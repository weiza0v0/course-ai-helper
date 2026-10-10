#!/usr/bin/env node
/**
 * 打包成可分发 zip：node scripts/package.mjs [mooc|chaoxing|all]
 * 产物在 dist/ 下，解压后双击 启动.bat 即可（若已用 fetch-node.mjs 拉过 node.exe 则免装 Node）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const which = args[0] || 'all';
const platforms = fs.readdirSync(path.join(ROOT, 'platforms'))
  .filter(p => fs.statSync(path.join(ROOT, 'platforms', p)).isDirectory());
const targets = which === 'all' ? platforms : [which];

const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, {recursive: true});

function rmrf(p) { fs.rmSync(p, {recursive: true, force: true}); }
function copy(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d);
    else fs.copyFileSync(s, d);
  }
}

for (const p of targets) {
  const src = path.join(ROOT, 'platforms', p);
  if (!fs.existsSync(src)) { console.error('没有这个平台：' + p); continue; }
  const stage = path.join(DIST, p);
  rmrf(stage);
  copy(src, stage);
  // 没有 config.toml 就用 example 顶一个（用户解压后直接改）
  const cfg = path.join(stage, 'config.toml');
  const example = path.join(stage, 'config.example.toml');
  if (!fs.existsSync(cfg) && fs.existsSync(example)) {
    fs.copyFileSync(example, cfg);
    // 首次运行 server.mjs 会自动生成带注释的 config.toml，这里放 example 只是省一步
  }
  fs.rmSync(path.join(stage, 'data'), {recursive: true, force: true});
  fs.mkdirSync(path.join(stage, 'data'), {recursive: true});

  const zip = path.join(DIST, `${p}.zip`);
  rmrf(zip);
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`]);
    } else {
      execFileSync('zip', ['-qr', zip, '.'], {cwd: stage});
    }
    console.log(`✅ ${zip}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`);
  } catch (e) {
    console.error(`打包 ${p} 失败（stage 目录保留在 dist/${p}）：` + e.message);
  }
}
