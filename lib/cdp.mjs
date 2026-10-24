/**
 * 极简 CDP（Chrome DevTools Protocol）客户端 —— 零依赖，Node 22+ 自带 WebSocket / fetch。
 *
 * 为什么需要它：有些平台（如智慧树）把题干预设在**闭合 Shadow DOM** 里，
 * 页面内的 JS（textContent / innerHTML / Range / 选区 / attachShadow 钩子）全读不到，
 * 只有浏览器层面的 CDP `DOM.getDocument{pierce:true}` 能穿透。所以让助手直连浏览器。
 *
 * 用法：
 *   const tabs = await listTabs(9222);
 *   const s = await CdpSession.attach(tabs.find(t => /dohomework/.test(t.url)));
 *   const tree = await s.getDocument({pierce: true});
 *   await s.clickAt(x, y);
 *   s.close();
 */

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

/** 列出所有页面标签。连不上就抛错（含可操作的提示）。 */
export async function listTabs(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  let res;
  try {
    res = await fetch(`http://${host}:${port}/json/list`, {signal: AbortSignal.timeout(4000)});
  } catch (e) {
    const err = new Error(
      `连不上浏览器调试端口 ${host}:${port}。\n` +
      `请用一个带调试端口的 Chrome 打开页面：\n` +
      `  Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir="%USERPROFILE%\\zhs-helper-profile"\n` +
      `  macOS:   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}\n` +
      `  Linux:   google-chrome --remote-debugging-port=${port}\n` +
      `  或者直接：node cli.mjs <平台> "<答题页链接>"  ← 它会自己把浏览器拉起来\n` +
      `（原始错误：${e.message}）`
    );
    err.code = 'CDP_UNREACHABLE';
    throw err;
  }
  if (!res.ok) throw new Error(`调试端口返回 HTTP ${res.status}`);
  const all = await res.json();
  return all.filter(t => t.type === 'page').map(t => ({id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl}));
}

/** 按 URL 正则找标签；找不到返回 null。 */
export async function findTab(re, port = DEFAULT_PORT, host = DEFAULT_HOST) {
  const tabs = await listTabs(port, host);
  return tabs.find(t => re.test(t.url)) || null;
}

export class CdpSession {
  #ws = null;
  #seq = 0;
  #pending = new Map();
  #closed = false;
  #listeners = new Set();
  #consoleLogs = [];
  #contexts = new Map();        // executionContextId -> context（用于跨 iframe 注入）
  #pageEnabled = false;
  #frameId = null;             // 注入目标 frame（null = 顶层文档）
  tab = null;

