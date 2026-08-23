"""Kiem chinh sach ham PostgreSQL.

Day la phep dao nguoc quan trong nhat cua ca dot chuyen engine. Ban DuckDB suy
ra tap ham an toan TU ENGINE; lam vay tren PostgreSQL se lam nhanh fail-closed
cho `exp.Anonymous` AM THAM tro thanh fail-open cho pg_read_file, pg_ls_dir,
to_regclass, pg_get_viewdef va vai tram ham khac.

Cac test duoi day co gang PHA phep dao nguoc do theo moi huong nghi ra duoc.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend import pg_function_policy as P  # noqa: E402


# ---------------------------------------------------------------------------
# Danh sach cho phep
# ---------------------------------------------------------------------------

def test_danh_sach_doc_duoc_va_khong_rong():
    allowed = P.load_allowlist()
    assert len(allowed) > 100, "danh sach qua ngan, chac chan thieu ham co ban"
    assert all(n == n.lower() for n in allowed)


def test_ham_can_cho_day_hoc_deu_co():
    """Neu thieu, hoc vien go mot cau SQL binh thuong va bi tu choi."""
    allowed = P.load_allowlist()
    can_co = {
        "count", "sum", "avg", "min", "max", "round", "abs",
        "upper", "lower", "substr", "length", "btrim", "replace", "concat",
        "date_trunc", "date_part", "extract", "to_char",
        "row_number", "rank", "dense_rank", "lag", "lead",
        "string_agg", "array_agg", "percentile_cont",
        "generate_series", "unnest",
    }
    thieu = sorted(can_co - allowed)
    assert not thieu, f"Thieu ham co ban: {thieu}"


def test_cau_truc_ngu_phap_khong_nam_trong_danh_sach():
    """COALESCE / NULLIF / CAST / GREATEST / LEAST / TRIM / CURRENT_DATE ...

    Chung la cau truc ngu phap SQL, khong co dong nao trong pg_proc, va sqlglot
    phan giai chung thanh lop rieng chu khong phai exp.Anonymous - nen nhanh
    fail-closed khong ap cho chung. De chung o day se lam phep kiem "moi ten
    phai ton tai trong engine" that bai va dich vu khong khoi dong duoc.
    """
    allowed = P.load_allowlist()
    khong_duoc_co = {
        "coalesce", "nullif", "cast", "greatest", "least", "trim",
        "current_date", "current_time", "current_timestamp",
        "localtime", "localtimestamp",
    }
    thua = sorted(khong_duoc_co & allowed)
    assert not thua, (
        f"{thua} la cau truc ngu phap chu khong phai ham trong pg_proc; "
        "de trong danh sach se lam dich vu khong khoi dong duoc."
    )


@pytest.mark.parametrize(
    "ten",
    [
        # doc he thong tap tin
        "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
        "pg_ls_waldir", "pg_file_write",
        # large object
        "lo_import", "lo_export", "lo_get", "lo_put",
        # ra ngoai may
        "dblink", "dblink_exec", "postgres_fdw_handler",
        # do su ton tai - nguy hiem nhat vi khong he co node exp.Table
        "to_regclass", "to_regtype", "to_regproc", "to_regrole",
        "has_table_privilege", "has_column_privilege",
        # lo dinh nghia / cau hinh
        "pg_get_viewdef", "pg_get_functiondef", "current_setting", "set_config",
        "version", "current_database", "current_user", "session_user",
        # DoS / doi trang thai
        "pg_sleep", "pg_sleep_for", "pg_advisory_lock", "pg_terminate_backend",
        "nextval", "setval", "pg_notify",
        # thong ke - ho rat lon, phai chan bang tien to
        "pg_stat_file", "pg_stat_get_numscans", "pg_statio_user_tables",
        # xuat du lieu
        "query_to_xml", "table_to_xml", "schema_to_xml", "xmltable",
        # kich thuoc - do gian tiep noi dung bang bi giau
        "pg_relation_size", "pg_column_size", "pg_database_size",
    ],
)
def test_ham_nguy_hiem_bi_nhan_dien(ten):
    assert P.is_denied(ten), f"{ten} phai bi coi la nguy hiem"


@pytest.mark.parametrize(
    "ten",
    ["count", "sum", "upper", "date_trunc", "row_number", "string_agg",
     "generate_series", "unnest", "round", "regexp_replace", "percentile_cont"],
)
def test_ham_binh_thuong_khong_bi_nhan_nham(ten):
    assert not P.is_denied(ten), f"{ten} bi nhan nham la nguy hiem"


def test_khong_ten_nao_vua_cho_phep_vua_nguy_hiem():
    """Phep kiem nay cung chay luc khoi dong va lam dich vu khong len."""
    allowed = P.load_allowlist()
    va_cham = sorted(n for n in allowed if P.is_denied(n))
    assert not va_cham, f"Ten vua duoc phep vua nguy hiem: {va_cham}"


def test_file_hong_thi_nem_chu_khong_doc_bua(tmp_path):
    p = tmp_path / "bad.txt"

    p.write_text("# chi co chu thich\n\n", encoding="utf-8")
    with pytest.raises(P.FunctionPolicyError, match="rong"):
        P.load_allowlist(p)

    # ten kem tham so: gan nhu chac chan la nguoi soan hieu nham dinh dang
    p.write_text("count\npg_sleep(int)\n", encoding="utf-8")
    with pytest.raises(P.FunctionPolicyError, match="khong phai mot ten ham"):
        P.load_allowlist(p)

    with pytest.raises(P.FunctionPolicyError, match="Khong thay"):
        P.load_allowlist(tmp_path / "khong-co-file-nay.txt")


# ---------------------------------------------------------------------------
# Phep kiem luc khoi dong
# ---------------------------------------------------------------------------

class FakeConn:
    """Gia lap `conn.execute(...).fetchall()` tra ve (ten, la_srf)."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, _sql):
        return self

    def fetchall(self):
        return self._rows


