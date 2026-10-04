#!/usr/bin/env node
/**
 * 桥接页测试桩：在 Node 里以最小桩环境运行真实的 native-bridge.js，
 * 并把它的输出转发给真实的 bin/mpris-host（Python 本地程序）。
 *
 * 传输模式与显示配置（开关/透明度/位置/穿透）现在由弹窗直连本地程序写入，
 * 桥接页只搬运播放数据；因此这里也直接向本地程序发 mode / config / status-request。
 *
 * stdin（JSON Lines，测试进程驱动）：
 *   {"open":true}                  模拟 WebSocket 连接建立
 *   {"push":{"type":"lyrics",...}} 向桥接页推送 MoeKoe WS 消息
 *   {"setMode":"translation"}      模拟弹窗直连本地程序写模式
 *   {"setConfig":{...}}            模拟弹窗直连本地程序写显示配置
 *   {"toHost":{...}}               向本地程序直发任意消息
 *   {"status":true}                向本地程序请求合并状态
 *   {"quit":true}                  退出
 *
 * stdout（JSON Lines）：
 *   {"event":"ready"}
 *   {"event":"host-message","message":{...}}   本地程序返回的消息
 *   {"event":"status","status":{...}}          本地程序合并状态回执
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const HOST_PATH = path.join(__dirname, '..', 'bin', 'mpris-host');
const HOST_ID = 'mpris-host';

const hostListeners = [];
const hostWaiters = [];
let hostProcess = null;
let hostBuffer = '';

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function startHost() {
  if (hostProcess && hostProcess.exitCode === null) return true;
  hostProcess = spawn(HOST_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  hostProcess.stdout.setEncoding('utf8');
  hostProcess.stdout.on('data', (chunk) => {
    hostBuffer += chunk;
    const lines = hostBuffer.split('\n');
    hostBuffer = lines.pop();
    lines.forEach((line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        process.stderr.write('[harness] host stdout 非 JSON: ' + line + '\n');
        return;
      }
      emit({ event: 'host-message', message });
      hostListeners.forEach((listener) => listener({ hostId: HOST_ID, message }));
      hostWaiters.slice().forEach((waiter) => waiter(message));
    });
  });
  hostProcess.stderr.setEncoding('utf8');
  hostProcess.stderr.on('data', (chunk) => process.stderr.write('[host] ' + chunk));
  hostProcess.on('exit', () => {
    hostProcess = null;
  });
  hostProcess.on('error', (error) => {
    process.stderr.write('[harness] host 启动失败: ' + error.message + '\n');
    hostProcess = null;
  });
  return true;
}

function hostRunning() {
  return !!(hostProcess && hostProcess.exitCode === null);
}

/** 直接向本地程序发消息（等价弹窗的 electronAPI.nativeHost.send） */
function toHost(payload) {
  if (!hostRunning()) startHost();
  if (!hostRunning() || !hostProcess.stdin.writable) return false;
  hostProcess.stdin.write(JSON.stringify({ type: 'message', payload }) + '\n');
  return true;
}

/** 等一条指定类型的宿主消息（用于 status 回执） */
function waitHostMessage(type, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const waiter = (message) => {
      if (done || !message || message.type !== type) return;
      done = true;
      const idx = hostWaiters.indexOf(waiter);
      if (idx >= 0) hostWaiters.splice(idx, 1);
      resolve(message);
    };
    hostWaiters.push(waiter);
    setTimeout(() => {
      if (done) return;
      done = true;
      const idx = hostWaiters.indexOf(waiter);
      if (idx >= 0) hostWaiters.splice(idx, 1);
      resolve(null);
    }, timeout || 1500);
  });
}

/* ---------------- 桩：WebSocket ---------------- */

const sockets = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  emit(message) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
}

/* ---------------- 桩：Electron preload ---------------- */

global.window = globalThis;
window.electron = { platform: 'linux' };
window.electronAPI = {
  nativeHost: {
    getStatus: async (hostId) => ({
      success: true,
      host: {
        id: hostId,
        authorized: true,
        supported: true,
        valid: true,
        errors: [],
        running: hostRunning(),
        executablePath: HOST_PATH
      }
    }),
    send: async (hostId, payload) => {
      return { success: toHost(payload) };
    },
    onMessage: (listener) => {
      hostListeners.push(listener);
      return () => {};
    }
  }
};

global.MoeKoeLyrics = require('../lyrics-parser.js');
global.WebSocket = FakeWebSocket;

require('../native-bridge.js');

/* ---------------- 控制通道 ---------------- */

async function requestStatus() {
  const pending = waitHostMessage('status', 1500);
  toHost({ type: 'status-request' });
  const message = await pending;
  return (message && message.status) || null;
}

async function handle(line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    return;
  }

  if (command.quit) {
    if (hostProcess) {
      try {
        hostProcess.stdin.write('{"type":"message","payload":{"type":"shutdown"}}\n');
      } catch (error) { /* ignore */ }
      hostProcess.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (command.open) {
    sockets.forEach((socket) => socket.onopen && socket.onopen());
    emit({ event: 'ack', for: 'open' });
    return;
  }

  if (command.push) {
    sockets.forEach((socket) => socket.emit(command.push));
    emit({ event: 'ack', for: 'push' });
    return;
  }

  if (command.setMode) {
    toHost({ type: 'mode', mode: String(command.setMode) });
    emit({ event: 'ack', for: 'setMode', mode: command.setMode });
    return;
  }

  if (command.setConfig) {
    toHost(Object.assign({ type: 'config' }, command.setConfig));
    emit({ event: 'ack', for: 'setConfig' });
    return;
  }

  if (command.toHost) {
    toHost(command.toHost);
    emit({ event: 'ack', for: 'toHost' });
    return;
  }

  if (command.status) {
    const status = await requestStatus();
    emit({ event: 'status', status });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  handle(line);
});

emit({ event: 'ready' });
