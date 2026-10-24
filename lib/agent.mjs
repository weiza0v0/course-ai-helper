/**
 * 多模态 LLM 调用 + 解题 Agent 循环
 * 只暴露三个工具：web_search / web_fetch / calc
 */

import {toolSpecs, runTool, normalizeQueries} from './tools.mjs';

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
  // ★ 这里刻意**不**去宣传"多查询很省""focus 很好用"：实测只要把搜索描述得便宜，
  //   模型就会从 4 次搜索涨到 6 次，每次都要重发整段对话，成本翻倍（20k → 74k prompt tokens）。
  //   工具能力照旧（schema 里有），但不主动怂恿它去用 —— 这条克制规则才是省钱的关键。
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
  if (q.opaque) {
    // ★ 超星字体反爬：DOM 文字是随机替换后的乱码，只有截图能读 —— 别让模型去猜乱码
    lines.push('题干：见随消息附上的截图（页面文字被字体反爬替换成乱码，**不要**参考文字）');
  } else {
    lines.push(`题干：${q.stem || '(题干见图片)'}`);
    if (q.stemOcr) lines.push(`题干OCR（可能不准，仅供参考）：${q.stemOcr}`);
  }
  lines.push('');
  for (const o of q.options || []) {
    const t = q.opaque ? '(见截图)' : (o.text && !/^\[图片/.test(o.text) ? o.text : '(选项见图片)');
    lines.push(`${o.letter}. ${t}`);
    if (o.ocr && !t.includes(o.ocr)) lines.push(`   OCR：${o.ocr}`);
  }
  lines.push('');
  if (q.typeName === '判断' || q.type === 4) {
    const map = (q.options || []).map(o => `${o.letter}=${q.opaque ? '见截图' : '“' + (o.text || '图片') + '”'}`).join('，');
    lines.push(`注意：本题是判断题，选项对应关系为 ${map}，请回答字母（不要写“正确/错误”）。`);
  }
  if (q.opaque) lines.push('注意：题干和选项的文字都不可用，请直接读截图；仍然是回答选项字母（填空题写答案文本）。');
  lines.push('请解题并给出最终 JSON。');
  return lines.join('\n');
}

