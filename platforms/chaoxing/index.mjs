/**
 * 平台适配：超星学习通 / 泛雅（chaoxing.com）
 *
 * 模式 script —— 页面脚本 + CDP 跨 iframe 注入。
 *
 * 实测（2026-10，真实章节测验）：
 *   1) 题目藏在 4 层 iframe 里：
 *      studentstudy > knowledge/cards > ananas/modules/work > iframe#frame_content
 *      顶层 document 查不到任何题目 → 必须按 frame 逐个探测，再往那个 frame 里注入脚本。
 *   2) 题干/选项套了 `font-cxsecret` 自定义字体（字体反爬）：
 *      DOM 里的文字是随机替换后的乱码，只有渲染出来才是真字
 *      → 所以每题截一张图，交给多模态模型看；文本只作为兜底/诊断。
 *   3) 题号不在 data 属性上（`data` 是题型：0 单选 / 2 填空 / 3 判断），
 *      真实 qid 在隐藏域 `answertype<qid>` / `answer<qid>` 的 name 里。
 *   4) 选中态是 `.num_option.check_answer`（addChoice 函数里能看到）；
 *      填空题是 UEditor 富文本（隐藏 textarea + contenteditable iframe）。
 *
 * ⚠ 仍然不点提交：本文件没有任何 submit 相关动作。
 */
export const id = 'chaoxing';
export const name = '超星学习通';
export const order = 2;   // 终端菜单里的序号
export const mode = 'script';
// 不给链接时，让它先把浏览器开到这个页面（总比 about:blank 强）
export const homeUrl = 'https://i.chaoxing.com/base';
// 在**题目所在 frame** 里探测：顶层 document 一般查不到
export const readyProbe = 'document.querySelectorAll(".TiMu, .questionLi, .Zy_TItle, .examPaper_subject").length';
export const platformHint = '登录后进入课程 → 作业/章节测验，停在能看到题目和选项的页面即可（题目在 iframe 里也能读）';
export const pageScript = 'console/helper.js';
export const allowOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/[a-z0-9-]*(chaoxing|xuexitong|chaoxingc)\.(com|cn)$/;
// 页面可能是 studentstudy / 新版作业页 / 考试页 / 老版 doHomeWork —— 统一交给 iframe 探测去认
export const matchUrl = /(chaoxing|xuexitong|chaoxingc)\.(com|cn)\//i;
export const siteUrl = /(chaoxing|xuexitong|chaoxingc)\.(com|cn)/i;
// ★ 超星所有内容都在 iframe 里：只往顶层注入是读不到题的
export const frameAware = true;
export const frameProbe = '.TiMu, .questionLi';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 在顶层文档里递归找「含题目的 frame」，并算出每道题在**视口**里的绝对坐标。
 * 只用于截图；所有 iframe 必须同源（超星满足）。
 */
function scanSource(probe) {
  return `(() => {
  const SEL = ${JSON.stringify(probe)};
  let leaf = null;
  const walk = (doc, depth) => {
    if (leaf || depth > 6) return;
    let qs = [];
    try { qs = doc.querySelectorAll(SEL); } catch (e) {}
    if (qs.length) { leaf = doc; return; }
    let fs = [];
    try { fs = doc.querySelectorAll('iframe'); } catch (e) {}
    for (const f of fs) {
      let cd = null;
      try { cd = f.contentDocument; } catch (e) { continue; }
      if (cd) walk(cd, depth + 1);
      if (leaf) return;
    }
  };
  walk(document, 0);
  if (!leaf) return null;
  const rectOf = (win, node) => {
    let r = node.getBoundingClientRect();
    let w = win;
    while (w && w !== w.top && w.frameElement) {
      const fe = w.frameElement;
      const fr = fe.getBoundingClientRect();
      let bl = 0, bt = 0;
      try {
        const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
        bl = parseFloat(cs.borderLeftWidth) || 0;
        bt = parseFloat(cs.borderTopWidth) || 0;
      } catch (e) {}
      r = { left: r.left + fr.left + bl, top: r.top + fr.top + bt, width: r.width, height: r.height };
      w = fe.ownerDocument.defaultView;
    }
    return r;
  };
  const nodes = [...leaf.querySelectorAll(SEL)];
  return {
    count: nodes.length,
    obfuscated: leaf.querySelectorAll('.font-cxsecret').length > 0,
    rects: nodes.map(n => {
      const r = rectOf(leaf.defaultView, n);
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }),
  };
})()`;
}

/**
 * 读卷之后的增强：
 *   · 题目在 iframe 里 → 记一笔（诊断用）
 *   · 有 font-cxsecret（字体反爬）→ 临时放大视口、把每道题截成 jpeg，
 *     写进 q.shot（data URL），由多模态模型来读题。
 *
 * 注意：截完会恢复视口；但为了让 Chrome 肯出图，会把答题页**切到前台**
 * （隐藏标签页上 captureScreenshot 会卡住）。不会导航、不会点击、不会提交。
 */
export async function enrichPaper(session, paper) {
  if (!paper || !paper.questions || !paper.questions.length) return paper;
  if (!session.targetFrameId) return paper;

  let scan = null;
  try { scan = await session.evalTop(scanSource(frameProbe)); } catch (e) { return paper; }
  if (!scan || !scan.count) return paper;
  paper.iframe = true;
  if (!scan.obfuscated) return paper;          // 没有字体反爬：普通文本直接解，无需截图

  paper.obfuscated = true;
  let shots = 0;
  for (const q of paper.questions) {
    q.opaque = true;
    q.stemRaw = q.stem;
    q.stem = '(题干与选项见截图：超星字体反爬，DOM 文字不可用)';
    for (const o of q.options || []) { o.textRaw = o.text; o.text = ''; }
  }

  // 截图：先把答题页亮出来（隐藏页截不出图），再把视口临时放大到能装下整卷
  await session.bringToFront();
  const viewH = Math.min(12000, Math.max(4200, paper.questions.length * 90 + 3600));
  await session.setViewport({width: 1280, height: viewH, deviceScaleFactor: 1});
  await sleep(500);
  try {
    scan = await session.evalTop(scanSource(frameProbe));
    if (scan && scan.rects) {
      for (let i = 0; i < Math.min(scan.rects.length, paper.questions.length); i++) {
        const r = scan.rects[i];
        if (!r || r.width < 40 || r.height < 20) continue;
        const clip = {x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16, scale: 1};
        try {
          const buf = await session.screenshotClip(clip, {format: 'jpeg', quality: 82});
          paper.questions[i].shot = 'data:image/jpeg;base64,' + buf.toString('base64');
          shots++;
        } catch (e) { /* 单题截图失败不致命：还有文本兜底 */ }
      }
    }
  } finally {
    await session.clearViewport().catch(() => {});
  }
  paper.shots = shots;
  return paper;
}
