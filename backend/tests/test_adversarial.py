"""Extra attack vectors thought up beyond the brief, plus service-resilience.

Every test here corresponds to an attack idea that is NOT in the original task
list. Results are reported honestly in the handover notes, including anything
that gets through.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request

import pytest

from backend.guard import GuardRejection, validate

from .attacks import INSTRUCTOR_TABLES


def _validate(sql, ctx, row_limit=100):
    catalog, policy = ctx
    return validate(sql, catalog, policy, max_sql_chars=20000, row_limit=row_limit)


def _blocked(sql, ctx):
    try:
        _validate(sql, ctx)
    except GuardRejection:
        return True
    return False


# --- ATTACK IDEA 1 -------------------------------------------------------
# Hide the instructor table inside a lambda / list-comprehension body, which
# is a part of the AST that a naive "scan the FROM clause" guard never visits.
LAMBDA_ATTACKS = [
    "SELECT list_transform([1], x -> (SELECT count(*) FROM meta_dirty_log))",
    "SELECT list_filter([1], x -> EXISTS (SELECT 1 FROM meta_scenario_label))",
    "SELECT [x FOR x IN (SELECT label FROM meta_scenario_label)]",
]


@pytest.mark.parametrize("sql", LAMBDA_ATTACKS)
def test_attack_lambda_body(sql, guard_ctx):
    assert _blocked(sql, guard_ctx), f"lambda-body attack got through: {sql}"


# --- ATTACK IDEA 2 -------------------------------------------------------
# Identifier-folding divergence: find a spelling that Python's str.lower()
# maps into the allowlist while DuckDB folds it to something else. Also make
# sure the SQL we execute always uses the canonical, quoted identifier.
FOLDING_ATTACKS = [
    'SELECT * FROM "META_DIRTY_LOG"',
    'SELECT * FROM "Meta_Dirty_Log"',
    "SELECT * FROM MeTa_DiRtY_lOg",
    'SELECT * FROM "meta_dirty_log "',      # trailing space in identifier
    'SELECT * FROM " meta_dirty_log"',
    'SELECT * FROM "meta_dirty_lo" || "g"',  # not a valid identifier path
]


@pytest.mark.parametrize("sql", FOLDING_ATTACKS)
def test_attack_identifier_folding(sql, guard_ctx):
    assert _blocked(sql, guard_ctx), f"identifier-folding attack got through: {sql}"


def test_executed_sql_uses_canonical_identifiers(guard_ctx):
    v = _validate('SELECT count(*) FROM "CORE_PARTY"', guard_ctx)
    assert '"aivb"."core_party"' in v.inner_sql, v.inner_sql


def test_executed_sql_pins_every_relation_to_the_aivb_schema(guard_ctx):
    """Quan trong hon tren PostgreSQL so voi DuckDB.

    `pg_catalog` LUON dung dau search_path va khong the go ra. Ghim moi quan he
    vao schema `aivb` nghia la mot ten khong dat truoc schema khong bao gio co
    the phan giai ve pg_catalog.
    """
    v = _validate("SELECT count(*) FROM aivb.core_party", guard_ctx)
    assert '"aivb"."core_party"' in v.inner_sql
    v2 = _validate("SELECT count(*) FROM core_party", guard_ctx)
    assert '"aivb"."core_party"' in v2.inner_sql


# --- ATTACK IDEA 3 -------------------------------------------------------
# Blind existence oracle: make the API behave differently for a hidden table
# vs. a table that truly does not exist (status, error code, message, timing).
def test_no_existence_oracle_via_status_or_code(client):
    hidden = client.post("/query", json={"sql": "SELECT * FROM meta_dirty_log"})
    absent = client.post("/query", json={"sql": "SELECT * FROM zzz_not_a_table"})
    assert hidden.status_code == absent.status_code
    assert hidden.json()["error_code"] == absent.json()["error_code"]


def test_no_existence_oracle_via_timing(client):
    def timed(sql):
        samples = []
        for _ in range(12):
            t0 = time.perf_counter()
            client.post("/query", json={"sql": sql})
            samples.append(time.perf_counter() - t0)
        samples.sort()
        return samples[len(samples) // 2]

    hidden = timed("SELECT * FROM meta_dirty_log")
    absent = timed("SELECT * FROM zzz_not_a_table")
    # Both are refused by the guard before touching DuckDB, so the medians
    # should be the same order of magnitude.
    assert abs(hidden - absent) < 0.05, (hidden, absent)


# --- ATTACK IDEA 4 -------------------------------------------------------
# CTE-name oracle: a student probes which names are "reserved" to enumerate
# hidden relations. The reserved set must be the full 96-table contract (public
# information from the parameter book), never just the hidden ones.
def test_cte_reserved_set_is_not_an_oracle(guard_ctx):
    catalog, _ = guard_ctx
    assert _blocked("WITH meta_dirty_log AS (SELECT 1) SELECT * FROM meta_dirty_log", guard_ctx)
    # A perfectly visible table gives the SAME rejection, so "reserved" does
    # not mean "hidden".
    assert _blocked("WITH core_party AS (SELECT 1) SELECT * FROM core_party", guard_ctx)
    # And a free name is fine.
    assert not _blocked("WITH my_cte AS (SELECT 1) SELECT * FROM my_cte", guard_ctx)


# --- ATTACK IDEA 5 -------------------------------------------------------
# Second-order access: an allowlisted VIEW whose body reads an instructor
# table would tunnel the answer key through an approved name.
def test_leaky_view_is_revoked_at_startup():
    """Fixture `aivb_test_leaky` mang mot view `ref_branch` doc `meta_dirty_log`.

    Tren PostgreSQL phep phat hien nay CHINH XAC hon ban DuckDB: DuckDB do bang
    regex tren van ban SQL cua view, con o day di theo do thi phu thuoc that
    (`pg_rewrite` + `pg_depend`), nen khong bo sot khi ten bi dat trong ngoac
    kep, co bi danh, hay co schema.
    """
    from backend.db import Database
    from .conftest import LEAKY_DB, _pg_settings, _require_pg

    _require_pg(LEAKY_DB)
    db = Database(_pg_settings(LEAKY_DB))
    try:
        assert not db.catalog.is_allowed("ref_branch"), (
            "a view tunnelling to meta_dirty_log stayed in the allowlist"
        )
        assert "ref_branch" not in {t.name for t in db.catalog.list_tables()}
    finally:
        db.close()


# --- ATTACK IDEA 6 -------------------------------------------------------
# Denial of service / starvation: several heavy queries at once must not make
# the shared service unresponsive, and must not be able to run forever.
def test_service_stays_responsive_under_heavy_load(client):
    heavy = (
        "SELECT count(*) FROM core_party a, core_party b, core_party c, "
        "core_party d, core_party e"
    )
    results: list[int] = []

    def hammer():
        r = client.post("/query", json={"sql": heavy})
        results.append(r.status_code)

    threads = [threading.Thread(target=hammer) for _ in range(6)]
    for t in threads:
        t.start()
    time.sleep(0.5)

    # /health must still answer promptly while the pool is saturated.
    t0 = time.perf_counter()
    r = client.get("/health")
    health_latency = time.perf_counter() - t0
    assert r.status_code == 200
    assert health_latency < 5.0, f"/health blocked for {health_latency:.1f}s"

    for t in threads:
        t.join(timeout=60)
    assert all(not t.is_alive() for t in threads)
    assert results, "no heavy query finished"
    # Every heavy query is either timed out (408) or shed (503). None succeed.
    assert set(results) <= {408, 503}, results


def test_service_recovers_after_load(client):
    r = client.post("/query", json={"sql": "SELECT count(*) AS n FROM core_party"})
    assert r.status_code == 200
    assert r.json()["rows"][0][0] > 0


# --- ATTACK IDEA 7 -------------------------------------------------------
# HTTP-layer abuse of the schema endpoint: path traversal, injection through
# the {table_name} path parameter.
@pytest.mark.parametrize(
    "raw",
    [
        "core_party%22%3B%20DROP%20TABLE%20core_party%3B--",
        "..%2F..%2Fetc%2Fpasswd",
        "meta_dirty_log%00",
        "core_party%20UNION%20SELECT",
        "%2A",
    ],
)
def test_schema_path_param_abuse(raw, client):
    r = client.get(f"/schema/tables/{raw}")
    assert r.status_code in (404, 400), r.text
    blob = r.text.lower()
    for bad in INSTRUCTOR_TABLES:
        if bad in raw.lower():
            continue
        assert bad not in blob


def test_row_count_helper_rejects_non_allowlisted(hostile_db):
    for bad in INSTRUCTOR_TABLES:
        assert hostile_db.table_row_count(bad) is None
    assert hostile_db.table_row_count('core_party"; DROP TABLE core_party; --') is None


# --- ATTACK IDEA 8 -------------------------------------------------------
# Malformed / hostile request bodies.
def test_malformed_bodies(client):
    base = client.base_url
    cases = [
        b"{}",
        b'{"sql": 123}',
        b'{"sql": null}',
        b'{"sql": ["SELECT 1"]}',
        b'{"sql": "SELECT 1", "max_rows": -5}',
        b'{"sql": "SELECT 1", "max_rows": 0}',
        b"not json at all",
        json.dumps({"sql": "SELECT 1", "extra": {"a": [1] * 1000}}).encode(),
    ]
    # Raw urllib, deliberately bypassing LiveClient - but the session cookie
    # and the CSRF header still have to be attached by hand, or the request is
    # refused before the JSON body is ever parsed and this stops testing the
    # thing it was written to test.
    headers = {
        "Content-Type": "application/json",
        client.csrf_header: client.csrf_value,
        "Cookie": "; ".join(f"{k}={v}" for k, v in client.cookies.items()),
    }
    for body in cases:
        req = urllib.request.Request(
            base + "/query", data=body, method="POST", headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                assert resp.status == 200, body
        except urllib.error.HTTPError as exc:
            assert exc.code in (400, 422), (body, exc.code)


# --- ATTACK IDEA 9 -------------------------------------------------------
# Response-size bomb: force a huge payload and confirm the size cap engages
# instead of the server trying to serialise gigabytes.
def test_response_size_is_capped(client):
    sql = (
        "SELECT repeat('x', 20000) AS a, repeat('y', 20000) AS b, "
        "repeat('z', 20000) AS c FROM core_party"
    )
    r = client.post("/query", json={"sql": sql})
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert len(r.text) < 12 * 1024 * 1024
    if body["row_count"] < body["row_limit"]:
        assert body["truncated"] is True


# --- ATTACK IDEA 10 ------------------------------------------------------
# Nested / recursive parser abuse must fail closed with a 4xx, never a 500 or
# a crashed worker.
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT " + "(" * 2000 + "1" + ")" * 2000,
        "SELECT * FROM " + " JOIN ".join(["core_party"] * 200) + " ON true",
        "SELECT " + " OR ".join(["1=1"] * 5000),
        "WITH " + ", ".join(f"c{i} AS (SELECT {i} AS x)" for i in range(500))
        + " SELECT * FROM c0",
    ],
    ids=["nested-parentheses", "join-bomb", "or-bomb", "cte-bomb"],
)
def test_parser_abuse_fails_closed(sql, client):
    r = client.post("/query", json={"sql": sql})
    assert r.status_code != 500, r.text[:300]
    assert r.status_code in (200, 400, 408, 413, 422), r.status_code


# --- ATTACK IDEA 11 ------------------------------------------------------
# Exponential-parse CPU bomb. `sqlglot.parse` doubles in cost for every extra
# consecutive ON-less JOIN, so ~200 bytes of SQL used to burn minutes of CPU
# INSIDE the guard, where no DuckDB timeout could reach it. This was a real
# hole found during testing; these tests keep it closed.
@pytest.mark.parametrize("n", [20, 25, 40, 200])
def test_exponential_parse_bomb_rejected_fast(n, guard_ctx):
    sql = "SELECT * FROM " + " JOIN ".join(["core_party"] * n) + " ON true"
    t0 = time.perf_counter()
    with pytest.raises(GuardRejection) as exc:
        _validate(sql, guard_ctx)
    elapsed = time.perf_counter() - t0
    assert exc.value.code == "E_TOO_COMPLEX"
    assert elapsed < 0.5, f"guard spent {elapsed:.2f}s on the bomb"


def test_exponential_parse_bomb_over_http(client):
    sql = "SELECT * FROM " + " JOIN ".join(["core_party"] * 200) + " ON true"
    t0 = time.perf_counter()
    r = client.post("/query", json={"sql": sql})
    elapsed = time.perf_counter() - t0
    assert r.status_code == 400, r.text[:200]
    assert r.json()["error_code"] == "E_TOO_COMPLEX"
    assert elapsed < 5, f"request took {elapsed:.1f}s"


def test_reasonable_join_counts_still_work(guard_ctx):
    """The limit must not break realistic teaching queries."""
    sql = "SELECT * FROM core_party a " + " ".join(
        f"JOIN core_customer c{i} ON c{i}.party_id = a.party_id" for i in range(10)
    )
    assert _validate(sql, guard_ctx).sql

    # CROSS/NATURAL joins never take ON and never trigger the pathology.
    sql = "SELECT * FROM core_party " + " ".join(["CROSS JOIN core_party"] * 12)
    assert _validate(sql, guard_ctx).sql


def test_deep_nesting_rejected_not_crashed(guard_ctx):
    for sql in (
        "SELECT " + "(" * 2000 + "1" + ")" * 2000,
        "SELECT * FROM " + "(SELECT * FROM " * 300 + "core_party" + ")x " * 300,
    ):
        with pytest.raises(GuardRejection):
            _validate(sql, guard_ctx)


def test_health_still_ok_at_the_end(client):
    assert client.get("/health").json()["ok"] is True
