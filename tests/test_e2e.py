#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端测试：MoeKoe WS 消息 → 桥接页(native-bridge.js) → bin/mpris-host → D-Bus。

tests/bridge-harness.js 在 Node 中以桩环境运行真实桥接页，把消息转发给真实
本地程序；本测试再用独立的 D-Bus 连接校验最终暴露出去的内容。

运行：python3 tests/test_e2e.py
依赖：node、python3-dbus、python3-gi、dbus-daemon（测试跑在自带的私有
      D-Bus 上，不与正在运行的 MoeKoe 宿主抢名称）
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HARNESS = os.path.join(HERE, "bridge-harness.js")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import privatebus  # noqa: E402

DBUS_NAME = "org.mpris.MediaPlayer2.MoeKoeMusic"
PATH = "/org/mpris/MediaPlayer2"
IFACE_PLAYER = "org.mpris.MediaPlayer2.Player"
IFACE_PROPS = "org.freedesktop.DBus.Properties"

failures = []


def check(condition, message):
    if condition:
        print("  ok   %s" % message)
    else:
        print("  FAIL %s" % message)
        failures.append(message)


class Harness:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", HARNESS],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.events = queue.Queue()
        self.status = None
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception as exc:  # noqa: BLE001
                print("  FAIL harness 输出非 JSON: %s (%s)" % (line, exc))
                failures.append("harness 输出非 JSON")
                continue
            if event.get("event") == "status":
                self.status = event.get("status")
            self.events.put(event)

    def _read_stderr(self):
        for line in self.process.stderr:
            if line.strip():
                sys.stderr.write("      harness| %s" % line)

    def send(self, payload):
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def push(self, message):
        self.send({"push": message})

    def wait_event(self, name, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                event = self.events.get(timeout=0.2)
            except queue.Empty:
                continue
            if event.get("event") == name:
                return event
        return None

    def wait_host_message(self, message_type, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                event = self.events.get(timeout=0.2)
            except queue.Empty:
                continue
            message = event.get("message") or {}
            if event.get("event") == "host-message" and message.get("type") == message_type:
                return message
        return None

    def request_status(self, timeout=3.0):
        self.send({"status": True})
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.status is not None:
                status, self.status = self.status, None
                return status
            time.sleep(0.1)
        return None

    def shutdown(self, timeout=5.0):
        self.send({"quit": True})
        try:
            return self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return None


def wait_name(bus, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if bus.name_has_owner(DBUS_NAME):
            return True
        time.sleep(0.1)
    return False


def run():
    import dbus
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    print("\n[启动桥接页与本地程序]")
    harness = Harness()
    check(harness.wait_event("ready") is not None, "harness 就绪")
    ready = harness.wait_host_message("ready")
    check(ready is not None, "桥接页 hello 触发本地程序启动并返回 ready")
    check(wait_name(bus), "D-Bus 名称已注册")

    props = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_PROPS)

    def pump(duration=0.4):
        loop = GLib.MainLoop()
        GLib.timeout_add(int(duration * 1000), loop.quit)
        loop.run()

    # ---------------- 推送 MoeKoe WS 消息 ----------------
    print("\n[推送曲目]")
    harness.push(
        {
            "type": "lyrics",
            "data": {
                "currentTime": 1.0,
                "duration": 200.0,
                "currentSong": {
                    "hash": "ABC123",
                    "name": "うぉーたーりょー",
                    "author": "まふまふ",
                    "albumname": "アコースティック",
                    "img": "https://example.com/cover.jpg",
                    "url": "https://example.com/song.mp3",
                },
            },
        }
    )
    harness.push({"type": "playerState", "data": {"isPlaying": True, "currentTime": 1.0}})
    pump()

    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check(str(metadata.get("xesam:title", "")) == "うぉーたーりょー", "曲名上总线")
    check(
        [str(item) for item in metadata.get("xesam:artist", [])] == ["まふまふ"],
        "歌手上总线",
    )
    check(int(metadata.get("mpris:length", 0)) == 200 * 1_000_000, "时长 200s 上总线")
    check(str(metadata.get("xesam:album", "")) == "アコースティック",
          "xesam:album 上总线（albumname 字段兜底）")
    check(str(metadata.get("xesam:url", "")) == "https://example.com/song.mp3",
          "xesam:url 上总线")
    check(str(props.Get(IFACE_PLAYER, "PlaybackStatus")) == "Playing", "PlaybackStatus = Playing")
    check("moekoe:lyrics" not in metadata, "Metadata 不含私有歌词键")
    check("moekoe:translation" not in metadata, "Metadata 不含私有译文键")

    # ---------------- 合并状态（弹窗刷新回执） ----------------
    print("\n[合并状态]")
    harness.status = None
    status = harness.request_status()
    check(status is not None, "弹窗可查询合并状态")
    if status:
        check(status.get("ws", {}).get("connected") is True, "WS 已连接")
        check(status.get("hostReady") is True, "本地程序 ready")
        check(status.get("track", {}).get("title") == "うぉーたーりょー", "曲目回传正确")
        check(bool(status.get("host", {}).get("authorized")) is True, "授权状态回传")
        check(status.get("bridgeAlive") is True, "bridgeAlive = true（快照新鲜）")
        check(isinstance(status.get("statusAt"), int), "statusAt 为整数时间戳")
        check("mode" not in status, "合并状态不含私有 mode 字段")
        check("overlay" not in status, "合并状态不含私有 overlay 字段")
        check("lineCount" not in status, "合并状态不含歌词行数字段")
        check("lineIndex" not in status, "合并状态不含歌词行号字段")

    # ---------------- 指令中继（会重建 WS，放在状态查询之后） ----------------
    print("\n[指令中继]")
    harness.send({"toHost": {"type": "bridge-command", "cmd": "reconnect"}})
    relayed = harness.wait_host_message("bridge-command")
    check(relayed is not None and str(relayed.get("cmd")) == "reconnect",
          "bridge-command 原样广播回 stdout")

    # ---------------- 关闭 ----------------
    print("\n[关闭]")
    code = harness.shutdown()
    check(code == 0, "harness 正常退出（exit=%s）" % code)
    deadline = time.time() + 6
    while time.time() < deadline and bus.name_has_owner(DBUS_NAME):
        time.sleep(0.2)
    check(not bus.name_has_owner(DBUS_NAME), "本地程序退出后释放 D-Bus 名称")

    print()
    if failures:
        print("FAILED: %d 项未通过" % len(failures))
        for item in failures:
            print("  - %s" % item)
        return 1
    print("ALL PASSED")
    return 0


def main():
    # 私有总线先行：后续 SessionBus、harness 与 bin/mpris-host 都指向它
    private_bus = privatebus.start()
    try:
        return run()
    finally:
        privatebus.stop(private_bus)


if __name__ == "__main__":
    sys.exit(main())
