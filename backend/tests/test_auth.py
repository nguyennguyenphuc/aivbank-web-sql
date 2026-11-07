"""Acceptance tests for the authentication / authorization layer.

Every test here runs against a REAL uvicorn server over a REAL socket, with a
REAL SQLite credential store and a REAL DuckDB file. Nothing is mocked, and
nothing is asserted by reading the source.

The single most important test in this file is
`test_student_cannot_read_answer_key_but_instructor_can`. It carries its own
positive control: the same query, on the same server, against the same
database file, must SUCCEED for an INSTRUCTOR session. Without that control,
"the student got an error" would prove nothing - it is exactly what you would
also see if the table were missing, the SQL were malformed, or the endpoint
were broken.
"""

from __future__ import annotations

import json
import os
import statistics
import time
from pathlib import Path

import pytest

from backend.authstore import AuthStore, ThrottlePolicy, hash_token
from backend.config import (
    REPO_ROOT,
    Settings,
)

from .conftest import (
    AUDIT_LOG,
    INSTRUCTOR_PASSWORD,
    INSTRUCTOR_USER,
    STUDENT_PASSWORD,
    STUDENT_USER,
)
from .live_client import LiveClient

ANSWER_KEY_TABLES = ["meta_dirty_log", "meta_scenario_label"]


def _audit_records() -> list[dict]:
    """Parse the JSONL audit log.

    A record still being flushed by the server thread can be read back as a
    truncated final line on APFS; that is a property of reading a file while
    it is appended to, not of the log. Unparseable lines are skipped, and the
    tests below assert on the presence of a specific record, so a skipped
    partial line can only ever make a test fail, never pass.
    """
    path = Path(AUDIT_LOG)
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records

PROTECTED_GET = [
    "/schema",
    "/schema/tables",
    "/schema/tables/core_party",
    "/schema/relationships",
    "/schema/game",
    "/audit/recent",
]


def _server_store():
    """The AuthStore object the running app is using (same process)."""
    from backend import main

    store = main._state.get("auth")
    assert store is not None, "the app did not build an auth store"
    return store


# ===========================================================================
# 1. No session -> no data
# ===========================================================================
@pytest.mark.parametrize("path", PROTECTED_GET)
def test_protected_get_endpoints_require_a_session(anon_client, path):
    r = anon_client.get(path)
    assert r.status_code == 401, f"{path} answered {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body["ok"] is False
    assert body["error_code"] == "E_UNAUTHORIZED"


def test_query_requires_a_session(anon_client):
    r = anon_client.post("/query", json={"sql": "SELECT 1"})
    assert r.status_code == 401, r.text
    assert r.json()["error_code"] == "E_UNAUTHORIZED"


def test_auth_me_requires_a_session(anon_client):
    assert anon_client.get("/auth/me").status_code == 401


def test_password_change_requires_a_session(anon_client):
    r = anon_client.post(
        "/auth/password", json={"current_password": "x" * 12, "new_password": "y" * 12}
    )
    assert r.status_code == 401


def test_health_stays_public_and_leaks_nothing_internal(anon_client):
    r = anon_client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert set(body) == {
        "ok", "status", "version", "table_count", "max_rows", "query_timeout_s"
    }, f"/health grew a field: {sorted(body)}"
    blob = r.text.lower()
    for leak in ("duckdb", "/users/", "sqlite", "auth", "instructor", "password", "path"):
        assert leak not in blob, f"/health leaked {leak!r}: {r.text}"


def test_unauthenticated_401_is_identical_for_every_endpoint(anon_client):
    """No endpoint may hint at what lies behind it before you sign in."""
    messages = set()
    for path in PROTECTED_GET:
        messages.add(anon_client.get(path).json()["message"])
    messages.add(anon_client.post("/query", json={"sql": "SELECT 1"}).json()["message"])
    assert len(messages) == 1, f"401 wording differs per endpoint: {messages}"


# ===========================================================================
# 2. Forged / tampered / expired cookies
# ===========================================================================
def test_a_made_up_cookie_is_rejected(anon_client):
    anon_client.cookies["aivb_session"] = "totally-made-up-session-token-value"
    r = anon_client.get("/schema/tables")
    assert r.status_code == 401
    assert r.json()["error_code"] == "E_UNAUTHORIZED"


