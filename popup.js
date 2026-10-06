/**
 * MoeKoe MPRIS 弹窗：连接状态、歌词传输模式、悬浮歌词显示设置、传输预览。
 *
 * 弹窗不轮询：打开时向宿主要一次合并状态，需要时点「刷新」。设置（模式 /
 * 悬浮窗开关 / 透明度 / 位置 / 穿透）都直连宿主写入并持久化，宿主是唯一
 * 真相源；控件以后端回执回填，保证页面与后端一致。
 */
'use strict';

const HOST_ID = 'mpris-host';

const state = {
  mode: MoeKoeLyrics.DEFAULT_MODE,
  live: null,
  host: null
};

function $(id) {
  return document.getElementById(id);
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  var total = Math.max(Math.floor(seconds), 0);
  var minutes = Math.floor(total / 60);
  var rest = total % 60;
  return minutes + ':' + (rest < 10 ? '0' : '') + rest;
}

function setStateText(element, text, className) {
  element.textContent = text;
  element.className = className || '';
}

function notice(text) {
  var element = $('notice');
  if (!text) {
    element.hidden = true;
    element.textContent = '';
    return;
  }
  element.hidden = false;
  element.textContent = text;
}

/* ---------------- 数据获取（直连本地程序） ---------------- */

function hostSend(payload) {
  if (!window.electronAPI || !window.electronAPI.nativeHost) return Promise.resolve(null);
  return window.electronAPI.nativeHost
    .send(HOST_ID, payload)
    .catch(function () { return null; });
}

function fetchHostStatus() {
  if (!window.electronAPI || !window.electronAPI.nativeHost) {
    return Promise.resolve(null);
  }
  return window.electronAPI.nativeHost
    .getStatus(HOST_ID)
    .then(function (result) { return (result && result.host) || null; })
    .catch(function () { return null; });
}

function listenHost() {
  if (!window.electronAPI || !window.electronAPI.nativeHost) return;
  window.electronAPI.nativeHost.onMessage(function (payload) {
    if (!payload || payload.hostId !== HOST_ID) return;
    var message = payload.message;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'status' && message.status && typeof message.status === 'object') {
      applyLiveStatus(message.status);
    } else if (message.type === 'ready' || message.type === 'bye' || message.type === 'error') {
      setTimeout(refresh, 50);  // 宿主生命周期变化 → 重拉一次合并状态
    }
  });
}

function applyLiveStatus(status) {
  state.live = status;
  if (typeof status.mode === 'string') {
    state.mode = MoeKoeLyrics.normalizeMode(status.mode);
  }
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  var platform = (window.electron && window.electron.platform) || '';
  var live = state.live;
  var host = state.host;
  var overlay = live && live.overlay;

  if (platform && platform !== 'linux') {
    $('platform-tip').textContent = 'MPRIS 仅支持 Linux，当前平台：' + platform;
  }

  /* D-Bus 状态 */
  if (platform && platform !== 'linux') {
    setStateText($('dbus-state'), '仅 Linux 可用', 'warn');
  } else if (host && !host.authorized) {
    setStateText($('dbus-state'), '本地程序未授权', 'bad');
  } else if (host && !host.valid) {
    setStateText($('dbus-state'), '声明校验失败', 'bad');
  } else if (live && live.hostReady) {
    setStateText($('dbus-state'), '已注册 MPRIS 接口', 'ok');
    $('dbus-state').title = 'org.mpris.MediaPlayer2.MoeKoeMusic';
  } else if (host && host.running && live && live.hostLastError) {
    setStateText($('dbus-state'), '本地程序异常', 'bad');
  } else if (host && host.running) {
    setStateText($('dbus-state'), '本地程序运行中', 'warn');
  } else {
    setStateText($('dbus-state'), '本地程序未运行', 'bad');
  }

  /* MoeKoe API 状态 */
  if (!live) {
    setStateText($('ws-state'), '等待宿主状态回执', 'warn');
  } else if (live.bridgeAlive === false) {
    setStateText($('ws-state'), '桥接页未运行（等待自动重连）', 'bad');
  } else if (live.ws && live.ws.connected) {
    setStateText($('ws-state'), '已连接 127.0.0.1:6520', 'ok');
  } else {
    setStateText($('ws-state'), (live.ws && live.ws.error) || '未连接', 'bad');
  }

  /* 曲目与进度 */
  if (live && live.track && live.track.title) {
    var artists = (live.track.artists || []).join('、');
    setStateText($('track-state'), live.track.title + (artists ? ' - ' + artists : ''));
  } else {
    setStateText($('track-state'), '暂无（播放歌曲后推送）', 'muted');
  }

  if (live && live.track) {
    var text = formatTime(live.position) + ' / ' + formatTime(live.duration);
    text += live.isPlaying ? ' · 播放中' : ' · 已暂停';
    setStateText($('position-state'), text);
  } else {
    setStateText($('position-state'), '—', 'muted');
  }

  /* 悬浮歌词显示设置：以后端回执为准回填（正在操作的控件不覆盖） */
  var enabledBox = $('overlay-enabled');
  if (overlay) {
    if (document.activeElement !== enabledBox) enabledBox.checked = !!overlay.enabled;
    var slider = $('overlay-opacity');
    var pct = Math.round((Number(overlay.opacity) || 0) * 100);
    if (document.activeElement !== slider) slider.value = String(pct);
    $('overlay-opacity-value').textContent = pct + '%';
    var positionSelect = $('overlay-position');
    if (document.activeElement !== positionSelect) positionSelect.value = overlay.position || 'bottom-center';
    var scaleSlider = $('overlay-scale');
    var scalePct = Math.round((Number(overlay.scale) || 1) * 100);
    if (document.activeElement !== scaleSlider) scaleSlider.value = String(scalePct);
    $('overlay-scale-value').textContent = scalePct + '%';
    var clickBox = $('overlay-click-through');
    if (document.activeElement !== clickBox) clickBox.checked = !!overlay.clickThrough;
  } else {
    enabledBox.checked = false;
  }

  /* 提示信息 */
  /* 右侧「运行异常排查」常驻展示，这里只把真实路径回填进去（不隐藏） */
  if (live && live.chmodCommand) {
    $('chmod-command').textContent = live.chmodCommand;
  }
  if (live && live.hint) {
    notice(live.hint);
  } else if (live && live.hostLastError) {
    notice(live.hostLastError);
  } else if (live && live.sendError) {
    notice(live.sendError);
  } else if (!live && host && !host.authorized) {
    notice('请在 设置 → 插件 → 插件管理 中授权本地程序 mpris-host，授权后桥接页才会打开');
  } else if (!live && host && !host.valid) {
    notice('本地程序声明校验失败：' + (host.errors || []).join('；'));
  } else {
    notice('');
  }

  /* 模式按钮 */
  var buttons = document.querySelectorAll('#modes button');
  Array.prototype.forEach.call(buttons, function (button) {
    var active = button.dataset.mode === state.mode;
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.mode-tip'), function (tip) {
    tip.hidden = tip.dataset.mode !== state.mode;
  });

  /* 传输预览：槽位已在 HTML 里写好，这里只填文本 + 显隐，不重建节点 */
  var line = live && live.line;
  var sourceEl = $('preview-source');
  var textEl = $('preview-text');
  var transEl = $('preview-translation');
  if (!line) {
    sourceEl.hidden = true;
    transEl.hidden = true;
    textEl.className = 'muted';
    textEl.hidden = false;
    textEl.textContent = live ? '暂无当前歌词行' : '等待宿主状态回执…';
    return;
  }

  var projected = MoeKoeLyrics.projectLine(line, state.mode);
  sourceEl.hidden = false;
  sourceEl.textContent = '第 ' + (projected.index + 1) + ' 行 · ' + MoeKoeLyrics.modeLabel(state.mode);

  if (typeof projected.text === 'string') {
    textEl.hidden = false;
    textEl.className = 'line-text';
    textEl.textContent = projected.text;
  } else {
    textEl.hidden = true;
  }
  if (typeof projected.translation === 'string') {
    transEl.hidden = false;
    transEl.textContent = projected.translation || '（本行无译文）';
  } else {
    transEl.hidden = true;
  }
}

