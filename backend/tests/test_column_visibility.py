"""COLUMN-level permission, with a mandatory positive control.

Why this module exists
----------------------
Until 2026-08-04 `student_visibility` was effectively a per-TABLE flag, and the
whole suite tested it that way: test_answer_key_real_data.py proves a STUDENT
session is refused `meta_dirty_log` through 11 different syntactic routes while
an INSTRUCTOR session reads it. That is a good test *of table permissions*.

The mentor's ruling of 2026-08-04 (answer 3) moved
`raw_account_transaction.dirty_flag` to INSTRUCTOR while leaving the other five
columns of that table STUDENT. Nothing in the suite covered that: no test
anywhere referenced a column the student may not use.

The trap this module is built to avoid
--------------------------------------
"STUDENT cannot select dirty_flag" is worth nothing on its own. On the shipped
student.duckdb the column is not there at all, so a failure proves only that a
nonexistent column is nonexistent. Every negative assertion here therefore runs
against `fixture_full.duckdb`, where:

  * `dirty_flag` is PHYSICALLY PRESENT with real values copied from the
    instructor build (the fixture builder stratifies the sample so both flagged
    and unflagged rows are in it);
  * the STUDENT and the INSTRUCTOR sessions are pointed at THAT SAME FILE.

So the student being refused and the instructor getting real rows out of the
same bytes, in the same process, is attributable to the permission layer and to
nothing else.
"""

from __future__ import annotations

import pytest

from backend.guard import GuardRejection, validate

from .conftest import (
    DELTA_P1_COLUMNS,
    DELTA_P1_TABLES,
    MIXED_TABLE,
    MIXED_TABLE_STUDENT_COLUMNS,
    STUDENT_TABLE_COUNT,
    WITHHELD_COLUMN,
)

# Every syntactic route to the withheld column we could think of. Mirrors the
# 11-route table-level corpus in test_answer_key_real_data.py.
COLUMN_ATTACKS: list[tuple[str, str]] = [
    ("col.select", f"SELECT {WITHHELD_COLUMN} FROM {MIXED_TABLE}"),
    ("col.select_star_table", f"SELECT * FROM {MIXED_TABLE}"),
    ("col.qualified", f"SELECT r.{WITHHELD_COLUMN} FROM {MIXED_TABLE} r"),
    (
        "col.fully_qualified",
        f"SELECT {MIXED_TABLE}.{WITHHELD_COLUMN} FROM {MIXED_TABLE}",
    ),
    ("col.quoted", f'SELECT "{WITHHELD_COLUMN}" FROM {MIXED_TABLE}'),
    ("col.upper", f"SELECT {WITHHELD_COLUMN.upper()} FROM {MIXED_TABLE}"),
    ("col.mixed_case", "SELECT DiRtY_fLaG FROM raw_account_transaction"),
    ("col.where", f"SELECT raw_row_id FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}"),
    (
        "col.where_not",
        f"SELECT raw_row_id FROM {MIXED_TABLE} WHERE NOT {WITHHELD_COLUMN}",
    ),
    (
        "col.count_filter",
        f"SELECT count(*) AS n FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}",
    ),
    (
        "col.aggregate",
        f"SELECT sum(CASE WHEN {WITHHELD_COLUMN} THEN 1 ELSE 0 END) AS n FROM {MIXED_TABLE}",
    ),
    ("col.group_by", f"SELECT {WITHHELD_COLUMN}, count(*) FROM {MIXED_TABLE} GROUP BY 1"),
    (
        "col.order_by",
        f"SELECT raw_row_id FROM {MIXED_TABLE} ORDER BY {WITHHELD_COLUMN} DESC",
    ),
    (
        "col.having",
        f"SELECT count(*) FROM {MIXED_TABLE} GROUP BY raw_row_id "
        f"HAVING bool_or({WITHHELD_COLUMN})",
    ),
    (
        "col.cte",
        f"WITH q AS (SELECT {WITHHELD_COLUMN} AS f FROM {MIXED_TABLE}) SELECT * FROM q",
    ),
    (
        "col.cte_star",
        f"WITH q AS (SELECT * FROM {MIXED_TABLE}) SELECT * FROM q",
    ),
    (
        "col.subquery",
        f"SELECT raw_row_id FROM (SELECT raw_row_id, {WITHHELD_COLUMN} FROM {MIXED_TABLE}) q",
    ),
    (
        "col.subquery_star",
        f"SELECT raw_row_id FROM (SELECT * FROM {MIXED_TABLE}) q",
    ),
    (
        "col.exists",
        f"SELECT count(*) FROM core_party WHERE EXISTS "
        f"(SELECT 1 FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN})",
    ),
    (
        "col.join",
        f"SELECT r.raw_row_id FROM {MIXED_TABLE} r JOIN core_party p ON true "
        f"WHERE r.{WITHHELD_COLUMN}",
    ),
    (
        "col.union",
        f"SELECT raw_row_id FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN} "
        f"UNION ALL SELECT raw_row_id FROM {MIXED_TABLE}",
    ),
    (
        "col.window",
        f"SELECT raw_row_id, row_number() OVER (PARTITION BY {WITHHELD_COLUMN}) AS rn "
        f"FROM {MIXED_TABLE}",
    ),
    (
        "col.qualify",
        f"SELECT raw_row_id FROM {MIXED_TABLE} "
        f"QUALIFY row_number() OVER (PARTITION BY {WITHHELD_COLUMN}) = 1",
    ),
    # `SELECT * EXCLUDE (...)` la cu phap rieng cua DuckDB. Tren PostgreSQL
    # cach tuong duong de cham cot bi giau la nhac ten no trong mot bieu thuc.
    (
        "col.expression",
        f"SELECT raw_row_id, NOT {WITHHELD_COLUMN} AS inverted FROM {MIXED_TABLE}",
    ),
    ("col.qualified_star", f"SELECT r.* FROM {MIXED_TABLE} r"),
    (
        "col.comment_smuggle",
        f"SELECT /*x*/ {WITHHELD_COLUMN} /*y*/ FROM {MIXED_TABLE}",
    ),
]


