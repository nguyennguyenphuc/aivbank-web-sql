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

# The auth store lives in its own SUBDIRECTORY, never beside a dataset file -
# api.config.assert_auth_store_isolated refuses to start otherwise, and the
# test harness has to obey the same rule the server does.
AUTH_DIR = FIXTURE_DIR / "auth"
AUTH_DB = AUTH_DIR / "auth.sqlite3"
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
os.environ.setdefault("AIVB_AUTH_DB_PATH", str(AUTH_DB))
os.environ.setdefault("AIVB_AUDIT_LOG_PATH", str(AUDIT_LOG))
# Bat buoc, khong phai cho gon. `Settings.gamification_db_path` mac dinh la
# DEFAULT_AUTH_DB_PATH.with_name(...) - tuc la CHOT CUNG vao C:\ProgramData, chu
# khong di theo AIVB_AUTH_DB_PATH o tren. Thieu dong nay thi moi lan chay pytest
# lai ghi diem vao kho THAT: `test_student` va `test_instructor` xuat hien tren
# bang xep hang cua lop, va khong co gi bao.
os.environ.setdefault("AIVB_GAMIFICATION_DB_PATH", str(AUTH_DIR / "gamification.sqlite3"))
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


@pytest.fixture(scope="session")
def auth_store():
    """A throwaway credential store with one student and one instructor.

    Rebuilt from scratch each session so lockout counters and sessions from a
    previous run cannot make a test pass or fail for the wrong reason.
    """
    from backend.authstore import AuthStore

    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(AUTH_DB) + suffix)
        if candidate.exists():
            candidate.unlink()
    if AUDIT_LOG.exists():
        AUDIT_LOG.unlink()

    store = AuthStore(AUTH_DB)
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
