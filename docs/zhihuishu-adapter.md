# 智慧树适配笔记

> 状态：**只读模式可用**（读卷 + 解题 + 生成答案单），**刻意不做自动填答**。
> 原因见下面第 3 节 —— 实测触发了平台的反作弊检测。

---

## 1. 入口与页面结构（实测）

### 1.1 从任务列表到答题页

```
AI 教学中心  hike-teaching-center.polymas.com/stu-hike/studyTask
  └─ 点作业卡片 → window.open(...)                      ← 弹窗会被浏览器拦
       https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=<加密串>
          └─ 点「开始答题」（<span class="themeBg">）
               https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/<a>/<b>/<c>/<courseId>/<n>/<k>
```

要点：
- `#/...` 是 **hash 前端路由**，HTTP 抓这个 URL 只能拿到空壳 HTML，卷子数据不在里面；
- 卷子数据来自 `studentexam-api.zhihuishu.com/studentExam/gateway/t/v1/...`，请求体是 **`secretStr=<加密串>`**（客户端加密）+ 登录 cookie，所以"服务端直接抓取解析"这条路等于要复刻它的加密，维护成本高、平台一改就碎。

### 1.2 答题页 DOM（6 题实测）

```html
<div class="examPaper_subject mt20">                        ← 一道题
  <div class="subject_stem clearfix">
    <div class="subject_num fl"><span>1</span></div>
    <span class="subject_type"><span>【多选题】</span><span>(2分)</span></span>
    <div class="subject_describe dynamic-fonts">           ← 题干在这里，但见第 2 节
      <div data-v-3d518ffb=""><div data-v-3d518ffb=""></div></div>
    </div>
  </div>
  <div class="subject_node">
    <div class="nodeLab">                                   ← 一个选项
      <div class="label clearfix">
        <div class="fl">
          <input type="checkbox" class="mr30" value="519946071" style="display:none">   ← 选项 id
          <img class="flagChecked" src="...39942f89....png">
          <span class="mr10">A.</span>
        </div>
        <div class="node_detail examquestions-answer fl"><p>战役还原环节</p></div>
      </div>
    </div>
    ... B / C / D
  </div>
</div>
```

- 题目容器 `.examPaper_subject`；题型在 `.subject_type`；选项 `.nodeLab`，字母在 `.label .fl > span.mr10`，正文在 `.node_detail`；
- **选中态以隐藏 `input[type=checkbox|radio]` 的 `checked` 为准**（`value` 是服务端选项 id）；
- 分组标题 `.examPaper_partTit`；
- 页面原文提示两条关键规则：
  - 「**选择题选项顺序为随机排列**，若要核对答案，请以选项内容为准」→ 同一个账号两次加载，A/B/C/D 对应的内容真的不一样（实测过）
  - 「答题后请点【**下一题**】保存答案」

---

## 2. 题干预设在**闭合 Shadow DOM** 里

`class="subject_describe dynamic-fonts"` 这个元素在普通 DOM 里看是**空的**（只有一个空格文本节点），
但屏幕上明明有题干。

用浏览器层面的 CDP `DOM.getDocument {pierce:true}` 一看，文字在 `#shadowRoot` 里：

```
/HTML/BODY/DIV/.../DIV/DIV/DIV/#shadow/#text = "沙盘推演实践教学有哪几个环节组成？（ ）。"
```

**页内 JS 的所有常规通道都读不到**（逐一实测过，全部为空）：

| 试过的手段 | 结果 |
| --- | --- |
| `textContent` / `innerHTML` | 空 |
| `Range.toString()` / `getSelection()` | 空 |
| `document.execCommand('selectAll')` + 选区 | 空（强制 `user-select:text` 也没用） |
| 真人鼠标拖选 | 选不中 |
| `window.find('沙盘推演')` | 返回 `true`，**但是误报**：选区为空、`range.toString()` 为空 |
| hook `Element.prototype.attachShadow` + SPA 路由重新挂载 | 捕获 0 个（说明不是 `attachShadow` 建的，是**声明式 shadow DOM**） |
| MutationObserver 盯着重新渲染 | 没看到 `<template shadowrootmode>` |
| Vue 实例 `__vue__.$data/$props` 翻题干 | 那些元素上没有 `__vue__`，全页扫描也没有 |
| `caretRangeFromPoint` | 返回宿主元素，不是影子树内部 |

