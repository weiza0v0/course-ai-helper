# 贡献指南

谢谢你来！这个项目最需要的是**平台适配**和**数学能力补强**。

## 最想要的三件事

### 🥇 1. 超星学习通答题态 DOM 校准（最高优先级）

超星的页面脚本（`platforms/chaoxing/console/helper.js`）已经写好，但作者手上的账号所有作业都已提交，
**没人验证过"正在作答"页面的真实 DOM**。你只需要：

1. 在自己的账号上打开一份**没做过**的作业，进入能看到题目的界面；
2. 跑 `node cli.mjs chaoxing "<那个页面的链接>"`；
3. 如果它说读不到题目，把打印出来的 DOM 诊断贴到 issue。

### 🥈 2. 新平台适配

智慧树、雨课堂、学堂在线、钉钉课堂…… 适配一个平台基本只需要：

- `platforms/<id>/index.mjs`：`id / name / mode / matchUrl / platformHint`
  - `mode: 'script'` → 再给一个 `pageScript`（页面脚本路径），并实现 `collect()` / `fill()`
  - `mode: 'cdp'` → 导出 `readPaper(session)`（只读，用 CDP 的 `DOM.getDocument{pierce:true}`）+ `diagnose(session)`
- 页面脚本里读题/填答的逻辑自己写（`platforms/*/console/helper.js` 可以当模板）
- 不用改 `cli.mjs` —— 平台注册表会自动发现它

平台专属的只有 `platforms/<id>/index.mjs`（标识/模式/跨域白名单）和一个控制台脚本 `console/helper.js`；
其余（`lib/`、`public/`、`server.mjs`）是**所有平台共用的一份**，改动要保证其它平台不受影响。

### 🥉 3. 数学引擎补强

`lib/math/` 是零依赖自研的，欢迎补：

- 符号积分再强一点（分部积分、有理函数、三角替换）
- 复数运算、常微分方程、线性规划、单纯形法
- 数值方法：牛顿法解方程组、数值 Jacobian、插值拟合

**重要**：任何数学改动都必须在 `test/math-test.mjs` 里加对应断言，并保证
`node test/math-test.mjs` 全绿（参考值由 numpy/scipy/sympy 生成）。

---

## 开发流程

```bash
# 1. 跑测试
cd course-ai-helper
node cli.mjs --selftest       # 应用层，23 项，离线（平台注册/桥接层/答案单/工具实算）
python3 test/math-ref.py > test/math-ref.json && node test/math-test.mjs   # 数学层，106 项
node test/real-test.mjs --paper examples/questions.json --expect examples/expected.json   # 真实模型（要 key）
```

## 硬性要求

1. **`config.toml` 不要提交**（里面有 API Key）——`.gitignore` 已经挡了，提交前 `git status` 看一眼。
2. **不要加提交动作**。这个项目永远只填答案、不交卷；也请不要加自动提交的 PR。
3. **保持零依赖**。核心（`lib/`、`server.mjs`、`public/`）不允许引入 npm 包——这是"解压即用"的前提。
   平台适配脚本也不要用外部库。
4. **别用 `eval` / `new Function`** 处理模型返回的内容（数学表达式一律走 `lib/math/parser.mjs`）。
5. 提交信息用中文或英文都行，说清楚**改了什么、为什么**。

## 提交 PR

- 一个 PR 只做一件事；大改动先开 issue 讨论
- 附上你**实际验证过的截图或日志**（尤其是平台适配，需要真实页面的证据）
- 新平台的 PR 请附一个真实跑通的截图（答案已填入、未提交）

## 行为准则

- 这是学习辅助工具。**不要**用它去搞有监考/人脸识别的考试，也不要帮别人代考。
- issue 里不要贴自己的账号密码、cookie、API Key。
