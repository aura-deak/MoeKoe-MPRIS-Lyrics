/**
 * MoeKoe MPRIS 歌词解析与模式投影
 *
 * MoeKoe Music 的 WebSocket API（ws://127.0.0.1:6520）在 `lyrics` 消息里推送的是
 * 酷狗 KRC 原始歌词文本，其中通过 `[language:base64]` 标签携带翻译（type=1）
 * 与音译（type=0）。本文件负责：
 *   1. 解析 KRC（并提供 LRC 兜底）为逐行结构
 *   2. 按「单歌词 / 单翻译 / 歌词翻译」三种模式投影出需要传输的字段
 *   3. 根据播放进度定位当前行
 *
 * 解析规则与 MoeKoe 自带的 src/components/player/LyricsHandler.js 保持一致，
 * 确保插件输出的歌词与播放器界面显示一致。
 */
(function (global) {
  'use strict';

  var MODES = ['original', 'translation', 'both'];
  var DEFAULT_MODE = 'both';

  function normalizeMode(mode) {
    return MODES.indexOf(mode) >= 0 ? mode : DEFAULT_MODE;
  }

  function modeLabel(mode) {
    if (mode === 'original') return '单歌词';
    if (mode === 'translation') return '单翻译';
    return '歌词翻译';
  }

  /** 解码 [language:...] 里的 base64 JSON，返回 { translation: string[], romanization: string[] } */
  function decodeLanguageTag(raw) {
    var result = { translation: [], romanization: [] };
    if (typeof raw !== 'string' || !raw) return result;

    var cleaned = raw.replace(/[^A-Za-z0-9+/=]/g, '');
    if (!cleaned) return result;
    cleaned += '='.repeat((4 - (cleaned.length % 4)) % 4);

    try {
      var json;
      if (typeof atob === 'function') {
        var binary = atob(cleaned);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        json = new TextDecoder().decode(bytes);
      } else {
        // Node 测试环境
        json = Buffer.from(cleaned, 'base64').toString('utf8');
      }
      var languageData = JSON.parse(json);
      var sections = (languageData && languageData.content) || [];

      sections.forEach(function (section) {
        var content = Array.isArray(section.lyricContent) ? section.lyricContent : [];
        if (section.type === 1) {
          result.translation = content.map(function (entry) {
            return Array.isArray(entry) ? entry[0] : entry;
          });
        }
      });
    } catch (error) {
      // 翻译标签损坏时按无翻译处理
    }
    return result;
  }

  /** 解析 KRC 文本，返回 { format, lines: [{index,start,duration,text,translation}] } */
  function parseKrc(raw) {
    var lines = [];
    var translated = [];
    var text = String(raw || '');

    var languageLine = null;
    text.split(/\r?\n/).some(function (line) {
      var match = line.match(/\[language:([^\]]*)\]/);
      if (match) {
        languageLine = match[1];
        return true;
      }
      return false;
    });
    if (languageLine) {
      translated = decodeLanguageTag(languageLine).translation;
    }

    var pending = [];
    text.split(/\r?\n/).forEach(function (line) {
      var match = line.match(/^\[(\d+),(\d+)\](.*)/);
      if (!match) return;

      var start = parseInt(match[1], 10);
      var duration = parseInt(match[2], 10);
      var content = match[3].replace(/<[^>]*>/g, '');
      if (!content.trim()) return;

      pending.push({ start: start, duration: duration, text: content });
    });

    pending.forEach(function (line, index) {
      lines.push({
        index: index,
        start: line.start,
        duration: line.duration > 0 ? line.duration : 0,
        text: line.text,
        translation: typeof translated[index] === 'string' ? translated[index] : ''
      });
    });

    return { format: lines.length > 0 ? 'krc' : 'none', lines: lines };
  }

  /** LRC 兜底：个别场景（如接口只返回 LRC）时间标签形如 [mm:ss.xx] */
  function parseLrc(raw) {
    var lines = [];
    var text = String(raw || '');

    text.split(/\r?\n/).forEach(function (line) {
      var matches = line.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
      var body = line.replace(/\[[^\]]*\]/g, '').trim();
      if (!matches || !body) return;

      var startMs = null;
      matches.forEach(function (tag) {
        var parts = tag.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
        if (!parts) return;
        var fraction = parts[3] || '0';
        var ms = parseInt(fraction, 10) * Math.pow(10, 3 - fraction.length);
        var value = (parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)) * 1000 + ms;
        if (startMs === null || value < startMs) startMs = value;
      });

      if (startMs === null) return;
      lines.push({ start: startMs, duration: 0, text: body, translation: '' });
    });

    lines.sort(function (a, b) { return a.start - b.start; });
    lines.forEach(function (line, index) { line.index = index; });
    return { format: lines.length > 0 ? 'lrc' : 'none', lines: lines };
  }

  /** 自动识别 KRC / LRC，返回统一结构 */
  function parse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { format: 'none', lines: [] };
    }
    var krc = parseKrc(raw);
    if (krc.lines.length > 0) return krc;
    return parseLrc(raw);
  }

  /**
   * 按模式投影单行歌词：
   *   original   -> 只保留 text
   *   translation-> 只保留 translation
   *   both       -> 同时保留 text 与 translation
   */
  function projectLine(line, mode) {
    var m = normalizeMode(mode);
    var out = { index: line.index, start: line.start, duration: line.duration || 0 };
    if (m === 'original' || m === 'both') out.text = line.text || '';
    if (m === 'translation' || m === 'both') out.translation = line.translation || '';
    return out;
  }

  function projectLines(lines, mode) {
    var m = normalizeMode(mode);
    return (lines || []).map(function (line) { return projectLine(line, m); });
  }

  /** 返回当前时间所在的歌词行索引，-1 表示尚无当前行 */
  function findLineIndex(lines, timeMs) {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    var current = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].start <= timeMs) current = i;
      else break;
    }
    return current;
  }

  var api = {
    MODES: MODES,
    DEFAULT_MODE: DEFAULT_MODE,
    normalizeMode: normalizeMode,
    modeLabel: modeLabel,
    parse: parse,
    parseKrc: parseKrc,
    parseLrc: parseLrc,
    projectLine: projectLine,
    projectLines: projectLines,
    findLineIndex: findLineIndex
  };

  global.MoeKoeLyrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
