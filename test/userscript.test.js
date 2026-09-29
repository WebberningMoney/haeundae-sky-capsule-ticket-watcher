'use strict';
/**
 * 使用者腳本（Tampermonkey 版）與小工具腳本的檢查。
 * 目的：確保 userscript/ 底下那份「自動產生」的檔案永遠和 watcher.js 同步，
 * 不會發生「改了 watcher.js 卻忘了更新使用者腳本」而讓用 Tampermonkey 的人拿到舊版。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { build, OUT } = require('../scripts/build-userscript.js');

const ROOT = path.join(__dirname, '..');
const OLD_HEADER = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\r?\n/;

test('userscript 產出檔與 watcher.js 同步（改了 watcher.js 要執行 npm run build:userscript）', () => {
  assert.ok(fs.existsSync(OUT), '找不到 userscript 檔，請執行 npm run build:userscript');
  assert.equal(fs.readFileSync(OUT, 'utf8'), build(), 'userscript 已過期，請執行 npm run build:userscript 後一起 commit');
});

test('userscript 標頭：只在訂票頁啟動、不在 iframe 裡啟動、不自動更新、不需要特殊權限', () => {
  const head = fs.readFileSync(OUT, 'utf8').match(OLD_HEADER)[0];
  assert.match(head, /@match\s+https:\/\/www\.tbluelinepark\.com\/ticket_chn\/GD\d+\*/);
  assert.match(head, /@noframes/);
  assert.match(head, /@grant\s+none/);
  assert.match(head, /@updateURL\s+none/);
  assert.match(head, /@downloadURL\s+none/);
  assert.match(head, /@run-at\s+document-idle/);
  const { version } = require('../package.json');
  assert.match(head, new RegExp(`@version\\s+${version.replace(/\./g, '\\.')}`), '@version 要和 package.json 一致');
});

test('userscript 本體 ＝ watcher.js 去掉舊標頭（沒有多餘或遺漏的程式碼）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'watcher.js'), 'utf8');
  const us = fs.readFileSync(OUT, 'utf8');
  const body = src.replace(OLD_HEADER, '');
  assert.ok(us.endsWith(body), '本體和 watcher.js 不一致');
});

test('watcher.js 自己的標頭版本也要跟 package.json 一致', () => {
  const src = fs.readFileSync(path.join(ROOT, 'watcher.js'), 'utf8');
  const { version } = require('../package.json');
  assert.match(src.match(OLD_HEADER)[0], new RegExp(`@version\\s+${version.replace(/\./g, '\\.')}`));
});

test('userscript 能被 JavaScript 引擎解析', () => {
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(OUT, 'utf8'), { filename: 'userscript.user.js' }));
});

test('重開 Chrome 小工具（macOS）：bash 語法正確、有執行權限、內容符合說明', { skip: process.platform === 'win32' }, () => {
  const f = path.join(ROOT, 'scripts', 'restart-chrome.command');
  const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(f).mode & 0o111, '需要可執行權限（chmod +x）');
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /osascript -e 'tell application "Google Chrome" to quit'/);
  assert.match(text, /open -a "Google Chrome"/);
  // 刻意不做：不清 Cookie、不刪資料夾、不強制殺程序、不由監控程式自動觸發
  assert.doesNotMatch(text, /rm\s+-rf|killall|kill\s+-9|pkill|Cookies|defaults\s+delete/);
});

test('監控程式本體不會呼叫重開 Chrome 的工具（刻意不做「被限流就自動重開」）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'watcher.js'), 'utf8');
  assert.doesNotMatch(src, /restart-chrome|osascript|taskkill|child_process/);
});
