# Mở ra Internet bằng cách forward cổng trên router

Tài liệu này thay đường hầm SSH qua VPS bằng **port forwarding thẳng trên router nhà**,
vẫn giữ tên miền DuckDNS và vẫn giữ HTTPS.

Đường hầm cũ hoạt động vì một giả định: *"router không thuộc quyền quản trị của bạn."*
Khi giả định đó không còn đúng, cả VPS lẫn đường hầm đều thừa.

Ký hiệu dùng trong tài liệu:

| Giữ chỗ | Nghĩa | Cách lấy |
|---|---|---|
| `<DOMAIN>` | tên miền DuckDNS | `AIVB_DUCKDNS_DOMAIN` trong `duckdns.env` |
| `<TOKEN>` | token DuckDNS | `AIVB_DUCKDNS_TOKEN` — **chìa khoá DNS, đừng commit** |
| `<LAN_IP>` | IP nội bộ của máy chủ | `ipconfig` |
| `<ROUTER_IP>` | cổng mặc định | `ipconfig` → Default Gateway |
| `<WAN_IP>` | IP công khai của nhà | `curl https://api.ipify.org` |

---

## Kiến trúc sau khi đổi

```
Trình duyệt học viên
  │
  ├─ https://<DOMAIN>                DuckDNS A → <WAN_IP>  (động → cần updater)
  │
  └─ Router <ROUTER_IP>              forward TCP 443 → <LAN_IP>:443
     │
     └─ Caddy  (Windows service)     cắt TLS, chứng chỉ Let's Encrypt qua DNS-01
        │
        └─ 127.0.0.1:8000            uvicorn (--proxy-headers)
           │
           └─ 127.0.0.3:15433        PgRelay — đổi địa chỉ nguồn thành 127.0.0.2
              │
              └─ 127.0.0.1:5432      PostgreSQL 18
```

So với đường hầm cũ, **chỉ hai ô ngoài cùng đổi**. Relay, uvicorn và PostgreSQL giữ nguyên
hoàn toàn, và **không phải sửa một dòng nào trong `backend/`**.

### Vì sao Caddy phải chạy cùng máy với uvicorn

`Start-Api.ps1` chạy uvicorn với `--proxy-headers --forwarded-allow-ips 127.0.0.1`.
`backend/auth.py` cố tình **bỏ qua** header `X-Forwarded-For` (nó do phía gọi đặt, mà nó
lại nuôi bộ đếm khoá tài khoản), và thay vào đó tin `request.client.host` ở tầng vận
chuyển. Điều đó chỉ đúng khi proxy nằm ở `127.0.0.1`.

Caddy chạy cùng máy nên `--forwarded-allow-ips 127.0.0.1` **vẫn đúng nguyên**, IP thật của
học viên vẫn vào đúng nhật ký và đúng bộ đếm khoá. Nếu đem Caddy sang máy khác trong LAN
thì phải sửa cờ đó thành IP của máy Caddy — và phải chắc không ai khác trong LAN giả mạo
được nó.

### Vì sao vẫn phải có HTTPS

Cookie phiên mang tiền tố `__Host-` khi `AIVB_COOKIE_SECURE=1`. **Trình duyệt từ chối
cookie `__Host-` trên HTTP thuần**, và triệu chứng là: đăng nhập thành công, không báo lỗi
gì cả, nhưng màn hình vẫn như chưa đăng nhập.

Ngoài ra `Start-Api.ps1` dòng 81-86 sẽ **chặn khởi động** nếu `AIVB_COOKIE_SECURE` khác `1`
hoặc `AIVB_CORS_ORIGINS` không phải đúng một origin `https://`. Bỏ TLS không phải là một
tuỳ chọn mà bạn có thể chọn im lặng — launcher sẽ không cho.

---

## Bước 0 — Kiểm xem mạng nhà có forward được không

**Làm bước này trước tiên.** Nếu nó hỏng thì mọi bước sau đều vô ích.

```powershell
curl https://api.ipify.org        # IP mà Internet nhìn thấy
ipconfig                          # IP nội bộ và Default Gateway
```

