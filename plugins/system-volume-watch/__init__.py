"""system-volume-watch plugin - observe macOS output volume changes.

This plugin keeps a small polling loop in the Hermes process, records
changes into a JSON state file plus an append-only outbox, and emits
callback jobs into ``output.json`` when the host volume changes.
Hermes owns the visible loading state and the final component update.

The dispatch path is loop-safe:

- self-initiated volume changes are suppressed briefly
- spawned Hermes runs receive a disable flag so they do not start their
  own watcher loop
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

PLUGIN_NAME = "system-volume-watch"
POLL_INTERVAL_SECONDS = 1.0
SELF_CHANGE_WINDOW_SECONDS = 2.0
HISTORY_LIMIT = 32
HELPER_NAME = "volume-watch-daemon"

STATE_DIR = Path(get_hermes_home()) / PLUGIN_NAME
STATE_PATH = STATE_DIR / "state.json"
OUTBOX_PATH = STATE_DIR / "outbox.jsonl"
PID_PATH = STATE_DIR / "daemon.pid"
CONTEXT_PATH = STATE_DIR / "daemon.context.json"
OUTPUT_PATH_ENV = "LIVE_EDIT_OUTPUT_PATH"
CALLBACK_PROMPT_ENV = "HERMES_VOLUME_WATCH_CALLBACK_PROMPT"

DISABLE_ENV = "HERMES_VOLUME_WATCH_DISABLE"
AUTO_DISPATCH_ENV = "HERMES_VOLUME_WATCH_AUTO_DISPATCH"
STATE_FILE_ENV = "HERMES_VOLUME_WATCH_STATE_FILE"

_lock = threading.RLock()
_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None
_events: Deque[Dict[str, Any]] = deque(maxlen=HISTORY_LIMIT)
_dispatch_lock = threading.Lock()
_dispatch_in_flight = False

_state: Dict[str, Any] = {
    "supported": False,
    "available": False,
    "watching": False,
    "current_volume": None,
    "last_polled_at": None,
    "last_change": None,
    "last_error": None,
    "last_self_set": None,
    "last_dispatch": None,
    "recent_events": [],
}


def _is_supported() -> bool:
    return platform.system().lower() == "darwin" and shutil.which("osascript") is not None


def _watching_disabled() -> bool:
    value = os.getenv(DISABLE_ENV, "")
    return value.lower() in {"1", "true", "yes", "on"}


def _auto_dispatch_enabled() -> bool:
    value = os.getenv(AUTO_DISPATCH_ENV, "1")
    return value.lower() in {"1", "true", "yes", "on"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _daemon_context() -> Dict[str, Any]:
    try:
        return json.loads(CONTEXT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_daemon_context(**updates: Any) -> Dict[str, Any]:
    context = _daemon_context()
    context.update({key: value for key, value in updates.items() if value is not None})

    env_output_path = os.getenv(OUTPUT_PATH_ENV, "").strip()
    if "output_path" not in context and env_output_path:
        context["output_path"] = env_output_path

    if not context.get("output_path"):
        context.pop("output_path", None)

    if not context.get("callback_prompt"):
        context.pop("callback_prompt", None)

    context["updated_at"] = _now_iso()
    _ensure_state_dir()
    CONTEXT_PATH.write_text(json.dumps(context, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return context


def _ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def _snapshot_locked() -> Dict[str, Any]:
    snapshot = dict(_state)
    snapshot["recent_events"] = list(_events)
    snapshot["watcher_thread_alive"] = bool(_thread and _thread.is_alive())
    snapshot["daemon_pid_alive"] = _daemon_running()
    snapshot["supported"] = _is_supported()
    snapshot["watching_disabled"] = _watching_disabled()
    snapshot["auto_dispatch_enabled"] = _auto_dispatch_enabled()
    snapshot["poll_interval_seconds"] = POLL_INTERVAL_SECONDS
    snapshot["self_change_window_seconds"] = SELF_CHANGE_WINDOW_SECONDS
    snapshot["state_file"] = str(STATE_PATH)
    snapshot["outbox_file"] = str(OUTBOX_PATH)
    snapshot["daemon_context"] = _daemon_context()
    return snapshot


def _write_state_locked() -> None:
    _ensure_state_dir()
    payload = json.dumps(_snapshot_locked(), indent=2, sort_keys=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=STATE_DIR,
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(payload)
        handle.write("\n")
        tmp_path = Path(handle.name)
    tmp_path.replace(STATE_PATH)


def _append_outbox(event: Dict[str, Any]) -> None:
    _ensure_state_dir()
    line = json.dumps(event, sort_keys=True)
    with OUTBOX_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.write("\n")


def _output_path() -> Optional[Path]:
    config = _daemon_context()
    raw = str(config.get("output_path") or "").strip()
    if not raw:
        raw = os.getenv(OUTPUT_PATH_ENV, "").strip()
    if not raw:
        return None
    return Path(raw)


def _callback_prompt(event: Dict[str, Any]) -> str:
    config = _daemon_context()
    prompt = str(config.get("callback_prompt") or "").strip()
    if not prompt:
        prompt = os.getenv(CALLBACK_PROMPT_ENV, "").strip()
    if not prompt:
        prompt = f"System volume changed to {event.get('volume', event.get('to'))} percent."
    try:
        return prompt.format(**event)
    except Exception:
        return prompt


def _write_output_job(event: Dict[str, Any]) -> None:
    output_path = _output_path()
    if output_path is None:
        return

    try:
        if output_path.exists():
            current = json.loads(output_path.read_text(encoding="utf-8"))
            if isinstance(current, dict) and current.get("status") in {"pending", "running"}:
                logger.debug("[system-volume-watch] output.json busy; skipping event write")
                return
    except Exception:
        pass

    prompt = _callback_prompt(event)
    job = {
        "id": f"volume-change-{int(time.time() * 1000)}",
        "status": "pending",
        "createdAt": _now_iso(),
        "type": "hermes_callback",
        "source": PLUGIN_NAME,
        "prompt": prompt,
        "payload": event,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=output_path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(job, handle, indent=2, sort_keys=True)
        handle.write("\n")
        tmp_path = Path(handle.name)
    tmp_path.replace(output_path)


def _daemon_running() -> bool:
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
    except Exception:
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def _start_daemon() -> bool:
    if _watching_disabled() or not _is_supported():
        return False

    context = _daemon_context()
    current_output = str(context.get("output_path") or os.getenv(OUTPUT_PATH_ENV, "")).strip()
    if _daemon_running():
        if not current_output:
            return True
        if context.get("output_path") == current_output:
            return True
        _stop_daemon()

    if not current_output:
        return False

    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault(DISABLE_ENV, "0")
    env.setdefault(AUTO_DISPATCH_ENV, "0")
    env.setdefault(STATE_FILE_ENV, str(STATE_PATH))
    env.setdefault(OUTPUT_PATH_ENV, env.get(OUTPUT_PATH_ENV, ""))
    cmd = [sys.executable, str(Path(__file__).resolve()), "--daemon"]

    proc = subprocess.Popen(
        cmd,
        cwd=str(Path(__file__).resolve().parent),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )

    PID_PATH.write_text(str(proc.pid) + "\n", encoding="utf-8")
    _write_daemon_context(output_path=current_output)
    logger.info("[system-volume-watch] started daemon pid=%s", proc.pid)
    return True


def _stop_daemon() -> None:
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
    except Exception:
        return

    try:
        os.kill(pid, 15)
    except Exception:
        pass
    try:
        PID_PATH.unlink()
    except Exception:
        pass


def _load_state_file() -> Dict[str, Any]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _read_pending_events(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    if not OUTBOX_PATH.exists():
        return []
    items: List[Dict[str, Any]] = []
    try:
        for raw in OUTBOX_PATH.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            try:
                items.append(json.loads(raw))
            except Exception:
                continue
    except Exception:
        return []
    if limit is None or limit >= len(items):
        return items
    return items[-limit:]


def _parse_volume(raw: Any) -> int:
    value = int(str(raw).strip())
    if not 0 <= value <= 100:
        raise ValueError(f"volume out of range: {value}")
    return value


def _get_volume() -> int:
    proc = subprocess.run(
        ["osascript", "-e", "output volume of (get volume settings)"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "osascript failed").strip()
        raise RuntimeError(message)
    return _parse_volume(proc.stdout)


def _get_muted() -> Optional[bool]:
    proc = subprocess.run(
        ["osascript", "-e", "output muted of (get volume settings)"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None

    value = proc.stdout.strip().lower()
    if value in {"true", "1", "yes"}:
        return True
    if value in {"false", "0", "no"}:
        return False
    return None


def _set_volume(value: int) -> None:
    proc = subprocess.run(
        ["osascript", "-e", f"set volume output volume {value}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "osascript failed").strip()
        raise RuntimeError(message)


def _append_event(event: Dict[str, Any]) -> None:
    _events.append(event)
    _state["recent_events"] = list(_events)


def _record_change(source: str, previous: Optional[int], current: int) -> Dict[str, Any]:
    event = {
        "changedAt": _now_iso(),
        "source": source,
        "from": previous,
        "muted": _get_muted(),
        "to": current,
        "volume": current,
    }
    _state["current_volume"] = current
    _state["last_change"] = event
    _state["last_error"] = None
    _append_event(event)
    return event


def _poll_once() -> None:
    current = _get_volume()
    now = time.time()
    with _lock:
        previous = _state.get("current_volume")
        _state["supported"] = _is_supported()
        _state["available"] = True
        _state["watching"] = True
        _state["last_polled_at"] = _now_iso()
        self_change = _state.get("last_self_set") or {}
        suppress_until = float(self_change.get("suppress_until", 0.0) or 0.0)
        target = self_change.get("target")

        if previous is None:
            event = _record_change("startup", None, current)
            _write_state_locked()
            return

        if current == previous:
            if suppress_until and now > suppress_until:
                _state["last_self_set"] = None
                _write_state_locked()
            return

        if target == current and now <= suppress_until:
            _state["current_volume"] = current
            _state["last_error"] = None
            _state["last_polled_at"] = _now_iso()
            _write_state_locked()
            return

        event = _record_change("external", previous, current)
        _state["last_self_set"] = None
        logger.info("[system-volume-watch] volume changed %s -> %s", previous, current)
        _write_state_locked()

    _append_outbox(event)
    _write_output_job(event)


def _watch_loop() -> None:
    logger.info("[system-volume-watch] watcher started")
    while not _stop_event.wait(POLL_INTERVAL_SECONDS):
        try:
            _poll_once()
        except Exception as exc:
            with _lock:
                _state["supported"] = _is_supported()
                _state["available"] = _state["supported"]
                _state["watching"] = True
                _state["last_error"] = str(exc)
                _state["last_polled_at"] = _now_iso()
                _write_state_locked()
            logger.debug("[system-volume-watch] poll failed: %s", exc)
    logger.info("[system-volume-watch] watcher stopped")


def _ensure_watcher_running() -> bool:
    global _thread
    if _watching_disabled():
        with _lock:
            _state["supported"] = _is_supported()
            _state["available"] = False
            _state["watching"] = False
            _state["last_error"] = "watcher disabled by environment"
            try:
                _write_state_locked()
            except Exception:
                pass
        return False

    if not _is_supported():
        with _lock:
            _state["supported"] = False
            _state["available"] = False
            _state["watching"] = False
            _state["last_error"] = "system volume watching is only available on macOS with osascript"
            try:
                _write_state_locked()
            except Exception:
                pass
        return False

    with _lock:
        _state["supported"] = True
        _state["available"] = True
        _state["watching"] = True
        _state.setdefault("current_volume", None)
        _state["last_error"] = None
        _write_state_locked()
    return _start_daemon()


def _stop_watcher() -> None:
    with _lock:
        _state["watching"] = False
        try:
            _write_state_locked()
        except Exception:
            logger.debug("[system-volume-watch] failed to flush state on exit", exc_info=True)


def _parse_args(args: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return args if isinstance(args, dict) else {}


def _status_payload() -> Dict[str, Any]:
    with _lock:
        snapshot = _snapshot_locked()
    snapshot["state_file_snapshot"] = _load_state_file()
    snapshot["pending_events"] = _read_pending_events(limit=32)
    return snapshot


def volume_watch_status(args: Dict[str, Any], **kwargs: Any) -> str:
    return json.dumps({"ok": True, "status": _status_payload()}, indent=2, sort_keys=True)


def volume_watch_refresh(args: Dict[str, Any], **kwargs: Any) -> str:
    if not _ensure_watcher_running():
        return json.dumps(
            {
                "ok": False,
                "error": "system volume watching is only available on macOS with osascript",
                "status": _status_payload(),
            },
            indent=2,
            sort_keys=True,
        )

    try:
        _poll_once()
        return json.dumps({"ok": True, "status": _status_payload()}, indent=2, sort_keys=True)
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": str(exc), "status": _status_payload()},
            indent=2,
            sort_keys=True,
        )


def volume_watch_pending_events(args: Dict[str, Any], **kwargs: Any) -> str:
    parsed = _parse_args(args)
    limit = parsed.get("limit")
    try:
        limit_value = int(limit) if limit is not None else 32
    except Exception:
        limit_value = 32
    if limit_value <= 0:
        limit_value = 32
    events = _read_pending_events(limit=limit_value)
    return json.dumps(
        {"ok": True, "count": len(events), "events": events, "outbox": str(OUTBOX_PATH)},
        indent=2,
        sort_keys=True,
    )


def volume_watch_set(args: Dict[str, Any], **kwargs: Any) -> str:
    parsed = _parse_args(args)
    if not _ensure_watcher_running():
        return json.dumps(
            {
                "ok": False,
                "error": "system volume watching is only available on macOS with osascript",
                "status": _status_payload(),
            },
            indent=2,
            sort_keys=True,
        )

    try:
        value = _parse_volume(parsed.get("value", parsed.get("volume", 0)))
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"invalid volume value: {exc}"}, indent=2, sort_keys=True)

    try:
        _set_volume(value)
    except Exception as exc:
        with _lock:
            _state["last_error"] = str(exc)
            _write_state_locked()
        return json.dumps({"ok": False, "error": str(exc), "status": _status_payload()}, indent=2, sort_keys=True)

    with _lock:
        previous = _state.get("current_volume")
        current_at = _now_iso()
        event = {
            "changedAt": current_at,
            "source": "local-set",
            "from": previous,
            "muted": _get_muted(),
            "to": value,
            "volume": value,
        }
        _state["supported"] = True
        _state["available"] = True
        _state["watching"] = True
        _state["current_volume"] = value
        _state["last_change"] = event
        _state["last_error"] = None
        _state["last_self_set"] = {
            "target": value,
            "set_at": current_at,
            "suppress_until": time.time() + SELF_CHANGE_WINDOW_SECONDS,
        }
        _append_event(event)
        _write_state_locked()

    return json.dumps({"ok": True, "volume": value, "status": _status_payload()}, indent=2, sort_keys=True)


def volume_watch_configure(args: Dict[str, Any], **kwargs: Any) -> str:
    parsed = _parse_args(args)
    callback_prompt = str(parsed.get("callback_prompt", parsed.get("prompt", ""))).strip()
    output_path = str(parsed.get("output_path", "")).strip()

    if not callback_prompt:
        return json.dumps(
            {"ok": False, "error": "callback_prompt is required", "status": _status_payload()},
            indent=2,
            sort_keys=True,
        )

    if not output_path:
        return json.dumps(
            {"ok": False, "error": "output_path is required", "status": _status_payload()},
            indent=2,
            sort_keys=True,
        )

    if not Path(output_path).is_absolute():
        return json.dumps(
            {"ok": False, "error": "output_path must be absolute", "status": _status_payload()},
            indent=2,
            sort_keys=True,
        )

    configured = _write_daemon_context(callback_prompt=callback_prompt, output_path=output_path)
    _ensure_watcher_running()
    return json.dumps({"ok": True, "config": configured, "status": _status_payload()}, indent=2, sort_keys=True)


def volume_watch_set_callback(args: Dict[str, Any], **kwargs: Any) -> str:
    return volume_watch_configure(args, **kwargs)


def _on_session_start(**kwargs: Any) -> None:
    _ensure_watcher_running()


def _on_session_end(**kwargs: Any) -> None:
    with _lock:
        _state["watching"] = _daemon_running()
        try:
            _write_state_locked()
        except Exception:
            logger.debug("[system-volume-watch] failed to flush state on session end", exc_info=True)


def register(ctx) -> None:
    if not _is_supported():
        logger.info("system-volume-watch plugin: unsupported platform; not registering watcher")

    ctx.register_tool(
        name="volume_watch_status",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_status",
            "description": "Return the current watcher state, last observed volume, and recent change events.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=volume_watch_status,
        check_fn=None,
    )
    ctx.register_tool(
        name="volume_watch_refresh",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_refresh",
            "description": "Poll macOS once right now and return the latest watcher state.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=volume_watch_refresh,
        check_fn=None,
    )
    ctx.register_tool(
        name="volume_watch_pending_events",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_pending_events",
            "description": "Read the pending outbox events written by the watcher.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Maximum number of pending events to return.",
                    }
                },
                "additionalProperties": False,
            },
        },
        handler=volume_watch_pending_events,
        check_fn=None,
    )
    ctx.register_tool(
        name="volume_watch_set",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_set",
            "description": "Set macOS output volume and suppress the resulting self-change loop.",
            "parameters": {
                "type": "object",
                "properties": {
                    "value": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 100,
                        "description": "Target output volume percentage.",
                    }
                },
                "required": ["value"],
                "additionalProperties": False,
            },
        },
        handler=volume_watch_set,
        check_fn=None,
    )
    ctx.register_tool(
        name="volume_watch_configure",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_configure",
            "description": "Configure the system volume watcher callback prompt and output.json path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "callback_prompt": {
                        "type": "string",
                        "description": "Prompt to send back into Hermes when volume changes.",
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Absolute path to the canvas output.json file.",
                    }
                },
                "required": ["callback_prompt", "output_path"],
                "additionalProperties": False,
            },
        },
        handler=volume_watch_configure,
        check_fn=None,
    )
    ctx.register_tool(
        name="volume_watch_set_callback",
        toolset=PLUGIN_NAME,
        schema={
            "name": "volume_watch_set_callback",
            "description": "Backward-compatible alias for volume_watch_configure.",
            "parameters": {
                "type": "object",
                "properties": {
                    "callback_prompt": {
                        "type": "string",
                        "description": "Prompt to send back into Hermes when volume changes.",
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Absolute path to the canvas output.json file.",
                    }
                },
                "required": ["callback_prompt", "output_path"],
                "additionalProperties": False,
            },
        },
        handler=volume_watch_set_callback,
        check_fn=None,
    )
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    _ensure_watcher_running()
    atexit.register(_stop_watcher)


def _daemon_main() -> int:
    if _watching_disabled() or not _is_supported():
        return 0
    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(str(os.getpid()) + "\n", encoding="utf-8")
    context = _daemon_context()
    output_path = str(context.get("output_path") or os.getenv(OUTPUT_PATH_ENV, "")).strip()
    _write_daemon_context(output_path=output_path)
    try:
        with _lock:
            _state["supported"] = True
            _state["available"] = True
            _state["watching"] = True
            _write_state_locked()
        _watch_loop()
    finally:
        try:
            PID_PATH.unlink()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(_daemon_main())
