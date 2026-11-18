#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""巡检矩阵版 · 官方 API 桥启动脚本（前台，关闭窗口即停止）

注意：矩阵版与双轨版共用 127.0.0.1:18765 这一个桥，同时只运行一个即可。
优先使用系统自带 Python（3.12/3.14），找不到再退回 DeepSeek Harness 自带 Python。
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL = Path(os.environ.get("LOCALAPPDATA", ""))
CANDIDATES = [
    LOCAL / "Programs/Python/Python312/python.exe",
    LOCAL / "Programs/Python/Python314/python.exe",
    Path(os.environ.get("USERPROFILE", "")) / ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe",
    Path(sys.executable),
]
PY = next((p for p in CANDIDATES if p.exists()), Path(sys.executable))

print("启动巡检矩阵版 API 桥（与双轨版共用 18765 端口，关闭窗口即停止）...")
subprocess.run([str(PY), str(HERE / "api_bridge.py"), "--port", "18765"], cwd=str(HERE))
