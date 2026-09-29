#!/bin/bash
# ============================================================================
# 手動重開 Google Chrome（macOS），並重新打開訂票頁
# ----------------------------------------------------------------------------
# 用法（在「終端機」）：
#   bash scripts/restart-chrome.command                    # 打開下面預設的網址
#   bash scripts/restart-chrome.command "https://…/ticket_chn/GDxxxxxxx"   # 指定網址
# 也可以在 Finder 雙擊（下載來的檔案第一次可能要「右鍵 → 打開」，或先 chmod +x）。
#
# 它只做一件事：正常關閉所有 Chrome 視窗 → 等 Chrome 完全結束 → 重新打開網址。
#
# 請先知道：
#   ⚠ 會關閉「所有」Chrome 視窗與分頁，請先存好其他內容。
#   ⚠ 這個工具只有你「手動執行」時才會動；監控程式 watcher.js 不會、也不能呼叫它，
#     也沒有任何「被限流就自動重開」的機制（刻意不做）。
#   ⚠ 若你的 Chrome 設定為「關閉時清除網站資料」，監控的歷史紀錄與存檔會一起消失；
#     要留紀錄，重開前先在訂票頁的 Console 執行  __ticketWatcher.exportHistory()
#   ⚠ 重開後，如果沒有裝 Tampermonkey 自動啟動，需要重新貼一次 watcher.js（見 README）。
#   第一次執行時 macOS 可能問「終端機想要控制 Google Chrome」，請按「好」。
# ============================================================================
URL="${1:-https://www.tbluelinepark.com/ticket_chn/GD2100036}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "這個腳本只支援 macOS。Windows 請用 scripts/restart-chrome.bat"
  exit 1
fi

if pgrep -x "Google Chrome" >/dev/null; then
  echo "正在關閉 Google Chrome…"
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
fi

# 等 Chrome 真的完全結束（最多 30 秒）
for _ in $(seq 1 30); do
  pgrep -x "Google Chrome" >/dev/null || break
  sleep 1
done
if pgrep -x "Google Chrome" >/dev/null; then
  echo "Chrome 在 30 秒內沒有結束（可能正在等你回應「要關閉多個分頁嗎」之類的對話框）。請處理後再執行一次。"
  exit 1
fi

sleep 2
echo "重新打開：$URL"
open -a "Google Chrome" "$URL"
