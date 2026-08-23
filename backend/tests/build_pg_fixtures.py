"""Dung hai database fixture PostgreSQL cho bo test API.

Chinh sach giong het ban DuckDB (`api/tests/build_fixtures.py`), va vi cung mot
ly do:

    `aivb_test_hostile` CO DU 100 bang, ke ca `meta_dirty_log`,
    `meta_scenario_label` va cot `raw_account_transaction.dirty_flag`, voi du
    lieu that.

Do la co y. Lop phong thu 0 - goi hoc vien khong he chua nhung thu do - bi TAT
trong fixture nay, de bo test do MOT MINH tang guard. Neu bang bi giau vang mat
khoi fixture thi "hoc vien khong doc duoc" se dung ma khong chung minh duoc gi:
no dung vi khong co gi de doc, chu khong phai vi guard lam vic.

`aivb_test_student` la doi chung: dung cach goi that duoc phat hanh.

Nap tu parquet chu khong chep tu `aivb_instructor`
--------------------------------------------------
PostgreSQL KHONG cho truy van cheo database (da do: `0A000 cross-database
references are not implemented`), nen khong the `INSERT ... SELECT` tu database
that sang fixture. Nap tu parquet cung dung con duong ma
`generator/load_postgres.py` di, nen fixture va ban that khong the lech nhau ve
kieu du lieu.

Chay
----
    python api/tests/build_pg_fixtures.py
    python api/tests/build_pg_fixtures.py --drop      # dung lai tu dau
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import psycopg  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from generator import build_pg_schema, load_postgres, pg_types  # noqa: E402
from generator.aivb import ddl  # noqa: E402
from generator.aivb.spec import Spec  # noqa: E402

SOURCE = REPO_ROOT / "_workspace" / "instructor_DO_NOT_SHIP"

HOSTILE_DB = os.environ.get("AIVB_PG_FIXTURE_HOSTILE", "aivb_test_hostile")
STUDENT_DB = os.environ.get("AIVB_PG_FIXTURE_STUDENT", "aivb_test_student")

#: Bang hoc vien duoc phep xem: guard khong quan tam bang co bao nhieu dong, nen
#: cat ngan cho nhanh.
STUDENT_ROW_CAP = int(os.environ.get("AIVB_PG_FIXTURE_STUDENT_ROWS", "2000"))
#: Bang chi danh cho giang vien: giu NHIEU HON, vi chung la muc tieu tan cong.
#:
#: Con so 120.000 khong phai tuy tien. `test_answer_key_real_data.py` doi
#: `meta_scenario_label` va `meta_dirty_log` moi bang co it nhat 100.000 dong,
#: va phep kiem do ton tai vi mot ly do dung: truoc kia hai bang nay RONG, nen
#: "truy van bi chan" va "bang khong co gi" tra ve cung mot ket qua - khong
#: phan biet duoc "guard bao ve dap an" voi "khong co dap an de bao ve".
#:
#: Van co tran, khac ban DuckDB: `fact_account_daily_balance` co 7,4 trieu dong
#: va mot fixture khong can tung ay de chung minh dieu gi.
INSTRUCTOR_ROW_CAP = int(os.environ.get("AIVB_PG_FIXTURE_INSTRUCTOR_ROWS", "120000"))


def admin_conn(dbname: str = "postgres") -> psycopg.Connection:
    pw = os.environ.get("PGPASSWORD")
    if not pw:
        raise SystemExit(
            "Dat PGPASSWORD (mat khau superuser postgres) truoc khi chay."
        )
    return psycopg.connect(
        host="127.0.0.1", port=5432, dbname=dbname, user="postgres",
        password=pw, connect_timeout=10, autocommit=True,
    )


def ensure_database(admin: psycopg.Connection, name: str, drop: bool) -> None:
    if drop:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    exists = admin.execute(
        "SELECT 1 FROM pg_database WHERE datname = %s", (name,)
    ).fetchone()
    if not exists:
        # BUILTIN_LOCALE 'C' giong ban that: DuckDB so sanh chuoi theo byte, va
        # fixture phai xu su nhu ban that hoac bo test dang do mot he khac.
        admin.execute(
            f'CREATE DATABASE "{name}" TEMPLATE template0 ENCODING \'UTF8\' '
            "LOCALE_PROVIDER 'builtin' BUILTIN_LOCALE 'C'"
        )
    admin.execute(f'ALTER DATABASE "{name}" SET lc_messages = \'C\'')
    admin.execute(f'ALTER DATABASE "{name}" SET DateStyle = \'ISO, YMD\'')
    admin.execute(f'ALTER DATABASE "{name}" SET TimeZone = \'UTC\'')
    admin.execute(f'GRANT CONNECT ON DATABASE "{name}" TO aivb_reader_student')
    admin.execute(f'GRANT CONNECT ON DATABASE "{name}" TO aivb_reader_instructor')


#: Bang can LAY MAU PHAN TANG chu khong cat N dong dau.
#:
#: Cat N dong dau lam hong chinh tinh chat ma bo test dua vao. Cu the:
#: `raw_account_transaction.dirty_flag` la dap an cham bai, va
#: `test_hostile_fixture_really_carries_the_withheld_column` doi fixture phai co
#: CA dong flagged lan unflagged - neu khong thi moi phep tu choi ben duoi deu
#: dung vi ly do sai (cot khong mang thong tin gi). Da mac loi nay mot lan: cat
#: 2000 dong dau cho ra 0 dong flagged va test do bat duoc.
STRATIFY_ON = {"raw_account_transaction": "dirty_flag"}

#: Bang phai duoc LOC theo tap khoa da lay mau o bang khac, de phep join giua
#: chung con ra ket qua. `meta_dirty_log` la dap an cua raw_account_transaction.
LINKED_TO = {"meta_dirty_log": ("raw_account_transaction", "raw_row_id")}


def _sample_stratified(pf, names, flag_col, cap):
    """Lay tối đa `cap` dong, chia deu hai nhom theo `flag_col`."""
    half = max(1, cap // 2)
    keep_true, keep_false = [], []
    for batch in pf.iter_batches(batch_size=8192, columns=names):
        idx = [batch.schema.get_field_index(n) for n in names]
        cols = [batch.column(i).to_pylist() for i in idx]
        fpos = names.index(flag_col)
        for row in zip(*cols):
            bucket = keep_true if row[fpos] else keep_false
            if len(bucket) < half:
                bucket.append(row)
        if len(keep_true) >= half and len(keep_false) >= half:
            break
    return keep_true + keep_false


def build_one(
    spec: Spec, dbname: str, target: str, row_caps: bool, drop: bool
) -> tuple[int, int]:
    with admin_conn() as admin:
        ensure_database(admin, dbname, drop)

    tables, omit = build_pg_schema.plan_for_target(spec, target)
    tbl_sql, con_sql, _ix_sql, _dropped = build_pg_schema.render(spec, target)

    split = load_postgres.visibility_split(spec)
    instructor_only = set(split.instructor_tables)

    n_rows = 0
    with admin_conn(dbname) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS aivb")
        con.execute("SET search_path = aivb")
        for stmt in load_postgres.split_statements(tbl_sql):
            con.execute(stmt)

        # Bang duoc lay mau truoc phai nap TRUOC bang lien ket voi no.
        ordered = sorted(
            tables,
            key=lambda t: (t in LINKED_TO, t not in STRATIFY_ON, t),
        )
        sampled_keys: dict[str, set] = {}

        for table in ordered:
            path = SOURCE / "parquet" / f"{table}.parquet"
            if not path.exists():
                continue
            cols = ddl.kept_columns(spec, table, omit)
            names = [c.column_name for c in cols]
            cap = (
                INSTRUCTOR_ROW_CAP if table in instructor_only else STUDENT_ROW_CAP
            ) if row_caps else None
            collist = ", ".join(f'"{n}"' for n in names)
            pf = pq.ParquetFile(path)

            flag_col = STRATIFY_ON.get(table)
            link = LINKED_TO.get(table)
            rows_out = []

            if cap and flag_col and flag_col in names:
                rows_out = _sample_stratified(pf, names, flag_col, cap)
            elif cap and link and link[0] in sampled_keys and link[1] in names:
                # Giu MOI dong khop khoa da lay mau (de phep join ra ket qua),
                # roi bo sung cho du cap.
                want = sampled_keys[link[0]]
                kpos = names.index(link[1])
                extra = []
                for batch in pf.iter_batches(batch_size=8192, columns=names):
                    idx = [batch.schema.get_field_index(n) for n in names]
                    colsl = [batch.column(i).to_pylist() for i in idx]
                    for row in zip(*colsl):
                        if row[kpos] in want:
                            rows_out.append(row)
                        elif len(extra) < cap:
                            extra.append(row)
                rows_out.extend(extra[: max(0, cap - len(rows_out))])

            with con.cursor() as cur, cur.copy(
                f'COPY aivb."{table}" ({collist}) FROM STDIN (FORMAT BINARY)'
            ) as cp:
                cp.set_types([pg_types.pg_copy_type(c.duckdb_type) for c in cols])
                if rows_out:
                    for row in rows_out:
                        cp.write_row(row)
                    written = len(rows_out)
                else:
                    written = 0
                    for batch in pf.iter_batches(batch_size=8192, columns=names):
                        idx = [batch.schema.get_field_index(n) for n in names]
                        colsl = [batch.column(i).to_pylist() for i in idx]
                        for row in zip(*colsl):
                            cp.write_row(row)
                            written += 1
                            if cap and written >= cap:
                                break
                        if cap and written >= cap:
                            break

            # Ghi lai khoa da lay mau cho bang lien ket phia sau.
            if table in STRATIFY_ON and rows_out:
                key = "raw_row_id"
                if key in names:
                    kpos = names.index(key)
                    sampled_keys[table] = {r[kpos] for r in rows_out}
            n_rows += written

        # Chi PK va index. KHONG dung FK: fixture cat ngan tung bang doc lap nen
        # tham chieu khong con toan ven - va guard khong he quan tam den FK.
        for stmt in load_postgres.split_statements(con_sql):
            if " FOREIGN KEY " in stmt or stmt.strip().upper().startswith("ANALYZE"):
                continue
            try:
                con.execute(stmt)
            except psycopg.errors.UniqueViolation:
                # Cat ngan co the lam mot UNIQUE khong con dung tren tap con.
                # Bo qua co bao cao chu khong im lang.
                print(f"    bo qua (cat ngan lam vo rang buoc): "
                      f"{' '.join(stmt.split())[:70]}")
        con.execute("ANALYZE")

        # Quyen doc cho vai tro test.
        con.execute("GRANT USAGE ON SCHEMA aivb TO aivb_reader_student, aivb_reader_instructor")
        con.execute(
            "GRANT SELECT ON ALL TABLES IN SCHEMA aivb TO "
            "aivb_reader_student, aivb_reader_instructor"
        )
    return len(tables), n_rows


LEAKY_DB = os.environ.get("AIVB_PG_FIXTURE_LEAKY", "aivb_test_leaky")


def build_leaky(spec: Spec, drop: bool) -> None:
    """Database thu ba, mang MOT moi nguy cu the: view thong ngam.

    Mot VIEW mang ten duoc phep (`ref_branch`) nhung ben duoi lai SELECT tu
    `meta_dirty_log` se tuon dap an qua mot cai ten ma guard chap nhan. Tang
    truy cap phai phat hien va THU HOI ten do luc khoi dong.

    Dat moi nguy nay vao mot database rieng chu khong vao `aivb_test_hostile`:
    o day phai DROP bang `ref_branch` that de dat view trung ten, va lam vay se
    lam sai so bang cua fixture kia (100), pha cac test khac.
    """
    with admin_conn() as admin:
        ensure_database(admin, LEAKY_DB, drop)

    with admin_conn(LEAKY_DB) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS aivb")
        con.execute("SET search_path = aivb")
        con.execute('DROP VIEW IF EXISTS aivb."ref_branch"')
        for t in ("core_party", "meta_dirty_log", "ref_branch"):
            con.execute(f'DROP TABLE IF EXISTS aivb."{t}" CASCADE')
        for t in ("core_party", "meta_dirty_log"):
            cols = ddl.kept_columns(spec, t, {})
            body = ",\n  ".join(
                f'"{c.column_name}" {pg_types.pg_type(c.duckdb_type)}' for c in cols
            )
            con.execute(f'CREATE TABLE aivb."{t}" (\n  {body}\n)')
        # Ten hoan toan vo hai trong allowlist, noi dung thi khong.
        con.execute('CREATE VIEW aivb."ref_branch" AS SELECT * FROM aivb."meta_dirty_log"')
        con.execute(
            "GRANT USAGE ON SCHEMA aivb TO aivb_reader_student, aivb_reader_instructor"
        )
        con.execute(
            "GRANT SELECT ON ALL TABLES IN SCHEMA aivb TO "
            "aivb_reader_student, aivb_reader_instructor"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--drop", action="store_true", help="Xoa va dung lai tu dau")
    ap.add_argument("--full", action="store_true", help="Khong cat ngan bang nao")
    args = ap.parse_args()

    if not (SOURCE / "parquet").exists():
        raise SystemExit(f"Khong thay {SOURCE / 'parquet'}")

    spec = Spec()
    for dbname, target in ((HOSTILE_DB, "instructor"), (STUDENT_DB, "student")):
        t0 = time.time()
        n_tables, n_rows = build_one(
            spec, dbname, target, row_caps=not args.full, drop=args.drop
        )
        print(f"{dbname:22s} {n_tables:3d} bang  {n_rows:9,d} dong  "
              f"{time.time() - t0:6.1f}s")

    t0 = time.time()
    build_leaky(spec, drop=args.drop)
    print(f"{LEAKY_DB:22s}   2 bang + 1 view thong ngam  {time.time() - t0:6.1f}s")

    print()
    print("Fixture da san sang. Bo test tro toi chung qua bien moi truong:")
    print(f"  AIVB_PG_FIXTURE_HOSTILE={HOSTILE_DB}")
    print(f"  AIVB_PG_FIXTURE_STUDENT={STUDENT_DB}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
