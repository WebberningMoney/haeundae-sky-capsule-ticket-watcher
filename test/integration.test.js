'use strict';
/**
 * 整合測試：在「假瀏覽器環境」（見 fake-env.js）裡跑完整的 watcher.js。
 * 不連網、不開瀏覽器；每個情境都是真實使用中遇過、或可能遇到的狀況。
 * 執行： npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, Core } = require('./fake-env.js');

const PATH = '/ticket_chn/GD0000001';
const T = { timeout: 20_000 };

/** 每個情境獨立一個環境，結束一定 stop()，避免計時器殘留。 */
function scenario(name, envOpts, fn) {
  test(name, T, async () => {
    const env = createEnv(envOpts);
    try {
      await fn(env);
    } finally {
      env.stop();
      await env.sleep(40);
    }
  });
}
const hitNotifications = (env) => env.notifications.filter((n) => n.title.includes('有票'));
const warnNotifications = (env) => env.notifications.filter((n) => n.title.includes('限流'));

// ============================================================ A. 基本流程
scenario('A1 基本流程：沒票時持續輪詢、沿用同一頁、間隔逐步縮短、不打擾', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 3, 5000, '完成 3 輪');
  assert.match(api.state.lastResult, /4天\/80筆, 全售罄/);
  assert.equal(env.pageLoads, 1, '預設沿用同一頁，不該每輪重載');
  assert.equal(env.requests.length >= 12, true);
  assert.deepEqual([...new Set(env.requests.map((r) => r.sdDate.slice(0, 6)))], ['202610'], '月份要自動切到 10 月');
  assert.deepEqual([...new Set(env.requests.map((r) => r.day))].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.equal(api.controller.interval, 100, '成功後休息時間縮到下限');
  assert.equal(env.notifications.length, 0);
  assert.equal(env.spoken.length, 0);
  assert.ok(api.log().some((l) => /資料來源:json/.test(l)));
});

scenario('A2 有票：只提醒「新出現」的；持續有票不重複；消失後再出現會再提醒', {}, async (env) => {
  env.tickets['20261011'] = [{ idx: 4, remain: 3 }];
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => hitNotifications(env).length >= 1, 5000, '第一次提醒');
  const n = hitNotifications(env)[0];
  assert.match(n.body, /10\/11 5班10:30-11:00 剩3/);
  assert.equal(n.requireInteraction, true, '系統通知要一直停留到使用者處理');
  assert.ok(env.beeps() >= 1, '要有提示音');
  assert.equal(env.spoken.length, 1, '語音只念一次');
  assert.match(env.doc.title, /有票/);
  assert.deepEqual(Object.keys(api.state.current), ['10/11']);
  assert.equal(api.state.history.length, 1);

  const c = api.state.cycle;
  await env.until(() => api.state.cycle >= c + 3, 5000, '再跑 3 輪');
  assert.equal(hitNotifications(env).length, 1, '票一直都在，不該重複提醒');

  env.tickets = {};
  await env.until(() => Object.keys(api.state.current).length === 0, 5000, '票消失');
  env.tickets['20261011'] = [{ idx: 4, remain: 2 }];
  await env.until(() => hitNotifications(env).length >= 2, 5000, '票再出現要再提醒');
  assert.equal(api.state.history.length, 2);
});

scenario('A3 備援：API 沒有 JSON 時改讀畫面文字，仍能偵測到票', {}, async (env) => {
  env.tickets['20261012'] = [{ idx: 0, remain: 5 }];
  env.responder = () => ({ noJson: true });
  const api = env.start({ month: 10, days: '12' });
  await env.until(() => hitNotifications(env).length >= 1, 5000, '從畫面文字偵測到票');
  assert.ok(api.log().some((l) => /資料來源:dom/.test(l)));
  assert.match(hitNotifications(env)[0].body, /10\/12 1班08:30-09:00 剩5/);
});

scenario('A4 備援：頁面根本沒有 jQuery 也能運作', {}, async (env) => {
  env.scenario.noJquery = true;
  env.tickets['20261010'] = [{ idx: 2, remain: 1 }];
  const api = env.start({ month: 10, days: '10' });
  await env.until(() => hitNotifications(env).length >= 1, 5000, '沒有 jQuery 仍偵測到票');
  assert.ok(api.log().some((l) => /資料來源:dom/.test(l)));
});

scenario('A5 某天沒有場次（200 + 空陣列）不算失敗', {}, async (env) => {
  env.responder = (c) => (c.day === 12 ? { rows: [] } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 2, 5000, '完成 2 輪');
  assert.equal(api.controller.fails, 0);
  assert.match(api.state.lastResult, /無場次:12/);
});

scenario('A6a 該月沒有的日期（例如 9 月沒有 31 號）會略過而不是報錯', {}, async (env) => {
  const api = env.start({ month: 9, days: '29-31' });
  await env.until(() => api.state.cycle >= 1, 5000, '完成 1 輪');
  assert.match(api.state.lastResult, /略過:31/);
  assert.deepEqual([...new Set(env.requests.map((r) => r.sdDate))].sort(), ['20260929', '20260930']);
  assert.equal(env.navClicks.next + env.navClicks.prev, 0, '目標月份就是目前顯示的月份，不該按任何按鈕');
});

scenario('A6b 目標日期一個都找不到 → 連續 3 次後停止並說明', {}, async (env) => {
  const api = env.start({ month: 9, days: '31' });
  await env.until(() => /已停止/.test(env.panel()), 8000, '停止');
  assert.match(env.panel(), /版面可能改版/);
  assert.equal(api.state.attempt, 3);
  assert.ok(api.log().some((l) => /\[layout\]/.test(l)));
});