Đăng nhập trang quản trị router (`http://<ROUTER_IP>`) và tìm mục **WAN / Internet**.
So sánh **WAN IP mà router báo** với kết quả `api.ipify.org`:

| Kết quả | Nghĩa | Làm gì |
|---|---|---|
| Hai giá trị **trùng nhau** | Có IP công khai thật | Đi tiếp |
| Router báo `100.64.x.x` – `100.127.x.x` | **CGNAT** | Forward cổng **không bao giờ chạy**. Xin ISP cấp IP tĩnh (thường có phí), hoặc giữ đường hầm |
| Router báo `10.x` / `172.16-31.x` / `192.168.x` | Double NAT hoặc CGNAT | Tìm modem cấp trên, chuyển nó sang bridge mode; nếu không được thì như trên |

> Trên máy hiện tại có dấu hiệu đáng ngờ: `tracert 8.8.8.8` cho hop 3 là một địa chỉ công
> khai của một ISP, hop 4 lại là `10.254.210.243` — địa chỉ riêng. Điều đó **chưa chứng
> minh** có CGNAT, nhưng đủ để bắt buộc phải kiểm ở trang router trước khi làm gì tiếp.

**Kiểm thứ hai: ISP có chặn cổng 443 vào không.** Nhiều gói dân dụng ở Việt Nam chặn 80 và
443 chiều vào. Cách kiểm nhanh, chạy trên máy chủ:

```powershell
# mở một listener tạm trên 443, rồi từ điện thoại 4G thử nối tới <WAN_IP>:443
python -c "import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',443));s.listen(1);print('dang nghe 443...');c,a=s.accept();print('CO KET NOI TU',a);c.close()"
```

Sau khi đã cấu hình forward ở bước 4, từ **mạng 4G** (không phải Wi-Fi nhà) chạy
`Test-NetConnection <WAN_IP> -Port 443`. Nếu không thông trong khi mọi cấu hình đều đúng
thì ISP đang chặn.

**Nếu 443 bị chặn:** dùng cổng lẻ. Forward `8443` ngoài → `443` trong, và học viên gõ
`https://<DOMAIN>:8443`. Khi đó phải sửa `AIVB_CORS_ORIGINS` thành
`https://<DOMAIN>:8443` cho khớp — sai một chữ là trình duyệt chặn mọi lời gọi API.
Cổng 80 **không cần** vì cách xin chứng chỉ ở đây là DNS-01, không phải HTTP-01.

---

## Bước 1 — Siết PostgreSQL lại trước khi mở bất kỳ cổng nào

Đây là bước quan trọng nhất trong cả tài liệu.

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "SHOW listen_addresses"
```

Nếu kết quả là `*`, PostgreSQL đang nghe trên **mọi** giao diện mạng, kể cả IP LAN. Hôm nay
điều đó tương đối vô hại vì router chưa mở cổng nào vào. **Khoảnh khắc bạn mở cổng ở bước
4, nó thành lỗ hổng thật** — và nó sẽ không gây ra triệu chứng nào để bạn nhận ra.

Sửa `C:\Program Files\PostgreSQL\18\data\postgresql.conf`:

```
listen_addresses = '127.0.0.1,127.0.0.2'
```

Bổ sung dòng còn thiếu vào `pg_hba.conf` (xem `docs/MIGRATION.md` §3.4 cho danh sách đầy đủ):

```
host    scm    scm_bi    127.0.0.2/32    scram-sha-256
```

Rồi **restart**, không phải reload — `listen_addresses` chỉ được đọc lúc khởi động:

```powershell
Restart-Service postgresql-x64-18
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "SHOW listen_addresses"
netstat -ano | Select-String ":5432"     # chỉ được thấy 127.0.0.1 và 127.0.0.2
```

Nếu `netstat` còn hiện `0.0.0.0:5432` thì **dừng lại**, đừng đi tiếp.

---

## Bước 2 — DuckDNS: trỏ tên miền về nhà, và giữ nó đúng

Bản ghi A hiện đang trỏ về VPS. Đổi nó về `<WAN_IP>`:

```powershell
.\scripts\Update-DuckDns.ps1
```

Script đọc `C:\ProgramData\AIVBank\config\duckdns.env`, tự phát hiện IP công khai và gọi
API DuckDNS. Chạy `-WhatIf` để xem trước mà không đổi gì.

**IP nhà là IP động.** ISP đổi nó bất cứ lúc nào — thường sau khi mất điện hoặc router khởi
động lại. Khi đó tên miền trỏ vào một địa chỉ của người khác và cả lớp mất truy cập, không
có cảnh báo nào. Đường hầm cũ miễn nhiễm với chuyện này vì IP của VPS là tĩnh; forward cổng
thì không.

Vì vậy phải cài updater chạy nền:

```powershell
# chạy trong PowerShell có quyền Administrator
$repo = "D:\Giang-day\Soan bai\Project DA\Web_SQL"
$act  = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$repo\scripts\Update-DuckDns.ps1`""
$trg  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)
$prc  = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
Register-ScheduledTask -TaskName "AIVBank-DuckDNS" -Action $act -Trigger $trg -Principal $prc
```