def _universe(extra=()):
    """Mot 'engine' du lon de qua phep kiem ty le, gom ca ten nguy hiem that."""
    rows = [(f"ham_dem_{i}", False) for i in range(2000)]
    rows += [(n, False) for n in P.load_allowlist()]
    rows += [(n, False) for n in extra]
    return rows


def test_khoi_dong_thanh_cong_khi_danh_sach_khop_engine():
    pol = P.PgFunctionPolicy.from_connection(FakeConn(_universe()))
    assert "count" in pol.allowed
    assert "pg_read_file" not in pol.allowed
    assert len(pol.allowed) < len(pol.engine_universe) // 4


def test_ten_khong_co_trong_engine_thi_tu_choi_khoi_dong(tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("count\nham_khong_ton_tai_o_dau_ca\n", encoding="utf-8")
    with pytest.raises(P.FunctionPolicyError, match="KHONG CO trong cluster"):
        P.PgFunctionPolicy.from_connection(FakeConn(_universe()), p)


def test_ten_nguy_hiem_lot_vao_danh_sach_thi_tu_choi_khoi_dong(tmp_path):
    """Them nham mot dong phai lam dich vu KHONG LEN, khong thanh lo hong im lang."""
    p = tmp_path / "a.txt"
    p.write_text("count\nsum\npg_read_file\n", encoding="utf-8")
    with pytest.raises(P.FunctionPolicyError, match="nguy hiem"):
        P.PgFunctionPolicy.from_connection(
            FakeConn(_universe(extra=["pg_read_file"])), p)


def test_danh_sach_sinh_tu_pg_proc_thi_bi_phat_hien(tmp_path):
    """Kich ban that su dang so.

    Mot nguoi tiep nhan tuong lai doc `pg_proc` roi sinh thang file nay cho
    'day du'. Lam vay la quay ve dung cai fail-open ma ca thiet ke sinh ra de
    tranh, va no se KHONG bao loi o dau ca - tru o day.
    """
    universe = _universe()
    p = tmp_path / "a.txt"
    p.write_text("\n".join(n for n, _ in universe if not P.is_denied(n)), encoding="utf-8")
    with pytest.raises(P.FunctionPolicyError, match="qua lon"):
        P.PgFunctionPolicy.from_connection(FakeConn(universe), p)


def test_permits_fail_closed():
    pol = P.PgFunctionPolicy.from_connection(FakeConn(_universe()))
    assert pol.permits({"count"})
    assert pol.permits({"khong_biet", "sum"})       # mot ten hop le la du
    assert not pol.permits({"pg_read_file"})
    assert not pol.permits({"ham_la_hoac_khong"})
    assert not pol.permits(set())                   # khong ung vien -> tu choi


# ---------------------------------------------------------------------------
# Doi chieu voi PostgreSQL that (bo qua neu khong co ket noi)
# ---------------------------------------------------------------------------

def _live_conn():
    try:
        import psycopg

        from generator import load_postgres as loader

        return psycopg.connect(
            host="127.0.0.1", port=5432, dbname="aivb_student",
            user="aivb_api_student", password=loader.read_secret("pw_api_s"),
            connect_timeout=5, autocommit=True,
        )
    except Exception:  # noqa: BLE001
        return None


def test_doi_chieu_voi_postgres_that():
    conn = _live_conn()
    if conn is None:
        pytest.skip("khong co ket noi PostgreSQL")
    with conn:
        pol = P.PgFunctionPolicy.from_connection(conn)
        assert len(pol.engine_universe) > 2000, "pg_proc qua nho, truy van sai?"
        # Ty le phai nho. Da do tren PostgreSQL 18.3: 159/2787 = 5,7%.
        ty_le = len(pol.allowed) / len(pol.engine_universe)
        assert ty_le < 0.10, f"danh sach chiem {ty_le:.1%} engine - qua rong"
        # Nhung ham nguy hiem PHAI co that trong engine (neu khong thi test
        # tren chi dang chung minh mot dieu vo nghia).
        for n in ("pg_read_file", "pg_ls_dir", "pg_sleep", "to_regclass",
                  "current_setting", "pg_get_viewdef"):
            assert n in pol.engine_universe, f"{n} khong co trong engine?"
            assert n not in pol.allowed
