# AIV Bank — bản đồ code base

> Sinh từ một lần đọc toàn bộ dự án (2026-08-19), đối chiếu với knowledge graph ở
> `graphify-out/` (1.258 node · 2.338 cạnh · 90 community).
>
> Tài liệu này trả lời **"cái gì nằm ở đâu"**; `ARCHITECTURE.md` trả lời **"vì sao"**;
> `backend/API_CONTRACT.md` là hợp đồng ràng buộc giữa hai tầng.
>
> **Đọc mục 8 trước khi tin bất kỳ con số nào trong ba file trên** — có 12 điểm code đã
> lệch khỏi tài liệu.

---

## 1. Bản đồ 30 giây

**AIV Bank** là nền tảng dạy SQL: học viên đăng nhập vào một console web, gõ `SELECT`, và
chạy nó trên bản sao PostgreSQL của một bộ dữ liệu ngân hàng mô phỏng. Toàn bộ thiết kế
xoay quanh **một ràng buộc duy nhất**: bộ dữ liệu chứa các bảng đáp án chấm bài, và học
viên **không được biết chúng tồn tại**.

```
                     ┌─────────────────────────────────────────────┐
   Học viên (web) ──▶ │ FastAPI    ──▶  guard.py  ──▶  psycopg3    │ ──▶ PostgreSQL 18
                     │ backend/main.py  sqlglot       backend/db.py│     aivb_student    (77 bảng)
                     └─────────────────────────────────────────────┘     aivb_instructor (100 bảng)
                                                                                ▲
   Học viên (BI: Excel · Power BI · Tableau) ────────────────────────────────────┘
                              ĐI VÒNG QUA GUARD — với họ, biên an ninh là
                              role + GRANT của PostgreSQL, không phải guard.py
```

Dữ liệu chảy **một chiều** (`ARCHITECTURE.md` §1) — PostgreSQL luôn là **bản sao**, không
bao giờ là bản gốc:

```
DuckDB ──build──▶ validate ──▶ seal ──▶ parquet/dump ──▶ PostgreSQL ──┬─▶ FastAPI /query
                                                                      └─▶ Excel · Power BI
```

Nhà máy sinh dữ liệu (`generator/`, `qa/`, `_workspace/`) **không nằm trong thư mục này**
và `backend/` không import gì từ chúng — đó là thứ làm thư mục này chuyển máy được.

| Con số | Giá trị |
|---|---|
| Backend | FastAPI · 15 module Python · ~4.400 dòng |
| Frontend | 12 module ES thuần · không build step · CodeMirror 5.65.16 vendor sẵn |
| Test | 15 file `test_*.py` + 7 harness, chạy trên database **cố ý thù địch** |
| Endpoint | 15 route (13 frontend đang dùng, 1 dead code, 1 chưa dùng) |
| Cấu hình | 48 biến `AIVB_*` |
| Dữ liệu | 2 database vật lý · 2 file dump ~2,1 GB |

---

## 2. Ranh giới bảo mật — bốn tầng

Đọc từ ngoài vào; **tầng càng sâu càng ít người đi qua**.

### Tầng 0 — Hai database *vật lý*, không phải phân quyền

`aivb_student` (77 bảng) và `aivb_instructor` (100 bảng) là hai database riêng biệt. Bảng
và cột giảng viên **không tồn tại** trong database học viên.

Cách "đúng kiểu PostgreSQL" — một database + `GRANT`/`REVOKE` cấp cột — đã bị **bác bỏ có
chủ ý** (`ARCHITECTURE.md` §2; lý do đầy đủ ở cuối `database/schema/03_schema_grants.sql`):

1. **Tạo ra oracle dò sự tồn tại.** Cột bị từ chối trả `42501`, cột không tồn tại trả
   `42703`. Hai mã khác nhau = học viên hỏi được "cột này có thật không".
2. **Phá `SELECT *`** — câu lệnh cơ bản nhất trong bài giảng.

Kết quả: học viên gõ `SELECT * FROM aivb.meta_dirty_log` nhận đúng thông báo "không có
bảng", giống hệt khi gõ sai tên.

### Tầng 1 — GRANT ở tầng database

`database/schema/01_roles.sql` tạo owner `aivb_owner` (NOLOGIN), các bundle reader
(NOLOGIN), và **role đăng nhập tách riêng cho API và cho BI**.
`03_schema_grants.sql` chỉ cấp `GRANT SELECT` **cấp bảng** — không bao giờ cấp cột — cộng
`ALTER DEFAULT PRIVILEGES`, và có một assertion collation bằng hành vi
(`IF ('a' < 'B') THEN RAISE`).

> ⚠️ **Điều quan trọng nhất khi sửa bảo mật:** `default_transaction_read_only` **không phải**
> biện pháp bảo mật — client nào cũng tắt được. Chỉ việc **không cấp**
> INSERT/UPDATE/DELETE/DDL mới thật sự ép chỉ-đọc.
> `backend/tests/test_pg_engine_defenses.py` chứng minh cả hai vế.

Người dùng BI chỉ đi qua tầng 0 và 1. **Mọi biện pháp chỉ tồn tại trong `guard.py` đều
không bảo vệ họ.** Muốn một hạn chế áp cho tất cả, nó phải nằm ở tầng database.

### Tầng 2 — `backend/guard.py` (874 dòng)

Chặn ở tầng ứng dụng cho người dùng web. Chi tiết ở mục 3.

### Tầng 3 — Catalog cấp cột

`backend/catalog.py` giao cắt `contract/column-contract.json` (`student_visibility` từng
cột) với cấu trúc bảng **thật sự tồn tại** lấy từ `information_schema`. Guard hỏi catalog
cho từng bảng và từng cột — trong graph, `validate()` → `Catalog` là một cạnh `references`
trực tiếp.

### Ba cơ chế chống rò rỉ chạy xuyên suốt

| Cơ chế | Nơi cài đặt |
|---|---|
| Thông báo lỗi **giống hệt nhau** cho "gõ sai tên" và "không được phép thấy" | `main.py:825` (`/schema/tables/{name}`), `guard.py:428` (`_check_table`) |
| Sanitize lỗi engine — chỉ đọc `diag.message_primary`, chỉ với SQLSTATE trong allowlist; **không bao giờ** `str(exc)` (lộ `LINE 1:` kèm SQL đã bọc), **không bao giờ** `HINT` (tự khai tên cột thật) | `db.py:487` `_sanitize_engine_error`, allowlist `db.py:462-484` |
| Đăng nhập sai: **một câu duy nhất** cho cả sai-tài-khoản lẫn sai-mật-khẩu, và `verify_password` **luôn** chạy đúng một dẫn xuất scrypt kể cả với user không tồn tại (dummy salt) | `main.py:488`, `authstore.py:414` + `authstore.py:63` |

