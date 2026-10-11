#!/usr/bin/env node
/**
 * 在线课程 AI 答题助手 —— 终端版
 *
 *   node cli.mjs <平台> <网页链接>
 *   平台可以写序号：1 = 中国大学MOOC / 2 = 超星学习通 / 3 = 智慧树
 *
 * 例：
 *   node cli.mjs mooc      "https://www.icourse163.org/spoc/learn/XJTU-1486472169?tid=...#/learn/quiz?id=..."
 *   node cli.mjs chaoxing  "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?..."
 *   node cli.mjs zhihuishu "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/..."
 *
 * 平台可以写 id 或中文名（mooc / 中国大学MOOC / chaoxing / 超星 / zhihuishu / 智慧树）。
 * 浏览器没开它会自己拉起来（带调试端口），登录/进页面之后它会自动继续。
 *
 * 其他：
 *   --port 9222    浏览器调试端口
 *   --sheet        只出答案单，不碰页面（智慧树这类平台默认如此）
 *   --no-fill      解题但不动页面
 *   --list         只列出浏览器里的标签
 *   --login        只打开登录窗口（借用你日常浏览器登录态；登录完再跑上面那条命令）
 *   --profile <dir> 指定浏览器 profile 目录（默认自动：优先借你日常浏览器的登录态）
 *
 * 永不提交：本程序里没有任何"点提交/交卷"的代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './lib/config.mjs';
import {loadPlatforms} from './lib/platforms.mjs';
import {listTabs, CdpSession} from './lib/cdp.mjs';
import {solvePaper} from './lib/agent.mjs';
import {renderAnswerSheet, safeName} from './lib/report.mjs';
import {bridgeSource, preparePageScript} from './lib/bridge.mjs';
import {runTool, toolSpecs} from './lib/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 终端样式
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[36m', magenta: '\x1b[35m',
};
const c = (s, col) => `${C[col] || ''}${s}${C.reset}`;
const line = () => console.log(c('  ' + '─'.repeat(66), 'dim'));
const info = m => console.log('  ' + m);
const ok = m => console.log('  ' + c('✓', 'green') + ' ' + m);
const warn = m => console.log('  ' + c('⚠', 'yellow') + ' ' + m);
const bad = m => console.log('  ' + c('✗', 'red') + ' ' + m);
const step = m => console.log('  ' + c('→', 'blue') + ' ' + m);

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const out = {flags: new Set(), opts: {}, pos: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (v !== undefined) out.opts[k] = v;
      else if (next && !next.startsWith('--')) { out.opts[k] = next; i++; }
      else out.flags.add(k);
    } else out.pos.push(a);
  }
  // node cli.mjs <平台> <链接>：第一个位置参数是平台，第二个（或含 :// 的那个）是链接
  for (const x of out.pos) {
    if (/^https?:\/\//i.test(x)) { if (!out.opts.url) out.opts.url = x; }
    else if (!out.opts.platform) out.opts.platform = x;
  }
  return out;
}

/** 平台名容错：序号(1/2/3) / id / 中文名 / 大小写 */
function matchPlatform(platforms, name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (/^\d+$/.test(n)) {
    const byOrder = platforms.find(p => String(p.order) === n) || platforms[Number(n) - 1];
    return byOrder || null;
  }
  return platforms.find(p => p.id.toLowerCase() === n)
      || platforms.find(p => (p.name || '').toLowerCase().includes(n))
      || platforms.find(p => n.includes(p.id.toLowerCase()))
      || null;
}

/** 平台菜单（终端与用法提示共用） */
function platformMenu(platforms) {
  return platforms.map((p, i) => `    ${p.order || i + 1}. ${p.name.padEnd(12)} ${p.id}${p.mode === 'cdp' ? '   (CDP 只读 → 答案单)' : ''}`).join('\n');
}

/** 浏览器在跑吗？（在跑的话没法附加调试端口，也不能用它的 profile —— Chrome 会锁住） */
async function browserRunning() {
  const {execFile} = await import('node:child_process');
  const run = cmd => new Promise(res => execFile(cmd[0], cmd.slice(1), {timeout: 5000}, (e, out) => res(String(out || ''))));
  try {
    if (process.platform === 'win32') {
      const out = await run(['tasklist', '/FI', 'IMAGENAME eq chrome.exe']);
      if (/chrome\.exe/i.test(out)) return 'chrome';
      const out2 = await run(['tasklist', '/FI', 'IMAGENAME eq msedge.exe']);
      if (/msedge\.exe/i.test(out2)) return 'edge';
      return null;
    }
    const out = await run(['ps', '-A', '-o', 'comm=']);
    if (/Google Chrome|chrome$/m.test(out)) return 'chrome';
    if (/msedge|Microsoft Edge/m.test(out)) return 'edge';
  } catch {}
  return null;
}

