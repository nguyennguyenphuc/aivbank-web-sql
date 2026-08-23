#!/usr/bin/env python3
"""Development server for the student SQL console.

Serves the static files in web/ AND forwards the API paths to the backend, so
the browser sees a single origin.

    python frontend/serve.py [--port 5173] [--host 127.0.0.1] [--api URL] [--no-proxy]

Why it proxies now, when it deliberately did not before
-------------------------------------------------------
The session is an HttpOnly cookie and every request is sent with
``credentials: 'same-origin'``. A browser will not attach that cookie to an API
on a different origin, so with the UI on :5173 and the API on :8000 login would
"succeed" and every request after it would come back 401. One origin is not a
convenience here, it is a requirement of cookie auth.

The old comment warned that a proxy would create a second place where
permissions are decided. It does not: this proxy makes no decision. It copies
the method, path, body and headers up, and the status, body and ``Set-Cookie``
back. Authentication and the student/instructor split stay entirely in api/. If
you ever find yourself adding an ``if`` to this file about *who may see what*,
that is the bug.

In production put both behind one real reverse proxy (nginx/Caddy) over HTTPS
and serve web/ from it; this script is for the lab and for development.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent

# Path prefixes handed to the backend. Everything else is a static file.
API_PREFIXES = (
    "/auth/",
    "/auth",
    "/health",
    "/schema",
    "/query",
    "/gamification",
    "/admin/analytics",
)

# Hop-by-hop headers must not be forwarded in either direction (RFC 9110 §7.6.1).
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def is_api_path(path: str) -> bool:
    only_path = urllib.parse.urlsplit(path).path
    return any(
        only_path == p.rstrip("/") or only_path.startswith(p.rstrip("/") + "/") or only_path == p
        for p in API_PREFIXES
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    api_base: str | None = None

    # ---------------------------------------------------------------- static

    def end_headers(self) -> None:
        # No client-side caching. Two reasons: the UI must re-fetch /schema on
        # every load, and a cached console page must not be restorable from disk
        # after someone signs out on a shared machine.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        if args and str(args[0]).startswith(("GET", "HEAD")):
            return
        super().log_message(fmt, *args)

    # ----------------------------------------------------------------- proxy

    def do_GET(self) -> None:  # noqa: N802
        if self.api_base and is_api_path(self.path):
            self.proxy("GET")
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self.api_base and is_api_path(self.path):
            self.proxy("HEAD")
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802
        if self.api_base and is_api_path(self.path):
            self.proxy("POST")
            return
        self.send_error(405, "This server only serves static files and proxies the API.")

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self.api_base and is_api_path(self.path):
            self.proxy("OPTIONS")
            return
        self.send_error(405)

    def proxy(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        target = self.api_base.rstrip("/") + self.path
        req = urllib.request.Request(target, data=body, method=method)

        # Forward the request headers as-is. In particular Cookie (the session)
        # and X-AIVB-Client (the CSRF marker the backend requires on POST): if
        # this dropped either, the proxy would be silently changing the security
        # properties of the request, which is exactly what it must not do.
        for name, value in self.headers.items():
            if name.lower() in HOP_BY_HOP or name.lower() == "host":
                continue
            req.add_header(name, value)

        try:
            with urllib.request.urlopen(req, timeout=180) as up:
                status, headers, payload = up.status, up.headers, up.read()
        except urllib.error.HTTPError as e:
            # 401/403/404/429 are normal answers here, not proxy failures: pass
            # the backend's own status and body through untouched.
            status, headers, payload = e.code, e.headers, e.read()
        except Exception as e:  # backend down / timeout
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b'{"error_code":"E_CLIENT_NETWORK","message":"Khong ket noi duoc toi API."}'
            )
            self.log_message("proxy %s %s failed: %s", method, self.path, e)
            return

        self.send_response(status)
        for name, value in headers.items():
            low = name.lower()
            # send_response() already emitted Server and Date; forwarding the
            # upstream's copies would duplicate both headers on every response.
            if low in HOP_BY_HOP or low in ("content-length", "server", "date"):
                continue
            # Set-Cookie must survive verbatim, including HttpOnly/SameSite.
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        # end_headers() adds the no-store headers; harmless on API responses and
        # right for anything the backend did not mark itself.
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded: a 30-second query must not block the page from loading."""

    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument(
        "--api",
        default="http://127.0.0.1:8000",
        help="Backend to forward application API paths to.",
    )
    ap.add_argument(
        "--no-proxy",
        action="store_true",
        help="Serve static files only. Login will NOT work: the session cookie "
        "is not sent to a different origin.",
    )
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=str(ROOT))
    Handler.api_base = None if args.no_proxy else args.api

    with ThreadingServer((args.host, args.port), handler) as httpd:
        print(f"Student SQL console: http://{args.host}:{args.port}/")
        print(f"Serving {ROOT}")
        if Handler.api_base:
            print(f"Proxying {', '.join(API_PREFIXES[1:])} -> {Handler.api_base}")
        else:
            print("Proxy disabled: login will not work (cookie is same-origin only).")
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
