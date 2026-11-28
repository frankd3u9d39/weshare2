@echo off
rem Starts the Weshare desktop app in development mode.
rem Needs the page server running first (npx vite in this folder).
rem The app's log is written to %TEMP%\weshare-app.log
cd /d "%~dp0"
set NODE_ENV=development
start "Weshare log" /min cmd /c ""%~dp0node_modules\electron\dist\electron.exe" . > "%TEMP%\weshare-app.log" 2>&1"
