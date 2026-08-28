"""Test harness (PostgreSQL).

The fixture database used here is deliberately the WORST CASE: it physically
contains every INSTRUCTOR table, including `meta_scenario_label` and
`meta_dirty_log` with real rows, AND the withheld column
`raw_account_transaction.dirty_flag`. Defense layer 0 (the shipped student
database not containing them at all) is intentionally switched OFF so that
these tests measure the backend guard ON ITS OWN.

That distinction matters more than it looks. Against the real student database
every "the student cannot read the answer key" test would pass even with the
guard deleted, because the table is not there. Here it is there.

Build the fixtures with:
    set PGPASSWORD=...
    python api/tests/build_pg_fixtures.py
"""

from __future__ import annotations

import os
import sys
import json
import tempfile
from pathlib import Path

import pytest

#: `app/` - dat vao sys.path de `import backend` chay duoc.
APP_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(APP_ROOT))

#: Goc kho ma nguon. CHI dung cho vai duong dan lich su ngoai `app/`
#: (`_workspace/`). Khi chi trien khai rieng `app/` thi chung khong ton tai, va
#: cac phep kiem can chung se tu bo qua.
PROJECT_ROOT = APP_ROOT.parent

REPO_ROOT = APP_ROOT  # ten cu, giu cho ma da tham chieu

FIXTURE_DIR = Path(
    os.environ.get(
        "AIVB_FIXTURE_DIR",
        str(Path(tempfile.gettempdir()) / "aivb_api_test_fixtures"),
    )
)
#: Ten DATABASE, khong con la duong dan file.
HOSTILE_DB = os.environ.get("AIVB_PG_FIXTURE_HOSTILE", "aivb_test_hostile")
STUDENT_DB = os.environ.get("AIVB_PG_FIXTURE_STUDENT", "aivb_test_student")
#: Database thu ba, mang mot VIEW thong ngam (`ref_branch` doc `meta_dirty_log`).
LEAKY_DB = os.environ.get("AIVB_PG_FIXTURE_LEAKY", "aivb_test_leaky")
CONTRACT = APP_ROOT / "backend" / "contract" / "column-contract.json"

# ---------------------------------------------------------------------------
# Expected shape is read from the independently published release manifest,
# not from the column-contract under test.  This keeps the pin meaningful while
# removing version-specific numbers from Python.
# ---------------------------------------------------------------------------
from backend.release_contract import load_release_shape, load_visibility_policy

RELEASE_SHAPE = load_release_shape()
VISIBILITY_POLICY = load_visibility_policy()
CONTRACT_TABLES = RELEASE_SHAPE.total_tables
CONTRACT_COLUMNS = RELEASE_SHAPE.total_columns
INSTRUCTOR_TABLE_COUNT = len(VISIBILITY_POLICY["instructor_only_tables"])
STUDENT_TABLE_COUNT = CONTRACT_TABLES - INSTRUCTOR_TABLE_COUNT
_CONTRACT_DOC = json.loads(CONTRACT.read_text(encoding="utf-8"))
STUDENT_COLUMN_COUNT = sum(
    entry.get("student_visibility") == "STUDENT"
    for entry in _CONTRACT_DOC.get("columns", [])
)
MIXED_TABLE = "raw_account_transaction"
WITHHELD_COLUMN = "dirty_flag"  # STUDENT until 2026-08-04, INSTRUCTOR since
MIXED_TABLE_STUDENT_COLUMNS = (
    "raw_row_id",
    "source_file_id",
    "source_row_number",
    "amount_text",
    "date_text",
)
# Full v5.1.6.3 additions that must be represented in the catalog.
FULL_CONTRACT_TABLES = ("core_customer_kyc_event", "mart_bank_performance_monthly")
# Retained as named compatibility probes: these P1 objects remain part of the
# Full contract even though totals now come from release artifacts.
DELTA_P1_TABLES = ("ref_branch", "ref_industry", "ref_segment")
DELTA_P1_COLUMNS = (
    ("core_customer", "home_branch_id"),
    ("core_customer", "kyc_status"),
    ("core_person", "occupation_code"),
    ("core_organization", "industry_code"),
    ("core_organization", "revenue_band"),
)

# Chi con `audit.jsonl` la file. Kho danh tinh nam trong PostgreSQL tu
# 2026-08 nen khong con cho nao de dat nham - xem backend/authstore.py.
AUTH_DIR = FIXTURE_DIR / "auth"
AUDIT_LOG = AUTH_DIR / "audit.jsonl"

# Fixture accounts. The student password is what every pre-existing test
# implicitly authenticates with, via the `client` fixture.
STUDENT_USER = "test_student"
STUDENT_PASSWORD = "fixture-student-pw-2026"
INSTRUCTOR_USER = "test_instructor"
INSTRUCTOR_PASSWORD = "fixture-instructor-pw-2026"