/* ---------------- 刷新 ---------------- */

function refresh() {
  fetchHostStatus().then(function (host) {
    state.host = host;
    render();
    hostSend({ type: 'status-request' });  // 回执经 onMessage → applyLiveStatus
  });
}

/* ---------------- 交互 ---------------- */

function saveMode(mode) {
  state.mode = MoeKoeLyrics.normalizeMode(mode);
  render();
  hostSend({ type: 'mode', mode: state.mode }).then(refresh);  // 宿主确认后回填
}

function bind() {
  document.querySelectorAll('#modes button').forEach(function (button) {
    button.addEventListener('click', function () {
      saveMode(button.dataset.mode);
    });
  });

  // 悬浮歌词显示设置：每项改动直写宿主（config），宿主校验、持久化并广播
  // 给悬浮客户端；随后 refresh 用后端回执回填，保证 UI 与真实状态一致。
  $('overlay-enabled').addEventListener('change', function () {
    hostSend({ type: 'config', enabled: this.checked }).then(refresh);
  });
  $('overlay-click-through').addEventListener('change', function () {
    // 穿透开启时悬浮窗不接收鼠标，关闭悬浮窗请点桌面托盘图标（左键直接关闭）
    hostSend({ type: 'config', clickThrough: this.checked }).then(refresh);
  });
  $('overlay-opacity').addEventListener('input', function () {
    $('overlay-opacity-value').textContent = this.value + '%';
  });
  $('overlay-opacity').addEventListener('change', function () {
    hostSend({ type: 'config', opacity: Number(this.value) / 100 }).then(refresh);
  });
  $('overlay-position').addEventListener('change', function () {
    hostSend({ type: 'config', position: this.value }).then(refresh);
  });
  $('overlay-scale').addEventListener('input', function () {
    $('overlay-scale-value').textContent = this.value + '%';
  });
  $('overlay-scale').addEventListener('change', function () {
    hostSend({ type: 'config', scale: Number(this.value) / 100 }).then(refresh);
  });
  // 立即重启：宿主结束当前悬浮客户端并拉起新进程（等价于完全重启 MoeKoe）
  $('overlay-restart').addEventListener('click', function () {
    hostSend({ type: 'overlay-restart' }).then(refresh);
  });

  $('reconnect').addEventListener('click', function () {
    hostSend({ type: 'bridge-command', cmd: 'reconnect' }).then(refresh);
  });
  $('sync').addEventListener('click', function () {
    hostSend({ type: 'bridge-command', cmd: 'push-all' }).then(refresh);
  });
  $('refresh').addEventListener('click', refresh);
}

listenHost();
bind();
render();
refresh();