for (const c of [
  { name: '往後 1 個月（9→10）', initial: { y: 2026, m: 9 }, month: 10, year: null, next: 1, prev: 0, prefix: '202610' },
  { name: '不用切換（9→9）', initial: { y: 2026, m: 9 }, month: 9, year: null, next: 0, prev: 0, prefix: '202609' },
  { name: '明確指定年份時可以往前切（2026/10→2026/9）', initial: { y: 2026, m: 10 }, month: 9, year: 2026, next: 0, prev: 1, prefix: '202609' },
  { name: '跨年（2026/11→2月 = 2027/2）', initial: { y: 2026, m: 11 }, month: 2, year: null, next: 3, prev: 0, prefix: '202702' },
]) {
  scenario(`A7 自動切換月份：${c.name}`, { initialMonth: c.initial }, async (env) => {
    const api = env.start({ month: c.month, year: c.year, days: '2' });
    await env.until(() => api.state.cycle >= 1, 5000, '完成 1 輪');
    assert.equal(env.navClicks.next, c.next, 'Next 次數');
    assert.equal(env.navClicks.prev, c.prev, 'Prev 次數');
    assert.equal(env.requests[0].sdDate, `${c.prefix}02`);
  });
}

scenario('A8 每 N 輪才重新載入頁面（reloadEvery）', {}, async (env) => {
  const api = env.start({ reloadEvery: 2 });
  await env.until(() => api.state.cycle >= 5, 8000, '完成 5 輪');
  assert.ok(env.pageLoads >= 3 && env.pageLoads <= 4, `頁面載入次數 ${env.pageLoads}`);
});

// ============================================================ B. 錯誤處理
scenario('B1 被限流（429）：不重載、暫停、發警示、只送 1 個試探請求、恢復後記錄', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.blockStart > 0, 5000, '偵測到限流');
  assert.equal(env.requests.length, 9);
  assert.equal(api.controller.interval, 200, '硬失敗要退回上一級');
  assert.equal(api.controller.lockedFloor, 200, '並鎖定下限');
  assert.match(api.state.notice, /被網站限流/);
  assert.ok(api.state.alerts.includes('요청실패'), '網站的 alert 要被攔截並記錄，而不是彈出來');
  assert.equal(warnNotifications(env).length, 1, '只發一次警示');
  assert.equal(hitNotifications(env).length, 0, '警示不能被當成有票');
  const before = env.requests.length;
  await env.sleep(150);
  assert.equal(env.requests.length, before, '暫停期間不能再送請求');
  await env.until(() => api.state.blocks.length === 1, 5000, '恢復');
  assert.equal(env.pageLoads, 1, '單純被限流不該重新載入頁面（會多送請求）');
  assert.equal(api.state.blockStart, 0);
  assert.ok(api.log().some((l) => /已恢復/.test(l)));
  assert.ok(api.state.cycle >= 3);
});

scenario('B1b 連續兩次 429（試探仍被擋）：只發一次警示，恢復後才記錄一波限流', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 || c.callNo === 10 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.blocks.length === 1, 8000, '恢復');
  assert.equal(warnNotifications(env).length, 1);
  assert.equal(api.state.blocks[0].minutes >= 0, true);
});

scenario('B2 伺服器指定 Retry-After 時要照做', {}, async (env) => {
  env.responder = (c) => (c.callNo === 5 ? { status: 429, headers: { 'Retry-After': '1' } } : {});
  const api = env.start({ blockedWaitMs: 50 });
  await env.until(() => api.state.blockStart > 0, 5000, '偵測到限流');
  assert.ok(api.state.nextAt - Date.now() >= 800, `要等到 Retry-After（約 1 秒），實際剩 ${api.state.nextAt - Date.now()}ms`);
});

scenario('B3 403 先當作 token 過期：重新載入頁面拿新 token，之後就恢復，不長時間暫停', {}, async (env) => {
  env.responder = (c) => (c.callNo === 5 ? { status: 403 } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 4, 8000, '恢復並繼續');
  assert.equal(env.pageLoads, 2, '403 後必須換新頁面（新 token）');
  assert.equal(api.state.blocks.length, 0, '單次 403 不該被當成長時間封鎖');
  assert.equal(warnNotifications(env).length, 0);
  assert.ok(api.log().some((l) => /\[blocked\]/.test(l)));
});

scenario('B4 換了新頁面仍連續 403 → 才當作真的被擋（暫停並警示）', {}, async (env) => {
  env.responder = (c) => (c.callNo === 5 || c.callNo === 6 ? { status: 403 } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.blockStart > 0, 8000, '判定為真的被擋');
  assert.equal(env.pageLoads, 2);
  assert.equal(warnNotifications(env).length, 1);
  await env.until(() => api.state.blocks.length === 1, 8000, '恢復');
});

scenario('B5 逾時（軟失敗）：間隔不變、不鎖下限、下一輪重新載入頁面', {}, async (env) => {
  env.responder = (c) => (c.callNo === 5 ? { noEvent: true } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.controller.fails >= 1, 5000, '逾時');
  assert.equal(api.controller.interval, 100);
  assert.equal(api.controller.lockedFloor, 100, '軟失敗不該鎖下限');
  assert.equal(api.state.blockStart, 0);
  await env.until(() => api.state.cycle >= 4, 8000, '恢復');
  assert.equal(env.pageLoads, 2, '逾時後要重新載入');
  assert.ok(api.log().some((l) => /\[timeout\]/.test(l)));
});

scenario('B6a 別天的回應（decoy）要被忽略，不能算成這一天的結果', {}, async (env) => {
  env.tickets['20261020'] = [{ idx: 0, remain: 9 }];
  env.responder = (c) => (c.callNo === 1 ? { decoys: ['20261020'] } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 2, 5000, '完成 2 輪');
  assert.equal(Object.keys(api.state.current).length, 0, '別天的資料不能算進這一天');
  assert.equal(env.notifications.length, 0);
});

scenario('B6b 回應內容的日期跟請求對不上 → 判為 stale（軟失敗）而不是照單全收', {}, async (env) => {
  env.tickets['20261099'] = [{ idx: 0, remain: 9 }];
  env.responder = (c) => (c.callNo === 1 ? { rows: env.makeRows('20261099') } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 8000, '之後恢復正常');
  assert.ok(api.log().some((l) => /\[stale\]/.test(l)));
  assert.equal(env.notifications.length, 0, '錯的資料不能觸發提醒');
});

scenario('B7 日曆標題讀不到（網站改版）連續 3 次 → 停止並用中文說明', {}, async (env) => {
  env.scenario.noHeader = true;
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => /已停止/.test(env.panel()), 8000, '停止');
  assert.match(env.panel(), /版面可能改版/);
  const attempts = api.state.attempt;
  await env.sleep(300);
  assert.equal(api.state.attempt, attempts, '停止後不能再嘗試');
  assert.equal(env.iframes().length, 0, '要清掉隱藏頁面');
});

