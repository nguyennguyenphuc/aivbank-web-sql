"""Sinh hop dong cot cho bo du lieu SupplyChain.

    python database/make_scm_contract.py

Doc cau truc THAT tu PostgreSQL roi ghi ra
`backend/contract/scm-column-contract.json` theo dung dinh dang ma
`backend/catalog.py::load_contract_visibility` doc.

VI SAO SINH TU DATABASE, KHONG VIET TAY
    Hop dong cot cua AIV Bank (655 KB) do goi cua chu so huu sinh ra, va no
    mang mot thong tin that: cot nao la dap an cham bai. SupplyChain khong co
    thong tin do - dap an cua no nam o `labs/vn/*.py`, `outputs/` va muc
    6.7/10 cua data dictionary, tuc la FILE chu khong phai COT. Nen o day
    "moi cot deu thay duoc" khong phai la mot mac dinh luoi bieng: no la mo ta
    dung cua bo du lieu nay.

    Sinh tu database co mot tinh chat quan trong hon viet tay: hop dong khong
    the troi khoi cau truc that. Neu ai do them mot bang, chay lai file nay va
    bang do xuat hien; con neu quen chay lai thi `catalog.py` se coi bang moi
    la BI HAN CHE (fail closed), khong phai la duoc phep.

NEU VE SAU CO COT CAN GIAU
    Sua `RESTRICTED` o duoi. Nhung doc ARCHITECTURE.md muc 2 truoc: giau bang
    cach KHONG DUA VAO database van tot hon giau bang phan quyen, vi mot cot
    bi tu choi va mot cot khong ton tai tra ve hai ma loi khac nhau, va hoc
    vien doc duoc su khac biet do.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
OUT = APP_ROOT / "backend" / "contract" / "scm-column-contract.json"

SCHEMA = os.environ.get("AIVB_DS_SCM_SCHEMA", "scm")
DB = os.environ.get("AIVB_DS_SCM_DB_STUDENT", "scm")
HOST = os.environ.get("AIVB_PG_HOST", "127.0.0.1")
PORT = os.environ.get("AIVB_PG_PORT", "5432")
USER = os.environ.get("AIVB_SCM_LOAD_USER", "postgres")

#: {bang: {cot, ...}} - cot KHONG duoc hoc vien thay. Rong, co chu y (xem tren).
RESTRICTED: dict[str, set[str]] = {}

#: PostgreSQL -> ten kieu theo phong cach DuckDB, dung khuon pgtypes.py. Frontend
#: (format.js) doc chinh cac ten nay de biet cot nao la so.
PG_TO_DUCK = {
    "smallint": "SMALLINT",
    "integer": "INTEGER",
    "bigint": "BIGINT",
    "real": "FLOAT",
    "double precision": "DOUBLE",
    "numeric": "DECIMAL",
    "text": "VARCHAR",
    "character varying": "VARCHAR",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
}


def main() -> int:
    try:
        import psycopg
    except ModuleNotFoundError:
        sys.exit("Thieu psycopg. Cai: .venv/Scripts/python -m pip install -r docker/requirements.txt")
    if not os.environ.get("PGPASSWORD"):
        sys.exit("Chua dat PGPASSWORD cho lan chay nay.")

    conn = psycopg.connect(host=HOST, port=PORT, dbname=DB, user=USER, autocommit=True)

    rows = conn.execute(
        """
        SELECT c.table_name, c.column_name, c.ordinal_position, c.data_type,
               c.is_nullable = 'YES' AS nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = %s AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
        """,
        (SCHEMA,),
    ).fetchall()

    # Phan vung cua `sales` la bang vat ly nhung KHONG phai bang logic - hoc
    # vien truy van `sales`, khong truy van `sales_2015`. Dua chung vao hop dong
    # se lam sidebar hien 25 bang thay vi 20 va gioi thieu chi tiet luu tru nhu
    # the no la mo hinh du lieu.
    parts = {
        r[0]
        for r in conn.execute(
            """
            SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s AND c.relispartition
            """,
            (SCHEMA,),
        ).fetchall()
    }

    pk = {}
    for tbl, col, pos in conn.execute(
        """
        SELECT c.relname, a.attname, k.ord
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = %s AND con.contype = 'p'
        ORDER BY c.relname, k.ord
        """,
        (SCHEMA,),
    ).fetchall():
        pk.setdefault(tbl, []).append(col)

    columns: list[dict] = []
    tables: dict[str, dict] = {}
    n_restricted = 0

    for table, column, pos, data_type, nullable in rows:
        if table in parts:
            continue
        hidden = column.lower() in {c.lower() for c in RESTRICTED.get(table, set())}
        if hidden:
            n_restricted += 1
        columns.append(
            {
                "table_name": table,
                "column_name": column,
                "ordinal_position": pos,
                "duckdb_type": PG_TO_DUCK.get(data_type, data_type.upper()),
                "nullable": bool(nullable),
                "pk_order": (pk.get(table, []).index(column) + 1) if column in pk.get(table, []) else None,
                "student_visibility": "RESTRICTED" if hidden else "STUDENT",
            }
        )
        t = tables.setdefault(
            table,
            {"n_columns": 0, "pk": pk.get(table, []), "student_visibility": "STUDENT"},
        )
        t["n_columns"] += 1

    doc = {
        "_meta": {
            "dataset": "scm",
            "schema": SCHEMA,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "generated_by": "database/make_scm_contract.py",
            "source": f"information_schema cua {DB}.{SCHEMA}",
            "note": (
                "Moi cot deu STUDENT. SupplyChain khong co bang dap an trong du "
                "lieu - dap an nam o labs/vn/*.py, outputs/ va muc 6.7/10 cua "
                "MO-TA-BO-DU-LIEU.md, deu la file ngoai database. Phan vung cua "
                "`sales` bi loai vi chung la chi tiet luu tru, khong phai bang "
                "logic."
            ),
        },
        "MISSING": [],
        "columns": columns,
        "tables": tables,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"  {len(tables)} bang, {len(columns)} cot ({n_restricted} bi han che)")
    print(f"  -> {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
