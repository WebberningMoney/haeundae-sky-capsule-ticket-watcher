// ==UserScript==
// @name         haeundae-sky-capsule-ticket-watcher
// @namespace    https://github.com/WebberningMoney/haeundae-sky-capsule-ticket-watcher
// @version      2.0.0
// @description  訂票頁有票監控（只監看，不下單）。事件驅動、自動退避、Chrome 重啟後自動接續。
// @match        https://*/ticket_chn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/**
 * haeundae-sky-capsule-ticket-watcher v2 — 票務頁面「有票監控」腳本
 * ============================================================================
 * 用途
 *   在「訂票頁面本身」的分頁裡持續監看指定月份、指定日期的各個時段，
 *   一旦有任何時段不是「售罄」，就用【桌面通知＋提示音＋語音＋標題閃爍＋紅色面板】提醒你。
 *   只監看，不會下單、不會付款、不會填任何個資。
 *
 * 適用環境
 *   桌面版 Chrome（macOS / Windows）。maketicket 系統的訂票頁
 *   （例如 https://www.tbluelinepark.com/ticket_chn/GDxxxxxxx），商品代碼取自目前網址。
 *
 * 使用方式（最簡單）
 *   1. 用 Chrome 開啟訂票頁，停在看得到「預訂日期」日曆的那一頁。
 *   2. 改下方 CONFIG 的 month（幾月）與 days（幾號），其餘通常不用動。
 *   3. 開發人員工具 → Console，貼上整份檔案，按 Enter。
 *   停止：Console 執行  window.__ticketWatcher.stop()
 *   測試提醒：Console 執行  window.__ticketWatcher.testAlert()
 *
 * 運作原理（v2 重點）
 *   A. 每輪（或每 N 輪）在畫面外建立「隱藏的 same-origin iframe」載入全新頁面。
 *   B. 【事件驅動】不再用固定 sleep 猜「應該載入完了吧」，而是：
 *        - 用 jQuery.active 判斷頁面是否閒置（請求都結束）
 *        - 點日期時監聽頁面自己的 ajaxComplete 事件，等到「這一次點擊」的回應真的回來
 *          （以請求裡的 sdDate 比對，避免讀到上一天的舊資料）
 *   C. 直接取得該回應的【HTTP 狀態碼】與【JSON】（sdDate／sdName／sdRemainder），
 *      不再靠「畫面上讀不到文字」來猜是不是被限流。讀不到 JSON 時才退回讀畫面文字。
 *   D. 依狀態碼精準分類錯誤（429 限流／403 被擋／逾時／版面改變…），各自用不同方式處理，
 *      並遵守 Retry-After。
 *   E. 有「新出現」的票才提醒；自適應間隔（成功縮短、失敗退回並鎖定下限）。
 *
 * 為什麼不直接呼叫 API？
 *   網站的時段查詢帶有 X-Schedule-Token 防機器人驗證，直接呼叫會被 403。
 *   本腳本刻意不偽造該 token：仍由頁面自己發請求，我們只「旁聽」它的結果。
 *   請勿修改成繞過防護的版本。
 * ============================================================================
 */
