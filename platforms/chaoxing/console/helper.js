/* ============================================================================
 * 超星学习通 AI 答题助手 —— 一键脚本（在作业/考试页面控制台粘贴一次即可）
 *
 *   1. 从页面读题目（超星是服务端渲染，直接解析 DOM，比接口更稳）
 *   2. 直接 POST 给本机助手 → 后端自动开始解题
 *   3. 轮询答案 → 拿到后限速自动勾选（只填，不提交）
 *
 * 使用：
 *   - 先在超星里打开作业/考试，进入**能看到题目和选项**的答题界面
 *   - F12 控制台；若提示不允许粘贴，先输入  allow pasting  回车
 *   - 粘贴本脚本，回车。之后什么都不用做
 *   - 中途停止：__CX_HELPER__.stop()   只重填一次：__CX_HELPER__.fill()
 *   - 采集失败想知道原因：__CX_HELPER__.diagnose()
 *
 * ⚠ 仅适用于普通作业 / 章节测验。有监考、人脸识别、摄像头抓拍的考试请勿使用。
 * ==========================================================================*/
(async () => {
  const VERSION = '1.0.0';
  const BACKEND = '__BACKEND__';
  const TOKEN = '__TOKEN__';

  const log = (m, c = '#0a0') => console.log(`%c[助手] ${m}`, `color:${c};font-weight:bold`);
  const warn = m => console.warn(`[助手] ${m}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const abs = u => (!u ? '' : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? location.origin + u : u);
  const imgsIn = el => el ? [...el.querySelectorAll('img')].map(i => abs(i.getAttribute('src') || i.getAttribute('data-src'))).filter(Boolean) : [];

  // ================================================================ 题目容器定位
  // 超星不同版本/端（作业 doHomeWork、考试 reVersionTestStartNew、章节测验）类名略有差别，多路兜底
  const Q_SELECTORS = [
    '.TiMu',                        // 最常见（作业/考试）
    '.questionLi',                  // 老版作业
    'div[class*="TiMu"]',
    '.queBox', '.exam-question', '.question-item',
  ];
  function findQuestions() {
    for (const sel of Q_SELECTORS) {
      const list = [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || e.querySelector('input'));
      if (list.length) return {list, by: sel};
    }
    return {list: [], by: null};
  }

  const TYPES = [
    [/单选/, '单选'], [/多选|不定项/, '多选'], [/判断/, '判断'],
    [/填空/, '填空'], [/简答|论述|名词解释|计算题|分析/, '简答'], [/其他/, '其他'],
  ];
  function detectType(node) {
    const marker = txt(node.querySelector('.mark_name, .markName, h3, .type'));
    for (const [re, name] of TYPES) if (re.test(marker)) return name;
    // 没有文字标记就看控件
    if (node.querySelector('input[type=checkbox]')) return '多选';
    if (node.querySelector('input[type=radio]')) return '单选';
    if (node.querySelector('input[type=text], textarea')) return '填空';
    return '单选';
  }

  function optionNodes(node) {
    // 选项可能在 Zy_ulTop / Zy_ulBottom / 任意 ul>li，且可能带 input[type=radio|checkbox]
    const uls = [...node.querySelectorAll('ul.Zy_ulTop, ul.Zy_ulBottom, ul[class*="Zy_ul"], .Zy_ulTop, .answerList')];
    let lis = uls.flatMap(ul => [...ul.querySelectorAll(':scope > li')]);
    if (!lis.length) lis = [...node.querySelectorAll('li')].filter(li => li.querySelector('.after, a, input'));
    // 去重 + 去掉嵌套在别的 li 里的
    const seen = new Set();
    return lis.filter(li => {
      if (seen.has(li)) return false;
      seen.add(li);
      return !lis.some(other => other !== li && other.contains(li));
    });
  }

  function optionInfo(li, k) {
    const letterNode = li.querySelector('i.fl, i, .num, .optionNum');
    let letter = txt(letterNode).replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!letter || letter.length > 2) letter = String.fromCharCode(65 + k);
    const textNode = li.querySelector('.after, .optionCnt, .answer_p, label, span');
    const input = li.querySelector('input');
    return {
      letter,
      oid: input && input.name ? `${input.name}#${input.value}` : String(k),
      text: txt(textNode) || txt(li).replace(/^[A-Za-z][.、]?\s*/, ''),
      images: imgsIn(li),
    };
  }

  function collect() {
    const {list, by} = findQuestions();
    const questions = list.map((node, i) => {
      const typeName = detectType(node);
      const titleNode = node.querySelector('.Zy_TItle, .TiMuTitle, .mark_title, .questionTitle') || node;
      const stemFull = txt(titleNode);
      const stem = stemFull.replace(/^\s*\d+\s*[、.．]\s*/, '').replace(/^\s*[【\[]?[^】\]]{0,8}[】\]]?\s*/, m => /分|单选|多选|判断|填空|简答/.test(m) ? '' : m);
      const lis = ['单选', '多选', '判断'].includes(typeName) ? optionNodes(node) : [];
      return {
        index: i + 1,
        qid: node.getAttribute('data-id') || node.getAttribute('data') || node.id || `q${i + 1}`,
        type: typeName,
        typeName,
        score: (txt(node.querySelector('.mark_name, h3')).match(/\((\d+(?:\.\d+)?)分\)/) || [])[1] || null,
        stem,
        stemImages: imgsIn(titleNode),
        stemOcr: '',
        options: lis.map(optionInfo),
      };
    });
    return {tid: location.href, aid: 0, name: document.title, source: 'dom', collectedAt: new Date().toISOString(), questions, by};
  }

  // ================================================================ 诊断（采集不到时用）
  function diagnose() {
    const rep = {url: location.href, title: document.title, candidates: {}};
    for (const sel of Q_SELECTORS) rep.candidates[sel] = document.querySelectorAll(sel).length;
    rep.iframes = [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 5);
    rep.likely = [...document.querySelectorAll('div')]
      .filter(d => /单选|多选|判断|填空/.test(txt(d).slice(0, 60)) && d.children.length)
      .slice(0, 6)
      .map(d => ({cls: String(d.className).slice(0, 60), tag: d.tagName, head: txt(d).slice(0, 50)}));
    const r = findQuestions();
    rep.matched = r.by;
    rep.sample = r.list[0] ? r.list[0].outerHTML.slice(0, 1500) : null;
    console.log('%c[助手] DOM 诊断：', 'color:#06c;font-weight:bold');
    console.log(JSON.stringify(rep, null, 1));
    return rep;
  }

  // ================================================================ 填答
  const SELECTED_RE = /check_answer|check_answer_dx|cur|selected|on\b/;
  function isSelected(li) {
    const a = li.querySelector('a');
    const i = li.querySelector('i');
    const input = li.querySelector('input');
    if (input && input.checked) return true;
    if (a && SELECTED_RE.test(a.className)) return true;
    if (i && /\bcur\b|check/.test(i.className)) return true;
    return false;
  }
  async function setOption(li, want) {
    const input = li.querySelector('input');
    if (input && input.disabled) return false;
    if (isSelected(li) === want) return true;
    const target = li.querySelector('a') || li;
    target.click();
    if (isSelected(li) === want) return true;
    await sleep(200);
    if (input) {
      if (want) { input.checked = true; input.click(); }
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }
    if (isSelected(li) === want) return true;
    await sleep(200);
    return isSelected(li) === want;
  }

  /** 限流/提示弹窗检测（超星也会弹"操作过于频繁"之类） */
  function blockDialog() {
    for (const d of document.querySelectorAll('.layui-layer, .popup, .dialog, [class*="layer"], [class*="Dialog"], .tipBox')) {
      if (!d.offsetParent) continue;
      if (/过于频繁|请稍后|操作太快|系统繁忙|验证/.test(txt(d))) return d;
    }
    return null;
  }
  function dismissDialog(scope) {
    const btns = [...scope.querySelectorAll('a,button,span,div')]
      .filter(e => e.children.length === 0 && /^(确定|知道了|好的|关闭|继续|OK)$/i.test(txt(e)));
    if (btns.length) { btns[0].click(); return true; }
    return false;
  }

  function fillText(node, spec) {
    const inputs = [...node.querySelectorAll('input[type=text], input:not([type]), textarea')];
    if (!inputs.length) return false;
    const vals = Array.isArray(spec) ? spec : String(spec).split(/[;；|]/).map(s => s.trim()).filter(Boolean);
    let n = 0;
    for (let i = 0; i < inputs.length && i < vals.length; i++) {
      const inp = inputs[i];
      inp.focus();
      inp.value = vals[i];
      inp.dispatchEvent(new Event('input', {bubbles: true}));
      inp.dispatchEvent(new Event('change', {bubbles: true}));
      inp.blur();
      n++;
    }
    return n > 0;
  }

  async function fill(answers, opts = {}) {
    const intervalMs = Math.max(0, Number(opts.intervalMs ?? 400));
    const backoffMs = Math.max(500, Number(opts.backoffMs ?? 3000));
    const {list} = findQuestions();
    if (!list.length) { warn('页面上找不到题目，跑 __CX_HELPER__.diagnose() 看诊断'); return {ok: 0, fail: 0, missing: 0, throttled: 0}; }
    let ok = 0, fail = 0, missing = 0, throttled = 0;
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      if (state.stop) break;
      const node = list[i];
      const qid = node.getAttribute('data-id') || node.getAttribute('data') || node.id || `q${i + 1}`;
      const spec = answers[qid] != null ? answers[qid]
        : answers[String(i + 1)] != null ? answers[String(i + 1)] : answers[i];
      const typeName = detectType(node);
      if (spec == null) { missing++; rows.push({题号: i + 1, 类型: typeName, 答案: '(缺)', 结果: '跳过'}); continue; }

      const dlg = blockDialog();
      if (dlg) { dismissDialog(dlg); throttled++; warn(`页面提示"操作过于频繁/请稍后"，已关闭弹窗，等待 ${(backoffMs / 1000).toFixed(1)}s`); await sleep(backoffMs); }

      if (typeName === '填空' || typeName === '简答') {
        const done = fillText(node, spec);
        done ? ok++ : fail++;
        rows.push({题号: i + 1, 类型: typeName, 答案: String(spec).slice(0, 30), 结果: done ? '✔ 已填入' : '✖ 没找到输入框'});
        if (i < list.length - 1) await sleep(intervalMs);
        continue;
      }

      // 选择题：把答案规范化成选项下标
      const lis = optionNodes(node);
      const idxs = [];
      const specs = Array.isArray(spec) ? spec : String(spec).split(/[\s,、|]+/).filter(Boolean);
      for (const raw of specs) {
        const s = String(raw).trim(), u = s.toUpperCase();
        if (/^[A-Z]$/.test(u)) { const k = u.charCodeAt(0) - 65; if (k < lis.length) { idxs.push(k); continue; } }
        const k = lis.findIndex(li => txt(li).replace(/^[A-Za-z][.、]?\s*/, '').trim() === s);
        if (k >= 0) { idxs.push(k); continue; }
        warn('无法映射的答案：' + s);
      }
      if (!idxs.length) { fail++; rows.push({题号: i + 1, 类型: typeName, 答案: JSON.stringify(spec), 结果: '映射失败'}); continue; }

      let allOk = true;
      for (let k = 0; k < lis.length; k++) {
        if (!(await setOption(lis[k], idxs.includes(k))) && idxs.includes(k)) allOk = false;
      }
      allOk ? ok++ : fail++;
      rows.push({题号: i + 1, 类型: typeName, 答案: idxs.map(k => String.fromCharCode(65 + k)).join(''), 结果: allOk ? '✔ 已勾选' : '✖ 未生效'});
      if (i < list.length - 1) await sleep(intervalMs);      // ★ 错开请求，防平台限流
    }
    console.table(rows);

    // 复核：实际选中的和期望不一致的再补一次
    const bad = [];
    for (let i = 0; i < list.length; i++) {
      const spec = answers[i + 1] != null ? answers[i + 1] : answers[list[i].getAttribute('data-id') || ''];
      if (spec == null) continue;
      if (['填空', '简答'].includes(detectType(list[i]))) continue;
      const lis = optionNodes(list[i]);
      const wanted = /^[A-Z]$/.test(String(spec).toUpperCase()) ? [String(spec).toUpperCase().charCodeAt(0) - 65] : [];
      if (wanted.length && !wanted.every(k => lis[k] && isSelected(lis[k]))) bad.push({i, lis, wanted});
    }
    if (bad.length) {
      warn(`复核发现 ${bad.length} 题没选上，等待后补选…`);
      await sleep(backoffMs);
      for (const b of bad) { for (let k = 0; k < b.lis.length; k++) await setOption(b.lis[k], b.wanted.includes(k)); await sleep(intervalMs); }
    }
    return {ok, fail, missing, throttled, remaining: bad.length};
  }

  // ================================================================ 主流程
  const state = {stop: false, answers: {}, paper: null, info: null};
  window.__CX_HELPER__ = {
    version: VERSION,
    stop() { state.stop = true; log('已停止（已填的答案保留在页面上）', '#e90'); },
    fill() { return fill(state.answers, state.opts || {}); },
    diagnose,
    collect,
    answers: () => state.answers,
  };

  log('开始读题…');
  const paper = collect();
  if (!paper.questions.length) {
    warn('没读到题目。请确认已经进入答题界面（能看到题目和选项）；跑 __CX_HELPER__.diagnose() 可看 DOM 诊断。');
    return diagnose();
  }
  state.paper = paper;
  window.__CX_PAPER__ = paper;
  log(`读到 ${paper.questions.length} 道题（容器 ${paper.by}），正在上传…`);

  const manual = async why => {
    const json = JSON.stringify(paper);
    try { copy(json); } catch {}
    warn(why + '。题目 JSON 已复制到剪贴板：去助手网页粘贴 → 解题 → 再用填答脚本。');
    console.log(json);
  };
  if (!/^https?:\/\//.test(BACKEND) || BACKEND.includes('__BACKEND__')) return manual('脚本里的后端地址没被注入');

  let info;
  try {
    const r = await fetch(`${BACKEND}/api/collect?t=${TOKEN}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper}),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) return manual('上传失败（' + (j.error || r.status) + '）');
    info = j;
    state.info = j;
    state.opts = {intervalMs: j.fillIntervalMs, backoffMs: j.limitBackoffMs};
  } catch (e) {
    return manual('连不上本机助手（' + e.message + '）');
  }

  log(`上传成功 ✅ 助手开始解题：模型 ${info.model} · 思考 ${info.reasoning} · ${info.total} 题`, '#06c');
  if (!info.autoSolve) warn('助手配置里 auto_solve = false，需要在网页上手动点「开始解题」');

  const poll = Math.max(1, info.pollSeconds || 2) * 1000;
  let lastDone = -1;
  while (!state.stop) {
    await sleep(poll);
    let j;
    try { j = await (await fetch(`${BACKEND}/api/answers?t=${TOKEN}&paperId=${info.sessionId}`)).json(); }
    catch (e) { return warn('查询答案失败（助手窗口关了吗？）：' + e.message); }
    if (j.sessionId !== info.sessionId) { warn('助手那边开始了新的一轮，停止本次轮询'); return; }
    if (j.done !== lastDone) { lastDone = j.done; log(`进度 ${j.done}/${j.total}`); }
    if (j.status === 'error') return warn('助手解题出错：' + (j.error || '未知错误') + '，去助手网页看日志');
    if (j.status === 'done') {
      state.answers = j.answers || {};
      log(`答案到齐（${Object.keys(state.answers).length} 题），开始填答…`, '#06c');
      const r = await fill(state.answers, state.opts);
      log(`填答完成：成功 ${r.ok} / 失败 ${r.fail} / 缺答案 ${r.missing}${r.throttled ? ` / 遇限流等待 ${r.throttled} 次` : ''}${r.remaining ? ` / 仍未生效 ${r.remaining}` : ''}`, (r.fail || r.missing) ? '#e90' : '#0a0');
      const btn = document.querySelector('.btnSubmit, #submitBtn, .submitBtn, a[onclick*="submit"], .sub_btn');
      if (btn) {
        btn.style.outline = '3px solid #e33';
        btn.style.outlineOffset = '2px';
        log('答案已填入页面。请自己核对后再交卷 —— 本工具不会替你提交。', '#e33');
        btn.scrollIntoView({block: 'center', behavior: 'smooth'});
      } else {
        log('答案已填入页面（没找到提交按钮，请手动翻到页面底部提交）。', '#e90');
      }
      return;
    }
  }
})();
