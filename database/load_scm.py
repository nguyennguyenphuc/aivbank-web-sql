"""Nap bo du lieu SupplyChain vao PostgreSQL.

    python database/load_scm.py load     [--source DIR] [--only t1,t2]
    python database/load_scm.py index
    python database/load_scm.py verify
    python database/load_scm.py dump

CHAY TU PARQUET, KHONG CHAY TU CSV, o moi bang co ca hai. Muc 12 cua
`MO-TA-BO-DU-LIEU.md` noi ro: ban CSV mat kieu (`251.0` -> `251`) va cat
timestamp chang cuoi ve giay tron. Ban CSV chi ton tai de mo bang Excel.

Phu thuoc: `pyarrow` va `pandas` CHI can o duong nap nay, KHONG duoc them vao
`docker/requirements.txt`. Nguyen tac cua du an: app phuc vu du lieu thi khong
phu thuoc engine dung du lieu (xem dau file requirements.txt).
"""

from __future__ import annotations

import argparse
import io
import os
import subprocess
import sys
import time
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
DUMP_DIR = APP_ROOT / "database" / "dumps"

#: Nguon mac dinh. Doc TAI CHO, khong chep 470 MB parquet vao Web_SQL/ - thu
#: nam trong Web_SQL/ la DATABASE (tablespace o var/pgdata/scm) va BAN DUMP de
#: chuyen may, dung khuon AIV Bank: kho goc sinh du lieu, app giu dump.
DEFAULT_SOURCE = APP_ROOT.parent / "SupplyChain" / "bo-du-lieu-vn-full"

SCHEMA = "scm"
DB = os.environ.get("AIVB_SCM_DB", "scm")
HOST = os.environ.get("AIVB_PG_HOST", "127.0.0.1")
PORT = os.environ.get("AIVB_PG_PORT", "5432")
USER = os.environ.get("AIVB_SCM_LOAD_USER", "postgres")

#: Thu tu nap TON TRONG KHOA NGOAI - dimension truoc, fact sau. Doi thu tu se
#: lam FK tu choi, khong phai lam sai du lieu, nhung thong bao loi cua
#: PostgreSQL o day khong noi ro nguyen nhan la thu tu.
#:
#: (ten bang, thu muc con, so dong mong doi)
TABLES: list[tuple[str, str, int]] = [
    # --- tang 1: dimension khong phu thuoc ai ---
    ("city_geo", "", 22),
    ("warehouses", "", 3),
    ("items", "", 4_100),
    ("stores", "", 54),
    ("oil", "", 1_218),
    ("holidays", "", 350),
    ("sorting_hubs", "lastmile_v2", 6),
    ("delivery_points", "lastmile_v2", 49),
    ("event_calendar", "lastmile_v2", 34),
    # --- tang 2: mo rong 1:1 va dimension co FK ---
    ("store_attributes", "", 54),
    ("item_costs", "", 4_100),
    ("suppliers", "", 66),
    ("staffing_plan", "lastmile_v2", 4_368),
    ("warehouse_daily_ops", "lastmile_v2", 4_368),
    # --- tang 3: fact ---
    ("transactions", "", 83_488),
    ("shipments", "", 12_060),
    ("purchase_orders", "", 158_798),
    ("orders", "lastmile_v2", 1_034_195),
    ("inventory_snapshots", "", 9_782_360),
    ("sales", "", 125_497_040),
]

#: Chi tao SAU khi nap. Dung index luc COPY 125 trieu dong lam cham nhieu lan.
INDEXES: list[tuple[str, str]] = [
    # Truy van hoc vien hay viet nhat tren `sales`: mot cua hang, mot mat hang,
    # mot khoang thoi gian. `date` la khoa phan vung nen pruning lo phan con lai.
    ("idx_sales_store_item", "CREATE INDEX IF NOT EXISTS idx_sales_store_item ON scm.sales (store_nbr, item_nbr)"),
    ("idx_orders_date", "CREATE INDEX IF NOT EXISTS idx_orders_date ON scm.orders (order_date)"),
    ("idx_orders_hub", "CREATE INDEX IF NOT EXISTS idx_orders_hub ON scm.orders (dest_hub_id)"),
    ("idx_po_supplier", "CREATE INDEX IF NOT EXISTS idx_po_supplier ON scm.purchase_orders (supplier_id)"),
    ("idx_inv_ym", "CREATE INDEX IF NOT EXISTS idx_inv_ym ON scm.inventory_snapshots (ym)"),
]

BATCH_ROWS = 500_000


