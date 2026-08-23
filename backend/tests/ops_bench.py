"""Operational measurement harness for the 9.1GB student dataset.

NOT part of the pytest suite: this measures resource behaviour, which is
timing/host dependent, and its job is to produce numbers for a config decision
rather than to pass or fail.

Everything here opens the database READ-ONLY through the same api.db.Database
the service uses, so the numbers describe the real service, not a lab setup.

Usage:
    python api/tests/ops_bench.py scope     # is memory_limit global or per-conn?
    python api/tests/ops_bench.py memory    # peak RSS at 1/2/4/8 concurrency
    python api/tests/ops_bench.py latency   # per-query latency + DQ-scan cost
    python api/tests/ops_bench.py extract   # cost of paginating a large filter,
                                            # + how much of the answer key is
                                            #   still reachable without
                                            #   dirty_flag
"""

from __future__ import annotations

import json
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

STUDENT_DB = REPO_ROOT / "_workspace" / "output" / "student.duckdb"
INSTRUCTOR_DB = REPO_ROOT / "_workspace" / "instructor_DO_NOT_SHIP" / "instructor.duckdb"
CONTRACT = REPO_ROOT / "_workspace" / "00_spec-reader_column-contract.json"

# ---------------------------------------------------------------------------
# The heavy raw-staging predicate, rewritten 2026-08-04.
#
# Every query in this file used to filter `raw_account_transaction.dirty_flag`.
# The mentor's ruling of that date moved the column to INSTRUCTOR, so it is not
# in student.duckdb any more and those queries would simply error out.
#
# The replacement uses only columns that are still STUDENT and is, if anything,
# a better benchmark: it is what a student actually writes for the data-quality
# exercise, and it is measurably the same shape of work - a full scan of the
# 7.45M-row staging table producing a ~0.5M-row result (514,405 rows against
# the current build, versus 577,509 for the old `WHERE dirty_flag`).
#
# It is NOT a stand-in for the answer key. How much of the key it recovers is
# itself a measurement, and `extract` reports it against the instructor build.
# ---------------------------------------------------------------------------
DQ_SUSPECT_PREDICATE = (
    "TRY_CAST(amount_text AS DOUBLE) IS NULL OR TRY_CAST(date_text AS DATE) IS NULL"
)

# A genuinely heavy but entirely legitimate student query: GROUP BY over the
# 24.9M-row GL fact table.
HEAVY_GL = """
SELECT gl_account_code, count(*) AS n, sum(amount) AS total
FROM core_gl_entry
GROUP BY gl_account_code
ORDER BY total DESC
"""

HEAVIER_GL = """
SELECT gl_account_code, business_date, count(*) AS n, sum(amount) AS total
FROM core_gl_entry
GROUP BY gl_account_code, business_date
ORDER BY total DESC
"""


def rss_mb() -> float:
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(subprocess.os.getpid())],
        capture_output=True, text=True,
    ).stdout.strip()
    return int(out) / 1024.0 if out else 0.0


class RssSampler:
    """Polls this process's RSS on a background thread."""

    def __init__(self, interval: float = 0.05) -> None:
        self.interval = interval
        self.samples: list[float] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.samples.append(rss_mb())
            time.sleep(self.interval)

    def __enter__(self) -> "RssSampler":
        self.samples.append(rss_mb())
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        self.samples.append(rss_mb())

    @property
    def peak(self) -> float:
        return max(self.samples) if self.samples else 0.0

    @property
    def baseline(self) -> float:
        return self.samples[0] if self.samples else 0.0


def open_db(memory_limit: str = "2GB", max_concurrent: int = 4):
    from backend.config import Settings
    from backend.db import Database

    return Database(
        Settings(
            db_path=STUDENT_DB,
            contract_path=CONTRACT,
            query_timeout_s=120.0,
            memory_limit=memory_limit,
            max_concurrent_queries=max_concurrent,
        )
    )


