#!/bin/bash
# 一键停止 LX Music 批量下载器（双击运行）
PIDS=$(lsof -ti:8978 2>/dev/null)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  sleep 1
  # 还没退就强制结束
  PIDS=$(lsof -ti:8978 2>/dev/null)
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null
  fi
  echo "服务已停止"
else
  echo "服务未在运行"
fi