def _connect():
    try:
        import psycopg
    except ModuleNotFoundError:
        sys.exit(
            "Thieu psycopg. Cai bang:  .venv/Scripts/python -m pip install -r docker/requirements.txt"
        )
    if not os.environ.get("PGPASSWORD"):
        sys.exit(
            "Chua dat PGPASSWORD. Dat bien moi truong cho lan chay nay; dung ghi\n"
            "mat khau vao file trong cay thu muc - o day khong co .gitignore nao."
        )
    return psycopg.connect(host=HOST, port=PORT, dbname=DB, user=USER, autocommit=True)


def _source_file(source: Path, name: str, sub: str) -> Path:
    d = source / sub if sub else source
    pq = d / f"{name}.parquet"
    if pq.exists():
        return pq
    csv = d / f"{name}.csv"
    if csv.exists():
        return csv
    sys.exit(f"Khong tim thay nguon cho bang {name} trong {d}")


def _batches(path: Path, batch_rows: int):
    """Yield (pyarrow.Table, n_rows) tu parquet hoac csv, theo lo."""
    import pyarrow as pa
    import pyarrow.csv as pv
    import pyarrow.parquet as pq

    if path.suffix == ".parquet":
        pf = pq.ParquetFile(path)
        for rb in pf.iter_batches(batch_size=batch_rows):
            yield pa.Table.from_batches([rb]), rb.num_rows
    else:
        tbl = pv.read_csv(path)
        yield tbl, tbl.num_rows


def cmd_load(args) -> int:
    import pyarrow.csv as pv

    source = Path(args.source).resolve()
    if not source.is_dir():
        sys.exit(f"Thu muc nguon khong ton tai: {source}")

    wanted = set(args.only.split(",")) if args.only else None
    todo = [t for t in TABLES if wanted is None or t[0] in wanted]
    if wanted:
        unknown = wanted - {t[0] for t in TABLES}
        if unknown:
            sys.exit(f"Khong biet bang: {', '.join(sorted(unknown))}")

    print(f"Nguon : {source}")
    print(f"Dich  : {USER}@{HOST}:{PORT}/{DB}, schema {SCHEMA}")
    print()

    conn = _connect()
    # Chi anh huong PHIEN NAY. synchronous_commit=off danh doi do ben cua vai
    # giao dich cuoi neu may mat dien giua chung - chap nhan duoc cho mot lan
    # nap lai duoc tu dau, va no cat dang ke thoi gian nap 125 trieu dong.
    conn.execute("SET synchronous_commit = off")
    conn.execute("SET maintenance_work_mem = '1GB'")

    grand_total = 0
    t_all = time.time()

    for name, sub, expected in todo:
        path = _source_file(source, name, sub)
        t0 = time.time()
        conn.execute(f"TRUNCATE TABLE {SCHEMA}.{name} CASCADE")

        loaded = 0
        first = True
        cols_sql = ""
        with conn.cursor() as cur:
            for tbl, n in _batches(path, BATCH_ROWS):
                if first:
                    cols_sql = ", ".join(f'"{c}"' for c in tbl.column_names)
                    first = False
                buf = io.BytesIO()
                pv.write_csv(tbl, buf, pv.WriteOptions(include_header=False))
                copy_sql = (
                    f"COPY {SCHEMA}.{name} ({cols_sql}) FROM STDIN WITH (FORMAT csv)"
                )
                with cur.copy(copy_sql) as cp:
                    cp.write(buf.getvalue())
                loaded += n
                if loaded >= 1_000_000:
                    print(
                        f"  {name:22s} {loaded:>12,} / {expected:>12,}"
                        f"  ({time.time() - t0:6.1f}s)",
                        end="\r",
                        flush=True,
                    )

        dt = time.time() - t0
        ok = "OK " if loaded == expected else "SAI"
        print(f"  [{ok}] {name:22s} {loaded:>12,} dong  ({dt:6.1f}s)  <- {path.name}")
        if loaded != expected:
            print(f"        ^ mong doi {expected:,}. Kiem tra file nguon truoc khi di tiep.")
        grand_total += loaded

    print(f"\nNap xong {grand_total:,} dong trong {time.time() - t_all:.0f}s.")
    print("Buoc tiep theo:  python database/load_scm.py index")
    return 0


def cmd_index(args) -> int:
    conn = _connect()
    conn.execute("SET maintenance_work_mem = '1GB'")
    for name, sql in INDEXES:
        t0 = time.time()
        print(f"  {name:24s} ...", end="", flush=True)
        conn.execute(sql)
        print(f" {time.time() - t0:6.1f}s")
    print("  ANALYZE ...", end="", flush=True)
    t0 = time.time()
    conn.execute(f"ANALYZE")
    print(f" {time.time() - t0:6.1f}s")
    return 0


