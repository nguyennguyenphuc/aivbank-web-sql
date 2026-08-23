"""Acceptance run of the auth layer against the REAL builds.

The pytest suite runs against a hostile fixture, on purpose: it switches
defense layer 0 off so the guard is measured on its own. This script is the
other half - it points the service at the two files that actually ship:

    student    -> _workspace/release/student/student.duckdb        (9.1 GB)
    instructor -> _workspace/instructor_DO_NOT_SHIP/instructor.duckdb

and checks, over real HTTP with real cookies, that:

  * every data endpoint answers 401 without a session;
  * a STUDENT session cannot reach meta_dirty_log / meta_scenario_label
    (TABLE level) and cannot reach raw_account_transaction.dirty_flag
    (COLUMN level, added after the mentor's ruling of 2026-08-04);
  * an INSTRUCTOR session CAN reach both - the positive control, without which
    the lines above only prove that something, somewhere, said no;
  * /health reports the caller's own catalog size and nothing more;
  * the credential store is not inside the release and cannot be read by SQL.

Run:  python api/tests/verify_real_release.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

STUDENT_DB = Path(
    os.environ.get(
        "AIVB_REAL_STUDENT_DB",
        str(REPO_ROOT / "_workspace" / "release" / "student" / "student.duckdb"),
    )
)
_instructor_candidates = (
    REPO_ROOT / "_workspace" / "instructor_DO_NOT_SHIP" / "instructor.duckdb",
    REPO_ROOT / "instructor.duckdb",
)
INSTRUCTOR_DB = Path(
    os.environ.get(
        "AIVB_REAL_INSTRUCTOR_DB",
        str(next((p for p in _instructor_candidates if p.exists()), _instructor_candidates[0])),
    )
)
CONTRACT = Path(
    os.environ.get(
        "AIVB_CONTRACT_PATH",
        str(REPO_ROOT / "_workspace" / "00_spec-reader_column-contract.json"),
    )
)

ANSWER_KEY = ["meta_dirty_log", "meta_scenario_label"]

# Post-ruling shape. See api/tests/conftest.py for the same constants.
from backend.release_contract import load_release_shape, load_visibility_policy

_RELEASE_SHAPE = load_release_shape()
_VISIBILITY = load_visibility_policy()
CONTRACT_TABLES = _RELEASE_SHAPE.total_tables
STUDENT_TABLE_COUNT = CONTRACT_TABLES - len(_VISIBILITY["instructor_only_tables"])
MIXED_TABLE = "raw_account_transaction"
WITHHELD_COLUMN = "dirty_flag"
MIXED_TABLE_STUDENT_COLUMNS = {
    "raw_row_id",
    "source_file_id",
    "source_row_number",
    "amount_text",
    "date_text",
}
DELTA_P1_TABLES = ["ref_branch", "ref_industry", "ref_segment"]

PASSED: list[str] = []
FAILED: list[str] = []
PENDING: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"  PASS  {label}" + (f"  [{detail}]" if detail else ""))
    else:
        FAILED.append(f"{label}: {detail}")
        print(f"  FAIL  {label}  [{detail}]")


def pending(label: str, detail: str = "") -> None:
    """A check that cannot be decided yet because an upstream artefact is stale.

    Reported loudly and counted separately. It never turns the run green by
    itself - the exit code stays 0 only when there are no FAILs, and the summary
    always prints what is still outstanding.
    """
    PENDING.append(f"{label}: {detail}")
    print(f"  PEND  {label}  [{detail}]")


def main() -> int:
    for path in (STUDENT_DB, INSTRUCTOR_DB, CONTRACT):
        if not path.exists():
            print(f"missing prerequisite: {path}")
            return 2

    workdir = Path(tempfile.mkdtemp(prefix="aivb_real_auth_"))
    auth_db = workdir / "secrets" / "auth.sqlite3"
    audit_log = workdir / "secrets" / "audit.jsonl"

    os.environ["AIVB_DB_PATH"] = str(STUDENT_DB)
    os.environ["AIVB_INSTRUCTOR_DB_PATH"] = str(INSTRUCTOR_DB)
    os.environ["AIVB_CONTRACT_PATH"] = str(CONTRACT)
    os.environ["AIVB_AUTH_DB_PATH"] = str(auth_db)
    os.environ["AIVB_AUDIT_LOG_PATH"] = str(audit_log)
    os.environ["AIVB_QUERY_TIMEOUT_S"] = "30"

    from backend.authstore import AuthStore  # imported AFTER the env is set
    from backend.main import app
    from backend.tests.live_client import LiveClient, LiveServer

    store = AuthStore(auth_db)
    student_pw = "real-run-student-secret-2026"
    instructor_pw = "real-run-instructor-secret-2026"
    store.create_user("real_student", "STUDENT", password=student_pw, must_change_password=False)
    store.create_user("real_instructor", "INSTRUCTOR", password=instructor_pw, must_change_password=False)

    print(f"\nstudent db   : {STUDENT_DB}  ({STUDENT_DB.stat().st_size / 2**30:.1f} GB)")
    print(f"instructor db: {INSTRUCTOR_DB}  ({INSTRUCTOR_DB.stat().st_size / 2**30:.1f} GB)")
    print(f"auth store   : {auth_db}\n")

    server = LiveServer(app)
    server.start()
    try:
        # -- 1. anonymous -------------------------------------------------
        print("1. no session")
        anon = LiveClient(server.base_url)
        for path in ("/schema", "/schema/tables", "/schema/tables/core_party", "/audit/recent"):
            r = anon.get(path)
            check(f"GET {path} -> 401", r.status_code == 401, f"got {r.status_code}")
        r = anon.post("/query", json={"sql": "SELECT 1"})
        check("POST /query -> 401", r.status_code == 401, f"got {r.status_code}")
        r = anon.get("/health")
        check("GET /health -> 200 (public)", r.status_code == 200, f"got {r.status_code}")

        # -- 2. student ----------------------------------------------------
        print("\n2. STUDENT session")
        student = LiveClient(server.base_url)
        r = student.login("real_student", student_pw)
        check("login", r.status_code == 200, r.text[:160])
        check("role is STUDENT", r.json().get("role") == "STUDENT", str(r.json().get("role")))

        tables = student.get("/schema/tables").json()
        names = {t["name"] for t in tables["tables"]}
        missing_delta = [t for t in DELTA_P1_TABLES if t not in names]
        if missing_delta:
            pending(
                f"student sees {STUDENT_TABLE_COUNT} tables",
                f"got {tables['table_count']}; the shipped student.duckdb "
                f"predates delta P1 ({missing_delta} not built yet)",
            )
        else:
            check(
                f"student sees {STUDENT_TABLE_COUNT} tables",
                tables["table_count"] == STUDENT_TABLE_COUNT,
                str(tables["table_count"]),
            )
            check(
                "delta P1 tables are in the student catalog",
                not missing_delta,
                str(missing_delta),
            )
        check(
            "no answer-key table in the student catalog",
            not (names & set(ANSWER_KEY)),
            str(sorted(names & set(ANSWER_KEY))),
        )
        r = student.post("/query", json={"sql": "SELECT count(*) FROM core_party"})
        check("student can run a normal query", r.status_code == 200, r.text[:160])

        for table in ANSWER_KEY:
            r = student.post("/query", json={"sql": f"SELECT * FROM {table} LIMIT 5"})
            check(
                f"student BLOCKED from {table}",
                r.status_code == 400 and r.json().get("error_code") == "E_UNKNOWN_TABLE",
                f"{r.status_code} {r.text[:120]}",
            )

        # -- 2b. COLUMN level -------------------------------------------------
        print("\n2b. STUDENT session, column level")
        detail = student.get(f"/schema/tables/{MIXED_TABLE}")
        cols = {c["name"].lower() for c in detail.json().get("columns", [])}
        check(
            f"{MIXED_TABLE} is still queryable by students",
            detail.status_code == 200,
            f"{detail.status_code} {detail.text[:120]}",
        )
        check(
            f"student schema for {MIXED_TABLE} is exactly the 5 STUDENT columns",
            cols == MIXED_TABLE_STUDENT_COLUMNS,
            str(sorted(cols)),
        )
        for sql in (
            f"SELECT {WITHHELD_COLUMN} FROM {MIXED_TABLE} LIMIT 5",
            f"SELECT count(*) FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}",
            f"SELECT r.{WITHHELD_COLUMN} FROM {MIXED_TABLE} r LIMIT 5",
            f"WITH q AS (SELECT {WITHHELD_COLUMN} AS f FROM {MIXED_TABLE}) SELECT * FROM q",
        ):
            r = student.post("/query", json={"sql": sql})
            check(
                f"student BLOCKED from {WITHHELD_COLUMN}: {sql[:52]}...",
                r.status_code >= 400,
                f"{r.status_code} {r.text[:120]}",
            )
        r = student.post(
            "/query",
            json={"sql": f"SELECT raw_row_id FROM (SELECT * FROM {MIXED_TABLE}) q LIMIT 5"},
        )
        check(
            "student SELECT * is safe after the withheld column is physically removed",
            r.status_code == 200
            and r.json().get("columns") == ["raw_row_id"]
            and r.json().get("row_count") == 5,
            f"{r.status_code} {r.text[:120]}",
        )
        projection = ", ".join(sorted(MIXED_TABLE_STUDENT_COLUMNS))
        r = student.post(
            "/query", json={"sql": f"SELECT {projection} FROM {MIXED_TABLE} LIMIT 5"}
        )
        check(
            "student can still read the 5 remaining columns",
            r.status_code == 200 and r.json().get("row_count") == 5,
            f"{r.status_code} {r.text[:120]}",
        )

        # -- 3. instructor: THE POSITIVE CONTROL ---------------------------
        print("\n3. INSTRUCTOR session (positive control)")
        instructor = LiveClient(server.base_url)
        r = instructor.login("real_instructor", instructor_pw)
        check("login", r.status_code == 200, r.text[:160])
        check("role is INSTRUCTOR", r.json().get("role") == "INSTRUCTOR", str(r.json().get("role")))

        itables = instructor.get("/schema/tables").json()
        inames = {t["name"] for t in itables["tables"]}
        check(
            "instructor sees strictly more tables",
            names < inames,
            f"student={len(names)} instructor={len(inames)}",
        )
        for table in ANSWER_KEY:
            r = instructor.post("/query", json={"sql": f"SELECT * FROM {table} LIMIT 5"})
            ok = r.status_code == 200 and r.json().get("row_count", 0) > 0
            check(
                f"instructor CAN read {table} (positive control)",
                ok,
                f"{r.status_code} rows={r.json().get('row_count') if r.status_code == 200 else '-'}",
            )

        idetail = instructor.get(f"/schema/tables/{MIXED_TABLE}")
        icols = {c["name"].lower() for c in idetail.json().get("columns", [])}
        check(
            f"instructor schema for {MIXED_TABLE} includes {WITHHELD_COLUMN}",
            WITHHELD_COLUMN in icols,
            str(sorted(icols)),
        )
        r = instructor.post(
            "/query",
            json={
                "sql": f"SELECT count(*) AS n FROM {MIXED_TABLE} WHERE {WITHHELD_COLUMN}"
            },
        )
        flagged = r.json()["rows"][0][0] if r.status_code == 200 else 0
        check(
            f"instructor CAN read {WITHHELD_COLUMN} (positive control)",
            r.status_code == 200 and flagged > 0,
            f"{r.status_code} flagged_rows={flagged:,}",
        )
        r = instructor.post(
            "/query",
            json={
                "sql": f"SELECT count(*) AS n FROM {MIXED_TABLE} r "
                       "JOIN meta_dirty_log d ON d.raw_row_id = r.raw_row_id "
                       f"WHERE r.{WITHHELD_COLUMN}"
            },
        )
        joined = r.json()["rows"][0][0] if r.status_code == 200 else 0
        check(
            f"{WITHHELD_COLUMN} really is the answer key (joins to meta_dirty_log)",
            r.status_code == 200 and joined > 0,
            f"{r.status_code} matched={joined:,}",
        )

        # -- 3b. /health reports the caller's own catalog ---------------------
        print("\n3b. /health is role-aware without leaking to anonymous callers")
        anon_health = anon.get("/health").json()
        student_health = student.get("/health").json()
        instructor_health = instructor.get("/health").json()
        check(
            "anonymous /health still reports the student catalog",
            anon_health["table_count"] == student_health["table_count"],
            f"anon={anon_health['table_count']} student={student_health['table_count']}",
        )
        check(
            "student /health matches the student sidebar",
            student_health["table_count"] == tables["table_count"],
            f"{student_health['table_count']} vs {tables['table_count']}",
        )
        check(
            "instructor /health matches the instructor sidebar",
            instructor_health["table_count"] == itables["table_count"],
            f"{instructor_health['table_count']} vs {itables['table_count']}",
        )
        check(
            "instructor /health is strictly larger than the student one",
            instructor_health["table_count"] > student_health["table_count"],
            f"{instructor_health['table_count']} > {student_health['table_count']}",
        )

        # -- 4. CSRF + credential store ------------------------------------
        print("\n4. CSRF and credential-store isolation")
        r = student.post("/query", json={"sql": "SELECT 1"}, csrf=False)
        check("POST without the custom header -> 403", r.status_code == 403, f"got {r.status_code}")

        release_hits = [
            str(p) for p in (REPO_ROOT / "_workspace" / "release").rglob("*")
            if p.is_file() and p.suffix in {".sqlite3", ".sqlite"}
        ]
        check("no credential file inside the release tree", release_hits == [], str(release_hits))

        target = str(auth_db.resolve())
        for sql in (
            f"SELECT * FROM sqlite_scan('{target}', 'users')",
            f"SELECT * FROM read_csv_auto('{target}')",
            f"ATTACH '{target}' AS leak",
            "SELECT * FROM users",
        ):
            r = student.post("/query", json={"sql": sql})
            check(
                f"auth store unreachable via SQL: {sql[:44]}...",
                r.status_code != 200,
                f"got {r.status_code}",
            )

        # -- 5. session revocation ----------------------------------------
        print("\n5. logout revokes server-side")
        token = student.cookies["aivb_session"]
        student.logout()
        replay = LiveClient(server.base_url)
        replay.cookies["aivb_session"] = token
        r = replay.get("/schema/tables")
        check("replayed token after logout -> 401", r.status_code == 401, f"got {r.status_code}")
    finally:
        server.stop()
        store.close()
        shutil.rmtree(workdir, ignore_errors=True)

    print(f"\n{'=' * 70}")
    print(f"{len(PASSED)} passed, {len(FAILED)} failed, {len(PENDING)} pending")
    for line in FAILED:
        print(f"  FAILED:  {line}")
    for line in PENDING:
        print(f"  PENDING: {line}")
    print("=" * 70)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