Kiểm sau vài phút:

```powershell
Get-Content C:\ProgramData\AIVBank\logs\duckdns.log -Tail 5
nslookup <DOMAIN> 8.8.8.8
```

DNS có bộ nhớ đệm. Sau khi đổi bản ghi, chờ vài phút và kiểm bằng `8.8.8.8` thay vì DNS của
ISP — DNS của ISP thường giữ giá trị cũ lâu hơn.

---

## Bước 3 — Caddy: cắt TLS ở nhà

VPS dùng nginx + certbot. Ở nhà dùng Caddy vì nó tự xin và tự gia hạn chứng chỉ, không cần
cron, và cấu hình gọn hơn nhiều.

### 3.1 Tải bản Caddy **có module DuckDNS**

Bản Caddy mặc định **không** có module DNS của DuckDNS, và không có nó thì không xin được
chứng chỉ bằng DNS-01.

Vào <https://caddyserver.com/download>, chọn:

- Platform: **windows / amd64**
- Thêm package: **`github.com/caddy-dns/duckdns`**

Tải file `.exe`, đặt vào `C:\ProgramData\AIVBank\bin\caddy.exe`. Kiểm:

```powershell
C:\ProgramData\AIVBank\bin\caddy.exe list-modules | Select-String duckdns
```

Phải thấy `dns.providers.duckdns`. Không thấy là tải nhầm bản.

### 3.2 Đặt Caddyfile

```powershell
Copy-Item deploy\Caddyfile.template C:\ProgramData\AIVBank\config\Caddyfile
notepad C:\ProgramData\AIVBank\config\Caddyfile   # thay <DOMAIN>
```

Token **không** nằm trong Caddyfile — Caddyfile đọc nó từ biến môi trường `DUCKDNS_TOKEN`,
để file cấu hình không mang bí mật và có thể đưa vào git nếu cần.

```powershell
[Environment]::SetEnvironmentVariable("DUCKDNS_TOKEN", "<TOKEN>", "Machine")
```

Kiểm cú pháp:

```powershell
C:\ProgramData\AIVBank\bin\caddy.exe validate --config C:\ProgramData\AIVBank\config\Caddyfile
```

### 3.3 Chạy Caddy như Windows service

Tunnel cũ chết mỗi lần khởi động lại máy và phải chạy tay `aivb.ps1 up`. Caddy nên chạy như
service để không thừa hưởng nhược điểm đó.

