# AIV Bank — hướng thiết kế

Tài liệu này không mô tả lại code. Nó trả lời những câu mà người tiếp nhận sẽ
hỏi, và ghi lại **vì sao** mỗi lựa chọn được chọn — kèm cái giá của lựa chọn
ngược lại, vì đó mới là thứ khó tìm lại sau này.

---

## 1. Ranh giới: sản phẩm và nhà máy

```
app/          ← SẢN PHẨM CHẠY. Chuyển máy chỉ cần mang theo thư mục này.
generator/    ┐
qa/           ├ NHÀ MÁY SINH DỮ LIỆU. Không cần để chạy ứng dụng.
_workspace/   ┘
```

`app/backend/` **không import** gì từ `generator/` hay `qa/`. Ranh giới này có
sẵn trong code từ trước; việc tách thư mục chỉ làm nó hiện rõ ra.

Hệ quả thực tế: bạn có thể copy `app/` sang máy khác, dựng PostgreSQL, phục hồi
dump, và có một hệ thống chạy được — **không cần** DuckDB, không cần package
của chủ sở hữu, không cần 39 GB `_workspace`.

### Dữ liệu chảy một chiều

```
DuckDB  ──build──▶  validate  ──▶  seal  ──▶  parquet/dump  ──▶  PostgreSQL
                                                                      │
                                                          ┌───────────┴───────────┐
                                                     FastAPI /query        Excel · Power BI
```

**PostgreSQL là bản sao, không bao giờ là bản gốc.** Muốn sửa dữ liệu thì dựng
lại từ DuckDB, nghiệm thu, seal, rồi nạp lại. Sửa thẳng trong PostgreSQL sẽ làm
nó lệch khỏi bản dùng chấm bài, và **không có phép kiểm nào bắt được** — bản
chấm bài nằm ở DuckDB, còn parity check thì so PostgreSQL với parquet đã seal
chứ không so với bài giải.

---

## 2. Vì sao hai database vật lý

`aivb_student` (77 bảng) và `aivb_instructor` (100 bảng) là **hai database
riêng**, không phải một database với phân quyền.

Cách làm "đúng kiểu PostgreSQL" là một database + `GRANT`/`REVOKE` cấp cột để
giấu `raw_account_transaction.dirty_flag`. **Nó sai hai lần:**

1. **Tạo ra oracle dò sự tồn tại.** Cột bị từ chối trả `42501` (không đủ quyền),
   cột không tồn tại trả `42703`. Hai mã khác nhau = học viên hỏi được "cột này
   có thật không", tức là dò ra cấu trúc đáp án.
2. **Phá `SELECT *`** cho mọi học viên — câu lệnh cơ bản nhất trong bài giảng.

Cách hiện tại: bảng và cột giảng viên **không tồn tại** trong `aivb_student`.
Học viên gõ `SELECT * FROM aivb.meta_dirty_log` nhận đúng thông báo "không có
bảng", giống hệt khi gõ sai tên. Đã kiểm: vai trò học viên đọc `pg_class` không
thấy gì — danh mục đọc được cũng vô hại khi đối tượng thật sự không có.

Lý do đầy đủ ở cuối `app/database/schema/03_schema_grants.sql`.

---

## 3. Người dùng BI đi vòng qua guard

Đây là điều quan trọng nhất phải nhớ khi sửa bảo mật.

```
Học viên trên web  ──▶  FastAPI  ──▶  guard.py  ──▶  PostgreSQL
Học viên trên BI   ─────────────────────────────▶  PostgreSQL
```

Excel, Power BI và Tableau nói chuyện thẳng với PostgreSQL. **Đó là mục đích
của cả lớp phục vụ này**, nhưng nó có nghĩa: với người dùng BI, biên an ninh là
**role và GRANT của PostgreSQL**, không phải `guard.py`.

Nên mọi biện pháp chỉ tồn tại trong guard đều **không bảo vệ** người dùng BI.
Muốn một hạn chế áp cho tất cả, nó phải nằm ở tầng database.

Hai hệ quả đã được cài đặt:

- `default_transaction_read_only` **không phải** biện pháp bảo mật — client nào
  cũng tắt được. Chỉ việc **không cấp** INSERT/UPDATE/DELETE/DDL mới thật sự ép
  chỉ-đọc. `app/backend/tests/test_pg_engine_defenses.py` chứng minh cả hai vế.
- Không bao giờ dùng GRANT/REVOKE cấp cột (mục 2).

---

## 4. Hai khác biệt ngữ nghĩa làm sai kết quả trong im lặng

| Biểu thức | DuckDB 1.3.2 | PostgreSQL 18 |
|---|---|---|
| `5 / 2`, `BIGINT / BIGINT` | `2.5` (DOUBLE) | `2` (số nguyên) |
| `'a' < 'B'` | `false` (byte UTF-8) | `false` **chỉ khi `LC_COLLATE = C`** |

