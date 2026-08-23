"""Guard-level tests: validate() must refuse every MUST_BLOCK entry."""

from __future__ import annotations

import json

import pytest

from backend.guard import GuardRejection, validate

from .attacks import INSTRUCTOR_TABLES, MUST_ALLOW, MUST_BLOCK
from .conftest import (
    CONTRACT,
    CONTRACT_COLUMNS,
    CONTRACT_TABLES,
    FULL_CONTRACT_TABLES,
    INSTRUCTOR_TABLE_COUNT,
    MIXED_TABLE,
    MIXED_TABLE_STUDENT_COLUMNS,
    STUDENT_COLUMN_COUNT,
    STUDENT_TABLE_COUNT,
    WITHHELD_COLUMN,
)


def _validate(sql, ctx, row_limit=100):
    catalog, policy = ctx
    return validate(sql, catalog, policy, max_sql_chars=20000, row_limit=row_limit)


@pytest.mark.parametrize("case_id,sql", MUST_BLOCK, ids=[c[0] for c in MUST_BLOCK])
def test_must_block(case_id, sql, guard_ctx):
    with pytest.raises(GuardRejection) as excinfo:
        _validate(sql, guard_ctx)
    rej = excinfo.value
    assert rej.code, f"{case_id}: rejection must carry an error code"
    # The student-facing message must never confirm an instructor table exists.
    lowered = rej.message.lower()
    for name in INSTRUCTOR_TABLES:
        if name in sql.lower():
            continue  # echoing back the student's own identifier is unavoidable
        assert name not in lowered, f"{case_id}: message leaked {name}"


@pytest.mark.parametrize("case_id,sql", MUST_ALLOW, ids=[c[0] for c in MUST_ALLOW])
def test_must_allow(case_id, sql, guard_ctx):
    result = _validate(sql, guard_ctx)
    assert result.sql
    assert "LIMIT 101" in result.sql  # row cap always wrapped on


def test_fixture_really_contains_instructor_tables(hostile_db):
    """Sanity: prove the tests are meaningful, i.e. layer 0 is OFF here."""
    physical = hostile_db.catalog.physical_tables
    for name in INSTRUCTOR_TABLES:
        assert name in physical, f"{name} must physically exist in the hostile fixture"
    assert hostile_db.catalog.hidden_count == len(INSTRUCTOR_TABLES)


def test_instructor_tables_never_in_allowlist(hostile_db):
    for name in INSTRUCTOR_TABLES:
        assert not hostile_db.catalog.is_allowed(name)


def test_contract_counts(hostile_db):
    """The Full release exposes 77 tables and withholds 23 whole tables."""
    assert len(hostile_db.catalog.contract_student) == STUDENT_TABLE_COUNT
    assert len(hostile_db.catalog.contract_restricted) == INSTRUCTOR_TABLE_COUNT
    assert MIXED_TABLE in hostile_db.catalog.contract_student


def test_contract_shape_is_as_ruled():
    """Pin the contract file itself against the numbers in the ruling.

    Every other test in this suite trusts the contract. If it is ever swapped,
    truncated or regenerated without the delta overlay, this fails first and
    says so, instead of a dozen permission tests failing for an obscure reason.
    """
    from backend.catalog import load_contract_visibility

    raw = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert len(raw["tables"]) == CONTRACT_TABLES
    assert len(raw["columns"]) == CONTRACT_COLUMNS
    assert (
        sum(1 for c in raw["columns"] if c["student_visibility"] == "STUDENT")
        == STUDENT_COLUMN_COUNT
    )

    vis = load_contract_visibility(CONTRACT)
    assert len(vis.student_tables) == STUDENT_TABLE_COUNT
    assert len(vis.restricted_tables) == INSTRUCTOR_TABLE_COUNT
    assert vis.mixed_tables == frozenset({MIXED_TABLE})
    assert vis.restricted_columns[MIXED_TABLE] == frozenset({WITHHELD_COLUMN})
    assert vis.student_columns[MIXED_TABLE] == frozenset(MIXED_TABLE_STUDENT_COLUMNS)
    assert vis.restricted_column_names == frozenset({WITHHELD_COLUMN})
    for table in FULL_CONTRACT_TABLES:
        assert table in raw["tables"], f"Full contract table {table} missing"


def test_no_student_column_shares_a_name_with_a_withheld_one():
    """The guard blocks withheld columns by BARE NAME (see Catalog.

    restricted_column_names). That is only free of collateral damage while no
    student-visible column anywhere is spelled the same way. If a future delta
    introduces such a name, this fails and the guard needs table-scoped
    resolution before the contract can ship.
    """
    from backend.catalog import load_contract_visibility

    vis = load_contract_visibility(CONTRACT)
    withheld = vis.restricted_column_names
    clashes = {
        f"{table}.{column}"
        for table, columns in vis.student_columns.items()
        for column in columns
        if column in withheld
    }
    assert not clashes, f"withheld column name(s) also used as STUDENT columns: {clashes}"


def test_non_prefix_student_tables_are_allowed_by_name(hostile_db):
    """`hist_*` and `organization_*` are STUDENT despite not matching the
    documented prefix list - proves we are not using prefix matching."""
    assert "hist_customer_segment" in hostile_db.catalog.contract_student
    assert "organization_financial_snapshot" in hostile_db.catalog.contract_student


def test_limit_wrapper_caps_rows(guard_ctx):
    v = _validate("SELECT * FROM core_party LIMIT 999999999", guard_ctx, row_limit=10)
    assert v.sql.rstrip().endswith("LIMIT 11")


def test_tables_used_reported(guard_ctx):
    v = _validate(
        "SELECT * FROM core_party p JOIN core_customer c ON c.party_id = p.party_id",
        guard_ctx,
    )
    assert v.tables == ("core_customer", "core_party")


def test_executed_sql_is_regenerated_not_raw(guard_ctx):
    v = _validate("SELECT /* sneaky */ 1 AS x", guard_ctx)
    assert "sneaky" not in v.inner_sql
    assert "/*" not in v.inner_sql and "--" not in v.inner_sql


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1 -- */ ; SELECT * FROM meta_dirty_log /*",
        "SELECT 1 /* a */ AS x",
        "-- lead\nSELECT count(*) FROM core_party -- tail",
    ],
)
def test_no_student_comment_text_reaches_duckdb(sql, guard_ctx):
    v = _validate(sql, guard_ctx)
    assert "/*" not in v.sql
    assert "--" not in v.sql
    assert "meta_dirty_log" not in v.sql