Dùng `WinSW-x64.exe` đã có sẵn ở `C:\ProgramData\AIVBank\bin\`:

```powershell
# tạo caddy.xml cạnh WinSW, rồi:
Copy-Item C:\ProgramData\AIVBank\bin\WinSW-x64.exe C:\ProgramData\AIVBank\bin\caddy-svc.exe
C:\ProgramData\AIVBank\bin\caddy-svc.exe install
Start-Service caddy
```

Nội dung `caddy-svc.xml` mẫu nằm ở `deploy\caddy-svc.xml.template`.

Lần chạy đầu, Caddy đặt một bản ghi TXT `_acme-challenge.<DOMAIN>` qua API DuckDNS, đợi
Let's Encrypt xác minh, rồi lưu chứng chỉ vào `%ProgramData%\Caddy`. Mất khoảng 30–60 giây.

```powershell
Get-Content C:\ProgramData\AIVBank\logs\caddy.log -Tail 30
```

Tìm dòng `certificate obtained successfully`. Nếu thấy lỗi DNS thì kiểm lại `DUCKDNS_TOKEN`.

> **Let's Encrypt giới hạn 5 chứng chỉ trùng tên mỗi tuần.** Đừng thử đi thử lại. Khi gỡ
> rối, thêm `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` vào Caddyfile
> để dùng môi trường thử (chứng chỉ không được trình duyệt tin, nhưng không tính hạn mức),
> rồi bỏ dòng đó đi khi đã chạy đúng.

---

## Bước 4 — Router: forward cổng

Trong trang quản trị router (`http://<ROUTER_IP>`), mục **Port Forwarding** / **Virtual
Server** / **NAT**:

| Cổng ngoài | Giao thức | IP đích | Cổng đích | Bắt buộc? |
|---|---|---|---|---|
| 443 | TCP | `<LAN_IP>` | 443 | có |
| 5432 | TCP | `<LAN_IP>` | 5432 | chỉ khi cần Power BI |

**Không forward cổng 8000.** uvicorn nghe ở `127.0.0.1:8000`, sau lưng Caddy, và nó chưa
bao giờ được thiết kế để hứng lưu lượng Internet trực tiếp.

**Không forward cổng 80.** DNS-01 không cần nó. Đánh đổi: học viên gõ `<DOMAIN>` trần
(không có `https://`) sẽ bị treo tới lúc timeout thay vì được chuyển hướng. Nếu điều đó
gây phiền và ISP không chặn 80, forward thêm 80 → 80 và Caddy sẽ tự chuyển hướng sang HTTPS.

**Đặt IP tĩnh cho máy chủ.** DHCP có thể cấp `<LAN_IP>` khác sau khi khởi động lại, và khi
đó forward trỏ vào máy khác. Dùng DHCP reservation theo địa chỉ MAC trong trang router, hoặc
đặt IP tĩnh trong Windows.

---

## Bước 5 — Windows Firewall

```powershell
New-NetFirewallRule -DisplayName "AIVBank HTTPS" -Direction Inbound `
    -Protocol TCP -LocalPort 443 -Action Allow -Profile Any

# chỉ khi mở Power BI ra ngoài
New-NetFirewallRule -DisplayName "AIVBank PostgreSQL" -Direction Inbound `
    -Protocol TCP -LocalPort 5432 -Action Allow -Profile Any
```

Nhớ rằng lúc này máy chủ đang phơi trực tiếp ra Internet chứ không còn nấp sau VPS. Cân
nhắc thêm:

- Tắt Remote Desktop hoặc chắc chắn nó không được forward.
- `Get-NetFirewallRule -Enabled True -Direction Inbound` — rà lại xem còn luật nào mở rộng
  hơn cần thiết không. Hiện có 12 luật `python.exe Allow / Public` cho phép **mọi cổng**
  Python mở ra ngoài; chúng thừa với kiến trúc này, và nên xoá.

---

## Bước 6 — Power BI / Excel / Tableau qua cổng 5432 (tuỳ chọn)

Bỏ qua mục này nếu chỉ cần console web.

Phải nối `<LAN_IP>:5432` vào relay ở `127.0.0.3:15433`. Windows làm được bằng `portproxy`,
không cần thêm phần mềm:

```powershell
netsh interface portproxy add v4tov4 `
    listenaddress=<LAN_IP> listenport=5432 `
    connectaddress=127.0.0.3 connectport=15433

netsh interface portproxy show v4tov4
```

