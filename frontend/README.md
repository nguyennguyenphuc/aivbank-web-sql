# Bảng điều khiển SQL học viên — AIV Bank Mini Core Banking

Giao diện web để học viên eDA đăng nhập, gõ câu `SELECT`, xem kết quả và khám phá
cấu trúc bảng của bộ dữ liệu AIV Bank.

Toàn bộ dữ liệu, danh tính và quyền truy cập do **backend** (`api/`) quyết định.
Thư mục `web/` này chỉ hiển thị những gì API trả về: nó không kết nối DuckDB,
không chứa danh sách bảng, không tự quyết định học viên được thấy gì, và **không
tự kết luận ai đang đăng nhập** — câu hỏi "tôi đã đăng nhập chưa?" luôn được trả
lời bằng `GET /auth/me`, không bao giờ bằng một cờ ở phía trình duyệt.

---

## 1. Chạy

Cần **hai** tiến trình: API và máy chủ phục vụ giao diện.

### Cửa sổ 1 — API (backend)

```bash
source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh && conda activate aivbank
cd /Users/nguyennp/AI/Finance
AIVB_DB_PATH=_workspace/output/student.duckdb \
AIVB_CORS_ORIGINS=http://127.0.0.1:5173 \
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### Cửa sổ 2 — giao diện

```bash
cd /Users/nguyennp/AI/Finance
python frontend/serve.py            # mặc định http://127.0.0.1:5173/, proxy sang :8000
```

Mở <http://127.0.0.1:5173/>.

### Tài khoản

Không có tài khoản mặc định. Tạo bằng CLI của backend:

```bash
python -m backend.admin_cli create-user --username sv001 --role STUDENT
python -m backend.admin_cli create-user --username gv001 --role INSTRUCTOR
python -m backend.admin_cli import-csv --file danh_sach_lop.csv --role STUDENT  # cả lớp
```

Mật khẩu ban đầu được in **một lần** ra màn hình; tài khoản mới luôn ở trạng thái
`first-login`, nghĩa là giao diện bắt đổi mật khẩu trước khi cho vào.

### Vì sao `serve.py` nay có proxy (trước đây cố tình không)

Phiên đăng nhập là **cookie HttpOnly**, và mọi request đều gửi với
`credentials: 'same-origin'`. Trình duyệt **không** gắn cookie đó vào một API ở
origin khác. Nếu giao diện ở `:5173` còn API ở `:8000` thì đăng nhập sẽ "thành
công" rồi mọi thao tác sau đó đều 401. Cùng một origin ở đây là **điều kiện bắt
buộc của cookie auth**, không phải tiện nghi.

Lý do cũ ("proxy sẽ tạo ra nơi thứ hai quyết định quyền") không còn đúng với
proxy này: nó **không quyết định gì cả**. Nó chuyển tiếp nguyên văn method, path,
body, header (kể cả `Cookie` và `X-AIVB-Client`) lên trên, và status, body,
`Set-Cookie` xuống dưới. Nếu bạn thấy mình đang thêm một câu `if` về *ai được
xem gì* vào `serve.py` thì đó chính là lỗi.

Chạy `python frontend/serve.py --no-proxy` sẽ quay lại chế độ tĩnh thuần — và đăng
nhập sẽ không hoạt động; giao diện phát hiện điều này và hiện băng cảnh báo thay
vì để nó trông như lỗi vặt của máy chủ.

### Cấu hình

Sửa `web/config.js`:

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `apiBase` | `''` | `''` = **cùng origin với trang** — đây là giá trị duy nhất hoạt động được với cookie phiên. Đặt URL tuyệt đối chỉ để gỡ rối. |
| `defaultMaxRows` | `200` | Số dòng xin về mặc định. Máy chủ luôn kẹp lại theo `max_rows` của nó — không thể nới rộng từ đây. |
| `historyLimit` | `50` | Số câu lưu trong lịch sử. |
| `passwordMinLength` | `12` | Chỉ để gợi ý trước khi gửi. Phải **bằng** `MIN_PASSWORD_LENGTH` trong `api/authstore.py`; đặt thấp hơn chỉ tốn một lượt gửi, đặt **cao hơn** sẽ chặn oan mật khẩu mà máy chủ vốn chấp nhận. |

### Trước khi mở cho học viên dùng thật

1. Đặt `AIVB_CORS_ORIGINS` của backend về đúng origin của giao diện, không để `*`.
2. Phục vụ cả `web/` lẫn API sau **một** reverse proxy (nginx/Caddy) trên
   **cùng một origin**, qua **HTTPS**. `serve.py` là công cụ cho phòng lab và
   cho lúc phát triển, không phải máy chủ triển khai.
3. Bật `AIVB_COOKIE_SECURE=1`. Backend cảnh báo lúc khởi động nếu chưa bật.
4. Cân nhắc tắt trình quản lý mật khẩu của trình duyệt bằng chính sách máy
   (máy phòng lab dùng chung — giao diện không cản được việc trình duyệt tự
   hỏi "có lưu mật khẩu không?").

---

## 1b. Đăng nhập hoạt động thế nào

| Tình huống | Giao diện làm gì |
|---|---|
| Mở trang | Gọi `GET /auth/me`. Chưa có phiên → hiện màn hình đăng nhập; khung ứng dụng vẫn `hidden`. |
| Sai tài khoản **hoặc** sai mật khẩu | Luôn đúng **một** câu: *"Tên đăng nhập hoặc mật khẩu không đúng."* Không thể phân biệt tài khoản có tồn tại hay không. |
| Nhập sai quá nhiều lần | Máy chủ trả 429 → hiện *"…tạm thời bị khoá… thử lại sau N giây/phút"*, lấy số giây từ header `Retry-After`. |
| Lần đăng nhập đầu | `must_change_password` → màn hình đổi mật khẩu, **không** có nút bỏ qua. Chỉ còn lối ra là Đăng xuất. |
| Bất kỳ API nào trả 401 giữa chừng | Che ứng dụng, hiện lại màn hình đăng nhập, **giữ nguyên câu SQL đang gõ**, điền sẵn tên đăng nhập. Đăng nhập lại (cùng người) → về đúng chỗ cũ. |
| Đăng nhập lại bằng **người khác** | Xoá sạch trạng thái của người trước (SQL, kết quả, lịch sử, danh sách bảng) rồi mới mở ứng dụng. |
| 403 `E_PASSWORD_CHANGE_REQUIRED` | Đưa thẳng về màn hình đổi mật khẩu (không hiện lỗi phân quyền mà học viên không xử lý được). |
| Đăng xuất | Gọi `POST /auth/logout`, xoá lịch sử + kết quả + danh sách bảng + ô soạn thảo, rồi `location.replace()` để nút Back không còn mục lịch sử nào chứa dữ liệu cũ. |
| Nút Back / bfcache | `pageshow` (khi `event.persisted`) hỏi lại `GET /auth/me`; phiên đã chết thì màn hình đăng nhập che ngay lên bản DOM cũ. |

**Phiên giảng viên** được báo hiệu bằng **ba** dấu hiệu cùng lúc: huy hiệu
`GIẢNG VIÊN` nền đỏ sẫm, thanh trên cùng đổi màu, và một dải chữ trắng nền đỏ
chạy ngang trang. Bỏ sót cả ba là điều khó xảy ra.

---

## 2. Dùng như thế nào

| Thao tác | Cách làm |
|---|---|
| Chạy câu truy vấn | Nút **Chạy** hoặc `Ctrl/Cmd + Enter` |
| Chỉ chạy một đoạn | Bôi đen đoạn đó rồi `Ctrl/Cmd + Enter` |
| Gợi ý tên bảng/cột | `Ctrl + Space`, hoặc tự hiện khi gõ từ 2 ký tự trở lên |
| Gợi ý cột theo alias | Gõ `p.` sau khi đã viết `FROM <bảng> p` |
| Xem cột của một bảng | Bấm tên bảng ở thanh bên trái |
| Chèn tên bảng/cột vào ô soạn thảo | Bấm tên cột, hoặc biểu tượng `⤵` bên phải tên bảng |
| Tìm bảng theo tên cột | Gõ tên cột vào ô lọc ở thanh bên trái |
| Dừng câu đang chạy | Nút **Dừng** |
| Xem `tables_used` / SQL máy chủ đã chạy | Tab **Chi tiết lần chạy** |
| Lấy kết quả ra Excel | **Sao chép CSV** rồi dán |
| Đổi mật khẩu | Nút **Đổi mật khẩu** ở thanh trên cùng (`Esc` hoặc **Huỷ** để đóng) |
| Kết thúc buổi học | Nút **Đăng xuất** — bắt buộc trên máy dùng chung: nó xoá lịch sử SQL và kết quả khỏi máy |

### Đọc kết quả cho đúng

* Tiền là **số nguyên VND**. Ô số được nhóm hàng nghìn cho dễ đọc
  (`12,500,000,000`), nhưng giá trị **không bao giờ bị làm tròn hay rút gọn**.
  Di chuột lên ô để thấy giá trị gốc; tắt hẳn việc nhóm bằng ô đánh dấu
  *Nhóm hàng nghìn*; bản **Sao chép CSV** luôn ghi giá trị gốc.
* Băng thông báo **"Kết quả đã bị cắt bớt"** nghĩa là bạn đang nhìn một phần dữ
  liệu, không phải toàn bộ. Dùng `COUNT(*)` để biết con số thật.
* `NULL` hiển thị chữ nghiêng màu xám. Giá trị `NaN`/`Infinity` của kiểu `DOUBLE`
  được máy chủ trả về là `null` nên cũng hiện `NULL`.
* Chỉ chạy được **một** câu `SELECT` mỗi lần (mở đầu bằng `WITH` thì được).
  `DESCRIBE`, `SUMMARIZE`, `SHOW`, `PRAGMA`, `EXPLAIN` và mọi lệnh sửa dữ liệu
  đều bị từ chối — đây là thiết kế, không phải lỗi. Muốn xem cấu trúc bảng thì
  bấm tên bảng ở thanh bên trái.

---

## 3. Kiến trúc và lý do chọn

**Stack: HTML + CSS + JavaScript module thuần, không build step, không framework.
Hai phụ thuộc runtime, cả hai đã vendor sẵn vào `vendor/`: CodeMirror 5 cho ô soạn
thảo, và DuckDB-WASM cho khu vực "Thực hành SQL" (nạp lười, chỉ tải khi dùng).**

Lý do:

* Đây là **công cụ giảng dạy sẽ do người khác vận hành**, có thể là trợ giảng
  không phải lập trình viên. Sửa một dòng chữ tiếng Việt rồi F5 là thấy ngay —
  không cần `npm install`, không cần biết Vite/React, không có `node_modules`
  400 MB, không có lockfile phải bảo trì, không có bundle phải rebuild trước mỗi
  lần deploy.
* Quy mô bài toán nhỏ: 8 endpoint, một ô soạn thảo, một bảng kết quả, một thanh
  bên, một lớp che đăng nhập. Không có state phức tạp nào đáng để trả giá cho
  một framework.
* **Đăng nhập là lớp che (overlay), không phải trang riêng.** Cả bảng điều khiển
  nằm trên một trang, và phiên có thể chết giữa hai lần gõ phím. Một lớp che có
  thể hiện lên trên ô soạn thảo đang giữ câu SQL chưa lưu rồi biến đi sau khi
  đăng nhập lại — một trang riêng thì phải điều hướng, và điều hướng làm mất bài
  của học viên. Lớp che này mặc định **hiện sẵn trong HTML**: nếu `app.js` không
  tải được, thứ còn lại trên màn hình là form đăng nhập, không bao giờ là bảng
  điều khiển.
* CodeMirror được **vendor thay vì gọi CDN**: phòng máy có thể không ra được
  Internet, và một CDN là thêm một bên thứ ba chạy script trên trang mà học viên
  đang gõ truy vấn. Chỉ chép đúng 9 file cần dùng (`lib`, `mode/sql`, 4 addon),
  kèm `LICENSE`. Xem `web/vendor/codemirror/` — phiên bản 5.65.16.

### Các file

| File | Vai trò |
|---|---|
| `index.html` | Khung giao diện + màn hình đăng nhập (`#auth-gate`) và khung ứng dụng (`#app`) |
| `config.js` | Cấu hình triển khai (file duy nhất thường phải sửa) |
| `api.js` | Gọi API, gắn cookie + header `X-AIVB-Client`, chuẩn hoá mọi lỗi về một shape, giữ nguyên số nguyên lớn |
| `auth.js` | Mô hình phiên, câu chữ khi đăng nhập hỏng, gợi ý độ mạnh mật khẩu |
| `authgate.js` | Lớp che đăng nhập / đổi mật khẩu; quyết định khi nào ứng dụng được mở |
| `editor.js` | CodeMirror + autocomplete (nguồn duy nhất: schema từ API) |
| `schema.js` | Thanh bên khám phá bảng/cột |
| `results.js` | Bảng kết quả, băng cắt bớt, tab chi tiết |
| `format.js` | Quy đổi giá trị JSON → chữ hiển thị; xuất CSV |
| `errors.js` | Ánh xạ `error_code` → gợi ý tiếng Việt |
| `history.js` | Lịch sử câu đã chạy (sessionStorage) |
| `sandbox.js` | **Khu vực "Thực hành SQL"** — DuckDB-WASM chạy trong trình duyệt. Không import `api.js`, không gọi máy chủ dòng nào |
| `app.js` | Nối các phần lại với nhau + điều hướng ba khu vực |
| `tokens.css` | **Hệ token thiết kế** — nơi DUY NHẤT được phép có giá trị màu/khoảng cách/bo góc/đổ bóng/ho chữ viết cứng |
| `styles.css` | Lớp trình bày; chỉ dùng `var(--…)` từ `tokens.css`, không có literal nào |
| `assets/logo.png` | Lockup đầy đủ eDA — E2E Data Analytics (880×275) — dùng ở màn hình đăng nhập |
| `assets/logo-mark.png` | Riêng vòng tròn "eDA" (256×249) — dùng ở thanh trên cùng và favicon |
| `vendor/duckdb-wasm/` | DuckDB-WASM 1.32.0 (MIT), chỉ bundle `eh`: `.wasm` 33 MB + worker + loader |
| `serve.py` | Máy chủ tĩnh + proxy API (một origin) |

