"""Chuyển kho đăng nhập từ SQLite sang PostgreSQL. Chạy MỘT LẦN.

    python database/migrate_auth_to_pg.py            # xem trước, không đổi gì
    python database/migrate_auth_to_pg.py --apply    # làm thật

===========================================================================
ĐIỀU PHẢI BIẾT TRƯỚC KHI CHẠY
===========================================================================

MỌI TÀI KHOẢN SẼ CÓ MẬT KHẨU MỚI.

`auth.sqlite3` băm mật khẩu bằng scrypt; PostgreSQL dùng SCRAM-SHA-256. Không
có phép biến đổi nào giữa hai thứ đó — mật khẩu gốc không tồn tại ở đâu để mà
băm lại. Đây là hệ quả không tránh được của việc bỏ SQLite, không phải một
thiếu sót của script này.

Script in mật khẩu mới ra MỘT LẦN. Không có cách lấy lại; mất thì reset.

CÁI GÌ ĐƯỢC CHUYỂN
  * tài khoản  -> vai trò PostgreSQL, nhóm suy từ cột `role` của SQLite
  * hồ sơ      -> `app.user_profile` (họ tên, ngày tạo, lần đăng nhập cuối)
  * điểm       -> `app.practice_*`, `app.user_rewards`, `app.user_achievements`

CÁI GÌ KHÔNG ĐƯỢC CHUYỂN
  * phiên đăng nhập — buộc đăng nhập lại là ĐÚNG, không phải thiếu sót. Phiên
    cũ gắn với mật khẩu cũ.
  * `audit.jsonl` — vẫn là file, không nằm trong phạm vi này.

Giữ nguyên file SQLite làm đường lùi cho tới khi chạy ổn một buổi.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from backend import pgroles  # noqa: E402
from backend.authstore import generate_password  # noqa: E402
from backend.config import APP_ROOT, settings  # noqa: E402

AUTH_DB = APP_ROOT / "var" / "auth" / "auth.sqlite3"
GAMI_DB = APP_ROOT / "var" / "auth" / "gamification.sqlite3"


def _admin_dsn() -> str:
    password = os.environ.get("PGPASSWORD", "")
    if not password:
        for candidate in (
            Path("/run/secrets/pg_superuser"),
            APP_ROOT / "config" / "pg_superuser.txt",
        ):
            if candidate.is_file():
                password = candidate.read_text(encoding="utf-8").strip()
                break
    if not password:
        raise SystemExit(
            "Khong tim thay mat khau superuser. Dat PGPASSWORD hoac de no o "
            "config/pg_superuser.txt."
        )
    return (
        f"host={settings.pg_host} port={settings.pg_port} dbname={settings.pg_db_app} "
        f"user=postgres password={password} sslmode={settings.pg_sslmode} "
        "connect_timeout=10"
    )


def _sqlite(path: Path) -> sqlite3.Connection:
    # `immutable=0` va mo doc-ghi: file `-wal` chi duoc doc khi mo binh thuong,
    # va gan het du lieu cua kho nay dang nam trong WAL (xem docs/MIGRATION.md
    # muc 1). Mo che do read-only se doc ra mot kho gan nhu rong.
    con = sqlite3.connect(str(path), timeout=10.0)
    con.row_factory = sqlite3.Row
    return con


def read_users() -> list[dict]:
    if not AUTH_DB.exists():
        raise SystemExit(f"khong thay {AUTH_DB}")
    con = _sqlite(AUTH_DB)
    try:
        rows = con.execute(
            "SELECT username, role, full_name, disabled, created_at, last_login_at "
            "FROM users ORDER BY username"
        ).fetchall()
    finally:
        con.close()
    return [dict(r) for r in rows]


GAMI_TABLES = (
    ("practice_events", "username, practice_date, query_hash, tables_used, query_kind, created_at"),
    ("practice_daily", "username, practice_date, successful_queries, unique_queries, stars_earned"),
    ("user_rewards", "username, stars, diamonds, current_streak, longest_streak, last_practice_date, updated_at"),
    ("user_achievements", "username, achievement_code, earned_at"),
)


def read_gamification() -> dict[str, list[tuple]]:
    if not GAMI_DB.exists():
        return {name: [] for name, _ in GAMI_TABLES}
    con = _sqlite(GAMI_DB)
    out: dict[str, list[tuple]] = {}
    try:
        for name, cols in GAMI_TABLES:
            try:
                out[name] = [tuple(r) for r in con.execute(f"SELECT {cols} FROM {name}")]
            except sqlite3.OperationalError:
                out[name] = []
    finally:
        con.close()
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="lam that (mac dinh chi xem truoc)")
    args = ap.parse_args(argv)

    users = read_users()
    gami = read_gamification()

    print(f"nguon : {AUTH_DB}")
    print(f"        {len(users)} tai khoan")
    for name, _ in GAMI_TABLES:
        print(f"        {len(gami[name]):>6} dong {name}")
    print(f"dich  : PostgreSQL {settings.pg_db_app} @ {settings.pg_host}:{settings.pg_port}")
    print()

    if not args.apply:
        print("XEM TRUOC - khong doi gi. Cac tai khoan se duoc tao:")
        for u in users:
            state = " (DA KHOA)" if u["disabled"] else ""
            print(f"  {u['username']:<20} {u['role']:<11}{state}")
        print()
        print("Chay lai voi --apply de lam that. MOI TAI KHOAN SE CO MAT KHAU MOI.")
        return 0

    dsn = _admin_dsn()
    issued: list[tuple[str, str, str]] = []

    with psycopg.connect(dsn, autocommit=True) as con:
        for u in users:
            name = pgroles.normalise_username(u["username"])
            role = (u["role"] or "STUDENT").upper()
            if role not in pgroles.GROUP_OF_ROLE:
                print(f"  BO QUA {name}: vai tro la {role!r}")
                continue
            try:
                password = generate_password()
                pgroles.ensure_role(con, name, role, password)
                if u["disabled"]:
                    pgroles.set_disabled(con, name, True)
                con.execute(
                    "INSERT INTO app.user_profile "
                    "(username, full_name, must_change_password, created_at, last_login_at) "
                    "VALUES (%s,%s,true,%s,%s) "
                    "ON CONFLICT (username) DO UPDATE SET "
                    "full_name = EXCLUDED.full_name, last_login_at = EXCLUDED.last_login_at",
                    (name, u["full_name"] or "", u["created_at"] or "", u["last_login_at"]),
                )
                issued.append((name, role, password))
                print(f"  OK  {name} ({role})")
            except pgroles.RoleError as exc:
                print(f"  BO QUA {name}: {exc}")

        # `assert_no_leak` sau khi cap phat hang loat: mot vai tro hoc vien lot
        # vao nhom giang vien la doc duoc bang dap an cham bai, va khong co
        # trieu chung nao khac bao dieu do.
        pgroles.assert_no_leak(con)

        print()
        for name, cols in GAMI_TABLES:
            rows = gami[name]
            if not rows:
                continue
            holes = ",".join(["%s"] * len(cols.split(",")))
            with con.cursor() as cur:
                cur.executemany(
                    f"INSERT INTO app.{name} ({cols}) VALUES ({holes}) ON CONFLICT DO NOTHING",
                    rows,
                )
            print(f"  chuyen {len(rows):>6} dong -> app.{name}")

    if issued:
        print()
        print("=" * 72)
        print("MAT KHAU MOI - chep ngay, khong lay lai duoc.")
        print("Moi tai khoan phai doi mat khau o lan dang nhap dau tien.")
        print("Dung cho CA console web LAN Power BI.")
        print("=" * 72)
        width = max(len(r[0]) for r in issued)
        for name, role, password in issued:
            print(f"  {name.ljust(width)}  {role:<11}  {password}")
        print("=" * 72)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
