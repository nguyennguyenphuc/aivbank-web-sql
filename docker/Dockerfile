# Backend + frontend tĩnh. Một image dùng cho cả service `backend` lẫn bước
# `restore` một lần — cùng phụ thuộc, đỡ phải giữ hai thứ đồng bộ.

FROM python:3.11-slim

# postgresql-client: `restore.py` gọi pg_dump/pg_restore/psql thật, không tự
# viết lại logic phục hồi. Phải khớp phiên bản server (18).
# Kho apt cua Debian KHONG co postgresql-client-18, nen nhanh du phong cu
# (`|| apt-get install postgresql-client`) am tham cai ban 17 - va pg_restore 17
# TU CHOI archive v1.16 do pg_dump 18 sinh ra. Phai lay tu kho PGDG, va neu
# khong lay duoc thi DUNG BUILD, khong duoc am tham roi xuong ban thap hon.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    pg_restore --version | grep -q " 18\." || (echo "KHONG lay duoc client 18" >&2; exit 1); \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
COPY database/ /app/database/

# Không chạy bằng root: nếu ai đó thoát được ra khỏi tiến trình Python thì
# quyền họ có cũng chỉ là quyền của tài khoản này.
RUN useradd --create-home --shell /usr/sbin/nologin aivb \
 && mkdir -p /app/var/auth /app/config \
 && chown -R aivb:aivb /app/var
USER aivb

EXPOSE 8000

# `--forwarded-allow-ips` giới hạn ở proxy đứng ngay trước: nhờ vậy nhật ký
# audit ghi IP THẬT của học viên chứ không phải IP của proxy, mà vẫn không cho
# client tuỳ ý giả mạo header.
CMD ["uvicorn", "backend.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--forwarded-allow-ips", "127.0.0.1", \
     "--proxy-headers"]