#### Nhận diện thương hiệu và khả năng tiếp cận

Màu chính `--brand-600 = #3D562A` lấy từ chính chữ "DA" trong logo (8,19:1 trên
nền trắng). Thang `--brand-50 … --brand-900` giữ nguyên H và S, chỉ đổi độ sáng.

Lần đổi nhận diện sang **eDA** giữ nguyên đúng màu xanh này, nên cả thang màu và
mọi con số tương phản bên dưới vẫn đúng như đã đo. Màu thứ hai của logo — chữ "e"
màu xanh xám `#95AE8D` — **không** nằm trong thang: nó chỉ đạt 2,41:1 trên nền
trắng, dưới cả ngưỡng 3:1, nên tuyệt đối không dùng cho chữ, biểu tượng hay vòng focus.

Ba quy tắc bắt buộc khi sửa giao diện:

1. **Mọi cặp chữ/nền phải ≥ 4,5:1** (chữ thường) hoặc **≥ 3:1** (chữ ≥18px, biểu
   tượng, vòng focus). `--ink-faint` chỉ đạt 3,59:1 nên **chỉ được dùng cho hình
   trang trí**, tuyệt đối không dùng cho câu chữ.
2. **Huy hiệu vai trò GIẢNG VIÊN phải dùng `--warning`, không bao giờ dùng xanh
   thương hiệu.** Đây là yêu cầu an toàn: xanh thương hiệu là hình ảnh của phiên
   học viên, giảng viên nhầm phiên là hỏng cơ chế chấm điểm.