function collectImages(q, max = 12) {
  const urls = [];
  // ★ 页面截图（data URL）优先：超星这类字体反爬只有渲染出来的截图才是真字
  if (q.shot && /^data:image\//.test(q.shot)) urls.push(q.shot);
  const push = u => { if (u && (/^https?:\/\//.test(u) || /^data:image\//.test(u)) && !urls.includes(u)) urls.push(u); };
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
      const isShot = i === 0 && q.shot && urls[0] === q.shot;
      parts.push({type: 'text', text: isShot
        ? '（本题页面截图：题干与选项以下图为准）'
        : `（下图 ${i + 1}/${urls.length}，按题目中出现的先后顺序排列）`});
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

export async function chat({baseUrl, apiKey, model, messages, tools, temperature = 0, reasoningEffort, maxTokens, timeout = 180000, retries = 3, onRetry}) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  if (!apiKey) throw new Error('缺少 API Key');
  const body = {model, messages, temperature};
  // 思考强度：DeepSeek 等支持 reasoning_effort（low/high/max）。数学题建议 max。
  // ★ 'off' 必须显式发 thinking.disabled —— 官方默认是**开着思考**、effort 默认 high，
  //   所以"不传 reasoning_effort"根本关不掉思考（早先就是这么写的，等于假关）。
  if (reasoningEffort === 'off') body.thinking = {type: 'disabled'};
  else if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
    body.thinking = {type: 'enabled'};
  }
  if (Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
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
/**
 * 关键词兜底判定（模型分类不可用时的退路）。
 *
 * ★ 先抹掉"年份 / 年代 / 世纪 / 第X次"再判：近代史、毛概、思政的题目满篇都是年份，
 *   而老版本用一个裸 `\d` 当数理信号 —— 实测「五四运动爆发于（　）1919年…」这类题
 *   **4 道里 4 道全被判成数理**，于是一路按 max 思考强度烧钱。
 *   抹掉之后再按分数判（强信号 2 分、运算符/剩余数字/求解词各 1 分，≥2 才算数理），
 *   这样"一战持续了 4 年"这种也仍然是文史。
 */
export function looksMathy(text) {
  const t = String(text || '')
    .replace(/\d{3,4}\s*年/g, ' ').replace(/\d+\s*年代/g, ' ')
    .replace(/\d+\s*世纪/g, ' ').replace(/第\s*[一二三四五六七八九十\d]+\s*次/g, ' ');
  let score = 0;
  if (/积分|导数|微分|极限|矩阵|行列式|概率|方差|期望|分布|方程|函数|数列|向量|特征值|正态|置信|假设检验|sin|cos|tan|log|ln|∑|∫|√|det|rank/.test(t)) score += 2;
  if (/[=+\-×÷≤≥<>^%]/.test(t)) score += 1;
  if (/\d/.test(t)) score += 1;
  if (/计算|求值|求解|证明|等于多少/.test(t)) score += 1;
  return score >= 2;
}

/** 题目文本（题干 + OCR + 选项 + 选项 OCR），分类判定统一用这个 */
function questionText(q) {
  return [q.stem, q.stemOcr, ...(q.options || []).map(o => o.text), ...(q.options || []).map(o => o.ocr)]
    .filter(Boolean).join(' ').trim();
}

/**
 * 这题像不像数理题？（工具裁剪和思考强度都用它，保证两处判定一致）
 * 返回 'mathy' | 'humanities' | 'unsure'
 *   unsure = 纯图片题 / 文字太少，判不出来 —— 一律按数理题对待（最保险）
 */
export function classifyQuestion(q) {
  const text = questionText(q);
  const hasImages = (q.stemImages || []).length > 0 || (q.options || []).some(o => (o.images || []).length > 0);
  // ★ 不确定就按数理：题目是纯图片、或文字少到没法判断时，
  //   宁可多发 2600 tokens 的工具 schema / 多花点思考 token，也不能让数学题少了 matrix/calculus/stats。
  //   （MOOC 的题经常整题就是一张图，此时 text 为空 —— 早期版本会误判成文史。）
  if (text.length < 12) return 'unsure';
  if (hasImages && text.length < 40) return 'unsure';
  return looksMathy(text) ? 'mathy' : 'humanities';
}

/**
 * 每题的思考强度：数理题用配置里的（默认 max），文史题自动降档。
 *
 * 为什么值得分档：**输出 token 占实际花费的 ~78%**（输入有缓存几乎是免费的，
 * 输出 ¥8/M 是缓存输入 ¥0.04/M 的 200 倍），而思考 token 全部按输出价计费。
 * 文史题基本是回忆 + 判断，用 low 足够；数理题要算，才需要 max。
 * 设 reasoning_effort_auto = false 就退回"所有题都用 reasoning_effort"的老行为。
 */
export function effortForQuestion(q, settings = {}) {
  const base = settings.reasoningEffort || 'max';
  if (settings.reasoningEffortAuto === false) return base;
  const kind = classifyQuestion(q);
  if (kind === 'humanities') return settings.reasoningEffortHumanities || 'low';
  return base;   // mathy 和 unsure 都用配置里的强度
}

/** 分类用的提示词（刻意写得很短：这一卷分类的实测成本只有万分之几元） */
function classifyPrompt(items) {
  return [
    '下面是一份在线测验的题目。请逐题判断它属于「文史」还是「数理」。',
    '- 数理：需要计算 / 推导 / 公式 / 矩阵 / 微积分 / 概率统计。',
    '- 文史：概念、记忆、判断、语言、历史、政治、法律、艺术等。',
    '  ⚠ 题目里出现的**年份、年代、数量词不算数理信号**（"1919年""持续了4年"都属文史）。',
    '只输出一个 JSON 数组，元素只能是 "数理" 或 "文史"，按题号顺序，不要任何解释。',
    ...items.map((x, i) => `${i + 1}. ${x.text}`),
  ].join('\n');
}

/** 从模型输出里抠出 JSON 数组（可能被包在 ``` 里，也可能带一句废话） */
export function parseLabels(text, expected) {
  const m = String(text || '').match(/\[[\s\S]*?\]/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || arr.length !== expected) return null;
  return arr.map(x => (/数理|数学|math/i.test(String(x)) ? 'mathy' : 'humanities'));
}

/**
 * 用模型给**整卷**分一次类（不是逐题调用）。
 *
 * 为什么这么设计：
 *  - 一次调用发完整卷，分类成本 ¥0.0007/卷（实测 8 题），摊到每题不到万分之一元 ——
 *    远比逐题调用便宜（那样每题都要重发一遍提示词且缓存难命中）。
 *  - `thinking: disabled`：分类不需要思考，实测 0.6 秒出结果。
 *  - **纯图片题不发图**：发图的成本是纯文本的几十倍，而不确定时按数理走本来就最保险，
 *    所以这类题直接标 'unsure'，不浪费钱也不冒险。
 *  - 任何异常（网络、解析长度对不上）都返回 null，交给关键词兜底 —— 绝不因为分类失败而中断解题。
 *
 * 实测：8 题里模型 8/8 正确，而关键词法只对 4/8（带年份的文史题全错）。
 */
export async function classifyPaperWithModel(questions, settings, onEvent = () => {}) {
  const items = [];
  for (const q of questions) {
    const text = questionText(q).replace(/\s+/g, ' ').trim().slice(0, 300);
    items.push({q, text, kind: text.length < 8 ? 'unsure' : null});
  }
  const need = items.filter(x => x.kind === null);
  if (!need.length) return null;
  const res = await chat({
    baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
    messages: [{role: 'user', content: classifyPrompt(need)}],
    tools: null, temperature: 0, reasoningEffort: 'off',
    maxTokens: 16 + need.length * 8,
    timeout: Math.min(60000, (Number(settings.timeoutSeconds) || 300) * 1000),
    retries: settings.maxRetries,
  });
  const labels = parseLabels(res.message.content, need.length);
  if (!labels) return null;                       // 解析不上 → 交给关键词兜底
  const kinds = new Map();
  for (const x of items) if (x.kind) kinds.set(x.q.qid, x.kind);
  need.forEach((x, i) => kinds.set(x.q.qid, labels[i]));
  const counts = {mathy: 0, humanities: 0, unsure: 0};
  for (const k of kinds.values()) counts[k]++;
  return {kinds, counts, usage: res.usage};
}

export function pickToolsForQuestion(q, mode = 'auto') {
  if (mode === 'all') return toolSpecs;
  const LITE = ['calc', 'web_search', 'web_fetch'];
  const liteSet = () => toolSpecs.filter(t => LITE.includes(t.function.name));
  // 只有**明确判为文史**才裁工具；mathy 和 unsure 都全发（保住"不确定就全发"这条底线）
  return classifyQuestion(q) === 'humanities' ? liteSet() : toolSpecs;
}

/**
 * 按**整份卷子**挑工具（不是按题）。
 *
 * 为什么按卷子：DeepSeek 的上下文缓存要求"完整匹配某个缓存前缀单元"。
 * 系统提示 + 工具 schema 是所有请求共用的前缀 A；如果逐题切换工具集，
 * A 就会在两种形状之间来回变 → 官方文档 Example 2 的情况 → 永远命中不了。
 * 按卷子定一次，A 就固定了，第 3 题起就能稳定命中（命中价约 1/10）。
 */
export function pickToolsForPaper(questions, mode = 'auto') {
  if (mode === 'all') return toolSpecs;
  const anyMathy = (questions || []).some(q => pickToolsForQuestion(q, 'auto').length === toolSpecs.length);
  return anyMathy ? toolSpecs : toolSpecs.filter(t => ['calc', 'web_search', 'web_fetch'].includes(t.function.name));
}

/** 工具结果进对话前的截断（抽出来便于自检）。超长结果会在后续每一轮被重发，所以必须截。 */
export function truncateToolResult(result, cap = 2000) {
  const n = Math.max(400, Math.min(20000, Number(cap) || 2000));
  const str = String(result ?? '');
  return str.length > n ? str.slice(0, n) + `\n…（工具结果过长，已截断；原文 ${str.length} 字符）` : str;
}

/**
 * 组装回传给 API 的 assistant 消息。
 *
 * ★ reasoning_content 必须回传：官方规定"带 tools 的请求，历史轮次的 reasoning_content
 *   均应回传并会拼接进上下文"。不回传的话模型看不到自己上一轮是怎么想的，只能重新推一遍。
 *   实测（热身 + 交替顺序，各 2 次）：**每轮输出 token 213 → 177（-17%），整题成本 -27%**。
 *   它进上下文后走缓存命中价（¥0.04/百万，是输出价的 1/200），所以几乎白送。
 *
 * ★ 只在模型**确实返回过** reasoning_content 时才带这个字段：本项目支持"任何 OpenAI 兼容接口"，
 *   换个不返回思考的模型时，我们绝不会凭空塞一个它可能不认识的字段。
 */
export function assistantMessageFor(msg) {
  return {
    role: 'assistant',
    content: msg.content || '',
    ...(msg.tool_calls ? {tool_calls: msg.tool_calls} : {}),
    ...(msg.reasoning_content ? {reasoning_content: String(msg.reasoning_content)} : {}),
  };
}

export async function solveQuestion(q, settings, onEvent = () => {}) {
  const messages = [{role: 'system', content: SYSTEM_PROMPT}, await buildUserMessage(q)];
  const trace = [];
  const thoughts = [];
  const usage = {prompt: 0, completion: 0, requests: 0, web: 0, cacheHit: 0, cacheMiss: 0};   // ★ 每题的真实用量（含缓存命中）
  // ★ 工具 schema 每次请求都要重发（stats+calculus+matrix 合计约 2600 tokens）。
  //   文史类题目用不到它们，只发 calc + 联网，单次请求固定开销能降一大半。
  const toolsForQuestion = () => settings._toolSet || pickToolsForQuestion(q, String(settings.toolMode || 'auto'));
  // ★ 思考强度按题分档：文史 low、数理用配置值（默认 max）。
  //   输出 token 占总花费 ~78%，而思考 token 全按输出价计费 —— 文史题没必要开 max。
  //   优先用"整卷模型分类"的结果（更准），没有再退回关键词判定。
  const kindFromModel = settings._kindByQid instanceof Map ? settings._kindByQid.get(q.qid) : null;
  const effort = (settings.reasoningEffortAuto === false)
    ? (settings.reasoningEffort || 'max')
    : (kindFromModel === 'humanities' ? (settings.reasoningEffortHumanities || 'low')
      : kindFromModel === 'mathy' ? (settings.reasoningEffort || 'max')
        : effortForQuestion(q, settings));
  const maxWebCalls = Math.max(0, Math.min(10, Number(settings.maxWebCalls ?? 3)));
  const maxWebFetches = Math.max(0, Math.min(10, Number(settings.maxWebFetches ?? 2)));
  const webResultChars = Math.max(400, Math.min(20000, Number(settings.webResultChars) || 1200));
  const webCache = new Map();
  let webCalls = 0;
  let webFetches = 0;
  const maxRounds = Math.max(1, Math.min(8, Number(settings.maxRounds) || 4));
  let useTools = settings.useTools !== false;
  let brokeEarly = false;   // 是因为"联网预算用完"提前收尾，而不是轮数真的用尽
  let lastContent = '';

  let lastRound = 0;
  for (let round = 1; round <= maxRounds; round++) {
    lastRound = round;
    onEvent({type: 'round', qid: q.qid, index: q.index, round, maxRounds, kind: classifyQuestion(q), effort});
    let res;
    try {
      const onRetry = r => onEvent({
        type: 'warn', qid: q.qid, index: q.index,
        message: `第 ${r.attempt} 次重试：${r.reason}，${Math.round(r.wait / 1000)}s 后重试${r.detail ? '（' + r.detail + '）' : ''}`,
      });
      res = await chat({
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
        messages, tools: useTools ? toolSpecs : null, temperature: settings.temperature,
        reasoningEffort: effort, timeout: (Number(settings.timeoutSeconds) || 300) * 1000,
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
      const u = res.usage;
      const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
      const miss = Number(u.prompt_cache_miss_tokens ?? (Number(u.prompt_tokens || 0) - hit));
      usage.prompt += Number(u.prompt_tokens || 0);
      usage.completion += Number(u.completion_tokens || 0);
      usage.cacheHit += hit;
      usage.cacheMiss += miss > 0 ? miss : 0;
      usage.requests++;
    }
    messages.push(assistantMessageFor(msg));
    if (msg.content) lastContent = msg.content;

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const parsed = parseAnswer(lastContent, q);
      usage.web = webCalls; usage.fetches = webFetches;
      const out = {qid: q.qid, index: q.index, ...parsed, trace, usage, thinking: thoughts.join('\n\n').slice(0, 4000)};
      onEvent({type: 'answer', qid: q.qid, index: q.index, ...parsed, usage: res.usage});
      return out;
    }
    let refusedWeb = 0, freshOther = 0;
    for (const c of calls) {
      const name = c.function && c.function.name;
      let args = {};
      try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch {}
      onEvent({type: 'tool', qid: q.qid, index: q.index, round, name, args});
      // ★ 联网类工具要限次：文史题最容易在这里反复搜，每次搜回来的都是大段网页
      const isWeb = /^web_/.test(name);
      const isSearch = name === 'web_search';
      const isFetch = name === 'web_fetch';
      let result, ms;
      let refused = '';
      // ★ "搜"和"读"分开算预算 —— 这一点是真踩出来的：
      //   一次 web_search 最多带 4 条查询，若和 web_fetch 共用一个计数器，
      //   一次 3 条的搜索就会把预算吃光，接着模型刚搜到的页面**读都读不了**，
      //   白白空转好几轮（实测一次跑出 74 秒、还多烧了一万多输出 token）。
      //   语义也本来就不同：搜索是"找"，抓取是"读已经决定要读的那一篇"。
      if (isSearch) {
        // ★ 预算按**调用次数**算，不按查询条数 —— 这一点是量出来的：
        //   一次带 4 条查询的搜索，结果会被 max_results 合并限长，进上下文的量和 1 条查询
        //   几乎一样（多出来的只是那一行查询列表）。真正花钱的是**轮次**：每多调一次工具，
        //   整段对话就要重发一次。按条数计费等于把搜索预算砍到 1/3，模型只好空转（实测 123 秒）。
        //   而且查询是并发跑的，多几条不额外花钱，只是搜索引擎那边多几个请求。
        if (webCalls >= maxWebCalls) refused = `本题的联网搜索已用完（${maxWebCalls} 次）`;
      } else if (isFetch) {
        if (webFetches >= maxWebFetches) refused = `本题的网页抓取已用完（${maxWebFetches} 次）`;
      }
      // ★ web_fetch 的返回窗口交给工具自己控：工具知道 focus，能在**预算内按相关性挑段落**；
      //   若让它先返回 6000 字符、再由这里盲目砍到 1200，挑句子的效果就白费了。
      if (isFetch) {
        const want = Number(args.max_chars);
        const budget = Math.max(400, webResultChars - 160);   // 留出 URL/标题/说明那几行
        args = {...args, max_chars: Number.isFinite(want) && want > 0 ? Math.min(want, budget) : budget};
      }
      const cacheKey = name + '|' + JSON.stringify(args);
      if (isWeb && refused) {
        result = `（${refused}，请基于已获得的信息作答，不要再调用联网工具）`;
        ms = 0;
        refusedWeb++;
        onEvent({type: 'warn', qid: q.qid, index: q.index, message: refused + '，要求直接作答'});
      } else if (isWeb && webCache.has(cacheKey)) {
        result = webCache.get(cacheKey);
        ms = 0;
        onEvent({type: 'tool_result', qid: q.qid, index: q.index, name, ms: 0, preview: '（同一题内重复查询，直接复用上次结果）'});
      } else {
        ({result, ms} = await runTool(name, args));
        if (isSearch) webCalls++;
        if (isFetch) webFetches++;
        if (!isWeb) freshOther++;
        webCache.set(cacheKey, result);
      }
      trace.push({round, name, args, result: result.slice(0, 1200), ms});
      onEvent({type: 'tool_result', qid: q.qid, index: q.index, name, ms, preview: result.slice(0, 400)});
      // ★ 进对话前必须截断：web_fetch 一次能返回 3 万字符，而它会在**后续每一轮**被重新发送。
      //   不截断的话，一次长网页抓取就能把单题输入 token 顶到几万，成本翻好几倍。
      const capForTool = isWeb ? webResultChars : settings.maxToolResultChars;
      const trimmed = truncateToolResult(result, capForTool);
      messages.push({role: 'tool', tool_call_id: c.id, content: trimmed});
    }
    // ★ 联网预算已耗尽、且这一轮除了被拒的联网调用什么都没干 → 直接收尾，别再空转。
    //   实测这种"撞两轮再作答"会白烧掉 2 次请求（14 次里的 2 次），每次都要重发整段对话。
    //   只要还有别的工具真的跑了（比如 calc），就仍然正常进入下一轮。
    if (refusedWeb > 0 && freshOther === 0) {
      brokeEarly = true;
      onEvent({type: 'warn', qid: q.qid, index: q.index, message: '联网预算已用完，直接收尾作答（不再空转）'});
      break;
    }
  }
  // 工具轮数用尽（或因联网预算用完提前收尾）还没给答案：强制一次「不带工具」的收尾回答，避免空答案
  onEvent({type: 'warn', qid: q.qid, index: q.index,
    message: brokeEarly ? `因联网预算用完提前收尾（第 ${lastRound} 轮），强制模型作答`
                        : `工具轮数用尽（${maxRounds} 轮），强制模型收尾作答`});
  try {
    const fin = await chat({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
      messages: [...messages, {role: 'user', content: '时间到。请立刻基于已获得的信息给出最终 JSON 答案，不要再调用任何工具。'}],
      tools: null, temperature: settings.temperature,
      reasoningEffort: effort, timeout: (Number(settings.timeoutSeconds) || 300) * 1000,
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
  usage.web = webCalls; usage.fetches = webFetches;
  return {qid: q.qid, index: q.index, ...parsed, trace, usage, thinking: thoughts.join('\n\n').slice(0, 4000)};
}

/** 并发解题（默认并发 3） */
const useToolsEnabled = s => s.useTools !== false;

export async function solvePaper({paper, settings, onEvent = () => {}}) {
  const questions = paper.questions || [];
  const concurrency = Math.max(1, Math.min(6, Number(settings.concurrency) || 3));
  const results = new Array(questions.length);
  let next = 0;
  // ★ 整卷一次定工具集：保证"系统提示 + 工具 schema"这个共享前缀 A 不变，缓存才命中得了
  const toolMode = String(settings.toolMode || 'auto');
  const toolSet = useToolsEnabled(settings) ? pickToolsForPaper(questions, toolMode) : null;
  // ★ 整卷先用模型分一次类（thinking 关闭，一次调用），再按分类决定每题的思考强度。
  //   关键词法在"带年份的文史题"上几乎必错（实测 4/4 错），而这类题在近代史/毛概里遍地都是。
  let kindByQid = null, classifyUsage = null;
  const auto = settings.reasoningEffortAuto !== false;
  const differ = (settings.reasoningEffortHumanities || 'low') !== (settings.reasoningEffort || 'max');
  // ★ 字体反爬的题（opaque）文字全是乱码，分类调用只会浪费钱；直接走兜底（数理档）
  const opaquePaper = questions.some(q => q.opaque);
  if (auto && differ && settings.classifyWithModel !== false && questions.length && !opaquePaper) {
    try {
      const r = await classifyPaperWithModel(questions, settings, onEvent);
      if (r) {
        kindByQid = r.kinds; classifyUsage = r.usage;
        onEvent({type: 'classify', source: 'model', ...r.counts, usage: r.usage});
      } else {
        onEvent({type: 'classify', source: 'keyword', message: '模型分类不可用，改用关键词判定'});
      }
    } catch (e) {
      onEvent({type: 'classify', source: 'keyword', message: '模型分类失败，改用关键词判定：' + e.message});
    }
  }
  const settingsForRun = {...settings, _toolSet: toolSet, _kindByQid: kindByQid};
  onEvent({type: 'start', total: questions.length, concurrency, tid: paper.tid, name: paper.name, tools: toolSet ? toolSet.map(t => t.function.name) : []});
  async function worker(id) {
    while (true) {
      const i = next++;
      if (i >= questions.length) return;
      try {
        results[i] = await solveQuestion(questions[i], settingsForRun, onEvent);
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
    a.cacheHit += u.cacheHit || 0; a.cacheMiss += u.cacheMiss || 0; a.fetches += u.fetches || 0;
    return a;
  }, {prompt: 0, completion: 0, requests: 0, web: 0, fetches: 0, cacheHit: 0, cacheMiss: 0});
  // 分类调用也要计入用量 —— 否则报出来的钱会比实际花的少
  if (classifyUsage) {
    const hit = Number(classifyUsage.prompt_cache_hit_tokens ?? classifyUsage.prompt_tokens_details?.cached_tokens ?? 0);
    const miss = Number(classifyUsage.prompt_cache_miss_tokens ?? (Number(classifyUsage.prompt_tokens || 0) - hit));
    usage.prompt += Number(classifyUsage.prompt_tokens || 0);
    usage.completion += Number(classifyUsage.completion_tokens || 0);
    usage.cacheHit += hit; usage.cacheMiss += miss > 0 ? miss : 0;
    usage.requests += 1;
  }
  const total = usage.prompt + usage.completion;
  if (total) onEvent({type: 'usage', ...usage, total});
  onEvent({type: 'done', answers, results});
  return {answers, results, usage};
}
