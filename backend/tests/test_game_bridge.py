"""Tab Tro choi: ve SSO, proxy `/game/api/*`, va header cua `/game/*`.

Khong can PostgreSQL: game-api duoc thay bang `httpx.MockTransport`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from backend import game_bridge
from backend.config import CONTENT_SECURITY_POLICY, GAME_CONTENT_SECURITY_POLICY

SECRET = "x" * 40


def _decode(ticket: str) -> dict:
    body, sig = ticket.split(".")
    expected = hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()
    assert base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)) == expected
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


# ------------------------------------------------------------------- ve SSO
def test_ticket_carries_identity_and_short_lifetime():
    claims = _decode(
        game_bridge.sign_ticket(
            username="sv001", full_name="Nguyễn Văn A", role="STUDENT", secret=SECRET, now=1000
        )
    )
    assert claims["iss"] == "aivb"
    assert claims["sub"] == "sv001"
    assert claims["name"] == "Nguyễn Văn A"
    assert claims["role"] == "student"
    assert claims["exp"] - claims["iat"] == game_bridge.TICKET_TTL_S == 60
    assert len(claims["jti"]) >= 16


def test_ticket_maps_instructor_and_falls_back_to_username():
    claims = _decode(game_bridge.sign_ticket(username="gv01", full_name="", role="INSTRUCTOR", secret=SECRET))
    assert claims["role"] == "instructor"
    assert claims["name"] == "gv01"


def test_every_ticket_has_its_own_jti():
    a = _decode(game_bridge.sign_ticket(username="u", full_name="", role="STUDENT", secret=SECRET))
    b = _decode(game_bridge.sign_ticket(username="u", full_name="", role="STUDENT", secret=SECRET))
    assert a["jti"] != b["jti"]


# ---------------------------------------------------------------- cookie
def test_only_game_cookies_reach_game_api():
    raw = "__Host-aivb_session=SECRET-TOKEN; session=g1; theme={\"a\":1}; csrf=c1; refresh=r1"
    assert game_bridge.game_cookie_header(raw) == "session=g1; refresh=r1; csrf=c1"


def test_no_game_cookie_means_no_cookie_header():
    assert game_bridge.game_cookie_header("aivb_session=abc") is None
    assert game_bridge.game_cookie_header(None) is None


# ------------------------------------------------------------------ proxy
@pytest.fixture
def proxied():
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"ok": True},
            headers=[
                ("set-cookie", "session=new; Path=/game; HttpOnly"),
                ("set-cookie", "csrf=c2; Path=/game"),
                ("x-internal", "leak"),
            ],
        )

    proxy = game_bridge.GameProxy("http://game-api:3001")
    proxy._client = httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://game-api:3001"
    )
    app = FastAPI()

    @app.api_route("/game/api/{path:path}", methods=["GET", "POST"])
    async def route(path: str, request: Request):
        return await proxy.forward(request, path)

    return TestClient(app), seen


def test_proxy_strips_host_session_and_passes_game_cookies(proxied):
    client, seen = proxied
    client.cookies.set("aivb_session", "HOST-TOKEN")
    client.cookies.set("session", "g1")
    r = client.post(
        "/game/api/v1/auth/aivb-sso?x=1",
        json={"ticket": "t"},
        headers={"origin": "http://testserver", "x-csrf-token": "c1", "x-aivb-client": "web"},
    )
    assert r.status_code == 200
    sent = seen[-1]
    assert sent.url.path == "/api/v1/auth/aivb-sso"
    assert sent.url.params["x"] == "1"
    assert "HOST-TOKEN" not in sent.headers.get("cookie", "")
    assert sent.headers["cookie"] == "session=g1"
    assert sent.headers["origin"] == "http://testserver"
    assert sent.headers["x-csrf-token"] == "c1"
    assert "x-aivb-client" not in sent.headers
    assert json.loads(sent.content) == {"ticket": "t"}


def test_proxy_forwards_telemetry_account_header(proxied):
    """Thieu header nay game tra 409 cho moi su kien choi -> spine rong."""
    client, seen = proxied
    r = client.post(
        "/game/api/v1/analytics/events",
        json={"eventName": "game_observation"},
        headers={"x-telemetry-account-id": "acc-1", "user-agent": "UA-Test"},
    )
    assert r.status_code == 200
    assert seen[-1].headers["x-telemetry-account-id"] == "acc-1"
    assert seen[-1].headers["user-agent"] == "UA-Test"


def test_proxy_returns_every_set_cookie_but_not_internal_headers(proxied):
    client, _ = proxied
    r = client.get("/game/api/health")
    assert r.headers.get_list("set-cookie") == [
        "session=new; Path=/game; HttpOnly",
        "csrf=c2; Path=/game",
    ]
    assert "x-internal" not in r.headers


def test_proxy_refuses_dot_segments(proxied):
    client, seen = proxied
    before = len(seen)
    # Chuoi da ma hoa de client khong tu chuan hoa `..` truoc khi gui.
    r = client.get("/game/api/v1/%2E%2E/%2E%2E/admin")
    assert r.status_code == 404
    assert len(seen) == before


def test_proxy_rejects_oversized_body(proxied):
    client, seen = proxied
    before = len(seen)
    r = client.post("/game/api/v1/x", content=b"a" * (game_bridge.MAX_BODY_BYTES + 1))
    assert r.status_code == 413
    assert len(seen) == before


def test_proxy_reports_game_api_down():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    proxy = game_bridge.GameProxy("http://game-api:3001")
    proxy._client = httpx.AsyncClient(transport=httpx.MockTransport(down), base_url="http://game-api:3001")
    app = FastAPI()

    @app.get("/game/api/{path:path}")
    async def route(path: str, request: Request):
        return await proxy.forward(request, path)

    r = TestClient(app).get("/game/api/health")
    assert r.status_code == 502
    assert "error" in r.json()


# ---------------------------------------------------------------------- CSP
def _directives(policy: str) -> dict[str, set[str]]:
    out = {}
    for part in policy.split(";"):
        bits = part.split()
        if bits:
            out[bits[0]] = set(bits[1:])
    return out


def test_game_csp_allows_same_origin_framing_only():
    d = _directives(GAME_CONTENT_SECURITY_POLICY)
    assert d["frame-ancestors"] == {"'self'"}
    assert d["script-src"] == {"'self'"}, "no wasm/eval for the game"
    assert d["connect-src"] == {"'self'"}
    assert d["object-src"] == {"'none'"}


def test_host_csp_still_forbids_framing():
    assert _directives(CONTENT_SECURITY_POLICY)["frame-ancestors"] == {"'none'"}


# ------------------------------------------------------ main.py khi game TAT
def test_routes_when_game_disabled():
    """Mac dinh (khong AIVB_GAME_API_URL): tab an, proxy 404, trang chu van DENY."""
    from backend import main

    if main.settings.game_enabled:
        pytest.skip("AIVB_GAME_API_URL dang dat trong moi truong test")
    client = TestClient(main.app)
    assert client.get("/game-sso/status").json() == {"enabled": False}
    r = client.get("/game/api/v1/auth/session")
    assert r.status_code == 404
    home = client.get("/")
    assert home.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in home.headers["content-security-policy"]


def test_game_paths_get_game_headers():
    from backend import main

    r = TestClient(main.app).get("/game/api/anything")
    assert r.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in r.headers["content-security-policy"]


def test_sso_token_requires_csrf_header_before_anything_else():
    from backend import main

    r = TestClient(main.app).post("/game-sso/token")
    assert r.status_code == 403


def test_game_writes_need_the_host_csrf_header():
    """POST vao game qua proxy cung phai mang X-AIVB-Client nhu moi POST khac."""
    from backend import main

    client = TestClient(main.app)
    assert client.post("/game/api/v1/auth/aivb-sso", json={}).status_code == 403
    # Co header thi qua lop CSRF; game tat trong test nen dung o 404.
    r = client.post("/game/api/v1/auth/aivb-sso", json={}, headers={"X-AIVB-Client": "web"})
    assert r.status_code == 404
