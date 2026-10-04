/**
 * MoeKoe MPRIS 桥接页（隐藏窗口）
 *
 * 数据流：
 *   MoeKoe WebSocket API (ws://127.0.0.1:6520, 需在设置中开启「API 模式」)
 *        │  lyrics / playerState
 *        ▼
 *   本桥接页：解析 KRC 歌词、定位当前行、维护曲目与播放状态
 *        │  JSON Lines (window.electronAPI.nativeHost.send)
 *        ▼
 *   bin/mpris-host (Python)：按传输模式投影歌词，注册
 *        org.mpris.MediaPlayer2.MoeKoeMusic 到会话 D-Bus
 *
 * 传输模式与悬浮窗显示设置（开关/透明度/位置）由插件弹窗直连本地程序写入并
 * 持久化，桥接页只搬运播放数据；本地程序按设置投影后上总线，弹窗设置页再从
 * 本地程序回读状态（status-request 回执），保证设置页永远与后端一致。
 */
(function () {
  'use strict';

  var HOST_ID = 'mpris-host';
  var WS_URL = 'ws://127.0.0.1:6520';
  var PROTOCOL = 1;
  var RECONNECT_DELAY = 1000;
  var POSITION_INTERVAL = 500;    // 位置上报最小间隔（毫秒）
  var MAX_PAYLOAD = 60000;        // Native Host 单条 stdin 消息上限 64KB，留出余量

  var state = {
    wsConnected: false,
    wsLastError: '',
    hostSummary: null,
    hostReady: false,
    hostLastError: '',
    track: null,
    trackKey: '',
    duration: 0,
    position: 0,
    isPlaying: false,
    lines: [],
    lyricsHash: '',
    lineIndex: -1,
    format: 'none',
    sentCount: 0,
    lastPositionSentAt: 0,
    sendError: '',
    hint: '',
    chmodCommand: ''
  };

  /* ---------------- 工具 ---------------- */

  function hashText(text) {
    var hash = 5381;
    for (var i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    return hash + ':' + text.length;
  }

  function splitArtists(value) {
    return String(value || '')
      .split(/\s*[、,，/]\s*/)
      .map(function (item) { return item.trim(); })
      .filter(Boolean)
      .slice(0, 16);
  }

  function normalizeTrack(song) {
    return {
      id: String((song && (song.hash || song.playHash || song.id)) || ''),
      title: String((song && (song.name || song.title)) || ''),
      artists: splitArtists(song && (song.author || song.author_name || song.artist)),
      // MoeKoe 队列项的专辑字段是 albumname（实测 song.album 在真实环境恒为空）
      album: String((song && (song.album || song.album_name || song.albumname)) || ''),
      artUrl: String((song && (song.img || song.pic || song.cover)) || ''),
      url: String((song && song.url) || '')
    };
  }

  function toSeconds(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
  }

  /* ---------------- 与本地程序通信 ---------------- */

  function updateHostSummary(host) {
    state.hostSummary = host
      ? {
          authorized: !!host.authorized,
          supported: !!host.supported,
          valid: !!host.valid,
          running: !!host.running,
          errors: host.errors || [],
          executablePath: host.executablePath || ''
        }
      : null;
    refreshHint();
  }

  function refreshHint() {
    var host = state.hostSummary;
    state.chmodCommand = '';
    if (!host) {
      state.hint = '';
      return;
    }
    if (!host.supported) {
      state.hint = 'MPRIS 仅在 Linux 桌面可用';
    } else if (!host.authorized) {
      state.hint = '请在插件管理页授权本地程序';
    } else if (!host.running && !state.hostReady) {
      // zip 安装会丢失可执行位，spawn 失败时最常见的原因就是没有 +x
      state.hint = '本地程序未启动，多半是缺少可执行权限';
      state.chmodCommand = 'chmod +x ' + (host.executablePath || 'bin/mpris-host');
    } else {
      state.hint = '';
    }
  }

  function send(payload) {
    var json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD) {
      state.sendError = '消息过大已跳过（' + json.length + ' 字节）';
      return Promise.resolve({ success: false, message: state.sendError });
    }

    if (!window.electronAPI || !window.electronAPI.nativeHost) {
      return Promise.resolve({ success: false, message: 'Electron Native Host API 不可用' });
    }

    return window.electronAPI.nativeHost
      .getStatus(HOST_ID)
      .then(function (result) {
        updateHostSummary(result && result.host);
        return window.electronAPI.nativeHost.send(HOST_ID, payload);
      })
      .then(function (result) {
        var ok = !!(result && result.success);
        state.sendError = ok ? '' : String((result && result.message) || '发送失败');
        if (ok) state.sentCount++;
        refreshHint();
        return result || { success: false };
      })
      .catch(function (error) {
        state.sendError = error.message || String(error);
        refreshHint();
        return { success: false, message: state.sendError };
      });
  }

  /* ---------------- 向 host 推送状态 ---------------- */

  function pushHello() {
    return send({ type: 'hello', protocol: PROTOCOL, client: 'moekoe-mpris-bridge' });
  }

  function pushTrack() {
    if (!state.track) return Promise.resolve({ success: true });
    return send({
      type: 'track',
      track: state.track,
      duration: state.duration,
      position: state.position,
      status: state.isPlaying ? 'Playing' : 'Paused'
    });
  }

  function pushLyrics() {
    return send({ type: 'lyrics', lines: state.lines });
  }

  function pushLine() {
    var line = state.lineIndex >= 0 ? state.lines[state.lineIndex] || null : null;
    return send({ type: 'line', line: line });
  }

  function pushStatus(force) {
    var now = Date.now();
    if (!force && now - state.lastPositionSentAt < POSITION_INTERVAL) return Promise.resolve({ success: true });
    state.lastPositionSentAt = now;
    return send({
      type: 'status',
      isPlaying: state.isPlaying,
      position: state.position,
      // 全量快照随状态消息走：宿主合并后回执给弹窗，设置页与状态列表都以它为准
      snapshot: getStatus()
    });
  }

  /** 重连 / host 重启后把完整状态同步一次 */
  function pushAll() {
    return pushTrack()
      .then(pushLyrics)
      .then(pushLine)
      .then(function () { return pushStatus(true); });
  }

  /* ---------------- 歌词处理 ---------------- */

  function applyLyrics(raw, trackChanged) {
    if (typeof raw !== 'string' || !raw.trim()) {
      if (!trackChanged && state.lines.length === 0) return;
      state.lines = [];
      state.format = 'none';
      state.lyricsHash = '';
      state.lineIndex = -1;
      pushLyrics();
      pushLine();
      pushStatus(true);  // 清空歌词也是状态变化，快照保持新鲜
      return;
    }

    var hash = hashText(raw);
    if (hash === state.lyricsHash && !trackChanged) return;
    state.lyricsHash = hash;

    var parsed = MoeKoeLyrics.parse(raw);
    state.lines = parsed.lines;
    state.format = parsed.format;
    pushLyrics();
    pushStatus(true);  // 歌词行数变化，快照保持新鲜
  }

  /** 根据播放进度刷新当前行，行号变化时推送 line 消息 */
  function refreshLine(force) {
    var index = MoeKoeLyrics.findLineIndex(state.lines, state.position * 1000);
    if (!force && index === state.lineIndex) return;
    state.lineIndex = index;
    pushLine();
    pushStatus(true);  // 当前行变化，快照保持新鲜
  }

  /* ---------------- MoeKoe WebSocket ---------------- */

  var socket = null;
  var reconnectTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      socket = new WebSocket(WS_URL);
    } catch (error) {
      state.wsLastError = error.message || String(error);
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      state.wsConnected = true;
      state.wsLastError = '';
      pushStatus(true);  // 重连成功，立刻让宿主/弹窗看到真实现状
    };

    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message && message.type === 'lyrics') handleLyrics(message.data || {});
      else if (message && message.type === 'playerState') handlePlayerState(message.data || {});
    };

    socket.onerror = function () {
      state.wsLastError = 'MoeKoe WebSocket 连接失败（请确认已在设置中开启 API 模式）';
    };

    socket.onclose = function () {
      state.wsConnected = false;
      pushStatus(true);  // 断开后立刻反映状态
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }

  function reconnect() {
    if (socket) {
      try { socket.close(); } catch (error) { /* ignore */ }
    } else {
      connect();
    }
  }

  function handleLyrics(data) {
    var song = data.currentSong || null;
    var position = typeof data.currentTime === 'number' ? data.currentTime : state.position;
    var duration = toSeconds(data.duration);
    var trackKey = song ? String(song.hash || song.playHash || song.id || '') : state.trackKey;
    var trackChanged = !!(trackKey && trackKey !== state.trackKey);

    if (trackChanged) {
      state.trackKey = trackKey;
      state.track = normalizeTrack(song);
      state.duration = duration;
      state.position = position;
      state.lines = [];
      state.lyricsHash = '';
      state.lineIndex = -1;
      state.format = 'none';
      pushTrack();
    } else if (duration > 0 && Math.abs(duration - state.duration) > 0.5) {
      // 首帧时 audio.duration 可能尚未就绪，就绪后再同步一次 mpris:length
      state.duration = duration;
      pushTrack();
    }

    state.position = position;
    applyLyrics(data.lyricsData, trackChanged);
    refreshLine(trackChanged);
    pushStatus(trackChanged);
  }

  function handlePlayerState(data) {
    var statusChanged = typeof data.isPlaying === 'boolean' && data.isPlaying !== state.isPlaying;
    if (typeof data.isPlaying === 'boolean') state.isPlaying = data.isPlaying;
    if (typeof data.currentTime === 'number') state.position = data.currentTime;

    refreshLine(false);
    pushStatus(statusChanged);
  }

  /* ---------------- host -> bridge ---------------- */

  if (window.electronAPI && window.electronAPI.nativeHost) {
    window.electronAPI.nativeHost.onMessage(function (payload) {
      if (!payload || payload.hostId !== HOST_ID) return;
      var message = payload.message;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        state.hostReady = true;
        state.hostLastError = '';
        pushAll();
      } else if (message.type === 'error') {
        state.hostReady = false;
        state.hostLastError = String(message.message || '本地程序错误');
      } else if (message.type === 'bye') {
        state.hostReady = false;
      } else if (message.type === 'bridge-command') {
        // 弹窗 → 宿主 → 广播回来的指令（弹窗没有直连桥接页的通道）
        if (message.cmd === 'reconnect') {
          reconnect();
          pushHello();
        } else if (message.cmd === 'push-all') {
          pushAll();
        }
      }
    });
  }

  /* ---------------- 状态查询（host / popup） ---------------- */

  function getStatus() {
    return {
      ws: { connected: state.wsConnected, url: WS_URL, error: state.wsLastError },
      host: state.hostSummary,
      hostReady: state.hostReady,
      hostLastError: state.hostLastError,
      sendError: state.sendError,
      hint: state.hint,
      chmodCommand: state.chmodCommand,
      format: state.format,
      track: state.track,
      duration: state.duration,
      position: state.position,
      isPlaying: state.isPlaying,
      lineCount: state.lines.length,
      lineIndex: state.lineIndex,
      line: state.lineIndex >= 0 ? state.lines[state.lineIndex] || null : null,
      sentCount: state.sentCount
    };
  }

  /* ---------------- 启动 ---------------- */

  connect();
  pushHello();
  // 心跳快照：让宿主随时知道桥接页活着（弹窗据此判断桥接页状态）
  setInterval(function () { pushStatus(true); }, 2000);
})();