# Configure BEFORE api.config is imported.
os.environ.setdefault("AIVB_PG_DB_STUDENT", HOSTILE_DB)
os.environ.setdefault("AIVB_CONTRACT_PATH", str(CONTRACT))
os.environ.setdefault("AIVB_QUERY_TIMEOUT_S", "5")
os.environ.setdefault("AIVB_MAX_ROWS", "100")
os.environ.setdefault("AIVB_AUDIT_LOG_PATH", str(AUDIT_LOG))
# The INSTRUCTOR dataset for the live app is the SAME hostile fixture the
# student role is pointed at. That is the strongest possible arrangement: both
# roles hit ONE database that really does contain meta_dirty_log, so "the
# student cannot read it" cannot be an artefact of the table being absent, and
# the instructor positive control proves the query itself works.
os.environ.setdefault("AIVB_PG_DB_INSTRUCTOR", HOSTILE_DB)


def _pg_settings(database: str, **overrides):
    """Settings pointed at a fixture DATABASE (not a file)."""
    from backend.config import Settings

    return Settings(
        pg_db_student=database,
        pg_db_instructor=database,
        contract_path=CONTRACT,
        query_timeout_s=overrides.pop("query_timeout_s", 5.0),
        **overrides,
    )


def _require_pg(database: str):
    """Skip when PostgreSQL or the fixture database is not available."""
    try:
        import psycopg

        from backend.config import Settings

        probe = Settings(pg_db_student=database, contract_path=CONTRACT)
        with psycopg.connect(probe.pg_conninfo("STUDENT"), connect_timeout=5):
            return
    except Exception as exc:  # noqa: BLE001
        pytest.skip(
            f"PostgreSQL fixture {database!r} unavailable ({exc}). "
            "Run: python api/tests/build_pg_fixtures.py"
        )


@pytest.fixture(scope="session")
def hostile_db():
    _require_pg(HOSTILE_DB)
    from backend.db import Database

    db = Database(_pg_settings(HOSTILE_DB))
    yield db
    db.close()


@pytest.fixture(scope="session")
def student_db():
    _require_pg(STUDENT_DB)
    from backend.db import Database

    db = Database(_pg_settings(STUDENT_DB))
    yield db
    db.close()


# Tai khoan dung mot lan cua cac test don le. Danh sach TUONG MINH thay vi don
# theo tien to: kho danh tinh bay gio la `pg_authid` dung chung, khong con la
# mot file tam moi test mot ban, nen "don nham" nghia la xoa tai khoan that.
THROWAWAY_USERS = (
    "dup_a", "dup_b", "leaky", "paramcheck", "known_user",
    "cli_sv01", "cli_a", "cli_b", "cli_c", "cli_rst",
    "inject_a", "inject_b", "budget_x",
)


def _admin_dsn_or_skip() -> str:
    """Chuoi ket noi superuser, hoac skip neu khong co.

    Dung `backend.pgadmin.admin_conninfo` chu khong chep lai luat: ban chep tay
    o day tung thieu `AIVB_PG_SUPERUSER_FILE`, nen bo test skip lang le tren
    dung nhung may cau hinh bang bien do. No cung dung `make_conninfo`, nen mot
    mat khau superuser co khoang trang khong con lam hong chuoi ket noi.
    """
    from backend.pgadmin import admin_conninfo

    dsn = admin_conninfo(required=False)
    if not dsn:
        pytest.skip("khong co mat khau superuser PostgreSQL")
    return dsn


def _drop_throwaway(dsn: str) -> None:
    import psycopg

    from backend import pgroles

    with psycopg.connect(dsn, autocommit=True) as con:
        for name in THROWAWAY_USERS:
            con.execute("DELETE FROM app.sessions WHERE username = %s", (name,))
            con.execute("DELETE FROM app.throttle WHERE key = %s", (name,))
            con.execute("DELETE FROM app.user_profile WHERE username = %s", (name,))
            if pgroles.role_exists(con, name):
                pgroles.drop_role(con, name)


@pytest.fixture
def pg_store():
    """AuthStore tren PostgreSQL that, co quyen quan tri.

    Thay cho `AuthStore(tmp_path / "auth.sqlite3")` cua ban SQLite: khong con
    kho dung-mot-lan nao ca, moi thu chung mot `aivb_app`. Vi vay fixture nay
    don sach cac tai khoan thu CA TRUOC LAN SAU - mot lan chay bi ngat giua
    chung se de lai vai tro that trong cluster.
    """
    import psycopg

    from backend.authstore import AuthStore
    from backend.config import settings

    dsn = _admin_dsn_or_skip()
    try:
        with psycopg.connect(dsn):
            pass
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong noi duoc toi aivb_app ({exc})")

    _drop_throwaway(dsn)
    store = AuthStore(
        settings.pg_conninfo_app(),
        user_conninfo=settings.pg_conninfo_as_user,
        admin_conninfo=dsn,
    )
    yield store
    store.close()
    _drop_throwaway(dsn)


