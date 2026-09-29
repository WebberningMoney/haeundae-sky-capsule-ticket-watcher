'use strict';
/**
 * 文件檢查：README 與 docs/ 裡所有「站內連結」都要有效（檔案存在、標題錨點存在）。
 * README 拆成多份文件後，最容易發生的就是改了標題或搬了段落，連結卻沒跟著改。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

/** GitHub 的標題錨點規則：轉小寫、去掉標點（保留字母數字底線連字號空白）、空白變連字號；重複的加 -1、-2。 */
function anchorsOf(md) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    let s = m[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
    const n = seen.get(s) || 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
}

function linksOf(md) {
  const links = [];
  let fence = false;
  md.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const noCode = line.replace(/`[^`]*`/g, '');
    for (const m of noCode.matchAll(/\]\(([^)\s]+)\)/g)) links.push({ target: m[1], line: i + 1 });
  });
  return links;
}

for (const file of FILES) {
  test(`文件連結有效：${file}`, () => {
    const md = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const problems = [];
    for (const { target, line } of linksOf(md)) {
      if (/^(https?:|mailto:)/i.test(target)) continue;
      const [p, anchor] = target.split('#');
      const abs = p ? path.join(ROOT, path.dirname(file), p) : path.join(ROOT, file);
      if (!fs.existsSync(abs)) { problems.push(`${file}:${line} 找不到檔案 ${target}`); continue; }
      if (anchor && abs.endsWith('.md')) {
        const decoded = decodeURIComponent(anchor);
        if (!anchorsOf(fs.readFileSync(abs, 'utf8')).has(decoded)) problems.push(`${file}:${line} 找不到標題錨點 ${target}`);
      }
    }
    assert.deepEqual(problems, []);
  });
}

test('README 保持精簡（詳細內容放在 docs/），避免又長成一大篇', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n').length;
  assert.ok(lines <= 200, `README 有 ${lines} 行，超過 200 行；請把細節移到 docs/`);
});
