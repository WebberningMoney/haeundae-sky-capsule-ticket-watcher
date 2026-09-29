// 單元測試：只測「純邏輯」（不需要瀏覽器）。執行： node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../watcher.js');

// ---------------------------------------------------------------- parseDays
test('parseDays: 各種合法寫法', () => {
  const ok = (spec, expected) => assert.deepEqual(Core.parseDays(spec).list, expected, String(spec));
  ok('10-13', [10, 11, 12, 13]);
  ok('10,12,15-17', [10, 12, 15, 16, 17]);
  ok('25', [25]);
  ok([10, 11, 12], [10, 11, 12]);
  ok('10、12', [10, 12]); // 中文頓號
  ok('10 ~ 12', [10, 11, 12]); // 範圍符號前後有空格
  ok('１０－１３', [10, 11, 12, 13]); // 全形數字與全形連字號
  ok('10 - 12 , 20', [10, 11, 12, 20]);
  ok('13,10,10,11', [10, 11, 13]); // 去重並排序
});

test('parseDays: 錯誤要回傳看得懂的訊息，而不是丟例外', () => {
  const bad = (spec, re) => {
    const r = Core.parseDays(spec);
    assert.deepEqual(r.list, []);
    assert.match(r.error, re, String(spec));
  };
  bad('13-10', /寫反了/);
  bad('abc', /看不懂/);
  bad('', /沒有填任何日期/);
  bad('0', /1 到 31/);
  bad('32', /1 到 31/);
});

// ---------------------------------------------------------------- monthDiff
test('monthDiff: 自動判斷要按幾次 Next／Prev', () => {
  assert.equal(Core.monthDiff({ y: 2026, m: 9 }, 10).diff, 1);
  assert.equal(Core.monthDiff({ y: 2026, m: 9 }, 11).diff, 2);
  assert.equal(Core.monthDiff({ y: 2026, m: 9 }, 9).diff, 0);
  assert.equal(Core.monthDiff({ y: 2026, m: 11 }, 2).diff, 3); // 目標比顯示的早 → 視為明年
  assert.equal(Core.monthDiff({ y: 2026, m: 11 }, 2).targetYear, 2027);
  assert.equal(Core.monthDiff({ y: 2026, m: 9 }, 9, 2026).diff, 0);
  assert.equal(Core.monthDiff({ y: 2026, m: 10 }, 9, 2026).diff, -1); // 明確指定年份 → 可往前
});

test('ymd: 補零', () => {
  assert.equal(Core.ymd(2026, 10, 5), '20261005');
  assert.equal(Core.ymd(2026, 1, 31), '20260131');
});

// ---------------------------------------------------------------- HTTP 分類
test('classifyHttp / isHard', () => {
  assert.equal(Core.classifyHttp(200), null);
  assert.equal(Core.classifyHttp(429), 'rate_limit');
  assert.equal(Core.classifyHttp(403), 'blocked');
  assert.equal(Core.classifyHttp(0), 'network');
  assert.equal(Core.classifyHttp(503), 'server');
  assert.equal(Core.classifyHttp(404), 'unknown');
  for (const k of ['rate_limit', 'blocked', 'load', 'server']) assert.equal(Core.isHard(k), true, k);
  for (const k of ['timeout', 'stale', 'network', 'notopen', 'layout', 'unknown']) assert.equal(Core.isHard(k), false, k);
});

test('parseRetryAfter: 秒數與日期兩種格式', () => {
  assert.equal(Core.parseRetryAfter('120'), 120_000);
  assert.equal(Core.parseRetryAfter(null), null);
  assert.equal(Core.parseRetryAfter(''), null);
  assert.equal(Core.parseRetryAfter('not a date'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(Core.parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
  assert.equal(Core.parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now), 0); // 已過期 → 0，不會是負數
});

// ---------------------------------------------------------------- 票的判斷
test('extractTickets: 只有 sdRemainder > 0 才算有票', () => {
  const rows = [
    { sdName: '1회차(08:30 ~ 09:00) 입장', sdRemainder: 0 },
    { sdName: '2회차(09:00 ~ 09:30) 입장', sdRemainder: '3' }, // 字串數字也要能處理
    { sdName: '3회차(09:30 ~ 10:00) 입장', sdRemainder: 12 },
  ];
  const t = Core.extractTickets(rows);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.remain), [3, 12]);
});

test('isNumeric', () => {
  for (const v of [0, '0', 5, '12']) assert.equal(Core.isNumeric(v), true, String(v));
  for (const v of [null, undefined, '', 'abc', NaN]) assert.equal(Core.isNumeric(v), false, String(v));
});

test('shortSlot', () => {
  assert.equal(Core.shortSlot('20회차(18:00 ~ 18:30) 입장'), '20班18:00-18:30');
  assert.equal(Core.shortSlot('奇怪的格式'), '奇怪的格式'); // 格式不符就原樣回傳
});

