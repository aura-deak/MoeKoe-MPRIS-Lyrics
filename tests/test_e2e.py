#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端测试：MoeKoe WS 消息 → 桥接页(native-bridge.js) → bin/mpris-host → D-Bus。

tests/bridge-harness.js 在 Node 中以桩环境运行真实桥接页，把消息转发给真实
本地程序；本测试再用独立的 D-Bus 连接校验最终暴露出去的内容。

运行：python3 tests/test_e2e.py
依赖：node、python3-dbus、python3-gi、dbus-daemon（测试跑在自带的私有
      D-Bus 上，不与正在运行的 MoeKoe 宿主抢名称）
"""

import base64
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HARNESS = os.path.join(HERE, "bridge-harness.js")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import privatebus  # noqa: E402

# 测试不拉起悬浮歌词客户端，配置也写进临时目录，避免碰用户真实配置
os.environ["MOEKOE_MPRIS_NO_OVERLAY"] = "1"
CONFIG_DIR = tempfile.mkdtemp(prefix="moekoe-mpris-e2e-")
os.environ["MOEKOE_MPRIS_CONFIG_DIR"] = CONFIG_DIR

DBUS_NAME = "org.mpris.MediaPlayer2.MoeKoeMusic"
PATH = "/org/mpris/MediaPlayer2"
IFACE_PLAYER = "org.mpris.MediaPlayer2.Player"
IFACE_LYRICS = "org.moekoe.MPRIS.Lyrics"
IFACE_OVERLAY = "org.moekoe.MPRIS.Overlay"
IFACE_PROPS = "org.freedesktop.DBus.Properties"

failures = []


def check(condition, message):
    if condition:
        print("  ok   %s" % message)
    else:
        print("  FAIL %s" % message)
        failures.append(message)


def build_krc():
    """构造与酷狗 KRC 一致的样本：language 标签 + 行级时间标签 + 逐字标签。"""
    language = {
        "content": [
            {"type": 1, "lyricContent": [["在水中"], ["抓住光芒"]]},
            {"type": 0, "lyricContent": [["i no na ka de"], ["hi ko o tsu ka mu"]]},
        ]
    }
    tag = base64.b64encode(json.dumps(language, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return "\n".join(
        [
            "[ar:まふまふ]",
            "[language:%s]" % tag,
            "[0,4000]<0,300,0>水<300,300,0>の<600,300,0>中<900,300,0>で",
            "[4000,4000]<0,400,0>光<400,400,0>を<800,400,0>つかむ",
            "[8000,2000]",
        ]
    )


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
    overlay = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_OVERLAY)
    signals = []
    bus.add_signal_receiver(
        lambda line: signals.append(dict(line)),
        signal_name="LineChanged",
        dbus_interface=IFACE_LYRICS,
        path=PATH,
        bus_name=DBUS_NAME,
    )

    def pump(duration=0.4):
        loop = GLib.MainLoop()
        GLib.timeout_add(int(duration * 1000), loop.quit)
        loop.run()

    # ---------------- 推送 MoeKoe WS 消息 ----------------
    print("\n[推送曲目与歌词]")
    krc = build_krc()
    harness.push(
        {
            "type": "lyrics",
            "data": {
                "currentTime": 1.0,
                "duration": 200.0,
                "lyricsData": krc,
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
          "xesam:url 上总线（供现有客户端查词识别）")
    check(str(props.Get(IFACE_PLAYER, "PlaybackStatus")) == "Playing", "PlaybackStatus = Playing")
    check(str(metadata.get("moekoe:lyrics", "")) == "水の中で", "当前行原文（默认歌词翻译模式）")
    check(str(metadata.get("moekoe:translation", "")) == "在水中", "当前行译文")

    current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
    check(int(current.get("index", -9)) == 0, "CurrentLine.index = 0")
    lyrics_json = json.loads(str(props.Get(IFACE_LYRICS, "LyricsJson")))
    check(len(lyrics_json) == 2, "LyricsJson 含 2 行（KRC 空行被忽略）")

    # ---------------- 行切换 ----------------
    print("\n[行切换]")
    signals.clear()
    harness.push(
        {
            "type": "lyrics",
            "data": {
                "currentTime": 5.0,
                "duration": 200.0,
                "lyricsData": krc,
                "currentSong": {
                    "hash": "ABC123",
                    "name": "うぉーたーりょー",
                    "author": "まふまふ",
                    "album": "アコースティック",
                    "img": "https://example.com/cover.jpg",
                },
            },
        }
    )
    pump()
    check(len(signals) == 1, "触发一次 LineChanged")
    if signals:
        check(str(signals[0].get("text", "")) == "光をつかむ", "信号携带第二行原文")
        check(str(signals[0].get("translation", "")) == "抓住光芒", "信号携带第二行译文")
        check(str(signals[0].get("mode", "")) == "both", "信号携带当前模式")
        check(dict(props.Get(IFACE_LYRICS, "CurrentLine")) == signals[0],
              "信号与 CurrentLine 属性负载逐字段一致")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check(str(metadata.get("moekoe:lyrics", "")) == "光をつかむ", "Metadata 跟随行切换更新")

    # ---------------- 模式切换（通过 chrome.storage） ----------------
    print("\n[单翻译 translation]")
    harness.send({"setMode": "translation"})
    time.sleep(0.3)
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "translation", "Mode 切换为 translation")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:translation" in metadata, "保留 moekoe:translation")
    check("moekoe:lyrics" not in metadata, "不出现 moekoe:lyrics")
    current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
    check("text" not in current, "CurrentLine 不含原文字段")
    check(str(current.get("translation", "")) == "抓住光芒", "CurrentLine 只含译文")
    lyrics_json = json.loads(str(props.Get(IFACE_LYRICS, "LyricsJson")))
    check(all("text" not in item for item in lyrics_json), "LyricsJson 不含原文")

    print("\n[单歌词 original]")
    harness.send({"setMode": "original"})
    time.sleep(0.3)
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "original", "Mode 切换为 original")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:lyrics" in metadata, "保留 moekoe:lyrics")
    check("moekoe:translation" not in metadata, "不出现 moekoe:translation")
    current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
    check("translation" not in current, "CurrentLine 不含译文字段")

    print("\n[回到歌词翻译 both]")
    harness.send({"setMode": "both"})
    time.sleep(0.3)
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "both", "Mode 回到 both")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:lyrics" in metadata and "moekoe:translation" in metadata, "两个歌词键同时存在")

    # ---------------- 悬浮窗显示配置（Overlay 接口 + 持久化） ----------------
    print("\n[悬浮窗显示配置]")
    check(bool(props.Get(IFACE_OVERLAY, "Enabled")) is True, "默认 Enabled = true")
    check(abs(float(props.Get(IFACE_OVERLAY, "Opacity")) - 0.62) < 1e-6, "默认 Opacity = 0.62")
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "bottom-center", "默认 Position = bottom-center")
    check(bool(props.Get(IFACE_OVERLAY, "ClickThrough")) is True, "默认 ClickThrough = true")
    check(abs(float(props.Get(IFACE_OVERLAY, "Scale")) - 1.0) < 1e-6, "默认 Scale = 1.0")

    overlay_changes = []
    bus.add_signal_receiver(
        lambda iface, changed, invalidated: overlay_changes.append((str(iface), dict(changed))),
        signal_name="PropertiesChanged",
        dbus_interface=IFACE_PROPS,
        path=PATH,
        bus_name=DBUS_NAME,
    )

    harness.send({"setConfig": {
        "opacity": 0.3, "position": "top-left",
        "clickThrough": False, "enabled": False, "scale": 0.5,
    }})
    time.sleep(0.3)
    pump()
    check(abs(float(props.Get(IFACE_OVERLAY, "Opacity")) - 0.3) < 1e-6, "Opacity 更新为 0.3")
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "top-left", "Position 更新为 top-left")
    check(bool(props.Get(IFACE_OVERLAY, "ClickThrough")) is False, "ClickThrough 更新为 false")
    check(bool(props.Get(IFACE_OVERLAY, "Enabled")) is False, "Enabled 更新为 false")
    check(abs(float(props.Get(IFACE_OVERLAY, "Scale")) - 0.5) < 1e-6, "Scale 更新为 0.5")
    check(any(iface == IFACE_OVERLAY for iface, _ in overlay_changes),
          "Overlay 发出 PropertiesChanged")

    # 拖动回写：SavePosition 切到 custom 并记录坐标
    overlay.SavePosition(dbus.Int32(200), dbus.Int32(80))
    time.sleep(0.2)
    pump()
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "custom", "SavePosition 后 Position = custom")
    check(int(props.Get(IFACE_OVERLAY, "PosX")) == 200, "SavePosition 后 PosX = 200")
    check(int(props.Get(IFACE_OVERLAY, "PosY")) == 80, "SavePosition 后 PosY = 80")

    # 非法值被忽略（不改变现状、不抛错）
    harness.send({"setConfig": {"position": "middle", "opacity": "abc"}})
    time.sleep(0.2)
    pump()
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "custom", "非法 position 被忽略")

    # 持久化：配置目录里已落盘（宿主重启后不回退）
    with open(os.path.join(CONFIG_DIR, "config.json"), "r", encoding="utf-8") as handle:
        saved = json.load(handle)
    saved_overlay = saved.get("overlay") or {}
    check(saved_overlay.get("position") == "custom", "配置已持久化 position=custom")
    check(saved_overlay.get("enabled") is False, "配置已持久化 enabled")
    check(abs(float(saved_overlay.get("opacity", 0)) - 0.3) < 1e-6, "配置已持久化 opacity")
    check(saved_overlay.get("click_through") is False, "配置已持久化 click_through")
    check(abs(float(saved_overlay.get("scale", 0)) - 0.5) < 1e-6, "配置已持久化 scale")
    check(int(saved_overlay.get("x", -1)) == 200, "配置已持久化 x")
    check(int(saved_overlay.get("y", -1)) == 80, "配置已持久化 y")

    # ---------------- hello 无 mode 不覆盖持久化 ----------------
    print("\n[hello 无 mode]")
    harness.send({"toHost": {"type": "hello"}})
    time.sleep(0.3)
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "both", "无 mode 的 hello 不覆盖当前模式")

    # ---------------- 合并状态（弹窗刷新回执） ----------------
    print("\n[合并状态]")
    harness.status = None
    status = harness.request_status()
    check(status is not None, "弹窗可查询合并状态")
    if status:
        check(status.get("ws", {}).get("connected") is True, "WS 已连接")
        check(status.get("hostReady") is True, "本地程序 ready")
        check(status.get("mode") == "both", "mode 回报 both")
        check(status.get("track", {}).get("title") == "うぉーたーりょー", "曲目回传正确")
        check(status.get("lineCount") == 2, "歌词行数 2")
        check(status.get("lineIndex") == 1, "当前行 1")
        check(bool(status.get("host", {}).get("authorized")) is True, "授权状态回传")
        overlay = status.get("overlay") or {}
        check(overlay.get("position") == "custom", "合并状态 overlay.position")
        check(abs(float(overlay.get("opacity", 0)) - 0.3) < 1e-6, "合并状态 overlay.opacity")
        check(overlay.get("enabled") is False, "合并状态 overlay.enabled")
        check(overlay.get("clickThrough") is False, "合并状态 overlay.clickThrough")
        check(abs(float(overlay.get("scale", 0)) - 0.5) < 1e-6, "合并状态 overlay.scale")
        check(overlay.get("running") is False, "合并状态 overlay.running（测试禁用了拉起）")
        check(status.get("bridgeAlive") is True, "bridgeAlive = true（快照新鲜）")
        check(isinstance(status.get("statusAt"), int), "statusAt 为整数时间戳")

    # ---------------- 立即重启悬浮歌词（测试禁用拉起，仍应回执状态） ----------------
    print("\n[立即重启悬浮歌词]")
    harness.send({"toHost": {"type": "overlay-restart"}})
    restart_reply = harness.wait_host_message("status")
    check(restart_reply is not None, "overlay-restart 返回 status")
    if restart_reply:
        restart_overlay = (restart_reply.get("status") or {}).get("overlay") or {}
        check(restart_overlay.get("running") is False, "测试禁用拉起时 running 仍为 false")

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