3. **Chỉ dùng font có sẵn trong hệ thống.** Không CDN, không nhúng file font —
   giao diện phải chạy y hệt khi mất mạng.

---

## 4. Ràng buộc bắt buộc khi sửa code này

Đọc `api/API_CONTRACT.md` mục 9 trước. Năm điều dưới đây là ràng buộc, không phải
khuyến nghị:

**1. Không được viết tên bảng hay tên cột vào code.**
Mọi tên hiển thị trong giao diện — thanh bên, autocomplete, kể cả câu ví dụ mở
đầu trong ô soạn thảo — đều sinh ra lúc chạy từ `GET /schema`. Nếu hardcode, code
sẽ lệch khi dataset đổi, và tệ hơn là `web/` trở thành nguồn sự thật thứ hai về
việc học viên được thấy bảng nào. Có thể tự kiểm tra:

Có thể tự kiểm tra (`/schema` nay cần phiên, nên phải đăng nhập trước):

```bash
python3 - <<'PY'
import http.cookiejar, json, pathlib, re, urllib.request
BASE = 'http://127.0.0.1:5173'          # origin của giao diện, không phải :8000
USER, PW = 'sv001', '...'               # một tài khoản học viên bất kỳ

op = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.open(urllib.request.Request(
    BASE + '/auth/login', method='POST',
    data=json.dumps({'username': USER, 'password': PW}).encode(),
    headers={'Content-Type': 'application/json', 'X-AIVB-Client': 'web'}))

names = [t['name'] for t in json.load(op.open(BASE + '/schema'))['tables']]
for f in sorted(pathlib.Path('web').rglob('*')):
    if f.is_file() and f.suffix in {'.js', '.html', '.css'} and 'vendor' not in f.parts:
        txt = f.read_text(encoding='utf-8', errors='replace')
        hit = [n for n in names if re.search(r'\b' + re.escape(n) + r'\b', txt)]
        if hit:
            print(f, hit)
PY
```