scenario('B8 該月份尚未開放（按 Next 沒反應）：持續等待，不停止，開放後自動恢復', {}, async (env) => {
  env.scenario.nextInert = true;
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.attempt >= 3, 8000, '至少嘗試 3 次');
  assert.match(api.state.notice, /尚未開放/);
  assert.doesNotMatch(env.panel(), /已停止/);
  assert.equal(api.state.layoutFails, 0);
  env.scenario.nextInert = false; // 月份開放了
  await env.until(() => api.state.cycle >= 1, 8000, '開放後恢復');
  assert.equal(api.state.notice, '');
});

scenario('B9 頁面載不出來（硬失敗）：退回一級、鎖定下限，之後恢復', {}, async (env) => {
  env.scenario.loadFails = (id) => id === 1;
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 8000, '第二次載入成功');
  assert.ok(api.log().some((l) => /\[load\]/.test(l)));
  assert.ok(api.controller.lockedFloor >= 300);
});

scenario('B10 伺服器錯誤（500）：硬失敗，下一輪重新載入', {}, async (env) => {
  env.responder = (c) => (c.callNo === 5 ? { status: 500 } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 4, 8000, '恢復');
  assert.ok(api.log().some((l) => /\[server\]/.test(l)));
  assert.equal(env.pageLoads, 2);
});

// ============================================================ C. 提醒
const VOICES = [
  { name: 'Eddy (Chinese (Taiwan))', lang: 'zh-TW', localService: true },
  { name: 'Meijia', lang: 'zh-TW', localService: true },
  { name: 'Google 國語（臺灣）', lang: 'zh-TW', localService: false },
  { name: 'Sandy (Chinese (Taiwan))', lang: 'zh-TW', localService: true },
];

scenario('C1 通知權限：Notification.permission 說 denied、但 permissions.query 是 granted → 仍要送出通知（真實發生過的 bug）', {}, async (env) => {
  env.notifPermission = 'denied';
  env.permQuery = 'granted';
  env.tickets['20261010'] = [{ idx: 0, remain: 1 }];
  const api = env.start({ month: 10, days: '10' });
  await env.until(() => hitNotifications(env).length >= 1, 5000, '送出通知');
  assert.match(api.alerter.status(), /桌面通知：✅ 已開啟/);
});

scenario('C2 通知權限：真的被封鎖時不送、顯示怎麼處理；尚未允許時會去要求', {}, async (env) => {
  env.permQuery = 'denied';
  env.tickets['20261010'] = [{ idx: 0, remain: 1 }];
  const api = env.start({ month: 10, days: '10' });
  await env.until(() => api.state.cycle >= 2, 5000, '完成 2 輪');
  assert.equal(hitNotifications(env).length, 0);
  assert.match(api.alerter.status(), /桌面通知：❌ 被封鎖.*網址列左側/);
  await env.until(() => /🔔 桌面通知：❌ 被封鎖/.test(env.panel()), 3000, '面板顯示被封鎖'); // 面板每秒更新一次
  assert.ok(env.beeps() >= 1, '通知被封鎖時聲音仍要響');
});

scenario('C2b 尚未允許（prompt）：啟動時主動要求權限', {}, async (env) => {
  env.permQuery = 'prompt';
  env.notifPermission = 'default';
  const api = env.start({ month: 10, days: '10' });
  await env.until(() => env.requestPermissionCalls >= 1, 3000, '要求權限');
  assert.match(api.alerter.status(), /❓ 尚未允許/);
});

scenario('C3 語音：預設 Google 國語（臺灣），找不到就退回本機女聲，且絕不選男聲', { voices: VOICES }, async (env) => {
  const api = env.start({ month: 10, days: '10' });
  assert.equal(api.alerter.voiceName(), 'Google 國語（臺灣）');
  env.voices = VOICES.filter((v) => !/Google/.test(v.name));
  assert.equal(api.alerter.voiceName(), 'Meijia');
  env.voices = VOICES.filter((v) => !/Google|Meijia/.test(v.name));
  assert.equal(api.alerter.voiceName(), 'Sandy (Chinese (Taiwan))');
  env.voices = VOICES.filter((v) => /Eddy/.test(v.name));
  assert.equal(api.alerter.voiceName(), '(系統預設)', '只剩男聲時寧可用系統預設，也不選男聲');
  env.voices = VOICES;
  api.config.notify.voice.name = 'sandy';
  assert.equal(api.alerter.voiceName(), 'Sandy (Chinese (Taiwan))', '自行指定名稱（不分大小寫、部分比對）');
  api.config.notify.voice.name = null;
  assert.equal(api.alerter.voiceName(), 'Meijia', 'name=null 時本機女聲優先');
});

scenario('C4 語音：網路語音出錯（斷網）時自動改用本機女聲，只重試一次', { voices: VOICES }, async (env) => {
  const api = env.start({ month: 10, days: '10' });
  api.testAlert();
  assert.equal(env.spoken.length, 1);
  assert.equal(env.spoken[0].voice, 'Google 國語（臺灣）');
  assert.equal(env.spoken[0].rate, 0.92);
  assert.equal(env.spoken[0].pitch, 1.1);
  env.spoken[0].utterance.onerror({ error: 'canceled' });
  assert.equal(env.spoken.length, 1, '被取消不算錯誤，不重試');
  env.spoken[0].utterance.onerror({ error: 'network' });
  assert.equal(env.spoken.length, 2);
  assert.equal(env.spoken[1].voice, 'Meijia');
  env.spoken[1].utterance.onerror({ error: 'network' });
  assert.equal(env.spoken.length, 2, '備援也失敗時不再無限重試');
});

scenario('C5 聲音：Chrome 要求先點擊才能出聲；點擊後啟用，並停止吵人', {}, async (env) => {
  env.audioInitial = 'suspended';
  const api = env.start({ month: 10, days: '10' });
  assert.match(api.alerter.status(), /🔇 尚未啟用/);
  api.testAlert();
  assert.equal(env.beeps(), 0, '尚未啟用時不能響');
  assert.equal(api.alerter.isAlerting(), true);
  env.doc.dispatch('pointerdown');
  assert.match(api.alerter.status(), /提示音與語音：✅ 已啟用/);
  assert.equal(api.alerter.isAlerting(), false, '點擊代表使用者看到了，要停止提醒');
  api.testAlert();
  assert.ok(env.beeps() >= 1);
});

