@echo off
setlocal
cd /d "%~dp0"
node uninstall.mjs
echo.
pause
