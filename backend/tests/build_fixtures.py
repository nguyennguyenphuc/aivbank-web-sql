"""Build the two test fixture databases.

  fixture_full.duckdb    - worst case: STUDENT tables + every INSTRUCTOR
                           tables physically present, carrying the REAL
                           answer-key rows copied out of the instructor build,
                           AND the MIXED table still carrying its withheld
                           column (`raw_account_transaction.dirty_flag`).
  fixture_student.duckdb - what production looks like after the 2026-08-04
                           ruling: only tables with a STUDENT part, and within
                           them only the STUDENT columns.

Both are written to the scratchpad, NEVER into _workspace/output, so this
script never touches a database another agent is building.

Row policy
----------
STUDENT tables are capped (AIVB_FIXTURE_STUDENT_ROWS, default 3000) because the
full dataset is ~90M rows / 9.1GB and the guard does not care how many rows a
table has.  INSTRUCTOR tables are copied IN FULL: the whole point of the hostile
fixture is that the real grading answer key (meta_scenario_label,
meta_dirty_log, meta_validation_result) is physically sitting there, so a
"blocked" result proves the guard blocked real data - not that the table was
empty or absent.

Schema policy (added 2026-08-04)
--------------------------------
The source database is whatever build exists on disk and it may predate the
delta overlay in the column contract. The fixture is therefore CONFORMED to the
contract after copying:

  * every contract table that the source lacks is created empty with the
    contract's DuckDB types (currently ref_branch, ref_industry, ref_segment);
  * every contract column that a copied table lacks is added as NULL (currently
    core_customer.home_branch_id / kyc_status, core_person.occupation_code,
    core_organization.industry_code / revenue_band).

Without this the fixtures would silently test yesterday's schema, and every
permission test would be measuring the wrong shape.

Usage:  python api/tests/build_fixtures.py [source.duckdb] [dest_dir]
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "_workspace" / "output"

# Preference order: the richer the source, the more meaningful the test. Any of
# these is opened READ-ONLY and never modified.
SOURCE_CANDIDATES = [
    OUTPUT_DIR / "instructor.duckdb",   # full internal dataset incl. the answer key
    REPO_ROOT / "instructor.duckdb",    # checked-in/local full v5.1.5 build
    REPO_ROOT / "aivb_full.duckdb",
    OUTPUT_DIR / "aivb_full.duckdb",
    OUTPUT_DIR / "student.duckdb",
    REPO_ROOT / "student.duckdb",
]


def default_source() -> Path:
    for candidate in SOURCE_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit(
        "No source database found. Looked for: "
        + ", ".join(str(c) for c in SOURCE_CANDIDATES)
    )
DEFAULT_DEST = Path(
    os.environ.get(
        "AIVB_FIXTURE_DIR",
        str(Path(tempfile.gettempdir()) / "aivb_api_test_fixtures"),
    )
)
CONTRACT = REPO_ROOT / "_workspace" / "00_spec-reader_column-contract.json"

STUDENT_ROW_CAP = int(os.environ.get("AIVB_FIXTURE_STUDENT_ROWS", "3000"))

# Only used when the source database does not contain the table at all, so the
# hostile fixture always has every contract table physically present.
PLACEHOLDER_INSTRUCTOR_TABLES = {
    "meta_scenario_label": (
        "SELECT 'SC001' AS scenario_label_id, 'CHURN' AS scenario_code, "
        "'SYN_PTY_P000001' AS entity_id"
    ),
    "meta_dirty_log": (
        "SELECT 'D001' AS dirty_log_id, 'SYN_RAW_000000001' AS raw_row_id, "
        "'DQ.DUP_RETRY' AS dq_rule_id"
    ),
    "meta_generation_run": "SELECT 'R1' AS run_id",
    "meta_student_release": "SELECT 'REL1' AS release_id",
    "meta_validation_result": "SELECT 'V1' AS validation_result_id",
}

# Tables whose capped sample must be stratified rather than "the first N rows".
# raw_account_transaction is the MIXED table: if the sample happened to contain
# no dirty row, the INSTRUCTOR positive control would return an empty result and
# the column-permission tests would prove nothing.
STRATIFY_ON = {"raw_account_transaction": "dirty_flag"}
FULL_COPY_INSTRUCTOR_PREFIXES = ("meta_", "cfg_")


def _is_instructor_table(name: str, restricted: set[str]) -> bool:
    return name.lower() in restricted


def load_contract(path: Path = CONTRACT) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def contract_columns(contract: dict) -> dict[str, list[dict]]:
    """table -> ordered column specs, straight from the contract."""
    by_table: dict[str, list[dict]] = {}
    for entry in contract["columns"]:
        by_table.setdefault(entry["table_name"].lower(), []).append(entry)
    for cols in by_table.values():
        cols.sort(key=lambda c: c.get("ordinal_position") or 0)
    return by_table


def student_column_names(contract: dict) -> dict[str, list[str]]:
    """table -> the STUDENT columns of that table, in contract order."""
    out: dict[str, list[str]] = {}
    for table, cols in contract_columns(contract).items():
        keep = [c["column_name"] for c in cols if c.get("student_visibility") == "STUDENT"]
        if keep:
            out[table] = keep
    return out


def _physical(con, database: str | None = None) -> dict[str, set[str]]:
    """table -> set of lower-cased column names actually in the database."""
    where = f"WHERE database_name = '{database}'" if database else ""
    rows = con.execute(
        f"SELECT lower(table_name), lower(column_name) FROM duckdb_columns() {where}"
    ).fetchall()
    out: dict[str, set[str]] = {}
    for table, column in rows:
        out.setdefault(table, set()).add(column)
    return out


def conform_to_contract(con, contract: dict) -> tuple[list[str], list[str]]:
    """Create missing contract tables / add missing contract columns, in place.

    Returns (created_tables, added_columns) for the build log.
    """
    by_table = contract_columns(contract)
    present = _physical(con)
    created: list[str] = []
    added: list[str] = []

    for table, cols in sorted(by_table.items()):
        if table not in present:
            body = ", ".join(f'"{c["column_name"]}" {c["duckdb_type"]}' for c in cols)
            con.execute(f'CREATE TABLE main."{table}" ({body})')
            created.append(table)
            continue
        for col in cols:
            name = col["column_name"].lower()
            if name in present[table]:
                continue
            con.execute(
                f'ALTER TABLE main."{table}" ADD COLUMN "{col["column_name"]}" '
                f'{col["duckdb_type"]}'
            )
            added.append(f"{table}.{col['column_name']}")
    return created, added


def build(source: Path, dest_dir: Path) -> tuple[Path, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    full = dest_dir / "fixture_full.duckdb"
    student = dest_dir / "fixture_student.duckdb"
    for p in (full, student):
        for suffix in ("", ".wal"):
            candidate = Path(str(p) + suffix)
            if candidate.exists():
                candidate.unlink()

    contract = load_contract()
    student_cols = student_column_names(contract)
    restricted_tables = set(contract["tables"]) - set(student_cols)

    con = duckdb.connect(str(full))
    con.execute(f"ATTACH '{source}' AS src (READ_ONLY)")
    names = [
        r[0]
        for r in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name='src' ORDER BY 1"
        ).fetchall()
    ]
    src_columns = _physical(con, "src")
    for t in names:
        if _is_instructor_table(t, restricted_tables) and t.lower().startswith(
            FULL_COPY_INSTRUCTOR_PREFIXES
        ):
            # Real answer key, in full. This is the payload the guard must
            # never hand back.
            con.execute(f'CREATE TABLE main."{t}" AS SELECT * FROM src.main."{t}"')
            continue
        flag = STRATIFY_ON.get(t.lower())
        if flag and flag in src_columns.get(t.lower(), set()):
            # Half flagged, half not: the sample keeps both sides of the
            # answer key so the positive control cannot pass vacuously.
            half = max(1, STUDENT_ROW_CAP // 2)
            con.execute(
                f'CREATE TABLE main."{t}" AS '
                f'(SELECT * FROM src.main."{t}" WHERE "{flag}" LIMIT {half}) '
                f'UNION ALL '
                f'(SELECT * FROM src.main."{t}" WHERE NOT "{flag}" LIMIT {half})'
            )
        else:
            con.execute(
                f'CREATE TABLE main."{t}" AS '
                f'SELECT * FROM src.main."{t}" LIMIT {STUDENT_ROW_CAP}'
            )
    con.execute("DETACH src")
    # Any INSTRUCTOR name the source did not have (e.g. a student-only source)
    # still has to exist physically, otherwise the fixture stops being hostile.
    present = {n.lower() for n in names}
    for t, sql in PLACEHOLDER_INSTRUCTOR_TABLES.items():
        if t not in present:
            con.execute(f'CREATE TABLE main."{t}" AS {sql}')
    created, added = conform_to_contract(con, contract)
    con.close()

    con = duckdb.connect(str(student))
    con.execute(f"ATTACH '{full}' AS src (READ_ONLY)")
    src_columns = _physical(con, "src")
    for t in [
        r[0]
        for r in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name='src' ORDER BY 1"
        ).fetchall()
    ]:
        keep = student_cols.get(t.lower())
        if not keep:
            continue
        # Column-level projection, not SELECT *: this is what
        # generator/build_student_db.py now does, and it is the whole point of
        # the MIXED case - raw_account_transaction ships without dirty_flag.
        available = src_columns.get(t.lower(), set())
        projection = ", ".join(f'"{c}"' for c in keep if c.lower() in available)
        if not projection:
            continue
        con.execute(
            f'CREATE TABLE main."{t}" AS SELECT {projection} FROM src.main."{t}"'
        )
    con.execute("DETACH src")
    con.close()
    if created:
        print(f"  conformed: created {len(created)} missing contract table(s): {created}")
    if added:
        print(f"  conformed: added {len(added)} missing contract column(s): {added}")
    return full, student


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else default_source()
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DEST
    print(f"source (read-only): {src}")
    a, b = build(src, dst)
    contract = load_contract()
    n_contract_tables = len(contract["tables"])
    n_student_tables = len(student_column_names(contract))
    restricted_tables = set(contract["tables"]) - set(student_column_names(contract))
    for path in (a, b):
        con = duckdb.connect(str(path), read_only=True)
        names = [r[0] for r in con.execute("SELECT table_name FROM duckdb_tables()").fetchall()]
        for t in ("meta_scenario_label", "meta_dirty_log", "meta_validation_result"):
            if t in names:
                n = con.execute(f'SELECT count(*) FROM main."{t}"').fetchone()[0]
                print(f"    {t}: {n:,} real answer-key rows")
        rat = con.execute(
            "SELECT lower(column_name) FROM duckdb_columns() "
            "WHERE lower(table_name) = 'raw_account_transaction'"
        ).fetchall()
        rat_cols = sorted(c[0] for c in rat)
        if rat_cols:
            extra = ""
            if "dirty_flag" in rat_cols:
                n_dirty = con.execute(
                    "SELECT count(*) FROM main.raw_account_transaction WHERE dirty_flag"
                ).fetchone()[0]
                extra = f", {n_dirty:,} flagged rows"
            print(f"    raw_account_transaction: {len(rat_cols)} cols {rat_cols}{extra}")
        hidden = sorted(n for n in names if n.lower() in restricted_tables)
        con.close()
        print(
            f"built {path}: {len(names)} tables (contract: {n_contract_tables} total / "
            f"{n_student_tables} with a STUDENT part), instructor tables = {len(hidden)}"
        )
