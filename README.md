# AIV Bank — ứng dụng

Console SQL cho lớp phân tích dữ liệu. Học viên gõ SQL trong trình duyệt, backend
kiểm câu lệnh rồi chạy trên PostgreSQL và trả kết quả về. Cùng một tài khoản
dùng được cho cả console lẫn Power BI.

Đọc [`ARCHITECTURE.md`](ARCHITECTURE.md) trước khi sửa bất cứ thứ gì. File đó
giải thích **vì sao**, còn file này chỉ nói **làm thế nào**.

```
backend/     FastAPI + guard SQL + hợp đồng API
frontend/    console SQL cho học viên (JS thuần, không cần build)
database/    schema, script phục hồi, thư mục chứa bản dump
config/      cấu hình và bí mật (không vào git)
docker/      docker compose + Dockerfile
scripts/     script vận hành trên Windows
deploy/      mẫu cấu hình Caddy
docs/        chuyển máy và mở ra Internet
aivb.cmd     lối tắt cho scripts\Server.ps1
```

---

## 1. Cần gì để dựng

Clone repo về là có **gần hết**. Ba thứ nằm ngoài git, và chỉ một trong số đó
phải xin từ người khác.

### Phải tải từ Drive

Mỗi file khoảng 1 GB nên không đưa vào git được. Đặt cả ba vào
`database/dumps/`:

| File | Dung lượng | Bảng | Bắt buộc? |
|---|---|---|---|
| `aivb_student.dump` | 959 MB | 77 | có |
| `aivb_instructor.dump` | 1,1 GB | 100 | có |
| `scm.dump` | 671 MB | 20 | chỉ khi bật bộ Supply Chain |

**Link tải:** https://drive.google.com/drive/folders/1lq33frHjPaXbd_eopECq-6v-XQBk99ht?usp=sharing

Hãy đối chiếu sau khi tải, vì Drive vẫn có thể cắt cụt một file 1 GB mà trình
duyệt không báo gì:

```
5bd4d48d07172449d122851068316be03dde9275840b78604e268b0a2ae3fc00  aivb_student.dump
4dd2bd4225f810fd8540aeceaf67fc411de7ccd7410154f8b6330046415d03e0  aivb_instructor.dump
5fa45210c0cee43d49c56712df665741a72b37ccecc3c463e06634e0b5d2461b  scm.dump
```

```powershell
Get-FileHash database\dumps\aivb_student.dump -Algorithm SHA256
```

Sai checksum thì **đừng restore**. `restore.py` có nghiệm thu riêng, nhưng nó
bắt lỗi ở tầng dữ liệu chứ không bắt được một archive hỏng nửa chừng. Khi đó bạn
sẽ mất thời gian đọc một thông báo về collation trong khi nguyên nhân thật là
đường truyền.

### Tự tạo lúc dựng, không phải xin ai

Đây là chỗ hay bị hiểu nhầm là thiếu file. Cả ba đều do bạn tự đặt:

| File | Nội dung |
|---|---|
| `config/app.env` | chép từ `config/.env.example` (**có sẵn trong git**) rồi sửa `AIVB_CORS_ORIGINS` |
| `config/pg_superuser.txt` | mật khẩu superuser PostgreSQL, một dòng, tự chọn |
| `config/pg_secrets.env` | mật khẩu của 6 vai trò hạ tầng, tự chọn |

`pg_secrets.env` cần đúng sáu khoá này (danh sách gốc ở `database/restore.py`
dòng 167):

```
pw_loader=...
pw_api_s=...
pw_api_i=...
pw_bi_s=...
pw_bi_i=...
pw_app_rw=...
```

Thêm `pw_scm_loader`, `pw_scm_api`, `pw_scm_bi` nếu bật Supply Chain.

Mật khẩu **tự chọn tuỳ ý**, vì `01_roles.sql` dòng 88-92 đặt chúng bằng
`ALTER ROLE … PASSWORD :'pw_loader'`. Chúng không phải khớp với bất cứ thứ gì
nằm trong bản dump.

### Không cần mang theo

`var/auth/auth.sqlite3` và `gamification.sqlite3` là **di sản** của kiến trúc
cũ. Định danh nay nằm trong `pg_authid`; hai file đó chỉ còn dùng khi di trú
một lớp đang chạy, không dùng khi dựng máy mới. `var/auth/audit.jsonl` là log
truy vấn của học viên, không phải thứ để dựng lại.