#: Ten dung trong test_gamification.py. Kho diem KHONG co khoa ngoai toi tai
#: khoan (xem docstring cua `leaderboard`), nen day chi la ten, khong phai vai
#: tro PostgreSQL.
GAMI_TEST_USERS = (
    "student", "alice", "bob", "gv1", "gv2",
    "sv1", "sv2", "sv3", "sv_dang_hoc", "cuu_giang_vien", "da_nghi_hoc",
)


@pytest.fixture
def gami_store():
    """Kho diem tren PostgreSQL that.

    Truoc day moi test mot file SQLite rieng nen tu cach ly. Bay gio ca bo test
    dung chung `aivb_app`, nen fixture nay phai don ten thu CA TRUOC LAN SAU.

    Ly do don TRUOC: mot lan chay bi ngat giua chung se de lai diem cua `alice`,
    va test sau do se thay bang xep hang co san du lieu - dat hay truot vi ly do
    sai.
    """
    import psycopg

    from backend.config import settings
    from backend.gamification import GamificationStore

    dsn = settings.pg_conninfo_app()
    try:
        with psycopg.connect(dsn, connect_timeout=5):
            pass
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong noi duoc toi aivb_app ({exc})")

    def _wipe():
        with psycopg.connect(dsn, autocommit=True) as con:
            for table in (
                "app.practice_events", "app.practice_daily",
                "app.user_achievements", "app.user_rewards",
            ):
                con.execute(
                    f"DELETE FROM {table} WHERE username = ANY(%s)",
                    (list(GAMI_TEST_USERS),),
                )

    _wipe()
    store = GamificationStore(dsn)
    yield store
    store.close()
    _wipe()


@pytest.fixture(scope="session")
def admin_dsn():
    return _admin_dsn_or_skip()


@pytest.fixture(scope="session")
def auth_store():
    """Kho danh tinh dung mot lan, co mot hoc vien va mot giang vien.

    Tu 2026-08: danh tinh nam trong PostgreSQL (`pg_authid`), khong con la mot
    file SQLite. Hai tai khoan fixture la VAI TRO PostgreSQL that, nen bo test
    nay bay gio CAN mot may chu dang chay - truoc day no chi can mot file tam.
    Do la he qua truc tiep cua viec Power BI phai xac thuc voi `pg_authid`.

    Dung lai tu dau moi phien de bo dem khoa va phien cua lan chay truoc khong
    lam mot phep thu dat hay truot vi ly do sai.
    """
    import psycopg

    from backend.authstore import AuthStore
    from backend.config import APP_ROOT, settings

    admin_password = os.environ.get("PGPASSWORD", "")
    if not admin_password:
        for candidate in (
            Path("/run/secrets/pg_superuser"),
            APP_ROOT / "config" / "pg_superuser.txt",
        ):
            if candidate.is_file():
                admin_password = candidate.read_text(encoding="utf-8").strip()
                break
    if not admin_password:
        pytest.skip("khong co mat khau superuser PostgreSQL (PGPASSWORD hoac config/pg_superuser.txt)")

    admin_dsn = (
        f"host={settings.pg_host} port={settings.pg_port} dbname={settings.pg_db_app} "
        f"user=postgres password={admin_password} sslmode={settings.pg_sslmode} "
        "connect_timeout=5"
    )
    try:
        with psycopg.connect(admin_dsn):
            pass
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong noi duoc toi database {settings.pg_db_app} ({exc})")

    # Xoa sach dau vet lan chay truoc TRUOC khi dung kho, khong phai sau: mot
    # lan chay bi ngat giua chung se de lai vai tro va bo dem khoa.
    from backend import pgroles

    with psycopg.connect(admin_dsn, autocommit=True) as con:
        for name in (STUDENT_USER, INSTRUCTOR_USER):
            con.execute("DELETE FROM app.sessions WHERE username = %s", (name,))
            con.execute("DELETE FROM app.throttle WHERE key = %s", (name,))
            con.execute("DELETE FROM app.user_profile WHERE username = %s", (name,))
            if pgroles.role_exists(con, name):
                pgroles.drop_role(con, name)

    if AUDIT_LOG.exists():
        AUDIT_LOG.unlink()
    AUTH_DIR.mkdir(parents=True, exist_ok=True)

    store = AuthStore(
        settings.pg_conninfo_app(),
        user_conninfo=settings.pg_conninfo_as_user,
        admin_conninfo=admin_dsn,
    )
    store.create_user(
        STUDENT_USER, "STUDENT", password=STUDENT_PASSWORD, must_change_password=False
    )
    store.create_user(
        INSTRUCTOR_USER,
        "INSTRUCTOR",
        password=INSTRUCTOR_PASSWORD,
        must_change_password=False,
    )
    yield store
    store.close()
    with psycopg.connect(admin_dsn, autocommit=True) as con:
        for name in (STUDENT_USER, INSTRUCTOR_USER):
            con.execute("DELETE FROM app.sessions WHERE username = %s", (name,))
            con.execute("DELETE FROM app.user_profile WHERE username = %s", (name,))
            if pgroles.role_exists(con, name):
                pgroles.drop_role(con, name)


