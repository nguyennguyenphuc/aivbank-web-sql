"""Tests that pin the API to API_CONTRACT.md, not to the other way round.

Two discrepancies were found by the frontend engineer against the running
server and are locked down here:

  (a) contract §2 promises `"ok": true` on *every* 200, but
      GET /schema/tables/{name} did not send it.  -> server fixed.
  (b) `E_ROW_LIMIT` does not exist; hitting the row cap is a 200 with
      `truncated: true`.                          -> contract clarified.

Plus the CORS-safe-by-default behaviour from §12, tested at the policy level
(the middleware is wired from env at import time, so the end-to-end proof lives
in the deployment checklist run, not here).
"""

from __future__ import annotations

import re

import pytest

from backend.config import (
    CONTENT_SECURITY_POLICY,
    LOCALHOST_ORIGIN_REGEX,
    resolve_cors_policy,
)

CONTRACT_ERROR_CODES = {
    "E_EMPTY_SQL", "E_SQL_TOO_LONG", "E_INVALID_INPUT", "E_PARSE",
    "E_MULTI_STATEMENT", "E_NOT_SELECT", "E_UNKNOWN_TABLE",
    "E_RESERVED_CTE_NAME", "E_UNSUPPORTED_FUNCTION", "E_UNSUPPORTED_SYNTAX",
    "E_TOO_COMPLEX", "E_QUERY_FAILED", "E_TIMEOUT", "E_SERVICE_BUSY",
    "E_DB_UNAVAILABLE", "E_INTERNAL",
}


# ------------------------------------------------------- (a) the `ok` invariant
def test_every_200_response_has_ok_true(client):
    """§2: every successful response contains "ok": true. No exceptions."""
    endpoints = [
        "/health",
        "/schema",
        "/schema/tables",
        "/schema/tables/core_party",
        "/schema/tables/core_party?include_row_count=true",
    ]
    for path in endpoints:
        r = client.get(path)
        assert r.status_code == 200, f"{path}: {r.text[:200]}"
        body = r.json()
        assert body.get("ok") is True, f"{path} is missing 'ok': {sorted(body)}"

    r = client.post("/query", json={"sql": "SELECT 1 AS n"})
    assert r.status_code == 200, r.text
    assert r.json().get("ok") is True


def test_table_detail_keeps_its_documented_fields_alongside_ok(client):
    r = client.get("/schema/tables/core_party")
    body = r.json()
    assert set(body) == {"ok", "name", "columns", "row_count"}
    assert body["name"] == "core_party"
    assert body["row_count"] is None
    assert body["columns"] and set(body["columns"][0]) == {
        "name", "type", "nullable", "primary_key"
    }


def test_full_schema_tables_are_not_polluted_with_per_table_ok(client):
    """`ok` marks a *response*, not a table. §5's nested shape must not change."""
    body = client.get("/schema").json()
    assert body["ok"] is True
    assert body["tables"], "expected at least one table"
    for table in body["tables"]:
        assert set(table) == {"name", "columns", "row_count"}, (
            f"nested table {table.get('name')} gained an unexpected field"
        )


def test_unknown_and_withheld_tables_stay_indistinguishable(client):
    """Adding `ok` must not have changed the 404 path (no existence oracle)."""
    a = client.get("/schema/tables/meta_dirty_log")
    b = client.get("/schema/tables/core_partyy")
    assert a.status_code == b.status_code == 404
    for r, name in ((a, "meta_dirty_log"), (b, "core_partyy")):
        body = r.json()
        assert body == {
            "ok": False,
            "error_code": "E_UNKNOWN_TABLE",
            "message": f"Table '{name}' does not exist or is not available in this dataset.",
        }


def test_every_error_response_uses_the_documented_envelope(client):
    r = client.post("/query", json={"sql": "DROP TABLE core_party"})
    assert r.status_code == 400
    body = r.json()
    assert set(body) == {"ok", "error_code", "message"}
    assert body["ok"] is False
    assert body["error_code"] in CONTRACT_ERROR_CODES