### ⚠ Máy mới sẽ có đủ dữ liệu nhưng KHÔNG có tài khoản nào

`pg_dump` chụp **một database**, còn vai trò là đối tượng cấp **cụm**. Vì vậy
chúng không nằm trong bản dump. Kho SQLite cũ thì đã bỏ. Sau khi restore xong,
chưa ai đăng nhập được, và phải tạo tài khoản lại từ đầu (mục 3).

Không có đường tắt bằng `pg_dumpall`. `scripts/Migrate-PgVolume.ps1` dòng 99-101
giải thích vì sao nó bị **cố ý** loại bỏ. Bản `pg_dumpall` dựng lại database với
collation cũ, và phép kiểm collation của `restore.py` sẽ đỏ.

---

## 2. Dựng bằng Docker

Đường chính. Cần Docker Desktop.

```powershell
copy config\.env.example config\app.env     # rồi sửa AIVB_CORS_ORIGINS
notepad config\pg_superuser.txt             # một dòng: mật khẩu superuser
notepad config\pg_secrets.env               # sáu khoá pw_* ở mục 1

# đặt aivb_student.dump, aivb_instructor.dump (và scm.dump) vào database\dumps\

aivb up -Build
```

Xong thì mở `http://127.0.0.1:8000`.

`aivb up` cần quyền Administrator để bật hai service Windows, và nó **tự mở lại
cửa sổ nâng quyền**, nên bạn không phải tự mở cửa sổ Administrator.

Cờ `-Build` dựng lại image trước khi bật. **Bắt buộc sau khi sửa mã** trong
`backend/` hoặc `database/`, vì `docker compose up` không tự dựng lại. Thiếu cờ
này thì container vẫn chạy mã cũ trong khi file trên đĩa đã đổi, và không có gì
báo. Bạn chỉ thấy hành vi không khớp với mã vừa đọc.

### Hai phép kiểm tự chạy

**`Check-PgVolume.ps1`** soi layout volume trước khi compose chạy. Từ
postgres:18, dữ liệu nằm ở `/var/lib/postgresql/<major>/docker` chứ không ở
`/var/lib/postgresql/data` như quy ước 16/17. Một volume còn ở layout cũ sẽ làm
entrypoint nhìn vào chỗ trống, chạy `initdb`, và **cụm cũ trở thành vô hình**,
kể cả `aivb_app`. Đó là điều kiện duy nhất khiến `docker compose up` xoá lịch sử
mà không nói một lời nào. Báo đỏ thì chạy `scripts\Migrate-PgVolume.ps1`.

Đừng dùng collation làm phép đo thay thế. Một lần `initdb` nhỡ vẫn áp
`POSTGRES_INITDB_ARGS` và cho ra cụm **đúng collation nhưng rỗng hoàn toàn**,
vẫn qua được phép kiểm `SELECT 'a' < 'B'` của `restore.py`.

**Bước `restore`** tự nghiệm thu trước khi backend khởi động, gồm đủ 77 bảng
(student) / 100 bảng (instructor), collation đúng, `ref_branch` có 12 dòng, và
đáp án chấm bài **không tồn tại** trong database học viên. Thiếu một mục là
dừng, và backend sẽ không lên.

---

## 3. Tạo tài khoản lớp

Sau khi backend healthy. Một người = một vai trò PostgreSQL, dùng chung cho cả
console lẫn Power BI.

```bash
python -m backend.admin_cli import-csv --file class_2026a.csv --role STUDENT
```

CSV cần cột `username`; `full_name` và `role` là tuỳ chọn (`role` thiếu thì lấy
theo `--role`).

```csv
username,full_name,role
sv001,Nguyen Van A,STUDENT
sv002,Tran Thi B,STUDENT
gv01,Le Van C,INSTRUCTOR
```

**Mật khẩu in ra một lần và không lấy lại được.** Chép ngay khi lệnh chạy xong;
mất thì `reset-password`.

Tên đã tồn tại thì bị **bỏ qua chứ không ghi đè**. Nghĩa là chạy lại file CSV cũ
sẽ không đặt lại mật khẩu của em đã tự đổi.

Các lệnh khác:

```bash
python -m backend.admin_cli list
python -m backend.admin_cli create-user --username sv001 --role STUDENT
python -m backend.admin_cli reset-password --username sv001
python -m backend.admin_cli disable --username sv001     # khoá, và cắt phiên
python -m backend.admin_cli enable  --username sv001
python -m backend.admin_cli sessions --revoke-user sv001
```