> **Đừng trỏ thẳng vào 127.0.0.1:5432.** Relay tồn tại để đổi **địa chỉ nguồn** của kết nối
> thành `127.0.0.2` trước khi nối vào PostgreSQL. Đó là thứ duy nhất giúp `pg_hba.conf`
> phân biệt lưu lượng từ Internet với lưu lượng quản trị tại chỗ. Bỏ qua relay là **âm thầm
> mở lại lỗ hổng superuser**: `pg_hba` sẽ thấy mọi kết nối Internet mang địa chỉ `127.0.0.1`
> và áp dòng `host all all 127.0.0.1/32` — tức là cho phép **mọi role, mọi database**,
> superuser bao gồm. `scripts/aivb.ps1` dòng 30-32 cảnh báo đúng điều này.

Chuỗi kết nối phát cho học viên: máy chủ `<DOMAIN>`, cổng `5432`, database `aivb_student`,
người dùng `aivb_bi_student`, và **`sslmode=require`**. PostgreSQL thương lượng TLS
đầu-cuối; portproxy chỉ chuyển byte, không đọc được nội dung.

Sau khi khởi động lại máy, `portproxy` vẫn còn (nó ghi vào registry) nhưng relay thì không
— relay chỉ lên khi chạy `aivb.ps1 up`.

---

## Bước 7 — Chạy và nghiệm thu

```powershell
.\scripts\aivb.ps1 up -Router
.\scripts\aivb.ps1 status
```

`-Router` thay đường hầm bằng `Start-Edge.ps1`: cập nhật DuckDNS, rồi bảo đảm service Caddy
đang chạy. Cổng nghiệm thu **không đổi** — vẫn là `Test-Public`, vẫn hỏi
`https://<DOMAIN>/health` và vẫn đòi 200. Khác biệt duy nhất là giờ Caddy ở nhà trả lời chứ
không phải nginx trên VPS.

### Nghiệm thu — làm từ mạng 4G, không làm từ Wi-Fi nhà

Nhiều router không hỗ trợ **NAT hairpin**: từ trong LAN gọi vào IP công khai của chính mình
sẽ hỏng, dù cấu hình hoàn toàn đúng. Thử từ trong nhà rồi kết luận "hỏng" là một cái bẫy
tốn hàng giờ.

Dùng điện thoại phát 4G, hoặc bảo một người ở nơi khác chạy giúp:

```bash
curl -s https://<DOMAIN>/health          # 200, JSON có "table_count":77
curl -sI https://<DOMAIN>/ | head -1     # 200
openssl s_client -connect <DOMAIN>:443 -servername <DOMAIN> </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates
```

Chứng chỉ phải do Let's Encrypt cấp và còn hạn.

Kiểm rằng **không** mở thừa cổng nào:

```bash
nmap -Pn -p 80,443,3389,5432,8000 <WAN_IP>
```

`8000` và `3389` phải là `closed` hoặc `filtered`. Nếu `8000` mở thì router đang forward
nhầm — sửa ngay.

### Phép thử cuối, và là phép thử duy nhất phát hiện lỗi cookie

Mở trình duyệt, vào `https://<DOMAIN>`, **đăng nhập bằng một tài khoản học viên thật** và
chạy một câu SQL.

Nếu đăng nhập xong mà màn hình vẫn như chưa đăng nhập, và console trình duyệt không báo
lỗi gì, thì đó là cookie `__Host-` bị từ chối. Nguyên nhân gần như luôn là một trong hai:
trang đang chạy HTTP thay vì HTTPS, hoặc `AIVB_CORS_ORIGINS` không khớp **chính xác** URL
mà học viên đang gõ (sai `https`/`http`, thừa dấu `/` cuối, hoặc thiếu số cổng).

`curl /health` trả 200 **không** bắt được lỗi này. Chỉ có đăng nhập thật mới bắt được.

### Sau khi khởi động lại máy

PostgreSQL và Caddy là service nên tự lên. Relay và API thì không:

```powershell
.\scripts\aivb.ps1 up -Router
```

Muốn tự động hoàn toàn thì đăng ký một Scheduled Task chạy lệnh trên lúc khởi động, tương
tự task DuckDNS ở bước 2.

---

## Đường lùi

Đường hầm cũ **còn nguyên**. `Start-Tunnel.ps1`, khoá SSH, VPS và cấu hình nginx đều không
bị đụng tới. Quay lại:

