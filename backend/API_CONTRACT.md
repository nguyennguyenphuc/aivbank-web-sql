# AIV Bank — Student SQL API contract

Version `1.4.0` · backend owner: `aivbank-backend-engineer` · consumer: `aivbank-frontend-engineer`

This document is the **only** thing the frontend should build against. Every response shape
below was captured from the running server against the real
`_workspace/output/student.duckdb`, not written from memory.

### Changelog

**1.5.1** - Adds `GET /schema/relationships` and `GET /schema/game`, the data
behind the console's ERD tab (section 6b). Relationships come from the
database's own `pg_constraint` and pass the same allowlist as `GET /schema` at
**both** ends: an edge that touches a withheld table or column does not exist.

**1.4.1** - Adds `GET /schema/marts` and `GET /schema/marts/{mart_name}`.
Both endpoints use the authenticated role database and expose only visible
tables with the `mart_` prefix. They never inspect the full source database.
Use `include_row_count=true` when the caller needs a row count.

**1.4.0** — **column-level permissions.** Follows the mentor's ruling of 2026-08-04 (answer 3:
`raw_account_transaction.dirty_flag` moves to INSTRUCTOR "regardless of any other choice") and
delta spec P1. No request or response *shape* changed; two **numbers** did, and the frontend
must stop assuming a table's column list is the same for every role.

| # | Change | Kind |
|---|---|---|
| 1 | **`student_visibility` is no longer a per-table flag.** `raw_account_transaction` is **MIXED**: 5 STUDENT columns + `dirty_flag`, which is now INSTRUCTOR. A STUDENT session sees the table with **5** columns; an INSTRUCTOR session sees **6**. The API is the source of truth — never cache a column list across roles. | breaking-ish |
| 2 | A STUDENT query naming `dirty_flag` is refused with `400 E_QUERY_FAILED` and DuckDB's own *"Referenced column … not found in FROM clause!"* text — deliberately **identical** to a misspelled column, because on a correctly built `student.duckdb` the column genuinely is not there. | server |
| 3 | **`AIVB_AUDIT_COLUMNS` now defaults to empty.** It used to default to `dirty_flag`; that column is refused now, so watching it is meaningless. The mechanism is unchanged and still configurable. §11. | server |
| 4 | Full v5.1.6.4 totals are read from release artifacts: **100 tables / 611 columns**. The STUDENT projection is **77 tables / 405 columns**; INSTRUCTOR sees **100 / 611**. DEC-07 withholds 23 whole tables plus `raw_account_transaction.dirty_flag`. | breaking |
| 5 | **`GET /health` reports the caller's own `table_count`.** Anonymous callers still see the student projection count. §3. | server |
| 6 | New `400 E_UNSUPPORTED_SYNTAX` case: `SELECT *` over a MIXED table is refused **only while the connected file still physically contains the withheld column**, i.e. on a stale export. On a correctly built one, `SELECT *` works normally. §10. | server |

**1.3.0** — **authentication and authorization. This is a BREAKING change for the frontend.**
The project owner confirmed eDA has no existing sign-in system, so the service now has its
own. §1.1 of the old document ("There is no authentication layer") no longer holds, and the
reverse-proxy recommendation in the old §12.3 has been superseded by an implementation.

| # | Change | Kind |
|---|---|---|
| 1 | **`/query` and every `/schema*` endpoint now require a session cookie.** No cookie → `401 E_UNAUTHORIZED`. `/health` stays public. | breaking |
| 2 | New endpoints: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`, and `GET /audit/recent` (INSTRUCTOR only). See §13. | additive |
| 3 | **Every POST must carry the header `X-AIVB-Client: web`.** Missing → `403 E_CSRF`. This is the CSRF control; a cross-site form cannot set it. | breaking |
| 4 | Two roles. `STUDENT` is served the 77-table/405-column physical projection. `INSTRUCTOR` is served the 100-table/611-column internal dataset. The role picks the **database file**, not a filter. | breaking |
| 5 | New error codes: `E_UNAUTHORIZED`, `E_BAD_CREDENTIALS`, `E_CSRF`, `E_FORBIDDEN`, `E_PASSWORD_CHANGE_REQUIRED`, `E_WEAK_PASSWORD`, `E_RATE_LIMITED`, `E_AUTH_UNAVAILABLE`. §8. | additive |
| 6 | `fetch` must now send `credentials: 'include'`, and `AIVB_CORS_ORIGINS` must name the UI origin exactly — cookies are not sent to a wildcard origin. §9, §12. | breaking |
| 7 | Accounts are created by the instructor with `python -m backend.admin_cli`. There is no self-service registration, by design. §13.6. | additive |

**1.2.0** — operational hardening after re-testing on the full 9.1 GB / 90.2M-row build.
**No request or response shape changed**, so no frontend work is required; the only
observable difference is that `503 E_SERVICE_BUSY` now happens far less often.

| # | Change | Kind |
|---|---|---|
| 1 | Admission control **queues** instead of rejecting instantly. Measured before: 10 students pressing Run together got six `503`s even on a 60 ms query. After: 10/10 succeed. The concurrency cap itself is unchanged — never more than `AIVB_MAX_CONCURRENT_QUERIES` run at once. New `AIVB_MAX_QUEUED_QUERIES` / `AIVB_ADMISSION_WAIT_S`. | server |
| 2 | DuckDB spill moved out of the release folder. It defaulted to `<db file>.tmp`, i.e. a directory created inside `_workspace/release/student/` next to the shipped `student.duckdb`. Now `AIVB_TEMP_DIR`, size-capped by `AIVB_MAX_TEMP_SIZE`. | server |
| 3 | Out-of-memory queries returned the useless `"The query could not be executed."`. They now return actionable advice — with DuckDB's own `SET memory_limit=...` coaching and the server's budget stripped out. Still `400 E_QUERY_FAILED`. | server |
| 4 | `dirty_flag` use is written to the server log (`AIVB_AUDIT_COLUMNS`). **Log only** — never blocked, never surfaced to the client, response byte-identical. See §11. *(Superseded by 1.4.0: the column is now refused, and the watch list defaults to empty.)* | server |

**1.1.0** — two discrepancies found by the frontend engineer against the running server,
plus deployment hardening. All three changes are backward compatible for a client that
branches on HTTP status (which `web/` does).

| # | Change | Kind |
|---|---|---|
| 1 | `GET /schema/tables/{name}` now returns `"ok": true` like every other 200. §2's invariant had no exception; the server was the side that was wrong. **Additive** — an extra field, nothing renamed or removed. | server |
| 2 | §8 now states explicitly that **`E_ROW_LIMIT` does not exist** and never did. Hitting the row cap is a `200` with `truncated: true`. The contract was already right; it just did not say so loudly enough. | docs |
| 3 | `AIVB_CORS_ORIGINS` no longer defaults to `*`. Unset now means **loopback-only**. New §12 is the pre-deployment checklist. | server + docs |

---

## 1. Running the server

```bash
source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh && conda activate aivbank
cd /Users/nguyennp/AI/Finance
AIVB_DB_PATH=_workspace/output/student.duckdb \
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Interactive docs: `GET /docs` · machine-readable: `GET /openapi.json`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AIVB_DB_PATH` | `_workspace/output/student.duckdb` | DuckDB file, opened **read-only**. |
| `AIVB_CONTRACT_PATH` | `_workspace/00_spec-reader_column-contract.json` | Permission source of truth. |
| `AIVB_QUERY_TIMEOUT_S` | `15` | Per-query wall clock. |
| `AIVB_MAX_ROWS` | `1000` | Server row cap. |
| `AIVB_MAX_SQL_CHARS` | `20000` | Max SQL length. |
| `AIVB_MAX_RESPONSE_BYTES` | `8388608` | Response size budget. |
| `AIVB_MAX_CONCURRENT_QUERIES` | `4` | Queries executing at once. |
| `AIVB_MAX_QUEUED_QUERIES` | `16` | Requests allowed to **wait** for one of those slots. Beyond this → immediate `503`. |
| `AIVB_ADMISSION_WAIT_S` | `10` | How long a request waits for a slot before `503`. |
| `AIVB_MEMORY_LIMIT` | `2GB` | DuckDB memory cap — **process-wide, not per request** (see §11). |
| `AIVB_DUCKDB_THREADS` | `2` | DuckDB threads. |
| `AIVB_TEMP_DIR` | `<system temp>/aivb_duckdb_spill` | Where DuckDB spills. Never inside the release folder. |
| `AIVB_MAX_TEMP_SIZE` | `8GB` | Spill size cap. |
| `AIVB_AUDIT_COLUMNS` | *(empty)* | Optional watch list: columns whose use is logged (log only — never blocked, never visible to the client). Empty since 1.4.0; see §11. |
| `AIVB_CORS_ORIGINS` | *(unset → loopback only)* | Comma-separated allowed origins. **Set this to the real UI origin before release** — see §12. |
| `AIVB_LOG_LEVEL` | `INFO` | Server log level. |

#### Authentication variables (new in 1.3.0)

| Variable | Default | Meaning |
|---|---|---|
| *(no credential-store variable)* | — | Passwords live in PostgreSQL's `pg_authid`. The app never hashes or stores a copy: `verify_password` opens a connection as the user's own role, so connecting *is* the check. There is no file to misplace. |
| `AIVB_AUDIT_LOG_PATH` | `_workspace/auth/audit.jsonl` | Append-only JSONL audit log. |
| `AIVB_INSTRUCTOR_DB_PATH` | *(unset)* | The 100-table/611-column internal dataset. Unset means INSTRUCTOR sessions get the same student dataset — less access, never more. |
| `AIVB_OWNER_CONFIG_PATH` | `AIV_Bank_full_standalone_v5.1.6.4/01_cau_hinh_owner_v1.0.json` | Normative DEC-07 visibility, alias and delivery policy. Startup fails closed if it conflicts with the column contract. |
| `AIVB_COOKIE_SECURE` | `0` | Marks the session cookie `Secure`. **Set to `1` behind TLS.** Left off, the server logs a `SECURITY:` warning at every start. |
| `AIVB_COOKIE_NAME` | `aivb_session` | Session cookie name. |
| `AIVB_CSRF_HEADER` | `X-AIVB-Client` | Header required on every POST. |
| `AIVB_SESSION_IDLE_S` | `28800` (8 h) | Idle timeout. |
| `AIVB_SESSION_ABSOLUTE_S` | `43200` (12 h) | Absolute session lifetime, regardless of activity. |
| `AIVB_LOGIN_FAIL_THRESHOLD` | `5` | Failed logins per **username** before lockout. |
| `AIVB_LOGIN_IP_FAIL_THRESHOLD` | `20` | Failed logins per **client IP** before lockout. Higher than the username threshold on purpose: a classroom behind one NAT shares an address, and a 5-strike IP rule would let one student's typo lock out the room. |
| `AIVB_LOGIN_LOCK_BASE_S` | `30` | First lockout duration; doubles per subsequent failure. |
| `AIVB_LOGIN_LOCK_MAX_S` | `900` | Lockout ceiling (15 minutes). |
| `AIVB_AUDIT_ENABLED` | `1` | Write the audit log. |

**Sizing for a cohort.** `AIVB_MAX_CONCURRENT_QUERIES + AIVB_MAX_QUEUED_QUERIES` is the
number of simultaneous `/query` requests the server will accept; the rest get `503`
immediately. The default `4 + 16 = 20` suits a class of ~20. For 40 students pressing Run
at the same instant, set `AIVB_MAX_QUEUED_QUERIES=40` — measured on the 9.1 GB build that
serves 40/40 in ≤ 4.5 s. The request threadpool is resized automatically to stay wider
than the queue, so `/health` and `/schema` never queue behind `/query`.

`AIVB_CORS_ORIGINS` is **safe by default**: if you do not set it, the server allows only
`http(s)://localhost`, `http(s)://127.0.0.1` and `http(s)://[::1]` on any port, and logs a
warning at startup. It does **not** silently fall back to `*`. Setting it explicitly replaces
that default entirely (loopback is then *not* included for free). `*` is still available, but
only as a deliberate choice, and it logs a `SECURITY:` line every start.