# ---------------------------------------------------------------------------
def cmd_scope() -> None:
    """Decide empirically whether memory_limit is per-connection or global."""
    import duckdb

    db = open_db("2GB")
    con = db._con
    print("== configuration as the engine reports it ==")
    for setting in ("memory_limit", "threads", "temp_directory", "external_access"):
        try:
            row = con.execute(
                "SELECT value, scope FROM duckdb_settings() WHERE name = ?", [setting]
            ).fetchone()
            print(f"  {setting:18s} = {row}")
        except duckdb.Error as exc:
            print(f"  {setting:18s} ! {exc}")

    # Cursors are what the API hands to each request.
    c1, c2 = con.cursor(), con.cursor()
    v1 = c1.execute("SELECT current_setting('memory_limit')").fetchone()[0]
    v2 = c2.execute("SELECT current_setting('memory_limit')").fetchone()[0]
    print(f"\n  cursor A memory_limit = {v1}")
    print(f"  cursor B memory_limit = {v2}")

    # The decisive question: do two cursors share ONE buffer pool?
    print("\n== buffer pool accounting (duckdb_memory) ==")
    c1.execute("SELECT count(*) FROM core_gl_entry").fetchone()
    total = con.execute(
        "SELECT sum(memory_usage_bytes) FROM duckdb_memory()"
    ).fetchone()[0]
    print(f"  after a scan on cursor A, instance-wide usage = {total/1e6:.1f} MB")
    print(
        "  NOTE: duckdb_memory() is an INSTANCE-level view. A single "
        "duckdb.connect() creates one DatabaseInstance; con.cursor() only adds\n"
        "  a client context to it. memory_limit therefore applies to the whole\n"
        "  process, shared by every concurrent request - not per request."
    )
    c1.close()
    c2.close()
    db.close()


