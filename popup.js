/**
 * MoeKoe MPRIS 弹窗：连接状态展示。
 *
 * 弹窗不轮询：打开时向宿主要一次合并状态，需要时点「刷新」。
 * 宿主是唯一真相源；控件以后端回执回填，保证页面与后端一致。
 */
'use strict';

const HOST_ID = 'mpris-host';

const state = {
  live: null,
  host: null,
  asTextFormat: 'lrc',
  asTextSource: 'original'
};

// 默认配置
const DEFAULT_CONFIG = {
  asTextFormat: 'lrc',
  asTextSource: 'original'
};

// 从 storage 加载配置
function loadConfig() {
  return new Promise(function (resolve) {
    if (!window.chrome || !chrome.storage || !chrome.storage.local) {
      resolve(DEFAULT_CONFIG);
      return;
    }
    chrome.storage.local.get(['asTextFormat', 'asTextSource'], function (items) {
      resolve({
        asTextFormat: items.asTextFormat || DEFAULT_CONFIG.asTextFormat,
        asTextSource: items.asTextSource || DEFAULT_CONFIG.asTextSource
      });
    });
  });
}

// 保存配置到 storage 并推送到 host
function saveConfig(config) {
  if (window.chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set(config, function () {
      // 忽略存储错误
    });
  }
  // 实时推送到 host
  hostSend({
    type: 'bridge-command',
    cmd: 'set-config',
    asTextFormat: config.asTextFormat,
    asTextSource: config.asTextSource
  }).then(function () {
    // 配置已推送，刷新状态回执
    refresh();
  });
}

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
    } else if (message.type === 'fix-launcher-result' || message.type === 'unfix-launcher-result') {
      showLauncherResult(message);
    } else if (message.type === 'ready' || message.type === 'bye' || message.type === 'error') {
      setTimeout(refresh, 50);  // 宿主生命周期变化 → 重拉一次合并状态
    }
  });
}

/* ---------------- 防重复注册自动修复 ---------------- */

var fixLauncherTimer = null;
var unfixLauncherTimer = null;

var LAUNCHER_BUTTONS = {
  'fix-launcher': { idle: '自动修复启动项', busy: '修复中…' },
  'unfix-launcher': { idle: '撤销修复（卸载前必点）', busy: '撤销中…' }
};

function showLauncherResult(result) {
  if (fixLauncherTimer) {
    clearTimeout(fixLauncherTimer);
    fixLauncherTimer = null;
  }
  if (unfixLauncherTimer) {
    clearTimeout(unfixLauncherTimer);
    unfixLauncherTimer = null;
  }
  // 回执不区分来源按钮，统一复位
  Object.keys(LAUNCHER_BUTTONS).forEach(function (id) {
    var button = $(id);
    button.disabled = false;
    button.textContent = LAUNCHER_BUTTONS[id].idle;
  });
  var element = $('fix-launcher-result');
  element.hidden = false;
  var ok = !!result.ok;
  element.textContent = result.message || (ok ? '完成' : '失败');
  element.className = 'tip fix-result ' + (ok ? 'ok' : 'bad');
}

function runLauncherCommand(cmd, buttonId, timerKey, timeoutMessage) {
  var button = $(buttonId);
  button.disabled = true;
  button.textContent = LAUNCHER_BUTTONS[buttonId].busy;
  hostSend({ type: 'bridge-command', cmd: cmd });
  // 本地程序未运行时不会收到回执，超时兜底提示
  var timer = setTimeout(function () {
    if (timerKey === 'fix') fixLauncherTimer = null; else unfixLauncherTimer = null;
    if (button.disabled) {
      showLauncherResult({ ok: false, message: timeoutMessage });
    }
  }, 4000);
  if (timerKey === 'fix') fixLauncherTimer = timer; else unfixLauncherTimer = timer;
}

function applyLiveStatus(status) {
  state.live = status;
  // 从宿主回执更新配置（启动时/重连时同步）
  if (typeof status.asTextFormat === 'string') state.asTextFormat = status.asTextFormat;
  if (typeof status.asTextSource === 'string') state.asTextSource = status.asTextSource;
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  var platform = (window.electron && window.electron.platform) || '';
  var live = state.live;
  var host = state.host;

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

  /* 歌词传输配置按钮 */
  var formatButtons = document.querySelectorAll('#format-modes button');
  Array.prototype.forEach.call(formatButtons, function (button) {
    var active = button.dataset.format === state.asTextFormat;
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  var sourceButtons = document.querySelectorAll('#source-modes button');
  Array.prototype.forEach.call(sourceButtons, function (button) {
    var active = button.dataset.source === state.asTextSource;
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
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

function bind() {
  $('reconnect').addEventListener('click', function () {
    hostSend({ type: 'bridge-command', cmd: 'reconnect' }).then(refresh);
  });
  $('sync').addEventListener('click', function () {
    hostSend({ type: 'bridge-command', cmd: 'push-all' }).then(refresh);
  });
  $('refresh').addEventListener('click', refresh);

  // 格式选择
  document.querySelectorAll('#format-modes button').forEach(function (button) {
    button.addEventListener('click', function () {
      var format = button.dataset.format;
      if (format !== state.asTextFormat) {
        state.asTextFormat = format;
        saveConfig({ asTextFormat: format, asTextSource: state.asTextSource });
      }
    });
  });

  // 来源选择
  document.querySelectorAll('#source-modes button').forEach(function (button) {
    button.addEventListener('click', function () {
      var source = button.dataset.source;
      if (source !== state.asTextSource) {
        state.asTextSource = source;
        saveConfig({ asTextFormat: state.asTextFormat, asTextSource: source });
      }
    });
  });

  // 防重复注册：自动生成带 flag 的启动包装
  $('fix-launcher').addEventListener('click', function () {
    runLauncherCommand(
      'fix-launcher',
      'fix-launcher',
      'fix',
      '没有收到本地程序回执：请先确认 mpris-host 正在运行（看上方 D-Bus 状态）'
    );
  });

  // 卸载前清理：删除插件生成的启动包装与菜单覆盖
  $('unfix-launcher').addEventListener('click', function () {
    runLauncherCommand(
      'unfix-launcher',
      'unfix-launcher',
      'unfix',
      '没有收到本地程序回执：请先确认 mpris-host 正在运行（看上方 D-Bus 状态）'
    );
  });
}

// 启动：加载配置并初始化
loadConfig().then(function (config) {
  state.asTextFormat = config.asTextFormat;
  state.asTextSource = config.asTextSource;
  listenHost();
  bind();
  render();
  refresh();
});