### 1.1 Authentication in one paragraph

Every data endpoint needs a session. Get one with `POST /auth/login`, which sets an
`HttpOnly; SameSite=Strict` cookie; send that cookie on every subsequent call
(`credentials: 'include'`), plus the header `X-AIVB-Client: web` on every POST. Sessions
expire after 8 h idle / 12 h absolute. Accounts are created by the instructor via
`python -m backend.admin_cli`; there is no registration endpoint. Full detail in §13.

---

## 2. Conventions

* All responses are JSON, UTF-8.
* Every **successful** response contains `"ok": true`. **No exceptions** — this holds for
  `/health`, `/schema`, `/schema/tables`, `/schema/tables/{name}` and `/query` alike.
  (`/schema/tables/{name}` was missing it up to 1.0.0; fixed in 1.1.0.)
  `ok` marks a *response*, not an object: the table objects nested inside `/schema` do
  **not** carry it.
* Prefer branching on the **HTTP status**; `ok` is a redundant cross-check, useful when a
  body is logged or replayed without its status.
* Every **error** response has exactly this shape, at every endpoint and every status code:

```json
{ "ok": false, "error_code": "E_UNKNOWN_TABLE", "message": "human readable, safe to display" }
```

`message` is written for a student to read and may be shown verbatim in the UI.
Branch on `error_code`, never on `message` text.

---

## 3. `GET /health`

Liveness plus the limits the UI should display. Never errors. **Public** — no session needed.

```json
{
  "ok": true,
  "status": "healthy",
  "version": "1.4.0",
  "table_count": 77,
  "max_rows": 1000,
  "query_timeout_s": 15.0
}
```

`status` is `"healthy"` or `"degraded"`. `degraded` (with `ok: false`) means the database file
was missing or locked at startup; `/query` and the schema endpoints will return `503`
`E_DB_UNAVAILABLE` until the server is restarted with a valid `AIVB_DB_PATH`.

**`table_count` is role-dependent (changed in 1.4.0).** If the request carries a valid session
cookie, the number is that session's own catalog — the same number `GET /schema/tables`
returns, so the two can never disagree on screen again. Anything else (no cookie, an expired
or revoked one, an account still on a forced password change) gets the **student** number,
which is what every caller got before. Do not use `/health` to infer whether you are signed in
— call `GET /auth/me`.

Polling `/health` does **not** refresh the session idle timer, so a left-open tab still
expires on schedule.

---

## 3b. `GET /datasets`

Which teaching datasets this session may use. Requires an active session.

