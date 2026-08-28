"""Chuoi ket noi QUAN TRI (co CREATEROLE), giai quyet o MOT cho duy nhat.

Truoc day luat nay co ba ban chep tay:

  - `admin_cli._admin_conninfo` - day du,
  - `tests/conftest._admin_dsn_or_skip` - thieu `AIVB_PG_SUPERUSER_FILE`,
  - `tests/ops_http` - chi doc DUNG mot bien `AIVB_ADMIN_DSN`, ma khong cho nao
    trong kho dat bien do. Ket qua la `AuthStore._admin()` bao "can quyen quan
    tri vai tro (CREATEROLE)" - dung, nhung khong noi THIEU CAI GI.

Backend phuc vu web co y KHONG dung module nay: no khong bao gio can
CREATEROLE. Hoc vien tu doi mat khau bang `ALTER ROLE CURRENT_USER`, thao tac
ma moi vai tro deu lam duoc voi chinh no.
"""

from __future__ import annotations

import os
from pathlib import Path

from psycopg.conninfo import make_conninfo

from .config import APP_ROOT, settings

#: Thu tu tim mat khau superuser, tu cu the toi chung chung.
_SEARCH_ORDER = (
    "tham so --admin-dsn (hoac doi so `explicit`)",
    "bien moi truong AIVB_ADMIN_DSN",
    "bien moi truong PGPASSWORD",
    "file tro boi AIVB_PG_SUPERUSER_FILE",
    "/run/secrets/pg_superuser (docker secret)",
    "config/pg_superuser.txt",
)


def _superuser_password() -> str:
    password = os.environ.get("PGPASSWORD", "")
    if password:
        return password
    for candidate in (
        Path(os.environ.get("AIVB_PG_SUPERUSER_FILE", "")),
        Path("/run/secrets/pg_superuser"),
        APP_ROOT / "config" / "pg_superuser.txt",
    ):
        if candidate and str(candidate) != "." and candidate.is_file():
            found = candidate.read_text(encoding="utf-8-sig").strip()
            if found:
                return found
    return ""


def admin_conninfo(
    explicit: str | None = None, *, required: bool = True
) -> str | None:
    """Chuoi ket noi co CREATEROLE, hoac None khi `required=False` va khong thay.

    `make_conninfo` chu khong noi chuoi tay: mat khau superuser doc tu file va
    hoan toan co the chua khoang trang, ma DSN kieu keyword/value thi tach bang
    khoang trang va khoa trung lan CUOI thang. Xem `Settings._pg_dsn`.
    """
    if explicit:
        return explicit
    from_env = os.environ.get("AIVB_ADMIN_DSN", "").strip()
    if from_env:
        return from_env
    password = _superuser_password()
    if not password:
        if not required:
            return None
        raise SystemExit(
            "Khong tim thay mat khau superuser PostgreSQL. Da thu, theo thu tu:\n"
            + "\n".join(f"  {i}. {src}" for i, src in enumerate(_SEARCH_ORDER, 1))
        )
    return make_conninfo(
        host=settings.pg_host,
        port=settings.pg_port,
        dbname=settings.pg_db_app,
        user=os.environ.get("AIVB_PG_SUPERUSER", "postgres"),
        password=password,
        sslmode=settings.pg_sslmode,
        connect_timeout=settings.pg_connect_timeout_s,
    )