`admin_cli` là file **duy nhất** dùng chuỗi kết nối có `CREATEROLE`. Backend
phục vụ web cố ý không có quyền đó.

---

## 4. Chạy hằng ngày

```
aivb up        bật tất cả
aivb down      tắt tất cả
aivb status    xem trạng thái (mặc định)
aivb logs      xem log
aivb restart   tắt rồi bật
```

Bốn tầng, và **thứ tự bật không đảo được**:

```
1. Docker Desktop
2. docker compose        postgres:18 + backend  ->  127.0.0.1:8000
3. DuckDNS AAAA          tiền tố IPv6 đổi theo lease 23h
4. caddy + aivb-tunnel   lối vào từ Internet    ->  127.0.0.1:8000
```

Tầng 4 trỏ vào cổng 8000. Bật nó trước khi backend lên thì học viên nhận **502**
thay vì một trang chờ, tức hỏng theo hướng khó hiểu hơn hẳn. Vì vậy `up` đợi
backend healthy rồi mới đụng tới hai service. Khi tắt thì làm ngược lại, cắt lối
vào trước rồi mới hạ backend.

`down` dùng `docker compose stop` chứ **không** `down`. Dữ liệu ~36 GB nằm trong
volume `docker_pgdata`, và `down -v` sẽ xoá nó.

Sau khi khởi động lại máy, Docker Desktop và hai service tự lên, nhưng container
thì **không** (`docker-compose.yml` không đặt `restart:`). Chạy `aivb up`.

---

## 5. Dựng không dùng Docker

Cần sẵn PostgreSQL 18 và Python 3.11.

```bash
cp config/.env.example config/app.env
# tạo config/pg_secrets.env và config/pg_superuser.txt như mục 1

pip install -r docker/requirements.txt
python database/restore.py restore          # schema + dump + nghiệm thu
```

Rồi áp kiến trúc xác thực:

```powershell
.\scripts\Apply-PgAuth.ps1              # xem trước, không đổi gì
.\scripts\Apply-PgAuth.ps1 -Apply       # làm thật
```

Script này chạy bốn bước theo đúng thứ tự sau, và **thứ tự không đảo được**:

1. `15_class_roles.sql` tạo hai nhóm lớp, trần kết nối database, và `scram_iterations = 100000`
2. `16_app_database.sql` tạo database `aivb_app` cho phiên, chặn đăng nhập sai, gamification, và vai trò `aivb_app_rw`
3. `14_pg_hba_docker.conf` được nạp vào rồi reload
4. dựng lại image và tạo lại container

Bước 1 đặt `scram_iterations`, mà giá trị đó chỉ áp **lúc đặt mật khẩu**. Chạy
bước 2 trước thì `aivb_app_rw` có mật khẩu băm bằng 4096 vòng PBKDF2 thay vì
100000, và không có gì báo.

Cuối cùng:

```bash
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

---

## 6. Bộ dữ liệu thứ hai: Supply Chain

App phục vụ **nhiều bộ dữ liệu**. Mặc định chỉ có `aivb` (AIV Bank); bật thêm
bằng `AIVB_DATASETS=aivb,scm` cộng khối `AIVB_DS_SCM_*` (xem mục 9 của
`config/.env.example`).

Có sẵn `scm.dump` thì bản Docker tự nạp qua `docker/restore-scm.sh`, không phải
làm gì thêm. Script đó cũng đặt mật khẩu cho ba vai trò SCM, vì
`10_scm_roles.sql` tạo chúng với `PASSWORD NULL`.

Dựng lại từ dữ liệu gốc (chỉ cần khi không có dump):

```bash
# 1. cấp phát: role, tablespace, database, 20 bảng
psql -U postgres -f database/schema/10_scm_roles.sql
psql -U postgres -v scm_ts_path="<tuyệt đối>/var/pgdata/scm" \
     -f database/schema/11_scm_database.sql
psql -U postgres -d scm -f database/schema/12_scm_schema_grants.sql

# 2. ghi pw_scm_api, pw_scm_bi, pw_scm_loader vào config/pg_secrets.env