---

## 3. Đường đi của một câu SQL

`POST /query` → `backend/main.py:857-981`. Tám bước, mỗi bước có thể từ chối:

| # | Bước | Vị trí | Từ chối bằng |
|---|---|---|---|
| 1 | Kẹp `row_limit` về `settings.max_rows` | `main.py:868-870` | — (kẹp im lặng) |
| 2 | **Admission slot** — hàng đợi có trần + semaphore + thời gian chờ có trần; bao cả CPU của guard | `db.py:246` `Database.slot()` | `503 E_SERVICE_BUSY` |
| 3 | **Guard** — xem sơ đồ dưới | `guard.py:769` `validate()` | `400` + mã riêng từng loại |
| 4 | Ghi log watch-list cột (mặc định tắt; response **byte-identical**) | `main.py:912-921` | — |
| 5 | **Execute** — `statement_timeout` per-statement, watchdog `threading.Timer` ở `timeout+2s`, `fetchmany(row_limit+1)` để phát hiện cắt bớt **trung thực** | `db.py:278` | `408` |
| 6 | Map ngoại lệ | `main.py:926-952` | `GuardRejection`→400 · `ServiceBusy`→503 · `QueryTimeout`→408 · `QueryFailed`→400 `E_QUERY_FAILED` · `RecursionError`→400 `E_TOO_COMPLEX` · còn lại→500 `E_INTERNAL` |
| 7 | Ghi audit, rồi gamification — **bọc riêng** để lỗi thưởng không bao giờ biến truy vấn thành công thành lỗi | `main.py:962-966` | — |
| 8 | `_jsonable` (Decimal→str, giữ nguyên số nguyên VND) + `_fit_response` (co về `max_response_bytes`) | `main.py:391`, `main.py:414` | — |

### Bên trong guard (bước 3)

```
sql
 ├─ rỗng / quá dài / chứa NUL                                    → từ chối
 ├─ _check_complexity trên TOKEN STREAM                guard.py:302
 │    trần token · trần join · trần join liên tiếp không ON (chống parse mũ)
 │    · trần độ sâu ngoặc · trần số SELECT
 ├─ sqlglot.parse(dialect="postgres", error_level=RAISE)  guard.py:68, :795
 │    nhiều câu → E_MULTI_STATEMENT      gốc không phải SELECT → E_NOT_SELECT
 ├─ _walk                                              guard.py:660
 │    alias CTE không được trùng tên bảng thật
 │    exp.Table  → _check_table    guard.py:428  ── và REWRITE về "aivb"."tên"  :494
 │    exp.Func   → _check_function guard.py:715  ── allowlist ~159 tên
 │    exp.Column → _check_column   guard.py:521  ── chặn ctid/xmin/xmax/cmin/cmax/tableoid
 │    mọi node khác phải nằm trong ALLOWED_NODES        guard.py:134
 ├─ _check_stars                                       guard.py:617
 │    chỉ từ chối SELECT * trên bảng CÒN mang cột bị giấu về mặt vật lý
 └─ xoá hết comment, RE-RENDER SQL từ AST đã kiểm       guard.py:842
    rồi bọc:  SELECT * FROM ( <inner> ) AS _aivb_student_query LIMIT row_limit+1   :858
```

**Chi tiết đáng nể nhất:** `_assert_star_scope_resolution_works()` (`guard.py:591`, gọi ở
`:614`) là self-test chạy lúc **import module** — nếu sqlglot đổi tên `from_` trong một bản
nâng cấp, module crash ngay thay vì để `_check_stars` âm thầm trở thành no-op.

**Đảo ngược logic đáng chú ý:** `PgFunctionPolicy.from_connection` (`pg_function_policy.py:154`)
đọc `pg_proc` **chỉ để thẩm định** danh sách allowlist viết tay, và **từ chối khởi động**
nếu một tên trong list không tồn tại, thuộc họ bị cấm, hoặc nếu list vượt quá ¼ tổng số hàm
của engine — bẫy chống việc ai đó "tiện tay" regenerate allowlist từ `pg_proc` và biến nó
thành fail-open (`pg_function_policy.py:189-194`).

---

## 4. Bản đồ backend

`app = FastAPI(...)` là **singleton cấp module** (`main.py:225`), không có factory. Mọi
wiring xảy ra lúc import + trong `lifespan`.

| Module | Dòng | Vai trò |
|---|---|---|
| `main.py` | 988 | Lifespan, CORS, security headers, **toàn bộ route** (không có APIRouter), JSON coercion, co response |
| `config.py` | 637 | `Settings` frozen dataclass đọc thẳng `os.environ`; resolver CORS; `assert_auth_store_isolated`; conninfo + session settings của PG. Singleton ở dòng 637 |
| `db.py` | 528 | Tầng PostgreSQL: `ConnectionPool` theo role, `slot()`, `execute()`, sanitize lỗi engine, quét view rò rỉ |
| `guard.py` | 874 | SQL guard (mục 3) |
| `catalog.py` | 368 | Catalog quyền: giao cắt column-contract với bảng có thật; visibility từng cột |
| `auth.py` | 196 | Keo HTTP: `ApiError`, `Principal`, set/clear cookie, kiểm CSRF header, `client_ip` |
| `authstore.py` | 685 | Kho credential + session + throttle trên SQLite; scrypt; `verify_password` hằng-công |
| `audit.py` | 124 | Log JSONL chỉ-ghi-thêm, có scrub trường credential; `tail()` cho endpoint giảng viên |
| `gamification.py` | 238 | SQLite thưởng luyện tập: sao / kim cương / streak / thành tựu / bảng xếp hạng |
| `models.py` | 161 | Pydantic v2 — hợp đồng API dưới dạng code |
| `pgtypes.py` | 114 | OID PostgreSQL → tên kiểu **theo phong cách DuckDB** (cố ý, `pgtypes.py:1-23`) |
| `pg_function_policy.py` | 207 | Nạp + thẩm định allowlist hàm (`pg_functions_allowed.txt`, 219 dòng) |
| `release_contract.py` | 119 | Adapter trên `owner-config.json` + `release-manifest.json` |
| `admin_cli.py` | 260 | `python -m backend.admin_cli` — tạo / import / reset / khoá user. **Cố ý không có đăng ký qua HTTP** |
| `__init__.py` | — | Chỉ docstring + `__version__` |