# ---------------------------------------------------------------------------
# 0. The fixture really can leak (otherwise everything below is vacuous)
# ---------------------------------------------------------------------------
def test_hostile_fixture_really_carries_the_withheld_column(hostile_db):
    """Guard against a false PASS.

    If `dirty_flag` were absent from the fixture, or present but all-false,
    every refusal below would be true for the wrong reason.
    """
    with hostile_db._pool.connection() as con:  # noqa: SLF001
        columns = {
            r[0].lower()
            for r in con.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'aivb' AND lower(table_name) = %s",
                (MIXED_TABLE,),
            ).fetchall()
        }
        assert WITHHELD_COLUMN in columns, (
            f"{MIXED_TABLE}.{WITHHELD_COLUMN} is not in the hostile fixture; the "
            "column-permission tests would prove nothing. Re-run "
            "api/tests/build_pg_fixtures.py against the instructor build."
        )
        flagged = con.execute(
            f'SELECT count(*) FROM aivb."{MIXED_TABLE}" WHERE {WITHHELD_COLUMN}'
        ).fetchone()[0]
        unflagged = con.execute(
            f'SELECT count(*) FROM aivb."{MIXED_TABLE}" WHERE NOT {WITHHELD_COLUMN}'
        ).fetchone()[0]
        assert flagged > 0 and unflagged > 0, (
            f"the sample must contain both flagged ({flagged}) and unflagged "
            f"({unflagged}) rows, otherwise the column carries no information. "
            "The fixture builder stratifies on this column precisely so that a "
            "head-N truncation cannot make every refusal below vacuous."
        )

        # And it really is the answer key: flagged rows join to meta_dirty_log.
        matched = con.execute(
            f'SELECT count(*) FROM aivb."{MIXED_TABLE}" r '
            'JOIN aivb."meta_dirty_log" d ON d.raw_row_id = r.raw_row_id '
            f"WHERE r.{WITHHELD_COLUMN}"
        ).fetchone()[0]
        assert matched > 0, (
            "no flagged row joins to meta_dirty_log - the fixture's dirty_flag is "
            "not the grading answer key, so the ruling's premise is not reproduced"
        )


def test_the_student_catalog_hides_the_column_but_keeps_the_table(hostile_db):
    catalog = hostile_db.catalog
    info = catalog.get(MIXED_TABLE)
    assert info is not None, "MIXED must not cost students the whole table"
    exposed = {c.name.lower() for c in info.columns}
    assert exposed == set(MIXED_TABLE_STUDENT_COLUMNS)
    assert WITHHELD_COLUMN not in exposed
    assert catalog.restricted_column_names == frozenset({WITHHELD_COLUMN})
    assert catalog.withheld_columns_present == frozenset(
        {f"{MIXED_TABLE}.{WITHHELD_COLUMN}"}
    )