**结论**：只有浏览器层（CDP）能读到。这也是为什么这个平台的适配不是"粘脚本"，而是让助手直连浏览器调试端口。

---

## 3. ⚠ 反作弊实测：**不要自动填答**

只读读取是安全的；**一旦在页面上点击选项，就会被判"异常脚本"**。

实测经过（在一个已授权的真实账号、真实作业上）：

1. 用 CDP 只读读到 6 道题（题干/题型/选项/选项 id 全部拿到）✅
2. 调模型解题 → 6 题全部得出答案 ✅
3. 在**准备自动填答、但还没点任何选项**时，页面弹出了：

   > **提示**
   > 检测到异常脚本，为保证您正常答题，请您关闭插件，刷新页面后重新答题！

事后核查：那次运行**一个选项都没点**（存档目录没有新文件 → 解题链没走到填答那一步），
所以触发的**不是"答题速度"**。两个最可能的原因：

1. **为撬开闭合影子树留下的原型 hook**（`Element.prototype.attachShadow`、`XMLHttpRequest.prototype.open/send`、`window.fetch` 都被改写过）——
   反作弊只要一句 `Element.prototype.attachShadow.toString().includes('native code')` 就能判定，**一句话就抓**；
2. **脚本点击的 `event.isTrusted === false`** —— 我们用 `.click()` 点选项时一定会暴露，任何监听 `click` 的脚本看一眼就知道。

这两点都跟"快慢"无关。第 1 条是调试期的人为污染（正式流程不需要任何 hook），第 2 条是自动填答的**结构性**问题 —— 所以本项目的智慧树适配**直接放弃了自动填答**：

> 只读读卷 → 模型解题 → **答案打在终端** → 你自己动手填。

零风险，而且省掉了思考的时间。

---

## 4. 现在的实现

```
platforms/zhihuishu/index.mjs     # 平台模块：mode = 'cdp'，导出 readPaper() / diagnose()，零点击代码
lib/cdp.mjs                       # 通用零依赖 CDP 客户端（Node 22+ 自带 WebSocket/fetch）
lib/report.mjs                    # 答案单渲染（Markdown，所有平台共用）
启动带调试浏览器.bat                # 用 --remote-debugging-port 拉起 Chrome/Edge（独立 profile）
```

流程：
1. 双击 `启动带调试浏览器.bat` → 登录 → 进入作业答题界面；
2. 网页上点「读取当前页面并解题」；
3. 助手用 `DOM.getDocument{pierce:true}` 读卷（**不执行任何页面 JS、不点任何东西**）→ 模型解题；
4. 解完**一次性把答案单打在终端里**（✅ 标出正确项 + 速查行）——**不写任何文件**；
5. 你照着终端里的答案自己填、自己交。

### 踩过的坑

- CDP 的 `attributes` 是**扁平数组** `[name1, value1, name2, value2, ...]`，不是对象数组 —— 写成 `.find(a => a.name==='class')` 会静默地一个 class 都取不到；
- 作业标题在 `h1.titleLength`，别用整个信息栏元素取 `textContent`（会把"名称/章节/截止时间"全吞进来）；
- `paper.tid` 是 URL，**不能直接拼进文件名**（`/` 和 `:` 会造出非法路径，存档会静默失败）；
- 多选题答案要能拆 `"AC"` / `"A,C"` / `["A","C"]` 三种写法（`lib/report.mjs` 里的 `lettersOf`）。

---

## 5. 还没做的

- 一页一题的考试（有"下一题"分页）目前只读当页；
- 填空题/简答题的答案单只给文本，没有长度/格式提示；
- 有监考、人脸识别、摄像头抓拍的考试**请勿使用任何自动化**（本来也过不了）。
