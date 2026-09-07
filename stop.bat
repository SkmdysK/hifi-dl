@echo off
rem 一键停止 LX Music 批量下载器（Windows 版，双击运行）
set found=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8978" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%a >nul 2>&1
  set found=1
)
if %found%==1 (
  echo 服务已停止
) else (
  echo 服务未在运行
)
timeout /t 2 >nul
