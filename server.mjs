#!/usr/bin/env node
/**
 * 在线课程 AI 答题助手 —— 本地服务端（多平台，平台模块见 platforms/<id>/index.mjs）
 *
 *  控制台脚本(helper.js) --POST /api/collect--> 本服务 --自动解题--> 答案
 *         ^                                                            |
 *         +----------------- GET /api/answers（轮询）<-----------------+
 *                               自动回填到页面
 *
 * 配置全部来自 config.toml（网页上点「重载配置」即可生效，不用重启）。
 * 零第三方依赖，Node 18+ / 便携版 node.exe 直接跑。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {exec} from 'node:child_process';
import {runTool, toolSpecs} from './lib/tools.mjs';
import {solvePaper, imageToDataUrl} from './lib/agent.mjs';
import {loadConfig, publicConfig, configPath} from './lib/config.mjs';
import {loadPlatforms, publicPlatform} from './lib/platforms.mjs';
import {listTabs, findTab, CdpSession} from './lib/cdp.mjs';
import {renderAnswerSheet, safeName} from './lib/report.mjs';

// 当前平台的 CDP 能力（mode='cdp' 且导出了 readPaper 才有）
const cdpState = {session: null, tab: null, port: null};
const cdpReady = () => !!(current && current.mode === 'cdp' && typeof current.readPaper === 'function');
const cdpPattern = () => (current && current.matchUrl) || /$^/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// ---- 多平台：一个服务支持所有平台，网页上切换
const PLATFORMS = await loadPlatforms(__dirname);
if (!PLATFORMS.length) { console.error('没有找到任何平台（platforms/<id>/index.mjs）'); process.exit(1); }
const platformById = id => PLATFORMS.find(p => p.id === id) || null;
// 网页上切换的平台记在小文件里（不改用户手写的 config.toml，保留注释）
const platformStateFile = () => path.join(DATA_DIR, 'platform.txt');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // 自检会用临时目录
fs.mkdirSync(DATA_DIR, {recursive: true});

const TOKEN = crypto.randomBytes(16).toString('hex');

const CONFIG_FILE = process.env.CONFIG_FILE || '';
let loaded = loadConfig(__dirname, CONFIG_FILE);
let CFG = loaded.config;

// 当前平台：环境变量 > config.toml 的 [server] platform > 上次网页上选的 > 第一个
function pickInitialPlatform() {
  let saved = '';
  try { if (fs.existsSync(platformStateFile())) saved = fs.readFileSync(platformStateFile(), 'utf8').trim(); } catch {}
  const wanted = process.env.PLATFORM || CFG.server.platform || saved;
  return platformById(wanted) || PLATFORMS[0];
}
let current = pickInitialPlatform();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function settingsFromConfig() {
  return {
    baseUrl: CFG.model.base_url,
    apiKey: CFG.model.api_key,
    model: CFG.model.model,
    temperature: CFG.model.temperature,
    concurrency: CFG.model.concurrency,
    maxRounds: CFG.model.max_tool_rounds,
    useTools: CFG.model.use_tools,
    reasoningEffort: CFG.model.reasoning_effort,
    timeoutSeconds: CFG.model.timeout_seconds,
    maxRetries: CFG.model.max_retries,
  };
}

// ---------------------------------------------------------------- 会话状态
function newSession() {
  return {
    id: 0, paper: null, status: 'idle', events: [], seq: 0,
    answers: {}, results: [], error: null,
    collectedAt: 0, startedAt: 0, finishedAt: 0,
  };
}
let session = newSession();

function emit(ev) {
  const e = {seq: ++session.seq, t: Date.now(), ...ev};
  session.events.push(e);
  if (session.events.length > 3000) session.events.splice(0, session.events.length - 3000);
  if (typeof currentStream === 'function') { try { currentStream(e); } catch {} }
  return e;
}
let currentStream = null;

function archive() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // tid 可能是 URL（含 / : 等非法字符），必须洗成安全文件名
    const file = path.join(DATA_DIR, `${safeName((session.paper && session.paper.tid) || 'quiz', 'quiz')}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
      paper: session.paper, answers: session.answers, results: session.results,
      status: session.status, error: session.error, savedAt: new Date().toISOString(),
    }, null, 2));
    emit({type: 'saved', file: path.basename(file)});
  } catch (e) {
    emit({type: 'warn', message: '存档失败：' + e.message});
  }
}

let solving = false;

/**
 * 把答案写成「答案单」文件（Markdown），给人照着手工填。
 * 只写本机文件，**不在页面上做任何修改**（点鼠标填答案这件事永远是用户自己来）。
 */
