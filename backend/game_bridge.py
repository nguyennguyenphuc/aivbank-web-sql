"""Cau noi giua AIV Bank va game "Vuong Quoc Keo Ngot" (thu muc `game/`).

Hai viec, va chi hai viec:

1. `sign_ticket` - cap VE SSO cho nguoi dang dang nhap AIV Bank. Game doi ve
   lay phien cua no (`POST /api/v1/auth/aivb-sso`, xem
   `game/server/src/modules/auth/aivb-sso.ts`) va tao/cap nhat tai khoan game
   tuong ung. Ve:
     * `base64url(JSON).base64url(HMAC-SHA256)` - dung khuon ma game kiem;
     * song 60 giay, mang `jti` ngau nhien, game tu choi `jti` da dung;
     * KHONG mang mat khau hay token phien AIV Bank nao.

2. `GameProxy` - chuyen `/game/api/*` sang `game-api` (Node) trong mang noi bo,
   de trinh duyet chi thay MOT origin: iframe, cookie va CSRF cua game chay y
   nhu nhau o http://127.0.0.1:8000 lan qua Caddy.

   Proxy LOC header theo danh sach cho phep, va quan trong nhat la LOC COOKIE:
   cookie phien AIV Bank co `Path=/` nen trinh duyet gui no kem ca request toi
   `/game/api/...`. Chuyen nguyen header `Cookie` sang Node la trao token dang
   nhap AIV Bank cho mot dich vu khac. Chi ba cookie cua game di qua.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response

log = logging.getLogger("aivb.game")

TICKET_TTL_S = 60

#: Cookie cua game (`auth.controller.ts::setCookies`). Chi nhung cookie nay
#: duoc chuyen sang `game-api`.
GAME_COOKIES = ("session", "refresh", "csrf")

#: Path ma game dat cho tung cookie (game chay voi PUBLIC_BASE_PATH=/game).
#: `/auth/logout` cua AIV Bank xoa dung ba cookie nay.
GAME_COOKIE_PATHS = {
    "session": "/game",
    "refresh": "/game/api/v1/auth/refresh",
    "csrf": "/game",
}

#: Header request duoc chuyen tiep. `origin` bat buoc: game kiem Origin cho moi
#: POST (`origin-csrf.guard.ts`). `x-telemetry-account-id` bat buoc cho
#: `POST /v1/analytics/events`: thieu no game tra 409 va client bo han su kien.
FORWARD_REQUEST_HEADERS = (
    "accept",
    "accept-language",
    "content-type",
    "origin",
    "user-agent",
    "x-csrf-token",
    "x-request-id",
    "x-telemetry-account-id",
)

#: Header response duoc tra ve. CSP/X-Frame-Options KHONG nam day: middleware
#: cua `main.py` dat chung cho moi response duoi `/game/`.
FORWARD_RESPONSE_HEADERS = ("content-type", "x-request-id", "retry-after")

#: API cua game chi trao doi JSON nho; chan than request qua lon truoc khi doc.
MAX_BODY_BYTES = 1 << 20


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_ticket(
    *, username: str, full_name: str, role: str, secret: str, now: float | None = None
) -> str:
    """Ve SSO cho `username`. `role` la ROLE_STUDENT/ROLE_INSTRUCTOR cua AIV Bank."""
    issued = int(time.time() if now is None else now)
    claims = {
        "iss": "aivb",
        "sub": username,
        "name": full_name or username,
        "role": "instructor" if role.upper() == "INSTRUCTOR" else "student",
        "iat": issued,
        "exp": issued + TICKET_TTL_S,
        "jti": secrets.token_urlsafe(24),
    }
    body = _b64(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    mac = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def game_cookie_header(raw: str | None) -> str | None:
    """Rut tu header `Cookie` chi nhung cookie cua game.

    Tach tay thay vi `http.cookies.SimpleCookie`: SimpleCookie gap mot cookie
    la (cua ung dung khac cung domain) la bo ngang, lang le lam rot ca cookie
    phien game dung sau no.
    """
    if not raw:
        return None
    found: dict[str, str] = {}
    for part in raw.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name in GAME_COOKIES and name not in found:
            found[name] = value
    kept = [f"{name}={found[name]}" for name in GAME_COOKIES if name in found]
    return "; ".join(kept) or None


class GameProxy:
    """Mot `httpx.AsyncClient` dung chung, mo trong `lifespan()`."""

    def __init__(self, base_url: str, *, timeout_s: float = 15.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout_s, connect=3.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
            follow_redirects=False,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def forward(self, request: Request, path: str) -> Response:
        # Khong cho `..` di ra ngoai `/api/` cua game-api.
        if any(segment in ("..", ".") for segment in path.split("/")):
            return _error(404, "Not found")
        declared = request.headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
            return _error(413, "Request body too large")
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            return _error(413, "Request body too large")

        headers = {
            name: request.headers[name]
            for name in FORWARD_REQUEST_HEADERS
            if name in request.headers
        }
        cookie = game_cookie_header(request.headers.get("cookie"))
        if cookie:
            headers["cookie"] = cookie
        if request.client:
            headers["x-forwarded-for"] = request.client.host
        headers["x-forwarded-proto"] = request.url.scheme

        try:
            upstream = await self._client.request(
                request.method,
                f"/api/{path}",
                params=list(request.query_params.multi_items()),
                content=body or None,
                headers=headers,
            )
        except httpx.TimeoutException:
            log.warning("game-api timeout: %s /api/%s", request.method, path)
            return _error(504, "Máy chủ trò chơi phản hồi quá chậm")
        except httpx.HTTPError as exc:
            log.error("game-api unreachable: %s", exc)
            return _error(502, "Máy chủ trò chơi đang không chạy")

        response = Response(content=upstream.content, status_code=upstream.status_code)
        for name in FORWARD_RESPONSE_HEADERS:
            value = upstream.headers.get(name)
            if value is not None:
                response.headers[name] = value
        for cookie_line in upstream.headers.get_list("set-cookie"):
            response.headers.append("set-cookie", cookie_line)
        return response


def _error(status: int, message: str) -> JSONResponse:
    # Cung hinh dang voi error envelope cua game (`apiFetch` doc `error.message`).
    return JSONResponse({"error": {"message": message}}, status_code=status)
