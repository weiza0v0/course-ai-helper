/* ============================================================================
 * MOOC 测验 AI 答题助手 —— 一键脚本（在测验页控制台粘贴一次即可）
 *
 *   1. 读取题目            （走 MOOC 官方接口，失败退回 DOM 解析）
 *   2. 直接 POST 给本机助手  → 后端自动开始解题
 *   3. 轮询答案            → 拿到后直接填进页面（只填，不交卷）
 *
 * 使用：
 *   - 先在测验页点「开始测验」进入答题界面
 *   - F12 控制台；若提示不允许粘贴，先输入  allow pasting  回车
 *   - 粘贴本脚本，回车。之后什么都不用做，等它在页面上勾答案。
 *   - 想中途停止：控制台输入  __MOOC_HELPER__.stop()
 *   - 想只重新勾一次：__MOOC_HELPER__.fill()
 * ==========================================================================*/
(async () => {
  const VERSION = '2.0.0';
  const BACKEND = '__BACKEND__';
  const TOKEN = '__TOKEN__';
  const TYPE = {1: '单选', 2: '多选', 3: '填空', 4: '判断'};

  const log = (msg, color = '#0a0') => console.log(`%c[助手] ${msg}`, `color:${color};font-weight:bold`);
  const warn = msg => console.warn(`[助手] ${msg}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const txt = html => String(html == null ? '' : html)
    .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '').replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, ' ').trim();
  const imgs = html => [...String(html || '').matchAll(/<img[^>]*?src=["']([^"']+)["']/gi)]
    .map(m => (m[1].startsWith('//') ? 'https:' + m[1] : m[1]));

  const tid = (location.hash.match(/[?&]id=(\d+)/) || location.pathname.match(/(\d{6,})/) || [])[1];
  if (!tid) return warn('从 URL 里找不到测验 id，请确认当前是测验页面');

  // ================================================================ 1. 采集
  async function collect() {
    const csrf = (document.cookie.match(/NTESSTUDYSI=([0-9a-f]{32})/) || [])[1];
    if (csrf) {
      const rpc = async (method, body) => {
        const r = await fetch(`/web/j/mocQuizRpcBean.${method}.rpc?csrfKey=${csrf}`, {
          method: 'POST', headers: {'Content-Type': 'application/json;charset=UTF-8'},
          body: JSON.stringify(body), credentials: 'include',
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error(`${method} code=${j.code}`);
        return j.result;
      };
      try {
        const info = await rpc('getOpenQuizInfo', {tid, targetAid: null, isDraft: false});
        const aid = info.aid || (info.targetAnswerform && info.targetAnswerform.aid);
        const paper = await rpc('getOpenQuizPaperDto', {tid, aid, withStdAnswerAndAnalyse: false});
        const qs = paper.objectiveQList || [];
        if (qs.length) {
          return {
            tid: String(tid), aid, name: paper.tname || info.name || '', source: 'api',
            collectedAt: new Date().toISOString(),
            questions: qs.map((q, i) => ({
              index: i + 1, qid: q.id, type: q.type, typeName: TYPE[q.type] || ('type' + q.type), score: q.score,
              stem: txt(q.title), stemImages: imgs(q.title), stemOcr: txt(q.ocrContent),
              options: (q.optionDtos || []).map((o, k) => ({
                letter: String.fromCharCode(65 + k), oid: o.id,
                text: txt(o.content), images: imgs(o.content), ocr: txt(o.ocrContent),
              })),
            })),
          };
        }
      } catch (e) { warn('接口采集失败，改用 DOM 解析：' + e.message); }
    }
    // DOM 兜底
    const nodes = [...document.querySelectorAll('.m-data-lists > .m-choiceQuestion')];
    if (!nodes.length) return null;
    return {
      tid: String(tid), aid: 0, name: '', source: 'dom', collectedAt: new Date().toISOString(),
      questions: nodes.map((node, i) => {
        const first = node.querySelector('input');
        const qid = first ? (first.id.match(/^op_(\d+)_/) || [])[1] : null;
        const stemNode = node.querySelector('.j-title .j-richTxt, .j-richTxt');
        return {
          index: i + 1, qid: qid ? Number(qid) : null, type: 0,
          typeName: txt(node.querySelector('.qaCate') && node.querySelector('.qaCate').textContent) || '单选',
          stem: txt(stemNode && stemNode.innerHTML), stemImages: imgs(stemNode && stemNode.innerHTML), stemOcr: '',
          options: [...node.querySelectorAll('.j-choicebox li')].map((li, k) => {
            const inp = li.querySelector('input');
            const cnt = li.querySelector('.optionCnt, .f-richEditorText');
            const icon = li.querySelector('.u-icon-correct') ? '正确' : (li.querySelector('.u-icon-wrong') ? '错误' : '');
            const oid = inp ? (inp.id.split('_')[2] || '').replace(/\d{13}$/, '') : '';
            return {
              letter: String.fromCharCode(65 + k), oid: oid ? Number(oid) : null,
              text: txt(cnt && cnt.innerHTML) || icon, images: imgs(cnt && cnt.innerHTML), ocr: '',
            };
          }),
        };
      }),
    };
  }

  // ================================================================ 2. 填答
  function toIndexes(qnode, spec) {
    const lis = [...qnode.querySelectorAll('.j-choicebox li')];
    const isJudge = lis.length === 2 && lis.some(li => li.querySelector('.u-icon-correct, .u-icon-wrong'));
    const items = spec == null ? [] : (Array.isArray(spec) ? spec : String(spec).split(/[\s,、|]+/).filter(Boolean));
    const idx = [];
    for (const raw of items) {
      const s = String(raw).trim(), u = s.toUpperCase();
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
      if (/^[A-H]$/.test(u)) {
        const k = u.charCodeAt(0) - 65;
        if (k < lis.length) { idx.push(k); continue; }
      }
      const k = lis.findIndex(li => {
        const t = txt(li.querySelector('.optionCnt, .f-richEditorText')) || txt(li);
        return t && (t === s || t.replace(/^[A-H][.、]\s*/, '') === s);
      });
      if (k >= 0) { idx.push(k); continue; }
      warn('无法映射的答案：' + s);
    }
    return [...new Set(idx)];
  }

  // ---------------- MOOC 平台限流处理 ----------------
  // 页面每勾一个选项就发一次 saveDraftAnswers 草稿写请求；一秒内连点会被平台判为
  // "并发限制，请稍后再试"。所以：① 勾选之间留间隔；② 一旦弹限流框就关掉并退避。
  function limitDialog() {
    for (const d of document.querySelectorAll('.u-dialog, .m-dialog, .u-modal, [class*="dialog"], [class*="Dialog"]')) {
      if (!d.offsetParent) continue;
      if (/并发限制|请稍后再试|操作(?:过于)?频繁|请求(?:过于)?频繁/.test(d.textContent || '')) return d;
    }
    return null;
  }
  function dismissDialog(scope) {
    const btns = [...scope.querySelectorAll('a,button,div,span')]
      .filter(e => e.children.length === 0 && /^(确定|知道了|好的|关闭|知道了！|OK)$/i.test((e.textContent || '').trim()));
    if (btns.length) { btns[0].click(); return true; }
    return false;
  }

  async function setOption(li, want) {
    const input = li.querySelector('input');
    if (!input || input.disabled) return false;
    if (input.checked === want) return true;
    input.click();
    if (input.checked === want) return true;
    await sleep(250);                                   // 限流时第一次点击可能没生效
    const label = li.querySelector('label');
    if (label) label.click();
    if (input.checked === want) return true;
    await sleep(250);
    input.checked = want;
    input.dispatchEvent(new Event('click', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return input.checked === want;
  }

  /** 限速填答：每题之间等待 intervalMs，撞到平台限流就退避重试 */
  async function fill(answers, opts = {}) {
    const intervalMs = Math.max(0, Number(opts.intervalMs ?? 400));
    const backoffMs = Math.max(500, Number(opts.backoffMs ?? 3000));
    let nodes = [...document.querySelectorAll('.m-data-lists > .m-choiceQuestion')];
    if (!nodes.length) nodes = [...document.querySelectorAll('.m-choiceQuestion')];
    if (!nodes.length) { warn('页面上找不到题目'); return {ok: 0, fail: 0, missing: 0, disabled: 0, throttled: 0}; }
    let ok = 0, fail = 0, missing = 0, disabled = 0, throttled = 0;
    const rows = [];
    for (let i = 0; i < nodes.length; i++) {
      if (state.stop) break;
      const node = nodes[i];
      const first = node.querySelector('input');
      const qid = first ? (first.id.match(/^op_(\d+)_/) || [])[1] : null;
      const spec = answers[qid] != null ? answers[qid]
        : answers[String(i + 1)] != null ? answers[String(i + 1)] : answers[i];
      const cate = txt(node.querySelector('.qaCate') && node.querySelector('.qaCate').textContent);
      if (spec == null) { missing++; rows.push({题号: i + 1, qid, 类型: cate, 答案: '(缺)', 结果: '跳过'}); continue; }
      const idxs = toIndexes(node, spec);
      const lis = [...node.querySelectorAll('.j-choicebox li')];
      if (!idxs.length) { fail++; rows.push({题号: i + 1, qid, 类型: cate, 答案: JSON.stringify(spec), 结果: '映射失败'}); continue; }

      // 撞限流：关掉弹窗、等一会儿再继续
      let dlg = limitDialog();
      if (dlg) {
        dismissDialog(dlg);
        throttled++;
        log(`平台提示"并发限制"，已关闭弹窗并等待 ${(backoffMs / 1000).toFixed(1)}s 后继续…`, '#e90');
        await sleep(backoffMs);
      }

      let allOk = true;
      for (let k = 0; k < lis.length; k++) {
        const want = idxs.includes(k);
        const done = await setOption(lis[k], want);
        if (want && !done) allOk = false;
        const inp = lis[k].querySelector('input');
        if (inp && inp.disabled) disabled++;
      }
      allOk ? ok++ : fail++;
      rows.push({题号: i + 1, qid, 类型: cate, 答案: idxs.map(k => String.fromCharCode(65 + k)).join(''), 结果: allOk ? '✔ 已勾选' : '✖ 未生效'});
      if (i < nodes.length - 1) await sleep(intervalMs);   // ★ 错开草稿写请求
    }

    // ---- 复核：实际勾上的 vs 期望的。不一致多半是被限流打断，退避后补勾一次
    const expectOf = i => {
      const node = nodes[i];
      const first = node.querySelector('input');
      const qid = first ? (first.id.match(/^op_(\d+)_/) || [])[1] : null;
      const spec = answers[qid] != null ? answers[qid]
        : answers[String(i + 1)] != null ? answers[String(i + 1)] : answers[i];
      if (spec == null) return null;
      const idxs = toIndexes(node, spec);
      if (!idxs.length) return null;
      const lis = [...node.querySelectorAll('.j-choicebox li')];
      const allChecked = idxs.every(k => lis[k] && lis[k].querySelector('input') && lis[k].querySelector('input').checked);
      return {idxs, lis, allChecked};
    };
    const check = () => nodes.map((_, i) => expectOf(i)).map((e, i) => (e && !e.allChecked ? {...e, i} : null)).filter(Boolean);

    let bad = check();
    if (bad.length) {
      warn(`复核发现 ${bad.length} 题没勾上（可能被平台限流打断），等待 ${(backoffMs / 1000).toFixed(1)}s 后补勾…`);
      await sleep(backoffMs);
      for (const b of bad) {
        const dlg = limitDialog();
        if (dlg) { dismissDialog(dlg); throttled++; await sleep(backoffMs); }
        for (let k = 0; k < b.lis.length; k++) await setOption(b.lis[k], b.idxs.includes(k));
        await sleep(intervalMs);
      }
      bad = check();
    }
    // 用最终状态重算成功/失败，并修正表格里的结果列
    const badSet = new Set(bad.map(b => b.i));
    rows.forEach((row, i) => {
      if (row.结果 === '跳过' || row.结果 === '映射失败') return;
      row.结果 = badSet.has(i) ? '✖ 未生效' : '✔ 已勾选';
    });
    const skipped = rows.filter(r => r.结果 === '跳过' || r.结果 === '映射失败').length;
    ok = rows.filter(r => r.结果 === '✔ 已勾选').length;
    fail = rows.length - ok - skipped;

    console.table(rows);
    return {ok, fail, missing, disabled, throttled, remaining: bad.length};
  }

  const state = {stop: false, answers: {}, paper: null, info: null};

  async function fillAnswers(answers) {
    const gap = (state.info && state.info.fillIntervalMs) || 400;
    const backoff = (state.info && state.info.limitBackoffMs) || 3000;
    log(`把 AI 答案填进页面…（每次勾选间隔 ${gap}ms，避免触发平台并发限制）`);
    const r = await fill(answers, {intervalMs: gap, backoffMs: backoff});
    log(`填答完成：成功 ${r.ok} / 失败 ${r.fail} / 缺答案 ${r.missing}${r.throttled ? ` / 遇限流等待 ${r.throttled} 次` : ''}${r.remaining ? ` / 仍未生效 ${r.remaining}` : ''}`, r.fail || r.missing ? '#e90' : '#0a0');
    if (r.disabled) warn(`有 ${r.disabled} 个选项是禁用状态——可能还没点「开始测验」，或这次测验已交过卷（要点「再做一次」）`);
    const btn = document.querySelector('.j-submitBtn');
    if (btn) {
      btn.style.outline = '3px solid #e33';
      btn.style.outlineOffset = '2px';
      log('答案已填入页面。请自己核对后再点「提交答案」—— 本工具不会替你交卷。', '#e33');
      btn.scrollIntoView({block: 'center', behavior: 'smooth'});
    } else {
      log('答案已填入页面（没找到提交按钮，请手动翻到页面底部提交）', '#e90');
    }
    return r;
  }

  // ================================================================ 3. 主流程
  window.__MOOC_HELPER__ = {
    version: VERSION,
    stop() { state.stop = true; log('已停止轮询（已勾选的答案保留在页面上）', '#e90'); },
    fill() { return fillAnswers(state.answers); },
    answers: () => state.answers,
    paper: () => state.paper,
  };

  log('开始采集题目…');
  const paper = await collect();
  if (!paper || !paper.questions.length) {
    return warn('没采到题目。请先在页面上点「开始测验」进入答题界面，再重新粘贴本脚本。');
  }
  state.paper = paper;
  window.__MOOC_PAPER__ = paper;
  log(`采到 ${paper.questions.length} 道题（来源 ${paper.source}），正在上传到本机助手…`);

  // 后端不可用/没 token 时，退回"复制 JSON 到网页"的老流程
  const manual = async why => {
    const json = JSON.stringify(paper);
    try { copy(json); } catch {}
    warn(why + '。已把题目 JSON 复制到剪贴板：去助手网页粘贴 → 解题 → 再用填答脚本。');
    console.log(json);
  };
  if (!/^https?:\/\//.test(BACKEND) || BACKEND.includes('__BACKEND__')) return manual('脚本里的后端地址没被注入');

  let info;
  try {
    const r = await fetch(`${BACKEND}/api/collect?t=${TOKEN}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper}),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) return manual('上传失败（' + (j.error || r.status) + '）');
    info = j;
    state.info = j;
  } catch (e) {
    return manual('连不上本机助手（' + e.message + '）');
  }

  log(`上传成功 ✅ 助手开始解题：模型 ${info.model} · 思考 ${info.reasoning} · ${info.total} 题`, '#06c');
  if (!info.autoSolve) warn('助手配置里 auto_solve = false，需要在网页上手动点「开始解题」');

  // ---- 轮询答案
  const poll = Math.max(1, info.pollSeconds || 2) * 1000;
  let lastDone = -1, dots = 0;
  while (!state.stop) {
    await sleep(poll);
    let j;
    try {
      j = await (await fetch(`${BACKEND}/api/answers?t=${TOKEN}&paperId=${info.sessionId}`)).json();
    } catch (e) {
      warn('查询答案失败（助手窗口关了吗？）：' + e.message);
      return;
    }
    if (j.sessionId !== info.sessionId) { warn('助手那边开始了新的一轮，停止本次轮询'); return; }
    if (j.done !== lastDone) {
      lastDone = j.done;
      log(`进度 ${j.done}/${j.total}`);
    } else if (++dots % 15 === 0) {
      log(`仍在解题中…（${j.status}，已出 ${j.done}/${j.total}）`);
    }
    if (j.status === 'error') return warn('助手解题出错：' + (j.error || '未知错误') + '，去助手网页看日志');
    if (j.status === 'done') {
      state.answers = j.answers || {};
      log(`答案到齐（${Object.keys(state.answers).length} 题）`, '#06c');
      await fillAnswers(state.answers);
      return;
    }
  }
})();
