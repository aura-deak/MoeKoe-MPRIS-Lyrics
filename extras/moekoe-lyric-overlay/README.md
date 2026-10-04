# moekoe-lyric-overlay

MoeKoe MPRIS 插件的配套悬浮歌词客户端（Wayland）。

插件本身把 MoeKoe 的歌词推到会话 D-Bus（`org.moekoe.MPRIS.Lyrics` 接口），
本程序订阅该接口，在 wlr-layer-shell 悬浮层上显示当前歌词行——
歌词来源是 **MoeKoe 自己**（含酷狗翻译），不联网取词。
`CurrentLine` 已由插件按传输模式投影，客户端直接显示即可：

| 插件弹窗模式 | CurrentLine 内容 | 悬浮层显示 |
| --- | --- | --- |
| 单歌词 | `text` | 原文一行 |
| 单翻译 | `translation` | 译文一行 |
| 歌词翻译 | `text` + `translation` | 原文大字 + 译文小字 |

兼容 niri、Hyprland、Sway 等支持 layer-shell 的合成器。

## 依赖

- `python-gobject`（PyGObject，含 GTK4 绑定）
- `gtk4`
- `gtk4-layer-shell`
- `python-dbus`（托盘图标；缺失时只是没有托盘，不影响悬浮显示）

Arch 系一行装齐：

```bash
sudo pacman -S python-gobject gtk4 gtk4-layer-shell python-dbus
```

没有 root 时可免密装到用户目录（脚本会自动回退到 `~/.local/lib/moekoe-layer-shell`）：

```bash
mkdir -p /tmp/g4ls ~/.local/lib/moekoe-layer-shell/typelib
curl -fsSL -o /tmp/g4ls/p.pkg.tar.zst \
  https://mirrors.tuna.tsinghua.edu.cn/archlinux/extra/os/x86_64/gtk4-layer-shell-1.3.0-1-x86_64.pkg.tar.zst
bsdtar -xf /tmp/g4ls/p.pkg.tar.zst -C /tmp/g4ls
cp -a /tmp/g4ls/usr/lib/libgtk4-layer-shell.so* ~/.local/lib/moekoe-layer-shell/
cp -a /tmp/g4ls/usr/lib/girepository-1.0/Gtk4LayerShell-1.0.typelib \
  ~/.local/lib/moekoe-layer-shell/typelib/
```

## 用法

```bash
./moekoe-lyric-overlay                 # 底部居中悬浮显示
./moekoe-lyric-overlay --show-track    # 歌词上方加一行曲目名
./moekoe-lyric-overlay --dump          # 不开窗口，把歌词行打进终端（调试用）
./moekoe-lyric-overlay --help          # 全部选项
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--anchor` | `bottom` | `bottom` / `top`，悬浮位置（宿主未提供 `Position` 时的回退值） |
| `--margin` | `64` | 距屏幕边缘像素 |
| `--font-size` | `28` | 原文字号（pt），译文/曲名按比例缩小 |
| `--layer` | `overlay` | `overlay`（压住一切窗口）/ `top`（普通置顶） |
| `--show-track` | 关 | 歌词上方显示曲目名 |
| `--no-click-through` | 穿透开 | 关闭鼠标穿透，让悬浮窗可接收右键菜单与拖动 |
| `--dump` | 关 | 调试：不建窗口，逐行打印收到的歌词 |
| `--bus-name` | MoeKoe | 其他暴露同接口的播放器也可接 |

## 显示设置（推荐在插件弹窗里改）

总开关、背景透明度、显示位置、整体缩放、鼠标穿透都存在插件宿主里
（`~/.config/moekoe-mpris/config.json`），本程序通过只读接口
`org.moekoe.MPRIS.Overlay`（`Enabled` / `Opacity` / `Position` /
`ClickThrough` / `Scale` / `PosX` / `PosY`）读取并实时跟随，无需重启。
命令行参数只在宿主不可用（旧版 / 播放器没起）时作为回退默认值。

- **鼠标穿透**（默认开）：悬浮窗不接收鼠标事件，点击直接落到下层窗口。
- **拖动改位置**：关闭穿透后可直接拖动悬浮文字，松手经 `SavePosition`
  把坐标回写宿主并持久化（`Position` 变为 `custom`）；在插件弹窗里选预设
  位置即可回到贴边/居中。`Scale`（0.5–2.0）整体缩放字号与内边距。
- **退出**：**左键单击桌面托盘里的悬浮歌词图标即可关闭**，右键则弹出
  「退出」菜单；也可先关闭穿透，再在悬浮文字上点右键 → “退出”。命令行
  调试可用 `pkill -f moekoe-lyric-overlay`。
- **纯音乐抑制**：当前行为「纯音乐，请欣赏」时，悬浮窗自动隐藏不显示。
- **重启**：插件弹窗里的「立即重启悬浮歌词」会结束本进程并由宿主重新拉起
  （等价于完全重启 MoeKoe）。
- 单实例：重复启动会提示“已有另一个悬浮歌词实例在运行”后退出。

**随插件自动启动**：宿主 `bin/mpris-host` 启动时会自动拉起本程序
（MoeKoe 启动即启动，宿主退出时一并关闭），单实例去重，无需手动运行。
环境变量 `MOEKOE_MPRIS_NO_OVERLAY=1` 可关闭自动拉起；自动启动时的输出写入
`~/.cache/moekoe-mpris/overlay.log`。

## 工作原理

1. 连接会话 D-Bus，`GetAll org.moekoe.MPRIS.Lyrics` 与
   `org.moekoe.MPRIS.Overlay` 拉初始状态；
2. 歌词**单订阅** `LineChanged`（发送端保证每次变化恰好一条，无需去重）；
   另外订阅 `PropertiesChanged` 取 `PlaybackStatus` / `Metadata` 与显示设置；
3. 订阅 `NameOwnerChanged`：MoeKoe 关闭即隐藏，重新启动后自动恢复并重读设置；
4. `text` / `translation` 有内容、非纯音乐占位、且总开关为开时才显示窗口，
   换歌间隙（index = -1）自动隐藏；
5. 在会话总线上注册 SNI 托盘图标（`org.kde.StatusNotifierItem` +
   `com.canonical.dbusmenu`）：左键单击直接关闭悬浮窗，右键弹出「退出」菜单，
   悬停提示「点击关闭悬浮歌词」。

## 故障排查

```bash
# 1. 插件是否在 D-Bus 上
busctl --user get-property org.mpris.MediaPlayer2.MoeKoeMusic \
  /org/mpris/MediaPlayer2 org.moekoe.MPRIS.Lyrics CurrentLine

# 2. 不开窗口看歌词是否在流动
./moekoe-lyric-overlay --dump
```

- 没有歌词：确认 MoeKoe 已开启 API 模式并重启过、插件已启用且正在播放。
- `错误：未找到 gtk4-layer-shell`：按上面的依赖章节安装（有 root 用 pacman，没 root 用用户级装法）。
- `错误：需要 Wayland 会话`：本程序基于 wlr-layer-shell，仅支持 Wayland（X11 请改用其他客户端）。
