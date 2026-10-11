#!/usr/bin/env node
/**
 * 在线课程 AI 答题助手 —— 终端版
 *
 *   node cli.mjs <平台> [网页链接]        ← 链接可省略：省略时把浏览器开好，你在里面点进答题页即可
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
 *   --doctor       诊断：浏览器在不在跑、会用哪个 exe/profile、登录态从哪来（不启动任何东西）
 *   --login        只打开登录窗口（借用你日常浏览器登录态；登录完再跑上面那条命令）
 *   --rounds <n>    每题最多让模型调用几轮工具（默认取 config.toml 的 max_tool_rounds）
 *   --profile <dir> 指定浏览器 profile 目录（默认自动：优先借你日常浏览器的登录态）
 *   --browser <exe> 指定浏览器可执行文件（默认自动找；找不到会问你一次并记进 config.toml）
 *
 * 永不提交：本程序里没有任何"点提交/交卷"的代码。
 */
import fs from 'node:fs';
import readline from 'node:readline';
import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig, saveCdpSetting} from './lib/config.mjs';
import {loadPlatforms} from './lib/platforms.mjs';
import {listTabs, CdpSession, browserFetch} from './lib/cdp.mjs';
import {solvePaper} from './lib/agent.mjs';
import {renderAnswerSheetText} from './lib/report.mjs';
import {bridgeSource, preparePageScript, cleanConsoleArgs} from './lib/bridge.mjs';
import {runTool, toolSpecs, setBrowserFetcher} from './lib/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 把本次运行的终端输出同时写进 data/logs/run-<时间>.log（去掉 ANSI 颜色） */
function startRunLog() {
  try {
    const dir = path.join(__dirname, 'data', 'logs');
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const orig = console.log.bind(console);
    console.log = (...a) => {
      orig(...a);
      try {
        // 同步写：流是异步的，进程退出时最后几行会丢
        fs.appendFileSync(file, a.map(x => (typeof x === 'string' ? x : String(x))).join(' ').replace(/\x1b\[[0-9;]*m/g, '') + '\n');
      } catch {}
    };
    return file;
  } catch { return null; }
}

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

/**
 * 日常浏览器的 profile 目录候选表。
 *
 * ★ 这里**只做 fs.existsSync 存在性检查**，不扫描磁盘、不读取任何浏览器数据文件。
 *   这些路径都是 Chromium 系浏览器的公开约定位置（各系统固定）。
 *   ★ 关键：我们不需要解密 cookie —— 我们是把整个 profile 目录**交给 Chrome 自己**去用，
 *     Chrome 会带着用户已登录的会话打开页面。所以 Chrome 127+ 的 App-Bound Encryption
 *     对本工具毫无影响（那玩意只挡"从外部解密 cookie"的做法）。
 */
export function profileCandidates(exePath) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const L = process.env.LOCALAPPDATA || '';       // Windows：当前用户
  const A = process.env.APPDATA || '';
  const exe = String(exePath || '');
  // 从可执行文件名推断"家族" —— 填了便携版 Chrome，就别再去看 Edge 的目录
  const family = /msedge/i.test(exe) ? 'edge'
    : /360/i.test(exe) ? '360'
    : /qqbrowser/i.test(exe) ? 'qq'
    : /sogou/i.test(exe) ? 'sogou'
    : /chrome|chromium/i.test(exe) ? 'chrome'
    : 'any';
  const keep = name => family === 'any'
    || (family === 'edge' && /^Edge/.test(name))
    || (family === 'chrome' && /^Chrom/.test(name))
    || (family === '360' && /360/.test(name))
    || (family === 'qq' && /QQ/.test(name))
    || (family === 'sogou' && /搜狗/.test(name));

  let list;
  if (process.platform === 'win32') list = [
    ['Chrome', path.join(L, 'Google/Chrome/User Data')],
    ['Chrome Beta', path.join(L, 'Google/Chrome Beta/User Data')],
    ['Chrome Dev', path.join(L, 'Google/Chrome Dev/User Data')],
    ['Chrome Canary', path.join(L, 'Google/Chrome SxS/User Data')],
    ['Edge', path.join(L, 'Microsoft/Edge/User Data')],
    ['Edge Beta', path.join(L, 'Microsoft/Edge Beta/User Data')],
    ['360 极速浏览器', path.join(L, '360Chrome/Chrome/User Data')],
    ['QQ 浏览器', path.join(L, 'Tencent/QQBrowser/User Data')],
    ['搜狗浏览器', path.join(A, 'SogouExplorer/User Data')],
  ];
  else if (process.platform === 'darwin') list = [
    ['Chrome', path.join(home, 'Library/Application Support/Google/Chrome')],
    ['Chrome Beta', path.join(home, 'Library/Application Support/Google/Chrome Beta')],
    ['Chrome Canary', path.join(home, 'Library/Application Support/Google/Chrome Canary')],
    ['Edge', path.join(home, 'Library/Application Support/Microsoft Edge')],
    ['Chromium', path.join(home, 'Library/Application Support/Chromium')],
  ];
  else list = [
    ['Chrome', path.join(home, '.config/google-chrome')],
    ['Chrome Beta', path.join(home, '.config/google-chrome-beta')],
    ['Chromium', path.join(home, '.config/chromium')],
    ['Edge', path.join(home, '.config/microsoft-edge')],
  ];
  list = list.filter(([n]) => keep(n));

  // ★ 便携版/绿色版：登录态通常在 exe 旁边，而不是系统标准目录
  if (exe) {
    const dir = path.dirname(exe);
    const parent = path.dirname(dir);
    list = [
      [`exe 同级 User Data`, path.join(dir, 'User Data')],
      [`exe 同级 u-data`, path.join(dir, 'u-data')],
      [`exe 同级 profile`, path.join(dir, 'profile')],
      [`exe 上级 User Data`, path.join(parent, 'User Data')],
      ...list,
    ];
  }
  return list;
}

/**
 * 把用户填的路径规范化。
 *
 * 坑：`chrome://version` 里的「配置文件路径」给的是 `...\User Data\Default`，
 * 而 `--user-data-dir` 要的是**上一级** `...\User Data`。
 * 如果直接把 `...\Default` 当 user-data-dir，Chrome 会在它里面再建一个 Default —— 等于一个全新 profile，白登录。
 * 所以这里自动往上退一级。
 */
export function normalizeProfileDir(p) {
  if (!p) return {dir: p, adjusted: false};
  const orig = String(p);
  let d = orig.replace(/[\/]+$/, '');
  const base = path.basename(d);
  const isProfileFolder = /^Default$/i.test(base) || /^Profile \d+$/i.test(base) || /^Guest Profile$/i.test(base);
  if (!isProfileFolder) return {dir: d, adjusted: d !== orig};
  const parent = path.dirname(d);
  if (parent && parent !== d && path.dirname(parent) !== parent) {
    // 指到 Default / Profile N 里，一定是想指 User Data —— 无条件上退一级
    return {dir: parent, adjusted: true, parentLooksUserData: path.basename(parent).toLowerCase() === 'user data' || fs.existsSync(path.join(parent, 'Local State'))};
  }
  return {dir: d, adjusted: d !== orig};
}

/** 看起来像个真 profile 吗（有 Default/ 或 Local State）—— 免得选到空壳目录 */
function looksLikeProfile(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Default')) || fs.existsSync(path.join(dir, 'Local State'));
  } catch { return false; }
}