(() => {
  'use strict';

  // ==========================================================================
  // 0. 核心邏輯（純函式，不碰 DOM／瀏覽器）—— 可以在 Node 直接跑單元測試
  // ==========================================================================
  const Core = (() => {
    /** 錯誤種類：各自有不同的處理方式（見 README「錯誤分類」）。 */
    const HARD_KINDS = new Set(['rate_limit', 'blocked', 'load', 'server']); // 需要退避並鎖定下限
    const isHard = (kind) => HARD_KINDS.has(kind);

    class ScanError extends Error {
      /**
       * @param {string} kind  rate_limit|blocked|server|network|timeout|stale|load|layout|notopen|unknown
       * @param {string} message 給人看的中文說明
       * @param {{retryAfterMs?: number}} [opts]
       */
      constructor(kind, message, opts = {}) {
        super(message);
        this.kind = kind;
        this.retryAfterMs = opts.retryAfterMs || 0;
      }
    }

    /** 把使用者寫的日期設定轉成整數陣列並檢查。回傳 { list, error }。 */
    function parseDays(spec) {
      const text = (Array.isArray(spec) ? spec.join(',') : String(spec))
        .normalize('NFKC') // 全形 → 半形（１０ → 10）
        .replace(/\s*([-~–—])\s*/g, '$1'); // 範圍符號前後空格去掉
      const set = new Set();
      for (const raw of text.split(/[,，、;；\s]+/)) {
        const part = raw.trim();
        if (!part) continue;
        const m = part.match(/^(\d{1,2})[-~–—](\d{1,2})$/);
        if (m) {
          const a = Number(m[1]);
          const b = Number(m[2]);
          if (a > b) return { list: [], error: `日期範圍「${part}」寫反了，應該是小的在前，例如 10-13` };
          for (let d = a; d <= b; d++) set.add(d);
        } else if (/^\d{1,2}$/.test(part)) {
          set.add(Number(part));
        } else {
          return { list: [], error: `看不懂日期「${part}」。請用像 10-13 或 10,12,15-17 這樣的寫法` };
        }
      }
      const list = [...set].sort((x, y) => x - y);
      if (!list.length) return { list: [], error: '沒有填任何日期（days 是空的）' };
      if (list.some((d) => d < 1 || d > 31)) return { list: [], error: '日期必須介於 1 到 31 之間' };
      return { list, error: null };
    }

    /** 目前顯示 shown={y,m}，目標月份 targetMonth（年份可省略 = 自動）→ 差幾個月（正=往後按 Next）。 */
    function monthDiff(shown, targetMonth, targetYear) {
      const ty = targetYear ?? shown.y + (targetMonth < shown.m ? 1 : 0);
      return { diff: (ty - shown.y) * 12 + (targetMonth - shown.m), targetYear: ty };
    }

    const two = (n) => String(n).padStart(2, '0');
    /** 組成網站使用的日期字串，例如 (2026,10,5) → '20261005'。 */
    const ymd = (y, m, d) => `${y}${two(m)}${two(d)}`;

    const isNumeric = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

    /** 由 HTTP 狀態碼判斷錯誤種類；200 回傳 null。 */
    function classifyHttp(status) {
      if (status === 200) return null;
      if (status === 429) return 'rate_limit';
      if (status === 403) return 'blocked';
      if (status === 0) return 'network';
      if (status >= 500) return 'server';
      return 'unknown';
    }

    /** Retry-After 可能是秒數，也可能是日期。回傳毫秒或 null。 */
    function parseRetryAfter(value, now = Date.now()) {
      if (value === null || value === undefined || value === '') return null;
      const s = String(value).trim();
      if (/^\d+$/.test(s)) return Number(s) * 1000;
      const t = Date.parse(s);
      return Number.isNaN(t) ? null : Math.max(0, t - now);
    }

    /** 從 API 的 rows 取出「有票」的時段（sdRemainder > 0）。 */
    function extractTickets(rows) {
      return rows
        .map((r) => ({ name: String(r.sdName ?? ''), remain: Number(r.sdRemainder) }))
        .filter((x) => x.remain > 0);
    }

    /** 「12회차(14:00 ~ 14:30) 입장」→「12班14:00-14:30」，方便放進標題與通知。 */
    function shortSlot(name) {
      const m = String(name).match(/(\d+)회차\((\d+:\d+) ~ (\d+:\d+)\)/);
      return m ? `${m[1]}班${m[2]}-${m[3]}` : String(name);
    }

    /**
     * 與上一輪比較，找出「新出現」的票。
     * @param {Record<string, {name:string, remain:number}[]>} found  { '10/11': [...] }
     * @param {Set<string>} prevKeys
     */
    function diffNewTickets(found, prevKeys) {
      const keys = new Set();
      const added = [];
      for (const day of Object.keys(found)) {
        for (const x of found[day]) {
          const key = `${day}|${x.name}`;
          keys.add(key);
          if (!prevKeys.has(key)) added.push({ day, name: x.name, remain: x.remain });
        }
      }
      return { keys, added };
    }

    /**
     * 查詢預算（滾動視窗）：在最近 windowMs 內最多送 limit 個查詢。
     * 回傳「要再等多少毫秒，才能安全地再送 needed 個」；0 代表現在就可以送。
     * timestamps 是過去每個查詢的時間戳（毫秒）。
     */
    function budgetWaitMs(timestamps, now, windowMs, limit, needed) {
      if (!limit || limit <= 0) return 0; // 沒設定預算 = 不限制
      const live = timestamps.filter((t) => now - t < windowMs).sort((a, b) => a - b);
      const need = Math.min(needed, limit);
      const excess = live.length + need - limit;
      if (excess <= 0) return 0;
      return Math.max(1, live[excess - 1] + windowMs - now + 1); // 等到最舊的 excess 個過期
    }

    /**
     * 依預算算出「每一輪至少要間隔多久」（毫秒）：讓查詢平均分散在整個視窗裡。
     * 若沒有這個，程式會先用最快的速度把預算一口氣用完，然後長時間停擺等舊查詢過期（實測會有 9 分鐘完全偵測不到票）。
     * 例：視窗 30 分鐘、預算 90、每輪 4 個查詢 → 每輪至少間隔 80 秒。
     */
    function paceMs(windowMs, callsPerRound, limit) {
      if (!limit || limit <= 0) return 0;
      return Math.ceil((windowMs * callsPerRound) / limit);
    }

    /**
     * 被限流時「學習」預算：把這次被擋時窗口內的查詢量打折，當作新的上限（只會調降，不會調升）。
     */
    function learnBudget(currentLimit, callsInWindow, factor, min) {
      const learned = Math.max(min, Math.floor(callsInWindow * factor));
      return currentLimit ? Math.min(currentLimit, learned) : learned;
    }

    /**
     * 把 src 的設定「深層合併」進 target（就地修改並回傳 target）。
     * 用途：讓使用者（或測試）用 window.ticketWatcherConfig = {...} 覆寫預設值，不必改檔案內容。
     * 只合併自己的屬性，並略過 __proto__／constructor／prototype，避免原型污染。
     */
    function deepMerge(target, src) {
      if (!src || typeof src !== 'object') return target;
      for (const key of Object.keys(src)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const v = src[key];
        const isPlain = (o) => o && typeof o === 'object' && !Array.isArray(o);
        if (isPlain(v) && isPlain(target[key])) deepMerge(target[key], v);
        else target[key] = v;
      }
      return target;
    }

    /** 存檔與鎖的鍵名要依「商品＋月份＋日期」區分，避免不同監控互相污染。 */
    const makeScope = (pathname, month, year, days) => `${pathname}|${year ?? 'auto'}-${month}|${days.join(',')}`;

    /**
     * 自適應間隔控制器：成功 → 縮短；失敗 → 依嚴重度處理。
     *  - hard（429/403/載入失敗/5xx）：退回上一級並鎖定下限
     *  - soft（逾時/舊資料/網路…）：間隔不變（避免因為小狀況就變慢），僅重新載入後重試
     */
    class IntervalController {
      constructor(cfg) {
        this.cfg = cfg;
        this.interval = cfg.start;
        this.lockedFloor = cfg.floor;
        this.stack = [];
        this.okStreak = 0;
        this.okAtFloor = 0;
        this.fails = 0;
      }

      onSuccess() {
        const c = this.cfg;
        const events = [];
        this.fails = 0;
        this.okStreak++;
        if (this.interval > this.lockedFloor) {
          this.stack.push(this.interval);
          this.interval = Math.max(this.lockedFloor, this.interval - c.step);
          this.okStreak = 0;
          events.push(`休息縮短→${this.interval / 1000}s`);
        } else {
          this.okAtFloor++;
          if (this.okAtFloor >= c.probeAfterOk && this.lockedFloor > c.floor) {
            this.lockedFloor = Math.max(c.floor, this.lockedFloor - c.step);
            this.okAtFloor = 0;
            events.push(`下限放寬→${this.lockedFloor / 1000}s`);
          }
        }
        return events;
      }

      onFailure(hard) {
        const c = this.cfg;
        const events = [];
        this.fails++;
        this.okStreak = 0;
        this.okAtFloor = 0;
        if (hard) {
          const back = this.stack.length ? this.stack.pop() : Math.min(this.interval + c.step, c.max);
          this.interval = back;
          this.lockedFloor = Math.max(this.lockedFloor, back);
          events.push(`退回上一級→${back / 1000}s`);
        } else {
          events.push('暫時性失敗：間隔不變，重新載入後重試');
        }
        return events;
      }

      /** 下一輪前要等多久（連續失敗會加倍，最多 5 倍；伺服器指定的 Retry-After 優先）。 */
      waitMs(retryAfterMs = 0) {
        const base = this.fails ? this.interval * (1 + Math.min(this.fails - 1, 4)) : this.interval;
        return Math.max(base, retryAfterMs || 0);
      }

      snapshot() {
        return { interval: this.interval, lockedFloor: this.lockedFloor, stack: [...this.stack], okAtFloor: this.okAtFloor };
      }

      restore(s) {
        const c = this.cfg;
        this.interval = Math.min(Math.max(Number(s.interval) || c.start, c.floor), c.max);
        this.lockedFloor = Math.max(Number(s.lockedFloor) || c.floor, c.floor);
        this.stack = Array.isArray(s.stack) ? s.stack.filter((n) => Number.isFinite(n)) : [];
        this.okAtFloor = Number(s.okAtFloor) || 0;
      }
    }

    return {
      ScanError, isHard, parseDays, monthDiff, ymd, isNumeric, classifyHttp,
      parseRetryAfter, extractTickets, shortSlot, diffNewTickets, makeScope, deepMerge, budgetWaitMs, paceMs, learnBudget, IntervalController,
    };
  })();

  // 在 Node（單元測試）環境只匯出核心邏輯，不執行下面的瀏覽器程式。
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Core;
    return;
  }

  // 只在最上層視窗執行。腳本每輪會建立隱藏 iframe 載入同一個網站；
  // 若用 Tampermonkey 自動啟動，沒有這行 iframe 內也會再啟動一份監控 → 遞迴失控。
  if (window.top !== window.self) return;

  // ==========================================================================
  // 1. 設定區 —— 使用者通常只需要改 month 與 days
  // ==========================================================================
  const CONFIG = {
    /** 【必改 ①】要監看「幾月」（1~12）。程式會自動切換到該月，不用算按幾次 Next。 */
    month: 10,

    /** 年份。null = 自動（沿用頁面顯示的年份；目標月份比顯示的早就當作明年）。 */
    year: null,

    /**
     * 【必改 ②】要監看「哪幾號」。寫法很彈性：
     *   '10-13'  '10,12,15-17'  '25'  [10, 11, 12]
     * 日期越多，每輪越慢、也越容易被限流。建議一次不超過 7 天。
     */
    days: '10-13',

    /** 每輪結束後的「休息時間」（毫秒）。 */
    interval: {
      start: 60_000, // 起始休息時間
      step: 10_000, // 每次成功縮短、或失敗退回的幅度
      floor: 30_000, // 下限：休息時間最短不會低於此值（越小越容易被限流；實測 10 秒約 20～30 分鐘就會被擋）
      max: 180_000, // 上限：失敗退避時最長不超過此值
      probeAfterOk: 10, // 因失敗被鎖住的下限，需在該下限連續成功幾次才放寬一級
    },

    /**
     * 查詢預算：在最近 windowMs 內，最多送 maxCalls 個「時段查詢」，超過就先等，等舊的查詢「過期」再送。
     * 為什麼要有這個：休息時間只控制「兩輪之間的間隔」，但被限流看的是「一段時間內的總量」。
     * 預設 30 分鐘 90 個（約每分鐘 3 個），依實測：30 分鐘窗口內累積 129 個查詢時被擋；
     * 之後以 90 個為上限連續跑了 60 分鐘以上（共 176 個查詢）沒有被擋。被擋時程式會依當下的量自動再調降。
     * pace: true 表示把查詢「平均分散」在整個視窗裡（每輪至少間隔 視窗×每輪查詢數÷預算），
     * 避免先猛送、用完預算後長時間停擺。maxCalls 設為 null 表示不限制（不建議）。
     */
    budget: { windowMs: 30 * 60_000, maxCalls: 90, learnFactor: 0.7, min: 30, pace: true },

    /** 啟動後先等多久才開始第一輪（毫秒）。剛被限流時可設大一點（例如 240000）。 */
    initialDelay: 0,

    /**
     * 每隔幾輪才「整頁重新載入」一次。
     * 網站每次點日期本來就會向伺服器查詢，所以不必每輪重新載入也拿得到最新資料；
     * 網站發的 token 有效 10 分鐘，過期時頁面會自己換新的。
     * 實測：每輪整頁重載會多出約 5 個請求（頁面、challenge、issueToken、月份清單…），
     * 是被限流（429）的主要推手，所以預設改成每 30 輪才重載一次。設 1 = 每輪都重載。
     * 頁面出現異常（逾時、版面錯亂…）後，下一輪一定會重新載入。
     */
    reloadEvery: 30,

    /**
     * 被限流（HTTP 429）後的暫停策略。
     * 實測（2026-09-29）：一次封鎖在第一次 429 之後 25.3 分鐘仍被擋、29.4 分鐘已恢復，沒有重開瀏覽器，
     * 而且期間送了好幾次試探／對照請求都沒有延長封鎖 → 封鎖大約 26～29 分鐘會自己解除。
     *  - blockedWaitMs：第一次被擋後，先暫停多久才送第一個試探（預設 25 分鐘）。
     *    累積到實際的封鎖時間紀錄後，會改用「已知最短封鎖時間 × 0.9」。
     *  - blockedRetryMs：第一個試探仍被擋時，之後每隔多久再試 1 個請求（預設 2 分鐘）。
     * 伺服器若有回 Retry-After，則以伺服器的為準（實測沒有回）。
     * 這只是一次實測的結果，程式會把每波封鎖的實際長度記在 state.blocks 供修正。
     */
    blockedWaitMs: 25 * 60_000,
    blockedRetryMs: 2 * 60_000,

    /** 等待時間上限（毫秒）。網路慢可以調大。 */
    timing: {
      readyTimeoutMs: 20_000, // 頁面載入並出現日曆
      ajaxTimeoutMs: 12_000, // 點日期後等待該次回應
      monthTimeoutMs: 8_000, // 按 Next／Prev 後等待月份真的換掉
      settleMaxMs: 8_000, // 等頁面「閒置」（沒有進行中的請求）的上限
      settleStableMs: 300, // 頁面連續閒置多久才算穩定
      pollMs: 100, // 輪詢頻率
      fallbackWaitMs: 3_000, // 備援模式（找不到 jQuery）點日期後固定等多久
      jitter: { min: 400, max: 1_200 }, // 每天之間的隨機間隔，避免規律到像機器
    },

    /**
     * 提醒方式（針對桌面版 Chrome：macOS / Windows）。全部預設開啟。
     *  desktop：系統通知（macOS 通知中心／Windows 動作中心），會一直停留到你按掉
     *  sound：提示音（Web Audio，不需要任何音檔）
     *  speech：語音朗讀「有票了」
     *  blinkTitle：分頁標題閃爍
     *  favicon：分頁圖示變紅點
     * 注意：Chrome 規定「第一次要有人在頁面上點一下」才能出聲，見面板上的提示。
     */
    notify: {
      desktop: true,
      sound: true,
      speech: true,
      blinkTitle: true,
      favicon: true,
      requireInteraction: true,
      /**
       * 語音（溫柔女聲）。預設指定「Google 國語（臺灣）」（Chrome 內建的網路語音，需要連網）。
       * 若找不到該聲音，或它發不出聲（例如斷網），會自動改用本機的台灣國語女聲：
       *   macOS：Meijia → Sandy／Shelley／Flo    Windows：Microsoft HanHan／Yating
       * name 填 null = 完全自動挑選（本機女聲優先）；也可填別的名稱（部分比對即可），例如 'Meijia'、'Shelley'、'Yating'。
       * 可用聲音清單：在 Console 執行  speechSynthesis.getVoices().map(v => v.name + ' | ' + v.lang)
       * rate：語速（1 = 正常，越小越慢越柔和）；pitch：音調（1 = 正常，略高聽起來較柔和）。
       */
      voice: { name: 'Google 國語（臺灣）', rate: 0.92, pitch: 1.1, text: '有票囉，請盡快前往訂票' },
      soundRepeatMs: 6_000, // 你沒看螢幕時，每隔多久再響一次
      alertDurationMs: 180_000, // 最多持續提醒多久
    },

    /** 面板外觀。 */
    panel: { fontPx: 40, widthPx: 820 },

    /** 中斷後自動接續（Chrome 重啟、分頁重開、睡眠喚醒）。 */
    resume: {
      enabled: true,
      maxAgeMs: 24 * 60 * 60 * 1000, // 存檔超過此時間視為過期
      gapMs: 10 * 60 * 1000, // 距上次存檔超過此值 = 中斷過
      cooldownMs: 120_000, // 中斷過久／上次失敗收尾時，先冷卻多久
    },

    /** 是否在執行期間要求瀏覽器保持螢幕喚醒。 */
    keepAwake: true,

    /** 使用 Web Worker 計時，降低「分頁在背景被 Chrome 節流」的影響。失敗會自動退回一般計時。 */
    workerTimers: true,

    /** 允許同時在多個分頁監控（不建議：請求加倍，更容易被限流）。 */
    allowMultipleTabs: false,

    /** 歷史紀錄最多保留幾筆。 */
    maxHistory: 200,
  };

  // 進階：可在貼上程式「之前」先設定  window.ticketWatcherConfig = { month: 11, days: '5-7' }
  // 就能覆寫上面的預設值，不必改檔案內容（Tampermonkey 使用者特別方便）。
  Core.deepMerge(CONFIG, window.ticketWatcherConfig);

  // ==========================================================================
  // 2. 防重複執行：舊實例每一步都檢查唯一 ID，發現不是自己就退出。
  // ==========================================================================
  if (window.__ticketWatcher && typeof window.__ticketWatcher.stop === 'function') {
    window.__ticketWatcher.stop();
  }
  const RUN_ID = `${Date.now()}-${Math.random()}`;
  const isAlive = () => window.__ticketWatcherRunId === RUN_ID;
  window.__ticketWatcherRunId = RUN_ID;

  // ==========================================================================
  // 3. 小工具
  // ==========================================================================
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmtTime = (t) =>
    new Date(t).toLocaleString('zh-TW', {
      hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  const { ScanError, shortSlot } = Core;

  /**
   * 計時器。優先用 Web Worker（分頁在背景時 Chrome 不會把它降到每分鐘一次），
   * 若被網站的安全設定（CSP）擋掉或發生錯誤，就自動退回一般 setTimeout。
   */
  function makeSleeper(useWorker) {
    const plain = (ms) => new Promise((r) => setTimeout(r, ms));
    const result = { sleep: plain, dispose() {}, mode: '一般計時' };
    if (!useWorker || typeof Worker === 'undefined' || typeof Blob === 'undefined') return result;
    try {
      const url = URL.createObjectURL(
        new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' }),
      );
      const worker = new Worker(url);
      const pending = new Map(); // id -> { res, ms, t0 }
      let seq = 0;
      let broken = false;
      worker.onmessage = (e) => {
        const p = pending.get(e.data);
        if (p) { pending.delete(e.data); p.res(); }
      };
      worker.onerror = () => {
        broken = true; // Worker 無法使用：把還在等的計時改用一般計時補完剩餘時間
        for (const p of pending.values()) setTimeout(p.res, Math.max(0, p.ms - (Date.now() - p.t0)));
        pending.clear();
        result.mode = '一般計時（Worker 失敗）';
      };
      result.sleep = (ms) =>
        broken ? plain(ms) : new Promise((res) => { const id = ++seq; pending.set(id, { res, ms, t0: Date.now() }); worker.postMessage({ id, ms }); });
      result.dispose = () => { try { worker.terminate(); URL.revokeObjectURL(url); } catch (_) {} };
      result.mode = 'Worker 計時';
    } catch (_) {
      /* 被 CSP 擋住等：維持一般計時 */
    }
    return result;
  }
  const sleeper = makeSleeper(CONFIG.workerTimers);
  const sleep = (ms) => sleeper.sleep(ms);

  // ==========================================================================
  // 4. 狀態
  // ==========================================================================
  const parsedDays = Core.parseDays(CONFIG.days);
  const days = parsedDays.list.map(String);
  const MONTH = CONFIG.month;
  const scope = Core.makeScope(location.pathname, MONTH, CONFIG.year, days);
  const KEY = { hist: `__tw:hist:${scope}`, state: `__tw:state:${scope}`, lock: '__tw:lock' };
  const ctl = new Core.IntervalController(CONFIG.interval);
  const BUDGET_KEEP_MS = () => Math.max(CONFIG.budget.windowMs, 10 * 60_000);

  const state = {
    label: `有票監控 ${MONTH}/${days[0] || '?'}–${MONTH}/${days[days.length - 1] || '?'}`,
    phase: '啟動',
    running: false,
    cycle: 0, // 成功完成的輪數
    attempt: 0, // 嘗試的輪數（含失敗）
    history: [], // 有票歷史 [{t, day, name, remain}]
    current: {}, // 最近一輪的有票結果
    previousKeys: new Set(),
    lastResult: '-',
    lastKind: '', // 最近一次失敗的種類
    nextAt: Date.now() + CONFIG.initialDelay,
    notice: '', // 面板上的額外提示（例如該月份尚未開放）
    events: [],
    alerts: [], // 被攔截的 iframe alert（例如「요청실패」），最多保留 50 筆
    layoutFails: 0,
    forceReload: true,
    startedAt: Date.now(),
    reqLog: [], // 每次「點日期查詢」的時間戳，用來統計最近 1／10 分鐘送了幾個
    reqTotal: 0,
    pageLoads: 0,
    monthClicks: 0,
    budget: null, // 目前生效的查詢預算（會依被擋的紀錄自動調降）
    budgetNoticeAt: 0,
    blockProbes: 0, // 這一波限流期間，已經試探了幾次
    blockStart: 0, // 這一波被限流的開始時間（0 = 目前沒被擋）
    blocks: [], // 過去每一波限流：{ from, to, minutes }，用來了解實際封鎖多久
  };

  state.budget = CONFIG.budget.maxCalls;
  try { state.history = JSON.parse(localStorage.getItem(KEY.hist) || '[]'); } catch (_) {}

  const log = (msg) => {
    const line = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} ${msg}`;
    state.events.push(line);
    if (state.events.length > 500) state.events.shift();
    console.log('[ticket-watcher]', line);
  };

  // ---- 中斷後自動接續 ----
  let resumeNote = '';
  function saveState(lastOk) {
    if (!CONFIG.resume.enabled) return;
    try {
      localStorage.setItem(KEY.state, JSON.stringify({
        savedAt: Date.now(), lastOk, cycle: state.cycle, ...ctl.snapshot(), prev: [...state.previousKeys], blocks: state.blocks.slice(-20), budget: state.budget, calls: state.reqLog.slice(-600), blockStart: state.blockStart, blockProbes: state.blockProbes,
      }));
    } catch (_) {}
  }
  if (CONFIG.resume.enabled) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY.state) || 'null');
      if (saved && Date.now() - saved.savedAt < CONFIG.resume.maxAgeMs) {
        ctl.restore(saved);
        state.cycle = saved.cycle || 0;
        if (Array.isArray(saved.blocks)) state.blocks = saved.blocks;
        // 還原「這一波限流從幾點開始」，重新載入程式後仍能算出這波持續了多久
        if (saved.blockStart && Number.isFinite(saved.blockStart) && saved.blockStart <= Date.now()) {
          state.blockStart = saved.blockStart;
          state.blockProbes = Number(saved.blockProbes) || 0;
        }
        // 還原「最近送過哪些查詢」，預算才不會因為重新貼程式／重新整理頁面而歸零
        if (Array.isArray(saved.calls)) state.reqLog = saved.calls.filter((t) => Number.isFinite(t) && Date.now() - t < BUDGET_KEEP_MS() && t <= Date.now());
        if (saved.budget && CONFIG.budget.maxCalls) state.budget = Math.min(Number(saved.budget) || CONFIG.budget.maxCalls, CONFIG.budget.maxCalls);
        const gap = Date.now() - saved.savedAt;
        if (gap > CONFIG.resume.gapMs || saved.lastOk === false) {
          // 中斷過久或上次以失敗收尾 → 先冷卻，等可能存在的限流解除
          CONFIG.initialDelay = Math.max(CONFIG.initialDelay, CONFIG.resume.cooldownMs);
          state.nextAt = Date.now() + CONFIG.initialDelay;
        }
        // 中斷不久才沿用「已通知過的票」，避免重啟後重複提醒；中斷很久則讓仍存在的票重新提醒一次
        if (gap <= CONFIG.resume.gapMs && Array.isArray(saved.prev)) state.previousKeys = new Set(saved.prev);
        resumeNote = `接續上次存檔：休息 ${ctl.interval / 1000}s／下限 ${ctl.lockedFloor / 1000}s／已 ${state.cycle} 輪` +
          (CONFIG.initialDelay ? `，先冷卻 ${Math.round(CONFIG.initialDelay / 1000)}s` : '');
      }
    } catch (_) {}
  }

  // ==========================================================================
  // 5. 提醒（針對桌面版 Chrome：macOS / Windows）
  // ==========================================================================
  const Alerter = (() => {
    const N = CONFIG.notify;
    let audioCtx = null;
    let repeatTimer = null;
    let blinkTimer = null;
    let stopTimer = null;
    let alerting = false;
    let alertText = '';
    let iconLink = null;
    let originalIconHref = null;

    const platform = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win';

    function getAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { audioCtx = new AC(); } catch (_) {} }
      }
      return audioCtx;
    }
    /** Chrome 規定：要有人在頁面上點一下（或按鍵）之後，網頁才能出聲。 */
    function unlock() {
      const c = getAudio();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    }
    const audioReady = () => !!audioCtx && audioCtx.state === 'running';

    function beep() {
      const c = getAudio();
      if (!c || c.state !== 'running') return false;
      const t0 = c.currentTime;
      [880, 1175, 880, 1175].forEach((freq, i) => {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const s = t0 + i * 0.22;
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.exponentialRampToValueAtTime(0.4, s + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
        osc.connect(gain).connect(c.destination);
        osc.start(s);
        osc.stop(s + 0.21);
      });
      return true;
    }

    // ---- 語音：挑一個台灣國語的女聲 ----
    // 已知的「男聲」名稱，自動挑選時排除（避免退而求其次時選到男聲）。
    const MALE_VOICES = /(Eddy|Reed|Rocko|Grandpa|Zhiwei|Kangkang|Danny|Yunjhe|Yunxi|Yunyang)/i;
    // 偏好順序：越前面越優先（都是女聲，Meijia 為 macOS 上最經典的台灣國語女聲）
    const FEMALE_PREFERENCE = [
      /^Meijia$/i, /Mei-?Jia|美佳/i,
      /HanHan|Hanhan|曉臻/i, /Yating|雅婷/i,
      /^Sandy \(Chinese \(Taiwan\)\)/i, /^Shelley \(Chinese \(Taiwan\)\)/i, /^Flo \(Chinese \(Taiwan\)\)/i,
      /Google 國語（臺灣）/,
    ];
    let chosenVoiceName = '';
    function pickVoice(excludeName) {
      if (!('speechSynthesis' in window)) return null;
      const all = speechSynthesis.getVoices().filter((v) => v.name !== excludeName);
      if (!all.length) return null;
      const want = N.voice && N.voice.name;
      if (want) {
        const hit = all.find((v) => v.name.toLowerCase().includes(String(want).toLowerCase()));
        if (hit) return hit;
      }
      const tw = all.filter((v) => /zh[-_]TW/i.test(v.lang) || /Taiwan|臺灣|台灣/.test(v.name));
      for (const re of FEMALE_PREFERENCE) {
        const hit = tw.find((v) => re.test(v.name));
        if (hit) return hit;
      }
      return tw.find((v) => !MALE_VOICES.test(v.name)) || all.find((v) => /^zh/i.test(v.lang) && !MALE_VOICES.test(v.name)) || null;
    }

    function speak(text, excludeName) {
      if (!N.speech || !('speechSynthesis' in window)) return;
      try {
        if (!excludeName) speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const voice = pickVoice(excludeName);
        if (voice) { u.voice = voice; u.lang = voice.lang; chosenVoiceName = voice.name; } else { u.lang = 'zh-TW'; }
        u.rate = (N.voice && N.voice.rate) || 0.92;
        u.pitch = (N.voice && N.voice.pitch) || 1.1;
        // 網路語音（Google）斷網等情況會出錯：改用「本機」的女聲再念一次（只重試一次）
        u.onerror = (e) => {
          if (excludeName || !voice || e.error === 'canceled' || e.error === 'interrupted') return;
          const local = speechSynthesis.getVoices().filter((v) => v.localService && /zh[-_]TW/i.test(v.lang) && !MALE_VOICES.test(v.name));
          const pref = FEMALE_PREFERENCE.map((re) => local.find((v) => re.test(v.name))).find(Boolean);
          if (pref) { N.voice = { ...N.voice, name: pref.name }; speak(text, voice.name); }
        };
        speechSynthesis.speak(u);
      } catch (_) {}
    }

    // ---- 通知權限：以 navigator.permissions.query 為準 ----
    // 實測：在某些環境（例如被自動化工具控制的分頁）Notification.permission 會一直回報 'denied'，
    // 但實際上通知是允許的（permissions.query 回報 granted，而且 new Notification 真的會顯示）。
    // 所以不能用 Notification.permission 來決定「要不要發」，否則有票時會靜悄悄地不通知。
    let permState = 'prompt'; // 'granted' | 'denied' | 'prompt'
    async function refreshPerm() {
      try {
        const q = await navigator.permissions.query({ name: 'notifications' });
        permState = q.state;
        q.onchange = () => { permState = q.state; };
      } catch (_) {
        const p = 'Notification' in window ? Notification.permission : 'denied';
        permState = p === 'default' ? 'prompt' : p;
      }
    }

    function desktop(title, body) {
      if (!N.desktop || !('Notification' in window) || permState === 'denied') return;
      if (permState === 'prompt') { Notification.requestPermission().then(refreshPerm); return; }
      try {
        const n = new Notification(title, { body, tag: 'ticket-watcher', renotify: true, requireInteraction: N.requireInteraction });
        n.onclick = () => { window.focus(); n.close(); acknowledge(); };
        n.onerror = () => log('桌面通知發送失敗（請檢查 macOS／Windows 的系統通知設定與專注模式）');
      } catch (e) {
        log(`桌面通知發送失敗：${e.message}`);
      }
    }

    function setFavicon(on) {
      if (!N.favicon) return;
      try {
        if (!iconLink) {
          iconLink = document.querySelector('link[rel~="icon"]');
          originalIconHref = iconLink ? iconLink.href : null;
          if (!iconLink) { iconLink = document.createElement('link'); iconLink.rel = 'icon'; document.head.appendChild(iconLink); }
        }
        if (on) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 32;
          const g = cv.getContext('2d');
          g.fillStyle = '#e00020';
          g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('!', 16, 17);
          iconLink.href = cv.toDataURL('image/png');
        } else if (originalIconHref) {
          iconLink.href = originalIconHref;
        } else {
          iconLink.remove(); iconLink = null;
        }
      } catch (_) {}
    }

    /** 只發桌面通知的「警示」（例如被限流暫停），不出聲、不閃爍。 */
    function warn(title, body) {
      desktop(title, body);
    }

    /** 使用者已經看到了（點擊、按鍵、回到分頁）→ 停止吵人，但面板仍保持紅色。 */
    function acknowledge() {
      if (!alerting) return;
      alerting = false;
      clearInterval(repeatTimer); clearInterval(blinkTimer); clearTimeout(stopTimer);
      try { speechSynthesis.cancel(); } catch (_) {}
      setFavicon(false);
      if (typeof onAckTitle === 'function') onAckTitle();
    }
    let onAckTitle = null;

    const userLooking = () => document.hasFocus() && !document.hidden;

    /** 觸發提醒。text 是簡短描述（例如「10/11 5班10:30-11:00 剩3」）。 */
    function fire(text, opts = {}) {
      alertText = text;
      desktop('🎫 有票了！', text);
      beep();
      speak(opts.test ? '這是測試提醒，有票的時候我會這樣叫你' : (N.voice && N.voice.text) || '有票囉');
      document.title = `🎫有票! ${alertText}`; // 立刻改標題，不必等第一次閃爍
      if (alerting) return; // 已在提醒中，只更新內容
      alerting = true;
      setFavicon(true);
      if (N.blinkTitle) {
        let on = false;
        blinkTimer = setInterval(() => {
          on = !on;
          document.title = on ? `🔔🔔 有票了！ ${alertText}` : `🎫有票! ${alertText}`;
        }, 900);
      }
      // 你沒在看螢幕時，定期再響；你一回來看（或點一下）就停
      repeatTimer = setInterval(() => {
        if (userLooking()) { acknowledge(); return; }
        beep();
      }, N.soundRepeatMs);
      stopTimer = setTimeout(acknowledge, N.alertDurationMs);
    }

    /**
     * 面板最後兩行的說明文字。設計原則：一眼看得懂；沒問題就只顯示 ✅，有問題才告訴你怎麼處理。
     */
    function status() {
      let notifyLine;
      if (!N.desktop) notifyLine = '— 已關閉';
      else if (!('Notification' in window)) notifyLine = '❌ 這個瀏覽器不支援';
      else if (permState === 'granted') notifyLine = '✅ 已開啟';
      else if (permState === 'denied') notifyLine = '❌ 被封鎖（網址列左側 🔒 → 通知 → 允許）';
      else notifyLine = '❓ 尚未允許（請在跳出的視窗按「允許」）';

      let soundLine;
      if (!N.sound && !N.speech) soundLine = '— 已關閉';
      else if (audioReady()) soundLine = '✅ 已啟用';
      else soundLine = '🔇 尚未啟用（請在頁面上點一下）';

      return `🔔 桌面通知：${notifyLine}\n🔊 提示音與語音：${soundLine}`;
    }

    function tips() {
      const tip = platform === 'mac'
        ? 'macOS：系統設定 → 通知 → Google Chrome 要允許通知，且不要開「專注模式／勿擾」'
        : 'Windows：設定 → 系統 → 通知 要開啟，且不要開「專注助理／勿擾」';
      return `${tip}；並在 Chrome 網址列左側的鎖頭 → 網站設定 → 通知 設為「允許」`;
    }

    function init() {
      refreshPerm().then(() => {
        if (N.desktop && 'Notification' in window && permState === 'prompt') Notification.requestPermission().then(refreshPerm);
      });
      const permPoll = setInterval(refreshPerm, 5_000); // 使用者中途去改設定，也能很快反映
      const evs = ['pointerdown', 'keydown', 'click'];
      const handler = () => { unlock(); acknowledge(); };
      evs.forEach((e) => document.addEventListener(e, handler, true));
      window.addEventListener('focus', () => { unlock(); if (alerting) setTimeout(() => userLooking() && acknowledge(), 500); });
      getAudio();
      unlock();
      try { speechSynthesis.getVoices(); } catch (_) {} // 先「暖機」，語音清單是非同步載入的
      return () => { evs.forEach((e) => document.removeEventListener(e, handler, true)); clearInterval(permPoll); };
    }

    return {
      fire, warn, acknowledge, status, tips, init, audioReady,
      isAlerting: () => alerting,
      voiceName: () => { const v = pickVoice(); return v ? v.name : '(系統預設)'; },
      setAckTitleHandler: (fn) => { onAckTitle = fn; },
      dispose() { acknowledge(); try { audioCtx && audioCtx.close(); } catch (_) {} },
    };
  })();
  const detachAlertListeners = Alerter.init();

  const originalTitle = document.title.replace(/^(🎫有票!|🔔🔔 有票了！).*/, '预订') || '预订';
  function setTitleFromFound(found) {
    const hitDays = Object.keys(found);
    document.title = hitDays.length
      ? '🎫有票! ' + hitDays.map((d) => `${d} ` + found[d].map((x) => shortSlot(x.name)).join('、')).join(' | ')
      : originalTitle;
  }
  Alerter.setAckTitleHandler(() => { if (isAlive()) setTitleFromFound(state.current); });

  // ==========================================================================
  // 6. 畫面面板
  // ==========================================================================
  let panel = document.getElementById('__ticket_watcher_panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = '__ticket_watcher_panel';
    document.body.appendChild(panel);
  }
  panel.style.cssText = [
    'position:fixed', 'right:16px', 'top:16px', 'z-index:2147483647',
    `width:${CONFIG.panel.widthPx}px`, 'max-width:calc(100vw - 32px)', 'max-height:92vh', 'overflow:auto',
    'box-sizing:border-box', 'background:#111', 'color:#fff',
    `font:700 ${CONFIG.panel.fontPx}px/1.45 -apple-system,"PingFang TC","Microsoft JhengHei",sans-serif`,
    'padding:24px 28px', 'border-radius:14px', 'box-shadow:0 4px 20px #000a',
    'white-space:pre-wrap', 'overflow-wrap:anywhere', 'pointer-events:none',
  ].join(';');

  let lockWarning = '';
  function render() {
    const secs = Math.max(0, Math.round((state.nextAt - Date.now()) / 1000));
    let text =
      `🎫 ${state.label}\n` +
      `查完休息: ${ctl.interval / 1000} 秒 (下限 ${ctl.lockedFloor / 1000})\n` +
      `狀態: ${state.phase}\n` +
      `輪數: ${state.cycle}  連續成功: ${ctl.okStreak}  失敗: ${ctl.fails}\n` +
      `下一輪: ${state.running ? '執行中…' : secs + ' 秒'}\n` +
      `上次: ${state.lastResult}\n` +
      Alerter.status();
    text += `\n📊 查詢預算 ${state.reqLog.filter((t) => Date.now() - t < CONFIG.budget.windowMs).length}/${state.budget || '不限'}（近 ${Math.round(CONFIG.budget.windowMs / 60000)} 分鐘）` +
      (CONFIG.budget.pace && state.budget ? `，每輪至少間隔 ${Math.round(Core.paceMs(CONFIG.budget.windowMs, days.length, state.budget) / 1000)} 秒` : '');
    if (state.notice) text += `\nℹ️ ${state.notice}`;
    if (lockWarning) text += `\n⚠ ${lockWarning}`;
    if (document.hidden) text += '\n⚠ 分頁在背景，可能變慢，建議放前景或獨立視窗';

    const hitDays = Object.keys(state.current);
    if (hitDays.length) {
      text += '\n【目前有票】\n' +
        hitDays.map((d) => `${d} ` + state.current[d].map((x) => `${shortSlot(x.name)}(剩${x.remain})`).join('、')).join('\n');
    }
    const recent = state.history.slice(-6).reverse();
    if (recent.length) {
      text += '\n【歷史紀錄】\n' + recent.map((h) => `${fmtTime(h.t)} → ${h.day} ${shortSlot(h.name)} 剩${h.remain}`).join('\n');
    }
    panel.textContent = text;
    panel.style.background = hitDays.length ? '#b00020' : '#111';
  }
  const renderTimer = setInterval(() => (isAlive() ? render() : clearInterval(renderTimer)), 1000);
  render(); // 啟動時立刻畫一次，不必等 1 秒

  // ==========================================================================
  // 7. 多分頁保護（同一網站的 localStorage 在各分頁間共用，用心跳判斷是否已有人在跑）
  // ==========================================================================
  // 心跳每 10 秒一次（用 Worker 計時，分頁在背景也不會被拖慢）；超過 90 秒沒有心跳就視為對方已經不在。
  const LOCK_STALE_MS = 90_000;
  function readLock() {
    try { return JSON.parse(localStorage.getItem(KEY.lock) || 'null'); } catch (_) { return null; }
  }
  function beat() {
    try {
      const cur = readLock();
      if (cur && cur.id !== RUN_ID && Date.now() - cur.t < LOCK_STALE_MS) {
        lockWarning = '偵測到另一個分頁也在監控，請關掉其中一個';
        return;
      }
      lockWarning = '';
      localStorage.setItem(KEY.lock, JSON.stringify({ id: RUN_ID, t: Date.now() }));
    } catch (_) {}
  }
  function releaseLock() {
    try { const cur = readLock(); if (cur && cur.id === RUN_ID) localStorage.removeItem(KEY.lock); } catch (_) {}
  }
  function acquireLock() {
    if (CONFIG.allowMultipleTabs) return null;
    const cur = readLock();
    if (cur && cur.id !== RUN_ID && Date.now() - cur.t < LOCK_STALE_MS) {
      const wait = Math.max(1, Math.ceil((LOCK_STALE_MS - (Date.now() - cur.t)) / 1000));
      return `偵測到另一個分頁／視窗正在監控（${Math.round((Date.now() - cur.t) / 1000)} 秒前有動靜）。\n` +
        `・如果你剛剛才重新整理頁面或重開 Chrome，那只是舊的殘留紀錄，約 ${wait} 秒後會自動解除，到時再貼一次即可。\n` +
        `・如果真的有另一個分頁在跑，請先關掉它（同時跑兩個請求會加倍，更容易被限流）。`;
    }
    beat();
    // 重新整理／關閉分頁時主動釋放鎖，避免留下殘留紀錄
    window.addEventListener('pagehide', releaseLock);
    (async () => { while (isAlive()) { await sleep(10_000); if (isAlive()) beat(); } })();
    return null;
  }

  // ==========================================================================
  // 8. 核心：掃描
  // ==========================================================================
  const findLink = (doc, text) => [...doc.querySelectorAll('a')].find((a) => a.textContent.trim() === text);

  /** 備援：讀畫面上的時段文字，例如「17회차(16:30 ~ 17:00) 입장 [剩余:售罄]」。 */
  const readSlotsFromDom = (doc) =>
    [...new Set(
      [...doc.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && /입장/.test(e.textContent) && /剩余/.test(e.textContent))
        .map((e) => e.textContent.trim()),
    )];

  function readShownMonth(doc) {
    const el = [...doc.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\s*\d{4}\s+\d{1,2}\s*$/.test(e.textContent));
    if (!el) return null;
    const m = el.textContent.trim().match(/^(\d{4})\s+(\d{1,2})$/);
    return { y: Number(m[1]), m: Number(m[2]) };
  }

  /** 輪詢等待條件成立（事件驅動的基礎，比固定 sleep 快也更可靠）。 */
  async function waitFor(fn, timeoutMs, what, kind = 'timeout', stepMs = CONFIG.timing.pollMs) {
    const t0 = Date.now();
    for (;;) {
      if (!isAlive()) throw new ScanError('unknown', '已被新版本取代');
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new ScanError(kind, `等待逾時：${what}`);
      await sleep(stepMs);
    }
  }

  /** 等頁面「閒置」：jQuery 沒有進行中的請求，並且連續 300ms 維持這個狀態。 */
  async function settle(win, maxMs) {
    let idleSince = 0;
    const t0 = Date.now();
    for (;;) {
      if (!isAlive()) throw new ScanError('unknown', '已被新版本取代');
      const idle = !win.jQuery || win.jQuery.active === 0;
      if (idle) {
        if (!idleSince) idleSince = Date.now();
        else if (Date.now() - idleSince >= CONFIG.timing.settleStableMs) return;
      } else {
        idleSince = 0;
      }
      if (Date.now() - t0 > maxMs) throw new ScanError('timeout', '頁面一直忙碌（請求沒有結束）');
      await sleep(CONFIG.timing.pollMs);
    }
  }

  // ---- iframe 工作階段（可重複使用，每 reloadEvery 輪或失敗後才重新載入）----
  let session = null; // { frame, win, doc, uses }
  function disposeSession() {
    if (session && session.frame) session.frame.remove();
    session = null;
  }
  async function openSession() {
    disposeSession();
    state.phase = '重新載入頁面…';
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-2000px;width:1200px;height:900px';
    frame.src = `${location.pathname}?_=${Date.now()}`;
    document.body.appendChild(frame);
    state.pageLoads++;
    session = { frame, win: null, doc: null, uses: 0 };

    // 網站在請求失敗時會 alert('요청실패')；alert 會卡住整個瀏覽器，所以改成「只記錄、不彈窗」。
    const quiet = (m) => { state.alerts.push(String(m)); if (state.alerts.length > 50) state.alerts.shift(); };
    const patch = setInterval(() => { try { frame.contentWindow.alert = quiet; frame.contentWindow.confirm = () => true; } catch (_) {} }, 20);
    try {
      await new Promise((resolve, reject) => {
        frame.onload = resolve;
        sleep(CONFIG.timing.readyTimeoutMs).then(() => reject(new ScanError('load', '頁面載入逾時（可能被暫時封鎖）')));
      });
    } finally {
      clearInterval(patch);
    }
    const win = frame.contentWindow;
    win.alert = quiet;
    win.confirm = () => true;
    const doc = frame.contentDocument;
    // 等日曆出現且 jQuery 可用；等不到通常表示被擋或網站改版
    // jQuery 不是必要條件：沒有時會走備援（讀畫面文字）
    await waitFor(() => findLink(doc, 'Next'), CONFIG.timing.readyTimeoutMs, '日曆出現', 'load');
    await settle(win, CONFIG.timing.readyTimeoutMs);
    session.win = win;
    session.doc = doc;
  }

  /** 依 CONFIG.month／year 自動按 Next／Prev，並等待月份真的換了、請求結束。回傳目前年份。 */
  async function gotoMonth({ win, doc }) {
    for (let guard = 0; guard < 24; guard++) {
      const shown = readShownMonth(doc);
      if (!shown) throw new ScanError('layout', '讀不到日曆上的年月標題（網站版面可能改了）');
      const { diff, targetYear } = Core.monthDiff(shown, MONTH, CONFIG.year);
      if (diff === 0) return targetYear;
      const link = findLink(doc, diff > 0 ? 'Next' : 'Prev');
      if (!link) throw new ScanError('layout', '找不到切換月份的按鈕（Next／Prev）');
      link.click();
      state.monthClicks++;
      try {
        await waitFor(() => { const s = readShownMonth(doc); return s && (s.y !== shown.y || s.m !== shown.m); }, CONFIG.timing.monthTimeoutMs, '切換月份');
      } catch (e) {
        if (e.kind === 'timeout') throw new ScanError('notopen', `切不到 ${MONTH} 月：該月份可能尚未開放預訂，會持續等待`);
        throw e;
      }
      await settle(win, CONFIG.timing.settleMaxMs);
    }
    throw new ScanError('notopen', `切不到 ${MONTH} 月，請確認月份設定，或該月份尚未開放`);
  }

  /**
   * 被擋時把「伺服器到底說了什麼」記下來（只記標頭名稱、少數安全的標頭值、內容前 120 字；不記 Cookie）。
   * 這是為了讓「為什麼被限流」有憑有據，不必靠猜。
   */
  function diagnoseResponse(kind, status, xhr) {
    try {
      const raw = (xhr.getAllResponseHeaders && xhr.getAllResponseHeaders()) || '';
      const names = raw.split(/\r?\n/).map((l) => l.split(':')[0].trim().toLowerCase()).filter(Boolean);
      const pick = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'content-type', 'server']
        .map((h) => { const v = xhr.getResponseHeader && xhr.getResponseHeader(h); return v ? `${h}=${v}` : ''; }).filter(Boolean);
      const body = String(xhr.responseText || '').replace(/\s+/g, ' ').slice(0, 120);
      state.lastDiag = { kind, status, headerNames: names, headers: pick, body, stats: requestStats() };
      log(`🔍 診斷[${kind} HTTP ${status}] ${statsText()}`);
      log(`🔍 回應標頭名稱：${names.join(', ') || '(無)'}${pick.length ? '；' + pick.join('；') : ''}；內容：${body || '(空)'}`);
    } catch (_) {}
  }

  /** 記錄「送出了一個時段查詢」，供診斷用。 */
  function countRequest() {
    const now = Date.now();
    state.reqTotal++;
    state.reqLog.push(now);
    if (state.reqLog.length > 5000) state.reqLog.splice(0, state.reqLog.length - 5000); // 安全上限，避免異常情況下無限增長
    while (state.reqLog.length && now - state.reqLog[0] > BUDGET_KEEP_MS()) state.reqLog.shift();
  }
  function requestStats() {
    const now = Date.now();
    const last = (ms) => state.reqLog.filter((t) => now - t <= ms).length;
    return { total: state.reqTotal, last1: last(60_000), last10: last(600_000), lastWindow: last(CONFIG.budget.windowMs), budget: state.budget, pageLoads: state.pageLoads, monthClicks: state.monthClicks,
      runMin: Math.round((now - state.startedAt) / 6000) / 10 };
  }
  const statsText = () => { const r = requestStats(); return `本次執行 ${r.runMin} 分鐘：時段查詢共 ${r.total} 次（近 1 分鐘 ${r.last1}、近 10 分鐘 ${r.last10}、近 ${Math.round(CONFIG.budget.windowMs / 60000)} 分鐘 ${r.lastWindow}／預算 ${r.budget || '不限'}），載入頁面 ${r.pageLoads} 次，切換月份 ${r.monthClicks} 次`; };

  /**
   * 點一個日期，並「旁聽」網站自己發出的時段查詢（getDateScheduleList）。
   * 用請求裡的 sdDate 比對，確保收到的是「這一次點擊」的回應，而不是上一天的。
   * 回傳 { tickets:[{name,remain}], total, source } 或丟出 ScanError。
   */
  async function fetchDay({ win, doc }, dayStr, year) {
    const link = findLink(doc, dayStr);
    if (!link) return { skipped: true, tickets: [], total: 0 }; // 該月沒有這一天（例如 9 月沒有 31 號）
    const expected = Core.ymd(year, MONTH, Number(dayStr));
    const $ = win.jQuery;

    let captured = null;
    if ($) {
      captured = await new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, v) => { if (done) return; done = true; $(win.document).off('ajaxComplete', handler); fn(v); };
        const handler = (_e, xhr, settings) => {
          if (!/getDateScheduleList/.test(String((settings && settings.url) || ''))) return;
          let sent = null;
          try { sent = settings.data && settings.data.get ? settings.data.get('sdDate') : null; } catch (_) {}
          if (sent && sent !== expected) return; // 別天的回應，繼續等
          // 注意：jqXHR 是「類 Promise」物件，直接 resolve(xhr) 會被自動拆開成回應內容，所以外面包一層
          finish(resolve, { xhr });
        };
        $(win.document).on('ajaxComplete', handler);
        countRequest();
        sleep(CONFIG.timing.ajaxTimeoutMs).then(() => finish(reject, new ScanError('timeout', `${MONTH}/${dayStr} 等不到查詢回應`)));
        link.click();
      });
    } else {
      countRequest();
      link.click();
      await sleep(CONFIG.timing.fallbackWaitMs);
    }

    if (captured) {
      const xhr = captured.xhr;
      const status = xhr.status;
      const kind = Core.classifyHttp(status);
      if (kind) {
        const retry = Core.parseRetryAfter(xhr.getResponseHeader && xhr.getResponseHeader('Retry-After'));
        diagnoseResponse(kind, status, xhr);
        throw new ScanError(kind, `${MONTH}/${dayStr} HTTP ${status}`, { retryAfterMs: retry || 0 });
      }
      const json = xhr.responseJSON;
      const rows = json && Array.isArray(json.data) ? json.data : null;
      if (rows) {
        const wrong = rows.find((r) => r.sdDate && String(r.sdDate) !== expected);
        if (wrong) throw new ScanError('stale', `${MONTH}/${dayStr} 收到的是 ${wrong.sdDate} 的資料（不是這天）`);
        if (!rows.length) return { tickets: [], total: 0, empty: true, source: 'json' }; // 該日沒有場次（不是失敗）
        if (rows.every((r) => Core.isNumeric(r.sdRemainder))) {
          return { tickets: Core.extractTickets(rows), total: rows.length, source: 'json' };
        }
      }
    }

    // 備援：API 格式不如預期（或沒有 jQuery）→ 改讀畫面文字
    await settle(win, CONFIG.timing.settleMaxMs);
    const slots = readSlotsFromDom(doc);
    if (!slots.length) throw new ScanError('stale', `${MONTH}/${dayStr} 讀不到任何時段`);
    const tickets = [];
    for (const text of slots) {
      const m = text.match(/剩余:\s*(\d+)/);
      if (m && Number(m[1]) > 0) tickets.push({ name: text.replace(/\s*\[.*$/, ''), remain: Number(m[1]) });
    }
    return { tickets, total: slots.length, source: 'dom' };
  }

  /** 掃描一輪；成功回傳 { found, seen, skipped, empties, sources }，失敗丟出 ScanError。 */
  async function scanOnce() {
    const startedAt = Date.now();
    if (!session || state.forceReload || session.uses >= CONFIG.reloadEvery) await openSession();
    session.uses++;
    state.forceReload = false;

    const year = await gotoMonth(session);
    const found = {};
    const skipped = [];
    const empties = [];
    const sources = new Set();
    let seen = 0;
    for (const d of days) {
      if (!isAlive()) throw new ScanError('unknown', '已被新版本取代');
      state.phase = `讀取 ${MONTH}/${d}…`;
      const r = await fetchDay(session, d, year);
      if (r.skipped) { skipped.push(d); continue; }
      if (r.empty) empties.push(d);
      seen += r.total;
      sources.add(r.source);
      if (r.tickets.length) found[`${MONTH}/${d}`] = r.tickets;
      await sleep(rand(CONFIG.timing.jitter.min, CONFIG.timing.jitter.max));
    }
    if (skipped.length === days.length) throw new ScanError('layout', '日曆上一個目標日期都找不到（月份不對或網站改版）');
    return { startedAt, found, seen, skipped, empties, sources: [...sources] };
  }

  // ==========================================================================
  // 9. 主迴圈
  // ==========================================================================
  function applyResult(res) {
    state.current = res.found;
    const { keys, added } = Core.diffNewTickets(res.found, state.previousKeys);
    state.previousKeys = keys;
    for (const a of added) {
      state.history.push({ t: res.startedAt, day: a.day, name: a.name, remain: a.remain });
      if (state.history.length > CONFIG.maxHistory * 2) state.history.splice(0, state.history.length - CONFIG.maxHistory); // 記憶體中也要設上限（存檔只留最後 maxHistory 筆）
      log(`★新增有票 ${a.day} ${shortSlot(a.name)} 剩${a.remain}`);
    }
    try { localStorage.setItem(KEY.hist, JSON.stringify(state.history.slice(-CONFIG.maxHistory))); } catch (_) {}
    if (added.length) Alerter.fire(added.map((a) => `${a.day} ${shortSlot(a.name)} 剩${a.remain}`).join('、'));

    if (!Alerter.isAlerting()) setTitleFromFound(res.found);
    const n = Object.keys(res.found).length;
    const extra = (res.skipped.length ? ` 略過:${res.skipped.join(',')}(該月無此日)` : '') +
      (res.empties.length ? ` 無場次:${res.empties.join(',')}` : '');
    state.lastResult = `${fmtTime(res.startedAt)} ${days.length - res.skipped.length}天/${res.seen}筆, ` +
      (n ? `${n}天有票!` : '全售罄') + extra;
    state.notice = '';
    log(`結果: ${state.lastResult}  [資料來源:${res.sources.join('+') || '-'}]`);
  }

  async function mainLoop() {
    if (CONFIG.initialDelay) {
      state.phase = '冷卻中';
      await sleep(CONFIG.initialDelay);
    }
    while (isAlive()) {
      // 先檢查查詢預算：最近一段時間送得太多，就等舊的查詢「過期」再送，避免自己把自己送進限流
      // （限流期間的「試探」只是為了確認有沒有恢復，不受預算限制；否則預算被調降後試探會被無限期往後推）
      const bw = state.blockStart ? 0 : Core.budgetWaitMs(state.reqLog, Date.now(), CONFIG.budget.windowMs, state.budget, days.length);
      if (bw > 0) {
        if (Date.now() - state.budgetNoticeAt > 5 * 60_000) {
          state.budgetNoticeAt = Date.now();
          log(`⏳ 為避免超過查詢預算（每 ${Math.round(CONFIG.budget.windowMs / 60000)} 分鐘最多 ${state.budget} 個），先暫停約 ${Math.round(bw / 1000)} 秒`);
        }
        state.running = false;
        state.phase = '節流等待（查詢預算）';
        const chunk = Math.min(bw, 30_000);
        state.nextAt = Date.now() + chunk;
        await sleep(chunk);
        continue;
      }
      state.running = true;
      state.attempt++;
      const roundStartedAt = Date.now();
      let err = null;
      try {
        const res = await scanOnce();
        if (!isAlive()) return;
        applyResult(res);
        state.cycle++;
        state.layoutFails = 0;
        state.lastKind = '';
        if (state.blockStart) {
          const minutes = Math.round((Date.now() - state.blockStart) / 6000) / 10;
          state.blocks.push({ from: state.blockStart, to: Date.now(), minutes, probes: state.blockProbes, stats: requestStats() });
          if (state.blocks.length > 50) state.blocks.splice(0, state.blocks.length - 50);
          state.blockProbes = 0;
          log(`✅ 已恢復：這波限流從第一次 429 起約 ${minutes} 分鐘（期間試探 ${state.blocks[state.blocks.length - 1].probes} 次，沒有重開瀏覽器）`);
          state.blockStart = 0;
          state.notice = '';
        }
        ctl.onSuccess().forEach(log);
      } catch (e) {
        err = e instanceof ScanError ? e : new ScanError('unknown', e && e.message ? e.message : String(e));
      }
      if (!isAlive()) return;

      if (err) {
        // 頁面可能已經壞掉的失敗（逾時、版面錯亂…）→ 下一輪重新載入。
        // 429（純粹被限流）頁面本身沒問題，重載只會多送請求，所以不重載。
        // 403 則可能是 token 過期（token 只有 10 分鐘）→ 一定要重載拿新 token，不能拿舊的一直試。
        if (err.kind !== 'rate_limit') state.forceReload = true;
        state.lastKind = err.kind;
        state.layoutFails = err.kind === 'layout' ? state.layoutFails + 1 : 0;
        ctl.onFailure(Core.isHard(err.kind)).forEach(log);
        state.lastResult = `${fmtTime(Date.now())} 失敗[${err.kind}]: ${err.message}`;
        if (err.kind === 'notopen') state.notice = err.message;
        log(`失敗[${err.kind}]: ${err.message}` + (err.retryAfterMs ? `（伺服器要求等 ${Math.round(err.retryAfterMs / 1000)}s）` : ''));
        if (state.layoutFails >= 3) {
          fatal('連續 3 次找不到日曆上的元素，網站版面可能改版了，或這個頁面不是訂票頁。請確認頁面後重新貼上程式。');
          return;
        }
      }
      let wait = ctl.waitMs(err ? err.retryAfterMs : 0);
      if (CONFIG.budget.pace) {
        // 依預算「平均分散」：兩輪開始之間至少要相隔 spacing（扣掉這一輪已經花掉的時間）
        const spacing = Core.paceMs(CONFIG.budget.windowMs, days.length, state.budget);
        const need = spacing - (Date.now() - roundStartedAt);
        if (need > wait) wait = need;
      }
      // 403 先當作「token 過期」：下一輪重載拿新 token 再試；換了新頁面仍連續 403 才當作真的被擋。
      const blockedForReal = err && err.kind === 'blocked' && ctl.fails >= 2;
      if (err && err.kind === 'rate_limit' && CONFIG.budget.maxCalls && !state.blockStart) {
        // （只在「第一次」被擋時學習；封鎖中的試探失敗時窗口裡本來就沒什麼查詢，學到的數字沒有意義）
        // 依這次被擋時「窗口內已經送了多少查詢」，把預算調降（只降不升）
        const inWindow = state.reqLog.filter((t) => Date.now() - t < CONFIG.budget.windowMs).length;
        const learned = Core.learnBudget(state.budget, inWindow, CONFIG.budget.learnFactor, CONFIG.budget.min);
        if (learned !== state.budget) {
          log(`📉 被擋時窗口內已送 ${inWindow} 個查詢 → 查詢預算調降：${state.budget} → ${learned}（每 ${Math.round(CONFIG.budget.windowMs / 60000)} 分鐘）`);
          state.budget = learned;
        }
      }
      if (err && (err.kind === 'rate_limit' || blockedForReal)) {
        // 被限流：快速重試沒有用，直接暫停到預期的解除時間附近，之後每隔一小段時間只送 1 個請求試探
        let pause;
        if (state.blockStart) {
          // 已經在封鎖中：這是一次「試探仍被擋」
          state.blockProbes++;
          log(`🔍 限流期間第 ${state.blockProbes} 次試探仍被擋（距第一次 429 已 ${Math.round((Date.now() - state.blockStart) / 6000) / 10} 分鐘，沒有重開瀏覽器）`);
          pause = CONFIG.blockedRetryMs;
        } else {
          // 第一次被擋
          state.blockProbes = 0;
          state.blockStart = Date.now();
          const known = state.blocks.map((b) => b.minutes * 60_000).filter((ms) => ms > 0);
          pause = known.length ? Math.max(CONFIG.blockedRetryMs, Math.min(...known) * 0.9) : CONFIG.blockedWaitMs;
          Alerter.warn('⚠ 監控被網站限流', `預計暫停約 ${Math.round(pause / 60000)} 分鐘後自動重試，期間不會偵測有票。`);
        }
        wait = Math.max(err.retryAfterMs || 0, pause); // 封鎖期間只由封鎖策略決定要等多久（不疊加「連續失敗倍數」）
        state.notice = `被網站限流(429)，暫停到 ${new Date(Date.now() + wait).toLocaleTimeString('zh-TW', { hour12: false })} 再試`;
        log(`⏸ 被限流，暫停 ${Math.round(wait / 1000)}s 後只送 1 個請求試探`);
      }
      saveState(!err); // 放在這裡，才會把剛設定好的 blockStart 一起存起來
      state.running = false;
      state.phase = '等待下一輪';
      state.nextAt = Date.now() + wait;
      await sleep(wait);
    }
  }

  // ==========================================================================
  // 10. 對外介面（Console 用）與啟動
  // ==========================================================================
  function fatal(msg) {
    panel.textContent = `⚠️ 已停止\n${msg}`;
    panel.style.background = '#b00020';
    panel.style.pointerEvents = 'auto';
    panel.onclick = () => panel.remove();
    console.error('[ticket-watcher]', msg);
    cleanup(false);
  }

  let wakeLock = null;
  let wakeLockPending = false;
  async function keepAwake() {
    if (!CONFIG.keepAwake || !('wakeLock' in navigator) || !isAlive()) return;
    if ((wakeLock && wakeLock.released === false) || wakeLockPending) return; // 已經持有（或正在要求），不重複要
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!isAlive()) { lock.release(); return; } // 等待期間已經被停止：立刻釋放，避免洩漏
      wakeLock = lock;
      log('已啟用「保持螢幕喚醒」');
    } catch (e) {
      log(`無法啟用保持喚醒（${e.message}）。請手動設定電腦不要睡眠`);
    } finally {
      wakeLockPending = false;
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  function cleanup(removePanel = true) {
    window.__ticketWatcherRunId = null;
    detachAlertListeners();
    Alerter.dispose();
    disposeSession();
    releaseLock();
    window.removeEventListener('pagehide', releaseLock);
    sleeper.dispose();
    try { wakeLock && wakeLock.release(); } catch (_) {}
    if (removePanel) document.getElementById('__ticket_watcher_panel')?.remove();
    document.title = originalTitle;
  }

  function download(filename, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.__ticketWatcher = {
    state, config: CONFIG, controller: ctl, core: Core,
    alerter: { status: () => Alerter.status(), voiceName: () => Alerter.voiceName(), isAlerting: () => Alerter.isAlerting() },
    stop() { cleanup(true); log('已停止'); },
    resetSaved() {
      try { localStorage.removeItem(KEY.state); } catch (_) {}
      log('已清除接續存檔');
    },
    diagnostics() { return { stats: requestStats(), lastDiag: state.lastDiag || null, blocks: state.blocks, blockStart: state.blockStart }; },
    testAlert() { Alerter.fire('這是測試提醒（不是真的有票）', { test: true }); return Alerter.status(); },
    log: () => state.events.slice(),
    history: () => state.history.map((h) => `${fmtTime(h.t)} ${h.day} ${shortSlot(h.name)} 剩${h.remain}`),
    /** 匯出有票歷史（CSV）。 */
    exportHistory() {
      const rows = [['時間', '日期', '時段', '剩餘']].concat(
        state.history.map((h) => [new Date(h.t).toISOString(), h.day, h.name, h.remain]),
      );
      download('ticket-history.csv', rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
    },
    /** 匯出完整事件記錄（純文字）。 */
    exportLog() { download('ticket-watcher-log.txt', state.events.join('\n'), 'text/plain'); },
  };

  // ---- 啟動前自動檢查（preflight）：把常見錯誤變成看得懂的中文提示 ----
  function preflight() {
    if (parsedDays.error) return `日期設定有問題：${parsedDays.error}`;
    if (!Number.isInteger(MONTH) || MONTH < 1 || MONTH > 12) return '月份 month 必須是 1 到 12 的數字';
    if (!findLink(document, 'Next')) {
      return '這個頁面找不到日曆。請先在瀏覽器打開「訂票頁」（要看得到日曆和「預訂日期」），停在那一頁再貼上程式。';
    }
    return acquireLock();
  }

  const problem = preflight();
  if (problem) {
    panel.textContent = `⚠️ 無法啟動\n${problem}`;
    panel.style.background = '#b00020';
    panel.style.pointerEvents = 'auto';
    panel.onclick = () => panel.remove();
    console.error('[ticket-watcher] 無法啟動：', problem);
    cleanup(false);
    return;
  }

  keepAwake();
  log(`啟動：${state.label}，休息起始 ${CONFIG.interval.start / 1000}s，下限 ${CONFIG.interval.floor / 1000}s，${sleeper.mode}，重新載入頻率每 ${CONFIG.reloadEvery} 輪`);
  log(Alerter.tips());
  setTimeout(() => log(`語音：${Alerter.voiceName()}`), 1500);
  if (resumeNote) log(resumeNote);
  mainLoop();
})();
