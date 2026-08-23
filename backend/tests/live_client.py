"""A dependency-free HTTP client + live uvicorn server harness.

We deliberately do NOT use starlette's TestClient (it needs httpx, which is not
in the environment, and it short-circuits the ASGI stack). Tests therefore run
against a real uvicorn process handling real sockets - which is also the only
way to prove that a runaway query does not hang the shared service.
"""

from __future__ import annotations

import json as jsonlib
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class Response:
    def __init__(self, status_code: int, text: str, headers=None) -> None:
        self.status_code = status_code
        self.text = text
        # Multi-valued: several Set-Cookie headers may arrive on one response.
        self.headers: list[tuple[str, str]] = list(headers or [])

    def json(self):
        return jsonlib.loads(self.text)

    def header(self, name: str) -> str | None:
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None

    def headers_all(self, name: str) -> list[str]:
        return [v for k, v in self.headers if k.lower() == name.lower()]

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Response {self.status_code} {self.text[:200]}>"


class LiveClient:
    """Minimal HTTP client with a cookie jar and the CSRF header attached.

    The CSRF header goes on by default because that is what the real UI does;
    tests that need to prove the CSRF check bites pass `csrf=False`.
    """

    def __init__(
        self,
        base_url: str,
        timeout: float = 60.0,
        csrf_header: str = "X-AIVB-Client",
        csrf_value: str = "web",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.csrf_header = csrf_header
        self.csrf_value = csrf_value
        self.cookies: dict[str, str] = {}

    # -- cookies ----------------------------------------------------------
    def _store_cookies(self, response_headers) -> None:
        for raw in response_headers.get_all("Set-Cookie") or []:
            first = raw.split(";")[0].strip()
            if "=" not in first:
                continue
            name, _, value = first.partition("=")
            name, value = name.strip(), value.strip()
            # An expiring cookie arrives with an empty value / past date.
            if value in ("", '""') or "max-age=0" in raw.lower():
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def clear_cookies(self) -> None:
        self.cookies.clear()

    def copy_without_cookies(self) -> "LiveClient":
        clone = LiveClient(self.base_url, self.timeout, self.csrf_header, self.csrf_value)
        return clone

    # -- transport --------------------------------------------------------
    def _send(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        csrf: bool = True,
        headers: dict | None = None,
        cookies: bool = True,
    ) -> Response:
        hdrs: dict[str, str] = {}
        if body:
            hdrs["Content-Type"] = "application/json"
        if csrf:
            hdrs[self.csrf_header] = self.csrf_value
        if cookies and self.cookies:
            hdrs["Cookie"] = self._cookie_header()
        hdrs.update(headers or {})

        req = urllib.request.Request(
            self.base_url + path, data=body, method=method, headers=hdrs
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                self._store_cookies(resp.headers)
                return Response(resp.status, resp.read().decode("utf-8"), resp.headers.items())
        except urllib.error.HTTPError as exc:
            self._store_cookies(exc.headers)
            return Response(exc.code, exc.read().decode("utf-8"), exc.headers.items())

    def get(self, path: str, params: dict | None = None, **kw) -> Response:
        if params:
            norm = {k: ("true" if v is True else "false" if v is False else v)
                    for k, v in params.items()}
            path = f"{path}?{urllib.parse.urlencode(norm)}"
        return self._send("GET", path, **kw)

    def post(self, path: str, json: dict, **kw) -> Response:
        return self._send("POST", path, jsonlib.dumps(json).encode("utf-8"), **kw)

    # -- convenience ------------------------------------------------------
    def login(self, username: str, password: str) -> Response:
        return self.post("/auth/login", json={"username": username, "password": password})

    def logout(self) -> Response:
        return self.post("/auth/logout", json={})


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LiveServer:
    """Runs the FastAPI app in a uvicorn server on a background thread."""

    def __init__(self, app) -> None:
        import uvicorn

        self.port = _free_port()
        config = uvicorn.Config(
            app, host="127.0.0.1", port=self.port, log_level="warning", access_log=False
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, wait_s: float = 30.0) -> None:
        self._thread.start()
        deadline = time.time() + wait_s
        while time.time() < deadline:
            if getattr(self._server, "started", False):
                return
            time.sleep(0.05)
        raise RuntimeError("uvicorn did not start in time")

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=15)
