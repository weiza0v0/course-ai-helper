# 超星学习通 / 泛雅 适配笔记

> 状态（2026-10）：**已用真实章节测验跑通**「iframe 穿透读题 → 多模态解题 → 自动填答」。
> 测试卷：10 题（4 单选 + 1 判断 + 5 填空），整卷同页，未提交。
> 仍然**永不交卷**：本适配层没有任何 submit 动作。

---

## 1. 真实页面结构（实测）

超星把内容全塞在 iframe 里，而且**题目不在第一层**：

```
学生学习页面  mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...     ← 顶层标签页
  └─ iframe#iframe  mooc1.chaoxing.com/mooc-ans/knowledge/cards?...     ← 课程内容卡片
       └─ iframe   mooc1.chaoxing.com/ananas/modules/work/index.html     ← 作业/测验模块
            └─ iframe#frame_content  mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?...  ← 题目在这
                 └─ 10 × .TiMu
```

实测结论：

- 顶层 `document.querySelectorAll('.TiMu')` = **0**；
- 顶层标签页 URL 是 `studentstudy`，路径里没有 work/exam，旧版按 URL 正则找答题页**根本认不出来**；
- 题目在第 4 层 document 里，必须按 frame 逐个探测，再往**那个 frame 的上下文**注入脚本。

现在的做法：

1. 标签页用 `siteUrl`（所有 chaoxing 域名）筛选，不再要求 URL 里带 work；
2. `CdpSession.findFrame(selector)` 遍历 `Page.getFrameTree`，在每个 frame 的默认执行上下文里数题目节点；
3. 找到后 `setTargetFrame(frameId)`，后续的桥接层注入、读题、回填都在那个 frame 里执行。

---

## 2. 字体反爬（最大的坑）

题干和选项的容器套了 `.font-cxsecret`：

```css
@font-face {
  font-family: font-cxsecret;
  src: url("data:application/font-ttf;charset=utf-8;base64,AAEAAAAMAIAAAwBAQkFTRR...");
}
```

- 服务端把文字替换成随机的生僻字，再下发一个自定义字体；**渲染出来才是真字**；
- DOM 里 `textContent` 拿到的是乱码，例如：

  ```
  设喸喺个随机喵営，喹充濆条営喸( ).       ← 实际应为「设 A,B 是两个随机事件…」
  ```

- 字体 info：`unitsPerEm=1000`，`name` 表里的 family 是 `Source Han Sans CN Normal`；
- 逐字去解字体（glyph 轮廓 → 真字）需要参考字体、且映射可能每页随机 —— 不划算。

**方案：截图 + 多模态模型。** 每题截一张图（jpeg，约 13–22 KB），作为 `q.shot`（data URL）
塞进模型消息；文字只留题型/字母，明确告诉模型"文字是乱码，以截图为准"。

截图实现要点（都踩过）：

| 问题 | 处理 |
| --- | --- |
| 隐藏标签页上 `Page.captureScreenshot` 会卡住 | 先 `Page.bringToFront` 把答题页切到前台 |
| 目标题在当前视口外，`captureBeyondViewport` 截不到/超时 | 用 `Emulation.setDeviceMetricsOverride` 临时把视口放大到 1280×(4200+)；截完 `clearDeviceMetricsOverride` |
| 题目在多层 iframe 里，坐标不对 | 顶层的 JS 递归拿到叶子 document，把每层 `getBoundingClientRect()` 加上 iframe 的边框累加，得到视口绝对坐标 |
| 整卷截完还要恢复 | 只截单题 clip；不滚动页面（放大视口后整卷都在视口里） |

---

## 3. 题号 / 题型 / 选中态 / 填空

### 3.1 题号不在 `data` 上

实测每个 `.TiMu` 的 `data` 属性是**题型**（0 单选 / 2 填空 / 3 判断），不是题号：

```html
<div class="TiMu newTiMu" data="0"> ... </div>
```

真实 qid 在隐藏域的 `name` 里：