function writeAnswerSheet() {
  try {
    const md = renderAnswerSheet(session.paper, session.answers, {
      siteName: current ? current.name : '',
      model: CFG.model.model,
      url: (session.paper && session.paper.tid) || '',
      solvedAt: new Date().toLocaleString('zh-CN'),
    });
    const name = safeName((session.paper && (session.paper.name || session.paper.title)) || 'answer');
    const file = path.join(DATA_DIR, `${name}-答案单-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, md, 'utf8');
    session.reportFile = file;
    emit({type: 'report', file: path.basename(file)});
    return file;
  } catch (e) {
    emit({type: 'warn', message: '答案单生成失败：' + e.message});
    return null;
  }
}

/** 附加到浏览器里匹配该平台的标签（只读） */
async function cdpAttach(port) {
  if (cdpState.session) { try { cdpState.session.close(); } catch {} cdpState.session = null; }
  const tab = await findTab(cdpPattern(), port);
  if (!tab) return {ok: false, error: '没找到该平台的答题页标签。请在那个浏览器里打开作业答题界面。', tabs: await listTabs(port)};
  cdpState.session = await CdpSession.attach(tab);
  cdpState.tab = tab;
  cdpState.port = port;
  return {ok: true, tab, session: cdpState.session};
}

/** 收到一份试卷：建新会话 + （按配置）自动开始解题。不提交任何东西。 */
async function handlePaperUpload(paper) {
  if (!paper || !Array.isArray(paper.questions) || !paper.questions.length) {
    return {code: 400, body: {ok: false, error: 'paper.questions 为空'}};
  }
  if (solving) return {code: 409, body: {ok: false, error: '已经在解题中，等这轮跑完再传'}};
  session.id++;
  session.paper = paper;
  session.collectedAt = Date.now();
  session.status = 'collected';
  session.events = [];
  session.seq = 0;
  session.answers = {};
  session.results = [];
  emit({type: 'collected', tid: paper.tid, name: paper.name, total: paper.questions.length, source: paper.source});
  const started = CFG.app.auto_solve ? await startSolve(paper) : {started: false, reason: 'auto_solve = false'};
  return {
    code: 200,
    body: {
      ok: true, sessionId: session.id, total: paper.questions.length,
      autoSolve: !!started.started, autoSolveReason: started.reason || null,
      autoFill: CFG.app.auto_fill, pollSeconds: CFG.app.poll_seconds,
      fillIntervalMs: CFG.app.fill_interval_ms, limitBackoffMs: CFG.app.limit_backoff_ms,
      model: CFG.model.model, reasoning: CFG.model.reasoning_effort,
    },
  };
}

async function startSolve(paper) {
  if (solving) return {started: false, reason: '已经在解题中'};
  solving = true;
  session.paper = paper;
  session.status = 'running';
  session.events = [];
  session.seq = 0;
  session.answers = {};
  session.results = [];
  session.error = null;
  session.startedAt = Date.now();
  emit({type: 'start', total: (paper.questions || []).length, model: CFG.model.model, reasoning: CFG.model.reasoning_effort});
  const settings = settingsFromConfig();
  solvePaper({paper, settings, onEvent: emit})
    .then(async ({answers, results}) => {
      session.answers = answers;
      session.results = results;
      session.status = 'done';
      session.finishedAt = Date.now();
      archive();
      // 只生成答案单供人工填写；本服务不会在页面上点任何东西
      writeAnswerSheet();
    })
    .catch(e => {
      session.status = 'error';
      session.error = e && e.message ? e.message : String(e);
      emit({type: 'fatal', message: session.error});
    })
    .finally(() => { solving = false; });
  return {started: true};
}

// ---------------------------------------------------------------- HTTP 工具
function send(res, code, body, headers = {}) {
  res.writeHead(code, {'Cache-Control': 'no-store', ...headers});
  res.end(body);
}

function sendFile(res, file, downloadName) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', {'Content-Type': MIME['.txt']});
    const headers = {'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};
    if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
    send(res, 200, buf, headers);
  });
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 简单并发闸：限制同时打到题库 CDN 的图片请求数
function makeGate(max) {
  let active = 0;
  const queue = [];
  return fn => new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { active--; const next = queue.shift(); if (next) next(); }
    };
    if (active < max) run(); else queue.push(run);
  });
}
const imageGate = makeGate(3);

// 跨域白名单来自当前平台模块
const defaultOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const allowedOriginRe = () => (current && current.allowOriginRe) || defaultOriginRe;
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !allowedOriginRe().test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,X-Helper-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  };
}
function isSameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // 同源 GET 通常不带 Origin
  try {
    const u = new URL(o);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port || 80) === port;
  } catch { return false; }
}
function hasToken(req, u) {
  return u.searchParams.get('t') === TOKEN || req.headers['x-helper-token'] === TOKEN;
}

// ---------------------------------------------------------------- 路由
let port = CFG.server.port;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(u.pathname);
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') return send(res, 204, '', cors);

  // ---- 健康检查（公开，不含任何敏感信息）
  if (p === '/api/health') {
    return send(res, 200, JSON.stringify({ok: true, node: process.version, tools: toolSpecs.map(t => t.function.name)}),
      {'Content-Type': MIME['.json'], ...cors});
  }

  // ---- 配置（同源才给；不含 api_key）
  if (p === '/api/config' && isSameOrigin(req)) {
    return send(res, 200, JSON.stringify({
      ok: true, token: TOKEN, configFile: loaded.note.file, created: loaded.note.created,
      site: current ? {
        id: current.id, name: current.name, shortName: current.shortName || current.name,
        platformHint: current.platformHint || '', mode: current.mode || 'script',
        readOnly: !!current.readOnly, cdp: cdpReady(),
      } : null,
      platforms: PLATFORMS.map(publicPlatform),
      helperHint: current ? (current.helperHint || '') : '',
      helperFile: current && current.helperFile ? '/' + current.helperFile : null,
      parseError: loaded.note.error, config: publicConfig(CFG),
    }), {'Content-Type': MIME['.json']});
  }
  if (p === '/api/reload-config' && req.method === 'POST' && isSameOrigin(req)) {
    loaded = loadConfig(__dirname, CONFIG_FILE);
    CFG = loaded.config;
    emit({type: 'info', message: '配置已重载：' + CFG.model.model + ' / 思考 ' + CFG.model.reasoning_effort});
    return send(res, 200, JSON.stringify({ok: true, created: loaded.note.created, parseError: loaded.note.error, config: publicConfig(CFG)}),
      {'Content-Type': MIME['.json']});
  }

  // ---- 工具自检（同源）
  if (p === '/api/tool-test' && req.method === 'POST' && isSameOrigin(req)) {
    const q = u.searchParams.get('q') || '线性代数 行列式 性质';
    const out = [];
    const probes = [
      ['calc', {expression: 'det([[1,0,2,1],[0,-1,3,-1],[-1,-1,5,-1],[-1,1,4,0]]) + normalinv(0.975)'}],
      ['matrix', {op: 'eigen', a: [[2, 1], [1, 2]]}],
      ['calculus', {op: 'derivative', expr: 'x^3+2x', variable: 'x', at: 2}],
      ['stats', {op: 'ttest', data: [1, 2, 3, 4, 5], mu: 0}],
      ['web_fetch', {url: 'https://www.icourse163.org/'}],
      ['web_search', {query: q, max_results: 3}],
    ];
    for (const [name, args] of probes) {
      const s = Date.now();
      const r = await runTool(name, args);
      out.push({name, args, ms: Date.now() - s, ok: !/失败|错误|异常/.test(r.result.slice(0, 40)), preview: r.result.slice(0, 500)});
    }
    return send(res, 200, JSON.stringify({ok: true, results: out}, null, 2), {'Content-Type': MIME['.json']});
  }

  // ---- 控制台脚本上传题目（跨域，需要 token）
  if (p === '/api/collect' && req.method === 'POST') {
    if (!hasToken(req, u)) return send(res, 403, JSON.stringify({ok: false, error: 'token 不对'}), {'Content-Type': MIME['.json'], ...cors});
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      return send(res, 400, JSON.stringify({ok: false, error: 'JSON 解析失败：' + e.message}), {'Content-Type': MIME['.json'], ...cors});
    }
    const r = await handlePaperUpload(body.paper);
    return send(res, r.code, JSON.stringify(r.body), {'Content-Type': MIME['.json'], ...cors});
  }

  // ---- 网页手动粘贴题目（同源，免 token）
  if (p === '/api/set-paper' && req.method === 'POST' && isSameOrigin(req)) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      return send(res, 400, JSON.stringify({ok: false, error: 'JSON 解析失败：' + e.message}), {'Content-Type': MIME['.json']});
    }
    const r = await handlePaperUpload(body.paper);
    return send(res, r.code, JSON.stringify(r.body), {'Content-Type': MIME['.json']});
  }

  // ---- 切换平台（同源）
  if (p === '/api/platform' && req.method === 'POST' && isSameOrigin(req)) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const next = platformById(String(body.id || ''));
    if (!next) return send(res, 400, JSON.stringify({ok: false, error: '没有这个平台：' + body.id, platforms: PLATFORMS.map(x => x.id)}), {'Content-Type': MIME['.json']});
    current = next;
    if (cdpState.session) { try { cdpState.session.close(); } catch {} cdpState.session = null; cdpState.tab = null; }
    CFG.server.platform = current.id;
    try { fs.writeFileSync(platformStateFile(), current.id, 'utf8'); } catch {}
    emit({type: 'info', message: `已切换到平台：${current.name}（${current.mode} 模式）`});
    return send(res, 200, JSON.stringify({ok: true, site: {id: current.id, name: current.name, mode: current.mode, readOnly: !!current.readOnly, cdp: cdpReady()}}), {'Content-Type': MIME['.json']});
  }

  // ---- 下载答案单（Markdown，人工照着填）
  if (p === '/api/report' && isSameOrigin(req)) {
    if (!session.reportFile || !fs.existsSync(session.reportFile)) {
      return send(res, 404, JSON.stringify({ok: false, error: '还没有答案单，先解一份卷子'}), {'Content-Type': MIME['.json']});
    }
    return sendFile(res, session.reportFile, path.basename(session.reportFile));
  }

  // ---- CDP：直连浏览器**只读**读取答题页（用于把题干藏进闭合 Shadow DOM 的平台）
  if (cdpReady() && p === '/api/cdp/status' && isSameOrigin(req)) {
    const port = Number(u.searchParams.get('port') || CFG.cdp.port);
    let tabs = [], error = null;
    try { tabs = await listTabs(port); } catch (e) { error = e.message; }
    return send(res, 200, JSON.stringify({
      ok: !error, port, error,
      attached: cdpState.tab ? {url: cdpState.tab.url, title: cdpState.tab.title} : null,
      tabs: tabs.map(t => ({title: t.title, url: t.url, matched: cdpPattern().test(t.url)})),
    }), {'Content-Type': MIME['.json'], ...cors});
  }

  if (cdpReady() && p === '/api/cdp/collect' && req.method === 'POST' && isSameOrigin(req)) {
    const port = Number(u.searchParams.get('port') || CFG.cdp.port);
    let at;
    try { at = await cdpAttach(port); } catch (e) {
      return send(res, 502, JSON.stringify({ok: false, error: e.message}), {'Content-Type': MIME['.json'], ...cors});
    }
    if (!at.ok) return send(res, 404, JSON.stringify({ok: false, error: at.error, tabs: (at.tabs || []).map(t => t.url)}), {'Content-Type': MIME['.json'], ...cors});
    let paper;
    try { paper = await current.readPaper(cdpState.session); } catch (e) {
      return send(res, 502, JSON.stringify({ok: false, error: '读卷失败：' + e.message}), {'Content-Type': MIME['.json'], ...cors});
    }
    if (!paper || !paper.questions.length) {
      return send(res, 422, JSON.stringify({ok: false, error: '这个标签页上没读到题目，确认已进入答题界面', diagnose: await current.diagnose(cdpState.session).catch(() => null)}), {'Content-Type': MIME['.json'], ...cors});
    }
    const r = await handlePaperUpload(paper);
    return send(res, r.code, JSON.stringify({...r.body, cdp: true, readOnly: true, attachedUrl: cdpState.tab && cdpState.tab.url}), {'Content-Type': MIME['.json'], ...cors});
  }

  if (cdpReady() && p === '/api/cdp/diagnose' && isSameOrigin(req)) {
    const port = Number(u.searchParams.get('port') || CFG.cdp.port);
    if (!cdpState.session) {
      const at = await cdpAttach(port).catch(e => ({ok: false, error: e.message}));
      if (!at.ok) return send(res, 502, JSON.stringify({ok: false, error: at.error}), {'Content-Type': MIME['.json']});
    }
    const d = await current.diagnose(cdpState.session).catch(e => ({error: e.message}));
    return send(res, 200, JSON.stringify({ok: true, ...d}), {'Content-Type': MIME['.json']});
  }

  // ---- 控制台脚本取答案（跨域，需要 token）
  if (p === '/api/answers') {
    if (!hasToken(req, u)) return send(res, 403, JSON.stringify({ok: false, error: 'token 不对'}), {'Content-Type': MIME['.json'], ...cors});
    return send(res, 200, JSON.stringify({
      ok: true, sessionId: session.id, status: session.status,
      answers: session.answers,
      done: Object.values(session.answers).filter(Boolean).length,
      total: (session.paper && session.paper.questions || []).length,
      error: session.error,
      autoFill: CFG.app.auto_fill,
      reportFile: session.reportFile || null,
      source: (session.paper && session.paper.source) || null,
      reportFile: session.reportFile || null,
      source: (session.paper && session.paper.source) || null,
      fillIntervalMs: CFG.app.fill_interval_ms, limitBackoffMs: CFG.app.limit_backoff_ms,
    }), {'Content-Type': MIME['.json'], ...cors});
  }

  // ---- 网页点「重新解题」
  if (p === '/api/resolve' && req.method === 'POST' && isSameOrigin(req)) {
    if (!session.paper) return send(res, 400, JSON.stringify({ok: false, error: '还没有题目'}), {'Content-Type': MIME['.json']});
    if (solving) return send(res, 409, JSON.stringify({ok: false, error: '正在解题中'}), {'Content-Type': MIME['.json']});
    const r = await handlePaperUpload(session.paper);
    return send(res, r.code, JSON.stringify(r.body), {'Content-Type': MIME['.json']});
  }

  // ---- 网页轮询状态（同源）
  if (p === '/api/state' && isSameOrigin(req)) {
    const since = Number(u.searchParams.get('since') || 0);
    const clientPaperId = Number(u.searchParams.get('paperId') ?? -1);
    const fresh = clientPaperId !== session.id;
    const effSince = fresh ? 0 : since;
    return send(res, 200, JSON.stringify({
      ok: true,
      sessionId: session.id,
      status: session.status,
      error: session.error,
      seq: session.seq,
      events: session.events.filter(e => e.seq > effSince),
      answers: session.answers,
      reportFile: session.reportFile || null,
      results: fresh ? session.results : undefined,
      done: Object.values(session.answers).filter(Boolean).length,
      total: (session.paper && session.paper.questions || []).length,
      paper: fresh ? session.paper : undefined,
      config: publicConfig(CFG),
      running: solving,
    }), {'Content-Type': MIME['.json']});
  }

  // ---- 手动重解（同源，NDJSON 流；UI 一般用轮询，这个留给手动/测试）
  if (p === '/api/solve' && req.method === 'POST' && isSameOrigin(req)) {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) {
      return send(res, 400, JSON.stringify({error: '请求体不是合法 JSON：' + e.message}), {'Content-Type': MIME['.json']});
    }
    const paper = payload.paper || session.paper;
    if (!paper || !Array.isArray(paper.questions) || !paper.questions.length) {
      return send(res, 400, JSON.stringify({error: '没有题目'}), {'Content-Type': MIME['.json']});
    }
    const s = settingsFromConfig();
    const override = payload.settings || {};
    for (const k of ['baseUrl', 'apiKey', 'model', 'temperature', 'concurrency', 'maxRounds', 'useTools', 'reasoningEffort', 'timeoutSeconds', 'maxRetries']) {
      if (override[k] !== undefined) s[k] = override[k];
    }
    if (!s.apiKey) return send(res, 400, JSON.stringify({error: 'config.toml 里没填 api_key'}), {'Content-Type': MIME['.json']});
    if (solving) return send(res, 409, JSON.stringify({error: '已经在解题中'}), {'Content-Type': MIME['.json']});

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => { closed = true; });
    session.events = []; session.seq = 0; session.answers = {}; session.results = []; session.error = null;
    solving = true;
    session.status = 'running';
    currentStream = e => { if (!closed) { try { res.write(JSON.stringify(e) + '\n'); } catch {} } };
    try {
      const {answers, results} = await solvePaper({paper, settings: s, onEvent: emit});
      session.answers = answers; session.results = results; session.status = 'done'; session.finishedAt = Date.now();
      archive();
    } catch (e) {
      session.status = 'error'; session.error = e.message;
      emit({type: 'fatal', message: e.message});
    } finally {
      solving = false;
      currentStream = null;
      if (!closed) res.end();
    }
    return;
  }

  // ---- 图片代理
  if (p === '/api/image') {
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(target)) return send(res, 400, 'bad url');
    try {
      const dataUrl = await imageGate(() => imageToDataUrl(target));
      const b64 = dataUrl.split(',')[1];
      const type = dataUrl.slice(5, dataUrl.indexOf(';'));
      return send(res, 200, Buffer.from(b64, 'base64'), {'Content-Type': type, 'Cache-Control': 'max-age=3600'});
    } catch (e) { return send(res, 502, 'fetch failed: ' + e.message); }
  }

  // ---- 控制台脚本（注入后端地址与 token）
  if (p === '/console/helper.js' || p === '/console/collect.js') {
    const file = p.endsWith('helper.js') ? 'helper.js' : 'collect.js';
    const rel = current && current.helperFile ? current.helperFile : 'console/helper.js';
    const filePath = path.join(current ? current.dir : __dirname, path.basename(rel) === 'collect.js' ? 'console/collect.js' : rel);
    if (!fs.existsSync(filePath)) {
      return send(res, 404, `// 平台「${current ? current.name : '?'}」没有控制台脚本（mode=${current ? current.mode : '?'}）\n// 该平台走的是「只读 + 答案单」模式，不需要粘脚本。\n`, {'Content-Type': MIME['.js'], ...cors});
    }
    const src = fs.readFileSync(filePath, 'utf8')
      .replace('__BACKEND__', `http://127.0.0.1:${port}`)
      .replace('__TOKEN__', TOKEN);
    return send(res, 200, src, {
      'Content-Type': MIME['.js'],
      ...(u.searchParams.has('dl') ? {'Content-Disposition': `attachment; filename="${file}"`} : {}),
      ...cors,
    });
  }
  if (p === '/console/fill.js') {
    const f = path.join(current ? current.dir : __dirname, 'console/fill.js');
    if (!fs.existsSync(f)) return send(res, 404, '// 该平台没有 fill.js\n', {'Content-Type': MIME['.js'], ...cors});
    return sendFile(res, f, u.searchParams.has('dl') ? 'fill.js' : undefined);
  }

  // ---- 示例题目
  if (p.startsWith('/examples/')) {
    const dir = path.join(__dirname, 'examples');
    const f = path.join(dir, p.slice('/examples/'.length));
    if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(res, f);
    return send(res, 404, 'not found', {'Content-Type': MIME['.txt']});
  }

  // ---- 静态资源
  if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  const file = path.join(PUBLIC_DIR, p.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);

  send(res, 404, 'not found', {'Content-Type': MIME['.txt'], ...cors});
});

// ---------------------------------------------------------------- 启动
function listen(p) {
  return new Promise((resolve, reject) => {
    const onError = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(p, '0.0.0.0');
  });
}

(async () => {
  const cliPort = Number(process.env.PORT || 0);
  port = cliPort || CFG.server.port;
  for (let i = 0; i < 12; i++) {
    try { await listen(port); break; } catch (e) {
      if (e.code === 'EADDRINUSE') { port++; continue; }
      console.error('启动失败：', e.message);
      process.exit(1);
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  ' + (current ? current.name : '') + ' AI 答题助手已启动');
  console.log('  ' + url);
  console.log(`  配置：${loaded.note.file}`);
  console.log(`  模型：${CFG.model.model}  思考：${CFG.model.reasoning_effort}  并发：${CFG.model.concurrency}`);
  if (!CFG.model.api_key) console.log('  ⚠ config.toml 里还没填 api_key，填完在网页上点「重载配置」');
  console.log('  （关闭本窗口即停止服务）');
  console.log('');
  if (CFG.server.open_browser && !process.env.NO_OPEN) {
    await sleep(300);
    exec(process.platform === 'win32' ? `start "" "${url}"` : `cmd.exe /c start "" "${url}"`, () => {});
  }
})();
