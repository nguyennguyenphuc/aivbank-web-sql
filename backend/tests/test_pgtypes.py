"""Kiem lop doi ten kieu PostgreSQL -> ten hien thi kieu DuckDB.

Truong `column_types` di ra tan trinh duyet va quyet dinh ba thu o
`web/format.js`, `web/results.js`, `web/mart.js`: cot nao can phai va nhom chu
so hang nghin, ten kieu in tren dau cot, va cach xuat CSV.

`NUMERIC_TYPE_RE` cua frontend khop BIGINT|INTEGER|DECIMAL|DOUBLE|... nhung
KHONG khop `int8`, `int4`, `float8` - ten goc cua Postgres. De nguyen thi moi
cot tien te VND mat can phai va mat dau phan cach, im lang, khong bao loi.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend import pgtypes  # noqa: E402

#: Ban sao NGUYEN VAN cua web/format.js:16. Neu ben do doi ma ben nay khong,
#: test se van xanh trong khi giao dien da sai - nen co test rieng ben duoi
#: doi chieu hai ban voi nhau.
FRONTEND_NUMERIC_RE = re.compile(
    r"^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER"
    r"|UBIGINT|UHUGEINT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)",
    re.I,
)


@pytest.mark.parametrize(
    "oid, expected",
    [
        (20, "BIGINT"),       # int8
        (23, "INTEGER"),      # int4
        (21, "SMALLINT"),     # int2
        (25, "VARCHAR"),      # text
        (1043, "VARCHAR"),    # varchar
        (1042, "VARCHAR"),    # bpchar
        (16, "BOOLEAN"),      # bool
        (1082, "DATE"),
        (1114, "TIMESTAMP"),
        (701, "DOUBLE"),      # float8
        (700, "FLOAT"),       # float4
    ],
)
def test_oid_thanh_ten_kieu_duckdb(oid, expected):
    assert pgtypes.type_name(oid) == expected


def test_numeric_giu_precision_va_scale():
    assert pgtypes.type_name(1700, 18, 10) == "DECIMAL(18,10)"
    assert pgtypes.type_name(1700, 12, 8) == "DECIMAL(12,8)"
    # numeric khong khai tham so (vd ket qua mot phep tinh) -> DECIMAL tron,
    # dung nhu DuckDB in ra.
    assert pgtypes.type_name(1700, None, None) == "DECIMAL"


def test_kieu_so_van_duoc_frontend_nhan_ra():
    """Day la ly do ton tai cua ca module. Kiem tra tuong minh.

    Neu mot kieu so bi doi thanh ten frontend khong nhan ra, cot tien te se hien
    can trai khong co dau phan cach - sai o giao dien nhung khong co loi nao.
    """
    so = [
        pgtypes.type_name(20),            # BIGINT - tien te VND
        pgtypes.type_name(23),            # INTEGER
        pgtypes.type_name(21),            # SMALLINT
        pgtypes.type_name(701),           # DOUBLE
        pgtypes.type_name(700),           # FLOAT
        pgtypes.type_name(1700, 18, 10),  # DECIMAL(18,10)
        pgtypes.type_name(1700, None, None),
    ]
    for t in so:
        assert FRONTEND_NUMERIC_RE.match(t), f"{t} khong duoc frontend coi la so"

    khong_phai_so = [
        pgtypes.type_name(25),    # VARCHAR
        pgtypes.type_name(16),    # BOOLEAN
        pgtypes.type_name(1082),  # DATE
        pgtypes.type_name(1114),  # TIMESTAMP
    ]
    for t in khong_phai_so:
        assert not FRONTEND_NUMERIC_RE.match(t), f"{t} bi nham la so"


def test_ban_sao_regex_khop_voi_frontend():
    """Doi chieu ban sao regex o tren voi web/format.js that.

    Neu ai do sua frontend ma khong sua o day thi test tren van xanh trong khi
    giao dien da doi hanh vi - nen phai co mot phep so sanh truc tiep.
    """
    js = (PROJECT_ROOT / "frontend" / "format.js").read_text(encoding="utf-8")
    m = re.search(r"const NUMERIC_TYPE_RE = /\^\((.+?)\)/i;", js)
    assert m, "khong tim thay NUMERIC_TYPE_RE trong web/format.js"
    ben_do = set(m.group(1).split("|"))
    ben_nay = set(FRONTEND_NUMERIC_RE.pattern.replace("^(", "").rstrip(")").split("|"))
    assert ben_do == ben_nay, (
        f"Ban sao regex da lech voi web/format.js. "
        f"Chi co ben JS: {sorted(ben_do - ben_nay)}; "
        f"chi co ben Python: {sorted(ben_nay - ben_do)}"
    )


def test_kieu_khong_biet_thi_ve_varchar_chu_khong_no():
    """Ten kieu chi dung de HIEN THI, nen mac dinh an toan la VARCHAR.

    Khac han `generator/pg_types.py`, noi mot kieu la phai lam DUNG LAI: ben do
    quyet dinh du lieu duoc luu the nao, ben nay chi quyet dinh can trai hay
    can phai.
    """
    assert pgtypes.type_name(999999) == "VARCHAR"


class FakeCol:
    def __init__(self, name, type_code, precision=None, scale=None):
        self.name = name
        self.type_code = type_code
        self.precision = precision
        self.scale = scale


def test_timestamptz_duoc_phep():
    """timestamptz KHONG bi chan - va do la mot lan tu sua co chu dinh.

    Ban dau no bi chan voi ly do "moi nguoi xem thay mot gio khac". Chay thu
    cho thay `date_trunc('month', DATE '2024-01-15')` tra ve timestamptz, tuc
    la chan no la chan mau truy van tong hop theo thang - pho bien nhat trong ca
    khoa hoc. Va ly do chan cung khong dung: moi phien API deu ghim
    `TimeZone = UTC` va dieu do duoc doc lai de xac nhan luc mo ket noi.
    """
    assert pgtypes.type_name(1184) == "TIMESTAMPTZ"
    pgtypes.assert_no_forbidden_types([FakeCol("t", 1184)])   # khong duoc nem


def test_co_che_chan_kieu_van_con_dung_duoc():
    """Danh sach cam dang rong, nhung co che phai con hoat dong."""
    pgtypes.assert_no_forbidden_types(None)
    pgtypes.assert_no_forbidden_types([FakeCol("a", 20), FakeCol("b", 1114)])

    goc = pgtypes.FORBIDDEN_OIDS
    pgtypes.FORBIDDEN_OIDS = frozenset({20})
    try:
        with pytest.raises(ValueError, match="khong duoc phep"):
            pgtypes.assert_no_forbidden_types([FakeCol("x", 20)])
    finally:
        pgtypes.FORBIDDEN_OIDS = goc


def test_types_from_description():
    assert pgtypes.types_from_description(None) == []
    assert pgtypes.types_from_description([]) == []
    assert pgtypes.types_from_description(
        [FakeCol("a", 20), FakeCol("b", 25), FakeCol("c", 1700, 12, 6)]
    ) == ["BIGINT", "VARCHAR", "DECIMAL(12,6)"]
