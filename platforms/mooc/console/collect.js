/* ============================================================================
 * MOOC 测验 AI 答题助手 —— 采集脚本（第 1 步）
 *
 * 用法：
 *   1. 在浏览器里打开测验页面（要点到能看到题目，比如已经点过「开始测验」）
 *   2. F12 打开控制台，若提示不允许粘贴，先输入  allow pasting  回车
 *   3. 把本文件全部内容粘进控制台，回车
 *   4. 脚本会把题目 JSON 复制到剪贴板（同时打印出来），粘到助手的网页里即可
 * ==========================================================================*/
(async () => {
  const VERSION = '1.0.0';
  const TYPE = {1: '单选', 2: '多选', 3: '填空', 4: '判断'};

  const txt = html => String(html == null ? '' : html)
    .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '').replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, ' ').trim();

  const imgs = html => [...String(html || '').matchAll(/<img[^>]*?src=["']([^"']+)["']/gi)]
    .map(m => m[1].startsWith('//') ? 'https:' + m[1] : m[1]);

  const tid = (location.hash.match(/[?&]id=(\d+)/) || location.pathname.match(/(\d{6,})/) || [])[1];
  if (!tid) return console.error('%c[采集失败] 从 URL 里找不到测验 id', 'color:#e33');

  // ---------------------------------------------------------------- 优先走接口
  let payload = null;
  const csrf = (document.cookie.match(/NTESSTUDYSI=([0-9a-f]{32})/) || [])[1];
  if (csrf) {
    const rpc = async (method, body) => {
      const r = await fetch(`/web/j/mocQuizRpcBean.${method}.rpc?csrfKey=${csrf}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json;charset=UTF-8'},
        body: JSON.stringify(body),
        credentials: 'include',
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
        payload = {
          tid: String(tid),
          aid,
          name: paper.tname || info.name || '',
          source: 'api',
          collectedAt: new Date().toISOString(),
          totalScore: paper.totalScore,
          questions: qs.map((q, i) => ({
            index: i + 1,
            qid: q.id,
            type: q.type,
            typeName: TYPE[q.type] || ('type' + q.type),
            score: q.score,
            stem: txt(q.title),
            stemImages: imgs(q.title),
            stemOcr: txt(q.ocrContent),
            options: (q.optionDtos || []).map((o, k) => ({
              letter: String.fromCharCode(65 + k),
              oid: o.id,
              text: txt(o.content),
              images: imgs(o.content),
              ocr: txt(o.ocrContent),
            })),
          })),
        };
        if ((paper.subjectiveQList || []).length) {
          payload.note = `本测验还有 ${paper.subjectiveQList.length} 道主观题，助手只能处理客观题`;
        }
      }
    } catch (e) {
      console.warn('[采集] 接口方式失败，改用 DOM 解析：' + e.message);
    }
  }

  // ---------------------------------------------------------------- DOM 兜底
  if (!payload) {
    const nodes = [...document.querySelectorAll('.m-data-lists > .m-choiceQuestion')];
    if (!nodes.length) {
      return console.error('%c[采集失败] 页面上找不到题目。请先点「开始测验」进入答题界面，再跑这个脚本。', 'color:#e33;font-weight:bold');
    }
    const typeOf = node => {
      const c = node.querySelector('.qaCate');
      return txt(c && c.textContent) || '单选';
    };
    payload = {
      tid: String(tid),
      aid: 0,
      name: (document.querySelector('.j-title') || {}).textContent ? '' : '',
      source: 'dom',
      collectedAt: new Date().toISOString(),
      questions: nodes.map((node, i) => {
        const firstInput = node.querySelector('input');
        const qid = firstInput ? (firstInput.id.match(/^op_(\d+)_/) || [])[1] : null;
        const stemNode = node.querySelector('.j-title .j-richTxt, .j-richTxt');
        return {
          index: i + 1,
          qid: qid ? Number(qid) : null,
          type: 0,
          typeName: typeOf(node),
          stem: txt(stemNode && stemNode.innerHTML),
          stemImages: imgs(stemNode && stemNode.innerHTML),
          stemOcr: '',
          options: [...node.querySelectorAll('.j-choicebox li')].map((li, k) => {
            const inp = li.querySelector('input');
            const cnt = li.querySelector('.optionCnt, .f-richEditorText');
            const icon = li.querySelector('.u-icon-correct') ? '正确' : (li.querySelector('.u-icon-wrong') ? '错误' : '');
            const oid = inp ? (inp.id.split('_')[2] || '').replace(/\d{13}$/, '') : '';
            return {
              letter: String.fromCharCode(65 + k),
              oid: oid ? Number(oid) : null,
              text: txt(cnt && cnt.innerHTML) || icon,
              images: imgs(cnt && cnt.innerHTML),
              ocr: '',
            };
          }),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- 输出
  const json = JSON.stringify(payload);
  let copied = false;
  try { copy(json); copied = true; } catch (e) {}
  window.__MOOC_PAPER__ = payload;

  console.log('%c[采集完成] ' + payload.questions.length + ' 道题 · 来源:' + payload.source + ' · 测验:' + (payload.name || payload.tid), 'color:#0a0;font-weight:bold');
  console.log(copied ? '已复制到剪贴板 ✅ 直接粘到助手网页的输入框里就行' : '剪贴板不可用，请手动复制下面这行 JSON：');
  if (!copied) console.log(json);
  console.log('也可以随时用  copy(JSON.stringify(window.__MOOC_PAPER__))  重新复制');
  console.table(payload.questions.map(q => ({
    题号: q.index, 类型: q.typeName, qid: q.qid,
    题干: (q.stem || '[图片]').slice(0, 40),
    图片: q.stemImages.length + q.options.reduce((s, o) => s + o.images.length, 0),
  })));
  if (payload.note) console.warn(payload.note);
})();
