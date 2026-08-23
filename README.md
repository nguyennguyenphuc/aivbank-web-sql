# AIV Bank — ứng dụng

Chép thư mục này sang máy khác là dựng lại được phần lớn hệ thống — nhưng
**không phải toàn bộ**. Ba thứ nằm ngoài đây và thiếu thứ nào cũng không chạy:
relay (`Finance/deploy/windows/`), env chạy thật (`C:\ProgramData\AIVBank\config\`),
và kho mật khẩu học viên — thứ không nằm trong bản dump nào cả.

Danh sách đầy đủ những gì phải mang theo: [`docs/MIGRATION.md`](docs/MIGRATION.md).

```
app/
  backend/     FastAPI + guard SQL + hợp đồng API
  frontend/    console SQL cho học viên (JS thuần, không cần build)
  database/    schema, script phục hồi, thư mục chứa bản dump
  config/      cấu hình và bí mật (không vào git)
  docker/      docker compose + Dockerfile
  scripts/     đường cài đặt không dùng Docker
  deploy/      mẫu cấu hình Caddy cho bản chạy tại nhà
  docs/        chuyển máy và mở ra Internet
```

Đọc `ARCHITECTURE.md` trước khi sửa bất cứ thứ gì — nó giải thích **vì sao**,
còn file này chỉ nói **làm thế nào**.

---

## Dựng bằng Docker

```bash
cp config/.env.example config/app.env       # rồi sửa AIVB_CORS_ORIGINS
printf 'mat-khau-superuser' > config/pg_superuser.txt
# đặt aivb_student.dump và aivb_instructor.dump vào database/dumps/

cd docker && docker compose up
```

Xong thì mở `http://127.0.0.1:8000`.

Bước `restore` **tự nghiệm thu** trước khi backend khởi động: đủ 77 bảng
(student) / 100 bảng (instructor), collation đúng, `ref_branch` có 12 dòng, và
đáp án chấm bài **không tồn tại** trong database học viên. Thiếu một mục là
dừng — backend sẽ không lên.

## Dựng không dùng Docker

Cần sẵn PostgreSQL 18 và Python 3.11.

```bash
cp config/.env.example config/app.env
cp <máy cũ>/pg_secrets.env config/pg_secrets.env

pip install -r docker/requirements.txt
python database/restore.py restore          # schema + dump + nghiệm thu

uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

---

## Bản dump lấy ở đâu

`database/dumps/` **nằm trong `.gitignore`** — mỗi file khoảng 1,5–2 GB, không
đưa vào git được. Clone repo về sẽ **không** có chúng, và đó là lý do máy mới
chưa chạy được ngay.

Sinh từ máy đang chạy:

```bash
python qa/verify_pg_parity.py --target student   # BẮT BUỘC chạy trước
python app/database/restore.py dump
```

Thứ tự này không đổi chỗ được. Dump chụp lại đúng trạng thái hiện tại, nên một
sai lệch chưa phát hiện sẽ bị đóng gói vĩnh viễn rồi nhân bản sang mọi máy sau.

Chuyển hai file `.dump` sang máy mới bằng ổ cứng hoặc cloud.

---

## Bộ dữ liệu thứ hai: Supply Chain

App phục vụ **nhiều bộ dữ liệu**. Mặc định chỉ có `aivb` (AIV Bank); bật thêm
bằng `AIVB_DATASETS=aivb,scm` cộng khối `AIVB_DS_SCM_*` — xem mục 9 của
`config/.env.example`.

Dựng bộ SupplyChain từ đầu (cần mật khẩu superuser PostgreSQL):

```bash
# 1. cấp phát: role, tablespace (nằm TRONG Web_SQL/var/pgdata), database, 20 bảng
psql -U postgres -f database/schema/10_scm_roles.sql
psql -U postgres -v scm_ts_path="<tuyệt đối>/Web_SQL/var/pgdata/scm" \
     -f database/schema/11_scm_database.sql
psql -U postgres -d scm -f database/schema/12_scm_schema_grants.sql

# 2. đặt mật khẩu cho scm_api / scm_bi / scm_loader, rồi ghi vào
#    config/pg_secrets.env với khoá pw_scm_api, pw_scm_bi, pw_scm_loader

# 3. nạp — đọc PARQUET, không đọc CSV (CSV mất kiểu, xem §12 data dictionary)
python database/load_scm.py load --source <...>/SupplyChain/bo-du-lieu-vn-full
python database/load_scm.py index
python database/make_scm_contract.py     # sinh hợp đồng cột TỪ CHÍNH database
python database/load_scm.py verify       # 24 mục, thiếu một là hỏng
```

Thư mục tablespace phải **rỗng**, và tài khoản chạy service PostgreSQL phải ghi
được vào đó (trên Windows là `NT AUTHORITY\NetworkService`).

Nghiệm thu phải cho đủ **136.586.733 dòng** trên 20 bảng, trong đó `sales` là
125.497.040 dòng chia 5 phân vùng theo năm.

Chuyển sang máy khác: `python database/load_scm.py dump` rồi mang
`database/dumps/scm.dump` (~0,7 GB) đi, đúng như hai dump của AIV Bank.

**Một điểm khác AIV Bank, có chủ ý:** SupplyChain chỉ có **một** database, cả học
viên lẫn giảng viên đọc chung. AIV Bank tách hai database vật lý vì trong dữ liệu
có bảng đáp án; SupplyChain không có bảng nào như vậy — đáp án của nó nằm ở
`labs/vn/*.py`, `outputs/` và mục 6.7/10 của `MO-TA-BO-DU-LIEU.md`, đều là file
ngoài database. **Phải phát cho học viên bản data dictionary đã bỏ hai mục đó**;
bản đầy đủ liệt kê thẳng những phát hiện mà bài tập yêu cầu họ tự tìm ra.

---

## Đưa ra Internet

Hai đường, cùng một tên miền DuckDNS và cùng một phép nghiệm thu:

```powershell
.\scripts\aivb.ps1 up             # đường hầm SSH ngược qua VPS (mặc định)
.\scripts\aivb.ps1 up -Router     # forward cổng trên router + Caddy ở nhà
.\scripts\aivb.ps1 up -NoTunnel   # chỉ chạy cục bộ, không mở gì ra ngoài
```

Cách dựng đường thứ hai — kiểm CGNAT, siết `listen_addresses`, xin chứng chỉ
Let's Encrypt bằng DNS-01, cấu hình router và tường lửa, và bảng tra lỗi:
[`docs/DEPLOY-ROUTER.md`](docs/DEPLOY-ROUTER.md).

Đường hầm giữ nguyên làm đường lùi. Nếu ISP dùng CGNAT hoặc chặn cổng vào thì
forward cổng không bao giờ chạy được, và đó là thứ duy nhất cứu được buổi học.

---

## Thay frontend

`frontend/` hiện là JS thuần. Muốn dùng React/Vue/Svelte:

1. Build ra một thư mục, phải có `index.html` ở gốc.
2. Đặt `AIVB_FRONTEND_DIR` trỏ vào đó.
3. Xong — **không sửa dòng backend nào**.

Hợp đồng là `backend/API_CONTRACT.md`. Đọc kỹ mục 9 "Rules the frontend MUST
follow" trước khi viết dòng đầu tiên: có bốn điều frontend không được làm, và
backend đã dựa vào đó (tóm tắt ở `ARCHITECTURE.md` mục 5).

Kiểm nhanh rằng cơ chế này thật sự chạy:

```bash
mkdir /tmp/fe && echo '<h1>xin chao</h1>' > /tmp/fe/index.html
AIVB_FRONTEND_DIR=/tmp/fe uvicorn backend.main:app --port 8001
```

---

## Chạy test

```bash
cd app && python -m pytest backend/tests/ -q
```

Bộ test này chạy được **độc lập** với phần còn lại của kho. Vài phép kiểm cần
gói phát hành hoặc bộ sinh dữ liệu sẽ tự bỏ qua khi không có — chúng thuộc về
kho đầy đủ, không thuộc `app/`.

---

## Cái gì KHÔNG nằm ở đây, và vì sao

`generator/`, `qa/`, `_workspace/` là **nhà máy sinh dữ liệu**, không phải sản
phẩm chạy. Chúng ở lại kho gốc.

Ranh giới này không phải quy ước suông: `backend/` không import gì từ chúng.
Nhờ vậy `app/` chuyển máy được mà không cần mang theo DuckDB, package của chủ
sở hữu, hay 39 GB dữ liệu trung gian.

Muốn **sinh lại** dữ liệu thì cần kho đầy đủ. Muốn **phục vụ** dữ liệu thì chỉ
cần thư mục này.
