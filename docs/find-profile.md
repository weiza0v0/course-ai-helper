# 怎么找到浏览器的 profile（登录态）位置

> **多数情况下你不需要看这篇。** 工具会自己找；找不到时会**问你一次**并把答案记住。
> 这篇是给你"想手动指定"或"自动找偏了"的时候看的。

---

## 一、为什么需要填这个

浏览器把「登录态」存在一个目录里（Chromium 系叫 **user data dir**，里面按 profile 分：
`Default`、`Profile 1`、`Profile 2`…）。工具启动浏览器时会传：

```
--user-data-dir=<你填的目录>
```

传对了 → 打开就是你**已经登录**的账号，不用扫码/输密码。
传错了 / 没传 → 打开的是一个**全新空白 profile**，什么都得重新登。

---

## 二、最靠谱的找法：问浏览器自己

1. 打开 Chrome（或 Edge），地址栏输入：

   ```
   chrome://version          ← Chrome
   edge://version            ← Edge
   ```
   > 注意：`chrome://` 开头的地址**不能点链接跳转**，要手动敲进地址栏。

2. 在页面上找这一行：

   | 界面语言 | 字段名 |
   | --- | --- |
   | 中文 | **配置文件路径** |
   | English | **Profile Path** |

3. 你会看到类似这样的一行：

   ```
   C:\Users\你的用户名\AppData\Local\Google\Chrome\User Data\Default
   ```

4. **把这一整行复制走就行** —— 工具会自动去掉末尾的 `\Default`（因为
   `--user-data-dir` 要的是上一级 `…\User Data`）。
   如果你自己手填配置，就填**去掉 `\Default` 的那一级**。

   ```
   要填的： C:\Users\你\AppData\Local\Google\Chrome\User Data
   不要填： C:\Users\你\AppData\Local\Google\Chrome\User Data\Default
   ```

   > 为什么要去掉？`--user-data-dir` 指的是"装 profile 的那层目录"。
   > 如果指到 `Default` 里面，Chrome 会在它里面**再建一个** `Default`，
   > 等于一个全新的 profile —— 照样要重新登录。

---

## 三、填到哪里

**方式 A：让工具问你**（推荐）

第一次跑的时候如果没找到，它会问：

```
  ⚠ 找到了浏览器，但没找到它的 profile（登录态）目录
    去哪找？浏览器地址栏输入  chrome://version  （Edge 是 edge://version）
    看「配置文件路径 / Profile Path」，把那一行贴进来即可（会自动去掉末尾的 \Default）
  浏览器配置文件路径（直接回车=用助手专用 profile）: 
```

贴上 → 它会把路径写进 `config.toml`，以后不再问。

**方式 B：直接写在 `config.toml` 里**

```toml
[cdp]
# 用单引号！TOML 字面量字符串，Windows 反斜杠不用转义
profile = 'C:\Users\你\AppData\Local\Google\Chrome\User Data'
```

**方式 C：命令行临时指定**

```bash
node cli.mjs mooc "<链接>" --profile "C:\Users\你\AppData\Local\Google\Chrome\User Data"
```

---

## 四、各系统的常见位置（自动找就是查这些）

| 系统 | 位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Windows（Edge） | `%LOCALAPPDATA%\Microsoft\Edge\User Data` |
| macOS | `~/Library/Application Support/Google/Chrome` |
| Linux | `~/.config/google-chrome` |

**便携版 / 绿色版**：一般在 **exe 同级或上级** 的 `User Data`：

```
D:\ChromePortable\
├─ chrome.exe
└─ User Data\          ← 就是这个
   ├─ Default\
   └─ Local State
```

工具已经会自动往这些地方看；实在找不到才需要你手填。

---

## 五、两个前提 / 注意事项

1. **浏览器要完全退出**。运行中的浏览器会锁住 profile，而且它启动时没开调试端口，
   工具也连不上去。→ 任务栏关掉，确认没有残留进程（任务管理器里搜 `chrome`）。

2. **这会使用你真实的浏览器登录态**。工具的做法是把 profile 目录**交给 Chrome 自己**去用，
   **不会去读 profile 里的任何文件、也不解密 cookie**（所以 Chrome 127+ 的
   App-Bound Encryption 对它没有影响）。
   但你要知道：跑这个工具时，它可以访问你已登录的会话 —— 所以你**自己**跑、跑**自己的**账号。

---

## 六、不想用真实 profile？

那就让它新建一个专用的：`config.toml` 里把 `profile` 留空、并保证你的浏览器**正在运行**
（这样工具没法借用），它会退回 `~/.course-ai-helper-profile`（Windows 是
`%USERPROFILE%\.course-ai-helper-profile`）。

在那个窗口里**登录一次**，之后这个 profile 会一直保留，不用重复登录。
