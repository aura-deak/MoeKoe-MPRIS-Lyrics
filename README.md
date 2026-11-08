# MoeKoe MPRIS（Linux）

⚠️VIBE CODING WARNING!

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/710cd88c-da65-41c1-bece-79b8bab9bada" />
图中终端歌词显示为mpris-lyrics，悬浮歌词显示为wshowlyrics  

---
为 **MoeKoe Music** 提供 Linux 下的 **MPRIS2** 协议支持：在会话 D-Bus 上注册
`org.mpris.MediaPlayer2.MoeKoeMusic`，把当前曲目、播放状态暴露给桌面组件，
并把 MPRIS Player 控制指令反向桥接到 MoeKoe WebSocket API。

只暴露标准 MPRIS 接口：

- `org.mpris.MediaPlayer2` — 根接口（最小可用）
- `org.mpris.MediaPlayer2.Player` — 播放状态 / Metadata / Position / 控制

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

## 卸载

> ⚠️ **卸载前必须先运行「撤销修复」**：如果用过弹窗里的「自动修复启动项」，
> 插件会生成 `~/.local/bin/moekoemusic` 启动包装，并覆盖应用菜单启动项
> （`~/.local/share/applications/moekoemusic.desktop`）。直接移除插件会让这些改动
> 残留并持续生效。正确顺序：
>
> 1. 打开插件弹窗，点 **「撤销修复（卸载前必点）」**；
> 2. 确认提示显示「撤销完成」；
> 3. 再到 **设置 → 插件** 移除本插件。
>
> 「撤销修复」只清理本插件生成的内容（启动包装与菜单覆盖），不会碰其他文件；
> 若当时没点撤销，也可手动 `rm ~/.local/bin/moekoemusic` 并删除
> `~/.local/share/applications/` 下 Exec 指向它的同名 `.desktop`。

---

## 插件弹窗

- **连接状态**：D-Bus 注册状态、MoeKoe API 连接状态、当前曲目与进度
- **立即同步 / 重新连接 / 刷新**：强制重推数据、重连 API、拉取一次合并状态
- **防重复注册**：一键创建/撤销带 `--disable-features=MediaSessionService` 的启动包装（卸载前必须撤销，见「卸载」一节）
- **支持作者**：GitHub 仓库入口

弹窗不做后台轮询：打开时拉一次合并状态，之后点「刷新」按需更新。

---

## 已知限制

1. **曲目信息需要播放一次才会推送**：MoeKoe 只在播放中向 WS API 发送
   `lyrics` 消息，因此纯暂停状态下首次连接可能暂时看不到元数据。
2. **暂停期间进度不刷新**：暂停时 MoeKoe 不再推送 `lyrics`，`Position` 以最后一次
   校正值为准（播放中每 500ms 校正一次）。
3. **插件只支持 Linux**：其他平台会在弹窗提示 `MPRIS 仅在 Linux 桌面可用`。
4. **zip 安装需要手动 `chmod +x`**（见上文），弹窗会给出确切命令。
5. **部分控制未开放**（MoeKoe WebSocket API 仅支持 `toggle` / `next` / `prev`）：
   `Seek` / `SetPosition` / `OpenUri` 以及 Root 的 `Raise` / `Quit` 返回
   `org.freedesktop.DBus.Error.NotSupported`。

---

## 功能范围

**已实现（标准 MPRIS 播放器）**

- `org.mpris.MediaPlayer2`：`Identity`、`CanQuit`、`CanRaise`、`HasTrackList`、`SupportedUriSchemes`、`SupportedMimeTypes`
- `org.mpris.MediaPlayer2.Player`：`Metadata`、`PlaybackStatus`、`Position`（带本地插值）、`Rate`、`Volume`、`Can*`
- 曲目元数据：`mpris:trackid`、`mpris:length`、`mpris:artUrl`、`xesam:title`、`xesam:artist`、`xesam:album`、`xesam:url`
- 播放控制：`Next` / `Previous` / `PlayPause` / `Play` / `Pause` / `Stop` 桥接到 MoeKoe WebSocket
- 完整 Introspection（`busctl introspect` / `gdbus introspect` 可直接查看）