**2. Không được diễn giải lại `E_UNKNOWN_TABLE`.**
Máy chủ cố tình trả về **cùng một thông điệp** cho tên bảng gõ sai và cho bảng
học viên không được phép thấy. Đừng thêm gợi ý kiểu "bảng này bị hạn chế", "chỉ
giảng viên mới xem được", "bạn không có quyền", cũng đừng tô màu/gắn nhãn khác đi
cho một số tên. Bộ dữ liệu có các bảng chứa **đáp án chấm bài**; chỉ cần học viên
biết chúng tồn tại là cơ chế đánh giá đã hỏng một phần. Xem thêm chú thích đầu
file `errors.js`.

**3. Không dùng lịch sử truy vấn làm nguồn gợi ý.**
Học viên gõ gì cũng được lưu vào lịch sử. Nếu lấy lịch sử làm nguồn autocomplete
thì một tên bảng học viên gõ mò sẽ được giao diện gợi ý lại như thể nó có thật —
đúng kiểu rò rỉ mà quy tắc 2 đang chặn. `editor.js` chỉ đọc từ schema của API.

**4. Không bao giờ lưu mật khẩu ở phía client.**
Không `localStorage`, không `sessionStorage`, không biến toàn cục, không closure
còn sống sau khi request xong. Mật khẩu được đọc từ ô nhập, truyền thẳng vào một
hàm, và ô nhập bị **xoá ngay trước khi gửi request** — không phải trong `finally`.
Đây là lỗi thật đã bị bắt trong khi nghiệm thu: `finally` của form đăng nhập chỉ
chạy sau khi `onSession()` tải xong health + toàn bộ schema, tức là mật khẩu
dạng chữ thường nằm lại trong một `<input>` trên trang đang hiển thị suốt vài
giây. Nếu bạn sửa luồng này, hãy giữ nguyên thứ tự: **xoá ô nhập trước, gọi
mạng sau.**