/** 日常浏览器的 profile 目录（用它 = 你已登录的账号，通常零登录） */
function defaultProfileDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cands = process.platform === 'win32' ? [
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
  ] : process.platform === 'darwin' ? [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
  ] : [
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/microsoft-edge'),
  ];
  return cands.find(d => d && fs.existsSync(d)) || null;
}

function helperProfileDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(home, '.course-ai-helper-profile');
}

/**
 * 决定用哪个 profile：
 *   1) --profile / config 指定
 *   2) 日常浏览器**没在跑** → 直接用它的 profile（已登录，零登录）
 *   3) 否则用助手专用 profile（登录一次，之后一直记得）
 */
async function pickProfile(explicit) {
  if (explicit) return {dir: explicit, why: '指定的 profile（--profile）', real: false};
  const running = await browserRunning();
  const def = defaultProfileDir();
  if (def && !running) {
    return {dir: def, why: '你日常浏览器的登录态 —— 通常不用再登录', real: true};
  }
  if (running) {
    return {dir: helperProfileDir(), why: `你的 ${running === 'edge' ? 'Edge' : 'Chrome'} 正在运行（它锁着 profile，也连不上调试端口）。改用助手专用 profile：**登录一次就会记住**，以后不再问`, real: false};
  }
  return {dir: helperProfileDir(), why: '助手专用 profile（登录一次就会记住）', real: false};
}

/** 浏览器调试端口连不上就用它拉一个 Chrome/Edge（带 --remote-debugging-port） */
async function ensureBrowser(port, url, profileDir) {
  try { const t = await listTabs(port); return {ok: true, launched: false, tabs: t}; } catch {}
  const profile = profileDir || helperProfileDir();
  const cands = process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['google-chrome', 'google-chrome-stable', 'chromium', 'microsoft-edge'];
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url || 'about:blank'];
  let exe = null;
  for (const c of cands) { if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) { exe = c; break; } } else exe = exe || c; }
  if (!exe) {
    bad('连不上浏览器调试端口，也没找到 Chrome/Edge。请手动启动：');
    info(c(`    chrome --remote-debugging-port=${port} --user-data-dir="${profile}" "${url || ''}"`, 'dim'));
    process.exit(2);
  }
  info(c(`    未发现调试端口 ${port}，正在启动浏览器：${path.basename(exe)}`, 'dim'));
  info(c(`    profile：${profile}`, 'dim'));
  const launch = async prof => {
    const a = args.map(x => x.startsWith('--user-data-dir=') ? `--user-data-dir=${prof}` : x);
    const {spawn} = await import('node:child_process');
    spawn(exe, a, {detached: true, stdio: 'ignore'}).unref();
  };
  try { await launch(profile); } catch (e) { bad('启动浏览器失败：' + e.message); process.exit(2); }

  // 真实 profile 可能刚好被占用（Chrome 正开着）→ 等一会儿再回退到助手 profile
  const waitPort = async secs => {
    for (let i = 0; i < secs * 2; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { const t = await listTabs(port); if (t.length) return t; } catch {}
    }
    return null;
  };
  let tabs = await waitPort(12);
  if (!tabs && profile !== helperProfileDir()) {
    warn('借不到你日常浏览器的 profile（可能刚好被占用），改用助手专用 profile（登录一次会记住）');
    try { await launch(helperProfileDir()); } catch {}
    tabs = await waitPort(20);
    if (tabs) return {ok: true, launched: true, tabs, profile: helperProfileDir()};
  }
  if (!tabs) { bad(`等了 30 秒还是连不上端口 ${port}`); process.exit(2); }
  return {ok: true, launched: true, tabs, profile};
}

