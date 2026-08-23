"""Append-only audit log (JSONL), readable only by INSTRUCTOR sessions.

One JSON object per line, opened with O_APPEND so concurrent writers cannot
interleave or overwrite each other's records, and never rewritten in place.

What goes in: who, when, from where, which SQL, how many rows, how long, and
whether the guard refused it (with the reason).

What must never go in: passwords, session tokens, cookie headers. `_scrub`
drops any field whose name looks like a credential, and the writer is the only
way into the file - callers cannot bypass it.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger("aivb.audit")

# Field names that must never be persisted, whatever a caller passes.
_FORBIDDEN_KEYS = frozenset(
    {
        "password",
        "new_password",
        "current_password",
        "passwd",
        "pw",
        "token",
        "raw_token",
        "session_token",
        "cookie",
        "authorization",
        "secret",
        "pw_hash",
        "pw_salt",
    }
)

MAX_SQL_CHARS_LOGGED = 4000


class AuditLog:
    def __init__(self, path: str | Path, enabled: bool = True) -> None:
        self.path = Path(path)
        self.enabled = enabled
        self._lock = threading.Lock()
        if self.enabled:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Create with 0600 before anything is written to it.
            if not self.path.exists():
                fd = os.open(str(self.path), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
                os.close(fd)
            try:
                os.chmod(self.path, 0o600)
            except OSError:  # pragma: no cover - platform dependent
                pass

    def write(self, event: str, **fields: Any) -> None:
        if not self.enabled:
            return
        record: dict[str, Any] = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
            "event": event,
        }
        record.update(_scrub(fields))
        line = json.dumps(record, ensure_ascii=False, default=str)
        try:
            with self._lock:
                # O_APPEND: every write lands at the current end of file, even
                # with several processes attached. No seek, no truncate.
                fd = os.open(str(self.path), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
                try:
                    payload = (line + "\n").encode("utf-8")
                    # write() may legally return short. Loop, or a long SQL
                    # statement can leave a half-written record in the file.
                    written = 0
                    while written < len(payload):
                        written += os.write(fd, payload[written:])
                finally:
                    os.close(fd)
        except OSError as exc:  # pragma: no cover - disk full / permissions
            log.error("audit write failed: %s", exc)

    def tail(self, limit: int = 100) -> list[dict[str, Any]]:
        """Most recent `limit` records, oldest first. Instructor-only callers."""
        if not self.enabled or not self.path.exists():
            return []
        limit = max(1, min(int(limit), 5000))
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()[-limit:]
        except OSError as exc:  # pragma: no cover
            log.error("audit read failed: %s", exc)
            return []
        out: list[dict[str, Any]] = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                out.append({"event": "unparseable_line", "raw": line[:500]})
        return out


def _scrub(fields: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in fields.items():
        lowered = key.lower()
        if lowered in _FORBIDDEN_KEYS or "password" in lowered or "token" in lowered:
            # session_id is an allowed exception: it is a truncated SHA-256 of
            # the token, not the token, and is handled by an explicit key name.
            continue
        if key == "sql" and isinstance(value, str):
            value = value[:MAX_SQL_CHARS_LOGGED]
        clean[key] = value
    return clean
