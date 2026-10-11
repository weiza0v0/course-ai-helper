<div align="center">

# course-ai-helper

**在线课程 AI 答题助手** · 终端一条命令：读题 → 大模型解题 → 答案填回页面（或打在终端）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![Tests](https://img.shields.io/badge/tests-106%20math%20%2B%2093%20app-success.svg)](#测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**永不自动交卷** —— 代码里没有任何提交动作。

</div>

---

## 它是什么

一个 Node 脚本，通过 CDP 驱动**你已经登录的浏览器**：

- 题目是图片也能做（多模态）
- 涉及计算**必须调工具复核**（自研零依赖数学引擎，106 项与 numpy/scipy/sympy 交叉验证）
- **中国大学MOOC / 超星**：答案自动勾回页面；**智慧树**：只读，答案打在终端

## 亮点

**1. 永不交卷。** 页面上所有跟 `submit` 有关的代码只做三件事：找到交卷按钮 → **圈红** → 滚到它，
然后提醒你"检查无误后自己点"。**没有一处对它 `.click()`。** 可自查：

```bash
grep -rn "\.click()" platforms/*/console/*.js   # 只命中：选项单选框、以及"确定/关闭"弹窗
grep -rn "submitBtn\.click\|btn\.click()" platforms/ lib/ cli.mjs   # 无输出
```

**2. 零依赖，解压就能跑。** `package.json` 的 `dependencies` 为空，自带便携 `node.exe`：
学生不用装 Node、不用 `npm install`，双击 `启动.bat` 就行。连数学引擎也是自研的，不调任何外部计算服务。

**3. 三个平台，两套完全不同的打法。** MOOC/超星是"把助手脚本注入页面"——
读题、勾选项都由**页面自己的 JS** 完成（勾的是选项，且按平台限流节奏间隔 400ms）。
智慧树则**完全不动页面**：它的反作弊会检查 `isTrusted=false`（我们实测被标记过一次），
所以走 CDP **只读**读卷（能穿透闭合 Shadow DOM 拿到题干），答案只打在终端。

**4. 计算不让模型心算。** `matrix` / `calculus` / `stats` / `calc` 全部本地实算，
**106 项对照 numpy / scipy / sympy** 交叉验证；判据是"凡是要下结论的数值都必须过工具"。

**5. 联网这块是踩过坑才做实的**（三条都是实测结论，不是设计想象）：

- **相关性打分选后端**：实测 Bing 对多词查询会返回"查询第一个字的字典页"
  （`大历十才子 五言长城 刘长卿` → 5 条全是「大」_百度百科）。所以判据不能是"有没有结果"，
  只能是"结果跟查询有没有关系"；跑题就换下一个引擎。
- **反爬用真实浏览器兜底**：百度百科对程序化抓取恒 403，改用它**已经开着的** Chrome
  开一个**后台**标签读正文（实测不改变答题页的 `visibilityState` / 焦点），读完就关。
- **按相关性挑段落，而不是砍开头**：1200 字的窗口要塞进 1 万字的网页。
  让模型传题干关键词、按命中挑句子 —— 实测「考文垂」在头部截断下看不见，按相关性挑就命中。

**6. 成本是量出来再优化的。** 实测**输出 token 占实际花费约 78%**
（输出 ¥8/百万 vs 缓存输入 ¥0.04/百万，而思考 token 全按输出价计费），
所以做了**思考强度按题分档**，同一组题 39.2s → 10.3s、输出 3595 → 768 tokens：

- **先用模型给整卷分一次类**（`thinking: disabled`，一次调用）——
  实测 8 题 8/8 正确、**只花 ¥0.0007、0.6 秒**。纯图片题不发图，一律按数理走。
- 分完类再定强度：**文史题 `low`、数理题 `max`**（不确定的按数理，宁可多花也别算错）。
- 关键词兜底（模型分类不可用时）：**先抹掉"年份/年代/世纪"再判** ——
  老版本拿裸 `\d` 当数理信号，实测带年份的文史题 **4 道全判错**，而近代史/毛概满篇是年份。
- **回传 `reasoning_content`**：官方要求带 `tools` 的请求必须回传历史思考内容，不回传模型就看不到
  自己上一轮怎么想的、只能重新推一遍。实测（热身 + 交替顺序各 2 次）**每轮输出 token -17%、
  整题成本 -27%**；而它进上下文后走缓存命中价（¥0.04/百万，是输出价的 1/200），几乎白送。
  （只在模型确实返回过时才带 —— 本项目支持任何 OpenAI 兼容接口，不能凭空塞人家不认识的字段。）

请求结构也刻意做成"稳定前缀在前"，让 DeepSeek 的自动缓存命中（实测 80%~94%）。跑完直接报钱。

**7. 一条命令自检，离线可复现。** `node cli.mjs --selftest` 有 93 项，不连浏览器、不调模型，
还包含几条**源码级安全红线**（"绝不退回前台标签""绝不生成 auto_submit"这类）。

## 固定流程（五步）

```
1. 它起浏览器    双击 启动.bat → 选 1/2/3 → 链接直接回车
2. 你登录        第一次在弹出的窗口里登录（之后一直记住）
3. 你找页面      点进作业/测验，看到题目和选项
4. 你按回车      它报「已就绪：N 道题」，你核对后回车
5. 它做题        MOOC/超星 → 填回页面 ｜ 智慧树 → 打在终端
```

等待阶段不设超时；按 Enter 立即重测一次；`Ctrl+C` 干净退出。

## 安装

**Windows（连 Node 都不用先装）**

1. 双击 `下载便携node.bat` —— 用系统自带 PowerShell 下 `node.exe`，本身不需要 Node
2. 复制 `config.example.toml` 为 `config.toml`，填上 `api_key`
3. 双击 `启动.bat`

**其它平台**

```bash
git clone https://github.com/weiza0v0/course-ai-helper && cd course-ai-helper
cp config.example.toml config.toml      # 填 api_key
node cli.mjs mooc                       # 链接可省略：浏览器里点进去即可
```

```bash
node cli.mjs <平台> [链接]     # 平台可写 1/2/3、id 或中文名
node cli.mjs --list            # 列出浏览器里打开的标签
node cli.mjs --doctor          # 诊断：端口/exe/profile/成本参数（不启动任何东西）
node cli.mjs --login           # 只开登录窗口
node cli.mjs --selftest        # 离线自检（35 项）
```

| 参数 | 说明 |
| --- | --- |
| `--rounds 8` | 每题最多几轮工具（默认 7，上限 20）|
| `--sheet` / `--no-fill` | 只解题，完全不碰页面 |
| `--port 9222` · `--profile <目录>` · `--browser <exe>` | 浏览器相关 |

## 平台支持

| 平台 | 模式 | 状态 |
| --- | --- | --- |
| 中国大学MOOC | 页面脚本 → 自动填答 | ✅ 已实测 |
| 超星学习通 | 页面脚本 → 自动填答 | ✅ 就绪；答题态 DOM 待社区用真实作业校准 |
| 智慧树 | **CDP 只读 → 终端打印** | ✅ 读卷 + 解题；🚫 不做自动填答 |

**智慧树为什么只读**：题干预设在闭合 Shadow DOM 里（页内 JS 读不到，只能靠 CDP 穿透）；
而自动点击的 `isTrusted=false` 会被平台判为"异常脚本"（实测弹窗）。
于是只读卷 → 打印答案 → 你自己填。详见 [docs/zhihuishu-adapter.md](docs/zhihuishu-adapter.md)。

## 六个工具

零依赖本地实现，不调任何外部计算服务。

| 工具 | 能力 |
| --- | --- |
| `matrix` | 行列式 · 逆 · 秩 · RREF · 解 Ax=b · 特征值（含复根）· LU/QR · 零空间 · 范数 |
| `calculus` | 符号求导 · 符号/数值积分 · 极限（含发散）· 求根 · Taylor · 级数 |
| `stats` | 描述统计 · 7 种分布 pdf/cdf/分位数 · t/z/卡方/方差分析 · 回归 · 相关 |
| `calc` | 通用表达式（自研解析器 + AST + 白名单，无 `eval`）|
| `web_search` | Bing → 搜狗 → 360 → DuckDuckGo，**按与查询的相关性打分选最优**（搜索引擎对多词查询会返回跑题结果，必须挡）；**一次可带最多 4 条查询并发跑、轮询合并、按 URL 去重**（照抄 DeepSeek Harness 的设计） |
| `web_fetch` | 去标签 + 跳过导航；**给了 focus（题干关键词）时按相关性挑段落**，而不是傻砍开头；被反爬挡住时**用同一个浏览器开后台标签兜底**（百度百科/知到答案页都能读） |

> 关于浏览器兜底的安全性：它**只新建/关闭自己的临时标签**，绝不导航或关闭你的答题页；
> 且只用**后台**标签（实测不会改变答题页的 `visibilityState` / 焦点 —— 那正是防作弊系统判定"切屏"的信号）。
> 浏览器若不支持后台开标签，就**整个放弃**这条路，绝不退回前台标签。
> 想完全关掉：`config.toml` 里 `web_browser_fallback = false`。

## 花费

`deepseek-flash` 高峰价（元/百万 token）：未命中 **2** / 命中 **0.04** / 输出 **8**。
按真实用量实测：

| 场景 | 每题 | 整卷 |
| --- | --- | --- |
| 文史概念题（不用工具） | ≈¥0.002～0.003 | 3 题 ≈¥0.006～0.009 |
| 文史题 + 联网查证 | ≈¥0.003～0.010 | 3 题 ≈¥0.01～0.03 |
| 理工计算题（matrix / calc） | ≈¥0.005～0.010 | 10 题 ≈¥0.05～0.10 |
| 智慧树 27 题（文史 + 联网） | —— | ≈¥0.10～0.20 |

> 区间这么宽是因为**输出 token 波动很大**（同一组题实测 3.6k～7.8k），
> 而输出正是成本大头。下面几项优化都指向它。

> 空闲时段（工作日 9-12、14-18 点之外，含周末全天）单价减半 —— **晚上做题基本按半价**。

**关键：钱花在哪。** 输入有缓存几乎免费（命中 5%），**输出占 ~78%** ——
因为输出 ¥8/百万 是缓存输入 ¥0.04/百万 的 200 倍，而思考 token 全按输出价计费。
所以最有效的省钱开关是思考强度，不是工具集：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `reasoning_effort` | `max` | **数理题**的思考强度 |
| `reasoning_effort_auto` | `true` | **文史题自动降档**（最大的省钱开关，见上）|
| `classify_with_model` | `true` | 整卷先用模型分一次类（¥0.0007/卷），失败退回关键词 |
| `reasoning_effort_humanities` | `low` | 文史题档位；`off` = **真正关闭思考**（显式发 `thinking.disabled`）|
| `max_web_calls` | 3 | 每题最多搜几次（一次最多带 4 条查询，查询不额外计费）|
| `max_web_fetches` | 2 | 每题最多打开几个网页（和搜索分开算：搜索是"找"，抓取是"读已决定要读的那篇"）|
| `web_result_chars` | 1200 | 网页结果进对话前的字符上限（它会在后续每轮重发）|
| `max_tool_rounds` | 7 | 每多一轮，前面内容全部重发一次 |
| `max_tool_result_chars` | 2000 | 普通工具结果上限 |
| `tool_mode` | `all` | 默认全发 6 个工具。设 `auto` 按卷裁工具（省得有限：多出的 schema 落在共享前缀里、走缓存命中价）|
| `price_in` / `price_out` / `price_cache_in` | 2 / 8 / 0.04 | 已按高峰价填好，跑完会估算金额 |

每次运行结束报真实用量并写日志到 `data/logs/run-*.log`：

```
  ✓ 3/3 已解题 · 耗时 10.3s · 工具调用 2 次
    💰 用量：输入 17.1k（缓存命中 12.7k · 74%）· 输出 768 tokens（5 次请求，搜索 2 条查询 / 抓网页 0 次）· 本卷约 ¥0.016
```

## 配置

只列常改的，完整见 [`config.example.toml`](config.example.toml)。

```toml
[model]
api_key = ""                  # 必填
model = "deepseek-flash"      # 必须支持图片输入
reasoning_effort = "max"      # 数理题别关；文史题由模型分类后自动降档（见 花费）

[app]
fill_interval_ms = 400        # 两次勾选的间隔（勾一次会发一次写请求，太快会被限流）

[cdp]
port = 9222
profile = ""                  # 不要指向浏览器默认数据目录：Chrome 136+ 会忽略调试端口
browser = ""
```

## 测试

```bash
node cli.mjs --selftest      # 93 项：平台注册表 / 桥接层 / 工具裁剪 / 答案单 / 联网判定 / 安全红线
node test/math-test.mjs      # 106 项，对照 numpy / scipy / sympy
node test/real-test.mjs --paper examples/questions.json --expect examples/expected.json
```

## 安全与边界

- **永不自动交卷**：没有提交动作
- **无 `eval` / `new Function`**：表达式走自研解析器 + 标识符白名单
- 只通过本机 CDP 端口驱动浏览器，不监听任何端口、不对外联网暴露
- 只填 / 只读，不修改页面结构；智慧树模式连点击都没有
- 有监考、人脸识别、摄像头抓拍的考试请勿使用

## 更多文档

| 文件 | 内容 |
| --- | --- |
| [docs/zhihuishu-adapter.md](docs/zhihuishu-adapter.md) | 智慧树：iframe / 闭合 Shadow DOM、反作弊实测、只读取舍 |
| [docs/chaoxing-adapter.md](docs/chaoxing-adapter.md) | 超星：iframe 套娃链、待校准的部分 |
| [docs/find-profile.md](docs/find-profile.md) | profile / 登录态怎么指定、为什么不能借用日常 Chrome |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 想加平台 / 补数学引擎 |

## License

[MIT](LICENSE)