/** 返回 {dir, name, checked:[{name,dir,exists}]}；找不到就 dir=null（调用方会退回助手 profile） */
function findDefaultProfile(exePath) {
  const cands = profileCandidates(exePath).filter(([, d]) => d);
  const checked = cands.map(([name, dir]) => ({name, dir, exists: fs.existsSync(dir) && looksLikeProfile(dir)}));
  const hit = checked.find(c => c.exists);
  return {dir: hit ? hit.dir : null, name: hit ? hit.name : null, checked};
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
/**
 * 选一套 profile 给浏览器用。
 *
 * ★ 为什么不用你日常的 Chrome profile：
 *   Chrome 136 起（见 https://developer.chrome.com/blog/remote-debugging-port ），
 *   对**默认数据目录**使用 --remote-debugging-port / --remote-debugging-pipe 会被**直接忽略**。
 *   也就是说"借用你日常登录态"从设计上就不可行了 —— 强行这么干只会得到一个
 *   没有调试端口的浏览器（工具连不上去）。这是 Google 的安全加固，我们尊重它。
 *
 *   所以我们固定用一个**非默认目录**（助手专用 profile）：登录一次，之后一直有效。
 */
const isDefaultProfileDir = d => {
  const {dir} = normalizeProfileDir(d);
  const def = findDefaultProfile('');
  return !!def.dir && path.resolve(dir).toLowerCase() === path.resolve(def.dir).toLowerCase();
};

async function pickProfile(explicit, exePath, {interactive = true} = {}) {
  if (explicit) {
    const {dir, adjusted} = normalizeProfileDir(explicit);
    if (adjusted && dir !== explicit) {
      info(c(`    路径已自动上退一级：${explicit}`, 'dim'));
      info(c(`                  →  ${dir}   （--user-data-dir 要的是 User Data，不是里面的 Default）`, 'dim'));
    }
    if (isDefaultProfileDir(dir)) {
      warn('这是你日常 Chrome 的默认数据目录 —— Chrome 136+ 不允许对它开调试端口，工具会连不上');
      info(c('    建议改用助手专用 profile（登录一次会记住）：把 [cdp] profile 留空', 'dim'));
    }
    return {dir, why: '指定的 profile（--profile / [cdp] profile）'};
  }
  const helper = helperProfileDir();
  const first = !fs.existsSync(path.join(helper, 'Default'));
  return {dir: helper, why: '助手专用 profile（非默认目录 —— Chrome 136+ 只允许对非默认目录开调试端口）', first};
}

/** 找不到日常 profile 时，把查过的位置打印出来（用户可以用 --profile 手动指） */
function explainProfileSearch(prof) {
  if (!prof.checked) return;
  info(c('    查过这些位置（都要求目录里有 Default/ 或 Local State）：', 'dim'));
  for (const chk of prof.checked) info(c(`      ${chk.exists ? '✓' : '·'} ${String(chk.name).padEnd(14)} ${chk.dir}`, 'dim'));
  info(c('    你的浏览器装在别处？用 --profile "<User Data 目录>" 指定，或在 config.toml 里写 [cdp] profile', 'dim'));
}

/** 常见安装位置（只做存在性检查）。想让用户自己填就用 config 的 [cdp] browser */
function detectBrowserExe() {
  const cands = process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['google-chrome', 'google-chrome-stable', 'chromium', 'microsoft-edge'];
  for (const c of cands) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return c; }
    else if (commandExists(c)) return c;   // PATH 里的命令名：确认真能跑再返回
  }
  return null;
}

/** PATH 里有没有这个命令（bare name 不能只看非空） */
function commandExists(name) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {stdio: 'ignore'});
    return r.status === 0;
  } catch { return false; }
}

/** 交互式问一次浏览器路径（并写回 config.toml，以后不再问） */
function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    rl.question(question, ans => { rl.close(); resolve(String(ans || '').trim()); });
  });
}

async function resolveBrowserExe(cfg, opts, {interactive = true} = {}) {
  for (const cand of [opts.browser, cfg.cdp?.browser]) {
    if (!cand) continue;
    if (fs.existsSync(cand) || !cand.includes(path.sep)) return cand;
    warn(`config 里的浏览器路径不存在：${cand}`);
  }
  const auto = detectBrowserExe();
  if (auto && (auto.includes('/') || auto.includes('\\') ? fs.existsSync(auto) : true)) return auto;

  info('');
  warn('没找到 Chrome / Edge。可以自己填它的完整路径（只问这一次，会记进 config.toml）');
  const example = process.platform === 'win32' ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
  info(c(`    例：${example}`, 'dim'));
  if (!interactive || !process.stdin.isTTY) {
    bad('请把路径填到 config.toml 的 [cdp] browser，或用 --browser "<路径>"');
    process.exit(2);
  }
  const p = await ask('  浏览器完整路径（直接回车=放弃）: ');
  if (!p) { bad('没有浏览器就没法继续。也可以用 --login 模式先手动开一个（见 README）'); process.exit(2); }
  if (!fs.existsSync(p)) { bad(`这个路径不存在：${p}`); process.exit(2); }
  try {
    const file = saveCdpSetting(__dirname, process.env.CONFIG_FILE || '', 'browser', p);
    ok('已记住：' + path.relative(__dirname, file) + ' → [cdp] browser');
  } catch (e) { warn('写配置失败（不影响本次运行）：' + e.message); }
  return p;
}

/**
 * 拿到一个可用的浏览器：
 *   1) 调试端口上已经有浏览器 → 直接用（**不需要** exe，也问不到它用哪个 profile）
 *   2) 没有 → 才需要 exe + profile，然后自己启动
 */
async function ensureBrowserSmart(port, startUrl, CFG, opts) {
  try {
    const tabs = await listTabs(port);
    ok(`已有浏览器在调试端口 ${port} 上（直接用它，不会另开窗口）`);
    return {ok: true, launched: false, tabs, profile: null, attached: true};
  } catch {}
  const exe = await resolveBrowserExe(CFG, opts);
  const prof = await pickProfile(opts.profile || CFG.cdp?.profile || '', exe);
  const br = await ensureBrowser(port, startUrl, prof.dir, exe);
  info(c(`    profile：${br.profile || prof.dir}`, 'dim'));
  info(c(`    ${prof.why}`, 'dim'));
  return {...br, firstTime: !!prof.first};
}