/** 找到/打开目标标签：同链接复用，否则新开一个 */
async function resolveTab(port, url, {forceNew = false} = {}) {
  let tabs = [];
  try { tabs = await listTabs(port); } catch {}
  const norm = u => String(u).replace(/\/+$/, '');
  const base = u => norm(u).split('#')[0];
  if (!forceNew) {
    // ★ hash 路由的页面（智慧树/超星）必须**连 hash 一起比**，否则列表页和答题页会被当成同一个
    const exact = tabs.find(t => norm(t.url) === norm(url));
    if (exact) return exact;
    if (!url.includes('#')) {
      const same = tabs.find(t => base(t.url) === base(url));
      if (same) return same;
    }
  }
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {method: 'PUT'}).catch(() => null);
  if (r && r.ok) {
    const t = await r.json().catch(() => null);
    if (t && t.webSocketDebuggerUrl) return {id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl};
  }
  // 退路：拿一个已有标签导航过去
  const any = tabs.find(t => !/^(chrome|edge|about|devtools)/i.test(t.url));
  if (any) return any;
  return tabs[0] || null;
}

// ------------------------------------------------------------------ 自检（离线）
async function selftest() {
  console.log('\n' + c('  在线课程 AI 答题助手 · 自检（离线，不连浏览器、不调模型）', 'bold') + '\n');
  let pass = 0, fail = 0;
  const t = (name, cond, detail) => {
    if (cond) { ok(name); pass++; } else { bad(name + (detail ? '  ' + detail : '')); fail++; }
  };

  // 1. 平台注册表
  const platforms = await loadPlatforms(__dirname);
  t(`平台注册表加载了 ${platforms.length} 个平台`, platforms.length >= 2, platforms.map(p => p.id).join(','));
  for (const p of platforms) {
    t(`平台 ${p.id}：${p.mode} 模式`, !!p.id && !!p.mode);
    if (p.mode === 'script') {
      t(`平台 ${p.id}：页面脚本存在`, fs.existsSync(path.join(p.dir, p.pageScript || 'console/helper.js')));
      t(`平台 ${p.id}：配了 URL 识别规则`, p.matchUrl instanceof RegExp);
    } else {
      t(`平台 ${p.id}：CDP 只读读卷已就绪`, typeof p.readPaper === 'function');
      const src = fs.readFileSync(path.join(p.dir, 'index.mjs'), 'utf8');
      t(`平台 ${p.id}：适配层零点击（只读约束）`, !/\.click\(|fillPaper|saveDraft/.test(src));
    }
  }

  // 2. 桥接层
  const {BRIDGE_SOURCE: BS} = await import('./lib/bridge.mjs');
  t('桥接层：拦截 /api/collect 与 /api/answers', /api\/collect/.test(BS) && /api\/answers/.test(BS));
  t('桥接层：不含提交逻辑', !/submit|交卷/i.test(BS));
  const pageScript = preparePageScript('const B="__BACKEND__",T="__TOKEN__";', {backend: 'http://127.0.0.1:9', token: 'abc'});
  t('页面脚本：后端地址/token 占位符可注入', pageScript.includes('127.0.0.1:9') && pageScript.includes('"abc"'));

  // 3. 答案单
  const demo = {name: 'T', questions: [
    {index: 1, qid: 'q1', typeName: '多选', stem: '题干一', options: [{letter: 'A', text: '甲'}, {letter: 'B', text: '乙'}, {letter: 'C', text: '丙'}, {letter: 'D', text: '丁'}]},
    {index: 2, qid: 'q2', typeName: '判断', stem: '题干二', options: [{letter: 'A', text: '错'}, {letter: 'B', text: '对'}]},
    {index: 3, qid: 'q3', typeName: '填空', stem: '题干三', options: []},
  ]};
  const md = renderAnswerSheet(demo, {q1: 'AC', q2: 'B', q3: '文本'}, {siteName: 'X'});
  t('答案单：速查表 + 多选勾选', /1\. AC/.test(md) && /- \[x\] \*\*A\.\*\*/.test(md) && /- \[ \] \*\*B\.\*\*/.test(md));
  t('答案单：填空与只读声明', md.includes('文本') && md.includes('自己点鼠标填'));
  t('答案单：文件名清洗', safeName('a/b:c*d?e"f<g>h|i') === 'a-b-c-d-e-f-g-h-i');

  // 4. 配置
  const {config, note} = loadConfig(__dirname, '');
  t('配置：config.toml 可读', !!config && !!config.model);
  t('配置：模型与 key 已设置', !!config.model.model, `model=${config.model.model} key=${config.model.api_key ? '已配置' : '未配置'}`);
  t('配置：没有 auto_submit（永不交卷）', !JSON.stringify(config).includes('auto_submit'));

  // 5. 工具与数学
  t(`工具：${toolSpecs.map(x => x.function.name).join(' / ')}`, toolSpecs.length === 6);
  const det = await runTool('calc', {expression: 'det([[1,0,2,1],[0,-1,3,-1],[-1,-1,5,-1],[-1,1,4,0]]) + normalinv(0.975)'});
  t('工具：calc 行列式(9) + 正态分位数(1.95996) = 10.95996', /10\.95996/.test(det.result), det.result.slice(0, 80));
  const eig = await runTool('matrix', {op: 'eigen', a: [[2, 1], [1, 2]]});
  t('工具：matrix 特征值', /3/.test(eig.result) && /1/.test(eig.result));
  const lim = await runTool('calculus', {op: 'limit', expr: 'sin(x)/x', variable: 'x', to: 0});
  t('工具：calculus 极限 sin(x)/x → 1', /=\s*1\b/.test(lim.result) || /\b1\b/.test(lim.result));

  line();
  console.log(`  通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exitCode = fail ? 1 : 0;
}

// ------------------------------------------------------------------ 解题并打印
async function solve(paper, settings) {
  const t0 = Date.now();
  const total = paper.questions.length;
  const qState = new Map();
  const label = q => `[${q.index}/${total}]`;
  let toolCalls = 0;

  const {answers, results} = await solvePaper({
    paper, settings,
    onEvent(ev) {
      const q = paper.questions.find(x => x.qid === ev.qid) || {};
      switch (ev.type) {
        case 'start':
          step(`读到 ${total} 道题，开始解题（${settings.model} · 思考 ${settings.reasoningEffort}）`);
          break;
        case 'round':
          if (ev.round === 1) {
            console.log('  ' + c(label(q), 'dim') + ' ' + c((q.typeName || q.type || '') + ' ', 'magenta') + (q.stem || '').slice(0, 52).replace(/\n/g, ' '));
          }
          break;
        case 'tool':
          toolCalls++;
          info(c('        🔧 ' + ev.name + '(' + JSON.stringify(ev.args).slice(0, 70) + ')', 'dim'));
          break;
        case 'tool_result':
          info(c('           ↳ ' + String(ev.preview || '').replace(/\s+/g, ' ').slice(0, 70), 'dim'));
          break;
        case 'warn':
          info(c('        ⚠ ' + ev.message, 'yellow'));
          break;
        case 'error':
          bad(`${label(q)} ${ev.message}`);
          break;
        case 'answer': {
          const a = Array.isArray(ev.answer) ? ev.answer.join('') : String(ev.answer ?? '');
          const meaning = ev.meaning || ev.text || '';
          console.log('  ' + c(label(q), 'dim') + ' ' + c('✅ ' + a, 'green') + (meaning ? '  ' + c(String(meaning).slice(0, 46), 'dim') : ''));
          break;
        }
      }
    },
  });
  const ms = Date.now() - t0;
  line();
  const got = Object.values(answers).filter(Boolean).length;
  ok(`${got}/${total} 已解题 · 耗时 ${(ms / 1000).toFixed(1)}s · 工具调用 ${toolCalls} 次`);
  return {answers, results, ms};
}

// ------------------------------------------------------------------ 等页面就绪（含等用户登录）
async function waitUntilReady(session, platform, url) {
  const re = platform.matchUrl ? platform.matchUrl.source : null;
  const probe = `(() => {
    const href = location.href;
    if (${re ? `!(${re}).test(href)` : 'false'}) return 'routing';
    const n = document.querySelectorAll('.examPaper_subject, .question-item, .nodeLab, .TiMu, .questionLi').length;
    if (n > 0) return 'ready';
    const t = document.body ? document.body.innerText : '';
    if (/登录|扫码|验证码/.test(t) && t.length < 400) return 'login';
    return 'wait';
  })()`;
  for (let i = 0; i < 90; i++) {
    let st = 'ready';
    try { st = await session.eval(probe); } catch { st = 'wait'; }
    if (st === 'ready') return true;
    if (st === 'routing' && i === 3) step('等页面路由到答题界面…');
    if (i === 6) {
      warn('页面还没就绪 —— 如果需要登录，请在浏览器窗口里登录并进入答题界面');
      info(c('    本程序会继续等（最多 90 秒）', 'dim'));
    }
    await sleep(1000);
  }
  warn('等超时了，仍继续尝试读题');
  return false;
}

// ------------------------------------------------------------------ 主流程
async function main() {
  const {flags, opts} = parseArgs(process.argv.slice(2));
  const platforms = await loadPlatforms(__dirname);
  const {config: CFG} = loadConfig(__dirname, process.env.CONFIG_FILE || '');
  const settings = {
    baseUrl: CFG.model.base_url, apiKey: CFG.model.api_key, model: CFG.model.model,
    temperature: CFG.model.temperature, concurrency: CFG.model.concurrency,
    maxRounds: CFG.model.max_tool_rounds, useTools: CFG.model.use_tools,
    reasoningEffort: CFG.model.reasoning_effort, timeoutSeconds: CFG.model.timeout_seconds,
    maxRetries: CFG.model.max_retries,
  };
  const port = Number(opts.port || CFG.cdp?.port || 9222);

  console.log('\n' + c('  在线课程 AI 答题助手 · 终端版', 'bold') + c('   （只填不交卷）', 'dim'));
  line();

  if (flags.has('list')) {
    const tabs = await listTabs(port).catch(e => { bad(e.message); process.exit(2); });
    info(`端口 ${port} 上有 ${tabs.length} 个标签：`);
    for (const t of tabs) {
      const hit = platforms.find(p => p.matchUrl && p.matchUrl.test(t.url));
      info(`  ${hit ? c('●', 'green') : c('○', 'dim')} ${(t.title || '').slice(0, 26).padEnd(26)} ${t.url.slice(0, 74)}${hit ? c('  ← ' + hit.name, 'green') : ''}`);
    }
    console.log();
    return;
  }
  if (flags.has('selftest')) return selftest();

  if (!settings.apiKey) { bad('config.toml 里没填 api_key'); process.exit(2); }

  // ---- 只打开登录窗口（不需要平台）
  if (flags.has('login')) {
    const prof = await pickProfile(opts.profile || CFG.cdp?.profile || '');
    const b = await ensureBrowser(port, opts.url, prof.dir);
    ok(`浏览器已就绪（端口 ${port}）`);
    info(c(`    profile：${b.profile || prof.dir}`, 'dim'));
    info(c(`    ${prof.why}`, 'dim'));
    if (opts.url) { const t = await resolveTab(port, opts.url); if (t) info('    已打开：' + String(opts.url).slice(0, 90)); }
    info('');
    info('  请在窗口里登录并进入答题界面，然后重跑：');
    info(c('    node cli.mjs <平台> "<答题页链接>"', 'bold'));
    console.log();
    return;
  }

  // ---- 只认两个输入：平台 + 网页链接
  let platform = matchPlatform(platforms, opts.platform);
  let url = opts.url;
  if (!platform && url) platform = platforms.find(p => p.matchUrl && p.matchUrl.test(url)) || null;
  if (!platform) {
    bad('没有指定平台（或认不出来）');
    info('  用法：node cli.mjs <平台> <网页链接>');
    info('  平台可选（序号、id 或中文名都行）：');
    console.log(platformMenu(platforms));
    process.exit(2);
  }
  if (platform.matchUrl && url && !platform.matchUrl.test(url)) {
    warn(`这个链接看起来不像 ${platform.name} 的页面 —— 仍按 ${platform.name} 处理`);
  }

  // ---- 浏览器：没开就拉起来（尽量借用你日常的登录态）
  const prof = await pickProfile(opts.profile || CFG.cdp?.profile || '');
  const br = await ensureBrowser(port, url, prof.dir);
  ok(`浏览器就绪（端口 ${port}${br.launched ? '，刚启动' : '，已连接'}）`);
  info(c(`    profile：${br.profile || prof.dir} —— ${prof.why}`, 'dim'));
  let tab = null;
  if (url) {
    tab = await resolveTab(port, url, {forceNew: flags.has('new')});
    if (!tab) { bad('没能打开标签'); process.exit(2); }
    const strip = u => String(u).split('#')[0].replace(/\/+$/, '');
    if (strip(tab.url) !== strip(url)) {
      step('打开页面：' + url.slice(0, 90));
      const tmp = await CdpSession.attach(tab);
      await tmp.navigate(url).catch(() => {});
      tmp.close();
      await sleep(1200);
      const fresh = await listTabs(port);
      tab = fresh.find(t => norm(t.url) === norm(url)) || fresh.find(t => t.url.includes(String(url).split('#')[1] || '\u0000')) || tab;
    }
  } else {
    const tabs = await listTabs(port);
    tab = tabs.find(t => platform.matchUrl && platform.matchUrl.test(t.url)) || null;
    if (!tab) {
      bad(`没有给定链接，也没找到 ${platform.name} 的页面`);
      info('  用法：node cli.mjs <平台> <网页链接>');
      process.exit(2);
    }
  }
  ok(`平台：${platform.name}（${platform.mode === 'cdp' ? 'CDP 只读' : '页面脚本'}模式）`);
  info(c('     ' + (tab.url || '').slice(0, 100), 'dim'));

  const session = await CdpSession.attach(tab);
  const sheetOnly = flags.has('sheet') || flags.has('no-fill') || platform.mode === 'cdp';
  await waitUntilReady(session, platform, url);

  let paper = null, fillResult = null;
  if (platform.mode === 'script' && !sheetOnly) {
    // ---- 注入桥接层 + 页面脚本，让脚本自己读题（还是那套验证过的 DOM 逻辑）
    step('注入页面脚本，让它自己读题…');
    await session.eval(bridgeSource({pollSeconds: CFG.app.poll_seconds, fillIntervalMs: CFG.app.fill_interval_ms, limitBackoffMs: CFG.app.limit_backoff_ms}));
    const helperPath = path.join(platform.dir, platform.pageScript || 'console/helper.js');
    const src = preparePageScript(fs.readFileSync(helperPath, 'utf8'));
    session.eval(src).catch(e => info(c('    (脚本执行返回：' + e.message.slice(0, 60) + ')', 'dim')));

    // 等它把题目交上来
    paper = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const raw = await session.eval('window.__BRIDGE__ && window.__BRIDGE__.paper ? JSON.stringify(window.__BRIDGE__.paper) : null').catch(() => null);
      if (raw) { paper = JSON.parse(raw); break; }
    }
    if (!paper || !paper.questions?.length) {
      bad('页面脚本没能读到题目。请确认浏览器停在答题界面（能看到题目和选项）。');
      const diag = await session.eval('typeof __ZHS_HELPER__ === "object" ? JSON.stringify(__ZHS_HELPER__.diagnose()) : "(该平台脚本无诊断)"').catch(() => null);
      if (diag && diag !== '"(该平台脚本无诊断)"') info(c(diag.slice(0, 400), 'dim'));
      session.close();
      process.exit(3);
    }
    // 桥接层是"先别自动解题"，这里由终端来解
    const {answers} = await solve(paper, settings);

    step('把答案交回页面脚本，让它自己填…');
    await session.eval(`window.__BRIDGE__.answers = ${JSON.stringify(answers)}; window.__BRIDGE__.status = 'done';`);
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = await session.eval('window.__BRIDGE__.status').catch(() => null);
      if (st === 'delivering') break;
    }
    await sleep(1500);
    fillResult = {done: true};
  } else {
    // ---- CDP 只读：直接从 DOM 读卷（能穿透闭合 Shadow DOM），不执行页面脚本、不点击
    if (platform.mode === 'cdp') step('CDP 只读读取答题页（不执行页面脚本、不点击任何东西）…');
    else step('CDP 只读读取答题页…');
    paper = await platform.readPaper(session);
    if (!paper || !paper.questions?.length) {
      bad('没读到题目。请确认浏览器停在答题界面。');
      const d = await platform.diagnose?.(session).catch(() => null);
      if (d) info(c(JSON.stringify(d), 'dim'));
      session.close();
      process.exit(3);
    }
    const {answers} = await solve(paper, settings);
    const md = renderAnswerSheet(paper, answers, {
      siteName: platform.name, model: settings.model, url: tab.url,
      solvedAt: new Date().toLocaleString('zh-CN'),
    });
    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, {recursive: true});
    const file = path.join(dataDir, `${safeName(paper.name || paper.title || 'answer')}-答案单-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, md, 'utf8');
    ok('答案单已保存：' + path.relative(__dirname, file));
    info(c(md.split('## 逐题')[0].split('## 速查')[1]?.replace(/```/g, '').trim() || '', 'green'));
  }

  line();
  if (sheetOnly) {
    warn('本模式只出答案单，没有在页面上做任何修改。交卷请你自己来。');
  } else {
    warn('答案已填入页面。请自己核对后再提交 —— 本工具不会替你提交。');
  }
  console.log();
  session.close();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
main().catch(e => { bad('出错：' + (e && e.message || e)); process.exit(1); });