```json
{
  "ok": true,
  "default": "aivb",
  "datasets": [
    {"name": "aivb", "label": "Finance Banking", "currency": "VND_INT",
     "table_count": 77, "available": true},
    {"name": "scm",  "label": "Supply Chain",    "currency": "USD_DEC",
     "table_count": 20, "available": true}
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Pass this as `?dataset=` (schema endpoints) or `"dataset"` (POST /query). |
| `label` | Display text. The frontend must not invent its own. |
| `currency` | `VND_INT` = integer VND, never rounded (§7). `USD_DEC` = USD with decimals. |
| `table_count` | Tables visible to THIS session's role in that dataset. |
| `available` | `false` when that dataset's database could not be opened. The entry is still returned — a dataset that vanished from the list would look like a feature that was never built. |

**The frontend MUST NOT carry its own list of datasets**, for exactly the reason
it must not carry its own list of tables (§9.1): this endpoint is the only
source of truth, and it already reflects the session's role.

### The `dataset` parameter

Every schema endpoint accepts `?dataset=<name>`; `POST /query` takes it in the
**body**, because it describes the run itself and is written to the audit log
next to the SQL. Omitting it selects the default dataset, so a client written
before datasets existed keeps working unchanged.

An unknown dataset name is `503 E_DB_UNAVAILABLE`, the same as a dataset whose
database is down. It is deliberately NOT a distinct code: a probe must not be
able to tell "no such dataset" from "that dataset is currently unavailable".

**Datasets do not share a catalog.** A table in one is not merely filtered out
of the other — it is absent from its catalog entirely, so asking for it returns
the ordinary `E_UNKNOWN_TABLE` with the ordinary wording. There is no phrasing
that reveals a table exists in a dataset you are not looking at. This is the
same property §10 describes for withheld tables, extended along the new axis.

## 4. `GET /schema/tables`

The table picker / sidebar list. Cheap — call it on page load.

```json
{
  "ok": true,
  "table_count": 77,
  "tables": [
    { "name": "bridge_loan_collateral", "column_count": 1 },
    { "name": "core_account", "column_count": 7 },
    { "name": "raw_account_transaction", "column_count": 5 }
  ]
}
```

Sorted by `name` ascending. `table_count` is **77** for a STUDENT session and **100** for an
INSTRUCTOR one; `column_count` is likewise per-role (see §5.1). Read both from the response —
never hardcode them.

---

## 5. `GET /schema`

Everything at once — use this to power autocomplete. For a STUDENT session: 77 tables /
405 columns. For an INSTRUCTOR session: 100 tables / 611 columns.

```json
{
  "ok": true,
  "table_count": 77,
  "tables": [
    {
      "name": "core_account",
      "row_count": null,
      "columns": [
        { "name": "account_id", "type": "VARCHAR", "nullable": false, "primary_key": true },
        { "name": "currency",   "type": "VARCHAR", "nullable": false, "primary_key": false }
      ]
    }
  ]
}
```

`row_count` is always `null` here (counting every visible table per request would be wasteful).
`type` is the native DuckDB type.

### 5.1 Column visibility is per role (new in 1.4.0)

Until 2026-08-04 every column of a table shared the table's `student_visibility`, so "which
tables you can see" fully described the permission model. It no longer does.

`raw_account_transaction` is **MIXED**. Its `dirty_flag` column is the grading answer key —
it reproduces `meta_dirty_log` exactly — and the mentor moved it to INSTRUCTOR while leaving
the other five columns STUDENT, because the raw-staging exercise is built on them.

| Role | `raw_account_transaction` columns |
|---|---|
| `STUDENT` | `raw_row_id`, `source_file_id`, `source_row_number`, `amount_text`, `date_text` |
| `INSTRUCTOR` | the same five **plus** `dirty_flag` |

Consequences for the UI:

* **Never cache a schema across sessions or roles.** Refetch `/schema` after every login.
* **Never build a column list from the parameter book, the workbook's ERD sheet or this
  document.** (The console's own ERD tab is drawn from `GET /schema` plus
  `GET /schema/relationships`, so it follows this rule.) The
  numbers here are documentation; the API response is the contract. Sheet 20 of the workbook
  still shows `dirty_flag` under `raw_account_transaction` — the delta overlay is what makes
  it INSTRUCTOR, and only the API has applied it.
* A student query naming `dirty_flag` fails with `400 E_QUERY_FAILED` and a message that is
  **byte-identical** to a misspelled column. That is deliberate: there must be no way to
  distinguish "withheld" from "does not exist". Do not add a special case for it in the UI.

---

## 6b. ERD data (new in 1.5.1)

### `GET /schema/relationships?dataset=<name>`

Session required. Same `dataset` parameter and `503 E_DB_UNAVAILABLE` as `GET /schema`.

```json
{"ok": true, "relationships": [
  {"from_table": "core_account", "from_columns": ["party_id"],
   "to_table": "core_party", "to_columns": ["party_id"], "inferred": false}
]}
```

* One entry per FOREIGN KEY constraint; `from_columns[i]` references `to_columns[i]`.
  Partition copies of a constraint (`scm.sales_20xx`) are folded into the parent's.
* An edge is listed only when both tables are in the caller's `GET /schema` and every
  named column is too. Measured 2026-11-07: 74 edges for an `aivb` student, 14 for `scm`.

### `GET /schema/game`

Session required. The `jelly_analytics` schema of the game database, which students query
with psql / Power BI on port 5433, not through this console. Only relations the class role
`candy_reader` may SELECT are listed; the game's `public` schema is never read.

```json
{"ok": true, "schema_name": "jelly_analytics",
 "tables": [{"name": "sessions", "kind": "table",
             "columns": [{"name": "session_id", "type": "VARCHAR", "nullable": false, "primary_key": true}]}],
 "relationships": [{"from_table": "sessions", "from_columns": ["user_id"],
                    "to_table": "users", "to_columns": ["user_id"], "inferred": true}]}
```

* `jelly_analytics` declares no FOREIGN KEY, so its edges are **inferred**: a column named
  `X` points at the other table whose single-column primary key is also `X`. Every such edge
  carries `"inferred": true`; the UI must say so. A declared FK turns inference off.
* `503 E_GAME_UNAVAILABLE` when the game is not enabled or its database cannot be reached.
  Cached for 10 minutes per backend process.

---

## 6. `GET /schema/tables/{table_name}`

Query parameter: `include_row_count` (boolean, default `false`).

`200`:

```json
{
  "name": "core_party",
  "row_count": 6400,
  "columns": [
    { "name": "party_id",   "type": "VARCHAR",   "nullable": false, "primary_key": true },
    { "name": "valid_to",   "type": "DATE",      "nullable": true,  "primary_key": false },
    { "name": "created_at", "type": "TIMESTAMP", "nullable": false, "primary_key": false }
  ],
  "ok": true
}
```

`row_count` is `null` unless `include_row_count=true`.

`ok` is last in the serialised body — key order is not significant in JSON; do not rely on it.
Note the difference from §5: the table objects **inside** `/schema` have no `ok`, because
they are nested objects rather than responses. Same three fields otherwise, so a renderer
written for one works for the other.

`404` — note this is the **same** response for a typo and for a restricted table:

```json
{ "ok": false, "error_code": "E_UNKNOWN_TABLE",
  "message": "Table 'meta_dirty_log' does not exist or is not available in this dataset." }
```

---

## 7. `POST /query`

### Request

```json
{ "sql": "SELECT party_id FROM core_party LIMIT 5", "max_rows": 200 }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `sql` | string | yes | Exactly one read-only `SELECT` (a leading `WITH` is fine). |
| `max_rows` | integer ≥ 1 | no | Clamped to the server's `max_rows`. Cannot raise it. |

A malformed body (missing `sql`, wrong type, `max_rows` ≤ 0) returns FastAPI's standard
`422` validation error, which does **not** use the `error_code` envelope. Treat `422` as
"the request itself was invalid" and show a generic message.

### `200` response

```json
{
  "ok": true,
  "columns": ["party_id", "valid_from", "created_at", "n", "f"],
  "column_types": ["VARCHAR", "DATE", "TIMESTAMP", "BIGINT", "DECIMAL(2,1)"],
  "rows": [
    ["SYN_PTY_P000001", "2023-01-01", "2023-01-01T00:00:00", 1, "1.5"]
  ],
  "row_count": 1,
  "truncated": false,
  "row_limit": 1000,
  "elapsed_ms": 0.71,
  "tables_used": ["core_party"],
  "executed_sql": "SELECT party_id, ... FROM \"main\".\"core_party\" LIMIT 2"
}
```

| Field | Meaning |
|---|---|
| `columns` / `column_types` | Parallel arrays, same length as each row. `column_types` are native DuckDB types. |
| `rows` | Array of arrays, **positional**, aligned with `columns`. |
| `row_count` | `rows.length`. |
| `truncated` | `true` if the result was cut off by `row_limit` **or** by the response size budget. Show a "results truncated" banner. |
| `row_limit` | The cap actually applied to this request. |
| `elapsed_ms` | Server-side execution time, excluding validation and transport. |
| `tables_used` | Physical tables the query touched, sorted. Empty for `SELECT 1`. Useful for a "tables used" hint. |
| `executed_sql` | The normalised SQL the server actually ran. Comments are stripped and table names are rewritten to `"main"."<table>"`. Handy for a "what ran" panel; not intended for round-tripping back into the editor. |

### JSON value encoding