  constructor(ws, tab) {
    this.#ws = ws;
    this.tab = tab;
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.#pending.has(msg.id)) {
        const {resolve, reject} = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.executionContextCreated') {
        const c = msg.params.context;
        this.#contexts.set(c.id, c);
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        this.#contexts.delete(msg.params.executionContextId);
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        this.#contexts.clear();
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params.args || []).map(a => a.value ?? a.description ?? '');
        this.#consoleLogs.push({type: msg.params.type, args, text: args.join(' ')});
        if (this.#consoleLogs.length > 200) this.#consoleLogs.shift();
      }
      for (const fn of this.#listeners) { try { fn(msg); } catch {} }
    });
    ws.addEventListener('close', () => { this.#closed = true; });
  }

  /** 附加到一个标签（tab 来自 listTabs/findTab）。 */
  static async attach(tab) {
    if (!tab?.wsUrl) throw new Error('这个标签没有调试地址，无法附加');
    const ws = new WebSocket(tab.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('附加超时')), 8000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, {once: true});
      ws.addEventListener('error', e => { clearTimeout(t); reject(new Error('附加失败：' + (e.message || '连接错误'))); }, {once: true});
    });
    const s = new CdpSession(ws, tab);
    // 打开 Runtime/DOM/Page 域，后续调用更省事
    await s.send('Runtime.enable').catch(() => {});
    await s.send('DOM.enable').catch(() => {});
    try { await s.send('Page.enable'); s.#pageEnabled = true; } catch {}
    return s;
  }

  static async attachToUrl(re, port = DEFAULT_PORT, host = DEFAULT_HOST) {
    const tab = await findTab(re, port, host);
    if (!tab) return null;
    return CdpSession.attach(tab);
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.#closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this.#pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify({id, method, params}));
    });
  }

  onMessage(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  consoleLogs() { return this.#consoleLogs.slice(); }
  url() { return this.tab?.url || ''; }

  /** 在页面里求值，返回 JSON 可序列化的结果。
   *  若已用 setTargetFrame() 指定了 iframe，则在那个 frame 的上下文里求值。 */
  async eval(expression, {awaitPromise = false} = {}) {
    const params = {expression, returnByValue: true, awaitPromise, timeout: 30000};
    if (this.#frameId) {
      let ctx = this.frameContextId(this.#frameId);
      if (!ctx) { await this.refreshFrameContexts(); ctx = this.frameContextId(this.#frameId); }
      // ★ 绝不能悄悄退回顶层：那会把脚本注入到错误的文档里
      if (!ctx) throw new Error('目标 iframe 的执行上下文已失效（页面可能导航了），请重新进入答题页');
      params.contextId = ctx;
    }
    const r = await this.send('Runtime.evaluate', params);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面求值异常：' + (d.exception?.description || d.text || '').slice(0, 300));
    }
    return r.result?.value;
  }

  /** 按 frameId 找它的默认执行上下文（iframe 注入用）。 */
  frameContextId(frameId) {
    for (const c of this.#contexts.values()) {
      if (c.auxData && c.auxData.frameId === frameId && c.auxData.isDefault !== false) return c.id;
    }
    return null;
  }

  /** 重新拉一次执行上下文列表（frame 导航后会重建）。 */
  async refreshFrameContexts() {
    await this.send('Runtime.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 60));
  }

  /** 页面 frame 树（含所有 iframe）。 */
  async frameTree() {
    if (!this.#pageEnabled) { await this.send('Page.enable').catch(() => {}); this.#pageEnabled = true; }
    const {frameTree} = await this.send('Page.getFrameTree');
    const frames = [];
    const walk = n => { if (!n) return; frames.push(n.frame); for (const c of n.childFrames || []) walk(c); };
    walk(frameTree);
    return frames;
  }

  /**
   * 找第一个「文档里能查到 selector」的 frame —— 超星这类平台把题目套在多层 iframe 里，
   * 顶层 document 查不到，必须按 frame 逐个探。
   * 返回 {frameId, count, url} 或 null。
   */
  async findFrame(selector, {timeoutMs = 4000} = {}) {
    const started = Date.now();
    for (;;) {
      await this.refreshFrameContexts();
      const frames = await this.frameTree().catch(() => []);
      for (const fr of frames) {
        const ctx = this.frameContextId(fr.id);
        if (!ctx) continue;
        try {
          const r = await this.send('Runtime.evaluate', {
            expression: 'document.querySelectorAll(' + JSON.stringify(selector) + ').length',
            contextId: ctx, returnByValue: true,
          }, 4000);
          const n = Number(r.result?.value) || 0;
          if (n > 0) return {frameId: fr.id, count: n, url: fr.url || ''};
        } catch {}
      }
      if (Date.now() - started > timeoutMs) return null;
      await new Promise(r => setTimeout(r, 120));
    }
  }

  /** 指定后续 eval() 走哪个 iframe（传 null 回到顶层）。 */
  setTargetFrame(frameId) { this.#frameId = frameId || null; }
  get targetFrameId() { return this.#frameId; }

  /** 指定 frame 里求值（不动 setTargetFrame 状态）。 */
  async evalInFrame(frameId, expression, {awaitPromise = false} = {}) {
    const ctx = this.frameContextId(frameId);
    if (!ctx) throw new Error('找不到这个 frame 的执行上下文（可能已导航）');
    const r = await this.send('Runtime.evaluate', {expression, contextId: ctx, returnByValue: true, awaitPromise, timeout: 30000});
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面求值异常：' + (d.exception?.description || d.text || '').slice(0, 300));
    }
    return r.result?.value;
  }

  /** 顶层文档求值（截图算坐标时用，因为要跨同一父域下的 iframe）。 */
  async evalTop(expression, {awaitPromise = false} = {}) {
    const r = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise, timeout: 30000});
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面求值异常：' + (d.exception?.description || d.text || '').slice(0, 300));
    }
    return r.result?.value;
  }

  /** 截当前视口里的一块（clip 是 CSS 像素、相对视口）。 */
  async screenshotClip(clip, {format = 'jpeg', quality = 82, timeoutMs = 15000} = {}) {
    const params = {format, clip, fromSurface: true};
    if (format === 'jpeg') params.quality = quality;
    const r = await this.send('Page.captureScreenshot', params, timeoutMs);
    return Buffer.from(r.data, 'base64');
  }

  /** 把目标标签页切到前台 —— 隐藏标签页上 Chrome 的截图会卡住，截图前必须先亮出来。 */
  async bringToFront() { await this.send('Page.bringToFront').catch(() => {}); }

  /** 临时放大视口（让整卷都在"屏幕"里，截图不用滚动页面）。 */
  async setViewport({width = 1280, height = 4200, deviceScaleFactor = 1} = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile: false,
      screenWidth: width, screenHeight: height,
    }, 8000);
  }

  async clearViewport() { await this.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); }

  /** 浏览器层面的完整 DOM 树（pierce=true 会穿透闭合 Shadow DOM）。 */
  async getDocument({pierce = true, depth = -1} = {}) {
    const r = await this.send('DOM.getDocument', {depth, pierce}, 40000);
    return r.root;
  }

  /** 截整页；传 clip 可只截一块。返回 PNG Buffer。 */
  async screenshot({clip, format = 'png'} = {}) {
    const r = await this.send('Page.captureScreenshot', clip ? {format, clip} : {format}, 30000);
    return Buffer.from(r.data, 'base64');
  }

  /** 真实鼠标点击（可信事件，不会被当作脚本点击拦截）。 */
  async clickAt(x, y, {button = 'left'} = {}) {
    await this.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, button: 'none'});
    await this.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button, clickCount: 1});
    await new Promise(r => setTimeout(r, 60));
    await this.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button, clickCount: 1});
  }

  async keyTap(key, {text} = {}) {
    if (text) return this.send('Input.insertText', {text});
    const codes = {Enter: 13, Tab: 9, Escape: 27, Backspace: 8};
    const code = codes[key] ?? 0;
    await this.send('Input.dispatchKeyEvent', {type: 'keyDown', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code});
    await this.send('Input.dispatchKeyEvent', {type: 'keyUp', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code});
  }

  async navigate(url) { return this.send('Page.navigate', {url}); }
  async reload() { return this.send('Page.reload', {}); }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#ws.close(); } catch {}
    for (const {reject} of this.#pending.values()) reject(new Error('CDP 连接已关闭'));
    this.#pending.clear();
  }
}

