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
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        this.#consoleLogs.push({type: msg.params.type, text});
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
    // 打开 Runtime/DOM 域，后续调用更省事
    await s.send('Runtime.enable').catch(() => {});
    await s.send('DOM.enable').catch(() => {});
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

  /** 在页面里求值，返回 JSON 可序列化的结果。 */
  async eval(expression, {awaitPromise = false} = {}) {
    const r = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise, timeout: 30000});
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面求值异常：' + (d.exception?.description || d.text || '').slice(0, 300));
    }
    return r.result?.value;
  }

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
