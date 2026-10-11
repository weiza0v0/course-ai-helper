/**
 * 真实模型端到端验证（会真的调 API，消耗 token）
 *
 *   node test/real-test.mjs --paper examples/questions.json [--expect examples/expected.json]
 *
 * 直接调用 lib/agent.mjs（不经过任何服务）。模型 / Key / 思考强度取自 config.toml，
 * 可用环境变量临时覆盖：API_BASE / DEEPSEEK_API_KEY / MODEL / REASONING / CONCURRENCY。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../lib/config.mjs';
import {solvePaper} from '../lib/agent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };

const paperPath = arg('paper');
if (!paperPath) { console.error('用法：node test/real-test.mjs --paper questions.json [--expect expected.json]'); process.exit(1); }
const paper = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
const expect = arg('expect') ? JSON.parse(fs.readFileSync(arg('expect'), 'utf8')) : null;

const {config} = loadConfig(ROOT, process.env.CONFIG_FILE || '');
const settings = {
  baseUrl: process.env.API_BASE || config.model.base_url,
  apiKey: process.env.DEEPSEEK_API_KEY || config.model.api_key,
  model: process.env.MODEL || config.model.model,
  temperature: config.model.temperature,
  concurrency: Number(process.env.CONCURRENCY || config.model.concurrency),
  maxRounds: config.model.max_tool_rounds,
  useTools: config.model.use_tools,
  reasoningEffort: process.env.REASONING || config.model.reasoning_effort,
  timeoutSeconds: config.model.timeout_seconds,
  maxRetries: config.model.max_retries,
};
if (!settings.apiKey) { console.error('config.toml 里没填 api_key'); process.exit(1); }

console.log(`\n真实模型验证：${paper.questions.length} 题 · ${settings.model} · 思考 ${settings.reasoningEffort} · 并发 ${settings.concurrency}\n${'='.repeat(64)}`);

let tools = 0, thinks = 0;
const t0 = Date.now();
const {answers, results} = await solvePaper({
  paper, settings,
  onEvent(ev) {
    if (ev.type === 'tool') tools++;
    if (ev.type === 'think') thinks++;
    if (ev.type === 'answer') {
      const a = Array.isArray(ev.answer) ? ev.answer.join('') : String(ev.answer ?? '');
      console.log(`  ${String(ev.index).padStart(2)}  ${(ev.typeName || '').padEnd(4)} → ${a}`);
    }
    if (ev.type === 'warn' && !/工具轮数/.test(ev.message)) console.log('     ⚠ ' + ev.message.slice(0, 100));
  },
});
const ms = Date.now() - t0;

// 判定对照：期望值可能是字母（单选/多选），也可能是**选项文字**（判断题顺序随机，只能按文字判）
const letters = v => (Array.isArray(v) ? v.join('') : String(v ?? '')).toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean);
const textOfLetters = (q, v) => letters(v)
  .map(l => ((q.options || []).find(o => String(o.letter).toUpperCase() === l) || {}).text || l)
  .sort().join('|');
function isRight(q, got, want) {
  const wRaw = String(Array.isArray(want) ? want.join('') : (want ?? '')).trim();
  if (!wRaw) return false;
  if (/^[A-Za-z]+$/.test(wRaw)) return letters(got).join('') === wRaw.toUpperCase();   // 期望是字母
  const wantTexts = wRaw.split(/[;；,，|\s]+/).filter(Boolean).sort().join('|');       // 期望是文字
  return textOfLetters(q, got) === wantTexts;
}

let right = 0, wrong = 0;
if (expect) {
  console.log('\n' + '─'.repeat(64));
  for (const q of paper.questions) {
    const got = answers[q.qid];
    const g = (Array.isArray(got) ? got.join('') : String(got ?? '')) || '—';
    const want = expect[q.qid];
    const okk = isRight(q, got, want);
    okk ? right++ : wrong++;
    const shown = /^[A-Za-z]+$/.test(String(want).trim()) ? g : `${g}（${textOfLetters(q, got)}）`;
    console.log(`  ${okk ? '✅' : '❌'} ${String(q.index).padStart(2)}. 得到 ${shown.padEnd(18)} 期望 ${want}`);
  }
}
console.log('─'.repeat(64));
console.log(`耗时 ${(ms / 1000).toFixed(1)}s · 工具调用 ${tools} 次 · 思考片段 ${thinks} 段` + (expect ? ` · 正确 ${right} / 错误 ${wrong}` : ''));
process.exitCode = expect && wrong ? 1 : 0;
