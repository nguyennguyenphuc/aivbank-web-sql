"""Acceptance tests against the REAL `_workspace/output/student.duckdb`.

The other test modules run against a hostile fixture with defense layer 0
switched off. This module verifies the actual artefact that will be shipped:
layer 0 really is in place, and the guard still blocks everything on top of it.

Skipped automatically if the generator has not produced the file yet.
"""

from __future__ import annotations

import pytest

from backend.guard import GuardRejection, validate

from .attacks import INSTRUCTOR_TABLES, MUST_ALLOW, MUST_BLOCK
from .conftest import (
    DELTA_P1_TABLES,
    MIXED_TABLE,
    MIXED_TABLE_STUDENT_COLUMNS,
    REAL_STUDENT_DB,
    STUDENT_TABLE_COUNT,
    WITHHELD_COLUMN,
)


def _validate(sql, ctx):
    catalog, policy = ctx
    return validate(sql, catalog, policy, max_sql_chars=20000, row_limit=100)


def _require_delta_schema(catalog) -> None:
    """Skip loudly when the shipped file predates the 2026-08-04 delta.

    The generator is rebuilding the student package; until it lands, the file on
    disk is the previous 84-table build. Skipping is honest - asserting a
    smaller number would quietly bless the stale artefact.
    """
    missing = sorted(catalog.contract_student - catalog.physical_tables)
    if missing:
        pytest.skip(
            f"{REAL_STUDENT_DB} predates the 2026-08-04 contract delta: "
            f"{missing} are not in the file yet. Rebuild the student package; "
            f"this test then requires exactly {STUDENT_TABLE_COUNT} tables."
        )


def test_layer0_no_instructor_table_is_physically_present(real_student_db):
    physical = real_student_db.catalog.physical_tables
    for bad in INSTRUCTOR_TABLES:
        assert bad not in physical, f"{bad} physically exists in student.duckdb!"
    leftovers = {t for t in physical if t.startswith(("meta_", "cfg_"))}
    assert not leftovers, leftovers


def test_exposes_exactly_the_student_tables(real_student_db):
    catalog = real_student_db.catalog
    # Holds for every build, stale or current: nothing physically present is
    # being withheld, and nothing outside the contract is exposed.
    assert catalog.hidden_count == 0
    assert catalog.allowed_tables <= catalog.contract_student

    _require_delta_schema(catalog)
    assert len(catalog.allowed_tables) == STUDENT_TABLE_COUNT
    assert catalog.allowed_tables == catalog.contract_student


def test_delta_p1_tables_are_visible_to_students(real_student_db):
    """ref_branch / ref_industry / ref_segment must reach the student catalog."""
    catalog = real_student_db.catalog
    _require_delta_schema(catalog)
    for table in DELTA_P1_TABLES:
        info = catalog.get(table)
        assert info is not None, f"{table} is missing from the student catalog"
        assert info.columns, f"{table} was exposed with no columns"


def test_the_withheld_column_is_never_exposed_on_the_real_build(real_student_db):
    """Column-level permission, measured on the 9.1GB artefact that ships.

    This one does NOT skip on a stale build - it is at its most valuable there.
    The current file still physically carries `dirty_flag`; the catalog must
    hide it anyway, and the guard must refuse it.
    """
    catalog = real_student_db.catalog
    info = catalog.get(MIXED_TABLE)
    assert info is not None, f"{MIXED_TABLE} must stay queryable (5 STUDENT columns)"
    exposed = [c.name.lower() for c in info.columns]
    assert WITHHELD_COLUMN not in exposed, exposed
    assert set(exposed) == set(MIXED_TABLE_STUDENT_COLUMNS), exposed


def test_the_withheld_column_is_refused_by_the_guard_on_the_real_build(
    real_student_db, real_guard_ctx
):
    for sql in (
        f"SELECT {WITHHELD_COLUMN} FROM {MIXED_TABLE}",
        f"SELECT * FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}",
        f"SELECT count(*) FROM {MIXED_TABLE} WHERE r.{WITHHELD_COLUMN}",
        f"WITH q AS (SELECT {WITHHELD_COLUMN} AS f FROM {MIXED_TABLE}) SELECT * FROM q",
    ):
        with pytest.raises(GuardRejection):
            _validate(sql, real_guard_ctx)