Đồ thị import là **DAG sạch**:

```
main    ──▶ auth · authstore · config · db · guard · gamification · audit · models
db      ──▶ pgtypes · catalog · config · pg_function_policy
guard   ──▶ catalog · pg_function_policy
catalog ──▶ release_contract
```

Không module nào import từ `generator/` hay `qa/` — xác nhận tuyên bố ở `ARCHITECTURE.md:18`.

### Khởi động (`main.py:148-223`)

1. `_size_request_threadpool()` (`main.py:121`) — nâng trần thread của anyio lên trên
   `max_concurrent_queries + max_queued_queries + 8`, vì **mọi endpoint đều là `def` đồng bộ**.
2. `assert_auth_store_isolated(...)` **hai lần** (auth + gamification) — **từ chối boot** nếu
   SQLite credential nằm trong thư mục học viên với tới được (`config.py:74`).
3. Dựng `AuthStore`, `AuditLog`, `GamificationStore`.
4. Mở `Database(role=STUDENT)` và, nếu có `AIVB_PG_DB_INSTRUCTOR`, thêm instructor.
   **Lỗi DB lúc khởi động không fatal** — ghi vào `_state["error"]`, endpoint trả
   `503 E_DB_UNAVAILABLE`.

State toàn cục là một `dict` thường `_state` (`main.py:111-118`), không phải `app.state`.

### Tầng dữ liệu

Không có ORM. SQL thô, luôn tham số hoá. `db.py:162` dùng `set_config(%s,%s,false)` chứ
không nội suy chuỗi vào `SET`. Chỗ duy nhất nội suy định danh là `db.py:240-242`
(`SELECT count(*) FROM "schema"."table"`) và nó bị chặn bởi `is_allowed()` ngay dòng trên.

**Hardening từng connection** (`db.py:150-183`): áp `pg_session_settings()` (`config.py:570` —
`search_path=aivb`, `default_transaction_read_only=on`, `statement_timeout`, `lock_timeout=2s`,
`work_mem`, `TimeZone=UTC`, `jit=off`) rồi **đọc ngược lại để xác nhận**. `lc_messages` và
`temp_file_limit` ở mức SUSET chỉ được *kiểm tra* (`config.py:595`); lệch là
`SessionSettingError` → **từ chối connection**.

**Định tuyến role** là **tra bảng, không phải suy luận**: `settings.pg_conninfo(role)`
(`config.py:514`) raise với role lạ. `db_for_role` (`main.py:330`) rơi về database học viên
nếu instructor chưa cấu hình — **ít quyền hơn, không bao giờ nhiều hơn**.

**Quét view rò rỉ** (`db.py:332-378`): đi qua `pg_rewrite`/`pg_depend` và thu hồi mọi view
trong allowlist mà lại phụ thuộc vào một quan hệ bị hạn chế.

**Không có framework migration.** Cấp phát là ba script psql idempotent trong
`database/schema/`. Nạp dữ liệu là `database/restore.py` (`dump` / `restore` / `verify`) bọc
`pg_dump` / `pg_restore` / `psql` thật.

**Hợp đồng nghiệm thu** (`restore.py:41-53`) — chạy **trước** khi backend khởi động, thiếu
một mục là dừng: student 77 bảng, instructor 100, `meta_dirty_log` + `meta_scenario_label`
**phải vắng mặt** ở student, canary `ref_branch` = 12 dòng, và collation kiểm bằng **hành vi**
(`SELECT 'a' < 'B'`) chứ không bằng metadata — vì **parity check dựa trên md5 hoàn toàn mù
với collation** và sẽ báo PASS trên một database sai (`ARCHITECTURE.md` §4).

### Xác thực & phiên

| Khía cạnh | Cài đặt |
|---|---|
| User | Bảng SQLite `users` (`authstore.py:197-210`) + dataclass `User` (`:72`). Role ∈ {STUDENT, INSTRUCTOR}. Không tự đăng ký |
| Mật khẩu | scrypt N=2^15, r=8, p=1, dklen=32, salt 16 byte mới mỗi lần (`authstore.py:52-56`, `:153`) |
| Chống đo thời gian | `verify_password` (`:414`) chạy đúng một dẫn xuất trên **mọi** nhánh kể cả user không tồn tại; `hmac.compare_digest` cả ở nhánh giả |
| Session | Token `secrets.token_urlsafe(32)`; **chỉ SHA-256 được lưu** (`:503`). `validate_session` (`:551`) đọc lại `role`/`disabled`/`must_change_password` **mỗi request** → khoá tài khoản có hiệu lực tức thì |
| Hết hạn | Idle 8h (`AIVB_SESSION_IDLE_S`) + tuyệt đối 12h (`AIVB_SESSION_ABSOLUTE_S`), tự thu hồi |
| Cookie | HttpOnly · `SameSite=Strict` · `Path=/` · `Secure` theo config · tiền tố `__Host-` khi bật TLS (`auth.py:158`, `config.py:492`) |
| CSRF | Header `X-AIVB-Client` bắt buộc trên mọi POST, kiểm **trước** khi xác thực (`auth.py:134`) để không dùng được làm oracle phiên |
| Throttle | Đếm riêng theo username và theo IP, backoff mũ (`authstore.py:100-127`); ngưỡng IP cố ý lỏng hơn cho phòng lab dùng chung NAT |
| IP | `client_ip` **cố ý bỏ qua `X-Forwarded-For`** (`auth.py:91`) |
| Bắt đổi mật khẩu | `require_active_session` (`main.py:352`) chặn tất cả trừ `/auth/me`, `/auth/password`, `/auth/logout` bằng `403 E_PASSWORD_CHANGE_REQUIRED` |

### ⚠️ Không có bộ chấm bài tự động trong backend này

