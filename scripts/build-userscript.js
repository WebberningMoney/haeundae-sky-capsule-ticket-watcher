'use strict';
/**
 * 由 watcher.js 產生「可直接安裝到 Tampermonkey／Violentmonkey 的使用者腳本」。
 *
 * 為什麼要另外產生一份，而不是直接用 watcher.js？
 *   - Tampermonkey 只有在網址以 .user.js 結尾時，才會跳出「安裝」頁（點一下連結就能裝）。
 *   - watcher.js 的標頭是給「通用」用的（@match 涵蓋所有 /ticket_chn/ 頁面）；這一份收窄到這個商品頁，
 *     並加上 @noframes（不要在腳本自己建立的隱藏 iframe 裡再啟動一份）與「不自動更新」。
 *
 * 用法：
 *   npm run build:userscript        # 重新產生 userscript/haeundae-sky-capsule-ticket-watcher.user.js
 * 改了 watcher.js 之後一定要重跑；test/userscript.test.js 會檢查兩者是否同步，忘了跑測試會失敗。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'userscript', 'haeundae-sky-capsule-ticket-watcher.user.js');
const OLD_HEADER = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\r?\n/;

/** 產生使用者腳本的完整文字（純函式，方便測試）。 */
function build() {
  const src = fs.readFileSync(path.join(ROOT, 'watcher.js'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!OLD_HEADER.test(src)) throw new Error('watcher.js 開頭找不到 ==UserScript== 標頭');
  const body = src.replace(OLD_HEADER, '');
  const header = [
    '// ==UserScript==',
    '// @name         haeundae-sky-capsule-ticket-watcher',
    '// @namespace    https://github.com/WebberningMoney/haeundae-sky-capsule-ticket-watcher',
    `// @version      ${version}`,
    '// @description  訂票頁有票監控（只監看，不下單）。開啟訂票頁就自動啟動，Chrome 重開後也會自動接續。',
    '// @match        https://www.tbluelinepark.com/ticket_chn/GD2100036*',
    '// @run-at       document-idle',
    '// @noframes',
    '// @grant        none',
    '// @updateURL    none',
    '// @downloadURL  none',
    '// ==/UserScript==',
    '',
    '// ⚠ 這個檔案由 scripts/build-userscript.js 自動產生，請不要直接改動作邏輯；要改請改 watcher.js 再重新產生。',
    '// 你可以改的只有下面「設定區」的 month / days（要監看幾月幾號）與上面的 @match（要在哪個網址啟動）。',
    '// @updateURL / @downloadURL 設為 none：不會自動更新，避免程式被悄悄換掉，也避免你改好的設定被覆蓋。',
    '',
  ].join('\n');
  return header + body;
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, build());
  console.log(`已產生 ${path.relative(ROOT, OUT)}`);
}

module.exports = { build, OUT };