scenario('C6 標題：提醒時立刻改標題並閃爍，使用者確認後恢復；紅點會出現並復原', {}, async (env) => {
  const api = env.start({ month: 10, days: '10', notify: { alertDurationMs: 5000 } });
  api.testAlert();
  assert.match(env.doc.title, /^🎫有票!/, '提醒的瞬間標題就要變，不能等第一次閃爍');
  const seen = new Set();
  for (let i = 0; i < 5; i++) { seen.add(env.doc.title); await env.sleep(500); }
  assert.ok([...seen].some((t) => /🔔🔔 有票了/.test(t)), '之後要在兩種標題間閃爍');
  assert.ok(env.doc.head.all().some((e) => e.tagName === 'LINK'), '分頁圖示要換成紅點');
  env.doc.dispatch('click');
  assert.equal(api.alerter.isAlerting(), false);
  await env.until(() => !/有票/.test(env.doc.title), 2000, '標題恢復');
});

// ============================================================ D. 生命週期
const stateKey = (month, days) => `__tw:state:${Core.makeScope(PATH, month, null, days)}`;

scenario('D1 接續存檔：沿用上次學到的間隔與已通知過的票，不重複提醒', {}, async (env) => {
  env.tickets['20261011'] = [{ idx: 4, remain: 3 }];
  env.storage.set(stateKey(10, ['10', '11', '12', '13']), JSON.stringify({
    savedAt: Date.now() - 1000, lastOk: true, cycle: 7, interval: 300, lockedFloor: 200, stack: [600, 400], okAtFloor: 1,
    prev: ['10/11|5회차(10:30 ~ 11:00) 입장'],
  }));
  const api = env.start({ month: 10, days: '10-13' });
  assert.equal(api.controller.interval, 300);
  assert.equal(api.controller.lockedFloor, 200);
  assert.equal(api.state.cycle, 7);
  assert.notEqual(api.state.phase, '冷卻中', '中斷不久、上次成功：不需要冷卻');
  assert.ok(api.log().some((l) => /接續上次存檔/.test(l)));
  await env.until(() => api.state.cycle >= 9, 5000, '再跑 2 輪');
  assert.equal(hitNotifications(env).length, 0, '重啟前已通知過的票，不該再提醒一次');
  assert.deepEqual(Object.keys(api.state.current), ['10/11'], '但面板仍要顯示目前有票');
});

scenario('D2a 接續存檔：中斷太久 → 先冷卻，仍存在的票重新提醒一次', {}, async (env) => {
  env.tickets['20261011'] = [{ idx: 4, remain: 3 }];
  env.storage.set(stateKey(10, ['10', '11', '12', '13']), JSON.stringify({
    savedAt: Date.now() - 5000, lastOk: true, cycle: 3, interval: 300, lockedFloor: 100, stack: [],
    prev: ['10/11|5회차(10:30 ~ 11:00) 입장'],
  }));
  const api = env.start({ month: 10, days: '10-13', resume: { gapMs: 1000, cooldownMs: 150 } });
  assert.equal(api.state.phase, '冷卻中');
  assert.equal(env.requests.length, 0, '冷卻期間不能送請求');
  await env.until(() => hitNotifications(env).length >= 1, 5000, '冷卻後重新提醒');
});

scenario('D2b 接續存檔：上次以失敗收尾 → 先冷卻', {}, async (env) => {
  env.storage.set(stateKey(10, ['10', '11', '12', '13']), JSON.stringify({
    savedAt: Date.now() - 100, lastOk: false, cycle: 3, interval: 300, lockedFloor: 300, stack: [],
  }));
  const api = env.start({ month: 10, days: '10-13' });
  assert.equal(api.state.phase, '冷卻中');
});

scenario('D2c 接續存檔：不同日期範圍的存檔不會互相污染', {}, async (env) => {
  env.storage.set(stateKey(10, ['20', '21']), JSON.stringify({ savedAt: Date.now() - 100, lastOk: true, cycle: 99, interval: 900, lockedFloor: 900, stack: [] }));
  const api = env.start({ month: 10, days: '10-13' });
  assert.equal(api.state.cycle, 0);
  assert.equal(api.controller.interval, 200);
});

scenario('D2d 接續存檔：壞掉的存檔資料不會讓程式當機', {}, async (env) => {
  env.storage.set(stateKey(10, ['10', '11', '12', '13']), '{這不是 JSON');
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 5000, '仍能正常執行');
});

scenario('D3a 多分頁保護：已有分頁在監控 → 拒絕啟動並說明，不送任何請求', {}, async (env) => {
  env.setLock({ id: 'other-tab', t: Date.now() - 1000 });
  const api = env.start({ month: 10, days: '10-13' });
  assert.match(env.panel(), /無法啟動/);
  assert.match(env.panel(), /偵測到另一個分頁/);
  assert.match(env.panel(), /剩餘|約 \d+ 秒後會自動解除/);
  await env.sleep(150);
  assert.equal(env.pageLoads, 0);
  assert.equal(api.state.attempt, 0);
  assert.equal(env.getLock().id, 'other-tab', '不能動別人的鎖');
});

scenario('D3b 多分頁保護：殘留（超過 90 秒沒心跳）的鎖視為已失效；stop() 會釋放自己的鎖', {}, async (env) => {
  env.setLock({ id: 'dead-tab', t: Date.now() - 100_000 });
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 5000, '正常啟動');
  assert.notEqual(env.getLock().id, 'dead-tab');
  api.stop();
  assert.equal(env.getLock(), null);
});

scenario('D3c 多分頁保護：allowMultipleTabs=true 可以繞過', {}, async (env) => {
  env.setLock({ id: 'other-tab', t: Date.now() });
  const api = env.start({ month: 10, days: '10-13', allowMultipleTabs: true });
  await env.until(() => api.state.cycle >= 1, 5000, '仍可啟動');
});

