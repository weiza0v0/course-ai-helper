/**
 * 配置：从 config.toml 读取（文件不存在则生成模板）
 */
import fs from 'node:fs';
import path from 'node:path';
import {parseToml} from './toml.mjs';

export const DEFAULT_CONFIG = {
  model: {
    base_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-flash',
    reasoning_effort: 'max',   // off | low | high | max
    temperature: 0,
    concurrency: 3,
    max_tool_rounds: 7,
    tool_mode: 'all',               // 工具集：all=每次都发全部 6 个（默认，省心）；auto=按卷子裁掉数理工具（省一点，但可能误判）
    max_tool_result_chars: 2000,
    max_web_calls: 3,              // ★ 每题最多联网查几次（文史题最烧钱的地方）
    web_result_chars: 1200,        // ★ 网页类结果进对话前的字符上限（比普通工具更狠）   // ★ 工具结果进对话前最多保留多少字符（越长越贵：它会在后续每一轮重发）
    price_in: 0,                   // 输入价（元 / 百万 token），填了就会估算本次花费；0 = 只报 token 不报钱
    price_out: 0,                  // 输出价（元 / 百万 token）
    price_cache_in: 0,             // 缓存命中价；0 = 按 price_in 的 1/10 粗略折算
    use_tools: true,
    timeout_seconds: 300,
    max_retries: 3,
  },
  app: {
    save_log: true,            // 把每次运行的终端输出存到 data/logs/（花销、卡在哪都有据可查）
    auto_solve: true,          // 控制台收到题目后，后端自动开解
    auto_fill: true,           // 出答案后自动推回页面并勾选（本工具只填不交卷）
    poll_seconds: 2,           // 控制台脚本轮询间隔
    fill_interval_ms: 400,     // ★ 两次勾选之间的间隔：MOOC 每勾一次就发一次草稿写请求，太快会被平台限流
    limit_backoff_ms: 3000,    // 撞到"并发限制"弹窗后的退避等待
  },
  cdp: {
    port: 9222,
    browser: '',                // 浏览器可执行文件路径（留空=自动找；找不到会问你一次并记下来）
    profile: '',                // 浏览器 profile（留空=优先借用你日常浏览器的登录态）
  },
};