**未实现（MoeKoe API 未开放）**

- `Seek` / `SetPosition` / `OpenUri` 返回 `NotSupported`
- TrackList / Playlists 接口
- Windows / macOS（MPRIS 是 Linux 专属协议）


## 架构

```text
MoeKoe Music (Electron)
  ├─ WebSocket API  ws://127.0.0.1:6520     ← 需在设置中开启「API 模式」
  │      │  lyrics（曲目 + 进度） / playerState
  │      ▼
  │  native-bridge.html/js（插件隐藏桥接页）
  │      │  JSON Lines
  │      ▼
  └─ bin/mpris-host（Python 本地程序，插件系统托管）
         │  D-Bus: org.mpris.MediaPlayer2.MoeKoeMusic
         │    └─ org.mpris.MediaPlayer2[.Player]  标准播放器
         └─→ 会话总线 → playerctl / KDE 媒体组件等
```

MoeKoe 推送的 `lyrics` 消息既用来取曲目与进度，也用来填充标准 Xesam 歌词元数据：
`xesam:asText`（歌词全文）与 `xesam:lyricist`（作词人）。歌词以纯文本形式放进
MPRIS 元数据，供支持这些字段的桌面媒体组件（如部分 KDE / GNOME 控件）读取。
插件不暴露任何私有 D-Bus 接口，只做标准 MPRIS 桥接。

**api-fallback 翻译兜底**：弹窗选择「翻译」来源但歌曲没有软件自带翻译时，可在弹窗中开启
「Bilibili API 翻译」兜底——调用 Bilibili 免费 Index-Translate API
（`https://index-translate.bilibili.com/v1`，OpenAI 兼容，无需 key）逐行译为简体中文，
并按行号回贴原 LRC 时间标签；翻译失败或未开启兜底时原文透传。

---

## 目录结构

```text
moekoe-mpris/
├── manifest.json          插件清单（声明 moekoe_native_hosts）
├── background.js          后台（仅记录生命周期）
├── popup.html/css/js      弹窗：连接状态
├── native-bridge.html/js  隐藏桥接页：连 WS API、转发本地程序
├── bin/mpris-host         Python 本地程序：D-Bus 上的 MPRIS 实现
├── icons/                 图标（icon16/48/128，由源图生成）
├── assets/                图标源图（打包时排除）
├── scripts/               make-icons.py（图标生成）、pack.py（zip 打包）
├── tests/                 自动化测试；bridge-harness.js 是桥接页的 Node 测试桩
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
| `hello` | `protocol` | 握手，返回 `ready` |
| `track` | `track`、`duration`、`position`、`status` | 曲目元数据；`track.id` 变化视为换歌 |
| `status` | `isPlaying`、`position`，可选 `snapshot` | 播放状态与进度；`snapshot` 为桥接页自述状态 |
| `position` | `position` | 仅进度校正 |
| `status-request` | — | 返回一条合并后的 `status`（宿主 + 桥接页快照） |
| `bridge-command` | `cmd`（`reconnect` / `push-all` / `set-config` / `fix-launcher` / `unfix-launcher`） | `reconnect` / `push-all` 转发给桥接页；`set-config` 更新歌词配置（`asTextFormat` / `asTextSource` / `asTextApiFallback`）；`fix-launcher` / `unfix-launcher` 由本地程序直接处理（启动包装的创建与撤销） |
| `ping` | — | 心跳 |

出站（stdout，JSON Lines，单条 < 64KB）：`ready` / `pong` / `error` / `bye` /
`status` / `bridge-command` / `control` / `fix-launcher-result` /
`unfix-launcher-result`。日志只写 stderr，不会污染协议。

> 每条出站消息都必须带 `type` 字段：弹窗按 `message.type` 分派，缺了会静默超时。

---

## 测试

```bash
tests/run_all.sh              # 一键跑全部

python3 tests/test_manifest.py    # manifest 与文件完整性（无需 D-Bus 服务）
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
