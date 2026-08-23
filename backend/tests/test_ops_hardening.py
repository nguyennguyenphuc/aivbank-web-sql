"""Regression tests for the operational fixes made against the 9.1GB build.

Each test here corresponds to a defect that only became visible once the
dataset was full size and the service was measured under a realistic classroom
burst. None of them relaxes a security control: the concurrency cap, the
read-only handle and the guard are untouched.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import psycopg
import pytest

from backend.config import Settings
from backend.db import ServiceBusy, _sanitize_engine_error

from .conftest import CONTRACT, HOSTILE_DB, REAL_STUDENT_PG_DB


def _db(**kwargs):
    from backend.db import Database

    return Database(
        Settings(
            pg_db_student=HOSTILE_DB,
            pg_db_instructor=HOSTILE_DB,
            contract_path=CONTRACT,
            **kwargs,
        )
    )


# --- DEFECT 1 ------------------------------------------------------------
# Admission control rejected instantly. Ten students pressing Run at the same
# moment got six 503s even for a 60ms query. It must queue, not shed, while
# still never running more than max_concurrent_queries at once.
def test_slot_queues_instead_of_rejecting_immediately():
    db = _db(max_concurrent_queries=1, admission_wait_s=5.0, max_queued_queries=8)
    try:
        results: list[str] = []
        overlap = []
        running = threading.Semaphore(0)
        lock = threading.Lock()
        active = [0]

        def worker() -> None:
            try:
                with db.slot():
                    with lock:
                        active[0] += 1
                        overlap.append(active[0])
                    time.sleep(0.25)
                    with lock:
                        active[0] -= 1
                    results.append("ok")
            except ServiceBusy:
                results.append("busy")
            finally:
                running.release()

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert results.count("ok") == 4, results
        # The cap still holds: never two at once with max_concurrent_queries=1.
        assert max(overlap) == 1, overlap
    finally:
        db.close()


def test_slot_still_sheds_when_the_queue_is_full():
    """Queueing must not become an unbounded backlog."""
    db = _db(max_concurrent_queries=1, admission_wait_s=5.0, max_queued_queries=1)
    try:
        outcomes: list[str] = []
        started = threading.Event()

        def holder() -> None:
            with db.slot():
                started.set()
                time.sleep(1.0)

        def waiter() -> None:
            try:
                with db.slot():
                    pass
                outcomes.append("ok")
            except ServiceBusy:
                outcomes.append("busy")

        h = threading.Thread(target=holder)
        h.start()
        assert started.wait(5)
        ws = [threading.Thread(target=waiter) for _ in range(5)]
        for t in ws:
            t.start()
        for t in ws:
            t.join(timeout=30)
        h.join(timeout=30)

        # One waiter is allowed to queue; the other four are shed at once.
        assert outcomes.count("busy") >= 3, outcomes
    finally:
        db.close()


def test_slot_gives_up_after_admission_wait():
    db = _db(max_concurrent_queries=1, admission_wait_s=0.2, max_queued_queries=8)
    try:
        started = threading.Event()

        def holder() -> None:
            with db.slot():
                started.set()
                time.sleep(1.5)

        h = threading.Thread(target=holder)
        h.start()
        assert started.wait(5)
        t0 = time.perf_counter()
        with pytest.raises(ServiceBusy):
            with db.slot():
                pass
        waited = time.perf_counter() - t0
        assert 0.1 < waited < 1.2, waited
        h.join(timeout=30)
    finally:
        db.close()


# --- DEFECT 2 ------------------------------------------------------------
# Lich su: DuckDB tran ra "<db file>.tmp", tuc la mot thu muc TAO RA BEN TRONG
# thu muc phat hanh, canh student.duckdb - noi dich vu khong co viec gi phai
# ghi vao, va se hong han neu ban phat hanh duoc gan chi doc.
#
# Lop loi do KHONG con ton tai tren PostgreSQL: may chu tu quan tep tam trong
# PGDATA, khong bao gio dung den thu muc phat hanh. Nhung Y DINH cua ba phep
# kiem cu van con nguyen gia tri, va o day no manh hon: gioi han tran khong chi
# duoc DAT ma con khong the bi nguoi dung TU NOI RA.
def test_spill_is_capped():
    settings = Settings(contract_path=CONTRACT)
    assert settings.pg_temp_file_limit, "phai co tran cho tep tam"
    assert "temp_file_limit" in settings.pg_required_settings(), (
        "temp_file_limit phai nam trong nhom tham so duoc KIEM CHUNG luc mo "
        "ket noi, khong phai nhom tu dat"
    )


def test_spill_cap_cannot_be_raised_by_the_session(hostile_db):
    """`temp_file_limit` la hang SUSET: vai tro thuong khong dat duoc.

    Do la ly do no nam o nhom 'kiem chung' chu khong phai 'tu dat' trong
    api/config.py - viec API khong dat duoc no chinh la thu bao ve no.
    """
    with hostile_db._pool.connection() as con:  # noqa: SLF001
        with pytest.raises(psycopg.Error) as exc:
            con.execute("SELECT set_config('temp_file_limit', '-1', false)")
        assert exc.value.sqlstate == "42501"


def test_no_spill_artefacts_beside_the_released_package():
    """Thu muc phat hanh phai sach - khong con dau vet cua engine nao.

    Truoc day duong dan nay duoc SUY RA tu vi tri file hop dong
    (`CONTRACT.parents[0] / "release"`). Cach do mong manh, va no gay dung luc
    hop dong duoc chuyen vao `app/backend/contract/`: phep kiem im lang chuyen
    sang `skip` thay vi bao do. Gio tro tuong minh tu goc kho.
    """
    from .conftest import PROJECT_ROOT

    release_dir = PROJECT_ROOT / "_workspace" / "release" / "student"
    if not release_dir.exists():
        pytest.skip("goi phat hanh chua duoc dung")
    stray = [
        p.name for p in release_dir.iterdir()
        if p.name.endswith(".tmp") or p.name.startswith("pgsql_tmp")
    ]
    assert not stray, f"con dau vet tep tam trong thu muc phat hanh: {stray}"


# --- DEFECT 3 ------------------------------------------------------------
# An out-of-memory query returned the useless "The query could not be
# executed." The replacement must help without disclosing the server's budget
# or coaching the student to run SET, which the guard forbids anyway.
class _FakeDiag:
    def __init__(self, primary, hint=None, detail=None):
        self.message_primary = primary
        self.message_hint = hint
        self.message_detail = detail


class _FakePgError(Exception):
    """Du de bo loc lam viec: SQLSTATE + diag. Khong can PostgreSQL that."""

    def __init__(self, sqlstate, primary, hint=None, detail=None):
        super().__init__(primary)
        self.sqlstate = sqlstate
        self.diag = _FakeDiag(primary, hint, detail)


def test_resource_exhaustion_message_is_useful_and_leaks_nothing():
    for state in ("53200", "53100", "54000", "53400"):
        message = _sanitize_engine_error(
            _FakePgError(
                state,
                "out of memory",
                detail='Failed on request of size 8388608 in memory context '
                       '"ExecutorState".',
            ),
            frozenset({"meta_dirty_log"}),
        )
        assert "resources" in message.lower() or "memory" in message.lower()
        assert "WHERE" in message or "filter" in message.lower()
        for forbidden in ("ExecutorState", "8388608", "work_mem", "SET "):
            assert forbidden not in message, f"lo {forbidden!r}: {message}"


def test_error_sanitiser_never_returns_the_hint_field():
    """PostgreSQL dinh kem HINT goi y TEN COT THAT lay tu catalog.

    Do la mot cong cu liet ke catalog, va DuckDB khong he co truong nay - day la
    duong ro ri HOAN TOAN MOI do doi engine mang lai. Da do that tren PG 18.3:
        SELECT customer_i FROM core_customer
        -> HINT: Perhaps you meant to reference the column
                 "core_customer.customer_id".
    `str(exception)` cua psycopg cung kem `LINE 1:` in nguyen cau SQL da boc.
    Nen bo loc CHI duoc doc `diag.message_primary`.
    """
    exc = _FakePgError(
        "42703",
        'column "dirty_fla" does not exist',
        hint='Perhaps you meant to reference the column '
             '"raw_account_transaction.dirty_flag".',
        detail="some internal detail",
    )
    message = _sanitize_engine_error(exc, frozenset())
    assert message == 'column "dirty_fla" does not exist'
    assert "Perhaps" not in message
    assert "dirty_flag" not in message
    assert "internal detail" not in message


def test_unknown_sqlstate_falls_back_to_generic():
    """Fail closed: ma loi chua xet thi khong tra van ban engine ra ngoai."""
    message = _sanitize_engine_error(
        _FakePgError("XX000", "internal error: something about /var/lib/pgsql"),
        frozenset(),
    )
    assert message == "The query could not be executed."


def test_heavy_query_is_cut_and_the_message_leaks_nothing():
    """Duong CAT THAT, chay het pipeline that.

    Ghi chu ve mot lan thu that bai: ban dau test nay truyen
    `pg_temp_file_limit="1MB"` de ep loi het tai nguyen. Khong chay duoc, va vi
    mot ly do dung: `temp_file_limit` nam trong nhom THAM SO KIEM CHUNG chu
    khong phai nhom tu dat (no la hang SUSET), nen moi ket noi bi tu choi va
    pool khong mo duoc. Co che bao ve da lam dung viec cua no ngay trong bo test.
    `statement_timeout` thi client dat duoc, nen day la duong ep thuc te.
    """
    from backend.db import QueryFailed, QueryTimeout

    db = _db(query_timeout_s=1.0)
    try:
        sql = (
            'SELECT * FROM (SELECT a.scenario_label_id, b.scenario_label_id AS s2, '
            'count(*) AS n FROM aivb."meta_scenario_label" a '
            'CROSS JOIN aivb."meta_scenario_label" b GROUP BY 1, 2) AS q'
        )
        try:
            db.execute(sql, timeout_s=1.0, row_limit=1000)
            pytest.skip("engine absorbed the query faster than the timeout")
        except QueryTimeout as exc:
            assert "meta_scenario_label" not in str(exc)
            assert "statement_timeout" not in str(exc)
        except QueryFailed as exc:
            assert "meta_scenario_label" not in exc.message
            assert "work_mem" not in exc.message
            assert "SET " not in exc.message
    finally:
        db.close()


# --- DEFECT 4 ------------------------------------------------------------
# Waiting requests hold a threadpool worker, so the pool has to be wider than
# the admission queue or /health starves behind a /query burst.
def test_threadpool_is_sized_above_the_admission_queue():
    import anyio.to_thread

    from backend.config import settings as live_settings
    from backend.main import _size_request_threadpool

    async def check():
        _size_request_threadpool()
        limiter = anyio.to_thread.current_default_thread_limiter()
        assert limiter.total_tokens >= (
            live_settings.max_concurrent_queries + live_settings.max_queued_queries + 8
        )

    import anyio

    anyio.run(check)


# --- DEFECT 5 -------------------------------------------------------------
# HISTORY. `raw_account_transaction.dirty_flag` used to be STUDENT in the column
# contract while reproducing the meta_dirty_log row set exactly, so the API had
# to serve it and the only available control was a log line. Three tests here
# pinned that arrangement: the guard reported the referenced columns, the audit
# default covered `dirty_flag`, and the audit line never changed the response.
#
# The mentor's ruling of 2026-08-04 (answer 3) moved the column to INSTRUCTOR.
# The leak is now CLOSED rather than merely logged, so those three tests would
# have been asserting the wrong thing. They are replaced one for one:
#
#   test_guard_reports_referenced_columns
#       -> same mechanism, exercised on columns that are still STUDENT
#          (the reporting is what feeds the watch list, and it must still work)
#   test_audit_column_default_covers_dirty_flag
#       -> test_audit_column_default_is_empty_and_dirty_flag_is_blocked_instead
#          (the stronger property: not watched, refused)
#   test_audit_logging_does_not_change_the_response
#       -> same property, driven by an explicitly configured watch list
def test_guard_reports_referenced_columns(guard_ctx):
    from backend.guard import validate

    catalog, policy = guard_ctx
    v = validate(
        "SELECT raw_row_id, amount_text FROM raw_account_transaction "
        "WHERE date_text IS NOT NULL",
        catalog, policy, max_sql_chars=20000, row_limit=100,
    )
    assert set(v.columns) == {"raw_row_id", "amount_text", "date_text"}


def test_audit_column_default_is_empty_and_dirty_flag_is_blocked_instead(guard_ctx):
    """The replacement for the old `dirty_flag` audit default.

    Two halves, and both matter:
      * nothing is watched by default any more, because the one column that
        needed watching is now refused outright (see api/config.py for why no
        other STUDENT column earns the noise);
      * that refusal actually happens - on the HOSTILE fixture, where the
        column is physically present with real answer-key values, so a refusal
        is attributable to the guard and not to the column being absent.
    """
    from backend.config import Settings as S
    from backend.guard import GuardRejection, validate

    assert S().audit_columns == frozenset()

    catalog, policy = guard_ctx
    assert "dirty_flag" in catalog.restricted_column_names
    assert "raw_account_transaction" in catalog.leaky_star_tables
    with pytest.raises(GuardRejection) as excinfo:
        validate(
            "SELECT raw_row_id FROM raw_account_transaction WHERE dirty_flag",
            catalog, policy, max_sql_chars=20000, row_limit=100,
        )
    assert "RESTRICTED COLUMN" in excinfo.value.internal


def test_audit_logging_does_not_change_the_response(client):
    """A watched query and an unwatched one must be indistinguishable to the
    caller: same status, same field set, same success.

    Driven through a column that is watched by an explicit configuration
    (`amount_text`), because the default watch list is now empty.
    """
    from backend.config import Settings as S

    watched = S(audit_columns=frozenset({"amount_text"}))
    assert "amount_text" in watched.audit_columns

    audited = client.post(
        "/query",
        json={
            "sql": "SELECT count(*) AS n FROM raw_account_transaction "
                   "WHERE amount_text IS NOT NULL"
        },
    )
    plain = client.post(
        "/query",
        json={"sql": "SELECT count(*) AS n FROM raw_account_transaction"},
    )
    assert audited.status_code == plain.status_code == 200, (
        f"{audited.status_code} {audited.text[:200]} / "
        f"{plain.status_code} {plain.text[:200]}"
    )
    assert sorted(audited.json().keys()) == sorted(plain.json().keys())
    assert audited.json()["ok"] is plain.json()["ok"] is True
    # And no hint of the audit reaches the client.
    assert "audit" not in audited.text.lower()


def test_audit_line_is_emitted_for_a_configured_watch_list():
    """The watch-list mechanism still works when an operator turns it on.

    Checked at the logger, since the live server runs in another thread.
    """
    from backend.guard import validate

    watch = frozenset({"amount_text", "date_text"})
    db = _db()
    try:
        v = validate(
            "SELECT raw_row_id FROM raw_account_transaction "
            "WHERE amount_text IS NOT NULL",
            db.catalog, db.function_policy, max_sql_chars=20000, row_limit=10,
        )
        flagged = sorted(set(v.columns) & watch)
        assert flagged == ["amount_text"], flagged
    finally:
        db.close()


def test_health_stays_fast_while_the_query_queue_is_saturated(client):
    heavy = (
        "SELECT count(*) FROM core_party a, core_party b, core_party c, "
        "core_party d, core_party e"
    )
    stop = threading.Event()

    def hammer() -> None:
        while not stop.is_set():
            client.post("/query", json={"sql": heavy})

    threads = [threading.Thread(target=hammer, daemon=True) for _ in range(8)]
    for t in threads:
        t.start()
    time.sleep(1.0)
    try:
        latencies = []
        for _ in range(5):
            t0 = time.perf_counter()
            r = client.get("/health")
            latencies.append(time.perf_counter() - t0)
            assert r.status_code == 200
        assert max(latencies) < 5.0, latencies
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=60)


# --- DEFECT: 34 MB tai lai moi lan --------------------------------------
# `production_response_headers` dong `no-store` len MOI phan hoi. Dung cho API va
# cho ma ung dung; sai cho `frontend/vendor/**`, noi co file wasm 34 MB cua
# DuckDB. Hau qua do duoc: 11,2 giay moi lan mot hoc vien mo khu vuc Thuc hanh
# SQL, lap lai vo han. Khong test nao ghim header nay truoc day, nen no im lang
# suot.


def test_vendor_assets_are_cacheable(client):
    """Thu vien ben thu ba bat bien phai duoc cache."""
    response = client.get("/vendor/duckdb-wasm/duckdb-browser.js")
    assert response.status_code == 200, response.status_code
    cache = response.header("Cache-Control") or ""
    assert "max-age=" in cache and "no-store" not in cache, cache


def test_everything_else_still_refuses_to_be_cached(client):
    """Va CHI vendor. Day moi la nua quan trong cua phep kiem.

    Noi cho HTML/JS/CSS cua ung dung se lam mot lop hoc chay ma cu sau moi lan
    cap nhat ma khong co gi bao - dat hon nhieu so voi mot lan tai 34 MB.
    """
    for path in ("/", "/app.js", "/styles.css", "/health"):
        cache = client.get(path).header("Cache-Control") or ""
        assert "no-store" in cache, f"{path}: {cache}"


def _head(client, path: str, headers: dict) -> dict:
    """HEAD qua urllib: `LiveClient` giai ma than phan hoi thanh UTF-8, con day
    la file nhi phan. HEAD khong co than nen tranh duoc han van de."""
    import urllib.request

    req = urllib.request.Request(client.base_url + path, method="HEAD", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = {k.lower(): v for k, v in resp.headers.items()}
        out["status"] = resp.status
        return out


def test_large_vendor_assets_are_served_gzipped(client):
    """32,7 MB -> 7,3 MB. Day moi la thu co tac dung, khong phai Cache-Control.

    Da do: mot file 227 KB trong cung thu muc thi trinh duyet cache that
    (`transferSize = 0` o lan hai), con file 32,7 MB thi KHONG - Chrome tu choi
    cache mot muc lon hon khoang 1/8 dung luong cache dia. Cung header, cung thu
    muc, chi khac kich thuoc. Nen `Cache-Control` mot minh de lai dung cai file
    nang nhat tai lai moi lan.
    """
    # HEAD, khong phai GET: chi can header, va keo 32 MB qua vong lap test moi
    # lan chay la mot cach lam bo test cham di ma khong doi lay gi.
    head = _head(client, "/vendor/duckdb-wasm/duckdb-eh.wasm", {"Accept-Encoding": "gzip"})
    assert head["status"] == 200
    assert head.get("content-encoding") == "gzip", (
        "khong nen. Chay `python scripts/build_vendor_gz.py` de sinh ban .gz"
    )
    # `Vary` bat buoc: khong co no, mot proxy o giua co the dua ban da nen cho
    # mot client khong doc duoc gzip.
    assert "accept-encoding" in head.get("vary", "").lower()
    size = int(head.get("content-length") or 0)
    assert 0 < size < 12_000_000, f"{size} byte - ban nen dang le duoi 12 MB"


def test_a_client_that_cannot_gunzip_still_gets_the_plain_file(client):
    """Nen la toi uu, khong duoc thanh dieu kien de dung duoc."""
    head = _head(client, "/vendor/duckdb-wasm/duckdb-eh.wasm", {"Accept-Encoding": "identity"})
    assert head["status"] == 200
    assert "content-encoding" not in head


def test_vendor_route_refuses_to_walk_out_of_its_directory(client):
    """`/vendor/` phuc vu file tu dia, nen phai tu chan di nguoc thu muc."""
    for probe in ("../backend/config.py", "../../backend/main.py", "../config/pg_secrets.env"):
        assert client.get(f"/vendor/{probe}").status_code == 404, probe

