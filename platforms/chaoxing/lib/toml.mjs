/**
 * 极简 TOML 解析/生成（零依赖）
 * 支持：注释 #、[section]、[a.b] 嵌套、字符串（基本/字面量）、整数、浮点、布尔、数组（可多行）
 * 够配置文件用；不支持日期、内联表、表数组等高级语法。
 */

function stripComment(line) {
  let inS = false, inD = false, out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && (inS || inD)) { out += c + (line[++i] || ''); continue; }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) break;
    out += c;
  }
  return out;
}

function splitTopLevel(s, sep = ',') {
  const parts = [];
  let depth = 0, inS = false, inD = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inS || inD)) { cur += c + (s[++i] || ''); continue; }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '' || parts.length) parts.push(cur);
  return parts;
}

function balancedBrackets(s) {
  let depth = 0, inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inS || inD)) { i++; continue; }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === '[') depth++;
      else if (c === ']') depth--;
    }
  }
  return depth <= 0;
}

function parseValue(v) {
  const s = v.trim();
  if (s === '') return '';
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'")) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[')) {
    const inner = s.replace(/^\[/, '').replace(/\]$/, '');
    return splitTopLevel(inner).map(x => x.trim()).filter(x => x !== '').map(parseValue);
  }
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  return s; // 宽松：裸词当字符串
}

function ensurePath(root, keys) {
  let cur = root;
  for (const k of keys) {
    if (!k) continue;
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const sec = line.match(/^\[\[?\s*([^\]]+?)\s*\]?\]$/);
    if (sec) {
      const keys = sec[1].split('.').map(k => k.trim().replace(/^["']|["']$/g, ''));
      cur = ensurePath(root, keys);
      continue;
    }
    const m = line.match(/^([^=]+?)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    const key = m[1].trim().replace(/^["']|["']$/g, '');
    let raw = m[2].trim();
    while (raw.startsWith('[') && !balancedBrackets(raw) && i + 1 < lines.length) {
      raw += ' ' + stripComment(lines[++i]).trim();
    }
    cur[key] = parseValue(raw);
  }
  return root;
}

/** 生成一段带注释的 TOML 文本（仅用于首次运行生成模板） */
export function stringifyToml(obj, header = '') {
  const out = [];
  if (header) out.push(header.trimEnd(), '');
  const scalars = [], tables = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) tables.push([k, v]);
    else scalars.push([k, v]);
  }
  const fmt = v => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(fmt).join(', ') + ']';
    return String(v);
  };
  for (const [k, v] of scalars) out.push(`${k} = ${fmt(v)}`);
  for (const [name, tbl] of tables) {
    out.push('', `[${name}]`);
    for (const [k, v] of Object.entries(tbl)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) continue;
      out.push(`${k} = ${fmt(v)}`);
    }
  }
  return out.join('\n') + '\n';
}
