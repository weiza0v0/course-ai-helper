#!/usr/bin/env node
/**
 * 共享核心同步：把 platforms/mooc 里的通用部分同步到其它平台，避免多份核心代码跑偏。
 *
 *   node scripts/sync-core.mjs            # 同步
 *   node scripts/sync-core.mjs --check    # 只检查是否一致（CI 用，不一致退出码 1）
 *
 * 为什么不用 monorepo 的 workspace：每个平台目录要能"拷走一个文件夹 + 一个 node.exe 就能跑"，
 * 所以核心在每个平台里都留了一份实物。这个脚本保证它们始终一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANON = 'mooc';                 // 以哪个平台为准
const SHARED = [
  'lib',
  'public',
  'server.mjs',
  'test/math-ref.py',
  'test/math-ref.json',
  'test/math-test.mjs',
  'test/mock-llm.mjs',
  'test/real-test.mjs',
  'test/fill-test.html',
];
const SKIP_PLATFORM = ['mooc', 'chaoxing'];

const check = process.argv.includes('--check');
const platforms = fs.readdirSync(path.join(ROOT, 'platforms'))
  .filter(p => fs.statSync(path.join(ROOT, 'platforms', p)).isDirectory());
const targets = platforms.filter(p => !SKIP_PLATFORM.includes(p));

let differs = 0, copied = 0;
function syncItem(rel, platform) {
  const src = path.join(ROOT, 'platforms', CANON, rel);
  const dst = path.join(ROOT, 'platforms', platform, rel);
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(src)) syncItem(path.join(rel, f), platform);
    return;
  }
  const a = fs.readFileSync(src);
  const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (b && Buffer.compare(a, b) === 0) return;
  differs++;
  if (check) {
    console.log(`  ✗ ${platform}/${rel} 与 ${CANON}/${rel} 不一致`);
  } else {
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.writeFileSync(dst, a);
    copied++;
    console.log(`  → 已同步 ${platform}/${rel}`);
  }
}

console.log(`\n共享核心同步（基准：platforms/${CANON}）`);
for (const rel of SHARED) for (const p of targets) syncItem(rel, p);

if (check) {
  console.log(differs ? `\n  有 ${differs} 处不一致，请运行 node scripts/sync-core.mjs\n` : '  ✅ 全部一致\n');
  process.exitCode = differs ? 1 : 0;
} else {
  console.log(copied ? `\n  ✅ 同步了 ${copied} 个文件\n` : '  ✅ 本来就一致\n');
}