test('diffNewTickets: 只有「新出現」的才算新增，持續有票不重複', () => {
  const t1 = { '10/11': [{ name: 'A', remain: 3 }] };
  const r1 = Core.diffNewTickets(t1, new Set());
  assert.equal(r1.added.length, 1);
  // 下一輪同一張票還在 → 不算新增
  const r2 = Core.diffNewTickets(t1, r1.keys);
  assert.equal(r2.added.length, 0);
  // 票消失後又出現 → 算新增
  const r3 = Core.diffNewTickets({}, r2.keys);
  const r4 = Core.diffNewTickets(t1, r3.keys);
  assert.equal(r4.added.length, 1);
  // 新增另一個時段 → 只有它算新增
  const r5 = Core.diffNewTickets({ '10/11': [{ name: 'A', remain: 3 }, { name: 'B', remain: 1 }] }, r4.keys);
  assert.deepEqual(r5.added.map((x) => x.name), ['B']);
});

test('makeScope: 不同商品／月份／日期要有不同的存檔鍵', () => {
  const a = Core.makeScope('/ticket_chn/GD1', 10, null, ['10', '11']);
  assert.notEqual(a, Core.makeScope('/ticket_chn/GD2', 10, null, ['10', '11']));
  assert.notEqual(a, Core.makeScope('/ticket_chn/GD1', 11, null, ['10', '11']));
  assert.notEqual(a, Core.makeScope('/ticket_chn/GD1', 10, null, ['10']));
  assert.equal(a, Core.makeScope('/ticket_chn/GD1', 10, null, ['10', '11']));
});

// ---------------------------------------------------------------- 自適應間隔
const cfg = () => ({ start: 60_000, step: 10_000, floor: 10_000, max: 180_000, probeAfterOk: 10 });

test('IntervalController: 連續成功會一路縮到下限，不會低於下限', () => {
  const c = new Core.IntervalController(cfg());
  const seen = [c.interval];
  for (let i = 0; i < 8; i++) { c.onSuccess(); seen.push(c.interval); }
  assert.deepEqual(seen, [60, 50, 40, 30, 20, 10, 10, 10, 10].map((s) => s * 1000));
});

test('IntervalController: hard 失敗只退回上一級，並鎖定下限', () => {
  const c = new Core.IntervalController(cfg());
  for (let i = 0; i < 5; i++) c.onSuccess(); // 60 → 10
  assert.equal(c.interval, 10_000);
  c.onFailure(true);
  assert.equal(c.interval, 20_000, '只退一級，不是跳回最大值');
  assert.equal(c.lockedFloor, 20_000, '這一級以下曾失敗過，要鎖住');
  c.onSuccess();
  assert.equal(c.interval, 20_000, '被鎖住的下限不會再往下縮');
});

test('IntervalController: 在下限連續成功 N 次後才放寬一級', () => {
  const c = new Core.IntervalController(cfg());
  for (let i = 0; i < 5; i++) c.onSuccess();
  c.onFailure(true); // interval 20, lockedFloor 20
  for (let i = 0; i < 9; i++) c.onSuccess();
  assert.equal(c.lockedFloor, 20_000, '還沒到 10 次');
  c.onSuccess(); // 第 10 次
  assert.equal(c.lockedFloor, 10_000, '放寬一級');
  c.onSuccess();
  assert.equal(c.interval, 10_000, '放寬後可以再往下試');
});

test('IntervalController: soft 失敗不改變間隔也不鎖下限', () => {
  const c = new Core.IntervalController(cfg());
  for (let i = 0; i < 3; i++) c.onSuccess(); // 30
  c.onFailure(false);
  assert.equal(c.interval, 30_000);
  assert.equal(c.lockedFloor, 10_000);
  assert.equal(c.fails, 1);
});

test('IntervalController: 連續失敗等待時間加倍（最多 5 倍），Retry-After 優先', () => {
  const c = new Core.IntervalController(cfg());
  c.onFailure(false);
  assert.equal(c.waitMs(), 60_000); // 第 1 次失敗 ×1
  c.onFailure(false);
  assert.equal(c.waitMs(), 120_000); // ×2
  for (let i = 0; i < 10; i++) c.onFailure(false);
  assert.equal(c.waitMs(), 300_000, '最多 5 倍');
  assert.equal(c.waitMs(600_000), 600_000, '伺服器要求等更久就聽伺服器的');
  assert.equal(c.waitMs(1_000), 300_000, 'Retry-After 比自己算的短就用自己的');
});

test('IntervalController: 成功會清掉連續失敗計數', () => {
  const c = new Core.IntervalController(cfg());
  c.onFailure(false); c.onFailure(false);
  c.onSuccess();
  assert.equal(c.fails, 0);
});

test('IntervalController: 沒有堆疊可退時，退回 interval+step，且不超過上限', () => {
  const c = new Core.IntervalController({ ...cfg(), start: 170_000 });
  c.onFailure(true);
  assert.equal(c.interval, 180_000);
  c.onFailure(true);
  assert.equal(c.interval, 180_000, '不超過 max');
});

