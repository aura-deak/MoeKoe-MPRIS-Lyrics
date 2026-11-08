/**
 * MoeKoe MPRIS 桥接页（隐藏窗口）
 *
 * 数据流：
 *   MoeKoe WebSocket API (ws://127.0.0.1:6520, 需在设置中开启「API 模式」)
 *        │  lyrics / playerState
 *        ▼
 *   本桥接页：解析曲目与播放状态
 *        │  JSON Lines (window.electronAPI.nativeHost.send)
 *        ▼
 *   bin/mpris-host (Python)：注册 org.mpris.MediaPlayer2.MoeKoeMusic 到会话 D-Bus
 */
(function () {
  'use strict';

  var HOST_ID = 'mpris-host';
  var WS_URL = 'ws://127.0.0.1:6520';
  var PROTOCOL = 1;
  var RECONNECT_DELAY = 1000;
  var POSITION_INTERVAL = 500;    // 位置上报最小间隔（毫秒）
  var MAX_PAYLOAD = 60000;        // Native Host 单条 stdin 消息上限 64KB，留出余量

  // Bilibili Index-Translate 免费 API（OpenAI 兼容，无需 key）
  var BILI_TRANSLATE_URL = 'https://index-translate.bilibili.com/v1/chat/completions';
  var BILI_TRANSLATE_MODEL = 'Index-Translate-35B-A3B';

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
    sentCount: 0,
    lastPositionSentAt: 0,
    sendError: '',
    hint: '',
    chmodCommand: '',
    // xesam:asText 配置
    asTextFormat: 'lrc',    // 'plain' | 'lrc'
    asTextSource: 'original', // 'original' | 'translation'
    asTextApiFallback: false  // 翻译模式取不到翻译时，是否走 Bilibili API 翻译
  };

  /* ---------------- 工具 ---------------- */

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
      url: String((song && song.url) || ''),
      // 作词人：xesam:lyricist。MoeKoe 接口字段名不统一，做多字段兜底
      lyricist: splitArtists(
        song && (song.lyricist || song.word || song.lyrics_writer)
      )
    };
  }

  function toSeconds(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
  }

  /* ---- 歌词全文与作词人（xesam:asText / xesam:lyricist）---- */

  /** 去掉 LRC 行首时间标签，得到纯文本歌词 */
  function stripLrc(text) {
    return String(text || '')
      .split('\n')
      .map(function (line) {
        var stripped = String(line);
        // 一行可能带多个时间标签（如 [00:01.00][00:05.00]副歌）
        while (/^\s*\[[^\]]*\]/.test(stripped)) {
          stripped = stripped.replace(/^\s*\[[^\]]*\]\s*/, '');
        }
        return stripped;
      })
      .filter(function (line) { return line.trim(); })
      .join('\n');
  }

  /** 按字节截断，避免歌词把整条消息撑过 Native Host 64KB 上限 */
  function capBytes(text, maxBytes) {
    var value = String(text || '');
    if (!value) return '';
    try {
      var encoder = new TextEncoder();
      if (encoder.encode(value).length <= maxBytes) return value;
      var lo = 0;
      var hi = value.length;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (encoder.encode(value.slice(0, mid)).length <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      return value.slice(0, lo) + '…';
    } catch (error) {
      return value.slice(0, 12000) + '…';
    }
  }

  /** 从 lyrics 消息与歌曲对象中提取歌词全文与作词人列表 */
    /** 从 lyrics 消息与歌曲对象中提取原文/翻译歌词全文与作词人列表 */
  
  /** 解析 KRC 格式中的 [language:base64] 标签，提取翻译歌词 */
  function extractKrcTranslation(krcText) {
    var match = krcText.match(/\[language:([^\]]*)\]/);
    if (!match) return '';
    var encoded = match[1];
    if (!encoded) return '';
    // 补全 base64 padding
    encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
    try {
      var binary = atob(encoded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var json = new TextDecoder().decode(bytes);
      var languageData = JSON.parse(json);
      var sections = (languageData && languageData.content) || [];
      var translations = [];
      sections.forEach(function (section) {
        if (section.type === 1) { // type=1 为翻译
          var content = Array.isArray(section.lyricContent) ? section.lyricContent : [];
          content.forEach(function (entry) {
            translations.push(Array.isArray(entry) ? entry[0] : entry);
          });
        }
      });
      return translations.join('\n');
    } catch (error) {
      return '';
    }
  }

/**
 * MoeKoe 接口下发的歌词字符串换行是字面量 "\n"（双重转义），先还原成真实换行。
 * 不还原的话 stripLrc / krcToLrc 的逐行解析全部失效，asText 会变成一整行。
 */
function unescapeLyricText(text) {
  return String(text || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

/** 检测内容是否为酷狗 KRC 格式（逐字时间轴 `[start,dur]<off,dur,0>字…`） */
function isKrc(text) {
  return /\[\d+,\d+\]/.test(String(text || ''));
}

/** 毫秒 → LRC 行时间标签 [mm:ss.xx] */
function krcMsToLrcTime(ms) {
  var total = Math.max(0, parseInt(ms, 10) || 0);
  var min = Math.floor(total / 60000);
  var sec = Math.floor((total % 60000) / 1000);
  var cs = Math.floor((total % 1000) / 10);
  return '[' +
    (min < 10 ? '0' : '') + min + ':' +
    (sec < 10 ? '0' : '') + sec + '.' +
    (cs < 10 ? '0' : '') + cs + ']';
}

/**
 * 翻译行与 KRC 原文按顺序对齐，生成带行级时间戳的翻译 LRC。
 * 翻译载荷（[language:base64] 解出的 type=1 行、data.translation / song.tlyric）
 * 只有纯文本、没有时间信息，不补时间戳的话消费端能显示但不会滚动。
 * 对齐规则：第 N 个翻译行配第 N 个 `[start,dur]` 原文行；不足的行跳过。
 */
function alignTranslationToKrc(krcText, translationText) {
  // 注意：空译文行（片头署名行、间奏行等）也占一个对齐位，必须保留；
  // 滤掉会让后续译文整体前移一行（Summer Dream 实测错位一拍就是这个原因）
  var lines = String(translationText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); });
  if (!lines.some(function (line) { return line; })) return '';
  var out = [];
  var index = 0;
  String(krcText || '')
    .split(/\r?\n/)
    .forEach(function (line) {
      var krcLine = line.match(/^\s*\[(\d+),(\d+)\]/);
      if (!krcLine || index >= lines.length) return;
      out.push(krcMsToLrcTime(krcLine[1]) + lines[index]);
      index++;
    });
  return out.join('\n');
}

/**
 * KRC → 标准 LRC（行级时间戳）
 *  - `[start,dur]<off,dur,0>字…` 逐字时间轴行 → `[mm:ss.xx]歌词整行`
 *  - `[language:base64]` 发音/翻译标签 → 丢弃（非标准，通用消费端只当乱码）
 *  - `[ti:][ar:][al:][by:][offset:]` 等 LRC 头标签原样保留
 */
function krcToLrc(krcText) {
  return String(krcText || '')
    // [language:base64] 发音/翻译载荷：可能独占一行也可能紧贴后续标签，进文本先全局移除
    .replace(/\[language:[^\]]*\]/g, '')
    .split(/\r?\n/)
    .map(function (line) {
      var trimmed = line.replace(/^\uFEFF/, '');
      // KRC 逐字时间轴行 → 行级时间标签 + 剥离 <...> 字级标签
      var krcLine = trimmed.match(/^\s*\[(\d+),(\d+)\](.*)$/);
      if (krcLine) {
        var body = krcLine[3].replace(/<\d+,\d+,\d+>/g, '');
        return krcMsToLrcTime(krcLine[1]) + body;
      }
      // 其余（头标签/空行）原样返回
      return trimmed;
    })
    .filter(function (line) { return line.trim(); })
    .join('\n');
}

