/**
 * 页面桥接 —— 把"控制台一键脚本"变成"终端驱动"。
 *
 * 原来的流程：用户把 helper.js 粘到页面控制台 → 脚本 POST 给本机服务 → 轮询答案 → 自己填。
 * 现在的流程：终端用 CDP 把 helper.js 注入页面，并给它装一个**假的 fetch**：
 *
 *   helper 调 /api/collect  → 桥接层把题目截下来交给终端，并回一个"先别自动解题"
 *   终端调模型解题（终端里打印进度）
 *   终端把答案塞回 window.__BRIDGE__.answers
 *   helper 下次轮询 /api/answers → 拿到答案 → **用它自己验证过的 DOM 逻辑勾选**
 *
 * 好处：控制台脚本的页面逻辑一个字都不用改（还是那份被实测过的代码），
 *      用户不再需要粘任何东西，所有进度都回到终端。
 */

/** 装进页面的桥接脚本：拦截 fetch，暴露一个可被 CDP 读写的状态对象 */
export function bridgeSource({pollSeconds = 1, fillIntervalMs = 400, limitBackoffMs = 3000} = {}) {
  return BRIDGE_SOURCE_RAW
    .replace('__POLL__', String(pollSeconds))
    .replace('__FILL_MS__', String(fillIntervalMs))
    .replace('__BACKOFF_MS__', String(limitBackoffMs));
}

const BRIDGE_SOURCE_RAW = `
(() => {
  if (window.__BRIDGE__ && window.__BRIDGE__.installed) return 'already';
  const B = window.__BRIDGE__ = {
    installed: true, paper: null, answers: null, status: 'pending',
    fill: null, total: 0, delivered: false, errors: [],
  };
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json'}});
  window.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    try {
      if (u.includes('/api/collect')) {
        let paper = null;
        try { paper = JSON.parse(opts && opts.body).paper; } catch (e) { B.errors.push('collect 解析失败: ' + e.message); }
        B.paper = paper;
        B.total = (paper && paper.questions || []).length;
        return json({ok: true, sessionId: 1, total: B.total, autoSolve: false, autoFill: true,
          pollSeconds: __POLL__, fillIntervalMs: __FILL_MS__, limitBackoffMs: __BACKOFF_MS__, model: 'cli', reasoning: 'cli'});
      }
      if (u.includes('/api/answers')) {
        if (B.status === 'done') {
          B.status = 'delivering';
          return json({ok: true, sessionId: 1, status: 'done', answers: B.answers || {},
            done: Object.keys(B.answers || {}).length, total: B.total});
        }
        return json({ok: true, sessionId: 1, status: 'running', answers: {}, done: 0, total: B.total});
      }
    } catch (e) {
      B.errors.push(String(e && e.message || e));
    }
    if (realFetch) return realFetch(url, opts);
    throw new Error('bridge: 未拦截的请求 ' + u);
  };
  return 'installed';
})()
`;

/** 兼容：不带参数时用默认值 */
export const BRIDGE_SOURCE = bridgeSource();

/**
 * 读取页面脚本（console/helper.js）并注入后端地址/token。
 *
 * ★ 只能替换**赋值那一行**，不能全局替换：
 *   页面脚本里有这么一句自检：
 *     if (!/^https?:\/\//.test(BACKEND) || BACKEND.includes('__BACKEND__')) return manual('没被注入')
 *   如果全局替换，守卫里的 '__BACKEND__' 也会变成真实地址，
 *   于是 BACKEND.includes(真实地址) 恒为 true → 它反而判定"没被注入"直接放弃。
 */
export function preparePageScript(source, {backend = 'http://127.0.0.1:0', token = 'cli'} = {}) {
  const assign = (name, value) => {
    const re = new RegExp(`((?:const|let|var)\\s+${name}\\s*=\\s*)(['\"])__${name}__\\2`);
    if (re.test(source)) return source.replace(re, `$1$2${value}$2`);
    return source.replace(`__${name}__`, value);      // 退路：只换第一处
  };
  let out = assign('BACKEND', backend);
  out = (() => {
    const re = /((?:const|let|var)\s+TOKEN\s*=\s*)(['"])__TOKEN__/;
    return re.test(out) ? out.replace(re, `$1$2${token}$2`) : out.replace('__TOKEN__', token);
  })();
  return out;
}

/** 给终端看的一行日志（helper 的 console.log 带 %c 样式参数，要滤掉） */
export function cleanConsoleArgs(args) {
  const out = [];
  for (const a of args || []) {
    const v = a && (a.value !== undefined ? a.value : a.description);
    if (typeof v !== 'string') continue;
    if (/^color:|^font-weight:|^background:/.test(v)) continue;
    out.push(v);
  }
  return out.join(' ').replace(/^\[助手\]\s*/, '').trim();
}