// ------------------------------------------------------------------ 后台标签抓取
/**
 * 用**真实浏览器**抓一个网页的可见正文，返回 {title, text, url}。
 *
 * 为什么需要它：有些站点（百度百科、知到答案页）对 Node 的 fetch 一律 403 + "安全验证" ——
 * 换 UA / Referer / 移动版 UA 都没用，因为它看的是 TLS 指纹与 JS 执行。而真实 Chrome 天然就过。
 *
 * 关键约束：**绝不碰用户正在做题的那个标签**。整个流程是
 *   新建后台标签 → 导航 → 读 innerText → 关掉标签，
 * 用户自己的答题页自始至终没有被导航或改动。
 *
 * innerText 而不是 outerHTML：innerText 是**渲染后的可见文本**，天然去掉了隐藏导航/脚本，
 * 体积通常小 10~50 倍，正好配上 web_result_chars 的截断。
 */
export async function browserFetch(url, {port = DEFAULT_PORT, host = DEFAULT_HOST, timeoutMs = 25000, textCap = 60000} = {}) {
  let ver;
  try {
    ver = await fetch(`http://${host}:${port}/json/version`, {signal: AbortSignal.timeout(4000)}).then(r => r.json());
  } catch (e) {
    throw new Error(`连不上浏览器调试端口 ${host}:${port}（${e.message}）`);
  }
  if (!ver?.webSocketDebuggerUrl) throw new Error('调试端口没给出 browser 级连接地址');

  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接浏览器级调试端口超时')), 8000);
    bws.addEventListener('open', () => { clearTimeout(t); resolve(); }, {once: true});
    bws.addEventListener('error', () => { clearTimeout(t); reject(new Error('连接浏览器级调试端口失败')); }, {once: true});
  });

  let seq = 0;
  const pending = new Map();
  bws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const {resolve, reject} = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(`CDP ${m.error.code}: ${m.error.message}`)); else resolve(m.result);
    }
  });
  const bsend = (method, params = {}, ms = 15000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, ms);
    pending.set(id, {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
    try { bws.send(JSON.stringify({id, method, params})); } catch (e) { clearTimeout(timer); reject(e); }
  });

  let targetId = null, tab = null, session = null;
  try {
    // 1) 开一个后台标签（后台 = 不抢用户正在答题的那个页面的焦点）
    //
    //  ★★ 这里**绝对不能**退回前台标签：实测（把标签当"答题页"并让它处于可见状态）
    //     - background:true → 答题页保持 visibilityState=visible、document.hasFocus()=true，完全不受影响；
    //     - 前台新标签     → 答题页立刻变成 visibilityState=hidden、失去焦点。
    //     而"切屏/离开考试页"正是超星、智慧树这类防作弊系统判定的信号。
    //     所以：老版本 Chrome 不认 background 时，宁可放弃浏览器抓取，也不能用前台标签。
    let created;
    try {
      created = await bsend('Target.createTarget', {url: 'about:blank', background: true});
    } catch (e) {
      throw new Error(`这个浏览器不支持后台开标签（${e.message}）；为保证不打扰答题页，已放弃浏览器抓取`);
    }
    targetId = created.targetId;

    // 2) 从 /json/list 拿到它的 ws 地址（新标签出现需要几十毫秒）
    //    注意字段名转换：/json/list 原文是 webSocketDebuggerUrl，CdpSession.attach 要的是 wsUrl。
    for (let i = 0; i < 30 && !tab; i++) {
      const list = await fetch(`http://${host}:${port}/json/list`, {signal: AbortSignal.timeout(4000)}).then(r => r.json()).catch(() => []);
      const raw = (list || []).find(t => t.id === targetId && t.webSocketDebuggerUrl);
      if (raw) tab = {id: raw.id, title: raw.title, url: raw.url, wsUrl: raw.webSocketDebuggerUrl};
      else await new Promise(r => setTimeout(r, 100));
    }
    if (!tab) throw new Error('新标签没能在调试端口里出现');

    // 3) 导航 + 等加载完
    session = await CdpSession.attach(tab);
    // ★ 自检：如果这个"后台"标签居然是可见的，说明 background 被忽略了、它抢了激活，
    //   此刻用户的答题页多半已经被切到后台。立即收手 + 报错，让上层把兜底整个关掉。
    const selfVis = await session.eval('document.visibilityState').catch(() => '');
    if (selfVis === 'visible') {
      throw new Error('后台标签没能保持后台（background 被忽略），已放弃浏览器抓取以免影响答题页');
    }
    await session.send('Page.enable').catch(() => {});
    await session.navigate(url);
    const deadline = Date.now() + timeoutMs;
    let ready = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
      try { ready = await session.eval('document.readyState') || ''; } catch { ready = ''; }
      if (ready === 'complete') break;
    }
    await new Promise(r => setTimeout(r, 500));   // 留点时间给前端渲染正文

    // 4) 读可见正文
    //    ★ 优先取「正文容器」而不是整个 body：实测百度百科 body.innerText 有 15042 字符，
    //      前 600 字符全是「网页新闻贴吧知道…秒懂百科…」导航，会把 web_result_chars 的
    //      1200 窗口吃掉一半；.J-lemma-content 只有 8964 字符且**第一行就是「内容简介」**。
    //      顺序 = 具体站点容器 → 语义标签 → 常见正文 class，每个都要求 ≥400 字才算数，
    //      否则退回 body（短页面不能因为容器太窄而丢掉内容）。
    const title = await session.eval('document.title || ""').catch(() => '');
    const grab = (cap) => `(() => {
      const sels = ['.J-lemma-content', '.lemma-content', '.mw-parser-output', '#mw-content-text',
        'article', 'main', '[role="main"]',
        '.rich_media_content', '.article-content', '.artical-content', '.post-content', '.entry-content',
        '#content', '.content'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = (el.innerText || '').trim();
        if (t.length >= 400) return t.slice(0, ${cap});
      }
      return ((document.body || document.documentElement).innerText || '').slice(0, ${cap});
    })()`;
    const text = await session.eval(grab(Math.max(1000, Number(textCap) || 60000))).catch(() => '');
    const finalUrl = await session.eval('location.href').catch(() => url);
    if (!text || !String(text).trim()) throw new Error('页面没有可见正文（可能需要登录或加载失败）');
    // Chrome 自己的错误页也会返回一段文字（"该网页无法正常运作…ERR_NAME_NOT_RESOLVED"），
    // 不认出来就会被当成网页正文喂给模型。（加长度上限，免得误伤正文里提到 ERR_ 的正常页面）
    if (String(text).length < 800 && /(该网页无法正常运作|无法访问此网站|网页无法打开|This site can|ERR_[A-Z_]{3,})/.test(String(text))) {
      throw new Error('浏览器没能打开该页面（' + String(text).split('\n')[0].slice(0, 40) + '）');
    }
    return {title: String(title || ''), text: String(text), url: String(finalUrl || url)};
  } finally {
    // 5) 无论如何都收摊：关会话 → 关标签（两条路都试，绝不留残留标签在用户浏览器里）
    try { session?.close(); } catch {}
    if (targetId) {
      try { await bsend('Target.closeTarget', {targetId}, 5000); } catch {}
      // 兜底：再走一次 HTTP 关闭端点，确认标签真的没了
      try {
        const list = await fetch(`http://${host}:${port}/json/list`, {signal: AbortSignal.timeout(3000)}).then(r => r.json()).catch(() => []);
        if ((list || []).some(t => t.id === targetId)) {
          await fetch(`http://${host}:${port}/json/close/${targetId}`, {signal: AbortSignal.timeout(3000)}).catch(() => {});
        }
      } catch {}
    }
    try { bws.close(); } catch {}
  }
}