/** 浏览器调试端口连不上就用它拉一个 Chrome/Edge（带 --remote-debugging-port） */
async function ensureBrowser(port, url, profileDir, exePath) {
  try { const t = await listTabs(port); return {ok: true, launched: false, tabs: t}; } catch {}
  const profile = profileDir || helperProfileDir();
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url || 'about:blank'];
  const exe = exePath || detectBrowserExe();
  if (!exe) { bad('没找到浏览器可执行文件（用 --browser 指定，或在 config.toml 里填 [cdp] browser）'); process.exit(2); }
  info(c(`    未发现调试端口 ${port}，正在启动浏览器：${path.basename(exe)}`, 'dim'));
  info(c(`    profile：${profile}`, 'dim'));
  let launchErr = null;
  const launch = prof => {
    const a = args.map(x => x.startsWith('--user-data-dir=') ? `--user-data-dir=${prof}` : x);
    const child = spawn(exe, a, {detached: true, stdio: 'ignore'});
    // ★ spawn 的失败是异步 'error' 事件，try/catch 抓不到，必须挂监听
    child.on('error', e => { launchErr = e; });
    child.unref();
  };
  launch(profile);

  // 真实 profile 可能刚好被占用（Chrome 正开着）→ 等一会儿再回退到助手 profile
  const waitPort = async secs => {
    for (let i = 0; i < secs * 2; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { const t = await listTabs(port); if (t.length) return t; } catch {}
    }
    return null;
  };
  let tabs = await waitPort(40);          // 冷启动 + 恢复标签可能较慢，给足时间
  if (!tabs && launchErr) {
    bad(`启动不了浏览器（${exe}）：${launchErr.message}`);
    info('  请手动启动一个带调试端口的浏览器，然后重跑：');
    info(c(`    chrome --remote-debugging-port=${port} --user-data-dir="<某个目录>"`, 'dim'));
    process.exit(2);
  }
  if (!tabs && profile !== helperProfileDir()) {
    warn('借不到你日常浏览器的 profile（可能刚好被占用），改用助手专用 profile（登录一次会记住）');
    launch(helperProfileDir());
    tabs = await waitPort(20);
    if (!tabs && launchErr) { bad(`启动不了浏览器（${exe}）：${launchErr.message}`); process.exit(2); }
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

  // 2b. 浏览器/profile 定位
  const portable = path.join(path.sep + 'tmp', 'ChromePortable', 'chrome.exe');
  const pc = profileCandidates(portable).map(([, d]) => d);
  t('profile 探测：便携版会看 exe 同级的 User Data', pc.includes(path.join(path.dirname(portable), 'User Data')));
  const edgeCands = profileCandidates(path.join('C:', 'Edge', 'msedge.exe')).map(([n]) => n).join(',');
  t('profile 探测：按浏览器家族过滤（填了 Edge 就不去找 Chrome）',
    !/Chrome/.test(edgeCands) && /Edge/.test(edgeCands), edgeCands);
  t('profile 探测：没给 exe 时也给标准位置', profileCandidates('').length > 0);
  const od = normalizeProfileDir;
  const sep = path.sep;
  t('profile 规范化：…/User Data/Default → …/User Data',
    od(`${sep}tmp${sep}ud${sep}Default`).dir === `${sep}tmp${sep}ud`,
    od(`${sep}tmp${sep}ud${sep}Default`).dir);
  t('profile 规范化：…/User Data/Profile 2 → …/User Data',
    od(`${sep}tmp${sep}ud${sep}Profile 2`).dir === `${sep}tmp${sep}ud`);
  t('profile 规范化：已经是 User Data 就原样',
    od(`${sep}tmp${sep}User Data`).dir === `${sep}tmp${sep}User Data`);

  // 2. 桥接层
  const {BRIDGE_SOURCE: BS} = await import('./lib/bridge.mjs');
  t('桥接层：拦截 /api/collect 与 /api/answers', /api\/collect/.test(BS) && /api\/answers/.test(BS));
  t('桥接层：不含提交逻辑', !/submit|交卷/i.test(BS));
  const pageScript = preparePageScript('const B="__BACKEND__",T="__TOKEN__";', {backend: 'http://127.0.0.1:9', token: 'abc'});
  t('页面脚本：后端地址/token 占位符可注入', pageScript.includes('127.0.0.1:9') && pageScript.includes('"abc"'));
  // ★ 回归防护：页面脚本里有 BACKEND.includes('__BACKEND__') 这种自检，
  //   全局替换会把守卫也换掉 → 恒为真 → 脚本反而判定"没被注入"而放弃（真踩过）
  const guardSample = "const BACKEND = '__BACKEND__';\nif (BACKEND.includes('__BACKEND__')) return 'not injected';";
  const guardOut = preparePageScript(guardSample);
  t('页面脚本注入：只换赋值、不动自检守卫',
    guardOut.includes("const BACKEND = 'http://127.0.0.1:0'") && guardOut.includes("BACKEND.includes('__BACKEND__')"),
    guardOut.split('\n')[1]);

  // 2c. 工具结果截断（省钱关键：超长结果会在后续每一轮被重发）
  const {truncateToolResult, pickToolsForQuestion, pickToolsForPaper: await_import_paper} = await import('./lib/agent.mjs');
  const long = 'x'.repeat(50000);
  const cut = truncateToolResult(long, 2000);
  t('工具结果截断：50000 → 2000 字符 + 截断说明',
    cut.length < 2100 && cut.includes('已截断') && cut.startsWith('x'.repeat(100)));
  t('工具结果截断：短结果原样返回', truncateToolResult('abc', 2000) === 'abc');

  // 2d. 联网工具的正确性（离线可验证的部分）
  const {stripTags, relevantEnough, looksBlocked} = await import('./lib/tools.mjs');
  // ★ 回归防护：stripTags 原来只把 [ \t\u00a0]+ 压成单空格，
  //   "<div></div><div></div>" → "\n \n \n"，而 \n{3,} 匹配不到（中间夹空格），
  //   于是正文里 18%~24% 是纯空白行，白吃掉 web_result_chars 的截断窗口。
  //   实测 gushiwen 的《文心雕龙》目录里 needle「序志」在 1285 字符处 → 被 cap=1200 切掉、模型永远看不到。
  const padded = stripTags('<div>甲</div><div></div><div></div><div>乙</div><div>   </div><div>丙</div>');
  t('网页去标签：空 div 不留空白行（否则白吃截断窗口）',
    padded === '甲\n乙\n丙', JSON.stringify(padded));
  t('网页去标签：连续空行被折成一个',
    !/\n\s*\n/.test(stripTags('<p>甲</p><div></div><div></div><div>乙</div>')));
  // ★ 相关性闸门：Bing 对多词查询会退化成"查询第一个字的字典页"（实测见 lib/tools.mjs 注释）。
  //   没有闸门的话垃圾会当结果返回，而且会因为"有结果"而让 DuckDuckGo 兜底永不触发。
  const junk = [
    {title: '大 （汉语文字）_百度百科', snippet: '大（拼音：dà、dài、tài）是汉语一级通用规范汉字'},
    {title: '大 的意思, 大 的解释', snippet: '大的部首是大部'},
  ];
  t('搜索相关性闸门：挡住"首字字典页"式降级结果',
    relevantEnough('大历十才子 五言长城 刘长卿', junk) === false);
  t('搜索相关性闸门：正常结果放行',
    relevantEnough('大历十才子 五言长城 刘长卿', [{title: '刘长卿被誉为五言长城', snippet: '唐代诗人刘长卿自诩为五言长城'}]) === true);
  t('搜索相关性闸门：整串命中（模型把整句当查询）放行',
    relevantEnough('五言长城是谁', [{title: '五言长城是谁', snippet: '即刘长卿'}]) === true);
  t('搜索相关性闸门：空结果不放行', relevantEnough('任意查询', []) === false);
  // ★ 借鉴 @deepseek-ai/dsh-tool-web（MIT）的多查询设计：一次调用收 1~4 条查询并发执行、
  //   轮询合并、按 URL 去重。目的不是"搜得更多"，而是**少几轮往返** ——
  //   模型每多调一次工具，就要把整段对话重发一次，轮次才是真正的成本来源。
  const {mergeSearchLists, normalizeQueries, trimLeadingNav,
          splitPassages, selectRelevant} = await import('./lib/tools.mjs');
  // ★ 截断从"按位置砍前 N 字符"改成"按相关性挑句子"。
  //   实测 360百科：不给 focus 时「考文垂」在 1200 窗口外、看不到；给了 focus 就精准挑到
  //   「12战斗机群，伯明翰，考文垂，伊普斯维奇…利物浦…」那句。
  {
    const filler = '这段是无关的铺垫内容，用来把真正相关的句子推到很后面去。';
    const body = Array.from({length: 40}, () => filler).join('\n') + '\n12战斗机群负责伯明翰、考文垂、利物浦及其周边地区。';
    t('相关性挑选：把埋在最后的答案句捞进窗口',
      selectRelevant(body, '考文垂 伯明翰 利物浦', 300)?.text.includes('考文垂') === true);
    t('相关性挑选：一个词都没命中 → 返回 null（退回头部截断）',
      selectRelevant(body, '量子纠缠 波函数坍缩', 300) === null);
    t('相关性挑选：不给 focus → 返回 null', selectRelevant(body, '', 300) === null);
    t('相关性挑选：遵守字符预算',
      (selectRelevant(body, '无关 铺垫', 200)?.text.length || 0) <= 220);
    // 命中分散在多句时：必须按**原文顺序**还原，并用「……」标出跳跃（否则读起来是断裂的）
    const multi = '关键甲在这里。中间这句无关。关键甲又出现在这里。';
    const picked = selectRelevant(multi, '关键甲', 200);
    t('切割与还原：多命中按原文顺序还原、跳跃处留标记',
      picked?.text === '关键甲在这里。\n……\n关键甲又出现在这里。', JSON.stringify(picked?.text));
    t('切割：单字词被过滤（≥2 字才算术语）', selectRelevant(multi, '甲', 200) === null);
    t('切割：中文句末标点会被切开', splitPassages('甲。乙！丙？').length === 3);
    t('切割：空行不产生空段', splitPassages('甲\n\n\n乙').length === 2);
  }
  // ★ Node 抓不到"正文容器"（没 DOM），用"导航是短词、正文是长句"近似跳过导航。
  //   实测 360百科前 600 字全是「网页/资讯/AI问答/视频/登录/注册…」，把截断窗口吃光。
  {
    const nav = ['网页', '资讯', 'AI问答', '视频', '图片', '登录', '注册'].join('\n');
    const prose = '不列颠战役是第二次世界大战期间纳粹德国对英国发动的大规模空战，也是二战中规模最大的空战。';
    t('跳过导航：从第一条长行开始取', trimLeadingNav(nav + '\n' + prose) === prose);
    t('跳过导航：首行就是正文时原样不动', trimLeadingNav(prose + '\n' + nav) === prose + '\n' + nav);
    t('跳过导航：全页都是短条目（目录型）不误伤',
      trimLeadingNav(nav) === nav);
  }
  // ★ 联网预算按**调用次数**算，不按查询条数 —— 这一点是量出来的：
  //   一次 4 条查询的结果被 max_results 合并限长，进上下文的量和 1 条查询几乎一样，
  //   真正花钱的是轮次。按条数计费会把搜索预算砍到 1/3，模型只好空转（实测 123 秒）。
  t('联网预算：一次调用最多带 4 条查询',
    normalizeQueries({queries: ['a', 'b', 'c', 'd', 'e', 'f']}).length === 4);
  t('联网预算：查询去重（同样的词不用搜两遍）',
    normalizeQueries({queries: ['a', 'a', 'b']}).length === 2);
  t('联网预算：query 与 queries 两种写法都吃',
    normalizeQueries({query: 'a'}).length === 1 && normalizeQueries({queries: ['b']}).length === 1);
  {
    const A = [{title: 'a1', url: 'https://x.com/1'}, {title: 'a2', url: 'https://x.com/2'}, {title: 'a3', url: 'https://x.com/3'}];
    const B = [{title: 'b1', url: 'https://y.com/9'}, {title: 'a1dup', url: 'https://x.com/1/'}, {title: 'b2', url: 'https://y.com/2'}];
    const merged = mergeSearchLists([A, B], 5).map(r => r.title).join(',');
    t('搜索合并：轮询取样（每条查询都能贡献头号结果）', merged === 'a1,b1,a2,b2,a3', merged);
    t('搜索合并：按 URL 去重（尾斜杠/锚点视为同一个）',
      mergeSearchLists([A, B], 9).filter(r => /dup/.test(r.title)).length === 0);
    t('搜索合并：遵守总数上限', mergeSearchLists([A, B], 2).length === 2);
    t('搜索合并：空输入不炸', mergeSearchLists([[], []], 5).length === 0);
  }
  // ★ 打分选最优：只判"有没有任一词命中"不够 —— 实测查「量子纠缠 是什么 通俗解释」时，
  //   Bing 那份整体跑题的结果里第 4 条摘要偶然出现"量子纠缠"就足以过关。
  const {relevanceScore} = await import('./lib/tools.mjs');
  t('搜索打分：跑题结果 0 分', relevanceScore('大历十才子 五言长城 刘长卿', [
    {title: '大 （汉语文字）_百度百科', snippet: '大的部首是大部'},
  ]) === 0);
  t('搜索打分：命中越多分越高（标题命中再加权）', (() => {
    const q = '司马迁 史记 体例 纪传体';
    const weak = relevanceScore(q, [{title: '某随笔', snippet: '司马迁 只是《史记》的编撰者'}]);
    const strong = relevanceScore(q, [{title: '史记（司马迁所著的纪传体史书）', snippet: '《史记》分本纪、表、书、世家、列传五部分'}]);
    return strong > weak && weak > 0;
  })());
  // 回归防护：书名号会把明明命中的结果判成不相关（"《春秋》" vs 结果里的"春秋"）
  t('搜索打分：书名号/引号不参与匹配',
    relevanceScore('《春秋》 编年体 史书', [{title: '春秋（儒家典籍）', snippet: '中国现存最早的编年体史书'}]) >= 2.5);
  // ★ 拦截页必须报错而不是当正文：原来 403 时把"百度安全验证"6 个字喂给模型，
  //   模型看不出这是失败，容易当成"没查到"的证据继续推理。
  t('抓取拦截识别：百度安全验证 403 → 判定为墙',
    looksBlocked(403, '百度安全验证', '百度安全验证') === true);
  t('抓取拦截识别：正常长正文不误判',
    looksBlocked(200, '文心雕龙 - 维基百科', '《文心雕龙》是南朝刘勰创作的文学理论著作，'.repeat(20)) === false);
  // ★ 浏览器兜底：直连被反爬挡住/连不上时，改用真实 Chrome 开后台标签抓。
  //   用 127.0.0.1:9（连接必然被拒）做离线触发点，不依赖网络、不真开浏览器。
  const {webFetch, setBrowserFetcher, hasBrowserFetcher, needsBrowser, isRedirectShell} = await import('./lib/tools.mjs');
  const noNet = 'http://127.0.0.1:9/';
  t('抓取兜底：没接浏览器时照常报错', (await webFetch({url: noNet})).includes('抓取失败'));
  t('抓取兜底：未注入时 hasBrowserFetcher 为 false', hasBrowserFetcher() === false);
  setBrowserFetcher(async () => ({title: '兜底页', text: '甲'.repeat(300), url: 'https://example.com/x'}));
  t('抓取兜底：注入后 hasBrowserFetcher 为 true', hasBrowserFetcher() === true);
  const viaFake = await webFetch({url: noNet});
  t('抓取兜底：直连失败 → 走浏览器抓取并标注来源',
    viaFake.includes('浏览器抓取') && viaFake.includes('甲甲'), viaFake.slice(0, 60));
  // 兜底抓回来还是验证页 → 必须放弃，不能把验证页当正文
  setBrowserFetcher(async () => ({title: '百度安全验证', text: '百度安全验证', url: noNet}));
  t('抓取兜底：抓回来仍是验证页 → 不当正文', (await webFetch({url: noNet})).includes('抓取失败'));
  setBrowserFetcher(null);
  t('抓取兜底：可以摘掉（不用浏览器时零影响）', hasBrowserFetcher() === false);
  // ★ 搜索引擎的"跳转链接"（搜狗/360）是 JS 跳转壳页：Node 直连拿到的是 HTTP 200 + 脚本，
  //   看着像成功其实是废的。实测经真实浏览器能正常跳到网易/百度文库等真页面。
  t('抓取判定：搜狗跳转链接要走浏览器',
    isRedirectShell('https://www.sogou.com/link?url=abc') === true
    && needsBrowser(200, '', '一段脚本', 'https://www.sogou.com/link?url=abc') === true);
  t('抓取判定：360 跳转链接要走浏览器',
    needsBrowser(200, '', '', 'https://www.so.com/link?m=xyz') === true);
  t('抓取判定：正常页面不走浏览器（否则每题都白白多开标签）',
    needsBrowser(200, '文心雕龙 - 维基百科', '《文心雕龙》共十卷五十篇。'.repeat(20), 'https://zh.wikipedia.org/wiki/x') === false);
  t('抓取判定：空壳页（无标题+极短正文）走浏览器',
    needsBrowser(200, '', 'Loading...', 'https://example.com/x') === true);
  // ★★ 安全回归防护（这条是整件事的红线）：
  //    实测把标签当"答题页"并保持可见后 —— background:true 的临时标签完全不影响它
  //    （visibilityState 仍为 visible、hasFocus() 仍为 true），而**前台**标签会立刻把它
  //    变成 hidden + 失去焦点，正是超星/智慧树那类防作弊系统判定"切屏"的信号。
  //    所以 browserFetch 里绝不允许存在"background 失败就退回前台标签"的兜底。
  {
    const cdpSrc = fs.readFileSync(path.join(__dirname, 'lib', 'cdp.mjs'), 'utf8');
    t('安全红线：browserFetch 只用后台标签，绝不退回前台（否则会切走答题页）',
      /background:\s*true/.test(cdpSrc)
      && !/catch\s*\{[^}]*Target\.createTarget[^}]*\{url:\s*'about:blank'\}\s*\)/.test(cdpSrc)
      && !/created\s*=\s*await bsend\('Target\.createTarget',\s*\{\s*url:\s*'about:blank'\s*\}\)/.test(cdpSrc));
    t('安全红线：抓取后自检"后台标签居然可见"→ 立即放弃',
      cdpSrc.includes('后台标签没能保持后台'));
  }

  // ★ 思考强度分档：文史 low / 数理 max。
  //   理由是实测出来的：输出 token 占实际花费约 78%（输出 8 元/百万 vs 缓存输入 0.04 元/百万），
  //   而思考 token 全部按输出价计费。
  const {classifyQuestion, effortForQuestion, looksMathy, parseLabels, assistantMessageFor} = await import('./lib/agent.mjs');
  // ★ reasoning_content 回传：官方要求带 tools 的请求必须回传历史思考内容，
  //   否则模型看不到自己上一轮怎么想的、只能重新推。实测每轮输出 token -17%、整题成本 -27%。
  //   但**只在模型确实返回过时才带** —— 本项目支持任何 OpenAI 兼容接口，
  //   换个不返回思考的模型时不能凭空塞一个它可能不认识的字段。
  {
    const withR = assistantMessageFor({content: 'a', reasoning_content: 'r', tool_calls: [{id: '1'}]});
    const noR = assistantMessageFor({content: 'a'});
    t('回传思考：模型给过 reasoning_content 就带上（和 tool_calls 并存）',
      withR.reasoning_content === 'r' && Array.isArray(withR.tool_calls) && withR.role === 'assistant');
    t('回传思考：模型没给过就绝不带这个字段（兼容别的 OpenAI 接口）',
      !('reasoning_content' in noR) && !('tool_calls' in noR) && noR.content === 'a');
    t('回传思考：思考内容一律转成字符串', typeof assistantMessageFor({content: '', reasoning_content: 123}).reasoning_content === 'string');
  }
  // ★ 兜底正则必须先抹掉年份：实测「五四运动爆发于（　）1919年…」这类题
  //   用裸 \d 当数理信号会 4/4 全判错，于是一路按 max 思考强度烧钱。
  t('兜底判定：带年份的文史题不再误判成数理（抹掉 年/年代/世纪/第X次）',
    looksMathy('五四运动爆发于（　）1919年 1921年 1905年') === false
    && looksMathy('《南京条约》签订于1842年，其内容不包括？') === false
    && looksMathy('一战持续了4年，这说明了什么') === false);
  t('兜底判定：数理题仍然认得出',
    looksMathy('求矩阵 A 的行列式 det(A)') && looksMathy('计算 ∫x²dx')
    && looksMathy('设随机变量 X~N(0,1)，求 P(X>1.96)'));
  // ★ 模型分类的解析：长度对不上就返回 null（交给兜底），不能瞎按顺序贴标签
  t('分类解析：正常数组', JSON.stringify(parseLabels('["文史","数理","文史"]', 3)) === JSON.stringify(['humanities', 'mathy', 'humanities']));
  t('分类解析：容忍代码块/废话包裹',
    JSON.stringify(parseLabels('好，结果如下：\n```json\n["数理"]\n```', 1)) === JSON.stringify(['mathy']));
  t('分类解析：题数对不上 → null（绝不硬凑）',
    parseLabels('["文史"]', 3) === null && parseLabels('不是数组', 2) === null);
  {
    const hist = {stem: '沙盘推演实践教学有哪几个环节组成', options: [{text: '战役还原环节'}]};
    const math = {stem: '求矩阵 A 的行列式 det(A)', options: [{text: '-2'}]};
    const unsure = {stem: '', stemOcr: '', stemImages: ['x'], options: [{text: '', images: ['y']}]};
    t('分类：文史 / 数理 / 不确定（纯图片题）三分',
      classifyQuestion(hist) === 'humanities' && classifyQuestion(math) === 'mathy' && classifyQuestion(unsure) === 'unsure');
    const st = {reasoningEffort: 'max', reasoningEffortHumanities: 'low'};
    t('思考强度：文史降档到 low、数理用 max', effortForQuestion(hist, st) === 'low' && effortForQuestion(math, st) === 'max');
    t('思考强度：不确定的题用数理档（宁可多花也别算错）', effortForQuestion(unsure, st) === 'max');
    t('思考强度：可以关掉自动分档', effortForQuestion(hist, {...st, reasoningEffortAuto: false}) === 'max');
    t('思考强度：文史档位可配成 off', effortForQuestion(hist, {...st, reasoningEffortHumanities: 'off'}) === 'off');
  }
  t('工具裁剪：文史题只发 calc+联网，数学题发全部',
    (() => {
      const hist = {stem: '沙盘推演实践教学有哪几个环节组成', options: [{text: '战役还原环节'}]};
      const math = {stem: '求矩阵 A 的行列式 det(A)', options: [{text: '-2'}]};
      return pickToolsForQuestion(hist).length === 3 && pickToolsForQuestion(math).length === 6
        && pickToolsForQuestion(hist, 'all').length === 6;
    })());
  // ★ 整卷固定工具集：DeepSeek 缓存要求"完整匹配前缀单元"，
  //   逐题切换会让共享前缀 A 变形，永远命中不了（官方文档 Example 2）
  t('工具裁剪：不确定就全发（纯图片题/文字过少 → 6 个）',
    pickToolsForQuestion({stem: '', stemOcr: '', stemImages: ['x'], options: [{text: '', images: ['y']}]}).length === 6
    && pickToolsForQuestion({stem: '计算', options: []}).length === 6);
  t('工具裁剪：弱信号词已剔除（"多少/已知"不再触发数理）',
    pickToolsForQuestion({stem: '第二次世界大战中，中国战场牵制了多少日军？', options: [{text: '甲'}]}).length === 3
    && pickToolsForQuestion({stem: '已知最早的人类活动遗址位于', options: [{text: '甲'}]}).length === 3
    && pickToolsForQuestion({stem: '求 x 等于多少', options: [{text: '甲'}]}).length === 6);
  t('工具裁剪：整卷只定一次（纯文史 3 个 / 混合卷 6 个）',
    (() => {
      const pickToolsForPaper = await_import_paper;
      const hist = [
        {stem: '沙盘推演实践教学有哪几个环节组成？（ ）。', options: [{text: '战役还原环节'}]},
        {stem: '沙盘推演实践教学有助于培养学生的规则意识、协作精神。（ ）', options: [{text: '对'}]},
      ];
      const mixed = [...hist, {stem: '已知矩阵 A=[[1,2],[3,4]]，求 det(A)', options: [{text: '-2'}]}];
      return pickToolsForPaper(hist).length === 3 && pickToolsForPaper(mixed).length === 6;
    })());

  // 3. 答案单
  const demo = {name: 'T', questions: [
    {index: 1, qid: 'q1', typeName: '多选', stem: '题干一', options: [{letter: 'A', text: '甲'}, {letter: 'B', text: '乙'}, {letter: 'C', text: '丙'}, {letter: 'D', text: '丁'}]},
    {index: 2, qid: 'q2', typeName: '判断', stem: '题干二', options: [{letter: 'A', text: '错'}, {letter: 'B', text: '对'}]},
    {index: 3, qid: 'q3', typeName: '填空', stem: '题干三', options: []},
  ]};
  const {renderAnswerSheet, safeName, renderAnswerSheetText} = await import('./lib/report.mjs');
  const md = renderAnswerSheet(demo, {q1: 'AC', q2: 'B', q3: '文本'}, {siteName: 'X'});   // md 能力保留（终端不再写文件）
  t('答案单：速查表 + 多选勾选', /1\. AC/.test(md) && /- \[x\] \*\*A\.\*\*/.test(md) && /- \[ \] \*\*B\.\*\*/.test(md));
  t('答案单：填空与只读声明', md.includes('文本') && md.includes('自己点鼠标填'));
  t('答案单：文件名清洗', safeName('a/b:c*d?e"f<g>h|i') === 'a-b-c-d-e-f-g-h-i');
  const txt = renderAnswerSheetText(demo, {q1: 'AC', q2: 'B', q3: '文本'}, {color: false});
  t('终端答案单：勾选 + 选项原文 + 速查',
    txt.includes('✅') && txt.includes('A. 甲') && /→ 选 A C/.test(txt) && /速查：.*1\.AC/.test(txt));
  t('终端答案单：判断题给的是选项文字', txt.includes('B. 对'));

  // 4. 配置
  const {config, note} = loadConfig(__dirname, '');
  t('配置：config.toml 可读', !!config && !!config.model);
  t('配置：模型与 key 已设置', !!config.model.model, `model=${config.model.model} key=${config.model.api_key ? '已配置' : '未配置'}`);
  t('配置：没有 auto_submit（永不交卷）', !JSON.stringify(config).includes('auto_submit'));
  // ★ 浏览器兜底的"关机键"：默认开，但必须能一键关掉
  {
    const os = await import('node:os');
    const tmpCfg = path.join(os.tmpdir(), 'cah-selftest-off.toml');
    fs.writeFileSync(tmpCfg, '[app]\nweb_browser_fallback = false\n', 'utf8');
    const {config: cfgOff} = loadConfig(__dirname, tmpCfg);
    fs.unlinkSync(tmpCfg);
    t('配置：web_browser_fallback 默认开、可一键关',
      config.app.web_browser_fallback === true && cfgOff.app.web_browser_fallback === false);
  }

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
  let usage = {prompt: 0, completion: 0, requests: 0, web: 0, cacheHit: 0, cacheMiss: 0};
  const qState = new Map();
  const label = q => `[${q.index}/${total}]`;
  let toolCalls = 0;

  const {answers, results} = await solvePaper({
    paper, settings,
    onEvent(ev) {
      const q = paper.questions.find(x => x.qid === ev.qid) || {};
      switch (ev.type) {
        case 'start':
          step(`读到 ${total} 道题，开始解题（${settings.model} · 思考 ${settings.reasoningEffortAuto === false ? settings.reasoningEffort : `数理 ${settings.reasoningEffort} / 文史 ${settings.reasoningEffortHumanities}`}）`);
          break;
        case 'classify':
          if (ev.source === 'model') {
            step(`先分个类（模型判定 · 不思考）：数理 ${ev.mathy} 题 / 文史 ${ev.humanities} 题 / 不确定 ${ev.unsure} 题`);
          } else if (ev.message) {
            warn(ev.message);
          }
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
        case 'usage':
          usage = {prompt: ev.prompt || 0, completion: ev.completion || 0, requests: ev.requests || 0,
                   web: ev.web || 0, cacheHit: ev.cacheHit || 0, cacheMiss: ev.cacheMiss || 0};
          break;
        case 'answer': {
          const a = Array.isArray(ev.answer) ? ev.answer.join('') : String(ev.answer ?? '');
          // 只显示关键词；终端别被长文本刷屏，也要能一眼核对该选哪个
          const brief = String(ev.kw || '').replace(/\s+/g, ' ').slice(0, 24);
          console.log('  ' + c(label(q), 'dim') + ' ' + c('✅ ' + a, 'green') + (brief ? '  ' + c(brief, 'dim') : ''));
          break;
        }
      }
    },
  });
  const ms = Date.now() - t0;
  line();
  const got = Object.values(answers).filter(Boolean).length;
  ok(`${got}/${total} 已解题 · 耗时 ${(ms / 1000).toFixed(1)}s · 工具调用 ${toolCalls} 次`);
  // ---- 用量与花费（本来就该有，之前完全没有计量）
  if (usage.prompt || usage.completion) {
    const k = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const pin = Number(settings.priceIn) || 0, pout = Number(settings.priceOut) || 0;
    // 缓存命中价没填就按 1/50 折算 —— deepseek-flash 现在是 0.04 / 2.0（高峰），正好 1/50。
    // 早先按 1/10 折算是过时的，会把缓存读的部分高估 5 倍。
    const pCache = Number(settings.priceCacheIn) > 0 ? Number(settings.priceCacheIn) : pin / 50;
    const hit = usage.cacheHit || 0, miss = usage.cacheMiss || Math.max(0, usage.prompt - hit);
    const rate = usage.prompt ? Math.round(hit / usage.prompt * 100) : 0;
    let cost = '';
    if (pin || pout) {
      const y = hit / 1e6 * pCache + miss / 1e6 * pin + usage.completion / 1e6 * pout;
      cost = ` · 估算 ¥${y < 1 ? y.toFixed(3) : y.toFixed(2)}`;
    } else {
      cost = c(' · （想估算金额就在 config.toml 填 price_in / price_out）', 'dim');
    }
    info(c(`    💰 用量：输入 ${k(usage.prompt)}（缓存命中 ${k(hit)} · ${rate}%）· 输出 ${k(usage.completion)} tokens（${usage.requests} 次请求，搜索 ${usage.web || 0} 条查询 / 抓网页 ${usage.fetches || 0} 次）`, 'dim') + cost);
  }
  return {answers, results, ms, usage};
}

