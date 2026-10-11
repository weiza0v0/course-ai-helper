/* MOOC 测验 AI 答题助手 —— 前端逻辑（轮询 /api/state，不再需要往页面里粘任何东西） */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  cfg: null, token: '',
  sessionId: -1, since: 0,
  paper: null,
  serverAnswers: {}, edited: {},
  lastStatus: '', fillTpl: null, polling: false,
};

// ---------------------------------------------------------------- 小工具
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || '已复制'); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? (okMsg || '已复制') : '复制失败，请手动复制');
    return ok;
  }
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const imgUrl = u => '/api/image?url=' + encodeURIComponent(u);
const clean = s => String(s || '').replace(/\[图片[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
const answersNow = () => {
  const out = {};
  if (!state.paper) return out;
  for (const q of state.paper.questions) {
    const v = state.edited[q.qid] != null ? state.edited[q.qid] : state.serverAnswers[q.qid];
    if (v) out[q.qid] = v;
  }
  return out;
};

// ---------------------------------------------------------------- 配置
async function loadConfig() {
  const j = await (await fetch('/api/config')).json();
  state.cfg = j.config;
  state.token = j.token;
  $('#cfgFile').textContent = j.configFile + (j.created ? '（已自动生成）' : '');
  if (j.site) { document.title = j.site.name; const sn = $('#siteName'); if (sn) sn.textContent = j.site.name; }
  const m = j.config.model;
  $('#modelPill').textContent = `${m.model} · 思考 ${m.reasoning_effort}`;
  $('#modelPill').className = 'pill ' + (m.api_key_set ? 'ok' : 'bad');
  const rows = [
    ['API 地址', m.base_url],
    ['模型', m.model],
    ['思考强度', m.reasoning_effort + (m.reasoning_effort === 'off' ? '（已关闭，容易算错）' : '')],
    ['API Key', m.api_key_set ? '已配置 ' + m.api_key_hint : '❌ 未配置，请编辑 config.toml'],
    ['并发 / 工具轮数', m.concurrency + ' 题并发 · 最多 ' + m.max_tool_rounds + ' 轮工具'],
    ['工具', m.use_tools ? '开启（calc · matrix · calculus · stats · web_search · web_fetch）' : '关闭'],
    ['自动解题', j.config.app.auto_solve ? '开（收到题目就解）' : '关（需手动点）'],
    ['自动填答', j.config.app.auto_fill ? '开（答案推回页面并勾选）' : '关'],
    ['交卷', '永不自动交卷，由你自己点'],
  ];
  const html = rows.map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`).join('');
  $('#cfgTable').innerHTML = html;
  $('#cfgSummary').innerHTML = `<div class="kv-k">模型</div><div class="kv-v">${esc(m.model)} · 思考 ${esc(m.reasoning_effort)} · 并发 ${m.concurrency}</div>
    <div class="kv-k">Key</div><div class="kv-v">${m.api_key_set ? '已配置' : '未配置'}</div>
    <div class="kv-k">自动</div><div class="kv-v">解题 ${j.config.app.auto_solve ? '开' : '关'} / 填答 ${j.config.app.auto_fill ? '开' : '关'} / 交卷 永不</div>`;
  if (j.parseError) toast('config.toml 解析出错：' + j.parseError, 6000);
  renderPlatformBar(j);
  applyMode(j);
  return j;
}

/** 渲染平台选择器 */
function renderPlatformBar(j) {
  const bar = $('#platformBar');
  if (!bar || !j.platforms) return;
  bar.innerHTML = j.platforms.map(p => {
    const on = j.site && p.id === j.site.id;
    return `<button class="btn plat ${on ? 'primary' : ''}" data-id="${esc(p.id)}" title="${esc(p.mode === 'cdp' ? '只读出答案单' : '控制台脚本填答')}">${esc(p.name)}${p.mode === 'cdp' ? ' ·只读' : ''}</button>`;
  }).join(' ');
  for (const b of bar.querySelectorAll('button.plat')) {
    b.onclick = async () => {
      if (b.classList.contains('primary')) return;
      b.disabled = true;
      const r = await (await fetch('/api/platform', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: b.dataset.id})})).json();
      if (!r.ok) { toast('切换失败：' + (r.error || ''), 4000); b.disabled = false; return; }
      state.paper = null; state.serverAnswers = {}; state.lastStatus = null; state.sessionId = -1;
      $('#log').innerHTML = '';
      $('#answerTable').innerHTML = '<p class="hint">还没有题目。按上面第 1 步操作。</p>';
      await loadConfig();
      toast('已切到：' + r.site.name);
    };
  }
  const cur = j.platforms.find(p => j.site && p.id === j.site.id);
  if (cur) $('#platformHint').textContent = (cur.platformHint || '') + (cur.mode === 'cdp' ? '（本模式只读：答案写成答案单，由你手工填）' : '');
}

/** 按平台能力切界面：CDP 只读模式（智慧树这类）/ 控制台脚本模式 */
function applyMode(j) {
  const cdp = !!(j.site && j.site.cdp);
  state.cdp = cdp;
  $('#cardScript').classList.toggle('hidden', cdp);
  $('#cardCdp').classList.toggle('hidden', !cdp);
  if ($('#fillHint')) $('#fillHint').classList.toggle('hidden', cdp);
  if ($('#copyFill')) $('#copyFill').classList.toggle('hidden', cdp);
  if (cdp) {
    const port = (j.config.app && j.config.app.cdp && j.config.app.cdp.port) || 9222;
    $('#cdpPort').value = port;
    const t = $('#cfgTable');
    if (t && !/CDP 只读/.test(t.innerHTML)) {
      t.insertAdjacentHTML('beforeend', '<div class="kv-k">读取方式</div><div class="kv-v">CDP 只读（不点击 / 不填答 / 不提交）</div>');
    }
    $('#cdpInfo').textContent = '还没连。点「检查连接」看看那个带调试端口的浏览器是否就绪。';
  }
}

// ---- CDP 只读模式：读卷 → 解题 → 出答案单
async function cdpStatus() {
  const port = Number($('#cdpPort').value || 9222);
  try {
    const j = await (await fetch(`/api/cdp/status?port=${port}`)).json();
    if (!j.ok) { $('#cdpInfo').textContent = '❌ ' + (j.error || '连不上'); $('#cdpInfo').style.color = '#c33'; return; }
    const hit = (j.tabs || []).filter(t => t.matched);
    $('#cdpInfo').style.color = '';
    $('#cdpInfo').textContent = hit.length
      ? `✅ 已连上（端口 ${j.port}），找到答题页：${hit[0].title || hit[0].url.slice(0, 70)}`
      : `✅ 连上了（端口 ${j.port}），但没找到答题页。请在那个浏览器里打开作业答题界面。当前 ${(j.tabs || []).length} 个标签。`;
  } catch (e) {
    $('#cdpInfo').textContent = '❌ ' + e.message;
  }
}
async function cdpCollect() {
  const port = Number($('#cdpPort').value || 9222);
  $('#cdpInfo').style.color = '';
  $('#cdpInfo').textContent = '正在读取卷子…';
  $('#cdpCollect').disabled = true;
  try {
    const j = await (await fetch(`/api/cdp/collect?port=${port}`, {method: 'POST'})).json();
    if (!j.ok) { $('#cdpInfo').style.color = '#c33'; $('#cdpInfo').textContent = '❌ ' + (j.error || '失败'); return; }
    $('#cdpInfo').textContent = `✅ 读到 ${j.total} 道题，正在解题…（只读，没有在页面上点任何东西）`;
    state.sessionId = -1;
  } catch (e) {
    $('#cdpInfo').style.color = '#c33';
    $('#cdpInfo').textContent = '❌ ' + e.message;
  } finally {
    $('#cdpCollect').disabled = false;
  }
}

function showReport(file) {
  const a = $('#downloadReport');
  if (!a) return;
  a.classList.toggle('hidden', !file);
  const p = $('#reportPath');
  if (p) {
    p.classList.toggle('hidden', !file);
    p.textContent = file ? `答案单已保存：data/${file} —— 打开它照着填即可（交卷仍由你自己点）` : '';
  }
}
if ($('#cdpStatus')) $('#cdpStatus').onclick = cdpStatus;
if ($('#cdpCollect')) $('#cdpCollect').onclick = cdpCollect;

if ($('#cdpStatus')) $('#cdpStatus').onclick = cdpStatus;
if ($('#cdpCollect')) $('#cdpCollect').onclick = cdpCollect;

if ($('#cdpStatus')) $('#cdpStatus').onclick = cdpStatus;
if ($('#cdpCollect')) $('#cdpCollect').onclick = cdpCollect;

$('#toggleCfg').onclick = () => {
  const b = $('#cfgBody');
  b.classList.toggle('hidden');
  $('#cfgSummary').classList.toggle('hidden', !b.classList.contains('hidden'));
  $('#toggleCfg').textContent = b.classList.contains('hidden') ? '详情' : '收起';
};
$('#reloadCfg').onclick = async () => {
  const j = await (await fetch('/api/reload-config', {method: 'POST'})).json();
  if (j.parseError) return toast('config.toml 解析出错：' + j.parseError, 6000);
  await loadConfig();
  toast('配置已重载');
};
$('#testTools').onclick = async () => {
  const out = $('#toolTestOut');
  out.classList.remove('hidden');
  out.textContent = '正在测试 calc / matrix / calculus / stats / web_fetch / web_search …（搜索受网络影响）';
  try {
    const j = await (await fetch('/api/tool-test', {method: 'POST'})).json();
    out.textContent = j.results.map(r => `【${r.name}】${r.ok ? '✅' : '⚠️'} ${r.ms}ms\n${r.preview}\n`).join('\n' + '-'.repeat(60) + '\n');
  } catch (e) { out.textContent = '自检失败：' + e.message; }
};

async function health() {
  try {
    const j = await (await fetch('/api/health')).json();
    $('#health').textContent = '服务正常 · Node ' + j.node;
    $('#health').className = 'pill ok';
  } catch { $('#health').textContent = '服务未就绪'; $('#health').className = 'pill bad'; }
}

// ---------------------------------------------------------------- 一键脚本
$('#copyHelper').onclick = async () => {
  const src = await (await fetch('/console/helper.js')).text();
  await copyText(src, '一键脚本已复制 → 去测验页控制台粘贴回车');
};
$('#openHelper').href = '/console/helper.js';

// ---------------------------------------------------------------- 轮询状态
function setProgress(pct) { $('#progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%'; }

function logLine(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'l ' + cls;
  d.textContent = text;
  const box = $('#log');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.appendChild(d);
  while (box.children.length > 1200) box.removeChild(box.firstChild);
  if (stick) box.scrollTop = box.scrollHeight;
}

function handleEvent(ev) {
  const q = state.paper && state.paper.questions.find(x => x.index === ev.index);
  switch (ev.type) {
    case 'collected':
      logLine(`📥 收到题目：${ev.name || ev.tid} · ${ev.total} 题 · 来源 ${ev.source}`, 'q');
      $('#log').innerHTML = '';
      logLine(`📥 收到题目：${ev.name || ev.tid} · ${ev.total} 题 · 来源 ${ev.source}`, 'q');
      break;
    case 'start':
      logLine(`开始解题：${ev.total} 题 · 模型 ${ev.model} · 思考 ${ev.reasoning}`, 'q');
      break;
    case 'think':
      logLine(`  💭 第${ev.index}题思考：${String(ev.text).replace(/\s+/g, ' ').slice(0, 220)}…`, 'think');
      break;
    case 'tool':
      logLine(`  🔧 第${ev.index}题 ${ev.name}(${JSON.stringify(ev.args).slice(0, 110)})`, 'tool');
      break;
    case 'tool_result':
      logLine(`     ↳ ${ev.ms}ms · ${String(ev.preview).replace(/\s+/g, ' ').slice(0, 150)}`, 'toolres');
      break;
    case 'answer': {
      state.serverAnswers[ev.qid] = ev.answer;
      syncAnswerInput(ev.qid, ev.answer, ev.reason);
      const conf = ev.confidence != null ? ` 置信${ev.confidence}` : '';
      logLine(`  ✅ 第${ev.index}题 → ${ev.answer || '(空)'}${conf}　${String(ev.reason || '').slice(0, 70)}`, 'ans');
      break;
    }
    case 'warn': logLine('  ⚠ ' + ev.message, 'warn'); break;
    case 'error': logLine(`  ❌ 第${ev.index}题失败：${ev.message}`, 'err'); break;
    case 'fatal': logLine('致命错误：' + ev.message, 'err'); break;
    case 'info': logLine('ℹ ' + ev.message, 'toolres'); break;
    case 'saved': logLine('已存档 data/' + ev.file, 'toolres'); break;
    case 'progress':
      setProgress(ev.done / ev.total * 100);
      $('#prog').textContent = `${ev.done}/${ev.total}`;
      break;
  }
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    const j = await (await fetch(`/api/state?since=${state.since}&paperId=${state.sessionId}`)).json();
    if (j.paper) {                       // 新一轮（或刚打开页面）
      state.paper = j.paper;
      state.sessionId = j.sessionId;
      state.since = 0;
      state.serverAnswers = {...(j.answers || {})};
      state.edited = {};
      renderAnswers();
      $('#log').innerHTML = '';
    }
    for (const ev of j.events || []) handleEvent(ev);
    state.since = j.seq;
    state.serverAnswers = {...(j.answers || {}), ...state.serverAnswers};
    if (j.status !== state.lastStatus) {
      state.lastStatus = j.status;
      renderStatus(j);
      if (j.status === 'done') {
        renderAnswers();
        toast(state.cdp ? '答案已出，已生成答案单（本模式只读，请照着答案单自己填）' : '全部题目已出答案，已自动填进页面（未提交）', 5200);
      }
    }
    if (j.reportFile) showReport(j.reportFile);
    if (j.reportFile) showReport(j.reportFile);
    if (j.reportFile) showReport(j.reportFile);
    $('#prog').textContent = j.total ? `${j.done}/${j.total}` : '';
    setProgress(j.total ? j.done / j.total * 100 : 0);
    $('#resume').disabled = !state.paper || j.running;
    updateFillButtons();
  } catch (e) {
    $('#conn').textContent = '后端连接异常';
    $('#conn').className = 'pill bad';
  } finally {
    state.polling = false;
  }
}

function renderStatus(j) {
  const map = {
    idle: ['等待测验页面连接…', ''],
    collected: ['已收到题目，准备解题…', ''],
    running: ['正在解题…', 'ok'],
    done: [state.cdp
        ? `解题完成（${j.done}/${j.total}）· 答案单已生成，请照着手工填`
        : `解题完成（${j.done}/${j.total}）· 答案已填入页面，等待你自己提交`, 'ok'],
    error: ['解题出错：' + (j.error || ''), 'bad'],
  };
  const [text, cls] = map[j.status] || [j.status, ''];
  $('#conn').textContent = text;
  $('#conn').className = 'pill ' + cls;
}

// ---------------------------------------------------------------- 题目与答案
function renderAnswers() {
  const box = $('#answerTable');
  if (!state.paper) { box.innerHTML = '<p class="hint">还没有题目。去测验页粘一键脚本，或展开下面的「手动粘贴」。</p>'; return; }
  box.innerHTML = state.paper.questions.map(q => {
    const val = state.edited[q.qid] != null ? state.edited[q.qid] : (state.serverAnswers[q.qid] || '');
    const imgs = (q.stemImages || []).slice(0, 2).map(u => `<img src="${imgUrl(u)}" alt="">`).join('');
    const opts = (q.options || []).map(o => `${o.letter}.${clean(o.text) || o.ocr || '图'}`).join(' ');
    return `<div class="arow ${val ? '' : 'err'}" data-qid="${q.qid}">
      <div class="no">第 ${q.index} 题</div>
      <div class="ty">${esc(q.typeName || '')}</div>
      <div class="q">${esc(clean(q.stem).slice(0, 60) || '（图片题）')}${imgs}<div class="hint">${esc(opts.slice(0, 90))}</div><div class="ansTip"></div></div>
      <input type="text" value="${esc(val)}" placeholder="答案">
      <div class="reason"></div>
    </div>`;
  }).join('');
  // 答案旁边标出"这个字母代表什么"，判断题尤其需要（A 可能是"错误"，B 可能是"正确"）
  $$('.arow').forEach(row => {
    const q = state.paper.questions.find(x => String(x.qid) === row.dataset.qid);
    const inp = row.querySelector('input');
    const tip = row.querySelector('.ansTip');
    if (!tip) return;
    const render = () => {
      const v = (inp.value || '').toUpperCase();
      if (!v || !q) { tip.textContent = ''; return; }
      const parts = [...v].map(ch => {
        const o = (q.options || [])[ch.charCodeAt(0) - 65];
        return o ? `${ch}=${clean(o.text) || o.ocr || '图片'}` : ch;
      });
      tip.textContent = parts.length ? '→ ' + parts.join('   ') : '';
      tip.style.fontSize = '12px';
      tip.style.color = v.length && [...v].every(ch => (q.options || [])[ch.charCodeAt(0) - 65]) ? '#86efac' : '#fca5a5';
    };
    inp.addEventListener('input', render);
    render();
  });
  $$('#answerTable input').forEach(inp => {
    inp.oninput = e => {
      const qid = e.target.closest('.arow').dataset.qid;
      state.edited[qid] = e.target.value.trim().toUpperCase();
      e.target.closest('.arow').classList.toggle('err', !state.edited[qid]);
      updateFillButtons();
    };
  });
  for (const [qid, reason] of Object.entries(state.reasons || {})) {
    const r = $(`.arow[data-qid="${qid}"] .reason`);
    if (r) r.textContent = reason;
  }
}
function syncAnswerInput(qid, value, reason) {
  if (!state.paper) return;
  if (!state.reasons) state.reasons = {};
  if (reason) state.reasons[qid] = reason;
  let row = $(`.arow[data-qid="${qid}"]`);
  if (!row) { renderAnswers(); row = $(`.arow[data-qid="${qid}"]`); }
  if (!row) return;
  const inp = row.querySelector('input');
  if (inp && document.activeElement !== inp && state.edited[qid] == null) inp.value = value || '';
  row.classList.toggle('err', !(value || '').trim());
  const r = row.querySelector('.reason');
  if (r && reason) r.textContent = reason;
}

// ---------------------------------------------------------------- 备用：手动粘贴
$('#toggleManual').onclick = () => {
  const b = $('#manualBody');
  b.classList.toggle('hidden');
  $('#toggleManual').textContent = b.classList.contains('hidden') ? '展开' : '收起';
};
$('#parseBtn').onclick = async () => {
  const raw = $('#paperInput').value.trim();
  if (!raw) return toast('先把题目 JSON 粘进来');
  let paper;
  try { paper = JSON.parse(raw); } catch (e) { return toast('JSON 解析失败：' + e.message, 5000); }
  if (!paper.questions || !paper.questions.length) return toast('JSON 里没有 questions');
  if (paper.questions.length && !paper.source) paper.source = 'manual';
  $('#parseInfo').textContent = `共 ${paper.questions.length} 题，已提交给助手…`;
  $('#solveBtn').disabled = false;
  const j = await (await fetch('/api/set-paper', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper})})).json();
  if (!j.ok) return toast('提交失败：' + (j.error || ''), 5000);
  toast('已提交，开始解题');
};
$('#solveBtn').onclick = async () => {
  const j = await (await fetch('/api/resolve', {method: 'POST'})).json();
  toast(j.ok ? '已重新开始解题' : ('重解失败：' + (j.error || '')));
};
$('#resume').onclick = () => $('#solveBtn').click();
$('#loadExample').onclick = async () => {
  $('#paperInput').value = await (await fetch('/examples/questions.json')).text();
  $('#parseBtn').click();
};

// ---------------------------------------------------------------- 填答脚本（备用）
async function getFillTpl() {
  if (!state.fillTpl) state.fillTpl = await (await fetch('/console/fill.js')).text();
  return state.fillTpl;
}
function makeFill() {
  return getFillTplSync().replace('/*__ANSWERS__*/ {}', JSON.stringify(answersNow()));
}
let fillTplSync = null;
function getFillTplSync() { return fillTplSync || ''; }
async function ensureFillTpl() { fillTplSync = await getFillTpl(); }
function updateFillButtons() {
  const n = Object.keys(answersNow()).length;
  $('#copyFill').disabled = !n;
  $('#downloadJson').disabled = !n;
}
$('#copyFill').onclick = async () => {
  await ensureFillTpl();
  copyText(makeFill(), '填答脚本已复制（只勾选，不交卷）');
};
$('#downloadJson').onclick = () => {
  const blob = new Blob([JSON.stringify(answersNow(), null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'answers.json'; a.click();
};

// ---------------------------------------------------------------- 启动
$('#ver').textContent = 'v2.0.0';
(async () => {
  await loadConfig();
  await ensureFillTpl();
  health();
  poll();
  setInterval(poll, 1000);
  setInterval(health, 30000);
})();