| DuckDB type | JSON |
|---|---|
| `VARCHAR` | string |
| `BOOLEAN` | boolean |
| integers | number |
| `DOUBLE`/`FLOAT` | number (`NaN`/`Infinity` become `null`) |
| `DECIMAL` | **string** — preserves exact VND amounts; parse with a decimal library, not `Number()` |
| `DATE` | `"2023-01-01"` |
| `TIMESTAMP` | `"2023-01-01T00:00:00"` |
| `TIME` | `"00:00:00"` |
| `INTERVAL` | string |
| `BLOB` | base64 string |
| `LIST`/`STRUCT`/`MAP` | JSON array / object |
| `NULL` | `null` |

---

## 8. Error codes

| `error_code` | HTTP | When | Suggested UI |
|---|---|---|---|
| `E_EMPTY_SQL` | 400 | Blank input or comments only. | Inline hint. |
| `E_SQL_TOO_LONG` | 400 | Over `AIVB_MAX_SQL_CHARS`. | Inline hint. |
| `E_INVALID_INPUT` | 400 | Control characters in the SQL. | Inline hint. |
| `E_PARSE` | 400 | Not valid SQL. `message` carries the parser's position. | Show in the editor gutter. |
| `E_MULTI_STATEMENT` | 400 | More than one statement. | Inline hint. |
| `E_NOT_SELECT` | 400 | DDL/DML/admin statement. | Inline hint. |
| `E_UNKNOWN_TABLE` | 400 | Table not in the student dataset. | Link to the table list. |
| `E_RESERVED_CTE_NAME` | 400 | A CTE was named after a dataset table. | Suggest renaming the CTE. |
| `E_UNSUPPORTED_FUNCTION` | 400 | Filesystem / catalog / admin function. | Inline hint. |
| `E_UNSUPPORTED_SYNTAX` | 400 | A construct the guard does not allow. Also `SELECT *` over a MIXED table **on a stale export** — see §10. | Inline hint; the message names the table and tells the student to list columns. |
| `E_TOO_COMPLEX` | 400 | Complexity limits exceeded (see §10). | Ask the student to simplify. |
| `E_QUERY_FAILED` | 400 | Valid & permitted, but the column does not exist for this session — either a typo or a column the contract withholds. The two are **indistinguishable by design**; both carry DuckDB's own `Binder Error: Referenced column "x" not found in FROM clause!`. Also covers other engine rejections (out of memory, conversion errors). | Show `message`. |
| `E_TIMEOUT` | 408 | Exceeded `query_timeout_s`. | Suggest `WHERE` / `LIMIT`. |
| `E_SERVICE_BUSY` | 503 | The service is saturated: all query slots busy **and** the wait queue is full, or the request waited longer than `AIVB_ADMISSION_WAIT_S`. | "Try again in a moment", offer retry. |
| `E_DB_UNAVAILABLE` | 503 | Dataset not loaded. | Maintenance banner. |
| `E_INTERNAL` | 500 | Unexpected. | Generic error. |

### Authentication codes (new in 1.3.0)

| `error_code` | HTTP | When | Suggested UI |
|---|---|---|---|
| `E_UNAUTHORIZED` | 401 | No session cookie, or it is unknown, tampered with, revoked or expired. **All five are the same response on purpose** — do not try to tell them apart. | Redirect to the sign-in screen; discard local state. |
| `E_BAD_CREDENTIALS` | 401 | Wrong username **or** wrong password **or** disabled account — one indistinguishable response. | "Incorrect username or password." Never say which. |
| `E_CSRF` | 403 | A POST arrived without `X-AIVB-Client`. | A bug in the client. Do not show a login screen for this. |
| `E_PASSWORD_CHANGE_REQUIRED` | 403 | The session is valid but the account still has its issued password. | Show the change-password screen. `/auth/me`, `/auth/password` and `/auth/logout` still work. |
| `E_FORBIDDEN` | 403 | Authenticated, but the endpoint is not available to this role (e.g. a student calling `/audit/recent`). | Do not render instructor-only UI for students in the first place. |
| `E_WEAK_PASSWORD` | 400 | The proposed new password was refused. `message` says why. | Inline hint under the field. |
| `E_RATE_LIMITED` | 429 | Login lockout in force. Carries a `Retry-After` header (seconds). | Countdown; disable the submit button. |
| `E_AUTH_UNAVAILABLE` | 503 | The credential store could not be opened. | Maintenance banner. |

This table is **exhaustive and closed**. A code not listed here is a backend bug; report it
rather than adding a UI branch for it. (`api/tests/test_contract_conformance.py` asserts the
server can emit nothing outside this set.)

### Codes that deliberately do not exist

**`E_ROW_LIMIT`** appears in some earlier task descriptions. It is **not** part of this API and
never was. Hitting the row cap is not an error: the query ran, and the rows you got back are
real. The server answers `200` with `truncated: true` and `row_limit` set to the cap that was
applied (§7), which is strictly more useful than an error — an error would throw away a result
the student can already learn from, and would make a `SELECT` over a large table feel broken.
The same `truncated: true` also covers the response-size budget, so the UI needs exactly one
"results were cut off" path rather than two.

---

## 9. Rules the frontend MUST follow

1. **Never hardcode a table or column list.** Every name shown in the UI — sidebar,
   autocomplete, table picker — must come from `GET /schema` or `GET /schema/tables` at
   runtime. The API is the single source of truth for who may see what.
2. **Never connect to a DuckDB file directly**, and never ship one to the browser.
3. **Do not "helpfully" list tables the API did not return**, and do not add names from the
   parameter book, the ERD, or any design document to autocomplete.
4. **Do not reinterpret `E_UNKNOWN_TABLE`.** Do not add a hint like "this table is restricted"
   or "instructor only" — that would reintroduce, in the UI, exactly the existence oracle the
   backend removes. A restricted table and a typo are indistinguishable by design; keep it
   that way.
5. Show `truncated: true` clearly, so students do not mistake a capped result for a complete
   one. This is the *only* signal for a capped result — do not wait for an error code (§8).
6. Assume `AIVB_CORS_ORIGINS` will be set to the exact origin the UI is served from. Local
   development works with it unset (loopback-only default), but the origin must match
   **character for character** in production — see §12.
7. **Send `credentials: 'include'` on every request.** Without it the browser will not attach
   the session cookie and everything answers `401`. A wildcard CORS origin is incompatible
   with cookies — the server disables credentials in that mode and logs a `SECURITY:` line.
8. **Send `X-AIVB-Client: web` on every POST**, including `/auth/login` and `/auth/logout`.
   Missing → `403 E_CSRF`.
9. **Never store the session token yourself.** It is `HttpOnly`; `document.cookie` cannot
   read it and must not try. Do not copy it into `localStorage`, a URL, or a log line.
10. **Treat `401` as "session over"**: clear cached schema and results, then show the sign-in
    screen. It can arrive on *any* call, at any time — the account may have been disabled or
    the 12-hour absolute cap may have been reached mid-session.
11. **Handle `403 E_PASSWORD_CHANGE_REQUIRED` as a screen, not an error toast.** A first-login
    account can call `/auth/me`, `/auth/password` and `/auth/logout`, and nothing else.
12. **Never send the password anywhere but `/auth/login` and `/auth/password`**, and never put
    it in a query string. Do not offer "remember my password" in local storage.
13. **Do not build an instructor UI into the student bundle.** Read the role from `/auth/me`
    and render accordingly — but treat that as cosmetic. The server decides; the UI only
    reflects what the server already enforced.

---

## 10. Guarantees, and their limits

### What the backend enforces