// ------------------------------------------------------------------ 等答题页（按 Enter 立即重测）
/** 监听 Enter：按一下立刻重测；顺便接管 Ctrl+C（raw 模式下不会自动发 SIGINT） */
function onEnter(fn) {
  if (!process.stdin.isTTY) return () => {};
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  } catch { return () => {}; }
  const h = (str, key) => {
    if (key && key.ctrl && (key.name === 'c' || key.name === 'd')) {
      try { process.stdin.setRawMode(false); } catch {}
      console.log('\n  ' + c('已手动退出（没有在页面上做任何修改）', 'yellow'));
      process.exit(130);
    }
    if (key && (key.name === 'return' || key.name === 'enter')) fn();
  };
  process.stdin.on('keypress', h);
  return () => { process.stdin.off('keypress', h); try { process.stdin.setRawMode(false); } catch {} };
}

/** 把页面脚本（helper.js）自己的 console 输出搬到终端 —— 这就是"答题 log" */
function makeLogStream(session) {
  let seen = session.consoleLogs().length;
  return () => {
    let n = 0;
    for (const log of session.consoleLogs()) {
      if (n++ < seen) continue;
      const text = cleanConsoleArgs(log.args && log.args.length ? log.args.map(v => ({value: v})) : [{value: log.text}]).replace(/^%c\s*/, '');
      if (!text) continue;
      if (/^(MOOC|超星|智慧树)?\s*(AI 答题助手|助手)/.test(text) && /版本|已启动/.test(text)) continue;
      const col = log.type === 'error' || log.type === 'warning' ? 'yellow' : 'dim';
      info(c('    [脚本] ' + text.slice(0, 160), col));
    }
    seen = session.consoleLogs().length;
  };
}

