# Mang hệ thống sang máy khác

`README.md` mở đầu bằng câu "thư mục này **tự chứa**". Câu đó **không đúng** với bản
đang chạy, và tài liệu này tồn tại để sửa lại cho đúng.

Ba thứ nằm ngoài thư mục `Web_SQL/`, và thiếu bất kỳ thứ nào thì máy mới không lên được:

- **relay** sống ở một repo khác (`Finance/deploy/windows/`),
- **env chạy thật** sống ở `C:\ProgramData\AIVBank\config\`,
- **kho mật khẩu học viên** sống ở `C:\ProgramData\AIVBank\auth\` và **không nằm trong
  bản dump nào cả**.

Cộng thêm: `database/dumps/` bị `.gitignore` chặn, nên `git clone` về sẽ **không** có
dữ liệu. Đó là chủ ý (mỗi file 0,7–1,1 GB), không phải sót.

---

## 1. Danh sách phải mang

Tổng cộng khoảng **2,7 GB** — vừa một USB.

| # | Thứ | Đường dẫn nguồn | Cỡ |
|---|---|---|---|
| 1 | `aivb_student.dump` | `Web_SQL\database\dumps\` | 959 MB |
| 2 | `aivb_instructor.dump` | `Web_SQL\database\dumps\` | 1,1 GB |
| 3 | `scm.dump` | `Web_SQL\database\dumps\` | 671 MB |
| 4 | Kho đăng nhập của lớp | `C:\ProgramData\AIVBank\auth\` | ~0,5 MB |
| 5 | Mật khẩu PostgreSQL | `C:\ProgramData\AIVBank\config\pg_secrets.env` | 638 B |
| 6 | Env chạy thật | `C:\ProgramData\AIVBank\config\api.env` | nhỏ |
| 7 | Token DuckDNS | `C:\ProgramData\AIVBank\config\duckdns.env` | nhỏ |
| 8 | Relay + launcher | `Finance\deploy\windows\` | ~90 KB |
| 9 | Mã nguồn | `git clone` từ GitHub | 46 MB |

### Vì sao từng mục

**(1)(2)(3) Ba bản dump.** Đây là toàn bộ dữ liệu. Định dạng custom (`pg_dump -Fc`), nên
phục hồi bằng `pg_restore` chứ không phải `psql`. AIV Bank tách **hai** database vật lý vì
trong dữ liệu có bảng đáp án; SupplyChain chỉ có một, cả học viên lẫn giảng viên đọc chung.

**(4) Kho đăng nhập.** `auth.sqlite3` (mã băm mật khẩu, scrypt), `gamification.sqlite3`
(điểm và bảng xếp hạng), `audit.jsonl` (nhật ký ai chạy câu gì). **Không có thứ nào trong
số này nằm trong ba bản dump** — chúng là SQLite, không phải PostgreSQL. Quên mục này thì
máy mới lên xanh hết nhưng cả lớp không ai đăng nhập được, và bạn phải tạo lại từng tài
khoản bằng `backend/admin_cli.py`.

Nhớ chép cả `auth.sqlite3-wal` và `auth.sqlite3-shm`. File `-wal` ở đây đang 459 KB trong
khi `auth.sqlite3` chỉ 4 KB — nghĩa là **gần như toàn bộ dữ liệu đang nằm trong WAL, chưa
checkpoint về file chính**. Chép mỗi `auth.sqlite3` là chép một file gần như rỗng.

Cách an toàn hơn là ép checkpoint trước khi chép, khi API đã tắt:

```powershell
.\scripts\aivb.ps1 down
sqlite3 C:\ProgramData\AIVBank\auth\auth.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 C:\ProgramData\AIVBank\auth\gamification.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"
```

**(5) `pg_secrets.env`.** Tám khoá: `pw_loader`, `pw_api_s`, `pw_api_i`, `pw_bi_s`,
`pw_bi_i`, `pw_scm_loader`, `pw_scm_api`, `pw_scm_bi`. Backend đọc chúng ở
`backend/config.py` (`Settings._pg_password`), chọn khoá theo vai trò của người đang hỏi.
Bản dump **không** mang mật khẩu role theo — `restore.py dump` chạy với `--no-owner
--no-privileges`, và `01_roles.sql` đặt mật khẩu từ chính file này. Không có nó thì restore
xong nhưng backend không nối được vào database.

Có hai bản của file này (`Web_SQL\config\` và `C:\ProgramData\AIVBank\config\`). Bản mà
production thật sự dùng là bản ở `ProgramData`, vì `api.env` dòng 32 trỏ thẳng vào đó.

**(6) `api.env`.** 48 biến `AIVB_*`. Đây là bản **production**, khác hẳn `config/app.env`
trong repo (bản dev: `AIVB_CORS_ORIGINS=http://127.0.0.1:5173`, `AIVB_COOKIE_SECURE=0`).
Lấy nhầm bản dev là hỏng đăng nhập trên HTTPS.