Không có model bài tập / bài nộp, không so sánh đáp án, không endpoint chấm điểm. "Đáp án"
ở đây là **dữ liệu** — hai bảng chỉ-giảng-viên `meta_dirty_log` và `meta_scenario_label` —
và toàn bộ backend được xây để làm chúng **không với tới được**, chứ không phải để chấm dựa
trên chúng. Việc kiểm đáp án tự động nằm ngoài cây thư mục này (`qa/verify_pg_parity.py`,
được nhắc ở `README.md:62` nhưng không ship kèm).

### Bộ test

15 file `test_*.py` + 7 harness (`attacks.py`, `conftest.py`, `live_client.py`,
`build_fixtures.py`, `build_pg_fixtures.py`, `ops_bench.py`, `ops_conc.py`, `ops_http.py`,
`verify_real_release.py`). Không có `pytest.ini`/`pyproject.toml`; `conftest.py:30-31` chèn
`APP_ROOT` vào `sys.path`.

**Thiết kế then chốt:** fixture trỏ vào một database **cố ý thù địch** (`aivb_test_hostile`)
*có chứa* đáp án và cột bị giấu — nghĩa là guard được đo với **tầng phòng thủ 0 tắt hẳn**
(`conftest.py:1-17`). Test **skip** thay vì fail khi không có PostgreSQL (`conftest.py:135`).

`test_auth.py` (1.252 dòng) chạy **uvicorn thật trên socket thật** qua `live_client.py` —
không dùng `TestClient`, không dùng httpx.

---

## 5. Bản đồ frontend

**Không có bước build.** Không `package.json`, không bundler, không `node_modules`. Một
`index.html` tĩnh, **không** template server-side. Hai phụ thuộc runtime, cả hai vendor
sẵn: CodeMirror 5.65.16 và DuckDB-WASM 1.32.0 (33 MB, chỉ tải khi mở khu vực sandbox).

Giao diện chia **ba khu vực** ở thanh ngay dưới thanh trên cùng: **Finance Banking** và
**Supply Chain** dùng chung console qua backend; **Thực hành SQL** chạy hẳn trong trình
duyệt trên file học viên tự tải lên, không chạm máy chủ dòng nào.

Hai đường phục vụ:

| Đường | Nơi | Ghi chú |
|---|---|---|
| Thật | `main.py:988` — `app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True))` | Route API đi trước rồi rơi xuống static. **Một origin theo cấu trúc** |
| Lab / dev | `frontend/serve.py` | `SimpleHTTPRequestHandler` + **reverse proxy trong suốt**, mặc định `127.0.0.1:5173` → `:8000`. Prefix proxy ở `serve.py:42-50`. Gửi `Cache-Control: no-store` cho mọi thứ (`:78-84`). `--no-proxy` = tĩnh thuần, và đăng nhập sẽ hỏng **theo thiết kế** |

Một origin là **điều kiện bắt buộc**, không phải tiện nghi: phiên là cookie HttpOnly và mọi
request dùng `credentials:'same-origin'` (`api.js:156`). Proxy **không quyết định gì cả** —
nó chuyển tiếp nguyên văn method, path, body, header lên trên và status, body, `Set-Cookie`
xuống dưới. Nếu bạn thấy mình đang thêm một câu `if` về *ai được xem gì* vào `serve.py` thì
đó chính là lỗi.

### Thứ tự bootstrap (`index.html:308-318`)

1. 7 thẻ `<script>` CodeMirror vendor (classic) → định nghĩa global `CodeMirror`
2. `<script src="config.js">` (classic) → đặt `window.AIVB_CONFIG`
3. `<script type="module" src="app.js">` → **điểm vào ES module duy nhất**

**Thiết kế fail-closed:** `<body class="is-gated">` và lớp che `#auth-gate` nằm **sẵn trong
HTML thô**; `#app` mang thuộc tính `hidden`. Nếu `app.js` không tải được, thứ người dùng
thấy là form đăng nhập — **không bao giờ** là console (`index.html:19-27,134`).

### Các module

| File | Dòng | Vai trò | Export |
|---|---|---|---|
| `config.js` | 47 | Cấu hình triển khai (file duy nhất thường phải sửa) | Global `window.AIVB_CONFIG` |
| `app.js` | 635 | Điểm vào, nối mọi thứ: tab, health pill, vòng chạy query, drawer mobile, dashboard | Không export — chỉ side-effect, kết bằng `gate.boot()` |
| `api.js` | 314 | HTTP client mỏng: dựng URL, cookie + header CSRF, chuẩn hoá lỗi, parse BIGINT chính xác, hook 401 toàn cục | `api`, `setUnauthorizedHandler`, `isExact`, `parseJsonExact`, `apiBase`, `apiOrigin`, `isCrossOrigin` |
| `auth.js` | 255 | Mô hình phiên + chính sách câu chữ khi đăng nhập hỏng | `login`, `logout`, `fetchSession`, `changePassword`, `loginErrorText`, `checkPasswordRules`, … |
| `authgate.js` | 384 | Lớp che đăng nhập / đổi mật khẩu; sở hữu câu hỏi "console đã dùng được chưa" | `createAuthGate(...)` |
| `editor.js` | 210 | CodeMirror 5 + autocomplete lấy nguồn **duy nhất** từ schema API | `createEditor`, `insertAtCursor` |
| `schema.js` | 208 | Thanh bên khám phá bảng/cột, lọc, đếm dòng lười | `createSchemaPanel(...)` → `{load, clear, ref}` |
| `results.js` | 240 | Lưới kết quả, băng cắt bớt, sao chép CSV, tab chi tiết | `createResultsPanel(...)` |
| `mart.js` | 180 | Trình duyệt data mart theo vai trò | `createMartPanel(...)` |
| `history.js` | 130 | Lịch sử truy vấn trong **sessionStorage**; xoá khoá localStorage cũ | `createHistoryPanel(...)` |
| `format.js` | 132 | Giá trị JSON → chữ hiển thị; số chính xác; CSV | `formatCell`, `toCsv`, `groupNumericText`, `shortType`, … |
| `errors.js` | 67 | `error_code` → gợi ý tiếng Việt | `errorHint`, `isRetryable`, `isClientCode` |
| `sandbox.js` | 300 | **Khu vực "Thực hành SQL"** — DuckDB-WASM chạy trong trình duyệt; nạp lười, không import `api.js` | `createSandbox`, `tableNameFor`, `RENDER_LIMIT`, `DOWNLOAD_LIMIT` |

`frontend/impeccable-stop-hook.mjs` **không phải code ứng dụng** — nó là adapter Stop-hook
cho agent, không liên quan đến web app.

