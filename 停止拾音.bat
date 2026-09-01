@echo off
title 拾音 · 停止服务
cd /d "%~dp0"

:: 按端口 18900 精确查找拾音服务进程（不用 taskkill /IM node，避免误杀其它 node 程序）
netstat -ano | findstr ":18900.*LISTENING" >nul 2>nul
if errorlevel 1 (
    echo [提示] 拾音服务未在运行。
    pause
    exit /b 0
)

echo [1/2] 正在停止拾音服务...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":18900.*LISTENING"') do taskkill /F /PID %%p >nul 2>nul
ping -n 2 127.0.0.1 >nul

netstat -ano | findstr ":18900.*LISTENING" >nul 2>nul
if errorlevel 1 (
    echo [完成] 拾音服务已停止。
) else (
    echo [警告] 端口 18900 仍被占用，请手动检查相关进程。
)
pause
exit /b 0
