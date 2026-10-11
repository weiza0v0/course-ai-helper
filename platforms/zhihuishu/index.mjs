/**
 * 平台适配：智慧树（zhihuishu.com）
 *
 * 模式 cdp —— 智慧树把题干预设在**闭合 Shadow DOM** 里，页面内的脚本读不到，
 * 必须让本服务直连浏览器调试端口**只读**读取，然后把答案写成答案单由人工填。
 *
 * 为什么不自动填：智慧树有反作弊检测，脚本点击（isTrusted=false）会被判定
 * 「检测到异常脚本」（已实测）。所以这里刻意没有任何点击/填答代码。
 */
export const id = 'zhihuishu';
export const name = '智慧树';
export const mode = 'cdp';
export const platformHint = '用「启动带调试浏览器.bat」打开的浏览器里登录，进入作业答题界面';
export const helperFile = 'console/helper.js';
export const helperHint = '本模式不粘脚本：助手直连浏览器只读读取（题目在闭合 Shadow DOM 里，页面脚本读不到）';
export const allowOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/[a-z0-9-]*\.?zhihuishu\.com$/;
// 只读模式：不点击 / 不填答 / 不提交
export const readOnly = true;

/**
 * 智慧树 CDP 适配层 —— 让本机助手直连浏览器读卷 / 填答（永不提交）。
 *
 * 为什么要走 CDP 而不是"控制台粘脚本"：
 *   智慧树把题干预设在**闭合 Shadow DOM** 里，页面内的 JS 完全读不到
 *   （textContent / innerHTML / Range / 选区 / attachShadow 钩子 / Vue 数据 全部为空），
 *   只有浏览器层面的 CDP `DOM.getDocument{pierce:true}` 能穿透。
 *
 * 另外页面自己写明："选择题选项顺序为随机排列，若要核对答案，请以选项内容为准"
 *   → 每道题的 A/B/C/D 每次都不同，所以：读卷时按当时顺序给字母，
 *     填答时**按选项文本 + 选项 id 反查**，而不是拿字母直接点第 N 个。
 */
import {queryAll, query, textOf, classOf, attrOf, hasClass} from '../../lib/cdp.mjs';


export const matchUrl = /onlineexamh5new\.zhihuishu\.com\/stuExamWeb\.html#\/webExamList\/dohomework/;

const TYPE_RE = [
  [/多选|不定项/, '多选'],
  [/判断/, '判断'],
  [/单选/, '单选'],
  [/填空/, '填空'],
  [/简答|论述|名词|计算|分析/, '简答'],
];

/** 从 CDP 的 DOM 树里读出整份卷子 */
export async function readPaper(session) {
  const root = await session.getDocument({pierce: true});
  const qNodes = queryAll(root, n => n.nodeType === 1 && hasClass(n, 'examPaper_subject'));
  if (!qNodes.length) return null;

  // 作业标题在 h1.titleLength（勿用整个信息栏，会把「名称/章节/截止时间」一起吞进来）
  const titleEl = query(root, n => n.nodeType === 1 && (hasClass(n, 'titleLength') || (n.nodeName === 'H1' && textOf(n).length > 1 && textOf(n).length < 40)));
  const title = titleEl ? textOf(titleEl) : '';
  const qs = qNodes.map((q, i) => {
    // 题型：.subject_type 里是「【多选题】(2分)」
    const typeRaw = textOf(query(q, n => classOf(n).includes('subject_type')) || {});
    let typeName = '单选';
    for (const [re, name] of TYPE_RE) if (re.test(typeRaw)) { typeName = name; break; }
    // 题干：.subject_describe 的文本在**闭合影子树**里，textOf 会穿透
    const stem = textOf(query(q, n => classOf(n).includes('subject_describe')) || {});
    const labs = queryAll(q, n => hasClass(n, 'nodeLab'));
    const options = labs.map((l, k) => {
      const letterRaw = textOf(query(l, n => hasClass(n, 'mr10')) || {}).replace(/[^A-Za-z]/g, '');
      const input = query(l, n => n.nodeName === 'INPUT') || null;
      // 选项正文在 .node_detail 里（判断题就是「对」「错」）
      const detailNode = query(l, n => classOf(n).includes('node_detail')) || l;
      return {
        letter: letterRaw || String.fromCharCode(65 + k),
        oid: attrOf(input, 'value') || String(k),          // 服务端选项 id —— 填答时按它定位最稳
        text: textOf(detailNode),
        images: queryAll(l, n => n.nodeName === 'IMG').map(n => attrOf(n, 'src')).filter(Boolean).map(u => u.startsWith('//') ? 'https:' + u : u),
      };
    });
    return {
      index: i + 1,
      qid: `q${i + 1}`,
      type: typeName,
      typeName,
      typeRaw,
      stem,
      stemImages: [],
      stemOcr: '',
      options,
    };
  });

  return {
    tid: session.url(),
    aid: 0,
    name: title || '智慧树作业',
    title,
    source: 'cdp',
    collectedAt: new Date().toISOString(),
    questions: qs,
  };
}

export async function diagnose(session) {
  const root = await session.getDocument({pierce: true, depth: 20});
  const counts = {};
  for (const sel of ['examPaper_subject', 'nodeLab', 'subject_describe', 'subject_type', 'examPaper_partTit']) {
    counts[sel] = queryAll(root, n => n.nodeType === 1 && hasClass(n, sel)).length;
  }
  return {
    url: session.url(),
    counts,
    isHomeworkPage: matchUrl.test(session.url()),
    readOnly: true,   // 本适配层只读：不点任何东西、不改页面
  };
}