Đồ thị import (`app.js:10-18`):

```
app.js   ──▶ api · errors · editor · schema · results · mart · history · authgate · auth
authgate ──▶ auth          auth   ──▶ api          schema ──▶ api · errors
mart     ──▶ api · format  results ─▶ format       format ──▶ api (chỉ isExact)
errors, config — không import gì
```

**Không có store, không có event bus** — chỉ callback chéo giữa các factory:
`api.setUnauthorizedHandler(...)` cài một lần (`app.js:553`) định tuyến 401 /
`E_PASSWORD_CHANGE_REQUIRED` về gate; `schemaPanel.ref` là một getter sống
(`schema.js:200-206`) truyền vào `createEditor` để autocomplete luôn thấy schema hiện tại.

**Quản lý state: không framework.** Closure + module scope. Đáng chú ý là `sessionEpoch`
(`app.js:70`) — bộ đếm đơn điệu dùng để **vứt bỏ kết quả async cũ** sau khi đăng nhập lại.
`wipeSessionState()` (`app.js:490-518`) xoá sạch khi đăng xuất hoặc khi **người khác** đăng
nhập; hết phiên với **cùng một người** thì cố ý **giữ nguyên câu SQL đang gõ**.

**Lưu trữ:** duy nhất `sessionStorage['aivbank.sql.history.v1']`. Schema, kết quả và mật khẩu
**không bao giờ** được lưu. `sessionStorage` chứ không `localStorage` vì máy phòng lab dùng
chung — `localStorage` sẽ trao bài của người trước cho người sau chỉ bằng thao tác mở trang.

**Không có router.** Một trang, một URL. Điều hướng duy nhất là `location.replace()` khi
đăng xuất (`app.js:602`), chọn thế để nút Back không khôi phục được console còn dữ liệu của
người trước. "Routing" thật sự là 5 ARIA tab (`result`, `mart`, `history`, `detail`,
`progress`) qua `selectTab()` (`app.js:167-179`) — không phản ánh vào URL, không lưu lại.

### CodeMirror

Bản **5.65.16**, vendor sẵn (`frontend/vendor/codemirror/lib/codemirror.js:9880`). Không CDN
— phòng máy có thể mất mạng, và một CDN là thêm một bên thứ ba chạy script trên trang học
viên đang gõ mật khẩu. Chỉ chép 9 file cần dùng + LICENSE.

Khởi tạo từ `<textarea id="sql">` ở `editor.js:28-48`: `mode: 'text/x-sql'`, `lineNumbers`,
`lineWrapping`, `matchBrackets`, `autoCloseBrackets`, `styleActiveLine`. Phím tắt
(`editor.js:38-47`): `Ctrl/Cmd-Enter` → chạy · `Ctrl-Space` → gợi ý · `Shift-Tab` → lùi lề ·
`Tab` → thụt lề hoặc chèn hai dấu cách.

Autocomplete (`editor.js:57-201`) tự hiện khi gõ ≥2 ký tự hoặc ngay sau dấu `.`;
`completeSingle:false` để Enter không bao giờ bị cướp. `referencedTables()` (`:95-116`) quét
regex `FROM|JOIN <bảng> [AS] <alias>` và map alias → bảng, **chỉ với tên có trong schema API**.
Xếp hạng: cột của bảng đã tham chiếu → mọi bảng → từ khoá SQL (chỉ ngữ pháp, không tên schema),
trần 60 mục. `alias.` với qualifier lạ trả `null` — **không gợi ý gì** thay vì đoán.

**Gotcha đã xử lý hai lần:** CodeMirror đo được 0px khi dựng bên trong `#app` đang `hidden`,
nên `cm.refresh()` được gọi sau đăng nhập (`app.js:579,589`) và khi thoát fullscreen (`:212`).

### Năm ràng buộc bắt buộc khi sửa frontend

Từ `frontend/README.md` §4 và `API_CONTRACT.md` §9. Đây là **ràng buộc, không phải khuyến
nghị** — backend đã dựa vào chúng:

1. **Không hardcode tên bảng hay tên cột.** Mọi tên hiển thị sinh lúc chạy từ `GET /schema`.
   Hardcode làm `frontend/` trở thành nguồn sự thật thứ hai về việc học viên được thấy gì.
2. **Không diễn giải lại `E_UNKNOWN_TABLE`.** Server cố ý trả **cùng một thông điệp** cho tên
   gõ sai và bảng không được phép thấy. Đừng thêm "bảng này bị hạn chế", đừng tô màu khác đi.
3. **Không dùng lịch sử truy vấn làm nguồn gợi ý.** Một tên bảng học viên gõ mò sẽ được giao
   diện gợi ý lại như thể nó có thật — đúng kiểu rò rỉ mà quy tắc 2 đang chặn.
4. **Không bao giờ lưu mật khẩu ở client.** Ô nhập bị **xoá ngay trước khi gửi request**,
   không phải trong `finally` (`authgate.js:142`, `:234`). Đây là **lỗi thật đã bị bắt khi
   nghiệm thu**: `finally` chỉ chạy sau khi `onSession()` tải xong health + toàn bộ schema,
   tức mật khẩu dạng chữ nằm lại trong một `<input>` đang hiển thị suốt vài giây.
   **Giữ nguyên thứ tự: xoá ô nhập trước, gọi mạng sau.**
5. **Đừng đoán trạng thái đăng nhập ở client.** Cookie là HttpOnly nên `document.cookie` không
   thấy nó. Nguồn sự thật duy nhất là `GET /auth/me` và mã HTTP của các request sau đó.

Cộng thêm: **không làm tròn số tiền** — tiền là số nguyên VND, và
`backend/tests/test_pgtypes.py` giữ hai bên khỏi trôi khỏi nhau.

### CSS

Bốn stylesheet, **thứ tự nạp có ý nghĩa** (`index.html:12-17`): `codemirror.css` →
`show-hint.css` → `tokens.css` → `styles.css`.

- **`tokens.css` (286 dòng)** — tầng design token, **file DUY NHẤT** được phép chứa giá trị
  màu / khoảng cách / bo góc / đổ bóng / font viết cứng. Màu chính `--brand-600 = #3D562A`
  lấy từ chính chữ "DA" trong logo eDA (8,19:1 trên nền trắng); thang `--brand-50 … --brand-900`
  giữ nguyên H và S, chỉ đổi độ sáng. Có hợp đồng tiếp cận **bằng số**: ≥4,5:1 cho chữ
  thường, ≥3:1 cho chữ ≥18px / biểu tượng / vòng focus; `--ink-faint` chỉ đạt 3,59:1 nên
  **chỉ được dùng cho hình trang trí**. Có cả tier theo chiều cao viewport (`max-height: 800px`
  ở dòng 245, `640px` ở dòng 275).