**Phép chia không sửa được ở tầng engine**: `pg_catalog` luôn đứng đầu
`search_path` nên không ghi đè được toán tử `/`. Quét toàn repo tìm thấy **0**
chỗ bị ảnh hưởng trong 81 validation — rủi ro nằm ở câu SQL học viên tự viết.
Dạy `::numeric` trước khi chia.

**Collation thì sửa được**, bằng cách tạo cả hai database với
`BUILTIN_LOCALE 'C'`. Điều then chốt: **parity check dựa trên md5 hoàn toàn mù
với collation** và sẽ báo PASS trên một database sai. Phải ép ở
`CREATE DATABASE` và kiểm bằng hành vi (`SELECT 'a' < 'B'`), không thể phát
hiện bằng cách chạy test.

---

## 2b. Vì sao Supply Chain chỉ có MỘT database

Mục 2 giải thích vì sao AIV Bank phải có hai database vật lý. Supply Chain
**không** đi theo, và đó là quyết định có cân nhắc chứ không phải bỏ sót.

Lý do của mục 2 là **trong dữ liệu có bảng đáp án** — `meta_dirty_log`,
`meta_scenario_label`. Supply Chain không có bảng nào như vậy. Đáp án của nó nằm
ở `labs/vn/*.py`, `outputs/`, và mục 6.7/10 của `MO-TA-BO-DU-LIEU.md`: **file,
không phải bảng**. Nhân đôi 9 GB `sales` để giấu một thứ không nằm trong database
là trả giá mà không mua được gì.

Hệ quả: việc tách học viên/giảng viên cho bộ này **nằm ngoài database**. Phải
phát bản data dictionary đã bỏ mục 6.7 và 10; bản đầy đủ liệt kê thẳng những phát
hiện mà bài tập yêu cầu học viên tự tìm ra (t3b +53% ngày sự kiện, lead-time đỉnh
trễ 4–5 ngày, r=+0,89 backlog↔sort-time, ITR 6,81, OTIF 91,5%…).

Code đã sẵn sàng cho điều này từ trước: `db_for_role()` lùi về database học viên
khi chưa cấu hình database giảng viên — *ít quyền hơn, không bao giờ nhiều hơn*.

### Trục dataset không tạo ra oracle mới

Đây là điều phải giữ khi thêm bộ dữ liệu thứ ba. Hai bộ **không dùng chung
catalog**: một bảng của bộ này không bị *lọc ra* khỏi bộ kia, nó **vắng mặt hoàn
toàn** khỏi catalog của bộ kia. Nên hỏi `orders` trong `aivb`, hỏi `ref_branch`
trong `scm`, hỏi một phân vùng `sales_2017` mà catalog không mô tả, hay hỏi
`meta_dirty_log` — cả bốn đều trả về **đúng một** `E_UNKNOWN_TABLE` với đúng một
câu chữ. Không có cách diễn đạt nào tiết lộ rằng một bảng có thật ở nơi khác.

Một tên dataset không tồn tại trả `503 E_DB_UNAVAILABLE`, **giống hệt** một
dataset đang hỏng — cố ý không tách mã riêng, vì tách ra là cho phép dò xem
những dataset nào tồn tại.

---

## 4b. Vì sao CSP có `'wasm-unsafe-eval'`

Khu vực **Thực hành SQL** chạy DuckDB-WASM ngay trong trình duyệt học viên, nên
`script-src` phải có `'wasm-unsafe-eval'`. Đây là một nới lỏng bảo mật thật, ghi
lại ở đây vì nó sẽ khiến người tiếp nhận dừng lại và hỏi.

**Vì sao chạy trong trình duyệt chứ không phải trên server.** Yêu cầu là "tải file
lên, chạy SQL, tải kết quả về" — nghĩa là dữ liệu học viên tự mang tới, cần
`CREATE`/`INSERT`, và cần một đường ghi. Đúng thứ mà mục 3 nói cả hệ thống này được
dựng để **không** cấp. Làm ở server nghĩa là đặt một engine có quyền ghi ngay cạnh
database chứa đáp án, cộng thêm lưu trữ file, hạn mức, thời hạn giữ, và một chính
sách quyền riêng tư cho dữ liệu học viên tải lên. Làm trong trình duyệt thì **file
không bao giờ rời khỏi máy học viên** và không có thứ nào ở trên tồn tại.

**Vì sao nó không làm yếu tầng bảo vệ đáp án.** Biên an ninh của đáp án nằm ở role
và GRANT của PostgreSQL, và ở `guard.py`. Khu vực sandbox không chạm cái nào: nó
không giữ kết nối tới bất kỳ database dạy học nào và không gọi `/query`.
`frontend/sandbox.js` không import `api.js` — đó là bất biến phải giữ.