def cmd_verify(args) -> int:
    """Hop dong nghiem thu cua SupplyChain.

    Giong tinh than `restore.py verify` cua AIV Bank: thieu mot muc la HONG,
    khong phai canh bao roi chay tiep. Dem dong la phep kiem "du lieu co that
    su vao du khong" - nap thieu mot phan vung `sales` thi khong co gi khac
    bao cho biet.
    """
    conn = _connect()
    print("=== NGHIEM THU SupplyChain ===")
    bad = 0

    # 1. collation, kiem bang hanh vi (ARCHITECTURE.md muc 4)
    got = conn.execute("SELECT ('a' < 'B')").fetchone()[0]
    if got:
        print("  [HONG] collation KHONG phai C ('a' < 'B' = true)")
        bad += 1
    else:
        print("  [OK] collation C ('a' < 'B' = false)")

    # 2. du 20 bang logic
    n = conn.execute(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind IN ('r','p') AND NOT c.relispartition",
        (SCHEMA,),
    ).fetchone()[0]
    if n != len(TABLES):
        print(f"  [HONG] {n} bang (mong doi {len(TABLES)})")
        bad += 1
    else:
        print(f"  [OK] {n} bang")

    # 3. dem dong tung bang
    for name, _sub, expected in TABLES:
        got = conn.execute(f"SELECT count(*) FROM {SCHEMA}.{name}").fetchone()[0]
        if got != expected:
            print(f"  [HONG] {name}: {got:,} dong (mong doi {expected:,})")
            bad += 1
        else:
            print(f"  [OK] {name}: {got:,} dong")

    # 4. tablespace phai nam trong Web_SQL
    loc = conn.execute(
        "SELECT pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname = 'scm_ts'"
    ).fetchone()
    loc = loc[0] if loc else ""
    if str(APP_ROOT) not in loc.replace("/", "\\"):
        print(f"  [HONG] tablespace nam ngoai Web_SQL: {loc}")
        bad += 1
    else:
        print(f"  [OK] tablespace trong Web_SQL: {loc}")

    # 5. phan vung sales phai co du lieu o ca 5 nam
    rows = conn.execute(
        "SELECT c.relname, (SELECT count(*) FROM pg_class WHERE oid = c.oid) "
        "FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
        "JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'sales' ORDER BY 1"
    ).fetchall()
    empty = []
    for part, _ in rows:
        cnt = conn.execute(f"SELECT count(*) FROM {SCHEMA}.{part}").fetchone()[0]
        if cnt == 0:
            empty.append(part)
    if empty:
        print(f"  [HONG] phan vung sales rong: {', '.join(empty)}")
        bad += 1
    else:
        print(f"  [OK] ca {len(rows)} phan vung sales deu co du lieu")

    print()
    if bad:
        print(f"NGHIEM THU HONG - {bad} muc.")
        return 1
    print("NGHIEM THU DAT.")
    return 0


def cmd_dump(args) -> int:
    """Sinh ban dump de chuyen may - dung khuon AIV Bank."""
    DUMP_DIR.mkdir(parents=True, exist_ok=True)
    out = DUMP_DIR / "scm.dump"
    exe = _pg_bin("pg_dump")
    cmd = [exe, "-h", HOST, "-p", PORT, "-U", USER, "-d", DB, "-Fc", "-f", str(out)]
    print("  " + " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode == 0:
        print(f"  -> {out}  ({out.stat().st_size / 1e9:.2f} GB)")
    return r.returncode


def _pg_bin(name: str) -> str:
    """Cung chien luoc nhu restore.py:_pg_bin - PATH truoc, cho cai mac dinh sau."""
    import shutil

    found = shutil.which(name)
    if found:
        return found
    for base in (
        Path(r"C:\Program Files\PostgreSQL"),
        Path("/usr/lib/postgresql"),
        Path("/opt/homebrew/opt/postgresql@18/bin"),
    ):
        if base.is_dir():
            # Ten CHINH XAC, khong phai tien to: glob "pg_dump*" bat trung
            # `pg_dumpall`, va pg_dumpall khong nhan -Fc nen loi bao ra la
            # "illegal option -- F" chu khong phai "tim nham chuong trinh".
            for cand in sorted(base.glob(f"*/bin/{name}.exe"), reverse=True):
                return str(cand)
            for cand in sorted(base.glob(f"*/bin/{name}"), reverse=True):
                if cand.is_file():
                    return str(cand)
    sys.exit(f"Khong tim thay {name}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("load", help="COPY du lieu vao PostgreSQL")
    p.add_argument("--source", default=str(DEFAULT_SOURCE))
    p.add_argument("--only", default="", help="chi nap mot so bang, cach nhau bang dau phay")
    p.set_defaults(fn=cmd_load)

    p = sub.add_parser("index", help="tao index + ANALYZE (chay SAU load)")
    p.set_defaults(fn=cmd_index)

    p = sub.add_parser("verify", help="hop dong nghiem thu")
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser("dump", help="sinh database/dumps/scm.dump")
    p.set_defaults(fn=cmd_dump)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
