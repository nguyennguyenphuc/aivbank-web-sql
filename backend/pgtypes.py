"""Doi OID kieu cua PostgreSQL sang ten kieu ma giao dien dang hieu.

Vi sao khong tra thang ten cua Postgres
---------------------------------------
Truong `column_types` di ra tan trinh duyet va duoc dung o ba cho
(`web/format.js`, `web/results.js`, `web/mart.js`):
  - `NUMERIC_TYPE_RE` quyet dinh cot nao can can phai va nhom chu so hang nghin;
  - dau moi cot in ten kieu cho hoc vien doc;
  - xuat CSV dua vao do de biet co duoc bo dau nhay hay khong.

`NUMERIC_TYPE_RE` hien khop TINYINT|SMALLINT|INTEGER|BIGINT|...|DECIMAL|NUMERIC
|DOUBLE|FLOAT|REAL. Ten goc cua Postgres la `int8`, `int4`, `float8` - KHONG
khop cai nao trong so do. De nguyen thi moi cot tien te VND mat can phai va mat
dau phan cach hang nghin, im lang, khong loi.

Va quan trong hon: hoc vien doc tai lieu viet BIGINT / VARCHAR / DECIMAL. Doi
sang int8 / text / numeric la bat ca lop hoc lai mot bo ten moi de doi lay
khong gi ca.

Nen o day tra ve ten theo phong cach DuckDB. Day la mot lop TUONG THICH co chu
dinh, khong phai su nham lan: PostgreSQL van la engine that, chi co nhan hien
thi la giu nguyen nhu truoc khi chuyen.
"""

from __future__ import annotations

#: OID kieu vo huong cua PostgreSQL -> ten hien thi kieu DuckDB.
#: Lay tu pg_type.oid, la hang so on dinh qua moi ban PostgreSQL.
_OID_TO_NAME: dict[int, str] = {
    16: "BOOLEAN",       # bool
    20: "BIGINT",        # int8
    21: "SMALLINT",      # int2
    23: "INTEGER",       # int4
    25: "VARCHAR",       # text
    700: "FLOAT",        # float4
    701: "DOUBLE",       # float8
    1042: "VARCHAR",     # bpchar
    1043: "VARCHAR",     # varchar
    1082: "DATE",        # date
    1083: "TIME",        # time
    1114: "TIMESTAMP",   # timestamp
    1184: "TIMESTAMPTZ", # timestamptz - KHONG duoc dung trong contract, xem duoi
    1186: "INTERVAL",    # interval
    1700: "DECIMAL",     # numeric - kem precision/scale, xem `type_name`
    2950: "UUID",        # uuid
    17: "BLOB",          # bytea
    114: "JSON",
    3802: "JSON",        # jsonb
}

_NUMERIC_OID = 1700

#: Rong - CO CHU DINH, va day la mot lan tu sua.
#:
#: Ban dau danh sach nay chua `timestamptz` (OID 1184), voi ly do "no dien giai
#: gia tri theo TimeZone cua phien nen hai nguoi o hai mui gio thay hai gia tri
#: khac nhau". Chay thu tren PostgreSQL 18 cho thay lap luan do sai o hai diem:
#:
#:   1. `date_trunc('month', DATE '2024-01-15')` tra ve timestamptz. Tong hop
#:      theo thang la mau truy van pho bien nhat trong ca khoa hoc phan tich,
#:      nen chan kieu nay la chan chinh bai giang.
#:   2. Moi phien cua API deu duoc ghim `TimeZone = UTC` va dieu do duoc DOC LAI
#:      de xac nhan o `api/db.py::Database._configure`. Ket xuat vi vay tat dinh,
#:      khong phu thuoc nguoi xem.
#:
#: Va khong cot nao trong contract co kieu timestamptz - da kiem tren ca 611
#: cot. Nen phep chan nay chan mot moi nguy khong ton tai, doi lay mot chuc nang
#: that. Bo di.
#:
#: Giu lai co che (rong) chu khong xoa han: neu ngay nao co mot kieu THUC SU
#: khong duoc phep phuc vu, day la cho de dat no.
FORBIDDEN_OIDS: frozenset[int] = frozenset()


def type_name(oid: int, precision: int | None = None, scale: int | None = None) -> str:
    """Ten kieu hien thi cho mot cot ket qua.

    `precision`/`scale` lay tu `cursor.description[i]`; chi co y nghia voi
    `numeric`. Postgres tra ve None cho ca hai khi cot la `numeric` khong khai
    tham so (vi du ket qua cua mot phep tinh) - khi do in `DECIMAL` tron, dung
    nhu DuckDB.
    """
    if oid == _NUMERIC_OID:
        if precision is not None and scale is not None:
            return f"DECIMAL({precision},{scale})"
        return "DECIMAL"
    return _OID_TO_NAME.get(oid, "VARCHAR")


def types_from_description(description) -> list[str]:
    """Danh sach ten kieu tu `cursor.description` cua psycopg.

    Tra ve [] khi cursor khong co description (vi du cau lenh khong sinh hang),
    de cho goi khong phai kiem None.
    """
    if not description:
        return []
    return [type_name(c.type_code, c.precision, c.scale) for c in description]


def assert_no_forbidden_types(description) -> None:
    """Fail-closed neu ket qua chua kieu khong duoc phep phuc vu.

    Goi o duong `/query`. Mot cot `timestamptz` lot ra la du lieu doc duoc khac
    nhau tuy mui gio cua nguoi xem - sai lech kieu khong ai bao gio bao loi.
    """
    if not description:
        return
    bad = [c.name for c in description if c.type_code in FORBIDDEN_OIDS]
    if bad:
        raise ValueError(
            f"Ket qua chua cot kieu khong duoc phep phuc vu: {bad}. "
            "Contract chi dung TIMESTAMP khong mui gio."
        )
