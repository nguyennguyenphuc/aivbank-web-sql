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

#: Vai tro truyen cho `03_schema_grants.sql`, lay nguyen van tu header cua no.
#: Mot dong cho moi database - file do co y dung chung cho ca hai.
GRANT_ROLES = {
    "aivb_student": ("aivb_reader_student", "aivb_api_student", "aivb_bi_student"),
    "aivb_instructor": ("aivb_reader_instructor", "aivb_api_instructor", "aivb_bi_instructor"),
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


def _secrets() -> dict[str, str]:
    """Doc `pg_secrets.env`: moi dong `khoa=gia-tri`, gia tri la phan TRUOC dau
    cach dau tien (phan sau la chu thich). Cung khuon ma `backend/config.py`
    (`Settings._pg_password`) dung, de hai ben khong thoat ly nhau."""
    raw = os.environ.get("AIVB_PG_PASSWORD_FILE", "")
    path = Path(raw) if raw else APP_ROOT / "config" / "pg_secrets.env"
    if not path.is_file():
        raise SystemExit(
            f"khong thay {path}. Mat khau vai tro nam o day - xem docs/MIGRATION.md muc 5."
        )
    out: dict[str, str] = {}
    # `utf-8-sig`: PowerShell ghi file nay. Voi `utf-8` thi mot BOM dinh vao
    # khoa DAU TIEN (`\ufeffpw_loader`) va khoa do bien mat khong mot loi bao.
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        cleaned = value.strip().split(" ", 1)[0]
        # Gia tri rong bi BO QUA chu khong luu chuoi rong: `REQUIRED_SECRETS`
        # ben duoi se bao thieu khoa, thay vi de mot mat khau rong di tiep.
        if cleaned:
            out[key.strip()] = cleaned
    return out


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


#: Thu tu ap luoc do. TUONG MINH chu khong glob.
#:
#:   - `0*.sql` cu bo sot 14/15/16, va hau qua la mot may moi dung len khong co
#:     nhom lop, khong co `aivb_app`, khong co `aivb_app_rw`: DANG NHAP WEB CHET
#:     trong khi `/health` van tra 200 (no chi doc dataset).
#:   - `*.sql` thi nguoc lai: keo ca `10/11/12_scm_*` vao day, ma do la viec cua
#:     service `restore-scm` (docker/restore-scm.sh).
SCHEMA_PRE = ("01_roles.sql", "02_databases.sql", "03_schema_grants.sql")

#: Chay SAU `pg_restore`. Ba canh, moi canh mot ly do:
#:
#:   15 sau pg_restore  `15` dat `statement_timeout='300s'` qua
#:                      `ALTER ROLE ALL IN DATABASE aivb_student`, va khoi mien
#:                      tru chi go `default_transaction_read_only`, KHONG go
#:                      timeout. `pg_restore` noi bang `postgres` nen khong duoc
#:                      mien: mot COPY/CREATE INDEX tren `core_gl_entry` 24,9
#:                      trieu hang vuot 300s se bi huy giua chung. Day chinh la
#:                      cai bay trong "cu noi glob ra cho du".
#:   16 sau 15          `16` cap CONNECT cho hai nhom lop ma `15` tao ra.
#:   01 LAN HAI         `01` dat nam mat khau ha tang vo dieu kien, ma verifier
#:                      SCRAM duoc tinh MOT LAN luc dat. Chay `01` o pha PRE bam
#:                      chung o 4096 vong; chay lai sau `15` (da nang
#:                      `scram_iterations` len 100000) bam lai cho dung. Nam cau
#:                      `ALTER ROLE`, idempotent hoan toan. KHONG gi khac dong
#:                      khe nay, va no khong co trieu chung nao.
SCHEMA_POST = ("15_class_roles.sql", "01_roles.sql", "16_app_database.sql")

#: Khung database cua game (tab Tro choi). TUY CHON: chi chay khi
#: `pg_secrets.env` co khoa `pw_candy_app`, de mot may chua bat game van
#: `restore` duoc nhu cu. Bang cua game do service `game-migrate` tao.
#: 19 mo `jelly_analytics` (chi doc) cho lop hoc, giong lane SCM.
SCHEMA_GAME = ("18_game_database.sql", "19_game_class_access.sql")
GAME_SECRET = "pw_candy_app"

#: Khoa bat buoc phai co trong `pg_secrets.env` truoc khi chay `restore`.
REQUIRED_SECRETS = (
    "pw_loader", "pw_api_s", "pw_api_i", "pw_bi_s", "pw_bi_i", "pw_app_rw",
)


def _runs_for(script: str, secrets: dict) -> list:
    """(database, [(bien psql, gia tri)]) cho moi lan chay mot script.

    Vai script duoc THAM SO HOA bang bien psql, va `03` con phai chay MOT LAN
    CHO MOI DATABASE - xem header cua chinh cac file. Chay tat ca voi
    `-d postgres` va khong bien nao thi hong ca hai duong: `:'pw_loader'` thanh
    loi cu phap duoi `ON_ERROR_STOP`, con schema `aivb` bi tao nham vao database
    `postgres` thay vi hai database that.
    """
    if script.startswith("01"):
        keys = ("pw_loader", "pw_api_s", "pw_api_i", "pw_bi_s", "pw_bi_i")
        return [("postgres", [(k, secrets[k]) for k in keys])]
    if script.startswith("03"):
        return [
            (db, list(zip(("reader", "api", "bi"), roles)))
            for db, roles in GRANT_ROLES.items()
        ]
    if script.startswith("16"):
        # `-d postgres`: chinh file tu `\connect aivb_app` ben trong no.
        return [("postgres", [("pw_app_rw", secrets["pw_app_rw"])])]
    if script.startswith("18"):
        return [("postgres", [(GAME_SECRET, secrets[GAME_SECRET])])]
    return [("postgres", [])]


def _wait_scram(args, want: int = 100000, timeout_s: float = 15.0) -> None:
    """Doi `scram_iterations` thuc su co hieu luc TRUOC khi dat mat khau.

    `15` doi tham so nay bang `ALTER SYSTEM` + `pg_reload_conf()`, ma
    `pg_reload_conf()` gui TIN HIEU cho postmaster - no khong dong bo. Phien
    psql ngay sau do van co the doc ra 4096, va luc ay `16` se bam mat khau cua
    `aivb_app_rw` o 4096 vong thay vi 100000, KHONG mot loi bao nao.
    """
    import time

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        out = _run([
            _pg_bin("psql"), "-h", args.host, "-p", args.port, "-U", args.user,
            "-d", "postgres", "-Atc", "SHOW scram_iterations",
        ])
        try:
            if int((out.stdout or "").strip()) >= want:
                return
        except ValueError:
            pass
        time.sleep(0.5)
    print("    CANH BAO: scram_iterations chua dat %d sau %.0fs" % (want, timeout_s))


def _run_scripts(args, scripts, secrets: dict) -> int:
    for name in scripts:
        script = SCHEMA_DIR / name
        if not script.is_file():
            print("    LOI: khong thay %s" % script, file=sys.stderr)
            return 1
        for db, bien in _runs_for(name, secrets):
            print("  chay %s tren %s" % (name, db))
            cmd = [
                _pg_bin("psql"), "-h", args.host, "-p", args.port, "-U", args.user,
                "-d", db, "-v", "ON_ERROR_STOP=1",
            ]
            for k, v in bien:
                cmd += ["-v", "%s=%s" % (k, v)]
            cmd += ["-f", str(script)]
            out = _run(cmd)
            if out.returncode != 0:
                print("    LOI: %s" % out.stderr.strip(), file=sys.stderr)
                return 1
        if name.startswith("15"):
            _wait_scram(args)
    return 0


def _data_loaded(args) -> bool:
    """Du lieu da vao chua - CHI hoi cau do, khong lam gi khac."""
    import contextlib
    import io

    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            return cmd_verify(args) == 0
        except SystemExit:
            return False


def cmd_restore(args) -> int:
    secrets = _secrets()
    thieu = [k for k in REQUIRED_SECRETS if k not in secrets]
    if thieu:
        print("LOI: pg_secrets.env thieu khoa %s." % thieu, file=sys.stderr)
        print("     Sinh chung tren HOST:  .\\scripts\\Apply-PgAuth.ps1 -Apply",
              file=sys.stderr)
        print("     (config/ duoc mount READ-ONLY vao moi container, nen tu trong",
              file=sys.stderr)
        print("      day khong ghi duoc. Mot may moi vi the la HAI lenh.)",
              file=sys.stderr)
        return 1

    # Schema TRUOC: `02_databases.sql` ep BUILTIN_LOCALE 'C', ma pg_restore
    # khong sua duoc sau do. Thu tu nay khong doi cho nhau duoc.
    rc = _run_scripts(args, SCHEMA_PRE, secrets)
    if rc:
        return rc

    # CHOT IDEMPOTENT - GIU DUNG MOT BUOC: `pg_restore`.
    #
    # Ban cu goi `cmd_verify` roi `return` som TRUOC CA vong lap luoc do, nen
    # sua mot script grants/roles roi chay lai `restore` khong ap gi ma van bao
    # DAT. `pg_restore` la buoc DUY NHAT khong lam lai duoc: vao mot database DA
    # CO du lieu thi lenh tao bang that bai, con lenh COPY thi khong chac - va
    # neu no chay, du lieu bi NHAN DOI. Cac script luoc do deu idempotent theo
    # thiet ke (`02` chi CREATE DATABASE ... \gexec guard NOT EXISTS; `03` drop
    # schema `public` chu KHONG phai `aivb`, roi CREATE SCHEMA IF NOT EXISTS) -
    # do la gia dinh chiu luc khien chot doi duoc xuong day.
    if _data_loaded(args):
        print("  du lieu da co (nghiem thu dat) - BO QUA pg_restore")
    else:
        missing = [db for db in EXPECTED if not (DUMP_DIR / ("%s.dump" % db)).is_file()]
        if missing:
            print("thieu ban dump cho: %s" % ", ".join(missing), file=sys.stderr)
            print("Dat chung vao %s - xem app/README.md." % DUMP_DIR, file=sys.stderr)
            return 2
        for db in EXPECTED:
            dump = DUMP_DIR / ("%s.dump" % db)
            print("  phuc hoi %s" % db)
            out = _run([
                _pg_bin("pg_restore"), "-h", args.host, "-p", args.port,
                "-U", args.user, "-d", db, "--no-owner", "--role", "aivb_owner",
                "-j", "4", str(dump),
            ])
            # pg_restore tra ve khac 0 ca khi chi co canh bao; chi coi la loi khi
            # phep nghiem thu ben duoi truot.
            if out.returncode != 0:
                print("    (pg_restore co canh bao, se kiem lai o buoc verify)")

    rc = _run_scripts(args, SCHEMA_POST, secrets)
    if rc:
        return rc

    if GAME_SECRET in secrets:
        rc = _run_scripts(args, SCHEMA_GAME, secrets)
        if rc:
            return rc
    else:
        print("  pg_secrets.env chua co %s - bo qua database game (candy_game)" % GAME_SECRET)

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
