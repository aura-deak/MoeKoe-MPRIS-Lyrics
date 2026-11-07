#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bin/mpris-host 集成测试。

把本地程序当子进程启动，模拟 MoeKoe Music 的 JSON Lines 输入，
再用另一个 D-Bus 连接校验 MPRIS 属性与播放控制。

运行：python3 tests/test_mpris_host.py
依赖：python3-dbus、python3-gi、dbus-daemon（测试跑在自带的私有 D-Bus 上，
      不与正在运行的 MoeKoe 宿主抢名称）
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "..", "bin", "mpris-host")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import privatebus  # noqa: E402

DBUS_NAME = "org.mpris.MediaPlayer2.MoeKoeMusic"
PATH = "/org/mpris/MediaPlayer2"
IFACE_ROOT = "org.mpris.MediaPlayer2"
IFACE_PLAYER = "org.mpris.MediaPlayer2.Player"
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

    def pump(duration=0.35):
        loop = GLib.MainLoop()
        GLib.timeout_add(int(duration * 1000), loop.quit)
        loop.run()

    # ---------------- 根接口 ----------------
    print("\n[根接口]")
    root = props.GetAll(IFACE_ROOT)
    check(str(root["Identity"]) == "MoeKoe Music", "Identity = MoeKoe Music")
    check(bool(root["CanQuit"]) is False, "CanQuit = false（最小可用）")
    player_props = props.GetAll(IFACE_PLAYER)
    check(bool(player_props["CanControl"]) is True, "CanControl = true")
    check(bool(player_props["CanPlay"]) is True, "CanPlay = true")
    check(bool(player_props["CanPause"]) is True, "CanPause = true")
    check(bool(player_props["CanGoNext"]) is True, "CanGoNext = true")
    check(bool(player_props["CanGoPrevious"]) is True, "CanGoPrevious = true")
    check(bool(player_props["CanSeek"]) is False, "CanSeek = false（WS API 暂未开放）")

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
    check("org.moekoe.MPRIS.Lyrics" not in interfaces, "Introspection 不含私有 Lyrics 接口")
    check("org.moekoe.MPRIS.Overlay" not in interfaces, "Introspection 不含私有 Overlay 接口")

    # ---------------- 握手与曲目 ----------------
    print("\n[曲目元数据]")
    host.send({"type": "hello", "protocol": 1})
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
    check("moekoe:lyrics" not in metadata, "Metadata 不含私有歌词键 moekoe:lyrics")
    check("moekoe:translation" not in metadata, "Metadata 不含私有歌词键 moekoe:translation")

    position1 = int(props.Get(IFACE_PLAYER, "Position"))
    time.sleep(0.3)
    position2 = int(props.Get(IFACE_PLAYER, "Position"))
    check(position2 > position1, "Position 在播放中自增（%d -> %d）" % (position1, position2))

    # ---------------- 播放状态 ----------------
    print("\n[播放状态]")
    host.send({"type": "status", "isPlaying": False, "position": 33.5})
    pump()
    check(str(props.Get(IFACE_PLAYER, "PlaybackStatus")) == "Paused", "暂停后 PlaybackStatus = Paused")
    check(abs(int(props.Get(IFACE_PLAYER, "Position")) - 33_500_000) < 1_000_000, "暂停后 Position 被校正到 33.5s")

    # ---------------- 状态回执（弹窗刷新） ----------------
    print("\n[状态回执]")
    host.send({"type": "status", "isPlaying": True, "position": 2.0,
               "snapshot": {"ws": {"connected": True}, "track": {"title": "T"},
                            "host": {"authorized": True}}})
    host.send({"type": "status-request"})
    status_reply = host.wait_for("status")
    check(status_reply is not None, "status-request 返回 status")
    if status_reply:
        merged = status_reply.get("status") or {}
        check(merged.get("hostReady") is True, "合并状态 hostReady")
        check(merged.get("bridgeAlive") is True, "合并状态 bridgeAlive（快照新鲜）")
        check(isinstance(merged.get("statusAt"), int), "合并状态 statusAt 为整数")
        check(merged.get("ws", {}).get("connected") is True, "合并状态含桥接页快照")
        check("mode" not in merged, "合并状态不含私有 mode 字段")
        check("overlay" not in merged, "合并状态不含私有 overlay 字段")

    # ---------------- 指令中继 ----------------
    print("\n[指令中继]")
    host.send({"type": "bridge-command", "cmd": "reconnect"})
    relay = host.wait_for("bridge-command")
    check(relay is not None and str(relay.get("cmd")) == "reconnect",
          "bridge-command 广播回 stdout")
    host.send({"type": "bridge-command", "cmd": "bogus"})
    err = host.wait_for("error")
    check(err is not None, "未知 bridge-command 返回 error")

    # ---------------- 播放控制（D-Bus → stdout control 消息） ----------------
    print("\n[播放控制：Next/Previous/PlayPause]")
    host.pending()  # 清空已有的消息
    player.Next()
    next_msg = host.wait_for("control")
    check(next_msg is not None and str(next_msg.get("command")) == "next",
          "Next() 下发 {type:control, command:next}")

    host.pending()
    player.Previous()
    prev_msg = host.wait_for("control")
    check(prev_msg is not None and str(prev_msg.get("command")) == "prev",
          "Previous() 下发 {type:control, command:prev}")

    host.pending()
    player.PlayPause()
    pp_msg = host.wait_for("control")
    check(pp_msg is not None and str(pp_msg.get("command")) == "toggle",
          "PlayPause() 下发 {type:control, command:toggle}")

    print("\n[播放控制：Play 仅在未播放时下发，Pause 仅在播放时下发]")
    # 先把状态明确切到 Paused
    host.send({"type": "status", "isPlaying": False, "position": 10.0})
    pump()
    host.pending()
    player.Play()
    play_msg = host.wait_for("control")
    check(play_msg is not None and str(play_msg.get("command")) == "toggle",
          "Play() 在 Paused 时下发 toggle")

    # 再切到 Playing，验证 Play 不下发、Pause 下发
    host.send({"type": "status", "isPlaying": True, "position": 10.0})
    pump()
    host.pending()
    player.Play()
    play_msg2 = host.wait_for("control", timeout=0.5)
    check(play_msg2 is None, "Play() 在 Playing 时不下发控制")
    leftover = [m for m in host.pending() if m.get("type") == "control"]
    check(not leftover, "Playing 时 Play() 无 control 消息")

    host.pending()
    player.Pause()
    pause_msg = host.wait_for("control")
    check(pause_msg is not None and str(pause_msg.get("command")) == "toggle",
          "Pause() 在 Playing 时下发 toggle")

    host.pending()
    # 切回 Paused，验证 Pause 不下发
    host.send({"type": "status", "isPlaying": False, "position": 10.0})
    pump()
    host.pending()
    player.Pause()
    pause_msg2 = host.wait_for("control", timeout=0.5)
    check(pause_msg2 is None, "Pause() 在 Paused 时不下发控制")
    leftover = [m for m in host.pending() if m.get("type") == "control"]
    check(not leftover, "Paused 时 Pause() 无 control 消息")

    print("\n[播放控制：Seek/SetPosition 仍未开放]")
    try:
        player.Seek(dbus.Int64(5_000_000))
        check(False, "Seek() 应返回 Not Supported")
    except dbus.exceptions.DBusException as exc:
        check(
            exc.get_dbus_name() == "org.freedesktop.DBus.Error.NotSupported",
            "Seek() 返回 Not Supported（WS API 未开放）",
        )
    try:
        player.SetPosition(dbus.ObjectPath("/org/mpris/MediaPlayer2/Track/any"),
                           dbus.Int64(10_000_000))
        check(False, "SetPosition() 应返回 Not Supported")
    except dbus.exceptions.DBusException as exc:
        check(
            exc.get_dbus_name() == "org.freedesktop.DBus.Error.NotSupported",
            "SetPosition() 返回 Not Supported（WS API 未开放）",
        )

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
