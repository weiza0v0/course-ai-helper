/**
 * 自检：除 web_search 外全部离线可跑（mock 模型 + 本地页面 + 临时 TOML 配置）。
 *   node test/selftest.mjs
 */
import {spawn} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTool} from '../lib/tools.mjs';
import {parseToml, stringifyToml} from '../lib/toml.mjs';
import {loadConfig, publicConfig, DEFAULT_CONFIG} from '../lib/config.mjs';
import {extractJson, extractFromText, toOptionLetters} from '../lib/agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0, fail = 0;
const ok = (n, e = '') => { pass++; results.push(`  ✅ ${n}${e ? ' ' + e : ''}`); };
const no = (n, e = '') => { fail++; results.push(`  ❌ ${n}${e ? ' ' + e : ''}`); };
const info = m => results.push(`  ·  ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const syncErr = (...a) => { try { fs.writeSync(2, a.map(x => (x && x.stack) || String(x)).join(' ') + '\n'); } catch {} };
process.on('uncaughtException', e => { syncErr('[uncaughtException]', e); process.exitCode = 1; });
process.on('unhandledRejection', e => { syncErr('[unhandledRejection]', e); process.exitCode = 1; });
process.on('exit', c => {
  for (const ch of children) { try { ch.kill('SIGKILL'); } catch {} }
  if (c) syncErr('[selftest exit]', c);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const children = [];
function launch(script, env) {
  const p = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => results.push('  [child stderr] ' + String(d).trim().slice(0, 200)));
  children.push(p);
  return p;
}
async function waitFor(fn, timeout = 20000, gap = 300) {
  const t0 = Date.now(); let err = '';
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return {ok: true}; } catch (e) { err = e.message; }
    await sleep(gap);
  }
  return {ok: false, err};
}

let serverPort = 0, mockPort = 0, BASE = '', TOKEN = '', TMP = '';
try {
  serverPort = await freePort();
  mockPort = await freePort();
  BASE = `http://127.0.0.1:${serverPort}`;
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mooc-helper-test-'));
  fs.writeFileSync(path.join(TMP, 'config.toml'), `[server]\nport = ${serverPort}\nopen_browser = false\n\n[model]\nbase_url = "http://127.0.0.1:${mockPort}/v1"\napi_key = "mock-key"\nmodel = "mock-vl"\nreasoning_effort = "max"\nconcurrency = 1\nmax_tool_rounds = 4\n\n[app]\nauto_solve = true\nauto_fill = true\npoll_seconds = 1\n`, 'utf8');
  console.log(`\n超星 AI Helper 自检\n${'='.repeat(54)}\n  server=${serverPort} mock=${mockPort}\n`);
} catch (e) { console.error('准备失败：' + e.message); process.exit(1); }

launch('test/mock-llm.mjs', {MOCK_PORT: String(mockPort)});
launch('server.mjs', {PORT: String(serverPort), NO_OPEN: '1', CONFIG_FILE: path.join(TMP, 'config.toml')});

