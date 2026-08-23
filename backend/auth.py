"""HTTP glue for authentication: sessions, CSRF, and role -> dataset routing.

Threat model this layer is written against
------------------------------------------
The asset is the grading answer key (`meta_scenario_label`, `meta_dirty_log`).
The attacker is a motivated student who can send arbitrary HTTP and arbitrary
SQL, and who may also be able to get a classmate to click a link.

  * No cookie / bad cookie / expired cookie -> 401 on every data endpoint.
    There is no "anonymous read-only" mode, because that is the mode that
    quietly becomes the default when someone tests with curl.
  * The session cookie is HttpOnly (XSS in the UI cannot read it), SameSite
    Strict (no cross-site request carries it at all) and Secure when
    configured for TLS.
  * Every POST additionally requires a custom header. A cross-origin <form>
    cannot set one, and a cross-origin fetch that does triggers a preflight
    our CORS policy refuses. That is the CSRF control.
  * The role on the session decides which DuckDB *file* the request is routed
    to. It does not filter a shared connection. A STUDENT session has no code
    path that reaches the instructor connection object.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from .authstore import ROLE_INSTRUCTOR, ROLE_STUDENT, AuthStore, Session

log = logging.getLogger("aivb.auth")


class ApiError(Exception):
    """An error to render in the standard {ok,error_code,message} envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
        internal: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}
        self.internal = internal or message


def api_error_response(exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"ok": False, "error_code": exc.code, "message": exc.message},
        headers=exc.headers,
    )


@dataclass(frozen=True)
class Principal:
    username: str
    role: str
    session_id: str
    must_change_password: bool
    expires_at: float
    idle_expires_at: float

    @property
    def is_instructor(self) -> bool:
        return self.role == ROLE_INSTRUCTOR

    def to_public(self) -> dict[str, Any]:
        return {
            "username": self.username,
            "role": self.role,
            "must_change_password": self.must_change_password,
        }


# Wording is deliberately identical for "no cookie", "unknown cookie",
# "tampered cookie", "revoked session" and "expired session". Distinguishing
# them would tell an attacker whether a token value ever existed.
_UNAUTHENTICATED = "Authentication required. Sign in and try again."


def client_ip(request: Request) -> str:
    """The peer address.

    X-Forwarded-For is deliberately ignored: it is attacker-controlled unless
    a trusted proxy is known to overwrite it, and here it feeds the lockout
    counters. Trusting it would let anyone reset their own throttle by
    inventing a new IP per attempt. If a real proxy is put in front, configure
    uvicorn's --proxy-headers with --forwarded-allow-ips instead, which makes
    request.client.host correct at the transport layer.
    """
    return request.client.host if request.client else "?"


def session_from_request(
    request: Request, store: AuthStore, cookie_name: str, touch: bool = True
) -> Session | None:
    """Resolve the session cookie, refreshing the idle timer by default.

    `touch=False` is for endpoints that a UI may poll on a timer (/health).
    Letting a poll count as activity would silently disable the idle timeout:
    an unattended browser tab would keep its session alive forever.
    """
    raw = request.cookies.get(cookie_name)
    if not raw:
        return None
    return store.validate_session(raw, touch=touch)


def principal_from_session(session: Session) -> Principal:
    return Principal(
        username=session.username,
        role=session.role,
        session_id=session.session_id,
        must_change_password=session.must_change_password,
        expires_at=session.absolute_expires_at,
        idle_expires_at=session.idle_expires_at,
    )


def unauthenticated() -> ApiError:
    return ApiError(401, "E_UNAUTHORIZED", _UNAUTHENTICATED)


def enforce_csrf(request: Request, header_name: str) -> None:
    """Require a custom header on every state-changing request.

    Checked before authentication so that a CSRF probe cannot be used to
    confirm whether the victim's cookie is still valid.
    """
    value = request.headers.get(header_name)
    if not value or not value.strip():
        raise ApiError(
            403,
            "E_CSRF",
            f"Missing required '{header_name}' header. Browser clients must send "
            "it on every POST.",
            internal=f"CSRF header {header_name} absent from {request.url.path}",
        )
    if len(value) > 64:
        raise ApiError(
            403,
            "E_CSRF",
            f"The '{header_name}' header value is not acceptable.",
            internal="CSRF header too long",
        )


def set_session_cookie(
    response: JSONResponse,
    raw_token: str,
    *,
    cookie_name: str,
    max_age: int,
    secure: bool,
) -> None:
    response.set_cookie(
        key=cookie_name,
        value=raw_token,
        max_age=max_age,
        httponly=True,
        samesite="strict",
        secure=secure,
        path="/",
    )


def clear_session_cookie(response: JSONResponse, cookie_name: str, secure: bool) -> None:
    response.delete_cookie(
        key=cookie_name, path="/", httponly=True, samesite="strict", secure=secure
    )


__all__ = [
    "ApiError",
    "Principal",
    "ROLE_INSTRUCTOR",
    "ROLE_STUDENT",
    "api_error_response",
    "clear_session_cookie",
    "client_ip",
    "enforce_csrf",
    "principal_from_session",
    "session_from_request",
    "set_session_cookie",
    "unauthenticated",
]
