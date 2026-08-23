# Backend + frontend tĩnh. Một image dùng cho cả service `backend` lẫn bước
# `restore` một lần — cùng phụ thuộc, đỡ phải giữ hai thứ đồng bộ.

FROM python:3.11-slim

# postgresql-client: `restore.py` gọi pg_dump/pg_restore/psql thật, không tự
# viết lại logic phục hồi. Phải khớp phiên bản server (18).
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 curl ca-certificates \
 || (apt-get install -y --no-install-recommends postgresql-client curl ca-certificates) \
 && rm -rf /var/lib/apt/lists/*

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
