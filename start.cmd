@echo off
cd /d %~dp0
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
start "" /min node server.js
