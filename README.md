# haeundae-sky-capsule-ticket-watcher 🎫

> 在「訂票頁面本身」持續監看指定日期的時段，一有票就用**桌面通知＋提示音＋語音＋紅色面板**提醒你。
> 只監看，**不會下單、不會付款、不會填寫任何個資**。

| ✅ 能做 | ❌ 不做 |
|---|---|
| 把要監看的日期**輪流查詢**（預設每 20 秒查 1 天），讀出各時段剩餘數 | 自動下單、自動付款、填寫個資 |
| 有票時：桌面通知、提示音、女聲語音、標題 `🎫有票! 10/11 5班10:30-11:00`、面板變紅 | 繞過網站的防機器人驗證 |
| 記錄「何時、哪天哪個時段、剩幾張」 | 在背景常駐（分頁或 Chrome 關掉就停止） |
| 被限流（429）時自動暫停、自動恢復；Chrome 重開後自動接續 | **保證搶得到票、保證不被限流** |

<sub>English: a single-file browser script that polls a booking page for released slots on chosen dates (one date at a time, in rotation), alerts you when any slot is not sold out, and backs off automatically when the site rate-limits it. Monitoring only — it never books or pays and does not bypass the site's anti-bot token.</sub>

---

## 三種用法（選一種開始）

| | 適合 | 要安裝 | Chrome 重開後 |
|---|---|---|---|
| **A. 貼到 Console** | 先試試看 | 不用 | 要重貼一次 |
| **B. 自動啟動** | 要長時間掛著 | 使用者腳本管理員：Tampermonkey／Violentmonkey／**AdGuard** 擇一 | 打開訂票頁就自動開始 |
| **B ＋ 重開小工具** | 想一鍵乾淨重開 Chrome | B ＋ `scripts/restart-chrome.command` | 重開 → 自動開訂票頁 → 自動開始監控（**作者實測可用**） |

---

## 方式 A｜貼到 Console（最簡單，3 分鐘）

**開始前**：用電腦版 Chrome、電腦接電源、網路穩定；打開訂票頁並看得到日曆；分頁放前景（或拖成獨立視窗）；只開**一個**監控。

1. 在訂票頁按 `⌥⌘J`（Mac）或 `F12` → **Console**。
2. 打開 [`watcher.js`](./watcher.js)，按「Copy raw file」複製全文。
3. 貼進 Console，按 Enter。第一次貼要先輸入 `allow pasting`。
4. 右上角出現**黑色面板**就成功了。**在頁面上點一下**（Chrome 規定點過才能出聲）。
5. 建議先測試提醒：Console 輸入 `__ticketWatcher.testAlert()`。