function extractLyricsMeta(data, song) {
    var rawOriginal = '';
    var rawTranslation = '';
    if (typeof data === 'string') {
      rawOriginal = data;
    } else if (data) {
      var payload = data.lyricsData || data.lyrics || data.text;
      // 原文
      if (typeof payload === 'string') {
        rawOriginal = payload;
      } else if (Array.isArray(payload)) {
        rawOriginal = payload
          .map(function (item) {
            return typeof item === 'string'
              ? item
              : String((item && (item.text || item.line || item.words)) || '');
          })
          .filter(Boolean)
          .join("\n");
      } else if (payload && typeof payload.text === 'string') {
        rawOriginal = payload.text;
      } else if (song && typeof song.lrc === 'string') {
        rawOriginal = song.lrc;
      }
      // 翻译：data.translation / payload.translation / song.tlyric
      var transPayload = data.translation || (payload && payload.translation);
      if (typeof transPayload === 'string') {
        rawTranslation = transPayload;
      } else if (Array.isArray(transPayload)) {
        rawTranslation = transPayload
          .map(function (item) {
            return typeof item === 'string'
              ? item
              : String((item && (item.text || item.line || item.words)) || '');
          })
          .filter(Boolean)
          .join("\n");
      } else if (transPayload && typeof transPayload.text === 'string') {
        rawTranslation = transPayload.text;
      } else if (song && typeof song.tlyric === 'string') {
        rawTranslation = song.tlyric;
      }
      // 兜底：从 KRC 原文中提取 [language:...] 翻译
      if (!rawTranslation && typeof payload === 'string') {
        rawTranslation = extractKrcTranslation(payload);
      }
    }

    var lyricists = [];
    if (data && data.lyricist) lyricists = splitArtists(data.lyricist);
    if (!lyricists.length && song && song.lyricist) lyricists = splitArtists(song.lyricist);

    // 处理两份歌词：分别剥离/截断，根据配置决定最终写入 track.lyrics
    // 先还原字面量 \n，再检测 KRC：
    // KRC 不是 LRC，逐字时间轴与 [language:base64] 只有酷狗系消费端认识，
    // 统一转成标准 LRC（行级 [mm:ss.xx] 时间戳），plain 分支的 stripLrc 也能正确剥标签
    rawOriginal = unescapeLyricText(rawOriginal);
    rawTranslation = unescapeLyricText(rawTranslation);
    if (isKrc(rawOriginal)) {
      // 翻译载荷本身不带时间戳；若它不是 KRC/LRC，就按原文行时间戳对齐补齐
      // （先于 krcToLrc 处理，因为对齐要用未转换的 KRC 原文）
      var transHasTime = /\[\d{2}:\d{2}/.test(rawTranslation);
      if (rawTranslation && !transHasTime && !isKrc(rawTranslation)) {
        rawTranslation = alignTranslationToKrc(rawOriginal, rawTranslation);
      }
      rawOriginal = krcToLrc(rawOriginal);
    } else if (isKrc(rawTranslation)) {
      rawTranslation = krcToLrc(rawTranslation);
    }
    var originalPlain = stripLrc(capBytes(rawOriginal, 40000));
    var originalLrc = capBytes(rawOriginal, 40000);
    var translationPlain = stripLrc(capBytes(rawTranslation, 40000));
    var translationLrc = capBytes(rawTranslation, 40000);

    // 根据当前配置选择：
    // - 原文模式 → 原文
    // - 翻译模式且有翻译 → 翻译（中文歌词除外：无论配置直接原文透传）
    // - 翻译模式但取不到翻译 → 原文透传（api-fallback 打开时由 maybeTranslateWithApi 异步补翻译后重推）
    var finalLyrics = originalPlain;
    if (state.asTextSource === 'translation' && translationLrc && !isMostlyChinese(rawOriginal)) {
      finalLyrics = state.asTextFormat === 'lrc' ? translationLrc : translationPlain;
    } else {
      finalLyrics = state.asTextFormat === 'lrc' ? originalLrc : originalPlain;
    }

    return {
      // 剥掉末尾空行，保证 xesam:asText 干净（多行歌词的尾部换行无意义）
      lyrics: finalLyrics.replace(/\n+$/, ''),
      originalPlain: originalPlain,
      originalLrc: originalLrc,
      translationPlain: translationPlain,
      translationLrc: translationLrc,
      lyricists: lyricists
    };
  }

  /* ---------------- Bilibili API 翻译（api-fallback） ---------------- */

  /** 中文率：CJK 汉字占全部有效字符（去时间标签/空白/标点）的比例 */
  function chineseRatio(text) {
    var cleaned = String(text || '').replace(/\[[^\]]*\]/g, '');
    var chars = cleaned.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!chars.length) return 0;
    var cjk = (chars.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    return cjk / chars.length;
  }

  /** 中文率 ≥ 80% 视为中文歌词：无论配置如何，直接原文透传到翻译通道 */
  function isMostlyChinese(text) {
    return chineseRatio(text) >= 0.8;
  }

  /** 拆一行 LRC：行首时间标签 + 歌词正文 */
  function splitLrcLine(line) {
    var stamps = '';
    var rest = String(line || '');
    var match;
    while ((match = rest.match(/^\s*\[[^\]]*\]/))) {
      stamps += match[0];
      rest = rest.replace(/^\s*\[[^\]]*\]\s*/, '');
    }
    return { stamps: stamps, text: rest };
  }

  /**
   * 调用 Bilibili Index-Translate API 逐行翻译歌词。
   * 输入保留时间标签的 LRC，输出同样格式：时间标签原样保留，正文换成译文。
   * 行号协议：发送「N|正文」，要求译文同样「N|译文」，按行号回贴，防止错位。
   */
  function translateLyricsViaBilibili(lrcText) {
    var lines = String(lrcText || '').replace(/^\uFEFF/, '').split('\n');
    var numbered = lines.map(function (line, index) {
      return (index + 1) + '|' + splitLrcLine(line).text;
    }).join('\n');

    return fetch(BILI_TRANSLATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer unused'  // API 无需鉴权，仅兼容客户端格式
      },
      body: JSON.stringify({
        model: BILI_TRANSLATE_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: '你是歌词翻译引擎。把用户输入的歌词逐行翻译为简体中文。' +
              '输入每行格式为「行号|歌词」。输出必须：' +
              '1) 行数与输入完全一致；2) 每行以相同的行号和「|」开头；' +
              '3) 空行/纯符号行保持原样；4) 只输出译文，不要任何解释或额外内容。'
          },
          { role: 'user', content: numbered }
        ]
      })
    }).then(function (response) {
      if (!response.ok) throw new Error('Bilibili 翻译 API HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      var content = data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      var map = {};
      String(content || '').split('\n').forEach(function (line) {
        var match = line.match(/^\s*(\d+)\s*\|\s*(.*)$/);
        if (match) map[parseInt(match[1], 10)] = match[2].trim();
      });
      var out = lines.map(function (line, index) {
        var parts = splitLrcLine(line);
        var translated = Object.prototype.hasOwnProperty.call(map, index + 1)
          ? map[index + 1]
          : '';
        return parts.stamps + translated;
      });
      var result = out.join('\n').replace(/\n+$/, '');
      if (!result.replace(/\[[^\]]*\]/g, '').trim()) {
        throw new Error('Bilibili 翻译 API 返回为空');
      }
      return result;
    });
  }

  /** 按当前配置从原始歌词重新计算 track.lyrics 并返回是否变化 */
  function recomputeTrackLyrics() {
    if (!state.track) return false;
    var rawOriginal = (state.track._rawLyrics || '').replace(/\n+$/, '');
    var rawTranslation = (state.track._rawTranslation || '').replace(/\n+$/, '');
    var originalPlain = stripLrc(capBytes(rawOriginal, 40000));
    var originalLrc = capBytes(rawOriginal, 40000);
    var translationPlain = stripLrc(capBytes(rawTranslation, 40000));
    var translationLrc = capBytes(rawTranslation, 40000);

    var finalLyrics;
    if (state.asTextSource === 'translation' && translationLrc && !isMostlyChinese(rawOriginal)) {
      finalLyrics = state.asTextFormat === 'lrc' ? translationLrc : translationPlain;
    } else {
      // 翻译模式取不到翻译，或中文歌词 → 原文透传
      finalLyrics = state.asTextFormat === 'lrc' ? originalLrc : originalPlain;
    }
    finalLyrics = finalLyrics.replace(/\n+$/, '');
    if (finalLyrics === state.track.lyrics) return false;
    state.track.lyrics = finalLyrics;
    return true;
  }

  /**
   * api-fallback：翻译模式下取不到软件翻译时，异步请求 Bilibili API 翻译。
   * 成功后把结果写入 _rawTranslation 并重推 track；失败则保持原文透传。
   */
  function maybeTranslateWithApi() {
    if (!state.asTextApiFallback) return;
    if (state.asTextSource !== 'translation') return;
    if (!state.track || state.track._rawTranslation) return;
    var original = (state.track._rawLyrics || '').replace(/\n+$/, '');
    if (!original) return;
    if (isMostlyChinese(original)) return;  // 中文歌词：无需翻译，直接透传
    if (state.track._apiTranslationPending) return;
    state.track._apiTranslationPending = true;
    translateLyricsViaBilibili(original)
      .then(function (translated) {
        if (state.track && !state.track._rawTranslation && translated) {
          state.track._rawTranslation = translated;
          if (recomputeTrackLyrics()) pushTrack();
        }
      })
      .catch(function (error) {
        // 翻译失败：保持原文透传，静默处理（下次换歌会重试）
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[moekoe-mpris] api-fallback 翻译失败:', error && error.message);
        }
      })
      .then(function () {
        if (state.track) state.track._apiTranslationPending = false;
      });
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
    return pushTrack().then(function () { return pushStatus(true); });
  }

  /* ---------------- 向 MoeKoe WebSocket 发送控制命令 ---------------- */

  var VALID_COMMANDS = { toggle: true, next: true, prev: true };

  function sendControl(command) {
    var cmd = String(command || '');
    if (!VALID_COMMANDS[cmd]) return;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({
        type: 'control',
        data: { command: cmd }
      }));
    } catch (error) {
      // 发送失败静默处理：控制权在用户手里，失败了再点一次即可
    }
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

    var lyricsMeta = extractLyricsMeta(data, song);
    var lyricsChanged = !!(
      state.track &&
      !trackChanged &&
      (lyricsMeta.lyrics !== (state.track.lyrics || '') ||
       lyricsMeta.lyricists.join('\u0001') !== (state.track.lyricist || []).join('\u0001'))
    );

    if (trackChanged) {
      state.trackKey = trackKey;
      state.track = normalizeTrack(song);
      // 保存原始歌词供配置切换时重新计算
      state.track._rawLyrics = lyricsMeta.originalLrc.replace(/\n+$/, '');
      state.track._rawTranslation = lyricsMeta.translationLrc.replace(/\n+$/, '');
      state.track.lyrics = lyricsMeta.lyrics;
      if (lyricsMeta.lyricists.length) state.track.lyricist = lyricsMeta.lyricists;
      state.duration = duration;
      state.position = position;
      pushTrack();
    } else if (lyricsChanged) {
      // 歌词往往比首帧 track 晚到：内容就绪后补推一次，刷新 xesam:asText / xesam:lyricist
      state.track._rawLyrics = lyricsMeta.originalLrc.replace(/\n+$/, '');
      state.track._rawTranslation = lyricsMeta.translationLrc.replace(/\n+$/, '');
      state.track.lyrics = lyricsMeta.lyrics;
      if (lyricsMeta.lyricists.length) state.track.lyricist = lyricsMeta.lyricists;
      pushTrack();
    } else if (duration > 0 && Math.abs(duration - state.duration) > 0.5) {
      // 首帧时 audio.duration 可能尚未就绪，就绪后再同步一次 mpris:length
      state.duration = duration;
      pushTrack();
    }

    state.position = position;
    // 翻译模式 + api-fallback：软件翻译缺失时异步补 Bilibili API 翻译
    maybeTranslateWithApi();
    pushStatus(trackChanged);
  }

  function handlePlayerState(data) {
    var statusChanged = typeof data.isPlaying === 'boolean' && data.isPlaying !== state.isPlaying;
    if (typeof data.isPlaying === 'boolean') state.isPlaying = data.isPlaying;
    if (typeof data.currentTime === 'number') state.position = data.currentTime;

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
        } else if (message.cmd === 'set-config') {
          // 更新 xesam:asText 配置
          if (typeof message.asTextFormat === 'string') state.asTextFormat = message.asTextFormat;
          if (typeof message.asTextSource === 'string') state.asTextSource = message.asTextSource;
          if (typeof message.asTextApiFallback === 'boolean') state.asTextApiFallback = message.asTextApiFallback;
          // 配置变更后若有歌词，重新计算并推送
          if (state.track && (state.track.lyrics || state.track.lyrics === '')) {
            if (recomputeTrackLyrics()) pushTrack();
            // 刚打开 api-fallback 且当前没有翻译 → 异步补 API 翻译
            maybeTranslateWithApi();
          }
        }
      } else if (message.type === 'control') {
        // MPRIS D-Bus 调用 → 宿主 → 桥接页，再经 WebSocket 发给 MoeKoe
        sendControl(message.command);
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
      track: state.track,
      duration: state.duration,
      position: state.position,
      isPlaying: state.isPlaying,
      sentCount: state.sentCount,
      asTextFormat: state.asTextFormat,
      asTextSource: state.asTextSource,
      asTextApiFallback: state.asTextApiFallback
    };
  }

  /* ---------------- 启动 ---------------- */

  connect();
  pushHello();
  // 心跳快照：让宿主随时知道桥接页活着（弹窗据此判断桥接页状态）
  setInterval(function () { pushStatus(true); }, 2000);
})();