# ---------------------------------------------------------------------------
# 1. Guard level - every route refused
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "case_id,sql", COLUMN_ATTACKS, ids=[c[0] for c in COLUMN_ATTACKS]
)
def test_column_attacks_blocked_by_the_guard(case_id, sql, guard_ctx):
    catalog, policy = guard_ctx
    with pytest.raises(GuardRejection):
        validate(sql, catalog, policy, max_sql_chars=20000, row_limit=100)


# ---------------------------------------------------------------------------
# 2. HTTP level - STUDENT refused ...
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "case_id,sql", COLUMN_ATTACKS, ids=[c[0] for c in COLUMN_ATTACKS]
)
def test_student_cannot_reach_the_withheld_column_over_http(case_id, sql, client):
    r = client.post("/query", json={"sql": sql})
    assert r.status_code >= 400, f"{case_id} was EXECUTED: {r.text[:400]}"
    body = r.json()
    assert body["ok"] is False
    # No result set of any kind came back.
    assert "rows" not in body and "columns" not in body


# The star check is scope-aware, and getting that wrong in the *blocking*
# direction would quietly break normal teaching queries. These pin the boundary
# on the leaky fixture, where the check is active.
STAR_MUST_STILL_WORK = [
    # A star that projects no columns at all.
    ("star.count", f"SELECT count(*) FROM {MIXED_TABLE}"),
    ("star.count_joined", f"SELECT count(*) FROM {MIXED_TABLE} r JOIN core_party p ON true"),
    # A star over a table that has nothing withheld.
    ("star.clean_table", "SELECT * FROM core_party LIMIT 1"),
    ("star.delta_table", "SELECT * FROM ref_branch"),
    # A qualified star that resolves to the clean side of a join.
    (
        "star.qualified_clean_side",
        f"SELECT p.* FROM core_party p JOIN {MIXED_TABLE} r ON true",
    ),
    # A qualified star over a subquery that already projected safe columns.
    (
        "star.over_subquery",
        f"SELECT r.* FROM (SELECT raw_row_id FROM {MIXED_TABLE}) r",
    ),
    # Named STUDENT columns of the MIXED table.
    (
        "star.named_columns",
        f"SELECT raw_row_id, amount_text FROM {MIXED_TABLE} WHERE date_text IS NOT NULL",
    ),
]


@pytest.mark.parametrize(
    "case_id,sql", STAR_MUST_STILL_WORK, ids=[c[0] for c in STAR_MUST_STILL_WORK]
)
def test_the_star_check_does_not_over_block(case_id, sql, guard_ctx):
    catalog, policy = guard_ctx
    assert MIXED_TABLE in catalog.leaky_star_tables, "the check must be active here"
    validate(sql, catalog, policy, max_sql_chars=20000, row_limit=10)


def test_student_query_on_the_remaining_columns_still_works(client):
    """The other half of the ruling: the five STUDENT columns must stay usable.

    Withholding the whole table would have been the easy fix and it would have
    been wrong - the raw-staging exercise lives on these columns.
    """
    projection = ", ".join(MIXED_TABLE_STUDENT_COLUMNS)
    r = client.post(
        "/query", json={"sql": f"SELECT {projection} FROM {MIXED_TABLE} LIMIT 5"}
    )
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert [c.lower() for c in body["columns"]] == list(MIXED_TABLE_STUDENT_COLUMNS)
    assert body["row_count"] == 5


# ---------------------------------------------------------------------------
# 3. ... INSTRUCTOR allowed. THE POSITIVE CONTROL.
# ---------------------------------------------------------------------------
# Without this the tests above prove only that the column could not be reached.
# They do not prove that the permission layer is what stopped it, nor that there
# was anything real behind it. These do.
@pytest.mark.parametrize(
    "case_id,sql", COLUMN_ATTACKS, ids=[c[0] for c in COLUMN_ATTACKS]
)
def test_instructor_can_run_the_same_queries(case_id, sql, instructor_client):
    r = instructor_client.post("/query", json={"sql": sql})
    assert r.status_code == 200, f"{case_id} was refused for an INSTRUCTOR: {r.text[:400]}"
    assert r.json()["ok"] is True


