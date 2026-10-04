#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包插件 zip（安装包内不含开发用的测试与脚本）。

运行：python3 scripts/pack.py
输出：dist/moekoe-mpris-<version>.zip，顶层目录为 moekoe-mpris/
"""

import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAME = os.path.basename(ROOT)

EXCLUDE_DIRS = {"tests", "scripts", "dist", "assets", "__pycache__", ".git", ".github"}
EXCLUDE_FILES = {".gitignore"}


def main():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as handle:
        version = json.load(handle).get("version", "0.0.0")

    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "%s-%s.zip" % (NAME, version))

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as bundle:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [item for item in dirnames if item not in EXCLUDE_DIRS]
            for filename in filenames:
                if filename in EXCLUDE_FILES or filename.endswith(".pyc"):
                    continue
                full = os.path.join(dirpath, filename)
                relative = os.path.relpath(full, ROOT)
                bundle.write(full, "%s/%s" % (NAME, relative))

    print("已生成 %s" % out_path)
    with zipfile.ZipFile(out_path) as bundle:
        for item in sorted(bundle.namelist()):
            print("  " + item)
    print(
        "\n提醒：MoeKoe 解压 zip 时不保留可执行位，安装后需要执行\n"
        "  chmod +x <插件目录>/bin/mpris-host\n"
        "（插件弹窗会给出确切路径）。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
