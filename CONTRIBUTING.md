# 贡献指南

谢谢你来！这个项目最需要的是**平台适配**和**数学能力补强**。

## 最想要的三件事

### 🥇 1. 超星学习通答题态 DOM 校准（最高优先级）

服务端、模型、数学工具全都就绪了，只差"正在作答的页面"长什么样。

**你只需要**：在有未作答作业的账号上跑一次诊断，把输出贴到 issue。

1. 打开没做过的作业/章节测验，进入能看到题目的界面
2. `F12` → 控制台左上角把上下文切到题目所在的 **iframe**（超星是 iframe 套娃，见 [docs/chaoxing-adapter.md](docs/chaoxing-adapter.md)）
3. 输入 `allow pasting` 回车，粘贴 `platforms/chaoxing/console/helper.js` 全文，回车
4. 如果它说"没读到题目"，它已经自动打印了诊断；也可以手动跑 `__CX_HELPER__.diagnose()`
5. 把诊断 JSON 贴到 issue

拿到真实结构后，需要改的就只有 `console/helper.js` 里这几个函数：
`Q_SELECTORS` / `optionNodes()` / `isSelected()` / `setOption()` / `fillText()`。

### 🥈 2. 新平台适配

智慧树、雨课堂、学堂在线、钉钉课堂…… 适配一个平台基本只需要：

- `console/helper.js`：`collect()`（读题）+ `fill()`（写答案）
- `config.example.toml`：端口错开
- `server.mjs`：CORS 白名单加域名
- 一个 `test/fill-test.html` 仿真页

共享核心（`lib/`、`public/`、`server.mjs`）**不要改动平台特有逻辑**，改完跑 `node scripts/sync-core.mjs`。

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
cd platforms/mooc
node test/selftest.mjs        # 应用层，56 项，离线可跑
python3 test/math-ref.py > test/math-ref.json && node test/math-test.mjs   # 数学层，106 项
node test/real-test.mjs --paper examples/questions.json --expect examples/expected.json   # 真实模型（要 key）

# 2. 改了共享核心就同步
node scripts/sync-core.mjs
node scripts/sync-core.mjs --check    # CI 用
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
