"""Authentication store for the AIV Bank student SQL interface.

WHY THIS IS A SEPARATE FILE ON DISK
-----------------------------------
Students execute arbitrary SELECT statements against `student.duckdb`. Any
table living in that database is, for practical purposes, public to them. A
`users` table there would hand out the password-hash corpus of the whole
cohort - salts, parameters and all - to anybody who typed `SELECT * FROM
users`. So the credential store is a *different file*, in a *different engine*
(SQLite), opened by a *different code path*, and never attached to the DuckDB
connection. `api/config.py::assert_auth_store_isolated` refuses to start the
service if that file is ever placed inside a student-facing directory.

WHAT IS STORED
--------------
* `users`     - one row per person. Password: scrypt(N=2^15, r=8, p=1) over a
                fresh 16-byte salt. The plaintext is never written anywhere.
* `sessions`  - the SHA-256 of the session token, never the token itself. A
                stolen store therefore cannot be replayed as a live session.
* `throttle`  - failed-login counters, keyed independently by username and by
                client IP, with exponential backoff.

TIMING
------
`verify_password` performs exactly one scrypt derivation whether or not the
user exists, whether or not the account is disabled, and whether or not the
password is right. Without that, "unknown user" would return in microseconds
and "wrong password" in ~65ms, which is a username oracle any script can read.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

ROLE_STUDENT = "STUDENT"
ROLE_INSTRUCTOR = "INSTRUCTOR"
ROLES = (ROLE_STUDENT, ROLE_INSTRUCTOR)

# --- scrypt parameters -------------------------------------------------------
# 128 * N * r = 32MiB of memory per derivation, ~65ms on the dev box. maxmem
# must be passed explicitly: OpenSSL's default ceiling is 32MiB and rejects
# exactly this combination ("memory limit exceeded").
SCRYPT_N = 1 << 15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_MAXMEM = 132 * 1024 * 1024

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256

# A password that cannot be entered (no user has this hash) but that costs the
# same scrypt work as a real one. Used for the unknown-user branch.
_DUMMY_SALT = b"\x00" * 16
_DUMMY_SECRET = b"aivb-nonexistent-account-timing-equaliser"


class AuthError(RuntimeError):
    """Programming / operator error in the auth store (never student facing)."""


@dataclass(frozen=True)
class User:
    username: str
    role: str
    full_name: str
    must_change_password: bool
    disabled: bool
    created_at: str
    password_changed_at: str | None
    last_login_at: str | None


@dataclass(frozen=True)
class Session:
    token_hash: str
    username: str
    role: str
    created_at: float
    last_seen_at: float
    absolute_expires_at: float
    idle_expires_at: float
    must_change_password: bool

    @property
    def session_id(self) -> str:
        """Short, non-reversible handle safe to write to the audit log."""
        return self.token_hash[:12]


@dataclass(frozen=True)
class ThrottlePolicy:
    """Exponential lockout, applied to usernames and client IPs separately.

    The username threshold is the tight one (5 failures -> 30s, doubling, 15min
    ceiling) because it is the credential actually being guessed. The IP
    threshold is deliberately looser: a classroom behind one NAT shares a single
    source address, and a 5-strike IP rule would let one student with a typo
    lock out the whole room. It still bounds a distributed username sweep from
    a single host.
    """

    user_fail_threshold: int = 5
    ip_fail_threshold: int = 20
    base_delay_s: float = 30.0
    max_delay_s: float = 900.0

    def delay_for(self, scope: str, fail_count: int) -> float:
        threshold = (
            self.user_fail_threshold if scope == "user" else self.ip_fail_threshold
        )
        if fail_count < threshold:
            return 0.0
        exponent = fail_count - threshold
        # Cheap guard against 2**huge before min() ever sees it.
        if exponent > 32:
            return self.max_delay_s
        return min(self.max_delay_s, self.base_delay_s * (2**exponent))


@dataclass(frozen=True)
class SessionPolicy:
    idle_timeout_s: float = 8 * 3600.0
    absolute_timeout_s: float = 12 * 3600.0


# --- password primitives -----------------------------------------------------
def _derive(password: str, salt: bytes, params: dict[str, int]) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=params["n"],
        r=params["r"],
        p=params["p"],
        dklen=params["dklen"],
        maxmem=SCRYPT_MAXMEM,
    )


def default_params() -> dict[str, int]:
    return {"n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P, "dklen": SCRYPT_DKLEN}


def hash_password(password: str) -> tuple[bytes, bytes, str]:
    """-> (salt, hash, params_json). A fresh 16-byte salt every single call."""
    salt = secrets.token_bytes(16)
    params = default_params()
    return salt, _derive(password, salt, params), json.dumps(params, sort_keys=True)


def validate_password_strength(password: str, username: str = "") -> None:
    """Raise AuthError with a human message if the password is unacceptable."""
    if not isinstance(password, str):
        raise AuthError("Password must be text.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters long."
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise AuthError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters.")
    if password.strip() == "":
        raise AuthError("Password must not be only whitespace.")
    if username and password.lower() == username.lower():
        raise AuthError("Password must not be the same as the username.")
    lowered = password.lower()
    for weak in ("password", "123456789", "qwerty", "aivbank", "letmein"):
        if weak in lowered:
            raise AuthError(f"Password must not contain '{weak}'.")


def generate_password(length: int = 16) -> str:
    """A one-shot initial password. Printed once by the CLI, never stored."""
    # token_urlsafe(n) yields ~1.34*n characters; ask for enough, then trim.
    raw = secrets.token_urlsafe(max(12, int(length * 0.8) + 4))
    return raw[:length]


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def normalise_username(username: str) -> str:
    return (username or "").strip().lower()


_SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
    username             TEXT PRIMARY KEY,
    role                 TEXT NOT NULL,
    full_name            TEXT NOT NULL DEFAULT '',
    pw_algo              TEXT NOT NULL,
    pw_salt              BLOB NOT NULL,
    pw_hash              BLOB NOT NULL,
    pw_params            TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    disabled             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    password_changed_at  TEXT,
    last_login_at        TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash          TEXT PRIMARY KEY,
    username            TEXT NOT NULL,
    role                TEXT NOT NULL,
    created_at          REAL NOT NULL,
    last_seen_at        REAL NOT NULL,
    absolute_expires_at REAL NOT NULL,
    revoked             INTEGER NOT NULL DEFAULT 0,
    ip                  TEXT,
    user_agent          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE TABLE IF NOT EXISTS throttle (
    scope        TEXT NOT NULL,
    key          TEXT NOT NULL,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until REAL NOT NULL DEFAULT 0,
    updated_at   REAL NOT NULL,
    PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class AuthStore:
    """SQLite-backed credential + session store. Safe for concurrent threads."""

    def __init__(
        self,
        path: str | Path,
        throttle: ThrottlePolicy | None = None,
        sessions: SessionPolicy | None = None,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.throttle = throttle or ThrottlePolicy()
        self.session_policy = sessions or SessionPolicy()
        self._local = threading.local()
        self._write_lock = threading.Lock()
        with self._connect_new() as con:
            con.executescript(_SCHEMA)
            con.execute(
                "INSERT OR IGNORE INTO meta(k, v) VALUES ('schema_version', '1')"
            )
            con.commit()
        self._restrict_permissions()

    # -- plumbing ---------------------------------------------------------
    def _connect_new(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.path), timeout=10.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA busy_timeout=10000")
        return con

    @property
    def _con(self) -> sqlite3.Connection:
        con = getattr(self._local, "con", None)
        if con is None:
            con = self._connect_new()
            self._local.con = con
        return con

    def _restrict_permissions(self) -> None:
        """0600 on the store and its WAL siblings. Best effort (no-op on FS
        that do not support it) - the isolation check in config.py is the
        control that actually matters."""
        for suffix in ("", "-wal", "-shm"):
            target = Path(str(self.path) + suffix)
            try:
                if target.exists():
                    os.chmod(target, 0o600)
            except OSError:  # pragma: no cover - platform dependent
                pass

    def close(self) -> None:
        con = getattr(self._local, "con", None)
        if con is not None:
            try:
                con.close()
            except Exception:  # pragma: no cover
                pass
            self._local.con = None

    # -- users ------------------------------------------------------------
    def create_user(
        self,
        username: str,
        role: str,
        password: str | None = None,
        full_name: str = "",
        must_change_password: bool = True,
    ) -> tuple[User, str]:
        """Create an account. Returns (user, plaintext_password).

        The plaintext is returned exactly once, to be shown to the operator and
        then forgotten. It is not stored, logged, or recoverable.
        """
        uname = normalise_username(username)
        if not uname or not uname.replace("_", "").replace(".", "").replace(
            "-", ""
        ).isalnum():
            raise AuthError(
                "Username must be alphanumeric (dots, dashes and underscores allowed)."
            )
        if len(uname) > 64:
            raise AuthError("Username must be at most 64 characters.")
        if role not in ROLES:
            raise AuthError(f"role must be one of {ROLES}, got {role!r}")

        plaintext = password or generate_password()
        validate_password_strength(plaintext, uname)
        salt, digest, params = hash_password(plaintext)
        now = _utc_now()
        with self._write_lock:
            try:
                self._con.execute(
                    "INSERT INTO users (username, role, full_name, pw_algo, pw_salt, "
                    "pw_hash, pw_params, must_change_password, disabled, created_at, "
                    "password_changed_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)",
                    (
                        uname,
                        role,
                        full_name,
                        "scrypt",
                        salt,
                        digest,
                        params,
                        1 if must_change_password else 0,
                        now,
                        now,
                    ),
                )
                self._con.commit()
            except sqlite3.IntegrityError as exc:
                raise AuthError(f"User {uname!r} already exists.") from exc
        self._restrict_permissions()
        user = self.get_user(uname)
        assert user is not None
        return user, plaintext

    def get_user(self, username: str) -> User | None:
        row = self._con.execute(
            "SELECT username, role, full_name, must_change_password, disabled, "
            "created_at, password_changed_at, last_login_at FROM users WHERE username = ?",
            (normalise_username(username),),
        ).fetchone()
        return _row_to_user(row) if row else None

    def list_users(self) -> list[User]:
        rows = self._con.execute(
            "SELECT username, role, full_name, must_change_password, disabled, "
            "created_at, password_changed_at, last_login_at FROM users ORDER BY role, username"
        ).fetchall()
        return [_row_to_user(r) for r in rows]

    def set_disabled(self, username: str, disabled: bool) -> None:
        uname = normalise_username(username)
        with self._write_lock:
            cur = self._con.execute(
                "UPDATE users SET disabled = ? WHERE username = ?",
                (1 if disabled else 0, uname),
            )
            self._con.commit()
        if cur.rowcount == 0:
            raise AuthError(f"No such user: {uname}")
        if disabled:
            # Disabling must take effect now, not at the next session expiry.
            self.revoke_all_sessions(uname)

    def set_password(
        self, username: str, password: str, must_change_password: bool = False
    ) -> None:
        uname = normalise_username(username)
        validate_password_strength(password, uname)
        salt, digest, params = hash_password(password)
        with self._write_lock:
            cur = self._con.execute(
                "UPDATE users SET pw_salt = ?, pw_hash = ?, pw_params = ?, "
                "pw_algo = 'scrypt', must_change_password = ?, password_changed_at = ? "
                "WHERE username = ?",
                (
                    salt,
                    digest,
                    params,
                    1 if must_change_password else 0,
                    _utc_now(),
                    uname,
                ),
            )
            self._con.commit()
        if cur.rowcount == 0:
            raise AuthError(f"No such user: {uname}")

    def reset_password(self, username: str) -> str:
        """Set a fresh random password, force a change at next login, and kill
        every live session for that user. Returns the plaintext once."""
        plaintext = generate_password()
        self.set_password(username, plaintext, must_change_password=True)
        self.revoke_all_sessions(username)
        return plaintext

    # -- authentication ---------------------------------------------------
    def verify_password(self, username: str, password: str) -> User | None:
        """Constant-work credential check.

        Exactly one scrypt derivation happens on every path:
          * unknown user      -> derive against a fixed dummy salt, return None
          * disabled user     -> derive against the real salt, return None
          * wrong password    -> derive, compare, return None
          * correct password  -> derive, compare, return the User
        """
        uname = normalise_username(username)
        row = self._con.execute(
            "SELECT username, role, full_name, pw_salt, pw_hash, pw_params, "
            "must_change_password, disabled, created_at, password_changed_at, "
            "last_login_at FROM users WHERE username = ?",
            (uname,),
        ).fetchone()

        if row is None:
            salt, expected, params = _DUMMY_SALT, b"", default_params()
        else:
            salt = row["pw_salt"]
            expected = row["pw_hash"]
            try:
                params = json.loads(row["pw_params"])
            except (TypeError, ValueError):  # pragma: no cover - corrupt store
                params = default_params()

        candidate = _derive(password[:MAX_PASSWORD_LENGTH], salt, params)
        # compare_digest even in the unknown-user branch so the comparison cost
        # does not become the oracle the scrypt call just removed.
        matched = hmac.compare_digest(candidate, expected or b"\x00" * len(candidate))

        if row is None or not matched or row["disabled"]:
            return None
        return _row_to_user(row)

    def record_login(self, username: str) -> None:
        with self._write_lock:
            self._con.execute(
                "UPDATE users SET last_login_at = ? WHERE username = ?",
                (_utc_now(), normalise_username(username)),
            )
            self._con.commit()

    # -- throttle ---------------------------------------------------------
    def lock_remaining(self, scope: str, key: str, now: float | None = None) -> float:
        now = time.time() if now is None else now
        row = self._con.execute(
            "SELECT locked_until FROM throttle WHERE scope = ? AND key = ?",
            (scope, key),
        ).fetchone()
        if row is None:
            return 0.0
        return max(0.0, float(row["locked_until"]) - now)

    def record_failure(self, scope: str, key: str, now: float | None = None) -> float:
        """Count one failed attempt; returns the lock duration now in force."""
        now = time.time() if now is None else now
        with self._write_lock:
            row = self._con.execute(
                "SELECT fail_count FROM throttle WHERE scope = ? AND key = ?",
                (scope, key),
            ).fetchone()
            fails = (int(row["fail_count"]) if row else 0) + 1
            delay = self.throttle.delay_for(scope, fails)
            self._con.execute(
                "INSERT INTO throttle (scope, key, fail_count, locked_until, updated_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET "
                "fail_count = excluded.fail_count, locked_until = excluded.locked_until, "
                "updated_at = excluded.updated_at",
                (scope, key, fails, now + delay, now),
            )
            self._con.commit()
        return delay

    def clear_failures(self, scope: str, key: str) -> None:
        with self._write_lock:
            self._con.execute(
                "DELETE FROM throttle WHERE scope = ? AND key = ?", (scope, key)
            )
            self._con.commit()

    def fail_count(self, scope: str, key: str) -> int:
        row = self._con.execute(
            "SELECT fail_count FROM throttle WHERE scope = ? AND key = ?", (scope, key)
        ).fetchone()
        return int(row["fail_count"]) if row else 0

    # -- sessions ---------------------------------------------------------
    def create_session(
        self,
        username: str,
        role: str,
        ip: str = "",
        user_agent: str = "",
        now: float | None = None,
    ) -> tuple[str, Session]:
        """Mint a session. Returns (raw_token, session).

        The raw token leaves this method exactly once, into a Set-Cookie
        header. Only its SHA-256 is persisted, so a dump of auth.sqlite3 does
        not yield a usable session.
        """
        now = time.time() if now is None else now
        raw = secrets.token_urlsafe(32)
        digest = hash_token(raw)
        absolute = now + self.session_policy.absolute_timeout_s
        with self._write_lock:
            self._con.execute(
                "INSERT INTO sessions (token_hash, username, role, created_at, "
                "last_seen_at, absolute_expires_at, revoked, ip, user_agent) "
                "VALUES (?,?,?,?,?,?,0,?,?)",
                (
                    digest,
                    normalise_username(username),
                    role,
                    now,
                    now,
                    absolute,
                    ip[:64],
                    user_agent[:200],
                ),
            )
            self._con.commit()
        user = self.get_user(username)
        session = Session(
            token_hash=digest,
            username=normalise_username(username),
            role=role,
            created_at=now,
            last_seen_at=now,
            absolute_expires_at=absolute,
            idle_expires_at=now + self.session_policy.idle_timeout_s,
            must_change_password=bool(user.must_change_password) if user else False,
        )
        return raw, session

    def validate_session(
        self, raw_token: str, now: float | None = None, touch: bool = True
    ) -> Session | None:
        """Resolve a cookie value to a live session, or None.

        Role and disabled-status are re-read from `users` on every request, so
        an account disabled by the instructor stops working immediately rather
        than at the next expiry.
        """
        if not raw_token or len(raw_token) > 256:
            return None
        now = time.time() if now is None else now
        digest = hash_token(raw_token)
        row = self._con.execute(
            "SELECT s.token_hash, s.username, s.created_at, s.last_seen_at, "
            "       s.absolute_expires_at, s.revoked, u.role AS user_role, "
            "       u.disabled, u.must_change_password "
            "FROM sessions s JOIN users u ON u.username = s.username "
            "WHERE s.token_hash = ?",
            (digest,),
        ).fetchone()
        if row is None:
            return None
        # Belt and braces: the lookup already matched, but compare the stored
        # value in constant time as well.
        if not hmac.compare_digest(str(row["token_hash"]), digest):
            return None  # pragma: no cover - unreachable via SQL equality
        if int(row["revoked"]):
            return None
        if int(row["disabled"]):
            return None
        if now >= float(row["absolute_expires_at"]):
            self.revoke_session_hash(digest)
            return None
        idle_deadline = float(row["last_seen_at"]) + self.session_policy.idle_timeout_s
        if now >= idle_deadline:
            self.revoke_session_hash(digest)
            return None

        if touch:
            with self._write_lock:
                self._con.execute(
                    "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                    (now, digest),
                )
                self._con.commit()
            last_seen = now
        else:
            last_seen = float(row["last_seen_at"])

        return Session(
            token_hash=digest,
            username=row["username"],
            role=row["user_role"],
            created_at=float(row["created_at"]),
            last_seen_at=last_seen,
            absolute_expires_at=float(row["absolute_expires_at"]),
            idle_expires_at=last_seen + self.session_policy.idle_timeout_s,
            must_change_password=bool(row["must_change_password"]),
        )

    def revoke_session(self, raw_token: str) -> bool:
        return self.revoke_session_hash(hash_token(raw_token)) if raw_token else False

    def revoke_session_hash(self, token_hash: str) -> bool:
        with self._write_lock:
            cur = self._con.execute(
                "UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0",
                (token_hash,),
            )
            self._con.commit()
        return cur.rowcount > 0

    def revoke_all_sessions(self, username: str) -> int:
        with self._write_lock:
            cur = self._con.execute(
                "UPDATE sessions SET revoked = 1 WHERE username = ? AND revoked = 0",
                (normalise_username(username),),
            )
            self._con.commit()
        return cur.rowcount

    def expire_session_now(self, raw_token: str) -> None:
        """Test/ops helper: push a session past its idle window without waiting."""
        digest = hash_token(raw_token)
        past = time.time() - self.session_policy.idle_timeout_s - 1
        with self._write_lock:
            self._con.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (past, digest),
            )
            self._con.commit()

    def purge_expired(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        cutoff = now - self.session_policy.idle_timeout_s
        with self._write_lock:
            cur = self._con.execute(
                "DELETE FROM sessions WHERE revoked = 1 OR absolute_expires_at < ? "
                "OR last_seen_at < ?",
                (now, cutoff),
            )
            self._con.commit()
        return cur.rowcount

    def active_session_count(self, username: str | None = None) -> int:
        if username is None:
            row = self._con.execute(
                "SELECT count(*) AS n FROM sessions WHERE revoked = 0"
            ).fetchone()
        else:
            row = self._con.execute(
                "SELECT count(*) AS n FROM sessions WHERE revoked = 0 AND username = ?",
                (normalise_username(username),),
            ).fetchone()
        return int(row["n"])


def _row_to_user(row: sqlite3.Row) -> User:
    return User(
        username=row["username"],
        role=row["role"],
        full_name=row["full_name"] if "full_name" in row.keys() else "",
        must_change_password=bool(row["must_change_password"]),
        disabled=bool(row["disabled"]),
        created_at=row["created_at"],
        password_changed_at=row["password_changed_at"],
        last_login_at=row["last_login_at"] if "last_login_at" in row.keys() else None,
    )


def _utc_now() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