@pytest.fixture(scope="session")
def live_server(auth_store):
    """Real uvicorn server + real HTTP, wired to the hostile database."""
    _require_pg(HOSTILE_DB)
    from backend.main import app

    from .live_client import LiveServer

    server = LiveServer(app)
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="session")
def client(live_server):
    """An authenticated STUDENT client.

    Authentication is mandatory on every data endpoint, so the pre-existing
    suite gets a signed-in student here rather than an anonymous caller. The
    permission tests it contains are unchanged and still meaningful: a
    logged-in student is exactly the attacker those tests model.
    """
    from .live_client import LiveClient

    session_client = LiveClient(live_server.base_url)
    resp = session_client.login(STUDENT_USER, STUDENT_PASSWORD)
    assert resp.status_code == 200, f"fixture student login failed: {resp.text}"
    yield session_client


@pytest.fixture(scope="session")
def instructor_client(live_server):
    """An authenticated INSTRUCTOR client - the positive control."""
    from .live_client import LiveClient

    session_client = LiveClient(live_server.base_url)
    resp = session_client.login(INSTRUCTOR_USER, INSTRUCTOR_PASSWORD)
    assert resp.status_code == 200, f"fixture instructor login failed: {resp.text}"
    yield session_client


@pytest.fixture
def anon_client(live_server):
    """No cookie at all. Every data endpoint must answer 401."""
    from .live_client import LiveClient

    return LiveClient(live_server.base_url)


@pytest.fixture(scope="session")
def guard_ctx(hostile_db):
    return hostile_db.catalog, hostile_db.function_policy


# The real production export, produced by aivbank-generator-engineer.
# NOTE: since the 56/56-table build this is a SYMLINK to
# _workspace/release/student/student.duckdb. Both spellings resolve to the same
# 9.1GB file; api/config.py keeps using this path.
#
# AIVB_REAL_STUDENT_DB overrides it. That exists so the "after the generator
# ships the new schema" path can be exercised BEFORE the 9.1GB rebuild lands -
# point it at a small database built to the new contract and the tests that
# currently skip run for real. It is not used in normal runs.
#
# CAVEAT when using the override: test_real_student_db_has_no_answer_key_bytes
# scans the DIRECTORY the file sits in for stray `meta_*` / `cfg_*` artefacts.
# Point the override at a database in a directory of its own, or that one test
# will fail on whatever else happens to be in the scratchpad. Verified run:
#   AIVB_REAL_STUDENT_DB=<new-schema student db> pytest api/tests/test_real_student_db.py
#   -> all permission tests pass against the current Full contract.
REAL_STUDENT_DB = Path(
    os.environ.get(
        "AIVB_REAL_STUDENT_DB",
        str(PROJECT_ROOT / "_workspace" / "output" / "student.duckdb"),
    )
)

# The instructor build. NEVER shipped, opened read-only, and used by the tests
# only as a source of canary values / attack targets.  Allow CI/release jobs to
# provide the exact artifact, then support both repository layouts used by the
# project without embedding a developer-machine path.
_instructor_candidates = (
    PROJECT_ROOT / "_workspace" / "instructor_DO_NOT_SHIP" / "instructor.duckdb",
    PROJECT_ROOT / "instructor.duckdb",
)
INSTRUCTOR_DB = Path(
    os.environ.get(
        "AIVB_REAL_INSTRUCTOR_DB",
        str(next((p for p in _instructor_candidates if p.exists()), _instructor_candidates[0])),
    )
)


#: Ban PostgreSQL THAT dang phuc vu, doi lap voi fixture "thu dich" o tren.
#: Cac test dung fixture nay do lop phong thu 0 (goi hoc vien khong he chua
#: bang bi giau), con fixture thu dich do tang guard mot minh. Can ca hai.
REAL_STUDENT_PG_DB = os.environ.get("AIVB_REAL_PG_STUDENT_DB", "aivb_student")


@pytest.fixture(scope="session")
def real_student_db():
    _require_pg(REAL_STUDENT_PG_DB)
    from backend.db import Database

    db = Database(_pg_settings(REAL_STUDENT_PG_DB, query_timeout_s=10.0))
    yield db
    db.close()


@pytest.fixture(scope="session")
def real_guard_ctx(real_student_db):
    return real_student_db.catalog, real_student_db.function_policy
