'use strict';
/**
 * 整合測試用的「假瀏覽器環境」。
 *
 * 目的：不連網、不開瀏覽器，就能把 watcher.js 的「瀏覽器層」（iframe、ajaxComplete 旁聽、
 * 通知、語音、鎖、接續存檔…）完整跑一遍，並且可以精準地製造各種狀況：
 * 429／403／逾時／舊資料／版面壞掉／該月份尚未開放…
 *
 * 做法：用 Node 的 vm 模組，把 watcher.js 丟進一個只有「假 window／document／jQuery…」的沙盒執行。
 * 假頁面（FakePage）會模擬真實網站的行為：日曆、Next／Prev、點日期後非同步發出查詢、
 * 觸發 jQuery 的 ajaxComplete 事件，回應內容由測試決定（env.responder）。
 *
 * 特別重要：假的 jqXHR 刻意做成「類 Promise」（有 then 方法），
 * 這樣如果程式又犯了「直接 resolve(xhr)」的錯，測試會立刻失敗（真實網站上發生過）。
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../watcher.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');

/** 讓所有等待時間縮到很短的預設設定，測試才跑得快。 */
const FAST = {
  interval: { start: 200, step: 100, floor: 100, max: 1000, probeAfterOk: 2 },
  blockedWaitMs: 400,
  blockedRetryMs: 150,
  reloadEvery: 5,
  resume: { cooldownMs: 100 },
  timing: {
    readyTimeoutMs: 600, ajaxTimeoutMs: 300, monthTimeoutMs: 300, settleMaxMs: 600,
    settleStableMs: 15, pollMs: 5, fallbackWaitMs: 30, jitter: { min: 0, max: 1 },
  },
  workerTimers: false,
  notify: { soundRepeatMs: 50, alertDurationMs: 400 },
};

const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const addMonths = ({ y, m }, n) => {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- 假 DOM
class FakeEl {
  constructor(tag, text = '') {
    this.tagName = tag.toUpperCase();
    this._text = text;
    this.children = [];
    this.parent = null;
    this.style = { cssText: '' };
    this.id = '';
    this._clickHandler = null;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    if (c._onAttach) c._onAttach();
    return c;
  }
  remove() {
    if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  }
  click() { if (this._clickHandler) this._clickHandler(); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  addEventListener() {}
  removeEventListener() {}
}

class FakeDocument {
  constructor(env) {
    this.env = env;
    this.body = new FakeEl('body');
    this.head = new FakeEl('head');
    this._title = '预订';
    this.listeners = {};
  }
  get title() { return this._title; }
  set title(v) { this._title = String(v); }
  get hidden() { return this.env.hidden; }
  get visibilityState() { return this.env.hidden ? 'hidden' : 'visible'; }
  hasFocus() { return this.env.focused; }
  all() { return [...this.body.all(), ...this.head.all()]; }
  querySelectorAll(sel) {
    const all = this.all();
    if (sel === '*') return all;
    if (sel === 'a') return all.filter((e) => e.tagName === 'A');
    return [];
  }
  querySelector(sel) {
    if (sel.startsWith('link[rel')) return this.head.all().find((e) => e.tagName === 'LINK') || null;
    return this.querySelectorAll(sel)[0] || null;
  }
  getElementById(id) { return this.all().find((e) => e.id === id) || null; }
  createElement(tag) {
    const t = tag.toLowerCase();
    if (t === 'iframe') return new FakeIframe(this.env);
    const el = new FakeEl(t);
    if (t === 'canvas') {
      el.getContext = () => ({ beginPath() {}, arc() {}, fill() {}, fillText() {} });
      el.toDataURL = () => 'data:image/png;base64,FAKE';
    }
    if (t === 'a') el._clickHandler = () => this.env.downloads.push({ href: el.href, download: el.download });
    return el;
  }
  addEventListener(type, h) { (this.listeners[type] = this.listeners[type] || []).push(h); }
  removeEventListener(type, h) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== h); }
  dispatch(type, ev = {}) {
    // 真實 Chrome：使用者操作（點擊／按鍵）之後，網頁才被允許出聲
    if (['pointerdown', 'click', 'keydown'].includes(type)) this.env.userActivated = true;
    (this.listeners[type] || []).slice().forEach((h) => h(ev));
  }
}

