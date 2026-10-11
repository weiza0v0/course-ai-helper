# 浏览器 profile（登录态）说明

> **多数情况你不需要看这篇。** 记住一句话就够：
> **第一次跑的时候在弹出的窗口里登录一次，之后就不用再登了。**

---

## 一、为什么不能直接用你日常 Chrome 的登录态

[Chrome 136 起](https://developer.chrome.com/blog/remote-debugging-port)，Google 做了一项安全加固：

> 如果尝试调试**默认的 Chrome 数据目录**，`--remote-debugging-port` /
> `--remote-debugging-pipe` **将不再被遵循**。这两个开关必须与 `--user-data-dir`
> 搭配、指向**非标准目录**。

背景：自从 Chrome 上了「应用绑定加密」，攻击者转而去用远程调试端口偷 cookie，
所以 Google 直接把"调试默认目录"这条路封了。

**后果**：想拿你日常那个已登录的 profile 开调试端口 → Chrome 直接忽略参数 →
工具连不上。这不是本工具的 bug，是平台的安全设计，我们没有（也不打算）绕过它。

所以工具**固定用一个非默认目录**：

| 系统 | 助手专用 profile |
| --- | --- |
| Windows | `%USERPROFILE%\.course-ai-helper-profile` |
| macOS / Linux | `~/.course-ai-helper-profile` |

这个目录是**持久的**：登录一次，之后一直有效。

---

## 二、想换一个目录？

改 `config.toml`（**用单引号**，TOML 字面量字符串，Windows 反斜杠不用转义）：

```toml
[cdp]
profile = 'D:\course-ai-helper-profile'
```

或者命令行临时指定：

```bash
node cli.mjs mooc --profile "D:\course-ai-helper-profile"
```

**规则就一条：不能指向浏览器默认的数据目录。**

```
❌ C:\Users\你\AppData\Local\Google\Chrome\User Data        ← 默认目录，Chrome 会忽略调试端口
✅ D:\course-ai-helper-profile                                   ← 任意非默认目录
```

> 填了默认目录工具也会提示你。想确认当前用哪个：`node cli.mjs --doctor`。

---

## 三、如果你手边只有「配置文件路径」

有时候你会从别处拿到一个 profile 路径（比如 `chrome://version` 里的「配置文件路径」）：

```
C:\Users\你\AppData\Local\Google\Chrome\User Data\Default
```

填进去也没关系 —— 工具会**自动上退一级**到 `…\User Data`，并打印提示。
（`--user-data-dir` 要的是装 profile 的那层目录；指到 `Default` 里面，Chrome 会在它里面
再建一个 `Default` = 全新 profile。）

不过注意：上退之后那就是**默认目录**了，仍然会被 Chrome 136+ 拒绝 —— 所以你**真正需要的
是一个新的空目录**，不是日常那个。

---

## 四、常见疑问

**Q：那我日常 Chrome 的登录就完全用不上了？**
A：用不上。第一次在新窗口登录一次即可，之后都在。想少登几个平台，就在**同一个助手 profile**
里把几个平台都登一遍（profile 是所有平台共用的）。

**Q：登录态会不会丢？**
A：不会。profile 是个普通目录，Chrome 把 cookie 写在里面。除非你手动删掉它。

**Q：能不能用 Chrome 的「多用户/Profile 1」？**
A：不能直接指过去（一样是默认数据目录下的）。要么用助手专用目录，要么 `[cdp] profile`
指一个全新的非默认目录。

**Q：有没有办法用上日常登录态？**
A：Chromium 官方的 **Chrome for Testing** 保留了旧行为，仍可对默认目录开调试端口。
把 `[cdp] browser` 指到它就行 —— 但那是你自己要接受的风险，本工具不默认这么做。

**Q：怎么知道现在用的是哪个 profile？**
A：`node cli.mjs --doctor`，里面会写清楚"将使用"哪一个，以及那个目录是不是已经登录过。