**5. Đừng đoán trạng thái đăng nhập ở phía client.**
Không có cờ `isLoggedIn` nào được tin. Cookie phiên là HttpOnly nên
`document.cookie` không thấy nó, và không chỗ nào trong `web/` thử đọc. Nguồn sự
thật duy nhất là `GET /auth/me` và mã HTTP của các request sau đó.

Ngoài ra:

* Không lưu schema vào `localStorage` / `sessionStorage` / service worker. Giao
  diện gọi lại `GET /schema` mỗi lần tải trang, để một thay đổi ở backend có hiệu
  lực ngay ở lần F5 kế tiếp thay vì kẹt trong bản sao cũ ở máy học viên.
* Lịch sử SQL nằm ở **`sessionStorage`**, không phải `localStorage`. Máy phòng
  lab là máy dùng chung: `localStorage` sẽ trao bài của người trước cho người
  sau chỉ bằng thao tác mở trang. `sessionStorage` sống qua F5 và qua lần đăng
  nhập lại khi hết phiên (đúng những trường hợp cần giữ), chết cùng với tab, và
  bị xoá hẳn khi bấm Đăng xuất. Khoá cũ trong `localStorage` (từ bản chưa có
  đăng nhập) bị xoá ở lần tải trang đầu tiên.
* Không thêm giao diện cho DDL/DML dù backend đã chặn. Đừng mời gọi một hành động
  chắc chắn bị từ chối.