- **`styles.css` (1614 dòng)** — chỉ trình bày, chỉ dùng `var(--…)`, **không literal nào**.
  Chia section có banner: LOGIN GATE (100) · TOP BAR (324) · BANNERS (511) · LAYOUT (555) ·
  WORKSPACE + override CodeMirror (830/960) · TABS (1020) · RESULT GRID (1102) ·
  RESPONSIVE (1474) · MOBILE DRAWER (1548).

Ba quy tắc bắt buộc: mọi cặp chữ/nền đạt ngưỡng tương phản; **huy hiệu GIẢNG VIÊN phải dùng
`--warning`, không bao giờ xanh thương hiệu** (xanh là hình ảnh của phiên học viên, giảng
viên nhầm phiên là hỏng cơ chế chấm điểm); chỉ dùng font có sẵn trong hệ thống.

Phiên giảng viên được báo bằng **ba** dấu hiệu cùng lúc (`app.js:520-543`): huy hiệu đỏ sẫm,
thanh trên đổi màu, và một dải chữ trắng nền đỏ chạy ngang trang.

---

## 6. Hợp đồng API

Mọi request đi qua đúng một hàm `request()` (`api.js:132-218`). Cross-origin non-GET bị **từ
chối trước khi gọi `fetch()`** với `E_CLIENT_CROSS_ORIGIN` (`api.js:136-141`).
`X-AIVB-Client: web` gắn vào mọi request không phải GET/HEAD (`api.js:22-23,147`).

| # | Method | URL | Backend | Frontend gọi từ |
|---|---|---|---|---|
| 1 | GET | `/health` | `main.py:457` | `app.js:285` |
| 2 | GET | `/auth/me` | `main.py:601` | `auth.js:81`, `app.js:627` (bfcache `pageshow`) |
| 3 | POST | `/auth/login` | `main.py:488` | `auth.js:89` ← `authgate.js:147` |
| 4 | POST | `/auth/logout` | `main.py:568` | `auth.js:96` ← `authgate.js:356` |
| 5 | POST | `/auth/password` | `main.py:615` | `auth.js:104` ← `authgate.js:238` |
| 6 | GET | `/schema` | `main.py:746` | `schema.js:34` |
| 7 | GET | `/schema/tables` | `main.py:734` | **⚠️ DEAD CODE — `api.tables()` (`api.js:279`) không có nơi gọi** |
| 8 | GET | `/schema/tables/{name}` | `main.py:825` | `schema.js:171` (đếm dòng lười, lỗi nuốt im lặng) |
| 9 | GET | `/schema/marts` | `main.py:772` | `mart.js:36` |
| 10 | GET | `/schema/marts/{name}` | `main.py:794` | `mart.js:77` (404 trừ khi tên bắt đầu bằng `mart_`) |
| 11 | POST | `/query` | `main.py:857` | `app.js:430` (SQL học viên, có `AbortSignal`), `mart.js:86` |
| 12 | GET | `/gamification/me` | `main.py:696` | `app.js:74` |
| 13 | GET | `/gamification/leaderboard` | `main.py:700` | `app.js:74` |
| 14 | GET | `/admin/analytics/queries` | `main.py:706` | `app.js:127` (chỉ giảng viên) |
| 15 | GET | `/audit/recent` | `main.py:687` | **⚠️ có ở server, frontend chưa dùng, `serve.py` chưa proxy `/audit`** |

Dependency: `require_session` (`main.py:344`) · `require_active_session` (`:352`) ·
`require_instructor` (`:371`) · `csrf_guard` (`:384`).

Lỗi được `api.js` chuẩn hoá về một shape duy nhất:
`{ok:false, error_code, message, http_status, retry_after_s, client}`. Mã chỉ-ở-client:
`E_CLIENT_CROSS_ORIGIN`, `E_CLIENT_NETWORK`, `E_CLIENT_ABORTED`, `E_CLIENT_BAD_REQUEST`,
`E_CLIENT_BAD_RESPONSE`. **422 phải xử lý riêng** (`api.js:194-198`) vì FastAPI validation
không dùng envelope này. `Retry-After` được đọc từ **bốn** cách viết trong body cộng header
(`api.js:227-240`).

**Số nguyên lớn:** `parseJsonExact` (`api.js:100-114`) dùng reviver `JSON.parse` có
`context.source` (ES2025) để giữ nguyên chữ số BIGINT dưới dạng `{__exactDigits:"…"}`.
Trình duyệt cũ hơn rơi về fallback và `format.js:64` **tô nền vàng kèm cảnh báo** thay vì
hiển thị lặng lẽ một con số sai.

**Một ngoại lệ cố ý về hiển thị lỗi:** thông điệp server hiện **nguyên văn**, trừ 401 từ
`/auth/login` bị thay bằng một câu cố định. Ngoại lệ này đi theo hướng an toàn — hiện **ít**
thông tin hơn, không bao giờ nhiều hơn. Lỗi khi **đổi** mật khẩu thì ngược lại: hiện nguyên
văn, vì nó nói về mật khẩu vừa gõ chứ không nói tài khoản nào tồn tại.

---

## 7. Cấu hình

48 biến `AIVB_*`, tất cả chảy qua một frozen dataclass và một singleton (`config.py:239-637`).
Mỗi field là `field(default_factory=...)` đọc `os.environ` lúc khởi tạo instance → **biến môi
trường phải được đặt TRƯỚC khi `backend.config` được import** (bộ test dựa vào đúng tính chất
này, `conftest.py:107-119`).

Neo đường dẫn: `APP_ROOT = Path(__file__).resolve().parent.parent` (`config.py:18`). **Mọi
đường dẫn mặc định tính từ đó, không có đường dẫn tuyệt đối nào trong code** — đây chính là
tính chất cho phép chuyển máy.