# --------------------------------------------------- (b) there is no E_ROW_LIMIT
def test_row_cap_is_a_200_with_truncated_not_an_error(client):
    r = client.post("/query", json={"sql": "SELECT party_id FROM core_party", "max_rows": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["truncated"] is True
    assert body["row_limit"] == 3
    assert body["row_count"] == 3
    assert "error_code" not in body


def test_no_endpoint_ever_emits_an_undocumented_error_code(client):
    """Guards against E_ROW_LIMIT (or any other code) creeping back in."""
    probes = [
        {"sql": ""},
        {"sql": "-- just a comment"},
        {"sql": "DROP TABLE core_party"},
        {"sql": "SELECT 1; SELECT 2"},
        {"sql": "SELECT * FROM meta_dirty_log"},
        {"sql": "SELECT nope FROM core_party"},
        {"sql": "SELECT ((("},
        {"sql": "SELECT * FROM read_csv_auto('/etc/passwd')"},
        {"sql": "SELECT party_id FROM core_party", "max_rows": 1},
        {"sql": "SELECT * FROM core_party"},
    ]
    seen = set()
    for probe in probes:
        body = client.post("/query", json=probe).json()
        if "error_code" in body:
            seen.add(body["error_code"])
    assert seen, "expected at least one rejection among the probes"
    assert seen <= CONTRACT_ERROR_CODES, f"undocumented code(s): {seen - CONTRACT_ERROR_CODES}"
    assert "E_ROW_LIMIT" not in seen


# ---------------------------------------------------- §12 CORS safe by default
def test_unset_cors_is_loopback_only_never_wildcard():
    for raw in (None, "", "   ", ",,"):
        policy = resolve_cors_policy(raw)
        assert policy.mode == "localhost-default"
        assert "*" not in policy.allow_origins
        assert policy.allow_origins == ()
        assert policy.allow_origin_regex == LOCALHOST_ORIGIN_REGEX
        assert policy.warnings, "an unset CORS config must warn the operator"


@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("http://localhost:5173", True),
        ("http://127.0.0.1:5173", True),
        ("http://127.0.0.1", True),
        ("https://localhost:8443", True),
        ("http://[::1]:5173", True),
        ("https://evil.example.com", False),
        ("http://aivbank.example.org", False),
        ("http://localhost.evil.com", False),
        ("http://evil.com/localhost", False),
        ("http://127.0.0.1.evil.com", False),
        ("http://notlocalhost", False),
        ("file://", False),
        ("null", False),
    ],
)
def test_loopback_regex_matches_only_real_loopback_origins(origin, allowed):
    assert bool(re.match(LOCALHOST_ORIGIN_REGEX, origin)) is allowed


def test_explicit_origins_win_and_do_not_get_loopback_for_free():
    policy = resolve_cors_policy("https://sql.aivbank.edu.vn")
    assert policy.mode == "explicit"
    assert policy.allow_origins == ("https://sql.aivbank.edu.vn",)
    assert policy.allow_origin_regex is None, "explicit config must not also open loopback"


def test_wildcard_requires_deliberate_opt_in_and_is_flagged():
    policy = resolve_cors_policy("*")
    assert policy.mode == "wildcard"
    assert policy.allow_origins == ("*",)
    assert any("SECURITY" in w for w in policy.warnings)

    # A wildcard anywhere in the list makes the whole list a wildcard; say so.
    mixed = resolve_cors_policy("https://sql.aivbank.edu.vn,*")
    assert mixed.mode == "wildcard"


def test_operator_typos_are_normalised_and_reported():
    policy = resolve_cors_policy("https://sql.aivbank.edu.vn/, aivbank.example.org")
    assert policy.allow_origins == ("https://sql.aivbank.edu.vn", "aivbank.example.org")
    assert any("trailing slash" in w for w in policy.warnings)
    assert any("no scheme" in w for w in policy.warnings)


# ---------------------------------------------------------------------------
# Content-Security-Policy
#
# The CSP was unasserted for the whole life of this service, so nothing would
# have caught it being widened by accident. These tests pin it at the policy
# level, the same way the CORS tests above do: they read the constant, so they
# run without PostgreSQL and without a live server.
# ---------------------------------------------------------------------------

def _csp_directives() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for part in CONTENT_SECURITY_POLICY.split(";"):
        part = part.strip()
        if not part:
            continue
        name, _, rest = part.partition(" ")
        out[name] = set(rest.split())
    return out


def test_csp_allows_wasm_but_never_js_eval():
    """The sandbox tab needs WebAssembly. It does not need eval(), ever.

    'wasm-unsafe-eval' compiles WASM and nothing else. 'unsafe-eval' would also
    re-open `eval()` and `new Function()` on a page where students type text
    that is echoed back to them -- a much larger blast radius for one feature.
    """
    script_src = _csp_directives()["script-src"]
    assert "'wasm-unsafe-eval'" in script_src
    assert "'unsafe-eval'" not in script_src
    assert "'unsafe-inline'" not in script_src, "inline <script> must stay blocked"


def test_csp_never_allows_a_blob_worker():
    """DuckDB's worker is loaded from its own same-origin vendored file.

    The common DuckDB-WASM recipe builds the worker from a Blob URL, which
    would force `worker-src blob:` into this header. We construct the Worker
    from frontend/vendor/duckdb-wasm/ instead, so `default-src 'self'` covers
    it. If this test fails, someone took the shortcut -- fix the loader.
    """
    assert "blob:" not in CONTENT_SECURITY_POLICY
    assert "worker-src" not in CONTENT_SECURITY_POLICY


def test_csp_keeps_every_pre_existing_restriction():
    """A relaxation for one feature must not quietly relax anything else."""
    d = _csp_directives()
    assert d["default-src"] == {"'self'"}
    assert d["base-uri"] == {"'self'"}
    assert d["connect-src"] == {"'self'"}, "the app talks to its own origin only"
    assert d["font-src"] == {"'self'"}, "no CDN fonts -- labs can be offline"
    assert d["frame-ancestors"] == {"'none'"}
    assert d["object-src"] == {"'none'"}
    assert d["img-src"] == {"'self'", "data:"}
    # style-src keeps 'unsafe-inline': the app sets element styles from JS.
    assert d["style-src"] == {"'self'", "'unsafe-inline'"}
