@echo off
cd /d %~dp0
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
sc qc SremoteService >nul 2>&1 && (net start SremoteService >nul 2>&1 & exit /b)
if exist "%~dp0agent\tray\SremoteTray.exe" (start "" "%~dp0agent\tray\SremoteTray.exe" & exit /b)
start "" /min node server.js
