@echo off
cd /d "%~dp0"
start "" /min node server.js
echo S-remote started - http://localhost:2209
