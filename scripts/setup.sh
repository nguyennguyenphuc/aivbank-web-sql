#!/usr/bin/env bash
#
# Dung AIV Bank tren mot may DA CO PostgreSQL 18 va Python 3.11, khong dung
# Docker.
#
#   bash app/scripts/setup.sh
#
# Script tu kiem tung buoc va DUNG NGAY khi mot buoc truot. Dung tiep sau mot
# buoc hong chi tao ra mot he thong chay duoc nhung sai - kieu hong ton thoi
# gian nhat.

set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

die() { echo "LOI: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# --- 1. Dieu kien can -------------------------------------------------------
command -v python3 >/dev/null || command -v python >/dev/null || die "khong thay Python"
PY="$(command -v python3 || command -v python)"
command -v psql >/dev/null || die "khong thay psql. Cai PostgreSQL client 18."

info "Python : $("$PY" --version)"
info "psql   : $(psql --version)"

# --- 2. Cau hinh ------------------------------------------------------------
if [[ ! -f config/app.env ]]; then
    cp config/.env.example config/app.env
    echo
    echo "Da tao config/app.env tu mau. SUA NO TRUOC KHI CHAY TIEP:"
    echo "  - AIVB_CORS_ORIGINS  = dia chi web that (bo trong = hoc vien tu xa"
    echo "                         khong dang nhap duoc, va KHONG co loi ro rang)"
    echo "  - AIVB_COOKIE_SECURE = 1 neu phuc vu qua HTTPS"
    exit 1
fi

[[ -f config/pg_secrets.env ]] || die "thieu config/pg_secrets.env (mat khau vai tro PostgreSQL)"

# --- 3. Thu vien ------------------------------------------------------------
info "cai phu thuoc"
"$PY" -m pip install --quiet -r docker/requirements.txt

# --- 4. Database ------------------------------------------------------------
if [[ -f database/dumps/aivb_student.dump ]]; then
    info "phuc hoi database tu ban dump"
    "$PY" database/restore.py restore
else
    echo
    echo "Khong thay database/dumps/aivb_student.dump."
    echo "Ban dump khong nam trong git (moi file ~1,5-2 GB). Lay tu may cu:"
    echo "    python qa/verify_pg_parity.py --target student   # BAT BUOC truoc"
    echo "    python app/database/restore.py dump"
    echo "roi chep hai file .dump sang day."
    exit 1
fi

# --- 5. Chay ----------------------------------------------------------------
echo
info "Xong. Chay backend bang:"
echo
echo "    cd $APP_ROOT"
echo "    set -a; . config/app.env; set +a"
echo "    uvicorn backend.main:app --host 127.0.0.1 --port 8000"
echo
echo "Chua co tai khoan nao thi tao truoc, neu khong khong ai dang nhap duoc:"
echo "    python -m backend.admin_cli create-user --username gv001 --role INSTRUCTOR"