test('IntervalController: snapshot／restore 來回不失真，壞資料會被夾回合理範圍', () => {
  const a = new Core.IntervalController(cfg());
  for (let i = 0; i < 3; i++) a.onSuccess();
  a.onFailure(true);
  const b = new Core.IntervalController(cfg());
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.deepEqual(b.snapshot(), a.snapshot());
  const c = new Core.IntervalController(cfg());
  c.restore({ interval: 999_999_999, lockedFloor: -5, stack: 'oops', okAtFloor: 'x' });
  assert.equal(c.interval, 180_000);
  assert.equal(c.lockedFloor, 10_000);
  assert.deepEqual(c.stack, []);
  assert.equal(c.okAtFloor, 0);
});

test('ScanError 帶有 kind 與 retryAfterMs', () => {
  const e = new Core.ScanError('rate_limit', 'x', { retryAfterMs: 5000 });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 5000);
  assert.ok(e instanceof Error);
});

// ---------------------------------------------------------------- 情境模擬
test('情境：先順利縮短，遇到 429 退一級後穩定，之後可再試探', () => {
  const c = new Core.IntervalController(cfg());
  const log = [];
  const step = (ok, hard = true) => { ok ? c.onSuccess() : c.onFailure(hard); log.push(c.interval / 1000); };
  step(true); step(true); step(true); // 60→50→40→30
  step(false); // 429 → 退到 40
  step(true); step(true); // 被鎖在 40
  assert.deepEqual(log, [50, 40, 30, 40, 40, 40]);
});

// ---------------------------------------------------------------- 查詢預算
test('budgetWaitMs: 未超過預算就不用等；超過就等到最舊的過期', () => {
  const W = 1000;
  const now = 10_000;
  assert.equal(Core.budgetWaitMs([], now, W, 5, 4), 0);
  assert.equal(Core.budgetWaitMs([9500, 9600], now, W, 5, 3), 0, '2+3=5 剛好在預算內');
  // 已有 4 個（9100、9200、9300、9400），想再送 4 個 → 總共 8，超過 5 → 要讓 3 個過期
  const ts = [9100, 9200, 9300, 9400];
  assert.equal(Core.budgetWaitMs(ts, now, W, 5, 4), 9300 + W - now + 1, '第 3 舊的過期時間 + 1ms');
  // 已過期的不算
  assert.equal(Core.budgetWaitMs([1000, 2000, 3000], now, W, 3, 3), 0);
});

test('budgetWaitMs: 一次要的比預算還多時以預算為上限，不會永遠等不到；沒設預算則不限制', () => {
  const now = 10_000;
  assert.ok(Core.budgetWaitMs([9900], now, 1000, 2, 10) > 0);
  assert.equal(Core.budgetWaitMs([], now, 1000, 2, 10), 0, '空窗口 → 直接可以送（以預算為上限）');
  assert.equal(Core.budgetWaitMs([9990, 9991, 9992], now, 1000, null, 4), 0);
  assert.equal(Core.budgetWaitMs([9990, 9991, 9992], now, 1000, 0, 4), 0);
});

test('budgetWaitMs: 等完之後真的可以送（模擬滾動）', () => {
  const W = 1000;
  let now = 0;
  const sent = [];
  for (let i = 0; i < 40; i++) {
    const wait = Core.budgetWaitMs(sent, now, W, 6, 2);
    now += wait;
    sent.push(now, now); // 送出 2 個
    const inWin = sent.filter((t) => now - t < W).length;
    assert.ok(inWin <= 6, `第 ${i} 次：視窗內 ${inWin} 個`);
    now += 5;
  }
});

test('learnBudget: 只降不升，有下限', () => {
  assert.equal(Core.learnBudget(150, 100, 0.7, 30), 70);
  assert.equal(Core.learnBudget(50, 100, 0.7, 30), 50, '不會調升');
  assert.equal(Core.learnBudget(150, 10, 0.7, 30), 30, '不低於下限');
  assert.equal(Core.learnBudget(null, 100, 0.5, 30), 50, '原本沒有預算 → 直接採用學到的');
});

test('deepMerge: 深層合併、不污染原型、不吃 undefined 來源', () => {
  const t = { a: 1, n: { x: 1, y: 2 }, arr: [1] };
  Core.deepMerge(t, { n: { y: 9, z: 3 }, arr: [2, 3], b: 5 });
  assert.deepEqual(t, { a: 1, n: { x: 1, y: 9, z: 3 }, arr: [2, 3], b: 5 });
  Core.deepMerge(t, JSON.parse('{"__proto__": {"bad": true}, "constructor": {"prototype": {"bad": true}}}'));
  assert.equal(({}).bad, undefined);
  assert.equal(Core.deepMerge(t, undefined), t);
  assert.equal(Core.deepMerge(t, null), t);
});