| Layer | Mechanism |
|---|---|
| LA | **Authentication.** Every data endpoint requires a live server-side session. The cookie carries a 32-byte random token; only its SHA-256 is stored, so a dump of the credential store yields nothing replayable. Passwords are `scrypt(N=2¹⁵, r=8, p=1)` over a fresh 16-byte salt. |
| LR | **Role routing.** The session's role selects the *file*: `STUDENT → student.duckdb`, `INSTRUCTOR → instructor.duckdb`. Two `Database` objects, two DuckDB connections, built at startup. There is no request-controlled expression that turns one into the other. |
| L0 | Connects to the server-side student projection, which physically contains only the 77 tables with a STUDENT part **and, within them, only the 405 STUDENT columns**. Verified: 0 instructor tables and 0 withheld columns present. The database file is never delivered to students. |
| L1 | `duckdb.connect(read_only=True)` with `enable_external_access=false`, extension autoload/autoinstall off, `memory_limit`, and `lock_configuration=true` so no query can undo it. |
| L2 | The SQL guard: `sqlglot` parse → single-statement check → `SELECT`-root check → AST node-type allowlist → table-name allowlist → **column-name denylist** → `SELECT *` expansion check → function policy → **re-render from the validated AST**. The bytes DuckDB receives are generated from approved nodes only; the student's raw text is never executed. |
| L3 | Response hygiene: identical `E_UNKNOWN_TABLE` text for restricted and non-existent tables; identical `E_QUERY_FAILED` Binder-Error text for withheld and misspelled columns; DuckDB catalog errors suppressed (their "did you mean …?" hints would enumerate hidden relations); any engine message mentioning a withheld table name is replaced. |

The table allowlist is "has at least one STUDENT column in the column contract"
**intersected with** the tables that physically exist. Note that `hist_customer_segment` and
`organization_financial_snapshot` are STUDENT tables that do *not* match the
`raw_/ref_/core_/bridge_/fact_/mart_` prefixes given in the design docs — the guard matches
explicit names from the contract, never prefixes.

#### Column level (new in 1.4.0)

Two independent checks, both derived from the same contract:

1. **Name denylist.** Any `dirty_flag` reference — qualified, quoted, upper-cased, in a CTE,
   in a subquery, in `ORDER BY`, in a window `PARTITION BY` — is refused. Matching is on the
   bare column name rather than on `(table, column)`, because resolving an unqualified column
   to its table needs full scope analysis and getting that subtly wrong is exactly how
   column filters leak. It can only ever over-block, and a test asserts that no
   student-visible column anywhere in the contract shares a name with a withheld one, so the
   over-block set is currently empty.
2. **Star expansion.** `SELECT *` and `alias.*` are checked against the sources of their own
   `SELECT`. This fires **only** when the connected file still physically carries the
   withheld column, i.e. on a stale or misconfigured export — the server also logs a
   `SECURITY:` line at startup in that case. On a correctly built `student.duckdb` the column
   does not exist, the set is empty, and `SELECT * FROM raw_account_transaction` behaves
   exactly as students expect. `count(*)` is never affected: stars nested inside a function
   project no columns.

**The load-bearing layer is still L0.** L2 exists so that a stale export or a misconfigured
`AIVB_DB_PATH` behaves like a correct one instead of handing over the answer key.

### Deliberate restrictions (report these as expected, not as bugs)

* `DESCRIBE`, `SUMMARIZE`, `SHOW`, `PRAGMA`, `EXPLAIN`, `PREPARE`/`EXECUTE` are all refused.
  They are statement types, not `SELECT`s, and `SUMMARIZE meta_dirty_log` would be a leak
  path. Use `GET /schema/tables/{name}` for column metadata instead.
* Table-valued functions are refused except `range`, `generate_series` and `unnest`.
* A CTE may not be named after any contract table or owner-declared object alias (e.g. `WITH core_party AS …`),
  because CTE shadowing would otherwise create an ambiguity the guard would have to resolve
  the same way DuckDB does. Renaming the CTE is always sufficient.
* `?` and `$1` placeholders are refused; there are no bind parameters.

### Complexity limits (`E_TOO_COMPLEX`)

Enforced on the token stream *before* parsing: max 4000 tokens, max 32 `JOIN`s, max 10
**consecutive `ON`-less `JOIN`s**, max parenthesis depth 64, max 64 `SELECT`s.

The consecutive-join limit is not arbitrary. `sqlglot.parse` is exponential on that shape:
measured on sqlglot 30.14, cost doubles per additional join (15 → 0.13 s, 20 → 3.9 s,
25 → 126 s) while the AST stays tiny. Roughly 200 bytes of SQL could therefore burn minutes
of CPU *inside the guard*, where no database timeout can reach it. This was found during
testing and is now closed; at the limit of 10 the worst case is about 4 ms.

### Honest limitations

1. **Timeouts are cooperative.** `cursor.interrupt()` relies on DuckDB checking for
   interruption. Every heavy query tested was cancelled within the budget, but a future
   DuckDB operator that does not poll could overrun it. Admission control
   (`AIVB_MAX_CONCURRENT_QUERIES`) bounds the damage to N cores.
2. **`sqlglot` is a third-party parser.** The re-render step means a parser bug leads to a
   *refusal or a syntax error*, not silent extra privilege — but this is a defense-in-depth
   argument, not a proof. L0 remains the load-bearing layer.
3. **Views are inspected only at startup.** If an allowlisted view were defined over an
   instructor table, it is dropped from the allowlist and logged as `SECURITY:` at startup.
   A view created *after* startup would not be noticed — but the connection is read-only and
   the current `student.duckdb` contains no views at all.
4. **CTE-name rejection is a weak existence oracle** limited to contract names and aliases
   in the parameter book. It reveals nothing that the course materials do not already state,
   and on `student.duckdb` the instructor tables are absent anyway.
7. **The `SELECT *` refusal is itself a weak signal** that the named table has hidden columns.
   It only ever appears on a stale export, it never names the column, and the alternative
   (silently rewriting the star into a column list) would be a rewrite that could be got
   wrong. Treat the message as an operator alarm: rebuild the export and it disappears.
8. **Column matching is by name, not by `(table, column)`.** See §10 above. If a future delta
   ever withholds a column name that another table uses legitimately, that legitimate column
   becomes unusable until the guard is given proper scope resolution. There is a test that
   fails the moment the contract introduces such a name.
5. **No authentication or per-student rate limiting.** Add both at the deployment layer;
   §12 is the checklist and §12.3 sets out the options and their trade-offs. CORS is *not*
   a substitute: it restrains browsers on other pages, not `curl`.
6. **The response size cap drops trailing rows** rather than refusing the query, and flags
   `truncated: true`. Very wide rows may therefore return far fewer rows than `row_limit`.

---

## 11. Verification status

**1175 passing, 2 skipped** (1048 before 1.4.0 + 114 column-visibility tests + 10 `/health`
role tests + 3 contract-shape tests), against the full 90.2M-row, 9.1 GB build. Reproduce:

```bash
source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh && conda activate aivbank
cd /Users/nguyennp/AI/Finance
python api/tests/build_fixtures.py \
    _workspace/instructor_DO_NOT_SHIP/instructor.duckdb   # hostile fixture
python -m pytest api/tests -q
python api/tests/verify_real_release.py     # 39 passed / 0 failed / 1 pending, real builds
```

The **2 skips are the only outstanding item** and they are upstream, not here: the shipped
`_workspace/release/student/student.duckdb` still predates delta P1 (`ref_industry` and
`ref_segment` are not in it), so the tests that pin the current release shape refuse to
assert against a stale artefact instead of silently blessing 84. `verify_real_release.py`
reports the same thing as `PENDING`. Everything else — including all column-level enforcement
— runs against real data today. The post-rebuild path was proven by pointing
`AIVB_REAL_STUDENT_DB` at a database built to the new contract: **1177 passed, 0 skipped**.

Both the auth tests and the column tests carry a **positive control**: the same query a
STUDENT session is refused must SUCCEED for an INSTRUCTOR session, on the same server and the
same file. Without it, "the student got an error" would be indistinguishable from a broken
endpoint or a missing table/column. Measured on the real builds:

| | STUDENT | INSTRUCTOR |
|---|---|---|
| `SELECT * FROM meta_dirty_log` | `400 E_UNKNOWN_TABLE` | `200`, 5 real answer-key rows |
| `SELECT count(*) … WHERE dirty_flag` | `400 E_QUERY_FAILED` | `200`, **577,509** rows |
| `/schema/tables/raw_account_transaction` | 5 columns | 6 columns |
| `/health` `table_count` | 84 *(stale build; 86 after rebuild)* | 96 *(98 after rebuild)* |

