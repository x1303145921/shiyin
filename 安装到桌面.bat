@echo off
setlocal EnableDelayedExpansion
title 拾音 · 安装到桌面
cd /d "%~dp0"

:: 检查必备文件
if not exist "%~dp0启动拾音.bat" goto :missing
if not exist "%~dp0public\app-icon.ico" goto :missing

:: 创建桌面快捷方式（指向启动脚本 + 应用图标）
set "SHIYIN_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d '拾音.lnk')); $s.TargetPath=(Join-Path $env:SHIYIN_DIR '启动拾音.bat'); $s.WorkingDirectory=$env:SHIYIN_DIR; $s.IconLocation=(Join-Path $env:SHIYIN_DIR 'public\app-icon.ico')+',0'; $s.Description='拾音 - 本地音频/视频转文字'; $s.Save()"
if errorlevel 1 goto :fail

echo.
echo  [成功] 已在桌面创建「拾音」快捷方式！
echo  双击桌面「拾音」即可启动。
echo.
pause
exit /b 0

:missing
echo  [错误] 缺少必要文件，请确认本脚本位于拾音文件夹根目录。
pause
exit /b 1

:fail
echo  [错误] 创建快捷方式失败，请右键本脚本「以管理员身份运行」重试。
pause
exit /b 1