/** 假的 jQuery：只實作程式用到的部分（$(doc).on/off('ajaxComplete')、$.active）。 */
function makeJQuery(page) {
  const handlers = new Set();
  const $ = () => ({
    on(evt, h) { if (evt === 'ajaxComplete') handlers.add(h); return this; },
    off(evt, h) { if (evt === 'ajaxComplete') handlers.delete(h); return this; },
  });
  $.active = 0;
  $.emit = (xhr, settings) => { for (const h of [...handlers]) h({}, xhr, settings); };
  $.handlerCount = () => handlers.size;
  return $;
}

/** 假的 jqXHR：刻意做成 thenable，重現「直接 resolve(xhr) 會被拆開」的真實陷阱。 */
function makeXhr({ status = 200, rows = null, headers = {}, noJson = false }) {
  const body = { data: rows };
  const xhr = {
    status,
    responseText: rows ? JSON.stringify(body) : '{"error":"TOO_MANY_REQUESTS","message":"요청실패"}',
    getResponseHeader: (name) => {
      const k = Object.keys(headers).find((h) => h.toLowerCase() === String(name).toLowerCase());
      return k === undefined ? null : headers[k];
    },
    getAllResponseHeaders: () => ['content-type: application/json', ...Object.keys(headers).map((k) => `${k}: ${headers[k]}`)].join('\r\n'),
    then(res, rej) { return Promise.resolve(body).then(res, rej); },
  };
  if (rows && !noJson) xhr.responseJSON = body;
  return xhr;
}

const makeSettings = (url, sdDate) => ({
  url,
  data: sdDate ? { get: (k) => (k === 'sdDate' ? sdDate : null) } : null,
});

class FakePage {
  constructor(env, id, { main = false } = {}) {
    this.env = env;
    this.id = id;
    this.main = main;
    this.doc = new FakeDocument(env);
    this.month = { ...env.initialMonth };
    this.jq = makeJQuery(this);
    const noJq = !main && env.scenario.noJquery;
    this.win = { document: this.doc, jQuery: noJq ? undefined : this.jq, alert: () => {}, confirm: () => true };
    this.calendar = new FakeEl('div');
    this.slotBox = new FakeEl('div');
    this.doc.body.appendChild(this.calendar);
    this.doc.body.appendChild(this.slotBox);
    this.render();
  }

  render() {
    const sc = this.env.scenario;
    this.calendar.children = [];
    if (!this.main && sc.noCalendar) return; // 整個日曆消失（例如載入到錯誤頁）
    if (!(sc.noHeader && !this.main)) {
      this.calendar.appendChild(new FakeEl('span', `${this.month.y} ${pad(this.month.m)}`));
    }
    const prev = new FakeEl('a', 'Prev');
    const next = new FakeEl('a', 'Next');
    prev._clickHandler = () => this.navigate(-1);
    next._clickHandler = () => this.navigate(+1);
    this.calendar.appendChild(prev);
    this.calendar.appendChild(next);
    for (let d = 1; d <= daysInMonth(this.month.y, this.month.m); d++) {
      const a = new FakeEl('a', String(d));
      a._clickHandler = () => this.clickDay(d);
      this.calendar.appendChild(a);
    }
  }

  navigate(dir) {
    const env = this.env;
    env.navClicks[dir > 0 ? 'next' : 'prev']++;
    if (!this.main && env.scenario.nextInert) return; // 該月份尚未開放：按了沒反應
    this.jq.active++;
    setTimeout(() => {
      this.month = addMonths(this.month, dir);
      this.render();
      this.jq.active--;
    }, env.latency);
  }

  renderSlots(rows) {
    this.slotBox.children = rows.map(
      (r) => new FakeEl('div', `${r.sdName} [剩余:${Number(r.sdRemainder) > 0 ? r.sdRemainder : '售罄'}]`),
    );
  }