export const CONFIG_TEMPLATE = `# ============================================================
#  在线课程 AI 答题助手 —— 配置文件
#  改完直接重新运行 cli.mjs 即可生效（不用重启任何服务）
# ============================================================

[model]
# 任何 OpenAI 兼容接口都可以
base_url = "https://api.deepseek.com/v1"
# 必填：你的 API Key
api_key = ""
# 必须是支持图片输入的多模态模型
model = "deepseek-flash"
# 思考强度：off（关闭）/ low / high / max —— 数学题建议 max，不然容易算错
reasoning_effort = "max"
temperature = 0
# 同时解几道题
concurrency = 3
# ★ 每题最多让模型调用几轮工具（matrix / calculus / stats / web_search / web_fetch）
#   调大 = 模型能多做几次计算/查证，更稳但更慢更贵；调小 = 更快但容易算错
#   临时改：node cli.mjs mooc --rounds 8
#   轮数用尽时模型会被强制收尾作答，并在终端打出"⚠ 工具轮数用尽" 
max_tool_rounds = 7
# 工具集怎么发：
#   all（默认） = 每次都发全部 6 个工具 —— 省心，任何题都能随手调 matrix/calculus/stats
#   auto        = 按整卷裁掉用不到的数理工具（纯文史卷每次省 ~2600 tokens）。
#                 ⚠ 判定是关键词启发式，可能误判；省下的量不大（多在共享前缀里，走缓存价）
tool_mode = "all"
# ★ 工具结果进对话前最多保留多少字符。
#   web_fetch 一次能返回 3 万字符，而这些内容会在**后续每一轮**被重新发给模型 ——
#   不截断的话单题输入 token 会翻好几倍。默认 2000 够用；要看长文可以调大。
max_tool_result_chars = 2000
# ★ 每题最多联网查几次（web_search + web_fetch 合计）。文史类题目最烧钱就在这儿：
#   搜回来的网页动辄几万字符，而且会在后续每一轮被重发。默认 3 次够用。
max_web_calls = 3
# ★ 网页类结果进对话前保留多少字符（比普通工具更狠，因为网页废话最多）
web_result_chars = 1200
# 单价（元 / 百万 token）。填了就会在结尾估算本次花费；不填只报 token 数。
# 例（deepseek）：输入 2 / 输出 8  → price_in = 2, price_out = 8
price_in = 0
price_out = 0
# 缓存命中的输入价（元 / 百万 token）。留 0 = 按 price_in 的 1/10 粗略折算；
# 想要准确估算请照官方定价页填（命中价随模型和时期变化，别照抄别人的数）
price_cache_in = 0
# 关掉就退化成纯推理，模型不能调工具验证
use_tools = true
# 单次模型请求超时（秒）
timeout_seconds = 300
# 撞到限流(429)/服务端错误时的重试次数（指数退避）
max_retries = 3

[app]
# 把每次运行的终端输出存到 data/logs/run-*.log（想排查花销/问题时很有用）
save_log = true

# 读到题目后自动开始解题
auto_solve = true
# 出答案后自动把答案推回页面并勾选（本工具只负责"填"，交卷永远由你自己点）
# 想只看答案不动页面：加 --no-fill 或 --sheet
auto_fill = true
# 页面脚本查答案的轮询间隔（秒）
poll_seconds = 2
# ★ 两次勾选之间的间隔（毫秒）。MOOC 页面每勾一个选项就发一次草稿写请求，
#   一秒内连点会被判"并发限制，请稍后再试" —— 这个间隔就是用来错开这些请求的。
fill_interval_ms = 400
# 撞到平台"并发限制"弹窗后等多久再继续（毫秒）
limit_backoff_ms = 3000

[cdp]
# 浏览器可执行文件路径。留空 = 自动在常见位置找；
# 找不到时会问你一次，并把答案写回这里。
# Windows 例： browser = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
# macOS  例： browser = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
# Linux  例： browser = '/usr/bin/google-chrome'
browser = ""
# 用哪套登录态（--user-data-dir）。
#   留空（推荐）= 助手专用目录 ~/.course-ai-helper-profile，**登录一次之后一直有效**
#   想换目录就填个**非默认**目录，例如：
#     profile = 'D:\\course-ai-helper-profile'
#   ⚠ 不能指向浏览器默认数据目录：Chrome 136+ 会对默认目录忽略 --remote-debugging-port，
#     工具就连不上了（Google 的安全加固，详见 docs/find-profile.md）
profile = ""
# 有些平台（如智慧树）把题干预设在**闭合 Shadow DOM** 里，页面内的脚本读不到，
# 必须让助手直连浏览器的调试端口去**只读**读取。启用方式见 启动带调试浏览器.bat
# 调试端口（要和启动 Chrome 时的 --remote-debugging-port 一致）
port = 9222
#
# ⚠ 本工具在 CDP 模式下只读：不点击、不填答、不提交。
#   原因：智慧树有反作弊检测（会弹「检测到异常脚本」），脚本点击的 isTrusted=false 一次就能被识别。
#   所以答案会写成答案单文件，由你自己动手填。
`;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = {...base};
  for (const [k, v] of Object.entries(over || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function coerce(cfg) {
  const n = (v, d, min, max) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return d;
    return Math.max(min, Math.min(max, x));
  };
  cfg.model.temperature = n(cfg.model.temperature, 0, 0, 2);
  cfg.model.concurrency = n(cfg.model.concurrency, 3, 1, 8);
  cfg.model.max_tool_rounds = n(cfg.model.max_tool_rounds, 7, 1, 20);   // 上限 20（--rounds 同）
  cfg.model.timeout_seconds = n(cfg.model.timeout_seconds, 300, 20, 3600);
  cfg.model.max_retries = n(cfg.model.max_retries, 3, 0, 6);
  cfg.model.tool_mode = ['auto', 'all'].includes(cfg.model.tool_mode) ? cfg.model.tool_mode : 'auto';
  cfg.model.max_tool_result_chars = n(cfg.model.max_tool_result_chars, 2000, 400, 20000);
  cfg.model.max_web_calls = n(cfg.model.max_web_calls, 3, 0, 10);
  cfg.model.web_result_chars = n(cfg.model.web_result_chars, 1200, 400, 20000);
  cfg.model.price_in = n(cfg.model.price_in, 0, 0, 10000);
  cfg.model.price_out = n(cfg.model.price_out, 0, 0, 10000);
  cfg.model.price_cache_in = n(cfg.model.price_cache_in, 0, 0, 10000);
  cfg.model.use_tools = cfg.model.use_tools !== false;
  cfg.app.save_log = cfg.app.save_log !== false;
  cfg.app.auto_solve = cfg.app.auto_solve !== false;
  cfg.app.auto_fill = cfg.app.auto_fill !== false;
  cfg.app.poll_seconds = n(cfg.app.poll_seconds, 2, 1, 30);
  cfg.app.fill_interval_ms = n(cfg.app.fill_interval_ms, 400, 0, 5000);
  cfg.app.limit_backoff_ms = n(cfg.app.limit_backoff_ms, 3000, 500, 30000);
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.cdp.profile = String(cfg.cdp.profile || '');
  cfg.cdp.browser = String(cfg.cdp.browser || '');
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.cdp.profile = String(cfg.cdp.profile || '');
  cfg.cdp.browser = String(cfg.cdp.browser || '');
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.cdp.profile = String(cfg.cdp.profile || '');
  cfg.cdp.browser = String(cfg.cdp.browser || '');
  cfg.model.reasoning_effort = String(cfg.model.reasoning_effort || 'max').toLowerCase();
  if (!['off', 'low', 'high', 'max', ''].includes(cfg.model.reasoning_effort)) cfg.model.reasoning_effort = 'max';
  return cfg;
}

export function configPath(rootDir) {
  return path.join(rootDir, 'config.toml');
}

/** 把 [cdp] 下的某个键写回 config.toml（只改一行，保留其余注释） */
export function saveCdpSetting(rootDir, configFile, key, value) {
  const file = configPath(rootDir, configFile);
  let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : CONFIG_TEMPLATE;
  const line = `${key} = '${String(value).replace(/'/g, '')}'`;     // 字面量字符串：Windows 反斜杠不用转义
  const re = new RegExp(`^[ \t]*${key}[ \t]*=.*$`, 'm');
  if (re.test(s)) s = s.replace(re, line);
  else if (/^\[cdp\][^\n]*\n/m.test(s)) s = s.replace(/^\[cdp\][^\n]*\n/m, m => m + line + '\n');
  else s = s.trimEnd() + `\n\n[cdp]\n${line}\n`;
  fs.writeFileSync(file, s, 'utf8');
  return file;
}

export function loadConfig(rootDir, fileOverride) {
  const file = fileOverride ? path.resolve(fileOverride) : configPath(rootDir);
  const note = {file, created: false, error: null};
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, CONFIG_TEMPLATE, 'utf8');
    note.created = true;
  }
  let parsed = {};
  try {
    parsed = parseToml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    note.error = e.message;
  }
  return {config: coerce(merge(DEFAULT_CONFIG, parsed)), note};
}

/** 给前端看的配置（隐去 API Key） */
export function publicConfig(cfg) {
  const k = cfg.model.api_key || '';
  return {
    server: {port: cfg.server.port},
    model: {
      base_url: cfg.model.base_url,
      model: cfg.model.model,
      reasoning_effort: cfg.model.reasoning_effort,
      temperature: cfg.model.temperature,
      concurrency: cfg.model.concurrency,
      max_tool_rounds: cfg.model.max_tool_rounds,
      use_tools: cfg.model.use_tools,
      max_retries: cfg.model.max_retries,
      api_key_set: !!k,
      api_key_hint: k ? k.slice(0, 6) + '…' + k.slice(-4) : '',
    },
    app: {
      auto_solve: cfg.app.auto_solve,
      auto_fill: cfg.app.auto_fill,
      poll_seconds: cfg.app.poll_seconds,
      fill_interval_ms: cfg.app.fill_interval_ms,
      limit_backoff_ms: cfg.app.limit_backoff_ms,
      cdp: {port: cfg.cdp.port, readOnly: true},
      cdp: {port: cfg.cdp.port, readOnly: true},
      cdp: {port: cfg.cdp.port, readOnly: true},
    },
  };
}
