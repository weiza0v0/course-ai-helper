/**
 * 平台适配：超星学习通 / 泛雅（chaoxing.com）
 *
 * 模式 script —— 在题目页面粘一次控制台脚本。
 * 注意：超星大量用 iframe，脚本要贴在装题目那个 frame 的 console 里。
 */
export const id = 'chaoxing';
export const name = '超星学习通';
export const order = 2;   // 终端菜单里的序号
export const mode = 'script';
// 不给链接时，让它先把浏览器开到这个页面（总比 about:blank 强）
export const homeUrl = 'https://i.chaoxing.com/base';
export const platformHint = '登录后进入课程 → 作业/考试 → 开始答题（要能看到题目和选项）';
export const pageScript = 'console/helper.js';
export const allowOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/[a-z0-9-]*(chaoxing|xuexitong|chaoxingc)\.(com|cn)$/;
export const matchUrl = /(chaoxing|xuexitong|chaoxingc)\.(com|cn)/;
