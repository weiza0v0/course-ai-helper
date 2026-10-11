<div align="center">

# course-ai-helper

**在线课程 AI 答题助手** · 终端一条命令：读题 → 大模型解题 → 答案填回页面（或打在终端）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![Tests](https://img.shields.io/badge/tests-106%20math%20%2B%2035%20app-success.svg)](#测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**永不自动交卷** —— 代码里没有任何提交动作。

</div>

---

## 它是什么

一个 Node 脚本，通过 CDP 驱动**你已经登录的浏览器**：

- 题目是图片也能做（多模态）
- 涉及计算**必须调工具复核**（自研零依赖数学引擎，106 项与 numpy/scipy/sympy 交叉验证）
- **中国大学MOOC / 超星**：答案自动勾回页面；**智慧树**：只读，答案打在终端

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
| `web_search` / `web_fetch` | Bing → DuckDuckGo 兜底；抓正文去标签 |

## 花费

实测：**MOOC 数学 10 题 ≈ ¥0.07**；**智慧树 27 题（大量联网）≈ ¥0.6**。
贵在"每次请求都要重发固定前缀"（工具 schema + 系统提示）。已做的优化：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `tool_mode` | `auto` | 按题目只发相关工具：文史题每次固定开销 4400 → **1527** tokens |
| `max_web_calls` | 3 | 每题最多联网几次；用完后工具回"请直接作答" |
| `web_result_chars` | 1200 | 网页结果进对话前的字符上限（它会在后续每轮重发）|
| `max_tool_rounds` | 7 | 每多一轮，前面内容全部重发一次 |
| `reasoning_effort` | `max` | 降到 `high` 明显降价 |
| `price_in` / `price_out` | 0 | 填自己的单价（元/百万 token）就会估算金额 |
| `price_cache_in` | 0 | 缓存命中的输入价；留 0 = 按 `price_in` 的 1/10 |

每次运行结束报真实用量，并存日志到 `data/logs/run-*.log`：

```
  ✓ 10/10 已解题 · 耗时 28.0s · 工具调用 21 次
    💰 用量：输入 41.2k（缓存命中 30.1k · 73%）· 输出 8.8k tokens（20 次请求，联网 6 次）· 估算 ¥0.11
```

> 输入分「缓存命中 / 未命中」两部分计费（DeepSeek 自动上下文缓存，命中价约 1/10）。
> 我们请求结构是"稳定前缀在前"，所以同一题的后续轮次、以及各题共用的
> 系统提示 + 工具 schema 都能命中 —— 命中率会直接打在终端上。

## 配置

只列常改的，完整见 [`config.example.toml`](config.example.toml)。

```toml
[model]
api_key = ""                  # 必填
model = "deepseek-flash"      # 必须支持图片输入
reasoning_effort = "max"      # 数学题别关

[app]
fill_interval_ms = 400        # 两次勾选的间隔（勾一次会发一次写请求，太快会被限流）

[cdp]
port = 9222
profile = ""                  # 不要指向浏览器默认数据目录：Chrome 136+ 会忽略调试端口
browser = ""
```

## 测试

```bash
node cli.mjs --selftest      # 35 项：平台注册表 / 桥接层 / 工具裁剪 / 答案单 / 工具实算
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