try {
  // ---------------- TOML 配置
  const t = parseToml(`
# 注释
title = "带#号的字符串"   # 尾注释
n = 42
f = 3.5
b = true
arr = ["a", "b", "c"]
[server]
port = 1234
open_browser = false
[model]
reasoning_effort = "max"
api_key = ''
`);
  t.title === '带#号的字符串' && t.n === 42 && t.f === 3.5 && t.b === true && t.arr.length === 3 && t.server.port === 1234 && t.model.api_key === ''
    ? ok('TOML：基本类型/注释/字面量字符串/嵌套表') : no('TOML 解析异常', JSON.stringify(t));
  const rt = parseToml(stringifyToml({a: 1, s: 'x', t: {k: true}}));
  rt.a === 1 && rt.s === 'x' && rt.t.k === true ? ok('TOML：生成后可再解析') : no('TOML 往返失败');
  const loadedCfg = loadConfig(TMP, path.join(TMP, 'config.toml')).config;
  loadedCfg.model.base_url.includes(String(mockPort)) && loadedCfg.app.auto_fill === true
    ? ok('TOML：loadConfig 读取成功') : no('loadConfig 失败');
  const pc = publicConfig({...DEFAULT_CONFIG, model: {...DEFAULT_CONFIG.model, api_key: 'sk-abcdef123456'}});
  const pcBefore = publicConfig(DEFAULT_CONFIG);
  pc.model.api_key === undefined && pc.model.api_key_hint.includes('…') && pc.model.api_key_set === true
    ? ok('配置：api_key 不下发（只给掩码）') : no('配置泄露风险', JSON.stringify(pc.model));
  !JSON.stringify(DEFAULT_CONFIG).includes('auto_submit') ? ok('配置：已无 auto_submit（工具不交卷）') : no('仍存在 auto_submit');

  // ---------------- 服务
  const up = await waitFor(async () => (await (await fetch(BASE + '/api/health')).json()).ok === true);
  up.ok ? ok('服务启动 + /api/health', `(${BASE})`) : no('服务启动', up.err);

  const cfgRes = await (await fetch(BASE + '/api/config')).json();
  TOKEN = cfgRes.token;
  TOKEN && cfgRes.config.model.api_key === undefined ? ok('/api/config 返回 token 且不含 key') : no('/api/config 异常');

  const html = await (await fetch(BASE + '/')).text();
  html.includes('复制一键脚本') && !html.includes('自动交卷') && html.includes('超星') ? ok('前端页面：一键脚本、无自动交卷') : no('前端页面内容异常');
  (await fetch(BASE + '/style.css')).ok ? ok('样式表可访问') : no('样式表不可访问');
  (await (await fetch(BASE + '/app.js')).text()).includes('/api/state') ? ok('前端脚本：走 /api/state 轮询') : no('前端脚本异常');

  // ---------------- 控制台脚本（超星版是 DOM 解析，只有一个 helper.js）
  const helper = await (await fetch(BASE + '/console/helper.js')).text();
  helper.includes(`http://127.0.0.1:${serverPort}`) ? ok('helper.js：后端地址已注入实际端口') : no('helper.js 端口注入失败');
  helper.includes(TOKEN) ? ok('helper.js：token 已注入') : no('helper.js token 注入失败');
  helper.includes('/api/collect') && helper.includes('/api/answers') ? ok('helper.js：上传 + 轮询答案') : no('helper.js 流程缺失');
  !/btn\.click\(\)|submitBtn\.click\(\)/.test(helper) && /本工具不会替你提交/.test(helper)
    ? ok('helper.js：不会自动提交') : no('helper.js 仍有提交动作');
  /intervalMs/.test(helper) && /blockDialog/.test(helper) && /复核发现/.test(helper)
    ? ok('helper.js：限速勾选 + 限流退避 + 复核补选') : no('helper.js 缺限流防护');
  /diagnose/.test(helper) && /Q_SELECTORS/.test(helper)
    ? ok('helper.js：内置 DOM 诊断（采集不到时可回帖）') : no('helper.js 缺诊断能力');
  /mark_name|mark_letter|questionLi/.test(helper) ? ok('helper.js：覆盖超星实测类名') : no('helper.js 未覆盖超星类名');

  // ---------------- 答案解析回归（真实踩过的坑）
  const TRICKY = '题干矩阵为 \\(a_{ij}=\\max\\{i,j\\}\\)，逐次相邻两行相减可得 \\(D_n=(-1)^{n-1}n\\)。\n用工具复核：\\(n=3\\) 时 \\(D_3=3\\)，并不等于 \\(-3\\)。因此"D_n=-n"并非对所有 \\(n\\) 成立，命题错误，选 A。\n```json\n{"answer":"A","confidence":0.99,"reason":"x"}\n```';
  const pj = extractJson(TRICKY);
  pj && pj.answer === 'A' ? ok('答案解析：LaTeX 的 \\{ 不再骗过 JSON 提取') : no('JSON 提取失败', JSON.stringify(pj));
  const q7 = {typeName: '判断', type: 4, options: [{text: '错误'}, {text: '正确'}]};
  extractFromText('因此"D_n=-n"并非对所有 n 成立，命题错误，选 A。', q7) === '错误'
    ? ok('答案解析：兜底不再把"并非对…"误判成"正确"') : no('兜底解析仍误判', JSON.stringify(extractFromText('因此"D_n=-n"并非对所有 n 成立，命题错误，选 A。', q7)));
  extractFromText('该命题正确。', q7) === '正确' ? ok('答案解析：兜底能识别"命题正确"') : no('兜底漏判正确');
  extractFromText('结论：错误', q7) === '错误' ? ok('答案解析：兜底识别"结论：错误"') : no('兜底漏判错误');
  // 判断题统一成字母（选项顺序逐题不同，A 可能是"错误"）
  toOptionLetters('正确', q7) === 'B' ? ok('判断题：文字"正确"→ 字母 B（A=错误,B=正确）') : no('判断题文字转字母失败', toOptionLetters('正确', q7));
  toOptionLetters('错误', q7) === 'A' ? ok('判断题：文字"错误"→ 字母 A') : no('判断题文字转字母失败', toOptionLetters('错误', q7));
  toOptionLetters('B', q7) === 'B' ? ok('判断题：字母原样保留') : no('字母被改动', toOptionLetters('B', q7));
  toOptionLetters('A', q7) === 'A' ? ok('判断题：字母 A 原样保留（不会被当成"正确"）') : no('字母 A 被误改', toOptionLetters('A', q7));
  const q6 = {typeName: '判断', type: 4, options: [{text: '正确'}, {text: '错误'}]};
  toOptionLetters('正确', q6) === 'A' && toOptionLetters('错误', q6) === 'B' ? ok('判断题：顺序反过来也能正确映射') : no('顺序反转映射失败');
  const q1 = {typeName: '单选', type: 1, options: [{text: 'a+b-d'}, {text: 'a+b+c'}, {text: 'a+b-c'}, {text: 'a+b+d'}]};
  toOptionLetters('a+b+d', q1) === 'D' ? ok('单选题：选项原文 → 字母 D') : no('选项原文转字母失败', toOptionLetters('a+b+d', q1));
  toOptionLetters('E', q1) === 'E' ? ok('单选题：越界字母原样返回（交给填答层报错）') : no('越界字母处理异常');

  // ---------------- 工具
  const c1 = await runTool('calc', {expression: 'det([[1,0,2,1],[0,-1,3,-1],[-1,-1,5,-1],[-1,1,4,0]])'});
  /\b9\b/.test(c1.result) ? ok('calc：4 阶行列式 = 9') : no('calc 行列式错误', c1.result);
  const c2 = await runTool('calc', {expression: 'process.exit(1)'});
  /未知的符号|失败/.test(c2.result) ? ok('calc：拦截代码注入（无 eval/new Function）') : no('calc 未拦截注入', c2.result.slice(0, 60));
  const c2b = await runTool('calc', {expression: '[].constructor.constructor("return 1")()'});
  /失败/.test(c2b.result) ? ok('calc：拦截 constructor 逃逸') : no('calc 未拦截 constructor', c2b.result.slice(0, 60));
  const c3 = await runTool('calc', {expression: '1e5 + 2'});
  /100002/.test(c3.result) ? ok('calc：科学计数法正常') : no('calc 误杀科学计数法');
  const wf = await runTool('web_fetch', {url: BASE + '/', max_chars: 1500});
  wf.result.includes('超星学习通 AI 答题助手') ? ok('web_fetch：抓取本地页面') : no('web_fetch 失败');
  const ws = await runTool('web_search', {query: '线性代数 行列式 性质', max_results: 3});
  /搜索引擎：/.test(ws.result) ? ok('web_search：可用') : info('web_search 当前网络不可用（不影响其它功能）');
  const tt = await (await fetch(BASE + '/api/tool-test', {method: 'POST'})).json();
  tt.results && tt.results.length === 6 ? ok('/api/tool-test 覆盖 6 个工具') : no('/api/tool-test 异常', 'n=' + (tt.results || []).length);

  // ---------------- 数学工具（矩阵 / 微积分 / 统计）
  const m1 = await runTool('matrix', {op: 'solve', a: [[2, 1], [1, 3]], b: [3, 5]});
  /0\.8/.test(m1.result) && /1\.4/.test(m1.result) ? ok('matrix：解线性方程组') : no('matrix solve 失败', m1.result.slice(0, 80));
  const m2 = await runTool('matrix', {op: 'eigen', a: [[0, -1], [1, 0]]});
  /i/.test(m2.result) ? ok('matrix：复特征值 ±i') : no('matrix eigen 失败', m2.result.slice(0, 80));
  const k1 = await runTool('calculus', {op: 'derivative', expr: 'x^3+2x', variable: 'x', at: 2});
  /14/.test(k1.result) ? ok('calculus：求导并代入 (3x²+2 @2 = 14)') : no('calculus 求导失败', k1.result.slice(0, 90));
  const k2 = await runTool('calculus', {op: 'integrate', expr: 'sin(x)', variable: 'x', lower: 0, upper: Math.PI});
  /\b2\b/.test(k2.result) ? ok('calculus：定积分 ∫₀^π sin = 2') : no('calculus 定积分失败', k2.result.slice(0, 90));
  const k3 = await runTool('calculus', {op: 'solve', expr: 'x^2-5x+6=0', variable: 'x'});
  /2/.test(k3.result) && /3/.test(k3.result) ? ok('calculus：求根 x²-5x+6=0 → 2,3') : no('calculus 求根失败', k3.result.slice(0, 90));
  const k4 = await runTool('calculus', {op: 'limit', expr: 'sin(x)/x', variable: 'x', point: 0});
  /1\b/.test(k4.result) ? ok('calculus：极限 sin(x)/x → 1') : no('calculus 极限失败', k4.result.slice(0, 90));
  const s1 = await runTool('stats', {op: 'dist', dist: 'normal', kind: 'quantile', x0: 0.975});
  /1\.959/.test(s1.result) ? ok('stats：正态分位数 1.95996') : no('stats 分布失败', s1.result.slice(0, 90));
  const s2 = await runTool('stats', {op: 'ttest', data: [1, 2, 3, 4, 5], mu: 0});
  /4\.2426/.test(s2.result) ? ok('stats：单样本 t 检验 t=4.2426') : no('stats t 检验失败', s2.result.slice(0, 90));
  const s3 = await runTool('stats', {op: 'regress', x: [1, 2, 3, 4, 5], y: [2, 4, 5, 4, 5]});
  /0\.6/.test(s3.result) ? ok('stats：一元线性回归') : no('stats 回归失败', s3.result.slice(0, 90));

  // ---------------- 全流程：控制台脚本上传 → 自动解题 → 轮询答案（对接 mock 模型）
  const paper = {
    tid: 'TEST-1', name: '自检试卷', source: 'selftest',
    questions: [{
      index: 1, qid: 1001, type: 1, typeName: '单选',
      stem: '设 D = |1 0 a 1; 0 -1 b -1; -1 -1 c -1; -1 1 d 0|，则 D = （ ）',
      stemImages: [], stemOcr: '',
      options: [
        {letter: 'A', oid: 11, text: 'a+b-d', images: [], ocr: ''},
        {letter: 'B', oid: 12, text: 'a+b+c', images: [], ocr: ''},
        {letter: 'C', oid: 13, text: 'a+b-c', images: [], ocr: ''},
        {letter: 'D', oid: 14, text: 'a+b+d', images: [], ocr: ''},
      ],
    }],
  };
  const noTok = await fetch(BASE + '/api/collect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper})});
  noTok.status === 403 ? ok('/api/collect：无 token 被拒（403）') : no('/api/collect 未鉴权', 'status=' + noTok.status);

  const col = await (await fetch(BASE + `/api/collect?t=${TOKEN}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper})})).json();
  col.ok && col.autoSolve ? ok('/api/collect：上传成功且自动开始解题') : no('/api/collect 失败', JSON.stringify(col));
  col.fillIntervalMs > 0 && col.limitBackoffMs > 0 ? ok('/api/collect：下发限流参数给控制台脚本') : no('未下发限流参数', JSON.stringify({a: col.fillIntervalMs, b: col.limitBackoffMs}));

  let final = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const j = await (await fetch(BASE + `/api/answers?t=${TOKEN}&paperId=${col.sessionId}`)).json();
    if (j.status === 'done' || j.status === 'error') { final = j; break; }
  }
  final && final.status === 'done' && final.answers['1001'] === 'D'
    ? ok('/api/answers：轮询拿到答案 D（控制台脚本据此自动填答）') : no('轮询取答案失败', JSON.stringify(final));

  // ---------------- /api/state（网页侧）
  const st = await (await fetch(BASE + '/api/state?since=0&paperId=-1')).json();
  st.paper && st.paper.questions.length === 1 && st.answers['1001'] === 'D' && st.events.some(e => e.type === 'tool')
    ? ok('/api/state：网页能拿到题目/答案/过程事件') : no('/api/state 异常', JSON.stringify({p: !!st.paper, a: st.answers}));
  st.config && st.config.model.api_key === undefined ? ok('/api/state：配置不含 key') : no('/api/state 泄露 key');
  const st2 = await (await fetch(BASE + `/api/state?since=${st.seq}&paperId=${st.sessionId}`)).json();
  st2.events.length === 0 && st2.paper === undefined ? ok('/api/state：增量轮询不重复推数据') : no('增量轮询异常');

  // ---------------- 同源手动粘贴
  const sp = await (await fetch(BASE + '/api/set-paper', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper: {...paper, tid: 'TEST-2'}})}));
  sp.status === 200 ? ok('/api/set-paper：手动粘贴可提交') : no('/api/set-paper 失败', 'status=' + sp.status);
  const bad = await fetch(BASE + '/api/set-paper', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper: {questions: []}})});
  bad.status === 400 ? ok('空题目返回 400') : no('参数校验缺失');
} catch (e) {
  no('自检过程抛出异常', e.stack || e.message);
}

for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
try { fs.rmSync(TMP, {recursive: true, force: true}); } catch {}
console.log(results.join('\n'));
console.log('='.repeat(54));
console.log(`  通过 ${pass} 项，失败 ${fail} 项\n`);
process.exitCode = fail ? 1 : 0;
