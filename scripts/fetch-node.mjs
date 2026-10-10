#!/usr/bin/env node
/**
 * 下载便携版 node.exe（Windows）到指定平台的 runtime/ 目录。
 *   node scripts/fetch-node.mjs mooc
 *   node scripts/fetch-node.mjs chaoxing --version v22.14.0
 *
 * 不把这个 80MB 的二进制提交进仓库，用这个脚本按需拉取。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const platform = argv.find(a => !a.startsWith('--'));
const vi = argv.indexOf('--version');
const VERSION = vi >= 0 ? argv[vi + 1] : 'v22.14.0';

if (!platform) {
  console.error('用法：node scripts/fetch-node.mjs <mooc|chaoxing> [--version v22.14.0]');
  process.exit(1);
}
const dir = path.join(ROOT, 'platforms', platform, 'runtime');
const out = path.join(dir, 'node.exe');
if (fs.existsSync(out)) {
  console.log('已经存在：' + out);
  process.exit(0);
}
fs.mkdirSync(dir, {recursive: true});

const url = `https://nodejs.org/dist/${VERSION}/win-x64/node.exe`;
console.log(`下载 ${url}`);
const res = await fetch(url);
if (!res.ok) { console.error('下载失败 HTTP ' + res.status); process.exit(1); }
const total = Number(res.headers.get('content-length') || 0);
const chunks = [];
let got = 0, lastPct = -1;
for await (const chunk of res.body) {
  chunks.push(chunk);
  got += chunk.length;
  if (total) {
    const pct = Math.floor(got / total * 100);
    if (pct !== lastPct && pct % 10 === 0) { process.stdout.write(`  ${pct}%\r`); lastPct = pct; }
  }
}
const buf = Buffer.concat(chunks);
if (total && buf.length !== total) {
  console.error(`\n下载不完整：${buf.length}/${total} 字节，请重试`);
  process.exit(1);
}
fs.writeFileSync(out, buf);
console.log(`\n✅ 已写入 ${out}（${(buf.length / 1048576).toFixed(1)} MB）`);
console.log('   现在双击该平台的 启动.bat 就能免装 Node 运行。');
