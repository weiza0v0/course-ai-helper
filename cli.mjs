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
import {listTabs, CdpSession} from './lib/cdp.mjs';
import {solvePaper} from './lib/agent.mjs';
import {renderAnswerSheet, renderAnswerSheetText, safeName} from './lib/report.mjs';
import {bridgeSource, preparePageScript, cleanConsoleArgs} from './lib/bridge.mjs';
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
  const {renderAnswerSheetText} = await import('./lib/report.mjs');
  const txt = renderAnswerSheetText(demo, {q1: 'AC', q2: 'B', q3: '文本'}, {color: false});
  t('终端答案单：勾选 + 选项原文 + 速查',
    txt.includes('✅') && txt.includes('A. 甲') && /→ 选 A C/.test(txt) && /速查：.*1\.AC/.test(txt));
  t('终端答案单：判断题给的是选项文字', txt.includes('B. 对'));

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
    maxRounds: Number.isFinite(roundsOverride) && roundsOverride > 0 ? Math.min(roundsOverride, 20) : CFG.model.max_tool_rounds,
    useTools: CFG.model.use_tools,
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
      const hit = platforms.find(p => p.matchUrl && (p.matchUrl.test(t.url) || (p.siteUrl && p.siteUrl.test(t.url))));
      info(`  ${hit ? c('●', 'green') : c('○', 'dim')} ${(t.title || '').slice(0, 26).padEnd(26)} ${t.url.slice(0, 74)}${hit ? c('  ← ' + hit.name, 'green') : ''}`);
    }
    console.log();
    return;
  }
  if (flags.has('selftest')) return selftest();
  if (flags.has('doctor')) return doctor(platforms, CFG, opts);

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
    step('只读出答案单模式（不执行页面脚本、不在页面上点击）');
    const {answers} = await solve(paper, settings);
    const md = renderAnswerSheet(paper, answers, {
      siteName: platform.name, model: settings.model, url: paper.tid || '',
      solvedAt: new Date().toLocaleString('zh-CN'),
    });
    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, {recursive: true});
    const file = path.join(dataDir, `${safeName(paper.name || paper.title || 'answer')}-答案单-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, md, 'utf8');
    ok('答案单已保存：' + path.relative(__dirname, file));
    console.log(renderAnswerSheetText(paper, answers));
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