const READY_PROBE = `(() => document.querySelectorAll('.examPaper_subject, .question-item, .nodeLab, .TiMu, .questionLi, .subject_node, [class*="question"]').length)()`;

/**
 * 等用户把页面点到"答题界面"，中途：
 *   · 一直扫标签，找到匹配的答题页就自动附加（换页也会跟着换）
 *   · 页面一旦有题目节点就注入页面脚本开始读题
 *   · **随时按 Enter 立即重测**
 */
async function acquireAnswerPage({platform, port, CFG}) {
  const tty = !!process.stdin.isTTY;
  let session = null, tab = null, elapsed = 0, probeN = 0, announced = false;
  let wantStart = false;                       // 用户按了回车 = 开始读题
  const off = onEnter(() => { wantStart = true; });

  step(`等你在浏览器里进入 ${platform.name} 的答题页（不设超时，慢慢来）`);
  if (platform.platformHint) info(c('    怎么进：' + platform.platformHint, 'dim'));
  info(c('    我只看不动；进去了按 ' + (tty ? '回车' : '（非交互：探测到就直接开始）') + ' 开始读题+解题', 'dim'));
  info('');

  const tryRead = async () => {
    const drainLog = makeLogStream(session);      // 页面脚本说什么，都搬到终端
    // —— 用户按了回车，才真正动手读卷
    if (platform.mode === 'script') {
      await session.eval(bridgeSource({
        pollSeconds: CFG.app.poll_seconds,
        fillIntervalMs: CFG.app.fill_interval_ms,
        limitBackoffMs: CFG.app.limit_backoff_ms,
      })).catch(() => {});
      const helperPath = path.join(platform.dir, platform.pageScript || 'console/helper.js');
      await session.eval(preparePageScript(fs.readFileSync(helperPath, 'utf8'))).catch(e => {
        info(c('    (脚本返回：' + String(e.message).slice(0, 60) + ')', 'dim'));
      });
      step('页面脚本已注入，正在读题…');
      for (let i = 0; i < 50; i++) {
        drainLog();
        const raw = await session.eval('window.__BRIDGE__ && window.__BRIDGE__.paper ? JSON.stringify(window.__BRIDGE__.paper) : null').catch(() => null);
        if (raw) {
          const paper = JSON.parse(raw);
          if (paper && paper.questions && paper.questions.length) { drainLog(); return paper; }
        }
        await sleep(400);
      }
      drainLog();
      // 页面脚本没交卷：把桥接层记到的错误也吐出来，方便定位
      const errs = await session.eval('window.__BRIDGE__ && window.__BRIDGE__.errors ? JSON.stringify(window.__BRIDGE__.errors) : null').catch(() => null);
      if (errs && errs !== '[]') info(c('    [桥接层] ' + errs.slice(0, 200), 'dim'));
      return null;
    }
    const paper = await platform.readPaper(session).catch(() => null);
    drainLog();
    return paper && paper.questions && paper.questions.length ? paper : null;
  };

  try {
    for (;;) {   // ★ 不设时间上限：一直等到你按回车
      // 1) 找答题页标签（**按标签 id 判断**，别被 SPA 改 hash 骗得反复重挂）
      const tabs = await listTabs(port).catch(() => []);
      const hit = tabs.find(t => platform.matchUrl.test(t.url));
      if (hit && (!tab || hit.id !== tab.id)) {
        if (session) { try { session.close(); } catch {} }
        tab = hit;
        session = await CdpSession.attach(tab);
        probeN = 0; announced = false;
        ok('识别到答题页：' + ((tab.title || '').replace(/\s+/g, ' ').slice(0, 40) || tab.url.slice(0, 60)));
      }

      // 2) 只读探测：页面上有没有题目节点（不注入任何东西）
      if (session && !announced) {
        probeN = await session.eval(platform.readyProbe || READY_PROBE).catch(() => 0);
        if (probeN > 0) {
          announced = true;
          console.log();
          ok(c('已就绪 —— 页面上能找到题目', 'green'));
          info(c('    核对一下浏览器里的页面没问题后，按 ', 'dim') + c('回车', 'bold') + c(' 开始读题+解题（Ctrl+C 退出）', 'dim'));
          console.log();
          if (!tty) wantStart = true;         // 非交互：直接开始
        }
      }

      // 3) 用户按了回车 → 开始读题
      if (wantStart) {
        wantStart = false;
        if (!session) {
          warn('还没识别到答题页 —— 确认你在**这个浏览器窗口**里打开了答题界面，再按回车');
        } else {
          const paper = await tryRead();
          if (paper) { off(); return {session, tab, paper}; }
          console.log();
          warn('这次没读到题目');
          info(c('    · 页面上要**真的能看到题目和选项**（还停在课程目录/说明页的话，先点「开始测验」进去）', 'dim'));
          info(c('    · 上面 [脚本] 那几行就是页面脚本的说明，通常能看出卡在哪', 'dim'));
          info(c('    · 确认无误后，再按一次回车重试', 'dim'));
          announced = false;                  // 允许重新探测
          console.log();
        }
      }

      // 4) 进度提示
      if (elapsed && elapsed % 20 === 0) {
        const t2 = await listTabs(port).catch(() => []);
        const sitePages = t2.filter(t => platform.siteUrl && platform.siteUrl.test(t.url)).length;
        const quizPages = t2.filter(t => platform.matchUrl.test(t.url)).length;
        info(c(`    还在等你进答题页…（${elapsed}s，${t2.length} 个标签` +
          (sitePages ? `，其中 ${sitePages} 个是 ${platform.name} 的页面` : '') +
          (quizPages ? `，${quizPages} 个看起来是答题页` : '') + `）`, 'dim'));
      }

      await sleep(1000);
      elapsed++;
    }
  } finally { off(); }
  return {session, tab, paper: null};
}