# ---------------------------------------------------------------------------
def cmd_memory() -> None:
    """Peak RSS as concurrency rises, with memory_limit=2GB."""
    print(f"{'conc':>5} {'peak RSS MB':>12} {'delta MB':>10} {'wall s':>8} {'outcome':>28}")
    for conc in (1, 2, 4, 8, 10):
        db = open_db("2GB", max_concurrent=max(conc, 4))
        # Warm the file cache identically for every round.
        db._con.execute("SELECT count(*) FROM core_gl_entry").fetchone()
        outcomes: list[str] = []
        lock = threading.Lock()

        def work(i: int) -> None:
            sql = HEAVY_GL if i % 2 == 0 else HEAVIER_GL
            try:
                db.execute(sql, timeout_s=300.0, row_limit=1000)
                r = "ok"
            except Exception as exc:
                r = type(exc).__name__
            with lock:
                outcomes.append(r)

        with RssSampler() as s:
            t0 = time.perf_counter()
            threads = [threading.Thread(target=work, args=(i,)) for i in range(conc)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            wall = time.perf_counter() - t0
        summary = ",".join(f"{o}x{outcomes.count(o)}" for o in sorted(set(outcomes)))
        print(
            f"{conc:>5} {s.peak:>12.0f} {s.peak - s.baseline:>10.0f} "
            f"{wall:>8.1f} {summary:>28}"
        )
        db.close()
        time.sleep(1)


# ---------------------------------------------------------------------------
def cmd_latency() -> None:
    db = open_db("2GB")
    cases = {
        "trivial count (core_party)": "SELECT count(*) FROM core_party",
        "1000 rows (core_gl_entry)": "SELECT * FROM core_gl_entry LIMIT 1000",
        "GROUP BY 24.9M (core_gl_entry)": HEAVY_GL,
        "GROUP BY 2 keys 24.9M": HEAVIER_GL,
        "DQ scan count": (
            f"SELECT count(*) FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE}"
        ),
        "DQ scan first 1000": (
            f"SELECT raw_row_id FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE} "
            "ORDER BY raw_row_id LIMIT 1000"
        ),
        "DQ scan OFFSET 500000": (
            f"SELECT raw_row_id FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE} "
            "ORDER BY raw_row_id LIMIT 1000 OFFSET 500000"
        ),
        "join 3 tables (7.9M postings)": (
            "SELECT ap.party_id, count(*) AS n, sum(p.amount) AS total "
            "FROM core_account_posting p "
            "JOIN core_account a ON a.account_id = p.account_id "
            "JOIN core_account_party ap ON ap.account_id = a.account_id "
            "GROUP BY 1 ORDER BY 2 DESC"
        ),
    }
    print(f"{'query':>34} {'p50 ms':>9} {'max ms':>9} {'rows':>7}")
    for label, sql in cases.items():
        times, rows = [], 0
        for _ in range(3):
            try:
                t0 = time.perf_counter()
                res = db.execute(sql, timeout_s=300.0, row_limit=1000)
                times.append((time.perf_counter() - t0) * 1000)
                rows = res.row_count
            except Exception as exc:
                print(f"{label:>34}  FAILED: {type(exc).__name__}: {exc}")
                times = []
                break
        if times:
            print(
                f"{label:>34} {statistics.median(times):>9.0f} "
                f"{max(times):>9.0f} {rows:>7}"
            )
    db.close()


# ---------------------------------------------------------------------------
def cmd_extract() -> None:
    """Two questions, one command.

    (1) COST: how expensive is it to page a ~0.5M-row filtered result out
        through a 1000-row API?  (unchanged in spirit; the filter is now the
        student-reachable DQ predicate instead of `WHERE dirty_flag`)

    (2) EXPOSURE: now that `dirty_flag` is INSTRUCTOR-only, how much of
        meta_dirty_log can a student still reconstruct from the columns they DO
        have? This is the number that decides whether the ruling actually
        closed the leak, and it can only be answered by comparing against the
        instructor build - so that half runs read-only against
        instructor.duckdb and is skipped if it is not on this machine.
    """
    db = open_db("2GB")
    total = db.execute(
        f"SELECT count(*) FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE}",
        timeout_s=300.0, row_limit=10,
    ).rows[0][0]
    page = 1000
    pages = -(-total // page)
    print(f"rows a student can select with the DQ predicate : {total:,}")
    print(f"AIVB_MAX_ROWS                                   : {page}")
    print(f"requests needed to page all of them             : {pages:,}")

    samples = []
    for offset in (0, 100_000, 300_000, min(500_000, max(0, total - page)),
                   max(0, total - page)):
        sql = (
            f"SELECT raw_row_id FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE} "
            f"ORDER BY raw_row_id LIMIT {page} OFFSET {offset}"
        )
        t0 = time.perf_counter()
        res = db.execute(sql, timeout_s=300.0, row_limit=page)
        dt = time.perf_counter() - t0
        samples.append(dt)
        print(f"  OFFSET {offset:>7,}: {dt*1000:>7.0f} ms, {res.row_count} rows")
    med = statistics.median(samples)
    print(f"\nmedian page latency  : {med*1000:.0f} ms")
    print(f"serial extraction    : {pages * med:.0f} s  ({pages * med / 60:.1f} min)")
    print(f"at 4x concurrency    : {pages * med / 4:.0f} s  ({pages * med / 240:.1f} min)")
    print(
        "\nBUT: paging is the expensive way and nobody needs it. One single "
        "request\n     aggregates the same set. Throttling page count therefore "
        "does not\n     protect anything - which is exactly why the answer key "
        "had to be\n     removed from the dataset rather than rate-limited."
    )
    db.close()

    _report_residual_exposure()


def _report_residual_exposure() -> None:
    """Precision / recall of the student-reachable DQ set against the answer key.

    Replaces the old "answer rows reachable via dirty_flag: 577,509 (100%/100%)"
    line. That line existed to quantify a leak the API could not close; the leak
    is now closed at the column level, and what is left to quantify is how much
    of the key survives in the columns students legitimately keep.
    """
    import duckdb

    print("\n-- residual exposure vs the answer key (instructor build) --")
    if not INSTRUCTOR_DB.exists():
        print(f"  skipped: {INSTRUCTOR_DB} is not on this machine")
        return
    con = duckdb.connect(str(INSTRUCTOR_DB), read_only=True)
    try:
        key, guess, hit = con.execute(
            f"""
            WITH key AS (SELECT DISTINCT raw_row_id FROM meta_dirty_log),
                 guess AS (
                   SELECT raw_row_id FROM raw_account_transaction
                   WHERE {DQ_SUSPECT_PREDICATE}
                 )
            SELECT (SELECT count(*) FROM key),
                   (SELECT count(*) FROM guess),
                   (SELECT count(*) FROM guess g JOIN key k USING (raw_row_id))
            """
        ).fetchone()
    finally:
        con.close()
    precision = hit / guess if guess else 0.0
    recall = hit / key if key else 0.0
    print(f"  meta_dirty_log rows (the key)      : {key:,}")
    print(f"  rows a student can flag unaided    : {guess:,}")
    print(f"  of those, really in the key        : {hit:,}")
    print(f"  precision / recall                 : {precision:.2%} / {recall:.2%}")
    print(
        "  NOTE: recall < 100% is the point. `WHERE dirty_flag` used to give\n"
        "        100%/100% for free; parsing amount_text / date_text is the\n"
        "        data-quality exercise itself and only recovers the parse-\n"
        "        failure rules, not DQ.DUP_RETRY / LATE_ARRIVE / TZ_SHIFT."
    )


COMMANDS = {
    "scope": cmd_scope,
    "memory": cmd_memory,
    "latency": cmd_latency,
    "extract": cmd_extract,
}

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    for name, fn in COMMANDS.items():
        if which in (name, "all"):
            print(f"\n{'=' * 70}\n{name.upper()}\n{'=' * 70}")
            fn()
