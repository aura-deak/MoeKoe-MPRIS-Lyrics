/**
 * MoeKoe MPRIS 后台脚本。
 *
 * 实时状态查询由桥接页（native-bridge.html）直接应答，这里不注册任何
 * onMessage 监听，避免与桥接页竞争响应；仅记录插件生命周期便于排查。
 */
'use strict';

console.log('[moekoe-mpris] 扩展后台已加载');