scenario('D3d 重新整理／關閉分頁（pagehide）時主動釋放鎖', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => env.getLock(), 2000, '取得鎖');
  (env.winListeners.pagehide || []).forEach((h) => h());
  assert.equal(env.getLock(), null);
  assert.ok(api);
});

scenario('D4 重複啟動：新的會取代舊的，不會有兩個迴圈同時跑', {}, async (env) => {
  const api1 = env.start({ month: 10, days: '10-13' });
  await env.until(() => api1.state.cycle >= 1, 5000, '第一個跑起來');
  const api2 = env.start({ month: 10, days: '10-13' });
  const a1 = api1.state.attempt;
  await env.until(() => api2.state.cycle >= 2, 5000, '第二個跑起來');
  assert.ok(api1.state.attempt <= a1 + 1, '舊的必須停止');
  assert.equal(env.doc.all().filter((e) => e.id === '__ticket_watcher_panel').length, 1, '只能有一個面板');
});

scenario('D5 stop()：清乾淨（隱藏頁面、面板、鎖、螢幕喚醒、標題），且不再送請求', {}, async (env) => {
  env.tickets['20261010'] = [{ idx: 0, remain: 1 }];
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 5000, '跑起來');
  api.stop();
  assert.equal(env.iframes().length, 0);
  assert.equal(env.doc.getElementById('__ticket_watcher_panel'), null);
  assert.equal(env.getLock(), null);
  assert.equal(env.doc.title, '预订');
  assert.equal(env.wakeLocks.released, env.wakeLocks.requested);
  const n = env.requests.length;
  await env.sleep(400);
  assert.ok(env.requests.length <= n + 1, '停止後不能繼續送請求');
});

scenario('D6 設定錯誤：用中文說明原因，並且不送任何請求', {}, async (env) => {
  for (const [cfg, re] of [
    [{ days: '13-10' }, /寫反了/],
    [{ days: 'abc' }, /看不懂/],
    [{ days: '' }, /沒有填任何日期/],
    [{ days: '40' }, /1 到 31/],
    [{ month: 13 }, /1 到 12/],
    [{ month: 0 }, /1 到 12/],
  ]) {
    env.start(cfg);
    assert.match(env.panel(), /無法啟動/, JSON.stringify(cfg));
    assert.match(env.panel(), re, JSON.stringify(cfg));
    env.stop();
  }
  assert.equal(env.pageLoads, 0);
});

scenario('D7 貼在錯誤的頁面（找不到日曆）：中文提示', {}, async (env) => {
  env.mainPage.calendar.children = [];
  env.start({ month: 10, days: '10-13' });
  assert.match(env.panel(), /找不到日曆/);
  assert.equal(env.pageLoads, 0);
});

scenario('D8 匯出有票歷史（CSV）', {}, async (env) => {
  env.tickets['20261011'] = [{ idx: 4, remain: 3 }];
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.history.length >= 1, 5000, '有紀錄');
  api.exportHistory();
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].download, 'ticket-history.csv');
  const csv = env.blobs[env.blobs.length - 1].parts[0];
  assert.ok(csv.startsWith('﻿'), '加上 BOM，Excel 才不會亂碼');
  assert.match(csv, /"時間","日期","時段","剩餘"/);
  assert.match(csv, /"10\/11","5회차\(10:30 ~ 11:00\) 입장","3"/);
});

scenario('D9 保持螢幕喚醒：只在需要時才要求；瀏覽器自動釋放後切回分頁會重新取得；全程不洩漏', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => env.wakeLocks.requested >= 1, 2000, '取得喚醒鎖');
  await env.sleep(20);
  env.doc.dispatch('visibilitychange');
  await env.sleep(30);
  assert.equal(env.wakeLocks.requested, 1, '還握著就不該重複要求');
  env.wakeSentinels.forEach((s) => { s.released = true; }); // 模擬：分頁被隱藏，瀏覽器自動釋放
  env.doc.dispatch('visibilitychange');
  await env.until(() => env.wakeLocks.requested >= 2, 2000, '切回分頁後重新取得');
  await env.sleep(20);
  api.stop();
  assert.ok(env.wakeSentinels.every((s) => s.released), '停止後每一把鎖都要釋放，不能洩漏');
});

scenario('D9c 剛要求喚醒鎖就被 stop()：要求完成後立刻釋放，不洩漏', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  api.stop(); // 此時 request 還在等待中
  await env.sleep(50);
  assert.ok(env.wakeSentinels.every((s) => s.released));
});

scenario('D9b 瀏覽器不支援 Wake Lock 也不會出錯', { wakeLock: false }, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 5000, '正常運作');
});

scenario('D10 每輪結束都會存檔（供 Chrome 重啟後接續）', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 1, 5000, '跑完 1 輪');
  await env.until(() => env.storage.has(stateKey(10, ['10', '11', '12', '13'])), 2000, '有存檔');
  const saved = JSON.parse(env.storage.get(stateKey(10, ['10', '11', '12', '13'])));
  assert.equal(saved.lastOk, true);
  assert.equal(typeof saved.interval, 'number');
  assert.ok(Array.isArray(saved.prev));
});

scenario('D11 Worker 計時：可用時使用；建立失敗或中途出錯都會退回一般計時而不卡住', {}, async () => {
  // (a) 正常的 Worker
  class GoodWorker {
    postMessage(m) { setTimeout(() => this.onmessage && this.onmessage({ data: m.id }), m.ms); }
    terminate() {}
  }
  let env = createEnv({ Worker: GoodWorker });
  try {
    const api = env.start({ workerTimers: true });
    assert.ok(api.log().some((l) => /Worker 計時/.test(l)));
    await env.until(() => api.state.cycle >= 2, 5000, 'Worker 計時下正常運作');
  } finally { env.stop(); await env.sleep(40); }

  // (b) 建立就丟例外（例如被 CSP 擋住）
  class ThrowingWorker { constructor() { throw new Error('CSP'); } }
  env = createEnv({ Worker: ThrowingWorker });
  try {
    const api = env.start({ workerTimers: true });
    assert.ok(api.log().some((l) => /一般計時/.test(l)));
    await env.until(() => api.state.cycle >= 1, 5000, '退回一般計時仍能運作');
  } finally { env.stop(); await env.sleep(40); }

  // (c) 建立成功但之後發生錯誤：等待中的計時要被補完，不能永遠卡住
  class BrokenWorker {
    postMessage() { setTimeout(() => this.onerror && this.onerror({}), 1); }
    terminate() {}
  }
  env = createEnv({ Worker: BrokenWorker });
  try {
    const api = env.start({ workerTimers: true });
    await env.until(() => api.state.cycle >= 2, 8000, 'Worker 壞掉後仍能繼續');
  } finally { env.stop(); await env.sleep(40); }
});

