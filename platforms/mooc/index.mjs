/**
 * 平台适配：中国大学MOOC（icourse163.org）
 *
 * 模式 script —— 在题目页面粘一次控制台脚本，脚本读题并把答案勾回去。
 */
export const id = 'mooc';
export const name = '中国大学MOOC';
export const order = 1;   // 终端菜单里的序号
export const mode = 'script';                 // script = 控制台脚本填答；cdp = 只读出答案单
// 不给链接时，让它先把浏览器开到这个页面（总比 about:blank 强）
export const homeUrl = 'https://www.icourse163.org/';
export const platformHint = '打开 MOOC 测验页，先点「开始测验」进入答题界面';
export const pageScript = 'console/helper.js';  // 页面脚本：由终端用 CDP 注入，不需要手动粘贴
// 允许跨域调本服务的来源（控制台脚本要跨域）
export const allowOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/(www\.)?icourse163\.(org|com)$/;
// 该平台的题目页特征（用于状态提示，可留空）
// ★ 只认"答题页"（课程页/首页不算）—— 否则会把 /course/xxx 当成答题页
export const matchUrl = /icourse163\.(org|com)\/.*(\/learn\/|quiz|exam|homework|test)/i;
// 宽口径：只要是中国大学MOOC 的页面（给 --list 上色用）
export const siteUrl = /icourse163\.(org|com)/i;