// ------------------------------------------------------------------ 诊断（不启动任何东西）
async function doctor(platforms, CFG, opts) {
  const port = Number(opts.port || CFG.cdp?.port || 9222);
  console.log();
  info(c('浏览器 / 登录态诊断（--doctor，不会启动或修改任何东西）', 'bold'));
  line();

  const running = await browserRunning();
  running ? warn(`检测到 ${running === 'edge' ? 'Edge' : 'Chrome'} 正在运行`)
          : ok('没有检测到运行中的 Chrome/Edge');

  try {
    const tabs = await listTabs(port);
    ok(`调试端口 ${port} 可用，已打开 ${tabs.length} 个标签`);
    for (const t of tabs.slice(0, 8)) {
      const hit = platforms.find(p => p.matchUrl && (p.matchUrl.test(t.url) || (p.siteUrl && p.siteUrl.test(t.url))));
      info(c(`      ${hit ? '●' : '○'} ${(t.title || '').replace(/\s+/g, ' ').slice(0, 24).padEnd(24)} ${t.url.slice(0, 64)}${hit ? '  ← ' + hit.name : ''}`, 'dim'));
    }
  } catch {
    info(c(`调试端口 ${port}：没有浏览器在监听`, 'dim'));
  }

  console.log();
  info('浏览器可执行文件：');
  const exeCfg = opts.browser || CFG.cdp?.browser || '';
  info(`    [cdp] browser = ${exeCfg ? `'${exeCfg}'` : '(空 → 自动找)'}`);
  const exe = exeCfg && fs.existsSync(exeCfg) ? exeCfg : detectBrowserExe();
  exe ? ok(`    将使用：${exe}`) : bad('    没找到（启动时会问你一次，并记进 config.toml）');

  console.log();
  info('登录态（profile）：');
  const {dir: realDir, name: realName} = findDefaultProfile(exe);
  info(c(`    你日常的浏览器 profile：${realDir ? `${realName} → ${realDir}` : '（没找到）'}`, 'dim'));
  info(c('    ⚠ Chrome 136+ 对**默认数据目录**会忽略 --remote-debugging-port（Google 的安全加固），', 'yellow'));
  info(c('      所以不能借用你日常的登录态 —— 这是平台限制，不是本工具的 bug', 'yellow'));
  const profCfg = opts.profile || CFG.cdp?.profile || '';
  if (profCfg) {
    const {dir, adjusted} = normalizeProfileDir(profCfg);
    if (!fs.existsSync(dir)) bad(`    [cdp] profile 目录不存在：${dir}`);
    else if (isDefaultProfileDir(dir)) bad(`    [cdp] profile 指向默认目录，Chrome 会忽略调试端口：${dir}`);
    else ok(`    将使用（[cdp] profile）：${dir}${adjusted ? '  （已自动上退一级）' : ''}`);
  } else {
    const helper = helperProfileDir();
    ok(`    将使用（助手专用 profile）：${helper}`);
    info(c(`      ${fs.existsSync(path.join(helper, 'Default')) ? '✅ 已经用过（里面登录过的话会保留）' : '🆕 还不存在 —— 第一次跑会新建，需要登录一次'}`, 'dim'));
  }

  console.log();
  info('模型与成本：');
  info(`    ${CFG.model.model} · 思考 ${CFG.model.reasoning_effort_auto === false ? CFG.model.reasoning_effort : `数理 ${CFG.model.reasoning_effort} / 文史 ${CFG.model.reasoning_effort_humanities}`} · 并发 ${CFG.model.concurrency}`);
  info(`    每题最多 ${CFG.model.max_tool_rounds} 轮工具（--rounds N 可临时改）`);
  info(`    工具结果截断 ${CFG.model.max_tool_result_chars} 字符 · 网页类 ${CFG.model.web_result_chars} 字符 · 每题搜索 ${CFG.model.max_web_calls} 条查询 / 抓网页 ${CFG.model.max_web_fetches} 次`);
  info(`    工具集：${CFG.model.tool_mode === 'all' ? '全部 6 个（默认，省心）' : 'auto —— 按卷子裁掉用不到的数理工具（省 ~2600 tokens/请求，可能误判）'}`);
  if (CFG.model.price_in || CFG.model.price_out) info(`    单价：输入 ${CFG.model.price_in} / 输出 ${CFG.model.price_out} 元每百万 token（会估算花费）`);
  else warn('    没填 price_in / price_out → 只报 token 数，不估算金额');

  console.log();
  info('历史日志：' + path.join('data', 'logs'));
  try {
    const logs = fs.readdirSync(path.join(__dirname, 'data', 'logs')).sort().slice(-3);
    for (const l of logs) info(c('    · ' + l, 'dim'));
  } catch {}
  console.log();
}