// ------------------------------------------------------------------ DOM 树工具
// CDP 返回的是纯 JSON 节点树（nodeName/attributes/children/shadowRoots/nodeValue），
// 下面这些工具让它用起来像普通 DOM 查询。

// 注意：CDP 的 attributes 是**扁平数组** [name1, value1, name2, value2, ...]，不是对象数组。
export function attrOf(node, name) {
  const a = node?.attributes;
  if (!a || !a.length) return null;
  if (typeof a[0] === 'string') {
    for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
    return null;
  }
  const o = a.find(x => x && x.name === name);
  return o ? o.value : null;
}
export function classOf(node) {
  return attrOf(node, 'class') || '';
}
export function hasClass(node, cls) {
  return classOf(node).split(/\s+/).includes(cls);
}
/** 收集 node 子树（含 shadowRoots）里所有满足条件的元素，深度优先。 */
export function queryAll(node, pred, out = []) {
  if (!node) return out;
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const c of node.children || []) queryAll(c, pred, out);
  for (const sr of node.shadowRoots || []) queryAll(sr, pred, out);
  return out;
}
export function query(node, pred) { return queryAll(node, pred)[0] || null; }
/** 取节点全部文本（穿透 shadowRoots，按文档顺序拼接，压缩空白）。 */
export function textOf(node) {
  if (!node) return '';
  let s = node.nodeType === 3 ? (node.nodeValue || '') : '';
  for (const c of node.children || []) s += textOf(c);
  for (const sr of node.shadowRoots || []) s += textOf(sr);
  return s.replace(/\s+/g, ' ').trim();
}
export function findById(node, id) { return query(node, n => attrOf(n, 'id') === id); }