def test_no_views_that_could_tunnel(real_student_db):
    """Goi that khong duoc co view nao.

    Mot view mang ten duoc phep nhung ben duoi doc bang bi giau se tuon dap an
    qua mot cai ten guard chap nhan. Cach chac chan nhat la khong co view nao
    ca - va do la trang thai cua goi phat hanh.
    """
    with real_student_db._pool.connection() as con:  # noqa: SLF001
        rows = con.execute(
            "SELECT relname, relkind FROM pg_class "
            "WHERE relnamespace = %s::regnamespace AND relkind IN ('v','m','f')",
            (real_student_db.schema,),
        ).fetchall()
    assert rows == [], f"unexpected views in the student database: {rows}"


@pytest.mark.parametrize("case_id,sql", MUST_BLOCK, ids=[c[0] for c in MUST_BLOCK])
def test_attacks_blocked_on_real_db(case_id, sql, real_guard_ctx):
    with pytest.raises(GuardRejection):
        _validate(sql, real_guard_ctx)


@pytest.mark.parametrize("case_id,sql", MUST_ALLOW, ids=[c[0] for c in MUST_ALLOW])
def test_legit_queries_run_on_real_db(case_id, sql, real_student_db, real_guard_ctx):
    validated = _validate(sql, real_guard_ctx)
    result = real_student_db.execute(validated.sql, timeout_s=10.0, row_limit=100)
    assert result.row_count >= 0


def test_every_exposed_table_is_actually_queryable(real_student_db, real_guard_ctx):
    """The schema endpoint must not advertise anything the guard then refuses.

    Every advertised COLUMN is named explicitly rather than using `SELECT *`.
    That is a stronger check (a column could be listed and still be unusable)
    and it is the only correct one on a build that still physically carries a
    withheld column: there, `SELECT *` over the MIXED table would expand to the
    withheld column, so the guard refuses the star on purpose - see
    test_star_is_refused_only_while_the_build_is_stale below.
    """
    for info in real_student_db.catalog.list_tables():
        projection = ", ".join(f'"{c.name}"' for c in info.columns)
        validated = _validate(
            f"SELECT {projection} FROM {info.name} LIMIT 1", real_guard_ctx
        )
        result = real_student_db.execute(validated.sql, timeout_s=10.0, row_limit=1)
        assert [c.lower() for c in result.columns] == [
            c.name.lower() for c in info.columns
        ], info.name


def test_star_is_refused_only_while_the_build_is_stale(real_student_db, real_guard_ctx):
    """`SELECT *` over the MIXED table: blocked now, allowed after the rebuild.

    While the shipped file still contains `dirty_flag`, a star would hand it
    back, so the guard refuses it. Once the generator ships the column-filtered
    build the column is gone, the star can no longer leak anything, and it must
    go back to working - students write `SELECT *` constantly.
    """
    catalog = real_student_db.catalog
    sql = f"SELECT * FROM {MIXED_TABLE} LIMIT 1"
    if MIXED_TABLE in catalog.leaky_star_tables:
        assert f"{MIXED_TABLE}.{WITHHELD_COLUMN}" in catalog.withheld_columns_present
        with pytest.raises(GuardRejection):
            _validate(sql, real_guard_ctx)
    else:
        assert catalog.withheld_columns_present == frozenset()
        validated = _validate(sql, real_guard_ctx)
        result = real_student_db.execute(validated.sql, timeout_s=10.0, row_limit=1)
        assert WITHHELD_COLUMN not in [c.lower() for c in result.columns]


def test_answer_key_content_is_unreachable(real_student_db, real_guard_ctx):
    for bad in INSTRUCTOR_TABLES:
        for sql in (
            f"SELECT * FROM {bad}",
            f"SELECT * FROM main.{bad}",
            f'SELECT * FROM "{bad}"',
            f"WITH q AS (SELECT * FROM {bad}) SELECT * FROM q",
            f"SELECT * FROM core_party WHERE EXISTS (SELECT 1 FROM {bad})",
        ):
            with pytest.raises(GuardRejection):
                _validate(sql, real_guard_ctx)
