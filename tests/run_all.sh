#!/usr/bin/env bash
# 运行插件全部测试
set -e
cd "$(dirname "$0")/.."

echo "== manifest 校验 =="
python3 tests/test_manifest.py

echo
echo "== 歌词解析（Node） =="
node tests/test-lyrics-parser.js

echo
echo "== 本地程序 D-Bus 集成 =="
python3 tests/test_mpris_host.py

echo
echo "== 端到端（WS 消息 -> 桥接页 -> 本地程序 -> D-Bus） =="
python3 tests/test_e2e.py