def test_instructor_reads_real_values_out_of_the_withheld_column(instructor_client):
    """Not just 'the query ran' - it returned the grading answer key."""
    r = instructor_client.post(
        "/query",
        json={
            "sql": f"SELECT count(*) AS n FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}"
        },
    )
    assert r.status_code == 200, r.text[:300]
    flagged = r.json()["rows"][0][0]
    assert flagged > 0, "the positive control returned zero flagged rows"

    r = instructor_client.post(
        "/query",
        json={
            "sql": f"SELECT raw_row_id, {WITHHELD_COLUMN} FROM {MIXED_TABLE} "
                   f"WHERE {WITHHELD_COLUMN} ORDER BY raw_row_id LIMIT 5"
        },
    )
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["row_count"] == 5
    assert [c.lower() for c in body["columns"]] == ["raw_row_id", WITHHELD_COLUMN]
    assert all(row[1] is True for row in body["rows"]), body["rows"]

    # And those rows are the answer key: they join to meta_dirty_log.
    r = instructor_client.post(
        "/query",
        json={
            "sql": f"SELECT count(*) AS n FROM {MIXED_TABLE} r "
                   "JOIN meta_dirty_log d ON d.raw_row_id = r.raw_row_id "
                   f"WHERE r.{WITHHELD_COLUMN}"
        },
    )
    assert r.status_code == 200, r.text[:300]
    assert r.json()["rows"][0][0] > 0


def test_student_and_instructor_hit_the_same_database():
    """The positive control is only meaningful if both roles read one database.

    If the instructor were pointed at a different database, 'student blocked /
    instructor allowed' could just be two different sets of rows rather than
    two different permission decisions over the same rows.
    """
    from backend.main import _state

    student_db = _state["db"]
    instructor_db = _state["instructor_db"]
    assert instructor_db is not None, "no instructor connection was configured"
    assert student_db.database_name == instructor_db.database_name
    assert student_db.schema == instructor_db.schema
    assert student_db.expose_restricted is False
    assert instructor_db.expose_restricted is True


# ---------------------------------------------------------------------------
# 4. No oracle: a withheld column looks exactly like a misspelled one
# ---------------------------------------------------------------------------
def test_withheld_column_is_indistinguishable_from_a_typo(client):
    withheld = client.post(
        "/query", json={"sql": f"SELECT {WITHHELD_COLUMN} FROM {MIXED_TABLE}"}
    )
    typo = client.post(
        "/query", json={"sql": f"SELECT zzz_no_such_column FROM {MIXED_TABLE}"}
    )
    assert withheld.status_code == typo.status_code == 400
    a, b = withheld.json(), typo.json()
    assert a["error_code"] == b["error_code"]
    # Same template; only the identifier the student typed differs.
    assert a["message"].replace(WITHHELD_COLUMN, "X") == b["message"].replace(
        "zzz_no_such_column", "X"
    )


def test_qualified_withheld_column_is_indistinguishable_from_a_typo(client):
    withheld = client.post(
        "/query", json={"sql": f"SELECT r.{WITHHELD_COLUMN} FROM {MIXED_TABLE} r"}
    )
    typo = client.post(
        "/query", json={"sql": f"SELECT r.zzz_no_such_column FROM {MIXED_TABLE} r"}
    )
    assert withheld.status_code == typo.status_code == 400
    a, b = withheld.json(), typo.json()
    assert a["error_code"] == b["error_code"]
    assert a["message"].replace(WITHHELD_COLUMN, "X") == b["message"].replace(
        "zzz_no_such_column", "X"
    )