**Hai thứ cố ý KHÔNG có trong header:**

- Không `'unsafe-eval'`. `'wasm-unsafe-eval'` hẹp hơn hẳn: nó cho biên dịch
  WebAssembly và không cho gì khác; `eval()` của JS vẫn bị chặn.
- Không `blob:` trong `worker-src`. Công thức DuckDB-WASM thông dụng dựng worker từ
  một Blob URL, và như vậy sẽ phải mở `worker-src blob:`. Ta dựng worker từ chính
  file same-origin trong `frontend/vendor/`, nên `default-src 'self'` đã đủ.

Chuỗi CSP nằm ở `backend/config.py` (`CONTENT_SECURITY_POLICY`) chứ không viết thẳng
trong middleware, và `backend/tests/test_contract_conformance.py` ghim nó — trước
đây không có test nào kiểm header này, nghĩa là nó có thể bị nới rộng mà không ai
biết.

## 5. Thay frontend

`app/frontend/` hiện là JS thuần, không có bước build, được backend phục vụ
tĩnh ở `/`. Muốn đổi hướng:

1. Build frontend mới ra một thư mục (phải có `index.html` ở gốc).
2. Đặt `AIVB_FRONTEND_DIR` trỏ vào đó.
3. Xong. Không sửa một dòng backend nào.

Hợp đồng là `app/backend/API_CONTRACT.md`. Bốn điều frontend **không được**
làm, vì backend đã dựa vào đó:

- **Không đọc cookie phiên.** Cookie là `HttpOnly` theo hợp đồng —
  `document.cookie` không thấy nó. Câu hỏi "tôi đã đăng nhập chưa" trả lời bằng
  `GET /auth/me`, không bằng phỏng đoán ở client.
- **Không diễn giải lại thông báo lỗi của backend.** Chúng được soạn để không
  rò rỉ sự tồn tại của bảng/cột; viết lại cho "thân thiện" là phá tính chất đó.
- **Không tự phân quyền ở client.** Cột nào vai trò nào thấy do backend quyết,
  frontend chỉ hiển thị thứ nhận được.
- **Không làm tròn số tiền.** Tiền là số nguyên VND. Parse JSON kiểu thông
  thường sẽ mất chữ số ở giá trị lớn — xem `app/frontend/format.js`, và
  `app/backend/tests/test_pgtypes.py` giữ hai bên khỏi trôi khỏi nhau.

---

## 6. Cấu hình

48 biến `AIVB_*`, tất cả có trong `app/config/.env.example`. Nguyên tắc:

- **Mọi đường dẫn mặc định tính từ `app/`**, không có đường dẫn tuyệt đối nào
  trong code. Đây là thứ cho phép chuyển máy.
- **Mặc định an toàn khi thiếu.** `AIVB_CORS_ORIGINS` không đặt = chỉ loopback,
  chứ không phải `*`. Muốn mở cho mọi nguồn phải cố ý ghi `*`, và server ghi
  cảnh báo SECURITY mỗi lần khởi động.

Hai biến sai âm thầm, đáng đọc kỹ:

- `AIVB_COOKIE_SECURE=0` khi chạy HTTPS → trình duyệt lặng lẽ bỏ cookie
  `__Host-`, học viên "đăng nhập xong vẫn như chưa đăng nhập".
- `AIVB_PG_LC_MESSAGES` khác `C` → thông báo lỗi đổi ngôn ngữ, guard không tái
  lập nguyên văn được nữa, và học viên dò được sự tồn tại của cột.

---

## 7. Một hệ quả đã chấp nhận có ý thức

Trước khi gom vào `app/`, `generator/freeze_release_candidate.py` băm mã nguồn
theo các gốc `("generator", "qa", "api", "web", "deploy")`. Giờ là
`("generator", "qa", "app", "deploy")`.

Nghĩa là các bản seal cũ (`rehearsal_dec24_A`) ghi băm nguồn theo **đường dẫn
cũ**, nên sau khi đổi cấu trúc thì **không đối chiếu lại byte-đối-byte được
nữa**.

Cái **không** mất: dữ liệu, checksum của dữ liệu, kết quả QA, `BUILD_HISTORY.md`.
Bản seal vẫn dùng được bình thường.

Cái mất: khả năng chứng minh lại "chính xác mã nguồn này đã sinh ra dữ liệu
kia". Bản seal tiếp theo sẽ có lại tính chất đó với cấu trúc mới.

Đây là cái giá đã cân nhắc để đổi lấy một thư mục chuyển máy được. Nếu truy
nguyên byte-đối-byte quan trọng hơn tính di động thì phải quay lại cấu trúc cũ —
hai thứ không cùng tồn tại được.