> ⚠️ **Không có dotenv loader trong Python.** `config.py` chỉ đọc `os.environ`. File
> `config/app.env` được nạp bởi `env_file:` của Docker (`docker-compose.yml:61-62`) hoặc bởi
> `set -a; . config/app.env` trong `scripts/setup.sh:64`. Chạy thẳng
> `uvicorn backend.main:app` mà quên export → **im lặng dùng toàn bộ giá trị mặc định**.

Mật khẩu PG **không phải** biến môi trường: đọc từ `config/pg_secrets.env` bởi
`Settings._pg_password` (`config.py:547`), khoá `pw_api_s` / `pw_api_i`, giá trị là phần chữ
trước dấu cách đầu tiên.

**Nguyên tắc mặc định an toàn khi thiếu:** `AIVB_CORS_ORIGINS` không đặt = **chỉ loopback**,
không phải `*`. Muốn mở cho mọi nguồn phải cố ý ghi `*`, và khi đó `allow_credentials` bị
**ép tắt** (`main.py:244-250`) cộng một dòng cảnh báo SECURITY mỗi lần khởi động.

### Hai biến sai âm thầm

| Biến | Đặt sai thì sao |
|---|---|
| `AIVB_COOKIE_SECURE=0` khi chạy HTTPS | Trình duyệt **lặng lẽ** bỏ cookie `__Host-`. Triệu chứng: "đăng nhập xong vẫn như chưa đăng nhập" — không có thông báo lỗi nào |
| `AIVB_PG_LC_MESSAGES` khác `C` | Thông báo lỗi engine đổi ngôn ngữ → guard không tái lập nguyên văn được nữa → **học viên dò được sự tồn tại của cột** |

### Cấu hình chết (di sản DuckDB)

`db_path`, `instructor_db_path`, `memory_limit`, `duckdb_threads`, `temp_directory`,
`max_temp_directory_size` và `Settings.duckdb_config()` (`config.py:616`) — **không có call
site nào trong app đang chạy**; `duckdb_config()` chỉ được `tests/ops_bench.py` dùng.
`db_path` / `instructor_db_path` sống sót chỉ để nuôi `dataset_paths()` →
`assert_auth_store_isolated`. `docker/requirements.txt:5` ghi rõ **cố ý không có** dependency
`duckdb`.

---

## 8. ⚠️ 12 điểm code đã lệch khỏi tài liệu

Danh sách cụ thể, không phải góp ý phong cách. Mỗi mục có vị trí cả hai phía.

| # | Vấn đề | Tài liệu nói | Code làm |
|---|---|---|---|
| 1 | **Tiền tố `app/` không tồn tại** | `README.md`, `ARCHITECTURE.md` mô tả `app/backend/`, `app/config/` | Thư mục `Web_SQL/` **chính là** `app/`. Runtime không ảnh hưởng vì `APP_ROOT` tính tương đối, **nhưng** `PROJECT_ROOT = APP_ROOT.parent` (`config.py:26`) nay trỏ ra `D:\Giang-day\Soan bai\Project DA`, nên `DEFAULT_DB_PATH` (`config.py:30`) và `STUDENT_FACING_DIRS[0]` (`config.py:56`) chỉ vào `Project DA\_workspace\…` **không tồn tại**. Vô hại hôm nay chỉ vì cả hai đều không được dùng |
| 2 | **Ba số version khác nhau** | `API_CONTRACT.md:3` ghi `1.4.0` (changelog dừng ở 1.4.1) | `main.py:103` `API_VERSION = "1.5.0"` (số `/health` trả về) · `backend/__init__.py:3` `__version__ = "1.0.0"` |
| 3 | **Bảng biến môi trường §1 của `API_CONTRACT.md` là thời DuckDB** | Ghi `AIVB_DB_PATH`, `AIVB_MEMORY_LIMIT`, `AIVB_DUCKDB_THREADS`, `AIVB_TEMP_DIR`, `AIVB_MAX_TEMP_SIZE` như knob còn sống (dòng 83, 92-95); lệnh chạy dòng 70-75 vẫn activate một conda env macOS | Không cái nào ảnh hưởng đường phục vụ nữa. Và **không tài liệu hoá** 20 biến `AIVB_PG_*` lẫn `AIVB_GAMIFICATION_DB_PATH`. Toàn bộ hợp đồng vẫn viết bằng thuật ngữ DuckDB (`duckdb.connect(read_only=True)`, `enable_external_access=false`, hai file `.duckdb` để định tuyến role) trong khi thực tế là một service `postgres:18` |
| 4 | **Mặc định auth-store đã cũ** | `API_CONTRACT.md:104-105` ghi `_workspace/auth/auth.sqlite3` | Code mặc định `<APP_ROOT>\var\auth\…` (`config.py:46-47`). Tương tự `AIVB_OWNER_CONFIG_PATH` |
| 5 | **Đếm biến sai** | `ARCHITECTURE.md:136` — "48 biến `AIVB_*`, **tất cả** có trong `.env.example`" | 48 đúng với `config.py`, nhưng `.env.example` chỉ có **36** assignment. Thiếu: `AIVB_GAMIFICATION_DB_PATH`, `AIVB_COOKIE_NAME`, `AIVB_CSRF_HEADER`, `AIVB_AUDIT_COLUMNS`, `AIVB_AUDIT_ENABLED`, `AIVB_PG_POOL_MIN/MAX`, `AIVB_INSTRUCTOR_DB_PATH` |
| 6 | **`.env.example` lệch default với code** | `.env.example:99` `AIVB_MAX_ROWS=10000`; `:85` `AIVB_SESSION_IDLE_S=1800` | `config.py:317` mặc định `1000`; `config.py:278` mặc định `28800`. `API_CONTRACT.md:86,111` ghi theo code → **ba nguồn, ba đáp án**. *(`frontend/README.md:75` còn ghi `defaultMaxRows: 200` trong khi `config.js:32` là `10000`.)* |
| 7 | **`API_CONTRACT.md` có hai section cùng số `## 13`** | Dòng 906 "Authentication endpoints" và dòng 1037 "Practice rewards and Instructor Console" | — |
| 8 | **Gamification/analytics không có trong changelog** | Changelog không nhắc gì tới các bổ sung của 1.5.0 | `/gamification/me`, `/gamification/leaderboard`, `/admin/analytics/queries` đã tồn tại và frontend đã dùng |
| 9 | **Không có `.gitignore` nào trong cây này** | `README.md:55` nói `database/dumps/` bị gitignore và vắng mặt sau khi clone; `.env.example:3-4` nói `app/config/*` được bảo vệ trừ chính nó | Hai file dump **đang có mặt** (1,00 GB + 1,15 GB), và **không có `.gitignore` lẫn `.git`** ở đâu cả → **`config/pg_secrets.env` đang nằm plaintext không được bảo vệ.** Đây là mục đáng ưu tiên xử lý nhất trong bảng này |
| 10 | **`docker compose up` không chạy được hôm nay** | `README.md:20-30` mô tả đường một lệnh | `docker-compose.yml:62` cần `../config/app.env`, dòng 81 cần `../config/pg_superuser.txt` — **không file nào tồn tại**. Đây là "chưa dựng xong", không phải lỗi code |
| 11 | **Tên package `api/` và `web/` cũ còn khắp docstring** | — | `main.py:6-30`, `guard.py`, `db.py`, `catalog.py:315`, `config.py` và hầu hết docstring test vẫn nhắc `api/auth.py`, `api/db.py`, `api/tests/…`; `frontend/README.md` vẫn gọi frontend là `web/` và backend là `api/`. Package nay là `backend/` và `frontend/`. Tương tự `deploy/postgres/0*.sql` (`db.py:171`, `config.py:598`, và header của chính các file SQL) nay là `database/schema/` |
| 12 | **Tham chiếu DuckDB trong guard** | — | `guard.py:1-48` và `:74-80` vẫn giải thích luật theo "dialect DuckDB" trong khi `guard.py:68` đặt `DIALECT = "postgres"`. *(Riêng `catalog.ColumnInfo.duckdb_type` và `pgtypes.py` giữ **tên** DuckDB là **cố ý**, có ghi chú ở `pgtypes.py:1-23` — không tính là lệch.)* |