scenario('D12 設定覆寫（window.ticketWatcherConfig）不會被原型污染攻擊', {}, async (env) => {
  const api = env.start(JSON.parse('{"__proto__": {"polluted": true}, "month": 10, "days": "10"}'));
  assert.equal(({}).polluted, undefined);
  assert.equal(api.config.month, 10);
});

scenario('E1 診斷：被限流時記下請求量與伺服器回應（標頭名稱／內容），供日後查根因', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429, headers: { 'Retry-After': '30', 'X-RateLimit-Remaining': '0' } } : {});
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.blockStart > 0, 5000, '偵測到限流');
  const d = api.diagnostics();
  assert.equal(d.lastDiag.status, 429);
  assert.equal(d.lastDiag.kind, 'rate_limit');
  assert.ok(d.lastDiag.headerNames.includes('retry-after'));
  assert.ok(d.lastDiag.headers.includes('retry-after=30'));
  assert.ok(d.lastDiag.headers.includes('x-ratelimit-remaining=0'));
  assert.match(d.lastDiag.body, /TOO_MANY_REQUESTS/);
  assert.equal(d.stats.total, env.requests.length, '請求計數要跟實際送出的一致');
  assert.equal(d.stats.pageLoads, 1);
  assert.ok(api.log().some((l) => /🔍 診斷\[rate_limit HTTP 429\].*時段查詢共 9 次/.test(l)));
  assert.ok(api.log().some((l) => /🔍 回應標頭名稱：.*retry-after/.test(l)));
});

scenario('E2 診斷：限流期間的試探次數與「沒有重開瀏覽器」會被記錄（用來驗證是否會自己解除）', {}, async (env) => {
  env.responder = (c) => (c.callNo >= 9 && c.callNo <= 11 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 100 });
  await env.until(() => api.state.blocks.length === 1, 10000, '自己恢復');
  const b = api.state.blocks[0];
  assert.equal(b.probes, 2, '第一次 429 之後又試探了 2 次仍被擋');
  assert.ok(api.log().some((l) => /試探仍被擋.*沒有重開瀏覽器/.test(l)));
  assert.ok(api.log().some((l) => /已恢復.*試探 2 次，沒有重開瀏覽器/.test(l)));
});

scenario('E3 面板顯示查詢預算（已用／上限）', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13' });
  await env.until(() => api.state.cycle >= 2, 5000, '跑 2 輪');
  // 上限寫多少跟著目前生效的預算走（預設值改過幾次，測試不該綁死某個數字）
  await env.until(() => new RegExp(`📊 查詢預算 \\d+/${api.state.budget}（近 30 分鐘）`).test(env.panel()), 3000, '面板有預算資訊');
});

// ============================================================ F. 查詢預算（滾動視窗）
scenario('F1 預算：任何一段視窗內送出的查詢都不超過上限，且輪詢仍持續進行', {}, async (env) => {
  const api = env.start({
    month: 10, days: '10-13', interval: { start: 20, step: 10, floor: 20, max: 200, probeAfterOk: 2 },
    budget: { windowMs: 400, maxCalls: 8, learnFactor: 0.7, min: 2, pace: false }, // 關掉平均分散，單獨測試「硬上限」
  });
  await env.until(() => api.state.cycle >= 4, 8000, '至少 4 輪');
  const phases = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 1200) { phases.add(api.state.phase); await env.sleep(10); }
  const ts = env.requests.map((r) => r.at);
  for (const t of ts) {
    const inWin = ts.filter((x) => x <= t && t - x < 400).length;
    assert.ok(inWin <= 8, `視窗內有 ${inWin} 個查詢，超過預算 8`);
  }
  assert.ok([...phases].some((p) => /節流等待/.test(p)) || api.log().some((l) => /查詢預算/.test(l)), '應該出現過節流等待');
});

scenario('F2 預算：被 429 時依窗口內的查詢量自動調降（只降不升）', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', budget: { windowMs: 60_000, maxCalls: 100, learnFactor: 0.5, min: 2 } });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  assert.equal(api.state.budget, 4, '9 個 × 0.5 → 4');
  assert.ok(api.log().some((l) => /📉.*預算調降：100 → 4/.test(l)));
});

scenario('F3 預算：maxCalls=null 表示不限制', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13', budget: { maxCalls: null } });
  await env.until(() => api.state.cycle >= 3, 5000, '跑 3 輪');
  assert.ok(!api.log().some((l) => /查詢預算/.test(l)));
  assert.match(env.panel(), /預算 \d+\/不限/);
});

scenario('F4 預算：存檔中學到的較低預算會被沿用；比設定更高的不會被採用', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  env.storage.set(key, JSON.stringify({ savedAt: Date.now() - 100, lastOk: true, cycle: 3, interval: 200, lockedFloor: 100, stack: [], budget: 60 }));
  let api = env.start({ month: 10, days: '10-13', budget: { maxCalls: 90 } });
  assert.equal(api.state.budget, 60);
  env.stop();
  env.storage.set(key, JSON.stringify({ savedAt: Date.now() - 100, lastOk: true, cycle: 3, interval: 200, lockedFloor: 100, stack: [], budget: 99999 }));
  api = env.start({ month: 10, days: '10-13', budget: { maxCalls: 90 } });
  assert.equal(api.state.budget, 90, '不能超過設定的上限');
});

