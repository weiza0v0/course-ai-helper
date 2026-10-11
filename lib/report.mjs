/**
 * 答案单渲染 —— 把「卷子 + 答案」渲染成一份能照着手工填的 Markdown。
 *
 * 为什么需要：有些平台（如智慧树）会自动检测脚本点击（isTrusted=false / 原型被改写），
 * 自动填答有被判定"异常脚本"的风险。那就退一步：助手只**读**（只读不改页面），
 * 把答案整理成答案单存成文件，人来点鼠标填 —— 零风险，还省了思考的时间。
 */

/** 答案归一化成字母数组；返回 null 表示没答案 */
function lettersOf(spec, q) {
  if (spec == null) return null;
  const parts = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const p of parts) {
    for (const t of String(p).split(/[\s,，、|;；\/]+/)) {
      const s = t.trim();
      if (!s) continue;
      const u = s.toUpperCase();
      if (/^[A-Z]{2,4}$/.test(u)) out.push(...u.split(''));
      else if (/^[A-Z]$/.test(u)) out.push(u);
      else out.push(s);            // 填空题：原样输出
    }
  }
  return out.length ? out : null;
}

function findSpec(answers, q, i) {
  if (answers[q.qid] != null) return answers[q.qid];
  if (answers[String(q.index)] != null) return answers[String(q.index)];
  if (answers[i] != null) return answers[i];
  return null;
}

/**
 * @param {object} paper   {name, source, questions:[{index,qid,typeName,stem,options:[{letter,text}]}]}
 * @param {object} answers {qid|index: 'A' | 'AC' | ['A','C'] | '填空内容'}
 * @param {object} opts    {siteName, url, model, solvedAt}
 * @returns {string} Markdown
 */
export function renderAnswerSheet(paper, answers, opts = {}) {
  const qs = (paper && paper.questions) || [];
  const lines = [];
  const title = (paper && (paper.name || paper.title)) || '答题单';
  lines.push(`# ${String(title).slice(0, 60)} —— 答案单`);
  lines.push('');
  if (opts.siteName) lines.push(`- 平台：${opts.siteName}`);
  if (opts.model) lines.push(`- 模型：${opts.model}`);
  lines.push(`- 题数：${qs.length}`);
  lines.push(`- 生成时间：${opts.solvedAt || new Date().toLocaleString('zh-CN')}`);
  if (opts.url) lines.push(`- 页面：${opts.url}`);
  lines.push('');
  lines.push('> 本文件只提供答案，需要你**自己点鼠标填**。工具没有在页面上做任何修改。');
  lines.push('');

  // ---- 速查表（照着填最快）
  lines.push('## 速查');
  lines.push('');
  const quick = qs.map((q, i) => {
    const l = lettersOf(findSpec(answers, q, i), q);
    if (!l) return `${q.index}.（缺）`;
    return `${q.index}. ${l.join('')}`;
  });
  lines.push('```');
  lines.push(quick.join('   '));
  lines.push('```');
  lines.push('');

  // ---- 逐题
  lines.push('## 逐题');
  lines.push('');
  qs.forEach((q, i) => {
    const spec = findSpec(answers, q, i);
    const letters = lettersOf(spec, q);
    const type = q.typeName || q.type || '';
    lines.push(`### ${q.index}. ${type ? `【${type}】` : ''}${(q.stem || '').trim() || '(无题干)'}`);
    lines.push('');
    const isChoice = /单选|多选|判断/.test(type) || (q.options || []).length > 0;
    if (isChoice && (q.options || []).length) {
      const chosen = new Set((letters || []).filter(x => /^[A-Z]$/.test(x)));
      for (const o of q.options) {
        const mark = chosen.has(String(o.letter).toUpperCase()) ? 'x' : ' ';
        lines.push(`- [${mark}] **${o.letter}.** ${o.text}`);
      }
      lines.push('');
      lines.push(`**答案：${(letters || []).filter(x => /^[A-Z]$/.test(x)).join(' ') || '（未得出）'}**`);
    } else {
      lines.push(`**答案：** ${letters ? letters.join('') : '（未得出）'}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}

/** 文件名安全的简短标题 */
export function safeName(s, fallback = 'paper') {
  const t = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return t || fallback;
}
