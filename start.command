#!/bin/bash
# 一键启动 LX Music 批量下载器（双击运行）
cd "$(dirname "$0")"

# Qobuz 下载模块已内置在项目 vendor/qobuz-dl 里，随项目一起拷贝即可用
if [ -d "vendor/qobuz-dl/env" ]; then
  export QOBUZ_DL_DIR="$(pwd)/vendor/qobuz-dl"
fi

if curl -s -m 2 http://127.0.0.1:8978/api/settings >/dev/null 2>&1; then
  echo "服务已在运行，直接打开界面…"
  open http://127.0.0.1:8978
else
  nohup node server.js > server.log 2>&1 &
  echo "服务已启动，浏览器将自动打开 http://127.0.0.1:8978"
  echo "关闭本窗口不会停止服务；停止请运行「停止.command」"
  sleep 5
fi
