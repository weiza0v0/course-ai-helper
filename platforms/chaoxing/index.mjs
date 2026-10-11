/**
 * 平台适配：超星学习通 / 泛雅（chaoxing.com）
 *
 * 模式 script —— 在题目页面粘一次控制台脚本。
 * 注意：超星大量用 iframe，脚本要贴在装题目那个 frame 的 console 里。
 */
export const id = 'chaoxing';
export const name = '超星学习通';
export const mode = 'script';
export const platformHint = '打开超星作业/考试页，进入能看到题目和选项的答题界面（题目多在 iframe 里）';
export const pageScript = 'console/helper.js';
export const allowOriginRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/[a-z0-9-]*(chaoxing|xuexitong|chaoxingc)\.(com|cn)$/;
export const matchUrl = /(chaoxing|xuexitong|chaoxingc)\.(com|cn)/;