**(7) `duckdns.env`.** `AIVB_DUCKDNS_DOMAIN`, `AIVB_DUCKDNS_TOKEN`, `AIVB_VPS_IP`.
Token này là **chìa khoá DNS**: ai có nó đều đổi được bản ghi A của tên miền. Caddy cần
nó để xin chứng chỉ qua DNS-01 — xem `DEPLOY-ROUTER.md`.

**(8) `Finance\deploy\windows\`.** Chứa `pg_source_relay.py` (relay), `Start-Api.ps1`
(launcher ép `AIVB_COOKIE_SECURE=1` và bind loopback), `Start-Tunnel.ps1` (đường lùi).
`scripts/aivb.ps1` **hard-fail ở bước preflight** nếu không thấy `pg_source_relay.py`.

Relay cố tình không được chép vào `Web_SQL/` — `aivb.ps1` dòng 43-46 giải thích: nó là mã
liên quan tới bảo mật và có một test chạy bằng kết nối thật đo bản ở repo Finance. Hai bản
sao sẽ lệch nhau vào một ngày không ai để ý.

---

## 2. Danh sách **không** mang

| Thứ | Cỡ | Vì sao không |
|---|---|---|
| `C:\Program Files\PostgreSQL\18\data` | 39,6 GB | Cluster sống. Chép nguyên chỉ chạy nếu máy đích trùng đúng major version, đúng kiến trúc, và service đã tắt lúc chép. `pg_restore` an toàn hơn nhiều |
| `Web_SQL\var\pgdata\scm` | 9,1 GB | Chỉ là **tablespace** của database `scm`, không phải cluster. Tách khỏi `pg_control` và WAL của cluster gốc thì các trang dữ liệu trong đó vô nghĩa. `scm.dump` dựng lại toàn bộ |
| `SupplyChain\bo-du-lieu-vn-full` | 4,8 GB | Parquet nguồn. Chỉ cần nếu muốn **nạp lại từ đầu** thay vì restore |
| `Web_SQL\.venv` | 85 MB | Dựng lại bằng `pip install -r docker/requirements.txt` |
| `~\.ssh\aivb_tunnel` | nhỏ | Khoá SSH của đường hầm cũ. Chỉ cần nếu giữ đường lùi qua VPS |

---

## 3. Dựng lại trên máy mới (Windows)

### 3.1 Chuẩn bị

Cần **PostgreSQL 18** và **Python 3.11**. `scripts/setup.ps1` kiểm hai thứ này nhưng
**không cài** chúng.

```powershell
git clone https://github.com/nguyennguyenphuc/aivbank-web-sql.git Web_SQL
cd Web_SQL
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r docker\requirements.txt
```

Chép từ USB vào:

```powershell
# dữ liệu
Copy-Item <USB>\dumps\*.dump .\database\dumps\

