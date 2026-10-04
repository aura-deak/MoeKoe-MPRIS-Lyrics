#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bin/mpris-host 集成测试。

把本地程序当子进程启动，模拟 MoeKoe Music 的 JSON Lines 输入，
再用另一个 D-Bus 连接校验 MPRIS 属性、歌词传输模式与信号。

运行：python3 tests/test_mpris_host.py
依赖：python3-dbus、python3-gi、dbus-daemon（测试跑在自带的私有 D-Bus 上，
      不与正在运行的 MoeKoe 宿主抢名称）
"""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "..", "bin", "mpris-host")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import privatebus  # noqa: E402

# 测试不拉起悬浮歌词客户端，配置写进临时目录，避免碰用户真实配置
os.environ["MOEKOE_MPRIS_NO_OVERLAY"] = "1"
CONFIG_DIR = tempfile.mkdtemp(prefix="moekoe-mpris-host-")
os.environ["MOEKOE_MPRIS_CONFIG_DIR"] = CONFIG_DIR

DBUS_NAME = "org.mpris.MediaPlayer2.MoeKoeMusic"
PATH = "/org/mpris/MediaPlayer2"
IFACE_ROOT = "org.mpris.MediaPlayer2"
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


class Host:
    def __init__(self):
        self.process = subprocess.Popen(
            [os.path.abspath(HOST)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.messages = queue.Queue()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.messages.put(json.loads(line))
            except Exception as exc:  # noqa: BLE001
                print("  FAIL stdout 非 JSON: %s (%s)" % (line, exc))
                failures.append("stdout 非 JSON")

    def _read_stderr(self):
        for line in self.process.stderr:
            if line.strip():
                sys.stderr.write("      host| %s" % line)

    def send(self, payload):
        self.process.stdin.write(
            json.dumps({"type": "message", "payload": payload}, ensure_ascii=False) + "\n"
        )
        self.process.stdin.flush()

    def wait_for(self, message_type, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self.messages.get(timeout=0.2)
            except queue.Empty:
                continue
            if message.get("type") == message_type:
                return message
        return None

    def pending(self):
        items = []
        while True:
            try:
                items.append(self.messages.get_nowait())
            except queue.Empty:
                return items

    def shutdown(self, timeout=5.0):
        try:
            self.process.stdin.write('{"type":"shutdown"}\n')
            self.process.stdin.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            return self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return None


def wait_name(bus, timeout=5.0):
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

    print("启动本地程序 ...")
    host = Host()
    ready = host.wait_for("ready")
    check(ready is not None, "启动后收到 ready")
    if ready:
        check(ready.get("dbusName") == DBUS_NAME, "ready 带上正确的 D-Bus 名称")

    check(wait_name(bus), "已占用 org.mpris.MediaPlayer2.MoeKoeMusic")

    props = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_PROPS)
    player = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_PLAYER)
    lyrics = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_LYRICS)
    overlay = dbus.Interface(bus.get_object(DBUS_NAME, PATH), IFACE_OVERLAY)

    signals = []
    bus.add_signal_receiver(
        lambda iface, changed, invalidated: signals.append(
            {"kind": "props", "iface": str(iface), "changed": dict(changed)}
        ),
        signal_name="PropertiesChanged",
        dbus_interface=IFACE_PROPS,
        path=PATH,
        bus_name=DBUS_NAME,
    )
    bus.add_signal_receiver(
        lambda line: signals.append({"kind": "line", "line": dict(line)}),
        signal_name="LineChanged",
        dbus_interface=IFACE_LYRICS,
        path=PATH,
        bus_name=DBUS_NAME,
    )

    def pump(duration=0.35):
        loop = GLib.MainLoop()
        GLib.timeout_add(int(duration * 1000), loop.quit)
        loop.run()

    def prop_names(iface):
        return set(str(key) for key in props.GetAll(iface).keys())

    # ---------------- 根接口 ----------------
    print("\n[根接口]")
    root = props.GetAll(IFACE_ROOT)
    check(str(root["Identity"]) == "MoeKoe Music", "Identity = MoeKoe Music")
    check(bool(root["CanQuit"]) is False, "CanQuit = false（最小可用）")
    player_props = props.GetAll(IFACE_PLAYER)
    check(bool(player_props["CanControl"]) is False, "CanControl = false")
    check(bool(player_props["CanPlay"]) is False, "CanPlay = false")

    try:
        player.Play()
        check(False, "Play() 应返回 Not Supported")
    except dbus.exceptions.DBusException as exc:
        check(
            exc.get_dbus_name() == "org.freedesktop.DBus.Error.NotSupported",
            "Play() 返回 Not Supported（%s）" % exc.get_dbus_name(),
        )

    try:
        props.Set(IFACE_PLAYER, "Volume", dbus.Double(0.5))
        check(False, "Set(Volume) 应被拒绝")
    except dbus.exceptions.DBusException as exc:
        check(
            exc.get_dbus_name() == "org.freedesktop.DBus.Error.NotSupported",
            "Set(Volume) 返回 Not Supported",
        )

    introspect = dbus.Interface(bus.get_object(DBUS_NAME, PATH), "org.freedesktop.DBus.Introspectable").Introspect()
    interfaces = [node.get("name") for node in ET.fromstring(str(introspect))]
    check(IFACE_PLAYER in interfaces, "Introspection 含 org.mpris.MediaPlayer2.Player")
    check(IFACE_LYRICS in interfaces, "Introspection 含 org.moekoe.MPRIS.Lyrics")
    check(IFACE_OVERLAY in interfaces, "Introspection 含 org.moekoe.MPRIS.Overlay")

    # ---------------- 握手与曲目 ----------------
    print("\n[曲目元数据]")
    host.send({"type": "hello", "protocol": 1, "mode": "both"})
    ready2 = host.wait_for("ready")
    check(ready2 is not None, "hello 收到 ready 应答")

    host.send(
        {
            "type": "track",
            "track": {
                "id": "ABC123",
                "title": "うぉーたーりょー",
                "artists": ["まふまふ", "another"],
                "album": "アコースティック",
                "artUrl": "https://example.com/cover.jpg",
                "url": "https://example.com/song.mp3",
            },
            "duration": 200.0,
            "position": 10.0,
            "status": "Playing",
        }
    )
    pump()
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check(str(metadata["xesam:title"]) == "うぉーたーりょー", "xesam:title 正确")
    check(
        [str(item) for item in metadata["xesam:artist"]] == ["まふまふ", "another"],
        "xesam:artist 正确",
    )
    check(str(metadata["xesam:album"]) == "アコースティック", "xesam:album 正确")
    check(str(metadata["mpris:artUrl"]) == "https://example.com/cover.jpg", "mpris:artUrl 正确")
    check(str(metadata.get("xesam:url", "")) == "https://example.com/song.mp3", "xesam:url 正确")
    check(int(metadata["mpris:length"]) == 200 * 1_000_000, "mpris:length = 200s（微秒）")
    check(str(metadata["mpris:trackid"]).startswith("/org/mpris/MediaPlayer2/Track/"), "mpris:trackid 为合法对象路径")
    check(str(props.Get(IFACE_PLAYER, "PlaybackStatus")) == "Playing", "PlaybackStatus = Playing")

    # ---------------- 歌词（歌词翻译模式） ----------------
    print("\n[歌词：歌词翻译 both]")
    lines = [
        {"index": 0, "start": 0, "duration": 4000, "text": "水の中で", "translation": "在水中"},
        {"index": 1, "start": 4000, "duration": 4000, "text": "光をつかむ", "translation": "抓住光芒"},
    ]
    host.send({"type": "lyrics", "lines": lines})
    host.send({"type": "line", "line": lines[0]})
    host.send({"type": "status", "isPlaying": True, "position": 1.0})
    pump()

    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check(str(metadata.get("moekoe:lyrics", "")) == "水の中で", "moekoe:lyrics = 当前行原文")
    check(str(metadata.get("moekoe:translation", "")) == "在水中", "moekoe:translation = 当前行译文")
    current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
    check(int(current["index"]) == 0, "CurrentLine.index = 0")
    check(str(current["text"]) == "水の中で", "CurrentLine.text 正确")
    check(str(current["translation"]) == "在水中", "CurrentLine.translation 正确")
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "both", "Mode = both")
    lyrics_json = json.loads(str(props.Get(IFACE_LYRICS, "LyricsJson")))
    check(len(lyrics_json) == 2 and lyrics_json[0]["text"] == "水の中で", "LyricsJson 含 2 行原文与译文")

    position1 = int(props.Get(IFACE_PLAYER, "Position"))
    time.sleep(0.3)
    position2 = int(props.Get(IFACE_PLAYER, "Position"))
    check(position2 > position1, "Position 在播放中自增（%d -> %d）" % (position1, position2))

    # ---------------- 行切换信号 ----------------
    print("\n[行切换信号]")
    signals.clear()
    host.send({"type": "line", "line": lines[1]})
    pump()
    line_signals = [item for item in signals if item["kind"] == "line"]
    check(len(line_signals) == 1, "收到 LineChanged 信号")
    if line_signals:
        payload = line_signals[0]["line"]
        check(str(payload.get("text")) == "光をつかむ", "LineChanged.text = 第二行原文")
        check(str(payload.get("translation")) == "抓住光芒", "LineChanged.translation 正确")
        check(int(payload.get("start")) == 4000, "LineChanged.start = 4000ms")
        current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
        check(current == dict(payload), "LineChanged 与 CurrentLine 负载逐字段一致")
        check(str(current.get("mode", "")) == "both", "CurrentLine 携带 mode")
    changed_ifaces = {
        item["iface"] for item in signals if item["kind"] == "props" and "Metadata" in item["changed"]
    }
    check(IFACE_PLAYER in changed_ifaces, "Metadata 变化通过 PropertiesChanged 广播")

    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check(str(metadata.get("moekoe:lyrics", "")) == "光をつかむ", "行切换后 Metadata 更新")

    # ---------------- 单歌词模式 ----------------
    print("\n[单歌词 original]")
    host.send({"type": "mode", "mode": "original"})
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "original", "Mode = original")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:lyrics" in metadata, "单歌词模式保留 moekoe:lyrics")
    check("moekoe:translation" not in metadata, "单歌词模式不出现 moekoe:translation")
    check(str(props.Get(IFACE_LYRICS, "CurrentLine").get("text", "")) == "光をつかむ", "CurrentLine 只含原文")
    check("translation" not in dict(props.Get(IFACE_LYRICS, "CurrentLine")), "CurrentLine 不含译文字段")
    lyrics_json = json.loads(str(props.Get(IFACE_LYRICS, "LyricsJson")))
    check(all("translation" not in item for item in lyrics_json), "LyricsJson 不含译文字段")

    # ---------------- 单翻译模式 ----------------
    print("\n[单翻译 translation]")
    host.send({"type": "mode", "mode": "translation"})
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "translation", "Mode = translation")
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:translation" in metadata, "单翻译模式保留 moekoe:translation")
    check("moekoe:lyrics" not in metadata, "单翻译模式不出现 moekoe:lyrics")
    check(str(metadata.get("moekoe:translation", "")) == "抓住光芒", "moekoe:translation 值正确")
    current = dict(props.Get(IFACE_LYRICS, "CurrentLine"))
    check("text" not in current, "单翻译模式 CurrentLine 不含原文")
    check(str(current.get("translation", "")) == "抓住光芒", "单翻译模式 CurrentLine 只含译文")
    lyrics_json = json.loads(str(props.Get(IFACE_LYRICS, "LyricsJson")))
    check(all("text" not in item for item in lyrics_json), "单翻译模式 LyricsJson 不含原文")

    # ---------------- 无歌词行 ----------------
    print("\n[无当前行]")
    host.send({"type": "line", "line": None})
    pump()
    metadata = dict(props.Get(IFACE_PLAYER, "Metadata"))
    check("moekoe:translation" not in metadata, "无歌词行时 Metadata 不含歌词键")
    check(int(dict(props.Get(IFACE_LYRICS, "CurrentLine")).get("index", -99)) == -1, "CurrentLine.index = -1")
    check("mode" in dict(props.Get(IFACE_LYRICS, "CurrentLine")), "无当前行时负载仍携带 mode")

    # ---------------- 播放状态 ----------------
    print("\n[播放状态]")
    host.send({"type": "status", "isPlaying": False, "position": 33.5})
    pump()
    check(str(props.Get(IFACE_PLAYER, "PlaybackStatus")) == "Paused", "暂停后 PlaybackStatus = Paused")
    check(abs(int(props.Get(IFACE_PLAYER, "Position")) - 33_500_000) < 1_000_000, "暂停后 Position 被校正到 33.5s")

    # ---------------- 悬浮窗显示配置 ----------------
    print("\n[悬浮窗显示配置]")
    check(bool(props.Get(IFACE_OVERLAY, "Enabled")) is True, "默认 Enabled = true")
    check(abs(float(props.Get(IFACE_OVERLAY, "Opacity")) - 0.62) < 1e-6, "默认 Opacity = 0.62")
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "bottom-center", "默认 Position = bottom-center")
    check(bool(props.Get(IFACE_OVERLAY, "ClickThrough")) is True, "默认 ClickThrough = true")
    check(abs(float(props.Get(IFACE_OVERLAY, "Scale")) - 1.0) < 1e-6, "默认 Scale = 1.0")
    check(int(props.Get(IFACE_OVERLAY, "PosX")) == 0, "默认 PosX = 0")
    check(int(props.Get(IFACE_OVERLAY, "PosY")) == 0, "默认 PosY = 0")

    signals.clear()
    host.send({"type": "config", "opacity": 0.25, "position": "top-right",
               "clickThrough": False, "enabled": False, "scale": 1.5})
    pump()
    check(abs(float(props.Get(IFACE_OVERLAY, "Opacity")) - 0.25) < 1e-6, "Opacity 更新为 0.25")
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "top-right", "Position 更新为 top-right")
    check(bool(props.Get(IFACE_OVERLAY, "ClickThrough")) is False, "ClickThrough 更新为 false")
    check(bool(props.Get(IFACE_OVERLAY, "Enabled")) is False, "Enabled 更新为 false")
    check(abs(float(props.Get(IFACE_OVERLAY, "Scale")) - 1.5) < 1e-6, "Scale 更新为 1.5")
    overlay_signals = [
        item for item in signals
        if item["kind"] == "props" and item["iface"] == IFACE_OVERLAY
    ]
    check(bool(overlay_signals), "Overlay 发出 PropertiesChanged")
    if overlay_signals:
        changed = overlay_signals[-1]["changed"]
        check("Opacity" in changed and "Position" in changed, "变更集含 Opacity 与 Position")
        check("Scale" in changed, "变更集含 Scale")

    # 拖动回写：SavePosition 切到 custom 并记录坐标（宿主持久化）
    signals.clear()
    overlay.SavePosition(dbus.Int32(321), dbus.Int32(123))
    pump()
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "custom", "SavePosition 后 Position = custom")
    check(int(props.Get(IFACE_OVERLAY, "PosX")) == 321, "SavePosition 后 PosX = 321")
    check(int(props.Get(IFACE_OVERLAY, "PosY")) == 123, "SavePosition 后 PosY = 123")
    check(any(item["kind"] == "props" and item["iface"] == IFACE_OVERLAY
              and "PosX" in item["changed"] for item in signals),
          "SavePosition 广播 PosX/PosY")

    # 非法值忽略（不改变现状、不抛错）；Scale 越界会被夹取
    host.send({"type": "config", "position": "middle", "opacity": "abc",
               "clickThrough": "yes", "scale": 9.0})
    pump()
    check(str(props.Get(IFACE_OVERLAY, "Position")) == "custom", "非法 position 被忽略")
    check(bool(props.Get(IFACE_OVERLAY, "ClickThrough")) is False, "非法 clickThrough 被忽略")
    check(abs(float(props.Get(IFACE_OVERLAY, "Scale")) - 2.0) < 1e-6, "越界 scale 被夹到 2.0")

    # 持久化：宿主重启后不回退
    with open(os.path.join(CONFIG_DIR, "config.json"), "r", encoding="utf-8") as handle:
        saved = json.load(handle)
    saved_overlay = saved.get("overlay") or {}
    check(saved_overlay.get("position") == "custom", "配置已持久化 position=custom")
    check(saved_overlay.get("enabled") is False, "配置已持久化 enabled")
    check(abs(float(saved_overlay.get("opacity", 0)) - 0.25) < 1e-6, "配置已持久化 opacity")
    check(saved_overlay.get("click_through") is False, "配置已持久化 click_through")
    check(abs(float(saved_overlay.get("scale", 0)) - 2.0) < 1e-6, "配置已持久化 scale")
    check(int(saved_overlay.get("x", -1)) == 321, "配置已持久化 x")
    check(int(saved_overlay.get("y", -1)) == 123, "配置已持久化 y")

    # ---------------- hello 无 mode 不覆盖持久化 ----------------
    print("\n[hello 无 mode]")
    host.send({"type": "hello", "protocol": 1})
    check(host.wait_for("ready") is not None, "hello 无 mode 也收到 ready")
    pump()
    check(str(props.Get(IFACE_LYRICS, "Mode")) == "translation",
          "无 mode 的 hello 不覆盖当前模式")

    # ---------------- 状态回执（弹窗刷新） ----------------
    print("\n[状态回执]")
    host.send({"type": "status", "isPlaying": True, "position": 2.0,
               "snapshot": {"ws": {"connected": True}, "track": {"title": "T"},
                            "lineCount": 2, "lineIndex": 1,
                            "host": {"authorized": True}}})
    host.send({"type": "status-request"})
    status_reply = host.wait_for("status")
    check(status_reply is not None, "status-request 返回 status")
    if status_reply:
        merged = status_reply.get("status") or {}
        check(merged.get("mode") == "translation", "合并状态 mode = translation")
        check(merged.get("hostReady") is True, "合并状态 hostReady")
        check(merged.get("bridgeAlive") is True, "合并状态 bridgeAlive（快照新鲜）")
        check(isinstance(merged.get("statusAt"), int), "合并状态 statusAt 为整数")
        merged_overlay = merged.get("overlay") or {}
        check(merged_overlay.get("position") == "custom", "合并状态 overlay.position")
        check(merged_overlay.get("clickThrough") is False, "合并状态 overlay.clickThrough")
        check(abs(float(merged_overlay.get("scale", 0)) - 2.0) < 1e-6, "合并状态 overlay.scale")
        check(merged_overlay.get("running") is False, "合并状态 overlay.running")
        check(merged.get("ws", {}).get("connected") is True, "合并状态含桥接页快照")

    # ---------------- 立即重启悬浮歌词 ----------------
    print("\n[立即重启悬浮歌词]")
    host.send({"type": "overlay-restart"})
    restart_reply = host.wait_for("status")
    check(restart_reply is not None, "overlay-restart 返回 status")
    if restart_reply:
        overlay_state = (restart_reply.get("status") or {}).get("overlay") or {}
        check(overlay_state.get("running") is False, "测试禁用拉起时 running 仍为 false")

    # ---------------- 指令中继 ----------------
    print("\n[指令中继]")
    host.send({"type": "bridge-command", "cmd": "reconnect"})
    relay = host.wait_for("bridge-command")
    check(relay is not None and str(relay.get("cmd")) == "reconnect",
          "bridge-command 广播回 stdout")
    host.send({"type": "bridge-command", "cmd": "bogus"})
    err = host.wait_for("error")
    check(err is not None, "未知 bridge-command 返回 error")

    # ---------------- 心跳与关闭 ----------------
    print("\n[生命周期]")
    host.send({"type": "ping"})
    pong = host.wait_for("pong")
    check(pong is not None, "ping 收到 pong")
    host.send({"type": "unknown-type"})
    error = host.wait_for("error")
    check(error is not None, "未知消息类型返回 error")

    code = host.shutdown()
    check(code == 0, "shutdown 后正常退出（exit=%s）" % code)

    print()
    if failures:
        print("FAILED: %d 项未通过" % len(failures))
        for item in failures:
            print("  - %s" % item)
        return 1
    print("ALL PASSED")
    return 0


def main():
    # 私有总线先行：后续 SessionBus 与 bin/mpris-host 都指向它
    private_bus = privatebus.start()
    try:
        return run()
    finally:
        privatebus.stop(private_bus)


if __name__ == "__main__":
    sys.exit(main())