預設監看 **10 月 10～13 日**、每 20 秒查 1 天。要改月份／日期／速度，看[常用設定](#常用設定)。
停止：`__ticketWatcher.stop()`，或關掉分頁。

---

## 方式 B｜自動啟動（Tampermonkey、Violentmonkey 或 AdGuard）

設定一次，之後**打開訂票頁就自動開始監控**，Chrome 重開也不必重貼。

**1. 準備一個使用者腳本管理員（三選一）**
- **Tampermonkey／Violentmonkey**：到 Chrome 線上應用程式商店安裝。新版 Chrome（約 138 版起）還要到 `chrome://extensions` → 該擴充功能「詳細資料」→ 打開「**允許使用者指令碼**」，沒開腳本完全不會執行。
- **AdGuard（桌面版 App）**：偏好設定 → **Extensions**，確認最上面的 Extensions 已勾選；用左下角的 **＋** 加入腳本（貼網址或選檔案，選單文字依版本略有不同）。每個腳本有勾選框（啟用）與齒輪（編輯／設定）。**作者實測：能安裝、能自動啟動。**

**2. 安裝腳本**：[`haeundae-sky-capsule-ticket-watcher.user.js`](https://raw.githubusercontent.com/WebberningMoney/haeundae-sky-capsule-ticket-watcher/main/userscript/haeundae-sky-capsule-ticket-watcher.user.js)
點連結（Tampermonkey 會跳出安裝頁），或在管理員裡新增腳本、貼上該檔全文。

**3. 驗證**：打開（或重新整理）訂票頁，幾秒內右上角出現黑色面板；在頁面上點一下。
沒有面板？檢查：①「允許使用者指令碼」有沒有開 ② 腳本是不是啟用狀態 ③ 腳本開頭的 `@match` 網址是否和你的分頁相符 ④ Console 有沒有紅字。

**4. 要改設定時**：在管理員裡編輯腳本、存檔、重新整理訂票頁，然後在 Console 輸入 `__ticketWatcher.config.rotate.everyMs` 確認數字真的變了。
**不會自動更新**（標頭已設 `@updateURL none`），避免程式被悄悄換掉；要更新就重新安裝最新版，設定要再改一次。

> 這個 `.user.js` 是由 `watcher.js` 自動產生的，內容一樣，只是標頭不同：只在這個商品頁啟動、不在腳本自己建立的隱藏頁面裡啟動（`@noframes`）、不自動更新。要監看別的商品，把 `@match` 改成該商品的訂票頁網址（結尾保留 `*`）。

---

## 重開 Chrome 小工具（手動執行）

`scripts/` 底下有一支小工具：**正常關閉所有 Chrome 視窗 → 等 Chrome 完全結束 → 重新打開訂票頁**。

| 系統 | 檔案 | 狀態 |
|---|---|---|
| macOS | [`scripts/restart-chrome.command`](./scripts/restart-chrome.command) | ✅ **作者實測**：搭配[方式 B](#方式-b自動啟動tampermonkeyviolentmonkey-或-adguard)（AdGuard 版），重開後**自動打開訂票頁、自動開始監控** |
| Windows | [`scripts/restart-chrome.bat`](./scripts/restart-chrome.bat) | ⚠ 未在 Windows 實測 |

**用法（macOS）**：在終端機進到專案資料夾，執行

```bash
bash scripts/restart-chrome.command
```

也可以在 Finder 雙擊。若出現「could not be executed because you do not have appropriate access privileges」，是單獨下載或下載 ZIP 時遺失了「可執行」權限：對該檔案執行一次 `chmod +x 檔案路徑` 即可（或一律用上面的 `bash` 指令）。第一次執行 macOS 會問「終端機想要控制 Google Chrome」，按「好」。

**請務必知道**
1. **只有你手動執行時才會動。** 監控程式不會、也不能呼叫它；本專案**刻意沒有**「被限流就自動重開／自動換身分」的機制（測試會檢查）。
2. **會關掉所有 Chrome 視窗與分頁**，其他工作先存好。
3. 若你的 Chrome 設定為「關閉時清除網站資料」（作者的環境是），監控的歷史與存檔會一起消失。重開前先在訂票頁 Console 執行 `__ticketWatcher.exportHistory()` 匯出 CSV。
4. **它不是「解除限流」的按鈕，也不建議拿來繞過限流。** 被限流時，封鎖約 26～29 分鐘會自己解除，程式會自動等待並恢復。重開在某些環境下可能讓網站當成新的瀏覽階段而提早恢復，但**不保證有效**；如果重開後繼續用會被擋的速度查詢，只會再被擋，甚至可能升級成更長、更大範圍的封鎖，連你自己手動訂票都受影響。適合用它的情境：Chrome 卡住、記憶體過高、想要乾淨的瀏覽器環境。

---

## 日常使用

| 面板／現象 | 意思 | 你要做什麼 |
|---|---|---|
| 面板變**紅**、標題 `🎫有票! …`、有聲音與語音 | 有票了 | **立刻到網站下單**（工具不代勞，票也可能瞬間被搶走） |
| 「被網站限流(429)，暫停到 HH:MM」 | 查太密被擋 | **什麼都不用做**，時間到程式自動試探並恢復（約 26 分鐘） |
| 「🔊 提示音與語音：🔇 尚未啟用」 | Chrome 要先被點過 | 在頁面上點一下 |
| 「🔔 桌面通知：❌ 被封鎖」 | 系統或 Chrome 封鎖通知 | 見[提醒設定](docs/configuration.md#提醒設定桌面版-chromemacoswindows)（macOS 也要關「專注模式」） |
| 「⚠️ 無法啟動」 | 啟動前檢查沒通過 | 照面板上的中文提示處理 |

保持分頁在前景、電腦不睡眠；Chrome 或分頁關掉，監控就停止。更多狀況見[疑難排解](docs/troubleshooting.md)。

---

## 常用設定

一般只需要改**月份和日期**；在方式 A 是改 `watcher.js` 最上方的 `CONFIG`，在方式 B 是改管理員裡的腳本。

| 設定 | 預設 | 說明 |
|---|---|---|
| `month` | `10` | 要監看幾月。程式會自動切到該月，不必自己按 Next |
| `days` | `'10-13'` | 要監看哪幾號：`'10-13'`、`'10,12,15-17'`、`'25'`。建議不超過 7 天 |
| `rotate.everyMs` | `20000` | 每隔多久查 1 天（20 秒 ＝ 每分鐘 3 個） |
| `budget.maxCalls` | `100` | 30 分鐘最多查幾個（安全上限）。**要加快必須和 `everyMs` 一起改** |

| 想要的速度 | `rotate.everyMs` | `budget.maxCalls` | 備註 |
|---|---|---|---|
| 每 30 秒查 1 天 | `30_000` | `60` | 最保守 |
| **每 20 秒查 1 天（預設）** | `20_000` | `100` | 每分鐘 3 個，實測曾連續跑 126 分鐘才被擋 |
| 每 10 秒查 1 天 | `10_000` | `200` | 每分鐘 6 個，實測**約半小時就被擋一次** |

**只改 `everyMs` 沒有用**：實際速度取「你設的間隔」和「預算允許的間隔」中較慢者，面板會說明。
不想改檔案（方式 A）：貼程式**之前**先執行 `window.ticketWatcherConfig = { rotate: { everyMs: 30000 }, budget: { maxCalls: 60 } };`。
其他參數（通知、語音、面板大小…）見[完整設定表](docs/configuration.md)。

---

## 注意事項

1. **沒有任何查詢速度被證明不會被限流。** 實測每分鐘 6 個約半小時被擋一次，每分鐘 3 個曾撐過 2 小時，但樣本很少。被擋一次要盲約 26～29 分鐘，詳見[限流的事實與實驗](docs/rate-limit.md)。
2. **請勿把速度調到極限。** 頻繁請求可能造成被限流、被暫時封鎖 IP，甚至影響你正常訂票。
3. **不要繞過網站的防護。** 本專案刻意不偽造 `X-Schedule-Token`、不直接呼叫 API，也不做自動換身分。
4. **一次只跑一個監控**（不要多分頁、多台電腦），否則請求加倍更容易被擋。
5. 僅限**個人自用監看**，請遵守網站條款與當地法規；請勿用於黃牛、轉售或大量搶票。
6. 腳本只在你的瀏覽器執行，不會把資料傳到第三方。從不明來源貼到 Console、或安裝成使用者腳本的程式碼都有風險，請先讀過 `watcher.js`（有完整註解）。
7. 網站改版（按鈕文字、時段文字格式、流程）就可能失效。

---

## 進階文件

| 文件 | 內容 |
|---|---|
| [docs/configuration.md](docs/configuration.md) | 完整設定表、提醒設定（macOS／Windows）、畫面說明 |
| [docs/how-it-works.md](docs/how-it-works.md) | 運作原理、輪流模式、錯誤分類、接續存檔、使用技術 |
| [docs/rate-limit.md](docs/rate-limit.md) | 限流（429）：已確認的事實、推論、實驗紀錄、程式的因應 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常見問題、已知限制、除錯與內部狀態 |
| [docs/development.md](docs/development.md) | 專案結構、測試（`npm test`）、開發歷程 |

---

## 免責聲明與授權

- 本專案為個人學習與自用監看工具，**與任何票務網站或營運方無關、亦未經其背書**。
- 使用者須自行確保使用方式符合網站條款與當地法規，並自行承擔使用風險（包含被限流、封鎖或其他後果）。
- 作者不對票務結果、資料正確性或任何損失負責。
- 本專案提到的地名、商品名與網站名稱，權利皆屬其各自的所有人，僅用於說明用途。
- 授權：**MIT License**（可自由使用、修改、散布，須保留版權聲明；軟體依「現狀」提供，不附任何保證）。完整條文見 [LICENSE](./LICENSE)。
