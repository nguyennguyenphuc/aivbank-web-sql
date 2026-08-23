"""Answer-key protection, verified against REAL grading data.

Why this module exists
----------------------
Every earlier permission test proved "the table is not reachable". That was a
weaker statement than it looked, because at the time `meta_scenario_label` and
`meta_dirty_log` were EMPTY. A blocked query and an empty table return the same
thing: nothing. So the tests could not distinguish "the guard protected the
answer key" from "there was no answer key to protect".

Now there is one: 958k scenario labels and 590k dirty-log rows of real grading
truth. This module re-runs the attack corpus with that data physically present
and asserts on CONTENT: no response body, no error message, no schema listing
may ever contain a canary value read straight out of the instructor build.

Two targets are exercised:

  * `fixture_full.duckdb`  - defense layer 0 switched OFF on purpose. The 12
    INSTRUCTOR tables are physically there with the real rows in them, so a
    "blocked" result is attributable to the guard alone.
  * the real `student.duckdb` - the artefact that actually ships (layer 0 on).

Skipped automatically when the instructor build is not present.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.guard import GuardRejection, validate

from .attacks import INSTRUCTOR_TABLES, MUST_BLOCK
from .conftest import (
    CONTRACT,
    HOSTILE_DB,
    INSTRUCTOR_TABLE_COUNT,
    REAL_STUDENT_PG_DB,
    STUDENT_TABLE_COUNT,
)

APP_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_ROOT  # ten cu

# Goi phat hanh nam NGOAI `app/` - `app/` la san pham chay, `_workspace/release/`
# la thu giao cho hoc vien. Dung `REPO_ROOT` o day se tro vao `app/_workspace/`
# khong ton tai, va phep kiem se AM THAM chuyen sang `skip` thay vi bao do.
PROJECT_ROOT = APP_ROOT.parent
INSTRUCTOR_PARQUET = PROJECT_ROOT / "_workspace" / "instructor_DO_NOT_SHIP" / "parquet"

#: Tep ma guard khong duoc de hoc vien cham toi. That, tuyet doi, ton tai.
#: DuckDB doc chung bang `read_parquet`; PostgreSQL bang `pg_read_file` /
#: `lo_import`. Ca hai duong deu phai bi chan.
ANSWER_KEY_FILES = [
    str(INSTRUCTOR_PARQUET / "meta_dirty_log.parquet"),
    str(INSTRUCTOR_PARQUET / "meta_scenario_label.parquet"),
    str(INSTRUCTOR_PARQUET / "meta_validation_result.parquet"),
]

#: Database that chua dap an. Duong tan cong tuong duong voi ATTACH cua DuckDB
#: la tham chieu cheo database va `dblink`.
INSTRUCTOR_PG_DB = "aivb_instructor"


# ---------------------------------------------------------------------------
# Canaries: gia tri THAT, doc mot lan tu ban giang vien.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def canaries() -> list[str]:
    """Doc tu FIXTURE THU DICH, khong tu ban giang vien that.

    Fixture nay mang dung nhung dong do (da chep tu ban giang vien), va doc no
    khong doi hoi ket noi vao `aivb_instructor` - vai tro test khong co quyen
    do, va viec no khong co quyen la mot phan cua thiet ke.
    """
    import psycopg

    from backend.config import Settings

    probe = Settings(pg_db_student=HOSTILE_DB, contract_path=CONTRACT)
    try:
        con = psycopg.connect(probe.pg_conninfo("STUDENT"), connect_timeout=5)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"hostile fixture unavailable: {exc}")

    values: set[str] = set()
    with con:
        con.execute("SET search_path = aivb")
        for sql in (
            "SELECT scenario_label_id, scenario_code, entity_id "
            "FROM aivb.meta_scenario_label LIMIT 25",
            "SELECT dirty_log_id, raw_row_id, dq_rule_id "
            "FROM aivb.meta_dirty_log LIMIT 25",
            "SELECT validation_result_id, validation_id, run_id "
            "FROM aivb.meta_validation_result LIMIT 25",
        ):
            try:
                rows = con.execute(sql).fetchall()
            except psycopg.Error:
                continue
            for row in rows:
                for cell in row:
                    if isinstance(cell, str) and len(cell) >= 8:
                        values.add(cell)
    assert values, "no canary values could be read from the answer key"
    return sorted(values)


def _assert_no_canary(
    text: str, canaries: list[str], context: str, submitted_sql: str = ""
) -> None:
    """No real answer-key VALUE may ever come back, and the server may not
    volunteer the name of a hidden table.

    Echoing a name the student typed is not disclosure: `SELECT * FROM
    meta_dirty_log` and `SELECT * FROM zzz_nope` produce byte-identical
    messages apart from that echo, so it carries no information the student did
    not already supply. `submitted_sql` is what the caller sent, and names that
    appear in it are excluded from the name check.
    """
    lowered = text.lower()
    typed = submitted_sql.lower()
    for value in canaries:
        assert value.lower() not in lowered, (
            f"ANSWER KEY LEAK via {context}: response contained {value!r}"
        )
    for name in INSTRUCTOR_TABLES:
        if name in typed:
            continue
        assert name not in lowered, (
            f"DISCLOSURE via {context}: response volunteered the hidden table "
            f"{name!r}, which the request never mentioned"
        )


# ---------------------------------------------------------------------------
# 0. The fixture really is hostile (otherwise everything below is vacuous)
# ---------------------------------------------------------------------------
def test_hostile_fixture_actually_contains_the_real_answer_key(hostile_db):
    """Guard against a false PASS: if the fixture were empty the attacks below
    would 'succeed' for the wrong reason."""
    with hostile_db._pool.connection() as con:  # noqa: SLF001
        for table, minimum in (
            ("meta_scenario_label", 100_000),
            ("meta_dirty_log", 100_000),
            ("meta_validation_result", 1),
        ):
            n = con.execute(f'SELECT count(*) FROM aivb."{table}"').fetchone()[0]
            assert n >= minimum, (
                f"{table} holds {n} rows; the hostile fixture is not carrying the "
                "real answer key, so these tests would prove nothing. "
                "Re-run api/tests/build_pg_fixtures.py against the instructor build."
            )
    # The visibility policy is release-owned.  This used to pin the v5.1.5
    # value (12) and started failing for the right v5.1.6.3 fixture, which has
    # 23 instructor-only tables.  Keep the positive-control assertion, but
    # derive its expected value from the same independently published owner
    # policy used by the rest of the release tests.
    assert hostile_db.catalog.hidden_count == INSTRUCTOR_TABLE_COUNT


# ---------------------------------------------------------------------------
# 1. The whole attack corpus, over real HTTP, with real answer key in place
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("case_id,sql", MUST_BLOCK, ids=[c[0] for c in MUST_BLOCK])
def test_corpus_blocked_over_http_with_real_answer_key(case_id, sql, client, canaries):
    r = client.post("/query", json={"sql": sql})
    assert r.status_code >= 400, f"{case_id} was EXECUTED: {r.text[:400]}"
    _assert_no_canary(r.text, canaries, f"POST /query [{case_id}]", sql)


# ---------------------------------------------------------------------------
# 2. Leak path 79a - doc THANG tep dap an tren dia
# ---------------------------------------------------------------------------
# Giu nguyen cac payload kieu DuckDB (`read_parquet`, `glob`, ...): tren
# PostgreSQL chung phan giai thanh `exp.Anonymous` va PHAI bi nhanh fail-closed
# tu choi. Neu mot ngay nao do chung duoc cho qua thi day la cho bao.
# Them vao do la duong tuong duong CUA POSTGRESQL, von khong ton tai truoc day.
def _parquet_attacks() -> list[tuple[str, str]]:
    cases: list[tuple[str, str]] = []
    for i, path in enumerate(ANSWER_KEY_FILES):
        p = path.replace("\\", "/")
        cases += [
            (f"79a.pg_read_file[{i}]", f"SELECT pg_read_file('{p}')"),
            (f"79a.pg_read_binary[{i}]", f"SELECT pg_read_binary_file('{p}')"),
            (f"79a.pg_stat_file[{i}]", f"SELECT * FROM pg_stat_file('{p}')"),
            (f"79a.lo_import[{i}]", f"SELECT lo_import('{p}')"),
            (
                f"79a.pg_read_in_cte[{i}]",
                f"WITH leak AS (SELECT pg_read_file('{p}') AS c) SELECT * FROM leak",
            ),
            (
                f"79a.pg_read_in_where[{i}]",
                "SELECT count(*) FROM core_party WHERE "
                f"pg_read_file('{p}') IS NOT NULL",
            ),
            (f"79a.copy_from[{i}]", f"COPY core_party FROM '{p}'"),
        ]
    for i, path in enumerate(ANSWER_KEY_FILES):
        cases += [
            (f"79a.read_parquet[{i}]", f"SELECT * FROM read_parquet('{path}')"),
            (f"79a.parquet_scan[{i}]", f"SELECT * FROM parquet_scan('{path}')"),
            (f"79a.string_path[{i}]", f"SELECT * FROM '{path}'"),
            (
                f"79a.parquet_metadata[{i}]",
                f"SELECT * FROM parquet_metadata('{path}')",
            ),
            (
                f"79a.in_cte[{i}]",
                f"WITH leak AS (SELECT * FROM read_parquet('{path}')) SELECT * FROM leak",
            ),
            (
                f"79a.in_subquery[{i}]",
                "SELECT count(*) FROM core_party WHERE EXISTS "
                f"(SELECT 1 FROM read_parquet('{path}'))",
            ),
            (
                f"79a.in_join[{i}]",
                "SELECT * FROM core_party p JOIN "
                f"read_parquet('{path}') k ON true",
            ),
            (f"79a.upper[{i}]", f"SELECT * FROM READ_PARQUET('{path}')"),
        ]
    d = str(INSTRUCTOR_PARQUET).replace("\\", "/")
    cases += [
        ("79a.pg_ls_dir", f"SELECT * FROM pg_ls_dir('{d}')"),
        ("79a.pg_ls_dir_scalar", f"SELECT pg_ls_dir('{d}')"),
        ("79a.glob_dir", f"SELECT * FROM read_parquet('{d}/meta_*.parquet')"),
        ("79a.glob_fn", f"SELECT * FROM glob('{d}/*')"),
        (
            "79a.relative",
            "SELECT pg_read_file("
            "'_workspace/instructor_DO_NOT_SHIP/parquet/meta_dirty_log.parquet')",
        ),
        (
            "79a.traversal",
            "SELECT pg_read_file('_workspace/release/student/parquet/../../"
            "instructor_DO_NOT_SHIP/parquet/meta_dirty_log.parquet')",
        ),
        (
            "79a.concat_path",
            f"SELECT pg_read_file('{d}/' || 'meta_dirty_log.parquet')",
        ),
        # PGDATA: doc thang cau hinh may chu, khong lien quan parquet nhung cung
        # mot lop phong thu.
        ("79a.pgdata_conf", "SELECT pg_read_file('postgresql.conf')"),
        ("79a.pgdata_hba", "SELECT pg_read_file('pg_hba.conf')"),
    ]
    return cases


PARQUET_ATTACKS = _parquet_attacks()


@pytest.mark.parametrize(
    "case_id,sql", PARQUET_ATTACKS, ids=[c[0] for c in PARQUET_ATTACKS]
)
def test_leak_79a_read_parquet_on_real_answer_key_files(case_id, sql, client, canaries):
    r = client.post("/query", json={"sql": sql})
    assert r.status_code >= 400, f"{case_id} READ THE ANSWER KEY FILE: {r.text[:400]}"
    _assert_no_canary(r.text, canaries, f"read_parquet [{case_id}]", sql)


# ---------------------------------------------------------------------------
# 3. Leak path 79b - ATTACH the real instructor database
# ---------------------------------------------------------------------------
def _attach_attacks() -> list[tuple[str, str]]:
    """Voi tay sang database CHUA dap an.

    Duoi DuckDB duong nay la `ATTACH <file>`. PostgreSQL khong co ATTACH; duong
    tuong duong la tham chieu CHEO DATABASE va cac cau ham noi ra ngoai
    (`dblink`, `postgres_fdw`).

    Giu lai ca payload `ATTACH` kieu DuckDB: chung phai bi tu choi o buoc phan
    tich cu phap, va neu mot ban sqlglot tuong lai bat dau chap nhan chung thi
    day la cho bao.
    """
    d = INSTRUCTOR_PG_DB
    return [
        # --- tham chieu cheo database (tuong duong ATTACH) ---
        ("79b.cross_db", f"SELECT * FROM {d}.aivb.meta_dirty_log"),
        ("79b.cross_db_quoted", f'SELECT * FROM "{d}"."aivb"."meta_dirty_log"'),
        ("79b.cross_db_scenario", f"SELECT * FROM {d}.aivb.meta_scenario_label"),
        ("79b.cross_db_in_cte",
         f"WITH x AS (SELECT * FROM {d}.aivb.meta_dirty_log) SELECT * FROM x"),
        ("79b.cross_db_in_join",
         f"SELECT * FROM core_party p JOIN {d}.aivb.meta_dirty_log k ON true"),
        # --- noi ra ngoai bang ham ---
        ("79b.dblink",
         f"SELECT * FROM dblink('dbname={d}', 'SELECT * FROM aivb.meta_dirty_log') "
         "AS t(a text)"),
        ("79b.dblink_connect", f"SELECT dblink_connect('dbname={d}')"),
        ("79b.dblink_exec", f"SELECT dblink_exec('dbname={d}', 'SELECT 1')"),
        ("79b.postgres_fdw", "SELECT postgres_fdw_handler()"),
        ("79b.create_extension_dblink", "CREATE EXTENSION dblink"),
        ("79b.create_server",
         f"CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname '{d}')"),
        ("79b.import_foreign_schema",
         "IMPORT FOREIGN SCHEMA aivb FROM SERVER s INTO public"),
        # --- liet ke database ---
        ("79b.pg_database", "SELECT datname FROM pg_database"),
        ("79b.current_database", "SELECT current_database()"),
        # --- payload DuckDB cu: van phai bi tu choi ---
        ("79b.attach_duckdb", "ATTACH 'instructor.duckdb' AS k"),
        ("79b.attach_then_select",
         "ATTACH 'instructor.duckdb' AS k; SELECT * FROM k.main.meta_dirty_log"),
        ("79b.detach", "DETACH k"),
        ("79b.duckdb_databases", "SELECT * FROM duckdb_databases()"),
    ]


ATTACH_ATTACKS = _attach_attacks()


@pytest.mark.parametrize(
    "case_id,sql", ATTACH_ATTACKS, ids=[c[0] for c in ATTACH_ATTACKS]
)
def test_leak_79b_attach_instructor_database(case_id, sql, client, canaries):
    r = client.post("/query", json={"sql": sql})
    assert r.status_code >= 400, f"{case_id} SUCCEEDED: {r.text[:400]}"
    _assert_no_canary(r.text, canaries, f"ATTACH [{case_id}]", sql)


# ---------------------------------------------------------------------------
# 4. Defense in depth: even WITHOUT the guard, the engine must refuse
# ---------------------------------------------------------------------------
# These bypass api.guard entirely and hand the SQL straight to the connection
# the API holds. If the guard ever regresses, layer 1 (read_only=True,
# enable_external_access=False, lock_configuration=True) still has to hold.
ENGINE_LEVEL = [
    ("engine.read_file", f"SELECT pg_read_file('{ANSWER_KEY_FILES[0]}')".replace("\\", "/")),
    ("engine.ls_dir", "SELECT * FROM pg_ls_dir('.')"),
    ("engine.lo_import", "SELECT lo_import('postgresql.conf')"),
    ("engine.cross_db", f"SELECT * FROM {INSTRUCTOR_PG_DB}.aivb.meta_dirty_log"),
    ("engine.dblink", f"SELECT dblink_connect('dbname={INSTRUCTOR_PG_DB}')"),
    ("engine.create_extension", "CREATE EXTENSION dblink"),
    ("engine.set_lc_messages", "SELECT set_config('lc_messages', 'vi_VN', false)"),
    ("engine.set_temp_limit", "SELECT set_config('temp_file_limit', '-1', false)"),
    ("engine.create", "CREATE TABLE hack_probe (a INT)"),
    ("engine.insert", "INSERT INTO core_party SELECT * FROM core_party LIMIT 1"),
    ("engine.update", "UPDATE core_party SET party_id = party_id"),
    ("engine.delete", "DELETE FROM core_party"),
    ("engine.drop", "DROP TABLE core_party"),
    ("engine.copy_out", "COPY core_party TO '/tmp/aivb_leak_probe.csv'"),
    ("engine.copy_program", "COPY core_party FROM PROGRAM 'cmd /c dir'"),
    ("engine.set_role_instructor", "SET ROLE aivb_reader_instructor"),
    ("engine.grant_self", "GRANT CONNECT ON DATABASE aivb_instructor TO aivb_api_student"),
]


@pytest.mark.parametrize("case_id,sql", ENGINE_LEVEL, ids=[c[0] for c in ENGINE_LEVEL])
def test_engine_layer_refuses_even_without_the_guard(case_id, sql, real_student_db):
    """Bo qua `api/guard.py` hoan toan, dua SQL thang cho ket noi cua API.

    Neu guard co ngay nao do thoai lui, lop duoi van phai giu. Tren DuckDB lop
    do la `read_only=True` + `enable_external_access=False` +
    `lock_configuration`. Tren PostgreSQL la vai tro chi co GRANT SELECT, khong
    phai superuser, va cac tham so hang SUSET.

    Lop nay CHINH LA lop duy nhat bao ve nguoi dung BI, vi ho khong di qua guard.
    """
    import psycopg

    with real_student_db._pool.connection() as con:  # noqa: SLF001
        with pytest.raises(psycopg.Error):
            cur = con.execute(sql)
            try:
                cur.fetchone()
            except psycopg.ProgrammingError:
                pass
        con.rollback()


# ---------------------------------------------------------------------------
# 5. The shipped artefact: layer 0 on the real 9.1GB student.duckdb
# ---------------------------------------------------------------------------
def test_real_student_db_has_no_answer_key_bytes(real_student_db):
    """Khong chi 'bang khong co' - khong quan he nao thuoc bat ky loai nao, va
    khong tep dap an nao nam trong GOI PHAT HANH.

    Thu muc duoc quet la `_workspace/release/student` - thu that su duoc giao
    cho hoc vien. Ban DuckDB quet thu muc chua file .duckdb, ma sau khi chuyen
    engine thi khai niem do khong con: `real_student_db` gio la mot TEN
    DATABASE, khong phai duong dan.
    """
    physical = real_student_db.catalog.physical_tables
    for bad in INSTRUCTOR_TABLES:
        assert bad not in physical
    assert not [t for t in physical if t.startswith(("meta_", "cfg_"))]

    shipped = PROJECT_ROOT / "_workspace" / "release" / "student"
    if not shipped.exists():
        pytest.skip(f"goi phat hanh chua duoc dung: {shipped}")
    stray = sorted(
        p.name
        for p in shipped.rglob("*")
        if p.is_file() and p.name.lower().startswith(("meta_", "cfg_", "fact_", "mart_"))
    )
    assert not stray, f"answer-key artefacts shipped in {shipped}: {stray}"


@pytest.mark.parametrize(
    "case_id,sql",
    PARQUET_ATTACKS + ATTACH_ATTACKS,
    ids=[c[0] for c in PARQUET_ATTACKS + ATTACH_ATTACKS],
)
def test_leak_79ab_blocked_against_real_student_db(case_id, sql, real_guard_ctx):
    catalog, policy = real_guard_ctx
    with pytest.raises(GuardRejection):
        validate(sql, catalog, policy, max_sql_chars=20000, row_limit=100)


def test_schema_endpoints_never_mention_the_answer_key(client, canaries):
    for path in ("/schema", "/schema/tables", "/health"):
        r = client.get(path)
        assert r.status_code == 200
        _assert_no_canary(r.text, canaries, f"GET {path}")

    body = client.get("/schema").json()
    assert body["table_count"] == STUDENT_TABLE_COUNT
    names = {t["name"] for t in body["tables"]}
    assert not (names & set(INSTRUCTOR_TABLES))


@pytest.mark.parametrize("table", INSTRUCTOR_TABLES)
def test_table_detail_gives_no_existence_oracle(table, client):
    hidden = client.get(f"/schema/tables/{table}")
    absent = client.get("/schema/tables/zzz_definitely_not_a_table")
    assert hidden.status_code == absent.status_code == 404
    assert hidden.json()["error_code"] == absent.json()["error_code"]
    # The only difference allowed is the echoed name the caller already knew.
    a = json.loads(hidden.text.replace(table, "NAME"))
    b = json.loads(absent.text.replace("zzz_definitely_not_a_table", "NAME"))
    assert a == b


def test_error_text_never_confirms_existence(client, canaries):
    """A hidden table and a typo must produce byte-identical errors, apart from
    the name the student typed."""
    hidden = client.post("/query", json={"sql": "SELECT * FROM meta_scenario_label"})
    absent = client.post("/query", json={"sql": "SELECT * FROM zzz_nope"})
    a = hidden.json()
    b = absent.json()
    assert a["error_code"] == b["error_code"]
    assert a["message"].replace("meta_scenario_label", "X") == b["message"].replace(
        "zzz_nope", "X"
    )
    _assert_no_canary(json.dumps(b), canaries, "typo error message")


def test_column_level_probing_is_not_an_oracle(client):
    """Guessing a real answer-key COLUMN must not behave differently from
    guessing a nonsense one."""
    real_col = client.post(
        "/query", json={"sql": "SELECT scenario_code FROM meta_scenario_label"}
    )
    fake_col = client.post(
        "/query", json={"sql": "SELECT zzz_no_such_col FROM meta_scenario_label"}
    )
    assert real_col.status_code == fake_col.status_code == 400
    assert real_col.json()["error_code"] == fake_col.json()["error_code"] == "E_UNKNOWN_TABLE"


def test_contract_path_is_not_readable_through_sql(client, canaries):
    """The column contract JSON names all 96 tables; reading it would enumerate
    the hidden 12."""
    for sql in (
        "SELECT * FROM read_json('/Users/nguyennp/AI/Finance/_workspace/"
        "00_spec-reader_column-contract.json')",
        "SELECT * FROM read_text('/Users/nguyennp/AI/Finance/_workspace/"
        "00_spec-reader_column-contract.json')",
        "SELECT * FROM read_csv('/etc/passwd')",
    ):
        r = client.post("/query", json={"sql": sql})
        assert r.status_code >= 400, r.text[:300]
        _assert_no_canary(r.text, canaries, "file read", sql)