# cấu hình và bí mật
New-Item -ItemType Directory -Force C:\ProgramData\AIVBank\config, C:\ProgramData\AIVBank\logs, C:\ProgramData\AIVBank\auth
Copy-Item <USB>\config\*.env C:\ProgramData\AIVBank\config\
Copy-Item <USB>\auth\*      C:\ProgramData\AIVBank\auth\
Copy-Item <USB>\config\pg_secrets.env .\config\

# relay (repo khác — giữ nguyên cấu trúc thư mục)
Copy-Item -Recurse <USB>\Finance\deploy "..\Finance\deploy"
```

Sửa lại đường dẫn trong `C:\ProgramData\AIVBank\config\api.env` nếu máy mới đặt repo ở ổ
khác: `AIVB_AUTH_DB_PATH`, `AIVB_AUDIT_LOG_PATH`, `AIVB_GAMIFICATION_DB_PATH`,
`AIVB_PG_PASSWORD_FILE`.

Và sửa `$DeployRoot` trong `scripts\aivb.ps1` (dòng 47) nếu repo `Finance` không nằm ở
`D:\Giang-day\Soan bai\Project DA\Finance` — hoặc truyền `-DeployRoot` mỗi lần chạy.

### 3.2 Phục hồi AIV Bank

```powershell
$env:PGPASSWORD = "<mat-khau-postgres>"
.\.venv\Scripts\python.exe database\restore.py restore
```

Lệnh này chạy `01_roles.sql`, `02_databases.sql`, `03_schema_grants.sql`, rồi `pg_restore`
cả hai database, rồi **tự nghiệm thu**: `aivb_student` đúng 77 bảng và **không** có
`meta_dirty_log` / `meta_scenario_label`; `aivb_instructor` đúng 100 bảng; `aivb.ref_branch`
đúng 12 dòng; và collation phải cho `SELECT 'a' < 'B'` ra `false`. Thiếu một mục là dừng.

> **Collation không sửa được về sau.** Database phải được tạo với
> `LOCALE_PROVIDER 'builtin' BUILTIN_LOCALE 'C'` **trước** khi restore. `pg_restore` không
> đổi được collation của database đã có. `02_databases.sql` làm đúng việc này — đừng tạo
> database bằng tay rồi restore vào.

### 3.3 Phục hồi Supply Chain — phải làm tay

`restore.py` glob `0*.sql`, nên nó **chỉ** chạy `01/02/03`. Ba script `10/11/12` của SCM
không được chạy. Đây là hành vi có thật của mã, không phải lỗi tài liệu.

**Bỏ tablespace.** `11_scm_database.sql` dòng 27-36 nói rõ tablespace chỉ hợp lý trên máy
nhiều ổ đĩa; trên máy một ổ nó vô ích, và trong Docker nó còn có hại. Không truyền
`scm_ts_path` thì script dùng tablespace mặc định.

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
& $psql -U postgres -f database\schema\10_scm_roles.sql
& $psql -U postgres -f database\schema\11_scm_database.sql
& $psql -U postgres -d scm -f database\schema\12_scm_schema_grants.sql

# đặt mật khẩu cho ba role SCM — 10_scm_roles.sql tạo chúng với PASSWORD NULL
& $psql -U postgres -c "ALTER ROLE scm_api    PASSWORD '<pw_scm_api>'"
& $psql -U postgres -c "ALTER ROLE scm_bi     PASSWORD '<pw_scm_bi>'"
& $psql -U postgres -c "ALTER ROLE scm_loader PASSWORD '<pw_scm_loader>'"

& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -U postgres -d scm `
    --no-owner --no-privileges --jobs 4 database\dumps\scm.dump