scenario('F5 預算：重新貼程式／重新整理後，最近送過的查詢仍計入預算（不會歸零）', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  const now = Date.now();
  const calls = Array.from({ length: 88 }, (_, i) => now - 60_000 + i); // 1 分鐘內已送 88 個（預算 90）
  env.storage.set(key, JSON.stringify({ savedAt: now - 100, lastOk: true, cycle: 3, interval: 200, lockedFloor: 100, stack: [], budget: 90, calls }));
  const api = env.start({ month: 10, days: '10-13', budget: { maxCalls: 90 } });
  await env.sleep(300);
  assert.equal(env.requests.length, 0, '預算幾乎用完，不能馬上再送 4 個');
  assert.match(api.state.phase, /節流等待/);
  assert.ok(api.log().some((l) => /⏳ 為避免超過查詢預算/.test(l)));
});

scenario('F6 預算：過期或不合理的舊紀錄不會被還原', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  const now = Date.now();
  env.storage.set(key, JSON.stringify({ savedAt: now - 100, lastOk: true, cycle: 3, interval: 200, lockedFloor: 100, stack: [], budget: 150,
    calls: [now - 3 * 3600_000, now + 999_999, 'x', null, now - 1000] }));
  const api = env.start({ month: 10, days: '10-13' });
  assert.equal(api.state.reqLog.length, 1, '只留下合理的那一筆');
});

// ============================================================ G. 限流期間的試探
scenario('G1 限流期間的試探不受「查詢預算」限制（真實發生過：預算被調降後試探被無限期往後推）', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  // learnFactor 極小 → 預算被調到 2，但窗口內已有 9 個查詢，遠超過預算
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 150, budget: { windowMs: 60_000, maxCalls: 100, learnFactor: 0.01, min: 2 } });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  assert.equal(api.state.budget, 2);
  await env.until(() => api.state.blocks.length === 1, 3000, '試探沒有被預算擋住，很快就恢復');
  assert.ok(api.log().some((l) => /已恢復/.test(l)));
});

scenario('G2 「這波限流從幾點開始」會隨存檔保存；重新載入後恢復時仍能算出持續多久', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  const start = Date.now() - 4000;
  env.storage.set(key, JSON.stringify({ savedAt: Date.now() - 100, lastOk: false, cycle: 5, interval: 200, lockedFloor: 200, stack: [], blockStart: start, blockProbes: 1 }));
  const api = env.start({ month: 10, days: '10-13' });
  assert.equal(api.state.blockStart, start);
  assert.equal(api.state.blockProbes, 1);
  await env.until(() => api.state.blocks.length === 1, 5000, '恢復');
  const b = api.state.blocks[0];
  assert.ok(b.minutes >= 0.05, `持續時間要從原本的起點算：${b.minutes} 分鐘`);
  assert.equal(b.probes, 1);
});

scenario('G3 進入限流時，存檔裡會有 blockStart', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 2000 });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  await env.sleep(30);
  const saved = JSON.parse(env.storage.get(stateKey(10, ['10', '11', '12', '13'])));
  assert.equal(saved.blockStart, api.state.blockStart);
  assert.equal(saved.lastOk, false);
});

scenario('G4 限流中重新貼程式：等到原本排定的試探時間才試探，不會只冷卻幾分鐘就送出整頁重載＋查詢', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  const now = Date.now();
  env.storage.set(key, JSON.stringify({ savedAt: now - 100, lastOk: false, cycle: 5, interval: 200, lockedFloor: 200, stack: [], blockStart: now - 100, blockProbes: 0 }));
  // FAST 的 resume.cooldownMs 只有 100ms；沒有這個修正時，100ms 後就會送出整頁載入＋查詢
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 800 });
  assert.equal(api.state.blockStart, now - 100);
  assert.ok(api.state.nextAt - Date.now() > 500, `應等到原本排定的時間（約 800ms 後），實際 ${api.state.nextAt - Date.now()}ms`);
  assert.match(api.state.notice, /被網站限流/);
  await env.sleep(450);
  assert.equal(env.requests.length, 0, '排定時間之前不可以送任何查詢');
  assert.equal(api.state.pageLoads, 0, '排定時間之前也不可以載入頁面');
  await env.until(() => api.state.blocks.length === 1, 4000, '排定時間到了才試探，然後恢復');
  assert.ok(env.requests.length > 0);
});

scenario('G5 被擋時記下當下的狀況（窗口內查詢量、距上次載入頁面幾秒），恢復時併入 blocks；每次載入頁面都留下紀錄', {}, async (env) => {
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 200 });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  assert.equal(typeof api.state.blockStartStats.sinceLoadSec, 'number');
  assert.ok(api.state.blockStartStats.lastWindow >= 8);
  assert.ok(api.log().some((l) => /🔄 載入頁面第 1 次（第一次）/.test(l)), '第一次載入要留下紀錄');
  assert.match(api.log().find((l) => /診斷\[rate_limit/.test(l)), /距上次載入完成 \d+ 秒/);
  await env.until(() => api.state.blocks.length === 1, 5000, '恢復');
  assert.ok(api.state.blocks[0].startStats && api.state.blocks[0].startStats.lastWindow >= 8, '封鎖紀錄要帶著被擋當下的快照');
  assert.equal(api.state.blockStartStats, null);
});

scenario('H1 預算只在「第一次被擋」時學習；封鎖中的試探失敗不會再把預算越調越低', {}, async (env) => {
  env.responder = (c) => (c.callNo >= 9 && c.callNo <= 12 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', budget: { windowMs: 60_000, maxCalls: 100, learnFactor: 0.5, min: 2 } });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  const learned = api.state.budget;
  assert.equal(learned, 4);
  await env.until(() => api.state.blockProbes >= 3, 8000, '至少 3 次試探仍被擋');
  assert.equal(api.state.budget, learned, '試探失敗不可以再調降預算');
  await env.until(() => api.state.blocks.length === 1, 8000, '恢復');
});

scenario('H2 第一次暫停用 blockedWaitMs，之後的試探用 blockedRetryMs（間隔比較短）', {}, async (env) => {
  env.responder = (c) => (c.callNo >= 9 && c.callNo <= 11 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 500, blockedRetryMs: 120 });
  // 等到「已被擋」且程式已經排好下一次時間
  await env.until(() => api.state.blockStart > 0 && api.state.nextAt > Date.now() && api.state.blockProbes === 0, 5000, '第一次被擋並排定暫停');
  assert.ok(api.state.nextAt - Date.now() > 350, `第一次暫停應接近 blockedWaitMs(500)，實際 ${api.state.nextAt - Date.now()}ms`);
  await env.until(() => api.state.blockProbes >= 1 && api.state.nextAt > Date.now(), 5000, '第一次試探仍被擋並排定下一次');
  assert.ok(api.state.nextAt - Date.now() <= 130, `之後的試探間隔應是 blockedRetryMs(120)，實際 ${api.state.nextAt - Date.now()}ms`);
});

