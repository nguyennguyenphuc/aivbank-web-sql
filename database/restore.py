"""Đóng gói và phục hồi database AIV Bank.

    python app/database/restore.py dump      # tạo dumps/ từ database đang chạy
    python app/database/restore.py restore   # dựng lại trên máy mới
    python app/database/restore.py verify    # chỉ kiểm, không đụng dữ liệu

===========================================================================
HAI ĐIỀU PHẢI BIẾT TRƯỚC KHI SỬA FILE NÀY
===========================================================================

1. `pg_restore` KHÔNG sửa được collation của database đích.

   Collation phải ép ngay ở `CREATE DATABASE ... BUILTIN_LOCALE 'C'`
   (`schema/02_databases.sql`). Sai collation thì `ORDER BY`, `min`/`max`,
   `LIKE` và mọi phép so sánh chuỗi ra kết quả khác — tức là đáp án chấm bài
   sai — mà **phép kiểm md5 hoàn toàn mù với nó** và vẫn báo PASS.

   Vì vậy `verify` ở đây kiểm bằng HÀNH VI (`SELECT 'a' < 'B'`), không kiểm
   bằng cách đọc metadata.

2. Bản dump chụp lại đúng trạng thái database TẠI THỜI ĐIỂM dump.

   Chạy `qa/verify_pg_parity.py` TRƯỚC khi dump. Nếu không, một sai lệch có
   sẵn sẽ được đóng gói vĩnh viễn và nhân bản sang mọi máy sau này.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
DUMP_DIR = APP_ROOT / "database" / "dumps"
SCHEMA_DIR = APP_ROOT / "database" / "schema"

#: Hình dạng bắt buộc sau khi phục hồi. Đây là hợp đồng, không phải gợi ý:
#: thiếu một mục là dừng, không cảnh báo rồi chạy tiếp.
EXPECTED = {
    "aivb_student": {
        "tables": 77,
        "must_be_absent": ["meta_dirty_log", "meta_scenario_label"],
    },
    "aivb_instructor": {
        "tables": 100,
        "must_be_absent": [],
    },
}

#: Bảng nhỏ, ổn định, dùng làm phép thử "dữ liệu có thật sự vào không".
CANARY = ("ref_branch", 12)


def _pg_bin(name: str) -> str:
    """Tìm pg_dump/pg_restore/psql, ưu tiên PATH rồi mới đến chỗ cài mặc định."""
    found = shutil.which(name)
    if found:
        return found
    for base in (
        Path(r"C:\Program Files\PostgreSQL\18\bin"),
        Path("/usr/lib/postgresql/18/bin"),
        Path("/usr/local/bin"),
    ):
        candidate = base / (name + (".exe" if os.name == "nt" else ""))
        if candidate.is_file():
            return str(candidate)
    raise SystemExit(
        f"khong tim thay {name}. Cai PostgreSQL client hoac them no vao PATH."
    )


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, text=True, capture_output=True, **kw)


def _psql_scalar(db: str, sql: str, user: str, host: str, port: str) -> str:
    out = _run([
        _pg_bin("psql"), "-h", host, "-p", port, "-U", user, "-d", db, "-Atc", sql
    ])
    if out.returncode != 0:
        raise SystemExit(f"psql loi tren {db}: {out.stderr.strip()}")
    return out.stdout.strip()


def cmd_dump(args) -> int:
    DUMP_DIR.mkdir(parents=True, exist_ok=True)
    print("NHAC: chay `python qa/verify_pg_parity.py --target student` TRUOC buoc nay.")
    print("      Dump chup lai dung trang thai hien tai - sai lech se duoc dong goi vinh vien.\n")
    for db in EXPECTED:
        target = DUMP_DIR / f"{db}.dump"
        print(f"  dang dump {db} -> {target.name}")
        out = _run([
            _pg_bin("pg_dump"), "-h", args.host, "-p", args.port, "-U", args.user,
            "-d", db, "-Fc", "--no-owner", "--no-privileges", "-f", str(target),
        ])
        if out.returncode != 0:
            print(f"    LOI: {out.stderr.strip()}", file=sys.stderr)
            return 1
        print(f"    xong, {target.stat().st_size / (1 << 30):.2f} GB")
    return 0


def cmd_restore(args) -> int:
    missing = [db for db in EXPECTED if not (DUMP_DIR / f"{db}.dump").is_file()]
    if missing:
        print(f"thieu ban dump cho: {', '.join(missing)}", file=sys.stderr)
        print(f"Dat chung vao {DUMP_DIR} - xem app/README.md.", file=sys.stderr)
        return 2

    # Schema TRUOC: `02_databases.sql` ep BUILTIN_LOCALE 'C', ma pg_restore
    # khong sua duoc sau do. Thu tu nay khong doi cho nhau duoc.
    for script in sorted(SCHEMA_DIR.glob("0*.sql")):
        print(f"  chay {script.name}")
        out = _run([
            _pg_bin("psql"), "-h", args.host, "-p", args.port, "-U", args.user,
            "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", str(script),
        ])
        if out.returncode != 0:
            print(f"    LOI: {out.stderr.strip()}", file=sys.stderr)
            return 1

    for db in EXPECTED:
        dump = DUMP_DIR / f"{db}.dump"
        print(f"  phuc hoi {db}")
        out = _run([
            _pg_bin("pg_restore"), "-h", args.host, "-p", args.port, "-U", args.user,
            "-d", db, "--no-owner", "--role", "aivb_owner", "-j", "4", str(dump),
        ])
        # pg_restore tra ve khac 0 ca khi chi co canh bao; chi coi la loi khi
        # phep nghiem thu ben duoi truot.
        if out.returncode != 0:
            print(f"    (pg_restore co canh bao, se kiem lai o buoc verify)")

    return cmd_verify(args)


def cmd_verify(args) -> int:
    print("\n=== NGHIEM THU ===")
    failures: list[str] = []

    for db, want in EXPECTED.items():
        try:
            n = int(_psql_scalar(
                db,
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
                "ON n.oid=c.relnamespace WHERE n.nspname='aivb' AND c.relkind='r';",
                args.user, args.host, args.port,
            ))
        except SystemExit as exc:
            failures.append(f"{db}: khong ket noi duoc ({exc})")
            continue

        ok = n == want["tables"]
        print(f"  [{'OK' if ok else 'XX'}] {db}: {n} bang (mong doi {want['tables']})")
        if not ok:
            failures.append(f"{db}: {n} bang thay vi {want['tables']}")

        # Collation: kiem bang HANH VI. Doc metadata khong du - xem docstring.
        collation_ok = _psql_scalar(db, "SELECT 'a' < 'B';", args.user, args.host, args.port)
        good = collation_ok == "f"
        print(f"  [{'OK' if good else 'XX'}] {db}: collation C ('a' < 'B' = {collation_ok})")
        if not good:
            failures.append(
                f"{db}: collation SAI. Phai tao lai database voi BUILTIN_LOCALE 'C' - "
                "pg_restore khong sua duoc collation sau khi database da ton tai."
            )

        table, rows = CANARY
        got = _psql_scalar(
            db, f"SELECT count(*) FROM aivb.{table};", args.user, args.host, args.port
        )
        ok = got == str(rows)
        print(f"  [{'OK' if ok else 'XX'}] {db}: aivb.{table} co {got} dong (mong doi {rows})")
        if not ok:
            failures.append(f"{db}: {table} co {got} dong thay vi {rows}")

        for absent in want["must_be_absent"]:
            found = _psql_scalar(
                db,
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n "
                f"ON n.oid=c.relnamespace WHERE n.nspname='aivb' AND c.relname='{absent}';",
                args.user, args.host, args.port,
            )
            ok = found == "0"
            print(f"  [{'OK' if ok else 'XX'}] {db}: {absent} KHONG ton tai")
            if not ok:
                failures.append(
                    f"{db}: {absent} co mat - dap an cham bai lo sang goi hoc vien"
                )

    print()
    if failures:
        print("NGHIEM THU TRUOT:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("NGHIEM THU DAT.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=["dump", "restore", "verify"])
    ap.add_argument("--host", default=os.environ.get("AIVB_PG_HOST", "127.0.0.1"))
    ap.add_argument("--port", default=os.environ.get("AIVB_PG_PORT", "5432"))
    ap.add_argument("--user", default="postgres")
    args = ap.parse_args(argv)
    return {"dump": cmd_dump, "restore": cmd_restore, "verify": cmd_verify}[args.action](args)


if __name__ == "__main__":
    raise SystemExit(main())
