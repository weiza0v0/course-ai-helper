/* ============================================================================
 * MOOC 测验 AI 答题助手 —— 手动填答脚本（备用）
 *
 * 一般情况下不需要它：一键脚本（helper.js）会自动把答案填进页面。
 * 只有在"想手动改几道题的答案"时才用它：
 *   网页上改好答案 → 复制填答脚本 → 粘进测验页控制台回车。
 *
 * 本脚本只负责勾选，不会提交，交卷永远由你自己点。
 * 勾选之间会留 400ms 间隔：MOOC 每勾一个选项就会发一次草稿写请求，连点太快会触发平台"并发限制"。
 * ==========================================================================*/
(async () => {
  const ANSWERS = /*__ANSWERS__*/ {};
  const FILL_INTERVAL_MS = 400;    // ★ 两次勾选之间的间隔：错开页面的草稿写请求，避免平台并发限制
  const LIMIT_BACKOFF_MS = 3000;   // 撞到"并发限制"弹窗后等多久
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const TYPE = {1: '单选', 2: '多选', 3: '填空', 4: '判断'};

  // ---------------------------------------------------------------- 答案来源
  let answers = ANSWERS;
  if (!answers || !Object.keys(answers).length) {
    if (window.__MOOC_ANSWERS__ && Object.keys(window.__MOOC_ANSWERS__).length) {
      answers = window.__MOOC_ANSWERS__;
    } else {
      const raw = prompt('把答案 JSON 粘贴到这里（形如 {"3388137939":"D","3388137926":"正确"}）');
      if (!raw) return console.warn('[填答] 已取消');
      try { answers = JSON.parse(raw); } catch (e) { return console.error('[填答] JSON 解析失败：' + e.message); }
    }
  }

  // ---------------------------------------------------------------- 找题目
  let nodes = [...document.querySelectorAll('.m-data-lists > .m-choiceQuestion')];
  if (!nodes.length) nodes = [...document.querySelectorAll('.m-choiceQuestion')];
  if (!nodes.length) {
    return console.error('%c[填答失败] 页面上找不到题目。请先点「开始测验」进入答题界面，再跑这个脚本。', 'color:#e33;font-weight:bold');
  }

  const txt = el => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const norm = s => String(s == null ? '' : s).trim().toUpperCase();

  /** 把「D」「AD」「正确」这类答案，映射到本题选项的下标数组 */
  function toIndexes(qnode, spec) {
    const lis = [...qnode.querySelectorAll('.j-choicebox li')];
    const isJudge = lis.length === 2 && lis.some(li => li.querySelector('.u-icon-correct, .u-icon-wrong'));
    const items = spec == null ? [] : (Array.isArray(spec) ? spec : String(spec).split(/[\s,、|]+/).filter(Boolean));
    const idx = [];
    for (const raw of items) {
      const s = String(raw).trim();
      const u = norm(s);
      // 判断题：正确/错误、对/错、T/F、√/×、A/B
      if (isJudge) {
        const wantTrue = /^(正确|对|是|T|TRUE|√|YES|Y)$/.test(u);
        const wantFalse = /^(错误|错|否|F|FALSE|×|X|NO|N)$/.test(u);
        if (wantTrue || wantFalse) {
          const k = lis.findIndex(li => (wantTrue
            ? (li.querySelector('.u-icon-correct') || /正确/.test(txt(li)))
            : (li.querySelector('.u-icon-wrong') || /错误/.test(txt(li)))));
          if (k >= 0) { idx.push(k); continue; }
        }
      }
      // 字母
      if (/^[A-H]$/.test(u)) {
        const k = u.charCodeAt(0) - 65;
        if (k < lis.length) { idx.push(k); continue; }
      }
      // 选项文本匹配
      const k = lis.findIndex(li => {
        const t = txt(li.querySelector('.optionCnt, .f-richEditorText')) || txt(li);
        return t && (t === s || t.replace(/^[A-H][.、]\s*/, '') === s);
      });
      if (k >= 0) { idx.push(k); continue; }
      console.warn('[填答] 无法映射的答案：' + s);
    }
    return [...new Set(idx)];
  }

  /** 点选某个选项；返回是否最终处于选中态 */
  async function setOption(li, want) {
    const input = li.querySelector('input');
    if (!input) return false;
    if (input.disabled) return false;
    if (input.checked === want) return true;
    input.click();                                  // 页面框架监听的是 input 的 click
    if (input.checked === want) return true;
    await sleep(250);                               // 被平台限流时第一次点击可能没生效
    const label = li.querySelector('label');
    if (label) label.click();
    if (input.checked === want) return true;
    await sleep(250);
    input.checked = want;                           // 最后兜底：直接改状态并补事件
    input.dispatchEvent(new Event('click', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return input.checked === want;
  }

  // ---------------- MOOC 平台限流处理 ----------------
  // 页面每勾一个选项就发一次 saveDraftAnswers 草稿写请求，一秒内连点会被判"并发限制，请稍后再试"。
  function limitDialog() {
    for (const d of document.querySelectorAll('.u-dialog, .m-dialog, .u-modal, [class*="dialog"], [class*="Dialog"]')) {
      if (!d.offsetParent) continue;
      if (/并发限制|请稍后再试|操作(?:过于)?频繁|请求(?:过于)?频繁/.test(d.textContent || '')) return d;
    }
    return null;
  }
  function dismissDialog(scope) {
    const btns = [...scope.querySelectorAll('a,button,div,span')]
      .filter(e => e.children.length === 0 && /^(确定|知道了|好的|关闭|OK)$/i.test((e.textContent || '').trim()));
    if (btns.length) { btns[0].click(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- 执行
  let ok = 0, fail = 0, missing = 0, disabled = 0, throttled = 0;
  const rows = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const firstInput = node.querySelector('input');
    const qid = firstInput ? (firstInput.id.match(/^op_(\d+)_/) || [])[1] : null;
    const spec = answers[qid] != null ? answers[qid]
      : answers[String(i + 1)] != null ? answers[String(i + 1)]
        : answers[i] != null ? answers[i] : null;
    const cate = txt(node.querySelector('.qaCate'));
    if (spec == null) {
      missing++;
      rows.push({题号: i + 1, qid, 类型: cate, 答案: '(缺)', 结果: '跳过'});
      continue;
    }
    const idxs = toIndexes(node, spec);
    const lis = [...node.querySelectorAll('.j-choicebox li')];
    if (!idxs.length) {
      fail++;
      rows.push({题号: i + 1, qid, 类型: cate, 答案: JSON.stringify(spec), 结果: '映射失败'});
      continue;
    }
    // 撞限流：关弹窗 + 退避
    const dlg = limitDialog();
    if (dlg) {
      dismissDialog(dlg);
      throttled++;
      console.warn('[填答] 平台提示"并发限制"，已关掉弹窗，等待 ' + (LIMIT_BACKOFF_MS / 1000).toFixed(1) + 's 后继续…');
      await sleep(LIMIT_BACKOFF_MS);
    }
    let allOk = true;
    for (let k = 0; k < lis.length; k++) {
      const want = idxs.includes(k);
      const done = await setOption(lis[k], want);
      if (want && !done) allOk = false;
      if (lis[k].querySelector('input') && lis[k].querySelector('input').disabled) disabled++;
    }
    if (allOk) ok++; else fail++;
    rows.push({
      题号: i + 1, qid, 类型: cate,
      答案: idxs.map(k => String.fromCharCode(65 + k)).join(''),
      结果: allOk ? '✔ 已勾选' : '✖ 未生效',
    });
    if (i < nodes.length - 1) await sleep(FILL_INTERVAL_MS);   // ★ 错开请求
  }

  console.log('%c[填答完成] 成功 ' + ok + ' / 失败 ' + fail + ' / 缺答案 ' + missing + (throttled ? ' / 遇限流等待 ' + throttled + ' 次' : ''), 'color:#0a0;font-weight:bold');
  console.table(rows);
  if (disabled) console.warn('有 ' + disabled + ' 个选项是禁用状态——很可能你还没点「开始测验」，或者本次测验已经交过卷了。请点「再做一次」后重跑。');
  if (missing) console.warn('有 ' + missing + ' 题没有答案，记得手动补。');
  if (fail) console.warn('有 ' + fail + ' 题没点成功，请手动核对。');

  // ---------------------------------------------------------------- 提示
  const submitBtn = document.querySelector('.j-submitBtn, a.j-submitBtn');
  if (submitBtn) {
    submitBtn.style.outline = '3px solid #e33';
    submitBtn.style.outlineOffset = '2px';
    console.log('%c答案已填好。检查无误后自己点页面上被红框圈出的「提交答案」——本脚本不会替你交卷。', 'color:#e33;font-weight:bold');
    submitBtn.scrollIntoView({block: 'center', behavior: 'smooth'});
  } else {
    console.log('%c答案已填好（没找到提交按钮，请手动翻到页面底部提交）。', 'color:#e33;font-weight:bold');
  }
})();