* Thông điệp lỗi của máy chủ được hiển thị **nguyên văn** — **trừ một ngoại lệ
  cố ý**: 401 từ `/auth/login` bị thay bằng một câu cố định. Ngoại lệ này đi
  theo hướng an toàn (hiện **ít** thông tin hơn, không bao giờ nhiều hơn): nếu
  sau này backend có đổi thành "không có tài khoản này" thì giao diện vẫn không
  nói ra. Xem chú thích đầu `auth.js`.
* Lỗi khi **đổi** mật khẩu thì ngược lại: hiện nguyên văn thông điệp máy chủ, vì
  nó nói về mật khẩu vừa gõ chứ không nói về việc tài khoản nào tồn tại.

---

## 5. Giới hạn đã biết

* **Số nguyên rất lớn.** Giá trị `BIGINT`/`HUGEINT` vượt 2^53−1 được giữ nguyên
  chữ số nhờ reviver `JSON.parse` có `context.source` (Chrome ≥ 114, Firefox ≥ 143,
  Safari ≥ 18.2). Trên trình duyệt cũ hơn, ô nào có nguy cơ mất chữ số sẽ được
  **tô nền vàng kèm cảnh báo** thay vì hiển thị một con số sai lặng lẽ. Số tiền
  VND thực tế trong bộ dữ liệu này còn cách ngưỡng đó rất xa.
* **Nhóm hàng nghìn áp dụng cho mọi cột số**, nên một cột kiểu "năm" sẽ hiện là
  `2,023`. Tắt bằng ô đánh dấu *Nhóm hàng nghìn*; giá trị gốc luôn nằm ở tooltip.
* **Bảng kết quả dựng toàn bộ DOM**, không ảo hoá. Với trần 1.000 dòng của máy
  chủ thì mượt; nếu sau này nâng `AIVB_MAX_ROWS` lên hàng chục nghìn thì cần
  virtual scrolling.
* **Chưa i18n.** Giao diện tiếng Việt cứng; thông điệp lỗi của máy chủ là tiếng
  Anh (cố ý, vì phải giữ nguyên văn).
* **Chưa cảnh báo trước khi phiên hết hạn.** `GET /auth/me` có trả `expires_at`
  và `idle_timeout_s`, nhưng giao diện chưa dùng để báo "phiên sắp hết trong 5
  phút". Hiện học viên chỉ biết khi bấm Chạy và bị đẩy về màn hình đăng nhập —
  câu SQL vẫn được giữ nguyên nên không mất bài, chỉ là bất ngờ.
* **Đăng xuất tải lại trang.** Đây là chủ ý (để nút Back không còn mục lịch sử
  nào chứa dữ liệu cũ), nhưng có nghĩa là mọi thứ chưa lưu đều mất khi bấm Đăng
  xuất. Hết phiên giữa chừng thì **không** như vậy: câu SQL được giữ lại.
* **Không cản được trình quản lý mật khẩu của trình duyệt.** Ô mật khẩu dùng
  `autocomplete` chuẩn để trình duyệt điền hộ; trên máy dùng chung, việc trình
  duyệt hỏi "lưu mật khẩu?" phải chặn bằng chính sách máy, không chặn được từ
  đây.
* **Không có luồng tự đặt lại mật khẩu.** Quên mật khẩu thì giảng viên chạy
  `python -m backend.admin_cli reset-password`. Đây là chủ ý: một luồng đặt lại qua
  email cần một kênh email đáng tin mà lớp học chưa có.

## Data mart

