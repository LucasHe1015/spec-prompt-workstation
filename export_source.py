#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
"""Export an allowlisted source archive, never the working directory recursively."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import argparse
import json

ROOT = Path(__file__).resolve().parent
SOURCE_FILES = (
    "server.py",
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    # motion layer
    "public/motion.js",
    "public/motion-core.css",
    "public/motion-nav.css",
    "public/motion-panels.css",
    "public/motion-overlays.css",
    # theme layer
    "public/theme.js",
    "public/theme.css",
    "public/theme-dark.css",
    "public/theme-dark-states.css",
    "public/theme-dark-overlays.css",
    "启动SPEC.bat",
    "README.md",
    "MOTION_SPEC.md",
    # License texts are required when redistributing (GPL-3.0 §4/§5)
    "LICENSE",
    "NOTICE",
    ".gitignore",
    "export_source.py",
    "test_privacy.py",
)


def export_source() -> Path:
    output_dir = ROOT / "dist"
    if output_dir.is_symlink() or output_dir.resolve().parent != ROOT:
        raise ValueError("Export directory must be a real directory inside the project")
    output_dir.mkdir(exist_ok=True)
    # Exclusive creation avoids overwriting an existing export or following a symlink.
    from datetime import datetime
    name = "spec7-source-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".zip"
    target = output_dir / name
    checked = []
    for relative in SOURCE_FILES:
        source = ROOT / relative
        if source.resolve() != source.absolute() or not source.is_file():
            raise ValueError("Missing or linked source file in export allowlist")
        checked.append((source, relative))
    with ZipFile(target, "x", compression=ZIP_DEFLATED) as archive:
        for source, relative in checked:
            archive.write(source, relative)
        # The editable glossary can contain private custom terms. Do not export it.
        # The recipient can add their own entries; translation engines still work.
        archive.writestr("data/glossary.json", json.dumps({
            "meta": {"name": "tag glossary", "version": 1}, "entries": {}
        }, ensure_ascii=False, indent=2))
    return target


def main():
    parser = argparse.ArgumentParser(description="Export source without local private data")
    parser.parse_args()
    archive = export_source()
    print("Created dist/" + archive.name)
    print("Private data/config/screenshots/models excluded; exported glossary is empty.")


if __name__ == "__main__":
    main()
