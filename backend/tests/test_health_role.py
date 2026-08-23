"""GET /health must report the caller's OWN catalog size.

The defect
----------
`table_count` was hardcoded to the student catalog for every caller, including
an authenticated instructor. An instructor therefore saw "84 tables" on /health
while their own sidebar - built from GET /schema/tables on the instructor
connection - listed 96. Not a leak (the number was too small, never too large),
but wrong information on the one screen an instructor is supposed to trust when
checking that the service is wired to the right dataset.

The fix must not create a leak in the other direction, so this module pins both
halves:

  * anonymous callers, and any session that is not a fully active instructor,
    see EXACTLY what they saw before - the student number. Reporting the
    instructor number to an unauthenticated caller would disclose that a
    second, larger database exists;
  * an authenticated INSTRUCTOR sees the instructor number.

The fixture points both roles at the same hostile file, where the student
catalog is the 77-table projection and the instructor catalog is all 100, so the two numbers
are genuinely different and the test cannot pass vacuously.
"""

from __future__ import annotations

import pytest

from .conftest import (
    CONTRACT_TABLES,
    INSTRUCTOR_PASSWORD,
    INSTRUCTOR_USER,
    STUDENT_TABLE_COUNT,
)


def _health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text[:200]
    return r.json()


def test_health_is_still_public(anon_client):
    body = _health(anon_client)
    assert body["ok"] is True
    assert body["status"] == "healthy"


def test_anonymous_sees_the_student_catalog_size(anon_client):
    assert _health(anon_client)["table_count"] == STUDENT_TABLE_COUNT


def test_student_sees_the_student_catalog_size(client):
    assert _health(client)["table_count"] == STUDENT_TABLE_COUNT


def test_instructor_sees_the_instructor_catalog_size(instructor_client):
    body = _health(instructor_client)
    assert body["table_count"] == CONTRACT_TABLES
    assert body["table_count"] > STUDENT_TABLE_COUNT


def test_the_two_numbers_are_actually_different():
    """Otherwise every assertion above is vacuous."""
    from backend.main import _state

    assert (
        len(_state["instructor_db"].catalog.allowed_tables)
        > len(_state["db"].catalog.allowed_tables)
    )


def test_health_matches_what_schema_tables_reports_for_the_same_session(
    client, instructor_client
):
    """The whole point of the fix: /health and the sidebar must agree."""
    for session in (client, instructor_client):
        health = _health(session)["table_count"]
        listed = session.get("/schema/tables").json()["table_count"]
        assert health == listed, f"{health} on /health vs {listed} on /schema/tables"


def test_a_garbage_cookie_falls_back_to_the_student_number(anon_client):
    """A forged or stale cookie must not be an upgrade path, and must not 500."""
    for value in ("", "not-a-token", "x" * 512, "../../etc/passwd"):
        anon_client.cookies["aivb_session"] = value
        assert _health(anon_client)["table_count"] == STUDENT_TABLE_COUNT
    anon_client.cookies.pop("aivb_session", None)


def test_a_revoked_instructor_session_drops_back_to_the_student_number(live_server):
    """Logging out must take the elevated number away with it."""
    from .live_client import LiveClient

    session = LiveClient(live_server.base_url)
    assert session.login(INSTRUCTOR_USER, INSTRUCTOR_PASSWORD).status_code == 200
    assert _health(session)["table_count"] == CONTRACT_TABLES

    token = session.cookies["aivb_session"]
    session.logout()

    replay = LiveClient(live_server.base_url)
    replay.cookies["aivb_session"] = token
    assert _health(replay)["table_count"] == STUDENT_TABLE_COUNT


def test_a_password_change_pending_instructor_gets_the_student_number(
    live_server, auth_store
):
    """A first-login account cannot reach any data endpoint, so /health must not
    hand it the instructor number either."""
    from .live_client import LiveClient

    username = "health_pending_instructor"
    password = "health-pending-instructor-pw-2026"
    try:
        auth_store.create_user(
            username, "INSTRUCTOR", password=password, must_change_password=True
        )
    except Exception:  # already created by a previous run in this session
        auth_store.set_password(username, password, must_change_password=True)

    session = LiveClient(live_server.base_url)
    assert session.login(username, password).status_code == 200
    assert session.get("/auth/me").json()["must_change_password"] is True
    assert _health(session)["table_count"] == STUDENT_TABLE_COUNT


def test_health_does_not_refresh_the_idle_timer(live_server, auth_store):
    """A UI that polls /health must not keep a dead session alive forever.

    /health reads the cookie now, so it has to read it with touch=False.
    """
    from .live_client import LiveClient

    username = "health_idle_probe"
    password = "health-idle-probe-pw-2026"
    try:
        auth_store.create_user(
            username, "STUDENT", password=password, must_change_password=False
        )
    except Exception:
        auth_store.set_password(username, password, must_change_password=False)

    session = LiveClient(live_server.base_url)
    assert session.login(username, password).status_code == 200
    raw = session.cookies["aivb_session"]

    before = auth_store.validate_session(raw, touch=False)
    assert before is not None
    _health(session)
    after = auth_store.validate_session(raw, touch=False)
    assert after is not None
    assert after.idle_expires_at == pytest.approx(before.idle_expires_at, abs=1e-6), (
        "GET /health refreshed the idle timeout; a polling tab would never expire"
    )
