/**
 * 真实模型端到端验证（会真的调 API，消耗 token）
 *
 *   node test/real-test.mjs --paper examples/questions.json [--expect examples/expected.json]
 *
 * 默认直接使用项目里的 config.toml（模型 / Key / 思考强度都在那儿配）。
 * 想临时覆盖：API_BASE / DEEPSEEK_API_KEY / MODEL / REASONING / CONCURRENCY 环境变量。
 */
import {spawn} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };

const paperPath = arg('paper');
if (!paperPath) { console.error('用法：node test/real-test.mjs --paper questions.json [--expect expected.json]'); process.exit(1); }
const paper = JSON.parse(fs.readFileSync(paperPath, 'utf8'));
const expect = arg('expect') ? JSON.parse(fs.readFileSync(arg('expect'), 'utf8')) : null;

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT, env: {...process.env, PORT: String(port), NO_OPEN: '1'}, stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await (await fetch(BASE + '/api/health')).json()).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 250));
}

const cfg = (await (await fetch(BASE + '/api/config')).json()).config;
const settings = {};
if (process.env.API_BASE) settings.baseUrl = process.env.API_BASE;
if (process.env.DEEPSEEK_API_KEY) settings.apiKey = process.env.DEEPSEEK_API_KEY;
if (process.env.MODEL) settings.model = process.env.MODEL;
if (process.env.REASONING) settings.reasoningEffort = process.env.REASONING;
if (process.env.CONCURRENCY) settings.concurrency = Number(process.env.CONCURRENCY);

console.log(`\n真实模型验证：${paper.questions.length} 题 · ${settings.model || cfg.model.model} · 思考 ${settings.reasoningEffort || cfg.model.reasoning_effort} · 并发 ${settings.concurrency || cfg.model.concurrency}\n${'='.repeat(64)}`);

const t0 = Date.now();
const res = await fetch(BASE + '/api/solve', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({paper, settings}),
});
if (!res.ok || !res.body) {
  console.error('请求失败：', res.status, await res.text().catch(() => ''));
  srv.kill('SIGKILL');
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const events = [];
let tools = 0, thinks = 0;
while (true) {
  const {done, value} = await reader.read();
  if (done) break;
  buf += dec.decode(value, {stream: true});
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    events.push(ev);
    if (ev.type === 'tool') { tools++; process.stdout.write(`  🔧 第${ev.index}题 ${ev.name}(${JSON.stringify(ev.args).slice(0, 68)})\n`); }
    if (ev.type === 'think') thinks++;
    if (ev.type === 'progress') process.stdout.write(`  … ${ev.done}/${ev.total}（工具 ${tools} 次，思考 ${thinks} 段）\n`);
    if (ev.type === 'fatal') console.error('  致命错误：' + ev.message);
  }
}

const byQid = new Map();
for (const e of events) if (e.type === 'answer') byQid.set(e.qid, e);
const toolCount = new Map();
for (const e of events) if (e.type === 'tool') toolCount.set(e.qid, (toolCount.get(e.qid) || 0) + 1);

/** 把「A/B」和「正确/错误」统一，避免判断题比对假阴性 */
function normalize(v, q) {
  let s = String(v == null ? '' : v).trim().toUpperCase();
  if (/^[A-H]$/.test(s)) {
    const o = (q.options || [])[s.charCodeAt(0) - 65];
    const t = o ? String(o.text || '') : '';
    if (/正确/.test(t)) return '正确';
    if (/错误/.test(t)) return '错误';
  }
  if (/^(对|是|T|TRUE|√|YES|Y)$/.test(s)) return '正确';
  if (/^(错|否|F|FALSE|×|X|NO|N)$/.test(s)) return '错误';
  return s;
}

console.log('\n' + '='.repeat(64));
let right = 0, wrong = 0;
for (const q of paper.questions) {
  const a = byQid.get(q.qid);
  const got = a ? a.answer : '(无)';
  let mark = '';
  if (expect) {
    const want = String(expect[q.qid] != null ? expect[q.qid] : expect[q.index] || '');
    const same = normalize(got, q) === normalize(want, q);
    same ? right++ : wrong++;
    mark = same ? ' ✅' : ` ❌ 期望 ${want}`;
  }
  console.log(`  ${String(q.index).padStart(2)}. ${q.typeName}\t→ ${String(got).padEnd(6)} 工具${toolCount.get(q.qid) || 0}次  置信${a && a.confidence != null ? a.confidence : '-'}${mark}`);
  if (a && a.reason) console.log(`      ${String(a.reason).replace(/\s+/g, ' ').slice(0, 96)}`);
}
console.log('='.repeat(64));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 工具调用 ${tools} 次 · 思考片段 ${thinks} 段` + (expect ? ` · 正确 ${right} / 错误 ${wrong}` : ''));
srv.kill('SIGKILL');
process.exitCode = wrong ? 1 : 0;