def test_no_endpoint_ever_names_the_withheld_column(client):
    for path in ("/health", "/schema", "/schema/tables", f"/schema/tables/{MIXED_TABLE}"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert WITHHELD_COLUMN not in r.text.lower(), (
            f"GET {path} volunteered the withheld column name"
        )


# ---------------------------------------------------------------------------
# 5. Schema endpoints: what each role is told the table looks like
# ---------------------------------------------------------------------------
def test_schema_detail_shows_five_columns_to_a_student(client):
    body = client.get(f"/schema/tables/{MIXED_TABLE}").json()
    names = [c["name"].lower() for c in body["columns"]]
    assert len(names) == 5
    assert set(names) == set(MIXED_TABLE_STUDENT_COLUMNS)


def test_schema_detail_shows_six_columns_to_an_instructor(instructor_client):
    body = instructor_client.get(f"/schema/tables/{MIXED_TABLE}").json()
    names = [c["name"].lower() for c in body["columns"]]
    assert len(names) == 6
    assert WITHHELD_COLUMN in names


def test_full_schema_column_counts_differ_by_exactly_that_one_column(
    client, instructor_client
):
    student = {t["name"]: len(t["columns"]) for t in client.get("/schema").json()["tables"]}
    instructor = {
        t["name"]: len(t["columns"])
        for t in instructor_client.get("/schema").json()["tables"]
    }
    shared = set(student) & set(instructor)
    differing = {n: (student[n], instructor[n]) for n in shared if student[n] != instructor[n]}
    assert differing == {MIXED_TABLE: (5, 6)}, differing


# ---------------------------------------------------------------------------
# 6. Delta P1: the three new tables must reach the student
# ---------------------------------------------------------------------------
def test_student_schema_lists_the_delta_p1_tables(client):
    body = client.get("/schema/tables").json()
    names = {t["name"] for t in body["tables"]}
    missing = [t for t in DELTA_P1_TABLES if t not in names]
    assert not missing, f"delta P1 tables missing from the student catalog: {missing}"
    assert body["table_count"] == STUDENT_TABLE_COUNT
    assert body["table_count"] == len(names)


def test_student_schema_lists_the_delta_p1_columns(client):
    body = client.get("/schema").json()
    columns = {
        t["name"]: {c["name"].lower() for c in t["columns"]} for t in body["tables"]
    }
    for table, column in DELTA_P1_COLUMNS:
        assert column in columns[table], f"{table}.{column} missing from the student schema"


@pytest.mark.parametrize("table", DELTA_P1_TABLES)
def test_student_can_query_each_delta_p1_table(table, client):
    detail = client.get(f"/schema/tables/{table}")
    assert detail.status_code == 200, detail.text[:200]
    projection = ", ".join(f'"{c["name"]}"' for c in detail.json()["columns"])
    r = client.post("/query", json={"sql": f"SELECT {projection} FROM {table} LIMIT 5"})
    assert r.status_code == 200, f"{table}: {r.text[:300]}"
    assert [c.lower() for c in r.json()["columns"]] == [
        c["name"].lower() for c in detail.json()["columns"]
    ]


# ---------------------------------------------------------------------------
# 7. The production-shaped export: the column is simply not there
# ---------------------------------------------------------------------------
def test_production_shaped_export_has_no_withheld_column(student_db):
    """fixture_student.duckdb is built the way the generator now builds the real
    one: column-level projection, so `dirty_flag` never lands in the file."""
    physical = student_db.catalog.physical_tables
    assert MIXED_TABLE in physical
    info = student_db.catalog.get(MIXED_TABLE)
    assert info is not None
    assert {c.name.lower() for c in info.columns} == set(MIXED_TABLE_STUDENT_COLUMNS)
    assert student_db.catalog.withheld_columns_present == frozenset()
    assert student_db.catalog.leaky_star_tables == frozenset()
    assert student_db.catalog.hidden_column_count == 0


def test_select_star_works_again_once_the_column_is_gone(student_db):
    """`SELECT *` is refused on a leaky file and allowed on a clean one.

    Students write `SELECT *` constantly; the guard must not cost them that
    once the export is built correctly.
    """
    validated = validate(
        f"SELECT * FROM {MIXED_TABLE} LIMIT 5",
        student_db.catalog,
        student_db.function_policy,
        max_sql_chars=20000,
        row_limit=5,
    )
    result = student_db.execute(validated.sql, timeout_s=10.0, row_limit=5)
    assert WITHHELD_COLUMN not in [c.lower() for c in result.columns]
    assert set(c.lower() for c in result.columns) == set(MIXED_TABLE_STUDENT_COLUMNS)


def test_withheld_column_still_refused_on_the_clean_export(student_db):
    """Belt and braces: even where the column cannot exist, naming it fails."""
    with pytest.raises(GuardRejection):
        validate(
            f"SELECT {WITHHELD_COLUMN} FROM {MIXED_TABLE}",
            student_db.catalog,
            student_db.function_policy,
            max_sql_chars=20000,
            row_limit=5,
        )