scenario('H3 已有封鎖時間紀錄時，下一次的第一個試探改用「已知最短封鎖 × 0.9」', {}, async (env) => {
  const key = stateKey(10, ['10', '11', '12', '13']);
  const now = Date.now();
  env.storage.set(key, JSON.stringify({ savedAt: now - 100, lastOk: true, cycle: 3, interval: 200, lockedFloor: 100, stack: [],
    blocks: [{ from: now - 600_000, to: now - 300_000, minutes: 0.005, probes: 1 }] })); // 已知一次封鎖 0.005 分鐘 = 300ms
  env.responder = (c) => (c.callNo === 9 ? { status: 429 } : {});
  const api = env.start({ month: 10, days: '10-13', blockedWaitMs: 5000, blockedRetryMs: 100, resume: { gapMs: 999999 } });
  await env.until(() => api.state.blockStart > 0, 5000, '被擋');
  const wait = api.state.nextAt - Date.now();
  assert.ok(wait < 1000, `應改用已知最短封鎖（約 270ms），而不是預設的 5000ms；實際剩 ${wait}ms`);
});

// ============================================================ S. 長時間壓力測試（有沒有東西越積越多）
scenario('S1 壓力測試：數百輪，票不斷出現／消失，穿插 429 與逾時 → 記憶體、計時器、儲存都有上限', {}, async (env) => {
  const rounds = (c) => Math.floor((c.callNo - 1) / 4);
  env.responder = (c) => {
    if (c.callNo % 97 === 0) return { status: 429 };
    if (c.callNo % 53 === 0) return { noEvent: true };
    const rows = env.makeRows(c.sdDate);
    if (c.day === 11 && rounds(c) % 2 === 0) rows[3].sdRemainder = 2; // 每隔一輪就出現／消失
    if (c.day === 12 && rounds(c) % 5 === 0) rows[7].sdRemainder = 1;
    return { rows };
  };
  const api = env.start({
    month: 10, days: '10-13', maxHistory: 20, reloadEvery: 40,
    interval: { start: 2, step: 1, floor: 1, max: 6, probeAfterOk: 2 },
    blockedWaitMs: 15, blockedRetryMs: 5,
    timing: { ajaxTimeoutMs: 40, readyTimeoutMs: 400, settleStableMs: 5, pollMs: 2, monthTimeoutMs: 100, settleMaxMs: 200, jitter: { min: 0, max: 1 } },
    budget: { maxCalls: null }, notify: { soundRepeatMs: 20, alertDurationMs: 60 },
  });
  const sample = [];
  const t0 = Date.now();
  while (api.state.cycle < 400 && Date.now() - t0 < 60_000) {
    await env.sleep(50);
    if (api.state.cycle >= 40 && sample.length === 0) sample.push({ cycle: api.state.cycle, intervals: env.intervals.size, iframes: env.iframes().length });
  }
  assert.ok(api.state.cycle >= 400, `60 秒內只跑了 ${api.state.cycle} 輪`);
  const end = { intervals: env.intervals.size, iframes: env.iframes().length };
  const s = api.state;
  assert.ok(s.events.length <= 500, `事件記錄 ${s.events.length}`);
  assert.ok(s.history.length <= 40, `歷史紀錄 ${s.history.length}（上限 maxHistory×2=40）`);
  assert.ok(s.blocks.length <= 50, `封鎖紀錄 ${s.blocks.length}`);
  assert.ok(s.alerts.length <= 50, `攔截的 alert ${s.alerts.length}`);
  assert.ok(s.reqLog.length <= 5000);
  assert.ok(end.iframes <= 1, `隱藏頁面 ${end.iframes} 個`);
  assert.ok(end.intervals <= sample[0].intervals + 3, `計時器從 ${sample[0].intervals} 增加到 ${end.intervals}（有洩漏）`);
  const stored = [...env.storage.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(stored < 120_000, `localStorage 用量 ${stored} 字元`);
  assert.ok(s.blocks.length >= 3, '壓力過程中應該真的經歷過多次限流恢復');
  assert.ok(env.notifications.length > 20, '票反覆出現，應該有多次提醒');
});

scenario('F7 預算平均分散：每輪至少間隔 視窗×每輪查詢數÷預算，不會先猛送再長時間停擺', {}, async (env) => {
  // 視窗 1000ms、預算 8、每輪 4 個 → 每輪至少間隔 500ms
  const api = env.start({
    month: 10, days: '10-13', interval: { start: 1, step: 1, floor: 1, max: 5, probeAfterOk: 2 },
    budget: { windowMs: 1000, maxCalls: 8, learnFactor: 0.7, min: 2, pace: true },
  });
  await env.until(() => api.state.cycle >= 8, 15000, '至少 8 輪');
  const starts = [];
  for (let i = 0; i < env.requests.length; i += 4) starts.push(env.requests[i].at);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.length >= 6);
  assert.ok(Math.min(...gaps) >= 450, `相鄰兩輪間隔最小 ${Math.min(...gaps)}ms，應接近 500ms`);
  assert.ok(Math.max(...gaps) <= 1400, `最大間隔 ${Math.max(...gaps)}ms：不該出現長時間停擺`);
  assert.match(env.panel(), /但受預算節流 → 實際每 \d+ 秒才開始一輪/);
});

scenario('F8 預算平均分散：關閉 pace 時退回原本行為', {}, async (env) => {
  const api = env.start({ month: 10, days: '10-13', interval: { start: 1, step: 1, floor: 1, max: 5, probeAfterOk: 2 },
    budget: { windowMs: 60_000, maxCalls: 1000, pace: false } });
  await env.until(() => api.state.cycle >= 5, 5000, '5 輪');
  assert.doesNotMatch(env.panel(), /預算節流/);
});
