"""End-to-end load probe: real uvicorn + real HTTP + the real 9.1GB student DB.

This is the only measurement that includes admission control
(AIVB_MAX_CONCURRENT_QUERIES), the 15s timeout and the response size cap, i.e.
what a student actually experiences.

    python api/tests/ops_http.py [n_students]

EACH SIMULATED STUDENT SIGNS IN FIRST. That is not decoration: every data
endpoint has required a session since API 1.3.0, and this script predated it -
it was reporting "10 students -> {401: 10}, p50 0.00s" and calling it a result.
An unauthenticated 401 costs nothing and measures nothing, so the numbers were
silently meaningless.

Tai khoan do KHONG con la file tam nua. Tu khi danh tinh chuyen sang
`pg_authid`, `ops_load_probe` la mot VAI TRO PostgreSQL THAT va no SONG SOT qua
moi lan chay. Vi vay lan chay thu hai phai dat lai mat khau chu khong duoc chet
vi "already exists", va script don vai tro do khi xong.
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

# Thu muc tam chi con giu `audit.jsonl`. Kho danh tinh nam trong PostgreSQL
# tu 2026-08, khong con la file.
_WORKDIR = Path(tempfile.mkdtemp(prefix="aivb_ops_http_"))
atexit.register(shutil.rmtree, _WORKDIR, True)

# TODO(2026-08): tan du thoi DuckDB tren mot backend PostgreSQL. `AIVB_DB_PATH`
# khong con duoc `Settings` dung vao viec gi tren duong PostgreSQL; giu lai o day
# chi de khong doi hanh vi cua script trong cung mot lan sua, nhung dung tin no.
os.environ["AIVB_DB_PATH"] = str(REPO_ROOT / "_workspace" / "output" / "student.duckdb")
os.environ["AIVB_CONTRACT_PATH"] = str(
    REPO_ROOT / "_workspace" / "00_spec-reader_column-contract.json"
)
os.environ["AIVB_AUDIT_LOG_PATH"] = str(_WORKDIR / "secrets" / "audit.jsonl")
os.environ.setdefault("AIVB_LOG_LEVEL", "ERROR")

LOAD_USER = "ops_load_probe"
LOAD_PASSWORD = "ops-load-probe-pw-2026"

# See api/tests/ops_bench.py for why `WHERE dirty_flag` was replaced here
# (2026-08-04: the column moved to INSTRUCTOR and is no longer in student.duckdb).
from backend.tests.ops_bench import DQ_SUSPECT_PREDICATE  # noqa: E402

WORKLOAD = {
    "typical GROUP BY": (
        "SELECT gl_account_code, count(*) AS n, sum(amount) AS total "
        "FROM core_gl_entry GROUP BY 1 ORDER BY total DESC"
    ),
    "worst GROUP BY (24.9M keys)": (
        "SELECT gl_entry_id, count(*) FROM core_gl_entry GROUP BY 1"
    ),
    "ORDER BY 24.9M": "SELECT gl_entry_id, amount FROM core_gl_entry ORDER BY amount DESC",
    "DQ scan page": (
        f"SELECT raw_row_id FROM raw_account_transaction WHERE {DQ_SUSPECT_PREDICATE} "
        "ORDER BY raw_row_id LIMIT 1000 OFFSET 300000"
    ),
    "browse 1000 rows": "SELECT * FROM core_gl_entry LIMIT 1000",
}


def rss_mb(pid: int) -> float:
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True
    ).stdout.strip()
    return int(out) / 1024.0 if out else 0.0


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    from backend.authstore import AuthStore  # imported AFTER the env is set
    from backend.config import settings
    from backend.main import app
    from backend.tests.live_client import LiveClient, LiveServer

    from backend.config import settings

    from backend.authstore import UserExistsError
    from backend.pgadmin import admin_conninfo

    # `admin_conninfo()` chu khong `os.environ.get('AIVB_ADMIN_DSN')`: khong cho
    # nao trong kho dat bien do, nen ban cu luon truyen None va `AuthStore._admin`
    # bao "can quyen quan tri vai tro (CREATEROLE)" - dung, nhung khong noi
    # THIEU CAI GI. Ham kia in ca thu tu tim kiem khi khong thay.
    store = AuthStore(
        settings.pg_conninfo_app(),
        user_conninfo=settings.pg_conninfo_as_user,
        admin_conninfo=admin_conninfo(),
        pool_max=2,  # script mot luong, khong can pool day du
    )
    try:
        store.create_user(
            LOAD_USER, "STUDENT", password=LOAD_PASSWORD, must_change_password=False
        )
    except UserExistsError:
        # Vai tro song sot qua lan chay truoc - dat lai mat khau chu khong chet.
        store.set_password(LOAD_USER, LOAD_PASSWORD, must_change_password=False)
    finally:
        store.close()

    print(
        f"settings: max_rows={settings.max_rows} timeout={settings.query_timeout_s}s "
        f"max_concurrent={settings.max_concurrent_queries} "
        f"memory_limit={settings.memory_limit} threads={settings.duckdb_threads}"
    )
    server = LiveServer(app)
    server.start()
    client = LiveClient(server.base_url, timeout=180)
    pid = os.getpid()

    resp = client.login(LOAD_USER, LOAD_PASSWORD)
    if resp.status_code != 200:
        server.stop()
        raise SystemExit(f"load probe could not sign in: {resp.status_code} {resp.text[:200]}")

    health = client.get("/health").json()
    print(f"health: {health}")

    # Fail loudly rather than producing fast, meaningless numbers.
    probe = client.post("/query", json={"sql": "SELECT 1 AS n"})
    if probe.status_code != 200:
        server.stop()
        raise SystemExit(
            f"authenticated probe query failed ({probe.status_code}): {probe.text[:200]}. "
            "Refusing to report timings that measure error responses."
        )

    try:
        for label, sql in WORKLOAD.items():
            statuses: list[int] = []
            lats: list[float] = []
            lock = threading.Lock()
            peak = [rss_mb(pid)]
            stop = threading.Event()

            def monitor() -> None:
                while not stop.is_set():
                    peak.append(rss_mb(pid))
                    time.sleep(0.03)

            def student() -> None:
                t0 = time.perf_counter()
                r = client.post("/query", json={"sql": sql})
                dt = time.perf_counter() - t0
                with lock:
                    statuses.append(r.status_code)
                    lats.append(dt)

            mon = threading.Thread(target=monitor, daemon=True)
            mon.start()
            t0 = time.perf_counter()
            threads = [threading.Thread(target=student) for _ in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            wall = time.perf_counter() - t0
            stop.set()
            mon.join(timeout=2)

            counts = Counter(statuses)
            lats.sort()
            print(
                f"\n{label}\n"
                f"  {n} simultaneous students -> {dict(counts)}\n"
                f"  wall {wall:.1f}s | latency p50 {lats[len(lats)//2]:.2f}s "
                f"max {lats[-1]:.2f}s | server peak RSS {max(peak):.0f} MB"
            )
            # The service must still answer /health while loaded.
            t0 = time.perf_counter()
            ok = client.get("/health").json()["ok"]
            print(f"  /health after the burst: ok={ok} in {(time.perf_counter()-t0)*1000:.0f} ms")
    finally:
        server.stop()


if __name__ == "__main__":
    main()
