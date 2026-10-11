/**
 * 配置：从 config.toml 读取（文件不存在则生成模板）
 */
import fs from 'node:fs';
import path from 'node:path';
import {parseToml} from './toml.mjs';

export const DEFAULT_CONFIG = {
  server: {
    platform: 'mooc',          // 默认平台（网页上切换会记到 data/platform.txt，不改这里）
    port: 8787,
    open_browser: true,
  },
  model: {
    base_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-flash',
    reasoning_effort: 'max',   // off | low | high | max
    temperature: 0,
    concurrency: 3,
    max_tool_rounds: 4,
    use_tools: true,
    timeout_seconds: 300,
    max_retries: 3,
  },
  app: {
    auto_solve: true,          // 控制台收到题目后，后端自动开解
    auto_fill: true,           // 出答案后自动推回页面并勾选（本工具只填不交卷）
    poll_seconds: 2,           // 控制台脚本轮询间隔
    fill_interval_ms: 400,     // ★ 两次勾选之间的间隔：MOOC 每勾一次就发一次草稿写请求，太快会被平台限流
    limit_backoff_ms: 3000,    // 撞到"并发限制"弹窗后的退避等待
  },
  cdp: {
    port: 9222,                // 浏览器调试端口（只读读取用；工具不会在页面上点任何东西）
  },
};

export const CONFIG_TEMPLATE = `# ============================================================
#  在线课程 AI 答题助手 —— 配置文件
#  改完保存，在网页上点「重载配置」即可生效（不用重启）
# ============================================================

[server]
# 本地服务端口（网页地址就是 http://127.0.0.1:<port>/）
port = 8787
# 默认平台：mooc / chaoxing / zhihuishu（网页上也能随时切，切换会记在 data/platform.txt）
platform = "mooc"
# 启动时自动打开浏览器
open_browser = true

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
# 每题最多让模型调用几轮工具（calc / web_search / web_fetch）
max_tool_rounds = 4
# 关掉就退化成纯推理，模型不能调工具验证
use_tools = true
# 单次模型请求超时（秒）
timeout_seconds = 300
# 撞到限流(429)/服务端错误时的重试次数（指数退避）
max_retries = 3

[app]
# 控制台脚本一上传题目，后端就自动开始解题
auto_solve = true
# 出答案后自动把答案推回页面并勾选（只在控制台脚本还活着时有效）
# 本工具只负责"填"，交卷永远由你自己点
auto_fill = true
# 控制台脚本查答案的轮询间隔（秒）
poll_seconds = 2
# ★ 两次勾选之间的间隔（毫秒）。MOOC 页面每勾一个选项就发一次 saveDraftAnswers 草稿写请求，
#   一秒内连点会被平台判为"并发限制，请稍后再试"—— 这个间隔就是用来错开这些请求的。
fill_interval_ms = 400
# 撞到平台"并发限制"弹窗后等多久再继续（毫秒）
limit_backoff_ms = 3000

[cdp]
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
  cfg.server.port = n(cfg.server.port, 8787, 1, 65535);
  cfg.server.open_browser = cfg.server.open_browser !== false;
  cfg.model.temperature = n(cfg.model.temperature, 0, 0, 2);
  cfg.model.concurrency = n(cfg.model.concurrency, 3, 1, 8);
  cfg.model.max_tool_rounds = n(cfg.model.max_tool_rounds, 4, 1, 8);
  cfg.model.timeout_seconds = n(cfg.model.timeout_seconds, 300, 20, 3600);
  cfg.model.max_retries = n(cfg.model.max_retries, 3, 0, 6);
  cfg.model.use_tools = cfg.model.use_tools !== false;
  cfg.app.auto_solve = cfg.app.auto_solve !== false;
  cfg.app.auto_fill = cfg.app.auto_fill !== false;
  cfg.app.poll_seconds = n(cfg.app.poll_seconds, 2, 1, 30);
  cfg.app.fill_interval_ms = n(cfg.app.fill_interval_ms, 400, 0, 5000);
  cfg.app.limit_backoff_ms = n(cfg.app.limit_backoff_ms, 3000, 500, 30000);
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.cdp = cfg.cdp || {};
  cfg.cdp.port = n(cfg.cdp.port, 9222, 1, 65535);
  cfg.model.reasoning_effort = String(cfg.model.reasoning_effort || 'max').toLowerCase();
  if (!['off', 'low', 'high', 'max', ''].includes(cfg.model.reasoning_effort)) cfg.model.reasoning_effort = 'max';
  return cfg;
}

export function configPath(rootDir) {
  return path.join(rootDir, 'config.toml');
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