$env:AIVB_SCM_LOAD_USER = "postgres"
.\.venv\Scripts\python.exe database\load_scm.py verify
```

Ba mật khẩu phải **khớp đúng** giá trị `pw_scm_api` / `pw_scm_bi` / `pw_scm_loader` trong
`pg_secrets.env` bạn vừa chép sang.

Nghiệm thu phải cho đủ **136.586.733 dòng** trên 20 bảng, trong đó `sales` là 125.497.040
dòng chia 5 phân vùng theo năm.

> **Một mục sẽ báo hỏng, và đó là dương tính giả.** `load_scm.py verify` mục #4 kiểm rằng
> tablespace `scm_ts` nằm bên trong thư mục `Web_SQL`. Vì bạn vừa cố tình bỏ tablespace
> theo đúng khuyến nghị của `11_scm_database.sql`, mục này sẽ in
> `[HONG] tablespace nam ngoai Web_SQL`. Bỏ qua nó. **23 mục còn lại phải xanh** — nếu có
> mục thứ hai đỏ thì đó mới là hỏng thật.

### 3.4 Cấu hình PostgreSQL

Trong `C:\Program Files\PostgreSQL\18\data\postgresql.conf`:

```
listen_addresses = '127.0.0.1,127.0.0.2'
```

**Không** để `'*'`. `13_scm_pg_hba.md` dòng 98-101 nói thẳng vì sao: nới ra `*` là phơi cả
hai bộ dữ liệu ra Internet với đúng một lớp mật khẩu che. Máy nguồn hiện đang để `'*'` —
đó là một sai lệch cần sửa, không phải hình mẫu để chép theo.

Trong `pg_hba.conf`:

```
host    all               all                   127.0.0.1/32    scram-sha-256
host    aivb_student      aivb_bi_student       127.0.0.2/32    scram-sha-256
host    aivb_student      aivb_api_student      127.0.0.2/32    scram-sha-256
host    aivb_student      aivb_bi_instructor    127.0.0.2/32    scram-sha-256
host    aivb_instructor   aivb_bi_instructor    127.0.0.2/32    scram-sha-256
host    scm               scm_bi                127.0.0.2/32    scram-sha-256
```

Dòng cuối (`scm` / `scm_bi`) **thiếu trên máy nguồn**. `13_scm_pg_hba.md` dòng 64-68 yêu
cầu nó. Không có dòng đó thì Power BI nối SupplyChain chạy được qua `127.0.0.1` ở máy chủ
nhưng hỏng ngay khi đi qua relay — tức là hỏng với mọi người trừ bạn.

Đổi hai file này xong phải **restart service**, không phải reload: `listen_addresses` chỉ
được đọc lúc khởi động.

```powershell
Restart-Service postgresql-x64-18
& $psql -U postgres -c "SHOW listen_addresses"
```

### 3.5 Chạy

```powershell
.\scripts\aivb.ps1 up -Router      # hoặc -NoTunnel nếu chỉ chạy trong LAN
.\scripts\aivb.ps1 status
```

Mở `http://127.0.0.1:8000` để kiểm tại chỗ. Để mở ra Internet, đọc tiếp
[`DEPLOY-ROUTER.md`](DEPLOY-ROUTER.md).

### 3.6 Kiểm lại

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\ -q
```

Và đăng nhập thật bằng một tài khoản học viên có sẵn — đó là phép thử duy nhất chứng minh
kho `auth.sqlite3` đã sang đúng.

---

## 4. Sinh bản dump mới

Khi dữ liệu đổi và cần phát bản mới, **thứ tự này không đảo chỗ được**:

```powershell
python qa\verify_pg_parity.py --target student   # BẮT BUỘC chạy trước
python database\restore.py dump
python database\load_scm.py dump                 # nếu SCM cũng đổi
```

`restore.py dump` chụp lại đúng trạng thái hiện tại, kể cả sai lệch chưa ai phát hiện. Chạy
`verify_pg_parity.py` sau khi đã dump là vô nghĩa: sai lệch đã bị đóng gói vào file và sẽ
nhân bản sang mọi máy nhận về sau.

Ba file mới nằm ở `database\dumps\`. Chuyển bằng ổ cứng — đừng thử đưa vào git, `.gitignore`
chặn `*.dump` chính vì lý do đó.
