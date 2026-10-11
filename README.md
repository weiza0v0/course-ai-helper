<div align="center">

# course-ai-helper

**在线课程 AI 答题助手** · 一个本地服务搞定多个平台，网页上选平台、粘一次脚本，剩下的交给多模态大模型

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#零依赖)
[![Tests](https://img.shields.io/badge/tests-106%20math%20%2B%2067%20app-success.svg)](#可信度拿-scipy--sympy-对过账)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Platform](https://img.shields.io/badge/平台-中国大学MOOC%20%7C%20超星%20%7C%20智慧树-blue.svg)](#平台支持)

采集题目 → 上传本机助手 → 多模态大模型（带**自研数学引擎**）解题 → **答案自动填回页面**

**本工具只填不交卷** —— 代码里根本没有提交动作，最后一步永远由你点。

<img src="docs/answer-table.png" width="820" alt="答案表：字母 + 选项含义">

</div>

---

## 它解决什么问题

MOOC / 超星的题目**越来越多是图片**（公式、矩阵、几何图），纯文本模型看不了；
而通用 ChatGPT 网页版又没法把答案填回你的答题页。

这个项目的做法：

1. **控制台脚本**在你已登录的页面里跑 —— 读题目、把答案勾回去，全程不用你复制粘贴题目；
2. **本机助手**（127.0.0.1）负责调模型、跑工具、管状态，你的 API Key 不出本机；
3. **模型能自己算** —— 内置 6 个工具（矩阵 / 微积分 / 概率统计 / 表达式 / 联网搜索 / 抓网页），
   涉及计算必须调工具复核，不靠心算。

---

## 亮点

- 🧮 **自研零依赖数学引擎**：矩阵与线性代数、微积分、概率统计三大块，**106 项与 numpy / scipy / sympy 交叉验证全绿**
- 🖼️ **原生多模态**：题目是图片也能做（图片自动下载转 base64 喂给模型）
- 🔒 **没有 `eval` / `new Function`**：表达式走自研解析器 + AST 求值 + 标识符白名单
- 🚫 **永不自动交卷**：只填答案，提交按钮由你自己点
- ⚙️ **纯 TOML 配置**：改完网页点「重载配置」，不用重启
- 🔁 **稳**：模型限流自动退避重试；MOOC 平台"并发限制"自动限速+退避+复核补勾
- 📦 **零依赖分发**：`runtime/node.exe` 便携运行时，对方解压双击 `启动.bat` 就能用，什么都不用装

---

## 快速开始

```bash
git clone https://github.com/weiza0v0/course-ai-helper
cd course-ai-helper
cp config.example.toml config.toml      # 填上你的 api_key
node server.mjs                          # 打开 http://127.0.0.1:8787/ ，在网页上选平台
```

**Windows 免安装**：先 `node scripts/fetch-node.mjs` 拉一个便携 node，然后双击 `启动.bat`。

然后按网页上的四步走：

| 步骤 | 做什么 |
| --- | --- |
| ⓪ | 网页上选平台（MOOC / 超星 / 智慧树） |
| ① | 网页上点「复制一键脚本」（智慧树模式没有脚本，直接点「读取当前页面并解题」） |
| ② | 到课程答题页 `F12` 控制台（提示不允许粘贴就先输 `allow pasting`）→ 粘贴 → 回车 |
| ③ | 回网页看实时进度：每题调了什么工具、思考了什么、答案是什么 |
| ④ | 答案自动勾进页面，**你核对后自己点提交** |

> 为什么必须手动粘一次？因为脚本要在**你已登录的页面**里跑。粘完它一直活着，所以答案能直接推回页面。

---

## 六个工具

计算**全部本地完成、零依赖**（`lib/math/*` 是自己写的），不调任何外部计算服务。

### `matrix` — 线性代数

行列式 · 逆 · 秩 · 迹 · 转置 · **RREF（含主元列）** · 加减乘幂 · **解 Ax=b（带残差验证）** ·
**特征值（任意实方阵，支持复根）** · LU / QR 分解 · 零空间基 · 四种范数

### `calculus` — 微积分

**符号求导**（任意阶，多项式/三角/指数/对数/商/链式/幂指函数）· **积分**（给区间→自适应 Simpson 数值定积分；不给→符号原函数）·
**极限**（双侧/单侧，能识别发散到 ±∞）· **求根**（`x^2-5x+6=0` 直接写，返回区间内全部实根 + 代入残差）·
Taylor 展开 · 级数求和 · 化简

### `stats` — 概率统计

描述统计（含偏度峰度）· **六种分布的 pdf/cdf/反函数**（normal / t / χ² / F / binom / poisson / exp）·
单样本/双样本(Welch+合并方差)/配对 t 检验 · z 检验 · 卡方拟合优度与独立性（可选 Yates 校正）·
单因素方差分析 · 一元线性回归 · Pearson/Spearman · 组合排列 · 贝叶斯

### `calc` — 通用表达式

`+ - * / % ^`、`pi`/`e`、隐式乘法（`2x`、`3(x+1)`）、向量 `[1,2,3]`、矩阵 `[[1,2],[3,4]]`，
以及上面所有函数的一站式入口。

### `web_search` / `web_fetch`

Bing 优先、DuckDuckGo 兜底；抓网页正文去标签。用来查证定义、定理、公式、题目出处。

---

## 可信度：拿 scipy / sympy 对过账

自研数学最大的风险是"算得看起来像对"，所以整套数学层都跟 **numpy / scipy / sympy** 逐项比对：

```
$ python3 test/math-ref.py > test/math-ref.json   # 生成参考值
$ node test/math-test.mjs
数学层交叉验证（对照 numpy / scipy / sympy）
  通过 106 项，失败 0 项
  ✅ 全部与 numpy/scipy/sympy 一致
```

覆盖：4 阶行列式、范德蒙德行列式、逆矩阵、秩、四种范数、解方程、**复特征值 ±i**、LU/QR 分解校验、零空间维数；
八类求导、七类定积分（含 ∫₀¹e^(-x²)、∫₋₁¹|x|）、三类极限（含发散）、求根、Taylor、级数；
t/z/卡方/方差分析/回归/相关；六种分布的 pdf/cdf/分位数；Γ/B/erf/erfc、组合排列。

应用层：`node test/selftest.mjs` —— **67 项全绿**（配置、鉴权、六个工具、答案解析回归、答案单渲染、**平台注册与切换**、各平台能力契约、上传→解题→轮询全链路）。

真实模型端到端（10 道真题，答案由 100 分交卷确认）：

```
1.单选→D ✅  2.单选→A ✅  3.单选→D ✅  4.单选→A ✅  5.单选→D ✅
6.判断→A ✅  7.判断→A ✅  8.判断→B ✅  9.判断→B ✅  10.判断→A ✅
耗时 28.0s · 工具调用 26 次 · 思考片段 25 段 · 正确 10 / 错误 0
```

> **全程只认选项字母**（单选/多选/判断都是）。判断题尤其要注意：同一份卷子里 Q6 的 A 可能是「正确」，
> Q7 的 A 却是「错误」——**选项顺序逐题都不同**，所以模型被要求"先看清本题 A/B 各写了什么，再回答字母"。

---

## 平台支持

一个服务同时支持多个平台，**在网页上选**（切换会记在 `data/platform.txt`，不用改 `config.toml`）。

| 平台 | 模式 | 状态 |
| --- | --- | --- |
| **中国大学 MOOC**（icourse163.org） | 控制台脚本 | ✅ 完整可用，已实测真实测验页 10/10 自动勾选、**未提交** |
| **超星学习通**（chaoxing.com） | 控制台脚本 | ✅ 服务端/脚本就绪；答题态 DOM 待社区用真实未作答作业校准（见 [docs/chaoxing-adapter.md](docs/chaoxing-adapter.md)） |
| **智慧树**（zhihuishu.com） | **CDP 只读** | ✅ 读卷 + 解题 + 出答案单；🚫 **刻意不做自动填答**（见下） |

### 为什么智慧树只能"只读"

智慧树把题干预设在**闭合 Shadow DOM** 里 —— 页面内的 JS 一律读不到
（`textContent`/`innerHTML`/`Range`/选区/`attachShadow` 钩子/Vue 数据 逐个实测，全是空的），
只有浏览器层 CDP 的 `DOM.getDocument{pierce:true}` 能穿透。

而一旦在页面上点选项，**脚本点击的 `event.isTrusted === false` 会立刻暴露**。
实测中该账号确实弹出了平台的告警：

> 检测到异常脚本，为保证您正常答题，请您关闭插件，刷新页面后重新答题！

所以这个平台的适配**主动砍掉了自动填答**，只做：
**只读读卷 → 模型解题 → 写成「答案单」Markdown → 你自己动手填。**
零风险，还省掉了思考的时间。细节和踩过的坑都在 [docs/zhihuishu-adapter.md](docs/zhihuishu-adapter.md)。

## 仓库结构

```
course-ai-helper/
├─ server.mjs              # 唯一的本地服务（多平台，网页上切换）
├─ lib/                    # 共享核心（只有一份）
│  ├─ agent.mjs            #   模型调用 + 工具循环 + 答案解析
│  ├─ tools.mjs            #   六个工具
│  ├─ math/                #   自研数学引擎（零依赖）
│  ├─ cdp.mjs              #   零依赖 CDP 客户端（Node 22+ 自带 WebSocket）
│  ├─ report.mjs           #   答案单渲染（Markdown）
│  ├─ platforms.mjs        #   平台注册表
│  ├─ config.mjs / toml.mjs
├─ platforms/              # 每个平台只有「标识 + 脚本 + 适配」，不再各带一份核心
│  ├─ mooc/index.mjs       + console/{helper,collect,fill}.js
│  ├─ chaoxing/index.mjs   + console/helper.js
│  └─ zhihuishu/index.mjs  （CDP 只读，零点击代码）
├─ public/                 # 一个前端（含平台选择器）
├─ test/                   # selftest（67 项）+ 数学校验（106 项）
├─ scripts/                # fetch-node.mjs（拉便携 node）/ package.mjs（打包）
├─ docs/                   # 截图 + 各平台适配笔记
├─ 启动.bat                 # Windows 双击即用
└─ 启动带调试浏览器.bat       # 智慧树这类平台用（带 --remote-debugging-port 的 Chrome）
```

**为什么不再按平台分发**：核心本来就只有一份，按平台各拷一份只会带来"改了一处忘了另一处"的漂移风险
（这个坑真踩过：同步方向搞反，把新写的功能覆盖回旧版）。现在平台专属的只剩 `index.mjs` 和一个控制台脚本。

## 配置

`platforms/<平台>/config.toml`（从 `config.example.toml` 拷）：

```toml
[model]
base_url = "https://api.deepseek.com/v1"   # 任何 OpenAI 兼容接口
api_key  = ""                              # 必填；只在本机，不会下发到浏览器
model    = "deepseek-flash"                # 必须支持图片输入
reasoning_effort = "max"                   # 思考强度：off/low/high/max —— 数学题别关
concurrency = 3
max_tool_rounds = 4                        # 工具轮数用完会强制模型收尾作答
max_retries = 3                            # 撞 429/5xx 指数退避重试

[app]
auto_solve = true          # 收到题目就自动开解
auto_fill  = true          # 出答案自动推回页面并勾选
fill_interval_ms = 400     # 两次勾选的间隔（MOOC 每勾一次就发一次保存请求，太快会被平台限流）
```

---

## 安全与边界

- **永不自动交卷**：代码里没有提交动作。
- **无 `eval` / `new Function`**：早期版本用 `new Function` + 字符白名单，被 `process.exit(1)` 逃逸过一次
  （真把测试进程退掉了），现在改成自研解析器 + AST + 标识符白名单。
- **API Key 不出本机**：只存在 `config.toml`，网页只知道"已配置"和一个掩码。
- 控制台脚本上传/取答案需要 token（每次启动随机生成，只注入到服务端渲染的脚本里）；CORS 只放行本机与课程站点。
- 服务只监听 `127.0.0.1`，别暴露到公网。
- 本项目是**答题辅助**。多数课程把"独立完成"写进了学术诚信条款；**怎么用、用不用，责任在你**。
- 有监考、人脸识别、摄像头抓拍的考试请勿使用。

---

## 参与贡献

特别欢迎这几类 PR（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）：

- 🥇 **超星答题态 DOM 校准**（跑一次 `diagnose()` 贴 issue 就算贡献）
- 🥈 新平台适配：智慧树 / 雨课堂 / 学堂在线 / 钉钉课堂 …
- 🥉 数学引擎补强：符号积分再强一点、线性规划、常微分方程、复数运算
- 文档、截图、Windows 打包脚本、模型兼容性测试（Qwen-VL / GLM-4V / GPT-4o / Gemini）

## License

[MIT](LICENSE)