```powershell
.\scripts\aivb.ps1 down
.\scripts\Update-DuckDns.ps1 -Ip <IP_CUA_VPS>    # trỏ tên miền về lại VPS
.\scripts\aivb.ps1 up                            # không có -Router
```

`AIVB_VPS_IP` trong `duckdns.env` giữ sẵn địa chỉ đó.

Nên giữ VPS ít nhất một học kỳ sau khi chuyển. Nếu ISP hoá ra có CGNAT hoặc chặn cổng vào,
đây là thứ duy nhất cứu được buổi học.

---

## Được gì, mất gì

**Được**

- Bỏ được một chặng mạng. Đường hầm qua VPS đo được khoảng 245 ms khứ hồi; học viên trong
  nước nối thẳng về sẽ thấy nhanh hơn rõ rệt, nhất là với file DuckDB-WASM 33 MB của khu
  vực SQL sandbox.
- Bớt một máy phải trả tiền và phải vá.
- Caddy chạy như service, sống qua khởi động lại — điều đường hầm chưa bao giờ làm được.

**Mất**

- **IP nhà lộ công khai.** Trước đây Internet chỉ thấy VPS. Giờ mọi học viên đều biết địa
  chỉ mạng nhà bạn, và mọi máy quét cổng tự động cũng vậy.
- **Băng thông tải lên của nhà thành nút cổ chai.** Đường dân dụng thường bất đối xứng.
  Ba mươi học viên cùng tải file WASM 33 MB là 1 GB đi ra qua đường lên của bạn.
- **Mất một lớp cách ly.** VPS từng là vùng đệm: thủng VPS vẫn còn phải qua đường hầm mới
  tới được máy chủ. Giờ không còn vùng đệm nào.
- **IP động thành điểm hỏng mới.** Xem bước 2.
- **Không còn chặn tần suất ở proxy.** `backend/API_CONTRACT.md` §12 khuyến nghị chặn
  khoảng 30 request/phút cho `POST /query` ở tầng proxy. nginx trên VPS là chỗ đặt nó.
  Caddy làm được nhưng cần plugin `caddy-ratelimit` — không bắt buộc để chạy, nhưng nên bổ
  sung sau. Giới hạn `AIVB_MAX_CONCURRENT_QUERIES` trong app bảo vệ **máy chủ**, không bảo
  vệ phần chia công bằng giữa các học viên.

---

## Bảng tra lỗi

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Tên miền không phân giải | Chưa chạy updater, hoặc DNS còn cache. Kiểm bằng `nslookup <DOMAIN> 8.8.8.8` |
| Phân giải ra IP cũ của VPS | Updater chưa chạy lần nào. Chạy tay `Update-DuckDns.ps1` |
| Timeout từ 4G, chạy được trong LAN | Router chưa forward, ISP chặn cổng, hoặc đang sau CGNAT (bước 0) |
| Chạy được từ 4G, timeout từ trong nhà | Router không hỗ trợ NAT hairpin. Bình thường. Trong LAN thì dùng `http://127.0.0.1:8000` |
| Cảnh báo chứng chỉ trong trình duyệt | Caddy đang dùng ACME staging, hoặc chưa xin được cert. Xem `caddy.log` |
| Caddy báo lỗi DNS challenge | `DUCKDNS_TOKEN` sai hoặc chưa đặt ở phạm vi Machine. Kiểm `caddy list-modules \| Select-String duckdns` |
| 502 từ Caddy | uvicorn chưa lên. `.\scripts\aivb.ps1 status` |
| Đăng nhập xong vẫn như chưa đăng nhập | Cookie `__Host-` bị từ chối — xem "phép thử cuối" ở trên |
| Power BI nối được `aivb_student` nhưng không nối được `scm` | Thiếu dòng `host scm scm_bi 127.0.0.2/32` trong `pg_hba.conf` (bước 1) |
| `aivb.ps1 up` báo thiếu `pg_source_relay.py` | Repo `Finance` chưa có mặt hoặc `-DeployRoot` sai. Xem `docs/MIGRATION.md` §1 mục 8 |
