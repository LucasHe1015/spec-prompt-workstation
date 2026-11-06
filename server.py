#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
"""S.P.E.C. 7 // STATION FOR PROMPT EDITING & COMPOSITION — local server (Python standard library only).

Serves the static console from ./public and exposes a small JSON API:
  GET  /api/health        engine status / auto-resolution
  GET  /api/config        current configuration (API keys masked)
  POST /api/config        save configuration
  GET  /api/models        model list for ollama / openai-compatible
  GET  /api/glossary      en -> zh tag glossary
  POST /api/glossary      save glossary entries
  POST /api/translate     translate parsed prompt blocks
  POST /api/unload        unload the Ollama model (free VRAM)
  GET  /api/history       list translation history (max 10)
  POST /api/history       append a history record
  POST /api/history/star  move a history record to favorites
  POST /api/history/delete delete a history record
  GET  /api/favorite      list favorite records
  POST /api/favorite      add a favorite record directly
  POST /api/favorite/save update an existing favorite record
  POST /api/favorite/rename rename a favorite record
  POST /api/favorite/example upload a favorite example image
  POST /api/favorite/example/delete remove a favorite example image
  GET  /api/favorite/example/<id> serve a favorite example image
  POST /api/favorite/delete delete a favorite record
  GET  /api/hardware      local CPU / RAM / GPU / VRAM usage
  GET  /api/characters    list saved character cards
  POST /api/characters    create or update a character card
  POST /api/characters/delete delete a character card
  POST /api/characters/order reorder character cards
  GET  /api/character/portrait/<id> serve a character portrait
  GET  /api/presets       list saved preset tag groups
  POST /api/presets       save a preset tag group
  POST /api/presets/rename rename a preset
  POST /api/presets/delete delete a preset
  GET  /api/wardrobe      list fixed clothing outfits
  POST /api/wardrobe      create or update a wardrobe outfit
  POST /api/wardrobe/order reorder wardrobe outfits
  POST /api/wardrobe/delete delete a wardrobe outfit
  GET  /api/wardrobe/image/<id> serve a wardrobe preview image
  GET  /api/gallery       list gallery works
  POST /api/gallery       create a gallery work
  POST /api/gallery/update update a gallery work
  POST /api/gallery/delete delete a gallery work
  POST /api/gallery/order reorder gallery works
  GET  /api/gallery/image/<id> serve a gallery preview image

Engine support: Ollama, OpenAI-compatible (LM Studio / vLLM / DeepSeek ...),
LibreTranslate.  The Chrome built-in translator and the offline glossary run
in the browser and never reach this server.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlsplit

# ---------------------------------------------------------------------------- #
# runtime roots
#
# Source mode (python server.py): ROOT is the folder holding server.py.
# Frozen mode (SPEC7.exe built with PyInstaller): ROOT is the folder holding the
# exe, so config.json / data / user_data stay next to the executable and survive
# restarts, while read-only assets (public/, data/glossary.json) fall back to the
# bundled payload in sys._MEIPASS when they are not found beside the exe.
# ---------------------------------------------------------------------------- #
FROZEN_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None
_PACKED_DIR = Path(sys._MEIPASS) if getattr(sys, "_MEIPASS", None) else None  # type: ignore[attr-defined]

ROOT = FROZEN_DIR or Path(__file__).resolve().parent

if FROZEN_DIR is not None:
    # An onedir build may sit in its own subfolder (SPEC7\SPEC7.exe). A one-line
    # spec7-home.txt next to the exe (".." or an absolute path) points the station
    # back at the project root so config.json / data / user_data keep living in the
    # source tree instead of beside the launcher.
    _hint_file = FROZEN_DIR / "spec7-home.txt"
    if _hint_file.is_file():
        try:
            _hint_text = _hint_file.read_text(encoding="utf-8").strip()
        except OSError:
            _hint_text = ""
        if _hint_text:
            _hint_path = Path(_hint_text)
            if not _hint_path.is_absolute():
                _hint_path = FROZEN_DIR / _hint_path
            if _hint_path.exists():
                ROOT = _hint_path.resolve()


def _resolve_asset(name: str) -> Path:
    """Prefer <exe dir>/<name> so users can hot-edit front-end files; else use the bundled copy.

    The returned path is always resolved: Handler._serve_static() compares it with
    Path.resolve() candidates via relative_to(), so a non-canonical prefix
    (sys._MEIPASS keeps the original case/short-name form) would raise 403.
    """
    local = ROOT / name
    if FROZEN_DIR is None:
        return local.resolve()
    if local.exists():
        return local.resolve()
    if _PACKED_DIR is not None:
        packed = _PACKED_DIR / name
        if packed.exists():
            return packed.resolve()
    return local.resolve()


PUBLIC = _resolve_asset("public")
DATA = ROOT / "data"
if FROZEN_DIR is not None:
    # seed the editable glossary beside the exe on first run, so save_glossary()
    # never writes into the temporary extraction folder
    DATA.mkdir(parents=True, exist_ok=True)
    _packed_glossary = (_PACKED_DIR / "data" / "glossary.json") if _PACKED_DIR else None
    if _packed_glossary is not None and _packed_glossary.is_file():
        _local_glossary = DATA / "glossary.json"
        if not _local_glossary.exists():
            try:
                shutil.copy2(_packed_glossary, _local_glossary)
            except OSError:
                pass
USER_DATA_DIR = ROOT / "user_data"
CONFIG_PATH = ROOT / "config.json"
HISTORY_DIR = USER_DATA_DIR / "history"
FAVORITE_DIR = USER_DATA_DIR / "favorite"
FAVORITE_EXAMPLE_DIR = FAVORITE_DIR / "example"
CHARACTER_DIR = USER_DATA_DIR / "character"
CHARACTER_PORTRAIT_DIR = CHARACTER_DIR / "portrait"
CHARACTER_ORDER_PATH = CHARACTER_DIR / "order.json"
GROUP_DIR = USER_DATA_DIR / "group"
GROUP_DIR.mkdir(parents=True, exist_ok=True)
WARDROBE_DIR = USER_DATA_DIR / "wardrobe"
WARDROBE_DIR.mkdir(parents=True, exist_ok=True)
WARDROBE_IMAGE_DIR = WARDROBE_DIR / "preview"
WARDROBE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
WARDROBE_ORDER_PATH = WARDROBE_DIR / "order.json"
_LEGACY_WARDROBE_ORDER_PATH = USER_DATA_DIR / "wardrobe_order.json"
GALLERY_DIR = USER_DATA_DIR / "gallery"
GALLERY_DIR.mkdir(parents=True, exist_ok=True)
GALLERY_ORDER_FILE = GALLERY_DIR / "order.json"
USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_DIR.mkdir(parents=True, exist_ok=True)
FAVORITE_DIR.mkdir(parents=True, exist_ok=True)
FAVORITE_EXAMPLE_DIR.mkdir(parents=True, exist_ok=True)
CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
CHARACTER_PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
if _LEGACY_WARDROBE_ORDER_PATH.exists() and not WARDROBE_ORDER_PATH.exists():
    try:
        os.replace(_LEGACY_WARDROBE_ORDER_PATH, WARDROBE_ORDER_PATH)
    except OSError:
        pass
HISTORY_LIMIT = 25
VERSION = "0.1.0"
DEFAULT_PORT = 8765

ALLOWED_ENGINES = {"auto", "chrome", "ollama", "openai", "libretranslate", "glossary"}

DEFAULT_CONFIG = {
    "engine": "auto",
    "ollama": {"baseUrl": "http://127.0.0.1:11434", "model": ""},
    "openai": {"baseUrl": "http://127.0.0.1:1234/v1", "model": "", "apiKey": ""},
    "libretranslate": {"baseUrl": "http://127.0.0.1:5000", "apiKey": ""},
    "options": {"useGlossary": True},
}

_config_lock = threading.Lock()
_cache_lock = threading.Lock()
_records_lock = threading.Lock()
_hardware_lock = threading.Lock()
_translation_lock = threading.Lock()
_translation_cancels: set[threading.Event] = set()
_undo_lock = threading.Lock()
_undo_store: dict[str, dict] = {}
_undo_order: list[str] = []
UNDO_LIMIT = 12
_cpu_prev = None
_translate_cache: dict[str, str] = {}
RECORD_ID_RE = re.compile(r"^\d{13}-[0-9a-f]{6}$")
CHARACTER_ID_RE = re.compile(r"^\d{13}-[0-9a-f]{6}$")
PRESET_ID_RE = re.compile(r"^\d{13}-[0-9a-f]{6}$")
WARDROBE_ID_RE = re.compile(r"^\d{13}-[0-9a-f]{6}$")
GALLERY_ID_RE = re.compile(r"^\d{13}-[0-9a-f]{6}$")


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #
def _merge_config(base: dict, override: dict) -> dict:
    out = json.loads(json.dumps(base))
    if not isinstance(override, dict):
        return out
    if override.get("engine") in ALLOWED_ENGINES:
        out["engine"] = override["engine"]
    for section in ("ollama", "openai", "libretranslate", "options"):
        if isinstance(override.get(section), dict):
            for key, value in override[section].items():
                if key in out[section] and isinstance(value, (str, bool)):
                    out[section][key] = value
    return out


def _base_url(section) -> str:
    return str((section or {}).get("baseUrl") or "").strip().rstrip("/")


def _keep_stored_key(current_section: dict, incoming_section: dict) -> bool:
    """Reuse a stored key only while the endpoint stays the same."""
    if not isinstance(incoming_section, dict) or incoming_section.get("apiKey"):
        return False
    if "baseUrl" not in incoming_section:
        return True
    return _base_url(current_section) == _base_url(incoming_section)


def load_config() -> dict:
    with _config_lock:
        if CONFIG_PATH.exists():
            try:
                stored = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                return _merge_config(DEFAULT_CONFIG, stored)
            except (OSError, ValueError):
                pass
        return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(incoming: dict) -> dict:
    with _config_lock:
        current = json.loads(json.dumps(DEFAULT_CONFIG))
        if CONFIG_PATH.exists():
            try:
                current = _merge_config(DEFAULT_CONFIG, json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                pass
        merged = _merge_config(current, incoming)
        if isinstance(incoming, dict):
            for section in ("openai", "libretranslate"):
                incoming_section = incoming.get(section)
                if not isinstance(incoming_section, dict):
                    continue
                if _keep_stored_key(current[section], incoming_section):
                    merged[section]["apiKey"] = current[section]["apiKey"]
                elif not incoming_section.get("apiKey"):
                    # The endpoint changed; never forward the old key to it.
                    merged[section]["apiKey"] = ""
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)
        return merged


def redacted_config(cfg: dict) -> dict:
    out = json.loads(json.dumps(cfg))
    key = out["openai"].get("apiKey", "")
    out["openai"]["apiKey"] = ""
    out["openai"]["hasApiKey"] = bool(key)
    out["libretranslate"]["hasApiKey"] = bool(out["libretranslate"].get("apiKey", ""))
    out["libretranslate"]["apiKey"] = ""
    return out


# --------------------------------------------------------------------------- #
# translation cancellation
# --------------------------------------------------------------------------- #
def _begin_translation_cancel() -> threading.Event:
    event = threading.Event()
    with _translation_lock:
        _translation_cancels.add(event)
    return event


def _end_translation_cancel(event: threading.Event) -> None:
    with _translation_lock:
        _translation_cancels.discard(event)


def cancel_active_translations() -> int:
    with _translation_lock:
        events = list(_translation_cancels)
    for event in events:
        event.set()
    return len(events)


# --------------------------------------------------------------------------- #
# in-memory undo snapshots for destructive UI actions
# --------------------------------------------------------------------------- #
def _undo_snapshot(**value) -> str:
    token = uuid.uuid4().hex
    with _undo_lock:
        _undo_store[token] = value
        _undo_order.append(token)
        while len(_undo_order) > UNDO_LIMIT:
            old = _undo_order.pop(0)
            _undo_store.pop(old, None)
    return token


def _undo_drop(token: str) -> None:
    if not token:
        return
    with _undo_lock:
        _undo_store.pop(token, None)
    try:
        _undo_order.remove(token)
    except ValueError:
        pass


def _file_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _write_bytes(path: Path, body: bytes | None) -> None:
    if body is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".undo.tmp")
    tmp.write_bytes(body)
    os.replace(tmp, path)


def restore_deleted(token: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
        raise BadRequest(400, "BAD_UNDO_TOKEN", "invalid undo token")
    with _undo_lock:
        snapshot = _undo_store.pop(token, None)
        try:
            _undo_order.remove(token)
        except ValueError:
            pass
    if snapshot is None:
        raise BadRequest(410, "UNDO_EXPIRED", "undo snapshot is no longer available")
    with _records_lock:
        kind = snapshot["kind"]
        ident = snapshot["id"]
        if kind in ("history", "favorite"):
            folder = _record_folder(kind)
            _write_bytes(folder / (ident + ".json"), snapshot.get("record"))
            if snapshot.get("exampleName"):
                FAVORITE_EXAMPLE_DIR.mkdir(parents=True, exist_ok=True)
                _write_bytes(FAVORITE_EXAMPLE_DIR / snapshot["exampleName"], snapshot.get("example"))
        elif kind == "character":
            CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
            _write_bytes(CHARACTER_DIR / (ident + ".json"), snapshot.get("card"))
            if snapshot.get("portraitName"):
                CHARACTER_PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
                _write_bytes(CHARACTER_PORTRAIT_DIR / snapshot["portraitName"], snapshot.get("portrait"))
            if isinstance(snapshot.get("order"), list):
                _write_character_order(snapshot["order"])
        elif kind == "preset":
            GROUP_DIR.mkdir(parents=True, exist_ok=True)
            _write_bytes(GROUP_DIR / (ident + ".json"), snapshot.get("preset"))
        elif kind == "wardrobe":
            WARDROBE_DIR.mkdir(parents=True, exist_ok=True)
            _write_bytes(WARDROBE_DIR / (ident + ".json"), snapshot.get("outfit"))
            if snapshot.get("imageName"):
                WARDROBE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
                _write_bytes(WARDROBE_IMAGE_DIR / snapshot["imageName"], snapshot.get("image"))
            if snapshot.get("orderBytes") is not None:
                _write_bytes(WARDROBE_ORDER_PATH, snapshot["orderBytes"])
        elif kind == "gallery":
            folder = GALLERY_DIR / ident
            for name, body in (snapshot.get("files") or {}).items():
                _write_bytes(folder / name, body)
            if snapshot.get("orderBytes") is not None:
                _write_bytes(GALLERY_ORDER_FILE, snapshot["orderBytes"])
        else:
            raise BadRequest(500, "BAD_UNDO_SNAPSHOT", "unknown undo snapshot")
    return {"kind": kind, "id": ident}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
class EngineError(Exception):
    def __init__(self, message: str, hint: str = "", code: str = "ENGINE_ERROR"):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code


class BadRequest(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# --------------------------------------------------------------------------- #
# local hardware telemetry (Windows native counters + nvidia-smi)
# --------------------------------------------------------------------------- #
class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_ulong),
        ("dwHighDateTime", ctypes.c_ulong),
    ]


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _filetime_value(value: _FILETIME) -> int:
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)


def _system_times():
    if os.name != "nt":
        return None
    idle = _FILETIME()
    kernel = _FILETIME()
    user = _FILETIME()
    ok = ctypes.windll.kernel32.GetSystemTimes(
        ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
    if not ok:
        return None
    return (_filetime_value(idle), _filetime_value(kernel), _filetime_value(user))


def _cpu_usage():
    global _cpu_prev
    if os.name != "nt":
        return None
    with _hardware_lock:
        current = _system_times()
        if current is None:
            return None
        if _cpu_prev is None:
            _cpu_prev = current
            time.sleep(0.12)
            current = _system_times()
            if current is None:
                return None
        idle0, kernel0, user0 = _cpu_prev
        idle1, kernel1, user1 = current
        _cpu_prev = current
        total = (kernel1 - kernel0) + (user1 - user0)
        if total <= 0:
            return None
        idle = idle1 - idle0
        return max(0.0, min(100.0, 100.0 * (1.0 - idle / total)))


def _ram_stats():
    if os.name != "nt":
        return None
    status = _MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    total = int(status.ullTotalPhys)
    avail = int(status.ullAvailPhys)
    return {
        "pct": float(status.dwMemoryLoad),
        "used": max(0, total - avail),
        "total": total,
    }


def _gpu_stats():
    exe = shutil.which("nvidia-smi")
    if not exe and os.name == "nt":
        candidate = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        if candidate.exists():
            exe = str(candidate)
    if not exe:
        return None
    try:
        completed = subprocess.run(
            [exe, "--query-gpu=utilization.gpu,memory.used,memory.total,name",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3.0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    line = next((item for item in completed.stdout.splitlines() if item.strip()), "")
    parts = [part.strip() for part in line.split(",", 3)]
    if len(parts) < 4:
        return None

    def number(text):
        try:
            return float(text)
        except ValueError:
            return None

    usage = number(parts[0])
    used = number(parts[1])
    total = number(parts[2])
    if used is None or total is None or total <= 0:
        return None
    return {
        "gpu": max(0.0, min(100.0, usage)) if usage is not None else None,
        "vram": max(0.0, min(100.0, used / total * 100.0)),
        "vramUsed": used,
        "vramTotal": total,
        "name": parts[3],
    }


def hardware_payload() -> dict:
    cpu = _cpu_usage()
    ram = _ram_stats()
    gpu = _gpu_stats()
    return {
        "ok": True,
        "cpu": round(cpu, 1) if cpu is not None else None,
        "ram": round(ram["pct"], 1) if ram else None,
        "ramUsed": ram["used"] if ram else None,
        "ramTotal": ram["total"] if ram else None,
        "gpu": round(gpu["gpu"], 1) if gpu and gpu["gpu"] is not None else None,
        "gpuName": gpu["name"] if gpu else "",
        "vram": round(gpu["vram"], 1) if gpu else None,
        "vramUsed": gpu["vramUsed"] if gpu else None,
        "vramTotal": gpu["vramTotal"] if gpu else None,
        "gpuAvailable": bool(gpu),
        "at": int(time.time()),
    }


def merged_draft_config(cfg: dict, draft) -> dict:
    """Merge an unsaved settings draft for probing, keeping stored secrets only
    when the endpoint has not changed."""
    if not isinstance(draft, dict):
        return cfg
    merged = _merge_config(cfg, draft)
    for section in ("openai", "libretranslate"):
        incoming = draft.get(section)
        if not isinstance(incoming, dict):
            continue
        if _keep_stored_key(cfg[section], incoming):
            merged[section]["apiKey"] = cfg[section]["apiKey"]
        elif not incoming.get("apiKey"):
            merged[section]["apiKey"] = ""
    return merged


class _PrivateRedirectHandler(urlrequest.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        def origin(url):
            parsed = urlsplit(url)
            port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
            return parsed.scheme.lower(), parsed.hostname, port

        if origin(req.full_url) != origin(newurl):
            raise EngineError("已阻止翻译接口跨站重定向。",
                              "请直接配置可信服务的最终地址，避免向其他站点转发密钥或提示词。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_http_opener = urlrequest.build_opener(_PrivateRedirectHandler())


def http_json(url: str, method: str = "GET", payload=None, headers: dict | None = None,
              timeout: float = 120.0):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with _http_opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return json.loads(body) if body.strip() else {}
    except urlerror.HTTPError as exc:
        # Upstream bodies and URLs may echo prompts, credentials or local paths.
        exc.close()
        raise EngineError(f"HTTP {exc.code}: 翻译服务请求失败。",
                          "请检查引擎连接、模型名称及密钥；为保护隐私，不显示上游原始报错。") from None
    except urlerror.URLError:
        raise EngineError("无法连接翻译服务。", "请检查引擎地址及服务运行状态。") from None
    except TimeoutError:
        raise EngineError("翻译服务响应超时。", "请稍后重试或检查模型运行状态。") from None
    except (ValueError, HTTPException, OSError):
        raise EngineError("翻译服务返回无效响应或连接中断。",
                          "请检查接口兼容性和服务运行状态。") from None


def normalize_base(url: str) -> str:
    return (url or "").strip().rstrip("/")


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}
# 本机引擎应当秒回；探测超时压短，端口被防火墙丢包时也能快速判离线
LOOPBACK_PROBE_TIMEOUT = 0.6
HEALTH_CACHE_TTL = 4.0


def is_loopback_url(url: str) -> bool:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return host in LOOPBACK_HOSTS


def probe_timeout(url: str, remote_default: float, fast: bool) -> float:
    if fast and is_loopback_url(url):
        return LOOPBACK_PROBE_TIMEOUT
    return remote_default


def unload_ollama_model(cfg: dict, model: str) -> None:
    """Ask Ollama to unload a model immediately (keep_alive=0)."""
    base = normalize_base(cfg["ollama"]["baseUrl"])
    if not base:
        raise EngineError("Ollama 地址未配置", "请在引擎舱填写 Ollama 地址。", "NO_OLLAMA")
    payload = {"model": model, "prompt": "", "stream": False, "keep_alive": 0}
    http_json(base + "/api/generate", method="POST", payload=payload, timeout=30.0)


# --------------------------------------------------------------------------- #
# engine probes / resolution
# --------------------------------------------------------------------------- #
def probe_ollama(cfg: dict, timeout: float = 1.4) -> dict:
    base = normalize_base(cfg["ollama"]["baseUrl"])
    if not base:
        return {"reachable": False, "models": [], "error": "not configured"}
    try:
        data = http_json(base + "/api/tags", timeout=timeout)
    except EngineError as exc:
        return {"reachable": False, "models": [], "error": exc.message}
    models = [m.get("name", "") for m in data.get("models", []) if m.get("name")]
    usable = [m for m in models if "embed" not in m.lower()]
    return {"reachable": True, "models": usable, "error": ""}


def probe_openai(cfg: dict, timeout: float = 1.6) -> dict:
    section = cfg["openai"]
    base = normalize_base(section["baseUrl"])
    if not base:
        return {"reachable": False, "models": [], "configured": False, "error": "not configured"}
    headers = {}
    if section.get("apiKey"):
        headers["Authorization"] = "Bearer " + section["apiKey"]
    try:
        data = http_json(base + "/models", headers=headers, timeout=timeout)
        models = [m.get("id", "") for m in data.get("data", []) if m.get("id")]
        return {"reachable": True, "models": models, "configured": True, "error": ""}
    except EngineError as exc:
        message = exc.message
        # an HTTP error still proves the endpoint is alive
        reachable = message.startswith("HTTP ")
        return {"reachable": reachable, "models": [], "configured": True,
                "error": "" if reachable else message}


def probe_libretranslate(cfg: dict, timeout: float = 1.4) -> dict:
    base = normalize_base(cfg["libretranslate"]["baseUrl"])
    if not base:
        return {"reachable": False, "error": "not configured"}
    try:
        http_json(base + "/languages", timeout=timeout)
        return {"reachable": True, "error": ""}
    except EngineError as exc:
        return {"reachable": False, "error": exc.message}


def _run_probes(cfg: dict, fast: bool) -> dict:
    targets = (
        ("ollama", probe_ollama, cfg["ollama"]["baseUrl"], 1.4),
        ("openai", probe_openai, cfg["openai"]["baseUrl"], 1.6),
        ("libretranslate", probe_libretranslate, cfg["libretranslate"]["baseUrl"], 1.4),
    )
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            name: pool.submit(probe, cfg, probe_timeout(base, remote, fast))
            for name, probe, base, remote in targets
        }
        return {name: future.result() for name, future in futures.items()}


_HEALTH_CACHE: dict = {"key": None, "at": 0.0, "probes": None}
_HEALTH_CACHE_LOCK = threading.Lock()
_HEALTH_PROBE_LOCK = threading.Lock()   # 单飞：同一时刻只让一个线程真正去探测


def _probe_cache_key(cfg: dict) -> tuple:
    def field(section: str, name: str) -> str:
        return str((cfg.get(section) or {}).get(name) or "").strip()
    return (
        field("ollama", "baseUrl"), field("ollama", "model"),
        field("openai", "baseUrl"), field("openai", "model"),
        field("openai", "apiKey")[:8],
        field("libretranslate", "baseUrl"),
    )


def probe_all(cfg: dict, fast: bool = False, force: bool = False) -> dict:
    """Probe every engine in parallel.

    fast=True is the /api/health path: loopback engines get a short timeout and
    the result is cached for a few seconds with single-flight, so a polling
    console never waits on a hung port. Translation paths keep the long timeout
    and never read the cache.
    """
    if not fast:
        return _run_probes(cfg, fast=False)
    key = _probe_cache_key(cfg)
    now = time.monotonic()
    with _HEALTH_CACHE_LOCK:
        cached = _HEALTH_CACHE["probes"]
        if not force and cached is not None and _HEALTH_CACHE["key"] == key \
                and now - _HEALTH_CACHE["at"] < HEALTH_CACHE_TTL:
            return cached
        stale = cached if cached is not None and _HEALTH_CACHE["key"] == key else None
    if _HEALTH_PROBE_LOCK.acquire(blocking=False):
        try:
            probes = _run_probes(cfg, fast=True)
            with _HEALTH_CACHE_LOCK:
                _HEALTH_CACHE["key"] = key
                _HEALTH_CACHE["at"] = time.monotonic()
                _HEALTH_CACHE["probes"] = probes
            return probes
        finally:
            _HEALTH_PROBE_LOCK.release()
    if stale is not None:
        return stale      # 旧结果先顶上，正在飞的那次探测稍后刷新缓存
    if _HEALTH_PROBE_LOCK.acquire(timeout=3.0):
        _HEALTH_PROBE_LOCK.release()
        with _HEALTH_CACHE_LOCK:
            if _HEALTH_CACHE["probes"] is not None and _HEALTH_CACHE["key"] == key:
                return _HEALTH_CACHE["probes"]
    return _run_probes(cfg, fast=True)



def pick_ollama_model(cfg: dict, models: list[str]) -> str | None:
    configured = (cfg["ollama"].get("model") or "").strip()
    if configured:
        for model in models:
            if model == configured or model.split(":")[0] == configured:
                return model
        return None
    return models[0] if models else None


def resolve_engine(cfg: dict, probes: dict | None = None) -> tuple[str, str] | None:
    """Return (engine, model) for the configured engine, or None when auto finds nothing."""
    requested = cfg.get("engine", "auto")
    probes = probes if probes is not None else probe_all(cfg)
    if requested == "auto":
        ollama = probes["ollama"]
        if ollama.get("reachable"):
            model = pick_ollama_model(cfg, ollama.get("models", []))
            if model:
                return "ollama", model
        openai = probes["openai"]
        if openai.get("reachable") and (cfg["openai"].get("model") or "").strip():
            return "openai", cfg["openai"]["model"].strip()
        if probes["libretranslate"].get("reachable"):
            return "libretranslate", ""
        return None
    if requested in ("chrome", "glossary"):
        return None
    if requested == "ollama":
        if not probes["ollama"].get("reachable"):
            raise EngineError("Ollama 未连接", "请先启动 Ollama（ollama serve），或在引擎舱中修改地址。", "OLLAMA_OFFLINE")
        model = pick_ollama_model(cfg, probes["ollama"].get("models", []))
        if not model:
            raise EngineError("Ollama 没有可用模型", "先执行 ollama pull qwen2.5:7b 之类拉取模型，或改用其他引擎。", "OLLAMA_NO_MODEL")
        return "ollama", model
    if requested == "openai":
        section = cfg["openai"]
        if not normalize_base(section["baseUrl"]) or not (section.get("model") or "").strip():
            raise EngineError("OpenAI 兼容引擎尚未配置", "填写 Base URL 与模型名（例如 LM Studio: http://127.0.0.1:1234/v1）。", "OPENAI_UNCONFIGURED")
        return "openai", section["model"].strip()
    if requested == "libretranslate":
        if not probes["libretranslate"].get("reachable"):
            raise EngineError("LibreTranslate 未连接", "启动 LibreTranslate 服务，或在引擎舱中修改地址。", "LIBRE_OFFLINE")
        return "libretranslate", ""
    raise EngineError(f"未知引擎: {requested}", "", "UNKNOWN_ENGINE")


def health_payload(cfg: dict, force: bool = False) -> dict:
    probes = probe_all(cfg, fast=True, force=force)
    resolved = None
    resolved_model = ""
    try:
        picked = resolve_engine(cfg, probes)
        if picked:
            resolved, resolved_model = picked
    except EngineError:
        resolved = None
    return {
        "ok": True,
        "version": VERSION,
        "engine": cfg.get("engine", "auto"),
        "resolved": resolved,
        "resolvedModel": resolved_model,
        "engines": probes,
        "chromeClient": cfg.get("engine") == "chrome",
        "glossary": cfg.get("options", {}).get("useGlossary", True),
    }


# --------------------------------------------------------------------------- #
# translation engines
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = (
    "You are a professional translation engine for anime image-generation prompts. "
    "Translate every item of the input JSON array into Simplified Chinese.\n"
    "Rules:\n"
    "- Keep the exact same order and the same number of items.\n"
    "- Each item is either a short Danbooru-style tag or one descriptive sentence.\n"
    "- Tags: translate concisely, using Danbooru-style Chinese wording "
    "(examples: solo -> 单人, looking at viewer -> 看向观者, cowboy shot -> 七分身构图).\n"
    "- Sentences: natural fluent Chinese; keep character names and proper nouns in Latin script.\n"
    "- Output ONLY a JSON array of strings. No numbering, no explanations, no extra prose."
)

SINGLE_PROMPT = (
    "Translate this English anime prompt fragment into Simplified Chinese. "
    "If it is a tag, use concise Danbooru-style wording. Keep proper nouns in Latin script. "
    "Output only the translated text, without quotes or explanation."
)

SYSTEM_PROMPT_ZH2EN = (
    "You are a professional translation engine for anime image-generation prompts. "
    "Translate every item of the input JSON array from Simplified Chinese into English.\n"
    "Rules:\n"
    "- Keep the exact same order and the same number of items.\n"
    "- Each item is either a short Danbooru-style tag or one descriptive sentence.\n"
    "- Tags: concise Danbooru-style English tag wording.\n"
    "- Sentences: natural fluent English; keep proper nouns in Latin script.\n"
    "- Output ONLY a JSON array of strings. No numbering, no explanations, no extra prose."
)

SINGLE_PROMPT_ZH2EN = (
    "Translate this Simplified Chinese anime prompt fragment into English. "
    "If it is a tag, use concise Danbooru-style tag wording; if it is a sentence, "
    "translate it naturally. Keep proper nouns in Latin script. "
    "Output only the English text, without quotes or explanation."
)

TAG_PROMPT_ZH2EN = (
    "Translate this Simplified Chinese image-prompt tag into exactly ONE English "
    "Danbooru-style tag phrase.\n"
    "Rules: lowercase; no commas; no article (a/an/the); no punctuation; keep it short (1-4 words).\n"
    "Output only the tag, without quotes or explanation.\n"
    "Examples: 明亮阳光 -> bright sunlight; 蓝色头发 -> blue hair; 单人 -> solo; 红色背心 -> red tank top."
)

TAG_PROMPT_EN2ZH = (
    "Translate this English image-prompt tag into exactly ONE concise Simplified Chinese tag phrase.\n"
    "Rules: no commas; no punctuation; keep it short.\n"
    "Output only the Chinese tag, without quotes or explanation.\n"
    "Examples: bright sunlight -> 明亮阳光; blue hair -> 蓝色头发; solo -> 单人; red tank top -> 红色背心."
)

FALLBACK_PROMPT_EN2ZH = (
    "Translate the following English anime image-prompt fragment into Simplified Chinese. "
    "Output only the Chinese translation, no English, no explanation."
)

FALLBACK_PROMPT_ZH2EN = (
    "Translate the following Chinese anime image-prompt fragment into English. "
    "Output only the English translation, no Chinese, no explanation."
)


def extract_json_array(raw: str):
    if not raw:
        return None
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return value
    return None


def llm_chat(engine: str, cfg: dict, model: str, messages: list[dict], timeout: float) -> str:
    if engine == "ollama":
        base = normalize_base(cfg["ollama"]["baseUrl"])
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0},
        }
        data = http_json(base + "/api/chat", method="POST", payload=payload, timeout=timeout)
        return (data.get("message") or {}).get("content", "")
    base = normalize_base(cfg["openai"]["baseUrl"])
    headers = {}
    if cfg["openai"].get("apiKey"):
        headers["Authorization"] = "Bearer " + cfg["openai"]["apiKey"]
    payload = {"model": model, "messages": messages, "temperature": 0, "stream": False}
    data = http_json(base + "/chat/completions", method="POST", payload=payload,
                     headers=headers, timeout=timeout)
    choices = data.get("choices") or []
    if not choices:
        raise EngineError("LLM 返回为空", "", "LLM_EMPTY")
    return ((choices[0].get("message") or {}).get("content") or "")


def ollama_messages(instruction: str, payload: str) -> list[dict]:
    """Imported GGUF models often have no chat template. Ollama then renders the
    system message as plain text, so the model just continues the prompt in the
    source language. Put the whole instruction in the user turn instead."""
    return [{"role": "user", "content": instruction + "\n\n" + payload}]


# --------------------------------------------------------------------------- #
# dedicated translation models (TranslateGemma / Hunyuan-MT / SEED-X / Tower)
# --------------------------------------------------------------------------- #
LANG_PAIR = {
    "en": ("English", "en"),
    "zh": ("Chinese", "zh"),
}


def translation_language_pair(direction: str):
    if direction == "zh2en":
        return LANG_PAIR["zh"], LANG_PAIR["en"]
    return LANG_PAIR["en"], LANG_PAIR["zh"]


def translation_only_prompt(text: str, direction: str = "en2zh") -> str:
    """Rebuild the TranslateGemma chat template ourselves.

    These models are pure text-in / text-out translators and carry their own
    instruction inside the chat template. Feeding them "our instruction + the
    payload" in a single user turn makes them translate the instruction too —
    that is what leaked the prompt into the output. Ollama's chat endpoint
    rejects the structured content array this template expects (HTTP 400), so
    the only reliable path is /api/generate with raw=true and a prompt we own.
    """
    (src_name, src_code), (tgt_name, tgt_code) = translation_language_pair(direction)
    return (
        "<start_of_turn>user\n"
        f"You are a professional {src_name} ({src_code}) to {tgt_name} ({tgt_code}) translator. "
        f"Your goal is to accurately convey the meaning and nuances of the original {src_name} text "
        f"while adhering to {tgt_name} grammar, vocabulary, and cultural sensitivities.\n"
        f"Produce only the {tgt_name} translation, without any additional explanations or commentary. "
        f"Please translate the following {src_name} text into {tgt_name}:\n\n\n" + text +
        "<end_of_turn>\n<start_of_turn>model\n"
    )


def ollama_generate(cfg: dict, model: str, prompt: str, timeout: float, raw: bool = True) -> str:
    base = normalize_base(cfg["ollama"]["baseUrl"])
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "raw": raw,
        "options": {"temperature": 0},
    }
    data = http_json(base + "/api/generate", method="POST", payload=payload, timeout=timeout)
    return data.get("response", "") or ""


ECHO_MARKERS = (
    "danbooru",
    "翻译成",
    "拉丁字母",
    "不包含引号",
    "仅输出",
    "output only",
    "without quotes",
    "translate this",
    "translate the following",
)


def looks_like_prompt_echo(source: str, output: str, direction: str = "en2zh") -> bool:
    """The model answered by translating our own instruction (prompt leak)."""
    src = (source or "").strip()
    out = (output or "").strip()
    if not out:
        return False
    low_src, low_out = src.lower(), out.lower()
    for marker in ECHO_MARKERS:
        if marker in low_out and marker not in low_src:
            return True
    # A short tag can never legitimately expand into a paragraph. Chinese packs
    # more meaning per character, so zh -> en output is allowed to be longer.
    limit = max(48, 8 * len(src)) if direction == "zh2en" else max(24, 4 * len(src))
    if len(src) <= 24 and len(out) > limit:
        return True
    return False


def llm_translate_batch(engine: str, cfg: dict, model: str, texts: list[str],
                        direction: str = "en2zh") -> list[str]:
    instruction = SYSTEM_PROMPT if direction == "en2zh" else SYSTEM_PROMPT_ZH2EN
    payload = json.dumps(texts, ensure_ascii=False)
    if engine == "ollama":
        messages = ollama_messages(instruction, payload)
    else:
        messages = [
            {"role": "system", "content": instruction},
            {"role": "user", "content": payload},
        ]
    raw = llm_chat(engine, cfg, model, messages, timeout=240.0)
    parsed = extract_json_array(raw)
    if parsed is None:
        raise EngineError("LLM 返回的不是合法 JSON 数组，已回退逐条翻译。", "", "LLM_BAD_JSON")
    if len(parsed) != len(texts):
        raise EngineError("LLM 返回条数与原文不一致，已回退逐条翻译。", "", "LLM_COUNT_MISMATCH")
    return [item.strip() for item in parsed]


def libretranslate_batch(cfg: dict, texts: list[str], direction: str = "en2zh") -> list[str]:
    base = normalize_base(cfg["libretranslate"]["baseUrl"])
    source, target = ("en", "zh") if direction == "en2zh" else ("zh", "en")
    payload = {"q": texts, "source": source, "target": target, "format": "text"}
    if cfg["libretranslate"].get("apiKey"):
        payload["api_key"] = cfg["libretranslate"]["apiKey"]
    data = http_json(base + "/translate", method="POST", payload=payload, timeout=120.0)
    translated = data.get("translatedText")
    if isinstance(translated, str):
        return [translated] if len(texts) == 1 else []
    if isinstance(translated, list) and len(translated) == len(texts):
        return [str(item) for item in translated]
    return []


def looks_untranslated(source: str, output: str, direction: str = "en2zh") -> bool:
    """Heuristic: dedicated MT models sometimes echo the source in batch mode."""
    src = (source or "").strip()
    out = (output or "").strip()
    if not out:
        return True
    if out.lower() == src.lower():
        return True
    if direction == "en2zh":
        if re.search(r"[A-Za-z]", src) and not re.search(r"[\u4e00-\u9fff]", out):
            return True
    else:
        if re.search(r"[\u4e00-\u9fff]", src) and not re.search(r"[A-Za-z]", out):
            return True
    return False


def is_translation_only_model(model: str) -> bool:
    name = (model or "").lower()
    markers = ("translategemma", "hy-mt", "hunyuan-mt", "hunyuan_mt", "seed-x", "tower")
    return any(marker in name for marker in markers)


def per_block_translate(engine: str, cfg: dict, model: str, texts: list[str],
                        direction: str = "en2zh", types: list[str] | None = None) -> list[str]:
    def instruction_for(index: int) -> str:
        kind = types[index] if types and index < len(types) else ""
        # The strict single-phrase prompt is only needed for zh -> en tag edits;
        # it makes en -> zh tags unreliable, so keep the proven generic prompt there.
        if kind == "tag" and direction == "zh2en":
            return TAG_PROMPT_ZH2EN
        return SINGLE_PROMPT if direction == "en2zh" else SINGLE_PROMPT_ZH2EN

    only_model = engine == "ollama" and is_translation_only_model(model)

    def call_model(instruction: str, text: str) -> str:
        if only_model:
            # Translation-dedicated models bring their own instruction inside the
            # chat template; never hand them ours, or they translate it as well.
            raw = ollama_generate(cfg, model, translation_only_prompt(text, direction), timeout=90.0)
        elif engine == "ollama":
            messages = ollama_messages(instruction, text)
            raw = llm_chat(engine, cfg, model, messages, timeout=90.0)
        else:
            messages = [
                {"role": "system", "content": instruction},
                {"role": "user", "content": text},
            ]
            raw = llm_chat(engine, cfg, model, messages, timeout=90.0)
        raw = raw.strip().strip('"').strip("“”").strip()
        if looks_like_prompt_echo(text, raw, direction):
            return ""
        return raw

    def one(text: str, instruction: str) -> str:
        raw = call_model(instruction, text)
        if looks_untranslated(text, raw, direction):
            fallback = FALLBACK_PROMPT_EN2ZH if direction == "en2zh" else FALLBACK_PROMPT_ZH2EN
            raw = call_model(fallback, text)
        if looks_untranslated(text, raw, direction):
            return ""
        return raw

    results = [""] * len(texts)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {index: pool.submit(one, text, instruction_for(index))
                   for index, text in enumerate(texts)}
        for index, future in futures.items():
            try:
                results[index] = future.result()
            except EngineError:
                results[index] = ""
    return results


def translate_texts(engine: str, cfg: dict, model: str, texts: list[str],
                    direction: str = "en2zh", types: list[str] | None = None) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    if not texts:
        return [], warnings
    if engine == "libretranslate":
        try:
            translated = libretranslate_batch(cfg, texts, direction)
            if len(translated) == len(texts):
                return translated, warnings
        except EngineError as exc:
            warnings.append(exc.message)
        # fall back to one request per block
        results = []
        for text in texts:
            try:
                part = libretranslate_batch(cfg, [text], direction)
                results.append(part[0] if part else "")
            except EngineError:
                results.append("")
        if any(results):
            warnings.append("批量接口不支持，已改为逐条翻译。")
            return results, warnings
        raise EngineError("LibreTranslate 翻译失败", "请检查 LibreTranslate 服务与语言支持。", "LIBRE_FAILED")

    # Dedicated translation models (TranslateGemma / Hunyuan-MT ...) do not
    # reliably follow a JSON-array batch prompt; translate each block instead.
    if is_translation_only_model(model):
        results = per_block_translate(engine, cfg, model, texts, direction, types)
        return results, warnings

    # A pure tag edit needs the tag-specific prompt (single lowercase phrase,
    # no comma). Batch prompts would otherwise return "Bright, sunny".
    if types and all(kind == "tag" for kind in types):
        results = per_block_translate(engine, cfg, model, texts, direction, types)
        return results, warnings

    try:
        translated = llm_translate_batch(engine, cfg, model, texts, direction)
    except EngineError as exc:
        warnings.append(exc.message)
    else:
        retry_indexes = [index for index, (source, output) in enumerate(zip(texts, translated))
                         if looks_untranslated(source, output, direction)
                         or looks_like_prompt_echo(source, output, direction)]
        if retry_indexes:
            retry_types = [types[index] for index in retry_indexes] if types else None
            retry_values = per_block_translate(engine, cfg, model,
                                               [texts[index] for index in retry_indexes],
                                               direction, retry_types)
            for index, value in zip(retry_indexes, retry_values):
                translated[index] = value
            warnings.append(f"批量结果有 {len(retry_indexes)} 条未翻译，已逐条补齐。")
        return translated, warnings

    results = per_block_translate(engine, cfg, model, texts, direction, types)
    if not any(results):
        raise EngineError("翻译引擎没有返回结果", "请确认模型可用，或在引擎舱中切换引擎。", "LLM_FAILED")
    warnings.append("已改用逐条翻译。")
    return results, warnings


# --------------------------------------------------------------------------- #
# glossary
# --------------------------------------------------------------------------- #
_glossary_cache: dict = {"mtime": 0.0, "entries": {}}
_glossary_lock = threading.Lock()


def load_glossary() -> dict:
    path = DATA / "glossary.json"
    with _glossary_lock:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return {}
        if mtime != _glossary_cache["mtime"]:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                entries = payload.get("entries", {}) if isinstance(payload, dict) else {}
                _glossary_cache["entries"] = {
                    str(k).strip().lower(): str(v).strip()
                    for k, v in entries.items()
                    if isinstance(k, str) and isinstance(v, str) and str(v).strip()
                }
                _glossary_cache["mtime"] = mtime
            except (OSError, ValueError):
                return _glossary_cache["entries"]
        return _glossary_cache["entries"]


def save_glossary(entries: dict) -> int:
    path = DATA / "glossary.json"
    payload = {}
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            payload = stored
    except (OSError, ValueError):
        payload = {}
    if not isinstance(payload.get("meta"), dict):
        payload["meta"] = {
            "name": "anime tag glossary",
            "version": 1,
            "note": "en -> zh-Hans, Danbooru-style prompt tags",
        }
    payload["entries"] = entries
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    with _glossary_lock:
        _glossary_cache["entries"] = entries
        _glossary_cache["mtime"] = 0.0
    return len(entries)


# --------------------------------------------------------------------------- #
# history / favorites
# --------------------------------------------------------------------------- #
def _record_folder(kind: str) -> Path:
    folder = HISTORY_DIR if kind == "history" else FAVORITE_DIR
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _read_record_file(path: Path) -> dict | None:
    # Records must be real files inside user_data, never links to other files.
    if path.resolve() != path.absolute() or not path.resolve().is_relative_to(USER_DATA_DIR.resolve()):
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    value.setdefault("id", path.stem)
    return value


def list_records(kind: str) -> list[dict]:
    folder = _record_folder(kind)
    records = []
    for path in folder.glob("*.json"):
        record = _read_record_file(path)
        if record is not None:
            records.append(record)
    records.sort(key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")),
                 reverse=True)
    if kind == "history":
        records = records[:HISTORY_LIMIT]
    return records


def _write_record_file(folder: Path, record: dict) -> None:
    if not RECORD_ID_RE.fullmatch(str(record.get("id") or "")):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    path = folder / (record["id"] + ".json")
    tmp = folder / (record["id"] + ".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _clean_record(payload) -> dict:
    if not isinstance(payload, dict):
        raise BadRequest(400, "BAD_RECORD", "record must be an object")
    text = str(payload.get("text") or "").strip()
    if not text:
        raise BadRequest(400, "EMPTY_RECORD", "record text is empty")
    if len(text) > 20000:
        raise BadRequest(400, "RECORD_TOO_LONG", "record text is too long")

    blocks = payload.get("blocks") if isinstance(payload.get("blocks"), dict) else {}
    clean_blocks = {"tags": [], "sentences": []}
    for key in ("tags", "sentences"):
        items = blocks.get(key, [])
        if not isinstance(items, list):
            raise BadRequest(400, "BAD_RECORD", f"{key} must be an array")
        if len(items) > 500:
            raise BadRequest(400, "RECORD_TOO_LONG", "too many blocks")
        for item in items:
            if not isinstance(item, dict):
                continue
            clean_blocks[key].append({
                "id": str(item.get("id") or "")[:40],
                "kind": "tag" if key == "tags" else "sentence",
                "text": str(item.get("text") or "")[:4000],
            })

    translations = payload.get("translations") if isinstance(payload.get("translations"), dict) else {}
    clean_translations = {}
    for bid, item in list(translations.items())[:1000]:
        if not isinstance(item, dict):
            continue
        clean_translations[str(bid)[:40]] = {
            "text": str(item.get("text") or "")[:4000],
            "from": str(item.get("from") or "")[:40],
        }

    record = {
        "title": str(payload.get("title") or "")[:120],
        "text": text,
        "translatedText": str(payload.get("translatedText") or "")[:20000],
        "blocks": clean_blocks,
        "translations": clean_translations,
        "lastEngine": str(payload.get("lastEngine") or "")[:120],
    }
    encoded = json.dumps(record, ensure_ascii=False).encode("utf-8")
    if len(encoded) > 1_000_000:
        raise BadRequest(400, "RECORD_TOO_LONG", "record is too large")
    return record


def create_history_record(payload) -> dict:
    record = _clean_record(payload)
    with _records_lock:
        folder = _record_folder("history")
        record["id"] = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        record["createdAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(folder, record)
        files = sorted(folder.glob("*.json"), key=lambda path: path.stem, reverse=True)
        for old in files[HISTORY_LIMIT:]:
            try:
                old.unlink()
            except OSError:
                pass
    return record


def star_history_record(record_id: str) -> dict:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    with _records_lock:
        source = HISTORY_DIR / (record_id + ".json")
        record = _read_record_file(source) if source.exists() else None
        if record is None:
            raise BadRequest(404, "RECORD_NOT_FOUND", "history record not found")
        record["favoritedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(_record_folder("favorite"), record)
        try:
            source.unlink()
        except OSError:
            pass
    return record


def create_favorite_record(payload) -> dict:
    record = _clean_record(payload)
    with _records_lock:
        folder = _record_folder("favorite")
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        record["id"] = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        record["createdAt"] = now
        record["favoritedAt"] = now
        _write_record_file(folder, record)
    return record


def update_favorite_record(record_id: str, payload) -> dict:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    record = _clean_record(payload)
    with _records_lock:
        path = FAVORITE_DIR / (record_id + ".json")
        stored = _read_record_file(path) if path.exists() else None
        if stored is None:
            raise BadRequest(404, "RECORD_NOT_FOUND", "favorite record not found")
        record["id"] = record_id
        record["createdAt"] = stored.get("createdAt") or datetime.now().astimezone().isoformat(timespec="seconds")
        if stored.get("favoritedAt"):
            record["favoritedAt"] = stored["favoritedAt"]
        if stored.get("example"):
            record["example"] = stored["example"]
        record["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(_record_folder("favorite"), record)
    return record


def rename_favorite_record(record_id: str, title) -> dict:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    clean_title = str(title or "").strip()
    if not clean_title:
        raise BadRequest(400, "EMPTY_TITLE", "favorite title is empty")
    if len(clean_title) > 120:
        raise BadRequest(400, "TITLE_TOO_LONG", "favorite title is too long")
    with _records_lock:
        path = FAVORITE_DIR / (record_id + ".json")
        record = _read_record_file(path) if path.exists() else None
        if record is None:
            raise BadRequest(404, "RECORD_NOT_FOUND", "favorite record not found")
        record["title"] = clean_title
        record["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(_record_folder("favorite"), record)
    return record


def _safe_example_path(filename) -> Path | None:
    name = str(filename or "")
    if not name or Path(name).name != name:
        return None
    path = FAVORITE_EXAMPLE_DIR / name
    return path if path.resolve() == path.absolute() else None


def save_favorite_example(record_id: str, data_url) -> dict:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    if not isinstance(data_url, str):
        raise BadRequest(400, "BAD_IMAGE", "image data is missing")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)", data_url)
    if not match:
        raise BadRequest(400, "BAD_IMAGE", "only PNG / JPEG / WebP / GIF images are supported")
    mime, encoded = match.group(1), match.group(2)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise BadRequest(400, "BAD_IMAGE", "image data is not valid base64") from None
    if not raw:
        raise BadRequest(400, "BAD_IMAGE", "image is empty")
    if len(raw) > 8 * 1024 * 1024:
        raise BadRequest(413, "IMAGE_TOO_LARGE", "example image must be 8 MB or smaller")

    if mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        ext = "png"
    elif mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff"):
        ext = "jpg"
    elif mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        ext = "webp"
    elif mime == "image/gif" and raw[:6] in (b"GIF87a", b"GIF89a"):
        ext = "gif"
    else:
        raise BadRequest(400, "BAD_IMAGE", "image content does not match its type")

    with _records_lock:
        path = FAVORITE_DIR / (record_id + ".json")
        record = _read_record_file(path) if path.exists() else None
        if record is None:
            raise BadRequest(404, "RECORD_NOT_FOUND", "favorite record not found")
        old_example = record.get("example")
        filename = f"{record_id}.{ext}"
        target = FAVORITE_EXAMPLE_DIR / filename
        tmp = FAVORITE_EXAMPLE_DIR / (filename + ".tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, target)
        record["example"] = filename
        record["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(_record_folder("favorite"), record)
        if old_example and old_example != filename:
            old_path = _safe_example_path(old_example)
            if old_path and old_path.exists():
                try:
                    old_path.unlink()
                except OSError:
                    pass
    return record


def delete_favorite_example(record_id: str) -> bool:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    with _records_lock:
        path = FAVORITE_DIR / (record_id + ".json")
        record = _read_record_file(path) if path.exists() else None
        if record is None:
            raise BadRequest(404, "RECORD_NOT_FOUND", "favorite record not found")
        old_example = record.get("example")
        if not old_example:
            return False
        record.pop("example", None)
        record["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _write_record_file(_record_folder("favorite"), record)
        old_path = _safe_example_path(old_example)
        if old_path and old_path.exists():
            try:
                old_path.unlink()
            except OSError:
                pass
    return True


def delete_record(kind: str, record_id: str) -> str | None:
    if not RECORD_ID_RE.match(record_id or ""):
        raise BadRequest(400, "BAD_RECORD_ID", "invalid record id")
    folder = _record_folder(kind)
    path = folder / (record_id + ".json")
    token = None
    with _records_lock:
        if not path.exists():
            return None
        record = _read_record_file(path)
        example_name = None
        example = None
        if kind == "favorite":
            example_name = str((record or {}).get("example") or "")
            example_path = _safe_example_path(example_name)
            if example_path and example_path.exists():
                example = _file_bytes(example_path)
        token = _undo_snapshot(kind=kind, id=record_id, record=_file_bytes(path),
                               exampleName=example_name, example=example)
        try:
            if example_name:
                example_path = _safe_example_path(example_name)
                if example_path and example_path.exists():
                    example_path.unlink()
            path.unlink()
        except OSError:
            _undo_drop(token)
            raise
    return token


# --------------------------------------------------------------------------- #
# character cards
# --------------------------------------------------------------------------- #
def _clean_character(payload) -> dict:
    if not isinstance(payload, dict):
        raise BadRequest(400, "BAD_CHARACTER", "character must be an object")
    ident = str(payload.get("id") or "").strip()
    if ident and not CHARACTER_ID_RE.match(ident):
        raise BadRequest(400, "BAD_CHARACTER_ID", "invalid character id")
    name = str(payload.get("name") or "").strip() or "未命名角色"
    if len(name) > 120:
        raise BadRequest(400, "CHARACTER_TOO_LONG", "character name is too long")
    card = {
        "id": ident,
        "name": name,
        "source": str(payload.get("source") or "").strip()[:200],
        "tags": str(payload.get("tags") or "").strip()[:20000],
        "notes": str(payload.get("notes") or "").strip()[:4000],
    }
    raw_groups = payload.get("groups")
    groups = []
    if isinstance(raw_groups, list):
        for index, item in enumerate(raw_groups[:50]):
            if not isinstance(item, dict):
                continue
            gid = str(item.get("id") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", gid):
                gid = "g-" + uuid.uuid4().hex[:10]
            gname = str(item.get("name") or "").strip()[:80] or f"组{index + 1}"
            gtags = []
            raw_tags = item.get("tags")
            if isinstance(raw_tags, list):
                for tag in raw_tags[:300]:
                    tag = str(tag).strip()[:300]
                    if tag and tag not in gtags:
                        gtags.append(tag)
            groups.append({"id": gid, "name": gname, "tags": gtags})
    card["groups"] = groups
    raw_combo = payload.get("combo")
    combo = []
    group_ids = {group["id"] for group in groups}
    if isinstance(raw_combo, list):
        for gid in raw_combo[:50]:
            gid = str(gid or "")
            if gid in group_ids and gid not in combo:
                combo.append(gid)
    card["combo"] = combo
    raw_combo_tags = payload.get("comboTags")
    combo_tags = []
    if isinstance(raw_combo_tags, list):
        for tag in raw_combo_tags[:300]:
            tag = str(tag or "").strip()[:300]
            if tag and tag not in combo_tags:
                combo_tags.append(tag)
    card["comboTags"] = combo_tags
    raw_combo_wardrobe = payload.get("comboWardrobe")
    combo_wardrobe = []
    if isinstance(raw_combo_wardrobe, list):
        for oid in raw_combo_wardrobe[:50]:
            oid = str(oid or "")
            if WARDROBE_ID_RE.match(oid) and oid not in combo_wardrobe:
                combo_wardrobe.append(oid)
    card["comboWardrobe"] = combo_wardrobe
    return card


def _decode_character_portrait(data_url) -> tuple[bytes, str]:
    if not isinstance(data_url, str):
        raise BadRequest(400, "BAD_IMAGE", "portrait data is missing")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", data_url)
    if not match:
        raise BadRequest(400, "BAD_IMAGE", "only PNG / JPEG / WebP portraits are supported")
    mime, encoded = match.group(1), match.group(2)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise BadRequest(400, "BAD_IMAGE", "portrait data is not valid base64") from None
    if not raw:
        raise BadRequest(400, "BAD_IMAGE", "portrait is empty")
    if len(raw) > 8 * 1024 * 1024:
        raise BadRequest(413, "IMAGE_TOO_LARGE", "portrait must be 8 MB or smaller")
    if mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    if mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "webp"
    raise BadRequest(400, "BAD_IMAGE", "portrait content does not match its type")


def _safe_portrait_path(filename) -> Path | None:
    name = str(filename or "")
    if not name or Path(name).name != name:
        return None
    path = CHARACTER_PORTRAIT_DIR / name
    return path if path.resolve() == path.absolute() else None


def _read_character_order() -> list[str]:
    if not CHARACTER_ORDER_PATH.exists():
        return []
    try:
        data = json.loads(CHARACTER_ORDER_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ids = data.get("ids") if isinstance(data, dict) else data
    if not isinstance(ids, list):
        return []
    result = []
    for ident in ids:
        ident = str(ident)
        if CHARACTER_ID_RE.match(ident) and ident not in result:
            result.append(ident)
    return result


def _write_character_order(ids: list[str]) -> None:
    CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CHARACTER_ORDER_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"ids": ids}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CHARACTER_ORDER_PATH)


def save_character_order(ids) -> list[str]:
    if not isinstance(ids, list):
        raise BadRequest(400, "BAD_ORDER", "ids must be a list")
    if len(ids) > 500:
        raise BadRequest(400, "BAD_ORDER", "too many characters")
    clean = []
    for ident in ids:
        ident = str(ident or "")
        if not CHARACTER_ID_RE.match(ident):
            raise BadRequest(400, "BAD_ORDER", "invalid character id")
        if ident not in clean:
            clean.append(ident)
    with _records_lock:
        _write_character_order(clean)
    return clean


def list_characters() -> list[dict]:
    CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    cards = []
    for path in CHARACTER_DIR.glob("*.json"):
        if path.name == CHARACTER_ORDER_PATH.name:
            continue
        card = _read_record_file(path)
        if card is not None:
            cards.append(card)
    by_id = {str(card.get("id") or ""): card for card in cards}
    ordered = []
    seen = set()
    for ident in _read_character_order():
        card = by_id.get(ident)
        if card is not None and ident not in seen:
            ordered.append(card)
            seen.add(ident)
    rest = [card for card in cards if str(card.get("id") or "") not in seen]
    rest.sort(key=lambda item: (str(item.get("updatedAt") or item.get("createdAt") or ""),
                                str(item.get("id") or "")), reverse=True)
    return ordered + rest


def save_character(payload, portrait_data=None) -> dict:
    card = _clean_character(payload)
    with _records_lock:
        CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
        CHARACTER_PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        cid = card.get("id") or ""
        is_new = not cid
        path = CHARACTER_DIR / (cid + ".json") if cid else None
        stored = _read_record_file(path) if path and path.exists() else None
        if cid and stored is None:
            raise BadRequest(404, "CHARACTER_NOT_FOUND", "character not found")
        if not cid:
            cid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
            card["createdAt"] = now
            portrait = None
        else:
            card["createdAt"] = stored.get("createdAt") or now
            portrait = stored.get("portrait")
        if portrait_data:
            raw, ext = _decode_character_portrait(portrait_data)
            filename = f"{cid}.{ext}"
            target = CHARACTER_PORTRAIT_DIR / filename
            tmp = CHARACTER_PORTRAIT_DIR / (filename + ".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, target)
            if portrait and portrait != filename:
                old = _safe_portrait_path(portrait)
                if old and old.exists():
                    try:
                        old.unlink()
                    except OSError:
                        pass
            portrait = filename
        card["id"] = cid
        card["portrait"] = portrait
        card["updatedAt"] = now
        tmp = CHARACTER_DIR / (cid + ".json.tmp")
        tmp.write_text(json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, CHARACTER_DIR / (cid + ".json"))
        if is_new:
            order = _read_character_order()
            if cid not in order:
                order.append(cid)
                _write_character_order(order)
    return card


def delete_character(character_id: str) -> str | None:
    if not CHARACTER_ID_RE.match(character_id or ""):
        raise BadRequest(400, "BAD_CHARACTER_ID", "invalid character id")
    path = CHARACTER_DIR / (character_id + ".json")
    token = None
    with _records_lock:
        card = _read_record_file(path) if path.exists() else None
        if card is None:
            return None
        portrait_name = str(card.get("portrait") or "")
        portrait_path = _safe_portrait_path(portrait_name)
        portrait = _file_bytes(portrait_path) if portrait_path and portrait_path.exists() else None
        token = _undo_snapshot(kind="character", id=character_id, card=_file_bytes(path),
                               portraitName=portrait_name, portrait=portrait,
                               order=_read_character_order())
        try:
            if portrait_path and portrait_path.exists():
                portrait_path.unlink()
            path.unlink()
            order = [ident for ident in _read_character_order() if ident != character_id]
            if CHARACTER_ORDER_PATH.exists():
                _write_character_order(order)
        except OSError:
            _undo_drop(token)
            raise
    return token


# --------------------------------------------------------------------------- #
# preset tag groups (/group)
# --------------------------------------------------------------------------- #
def _clean_preset_tags(tags) -> list[str]:
    if not isinstance(tags, list):
        raise BadRequest(400, "BAD_PRESET", "preset tags must be a list")
    cleaned = []
    for tag in tags[:300]:
        tag = str(tag or "").strip()[:300]
        if tag:
            cleaned.append(tag)
    if not cleaned:
        raise BadRequest(400, "BAD_PRESET", "preset tags are empty")
    return cleaned


def list_presets() -> list[dict]:
    GROUP_DIR.mkdir(parents=True, exist_ok=True)
    presets = []
    for path in GROUP_DIR.glob("*.json"):
        preset = _read_record_file(path)
        if preset is not None:
            presets.append(preset)
    presets.sort(key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")))
    return presets


def save_preset(tags, name=None) -> dict:
    cleaned = _clean_preset_tags(tags)
    with _records_lock:
        GROUP_DIR.mkdir(parents=True, exist_ok=True)
        presets = list_presets()
        used = {str(preset.get("name") or "") for preset in presets}
        custom_name = str(name or "").strip()[:80]
        if custom_name:
            preset_name = custom_name
        else:
            index = 1
            while f"预设{index}" in used:
                index += 1
            preset_name = f"预设{index}"
        preset_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        preset = {
            "id": preset_id,
            "name": preset_name,
            "tags": cleaned,
            "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        tmp = GROUP_DIR / (preset_id + ".json.tmp")
        tmp.write_text(json.dumps(preset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, GROUP_DIR / (preset_id + ".json"))
    return preset


def rename_preset(preset_id: str, name) -> dict:
    if not PRESET_ID_RE.match(preset_id or ""):
        raise BadRequest(400, "BAD_PRESET_ID", "invalid preset id")
    new_name = str(name or "").strip()[:80]
    if not new_name:
        raise BadRequest(400, "BAD_PRESET_NAME", "preset name is empty")
    path = GROUP_DIR / (preset_id + ".json")
    with _records_lock:
        preset = _read_record_file(path) if path.exists() else None
        if preset is None:
            raise BadRequest(404, "PRESET_NOT_FOUND", "preset not found")
        preset["name"] = new_name
        preset["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        tmp = GROUP_DIR / (preset_id + ".json.tmp")
        tmp.write_text(json.dumps(preset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    return preset


def delete_preset(preset_id: str) -> str | None:
    if not PRESET_ID_RE.match(preset_id or ""):
        raise BadRequest(400, "BAD_PRESET_ID", "invalid preset id")
    path = GROUP_DIR / (preset_id + ".json")
    token = None
    with _records_lock:
        if not path.exists():
            return None
        token = _undo_snapshot(kind="preset", id=preset_id, preset=_file_bytes(path))
        try:
            path.unlink()
        except OSError:
            _undo_drop(token)
            raise
    return token


# --------------------------------------------------------------------------- #
# wardrobe outfits (/wardrobe)
# --------------------------------------------------------------------------- #
def _clean_wardrobe_tags(tags) -> list[str]:
    if isinstance(tags, str):
        tags = re.split(r"[,，\n;；、]+", tags)
    if not isinstance(tags, list):
        raise BadRequest(400, "BAD_WARDROBE_TAGS", "wardrobe tags must be a list")
    cleaned = []
    for value in tags[:200]:
        tag = str(value or "").strip()[:300]
        if tag and tag not in cleaned:
            cleaned.append(tag)
    if not cleaned:
        raise BadRequest(400, "EMPTY_WARDROBE_TAGS", "wardrobe tags cannot be empty")
    return cleaned


def _safe_wardrobe_image_path(filename) -> Path | None:
    name = str(filename or "")
    if not name or Path(name).name != name:
        return None
    path = WARDROBE_IMAGE_DIR / name
    return path if path.resolve() == path.absolute() else None


def _read_wardrobe_order() -> list[str]:
    if not WARDROBE_ORDER_PATH.exists():
        return []
    try:
        data = json.loads(WARDROBE_ORDER_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ids = data.get("ids") if isinstance(data, dict) else data
    if not isinstance(ids, list):
        return []
    result = []
    for ident in ids:
        ident = str(ident or "")
        if WARDROBE_ID_RE.match(ident) and ident not in result:
            result.append(ident)
    return result


def _write_wardrobe_order(ids: list[str]) -> None:
    tmp = WARDROBE_ORDER_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"ids": ids}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, WARDROBE_ORDER_PATH)


def list_wardrobe() -> list[dict]:
    WARDROBE_DIR.mkdir(parents=True, exist_ok=True)
    outfits = []
    for path in WARDROBE_DIR.glob("*.json"):
        if path.name == WARDROBE_ORDER_PATH.name:
            continue
        outfit = _read_record_file(path)
        if outfit is not None:
            outfits.append(outfit)
    order = {ident: index for index, ident in enumerate(_read_wardrobe_order())}
    outfits.sort(key=lambda item: (order.get(str(item.get("id") or ""), 10**9),
                                  str(item.get("createdAt") or ""), str(item.get("id") or "")))
    return outfits


def save_wardrobe(payload, image_data=None) -> dict:
    if not isinstance(payload, dict):
        raise BadRequest(400, "BAD_WARDROBE", "wardrobe entry must be an object")
    ident = str(payload.get("id") or "").strip()
    if ident and not WARDROBE_ID_RE.match(ident):
        raise BadRequest(400, "BAD_WARDROBE_ID", "invalid wardrobe id")
    tags = _clean_wardrobe_tags(payload.get("tags"))
    name = str(payload.get("name") or "").strip()[:80]
    notes = str(payload.get("notes") or "").strip()[:2000]
    image_bytes = None
    image_ext = ""
    if image_data is not None:
        image_bytes, image_ext = _decode_character_portrait(image_data)
    with _records_lock:
        outfits = list_wardrobe()
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        is_new = False
        stored = None
        if ident:
            path = WARDROBE_DIR / (ident + ".json")
            stored = _read_record_file(path) if path.exists() else None
            if stored is None:
                raise BadRequest(404, "WARDROBE_NOT_FOUND", "wardrobe entry not found")
            createdAt = stored.get("createdAt") or now
        else:
            is_new = True
            used = {str(item.get("name") or "") for item in outfits}
            index = 1
            while f"衣物{index}" in used:
                index += 1
            ident = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
            path = WARDROBE_DIR / (ident + ".json")
            createdAt = now
            if not name:
                name = f"衣物{index}"
        old_image = str((stored or {}).get("image") or "")
        image_name = old_image
        if image_bytes is not None:
            image_name = f"{ident}.{image_ext}"
            WARDROBE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
            target = WARDROBE_IMAGE_DIR / image_name
            tmp_image = WARDROBE_IMAGE_DIR / (image_name + ".tmp")
            tmp_image.write_bytes(image_bytes)
            os.replace(tmp_image, target)
        outfit = {
            "id": ident,
            "name": name or "未命名衣物",
            "tags": tags,
            "notes": notes,
            "image": image_name,
            "createdAt": createdAt,
            "updatedAt": now,
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(outfit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        if old_image and old_image != image_name:
            old_path = _safe_wardrobe_image_path(old_image)
            if old_path and old_path.exists():
                try:
                    old_path.unlink()
                except OSError:
                    pass
        if is_new:
            order = _read_wardrobe_order()
            for item in outfits:
                item_id = str(item.get("id") or "")
                if item_id and item_id not in order:
                    order.append(item_id)
            if ident not in order:
                order.append(ident)
            _write_wardrobe_order(order)
    return outfit


def save_wardrobe_order(ids) -> list[str]:
    if not isinstance(ids, list):
        raise BadRequest(400, "BAD_ORDER", "ids must be a list")
    if len(ids) > 500:
        raise BadRequest(400, "BAD_ORDER", "too many wardrobe entries")
    known = {str(item.get("id") or "") for item in list_wardrobe()}
    clean = []
    for ident in ids:
        ident = str(ident or "")
        if ident in known and ident not in clean:
            clean.append(ident)
    with _records_lock:
        _write_wardrobe_order(clean)
    return clean


def delete_wardrobe(outfit_id: str) -> str | None:
    if not WARDROBE_ID_RE.match(outfit_id or ""):
        raise BadRequest(400, "BAD_WARDROBE_ID", "invalid wardrobe id")
    path = WARDROBE_DIR / (outfit_id + ".json")
    token = None
    with _records_lock:
        if not path.exists():
            return None
        outfit = _read_record_file(path)
        image_name = str((outfit or {}).get("image") or "")
        image_path = _safe_wardrobe_image_path(image_name)
        image = _file_bytes(image_path) if image_path and image_path.exists() else None
        token = _undo_snapshot(kind="wardrobe", id=outfit_id, outfit=_file_bytes(path),
                               imageName=image_name, image=image,
                               orderBytes=_file_bytes(WARDROBE_ORDER_PATH))
        try:
            path.unlink()
            if image_path and image_path.exists():
                image_path.unlink()
            order = [ident for ident in _read_wardrobe_order() if ident != outfit_id]
            _write_wardrobe_order(order)
        except OSError:
            _undo_drop(token)
            raise
    return token


# --------------------------------------------------------------------------- #
# gallery works (/gallery/<id>/)
# --------------------------------------------------------------------------- #
def _clean_gallery_work(payload) -> dict:
    if not isinstance(payload, dict):
        raise BadRequest(400, "BAD_GALLERY_WORK", "gallery work must be an object")

    def field(key: str, limit: int) -> str:
        return str(payload.get(key) or "").strip()[:limit]

    return {
        "title": field("title", 200),
        "character": field("character", 300),
        "source": field("source", 300),
        "seed": field("seed", 200),
        "artist": field("artist", 2000),
        "subjectPrompt": field("subjectPrompt", 10000),
        "qualityPrompt": field("qualityPrompt", 10000),
        "loras": field("loras", 5000),
    }


def _decode_gallery_image(data_url) -> tuple[bytes, str]:
    if not isinstance(data_url, str):
        raise BadRequest(400, "BAD_GALLERY_IMAGE", "preview image is missing")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", data_url)
    if not match:
        raise BadRequest(400, "BAD_GALLERY_IMAGE", "only PNG / JPEG / WebP preview images are supported")
    mime, encoded = match.group(1), match.group(2)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise BadRequest(400, "BAD_GALLERY_IMAGE", "preview image is not valid base64") from None
    if not raw:
        raise BadRequest(400, "BAD_GALLERY_IMAGE", "preview image is empty")
    if len(raw) > 8 * 1024 * 1024:
        raise BadRequest(413, "GALLERY_IMAGE_TOO_LARGE", "preview image must be 8 MB or smaller")
    if mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    if mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "webp"
    raise BadRequest(400, "BAD_GALLERY_IMAGE", "preview image content does not match its type")


def list_gallery_works() -> list[dict]:
    GALLERY_DIR.mkdir(parents=True, exist_ok=True)
    works = []
    for folder in GALLERY_DIR.iterdir():
        if not folder.is_dir():
            continue
        work = _read_record_file(folder / "work.json")
        if work is not None:
            works.append(work)
    works.sort(key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")), reverse=True)
    order = _read_record_file(GALLERY_ORDER_FILE)
    ids = order.get("ids") if isinstance(order, dict) else None
    if not isinstance(ids, list):
        return works
    by_id = {str(work.get("id")): work for work in works}
    ordered = []
    seen = set()
    for work_id in ids:
        key = str(work_id)
        if key in by_id and key not in seen:
            ordered.append(by_id[key])
            seen.add(key)
    ordered.extend(work for work in works if str(work.get("id")) not in seen)
    return ordered


def save_gallery_order(ids) -> list[str]:
    if not isinstance(ids, list):
        raise BadRequest(400, "BAD_GALLERY_ORDER", "order must be a list")
    cleaned = []
    seen = set()
    for work_id in ids:
        key = str(work_id)
        if not GALLERY_ID_RE.match(key):
            continue
        if key in seen:
            continue
        if not (GALLERY_DIR / key / "work.json").exists():
            continue
        seen.add(key)
        cleaned.append(key)
    with _records_lock:
        tmp = GALLERY_ORDER_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"ids": cleaned}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, GALLERY_ORDER_FILE)
    return cleaned


def delete_gallery_work(work_id: str) -> str | None:
    if not GALLERY_ID_RE.match(work_id or ""):
        raise BadRequest(400, "BAD_GALLERY_ID", "invalid gallery work id")
    folder = GALLERY_DIR / work_id
    token = None
    with _records_lock:
        if not (folder / "work.json").exists():
            return None
        files = {}
        for item in folder.iterdir():
            if item.is_file():
                files[item.name] = _file_bytes(item)
        token = _undo_snapshot(kind="gallery", id=work_id, files=files,
                               orderBytes=_file_bytes(GALLERY_ORDER_FILE))
        try:
            shutil.rmtree(folder)
            order = _read_record_file(GALLERY_ORDER_FILE)
            ids = order.get("ids") if isinstance(order, dict) else None
            if isinstance(ids, list):
                cleaned = [str(item) for item in ids if str(item) != work_id]
                tmp = GALLERY_ORDER_FILE.with_suffix(".json.tmp")
                tmp.write_text(json.dumps({"ids": cleaned}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                os.replace(tmp, GALLERY_ORDER_FILE)
        except OSError:
            _undo_drop(token)
            raise
    return token


def create_gallery_work(payload, image_data=None) -> dict:
    work = _clean_gallery_work(payload)
    with _records_lock:
        GALLERY_DIR.mkdir(parents=True, exist_ok=True)
        work_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        folder = GALLERY_DIR / work_id
        folder.mkdir(parents=True, exist_ok=True)
        image = None
        if image_data:
            raw, ext = _decode_gallery_image(image_data)
            image = f"preview.{ext}"
            tmp = folder / (image + ".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, folder / image)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        work["id"] = work_id
        work["image"] = image
        work["createdAt"] = now
        work["updatedAt"] = now
        tmp = folder / "work.json.tmp"
        tmp.write_text(json.dumps(work, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, folder / "work.json")
        order = _read_record_file(GALLERY_ORDER_FILE)
        ids = order.get("ids") if isinstance(order, dict) else None
        ids = [str(item) for item in ids] if isinstance(ids, list) else []
        ids = [work_id] + [item for item in ids if item != work_id]
        tmp_order = GALLERY_ORDER_FILE.with_suffix(".json.tmp")
        tmp_order.write_text(json.dumps({"ids": ids}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_order, GALLERY_ORDER_FILE)
    return work


def update_gallery_work(work_id: str, payload, image_data=None) -> dict:
    if not GALLERY_ID_RE.match(work_id or ""):
        raise BadRequest(400, "BAD_GALLERY_ID", "invalid gallery work id")
    fields = _clean_gallery_work(payload)
    with _records_lock:
        folder = GALLERY_DIR / work_id
        path = folder / "work.json"
        work = _read_record_file(path)
        if work is None:
            raise BadRequest(404, "NOT_FOUND", "gallery work not found")
        work.update(fields)
        if image_data:
            raw, ext = _decode_gallery_image(image_data)
            old_image = str(work.get("image") or "")
            image = f"preview.{ext}"
            tmp = folder / (image + ".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, folder / image)
            work["image"] = image
            if old_image and old_image != image:
                old_path = (folder / old_image).resolve()
                if Path(old_image).name == old_image and old_path.parent == folder.resolve():
                    try:
                        old_path.unlink()
                    except OSError:
                        pass
        work["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        tmp = folder / "work.json.tmp"
        tmp.write_text(json.dumps(work, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    return work


def gallery_image_path(work_id: str) -> Path | None:
    if not GALLERY_ID_RE.match(work_id or ""):
        return None
    work = _read_record_file(GALLERY_DIR / work_id / "work.json")
    name = str(work.get("image") or "") if work else ""
    if not name or Path(name).name != name:
        return None
    path = GALLERY_DIR / work_id / name
    return path if path.exists() and path.resolve() == path.absolute() else None


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "S.P.E.C.7/" + VERSION
    protocol_version = "HTTP/1.1"

    # -- utilities ---------------------------------------------------------
    def version_string(self):
        # Do not disclose the local Python version in HTTP responses.
        return self.server_version

    def _allow_local_request(self) -> bool:
        """Reject DNS rebinding and browser requests from other origins.

        Non-browser local clients without Origin remain supported. This is not
        authentication against other processes or users on the same computer.
        """
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = (self.headers.get("Host") or "").lower()
        origin = self.headers.get("Origin")
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        valid_origin = True
        if origin:
            try:
                parsed = urlsplit(origin)
                valid_origin = (parsed.scheme == "http" and parsed.netloc.lower() == host
                                and not parsed.path and not parsed.query and not parsed.fragment)
            except ValueError:
                valid_origin = False
        if host not in allowed or not valid_origin or fetch_site in {"cross-site", "same-site"}:
            self.close_connection = True
            self._error(403, "LOCAL_ONLY", "仅允许从本机应用页面访问。")
            return False
        return True

    def log_message(self, fmt, *args):  # keep the console calm
        pass

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
            self.send_header("Referrer-Policy", "no-referrer")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # the browser closed the tab mid-response; nothing left to say
            self.close_connection = True

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, code: str, message: str, hint: str = ""):
        self._json(status, {"error": {"code": code, "message": message, "hint": hint}})

    def _read_json(self) -> dict:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            raise BadRequest(411, "LENGTH_REQUIRED", "chunked request bodies are not supported")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            raise BadRequest(400, "BAD_REQUEST", "invalid Content-Length") from None
        if length <= 0:
            return {}
        if length > 16 * 1024 * 1024:
            self.close_connection = True
            raise BadRequest(413, "PAYLOAD_TOO_LARGE", "request body larger than 16 MB")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise BadRequest(400, "BAD_JSON", "request body is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise BadRequest(400, "BAD_BODY", "request body must be a JSON object")
        return payload

    # -- routing -----------------------------------------------------------
    def do_OPTIONS(self):
        if not self._allow_local_request():
            return
        self._send(204, b"", "text/plain")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._allow_local_request():
            return
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            try:
                self._api_get(path)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as exc:  # noqa: BLE001 - report any failure as JSON
                self._error(500, "SERVER_ERROR", "本地服务处理失败；为保护隐私，不显示内部异常详情。")
            return
        self._serve_static(path)

    def do_POST(self):
        if not self._allow_local_request():
            return
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/config":
                incoming = self._read_json()
                merged = save_config(incoming)
                self._json(200, {"ok": True, "config": redacted_config(merged)})
                return
            if path == "/api/translate":
                self._translate()
                return
            if path == "/api/health":
                body = self._read_json()
                cfg = merged_draft_config(load_config(), body.get("config"))
                self._json(200, health_payload(cfg, force=bool(body.get("fresh"))))
                return
            if path == "/api/glossary":
                body = self._read_json()
                entries = body.get("entries")
                if not isinstance(entries, dict):
                    self._error(400, "BAD_GLOSSARY", "entries must be an object")
                    return
                if len(entries) > 20000:
                    self._error(400, "GLOSSARY_TOO_LARGE", "too many glossary entries")
                    return
                cleaned = {}
                for key, value in entries.items():
                    if not isinstance(key, str) or not isinstance(value, str):
                        self._error(400, "BAD_GLOSSARY", "entry keys and values must be strings")
                        return
                    clean_key = key.strip().lower()
                    clean_value = value.strip()
                    if not clean_key or not clean_value:
                        self._error(400, "BAD_GLOSSARY", "entry key and value cannot be empty")
                        return
                    if len(clean_key) > 120 or len(clean_value) > 160:
                        self._error(400, "BAD_GLOSSARY", "entry is too long")
                        return
                    if "," in clean_key or "\n" in clean_key:
                        self._error(400, "BAD_GLOSSARY", "entry key cannot contain commas or newlines")
                        return
                    cleaned[clean_key] = clean_value
                count = save_glossary(cleaned)
                self._json(200, {"ok": True, "count": count})
                return
            if path == "/api/unload":
                body = self._read_json()
                engine = str(body.get("engine") or "").strip().lower()
                model = str(body.get("model") or "").strip()
                force = bool(body.get("force"))
                if force:
                    cancel_active_translations()
                if engine != "ollama":
                    self._json(200, {
                        "ok": True,
                        "unloaded": False,
                        "engine": engine,
                        "reason": "only ollama supports model unloading",
                    })
                    return
                cfg = load_config()
                if not model:
                    model = str(cfg["ollama"].get("model") or "").strip()
                if not model:
                    self._error(400, "NO_MODEL", "no model to unload")
                    return
                try:
                    unload_ollama_model(cfg, model)
                except EngineError as exc:
                    self._error(502, "UNLOAD_FAILED", exc.message, exc.hint)
                    return
                self._json(200, {"ok": True, "unloaded": True, "engine": "ollama", "model": model, "forced": force})
                return
            if path == "/api/history":
                body = self._read_json()
                payload = body.get("record") if isinstance(body.get("record"), dict) else body
                record = create_history_record(payload)
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "count": len(list_records("history")),
                })
                return
            if path == "/api/history/star":
                body = self._read_json()
                record = star_history_record(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "historyCount": len(list_records("history")),
                    "favoriteCount": len(list_records("favorite")),
                })
                return
            if path == "/api/history/delete":
                body = self._read_json()
                token = delete_record("history", str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_records("history")),
                })
                return
            if path == "/api/favorite":
                body = self._read_json()
                payload = body.get("record") if isinstance(body.get("record"), dict) else body
                record = create_favorite_record(payload)
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/characters":
                body = self._read_json()
                payload = body.get("card") if isinstance(body.get("card"), dict) else body
                card = save_character(payload, body.get("portraitData"))
                self._json(200, {
                    "ok": True,
                    "card": card,
                    "count": len(list_characters()),
                })
                return
            if path == "/api/characters/delete":
                body = self._read_json()
                token = delete_character(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_characters()),
                })
                return
            if path == "/api/characters/order":
                body = self._read_json()
                ids = save_character_order(body.get("ids"))
                self._json(200, {"ok": True, "ids": ids})
                return
            if path == "/api/presets":
                body = self._read_json()
                preset = save_preset(body.get("tags"), body.get("name"))
                self._json(200, {
                    "ok": True,
                    "preset": preset,
                    "count": len(list_presets()),
                })
                return
            if path == "/api/presets/rename":
                body = self._read_json()
                preset = rename_preset(str(body.get("id") or ""), body.get("name"))
                self._json(200, {"ok": True, "preset": preset})
                return
            if path == "/api/presets/delete":
                body = self._read_json()
                token = delete_preset(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_presets()),
                })
                return
            if path == "/api/wardrobe":
                body = self._read_json()
                payload = body.get("entry") if isinstance(body.get("entry"), dict) else body
                outfit = save_wardrobe(payload, body.get("imageData"))
                self._json(200, {
                    "ok": True,
                    "outfit": outfit,
                    "count": len(list_wardrobe()),
                })
                return
            if path == "/api/wardrobe/delete":
                body = self._read_json()
                token = delete_wardrobe(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_wardrobe()),
                })
                return
            if path == "/api/wardrobe/order":
                body = self._read_json()
                ids = save_wardrobe_order(body.get("ids"))
                self._json(200, {"ok": True, "ids": ids})
                return
            if path == "/api/gallery":
                body = self._read_json()
                payload = body.get("work") if isinstance(body.get("work"), dict) else body
                work = create_gallery_work(payload, body.get("imageData"))
                self._json(200, {
                    "ok": True,
                    "work": work,
                    "count": len(list_gallery_works()),
                })
                return
            if path == "/api/gallery/update":
                body = self._read_json()
                payload = body.get("work") if isinstance(body.get("work"), dict) else body
                work = update_gallery_work(str(body.get("id") or ""), payload, body.get("imageData"))
                self._json(200, {
                    "ok": True,
                    "work": work,
                    "count": len(list_gallery_works()),
                })
                return
            if path == "/api/gallery/delete":
                body = self._read_json()
                token = delete_gallery_work(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_gallery_works()),
                })
                return
            if path == "/api/gallery/order":
                body = self._read_json()
                order = save_gallery_order(body.get("ids"))
                self._json(200, {
                    "ok": True,
                    "ids": order,
                    "count": len(order),
                })
                return
            if path == "/api/undo/restore":
                body = self._read_json()
                restored = restore_deleted(str(body.get("token") or ""))
                self._json(200, {"ok": True, **restored})
                return
            if path == "/api/favorite/example":
                body = self._read_json()
                record = save_favorite_example(str(body.get("id") or ""), body.get("dataUrl"))
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/favorite/example/delete":
                body = self._read_json()
                deleted = delete_favorite_example(str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": deleted,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/favorite/rename":
                body = self._read_json()
                record = rename_favorite_record(str(body.get("id") or ""), body.get("title"))
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/favorite/save":
                body = self._read_json()
                payload = body.get("record") if isinstance(body.get("record"), dict) else body
                record = update_favorite_record(str(body.get("id") or ""), payload)
                self._json(200, {
                    "ok": True,
                    "record": record,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/favorite/delete":
                body = self._read_json()
                token = delete_record("favorite", str(body.get("id") or ""))
                self._json(200, {
                    "ok": True,
                    "deleted": bool(token),
                    "undoToken": token,
                    "count": len(list_records("favorite")),
                })
                return
            if path == "/api/models":
                body = self._read_json()
                engine = str(body.get("engine") or "ollama")
                cfg = merged_draft_config(load_config(), body.get("config"))
                probes = probe_all(cfg)
                if engine == "ollama":
                    self._json(200, {"engine": engine, "models": probes["ollama"].get("models", []),
                                     "error": probes["ollama"].get("error", "")})
                elif engine == "openai":
                    self._json(200, {"engine": engine, "models": probes["openai"].get("models", []),
                                     "error": probes["openai"].get("error", "")})
                else:
                    self._error(400, "UNKNOWN_ENGINE", "models are only listed for ollama / openai")
                return
            self._error(404, "NOT_FOUND", "unknown endpoint")
        except BadRequest as exc:
            self._error(exc.status, exc.code, exc.message)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(500, "SERVER_ERROR", "本地服务处理失败；为保护隐私，不显示内部异常详情。")

    def _api_get(self, path: str):
        cfg = load_config()
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = {}
        for pair in query.split("&"):
            if "=" in pair:
                key, value = pair.split("=", 1)
                params[key] = value
        if path == "/api/health":
            fresh = params.get("fresh", "") in ("1", "true", "yes")
            self._json(200, health_payload(cfg, force=fresh))
            return
        if path == "/api/hardware":
            self._json(200, hardware_payload())
            return
        if path == "/api/characters":
            self._json(200, {"cards": list_characters()})
            return
        if path == "/api/presets":
            self._json(200, {"presets": list_presets()})
            return
        if path == "/api/wardrobe":
            self._json(200, {"outfits": list_wardrobe()})
            return
        if path.startswith("/api/wardrobe/image/"):
            outfit_id = path.rsplit("/", 1)[-1]
            if not WARDROBE_ID_RE.match(outfit_id or ""):
                self._error(404, "NOT_FOUND", "wardrobe image not found")
                return
            outfit = _read_record_file(WARDROBE_DIR / (outfit_id + ".json"))
            image_path = _safe_wardrobe_image_path((outfit or {}).get("image"))
            if not image_path or not image_path.exists():
                self._error(404, "NOT_FOUND", "wardrobe image not found")
                return
            try:
                body = image_path.read_bytes()
            except OSError:
                self._error(500, "READ_ERROR", "cannot read wardrobe image")
                return
            mime = STATIC_TYPES.get(image_path.suffix.lower(), "application/octet-stream")
            self._send(200, body, mime)
            return
        if path == "/api/gallery":
            self._json(200, {"works": list_gallery_works()})
            return
        if path.startswith("/api/gallery/image/"):
            work_id = path.rsplit("/", 1)[-1]
            image_path = gallery_image_path(work_id)
            if image_path is None:
                self._error(404, "NOT_FOUND", "gallery image not found")
                return
            try:
                body = image_path.read_bytes()
            except OSError:
                self._error(500, "READ_ERROR", "cannot read gallery image")
                return
            mime = STATIC_TYPES.get(image_path.suffix.lower(), "application/octet-stream")
            self._send(200, body, mime)
            return
        if path.startswith("/api/character/portrait/"):
            character_id = path.rsplit("/", 1)[-1]
            if not CHARACTER_ID_RE.match(character_id or ""):
                self._error(404, "NOT_FOUND", "portrait not found")
                return
            card = _read_record_file(CHARACTER_DIR / (character_id + ".json"))
            portrait_path = _safe_portrait_path(card.get("portrait") if card else None)
            if not portrait_path or not portrait_path.exists():
                self._error(404, "NOT_FOUND", "portrait not found")
                return
            try:
                body = portrait_path.read_bytes()
            except OSError:
                self._error(500, "READ_ERROR", "cannot read portrait")
                return
            mime = STATIC_TYPES.get(portrait_path.suffix.lower(), "application/octet-stream")
            self._send(200, body, mime)
            return
        if path == "/api/history":
            self._json(200, {"records": list_records("history"), "limit": HISTORY_LIMIT})
            return
        if path == "/api/favorite":
            self._json(200, {"records": list_records("favorite")})
            return
        if path.startswith("/api/favorite/example/"):
            record_id = path.rsplit("/", 1)[-1]
            if not RECORD_ID_RE.match(record_id or ""):
                self._error(404, "NOT_FOUND", "example image not found")
                return
            record = _read_record_file(FAVORITE_DIR / (record_id + ".json"))
            example_path = _safe_example_path(record.get("example") if record else None)
            if not example_path or not example_path.exists():
                self._error(404, "NOT_FOUND", "example image not found")
                return
            try:
                body = example_path.read_bytes()
            except OSError:
                self._error(500, "READ_ERROR", "cannot read example image")
                return
            mime = STATIC_TYPES.get(example_path.suffix.lower(), "application/octet-stream")
            self._send(200, body, mime)
            return
        if path == "/api/config":
            self._json(200, {"config": redacted_config(cfg)})
            return
        if path == "/api/glossary":
            self._json(200, {"entries": load_glossary()})
            return
        if path == "/api/models":
            engine = params.get("engine", "ollama")
            probes = probe_all(cfg)
            if engine == "ollama":
                self._json(200, {"engine": engine, "models": probes["ollama"].get("models", []),
                                 "error": probes["ollama"].get("error", "")})
            elif engine == "openai":
                self._json(200, {"engine": engine, "models": probes["openai"].get("models", []),
                                 "error": probes["openai"].get("error", "")})
            else:
                self._error(400, "UNKNOWN_ENGINE", "models are only listed for ollama / openai")
            return
        self._error(404, "NOT_FOUND", "unknown endpoint")

    # -- translation -------------------------------------------------------
    def _translate(self):
        body = self._read_json()
        blocks = body.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            self._error(400, "NO_BLOCKS", "blocks must be a non-empty array")
            return
        if len(blocks) > 400:
            self._error(400, "TOO_MANY_BLOCKS", "too many blocks")
            return
        direction = str(body.get("direction") or "en2zh")
        if direction not in ("en2zh", "zh2en"):
            self._error(400, "BAD_DIRECTION", "direction must be en2zh or zh2en")
            return
        texts: list[str] = []
        types: list[str] = []
        for block in blocks:
            if not isinstance(block, dict):
                self._error(400, "BAD_BLOCKS", "each block must be an object")
                return
            text = str(block.get("text", "")).strip()
            if not text:
                self._error(400, "EMPTY_BLOCK", "block text is empty")
                return
            if len(text) > 4000:
                self._error(400, "BLOCK_TOO_LONG", "one block is longer than 4000 characters")
                return
            texts.append(text)
            kind = str(block.get("type") or "").strip().lower()
            types.append(kind if kind in ("tag", "sentence") else "")

        cfg = load_config()
        started = time.time()
        try:
            picked = resolve_engine(cfg)
        except EngineError as exc:
            self._error(502, exc.code, exc.message, exc.hint)
            return
        if picked is None:
            self._error(409, "NO_ENGINE",
                        "本地没有可用的翻译引擎。",
                        "在引擎舱连接 Ollama / LM Studio / LibreTranslate，或使用本机 Chrome 内置翻译。")
            return
        engine, model = picked

        cache_keys = [hashlib.sha1(f"{direction}|{types[index]}|{engine}|{model}|{text}".encode("utf-8")).hexdigest()
                      for index, text in enumerate(texts)]
        results: list[str] = []
        pending_texts: list[str] = []
        pending_indexes: list[int] = []
        with _cache_lock:
            for index, key in enumerate(cache_keys):
                cached = _translate_cache.get(key)
                if cached is not None:
                    results.append(cached)
                else:
                    results.append("")
                    pending_texts.append(texts[index])
                    pending_indexes.append(index)

        warnings: list[str] = []
        if pending_texts:
            cancel_event = _begin_translation_cancel()
            try:
                translated, warnings = translate_texts(engine, cfg, model, pending_texts, direction,
                                                       [types[index] for index in pending_indexes])
            except EngineError as exc:
                self._error(502, exc.code, exc.message, exc.hint)
                return
            finally:
                _end_translation_cancel(cancel_event)
            if cancel_event.is_set():
                self._error(409, "TRANSLATION_CANCELLED", "翻译已被强制终止。")
                return
            with _cache_lock:
                for index, text in zip(pending_indexes, translated):
                    results[index] = text
                    if text:
                        _translate_cache[cache_keys[index]] = text
                        if len(_translate_cache) > 8000:
                            _translate_cache.pop(next(iter(_translate_cache)))

        payload = []
        for block, text, translation in zip(blocks, texts, results):
            payload.append({
                "id": (block or {}).get("id"),
                "text": translation,
                "ok": bool(translation),
            })
        self._json(200, {
            "engine": engine,
            "model": model,
            "direction": direction,
            "ms": int((time.time() - started) * 1000),
            "results": payload,
            "warnings": warnings,
            "cached": not pending_texts,
        })

    # -- static files ------------------------------------------------------
    def _serve_static(self, path: str):
        relative = path.lstrip("/") or "index.html"
        if relative in ("", "index.html"):
            relative = "index.html"
        candidate = (PUBLIC / relative).resolve()
        try:
            candidate.relative_to(PUBLIC)
        except ValueError:
            self._json(403, {"error": {"code": "FORBIDDEN", "message": "path outside public"}})
            return
        if candidate.is_dir():
            candidate = (candidate / "index.html").resolve()
            try:
                candidate.relative_to(PUBLIC)
            except ValueError:
                self._error(403, "FORBIDDEN", "path outside public")
                return
        if not candidate.exists():
            self._json(404, {"error": {"code": "NOT_FOUND", "message": relative}})
            return
        content_type = STATIC_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
        try:
            body = candidate.read_bytes()
        except OSError:
            self._error(500, "READ_ERROR", "cannot read file")
            return
        self._send(200, body, content_type)


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="S.P.E.C. 7 — station for prompt editing & composition")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if not (PUBLIC / "index.html").exists():
        print("public/index.html is missing — cannot start.", flush=True)
        raise SystemExit(1)

    server = None
    last_error = None
    for candidate in range(args.port, args.port + 10):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            break
        except OSError as exc:
            last_error = exc
    if server is None:
        print(f"cannot bind a local port ({last_error})", flush=True)
        raise SystemExit(1)
    server.daemon_threads = True
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}"
    # 后台预热引擎探测缓存，首个 /api/health 直接命中缓存而不是现场等超时
    threading.Thread(target=lambda: probe_all(load_config(), fast=True, force=True),
                     name="health-warmup", daemon=True).start()
    print("", flush=True)
    print("  S.P.E.C. 7 // STATION FOR PROMPT EDITING & COMPOSITION", flush=True)
    print(f"  local station ........ {url}", flush=True)
    print("  config ............... local configuration loaded", flush=True)
    print("  press Ctrl+C to stop", flush=True)
    print("", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  station offline.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
