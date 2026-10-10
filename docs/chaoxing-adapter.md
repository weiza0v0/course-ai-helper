# 超星学习通适配笔记（交接给社区）

> 状态：**服务端 / 模型 / 数学工具已全部复用并跑通；差的是"答题态 DOM"的校准。**
> 原因：作者手上这个账号的 11 个作业全部已提交、该课无考试，拿不到"正在作答"的页面。
> 欢迎在你有**未作答**作业/章节测验的账号上跑一次诊断，把结果贴到 issue，我们就能把它补完。

---

## 1. 已经确认的部分

### 1.1 iframe 套娃链（这是超星最大的坑）

超星把内容全塞在 iframe 里，而且是**跨子域**的，父页面 JS 读不到子页面 DOM：

```
i.chaoxing.com/base
  └─ iframe  mooc1-1.chaoxing.com/visit/interaction?s=<md5>          ← 课程卡片列表
       └─ a.color1  →  mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=..&clazzid=..&cpi=..&ismooc2=1&v=2
            └─ 302 →  mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=..&clazzid=..&cpi=..&enc=..&t=..&pageHeader=N
                 └─ iframe  mooc1.chaoxing.com/mooc2/work/list?courseId=..&classId=..&cpi=..&ut=s&t=..&stuenc=..&enc=..
                      └─ li[onclick="goTask(this)"] data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?...&workId=..&answerId=..&enc=.."
```

- `pageHeader=0` 首页 / **`8` 作业** / **`9` 考试**
- 课程页的 `t=` 时间戳和 `enc=` 是**会话绑定的**，手拼 URL 会得到「参数验证不通过 / 无效的参数」——
  必须从真实点击链路拿。

> ⚠️ 因此 `console/helper.js` 必须贴在**装题目的那个 iframe** 的 console 上下文里
> （DevTools 左上角有个 `top ▾` 上下文下拉框，切到对应 frame 再粘贴）。
> 脚本检测不到题目时会打印提示。

### 1.2 作业列表行（实测抓到的真实 HTML）

```html
<li onclick="goTask(this);"
    data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=250812473&classId=117171581&cpi=412310891&workId=43885025&answerId=53970903&enc=f83056..."
    tabindex="0" aria-label="第十章 ; 已完成" role="link">
  <div class="tag work-icon icon-zy-g"></div>
  <div class="right-content">
    <p class="overHidden2 fl">第十章</p>
    <p class="status fl">已完成</p>
    <a class="listSubmit fl insightBtn" href="https://stat2-ans.chaoxing.com/study-knowledge/ans?...">智能分析</a>
  </div>
</li>
```

### 1.3 已批阅详情页 `mooc2/work/view`（实测结构，**答题态大概率同构**）

```html
<div class="fanyaMarking TiMu" id="fanyaMarking">
  <div class="fanyaMarking_left whiteBg">
    <h2 class="mark_title">第十章</h2>
    <span class="resultNum"><i>100</i>分</span>
    <div class="mark_table ans-cc fontLabel">
      <div class="mark_item">
        <h2 class="type_tit">一. 单选题（共8题，61.5分）</h2>

        <div class="marBom60 questionLi singleQuesId" id="question404723008" data="404723008" aria-label="题目详情">
          <h3 class="mark_name colorDeep">
            1. <span class="colorShallow">(单选题)</span>
            <span class="qtContent workTextWrap">________把习近平总书记…写入党章。</span>
          </h3>
          <ul class="mark_letter colorDeep qtDetail">
            <li class="workTextWrap">A. 党的十六大</li>
            <li class="workTextWrap">B. 党的十七大</li>
            <li class="workTextWrap">C. 党的十八大</li>
            <li class="workTextWrap">D. 党的十九大</li>
          </ul>
          <div class="mark_answer">
            <span>我的答案: <span class="stuAnswerContent">D</span></span>
            <span class="element-invisible-hidden">:党的十九大; </span>
            <span>正确答案: <span class="rightAnswerContent workTextWrap">D</span></span>
          </div>
          <div class="analysisDiv"><div class="analysis"><span class="qtAnalysis">…解析…</span></div></div>
        </div>

      </div>
    </div>
  </div>
</div>
```

要点：
- **题目 id 就在 `data` 属性上**（`question404723008` → `404723008`），脚本已按这个取 `qid`；
- `.mark_name` 里有题号和题型（`.colorShallow` = `(单选题)` / `(判断题)` / `(多选题)` / `(填空题)` …）；
- 选项文本**自带字母**（`A. xxx`），所以在答题态用文本反查字母是可行的；
- 题型分组在 `.mark_item > .type_tit`。

> 💡 顺带发现：**已批阅页的 DOM 里直接带 `正确答案`**（`.rightAnswerContent`，还有 `.element-invisible-hidden` 里的选项原文）。
> 也就是说自己已交过的作业，答案是可以直接读出来的——但这对"正在作答"没有帮助。

### 1.4 答题态还缺什么

`mooc2/work/task?...` 页面（未作答状态）里，下面这些需要按真实页面确认：

| 待确认 | 脚本里对应的函数 |
| --- | --- |
| 选项的可点击元素是 `<li>` / `<a>` / `<label>` 还是里面的 `<i>` | `setOption()` 的 `target` |
| 选中态 class（`check_answer` / `check_answer_dx` / `cur` / `on`） | `isSelected()` 的 `SELECTED_RE` |
| 多选是 `input[type=checkbox]` 还是纯 class 切换 | `setOption()` 的 input 分支 |
| 填空题输入框的 class（`tk_input` / `textarea[data-id]`） | `fillText()` |
| 一页一题还是整卷同页（是否有"下一题"分页） | 采集范围 |

---

## 2. 请社区帮忙的第一步（5 分钟）

1. 打开一个**没做过**的作业或章节测验，进入能看到题目和选项的答题界面；
2. F12 控制台（记得把上下文切到题目所在的 frame），先输入 `allow pasting` 回车；
3. 粘贴 `console/helper.js` 全量内容并回车；
4. 它会自己采集；**如果采到 0 题**，它会自动打印 DOM 诊断，请把诊断 JSON 贴到 issue：<br>
   或者手动跑：`__CX_HELPER__.diagnose()`

诊断输出里包含：各个候选选择器的命中数、iframe 列表、最可能的题目容器、以及第一个容器的 `outerHTML`（前 1500 字符）——有这些就能一次改对。

---

## 3. 已知注意事项

- **别用在有监考/人脸识别/摄像头抓拍的考试上**（超星考试常见），既不合规也自动化不了；
- 一页一题的考试：当前脚本只处理"当前页的题"，需要加翻页循环；
- 超星**每选一个选项就会发一次保存请求**，所以 `fill_interval_ms`（默认 400ms）别调太小；
- 超星会给题目加"AI 讲解"入口（`initAssistant(...)`），说明平台本身也在用大模型——这算个正面信号，但别指望它不检测自动化。
