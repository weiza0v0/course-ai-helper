/**
 * 多模态 LLM 调用 + 解题 Agent 循环
 * 只暴露三个工具：web_search / web_fetch / calc
 */

import {toolSpecs, runTool} from './tools.mjs';

const IMG_CACHE = new Map(); // url -> dataURL

/** 把题目里的图片 URL 抓成 base64 dataURL（避免模型服务端访问不到题库 CDN） */
export async function imageToDataUrl(url) {
  if (IMG_CACHE.has(url)) return IMG_CACHE.get(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {'User-Agent': 'Mozilla/5.0', Referer: new URL(url).origin + '/'},
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = r.headers.get('content-type') || 'image/png';
    if (!/^image\//.test(type)) throw new Error('不是图片：' + type);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) throw new Error('图片过大');
    const durl = `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
    IMG_CACHE.set(url, durl);
    return durl;
  } finally {
    clearTimeout(t);
  }
}

const SYSTEM_PROMPT = [
  '你是在线课程（中国大学MOOC / 超星 / 智慧树）的解题助手，擅长大学基础课（高数、线代、概率统计等）。',
  '题干与选项可能是图片，图片已随消息给你。',
  '',
  '规则：',
  '1. 涉及数值/行列式/矩阵/微积分/概率统计的计算，**必须调工具复核**，不要心算：',
  '   calc 通用表达式；matrix 线代（行列式/逆/秩/RREF/解方程/特征值）；calculus 求导·积分·极限·求根·泰勒；stats 分布与统计检验。',
  '2. 联网要克制：常识/概念/文史类先用已有知识作答；确实要查证才 web_search，最多 2~3 次就应作答（反复换词搜索是浪费）。',
  '3. 给最终答案前做一次"选项核对"：把要输出的字母和它的选项文本逐字对一遍（尤其正负号、上下标）。算出 -10368 就不能选写着 10368 的选项。',
  '4. 工具结果与直觉冲突时以工具结果为准，重新推导。',
  '',
  '答案写法：',
  '- 单选/多选/判断一律回答**选项字母**，不要写选项文字。单选 "D"；多选连写 "AC"。',
  '- 判断题同样回答字母；⚠ 选项顺序每题都可能不同（这题 A=正确、下题 A=错误），先看清本题 A/B 各写了什么再选。',
  '- 填空题：填写答案文本本身。',
  '',
  '最终**只**输出一个 JSON，不要代码块、不要任何解释或推理文字（推理留在你自己的思考里）：',
  '{"answer":"D"}',
  '  · answer = 选项字母（填空题/简答题才写答案文本）。',
  '  · 只给选项就行，不需要理由、证据、关键词。',
].join('\n');

function buildUserContent(q) {
  const lines = [];
  lines.push(`题目类型：${q.typeName || q.type}`);
  lines.push(`题干：${q.stem || '(题干见图片)'}`);
  if (q.stemOcr) lines.push(`题干OCR（可能不准，仅供参考）：${q.stemOcr}`);
  lines.push('');
  for (const o of q.options || []) {
    const t = o.text && !/^\[图片/.test(o.text) ? o.text : '(选项见图片)';
    lines.push(`${o.letter}. ${t}`);
    if (o.ocr && !t.includes(o.ocr)) lines.push(`   OCR：${o.ocr}`);
  }
  lines.push('');
  if (q.typeName === '判断' || q.type === 4) {
    const map = (q.options || []).map(o => `${o.letter}=“${o.text || '图片'}”`).join('，');
    lines.push(`注意：本题是判断题，选项对应关系为 ${map}，请回答字母（不要写“正确/错误”）。`);
  }
  lines.push('请解题并给出最终 JSON。');
  return lines.join('\n');
}

function collectImages(q, max = 12) {
  const urls = [];
  const push = u => { if (u && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  (q.stemImages || []).forEach(push);
  for (const o of q.options || []) (o.images || []).forEach(push);
  return urls.slice(0, max);
}

export async function buildUserMessage(q) {
  const parts = [{type: 'text', text: buildUserContent(q)}];
  const urls = collectImages(q, 12);
  const failed = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const durl = await imageToDataUrl(urls[i]);
      parts.push({type: 'text', text: `（下图 ${i + 1}/${urls.length}，按题目中出现的先后顺序排列）`});
      parts.push({type: 'image_url', image_url: {url: durl}});
    } catch (e) {
      failed.push(`${urls[i]} (${e.message})`);
    }
  }
  if (failed.length) parts.push({type: 'text', text: '以下图片下载失败，请仅凭文字作答：' + failed.join(', ')});
  return {role: 'user', content: parts};
}

/** 一次 chat/completions 调用（带 429/5xx/网络错误的重试与指数退避） */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCompletion({url, apiKey, body, timeout}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey},
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return {status: r.status, text, retryAfter: r.headers.get('retry-after')};
  } finally {
    clearTimeout(t);
  }
}

export async function chat({baseUrl, apiKey, model, messages, tools, temperature = 0, reasoningEffort, timeout = 180000, retries = 3, onRetry}) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  if (!apiKey) throw new Error('缺少 API Key');
  const body = {model, messages, temperature};
  // 思考强度：DeepSeek 等支持 reasoning_effort（low/high/max）。数学题建议 max。
  if (reasoningEffort && reasoningEffort !== 'off') body.reasoning_effort = reasoningEffort;
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const maxRetries = Math.max(0, Math.min(6, Number(retries) || 0));
  let attempt = 0, lastErr = null;
  for (;;) {
    let res;
    try {
      res = await fetchCompletion({url, apiKey, body, timeout});
    } catch (e) {
      // 网络层错误（超时/连接被断）也重试
      lastErr = e;
      if (attempt < maxRetries) {
        const wait = Math.round(1000 * 2 ** attempt * (0.75 + Math.random() * 0.5));
        if (onRetry) onRetry({attempt: attempt + 1, reason: '网络错误：' + (e.message || e.name), wait});
        attempt++; await sleep(wait); continue;
      }
      throw e;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const ra = Number(res.retryAfter);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.round(1000 * 2 ** attempt * (0.75 + Math.random() * 0.5));
      if (onRetry) {
        const kind = res.status === 429 ? '触发限流(429)' : `服务端错误(${res.status})`;
        onRetry({attempt: attempt + 1, reason: kind, wait, detail: res.text.slice(0, 160)});
      }
      attempt++; await sleep(wait); continue;
    }

    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    if (res.status !== 200 || !json) {
      const msg = json && json.error ? (json.error.message || JSON.stringify(json.error)) : res.text.slice(0, 400);
      const err = new Error(`模型接口 ${res.status}：${msg}`);
      err.status = res.status;
      throw err;
    }
    const choice = (json.choices || [])[0];
    if (!choice) throw new Error('模型没有返回 choices：' + res.text.slice(0, 300));
    return {message: choice.message || {}, usage: json.usage, raw: json};
  }
}

/** 从回复里抽 JSON 对象：按括号配对扫描，跳过 LaTeX 的 \{ \} 转义，优先取含 answer 字段的 */
export function extractJson(text) {
  const s = String(text || '');
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { candidates.push(s.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && (o.answer !== undefined || o.答案 !== undefined || o.结论 !== undefined)) return o;
    } catch {}
  }
  for (const c of candidates.slice().reverse()) {
    try { const o = JSON.parse(c); if (o && typeof o === 'object') return o; } catch {}
  }
  return null;
}

/** 没有 JSON 时的兜底：只认显式结论，绝不靠散落的 对/是/否 猜（踩过坑：把"并非对所有 n 成立"判成"正确"） */
export function extractFromText(txt, q) {
  const t = String(txt || '');
  let m = t.match(/(?:正确答案|答案|结论|故选|选择|应为|所以选)\s*[:：]?\s*(?:是|为)?\s*([A-H])\b/);
  if (m) return m[1];
  const isJudge = q && (q.typeName === '判断' || q.type === 4);
  if (isJudge) {
    m = t.match(/(?:正确答案|答案|结论|故选|应为)\s*[:：]?\s*(?:是|为)?\s*(正确|错误)/);
    if (m) return m[1];
    if (/命题(?:错误|不成立|为假)|说法(?:错误|不成立)|结论(?:错误|不成立)|不正确|不成立|为假|故.{0,8}错误/.test(t)) return '错误';
    if (/命题正确|说法正确|结论正确|故.{0,8}正确/.test(t)) return '正确';
  }
  m = t.match(/选\s*([A-H])\b/);
  if (m) return m[1];
  if (!isJudge) {
    m = t.match(/\b([A-H])\b/);
    if (m) return m[1];
  }
  return '';
}

function parseAnswer(content, q) {
  const txt = String(content || '').trim();
  const json = extractJson(txt);
  let answer = json && json.answer != null ? String(json.answer).trim()
    : json && json.答案 != null ? String(json.答案).trim() : '';
  if (!answer) answer = extractFromText(txt, q);
  if (!answer) {
    const l = txt.match(/\b([A-H]{1,4})\b/);
    if (l) answer = l[1];
  }
  // 统一成「选项字母」——判断题也不留「正确/错误」这种文字答案：
  // 每题选项顺序可能不同（这题 A=错误，那题 A=正确），文字答案还要再反查一次字母，多一层出错机会。
  answer = toOptionLetters(answer, q);
  const kw = (json && (json.kw || json.KW || json.关键词)) || (json && json.reason) || '';
  return {
    answer,
    kw: String(kw).slice(0, 40),
    confidence: json && json.confidence != null ? Number(json.confidence) : null,
    reason: String(kw).slice(0, 200) || txt.slice(0, 120),
    evidence: (json && json.evidence) || '',
    raw: txt.length > 800 ? txt.slice(0, 800) + '…' : txt,   // 存档变小：raw 不再留 1500 字符
  };
}

/** 把各种形式的答案统一成选项字母："正确"→B、"错误"→A、选项原文→对应字母；已经是字母就原样返回 */
export function toOptionLetters(answer, q) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) return '';
  const opts = q.options || [];
  const letterOf = text => {
    const k = opts.findIndex(o => {
      const t = String(o.text || '').trim().replace(/\s+/g, '');
      return t && (t === text || (t.length > 1 && t === text));
    });
    return k >= 0 ? String.fromCharCode(65 + k) : '';
  };
  const isJudge = q.typeName === '判断' || q.type === 4;
  // 已经是字母（含多选连写）：校验范围
  if (/^[A-H]{1,8}$/.test(a.toUpperCase())) {
    const upper = a.toUpperCase();
    const valid = [...upper].every(ch => ch.charCodeAt(0) - 65 < opts.length);
    if (valid || !opts.length) return upper;
  }
  // 判断题的文字答案
  if (isJudge || /正确|错误/.test(a)) {
    const wantTrue = /^(正确|对|是|T|TRUE|√|YES|Y)$/i.test(a) || /正确|对|是/.test(a);
    const wantFalse = /^(错误|错|否|F|FALSE|×|X|NO|N)$/i.test(a) || /错误|错|否/.test(a);
    if (wantTrue && !wantFalse) {
      const k = opts.findIndex(o => /正确/.test(String(o.text || '')));
      if (k >= 0) return String.fromCharCode(65 + k);
    }
    if (wantFalse && !wantTrue) {
      const k = opts.findIndex(o => /错误/.test(String(o.text || '')));
      if (k >= 0) return String.fromCharCode(65 + k);
    }
  }
  // 选项原文（如把整个选项文本抄了一遍）
  const byText = letterOf(a.replace(/\s+/g, ''));
  if (byText) return byText;
  return a;   // 兜底：原样返回，由填答层报"映射失败"
}

/** 解一道题：带工具的多轮循环 */
/**
 * 按题目内容挑工具。抽出来便于自检。
 *
 * 为什么重要：工具 schema 每次请求都要重发。stats+calculus+matrix 合计约 2600 tokens，
 * 而文史类题目根本用不上 —— 只发 calc + 联网，单次固定开销能从 ~4400 降到 ~1500 tokens。
 */
export function pickToolsForQuestion(q, mode = 'auto') {
  if (mode === 'all') return toolSpecs;
  const text = [q.stem, q.stemOcr, ...(q.options || []).map(o => o.text), ...(q.options || []).map(o => o.ocr)]
    .filter(Boolean).join(' ');
  const mathy = /\d|[+\-×÷=<>≤≥^]|积分|导数|极限|矩阵|行列式|概率|方差|期望|分布|方程|函数|证明|计算|求值|sin|cos|tan|log|∑|∫|√/.test(text);
  if (mathy) return toolSpecs;
  return toolSpecs.filter(t => ['calc', 'web_search', 'web_fetch'].includes(t.function.name));
}

/** 工具结果进对话前的截断（抽出来便于自检）。超长结果会在后续每一轮被重发，所以必须截。 */
export function truncateToolResult(result, cap = 2000) {
  const n = Math.max(400, Math.min(20000, Number(cap) || 2000));
  const str = String(result ?? '');
  return str.length > n ? str.slice(0, n) + `\n…（工具结果过长，已截断；原文 ${str.length} 字符）` : str;
}

export async function solveQuestion(q, settings, onEvent = () => {}) {
  const messages = [{role: 'system', content: SYSTEM_PROMPT}, await buildUserMessage(q)];
  const trace = [];
  const thoughts = [];
  const usage = {prompt: 0, completion: 0, requests: 0, web: 0};   // ★ 每题的真实 token 用量
  // ★ 工具 schema 每次请求都要重发（stats+calculus+matrix 合计约 2600 tokens）。
  //   文史类题目用不到它们，只发 calc + 联网，单次请求固定开销能降一大半。
  const toolMode = String(settings.toolMode || 'auto');
  const toolsForQuestion = () => pickToolsForQuestion(q, toolMode);
  const maxWebCalls = Math.max(0, Math.min(10, Number(settings.maxWebCalls ?? 3)));
  const webResultChars = Math.max(400, Math.min(20000, Number(settings.webResultChars) || 1200));
  const webCache = new Map();
  let webCalls = 0;
  const maxRounds = Math.max(1, Math.min(8, Number(settings.maxRounds) || 4));
  let useTools = settings.useTools !== false;
  let lastContent = '';

  for (let round = 1; round <= maxRounds; round++) {
    onEvent({type: 'round', qid: q.qid, index: q.index, round, maxRounds});
    let res;
    try {
      const onRetry = r => onEvent({
        type: 'warn', qid: q.qid, index: q.index,
        message: `第 ${r.attempt} 次重试：${r.reason}，${Math.round(r.wait / 1000)}s 后重试${r.detail ? '（' + r.detail + '）' : ''}`,
      });
      res = await chat({
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
        messages, tools: useTools ? toolSpecs : null, temperature: settings.temperature,
        reasoningEffort: settings.reasoningEffort, timeout: (Number(settings.timeoutSeconds) || 300) * 1000,
        retries: settings.maxRetries, onRetry,
      });
    } catch (e) {
      if (useTools && (e.status === 400 || /tool|function/i.test(e.message))) {
        onEvent({type: 'warn', qid: q.qid, message: '该模型似乎不支持工具调用，已切换为纯推理模式：' + e.message});
        useTools = false;
        round--;
        continue;
      }
      throw e;
    }
    const msg = res.message;
    // 思考过程（DeepSeek 等把思维链放在 reasoning_content）
    if (msg.reasoning_content) {
      thoughts.push(String(msg.reasoning_content));
      onEvent({type: 'think', qid: q.qid, index: q.index, round, text: String(msg.reasoning_content).slice(0, 1200)});
    }
    // 累计用量（每轮请求都算）
    if (res.usage) {
      usage.prompt += Number(res.usage.prompt_tokens || 0);
      usage.completion += Number(res.usage.completion_tokens || 0);
      usage.requests++;
    }
    messages.push({role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? {tool_calls: msg.tool_calls} : {})});
    if (msg.content) lastContent = msg.content;

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const parsed = parseAnswer(lastContent, q);
      usage.web = webCalls;
      const out = {qid: q.qid, index: q.index, ...parsed, trace, usage, thinking: thoughts.join('\n\n').slice(0, 4000)};
      onEvent({type: 'answer', qid: q.qid, index: q.index, ...parsed, usage: res.usage});
      return out;
    }
    for (const c of calls) {
      const name = c.function && c.function.name;
      let args = {};
      try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch {}
      onEvent({type: 'tool', qid: q.qid, index: q.index, round, name, args});
      // ★ 联网类工具要限次：文史题最容易在这里反复搜，每次搜回来的都是大段网页
      const isWeb = /^web_/.test(name);
      let result, ms;
      const cacheKey = name + '|' + JSON.stringify(args);
      if (isWeb && webCalls >= maxWebCalls) {
        result = `（本题联网查询次数已用完 ${maxWebCalls} 次，请直接基于已有信息与常识作答，不要再搜索）`;
        ms = 0;
        onEvent({type: 'warn', qid: q.qid, index: q.index, message: `联网查询已达上限（${maxWebCalls} 次），要求直接作答`});
      } else if (isWeb && webCache.has(cacheKey)) {
        result = webCache.get(cacheKey);
        ms = 0;
        onEvent({type: 'tool_result', qid: q.qid, index: q.index, name, ms: 0, preview: '（同一题内重复查询，直接复用上次结果）'});
      } else {
        ({result, ms} = await runTool(name, args));
        if (isWeb) { webCalls++; webCache.set(cacheKey, result); }
      }
      trace.push({round, name, args, result: result.slice(0, 1200), ms});
      onEvent({type: 'tool_result', qid: q.qid, index: q.index, name, ms, preview: result.slice(0, 400)});
      // ★ 进对话前必须截断：web_fetch 一次能返回 3 万字符，而它会在**后续每一轮**被重新发送。
      //   不截断的话，一次长网页抓取就能把单题输入 token 顶到几万，成本翻好几倍。
      const capForTool = isWeb ? webResultChars : settings.maxToolResultChars;
      const trimmed = truncateToolResult(result, capForTool);
      messages.push({role: 'tool', tool_call_id: c.id, content: trimmed});
    }
  }
  // 工具轮数用尽还没给答案：强制一次「不带工具」的收尾回答，避免空答案
  onEvent({type: 'warn', qid: q.qid, index: q.index, message: `工具轮数用尽（${maxRounds} 轮），强制模型收尾作答`});
  try {
    const fin = await chat({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
      messages: [...messages, {role: 'user', content: '时间到。请立刻基于已获得的信息给出最终 JSON 答案，不要再调用任何工具。'}],
      tools: null, temperature: settings.temperature,
      reasoningEffort: settings.reasoningEffort, timeout: (Number(settings.timeoutSeconds) || 300) * 1000,
      retries: settings.maxRetries,
    });
    if (fin.message.reasoning_content) {
      thoughts.push(String(fin.message.reasoning_content));
      onEvent({type: 'think', qid: q.qid, index: q.index, round: maxRounds + 1, text: String(fin.message.reasoning_content).slice(0, 1200)});
    }
    const finText = fin.message.content || '';
    if (finText) lastContent = finText;
  } catch (e) {
    onEvent({type: 'warn', qid: q.qid, index: q.index, message: '收尾作答失败：' + e.message});
  }
  const parsed = parseAnswer(lastContent, q);
  if (!parsed.answer) onEvent({type: 'error', qid: q.qid, index: q.index, message: '模型没给出可解析的答案'});
  onEvent({type: 'answer', qid: q.qid, index: q.index, ...parsed});
  usage.web = webCalls;
  return {qid: q.qid, index: q.index, ...parsed, trace, usage, thinking: thoughts.join('\n\n').slice(0, 4000)};
}

/** 并发解题（默认并发 3） */
export async function solvePaper({paper, settings, onEvent = () => {}}) {
  const questions = paper.questions || [];
  const concurrency = Math.max(1, Math.min(6, Number(settings.concurrency) || 3));
  const results = new Array(questions.length);
  let next = 0;
  onEvent({type: 'start', total: questions.length, concurrency, tid: paper.tid, name: paper.name});
  async function worker(id) {
    while (true) {
      const i = next++;
      if (i >= questions.length) return;
      try {
        results[i] = await solveQuestion(questions[i], settings, onEvent);
      } catch (e) {
        results[i] = {qid: questions[i].qid, index: questions[i].index, answer: '', error: e.message, trace: []};
        onEvent({type: 'error', qid: questions[i].qid, index: questions[i].index, message: e.message});
      }
      onEvent({type: 'progress', done: results.filter(Boolean).length, total: questions.length});
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, questions.length)}, (_, i) => worker(i)));
  const answers = {};
  for (const r of results) if (r && r.answer) answers[r.qid] = r.answer;
  // 汇总真实用量（含失败/超时的题）
  const usage = results.reduce((a, r) => {
    const u = (r && r.usage) || {};
    a.prompt += u.prompt || 0; a.completion += u.completion || 0; a.requests += u.requests || 0; a.web += u.web || 0;
    return a;
  }, {prompt: 0, completion: 0, requests: 0, web: 0});
  const total = usage.prompt + usage.completion;
  if (total) onEvent({type: 'usage', ...usage, total});
  onEvent({type: 'done', answers, results});
  return {answers, results, usage};
}
