#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""manifest.json 静态校验。

对照 MoeKoe Music 的 nativeHostManager / extensionManager 校验逻辑，
以及插件市场（MoeKoeMusic-Plugins）的审核规则。

运行：python3 tests/test_manifest.py
"""

import json
import os
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(ROOT, "manifest.json")

failures = []
warnings = []


def check(condition, message, warning=False):
    if condition:
        print("  ok   %s" % message)
        return
    print("  %s %s" % ("WARN" if warning else "FAIL", message))
    (warnings if warning else failures).append(message)


def version_tuple(value):
    return tuple(int(item) for item in str(value).split("."))


def is_relative_plugin_path(value):
    if not value or not isinstance(value, str):
        return False
    normalized = value.replace("\\", "/")
    return not (
        value.startswith("/")
        or value.startswith("../")
        or normalized.startswith("/")
        or normalized == ".."
        or (len(value) >= 2 and value[1] == ":")
    )


def main():
    print("\n[基础字段]")
    with open(MANIFEST, encoding="utf-8") as handle:
        manifest = json.load(handle)

    check(manifest.get("manifest_version") == 3, "manifest_version = 3")
    check(bool(manifest.get("name")), "name 非空")
    check(bool(manifest.get("version")), "version 非空")
    check(bool(manifest.get("description")), "description 非空")
    check(bool(manifest.get("plugin_id")), "plugin_id 非空（市场审核必需）")
    check(manifest.get("moekoe") is True, "moekoe = true（市场审核必需）")
    check(bool(manifest.get("author", {}).get("name")), "author.name 非空")
    check(len(manifest.get("description", "")) <= 500, "description 长度合理")

    print("\n[Native Host 权限]")
    permissions = set(manifest.get("permissions") or [])
    moekoe_permissions = set(manifest.get("moekoe_permissions") or [])
    has_permission = "moekoe:nativeHost" in permissions or "moekoe:nativeHost" in moekoe_permissions
    check(has_permission, "声明 moekoe:nativeHost 权限")
    minversion = manifest.get("minversion")
    check(
        minversion is not None and version_tuple(minversion) >= (1, 6, 6),
        "minversion >= 1.6.6（使用 native host 的硬性要求，当前 %s）" % minversion,
    )

    hosts = manifest.get("moekoe_native_hosts")
    check(isinstance(hosts, list) and hosts, "moekoe_native_hosts 是数组")
    if not isinstance(hosts, list):
        return 1

    print("\n[本地程序声明]")
    for host in hosts:
        host_id = host.get("id")
        check(isinstance(host_id, str) and host_id.strip(), "host id 非空")

        platforms = host.get("platforms")
        check(
            isinstance(platforms, dict) and platforms,
            "%s: platforms 是非空对象" % host_id,
        )
        if not isinstance(platforms, dict):
            continue

        for platform, config in platforms.items():
            check(
                platform in ("win32", "darwin", "linux"),
                "%s: 平台 %s 合法" % (host_id, platform),
            )
            path = config.get("path")
            check(
                isinstance(path, str) and path.strip(),
                "%s/%s: path 非空" % (host_id, platform),
            )
            check(
                is_relative_plugin_path(path),
                "%s/%s: path 位于插件目录内（相对路径且不含 ..）" % (host_id, platform),
            )
            if platform == "win32":
                check(
                    str(path).lower().endswith(".exe"),
                    "%s/win32: path 以 .exe 结尾" % host_id,
                )
            args = config.get("args")
            check(
                args is None or (isinstance(args, list) and all(isinstance(a, str) for a in args)),
                "%s/%s: args 是字符串数组" % (host_id, platform),
            )

            full = os.path.join(ROOT, path)
            check(os.path.isfile(full), "%s/%s: 文件存在 %s" % (host_id, platform, path))

        bridge = host.get("bridge")
        if bridge is not None:
            check(is_relative_plugin_path(bridge), "%s: bridge 位于插件目录内" % host_id)
            check(os.path.isfile(os.path.join(ROOT, bridge)), "%s: bridge 文件存在" % host_id)

        check(host.get("auto_start") is True, "%s: auto_start = true（授权后自动启动）" % host_id)

    print("\n[Linux 可执行权限]")
    for host in hosts:
        linux = (host.get("platforms") or {}).get("linux") or {}
        path = linux.get("path")
        if not path:
            continue
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            continue
        executable = os.stat(full).st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        check(bool(executable), "%s 已设置可执行位" % path)
        with open(full, encoding="utf-8") as handle:
            first_line = handle.readline().strip()
        check(
            first_line.startswith("#!") and "python" in first_line,
            "%s 带 python shebang" % path,
        )

    print("\n[入口文件]")
    check(os.path.isfile(os.path.join(ROOT, "popup.html")), "popup.html 存在")
    check(os.path.isfile(os.path.join(ROOT, "popup.js")), "popup.js 存在")
    check(os.path.isfile(os.path.join(ROOT, "background.js")), "background.js 存在")
    check(os.path.isfile(os.path.join(ROOT, "native-bridge.html")), "native-bridge.html 存在")
    check(os.path.isfile(os.path.join(ROOT, "native-bridge.js")), "native-bridge.js 存在")
    check(os.path.isfile(os.path.join(ROOT, "lyrics-parser.js")), "lyrics-parser.js 存在")

    for icon in (manifest.get("icons") or {}).values():
        check(os.path.isfile(os.path.join(ROOT, icon)), "图标存在 %s" % icon)

    print()
    for item in warnings:
        print("警告: %s" % item)
    if failures:
        print("FAILED: %d 项未通过" % len(failures))
        for item in failures:
            print("  - %s" % item)
        return 1
    print("ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
