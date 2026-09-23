@echo off
title WhatsApp Bulk Group Member Remover
cd /d "%~dp0"
echo ====================================================
echo   WhatsApp Bulk Group Member Remover Pro
echo ====================================================
echo Starting local application on http://localhost:3000 ...
start http://localhost:3000
node server.js
pause