```html
<input type="hidden" name="answer405717732">          <!-- 选择题 -->
<input type="hidden" name="answertype405717732" value="0">
<input type="hidden" name="tiankongsize405717760" value="1">   <!-- 填空题 -->
<textarea name="answerEditor4057177601" style="display:none"></textarea>
```

旧版把 `data` 当 qid → 整卷只得到 `0/0/0/0/3/2/2/2/2/2` 三个 key，答案会串题。

现在的提取顺序：`answertype<qid>` → `answer<qid>` → `tiankongsize<qid>` →
`answerEditor<qid><序号>` → 选项 `[qid]` 属性。

### 3.2 题型

题型的文字标记在 `.newZy_TItle` 里（`【单选题】`/`【判断题】`/`【填空题】`…），
隐藏域 `answertype` 的值也可兜底：0 单选 / 1 多选 / 2 填空 / 3 判断。

### 3.3 两个"字母"（踩坑点）

超星选项上有**两个字母**，千万别混：

| 来源 | 例子 | 用途 |
| --- | --- | --- |
| `.num_option` 的**文本** | 显示 A / B / C / D | **用户看到的字母**（截图里也是它） |
| `.num_option` 的 `data` 属性 | B / D / C / A | 平台内部原始题序（`addChoice` 用它拼提交值） |

DOM 顺序 = 视觉顺序（A、B、C、D 从上到下），但 `data` 是按原始题序排的，两者是**错位**的。
如果拿 `data` 当答案字母：终端说"选 A"，页面上高亮的却是**显示为 D** 的那个选项 ——
看起来就是"答案和选的不一致"（本适配层早期版本就踩了这个坑，已改成一律用**显示字母**）。

### 3.4 选中态

选项 `li` 自带 `onclick="addChoice(this)"`。读页面里的 `addChoice` 源码可知：

```js
$(".choice" + qid).removeClass("check_answer");
$(obj).find(".num_option").addClass("check_answer");
$("#answer" + qid).val(choiceContent);
```

所以"已选中"的判据是 **`.num_option.check_answer`**（`li` 上的 `aria-checked=true` 也可）。
点击直接点 `li` 即可（事件冒泡到 `onclick`）。

### 3.5 填空题是 UEditor 富文本

可见的是 contenteditable iframe，隐藏 textarea 只是同步用。直接改 textarea 的 `value` 不会生效，
要拿编辑器实例：

```js
const ed = UE.getEditor(textarea.id) || window['answerEditor' + qid + '_1'];
ed.setContent(html);
ed.sync();
```

---

## 4. 已验证 / 未验证

**已验证**（真实章节测验，10 题）：

- 4 层 iframe 穿透 + 注入；
- 10 题 qid/题型/选项数量全部正确；
- 字体反爬截图 10/10；
- 只读模式 `--sheet`：10/10 解题，42.5s，输入 67.7k tokens（缓存命中 72%）；
- 自动填答：单选点击、判断点击、填空写 UEditor（见下节复测命令）。

**未验证 / 已知边界**：

- 多选（`qtype=1` 走 `addMultipleChoice`）——本卷没有多选；
- 一页一题 / 分页的考试；
- 连线、排序、口语、完形填空等特殊题型；
- 截图依赖"把答题页切到前台"：Chrome 隐藏标签页截不出图，**会短暂抢焦点**（不会导航/点击提交）；
- 截图会进模型上下文，成本比纯文本题高；模型必须支持图片输入；
- 有监考、人脸识别、摄像头抓拍的考试**不要用**（既不合规也自动化不了）。

---

## 5. 复测

```bash
# 1) 打开真实作业/章节测验，停在能看到题目和选项的页面
node cli.mjs chaoxing --sheet    # 只读：读题 + 解题 + 打印答案单，不碰页面
node cli.mjs chaoxing            # 自动填答（仍然不会提交）
node cli.mjs --selftest          # 102 项离线自检（含超星 iframe/字体反爬的静态检查）
```

如果页面上读不到题，先跑 `node cli.mjs --doctor` 看端口/profile，再看终端里
"识别到答题页 / 已就绪 —— 页面上能找到题目"这两行是否出现。
