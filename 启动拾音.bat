@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title 拾音 · 本地音频/视频转文字
cd /d "%~dp0"

:: 检测 Node.js（优先使用同目录便携版 node.exe，其次系统 PATH）
set "NODE_BIN=node"
if exist "%~dp0node.exe" set "NODE_BIN=%~dp0node.exe"
"%NODE_BIN%" --version >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 后重试。
    echo        下载地址：https://nodejs.org/zh-cn/download
    pause
    exit /b 1
)

:: 检查端口 18900：若已有拾音服务在运行，直接打开浏览器
netstat -ano | findstr ":18900.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    curl -s --noproxy "*" -m 3 http://127.0.0.1:18900/api/tasks >nul 2>nul
    if not errorlevel 1 (
        echo [提示] 拾音已在运行，直接打开页面...
        start "" "http://127.0.0.1:18900"
        exit /b 0
    )
    echo [警告] 端口 18900 被占用但不是拾音服务，尝试清理...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":18900.*LISTENING"') do taskkill /F /PID %%p >nul 2>nul
    ping -n 2 127.0.0.1 >nul
)

:: 启动服务（独立小窗口）
start "" /min cmd /c ""%NODE_BIN%" server.js"

:: 等待服务就绪（最多 30 秒）
set /a count=0
:wait
ping -n 2 127.0.0.1 >nul
curl -s --noproxy "*" -m 3 http://127.0.0.1:18900/api/tasks >nul 2>nul
if errorlevel 1 (
    set /a count+=1
    if !count! gtr 30 (
        echo [错误] 服务启动超时，请查看上方窗口的报错信息。
        pause
        exit /b 1
    )
    goto wait
)

start "" "http://127.0.0.1:18900"
echo [完成] 拾音已启动
echo 地址：http://127.0.0.1:18900
echo 关闭服务：右键托盘/任务栏的 node 窗口选择关闭，或运行 停止拾音.bat
pause
exit /b 0
