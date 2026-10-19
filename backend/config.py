"""Runtime configuration for the AIV Bank student SQL API.

Every path / limit is environment driven. Nothing about the database layout is
hardcoded: the DB path comes from AIVB_DB_PATH and the permission truth comes
from the column contract JSON at AIVB_CONTRACT_PATH.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path

from psycopg.conninfo import make_conninfo

# `app/` - moi thu ung dung can luc chay deu nam duoi day. Doi ten thu muc `app`
# hay chuyen no sang may khac deu khong anh huong: moi duong dan mac dinh o duoi
# deu tinh tu APP_ROOT chu khong tu mot vi tri co dinh nao.
APP_ROOT = Path(__file__).resolve().parent.parent

# Giu ten cu de khong pha ma da tham chieu. Hai ten tro cung mot cho.
REPO_ROOT = APP_ROOT

# Goc kho ma nguon, CHI dung cho vai duong dan lich su nam ngoai `app/`
# (`_workspace/`). Neu chi trien khai `app/` thi cac duong dan do khong ton tai,
# va do la binh thuong - chung deu co bien moi truong de tro di cho khac.
PROJECT_ROOT = APP_ROOT.parent

# Default target is the student export. It may not exist yet while the
# generator engineer is still building it; use AIVB_DB_PATH to point elsewhere.
DEFAULT_DB_PATH = PROJECT_ROOT / "_workspace" / "output" / "student.duckdb"

# Hop dong cot la thu ung dung BAT BUOC phai co luc chay (catalog.py bao
# CatalogError neu thieu), nen ban mac dinh nam TRONG `app/`. Ban o `_workspace/`
# la ban goc do generator sinh ra; ban o day la ban sao dong bang
# `app/database/sync_contract.py`.
DEFAULT_CONTRACT_PATH = APP_ROOT / "backend" / "contract" / "column-contract.json"
DEFAULT_OWNER_CONFIG_PATH = APP_ROOT / "backend" / "contract" / "owner-config.json"

# Thu muc frontend duoc phuc vu tinh. Tach thanh bien rieng vi day chinh la
# diem thay the: dung frontend khac chi can build ra mot thu muc roi tro
# AIVB_FRONTEND_DIR vao do - khong sua mot dong backend nao.
DEFAULT_FRONTEND_DIR = APP_ROOT / "frontend"

DEFAULT_AUDIT_LOG_PATH = APP_ROOT / "var" / "auth" / "audit.jsonl"

# Directories whose contents are handed to students. Nothing credential-shaped
# may live under any of them.
#
# `_workspace/release` van nam trong danh sach du no o ngoai `app/`: khi trien
# khai chi rieng `app/` thi duong dan do khong ton tai va phep kiem lang le bo
# qua, nhung khi chay trong kho day du thi no van bat duoc kho xac thuc dat nham
# vao goi giao cho hoc vien.
STUDENT_FACING_DIRS = (
    PROJECT_ROOT / "_workspace" / "release",
    APP_ROOT / "frontend",
)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


# --------------------------------------------------------------------------
# CORS policy
# --------------------------------------------------------------------------
# Any http(s) origin on the loopback interface, with any port. This is the
# fallback when AIVB_CORS_ORIGINS is not set: a developer running
# `python frontend/serve.py` (127.0.0.1:5173) keeps working, while a page served
# from a remote host cannot read this API out of a student's browser.
LOCALHOST_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


# Content-Security-Policy
# --------------------------------------------------------------------------
# Sent on EVERY response, API and static alike. It lives here rather than
# inline in the middleware so a test can pin it: a security header that nothing
# asserts on is a header that quietly drifts.
#
# 'wasm-unsafe-eval' exists for ONE feature: the SQL sandbox tab, which runs
# DuckDB-WASM in the browser so that a file a student uploads never reaches
# this server. It is strictly narrower than 'unsafe-eval' -- it permits
# WebAssembly compilation and nothing else; JS eval() stays blocked.
#
# It does not weaken the answer-key defences. Those live in the PostgreSQL
# roles/GRANTs and in guard.py, and the sandbox touches neither: it holds no
# connection to any teaching database and issues no request to /query.
#
# Note what is deliberately ABSENT: no `blob:` in worker-src. The DuckDB worker
# is constructed from its own same-origin file under frontend/vendor/, not from
# a Blob URL, so `default-src 'self'` already covers it. If a future change
# makes the worker load from a blob, fix the loader rather than widen this.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; "
    "frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; "
    "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'"
)

# CSP rieng cho `/game/*` (game match-3 nhung trong tab Tro choi):
#   * `frame-ancestors 'self'` - duoc nhung, nhung CHI boi chinh origin nay;
#   * KHONG 'wasm-unsafe-eval' - game khong can;
#   * `worker-src blob:` - canvas-confetti dung Web Worker tu Blob URL (no tu
#     lui ve luong chinh neu bi chan, nhung de lai mot loi CSP moi lan thang);
#   * `media-src data: blob:` - am thanh sinh bang Web Audio.
GAME_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; "
    "frame-ancestors 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; "
    "object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "worker-src 'self' blob:"
)


@dataclass(frozen=True)
class CorsPolicy:
    """Resolved CORS configuration, plus what to tell the operator about it."""

    allow_origins: tuple[str, ...] = ()
    allow_origin_regex: str | None = None
    # "localhost-default" | "explicit" | "wildcard"
    mode: str = "localhost-default"
    warnings: tuple[str, ...] = ()

    @property
    def description(self) -> str:
        if self.mode == "wildcard":
            return "* (any origin)"
        if self.mode == "explicit":
            return ", ".join(self.allow_origins)
        return "loopback only (regex)"


def resolve_cors_policy(raw: str | None) -> CorsPolicy:
    """Turn the AIVB_CORS_ORIGINS value into an explicit, auditable policy.

    Safe by default: an *unset* or blank variable no longer means `*`. It means
    loopback-only, which is what local development actually needs. Opening the
    API to every origin is still possible, but only as a deliberate act
    (`AIVB_CORS_ORIGINS=*`) and it is logged as a SECURITY warning every start.
    """
    entries = [e.strip() for e in (raw or "").split(",")]
    entries = [e for e in entries if e]

    if not entries:
        # Unset, blank, or degenerate (","). All three mean "the operator did
        # not decide", and the safe reading of that is loopback-only.
        detail = (
            "is not set"
            if raw is None or raw.strip() == ""
            else f"is set to {raw!r}, which contains no origin"
        )
        return CorsPolicy(
            allow_origin_regex=LOCALHOST_ORIGIN_REGEX,
            mode="localhost-default",
            warnings=(
                f"AIVB_CORS_ORIGINS {detail}; falling back to loopback-only "
                "(localhost / 127.0.0.1 / [::1], any port). Set it to the real "
                "UI origin before exposing this service on a network.",
            ),
        )

    if any(e == "*" for e in entries):
        return CorsPolicy(
            allow_origins=("*",),
            mode="wildcard",
            warnings=(
                "SECURITY: AIVB_CORS_ORIGINS='*' allows any website to call "
                "this API from a student's browser. Acceptable only for local "
                "development or behind an authenticating reverse proxy.",
            ),
        )

    warnings: list[str] = []
    normalised: list[str] = []
    for entry in entries:
        clean = entry.rstrip("/")
        if clean != entry:
            warnings.append(
                f"AIVB_CORS_ORIGINS entry {entry!r} had a trailing slash; using "
                f"{clean!r}. A CORS origin is scheme://host[:port] with no path."
            )
        if "://" not in clean:
            warnings.append(
                f"AIVB_CORS_ORIGINS entry {clean!r} has no scheme, so no browser "
                f"will ever match it. Expected e.g. 'https://{clean}'."
            )
        normalised.append(clean)

    return CorsPolicy(
        allow_origins=tuple(normalised), mode="explicit", warnings=tuple(warnings)
    )


def cors_policy_from_env() -> CorsPolicy:
    return resolve_cors_policy(os.environ.get("AIVB_CORS_ORIGINS"))


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_path_or_none(name: str) -> Path | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    return Path(raw.strip())


def _read_secret_file(path: Path, key: str) -> str:
    """Doc mot khoa trong `pg_secrets.env`.

    Khuon file: `ten=gia_tri  chu thich tuy y`. Gia tri la phan TRUOC dau cach
    dau tien, phan con lai la chu thich. Luat do co o ba noi (`Settings._pg_secret`,
    `Settings._pg_password`, `database/restore.py:_secrets`) nen no o day, MOT ban.

    Doc bang `utf-8-sig`: PowerShell ghi file nay, va `Add-Content -Encoding UTF8`
    tren WinPS 5.1 co the them BOM. Voi `utf-8` thi BOM dinh vao khoa DAU TIEN
    (`﻿pw_loader`) va khoa do bien mat khong mot loi bao. `utf-8-sig` giai ma
    file khong BOM y het, nen phep doi nay khong mat gi.

    Gia tri rong -> `ValueError` neu ro khoa nao. Truoc day la `value.split()[0]`,
    tuc mot dong `pw_app_rw=` lam ca dich vu chet luc khoi dong bang
    `IndexError: list index out of range` - dung, nhung khong noi khoa nao.
    """
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() != key:
            continue
        # `split(" ", 1)[0]` chu khong `split()[0]`: khoan dung voi dong rong.
        cleaned = value.strip().split(" ", 1)[0]
        if not cleaned:
            raise ValueError(
                f"Khoa {key!r} trong {path} co nhung rong. Gia tri la phan TRUOC "
                f"dau cach dau tien, nen dong `{key}=` khong mang gia tri nao."
            )
        return cleaned
    raise KeyError(f"Khong thay {key!r} trong {path}")


@dataclass(frozen=True)
class DatasetSpec:
    """Mot BO DU LIEU day hoc, voi day du thu can de phuc vu no.

    Truc nay khong ton tai truoc thang 8/2026: app chi co mot bo du lieu (AIV
    Bank) va mot truc duy nhat la VAI TRO (student/instructor). Them
    SupplyChain doi hoi mot truc thu hai, va hai truc do doc lap nhau:

        (dataset, role) -> (database, user, schema, contract)

    Mot dataset co the co MOT database vat ly thay vi hai. AIV Bank tach hai vi
    trong du lieu co bang dap an (`meta_dirty_log`, `meta_scenario_label`) va
    ARCHITECTURE.md muc 2 giai thich vi sao GRANT cap cot khong thay the duoc.
    SupplyChain khong co bang nao nhu vay - dap an cua no nam o file ngoai kho -
    nen `db_instructor = None` va ca hai vai tro doc cung mot database. Nhan doi
    15 GB `sales` de giau mot thu khong nam trong du lieu la vo nghia.
    """

    name: str
    label: str
    schema: str
    db_student: str
    db_instructor: str | None
    user_student: str
    user_instructor: str
    contract_path: Path
    owner_config_path: Path | None
    #: Frontend can biet de dinh dang so tien. AIV Bank la VND SO NGUYEN (khong
    #: bao gio lam tron - xem API_CONTRACT.md muc 7); SupplyChain la USD co phan
    #: thap phan. Doan sai o day lam sai so tien tren man hinh hoc vien.
    currency: str
    #: Khoa trong config/pg_secrets.env. AIV Bank dung pw_api_s / pw_api_i vi ly
    #: do lich su; dataset moi dat ten theo chinh no.
    secret_key_student: str
    secret_key_instructor: str

    def db_for(self, role: str) -> tuple[str, str]:
        """(database, user) cho mot vai tro. TRA CUU, khong suy luan."""
        role_up = (role or "").upper()
        if role_up == "INSTRUCTOR":
            # Chua cau hinh database giang vien => dung database hoc vien. BE MAT
            # NHO HON, khong bao gio lon hon.
            return (self.db_instructor or self.db_student), (
                self.user_instructor if self.db_instructor else self.user_student
            )
        if role_up == "STUDENT":
            return self.db_student, self.user_student
        raise ValueError(f"Vai tro khong hop le cho ket noi PostgreSQL: {role!r}")


def _ds_env(name: str, key: str, default: str | None = None) -> str | None:
    """AIVB_DS_<NAME>_<KEY>, hoa het."""
    return os.environ.get(f"AIVB_DS_{name.upper()}_{key}", default)


DEFAULT_DATASETS = "aivb"


def build_datasets() -> dict[str, DatasetSpec]:
    """Doc dang ky dataset tu moi truong.

    TUONG THICH NGUOC la yeu cau, khong phai tien nghi: mot ban trien khai dang
    chay chi dat AIVB_PG_DB_STUDENT / AIVB_PG_SCHEMA / AIVB_CONTRACT_PATH phai
    tiep tuc chay y nguyen ma khong sua mot bien nao. Nen dataset `aivb` lay mac
    dinh tu chinh cac bien phang do, con dataset moi thi khai bao day du bang
    tien to AIVB_DS_<TEN>_.
    """
    names = [n.strip() for n in os.environ.get("AIVB_DATASETS", DEFAULT_DATASETS).split(",") if n.strip()]
    if not names:
        names = [DEFAULT_DATASETS]

    out: dict[str, DatasetSpec] = {}
    for name in names:
        legacy = name == "aivb"
        contract = _ds_env(name, "CONTRACT_PATH")
        owner = _ds_env(name, "OWNER_CONFIG_PATH")
        if contract is None and legacy:
            contract = os.environ.get("AIVB_CONTRACT_PATH", str(DEFAULT_CONTRACT_PATH))
        if contract is None:
            contract = str(APP_ROOT / "backend" / "contract" / f"{name}-column-contract.json")
        if owner is None and legacy:
            owner = os.environ.get("AIVB_OWNER_CONFIG_PATH", str(DEFAULT_OWNER_CONFIG_PATH))

        out[name] = DatasetSpec(
            name=name,
            label=_ds_env(name, "LABEL") or name,
            schema=_ds_env(name, "SCHEMA")
            or (os.environ.get("AIVB_PG_SCHEMA", "aivb") if legacy else name),
            db_student=_ds_env(name, "DB_STUDENT")
            or (os.environ.get("AIVB_PG_DB_STUDENT", "aivb_student") if legacy else name),
            db_instructor=_ds_env(name, "DB_INSTRUCTOR")
            or (os.environ.get("AIVB_PG_DB_INSTRUCTOR") or None if legacy else None),
            user_student=_ds_env(name, "USER_STUDENT")
            or (os.environ.get("AIVB_PG_USER_STUDENT", "aivb_api_student") if legacy else f"{name}_api"),
            user_instructor=_ds_env(name, "USER_INSTRUCTOR")
            or (
                os.environ.get("AIVB_PG_USER_INSTRUCTOR", "aivb_api_instructor")
                if legacy
                else f"{name}_api"
            ),
            contract_path=Path(contract),
            owner_config_path=Path(owner) if owner else None,
            currency=_ds_env(name, "CURRENCY") or ("VND_INT" if legacy else "USD_DEC"),
            secret_key_student=_ds_env(name, "SECRET_KEY_STUDENT")
            or ("pw_api_s" if legacy else f"pw_{name}_api"),
            secret_key_instructor=_ds_env(name, "SECRET_KEY_INSTRUCTOR")
            or ("pw_api_i" if legacy else f"pw_{name}_api"),
        )
    return out


@dataclass(frozen=True)
class Settings:
    db_path: Path = field(
        default_factory=lambda: Path(os.environ.get("AIVB_DB_PATH", str(DEFAULT_DB_PATH)))
    )
    contract_path: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_CONTRACT_PATH", str(DEFAULT_CONTRACT_PATH))
        )
    )
    owner_config_path: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_OWNER_CONFIG_PATH", str(DEFAULT_OWNER_CONFIG_PATH))
        )
    )

    # -- authentication ---------------------------------------------------
    # The INSTRUCTOR dataset. Unset (the default) means instructors get the
    # same student database - a strictly smaller surface, never a larger one.
    # A STUDENT session can never be routed here regardless.
    instructor_db_path: Path | None = field(
        default_factory=lambda: _env_path_or_none("AIVB_INSTRUCTOR_DB_PATH")
    )
    audit_log_path: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_AUDIT_LOG_PATH", str(DEFAULT_AUDIT_LOG_PATH))
        )
    )
    session_idle_timeout_s: float = field(
        default_factory=lambda: _env_float("AIVB_SESSION_IDLE_S", 8 * 3600.0)
    )
    session_absolute_timeout_s: float = field(
        default_factory=lambda: _env_float("AIVB_SESSION_ABSOLUTE_S", 12 * 3600.0)
    )
    # Marks the session cookie `Secure`. Must be 1 in any deployment that is
    # not plain-http loopback; left off by default so local development over
    # http works, and warned about loudly at startup (see main.py).
    cookie_secure: bool = field(
        default_factory=lambda: _env_bool("AIVB_COOKIE_SECURE", False)
    )
    cookie_name: str = field(
        default_factory=lambda: os.environ.get("AIVB_COOKIE_NAME", "aivb_session")
    )
    # CSRF: a header no cross-site HTML form can set. Its presence proves the
    # request came from JS that survived the CORS preflight.
    csrf_header: str = field(
        default_factory=lambda: os.environ.get("AIVB_CSRF_HEADER", "X-AIVB-Client")
    )
    login_fail_threshold: int = field(
        default_factory=lambda: _env_int("AIVB_LOGIN_FAIL_THRESHOLD", 5)
    )
    login_ip_fail_threshold: int = field(
        default_factory=lambda: _env_int("AIVB_LOGIN_IP_FAIL_THRESHOLD", 20)
    )
    login_lock_base_s: float = field(
        default_factory=lambda: _env_float("AIVB_LOGIN_LOCK_BASE_S", 30.0)
    )
    login_lock_max_s: float = field(
        default_factory=lambda: _env_float("AIVB_LOGIN_LOCK_MAX_S", 900.0)
    )
    audit_enabled: bool = field(
        default_factory=lambda: _env_bool("AIVB_AUDIT_ENABLED", True)
    )

    # Resource limits -----------------------------------------------------
    query_timeout_s: float = field(
        default_factory=lambda: _env_float("AIVB_QUERY_TIMEOUT_S", 15.0)
    )
    max_rows: int = field(default_factory=lambda: _env_int("AIVB_MAX_ROWS", 1000))
    max_sql_chars: int = field(default_factory=lambda: _env_int("AIVB_MAX_SQL_CHARS", 20000))
    max_response_bytes: int = field(
        default_factory=lambda: _env_int("AIVB_MAX_RESPONSE_BYTES", 8 * 1024 * 1024)
    )
    max_concurrent_queries: int = field(
        default_factory=lambda: _env_int("AIVB_MAX_CONCURRENT_QUERIES", 4)
    )
    # How long a request may WAIT for one of those slots before being shed.
    # Measured on the 9.1GB build: a class of 10 students pressing Run at the
    # same moment used to get six 503s even for a 60ms query, because
    # admission control refused instantly instead of queueing. Queries here are
    # short (p50 ~10ms, worst case ~5s), so a brief wait converts almost every
    # one of those rejections into a normal answer without ever exceeding
    # max_concurrent_queries.
    admission_wait_s: float = field(
        default_factory=lambda: _env_float("AIVB_ADMISSION_WAIT_S", 10.0)
    )
    # Hard cap on how many requests may be queued behind the running ones.
    # Keeps blocked threads well below starlette's threadpool (40) so /health
    # and /schema stay responsive no matter how saturated /query is.
    max_queued_queries: int = field(
        default_factory=lambda: _env_int("AIVB_MAX_QUEUED_QUERIES", 16)
    )
    # DuckDB engine guard rails (layer 3).
    memory_limit: str = field(
        default_factory=lambda: os.environ.get("AIVB_MEMORY_LIMIT", "2GB")
    )
    duckdb_threads: int = field(default_factory=lambda: _env_int("AIVB_DUCKDB_THREADS", 2))
    # Where DuckDB spills. Left to DuckDB it becomes "<db file>.tmp", i.e. a
    # directory created INSIDE the published release folder next to
    # student.duckdb - which the service has no business writing to, and which
    # fails outright if the release is mounted read-only. Pointed at the system
    # temp area instead, with a size cap so a heavy query cannot fill the disk.
    temp_directory: str = field(
        default_factory=lambda: os.environ.get(
            "AIVB_TEMP_DIR", str(Path(tempfile.gettempdir()) / "aivb_duckdb_spill")
        )
    )
    max_temp_directory_size: str = field(
        default_factory=lambda: os.environ.get("AIVB_MAX_TEMP_SIZE", "8GB")
    )

    # -- PostgreSQL: engine PHUC VU ---------------------------------------
    # DuckDB o tren van la engine build + nghiem thu. Cac tham so duoi day chi
    # dieu khien duong PHUC VU. Hai vai tro tach bach, va khong bao gio duoc
    # tron: mot ket noi Postgres khong duoc phep xuat hien trong duong sinh du
    # lieu, va nguoc lai.
    #
    # Vai tro STUDENT va INSTRUCTOR tro toi HAI DATABASE VAT LY KHAC NHAU. Duoi
    # DuckDB, viec tach goi phu thuoc vao `db_for_role()` tra ve doi tuong nao -
    # mot loi dinh tuyen la giao nham ca file dap an. Duoi PostgreSQL, mot loi
    # dinh tuyen chi lam hoc vien cam mot bo thong tin dang nhap KHONG MO NOI
    # ket noi toi aivb_instructor: quyen CONNECT khong duoc cap.
    pg_host: str = field(default_factory=lambda: os.environ.get("AIVB_PG_HOST", "127.0.0.1"))
    pg_port: int = field(default_factory=lambda: _env_int("AIVB_PG_PORT", 5432))
    pg_db_student: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_DB_STUDENT", "aivb_student")
    )
    # Bo trong => giang vien dung chinh database hoc vien. Be mat NHO HON, khong
    # bao gio lon hon - giong het y nghia cua AIVB_INSTRUCTOR_DB_PATH truoc day.
    pg_db_instructor: str | None = field(
        default_factory=lambda: os.environ.get("AIVB_PG_DB_INSTRUCTOR") or None
    )
    pg_user_student: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_USER_STUDENT", "aivb_api_student")
    )
    pg_user_instructor: str = field(
        default_factory=lambda: os.environ.get(
            "AIVB_PG_USER_INSTRUCTOR", "aivb_api_instructor"
        )
    )
    # Mac dinh nam TRONG `app/`, khong phai `C:\ProgramData\...`. Duong dan
    # tuyet doi cu la thu duy nhat con troi ung dung vao dung mot may - va no
    # hong lang le tren may khac: file khong ton tai, va loi bao ra la "khong
    # thay file mat khau" chu khong phai "ban dang chay o may khac".
    #
    # `app/config/` nam trong .gitignore. Xem `app/config/.env.example`.
    pg_password_file: str = field(
        default_factory=lambda: os.environ.get(
            "AIVB_PG_PASSWORD_FILE", str(APP_ROOT / "config" / "pg_secrets.env")
        )
    )
    pg_schema: str = field(default_factory=lambda: os.environ.get("AIVB_PG_SCHEMA", "aivb"))

    #: Dang ky bo du lieu. Mac dinh la MOT dataset (`aivb`) dung lai chinh cac
    #: bien phang o tren, nen mot ban trien khai dang chay khong phai sua gi.
    #: Them SupplyChain = dat AIVB_DATASETS=aivb,scm va bo AIVB_DS_SCM_*.
    datasets: dict = field(default_factory=build_datasets)

    # Thu muc frontend duoc phuc vu tinh o `/`. Day la DIEM THAY THE frontend:
    # build React/Vue/... ra mot thu muc bat ky roi tro AIVB_FRONTEND_DIR vao do.
    # Backend khong biet gi ve noi dung ben trong - hop dong duy nhat giua hai
    # ben la API_CONTRACT.md.
    frontend_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_FRONTEND_DIR", str(DEFAULT_FRONTEND_DIR))
        )
    )
    # API noi chuyen voi PostgreSQL qua loopback trong cung mot may, nen TLS o
    # chang do khong mua duoc gi ma phai tra gia bat tay moi ket noi. Nguoi dung
    # BI thi khac: ho di qua tunnel va dung sslmode=require.
    #: Database trang thai ung dung: phien, chan dang nhap sai, gamification.
    #: TACH khoi hai database du lieu vi `restore.py` dung lai chung moi lan nap
    #: dump — de chung o do la mat diem va lich su luyen tap cua ca lop.
    pg_db_app: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_DB_APP", "aivb_app")
    )
    pg_user_app: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_USER_APP", "aivb_app_rw")
    )

    # -- game "Vuong Quoc Keo Ngot" (tab Tro choi) -------------------------
    #: Dia chi noi bo cua `game-api` (Node). RONG = tat game: khong route
    #: `/game/*` nao duoc dang ky, tab Tro choi tu an.
    game_api_url: str = field(
        default_factory=lambda: os.environ.get("AIVB_GAME_API_URL", "").rstrip("/")
    )
    #: Ban build frontend cua game (`game/`, `npm run build:web`).
    game_dist_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_GAME_DIST_DIR", str(APP_ROOT / "game" / "dist"))
        )
    )
    #: File chua khoa HMAC chung voi game (`AIVB_SSO_SECRET=`), cung khuon
    #: `khoa=gia_tri` voi `pg_secrets.env`. `game-api` doc CHINH file nay qua
    #: `env_file`, nen hai ben khong the lech khoa.
    game_env_file: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AIVB_GAME_ENV_FILE", str(APP_ROOT / "config" / "game.env"))
        )
    )
    pg_db_game: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_DB_GAME", "candy_game")
    )
    pg_user_game: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_USER_GAME", "candy_app")
    )

    pg_sslmode: str = field(default_factory=lambda: os.environ.get("AIVB_PG_SSLMODE", "disable"))
    pg_connect_timeout_s: int = field(
        default_factory=lambda: _env_int("AIVB_PG_CONNECT_TIMEOUT_S", 5)
    )
    pg_application_name: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_APPLICATION_NAME", "aivbank-api")
    )
    # `work_mem` la MOI NUT sort/hash MOI ket noi, khong phai gioi han ca tien
    # trinh nhu `memory_limit` cua DuckDB. Mot truy van co ba nut sort co the
    # dung gap ba. Con so nay vi vay thap hon nhieu so voi AIVB_MEMORY_LIMIT cu,
    # va do KHONG phai la ha cau hinh.
    pg_work_mem: str = field(default_factory=lambda: os.environ.get("AIVB_PG_WORK_MEM", "64MB"))
    pg_temp_file_limit: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_TEMP_FILE_LIMIT", "2GB")
    )
    pg_parallel_workers: int = field(
        default_factory=lambda: _env_int("AIVB_PG_PARALLEL_WORKERS", 2)
    )
    pg_lc_messages: str = field(
        default_factory=lambda: os.environ.get("AIVB_PG_LC_MESSAGES", "C")
    )
    pg_pool_min: int = field(default_factory=lambda: _env_int("AIVB_PG_POOL_MIN", 1))
    pg_pool_max: int = field(default_factory=lambda: _env_int("AIVB_PG_POOL_MAX", 0))

    # -- ngan sach ket noi cua `aivb_app_rw` ---------------------------------
    #
    # `aivb_app_rw` co `CONNECTION LIMIT` dat trong
    # `database/schema/16_app_database.sql`. Ba ben cung an vao han muc do:
    #
    #     pool xac thuc (AuthStore)           <= pg_auth_pool_max        (4)
    #     pool diem so  (GamificationStore)   <= pg_gamification_pool_max (6)
    #     `admin_cli` / `psql` luc van hanh   ~ 2
    #
    # Nang mot ben thi phai ha ben kia, hoac nang `CONNECTION LIMIT` trong file
    # schema - khong co cho nao khac giu con so nay.
    #
    # CO Y KHONG dung lai `pg_pool_min`/`pg_pool_max` o tren: hai cai do sizing
    # pool TRUY VAN theo bo du lieu trong `db.py`, noi bang `aivb_api_*` toi
    # `aivb_student`/`aivb_instructor` - vai tro khac, han muc khac. Dat
    # `AIVB_PG_POOL_MAX=10` la hop ly cho pool truy van, ma se an het phan cua
    # `aivb_app_rw` neu dung chung.
    pg_auth_pool_min: int = field(
        default_factory=lambda: _env_int("AIVB_PG_AUTH_POOL_MIN", 1)
    )
    pg_auth_pool_max: int = field(
        default_factory=lambda: _env_int("AIVB_PG_AUTH_POOL_MAX", 4)
    )
    pg_gamification_pool_max: int = field(
        default_factory=lambda: _env_int("AIVB_PG_GAMIFICATION_POOL_MAX", 6)
    )

    # Optional watch list: columns whose use earns a highlighted line in the
    # server log. Detection only - never blocks, never changes the response.
    #
    # DEFAULT IS EMPTY, and that is a deliberate change (2026-08-04).
    #
    # It used to default to `dirty_flag`, on the reasoning that
    # `raw_account_transaction.dirty_flag` was marked STUDENT in the column
    # contract and therefore had to be served: measured on the real build it
    # reproduced the meta_dirty_log row set with 100% precision and 100% recall
    # (577,509 of 7,449,253 rows), and logging was the only lever the API had.
    #
    # That reasoning is now void. The mentor's ruling of 2026-08-04 (answer 3)
    # moved the column to INSTRUCTOR, so the API does not serve it at all:
    # it is stripped from the catalog, the guard refuses any query naming it
    # (api/guard.py:_check_column), and the rebuilt student.duckdb will not
    # contain it. Enforcement replaced detection, which is strictly stronger.
    #
    # Why no replacement column is watched by default. Of the columns that are
    # still STUDENT, the only answer-key-adjacent pair is
    # `raw_account_transaction.amount_text` / `date_text`: measured on the same
    # build, `TRY_CAST(amount_text AS DOUBLE) IS NULL OR TRY_CAST(date_text AS
    # DATE) IS NULL` returns 514,405 rows, every one of them in meta_dirty_log -
    # 100% precision, 89.07% recall of the 577,509-row key. But parsing those
    # two fields IS the data-quality exercise, so watching them would fire on
    # essentially every legitimate query and bury the signal. `raw_row_id`, the
    # join key of meta_dirty_log, is that table's primary key and equally noisy.
    # Neither earns a default. Nothing is lost by leaving the list empty: every
    # query is already recorded in full in the audit log (api/audit.py) and is
    # readable by an instructor through GET /audit/recent.
    #
    # The mechanism stays wired and tested, so a watch list can be turned on at
    # any time without a code change:  AIVB_AUDIT_COLUMNS=amount_text,date_text
    audit_columns: frozenset[str] = field(
        default_factory=lambda: frozenset(
            c.strip().lower()
            for c in os.environ.get("AIVB_AUDIT_COLUMNS", "").split(",")
            if c.strip()
        )
    )

    def __post_init__(self) -> None:
        # Dataset mac dinh phai bam theo CAC TRUONG DA GIAI QUYET cua chinh
        # instance nay, khong phai theo bien moi truong luc import.
        #
        # Day khong phai tinh te thua. Bo test dung `Settings(pg_db_student=...)`
        # de tro vao database co dinh (conftest.py:120), va neu `datasets` chi
        # doc moi truong thi ket noi se di mot noi con ten database bao mot noi
        # khac - dung kieu sai im lang ma toan bo lop nay duoc dung de chan.
        # Bien AIVB_DS_AIVB_* van thang, de mot ban trien khai muon tach rieng
        # cau hinh dataset khoi cac bien phang cu van lam duoc.
        datasets = dict(self.datasets)
        if datasets:
            default_name = next(iter(datasets))
            spec = datasets[default_name]
            n = default_name
            datasets[default_name] = replace(
                spec,
                db_student=_ds_env(n, "DB_STUDENT") or self.pg_db_student,
                db_instructor=_ds_env(n, "DB_INSTRUCTOR") or self.pg_db_instructor,
                user_student=_ds_env(n, "USER_STUDENT") or self.pg_user_student,
                user_instructor=_ds_env(n, "USER_INSTRUCTOR") or self.pg_user_instructor,
                schema=_ds_env(n, "SCHEMA") or self.pg_schema,
                contract_path=Path(_ds_env(n, "CONTRACT_PATH") or self.contract_path),
                owner_config_path=Path(
                    _ds_env(n, "OWNER_CONFIG_PATH") or self.owner_config_path
                ),
            )
            object.__setattr__(self, "datasets", datasets)

        # Accept plain strings for the paths without losing frozen-ness.
        object.__setattr__(self, "db_path", Path(self.db_path))
        object.__setattr__(self, "contract_path", Path(self.contract_path))
        object.__setattr__(self, "owner_config_path", Path(self.owner_config_path))
        object.__setattr__(self, "audit_log_path", Path(self.audit_log_path))
        if self.instructor_db_path is not None:
            object.__setattr__(
                self, "instructor_db_path", Path(self.instructor_db_path)
            )

    @property
    def session_cookie_name(self) -> str:
        """The name actually written to Set-Cookie.

        Under TLS the cookie gets the `__Host-` prefix, which browsers refuse
        to accept unless it is Secure, Path=/ and has no Domain attribute. That
        closes cookie tossing: a page on a sibling subdomain (student.
        <campus>.edu writing a cookie for .<campus>.edu) cannot shadow or
        overwrite it. The prefix is skipped when Secure is off, because the
        browser would then reject the cookie outright and plain-http local
        development would stop working.
        """
        if self.cookie_secure and not self.cookie_name.startswith("__Host-"):
            return f"__Host-{self.cookie_name}"
        return self.cookie_name

    def dataset_paths(self) -> tuple[Path, ...]:
        paths = [self.db_path]
        if self.instructor_db_path is not None:
            paths.append(self.instructor_db_path)
        return tuple(paths)

    # -- PostgreSQL (engine phuc vu) ------------------------------------
    def dataset(self, name: str | None = None) -> "DatasetSpec":
        """Tra ve DatasetSpec, hoac bao loi ro rang neu ten khong co trong dang ky.

        Mac dinh la dataset dau tien trong AIVB_DATASETS - de moi loi goi cu
        khong truyen dataset van chay dung nhu truoc."""
        if not name:
            return next(iter(self.datasets.values()))
        try:
            return self.datasets[name]
        except KeyError:
            raise ValueError(f"Khong biet bo du lieu {name!r}") from None

    def pg_conninfo(self, role: str, dataset: str | None = None) -> str:
        """Chuoi ket noi libpq cho mot vai tro.

        `role` la ROLE_STUDENT hoac ROLE_INSTRUCTOR. Anh xa vai tro -> (database,
        user) la mot phep TRA CUU, khong phai mot phep suy luan: vai tro la la
        khong roi vao nhanh nao va bi tu choi.

        Mat khau KHONG nam trong bien moi truong. `deploy/tests/
        test_deployment_contract.py` cam chuoi `password=` trong moi template
        trien khai, va `api.env` thi bi Start-Api.ps1 doc va in ra khi kiem tra.
        Mat khau doc tu file rieng ngoai repo, da siet ACL.
        """
        spec = self.dataset(dataset)
        database, user = spec.db_for(role)
        password = self._pg_password(user, spec, role)
        return self._pg_dsn(
            dbname=database,
            user=user,
            password=password,
            application_name=self.pg_application_name,
        )

    # -- database trang thai ung dung (`aivb_app`) -------------------------
    def pg_conninfo_app(self) -> str:
        """Chuoi ket noi toi `aivb_app` bang `aivb_app_rw`.

        Day la ket noi GHI DUOC duy nhat cua backend, va no chi ghi duoc trong
        schema `app` cua mot database rieng. Hai database du lieu van chi-doc.
        Xem `database/schema/16_app_database.sql`.
        """
        password = self._pg_secret("pw_app_rw")
        return self._pg_dsn(
            dbname=self.pg_db_app,
            user=self.pg_user_app,
            password=password,
            application_name=f"{self.pg_application_name}-app",
        )

    # -- game ------------------------------------------------------------
    @property
    def game_enabled(self) -> bool:
        return bool(self.game_api_url)

    def game_sso_secret(self) -> str:
        """Khoa ky ve SSO. Doc moi lan goi (re, file nho) de xoay khoa khong
        can khoi dong lai backend - `game-api` thi van phai khoi dong lai."""
        secret = _read_secret_file(self.game_env_file, "AIVB_SSO_SECRET")
        if len(secret) < 32:
            raise ValueError("AIVB_SSO_SECRET phai dai it nhat 32 ky tu")
        return secret

    def pg_conninfo_game(self) -> str:
        """Chuoi ket noi toi `candy_game` bang `candy_app` - chi de dong bo user.
        Xem `database/schema/18_game_database.sql`."""
        return self._pg_dsn(
            dbname=self.pg_db_game,
            user=self.pg_user_game,
            password=self._pg_secret("pw_candy_app"),
            application_name=f"{self.pg_application_name}-game-sync",
        )

    def pg_conninfo_as_user(self, username: str, password: str) -> str:
        """Chuoi ket noi bang CHINH tai khoan cua nguoi dung.

        Dung de XAC THUC: noi duoc nghia la mat khau dung. Nho vay ung dung
        khong bao gio phai doc `pg_authid`, va cung khong can `CREATEROLE`.

        Noi vao `aivb_app` chu khong vao `aivb_student`: moi lan go sai mat khau
        cung ton mot ket noi, va tran cua aivb_student la de danh cho truy van
        cua hoc vien chu khong phai cho nguoi go nham.
        """
        return self._pg_dsn(
            dbname=self.pg_db_app,
            user=username,
            password=password,
            application_name=f"{self.pg_application_name}-auth",
        )

    def _pg_dsn(
        self, *, dbname: str, user: str, password: str, application_name: str
    ) -> str:
        r"""Rap mot DSN libpq. MOI chuoi ket noi cua ung dung di qua day.

        Dung `make_conninfo` chu KHONG noi chuoi tay, va day khong phai mot lop
        gian tiep cho dep:

        DSN kieu keyword/value tach nhau bang KHOANG TRANG, va khoa trung thi
        lan CUOI thang. Noi tay nghia la mot mat khau nhu

            x host=evil.example.com

        se ra `... user=sv001 password=x host=evil.example.com sslmode=disable`,
        tuc doi duoc may chu DICH cua chinh phep xac thuc. Ma `AuthStore.
        verify_password` lai coi "noi duoc" LA "mat khau dung", roi doc ho so
        that tu `aivb_app` that va phat cookie phien. Do la mot duong VONG QUA
        TOAN BO phep dang nhap, voi bat ky tai khoan nao doan duoc ten.

        `make_conninfo` trich dan tung gia tri (thoat `\` va `'`, boc nhay don
        khi co khoang trang), nen khong gia tri nao tro thanh mot THAM SO duoc
        nua. Voi gia tri khong co khoang trang/nhay, chuoi sinh ra giong het ban
        noi tay - nen phep doi nay khong doi hanh vi cua bat ky ket noi nao dang
        chay.
        """
        return make_conninfo(
            host=self.pg_host,
            port=self.pg_port,
            dbname=dbname,
            user=user,
            password=password,
            sslmode=self.pg_sslmode,
            connect_timeout=self.pg_connect_timeout_s,
            application_name=application_name,
        )

    def _pg_secret(self, key: str) -> str:
        """Doc mot khoa bat ky trong `pg_secrets.env`.

        Cung khuon voi `_pg_password` - va nay thi dung the that: ca hai deu goi
        `_read_secret_file`. Truoc day hai ban chep tay da troi khoi nhau va khoi
        ca `database/restore.py`, moi ban hong mot kieu khac nhau.
        """
        path = Path(self.pg_password_file)
        if not path.exists():
            raise FileNotFoundError(
                f"Khong thay file mat khau PostgreSQL: {path}."
            )
        return _read_secret_file(path, key)

    def _pg_password(
        self, user: str, spec: "DatasetSpec | None" = None, role: str | None = None
    ) -> str:
        """Mat khau cua mot vai tro, doc tu file bi mat ngoai repo."""
        path = Path(self.pg_password_file)
        if not path.exists():
            raise FileNotFoundError(
                f"Khong thay file mat khau PostgreSQL: {path}. "
                "Xem deploy/postgres/README.md."
            )
        if spec is not None:
            wanted = (
                spec.secret_key_instructor
                if (role or "").upper() == "INSTRUCTOR" and spec.db_instructor
                else spec.secret_key_student
            )
        else:
            # Duong goi cu, khong truyen dataset.
            wanted = {
                self.pg_user_student: "pw_api_s",
                self.pg_user_instructor: "pw_api_i",
            }.get(user)
        if wanted is None:
            raise ValueError(f"Khong biet lay mat khau nao cho user {user!r}")
        return _read_secret_file(path, wanted)

    def pg_session_settings(self, schema: str | None = None) -> dict[str, str]:
        """Tham so API TU DAT tren moi ket noi trong pool.

        Chi gom cac tham so hang USERSET - vai tro thuong dat duoc. Dat lai o
        day du chung da co gia tri o cap vai tro tren may chu, vi hai nguon deu
        co the troi va API phai chay dung du ai do sua mot ben.

        Dat bang `set_config(name, value, false)` chu KHONG phai `SET name =
        value`: cau lenh SET khong nhan tham so, nen dung no se phai noi chuoi
        vao SQL. set_config nhan tham so that.
        """
        return {
            # search_path phai la schema CUA BO DU LIEU dang ket noi. Dat nham
            # o day khong bao loi - no chi lam moi ten khong dinh danh day du
            # khong tim thay bang, va thong bao se noi "khong co bang" cho mot
            # bang ro rang co that.
            "search_path": schema or self.pg_schema,
            "default_transaction_read_only": "on",
            "statement_timeout": f"{int(self.query_timeout_s * 1000) + 2000}ms",
            "idle_in_transaction_session_timeout": "30s",
            "lock_timeout": "2s",
            "work_mem": self.pg_work_mem,
            "max_parallel_workers_per_gather": str(self.pg_parallel_workers),
            "DateStyle": "ISO, YMD",
            "TimeZone": "UTC",
            "client_min_messages": "error",
            "jit": "off",
        }

    def pg_required_settings(self) -> dict[str, str]:
        """Tham so API KHONG dat duoc, chi KIEM CHUNG - lech thi khong khoi dong.

        Ca hai deu la hang SUSET: chi superuser dat duoc, va chung da duoc dat
        san o `deploy/postgres/03_schema_grants.sql` (cap vai tro) va
        `02_databases.sql` (cap database). Viec API khong dat duoc chung la MOT
        DIEU TOT - no co nghia mot phien lam viec khong the tu noi long.

        `lc_messages` la thu de bo sot nhat va hau qua nang nhat. Tang guard tai
        lap NGUYEN VAN thong bao loi cua Postgres ("column ... does not exist")
        de mot cot bi giau khong phan biet duoc voi mot cot go sai. Neu
        lc_messages doi sang ngon ngu khac, van ban that cua engine khong con
        khop van ban guard tai lap, va hoc vien do duoc su ton tai cua cot -
        trong im lang, khong co loi nao duoc nem ra. Vi vay day la dieu kien
        khoi dong, khong phai canh bao.
        """
        return {
            "lc_messages": self.pg_lc_messages,
            "temp_file_limit": self.pg_temp_file_limit,
        }

    def duckdb_config(self) -> dict:
        """Engine-level hardening applied at connect() time.

        `lock_configuration` makes these immutable for the lifetime of the
        process, so no query (and no forgotten debug endpoint) can re-enable
        external file access later.
        """
        Path(self.temp_directory).mkdir(parents=True, exist_ok=True)
        return {
            "enable_external_access": False,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "allow_community_extensions": False,
            "memory_limit": self.memory_limit,
            "threads": self.duckdb_threads,
            "temp_directory": self.temp_directory,
            "max_temp_directory_size": self.max_temp_directory_size,
            "lock_configuration": True,
        }


settings = Settings()