  clickDay(d) {
    const env = this.env;
    const sdDate = Core.ymd(this.month.y, this.month.m, d);
    const callNo = env.requests.length + 1;
    env.requests.push({ page: this.id, day: d, sdDate, at: Date.now() });
    const action = env.responder({ sdDate, day: d, page: this.id, callNo, month: { ...this.month } });
    this.jq.active++;
    setTimeout(() => {
      this.jq.active--;
      if (action.noEvent) return; // 永遠等不到回應（逾時）
      for (const decoy of action.decoys || []) {
        this.jq.emit(makeXhr({ rows: env.makeRows(decoy) }), makeSettings('/ticket/getDateScheduleList', decoy));
      }
      const rows = action.rows === undefined && (action.status || 200) === 200 ? env.makeRows(sdDate) : action.rows;
      const status = action.status || 200;
      if (status === 200 && rows) this.renderSlots(rows);
      // 真實網站在失敗時會 alert('요청실패')
      if (status !== 200) this.win.alert('요청실패');
      this.jq.emit(
        makeXhr({ status, rows: status === 200 ? rows : null, headers: action.headers, noJson: action.noJson }),
        makeSettings('/ticket/getDateScheduleList', sdDate),
      );
    }, action.delay === undefined ? env.latency : action.delay);
  }
}

class FakeIframe extends FakeEl {
  constructor(env) {
    super('iframe');
    this.env = env;
    this.page = null;
    this.onload = null;
    this.src = '';
  }
  _onAttach() {
    const env = this.env;
    env.pageLoads++;
    const id = env.pageLoads;
    if (env.scenario.loadFails && env.scenario.loadFails(id)) return; // 永遠載不完
    setTimeout(() => {
      this.page = new FakePage(env, id);
      env.pages.push(this.page);
      if (this.onload) this.onload();
    }, env.loadDelay);
  }
  get contentWindow() { return this.page ? this.page.win : null; }
  get contentDocument() { return this.page ? this.page.doc : null; }
}