// ------------------------------------------------------------------ 主流程
async function main() {
  const {flags, opts} = parseArgs(process.argv.slice(2));
  const platforms = await loadPlatforms(__dirname);
  const {config: CFG} = loadConfig(__dirname, process.env.CONFIG_FILE || '');
  const roundsOverride = Number(opts.rounds);
  const settings = {
    baseUrl: CFG.model.base_url, apiKey: CFG.model.api_key, model: CFG.model.model,
    temperature: CFG.model.temperature, concurrency: CFG.model.concurrency,
    // 每题最多让模型调几轮工具：config.toml 的 [model] max_tool_rounds，可用 --rounds 临时覆盖
    priceIn: CFG.model.price_in, priceOut: CFG.model.price_out, priceCacheIn: CFG.model.price_cache_in,
    maxRounds: Number.isFinite(roundsOverride) && roundsOverride > 0 ? Math.min(roundsOverride, 20) : CFG.model.max_tool_rounds,
    toolMode: CFG.model.tool_mode,
    maxToolResultChars: CFG.model.max_tool_result_chars,
    maxWebCalls: CFG.model.max_web_calls,
    maxWebFetches: CFG.model.max_web_fetches,
    webResultChars: CFG.model.web_result_chars,
    useTools: CFG.model.use_tools,
    reasoningEffort: CFG.model.reasoning_effort,
    reasoningEffortAuto: CFG.model.reasoning_effort_auto,
    reasoningEffortHumanities: CFG.model.reasoning_effort_humanities,
    classifyWithModel: CFG.model.classify_with_model,
    timeoutSeconds: CFG.model.timeout_seconds,
    maxRetries: CFG.model.max_retries,
  };
  const port = Number(opts.port || CFG.cdp?.port || 9222);

  const logFile = CFG.app.save_log === false ? null : startRunLog();
  console.log('\n' + c('  在线课程 AI 答题助手 · 终端版', 'bold') + c('   （只填不交卷）', 'dim'));
  line();

  if (flags.has('list')) {
    const tabs = await listTabs(port).catch(e => { bad(e.message); process.exit(2); });
    info(`端口 ${port} 上有 ${tabs.length} 个标签：`);
    for (const t of tabs) {
      const hit = platforms.find(p => p.matchUrl && (p.matchUrl.test(t.url) || (p.siteUrl && p.siteUrl.test(t.url))));
      info(`  ${hit ? c('●', 'green') : c('○', 'dim')} ${(t.title || '').slice(0, 26).padEnd(26)} ${t.url.slice(0, 74)}${hit ? c('  ← ' + hit.name, 'green') : ''}`);
    }
    console.log();
    return;
  }
  if (flags.has('selftest')) return selftest();
  if (flags.has('doctor')) return doctor(platforms, CFG, opts);

  // ★ 联网工具的反爬兜底：web_fetch 直连被 403 挡住时（百度百科/知到答案页都是这样），
  //   用同一个浏览器开一个**后台标签**抓正文，读完就关 ——
  //   全程只新建/关闭临时标签，绝不导航或改动用户正在做题的那个页面。
  //   （放在这里而不是更早：--list/--selftest/--doctor 必须完全不碰浏览器。）
  //
  //   三道保险，任何一道不满足就完全不用这条路：
  //     1) config 的 web_browser_fallback 可以一键关掉；
  //     2) 绝不用浏览器打开"答题页自身"（多开考试标签可能触发平台并发检测）；
  //     3) 只要 browserFetch 报"不支持后台开标签/抢了激活"，本次运行立刻永久关掉兜底，
  //        不会每一次抓取都再去开一次标签。
  if (CFG.app?.web_browser_fallback === false) {
    info(c('    浏览器兜底抓取：已按配置关闭（web_browser_fallback = false）', 'dim'));
  } else {
    const fbPlatform = matchPlatform(platforms, opts.platform);
    let fallbackOff = '';
    setBrowserFetcher(async url => {
      if (fallbackOff) throw new Error(fallbackOff);
      if (fbPlatform?.matchUrl && fbPlatform.matchUrl.test(url)) {
        throw new Error('拒绝用浏览器打开答题页自身（避免多开考试标签）');
      }
      try {
        return await browserFetch(url, {port});
      } catch (e) {
        if (/后台开标签|没能保持后台|抢了激活/.test(String(e.message))) {
          fallbackOff = String(e.message);
          warn('已永久关闭浏览器兜底（本次运行）：' + e.message);
        }
        throw e;
      }
    });
  }

  if (!settings.apiKey) { bad('config.toml 里没填 api_key'); process.exit(2); }

  // ---- 只打开登录窗口（不需要平台）
  if (flags.has('login')) {
    const loginPlatform = matchPlatform(platforms, opts.platform) || platforms[0];
    await ensureBrowserSmart(port, opts.url || loginPlatform?.homeUrl || 'about:blank', CFG, opts);
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

  // ---- 没给链接也没给平台：看已有的标签里有没有能认出来的
  if (!platform && !url) {
    bad('要告诉我用哪个平台（或者给我一个答题页链接）');
    info('  平台可选（序号、id 或中文名都行）：');
    console.log(platformMenu(platforms));
    info('');
    info(c('  小技巧：链接是可选的 —— 不给链接的话，工具会把浏览器开好，', 'dim'));
    info(c('          你在窗口里点进答题页，它会自动认出那个页面', 'dim'));
    process.exit(2);
  }

  // ---- 浏览器：没开就拉起来（尽量借用你日常的登录态）
  const startUrl = url || platform.homeUrl || 'about:blank';   // 不给链接就开平台首页，别开空白页
  const br = await ensureBrowserSmart(port, startUrl, CFG, opts);
  if (br.launched) ok(`浏览器已启动（端口 ${port}）`);
  if (br.firstTime) {
    info('');
    warn('第一次用：这个窗口的浏览器是**全新 profile**，请在窗口里登录一次');
    info(c('    登录态会一直保存在这个 profile 里，以后不用再登', 'dim'));
    info('');
  }
  // ---- 给了链接就先打开它；没给就让用户自己在窗口里点（下面 acquireAnswerPage 会等）
  if (url) {
    let tab = await resolveTab(port, url, {forceNew: flags.has('new')});
    if (!tab) { bad('没能打开标签'); process.exit(2); }
    const strip = u => String(u).split('#')[0].replace(/\/+$/, '');
    if (strip(tab.url) !== strip(url)) {
      step('打开页面：' + String(url).slice(0, 90));
      const tmp = await CdpSession.attach(tab);
      await tmp.navigate(url).catch(() => {});
      tmp.close();
      await sleep(1200);
    }
  }
  ok(`平台：${platform.name}（${platform.mode === 'cdp' ? 'CDP 只读' : '页面脚本'}模式）`);
  info(c(`    端口 ${port}`, 'dim'));

  const sheetOnly = flags.has('sheet') || flags.has('no-fill') || platform.mode === 'cdp';

  // ---- 等答题页（可交互：随时按 Enter 立即重测）
  const acq = await acquireAnswerPage({platform, port, CFG});
  if (!acq.paper) {
    bad('一直没等到答题页');
    const tabs = await listTabs(port).catch(() => []);
    info('  浏览器里现在开着：');
    for (const t of tabs) info(c(`    · ${(t.title || '').replace(/\s+/g, ' ').slice(0, 26).padEnd(26)} ${t.url.slice(0, 66)}`, 'dim'));
    info('');
    info('  提示：要在**同一个浏览器窗口**里进入答题界面（能看到题目和选项）');
    info('  也可以直接给链接：node cli.mjs ' + platform.id + ' "<答题页链接>"');
    process.exit(3);
  }
  const session = acq.session;
  const paper = acq.paper;
  ok(`读到 ${paper.questions.length} 道题${paper.name || paper.title ? '：' + String(paper.name || paper.title).slice(0, 40) : ''}`);

  let fillResult = null;
  if (platform.mode === 'script' && !sheetOnly) {
    // 题目已经由页面脚本读好了（acquireAnswerPage 里注入的），这里由终端来解
    const {answers} = await solve(paper, settings);

    step('把答案交回页面脚本，让它自己填…');
    const drainFillLog = makeLogStream(session);
    await session.eval(`window.__BRIDGE__.answers = ${JSON.stringify(answers)}; window.__BRIDGE__.status = 'done';`);
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      drainFillLog();
      const st = await session.eval('window.__BRIDGE__.status').catch(() => null);
      if (st === 'delivering') { await sleep(1200); drainFillLog(); break; }
    }
    await sleep(1500);
    drainFillLog();
    fillResult = {done: true};
  } else {
    // ---- CDP 只读：卷子已由 acquireAnswerPage 只读读出
    step('只读模式（不执行页面脚本、不在页面上点击）');
    const {answers} = await solve(paper, settings);
    // 不导文件，解完一次性把答案打在终端里
    console.log(renderAnswerSheetText(paper, answers));
  }

  line();
  if (sheetOnly) {
    warn('本模式只出答案单，没有在页面上做任何修改。交卷请你自己来。');
  } else {
    warn('答案已填入页面。请自己核对后再提交 —— 本工具不会替你提交。');
  }
  console.log();
  if (logFile) info(c('本次日志：' + path.relative(__dirname, logFile), 'dim'));
  console.log();
  session.close();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
main().catch(e => { bad('出错：' + (e && e.message || e)); process.exit(1); });