Tab `Data mart` lấy danh sách động từ `GET /schema/marts`, lấy cột của lựa chọn
từ `GET /schema/marts/{name}`, rồi mới tạo câu `SELECT` chỉ với các tên API vừa
trả về. Vì vậy giao diện không chứa tên bảng/cột đóng gói sẵn và tự thích ứng
với quyền của phiên hiện tại. Nếu API trả danh sách rỗng, tab hiển thị trạng
thái không có dữ liệu thay vì suy đoán mart nào có thể tồn tại ở vai trò khác.

---

## 6. Ba khu vực

Thanh ngay dưới thanh trên cùng chia giao diện thành **ba khu vực**, không phải một
hộp chọn dataset:

| Khu vực | Dữ liệu | Đi qua máy chủ? |
|---|---|---|
| **Finance Banking** | `aivb_student` / `aivb_instructor`, 77/100 bảng | Có — `/query` → `guard.py` → PostgreSQL |
| **Supply Chain** | `scm`, 20 bảng, 136 triệu dòng | Có — cùng đường, khác dataset |
| **Thực hành SQL** | File học viên tự tải lên | **Không** — chạy hẳn trong trình duyệt |

Danh sách khu vực **không** nằm trong code giao diện: nó đến từ `GET /datasets`,
đúng cùng lý do danh sách bảng đến từ `GET /schema` (quy tắc 1 ở mục 4). Máy chủ
quyết định phiên này thấy bộ dữ liệu nào, và một bộ không mở được hiện ra là
*không kết nối được* chứ không biến mất khỏi thanh.

Hai khu vực đầu **dùng chung một ô soạn thảo và một thanh bên schema**, nên chuyển
giữa chúng **phải** xoá schema, kết quả và lịch sử — nếu không, autocomplete sẽ gợi
ý tên bảng của dataset này bên trong câu truy vấn của dataset kia, đúng kiểu rò rỉ
mà quy tắc 1 và 3 ở mục 4 đang chặn.

Khu vực thứ ba **không cần** xoá gì: nó có ô soạn thảo riêng, và nguồn tên duy nhất
của nó là file của chính học viên.

### Thực hành SQL — chạy trên file của bạn

Kéo thả một file CSV / TSV / Parquet / JSON vào thanh bên, nó thành một bảng, gõ
`SELECT` rồi bấm **Chạy**. Nhiều file thì `JOIN` được với nhau. Nút **Tải CSV** ghi
kết quả ra file.

**File không bao giờ rời khỏi máy học viên.** Không có upload, không có phiên,
không có vai trò, không ghi audit. Engine là DuckDB-WASM vendor sẵn ở
`vendor/duckdb-wasm/`, chạy trong một Web Worker.

Bốn điều cần biết:

* **Tải lười.** Bản `.wasm` nặng 33 MB và chỉ được tải ở lần nạp file đầu tiên,
  không tải lúc mở trang. Phục vụ từ chính origin của app nên trong phòng lab là
  một lần tải qua LAN rồi cache.
* **Tên bảng sinh từ tên file.** `Bảng Lương 2024.csv` → `bang_luong_2024`; dấu
  tiếng Việt được bỏ, trùng tên thì thêm `_2`.
* **Không đọc `.xlsx`.** Đọc Excel cần extension mà DuckDB tải về lúc chạy — vừa
  hỏng khi mất mạng, vừa bị `connect-src 'self'` chặn. Hãy *Lưu dưới dạng CSV*.
* **Trần hiển thị 2.000 dòng, trần tải về 1.000.000 dòng.** Cả hai đều được **báo
  ra màn hình** khi chạm tới, không bao giờ cắt im lặng. Trần hiển thị tồn tại vì
  bảng kết quả dựng toàn bộ DOM (xem mục 5).

Quy tắc 2 ở mục 4 (**không diễn giải lại `E_UNKNOWN_TABLE`**) **không** áp cho khu
vực này: lỗi ở đây nói về file của chính học viên, nên hiện nguyên văn là thứ hữu
ích nhất. Quy tắc đó vẫn ràng buộc mọi thông điệp đến từ `api.js`. Hai thế giới
được tách hẳn trong code — `sandbox.js` không import `api.js` — để không ai nhầm
luật nào áp ở đâu.