// ---------------------------------------------------------------- 環境
function createEnv(opts = {}) {
  const env = {
    initialMonth: opts.initialMonth || { y: 2026, m: 9 },
    latency: opts.latency ?? 2,
    loadDelay: opts.loadDelay ?? 2,
    scenario: {}, // 可在測試中隨時修改：noHeader／noCalendar／nextInert／noJquery／loadFails
    requests: [], // 每一次「點日期」送出的查詢
    pages: [],
    pageLoads: 0,
    navClicks: { next: 0, prev: 0 },
    notifications: [],
    requestPermissionCalls: 0,
    oscillators: 0,
    spoken: [],
    downloads: [],
    blobs: [],
    wakeLocks: { requested: 0, released: 0 },
    wakeSentinels: [],
    userActivated: false,
    consoleLogs: [],
    consoleErrors: [],
    winListeners: {},
    hidden: false,
    focused: false,
    intervals: new Set(),
    notifPermission: 'granted', // Notification.permission 回報的值
    permQuery: 'granted', // navigator.permissions.query 回報的值（實際狀態）
    audioInitial: 'running',
    voices: opts.voices || [],
    tickets: {}, // { '20261011': [{ idx: 4, remain: 3 }] }
  };

  /** 產生某一天的 20 個時段（預設全部售罄；env.tickets 指定的位置有票）。 */
  env.makeRows = (sdDate) =>
    Array.from({ length: 20 }, (_, i) => {
      const startMin = 8 * 60 + 30 + i * 30;
      const fmt = (t) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      const hit = (env.tickets[sdDate] || []).find((t) => t.idx === i);
      return {
        sdDate, sdSeq: `SD${i}`, sdName: `${i + 1}회차(${fmt(startMin)} ~ ${fmt(startMin + 30)}) 입장`,
        sdRemainder: hit ? hit.remain : 0,
      };
    });
  env.responder = () => ({}); // 預設：200 + env.makeRows

  const main = new FakePage(env, 'main', { main: true });
  env.mainPage = main;
  const doc = main.doc;
  env.doc = doc;

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  env.storage = storage;

  class FakeNotification {
    constructor(title, options) {
      env.notifications.push({ title, ...options });
      this.onclick = null;
      this.onerror = null;
      this.close = () => {};
    }
    static get permission() { return env.notifPermission; }
    static requestPermission() {
      env.requestPermissionCalls++;
      return Promise.resolve(env.notifPermission === 'default' ? 'granted' : env.notifPermission);
    }
  }
  class FakeAudioContext {
    constructor() { this.state = env.audioInitial; this.currentTime = 0; this.destination = {}; }
    resume() { if (env.userActivated) this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() {
      env.oscillators++;
      return { type: '', frequency: { value: 0 }, connect: (n) => n, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n) => n };
    }
  }
  class FakeUtterance { constructor(text) { this.text = text; } }
  const speechSynthesis = {
    getVoices: () => env.voices,
    cancel() {},
    speak(u) { env.spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, rate: u.rate, pitch: u.pitch, utterance: u }); },
    speaking: false,
  };
  const navigator = {
    platform: opts.platform || 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/154',
    permissions: { query: async () => ({ state: env.permQuery, onchange: null }) },
  };
  if (opts.wakeLock !== false) {
    navigator.wakeLock = {
      request: async () => {
        env.wakeLocks.requested++;
        const sentinel = { released: false, release() { if (!this.released) { this.released = true; env.wakeLocks.released++; } } };
        env.wakeSentinels.push(sentinel);
        return sentinel;
      },
    };
  }

  const sandbox = {
    document: doc,
    location: { pathname: '/ticket_chn/GD0000001' },
    localStorage,
    navigator,
    Notification: FakeNotification,
    AudioContext: FakeAudioContext,
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis,
    URL: { createObjectURL: (b) => { env.blobs.push(b); return 'blob:fake'; }, revokeObjectURL() {} },
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } },
    console: {
      log: (...a) => env.consoleLogs.push(a.join(' ')),
      error: (...a) => env.consoleErrors.push(a.join(' ')),
    },
    setTimeout, clearTimeout,
    // 追蹤「還活著的 setInterval」，用來偵測計時器有沒有越積越多
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); env.intervals.add(id); return id; },
    clearInterval: (id) => { env.intervals.delete(id); clearInterval(id); },
    addEventListener: (t, h) => { (env.winListeners[t] = env.winListeners[t] || []).push(h); },
    removeEventListener: (t, h) => { env.winListeners[t] = (env.winListeners[t] || []).filter((x) => x !== h); },
    focus() {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  if (opts.Worker) sandbox.Worker = opts.Worker;
  env.sandbox = sandbox;
  const ctx = vm.createContext(sandbox);

  /** 啟動 watcher.js。override 會深層合併進 CONFIG（透過 window.ticketWatcherConfig）。 */
  env.start = (override = {}) => {
    sandbox.ticketWatcherConfig = Core.deepMerge(JSON.parse(JSON.stringify(FAST)), override);
    vm.runInContext(SOURCE, ctx, { filename: 'watcher.js' });
    return sandbox.__ticketWatcher;
  };
  env.api = () => sandbox.__ticketWatcher;
  env.panel = () => (doc.getElementById('__ticket_watcher_panel') || { textContent: '' }).textContent;
  env.iframes = () => doc.body.children.filter((c) => c.tagName === 'IFRAME');
  env.beeps = () => Math.floor(env.oscillators / 4);
  env.stop = () => { try { sandbox.__ticketWatcher && sandbox.__ticketWatcher.stop(); } catch (_) {} };
  env.setLock = (obj) => localStorage.setItem('__tw:lock', JSON.stringify(obj));
  env.getLock = () => JSON.parse(localStorage.getItem('__tw:lock') || 'null');

  /** 輪詢等待條件成立；逾時就丟出帶有說明的錯誤（比測試框架的逾時好懂）。 */
  env.until = async (fn, ms = 5000, label = '條件') => {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = fn(); } catch (_) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > ms) {
        const api = env.api();
        throw new Error(`等待逾時：${label}\n最近記錄：\n${api ? api.log().slice(-8).join('\n') : '(尚未啟動)'}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  env.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return env;
}

module.exports = { createEnv, FAST, Core };