def test_one_character_change_to_a_real_token_is_rejected(live_server):
    """The classic 'is it really compared properly' probe."""
    good = LiveClient(live_server.base_url)
    assert good.login(STUDENT_USER, STUDENT_PASSWORD).status_code == 200
    token = good.cookies["aivb_session"]
    assert good.get("/schema/tables").status_code == 200, "control: real token works"

    checked = 0
    for index in (0, len(token) // 2, len(token) - 1):
        original = token[index]
        replacement = "A" if original != "A" else "B"
        mutated = token[:index] + replacement + token[index + 1 :]
        assert mutated != token
        forged = LiveClient(live_server.base_url)
        forged.cookies["aivb_session"] = mutated
        r = forged.get("/schema/tables")
        assert r.status_code == 401, f"mutated token at {index} was ACCEPTED: {r.text[:200]}"
        checked += 1
    assert checked == 3


def test_truncated_and_oversized_cookies_are_rejected(live_server):
    good = LiveClient(live_server.base_url)
    good.login(STUDENT_USER, STUDENT_PASSWORD)
    token = good.cookies["aivb_session"]
    for candidate in (token[:-1], token + "A", token * 8, "", "a" * 5000):
        forged = LiveClient(live_server.base_url)
        forged.cookies["aivb_session"] = candidate
        assert forged.get("/schema/tables").status_code == 401


def test_idle_expiry_kills_a_live_session(live_server, auth_store):
    client = LiveClient(live_server.base_url)
    assert client.login(STUDENT_USER, STUDENT_PASSWORD).status_code == 200
    assert client.get("/schema/tables").status_code == 200, "control: session works"

    # Push last_seen_at past the idle window, exactly as the clock would.
    auth_store.expire_session_now(client.cookies["aivb_session"])

    r = client.get("/schema/tables")
    assert r.status_code == 401, f"idle-expired session still worked: {r.text[:200]}"
    assert r.json()["error_code"] == "E_UNAUTHORIZED"


def test_absolute_expiry_kills_a_session_that_stayed_busy(live_server, auth_store):
    """Idle timeout alone is not enough: a session kept warm by traffic must
    still die at the 12-hour absolute cap."""
    client = LiveClient(live_server.base_url)
    client.login(STUDENT_USER, STUDENT_PASSWORD)
    digest = hash_token(client.cookies["aivb_session"])
    assert client.get("/schema/tables").status_code == 200

    with auth_store._write_lock:
        auth_store._con.execute(
            "UPDATE sessions SET absolute_expires_at = ?, last_seen_at = ? "
            "WHERE token_hash = ?",
            (time.time() - 1, time.time(), digest),
        )
        auth_store._con.commit()

    assert client.get("/schema/tables").status_code == 401


def test_logout_revokes_server_side_not_just_the_cookie(live_server):
    client = LiveClient(live_server.base_url)
    client.login(STUDENT_USER, STUDENT_PASSWORD)
    token = client.cookies["aivb_session"]
    assert client.get("/schema/tables").status_code == 200

    assert client.logout().status_code == 200

    # Replay the captured token from a brand new client: a cookie-only logout
    # would happily accept this.
    replay = LiveClient(live_server.base_url)
    replay.cookies["aivb_session"] = token
    r = replay.get("/schema/tables")
    assert r.status_code == 401, f"revoked token was replayable: {r.text[:200]}"


def test_session_cookie_flags_are_hardened(live_server):
    client = LiveClient(live_server.base_url)
    r = client.login(STUDENT_USER, STUDENT_PASSWORD)
    cookies = [h for h in r.headers_all("Set-Cookie") if h.startswith("aivb_session=")]
    assert cookies, f"no session cookie in {r.headers}"
    header = cookies[0].lower()
    assert "httponly" in header, header
    assert "samesite=strict" in header, header
    assert "path=/" in header, header


def test_secure_flag_appears_when_tls_is_configured():
    """The Secure attribute is off by default (plain-http development) and on
    when the operator says TLS is in front. Asserted on the real cookie writer,
    not on the config value."""
    from fastapi.responses import JSONResponse

    from backend.auth import set_session_cookie

    for secure in (False, True):
        response = JSONResponse(content={})
        set_session_cookie(
            response, "tok", cookie_name="aivb_session", max_age=60, secure=secure
        )
        header = next(
            v for k, v in response.raw_headers if k.lower() == b"set-cookie"
        ).decode()
        assert ("secure" in header.lower()) is secure, header
        assert "httponly" in header.lower()
        assert "samesite=strict" in header.lower()


def test_host_prefix_is_applied_only_when_the_cookie_is_secure():
    """`__Host-` is what stops a sibling subdomain from tossing a cookie at
    us. Browsers reject it without Secure, so it can only be switched on
    together with TLS."""
    from backend.config import Settings

    plain = Settings(cookie_secure=False, cookie_name="aivb_session")
    assert plain.session_cookie_name == "aivb_session"

    tls = Settings(cookie_secure=True, cookie_name="aivb_session")
    assert tls.session_cookie_name == "__Host-aivb_session"

    already = Settings(cookie_secure=True, cookie_name="__Host-aivb_session")
    assert already.session_cookie_name == "__Host-aivb_session"


def test_two_logins_get_different_high_entropy_tokens(live_server):
    tokens = set()
    for _ in range(4):
        client = LiveClient(live_server.base_url)
        client.login(STUDENT_USER, STUDENT_PASSWORD)
        token = client.cookies["aivb_session"]
        # secrets.token_urlsafe(32) -> 43 characters of base64url.
        assert len(token) >= 43, f"session token is too short: {len(token)}"
        tokens.add(token)
    assert len(tokens) == 4, "session tokens repeat across logins"


def test_disabling_an_account_kills_its_live_sessions_immediately(live_server, auth_store):
    from backend.authstore import AuthError

    username = "temp_disable_me"
    password = "temp-disable-pw-2026"
    try:
        auth_store.create_user(username, "STUDENT", password=password, must_change_password=False)
    except AuthError:
        auth_store.set_password(username, password, must_change_password=False)
        auth_store.set_disabled(username, False)

    client = LiveClient(live_server.base_url)
    assert client.login(username, password).status_code == 200
    assert client.get("/schema/tables").status_code == 200

    auth_store.set_disabled(username, True)

    assert client.get("/schema/tables").status_code == 401
    # And they cannot sign back in - with the same wording as a wrong password.
    fresh = LiveClient(live_server.base_url)
    r = fresh.login(username, password)
    assert r.status_code == 401
    assert r.json()["error_code"] == "E_BAD_CREDENTIALS"
    auth_store.set_disabled(username, False)
    auth_store.clear_failures("user", username)


# ===========================================================================
# 3. THE ANSWER KEY: student blocked, instructor allowed (positive control)
# ===========================================================================
@pytest.mark.parametrize("table", ANSWER_KEY_TABLES)
def test_student_cannot_read_answer_key_but_instructor_can(client, instructor_client, table):
    """The one test that has to be right.

    Both clients hit the same server and the same DuckDB file (the hostile
    fixture, which really does contain both answer-key tables with rows). The
    ONLY difference is the role on the session cookie.
    """
    sql = f"SELECT * FROM {table} LIMIT 5"

    # Positive control FIRST: prove the query, the table and the rows exist.
    ok = instructor_client.post("/query", json={"sql": sql})
    assert ok.status_code == 200, (
        f"POSITIVE CONTROL FAILED for {table}: an INSTRUCTOR could not read it "
        f"({ok.status_code} {ok.text[:300]}). Without this, the student-side "
        "assertion below proves nothing."
    )
    body = ok.json()
    assert body["row_count"] > 0, f"{table} returned no rows for the instructor"
    assert body["tables_used"] == [table]

    # Now the thing that must not happen.
    denied = client.post("/query", json={"sql": sql})
    assert denied.status_code == 400, f"STUDENT READ {table}: {denied.text[:400]}"
    assert denied.json()["error_code"] == "E_UNKNOWN_TABLE"
    assert table not in denied.text or denied.json()["error_code"] == "E_UNKNOWN_TABLE"


def test_instructor_positive_control_returns_real_answer_key_content(instructor_client):
    """Belt and braces: the instructor result must contain actual answer-key
    payload, not an empty shell that happens to return 200."""
    r = instructor_client.post(
        "/query", json={"sql": "SELECT * FROM meta_scenario_label LIMIT 5"}
    )
    assert r.status_code == 200, r.text
    blob = r.text.lower()
    assert r.json()["row_count"] > 0
    assert "churn_risk" in blob or "scenario" in blob, (
        "instructor read meta_scenario_label but got nothing recognisable back: "
        f"{r.text[:300]}"
    )


@pytest.mark.parametrize("table", ANSWER_KEY_TABLES)
def test_student_answer_key_attempts_over_every_vector(client, table):
    """A logged-in student trying every phrasing that has ever worked
    somewhere: bare name, quoted, schema-qualified, CTE, subquery, join,
    EXISTS, UNION, and a lateral."""
    vectors = [
        f"SELECT * FROM {table}",
        f'SELECT * FROM "{table}"',
        f"SELECT * FROM main.{table}",
        f'SELECT * FROM main."{table}"',
        f"SELECT * FROM MAIN.{table.upper()}",
        f"WITH x AS (SELECT * FROM {table}) SELECT * FROM x",
        f"SELECT * FROM (SELECT * FROM {table}) t",
        f"SELECT (SELECT count(*) FROM {table}) AS n",
        f"SELECT 1 WHERE EXISTS (SELECT 1 FROM {table})",
        f"SELECT party_id FROM core_party UNION ALL SELECT CAST(1 AS VARCHAR) FROM {table}",
        f"SELECT * FROM core_party JOIN {table} ON true",
    ]
    for sql in vectors:
        r = client.post("/query", json={"sql": sql})
        assert r.status_code != 200, f"STUDENT EXECUTED: {sql} -> {r.text[:300]}"
        blob = r.text.lower()
        assert "churn_risk" not in blob
        assert "null_inject" not in blob


def test_student_schema_endpoints_never_mention_the_answer_key(client):
    for path in ("/schema", "/schema/tables"):
        blob = client.get(path).text.lower()
        for table in ANSWER_KEY_TABLES:
            assert table not in blob, f"{path} leaked {table}"


def test_instructor_schema_shows_more_than_the_student_schema(client, instructor_client):
    """Proof the role split is real in both directions, not just an error
    message that always fires."""
    student_tables = {t["name"] for t in client.get("/schema/tables").json()["tables"]}
    instructor_tables = {
        t["name"] for t in instructor_client.get("/schema/tables").json()["tables"]
    }
    assert student_tables < instructor_tables, (
        "the instructor catalog is not a strict superset of the student one; "
        "the role split is not doing anything"
    )
    for table in ANSWER_KEY_TABLES:
        assert table in instructor_tables
        assert table not in student_tables


def test_student_cannot_reach_the_instructor_connection_by_asking_nicely(client):
    """Header / body smuggling attempts at role escalation."""
    attempts = [
        ({"role": "INSTRUCTOR"}, {}),
        ({"as_role": "INSTRUCTOR"}, {}),
        ({}, {"X-Role": "INSTRUCTOR"}),
        ({}, {"X-AIVB-Role": "INSTRUCTOR"}),
        ({}, {"X-Forwarded-User": INSTRUCTOR_USER}),
    ]
    for extra_body, extra_headers in attempts:
        payload = {"sql": "SELECT * FROM meta_dirty_log LIMIT 1"}
        payload.update(extra_body)
        r = client.post("/query", json=payload, headers=extra_headers)
        assert r.status_code == 400, f"escalated with {extra_body} {extra_headers}: {r.text[:300]}"
        assert r.json()["error_code"] == "E_UNKNOWN_TABLE"

    # And /auth/me still says STUDENT.
    assert client.get("/auth/me").json()["role"] == "STUDENT"


def test_audit_endpoint_is_instructor_only(client, instructor_client):
    denied = client.get("/audit/recent")
    assert denied.status_code == 403
    assert denied.json()["error_code"] == "E_FORBIDDEN"

    allowed = instructor_client.get("/audit/recent", params={"limit": 5})
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["ok"] is True


# ===========================================================================
# 4. Password hashing
# ===========================================================================
def test_same_password_yields_different_hashes_for_two_users(pg_store, admin_dsn):
    """Cung mot mat khau phai ra HAI verifier khac nhau.

    SCRAM sinh muoi ngau nhien cho moi lan dat mat khau, y het scrypt truoc day.
    Neu hai verifier trung nhau thi muoi khong ngau nhien, va mot bang tra cuu
    dung duoc cho ca lop.
    """
    import psycopg

    shared = "identical-secret-phrase-2026"
    pg_store.create_user("dup_a", "STUDENT", password=shared, must_change_password=False)
    pg_store.create_user("dup_b", "STUDENT", password=shared, must_change_password=False)

    with psycopg.connect(admin_dsn) as con:
        rows = con.execute(
            "SELECT rolname, rolpassword FROM pg_authid "
            "WHERE rolname IN ('dup_a','dup_b') ORDER BY rolname"
        ).fetchall()

    assert len(rows) == 2
    a, b = rows[0][1], rows[1][1]
    assert a and b, "PostgreSQL khong luu verifier nao"
    assert a.startswith("SCRAM-SHA-256$") and b.startswith("SCRAM-SHA-256$")
    assert a != b, "cung mat khau ra cung verifier - muoi khong ngau nhien"


def test_plaintext_password_is_nowhere_in_the_store(pg_store, admin_dsn):
    """Mat khau ro khong nam o dau ca - ke ca trong bang ho so."""
    import psycopg

    secret = "sup3r-unique-plaintext-marker-2026"
    pg_store.create_user("leaky", "STUDENT", password=secret, must_change_password=False)

    with psycopg.connect(admin_dsn) as con:
        verifier = con.execute(
            "SELECT rolpassword FROM pg_authid WHERE rolname = 'leaky'"
        ).fetchone()[0]
        profile = con.execute(
            "SELECT * FROM app.user_profile WHERE username = 'leaky'"
        ).fetchone()

    assert secret not in (verifier or ""), "mat khau ro nam trong verifier"
    assert secret not in str(profile), "mat khau ro nam trong app.user_profile"


def test_session_tokens_are_stored_hashed_not_raw(live_server, auth_store):
    """Kho bi doc cap khong replay duoc thanh phien song.

    Ban SQLite kiem them "token tho khong nam trong file". Khong con file nua,
    nhung tinh chat that su can giu van nguyen: trong `app.sessions` chi co
    SHA-256, khong o dau co token tho.
    """
    client = LiveClient(live_server.base_url)
    client.login(STUDENT_USER, STUDENT_PASSWORD)
    raw = client.cookies["aivb_session"]

    with auth_store._pool.connection() as con:
        stored = {r[0] for r in con.execute("SELECT token_hash FROM app.sessions").fetchall()}
    assert hash_token(raw) in stored, "khong tim thay phien theo bam"
    assert raw not in stored, "token tho duoc luu nguyen van"

    # Va no khong lot vao bat ky cot nao khac cua bang phien.
    with auth_store._pool.connection() as con:
        everything = con.execute(
            "SELECT token_hash, username, ip, user_agent FROM app.sessions"
        ).fetchall()
    assert all(raw not in str(row) for row in everything), "token tho nam trong bang phien"


def test_scrypt_parameters_are_the_agreed_cost(pg_store, admin_dsn):
    """So vong lap KDF khong duoc tut ve mac dinh cua PostgreSQL.

    Kho SQLite cu dung scrypt N=2^15 (memory-hard). PostgreSQL mac dinh
    `scram_iterations = 4096` - PBKDF2 4096 vong, yeu hon NHIEU BAC truoc tan
    cong offline. `15_class_roles.sql` nang len 100000 de bu, va gia tri do chi
    duoc ap LUC DAT MAT KHAU nen mot lan quen la ca lop dung mat khau yeu ma
    khong co gi bao.

    Day la phep kiem giu cho no khong am tham tut lai.
    """
    import psycopg

    pg_store.create_user("paramcheck", "STUDENT", password="param-check-pw-2026")
    with psycopg.connect(admin_dsn) as con:
        verifier = con.execute(
            "SELECT rolpassword FROM pg_authid WHERE rolname = 'paramcheck'"
        ).fetchone()[0]

    assert verifier.startswith("SCRAM-SHA-256$"), verifier[:20]
    iterations = int(verifier.split("$")[1].split(":")[0])
    assert iterations >= 100000, (
        f"scram_iterations tut ve {iterations}. Chay lai "
        "database/schema/15_class_roles.sql RO I dat lai mat khau."
    )


# ===========================================================================
# 5. Brute-force lockout (measured, not asserted from the source)
# ===========================================================================
def test_lockout_engages_and_expires_with_a_measured_wait(live_server, auth_store):
    """Real clock. The production backoff starts at 30s, which is too long for
    a test, so the SERVER's policy is temporarily shortened to 2s - the code
    path, the counters and the expiry are the production ones. The production
    numbers themselves are checked in
    test_production_backoff_schedule_matches_the_agreed_policy.
    """
    from backend.authstore import AuthError

    store = _server_store()
    username = "lockout_probe"
    password = "lockout-probe-pw-2026"
    try:
        auth_store.create_user(username, "STUDENT", password=password, must_change_password=False)
    except AuthError:
        auth_store.set_password(username, password, must_change_password=False)
    auth_store.clear_failures("user", username)

    original = store.throttle
    store.throttle = ThrottlePolicy(
        user_fail_threshold=5, ip_fail_threshold=10_000, base_delay_s=2.0, max_delay_s=900.0
    )
    try:
        client = LiveClient(live_server.base_url)
        # 4 failures: still allowed to try.
        for attempt in range(4):
            r = client.login(username, "wrong-password-here")
            assert r.status_code == 401, f"attempt {attempt}: {r.status_code}"
            assert r.json()["error_code"] == "E_BAD_CREDENTIALS"

        # 5th failure trips the lock.
        r = client.login(username, "wrong-password-here")
        assert r.status_code == 401

        locked_at = time.perf_counter()
        r = client.login(username, password)  # CORRECT password, still refused
        assert r.status_code == 429, f"lockout did not engage: {r.status_code} {r.text[:200]}"
        assert r.json()["error_code"] == "E_RATE_LIMITED"
        retry_after = float(r.header("Retry-After"))
        assert 0 < retry_after <= 3, f"unexpected Retry-After {retry_after}"

        # Still locked half way through the window.
        time.sleep(1.0)
        assert client.login(username, password).status_code == 429

        # Wait the lock out, then the correct password works again.
        while time.perf_counter() - locked_at < 2.4:
            time.sleep(0.1)
        waited = time.perf_counter() - locked_at
        r = client.login(username, password)
        assert r.status_code == 200, (
            f"still locked after {waited:.1f}s (expected release at 2.0s): {r.text[:200]}"
        )
        assert 2.0 <= waited < 6.0, f"measured wait {waited:.2f}s outside expectation"

        # A successful login clears the counter.
        assert store.fail_count("user", username) == 0
    finally:
        store.throttle = original
        auth_store.clear_failures("user", username)


def test_production_backoff_schedule_matches_the_agreed_policy():
    """5 wrong -> 30s, doubling, capped at 15 minutes."""
    policy = ThrottlePolicy(user_fail_threshold=5, base_delay_s=30.0, max_delay_s=900.0)
    assert [policy.delay_for("user", n) for n in range(1, 6)] == [0, 0, 0, 0, 30.0]
    assert policy.delay_for("user", 6) == 60.0
    assert policy.delay_for("user", 7) == 120.0
    assert policy.delay_for("user", 8) == 240.0
    assert policy.delay_for("user", 9) == 480.0
    assert policy.delay_for("user", 10) == 900.0  # 960 -> capped
    assert policy.delay_for("user", 40) == 900.0  # no overflow, still capped


def test_lockout_counts_ip_as_well_as_username(pg_store):
    """PostgreSQL khong co co che khoa dang nhap - `app.throttle` la tat ca."""
    try:
        for _ in range(20):
            pg_store.record_failure("ip", "10.0.0.9")
        assert pg_store.lock_remaining("ip", "10.0.0.9") > 0, "IP scope never locks"
        assert pg_store.lock_remaining("ip", "10.0.0.10") == 0, "the lock leaked to another IP"
    finally:
        pg_store.clear_failures("ip", "10.0.0.9")


def test_ip_lockout_blocks_a_username_sweep(live_server, auth_store):
    """A single host guessing DIFFERENT usernames must still hit a wall - the
    per-username counter alone would never fire."""
    store = _server_store()
    original = store.throttle
    store.throttle = ThrottlePolicy(
        user_fail_threshold=10_000, ip_fail_threshold=6, base_delay_s=2.0, max_delay_s=900.0
    )
    client = LiveClient(live_server.base_url)
    try:
        statuses = [
            client.login(f"sweep_target_{i}", "whatever-pw-12345").status_code
            for i in range(8)
        ]
        assert 429 in statuses, f"a username sweep from one IP was never throttled: {statuses}"
        assert statuses.index(429) >= 6, f"locked too early: {statuses}"
    finally:
        store.throttle = original
        for i in range(8):
            auth_store.clear_failures("user", f"sweep_target_{i}")
        # Free the shared test IP again for the rest of the suite.
        for row in auth_store._con.execute("SELECT key FROM throttle WHERE scope='ip'"):
            auth_store.clear_failures("ip", row["key"])


# ===========================================================================
# 6. Username enumeration by timing
# ===========================================================================
def test_unknown_user_and_wrong_password_cost_the_same_time(pg_store):
    """Khong duoc phan biet "khong co nguoi nay" voi "sai mat khau".

    Ban SQLite phai tu dung tinh chat nay bang mot lan scrypt gia. Voi
    PostgreSQL thi no co san: tu v10, SCRAM tra loi vai tro khong ton tai bang
    mot verifier GIA voi cung khoi luong tinh toan (mock authentication), dung
    de chan viec do ten nguoi dung.

    Phep do o day chung minh dieu do van dung qua ca duong ket noi that.
    """
    pg_store.create_user(
        "known_user", "STUDENT", password="known-user-pw-2026", must_change_password=False
    )

    def sample(username: str) -> float:
        start = time.perf_counter()
        assert pg_store.verify_password(username, "the-wrong-password-x") is None
        return (time.perf_counter() - start) * 1000

    for _ in range(2):  # lam nong: bat tay TLS va PBKDF2 lan dau dat hon
        sample("known_user")
        sample("no_such_user_here")

    known = sorted(sample("known_user") for _ in range(5))[2]
    unknown = sorted(sample("no_such_user_here") for _ in range(5))[2]

    # Nguong rong co chu dinh: day la ket noi mang that, khong phai mot phep
    # tinh trong bo nho. Cai can bat la chenh lech HANG BAC (5000x cua mot ban
    # cai nguoc), khong phai vai chuc phan tram nhieu do.
    ratio = max(known, unknown) / max(1e-6, min(known, unknown))
    assert ratio < 5, f"lo ten nguoi dung qua thoi gian: {known:.1f}ms vs {unknown:.1f}ms"


def test_login_timing_over_http_does_not_distinguish_the_two(live_server, auth_store):
    """The same measurement end to end, with the lockout lifted so the
    throttle does not short-circuit the very path being timed."""
    store = _server_store()
    original = store.throttle
    store.throttle = ThrottlePolicy(user_fail_threshold=10**6, ip_fail_threshold=10**6)
    client = LiveClient(live_server.base_url)
    try:
        def sample(username: str) -> float:
            start = time.perf_counter()
            r = client.login(username, "definitely-not-the-password")
            assert r.status_code == 401, r.text
            return (time.perf_counter() - start) * 1000

        for _ in range(3):
            sample(STUDENT_USER)
            sample("ghost_account_zzz")

        known = statistics.median(sample(STUDENT_USER) for _ in range(9))
        unknown = statistics.median(sample("ghost_account_zzz") for _ in range(9))
        ratio = max(known, unknown) / max(1e-6, min(known, unknown))
        print(f"\n  http timing: known={known:.2f}ms unknown={unknown:.2f}ms ratio={ratio:.3f}")
        assert ratio < 1.6, (
            f"HTTP login timing distinguishes a real account: known={known:.2f}ms "
            f"unknown={unknown:.2f}ms"
        )
    finally:
        store.throttle = original
        auth_store.clear_failures("user", STUDENT_USER)
        auth_store.clear_failures("user", "ghost_account_zzz")
        for row in auth_store._con.execute("SELECT key FROM throttle WHERE scope='ip'"):
            auth_store.clear_failures("ip", row["key"])


def test_wrong_password_and_unknown_user_are_byte_identical_responses(live_server):
    client = LiveClient(live_server.base_url)
    a = client.login(STUDENT_USER, "wrong-password-for-a-real-user")
    b = client.login("this_user_does_not_exist", "wrong-password-for-a-real-user")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json(), f"username oracle in the response body: {a.text} vs {b.text}"


# ===========================================================================
# 7. CSRF
# ===========================================================================
@pytest.mark.parametrize(
    "path,payload",
    [
        ("/query", {"sql": "SELECT 1"}),
        ("/auth/login", {"username": STUDENT_USER, "password": STUDENT_PASSWORD}),
        ("/auth/logout", {}),
        ("/auth/password", {"current_password": "x" * 12, "new_password": "y" * 12}),
    ],
)
def test_post_without_the_custom_header_is_refused(client, path, payload):
    r = client.post(path, json=payload, csrf=False)
    assert r.status_code == 403, f"{path} accepted a POST with no CSRF header: {r.status_code}"
    assert r.json()["error_code"] == "E_CSRF"


def test_csrf_check_runs_before_authentication(anon_client):
    """A CSRF probe must not double as a 'is this cookie still valid?' oracle."""
    r = anon_client.post("/query", json={"sql": "SELECT 1"}, csrf=False)
    assert r.status_code == 403
    assert r.json()["error_code"] == "E_CSRF"


def test_the_same_post_with_the_header_succeeds(client):
    r = client.post("/query", json={"sql": "SELECT 1 AS n"})
    assert r.status_code == 200, r.text


def test_get_endpoints_do_not_require_the_csrf_header(client):
    """GETs are safe methods; requiring the header there would break nothing
    but is not what the contract promises. Pin the documented behaviour."""
    assert client.get("/schema/tables", csrf=False).status_code == 200


# ===========================================================================
# 8. The credential store is not shipped and not reachable through SQL
# ===========================================================================
def test_audit_log_is_not_inside_any_student_facing_directory():
    """Kho danh tinh khong con la file, nhung `audit.jsonl` thi con.

    Truoc day phep kiem nay bao ve ca `auth.sqlite3`. Danh tinh gio nam trong
    `pg_authid` nen khong con cho nao de dat nham - nhung nhat ky audit van la
    mot file, va no ghi ai chay cau SQL nao.
    """
    from backend.config import settings as live_settings

    release = REPO_ROOT / "_workspace" / "release"
    resolved = Path(live_settings.audit_log_path).resolve()
    assert not str(resolved).startswith(str(release.resolve())), (
        f"{resolved} nam trong thu muc phat cho hoc vien"
    )


def test_no_credential_file_exists_anywhere_under_the_release_tree():
    """Scan what actually gets shipped, not what config says.

    Lay duong dan tu `PROJECT_ROOT` (goc kho) chu khong phai `REPO_ROOT` (gio
    la `app/`). Goi phat hanh nam NGOAI `app/` - do la chu dinh: `app/` la san
    pham chay, `_workspace/release/` la thu giao cho hoc vien.
    """
    from .conftest import PROJECT_ROOT

    release = PROJECT_ROOT / "_workspace" / "release"
    if not release.exists():
        pytest.skip("release tree not built")
    offenders = [
        str(p)
        for p in release.rglob("*")
        if p.is_file()
        and (
            p.name in {"auth.sqlite3", "auth.sqlite3-wal", "auth.sqlite3-shm", "audit.jsonl"}
            or p.suffix in {".sqlite3", ".sqlite"}
        )
    ]
    assert offenders == [], f"credential-shaped files inside the release: {offenders}"




def test_credentials_cannot_be_read_through_the_query_endpoint(client):
    """Moi duong mot hoc vien co the thu de doc thong tin dang nhap.

    Danh tinh gio nam trong `pg_authid`, mot bang he thong ma CHI superuser doc
    duoc cot `rolpassword`. Phep kiem nham thang vao do, cong voi `audit.jsonl`
    la file duy nhat con lai.
    """
    from backend.config import settings as live_settings

    audit = str(Path(live_settings.audit_log_path).resolve())
    vectors = [
        # Bang he thong giu verifier mat khau
        "SELECT rolname, rolpassword FROM pg_authid",
        "SELECT * FROM pg_authid",
        "SELECT * FROM pg_shadow",
        # Bang trang thai ung dung nam o database khac
        "SELECT * FROM app.sessions",
        "SELECT * FROM app.user_profile",
        "SELECT * FROM app.throttle",
        # Doc file
        f"SELECT pg_read_file('{audit}')",
        f"COPY (SELECT 1) TO '{audit}'",
        "SELECT * FROM users",
        "SELECT * FROM sessions",
    ]
    for sql in vectors:
        r = client.post("/query", json={"sql": sql})
        assert r.status_code != 200, f"DOC DUOC THONG TIN DANG NHAP qua: {sql} -> {r.text[:300]}"
        blob = r.text.lower()
        assert "rolpassword" not in blob or "column" in blob or "khong" in blob
        assert "scram-sha-256$" not in blob


def test_auth_tables_are_not_in_any_dataset_catalog(client, instructor_client):
    """Not even the instructor dataset contains a credentials table - the
    store is a different engine, in a different file."""
    for who in (client, instructor_client):
        names = {t["name"] for t in who.get("/schema/tables").json()["tables"]}
        for forbidden in ("users", "sessions", "throttle", "auth", "meta"):
            assert forbidden not in names, f"{forbidden} is exposed in the SQL catalog"


def test_credential_files_are_git_ignored():
    """A password-hash table committed to git is unrecallable.

    This repo has already had one near-miss of exactly this shape (the
    `*.parquet` rule in .gitignore was added after `git add -A` would have
    committed meta_dirty_log.parquet). The credential store is the same class
    of mistake, so it gets the same class of guard.
    """
    import subprocess

    candidates = [
        "_workspace/auth/auth.sqlite3",
        "_workspace/auth/audit.jsonl",
        "api/auth.sqlite3",
        "somewhere/else/auth.sqlite3-wal",
        "audit.jsonl",
    ]
    not_ignored = []
    for candidate in candidates:
        result = subprocess.run(
            ["git", "check-ignore", "-q", candidate],
            cwd=REPO_ROOT,
            capture_output=True,
        )
        if result.returncode != 0:
            not_ignored.append(candidate)
    assert not_ignored == [], f"these credential files are NOT git-ignored: {not_ignored}"




# ===========================================================================
# 9. Forced password change on first login
# ===========================================================================
def test_first_login_must_change_password_before_any_data_access(live_server, auth_store):
    from backend.authstore import AuthError

    username = "firstlogin_probe"
    initial = "initial-issued-pw-2026"
    try:
        auth_store.create_user(username, "STUDENT", password=initial, must_change_password=True)
    except AuthError:
        auth_store.set_password(username, initial, must_change_password=True)

    client = LiveClient(live_server.base_url)
    login = client.login(username, initial)
    assert login.status_code == 200
    assert login.json()["must_change_password"] is True

    # Data endpoints are closed until the password changes.
    for path in ("/schema", "/schema/tables"):
        r = client.get(path)
        assert r.status_code == 403, f"{path} served a first-login account"
        assert r.json()["error_code"] == "E_PASSWORD_CHANGE_REQUIRED"
    r = client.post("/query", json={"sql": "SELECT 1"})
    assert r.status_code == 403
    assert r.json()["error_code"] == "E_PASSWORD_CHANGE_REQUIRED"

    # But /auth/me works, so the UI can render the change screen.
    me = client.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["must_change_password"] is True

    # Weak new passwords are refused.
    for weak in ("short", "password12345", username):
        r = client.post(
            "/auth/password", json={"current_password": initial, "new_password": weak}
        )
        assert r.status_code == 400, f"accepted weak password {weak!r}"
        assert r.json()["error_code"] == "E_WEAK_PASSWORD"

    # Wrong current password is refused.
    r = client.post(
        "/auth/password",
        json={"current_password": "not-the-right-one", "new_password": "brand-new-pw-2026x"},
    )
    assert r.status_code == 401
    auth_store.clear_failures("user", username)

    # The real change unlocks the service.
    new_password = "brand-new-strong-pw-2026"
    r = client.post(
        "/auth/password", json={"current_password": initial, "new_password": new_password}
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True

    assert client.get("/schema/tables").status_code == 200
    assert client.get("/auth/me").json()["must_change_password"] is False

    # The old password no longer works.
    other = LiveClient(live_server.base_url)
    assert other.login(username, initial).status_code == 401
    auth_store.clear_failures("user", username)
    assert other.login(username, new_password).status_code == 200


def test_password_change_revokes_every_other_session(live_server, auth_store):
    from backend.authstore import AuthError

    username = "rotate_probe"
    password = "rotate-probe-pw-2026"
    try:
        auth_store.create_user(username, "STUDENT", password=password, must_change_password=False)
    except AuthError:
        auth_store.set_password(username, password, must_change_password=False)

    first = LiveClient(live_server.base_url)
    second = LiveClient(live_server.base_url)
    assert first.login(username, password).status_code == 200
    assert second.login(username, password).status_code == 200
    assert second.get("/schema/tables").status_code == 200

    new_password = "rotated-strong-pw-2026"
    r = first.post(
        "/auth/password", json={"current_password": password, "new_password": new_password}
    )
    assert r.status_code == 200, r.text
    assert r.json()["sessions_revoked"] >= 2

    # The other browser is logged out; the one that changed it keeps working.
    assert second.get("/schema/tables").status_code == 401
    assert first.get("/schema/tables").status_code == 200


# ===========================================================================
# 10. Audit log
# ===========================================================================
def test_audit_log_records_queries_with_who_what_and_how_many(client):
    marker = "audit_marker_9182736"
    client.post("/query", json={"sql": f"SELECT 1 AS {marker}"})

    hits = [
        r
        for r in _audit_records()
        if r.get("event") == "query" and marker in str(r.get("sql", ""))
    ]
    assert hits, "the query was not audited"
    record = hits[-1]
    for field in ("ts", "username", "role", "session_id", "ip", "sql", "row_count", "elapsed_ms"):
        assert field in record, f"audit record is missing {field}: {record}"
    assert record["username"] == STUDENT_USER
    assert record["role"] == "STUDENT"
    assert record["blocked"] is False
    assert record["row_count"] == 1


def test_audit_log_records_blocked_queries_with_the_reason(client):
    marker = "blocked_marker_5566778"
    client.post("/query", json={"sql": f"SELECT * FROM meta_dirty_log /* {marker} */"})

    hits = [r for r in _audit_records() if marker in str(r.get("sql", ""))]
    assert hits, "a blocked query was not audited"
    record = hits[-1]
    assert record["blocked"] is True
    assert record["error_code"] == "E_UNKNOWN_TABLE"
    assert record["reason"]


def test_audit_log_never_contains_a_password_or_a_session_token(live_server, auth_store):
    from backend.authstore import AuthError

    username = "audit_secret_probe"
    password = "audit-secret-pw-2026-unique"
    try:
        auth_store.create_user(username, "STUDENT", password=password, must_change_password=False)
    except AuthError:
        auth_store.set_password(username, password, must_change_password=False)

    client = LiveClient(live_server.base_url)
    client.login(username, password)
    client.login(username, "a-wrong-password-marker-2026")
    token = client.cookies.get("aivb_session", "")
    client.post("/query", json={"sql": "SELECT 2"})

    blob = Path(AUDIT_LOG).read_text()
    assert password not in blob, "a plaintext password reached the audit log"
    assert "a-wrong-password-marker-2026" not in blob, "a failed password reached the audit log"
    assert token and token not in blob, "a session token reached the audit log"
    auth_store.clear_failures("user", username)


def test_audit_scrubber_drops_credential_shaped_fields(tmp_path):
    from backend.audit import AuditLog

    log = AuditLog(tmp_path / "audit.jsonl")
    log.write(
        "probe",
        username="u1",
        password="SHOULD-NOT-APPEAR",
        session_token="ALSO-NOT",
        cookie="NOR-THIS",
        sql="SELECT 1",
    )
    text = (tmp_path / "audit.jsonl").read_text()
    assert "SHOULD-NOT-APPEAR" not in text
    assert "ALSO-NOT" not in text
    assert "NOR-THIS" not in text
    assert "SELECT 1" in text


def test_audit_log_is_append_only_in_practice(tmp_path):
    from backend.audit import AuditLog

    path = tmp_path / "audit.jsonl"
    log = AuditLog(path)
    for i in range(50):
        log.write("probe", n=i)
    first = path.read_text().splitlines()
    log.write("probe", n=999)
    second = path.read_text().splitlines()
    assert second[: len(first)] == first, "existing audit lines were rewritten"
    assert len(second) == len(first) + 1


# ===========================================================================
# 11. Admin CLI
# ===========================================================================
def test_cli_creates_an_account_and_prints_the_password_once(pg_store, capsys):
    from backend.admin_cli import main

    rc = main(["create-user", "--username", "cli_sv01", "--role", "STUDENT"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "cli_sv01" in out
    line = [ln for ln in out.splitlines() if "cli_sv01" in ln and "STUDENT" in ln][0]
    password = line.split()[-1]
    assert len(password) >= 12

    user = pg_store.verify_password("cli_sv01", password)
    assert user is not None and user.role == "STUDENT"


def test_cli_imports_a_class_list_and_skips_duplicates(pg_store, admin_dsn, tmp_path, capsys):
    import psycopg

    from backend.admin_cli import main

    csv_path = tmp_path / "class.csv"
    csv_path.write_text(chr(10).join(["username,full_name", "cli_a,Nguyen A", "cli_b,Tran B", "cli_c,Le C", ""]), encoding="utf-8")
    assert main(["import-csv", "--file", str(csv_path)]) == 0
    out = capsys.readouterr().out
    assert "3 account(s)" in out

    names = {u.username for u in pg_store.list_users()}
    assert {"cli_a", "cli_b", "cli_c"} <= names

    # Moi nguoi mot verifier KHAC NHAU - tuc la moi nguoi mot mat khau.
    with psycopg.connect(admin_dsn) as con:
        verifiers = [
            r[0]
            for r in con.execute(
                "SELECT rolpassword FROM pg_authid WHERE rolname IN ('cli_a','cli_b','cli_c')"
            ).fetchall()
        ]
    assert len(verifiers) == 3
    assert len(set(verifiers)) == 3, "hai hoc vien dung chung mot mat khau"

    # Chay lai KHONG duoc ghi de nguoi da co.
    assert main(["import-csv", "--file", str(csv_path)]) == 0
    out = capsys.readouterr().out
    assert "skipped" in out.lower() or "0 account(s)" in out


def test_cli_reset_disable_and_enable(pg_store, capsys):
    from backend.admin_cli import main

    main(["create-user", "--username", "cli_rst", "--role", "STUDENT",
          "--password", "first-issued-secret-2026", "--no-force-change"])
    capsys.readouterr()
    assert pg_store.verify_password("cli_rst", "first-issued-secret-2026") is not None

    assert main(["reset-password", "--username", "cli_rst"]) == 0
    out = capsys.readouterr().out
    new_password = [
        ln for ln in out.splitlines() if "cli_rst" in ln and "STUDENT" in ln
    ][0].split()[-1]
    assert pg_store.verify_password("cli_rst", "first-issued-secret-2026") is None, (
        "mat khau cu con song sau khi reset"
    )
    assert pg_store.verify_password("cli_rst", new_password) is not None

    # `disable` dong CA HAI lane: web va Power BI, vi ca hai xac thuc voi chinh
    # vai tro PostgreSQL nay. Kho SQLite cu chi dong duoc lane web.
    assert main(["disable", "--username", "cli_rst"]) == 0
    assert pg_store.verify_password("cli_rst", new_password) is None, (
        "tai khoan bi khoa van dang nhap duoc"
    )

    assert main(["enable", "--username", "cli_rst"]) == 0
    assert pg_store.verify_password("cli_rst", new_password) is not None


def test_server_auth_store_cannot_create_roles():
    """Tien trinh phuc vu Internet KHONG duoc cam quyen quan tri vai tro.

    Thay cho phep kiem cu "khong dat auth.sqlite3 vao thu muc phat cho hoc
    vien": kho danh tinh khong con la file nen khong con cho nao de dat nham.
    Tinh chat can giu bay gio la khac - `main.py` dung AuthStore KHONG co
    `admin_conninfo`, nen moi thao tac can CREATEROLE deu nem loi thay vi am
    tham chay.

    Thung web app thi cung khong tao/xoa/doi mat khau vai tro nao duoc.
    """
    from backend.authstore import AuthError, AuthStore

    store = AuthStore.__new__(AuthStore)  # khong mo ket noi nao
    store._admin_conninfo = None
    for call in (
        lambda: store._admin(),
    ):
        with pytest.raises(AuthError, match="CREATEROLE"):
            call()


def test_cli_rejects_an_unknown_role():
    """argparse phai chan vai tro la TRUOC khi cham toi PostgreSQL."""
    from backend.admin_cli import main

    with pytest.raises(SystemExit):
        main(["create-user", "--username", "x", "--role", "ADMIN"])


# ===========================================================================
# 12. Sanity: the auth layer did not weaken the SQL guard
# ===========================================================================
def test_ddl_is_still_refused_for_both_roles(client, instructor_client):
    """An instructor gets a bigger catalog, not a writable one."""
    for who, label in ((client, "student"), (instructor_client, "instructor")):
        for sql in (
            "DROP TABLE core_party",
            "CREATE TABLE x (a INT)",
            "INSERT INTO core_party VALUES (1)",
            "UPDATE core_party SET party_id = 1",
            "DELETE FROM core_party",
            "ATTACH 'x.duckdb' AS y",
        ):
            r = who.post("/query", json={"sql": sql})
            assert r.status_code == 400, f"{label} ran {sql!r}: {r.text[:200]}"
            assert r.json()["error_code"] in {
                "E_NOT_SELECT", "E_UNSUPPORTED_SYNTAX", "E_PARSE", "E_MULTI_STATEMENT",
            }


def test_instructor_dataset_is_still_read_only():
    from backend import main as api_main

    db = api_main._state.get("instructor_db")
    assert db is not None, "the test app did not open an instructor dataset"
    import psycopg

    with db._pool.connection() as con:  # noqa: SLF001
        with pytest.raises(psycopg.Error) as exc:
            con.execute("CREATE TABLE should_fail (a INT)")
        # Vai tro giang vien co quyen doc RONG HON, nhung khong he co quyen GHI.
        assert exc.value.sqlstate in ("25006", "42501")


def test_every_route_is_either_authenticated_or_on_the_public_allowlist():
    """Inventory guard.

    The realistic failure mode for this layer is not a broken check - it is a
    new endpoint added six months from now that nobody remembers to protect.
    This walks the actual route table and fails on anything that is neither
    documented as public nor wired to a session dependency.
    """
    from backend import main as api_main

    public = {
        "/health",          # liveness; reports only what a student already knows
        "/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect",  # API shape only
        "/auth/login",      # obviously
        "/auth/logout",     # idempotent, CSRF-protected, reveals nothing
        # Thu vien ben thu ba (DuckDB-WASM, CodeMirror). Cong khai KHONG phai la
        # noi long: truoc day chung do `app.mount("/", StaticFiles(...))` phuc vu,
        # cung khong co phien. Chung tro thanh mot route rieng chi de gui ban da
        # nen san `.gz` (32,7 MB -> 7,3 MB); be mat khong doi.
        #
        # Route do tu chan di nguoc thu muc, va co test rieng cho viec do:
        # test_ops_hardening.py::test_vendor_route_refuses_to_walk_out_of_its_directory
        "/vendor/{asset_path:path}",
        # Tab Tro choi. `status` chi noi game co bat khong. Proxy `/game/api/*`
        # khong dung phien AIV Bank: game tu xac thuc bang phien GAME cua no
        # (cookie Path=/game), va proxy chi chuyen dung ba cookie cua game -
        # xem test_game_bridge.py::test_proxy_strips_host_session_and_passes_game_cookies.
        # Ve SSO (`/game-sso/token`) thi KHONG nam day: no doi phien AIV Bank.
        "/game-sso/status",
        "/game/api/{path:path}",
    }
    session_dependencies = {
        "require_session", "require_active_session", "require_instructor"
    }

    unprotected = []
    for route in api_main.app.routes:
        path = getattr(route, "path", None)
        if path is None or path in public:
            continue
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        names = {
            getattr(sub.call, "__name__", "") for sub in dependant.dependencies
        }
        if not (names & session_dependencies):
            unprotected.append(path)

    assert unprotected == [], (
        f"these routes have no session dependency and are not on the public "
        f"allowlist: {unprotected}"
    )


def test_every_post_route_enforces_csrf():
    from backend import main as api_main

    missing = []
    for route in api_main.app.routes:
        methods = getattr(route, "methods", set()) or set()
        if "POST" not in methods:
            continue
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        names = {getattr(sub.call, "__name__", "") for sub in dependant.dependencies}
        if "csrf_guard" not in names:
            missing.append(route.path)
    assert missing == [], f"POST routes without a CSRF guard: {missing}"


def test_settings_default_audit_path_is_outside_the_release():
    fresh = Settings()
    assert "release" not in str(fresh.audit_log_path).lower()