### Điểm docs nói đúng, đã kiểm

- `backend/` không import gì từ `generator/`/`qa/` — ✅
- 77/100 bảng (`ARCHITECTURE.md:44`) khớp `restore.py:41-50` và delta 23 bảng ở `.env.example:26` — ✅
- `test_pg_engine_defenses.py` tồn tại và chứng minh đúng điều `ARCHITECTURE.md:84` tuyên bố — ✅

### Chưa xác minh được (chưa chạy code)

- `/docs` và `/openapi.json` **không bị tắt** (không có `docs_url=None`), nhưng CSP ở
  `main.py:278-282` là `script-src 'self'` → Swagger sẽ không tải được asset CDN. Khả năng
  hỏng cao nhưng chưa chạy thử.
- Body 422 của pydantic có thật sự thoát khỏi envelope `{ok,…}` mà `API_CONTRACT.md` §2 hứa
  hay không — không có handler cho `RequestValidationError`.
- Hai file `.dump` có khớp hợp đồng nghiệm thu 77/100 hay không — chỉ biết được khi chạy
  `database/restore.py verify` trên một cluster sống.

---

## 9. Khoảng trống của knowledge graph

Graph ở `graphify-out/` **không phải toàn bộ sự thật**. Đã cố ý bỏ:

| Bỏ gì | Vì sao |
|---|---|
| `frontend/vendor/**` (CodeMirror 5.65.16, 10 file) | Nội bộ thư viện bên thứ ba sẽ nhấn chìm 15 module backend thật sự quan trọng. *(Graph vẫn có 2 node **nói về** CodeMirror, lấy từ docs.)* |
| `backend/contract/column-contract.json` (655 KB / 20.508 dòng) | Là **dữ liệu**, không phải cấu trúc. Vai trò của nó được mô tả qua `catalog.py` |
| `backend/contract/owner-config.json` (203 KB / 6.434 dòng) | Như trên |
| `config/.env.example`, `config/pg_secrets.env` | graphify tự bỏ qua file nhạy cảm (3 file bị bỏ) |
| `database/dumps/*.dump`, `var/auth/*.sqlite3`, `audit.jsonl` | Đuôi file không được hỗ trợ |

**Khoảng trống không cố ý:**

- graphify **không quét `.css`**, nên `tokens.css` (hệ design token) và `styles.css` **hoàn
  toàn vắng mặt** trong graph. Mục 5 của tài liệu này là nguồn duy nhất mô tả chúng.
- Health check báo **191 cạnh có đầu mút không tồn tại** trong 2.585 cạnh thô. Kiểm tra cho
  thấy gần như toàn bộ là **tên module ngoài** (`pathlib`, `pytest`, `fastapi`, `sqlglot`,
  `psycopg`…) mà AST sinh cạnh `imports` tới nhưng không có node — vô hại. 15 cạnh nối
  docs→code do subagent đoán sai id đã được ánh xạ tay về id AST thật trước khi build.
- 54–56 cạnh bị **gộp** vì graph dựng ở dạng vô hướng: một cặp node nối nhau bằng nhiều quan
  hệ (`calls` + `references`) chỉ còn một cạnh. Đây là đánh đổi có chủ ý để community
  detection sắc nét hơn.

---

## 10. Dùng graph thế nào

```bash
graphify query "Một câu SQL của học viên đi qua những tầng nào trước khi chạm PostgreSQL?"
graphify query "Cơ chế nào ngăn học viên biết bảng đáp án tồn tại?"
graphify query "Cái gì sẽ hỏng nếu đổi AIVB_COOKIE_SECURE?"
graphify path "validate()" "Catalog"     # đường ngắn nhất giữa hai node
graphify explain "PgFunctionPolicy"      # giải thích một node bằng lời thường
graphify update                          # chỉ trích xuất lại file đã đổi
```

Output trong `graphify-out/`:

| File | Nội dung |
|---|---|
| `graph.html` | Đồ thị tương tác, mở thẳng bằng trình duyệt, không cần server |
| `GRAPH_REPORT.md` | Báo cáo kiểm toán: god node, cohesion score từng community, chi phí token |
| `graph.json` | Dữ liệu graph thô (1.258 node · 2.338 cạnh · 90 community) |
| `wiki/index.md` | Wiki markdown, một bài mỗi community — điểm vào cho agent đọc |
| `manifest.json` | Trạng thái file để `graphify update` biết cái gì đã đổi |

> Khi chạy lại graphify trên máy này, phải dùng interpreter Anaconda
> (`C:\Users\nguyennp\anaconda3\python.exe`) — `python` mặc định trên PATH không có graphify.
> Đường dẫn này đã được ghim sẵn ở `graphify-out/.graphify_python`.