# 3. nạp — đọc PARQUET, không đọc CSV (CSV mất kiểu, xem §12 data dictionary)
python database/load_scm.py load --source <...>/SupplyChain/bo-du-lieu-vn-full
python database/load_scm.py index
python database/make_scm_contract.py     # sinh hợp đồng cột TỪ CHÍNH database
python database/load_scm.py verify       # 24 mục, thiếu một là hỏng
```

Thư mục tablespace phải **rỗng**, và tài khoản chạy service PostgreSQL phải ghi
được vào đó (trên Windows là `NT AUTHORITY\NetworkService`). Bản Docker **bỏ
tablespace** theo đúng khuyến nghị, nên bước này chỉ áp dụng cho bản bare-metal.

Nghiệm thu phải cho đủ **136.586.733 dòng** trên 20 bảng, trong đó `sales` là
125.497.040 dòng chia 5 phân vùng theo năm.

**Có một điểm khác AIV Bank, và là có chủ ý.** SupplyChain chỉ có **một**
database, cả học viên lẫn giảng viên đọc chung. AIV Bank tách hai database vật lý
vì trong dữ liệu có bảng đáp án, còn SupplyChain không có bảng nào như vậy. Đáp
án của nó nằm ở `labs/vn/*.py`, `outputs/` và mục 6.7/10 của
`MO-TA-BO-DU-LIEU.md`, đều là file ngoài database. **Phải phát cho học viên bản data dictionary đã bỏ hai mục đó**;
bản đầy đủ liệt kê thẳng những phát hiện mà bài tập yêu cầu họ tự tìm ra.

---

## 7. Đưa ra Internet

Hai lối vào song song, cùng một tên miền DuckDNS, cùng trỏ về `127.0.0.1:8000`:

| Service Windows | Đường | Dùng khi |
|---|---|---|
| `caddy` | HTTPS trên IPv6, cổng 443 | ISP cấp IPv6 |
| `aivb-tunnel` | HTTPS trên IPv4, qua VPS cổng 18000 | ISP dùng CGNAT hoặc chặn cổng vào |

Cả hai do `aivb up` bật, không có lệnh riêng. `aivb status` kiểm từng đường bằng
`curl -4` và `curl -6` tách bạch. Lý do là hai đường hỏng độc lập với nhau, nên
gộp lại thì mất khả năng chẩn đoán.

Cách dựng đường IPv4 nằm ở [`docs/DEPLOY-ROUTER.md`](docs/DEPLOY-ROUTER.md), gồm
kiểm CGNAT, siết `listen_addresses`, xin chứng chỉ Let's Encrypt bằng DNS-01,
cấu hình router và tường lửa, và bảng tra lỗi.

### ⚠ Scheduled Task giữ bản ghi AAAA

Tiền tố IPv6 đổi theo lease ~23 giờ của ISP. Không có Scheduled Task
`AIVBank-DuckDNS6` thì bản ghi AAAA chết sau khoảng một ngày và tên miền ngừng
phân giải, trong khi mọi thứ khác vẫn xanh. Cài bằng
`scripts\Install-DnsTask.ps1`.

`aivb status` kiểm task này. Nhưng task chạy dưới SYSTEM với `HighestAvailable`
nên ACL chỉ cho quản trị viên đọc. **Phiên không nâng quyền thấy rỗng chứ không
báo lỗi.** Đừng suy ra là task không tồn tại. Hãy chạy `aivb status` trong cửa sổ
Administrator để kiểm thật.

### Đừng dùng `scripts\aivb.ps1`

File đó viết cho bản cài bare-metal cũ. Nó hard-fail vì thiếu
`pg_source_relay.py`, và còn cố dựng một uvicorn **thứ hai** tranh cổng 8000 với
container. Bản triển khai này dùng `aivb` / `scripts\Server.ps1`.

---

## 8. Luồng Power BI

Container publish cổng 5432 của PostgreSQL ra **5433** của host. Dùng 5433 chứ
không 5432 vì PostgreSQL 16 của Windows đang giữ `127.0.0.1:5432`.

**An toàn của việc này nằm ở `pg_hba`, không nằm ở chỗ không ai biết cổng.** Mọi
kết nối đi qua cổng publish đều tới PostgreSQL với địa chỉ nguồn `172.18.0.1`
(gateway của bridge), và `database/schema/14_pg_hba_docker.conf` chỉ cho ba vai
trò BI cùng hai nhóm lớp đi đường đó, rồi `reject` tất cả phần còn lại.

`postgres`, `aivb_owner`, `aivb_loader` và các vai trò `*_api` **không bao giờ
đăng nhập được từ ngoài**, dù có đúng mật khẩu. Thử từ máy Windows sẽ nhận:

```
FATAL: pg_hba.conf rejects connection for host "172.18.0.1", user "postgres"
```

Đó là quy tắc `pg_hba` đang chặn đúng như thiết kế, không phải lỗi cấu hình.

### Ngân sách kết nối

Mỗi học viên có trần **30 kết nối**. Trong database `scm` (nguồn dashboard Power BI)
kết nối rỗi **không** bị thu hồi; ở các database còn lại vẫn thu hồi sau **3 phút**.

Đo trên dashboard LastMile ngày 2026-09-14 bằng `sv001`:

| Cách nạp | Timeout rỗi `scm` | Đỉnh kết nối | Kết quả |
|---|---|---|---|
| song song (mặc định) | không | 47 | qua, nhưng vượt mọi trần hợp lý |
| song song | 20–60 giây | 14–20 | **chập chờn** — server cắt kết nối rỗi, Power BI dùng lại kết nối đã chết: `Exception while reading from stream` |
| **tuần tự** | không | **18–19** | qua |

**Học viên phải nạp tuần tự.** File `.pbip` của bài đã đặt sẵn; ai tự dựng file mới
thì vào Options > **Current File** > Data Load > *Parallel loading of tables* = **One**.

| Chế độ | Power BI mở bao nhiêu |
|---|---|
| Import | song song mặc định bằng **số nhân logic CPU** của máy học viên, tức 8-16 trên laptop đời mới |
| DirectQuery | *Maximum connections per data source*, mặc định tối đa **10** với Power BI Pro |

Với Import, đặt nạp **tuần tự** (xem trên). DirectQuery thì hạ số kết nối xuống **4-6**:

- **Import** nằm ở Options > Current File > Data Load > *Parallel loading of tables*
- **DirectQuery** nằm ở Options > Current File > DirectQuery > *Maximum
  connections per data source*

Hai thông báo lỗi trỏ vào hai chỗ khác nhau, đừng nhầm:

| Thông báo | Nghĩa | Xử lý |
|---|---|---|
| `too many connections for role` | vượt trần cá nhân 30 | đặt *Parallel loading of tables* = One, đóng/mở lại Power BI rồi Refresh |
| `too many connections for database` | cả lớp đang dùng hết trần chung | chờ, hoặc báo giảng viên |

Giảng viên xem ai đang giữ kết nối:

```sql
SELECT usename, state, application_name, now() - state_change AS idle
FROM pg_stat_activity WHERE usename NOT LIKE 'aivb\_%' ORDER BY usename;
```

`application_name` là `Mashup Engine` thì đó là Power BI.

---

## 9. Thay frontend

`frontend/` hiện là JS thuần. Muốn dùng React/Vue/Svelte:

1. Build ra một thư mục, phải có `index.html` ở gốc.
2. Đặt `AIVB_FRONTEND_DIR` trỏ vào đó.
3. Xong, và **không sửa dòng backend nào**.

Hợp đồng là [`backend/API_CONTRACT.md`](backend/API_CONTRACT.md). Đọc kỹ mục 9
"Rules the frontend MUST follow" trước khi viết dòng đầu tiên. Ở đó có bốn điều
frontend không được làm, và backend đã dựa vào đó (tóm tắt ở `ARCHITECTURE.md`
mục 5).

Kiểm nhanh rằng cơ chế này thật sự chạy:

```bash
mkdir /tmp/fe && echo '<h1>xin chao</h1>' > /tmp/fe/index.html
AIVB_FRONTEND_DIR=/tmp/fe uvicorn backend.main:app --port 8001
```

---

## 10. Chạy test

Chạy từ **gốc kho**, vì không có thư mục `app/` nào.

```bash
python -m pytest backend/tests -q
```

Python dùng để chạy phải có `psycopg`, `pytest`, `fastapi`, `pydantic`,
`sqlglot`, `duckdb`, `pyarrow`. Cài bằng `pip install -r docker/requirements.txt`
cộng `pytest`.

**Phần lớn test sẽ skip, và đó là đúng.** Ba nguyên nhân, không cái nào là lỗi:

- Ba database fixture (`aivb_test_hostile`, `aivb_test_student`, `aivb_test_leaky`)
  chưa dựng.
- `pg_hba` chặn `postgres` đi từ ngoài container, nên test cần quyền quản trị
  không nối được khi chạy từ máy Windows (xem mục 8). Muốn chạy chúng thì phải
  chạy từ trong mạng docker.
- `generator/` nằm ở kho `aivbank-generator-engineer` khác, nên
  `test_pg_engine_defenses.py` skip theo thiết kế.

Trên máy phát triển không dựng fixture, con số hiện tại là **164 test xanh**,
phần còn lại skip.

---

## 11. Cái gì KHÔNG nằm ở đây, và vì sao

`generator/`, `qa/`, `_workspace/` là **nhà máy sinh dữ liệu**, không phải sản
phẩm chạy. Chúng ở lại kho gốc.

Ranh giới này không phải quy ước suông. `backend/` không import gì từ chúng, nhờ
vậy kho này chuyển máy được mà không cần mang theo DuckDB, package của chủ sở
hữu, hay 39 GB dữ liệu trung gian.

Muốn **sinh lại** dữ liệu thì cần kho đầy đủ. Muốn **phục vụ** dữ liệu thì chỉ
cần thư mục này.

### Sinh bản dump mới từ máy đang chạy

```bash
python qa/verify_pg_parity.py --target student   # BẮT BUỘC chạy trước
python database/restore.py dump
```

Thứ tự này không đổi chỗ được. Dump chụp lại đúng trạng thái hiện tại, nên một
sai lệch chưa phát hiện sẽ bị đóng gói vĩnh viễn rồi nhân bản sang mọi máy sau.

---

## 12. Tab Trò chơi (game match-3)

Tab **Trò chơi** nhúng game "Vương Quốc Kẹo Ngọt" (thư mục `game/`, lấy từ
repo `kabuto-png/candy-kingdom-match3` ở commit ghi trong `game/PROVENANCE.md`).
Game là một ứng dụng đầy đủ (React + API NestJS + Redis + database riêng), nên
nó chạy thành ba service thêm trong profile compose `game`. **Tùy chọn**: không
bật thì không có service nào mới và tab tự ẩn.

```
trình duyệt ─> backend :8000 ─┬─ /game/          file tĩnh của game (build sẵn trong image backend)
                              ├─ /game-sso/token vé SSO 60 giây, dùng một lần
                              └─ /game/api/*  ──> game-api:3001 ──> PostgreSQL candy_game + redis
```

Bật trên máy đang chạy (idempotent, không cần Administrator):

```powershell
.\scripts\Enable-Game.ps1           # xem trước
.\scripts\Enable-Game.ps1 -Apply    # làm thật
```

Script sinh `pw_candy_app` (trong `config\pg_secrets.env`) và `config\game.env`,
dựng database `candy_game` bằng `database/schema/18_game_database.sql`, bật
`AIVB_GAME_API_URL` + `COMPOSE_PROFILES=game`, build rồi `up -d`, cuối cùng đồng
bộ tài khoản.

**Đồng bộ tài khoản** — hai đường, cùng một hàm SQL `aivb_upsert_account`:

- Mở tab là tự đăng nhập: game xin vé SSO từ phiên AIV Bank rồi tạo/cập nhật
  tài khoản game (`account_identities.provider = 'aivb'`, `provider_subject` =
  username, vai trò student/instructor theo AIV Bank).
- Hàng loạt: `docker compose exec backend python -m backend.admin_cli game-sync`.
  `create-user` / `import-csv` cũng tự đẩy tài khoản mới sang. Tài khoản bị
  xoá hoặc khoá bên AIV Bank thì bị vô hiệu hoá bên game và mất phiên.

**Ranh giới an toàn**: `candy_app` chỉ vào được `candy_game`; cookie phiên AIV
Bank không bao giờ được chuyển sang `game-api`; chỉ `/game/*` được phép nhúng
iframe, và chỉ bởi chính origin này.

**Học viên kết nối trực tiếp** (psql / Power BI), giống Finance và Supply Chain,
bằng chính tài khoản của mình: host của server, cổng `5433`, database
`candy_game`. Quyền do `database/schema/19_game_class_access.sql` cấp qua gói
`candy_reader` cho hai nhóm `aivb_class_*`, nên tài khoản tạo mới tự có.

- Đọc được: schema `jelly_analytics` — 13 bảng dữ liệu dạy học Jelly Trail v3
  (nạp bằng `npm run data:import`) cộng người chơi thật của lớp (`user_id` bắt
  đầu bằng `aivb_`, `app_version = 'web-live'`), hai view health và
  `live_player_wallets` (số dư ví của người chơi thật).
- Không đọc được: schema `public` của game (tài khoản, hash mật khẩu, token
  phiên, IP, vé SSO, ví gốc). Phiên của lớp là chỉ đọc, `search_path =
  jelly_analytics`, `statement_timeout = 300s`.
