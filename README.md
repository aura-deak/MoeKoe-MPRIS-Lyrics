# MoeKoe MPRIS Lyrics（Linux）

⚠️VIBE CODING WARNING!

![alt text](image.png)

为 **MoeKoe Music** 提供 Linux 下的 **MPRIS2** 协议支持：在会话 D-Bus 上注册
`org.mpris.MediaPlayer2.MoeKoeMusic`，把当前曲目、播放状态暴露给桌面组件，
并通过 **Metadata 自定义键 + 独立 D-Bus 信号** 传输歌词。

## 安装

### 依赖

1. MoeKoe Music **≥ 1.6.6**（`moekoe:nativeHost` 要求）
2. Python 3 与 D-Bus 绑定：

```bash
# Debian / Ubuntu
sudo apt install python3-dbus python3-gi
# Fedora
sudo dnf install python3-dbus python3-gobject
# Arch
sudo pacman -S python-dbus python-gobject
```

3. MoeKoe 设置 → 开启 **API 模式**（插件通过 `ws://127.0.0.1:6520` 取数据）


### zip 安装

先[点击下载最新版本的install.zip](https://github.com/aura-deak/MoeKoe-MPRIS-Lyrics/releases/latest/download/install.zip)
在 **设置 → 插件 → 安装插件** 里选择该 zip

> ⚠️ MoeKoe 解压 zip 时不保留文件权限，`bin/mpris-host` 会丢失可执行位。
> 安装后请打开插件弹窗，按提示执行（弹窗会给出确切路径）：
>
> ```bash
> chmod +x ~/.config/moekoemusic/extensions/moekoe-mpris/bin/mpris-host
> ```

### 启用

1. **设置 → 插件** 启用 `MoeKoe MPRIS (Linux)`
2. 在插件管理页 **授权本地程序**（`mpris-host`）
3. 播放任意歌曲，打开弹窗确认

---

## 插件弹窗

- **连接状态**：D-Bus 注册状态、MoeKoe API 连接状态、当前曲目与进度
- **歌词传输模式**：单歌词 / 单翻译 / 歌词翻译 一键切换（写入
  `~/.config/moekoe-mpris/config.json`，由宿主统一持久化）
- **悬浮歌词显示**：总开关、鼠标穿透、背景透明度、显示位置（含拖动后的
  「自定义」）、整体缩放、立即重启悬浮歌词
- **传输预览**：按当前模式展示即将上总线的当前行
- **立即同步 / 重新连接 / 刷新**：强制重推数据、重连 API、拉取一次合并状态

弹窗不做后台轮询：打开时拉一次合并状态，之后点「刷新」按需更新；所有设置
直连宿主（`electronAPI.nativeHost`），宿主是唯一真相源，控件以后端回执回填。

---

## 配套悬浮歌词客户端

`extras/moekoe-lyric-overlay/` 是本插件的 Wayland 悬浮歌词窗口（Python +
GTK4 + layer-shell，兼容 niri / Hyprland / Sway），直连
`org.moekoe.MPRIS.Lyrics` 显示 MoeKoe 自己的歌词与翻译，不联网取词：

```bash
extras/moekoe-lyric-overlay/moekoe-lyric-overlay           # 底部居中悬浮
extras/moekoe-lyric-overlay/moekoe-lyric-overlay --dump    # 终端逐行打印（调试）
extras/moekoe-lyric-overlay/moekoe-lyric-overlay --help    # 全部选项
```

**随 MoeKoe 自动启动**：插件宿主 `bin/mpris-host` 启动时自动拉起悬浮窗
（MoeKoe 起 → 插件起 → 悬浮窗起；MoeKoe 退出 → 宿主收尾 → 悬浮窗关闭），
单实例去重，手动启动/调试同样可用。环境变量 `MOEKOE_MPRIS_NO_OVERLAY=1`
可关闭自动拉起，子进程日志在 `~/.cache/moekoe-mpris/overlay.log`。

**显示设置**（在插件弹窗里改，实时生效并持久化）：总开关、背景透明度、
六档位置、整体缩放、鼠标穿透。**关闭鼠标穿透后可直接拖动悬浮文字**调整位置，
松手自动保存（位置变为「自定义」）；选择预设位置则回到贴边/居中。鼠标穿透
默认开启——此时悬浮窗不接收鼠标，**左键单击桌面托盘里的悬浮歌词图标即可
关闭悬浮窗**，右键则弹出「退出」菜单；关闭穿透后也可在悬浮文字上右键退出。
改动设置后若悬浮窗未及时更新，弹窗里的「立即重启悬浮歌词」会重新拉起客户端
（等价于完全重启 MoeKoe）。当前行为「纯音乐，请欣赏」时，悬浮窗自动隐藏不显示。

依赖安装与故障排查见 `extras/moekoe-lyric-overlay/README.md`。

---

## 已知限制

1. **曲目信息需要播放一次才会推送**：MoeKoe 只在播放中向 WS API 发送
   `lyrics` 消息，因此纯暂停状态下首次连接可能暂时看不到元数据。
2. **暂停期间进度不刷新**：暂停时 MoeKoe 不再推送 `lyrics`，`Position` 以最后一次
   校正值为准（播放中每 500ms 校正一次）。
3. **插件只支持 Linux**：其他平台会在弹窗提示 `MPRIS 仅在 Linux 桌面可用`。
4. **zip 安装需要手动 `chmod +x`**（见上文），弹窗会给出确切命令。
5. **不开放播放控制**（最小可用设计），控制类方法返回 Not Supported。

---

## 传输模式
歌词支持三种可切换的传输模式：

| 模式 | 标识 | 传出去的内容 |
| --- | --- | --- |
| 单歌词 | `original` | 只传原文 |
| 单翻译 | `translation` | 只传译文 |
| 歌词翻译 | `both` | 原文 + 译文 |

模式在插件弹窗里切换，切换后 Metadata、`CurrentLine`、`LyricsJson`、`LineChanged`
信号会一次性原子更新，不会出现「模式已改但数据还是旧的」中间态。

---

## 功能范围

**已实现（最小可用 MPRIS 播放器）**

- `org.mpris.MediaPlayer2`：`Identity`、`CanQuit`、`CanRaise`、`HasTrackList`、`SupportedUriSchemes`、`SupportedMimeTypes`
- `org.mpris.MediaPlayer2.Player`：`Metadata`、`PlaybackStatus`、`Position`（带本地插值）、`Rate`、`Volume`、`Can*`
- 曲目元数据：`mpris:trackid`、`mpris:length`、`mpris:artUrl`、`xesam:title`、`xesam:artist`、`xesam:album`、`xesam:url`
- 歌词扩展接口 `org.moekoe.MPRIS.Lyrics`：`Mode`、`CurrentLine`、`LyricsJson` 属性 + `LineChanged` 信号
- 悬浮窗显示接口 `org.moekoe.MPRIS.Overlay`：`Enabled`、`Opacity`、`Position`、`ClickThrough`、`Scale`、`PosX`、`PosY` 只读属性 + `SavePosition` 方法（悬浮窗拖动后回写自由位置）
- 完整 Introspection（`busctl introspect` / `gdbus introspect` 可直接查看）
- 自动拉起配套悬浮歌词客户端（`extras/moekoe-lyric-overlay`，`MOEKOE_MPRIS_NO_OVERLAY=1` 可关闭），
  显示设置持久化到 `~/.config/moekoe-mpris/config.json`

**未实现（按最小可用设计）**

- 播放控制：`Play` / `Pause` / `Next` / `Previous` / `Seek` / `SetPosition` 等一律返回
  `org.freedesktop.DBus.Error.NotSupported`，`CanPlay`、`CanPause`、`CanSeek`、`CanControl` 均为 `false`
- TrackList / Playlists 接口
- Windows / macOS（MPRIS 是 Linux 专属协议）


## 架构

```text
MoeKoe Music (Electron)
  ├─ WebSocket API  ws://127.0.0.1:6520     ← 需在设置中开启「API 模式」
  │      │  lyrics（KRC 原文 + 曲目 + 进度） / playerState
  │      ▼
  │  native-bridge.html/js（插件隐藏桥接页）
  │      │  解析 KRC → 定位当前行 → JSON Lines
  │      ▼
  └─ bin/mpris-host（Python 本地程序，插件系统托管）
         │  D-Bus: org.mpris.MediaPlayer2.MoeKoeMusic
         │    ├─ org.mpris.MediaPlayer2[.Player]  标准播放器
         │    ├─ org.moekoe.MPRIS.Lyrics          歌词
         │    └─ org.moekoe.MPRIS.Overlay         悬浮窗显示设置
         ├─→ 会话总线 → playerctl / KDE 媒体组件 / 自定义歌词消费端
         └─→ 自动拉起悬浮歌词客户端（extras/moekoe-lyric-overlay）
```

MoeKoe 推送的 `lyricsData` 是酷狗 **KRC 原始文本**，翻译以 `[language:base64]`
标签内嵌（`type: 1` 为翻译、`type: 0` 为音译）。解析规则与 MoeKoe 自带的
`src/components/player/LyricsHandler.js` 保持一致，因此插件输出的歌词行与播放器
界面显示逐字对齐；非 KRC 场景会自动回退到 LRC 解析。

三种传输模式的投影在 `bin/mpris-host` 内完成，弹窗把模式直写宿主，保证
「上总线的内容」只由一个环节决定。

---

## 歌词传输协议

### 1. Metadata 自定义键

`org.mpris.MediaPlayer2.Player.Metadata` 中随当前歌词行变化：

| 键 | 类型 | 出现的模式 | 含义 |
| --- | --- | --- | --- |
| `moekoe:lyrics` | `s` | `original`、`both` | 当前行原文 |
| `moekoe:translation` | `s` | `translation`、`both` | 当前行译文 |

行变化时通过 `org.freedesktop.DBus.Properties.PropertiesChanged` 广播，
`mpris:trackid` 保持不变，消费端可据此区分「换行」与「换歌」。

### 2. 独立歌词接口 `org.moekoe.MPRIS.Lyrics`

对象路径：`/org/mpris/MediaPlayer2`

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `Mode` | `s`（只读） | `original` / `translation` / `both` |
| `CurrentLine` | `a{sv}`（只读） | 当前行负载（字段见下表，附带 `mode`）；无当前行时为 `{"index": -1, "mode": ...}` |
| `LyricsJson` | `s`（只读） | 整首歌词 JSON 数组，已按模式投影 |
| `LineChanged` | 信号 `a{sv}` | 每次歌词行变化推送，负载与 `CurrentLine` 完全一致（同一构造函数产出，可按值直接比较） |

`CurrentLine` / `LineChanged` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `index` | `i` | 行号，`-1` 表示无当前行 |
| `text` | `s` | 当前行原文（`original` / `both` 才出现） |
| `translation` | `s` | 当前行译文（`translation` / `both` 才出现） |
| `start` | `i` | 行起始时间（毫秒） |
| `duration` | `i` | 行时长（毫秒） |
| `mode` | `s` | 当前传输模式（`CurrentLine` 与 `LineChanged` 都携带，与 `Mode` 属性同源） |

三处出口——`Metadata` 的 `moekoe:*` 键、`CurrentLine` 属性、`LineChanged`
信号——由同一个行负载构造函数产出，字段保证一致，下游可直接按值比较。

`LyricsJson` 示例：

```json
[
  {"index": 0, "start": 0, "duration": 4000, "text": "水の中で", "translation": "在水中"},
  {"index": 1, "start": 4000, "duration": 4000, "text": "光をつかむ", "translation": "抓住光芒"}
]
```

### 3. 三种模式对照

| 通道 | 单歌词 `original` | 单翻译 `translation` | 歌词翻译 `both` |
| --- | --- | --- | --- |
| `Metadata["moekoe:lyrics"]` | ✅ | ❌ | ✅ |
| `Metadata["moekoe:translation"]` | ❌ | ✅ | ✅ |
| `CurrentLine` / `LineChanged` | 仅 `text` | 仅 `translation` | `text` + `translation` |
| `LyricsJson` 每行字段 | `text` | `translation` | `text` + `translation` |

被排除的内容不会出现在总线上（不只是「显示时不显示」）。

### 4. 悬浮窗显示接口 `org.moekoe.MPRIS.Overlay`

对象路径同为 `/org/mpris/MediaPlayer2`，是配套悬浮歌词客户端（以及任何歌词
消费端）读取显示设置的**只读**接口（`SavePosition` 是唯一的写方法）：

| 属性 | 签名 | 说明 |
| --- | --- | --- |
| `Enabled` | `b` | 悬浮窗总开关 |
| `Opacity` | `d` | 背景透明度，`0.0`–`1.0` |
| `Position` | `s` | `bottom-center` / `bottom-left` / `bottom-right` / `top-center` / `top-left` / `top-right` / `custom`（拖动后的自由位置） |
| `ClickThrough` | `b` | 鼠标穿透（`true` 时点击落到下层窗口） |
| `Scale` | `d` | 整体缩放，`0.5`–`2.0`（默认 `1.0`） |
| `PosX` / `PosY` | `i` | `Position == "custom"` 时相对当前输出左上角的像素坐标 |

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `SavePosition` | `ii → ()` | 悬浮客户端拖动结束后回写自由坐标；宿主切到 `custom` 并持久化 |

设置由插件弹窗写入宿主（`payload.type = "config"`），宿主校验后原子写入
`~/.config/moekoe-mpris/config.json` 并通过 `PropertiesChanged` 广播；
悬浮客户端订阅后实时生效。拖动位置由客户端经 `SavePosition` 回写，仍由宿主
统一落盘。配置目录可用环境变量 `MOEKOE_MPRIS_CONFIG_DIR` 覆盖，默认
`{"enabled": true, "opacity": 0.62, "position": "bottom-center",
"click_through": true, "scale": 1.0, "x": 0, "y": 0}`。

### 5. 快速验证

```bash
# 查看当前曲目与歌词
busctl --user get-property org.mpris.MediaPlayer2.MoeKoeMusic \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata

busctl --user get-property org.mpris.MediaPlayer2.MoeKoeMusic \
  /org/mpris/MediaPlayer2 org.moekoe.MPRIS.Lyrics CurrentLine

# 查看悬浮窗显示设置
busctl --user get-property org.mpris.MediaPlayer2.MoeKoeMusic \
  /org/mpris/MediaPlayer2 org.moekoe.MPRIS.Overlay Position

# 订阅逐行歌词信号
busctl --user monitor org.mpris.MediaPlayer2.MoeKoeMusic

# 或用 playerctl
playerctl -p MoeKoeMusic metadata --format '{{xesam:title}} - {{moekoe:lyrics}}'
```

---

## 目录结构

```text
moekoe-mpris/
├── manifest.json          插件清单（声明 moekoe_native_hosts）
├── background.js          后台（仅记录生命周期）
├── popup.html/css/js      弹窗：状态、模式切换、传输预览
├── native-bridge.html/js  隐藏桥接页：连 WS API、解析歌词、转发本地程序
├── lyrics-parser.js       KRC/LRC 解析与当前行定位（桥接页与弹窗共用）
├── bin/mpris-host         Python 本地程序：D-Bus 上的 MPRIS 实现
├── icons/                 图标（icon16/48/128，由源图生成）
├── assets/                图标源图（打包时排除）
├── scripts/               make-icons.py（图标生成）、pack.py（zip 打包）
├── tests/                 自动化测试；bridge-harness.js 是桥接页的 Node 测试桩
├── extras/                配套工具（moekoe-lyric-overlay 悬浮歌词，随包分发）
└── dist/                  打包输出（已加入 .gitignore）
```

### 桥接页 ↔ 本地程序消息协议

入站（MoeKoe 写入 stdin，JSON Lines）：

```jsonc
{"type":"message","payload":{"type":"hello","protocol":1}}
{"type":"shutdown"}
```

| `payload.type` | 字段 | 作用 |
| --- | --- | --- |
| `hello` | `protocol`，可选 `mode` | 握手，返回 `ready`；带 `mode` 时兼容旧桥接页并应用该模式 |
| `mode` | `mode` | 切换传输模式并原子刷新全部歌词通道（持久化） |
| `track` | `track`、`duration`、`position`、`status` | 曲目元数据；`track.id` 变化视为换歌并清空歌词 |
| `lyrics` | `lines` | 整首歌词原始行（未投影） |
| `line` | `line` | 当前行；`null` 表示无当前行 |
| `status` | `isPlaying`、`position`，可选 `snapshot` | 播放状态与进度；`snapshot` 为桥接页自述状态 |
| `position` | `position` | 仅进度校正 |
| `config` | `enabled` / `opacity` / `position` / `clickThrough` / `scale` 任意子集 | 写入悬浮窗显示设置，校验后持久化并广播 `Overlay` |
| `status-request` | — | 返回一条合并后的 `status`（宿主 + 桥接页快照） |
| `overlay-restart` | — | 结束当前悬浮客户端并拉起新进程（弹窗「立即重启」），随后回一条 `status` |
| `bridge-command` | `cmd`（`reconnect` / `push-all`） | 转发给桥接页执行 |
| `ping` | — | 心跳 |

出站（stdout，JSON Lines，单条 < 64KB）：`ready` / `pong` / `error` / `bye` /
`status` / `bridge-command`。日志只写 stderr，不会污染协议。

> 注意：`mode` 与 `config` 的权威副本是宿主的
> `~/.config/moekoe-mpris/config.json`；桥接页的 `hello` 不再携带 `mode`，
> 以免重连时把用户设置覆盖回默认值。

---

## 测试

```bash
tests/run_all.sh              # 一键跑全部

python3 tests/test_manifest.py    # manifest 与文件完整性（无需 D-Bus 服务）
node    tests/test-lyrics-parser.js   # KRC/LRC 解析、行定位、三种模式投影
python3 tests/test_mpris_host.py   # 本地程序 D-Bus 集成
python3 tests/test_e2e.py          # 端到端：WS 消息 → 桥接页 → 本地程序 → D-Bus
```

后两个测试跑在自带的**私有 D-Bus**（临时 `dbus-daemon`）上，
即使 MoeKoe 正在运行、插件宿主持有同名总线名称也不会互相干扰。
`test_e2e.py` 通过 `tests/bridge-harness.js` 在 Node 里运行**真实的桥接页代码**，
用桩环境替代 Electron 与 MoeKoe WebSocket，因此覆盖了完整链路。

---

## 权限说明（上架审核参考）

| 项目 | 结论 | 说明 |
| --- | --- | --- |
| `networkAccess` | 仅本机 | `ws://127.0.0.1:6520` 与会话 D-Bus，不访问公网 |
| `fileAccess` | 无 | 不读写用户文件 |
| `binaryContent` | 无 | `bin/mpris-host` 是带 shebang 的 Python 文本脚本 |
| `moekoe:nativeHost` | 有 | 插件核心能力，已在 `moekoe_permissions` 声明 |

## License

GPL-2.0（与 MoeKoe Music 主项目一致）

Copyright (C) 2026 陈子涵
