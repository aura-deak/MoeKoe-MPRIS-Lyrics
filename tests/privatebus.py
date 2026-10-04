#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""私有会话 D-Bus：让测试与正在运行的 MoeKoe 宿主互不抢占名称。

用法：在创建任何 D-Bus 连接、启动 bin/mpris-host 之前调用 start()，
它会把本进程及其后续子进程的 DBUS_SESSION_BUS_ADDRESS 指向一个独立的
dbus-daemon；测试结束后调用 stop() 关闭。
"""

import os
import shutil
import subprocess
import sys


def start():
    daemon = shutil.which("dbus-daemon")
    if not daemon:
        print("警告: 未找到 dbus-daemon，回退到当前会话总线", file=sys.stderr)
        return None

    process = subprocess.Popen(
        [daemon, "--session", "--nofork", "--print-address=1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    address = process.stdout.readline().strip()
    if not address.startswith("unix:"):
        process.terminate()
        raise SystemExit("dbus-daemon 启动失败: %r" % address)

    os.environ["DBUS_SESSION_BUS_ADDRESS"] = address
    return process


def stop(process):
    if process is None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
