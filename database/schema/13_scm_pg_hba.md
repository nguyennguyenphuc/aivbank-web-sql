# SupplyChain — làn kết nối cho Power BI

Đây **không phải** file chạy được. `pg_hba.conf` nằm trong data directory của
PostgreSQL, ngoài `Web_SQL/`, nên nó không thể là một script trong dự án này.
File này ghi lại **chính xác** những dòng cần thêm, để bước cấp phát đó thôi
không còn là kiến thức truyền miệng.

## Vì sao có làn riêng

Cluster này tách hai làn bằng **hai địa chỉ loopback**:

| Địa chỉ | Ai dùng | Luật |
|---|---|---|
| `127.0.0.1` | backend FastAPI, công cụ quản trị | `host all all 127.0.0.1 scram-sha-256` |
| `127.0.0.2` | **Excel · Power BI · Tableau** | một dòng cho mỗi cặp (database, role) |

Làn BI hẹp theo từng cặp là có chủ ý. `ARCHITECTURE.md` mục 3 nói rõ: người dùng
BI **đi vòng qua `guard.py`**, nên với họ biên an ninh chỉ còn role + GRANT +
`pg_hba`. Một dòng `host all all` cho làn BI sẽ xoá mất tầng cuối cùng đó.

Luật hiện có (đọc từ `pg_hba_file_rules`, 2026-08-20):

```
host  aivb_student     aivb_bi_student      127.0.0.2  scram-sha-256
host  aivb_student     aivb_bi_instructor   127.0.0.2  scram-sha-256
host  aivb_instructor  aivb_bi_instructor   127.0.0.2  scram-sha-256
```

Chú ý `aivb_bi_instructor` có mặt ở **cả hai** database, còn `aivb_bi_student`
chỉ có ở database học viên — đúng nguyên tắc "ít quyền hơn, không bao giờ nhiều
hơn".

### `127.0.0.2` đến từ RELAY, không phải từ việc nối tới địa chỉ đó

Đây là chỗ dễ hiểu nhầm, và tôi đã hiểu nhầm một lần. Nối **thẳng** tới
`127.0.0.2` không tạo ra nguồn `127.0.0.2`:

```
$ psql "host=127.0.0.2 dbname=postgres user=postgres" -c "SELECT inet_client_addr()"
 127.0.0.1/32          <-- vẫn là .1, và superuser VÀO ĐƯỢC
```

Windows dùng `127.0.0.1` làm địa chỉ **nguồn** cho mọi đích `127.0.0.x`, còn
`pg_hba` khớp theo nguồn. Chính vì vậy mới có
`Finance/deploy/windows/pg_source_relay.py`: nó `bind()` nguồn vào `127.0.0.2`
**trước khi** `connect()`, nên PostgreSQL mới nhìn thấy đúng.

Đường đi thật của lưu lượng internet:

```
ssh -R  →  127.0.0.3:15433  →  [relay, nguồn 127.0.0.2]  →  127.0.0.1:5432
quản trị cục bộ  ─────────────────────────────────────────→  127.0.0.1:5432
```

Hai hệ quả cho SupplyChain:

1. **Phép thử "superuser phải bị từ chối" chỉ có nghĩa khi đi qua relay.** Chạy
   nó bằng cách nối thẳng vào `127.0.0.2` sẽ cho kết quả sai và làm người ta
   tưởng hệ thống thủng.
2. **Thiếu dòng dưới đây thì `scm_bi` bị từ chối qua đường hầm** — Power BI chạy
   được ở máy phát triển (qua `127.0.0.1`) nhưng hỏng với học viên ở nhà. Hỏng
   theo hướng an toàn, nhưng vẫn là hỏng.

## Cần thêm cho SupplyChain

```
host  scm  scm_bi  127.0.0.2  scram-sha-256
```

Một dòng, một cặp. SupplyChain chỉ có một database và một vai trò BI, vì bộ dữ
liệu này không có bảng đáp án để phải tách đôi (xem `ARCHITECTURE.md` mục 2b).

Đặt dòng này **trước** bất kỳ dòng `reject` nào, rồi nạp lại:

```sql
SELECT pg_reload_conf();
```

Kiểm bằng chính đường mà Power BI sẽ đi:

```bash
psql "host=127.0.0.2 dbname=scm user=scm_bi sslmode=require" -c "SELECT count(*) FROM scm.stores"
```

## Chuỗi kết nối cho Power BI

Trên **cùng máy** với PostgreSQL:

| Trường | Finance Banking | Supply Chain |
|---|---|---|
| Server | `127.0.0.2` | `127.0.0.2` |
| Database | `aivb_student` (hoặc `aivb_instructor`) | `scm` |
| Người dùng | `aivb_bi_student` / `aivb_bi_instructor` | `scm_bi` |
| Mật khẩu | `pw_bi_s` / `pw_bi_i` trong `config/pg_secrets.env` | `pw_scm_bi` |
| SSL | `require` — `ssl = on` đã bật trên cluster | như trên |

**Từ máy khác thì hiện chưa nối được**, và đó là mặc định đúng:
`listen_addresses = 127.0.0.1,127.0.0.2` nghĩa là PostgreSQL không nhận kết nối
từ ngoài máy. Muốn mở cho lớp học thì đi qua **SSH tunnel** hoặc một reverse
proxy có TLS, đừng nới `listen_addresses` ra `*` — làm vậy là phơi cả hai bộ dữ
liệu ra Internet với đúng một lớp mật khẩu che.

## Vì sao vai trò BI có hạn mức khác vai trò API

Power BI kéo cả bảng về để dựng mô hình, không chạy một câu `SELECT` ngắn như học
viên trên web. Với 125 triệu dòng `sales`, hồ sơ API (`statement_timeout` 20s,
`temp_file_limit` 2GB) sẽ cắt giữa chừng và thông báo chỉ nói "canceling
statement", không nói rằng giới hạn đặt sai chỗ. Hồ sơ BI — 300s, `work_mem`
128MB, `temp_file_limit` 8GB — nằm trong `10_scm_roles.sql` và khớp với hồ sơ
`aivb_bi_*` đang chạy.
