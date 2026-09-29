@echo off
rem ============================================================================
rem 手動重開 Google Chrome（Windows），並重新打開訂票頁
rem   用法： 雙擊，或在命令提示字元執行
rem            scripts\restart-chrome.bat
rem            scripts\restart-chrome.bat "https://.../ticket_chn/GDxxxxxxx"
rem   注意：
rem     - 會關閉「所有」Chrome 視窗，請先存好其他內容。
rem     - 只有你「手動執行」時才會動；監控程式不會、也不能呼叫它。
rem     - 這個版本【還沒有在 Windows 上實測過】，若有問題請改用手動關閉再開啟。
rem     - 若 Chrome 設定為「關閉時清除網站資料」，監控的歷史紀錄會一起消失；
rem       重開前可先在 Console 執行 __ticketWatcher.exportHistory()
rem ============================================================================
chcp 65001 >nul
setlocal
set "URL=%~1"
if "%URL%"=="" set "URL=https://www.tbluelinepark.com/ticket_chn/GD2100036"

echo 正在關閉 Google Chrome...
taskkill /IM chrome.exe >nul 2>&1

set /a n=0
:wait
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
if errorlevel 1 goto closed
set /a n+=1
if %n% GEQ 30 goto timeout
timeout /t 1 /nobreak >nul
goto wait

:timeout
echo Chrome 在 30 秒內沒有結束（可能在等你回應對話框，或有背景程序）。請處理後再執行一次。
exit /b 1

:closed
timeout /t 2 /nobreak >nul
echo 重新打開： %URL%
start "" chrome "%URL%"
endlocal
