#!/bin/sh
# Bước phục hồi SupplyChain — thay cho `command:` nội tuyến trong docker-compose.yml.
#
# Ba việc bản gốc thiếu:
#
#   1. `10_scm_roles.sql` tạo scm_api/scm_bi/scm_loader với PASSWORD NULL (dòng 68-78)
#      và nói rõ ở mục 5 rằng mật khẩu phải đặt riêng. Không ai đặt, nên backend
#      không nối được vào `scm`.
#   2. `load_scm.py verify` LUÔN báo hỏng mục "tablespace nam ngoai Web_SQL" khi ta bỏ
#      tablespace theo đúng khuyến nghị của `11_scm_database.sql:27-36`. Đó là dương
#      tính giả đã ghi nhận ở docs/MIGRATION.md §3.3 — nhưng nó làm service thoát 1,
#      và `backend` depends_on service_completed_successfully nên sẽ không lên được.
#      Ở đây ta bỏ qua ĐÚNG mục đó, và vẫn hỏng nếu có bất kỳ mục nào khác đỏ.
#   3. `pg_restore` không idempotent: chạy lại lần hai là nhân đôi dữ liệu. Có chốt chặn.
set -e

if [ ! -f database/dumps/scm.dump ]; then
    echo "khong co database/dumps/scm.dump - bo qua bo du lieu SupplyChain"
    exit 0
fi

PGPASSWORD="$(cat /run/secrets/pg_superuser)"; export PGPASSWORD
PSQL="psql -h postgres -U postgres -v ON_ERROR_STOP=1"

# Giá trị là phần TRƯỚC dấu cách đầu tiên — cùng khuôn với backend/config.py.
# `tr -d ''` la BAT BUOC: pg_secrets.env den tu Windows va co ket thuc dong CRLF.
# Thieu no thi mat khau duoc dat KEM ky tu CR, va moi client cat CR deu xac thuc
# truot voi "password authentication failed" — mot loi khong nhin thay duoc.
secret() {
    grep -E "^$1=" /app/config/pg_secrets.env | head -1 | tr -d '' | cut -d= -f2- | cut -d' ' -f1
}

echo "== 10_scm_roles.sql =="
$PSQL -f database/schema/10_scm_roles.sql

echo "== mat khau cho 3 vai tro SCM (10_scm_roles.sql tao chung voi PASSWORD NULL) =="
for role in scm_api scm_bi scm_loader; do
    pw="$(secret "pw_$role")"
    if [ -z "$pw" ]; then
        echo "LOI: pg_secrets.env thieu khoa pw_$role" >&2
        exit 1
    fi
    $PSQL -c "ALTER ROLE $role PASSWORD '$pw'" >/dev/null
    echo "   $role: da dat mat khau"
done

echo "== 11_scm_database.sql =="
$PSQL -f database/schema/11_scm_database.sql

# Chốt chặn: chỉ nạp khi `scm.sales` chưa có dòng nào.
rows=$($PSQL -d scm -Atc "select coalesce((select count(*) from scm.sales limit 1),0)" 2>/dev/null || echo 0)
if [ "$rows" -gt 0 ]; then
    echo "== pg_restore: BO QUA, scm.sales da co $rows dong =="
else
    echo "== pg_restore scm.dump =="
    pg_restore -h postgres -U postgres -d scm --no-owner --no-privileges \
        --jobs 4 database/dumps/scm.dump
fi

echo "== 12_scm_schema_grants.sql =="
$PSQL -d scm -f database/schema/12_scm_schema_grants.sql

echo "== nghiem thu =="
out="$(AIVB_SCM_LOAD_USER=postgres python database/load_scm.py verify 2>&1)" || true
echo "$out"

that_bai="$(echo "$out" | grep '\[HONG\]' | grep -vc 'tablespace nam ngoai' || true)"
if [ "$that_bai" -gt 0 ]; then
    echo "" >&2
    echo "NGHIEM THU HONG THAT: $that_bai muc (khong tinh muc tablespace)" >&2
    exit 1
fi
echo ""
echo "NGHIEM THU DAT (muc 'tablespace nam ngoai Web_SQL' la duong tinh gia da biet)."