The main suite runs against a **hostile fixture** in which every instructor table is
physically present carrying the **real grading answer key** — 958,625 `meta_scenario_label`
rows and 589,877 `meta_dirty_log` rows copied out of the instructor build — and in which
`raw_account_transaction` still carries `dirty_flag`, stratified so the 3,000-row sample holds
1,500 flagged and 1,500 unflagged rows. Defense layer 0 is switched off there on purpose, so
the guard is measured on its own; both roles are pointed at that same file, so "student
blocked / instructor allowed" cannot be an artefact of two different datasets. Tests assert on
*content*: 260 canary values read straight from the answer key must never appear in any
response body, error message or schema listing.

The fixture builder now **conforms the fixture to the column contract** after copying —
creating contract tables the source build lacks and adding contract columns it lacks — so a
source database that predates a delta can no longer make the whole suite quietly test
yesterday's schema.

> This matters because the earlier "tables are unreachable" result was weaker than it looked:
> those tables were **empty** at the time, and a blocked query and an empty table return the
> same thing. That ambiguity is now gone.

Attack result on the real answer key — **265 blocked, 0 leaked**:

| Surface | Blocked |
|---|---|
| Core corpus (direct, lexical, qualified, structural, DDL/DML, functions, parser abuse) | 160/160 |
| **Column corpus** — `dirty_flag` via 26 routes (qualified, quoted, case-shifted, `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, window `PARTITION BY`, `QUALIFY`, CTE, subquery, `EXISTS`, join, union, `SELECT *`, `alias.*`, `* EXCLUDE`, comment-smuggled), at the guard **and** over HTTP | 26/26 guard + 26/26 HTTP |
| `read_parquet` / `parquet_scan` / string-path / glob at the real answer-key parquet files | 29/29 |
| `ATTACH` of the real `instructor_DO_NOT_SHIP/instructor.duckdb` | 13/13 |
| Engine layer with the guard **bypassed entirely** (L1 on its own) | 11/11 |

**Positive control on all 26 column routes: 26/26 SUCCEED for an INSTRUCTOR session** on that
same file, and the flagged rows they return join to `meta_dirty_log`. The refusals are the
permission layer, not an absent column.

**37/37 legitimate queries still execute** — no over-blocking. Plus: a student can still read
all five remaining `raw_account_transaction` columns, and all three new delta P1 tables.

### `dirty_flag`: the leak that was escalated, and is now closed

**Status: CLOSED by the mentor's ruling of 2026-08-04 (answer 3).** What follows is the record
of why, kept because the numbers are what justified the escalation.

`raw_account_transaction.dirty_flag` used to be marked **STUDENT**, so the service was
required to serve it. Measured against the real 9.1 GB build, it was an *exact* oracle for the
answer key:

* `WHERE dirty_flag` returned **577,509 of 7,449,253** rows — **100.00 % recall and 100.00 %
  precision** against the distinct `raw_row_id` set in `meta_dirty_log` (0 false positives,
  0 false negatives).
* Throttling did not help. Paging all 577,509 rows at `max_rows=1000` is 578 requests and
  **87 s** end to end — and nobody needed to page: one `SELECT count(*) … WHERE dirty_flag`
  already answered the graded question.

The mentor moved the column to INSTRUCTOR. The API now:

* strips it from the STUDENT catalog (`/schema`, `/schema/tables/{name}` show 5 columns);
* refuses any STUDENT query naming it, with a message identical to a misspelled column;
* refuses `SELECT *` over that table **while** the connected file still contains the column,
  and logs a startup `SECURITY:` line naming the stale file;
* **stops watching it** — `AIVB_AUDIT_COLUMNS` defaults to empty, because enforcement
  replaced detection and watching a refused column is noise.

Verified against the real builds (`api/tests/verify_real_release.py`), on a
`student.duckdb` that **still physically contains** the column:

| Check | Result |
|---|---|
| STUDENT `/schema/tables/raw_account_transaction` | 5 columns, `dirty_flag` absent |
| STUDENT queries naming it (5 shapes incl. `SELECT *` inside a subquery) | 5/5 refused |
| STUDENT reading the 5 remaining columns | 200, 5 rows |
| INSTRUCTOR `SELECT count(*) … WHERE dirty_flag` (**positive control**) | 200, **577,509** rows |
| INSTRUCTOR join to `meta_dirty_log` on those rows | 200, **589,877** matched |

The positive control is not optional. Without it, "the student got an error" is
indistinguishable from a broken endpoint, and the whole result would be worthless.

#### What is still reachable, and why that is acceptable

With `dirty_flag` gone, the only answer-key-adjacent columns a student still has are
`amount_text` and `date_text`. Measured on the same build:

```sql
WHERE TRY_CAST(amount_text AS DOUBLE) IS NULL OR TRY_CAST(date_text AS DATE) IS NULL
```

returns **514,405** rows, every one of them in `meta_dirty_log` — **100 % precision, 89.07 %
recall** of the 577,509-row key. The gap is the rules that leave no parse failure behind:
`DQ.DUP_RETRY` (36,891), `DQ.LATE_ARRIVE` (29,644), `DQ.TZ_SHIFT` (1,257),
`DQ.LATE_REVERSAL` (102).

That residue is **the exercise itself** — finding malformed values in a raw staging table is
the data-quality lesson — so it is neither blocked nor watched. `AIVB_AUDIT_COLUMNS` is left
empty rather than pointed at these two columns precisely because they would fire on every
legitimate query and bury the signal. Nothing is lost by that: every query is already recorded
in full in the audit log and readable through `GET /audit/recent`.
`python api/tests/ops_bench.py extract` re-measures the precision/recall figures above on
demand.

### Cost of the authentication layer (measured, 1.3.0)

| Measurement | Result |
|---|---|
| Authenticated `POST /query` (`SELECT 1`), warm session | p50 **1.03 ms**, p95 1.33 ms |
| 30 students signing in *and* querying simultaneously | **30/30 succeed**, 269 ms wall, slowest 96 ms |
| One password verification (scrypt N=2¹⁵) | ~65 ms — deliberate, and the reason login is rate-limited |
| Session check per request | one indexed SQLite lookup + one `last_seen_at` update |

Session validation touches SQLite on every request. At 30 concurrent clients that is not
measurable next to query time; if this is ever fronted by hundreds of concurrent users, that
write is the first thing to profile.

### Measured behaviour on 9.1 GB

Peak process RSS, one fresh process per cell, at the enforced concurrency of 4:

| Workload | Latency | Peak RSS |
|---|---|---|
| Typical `GROUP BY` on `core_gl_entry` (24.9M rows) | 0.2 s | 150 MB |
| `ORDER BY` over 24.9M rows | 0.3 s | 260 MB |
| DQ-predicate page at `OFFSET 300000` (was `dirty_flag`) | 0.2 s | 340 MB |
| Worst case: `GROUP BY` with 24.9M **distinct** keys | 5.4 s | 3.2 GB |

Two findings that correct earlier estimates:

1. **`memory_limit` is process-wide, not per request.** DuckDB reports it with scope
   `GLOBAL`, and the API holds a single `duckdb.connect()`; per-request `con.cursor()` calls
   only add a client context to the same instance, sharing one buffer pool. Measured on the
   worst-case query at `memory_limit=2GB`: 1 concurrent → 2.46 GB RSS, 4 → 3.09 GB,
   16 → 3.58 GB. Memory is essentially **flat in concurrency**; an estimate of
   "10 students ≈ 12 GB" assumes per-connection budgets that do not exist here.
2. **Sort-shaped queries are cheap because of the `LIMIT` wrapper.** The guard executes
   `SELECT * FROM (…) LIMIT n+1`, which DuckDB turns into a Top-N. Benchmarking the raw
   student text instead overstates memory for every `ORDER BY` by an order of magnitude.

Rule of thumb: **peak RSS ≈ 0.8 GB + 1.2 × `AIVB_MEMORY_LIMIT`**, roughly independent of how
many students are querying. The default `2GB` → ~3.3 GB peak, comfortable on a 8 GB host.

---

## 12. Before you deploy this for real

Everything below is an **operator** decision, not a code change. The service is safe to run
on a laptop as shipped; the steps here are what turns that into something you can put in
front of a class over a network.

### 12.1 Checklist

Work top to bottom. Each step has a command that either passes or fails — do not accept
"looks right".

- [ ] **1. Point at the student export, and prove it is the student one.**

      export AIVB_DB_PATH=/abs/path/to/student.duckdb
      python -c "import duckdb,os;c=duckdb.connect(os.environ['AIVB_DB_PATH'],read_only=True);\
      print(sorted(r[0] for r in c.execute(\"select table_name from information_schema.tables\").fetchall() \
      if r[0].startswith(('meta_','cfg_'))))"

      Must print `[]`. Anything else means you are about to serve the grading answer key —
      stop, and go back to `aivbank-generator-engineer`. This is defense layer 0 and it is
      the only one that cannot be argued around.

- [ ] **2. Set `AIVB_CORS_ORIGINS` to the exact UI origin.**

      export AIVB_CORS_ORIGINS=https://sql.aivbank.example.edu

      Scheme + host + port, **no trailing slash, no path**. `http://localhost:5173` and
      `http://127.0.0.1:5173` are *different origins* to a browser — list both if both are
      used. Never ship `*`. The startup log prints the policy it resolved; read it.

- [ ] **3. Confirm the policy from outside.** With the server up:

      curl -s -o /dev/null -D- -H 'Origin: https://sql.aivbank.example.edu' http://HOST:8000/health | grep -i access-control
      curl -s -o /dev/null -D- -H 'Origin: https://evil.example.com'        http://HOST:8000/health | grep -i access-control

      First must echo your origin; second must print **nothing**.

- [ ] **4. Create the accounts, and capture the one-time passwords.**

      python -m backend.admin_cli import-csv --file class_2026a.csv --role STUDENT
      python -m backend.admin_cli create-user --username gv_lan --role INSTRUCTOR
      python -m backend.admin_cli list

      Each password is printed **once** and cannot be recovered — copy them as the
      command runs. A lost one is a `reset-password`, not a lookup.

      There is no credential file to misplace any more: passwords live in `pg_authid`,
      and the app holds no copy. What *can* still leak is the audit log, which records
      every query verbatim alongside who ran it:

      find _workspace/release -name 'audit.jsonl'   # must print nothing

      Check it even though `.gitignore` blocks the name everywhere, because the mistake
      that matters is copying it there *later*, when someone zips the release.

- [ ] **5. Terminate TLS** at the proxy **and set `AIVB_COOKIE_SECURE=1`.** Without it the
      session cookie is sent over plain HTTP. The startup log prints a `SECURITY:` warning
      whenever this is not set — a clean production start has no such line.

      export AIVB_COOKIE_SECURE=1

- [ ] **6. Bind to loopback and let the proxy reach it.**
      `uvicorn --host 127.0.0.1` (**not** `0.0.0.0`) once a proxy is in front.

- [ ] **7. Add a rate limit at the proxy.** Suggested start: ~30 requests/minute per client
      for `POST /query`. `AIVB_MAX_CONCURRENT_QUERIES` protects the *server*, not any
      individual student's fair share of it.

- [ ] **8. Size the limits for the class.** `AIVB_MAX_CONCURRENT_QUERIES` × `AIVB_DUCKDB_THREADS`
      should not exceed the box's cores; `AIVB_MEMORY_LIMIT` × concurrency should fit in RAM.

- [ ] **9. Check the startup log for `SECURITY:` lines.** The server emits them for a wildcard
      CORS policy, for `AIVB_COOKIE_SECURE` being off, and for any allowlisted view found to
      be defined over an instructor table (§10). A clean production start prints none.

- [ ] **10. Decide where the instructor dataset lives.** If instructors need the answer key
      through this UI, set `AIVB_INSTRUCTOR_DB_PATH`; if not, leave it unset and they get the
      student dataset. **Never point `AIVB_DB_PATH` at the instructor file.**

- [ ] **11. Re-run the suite against the database you are actually shipping.**

      python api/tests/build_fixtures.py && python -m pytest api/tests -q
      python api/tests/verify_real_release.py

      1051 passed, including the 160-attack corpus and the 65 auth tests; then 25/25 on the
      real 9.1 GB student + 9.2 GB instructor builds.

### 12.2 Quick sanity probe after go-live

```bash
# 1. unauthenticated -> 401, and no hint about what is behind it
curl -s -X POST https://HOST/query -H 'Content-Type: application/json' \
  -H 'X-AIVB-Client: web' -d '{"sql":"SELECT 1"}'
# {"ok":false,"error_code":"E_UNAUTHORIZED","message":"Authentication required. Sign in and try again."}

# 2. POST without the CSRF header -> 403, even with a valid cookie
curl -s -X POST https://HOST/query -H 'Content-Type: application/json' \
  -b cookies.txt -d '{"sql":"SELECT 1"}'
# {"ok":false,"error_code":"E_CSRF", ...}

# 3. signed in as a student, the answer key is still not there
curl -s -c cookies.txt -X POST https://HOST/auth/login -H 'Content-Type: application/json' \
  -H 'X-AIVB-Client: web' -d '{"username":"sv001","password":"..."}'
curl -s -b cookies.txt -X POST https://HOST/query -H 'Content-Type: application/json' \
  -H 'X-AIVB-Client: web' -d '{"sql":"SELECT * FROM meta_dirty_log"}'
```

The last call must return, verbatim:

```json
{"ok":false,"error_code":"E_UNKNOWN_TABLE",
 "message":"Table 'meta_dirty_log' does not exist or is not available in this dataset. Call GET /schema/tables for the list of tables you can query."}
```

`400` here, `404` for the same table via `GET /schema/tables/{name}` (§6) — different
endpoints, same neutral wording. If it returns rows, or any message that distinguishes
"restricted" from "not found", stop the service and escalate: that is an existence oracle
and it is exactly what §10 L3 exists to prevent.

### 12.3 Authentication — what was built, and why this shape

The previous version of this document argued for a reverse proxy in front of an
unauthenticated service. The project owner has since confirmed that **eDA has no existing
sign-in system**, which removes option A (reuse the institution's SSO) and leaves a shared
token — which I argued against then and still would. So the service now authenticates people
itself. Decisions worth knowing about:

* **scrypt, not SHA-256, not argon2id.** `hashlib.scrypt(N=2¹⁵, r=8, p=1)` costs 32 MiB and
  ~65 ms per attempt on the dev box, which makes an offline crack of a leaked store expensive
  and an online guess slow. It is in the standard library, so the credential path adds **no
  new dependency** — worth something on a service whose whole job is not to leak. argon2id is
  a better primitive, but `argon2-cffi` is a C extension that would have to be pinned, built
  and trusted on whatever box this lands on; scrypt at these parameters is not the weak link
  here. If the security review disagrees, the stored `pw_algo` / `pw_params` columns exist so
  a second algorithm can be added and rows migrated on next login.
* **Server-side sessions, not JWTs.** A JWT cannot be revoked before it expires. Here, the
  instructor disabling an account or resetting a password kills every live session on the
  next request, which is what "a student is caught mid-exam" actually needs.
* **There is no credential store to protect.** Passwords live in PostgreSQL's `pg_authid`,
  and `verify_password` authenticates by opening a connection *as that role* — connecting is
  the check. The app never reads `pg_authid.rolpassword`, so breaching the web tier yields no
  verifier to crack offline, and there is no file that can be copied into a student-facing
  directory by mistake. One person = one PostgreSQL role, shared by the console and Power BI,
  which is also the only way the two lanes can stay in sync.
* **The role selects the server-side database file.** `STUDENT → physical projection` (77 tables / 405 columns),
  `INSTRUCTOR → internal dataset` (100 / 611). Not a filter over one connection — a filter is one
  bug away from being bypassed, whereas the student connection has no handle on the
  instructor file at all. The one place a *filter* was unavoidable is the MIXED table's
  `dirty_flag` column, and even there the primary control is that the build step does not put
  it in the student file (L0); the guard is the backstop.
* **Lockout is per-username *and* per-IP, with different thresholds** (5 vs 20). A single
  threshold on IP would let one student's typo lock out a whole NAT'd classroom; no IP
  counter at all would leave a username sweep from one host unbounded.
* **`X-Forwarded-For` is deliberately ignored** when identifying a client. It is
  attacker-controlled unless a trusted proxy overwrites it, and it feeds the lockout
  counters — trusting it would let anyone reset their own throttle by inventing an address
  per attempt. Behind a real proxy, run uvicorn with `--proxy-headers --forwarded-allow-ips`
  so `request.client.host` is correct at the transport layer instead.

#### Known limits — read these before signing off

1. **No MFA, and no password-reset self-service.** A forgotten password means the instructor
   runs `reset-password`. For a cohort-scale teaching tool that is the right trade; for
   anything larger it is not.
2. **The lockout counters live in the `aivb_app` database.** Two API processes pointed at the
   same cluster share them correctly, but pointing them at *different* clusters would give an
   attacker N× the attempts. Run one `aivb_app`.
3. **`AIVB_COOKIE_SECURE` defaults to off** so local http development works. That default is
   wrong for production and is warned about at every start; step 5 of the checklist is not
   optional.
4. **A shared browser profile is a shared session.** `HttpOnly` stops script access, not the
   next person to sit down at the machine. The 8 h idle timeout is the only mitigation.
5. **`dirty_flag` is closed** as of 1.4.0 (§11) — the mentor moved it to INSTRUCTOR and the
   API now refuses it. What remains is `amount_text` / `date_text`, which recover 89.07 % of
   the answer key at 100 % precision; that is the data-quality exercise and is deliberately
   left open. Authentication still makes every query *attributable* through the audit log.
6. **Duplicate `Cookie` headers: the last value wins**, which is Starlette's parsing, not a
   decision made here. Exploiting it requires already being able to write a cookie into the
   victim's browser for this host (an XSS, or control of a sibling subdomain) — at which
   point that is the incident. `__Host-` prefixing under TLS closes the subdomain half.
7. **No per-account query rate limit.** `AIVB_MAX_CONCURRENT_QUERIES` protects the server as
   a whole; one authenticated student can still monopolise their share. Now that requests
   carry an identity, a per-user limit is finally *possible* — it is checklist step 7 (at the
   proxy) until someone asks for it in the app.
8. **The audit log grows without bound and is not rotated.** ~250 bytes per query. Point
   `AIVB_AUDIT_LOG_PATH` at a location covered by logrotate for a long-running deployment.

---

## 13. Authentication endpoints

### 13.1 `POST /auth/login`

Headers: `Content-Type: application/json`, `X-AIVB-Client: web`. Send with
`credentials: 'include'` so the browser stores the returned cookie.

```json
{ "username": "sv001", "password": "..." }
```

`200`:

```json
{
  "ok": true,
  "username": "sv001",
  "role": "STUDENT",
  "must_change_password": false,
  "expires_at": 1785866213.08,
  "idle_timeout_s": 28800.0,
  "absolute_timeout_s": 43200.0
}
```

plus `Set-Cookie: aivb_session=…; HttpOnly; SameSite=strict; Path=/; Max-Age=43200`
(`; Secure` when `AIVB_COOKIE_SECURE=1`).

Two things about that cookie the frontend does **not** need to handle, but should know:

* Under `AIVB_COOKIE_SECURE=1` the cookie is renamed `__Host-aivb_session`. The `__Host-`
  prefix makes the browser refuse it unless it is `Secure`, `Path=/` and carries no `Domain`,
  which stops a page on a sibling subdomain from overwriting it. The browser handles the name;
  JavaScript never sees it either way (it is `HttpOnly`).
* The CSRF header is checked for **presence**, not for a particular value: any non-empty
  string up to 64 characters passes. The security property comes from the fact that a
  cross-site `<form>` cannot set a custom header at all, and a cross-site `fetch` that does
  triggers a preflight our CORS policy refuses — not from the string. Send `web`; a future
  non-browser client can send its own name without a server change.

| Status | Code | Meaning |
|---|---|---|
| `401` | `E_BAD_CREDENTIALS` | Wrong username, wrong password, or disabled account — **one response for all three**, in the same amount of time. |
| `403` | `E_CSRF` | `X-AIVB-Client` missing. |
| `429` | `E_RATE_LIMITED` | Locked out. `Retry-After` header carries the seconds. |

If `must_change_password` is `true`, go straight to the change-password screen: every data
endpoint will answer `403 E_PASSWORD_CHANGE_REQUIRED` until it is done.

### 13.2 `POST /auth/logout`

Headers: `X-AIVB-Client: web`. Body: `{}`. Always `200`, even without a session:

```json
{ "ok": true, "message": "Signed out." }
```

The session is revoked **server-side** and the cookie is cleared. A token captured earlier
stops working immediately.

### 13.3 `GET /auth/me`

Same body as `/auth/login`'s `200`. Answers `401` when there is no live session — this is the
call to make on page load to decide between the app and the sign-in screen. It keeps working
while a password change is pending.

### 13.4 `POST /auth/password`

Headers: `X-AIVB-Client: web`. Requires a session (also works when
`must_change_password` is set).

```json
{ "current_password": "...", "new_password": "..." }
```

`200`:

```json
{ "ok": true, "message": "Password updated.", "sessions_revoked": 2 }
```

Rules: at least 12 characters, different from the current one, not the username, and not
containing an obvious pattern (`password`, `123456789`, `qwerty`, `aivbank`, `letmein`).
Violations are `400 E_WEAK_PASSWORD` with the reason in `message`.

On success **every session for that account is revoked and a fresh cookie is issued to the
caller** — the browser that made the change stays signed in, all others are logged out.

### 13.5 `GET /audit/recent?limit=100`

**INSTRUCTOR only** (`403 E_FORBIDDEN` otherwise). Returns the tail of the audit log,
oldest first:

```json
{
  "ok": true,
  "count": 2,
  "entries": [
    {"ts": "2026-08-04T05:48:26.160+00:00", "event": "login_ok", "username": "sv001",
     "role": "STUDENT", "ip": "127.0.0.1", "session_id": "ce21dd10d85f"},
    {"ts": "2026-08-04T05:48:27.002+00:00", "event": "query", "username": "sv001",
     "role": "STUDENT", "session_id": "ce21dd10d85f", "ip": "127.0.0.1",
     "sql": "SELECT count(*) FROM core_party", "row_count": 1, "elapsed_ms": 0.44,
     "blocked": false, "tables": ["core_party"], "total_ms": 1.9}
  ]
}
```

Events: `login_ok`, `login_failed`, `login_locked`, `logout`, `password_changed`,
`password_change_failed`, `query`. A blocked query carries `"blocked": true` with
`error_code` and `reason`. Passwords and session tokens are never written — `session_id` is
a truncated SHA-256 of the token, not the token.

### 13.6 Account administration (CLI, no HTTP surface)

There is **no registration endpoint**. Accounts are created on the server:

```bash
python -m backend.admin_cli create-user --username sv001 --role STUDENT
python -m backend.admin_cli import-csv   --file class_2026a.csv --role STUDENT   # username,full_name[,role]
python -m backend.admin_cli reset-password --username sv001    # new password + kills sessions
python -m backend.admin_cli disable --username sv001           # blocks + kills sessions
python -m backend.admin_cli enable  --username sv001
python -m backend.admin_cli list
python -m backend.admin_cli sessions --purge
```

Initial and reset passwords are random and **printed exactly once**; they are not stored in
plaintext and cannot be recovered. Every account created this way must change its password
at first sign-in.

## 13. Practice rewards and Instructor Console

Successful guarded queries may include a `gamification` object in the `POST /query` response. Reward persistence is server-side and failure-safe: a reward-store failure never changes a successful query into an API error.

### `GET /gamification/me`

Requires an active session. Returns the current user's stars, diamonds, streak, daily query count and achievements.

### `GET /gamification/leaderboard?period=day|week|month`

Requires an active session. Returns a bounded leaderboard for the selected period. Usernames are returned as the account identifiers already visible to the authenticated practice environment.

### `GET /admin/analytics/queries`

Requires an `INSTRUCTOR` session. Returns aggregated query count, successful/blocked counts, active users, average execution time, top errors, top tables and a bounded recent audit sample. It never changes student data visibility.
