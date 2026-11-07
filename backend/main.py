"""FastAPI application - AIV Bank student SQL interface (backend).

Defense layers, from outermost to innermost:

  LA  authentication: no valid server-side session, no data. Every /query and
      /schema* endpoint requires one (api/auth.py, api/authstore.py)
  LR  role routing: the session's role selects the PostgreSQL *database* and
      the *credential*. STUDENT -> aivb_student as aivb_api_student,
      INSTRUCTOR -> aivb_instructor as aivb_api_instructor. Two pools, two
      logins; not a filter over one shared connection. A routing bug hands a
      student a credential that CANNOT OPEN a connection to the instructor
      database, because CONNECT is not granted to it
  L0  the student database physically omits every INSTRUCTOR table and the
      withheld column (built that way by generator/load_postgres.py, proven by
      qa/verify_pg_parity.py)
  L1  engine privileges: the API roles hold GRANT SELECT and nothing else - no
      INSERT/UPDATE/DELETE/DDL, not superuser. NOTE that
      `default_transaction_read_only` is NOT this layer: any client can turn it
      off. Only the absent grants enforce read-only (api/tests/test_api.py
      proves both halves)
  L2  the SQL guard: parse -> node allowlist -> table allowlist -> re-render
      (api/guard.py)  <- primary application-level enforcement
  L3  response hygiene: uniform "does not exist" errors, engine errors rebuilt
      from SQLSTATE + diag.message_primary ONLY - never str(exc), never the
      HINT field, which volunteers real column names from the catalog (api/db.py)

Note on scope: users of Excel / Power BI / Tableau connect straight to
PostgreSQL and therefore bypass L2 and L3 entirely. For them L0, L1 and LR are
the whole story - which is why they are physical rather than app-level, and why
api/tests/test_pg_engine_defenses.py measures them against the live database.

The API is the single source of truth about the schema for the frontend.
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import json
import logging
import os
from pathlib import Path
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import mimetypes

from .audit import AuditLog
from .auth import (
    ApiError,
    Principal,
    api_error_response,
    clear_session_cookie,
    client_ip,
    enforce_csrf,
    principal_from_session,
    session_from_request,
    set_session_cookie,
    unauthenticated,
)
from . import pgroles
from .authstore import (
    ROLE_INSTRUCTOR,
    ROLE_STUDENT,
    AuthError,
    AuthStore,
    AuthUnavailable,
    SessionPolicy,
    ThrottlePolicy,
    validate_password_strength,
)
from .config import (
    CONTENT_SECURITY_POLICY,
    GAME_CONTENT_SECURITY_POLICY,
    REPO_ROOT,
    cors_policy_from_env,
    settings,
)
from .db import Database, QueryFailed, QueryTimeout, ServiceBusy
from .guard import GuardRejection, validate
from .gamification import GamificationStore
from . import game_bridge
from .models import (
    AuditEntryResponse,
    ColumnOut,
    ErrorResponse,
    HealthResponse,
    LoginRequest,
    LogoutResponse,
    MartListResponse,
    MartSummary,
    PasswordChangeRequest,
    PasswordChangeResponse,
    QueryRequest,
    QueryResponse,
    SchemaResponse,
    SessionInfo,
    TableDetail,
    TableDetailResponse,
    TableListResponse,
    TableSummary,
    DatasetSummary,
    DatasetListResponse,
    GamificationResponse,
    LeaderboardResponse,
    InstructorAnalyticsResponse,
    GameSchemaResponse,
    GameTableOut,
    RelationshipOut,
    RelationshipsResponse,
    ChallengeDetailResponse,
    ChallengeLeaderboardResponse,
    ChallengeListResponse,
    ChallengeSampleResponse,
    ChallengeSubmitRequest,
    ChallengeSubmitResponse,
)
from . import game_schema
from . import challenges as challenge_mod

API_VERSION = "1.5.1"

logging.basicConfig(
    level=os.environ.get("AIVB_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("aivb.api")

_state: dict[str, Any] = {
    # {ten_dataset: {"STUDENT": Database, "INSTRUCTOR": Database | None}}
    "datasets": {},
    # Hai khoa duoi la BI DANH cua bo du lieu mac dinh, giu lai de moi thu
    # tham chieu chung khong phai doi cung mot luc. `datasets` la nguon that.
    "db": None,  # STUDENT connection
    "instructor_db": None,  # INSTRUCTOR connection (may be None)
    "auth": None,  # AuthStore
    "audit": None,  # AuditLog
    "gamification": None,
    "error": None,
}


def _size_request_threadpool() -> None:
    """Keep starlette's threadpool wider than our own admission queue.

    Every endpoint here is a sync `def`, so each in-flight request occupies one
    anyio worker thread. Requests waiting for a query slot hold their thread
    while they wait. If the pool were not comfortably larger than
    `max_concurrent_queries + max_queued_queries`, a burst of /query would
    consume every worker and /health and /schema would stall behind it - the
    exact starvation the bounded queue exists to prevent.

    Dat DUNG BANG `needed`, ca len LAN xuong. Hai ly do, va ly do thu hai moi
    la cai quan trong:

      1. Nhanh cu la `if limiter.total_tokens < needed`, ma `needed` mac dinh
         la 4+16+8 = 28 con mac dinh cua anyio la 40. Nen no CHUA BAO GIO chay:
         phep sizing nay la mot no-op ke tu luc duoc viet.
      2. Moi worker thread phuc vu `/auth/login` giu MOT ket noi PostgreSQL mo
         bang chinh vai tro cua hoc vien (`AuthStore.verify_password`). So luong
         vi the LA mot ngan sach ket noi, khong chi la mot num CPU. De no o 40
         nghia la cho phep 40 phien dang nhap dong thoi, va cong voi pool cua
         `aivb_app_rw` thi vuot `max_connections` cua cum.

    Bat bien phai giu: `needed >= max_concurrent_queries + max_queued_queries`,
    khong thi luong tro thanh rang buoc chat hon va hang doi cua `db.slot()`
    khong bao gio day. An toan ha o day vi `lifespan` chay truoc moi request.
    """
    needed = settings.max_concurrent_queries + settings.max_queued_queries + 8
    try:
        import anyio.to_thread

        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = needed
        log.info(
            "request threadpool: %d workers (queue capacity %d+%d)",
            limiter.total_tokens,
            settings.max_concurrent_queries,
            settings.max_queued_queries,
        )
    except Exception as exc:  # pragma: no cover - anyio internals
        log.warning("could not size the request threadpool: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _size_request_threadpool()

    # Kho danh tinh khong con la mot FILE nen khong con cho nao de dat nham -
    # `assert_auth_store_isolated` da bi go cung `AIVB_AUTH_DB_PATH`. Danh tinh
    # song trong `pg_authid`, con phien/throttle trong database `aivb_app`.
    #
    # `admin_conninfo` CO Y de trong: tien trinh phuc vu Internet nay khong bao
    # gio duoc cam `CREATEROLE`. Tao/xoa tai khoan la viec cua `admin_cli`.
    _state["auth"] = AuthStore(
        settings.pg_conninfo_app(),
        user_conninfo=settings.pg_conninfo_as_user,
        throttle=ThrottlePolicy(
            user_fail_threshold=settings.login_fail_threshold,
            ip_fail_threshold=settings.login_ip_fail_threshold,
            base_delay_s=settings.login_lock_base_s,
            max_delay_s=settings.login_lock_max_s,
        ),
        sessions=SessionPolicy(
            idle_timeout_s=settings.session_idle_timeout_s,
            absolute_timeout_s=settings.session_absolute_timeout_s,
        ),
        pool_min=settings.pg_auth_pool_min,
        pool_max=settings.pg_auth_pool_max,
    )
    _state["audit"] = AuditLog(settings.audit_log_path, enabled=settings.audit_enabled)
    # Phong thu nhu cac dataset: kho diem hong thi `/query` van phai chay.
    # Truoc day `/gamification/*` deref thang `_state["gamification"]`, nen mot
    # store hong la `AttributeError` -> 500 thay vi mot 503 noi ro chuyen gi.
    try:
        _state["gamification"] = GamificationStore(
            settings.pg_conninfo_app(), pool_max=settings.pg_gamification_pool_max
        )
    except Exception as exc:  # pragma: no cover - phu thuoc may chu
        log.error("kho diem khong mo duoc: %s", exc)
        _state["gamification"] = None
    log.info("kho danh tinh: PostgreSQL %s", settings.pg_db_app)
    # Game la TUY CHON: khong dat AIVB_GAME_API_URL thi khong co route `/game`.
    if settings.game_enabled:
        _state["game"] = game_bridge.GameProxy(settings.game_api_url)
        log.info("game: proxy /game/api -> %s", settings.game_api_url)
    if not settings.cookie_secure:
        log.warning(
            "SECURITY: session cookies are NOT marked Secure "
            "(AIVB_COOKIE_SECURE unset). Acceptable for plain-http loopback "
            "development only - set it to 1 behind TLS."
        )
    try:
        n_users = len(_state["auth"].list_users())
        if n_users == 0:
            log.warning(
                "auth store has no accounts; nobody can sign in. Create them with "
                "`python -m backend.admin_cli create-user ...`"
            )
    except Exception as exc:  # pragma: no cover
        log.error("auth store unreadable: %s", exc)

    # Mo TUNG bo du lieu. Mot bo hong khong duoc keo ca dich vu xuong: hoc vien
    # van hoc duoc tren bo con lai, va /datasets se noi ro bo nao dang hong.
    default_name = next(iter(settings.datasets))
    for name, spec in settings.datasets.items():
        entry: dict[str, Any] = {"STUDENT": None, "INSTRUCTOR": None, "error": None}
        try:
            entry["STUDENT"] = Database(settings, role=ROLE_STUDENT, dataset=name)
        except Exception as exc:  # DB chua dung, hoac dang bi khoa
            entry["error"] = f"{type(exc).__name__}: {exc}"
            log.error("dataset %s: student database unavailable: %s", name, entry["error"])
            if name == default_name:
                _state["error"] = entry["error"]

        if spec.db_instructor is not None:
            try:
                entry["INSTRUCTOR"] = Database(
                    settings,
                    expose_restricted=True,
                    role=ROLE_INSTRUCTOR,
                    dataset=name,
                )
            except Exception as exc:
                log.error("dataset %s: instructor database unavailable: %s", name, exc)
        else:
            log.info(
                "dataset %s has no instructor database: INSTRUCTOR sessions are "
                "served the student one (smaller surface, never larger).",
                name,
            )
        _state["datasets"][name] = entry

    # Bi danh cua bo mac dinh.
    _state["db"] = _state["datasets"].get(default_name, {}).get("STUDENT")
    _state["instructor_db"] = _state["datasets"].get(default_name, {}).get("INSTRUCTOR")

    yield
    for entry in _state["datasets"].values():
        for key in ("STUDENT", "INSTRUCTOR"):
            db = entry.get(key)
            if db is not None:
                db.close()
    store = _state.get("auth")
    if store is not None:
        store.close()
    rewards = _state.get("gamification")
    if rewards is not None:
        rewards.close()
    game = _state.get("game")
    if game is not None:
        await game.aclose()


app = FastAPI(
    title="AIV Bank - Student SQL API",
    version=API_VERSION,
    description="Read-only SELECT access to the AIV Bank student dataset.",
    lifespan=lifespan,
)

# Safe by default: an unset AIVB_CORS_ORIGINS means loopback-only, never "*".
# See api/config.py:resolve_cors_policy and API_CONTRACT.md Ãƒâ€šÃ‚Â§12.
_cors = cors_policy_from_env()
for _warning in _cors.warnings:
    log.warning("CORS: %s", _warning)
log.info("CORS policy: mode=%s allow=%s", _cors.mode, _cors.description)

# Cookie authentication needs `allow_credentials` - but never together with a
# wildcard origin. Starlette would then echo whichever origin asked, which is
# every website on the internet holding a valid session cookie. If the operator
# insisted on `*`, credentials stay OFF: cross-origin cookie auth simply will
# not work, which is the correct outcome (fix the config, not the browser).
_allow_credentials = _cors.mode != "wildcard"
if not _allow_credentials:
    log.warning(
        "SECURITY: AIVB_CORS_ORIGINS='*' is incompatible with cookie "
        "authentication; credentials are disabled. Set the real UI origin so "
        "the session cookie can be sent."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_cors.allow_origins),
    allow_origin_regex=_cors.allow_origin_regex,
    allow_credentials=_allow_credentials,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", settings.csrf_header],
)


@app.middleware("http")
async def production_response_headers(request: Request, call_next: Any) -> Any:
    """Apply the same non-cacheable, same-origin policy to API and SPA files.

    The tunnel terminates TLS; FastAPI is the only loopback origin.  Keeping
    these headers here avoids relying on a second proxy to protect static
    content, session responses, or error responses.
    """
    response = await call_next(request)
    # `frontend/vendor/**` la NGOAI LE DUY NHAT, va chi vi no khong thuoc ca hai
    # ve cua cau tren: khong phai API, khong phai ma cua ung dung. Do la thu vien
    # ben thu ba bat bien (DuckDB-WASM, CodeMirror) - khong phien, khong du lieu
    # nguoi dung, doi ban thi doi ca thu muc.
    #
    # Khong co ngoai le nay thi file wasm 34 MB duoc tai lai MOI LAN mot hoc vien
    # mo khu vuc Thuc hanh SQL: do duoc 11,2 giay qua duong ham, moi lan.
    #
    # KHONG noi cho HTML/JS/CSS cua ung dung: ten file chua duoc bam, nen mot lop
    # hoc se chay ma cu sau moi lan cap nhat va khong co gi bao. Doi lai mot lan
    # tai 34 MB thi duoc; doi lai mot lop chay nham ban thi khong.
    path = request.url.path
    in_game = path == "/game" or path.startswith("/game/")
    # `/game/assets/*` do Vite dat ten KEM BAM noi dung, nen cache vinh vien la
    # an toan - khac han HTML/JS cua ung dung chu (xem ngay duoi).
    if path.startswith("/vendor/") or path.startswith("/game/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Game la trang DUY NHAT duoc nhung, va chi vao chinh origin nay (tab Tro
    # choi). Moi trang khac van DENY / frame-ancestors 'none'.
    response.headers["X-Frame-Options"] = "SAMEORIGIN" if in_game else "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # 'wasm-unsafe-eval' exists for ONE feature: the SQL sandbox tab, which runs
    # DuckDB-WASM in the browser so a student's uploaded file never reaches this
    # server.  It is strictly narrower than 'unsafe-eval' -- it permits
    # WebAssembly compilation and nothing else; JS eval() stays blocked.
    #
    # It does not weaken the answer-key defences.  Those live in the PostgreSQL
    # roles/GRANTs and in guard.py, and the sandbox tab touches neither: it has
    # no connection to any teaching database and issues no request to /query.
    #
    # Note what is deliberately ABSENT: no 'blob:' in worker-src.  The DuckDB
    # worker is constructed from its own same-origin file under
    # frontend/vendor/, not from a Blob URL, so default-src 'self' already
    # covers it.  If a future change makes the worker load from a blob, prefer
    # fixing the loader over widening this header.
    response.headers["Content-Security-Policy"] = (
        GAME_CONTENT_SECURITY_POLICY if in_game else CONTENT_SECURITY_POLICY
    )
    return response


@app.exception_handler(ApiError)
async def _api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    if exc.status in (401, 403, 429):
        log.warning(
            "auth refused %s %s code=%s client=%s detail=%s",
            request.method,
            request.url.path,
            exc.code,
            client_ip(request),
            exc.internal,
        )
    return api_error_response(exc)


@app.exception_handler(AuthUnavailable)
async def _auth_unavailable_handler(
    request: Request, exc: AuthUnavailable
) -> JSONResponse:
    """May chu danh tinh khong tra loi -> 503, KHONG phai 401.

    Luoi an toan phu cho moi duong goi vao `AuthStore`, khong rieng `/auth/login`:
    `require_session`, `/auth/password`, va bat ky cho nao ve sau. `_api_error_
    handler` chi log cho 401/403/429 nen 503 can dong log rieng cua no.
    """
    log.error(
        "auth store unavailable %s %s client=%s detail=%s",
        request.method,
        request.url.path,
        client_ip(request),
        exc,
    )
    return api_error_response(
        ApiError(
            503,
            "E_AUTH_UNAVAILABLE",
            "The sign-in service is temporarily unavailable. Please try again "
            "in a moment.",
            headers={"Retry-After": "5"},
            internal=str(exc),
        )
    )


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=ErrorResponse(error_code=code, message=message).model_dump(),
    )


def _db() -> Database | None:
    return _state.get("db")


def _auth() -> AuthStore:
    store = _state.get("auth")
    if store is None:  # pragma: no cover - lifespan always sets it
        raise ApiError(
            503, "E_AUTH_UNAVAILABLE", "The sign-in service is not available."
        )
    return store


def _audit() -> AuditLog:
    audit = _state.get("audit")
    if audit is None:  # pragma: no cover
        return AuditLog(settings.audit_log_path, enabled=False)
    return audit


def _gamification() -> GamificationStore:
    """Kho diem, hoac 503 neu no khong mo duoc luc khoi dong.

    Doi xung voi `_auth()`. Truoc day ba diem goi deref thang
    `_state["gamification"]`, nen mot kho diem hong la `AttributeError` -> 500.
    """
    store = _state.get("gamification")
    if store is None:
        raise ApiError(
            503,
            "E_GAMIFICATION_UNAVAILABLE",
            "The practice-rewards service is not available.",
        )
    return store


def _catalogue() -> "challenge_mod.Catalogue":
    """Ngan hang bai cua khu vuc Luyen SQL. Nap lan dau goi, roi giu.

    Nap luoi chu khong trong lifespan: test va cac app phu dung chung module nay
    khong phai tra gia doc file. File hong thi nem ngay (CatalogueError) thay vi
    phuc vu mot bai khong co dap an - nop mai khong bao gio dung.
    """
    cat = _state.get("challenges")
    if cat is None:
        cat = challenge_mod.load_catalogue(datasets=settings.datasets.keys())
        _state["challenges"] = cat
    return cat


def _challenge_store() -> "challenge_mod.ChallengeStore":
    # Dung CHUNG pool voi kho diem (aivb_app_rw co CONNECTION LIMIT).
    return challenge_mod.ChallengeStore(_gamification()._pool)


# ---------------------------------------------------------------------------
# Auth dependencies
# ---------------------------------------------------------------------------
def db_for_role(role: str, dataset: str | None = None) -> Database | None:
    """Map a session role to a connection.

    This is the whole authorization model in four lines, and it is deliberately
    a lookup rather than a predicate: there is no expression a request can
    influence that turns STUDENT into the instructor connection. If the
    instructor dataset was not configured, an instructor falls back to the
    student connection - less access, never more.
    """
    entry = _state["datasets"].get(dataset or next(iter(settings.datasets), ""))
    if entry is None:
        return None
    if role == ROLE_INSTRUCTOR:
        return entry.get("INSTRUCTOR") or entry.get("STUDENT")
    return entry.get("STUDENT")


def require_session(request: Request) -> Principal:
    """A valid, live session - or 401. Used by every data endpoint."""
    session = session_from_request(request, _auth(), settings.session_cookie_name)
    if session is None:
        raise unauthenticated()
    return principal_from_session(session)


def require_active_session(request: Request) -> Principal:
    """A valid session that is not parked on a forced password change.

    A first-login account can reach /auth/me, /auth/password and /auth/logout
    and nothing else, so an unchanged initial password (which the instructor
    handed out, possibly over a channel that keeps a copy) cannot be used to
    read data.
    """
    principal = require_session(request)
    if principal.must_change_password:
        raise ApiError(
            403,
            "E_PASSWORD_CHANGE_REQUIRED",
            "You must set a new password before using this service. "
            "POST /auth/password with your current and new password.",
        )
    return principal


def require_instructor(request: Request) -> Principal:
    principal = require_active_session(request)
    if not principal.is_instructor:
        # Deliberately not "you are a student": no capability enumeration.
        raise ApiError(
            403,
            "E_FORBIDDEN",
            "This endpoint is not available to your account.",
            internal=f"role={principal.role} attempted instructor endpoint",
        )
    return principal


def csrf_guard(request: Request) -> None:
    enforce_csrf(request, settings.csrf_header)


# ---------------------------------------------------------------------------
# JSON-safe value coercion
# ---------------------------------------------------------------------------
def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        # NaN / Infinity are not valid JSON.
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)


def _fit_response(payload: dict, max_bytes: int) -> dict:
    """Drop trailing rows until the serialized payload fits the size budget."""
    rows = payload.get("rows", [])
    while rows:
        size = len(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"))
        if size <= max_bytes:
            return payload
        keep = max(1, int(len(rows) * 0.6)) if len(rows) > 1 else 0
        rows = rows[:keep]
        payload["rows"] = rows
        payload["row_count"] = len(rows)
        payload["truncated"] = True
        if keep == 0:
            break
    return payload


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
def _role_for_health(request: Request) -> str:
    """The role /health should answer as. Anything unproven means STUDENT.

    /health stays reachable without a session (a load balancer has none), so
    this must never raise: an absent, expired, revoked or malformed cookie, or
    an auth store that is down, all fall through to STUDENT. A session parked on
    a forced password change is treated as STUDENT too - it cannot reach any
    data endpoint yet, so it must not learn anything from /health either.
    """
    try:
        session = session_from_request(
            request, _auth(), settings.session_cookie_name, touch=False
        )
    except Exception:  # pragma: no cover - auth store unavailable
        return ROLE_STUDENT
    if session is None:
        return ROLE_STUDENT
    principal = principal_from_session(session)
    if principal.must_change_password:
        return ROLE_STUDENT
    return principal.role


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> Any:
    """Liveness probe. Public: no session required.

    `table_count` reports the catalog OF THE CALLER'S OWN ROLE, resolved the
    same way every data endpoint resolves it (db_for_role). Two rules:

      * anonymous, or any session we cannot fully validate, sees exactly what
        it saw before - the student catalog. Reporting the instructor number to
        an unauthenticated caller would tell them a second, larger database
        exists, which is the leak this endpoint has always been careful about;
      * an authenticated INSTRUCTOR sees the instructor number, because the
        previous behaviour put "84 tables" on an instructor's screen while
        their own sidebar listed 96 - not a leak (the number was too small),
        but wrong information on the one screen that has to be trusted.
    """
    db = db_for_role(_role_for_health(request))
    healthy = db is not None and db.ping()
    return HealthResponse(
        ok=healthy,
        status="healthy" if healthy else "degraded",
        version=API_VERSION,
        table_count=len(db.catalog.allowed_tables) if db else 0,
        max_rows=settings.max_rows,
        query_timeout_s=settings.query_timeout_s,
    )


# ---------------------------------------------------------------------------
# Authentication endpoints
# ---------------------------------------------------------------------------
@app.post("/auth/login", response_model=SessionInfo)
def login(req: LoginRequest, request: Request, _csrf: None = Depends(csrf_guard)) -> Any:
    store = _auth()
    audit = _audit()
    ip = client_ip(request)
    username = pgroles.normalise_username(req.username)

    # Lockout is checked BEFORE the password is verified, so a locked account
    # costs an attacker a round trip and no scrypt work on our side.
    for scope, key in (("user", username), ("ip", ip)):
        remaining = store.lock_remaining(scope, key)
        if remaining > 0:
            audit.write(
                "login_locked",
                username=username,
                ip=ip,
                scope=scope,
                retry_after_s=round(remaining, 1),
            )
            raise ApiError(
                429,
                "E_RATE_LIMITED",
                f"Too many failed sign-in attempts. Try again in "
                f"{int(remaining) + 1} seconds.",
                headers={"Retry-After": str(int(remaining) + 1)},
                internal=f"locked scope={scope} key={key}",
            )

    # `AuthUnavailable` bay thang ra `_auth_unavailable_handler` -> 503. Bat o
    # day CHI de ghi mot dong audit rieng; tinh chat quan trong la CAU TRUC:
    # exception bay ra nghia la hai `record_failure` ben duoi khong bao gio chay
    # toi. PostgreSQL restart, hay mot vai tro cham `CONNECTION LIMIT` vi Power
    # BI, khong duoc tinh thanh mot lan go sai mat khau. Dung them `finally`.
    try:
        user = store.verify_password(username, req.password)
    except AuthUnavailable:
        audit.write("login_unavailable", username=username, ip=ip)
        raise
    if user is None:
        # Identical response and identical work for "no such user", "disabled"
        # and "wrong password" - see AuthStore.verify_password.
        #
        # Chi ghi throttle theo username khi cai ten CO THE la mot tai khoan:
        # `app.throttle` khong co khoa nao chan, va truoc day mot ke goi bat ky
        # co the chen mot hang moi request bang mot username rac 64 ky tu, tren
        # duong CHUA xac thuc. Throttle theo IP thi VAN luon ghi, nen mot luot
        # quet ten rac van cham nguong IP.
        if pgroles.is_valid_username(username):
            store.record_failure("user", username)
        store.record_failure("ip", ip)
        audit.write("login_failed", username=username, ip=ip)
        raise ApiError(
            401,
            "E_BAD_CREDENTIALS",
            "Incorrect username or password.",
            internal=f"failed login for {username!r} from {ip}",
        )

    store.clear_failures("user", username)
    store.clear_failures("ip", ip)
    store.record_login(user.username)
    store.purge_expired()
    raw_token, session = store.create_session(
        user.username,
        user.role,
        ip=ip,
        user_agent=request.headers.get("user-agent", ""),
    )
    audit.write(
        "login_ok",
        username=user.username,
        role=user.role,
        ip=ip,
        session_id=session.session_id,
        must_change_password=user.must_change_password,
    )

    body = SessionInfo(
        username=user.username,
        role=user.role,
        must_change_password=user.must_change_password,
        expires_at=session.absolute_expires_at,
        idle_timeout_s=settings.session_idle_timeout_s,
        absolute_timeout_s=settings.session_absolute_timeout_s,
    )
    response = JSONResponse(content=body.model_dump())
    set_session_cookie(
        response,
        raw_token,
        cookie_name=settings.session_cookie_name,
        max_age=int(settings.session_absolute_timeout_s),
        secure=settings.cookie_secure,
    )
    return response


@app.post("/auth/logout", response_model=LogoutResponse)
def logout(request: Request, _csrf: None = Depends(csrf_guard)) -> Any:
    """Idempotent: signing out twice, or without a session, is still a 200.

    Revocation is server-side. Deleting the cookie alone would leave a valid
    token in anything that captured it.
    """
    store = _auth()
    raw = request.cookies.get(settings.session_cookie_name)
    revoked = False
    username = None
    if raw:
        session = store.validate_session(raw, touch=False)
        if session is not None:
            username = session.username
            _audit().write(
                "logout",
                username=session.username,
                role=session.role,
                ip=client_ip(request),
                session_id=session.session_id,
            )
        revoked = store.revoke_session(raw)
    response = JSONResponse(
        content=LogoutResponse(
            message="Signed out." if revoked else "No active session."
        ).model_dump()
    )
    clear_session_cookie(response, settings.session_cookie_name, settings.cookie_secure)
    if settings.game_enabled:
        # Phien game song trong cookie `Path=/game` ma trang chinh khong doc
        # duoc, nen chinh endpoint nay xoa ho. Khong xoa thi may dung chung cua
        # phong lab se mo game bang tai khoan nguoi truoc cho toi luc SSO lai.
        for name, path in game_bridge.GAME_COOKIE_PATHS.items():
            response.delete_cookie(
                key=name, path=path, httponly=name != "csrf",
                samesite="strict", secure=settings.cookie_secure,
            )
    log.info("logout user=%s revoked=%s", username or "-", revoked)
    return response


@app.get("/auth/me", response_model=SessionInfo)
def whoami(principal: Principal = Depends(require_session)) -> Any:
    """Who the cookie says you are. Reachable while a password change is
    pending, so the UI can render the change-password screen."""
    return SessionInfo(
        username=principal.username,
        role=principal.role,
        must_change_password=principal.must_change_password,
        expires_at=principal.expires_at,
        idle_timeout_s=settings.session_idle_timeout_s,
        absolute_timeout_s=settings.session_absolute_timeout_s,
    )


@app.post("/auth/password", response_model=PasswordChangeResponse)
def change_password(
    req: PasswordChangeRequest,
    request: Request,
    _csrf: None = Depends(csrf_guard),
    principal: Principal = Depends(require_session),
) -> Any:
    store = _auth()
    audit = _audit()
    ip = client_ip(request)

    remaining = store.lock_remaining("user", principal.username)
    if remaining > 0:
        raise ApiError(
            429,
            "E_RATE_LIMITED",
            f"Too many failed attempts. Try again in {int(remaining) + 1} seconds.",
            headers={"Retry-After": str(int(remaining) + 1)},
        )

    if req.new_password == req.current_password:
        raise ApiError(
            400, "E_WEAK_PASSWORD", "The new password must differ from the current one."
        )
    try:
        validate_password_strength(req.new_password, principal.username)
    except AuthError as exc:
        raise ApiError(400, "E_WEAK_PASSWORD", str(exc)) from exc

    # `change_own_password` mo mot ket noi PostgreSQL bang CHINH tai khoan nay
    # roi chay `ALTER ROLE CURRENT_USER PASSWORD`. Mot vai tro luon tu doi duoc
    # mat khau cua no, nen tien trinh nay KHONG can `CREATEROLE` - do la ly do
    # bo SQLite khong keo theo viec phai cap quyen quan tri cho web app.
    #
    # Ket noi do dong thoi la phep kiem mat khau hien tai: khong noi duoc nghia
    # la sai. Vi vay khong con loi goi `verify_password` rieng o day.
    if not store.change_own_password(
        principal.username, req.current_password, req.new_password
    ):
        # Cung bo dem voi /auth/login: endpoint nay khong duoc tro thanh duong
        # do mat khau vong qua khoa dang nhap.
        store.record_failure("user", principal.username)
        audit.write("password_change_failed", username=principal.username, ip=ip)
        raise ApiError(401, "E_BAD_CREDENTIALS", "Your current password is incorrect.")

    store.clear_failures("user", principal.username)

    # Rotate: every session that existed under the old password dies, including
    # this one, and a fresh token is issued to the caller. That covers both the
    # forced-first-change case and "I think someone saw my password".
    revoked = store.revoke_all_sessions(principal.username)
    raw_token, session = store.create_session(
        principal.username,
        principal.role,
        ip=ip,
        user_agent=request.headers.get("user-agent", ""),
    )
    audit.write(
        "password_changed",
        username=principal.username,
        role=principal.role,
        ip=ip,
        session_id=session.session_id,
        sessions_revoked=revoked,
    )
    response = JSONResponse(
        content=PasswordChangeResponse(
            message="Password updated.", sessions_revoked=revoked
        ).model_dump()
    )
    set_session_cookie(
        response,
        raw_token,
        cookie_name=settings.session_cookie_name,
        max_age=int(settings.session_absolute_timeout_s),
        secure=settings.cookie_secure,
    )
    return response


@app.get("/audit/recent", response_model=AuditEntryResponse)
def recent_audit(
    limit: int = 100, principal: Principal = Depends(require_instructor)
) -> Any:
    """Append-only query log. INSTRUCTOR only - it names other people."""
    entries = _audit().tail(limit)
    return AuditEntryResponse(count=len(entries), entries=entries)


@app.get("/gamification/me", response_model=GamificationResponse)
def gamification_me(principal: Principal = Depends(require_active_session)) -> Any:
    return GamificationResponse(summary=_gamification().summary(principal.username))

@app.get("/gamification/leaderboard", response_model=LeaderboardResponse)
def gamification_leaderboard(period: str = "all", principal: Principal = Depends(require_active_session)) -> Any:
    if period not in {"day", "week", "month", "all"}:
        raise ApiError(400, "E_INVALID_PERIOD", "Period must be day, week, month or all.")
    # Bang xep hang la cua HOC VIEN DANG HOC. Danh sach CHO PHEP, khong phai
    # danh sach loai tru - va su khac biet la thuc chat:
    #
    #   - Giang vien luyen tap tren cung he thong (va phai the, de thu bai truoc
    #     khi giao), nen ho CO diem. Diem do khong thuoc ve bang thi dua cua lop.
    #   - kho diem giu theo TEN, khong co khoa ngoai toi tai
    #     khoan. Xoa mot tai khoan khong xoa diem cua no. Mot danh sach loai tru
    #     chi chan duoc nhung ai auth store CON BIET, nen ten mo coi - ke ca ten
    #     cua giang vien cu - se o lai bang mai mai.
    #
    # Loc o DAY chu khong o giao dien: mot bang, mot su that, giong nhau voi moi
    # vai tro. De giao dien tu loc thi hai phien hien hai bang khac nhau va khong
    # ai biet ben nao dung.
    #
    # `gamification` khong tu tra duoc dieu nay: no doc bang diem trong schema
    # `app`, con vai tro suy tu `pg_auth_members`. Chinh sach thuoc ve endpoint.
    # MOT truy van co chi muc, thay cho `list_users()` + mot `get_user` cho tung
    # nguoi (moi cai muon mot ket noi rieng) tren MOI request bang xep hang.
    students = _auth().active_usernames(ROLE_STUDENT)
    return LeaderboardResponse(
        period=period,
        entries=_gamification().leaderboard(period, only=students),
    )

# ---------------------------------------------------------------------------
# Luyen SQL (bai tap kieu HackerRank) - backend/challenges.py
#
# Dap an (`reference_sql`, `expected_state_sql`) KHONG BAO GIO nam trong mot
# response: moi endpoint o day chi tra `Challenge.public()` va con so cham bai.
# Dataset cua mot bai do MAY CHU gan theo domain cua bai, khong nhan tu client.
# ---------------------------------------------------------------------------


def _challenge_or_404(challenge_id: str):
    ch = _catalogue().get(challenge_id)
    if ch is None:
        raise ApiError(404, "E_UNKNOWN_CHALLENGE", "This challenge does not exist.")
    return ch


def _challenge_db(principal: Principal, ch) -> Database:
    db = db_for_role(principal.role, ch.dataset)
    if db is None:
        raise ApiError(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    return db


#: (dataset, sql) -> (thoi diem, ket qua). Dap an chi doi khi du lieu duoc nap
#: lai (restore), nen giu mot gio: bai nang nhat (A3, ~4s) khong phai chay lai
#: dap an cho moi lan nop cua ca lop.
_TRUSTED_CACHE: dict[tuple[str, str], tuple[float, Any]] = {}
_TRUSTED_TTL_S = 3600.0


def _run_trusted(db: Database, sql: str):
    """Chay cau dap an: KHONG qua guard (no la cua may chu), nhung van tren ket
    noi chi-doc, co timeout, va trong `slot()` nhu moi truy van khac."""
    key = (db.dataset, sql)
    hit = _TRUSTED_CACHE.get(key)
    if hit and time.monotonic() - hit[0] < _TRUSTED_TTL_S:
        return hit[1]
    with db.slot():
        result = db.execute(sql, timeout_s=settings.query_timeout_s, row_limit=challenge_mod.MAX_COMPARE_ROWS)
    _TRUSTED_CACHE[key] = (time.monotonic(), result)
    return result


@app.get("/challenges", response_model=ChallengeListResponse)
def list_challenges(
    domain: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    cat = _catalogue()
    try:
        solved = _challenge_store().solved(principal.username)
    except Exception:  # noqa: BLE001
        # Kho diem hong, hoac chua chay database/schema/20_challenges.sql:
        # van xem va lam duoc bai, chi chua luu tien do.
        log.warning("challenge progress unavailable", exc_info=True)
        solved = {}
    items = cat.list(domain)
    mine = [c for c in items if c.id in solved]
    return ChallengeListResponse(
        domains=list(cat.domains.values()),
        challenges=[
            {k: v for k, v in c.public(solved=c.id in solved).items()
             if k in ("id", "domain", "level", "points", "title", "topic", "kind", "solved")}
            for c in items
        ],
        my_points=sum(solved[c.id]["points"] for c in mine),
        my_solved=len(mine),
    )


@app.get("/challenges/leaderboard", response_model=ChallengeLeaderboardResponse)
def challenge_leaderboard(
    domain: str = "scm",
    principal: Principal = Depends(require_active_session),
) -> Any:
    # Cung luat voi /gamification/leaderboard: CHI hoc vien dang hoat dong.
    students = _auth().active_usernames(ROLE_STUDENT)
    return ChallengeLeaderboardResponse(
        domain=domain,
        entries=_challenge_store().leaderboard(
            domain, only=students, live_ids=[c.id for c in _catalogue().list(domain)]
        ),
    )


@app.get("/challenges/{challenge_id}", response_model=ChallengeDetailResponse)
def challenge_detail(
    challenge_id: str,
    principal: Principal = Depends(require_active_session),
) -> Any:
    ch = _challenge_or_404(challenge_id)
    try:
        solved = ch.id in _challenge_store().solved(principal.username)
    except Exception:  # noqa: BLE001 - xem challenges list
        solved = False
    return ChallengeDetailResponse(challenge=ch.public(solved=solved))


@app.get("/challenges/{challenge_id}/sample", response_model=ChallengeSampleResponse)
def challenge_sample(
    challenge_id: str,
    principal: Principal = Depends(require_active_session),
) -> Any:
    """Ban sao nho cho bai dml. Day la DE BAI (du lieu dau vao), khong phai dap an."""
    ch = _challenge_or_404(challenge_id)
    if ch.kind != "dml":
        raise ApiError(400, "E_NOT_DML", "This challenge has no sample table.")
    result = _run_trusted(_challenge_db(principal, ch), ch.sample_sql)
    return ChallengeSampleResponse(
        table=ch.sample_table,
        columns=result.columns,
        column_types=result.column_types,
        rows=[[_jsonable(v) for v in row] for row in result.rows],
    )


@app.post("/challenges/{challenge_id}/submit", response_model=ChallengeSubmitResponse)
def challenge_submit(
    challenge_id: str,
    req: ChallengeSubmitRequest,
    _csrf: None = Depends(csrf_guard),
    principal: Principal = Depends(require_active_session),
) -> Any:
    ch = _challenge_or_404(challenge_id)
    db = _challenge_db(principal, ch)
    try:
        if ch.kind == "select":
            if not (req.sql or "").strip():
                return _err(400, "E_EMPTY", "Write a query before submitting.")
            # Cau cua hoc vien di DUNG con duong cua /query: guard, slot, timeout.
            with db.slot():
                validated = validate(
                    req.sql,
                    db.catalog,
                    db.function_policy,
                    max_sql_chars=settings.max_sql_chars,
                    row_limit=challenge_mod.MAX_COMPARE_ROWS,
                )
                yours = db.execute(
                    validated.sql,
                    timeout_s=settings.query_timeout_s,
                    row_limit=challenge_mod.MAX_COMPARE_ROWS,
                )
            expected = _run_trusted(db, ch.reference_sql)
            your_cols, your_rows = yours.columns, yours.rows
            hashed = challenge_mod.sql_hash(req.sql)
        else:
            state = req.state or {}
            your_cols = list(state.get("columns") or [])
            your_rows = list(state.get("rows") or [])
            if not your_cols or len(your_cols) > challenge_mod.MAX_STATE_COLS or len(your_rows) > challenge_mod.MAX_STATE_ROWS:
                return _err(400, "E_BAD_STATE", "Submit the edited sample table (load it first).")
            expected = _run_trusted(db, challenge_mod.expected_state_query(ch))
            hashed = challenge_mod.sql_hash(json.dumps(your_rows, default=str)[:20000])
    except GuardRejection as rej:
        return _err(400, rej.code, rej.message)
    except ServiceBusy as exc:
        return _err(503, "E_SERVICE_BUSY", str(exc))
    except QueryTimeout as exc:
        return _err(408, "E_TIMEOUT", str(exc))
    except QueryFailed as exc:
        return _err(400, "E_QUERY_FAILED", exc.message)

    verdict = challenge_mod.compare(
        your_cols, your_rows, expected.columns, expected.rows,
        order_matters=ch.order_matters, tol=ch.float_tol,
    )
    try:
        progress = _challenge_store().record(
            principal.username, ch, verdict["passed"], hashed,
            live_ids=[c.id for c in _catalogue().list(ch.domain)],
        )
    except Exception:
        log.exception("challenge progress write failed; verdict still returned")
        progress = {"points_awarded": 0, "already_solved": False, "domain_points": 0,
                    "domain_solved": 0, "progress_saved": False}
    return ChallengeSubmitResponse(
        **verdict,
        **progress,
        takeaway=ch.takeaway if verdict["passed"] else None,
    )


@app.get("/admin/analytics/queries", response_model=InstructorAnalyticsResponse)
def instructor_analytics(principal: Principal = Depends(require_instructor)) -> Any:
    entries = _audit().tail(5000)
    query_entries = [entry for entry in entries if entry.get("event") == "query"]
    successful = [entry for entry in query_entries if not entry.get("blocked")]
    blocked = [entry for entry in query_entries if entry.get("blocked")]
    by_error: dict[str, int] = {}
    by_table: dict[str, int] = {}
    for entry in blocked:
        code = str(entry.get("error_code") or "unknown")
        by_error[code] = by_error.get(code, 0) + 1
    for entry in successful:
        for table in entry.get("tables", []) or []:
            by_table[table] = by_table.get(table, 0) + 1
    users = {str(entry.get("username")) for entry in query_entries if entry.get("username")}
    summary = {
        "query_count": len(query_entries),
        "successful_count": len(successful),
        "blocked_count": len(blocked),
        "active_users": len(users),
        "average_elapsed_ms": round(sum(float(e.get("elapsed_ms", 0) or 0) for e in successful) / len(successful), 2) if successful else 0,
        "top_errors": sorted(({"code": k, "count": v} for k, v in by_error.items()), key=lambda x: (-x["count"], x["code"]))[:10],
        "top_tables": sorted(({"name": k, "count": v} for k, v in by_table.items()), key=lambda x: (-x["count"], x["name"]))[:10],
    }
    return InstructorAnalyticsResponse(summary=summary, recent=entries[-50:])
# ---------------------------------------------------------------------------
# Data endpoints (session required)
# ---------------------------------------------------------------------------
@app.get("/schema/tables", response_model=TableListResponse)
def list_tables(
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    tables = db.catalog.list_tables()
    return TableListResponse(
        table_count=len(tables),
        tables=[TableSummary(name=t.name, column_count=len(t.columns)) for t in tables],
    )


@app.get("/datasets", response_model=DatasetListResponse)
def list_datasets(principal: Principal = Depends(require_active_session)) -> Any:
    """Cac bo du lieu phien nay dung duoc.

    Frontend goi day de dung thanh dieu huong. No KHONG duoc tu doan danh sach:
    cung mot ly do voi quy tac "khong hardcode ten bang" - danh sach nay do may
    chu quyet, va mot bo du lieu khong mo duoc phai hien ra la khong mo duoc chu
    khong bien mat.
    """
    out: list[DatasetSummary] = []
    for name, spec in settings.datasets.items():
        db = db_for_role(principal.role, name)
        out.append(
            DatasetSummary(
                name=name,
                label=spec.label,
                currency=spec.currency,
                table_count=len(db.catalog.allowed_tables) if db is not None else 0,
                available=db is not None,
            )
        )
    return DatasetListResponse(default=next(iter(settings.datasets)), datasets=out)


@app.get("/schema", response_model=SchemaResponse)
def full_schema(
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    tables = db.catalog.list_tables()
    return SchemaResponse(
        table_count=len(tables),
        tables=[
            TableDetail(
                name=t.name,
                columns=[
                    ColumnOut(
                        name=c.name,
                        type=c.duckdb_type,
                        nullable=c.nullable,
                        primary_key=c.is_primary_key,
                    )
                    for c in t.columns
                ],
            )
            for t in tables
        ],
    )


@app.get("/schema/relationships", response_model=RelationshipsResponse)
def schema_relationships(
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    """Cac canh FK cho so do ERD cua bo du lieu.

    Loc bang `Catalog.relationships`: mot canh chi ra ngoai khi CA HAI dau deu
    la bang ma phien nay thay trong GET /schema. Canh cham bang bi giu lai thi
    khong ton tai, cung nguyen tac "khong co oracle" voi /schema/tables/{name}.
    """
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    return RelationshipsResponse(
        relationships=[
            RelationshipOut(
                from_table=src,
                from_columns=list(fk.columns),
                to_table=fk.ref_table,
                to_columns=list(fk.ref_columns),
            )
            for src, fk in db.catalog.relationships()
        ]
    )


@app.get("/schema/game", response_model=GameSchemaResponse)
def schema_game(principal: Principal = Depends(require_active_session)) -> Any:
    """So do `jelly_analytics` cua database game, chi nhung gi lop hoc doc duoc.

    Console khong chay truy van tren database nay; hoc vien dung psql / Power BI
    qua cong 5433. Xem backend/game_schema.py.
    """
    try:
        gs = game_schema.load_game_schema(settings)
    except game_schema.GameSchemaUnavailable as exc:
        log.warning("game schema unavailable: %s", exc)
        return _err(503, "E_GAME_UNAVAILABLE", "The game database is not available right now.")
    return GameSchemaResponse(
        schema_name=gs.schema,
        tables=[
            GameTableOut(
                name=t.name,
                kind=t.kind,
                columns=[
                    ColumnOut(name=c.name, type=c.type, nullable=c.nullable, primary_key=c.primary_key)
                    for c in t.columns
                ],
            )
            for t in gs.tables
        ],
        relationships=[
            RelationshipOut(
                from_table=e.from_table,
                from_columns=list(e.from_columns),
                to_table=e.to_table,
                to_columns=list(e.to_columns),
                inferred=e.inferred,
            )
            for e in gs.relationships
        ],
    )


@app.get("/schema/marts", response_model=MartListResponse)
def list_marts(
    include_row_count: bool = False,
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    """Describe role-visible analytical mart tables only."""
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    marts = [table for table in db.catalog.list_tables() if table.name.startswith("mart_")]
    return MartListResponse(
        mart_count=len(marts),
        marts=[
            MartSummary(
                name=table.name,
                column_count=len(table.columns),
                row_count=db.table_row_count(table.name) if include_row_count else None,
            )
            for table in marts
        ],
    )

@app.get("/schema/marts/{mart_name}", response_model=TableDetailResponse)
def mart_detail(
    mart_name: str,
    include_row_count: bool = False,
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    """Return columns for one role-visible mart, if it exists."""
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    info = db.catalog.get(mart_name)
    if info is None or not info.name.startswith("mart_"):
        return _err(
            404,
            "E_UNKNOWN_TABLE",
            f"Table '{mart_name}' does not exist or is not available in this dataset.",
        )
    return TableDetailResponse(
        name=info.name,
        columns=[
            ColumnOut(
                name=column.name,
                type=column.duckdb_type,
                nullable=column.nullable,
                primary_key=column.is_primary_key,
            )
            for column in info.columns
        ],
        row_count=db.table_row_count(info.name) if include_row_count else None,
    )

@app.get("/schema/tables/{table_name}", response_model=TableDetailResponse)
def table_detail(
    table_name: str,
    include_row_count: bool = False,
    dataset: str | None = None,
    principal: Principal = Depends(require_active_session),
) -> Any:
    db = db_for_role(principal.role, dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")
    info = db.catalog.get(table_name)
    if info is None:
        # Identical response for "typo" and "withheld table". No oracle.
        return _err(
            404,
            "E_UNKNOWN_TABLE",
            f"Table '{table_name}' does not exist or is not available in this dataset.",
        )
    return TableDetailResponse(
        name=info.name,
        columns=[
            ColumnOut(
                name=c.name,
                type=c.duckdb_type,
                nullable=c.nullable,
                primary_key=c.is_primary_key,
            )
            for c in info.columns
        ],
        row_count=db.table_row_count(info.name) if include_row_count else None,
    )


@app.post("/query", response_model=QueryResponse)
def run_query(
    req: QueryRequest,
    request: Request,
    _csrf: None = Depends(csrf_guard),
    principal: Principal = Depends(require_active_session),
) -> Any:
    # Bo du lieu den tu BODY o day, khong phai query string, vi no thuoc ve mo ta
    # cua chinh lan chay - va vi no phai duoc ghi vao audit cung voi cau SQL.
    db = db_for_role(principal.role, req.dataset)
    if db is None:
        return _err(503, "E_DB_UNAVAILABLE", "The dataset is not available right now.")

    row_limit = settings.max_rows
    if req.max_rows is not None:
        row_limit = max(1, min(req.max_rows, settings.max_rows))

    client_host = client_ip(request)
    audit = _audit()
    started_wall = time.perf_counter()

    def _audit_query(**extra: Any) -> None:
        audit.write(
            "query",
            username=principal.username,
            role=principal.role,
            session_id=principal.session_id,
            ip=client_host,
            sql=req.sql,
            total_ms=round((time.perf_counter() - started_wall) * 1000, 2),
            **extra,
        )

    try:
        # Admission control covers validation (CPU) and execution alike.
        with db.slot():
            guard_started = time.perf_counter()
            try:
                validated = validate(
                    req.sql,
                    db.catalog,
                    db.function_policy,
                    max_sql_chars=settings.max_sql_chars,
                    row_limit=row_limit,
                )
            finally:
                guard_ms = (time.perf_counter() - guard_started) * 1000
                if guard_ms > 1000:
                    # Telemetry for an unknown parser pathology getting past
                    # the complexity limits. Should never fire in practice.
                    log.error("SLOW GUARD %.0fms client=%s", guard_ms, client_host)

            # Optional watch list, empty by default since the 2026-08-04
            # ruling turned `dirty_flag` from "log it" into "refuse it".
            # Detection only: the query is contract-legal and runs normally and
            # the response is byte-identical either way, so this can never
            # become an oracle. See config.audit_columns.
            flagged = sorted(set(validated.columns) & settings.audit_columns)
            if flagged:
                log.warning(
                    "AUDIT watched column used: columns=%s tables=%s "
                    "client=%s sql=%s",
                    flagged,
                    list(validated.tables),
                    client_host,
                    validated.inner_sql[:500],
                )

            result = db.execute(
                validated.sql, timeout_s=settings.query_timeout_s, row_limit=row_limit
            )
    except GuardRejection as rej:
        log.warning(
            "guard rejected code=%s user=%s client=%s detail=%s",
            rej.code,
            principal.username,
            client_host,
            rej.internal,
        )
        _audit_query(blocked=True, error_code=rej.code, reason=rej.internal)
        return _err(400, rej.code, rej.message)
    except ServiceBusy as exc:
        _audit_query(blocked=True, error_code="E_SERVICE_BUSY", reason="admission control")
        return _err(503, "E_SERVICE_BUSY", str(exc))
    except QueryTimeout as exc:
        _audit_query(blocked=True, error_code="E_TIMEOUT", reason="query timeout")
        return _err(408, "E_TIMEOUT", str(exc))
    except QueryFailed as exc:
        log.warning("engine error: %s", exc.internal)
        _audit_query(blocked=True, error_code="E_QUERY_FAILED", reason=exc.internal)
        return _err(400, "E_QUERY_FAILED", exc.message)
    except RecursionError:
        _audit_query(blocked=True, error_code="E_TOO_COMPLEX", reason="recursion limit")
        return _err(400, "E_TOO_COMPLEX", "The query is too deeply nested.")
    except Exception:  # pragma: no cover
        log.exception("unexpected execution failure")
        _audit_query(blocked=True, error_code="E_INTERNAL", reason="unexpected failure")
        return _err(500, "E_INTERNAL", "An internal error occurred.")

    _audit_query(
        blocked=False,
        row_count=result.row_count,
        truncated=result.truncated,
        elapsed_ms=result.elapsed_ms,
        tables=list(validated.tables),
    )

    try:
        gamification = _gamification().record_success(principal.username, req.sql, list(validated.tables))
    except Exception:
        log.exception("gamification write failed; query result remains successful")
        gamification = None

    payload = QueryResponse(
        columns=result.columns,
        column_types=result.column_types,
        rows=[[_jsonable(v) for v in row] for row in result.rows],
        row_count=result.row_count,
        truncated=result.truncated,
        row_limit=row_limit,
        elapsed_ms=result.elapsed_ms,
        tables_used=list(validated.tables),
        executed_sql=validated.inner_sql,
        gamification=gamification,
    ).model_dump()

    return JSONResponse(content=_fit_response(payload, settings.max_response_bytes))


#: duong dan ban .gz -> co dung voi ban goc khong. Kiem mot lan roi nho.
_GZIP_OK: dict[str, bool] = {}


def _gzip_matches(source: Path, packed: Path) -> bool:
    """Ban `.gz` co dung la ban nen cua `source` khong.

    KHONG so mtime. `frontend/vendor/` duoc commit co chu y (xem .gitignore muc
    3), va **git khong giu mtime**: sau mot lan clone thi hai file co dau thoi
    gian gan nhu bang nhau, thu tu khong xac dinh, va mot phep kiem `>=` se
    thinh thoang tra ve sai - luc do may chu lang le quay ve ban 32,7 MB va khong
    ai biet vi sao lop hoc cham.

    Bon byte cuoi cua mot tep gzip la kich thuoc SAU khi giai nen (mod 2^32).
    Doc chung la O(1) va tra loi dung cau hoi: ban nen nay co khop ban goc khong.
    """
    if not packed.is_file():
        return False
    key = str(packed)
    cached = _GZIP_OK.get(key)
    if cached is not None:
        return cached
    try:
        with packed.open("rb") as fh:
            fh.seek(-4, os.SEEK_END)
            declared = int.from_bytes(fh.read(4), "little")
        ok = declared == (source.stat().st_size % (1 << 32))
    except OSError:
        ok = False
    if not ok:
        log.warning(
            "vendor: bo qua %s (khong khop ban goc). Chay scripts/build_vendor_gz.py",
            packed.name,
        )
    _GZIP_OK[key] = ok
    return ok


# ---------------------------------------------------------------------------
# Game "Vuong Quoc Keo Ngot" (tab Tro choi) - xem backend/game_bridge.py
# ---------------------------------------------------------------------------
def _game() -> game_bridge.GameProxy:
    proxy = _state.get("game")
    if proxy is None:
        raise ApiError(404, "E_GAME_DISABLED", "Trò chơi chưa được bật trên máy chủ này.")
    return proxy


@app.get("/game-sso/status", include_in_schema=False)
def game_status() -> Any:
    """Giao dien hoi co nen hien tab Tro choi khong. Khong can dang nhap."""
    return {"enabled": settings.game_enabled and settings.game_dist_dir.is_dir()}


@app.post("/game-sso/token", include_in_schema=False)
def game_sso_token(
    _csrf: None = Depends(csrf_guard),
    principal: Principal = Depends(require_active_session),
) -> Any:
    """Cap ve SSO (60 giay, dung mot lan) cho nguoi dang dang nhap.

    `require_active_session`: nguoi con phai doi mat khau lan dau thi CHUA
    duoc vao game - giong moi chuc nang khac ngoai trang doi mat khau.
    """
    _game()
    try:
        secret = settings.game_sso_secret()
    except (OSError, KeyError, ValueError) as exc:
        log.error("game: khong doc duoc AIVB_SSO_SECRET: %s", exc)
        raise ApiError(503, "E_GAME_UNAVAILABLE", "Trò chơi tạm thời không dùng được.") from None
    user = _auth().get_user(principal.username)
    ticket = game_bridge.sign_ticket(
        username=principal.username,
        full_name=user.full_name if user else "",
        role=principal.role,
        secret=secret,
    )
    return {"ticket": ticket}


# Xac thuc cua `/game/api/*` la PHIEN GAME (cookie `session` Path=/game, game
# tu kiem). Rieng lop CSRF thi AIV Bank giu them mot lop: moi request ghi phai
# mang `X-AIVB-Client` (game gui no khi chay duoi /game/), giong moi POST khac
# cua ung dung nay - chong lai trang la gui form vao game qua cookie cua nguoi hoc.
@app.api_route("/game/api/{path:path}", methods=["GET"], include_in_schema=False)
async def game_api_read(path: str, request: Request) -> Any:
    return await _game().forward(request, path)


@app.api_route(
    "/game/api/{path:path}",
    methods=["POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def game_api_write(
    path: str, request: Request, _csrf: None = Depends(csrf_guard)
) -> Any:
    return await _game().forward(request, path)


if settings.game_enabled and settings.game_dist_dir.is_dir():
    app.mount(
        "/game",
        StaticFiles(directory=str(settings.game_dist_dir), html=True),
        name="game",
    )
elif settings.game_enabled:
    log.warning(
        "game: AIVB_GAME_API_URL da dat nhung khong thay ban build %s - tab Tro choi se an",
        settings.game_dist_dir,
    )


# HEAD cung phai o day, khong chi GET: thieu no thi mot yeu cau HEAD roi xuong
# StaticFiles ben duoi va bao ve content-length cua ban KHONG nen - hai cau
# tra loi khac nhau cho cung mot dia chi, va cong cu chan doan noi doi.
@app.api_route("/vendor/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def vendor_asset(asset_path: str, request: Request) -> Any:
    """Phuc vu file vendor, uu tien ban da nen san `<ten>.gz`.

    VI SAO CAN, va vi sao rieng `Cache-Control` khong du:
    File `duckdb-eh.wasm` nang 32,7 MB. Da dat `max-age=31536000, immutable` cho
    ca thu muc nay, va do duoc: file 227 KB cung thu muc thi trinh duyet cache
    (`transferSize = 0` o lan hai), con file 32,7 MB thi KHONG - Chrome tu choi
    cache mot muc lon hon khoang 1/8 dung luong cache dia. Cung header, cung thu
    muc, chi khac kich thuoc.
    Nen dua vao cache thoi la de hoc vien tai lai 32,7 MB moi lan.

    gzip dua no ve 7,3 MB (con 22%). Do la thu co tac dung o MOI lan vao, khong
    phu thuoc vao cache, va khong phai noi CSP.

    Ban nen duoc sinh boi `scripts/build_vendor_gz.py`. Thieu no thi ham nay lang
    le phuc vu ban goc - cham hon, nhung khong bao gio hong.
    """
    base = (settings.frontend_dir / "vendor").resolve()
    target = (base / asset_path).resolve()
    # Chan di nguoc thu muc. `resolve()` roi so tien to la phep kiem that; ghep
    # chuoi roi tin vao no thi `..%2f..` di thang ra ngoai frontend/.
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(status_code=404)

    packed = target.with_name(target.name + ".gz")
    accepts_gzip = "gzip" in request.headers.get("accept-encoding", "").lower()
    if accepts_gzip and _gzip_matches(target, packed):
        return FileResponse(
            packed,
            media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
            headers={
                "Content-Encoding": "gzip",
                "Vary": "Accept-Encoding",
                # Kich thuoc SAU giai nen. Trinh duyet giai nen trong suot, nen
                # `Content-Length` la so byte NEN con moi bo dem tien trinh lai
                # dem byte DA GIAI NEN - ty le hai so do vo nghia, va thanh tien
                # trinh nhay len 100% ngay tu goi dau roi dung im suot ca lan tai.
                # Mot thanh ghim o 100% con lam nguoi dung hoang mang hon la khong
                # co thanh nao. frontend/sandbox.js doc dong nay de lay tong dung.
                "X-Uncompressed-Length": str(target.stat().st_size),
            },
        )
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
        headers={"Vary": "Accept-Encoding"},
    )


# This must remain last: API routes above take precedence, while all browser
# assets are served by the same FastAPI process as the authenticated API.  The
# directory is repository-owned/read-only at deployment time; credentials and
# releases are deliberately elsewhere (see config.STUDENT_FACING_DIRS).
app.mount("/", StaticFiles(directory=str(settings.frontend_dir), html=True), name="web")
