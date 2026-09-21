#!/bin/zsh
# 双击启动 NCP-QwenImage 生成器(macOS)
cd "$(dirname "$0")"
echo "启动 NCP-QwenImage 生成器..."
python3 server.py
echo ""
echo "服务已停止,窗口可直接关闭。"
