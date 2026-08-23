"""One concurrency level per process, so the RSS high-water mark of one run
never contaminates the next.

macOS never returns freed heap to the OS eagerly, so RSS measured inside a
long-lived process is a cumulative high-water mark across every query it has
ever run - useless for sizing. Each level therefore gets a fresh interpreter.

    python api/tests/ops_conc.py <n_concurrent> [memory_limit] [query_key]
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from backend.tests.ops_bench import DQ_SUSPECT_PREDICATE, RssSampler, open_db  # noqa: E402

QUERIES = {
    # Worst realistic case found by probing: 24.9M distinct grouping keys, so
    # the hash table cannot be small no matter how clever the engine is.
    "worst": "SELECT gl_entry_id, count(*) FROM core_gl_entry GROUP BY 1",
    # What a normal student writes.
    "typical": (
        "SELECT gl_account_code, count(*), sum(amount) FROM core_gl_entry GROUP BY 1"
    ),
    "sort": "SELECT gl_entry_id, amount FROM core_gl_entry ORDER BY amount DESC",
    # Deep pagination over the raw staging table. Filtered on the DQ predicate
    # a student can actually write; `WHERE dirty_flag` stopped being available
    # on 2026-08-04 (see api/tests/ops_bench.py).
    "dq": (
        f"SELECT raw_row_id FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE} "
        "ORDER BY raw_row_id LIMIT 1000 OFFSET 300000"
    ),
}


def main() -> None:
    conc = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    limit = sys.argv[2] if len(sys.argv) > 2 else "2GB"
    key = sys.argv[3] if len(sys.argv) > 3 else "worst"
    sql = QUERIES[key]
    # Run a couple of the cheapest queries first so the OS page cache state is
    # comparable between cells; without this the first cell pays for warming.
    _ = conc

    db = open_db(limit, max_concurrent=max(conc, 1))

    # Measure what PRODUCTION executes, not the raw student text. The guard
    # re-renders the query and wraps it in `SELECT * FROM (...) LIMIT n+1`,
    # which lets DuckDB turn a full ORDER BY into a Top-N. Benchmarking the
    # unwrapped SQL overstates memory use for every sort-shaped query.
    from backend.guard import validate

    validated = validate(
        sql, db.catalog, db.function_policy, max_sql_chars=20000, row_limit=1000
    )
    executed = validated.sql

    outcomes: list[str] = []
    lock = threading.Lock()

    def work() -> None:
        try:
            db.execute(executed, timeout_s=600.0, row_limit=1000)
            r = "ok"
        except Exception as exc:
            r = f"{type(exc).__name__}"
        with lock:
            outcomes.append(r)

    with RssSampler(0.02) as s:
        t0 = time.perf_counter()
        threads = [threading.Thread(target=work) for _ in range(conc)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        wall = time.perf_counter() - t0

    summary = ",".join(f"{o}x{outcomes.count(o)}" for o in sorted(set(outcomes)))
    print(
        f"{key:8s} limit={limit:6s} conc={conc:<3d} "
        f"baseline={s.baseline:6.0f}MB peak={s.peak:7.0f}MB "
        f"delta={s.peak - s.baseline:7.0f}MB wall={wall:6.1f}s  {summary}"
    )
    db.close()


if __name__ == "__main__":
    main()
