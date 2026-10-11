/**
 * 平台注册表 —— 扫描 platforms/<id>/index.mjs，统一加载。
 *
 * 一个服务同时支持多个平台，用户在网页上切换，不用为每个平台分发一份程序。
 * 每个平台模块导出：
 *   id, name, mode('script'|'cdp'), platformHint, allowOriginRe,
 *   helperFile(可选), helperHint(可选), readOnly(可选),
 *   readPaper(session)/diagnose(session)（mode='cdp' 时提供）
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function loadPlatforms(rootDir) {
  const dir = path.join(rootDir, 'platforms');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'index.mjs');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      if (!mod.id || !mod.name) { console.warn(`  ⚠ 跳过 platforms/${name}：缺少 id/name 导出`); continue; }
      out.push({...mod, dir: path.join(dir, name), dirName: name});
    } catch (e) {
      console.warn(`  ⚠ 加载 platforms/${name} 失败：${e.message}`);
    }
  }
  return out;
}

/** 给前端用的精简信息 */
export function publicPlatform(p) {
  return {
    id: p.id, name: p.name, mode: p.mode || 'script',
    platformHint: p.platformHint || '', helperHint: p.helperHint || '',
    readOnly: !!p.readOnly, hasHelper: !!p.helperFile,
    hint: p.platformHint || '',
  };
}
