@echo off
rem 一键启动 LX Music 批量下载器（Windows 版，双击运行）
cd /d "%~dp0"

rem Qobuz 下载模块内置在 vendor\qobuz-dl（注意：该 Python 环境是 macOS 版，Windows 需自建环境后设置 QOBUZ_DL_DIR）
if exist "vendor\qobuz-dl\env" set "QOBUZ_DL_DIR=%~dp0vendor\qobuz-dl"

curl -s -m 2 http://127.0.0.1:8978/api/settings >nul 2>&1
if %errorlevel%==0 (
  echo 服务已在运行，直接打开界面...
  start http://127.0.0.1:8978
) else (
  start "LX Music 下载器" /min cmd /c "node server.js"
  echo 服务已启动，浏览器将自动打开 http://127.0.0.1:8978
  echo 关闭弹出的服务窗口会停止服务；停止请运行 停止.bat
)
timeout /t 3 >nul
