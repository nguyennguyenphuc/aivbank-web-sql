"""Phong thu o TANG ENGINE, do bang vai tro that, khong qua tang guard.

Vi sao bo test nay ton tai
--------------------------
Duoi DuckDB, moi truy van cua hoc vien deu di qua `api/guard.py`. Do la bien
bao mat duy nhat va no rat chat.

Sau khi chuyen sang PostgreSQL, nguoi dung BI (Excel / Power BI / Tableau) ket
noi THANG vao database. Do la muc dich cua ca dot chuyen doi - nhung he qua la:

    voi ho, `api/guard.py` khong ton tai.

Bien bao mat cua ho la vai tro va GRANT cua PostgreSQL. Nhung thu do khong co
test nao trong repo cho den file nay. Moi khang dinh o day duoc do bang cach
MO MOT KET NOI THAT bang vai tro `aivb_bi_student` va thu tan cong that.

Bo qua khi khong co PostgreSQL, de bo test van chay duoc tren may chua dung
ha tang.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

psycopg = pytest.importorskip("psycopg")


def _connect(user_key: str, database: str, sslmode: str = "prefer"):
    from generator import load_postgres as loader

    users = {
        "bi_student": "aivb_bi_student",
        "bi_instructor": "aivb_bi_instructor",
        "api_student": "aivb_api_student",
    }
    secrets = {
        "bi_student": "pw_bi_s",
        "bi_instructor": "pw_bi_i",
        "api_student": "pw_api_s",
    }
    return psycopg.connect(
        host="127.0.0.1", port=5432, dbname=database,
        user=users[user_key], password=loader.read_secret(secrets[user_key]),
        sslmode=sslmode, connect_timeout=5, autocommit=True,
    )


@pytest.fixture(scope="function")
def student():
    """Ket noi MOI cho tung test - co chu dinh, khong phai cho chac.

    Mot so payload o day (`COPY ... TO '<file>'`, `COPY ... FROM PROGRAM`) dua
    ket noi vao che do COPY roi that bai giua chung; psycopg phat hien giao thuc
    lech va DONG ket noi. Voi fixture dung chung ca module thi moi test SAU do
    deu do vi "the connection is closed" - do la ket qua cua mot cai tan cong
    truoc do, khong phai cua cai dang do. Ket noi rieng cho tung test lam moi
    phep kiem doc lap voi thu tu chay.
    """
    try:
        conn = _connect("bi_student", "aivb_student")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong co PostgreSQL: {exc}")
    yield conn
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass


def _refused(conn, sql: str) -> psycopg.Error | None:
    """Chay `sql`; tra ve loi neu bi tu choi, None neu CHAY DUOC."""
    try:
        cur = conn.execute(sql)
        try:
            cur.fetchone()
        except psycopg.ProgrammingError:
            pass  # lenh khong sinh hang - van la CHAY DUOC
        return None
    except psycopg.Error as exc:
        return exc


# ---------------------------------------------------------------------------
# 1. Cach ly hai goi - dieu quan trong nhat trong ca he thong
# ---------------------------------------------------------------------------

def test_hoc_vien_khong_ket_noi_duoc_database_giang_vien():
    """Chan o TANG KET NOI, khong phai tang ung dung.

    Duoi DuckDB, viec tach goi phu thuoc `db_for_role()` tra ve doi tuong nao -
    mot loi dinh tuyen la giao nham ca file dap an. Duoi PostgreSQL, loi dinh
    tuyen chi lam hoc vien cam mot bo thong tin dang nhap khong mo noi ket noi.
    """
    for role in ("bi_student", "api_student"):
        try:
            conn = _connect(role, "aivb_instructor")
        except psycopg.OperationalError as exc:
            assert "permission denied for database" in str(exc)
            continue
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"khong co PostgreSQL: {exc}")
        conn.close()
        pytest.fail(f"{role} KET NOI DUOC vao aivb_instructor")


@pytest.mark.parametrize(
    "bang",
    ["meta_dirty_log", "meta_scenario_label", "meta_validation_result",
     "meta_generation_run", "meta_student_release",
     "mart_customer_360", "mart_bank_performance_monthly", "mart_loan_performance",
     "mart_organization_360", "mart_payroll_behavior", "mart_relationship_360",
     "fact_account_daily_balance", "fact_account_monthly_balance",
     "fact_loan_monthly_snapshot", "fact_organization_cashflow", "fact_payroll_monthly",
     "cfg_accounting_rule", "cfg_fee_rule", "cfg_interest_rule"],
)
def test_bang_giang_vien_khong_ton_tai_trong_goi_hoc_vien(student, bang):
    exc = _refused(student, f"SELECT 1 FROM aivb.{bang} LIMIT 1")
    assert exc is not None, f"{bang} DOC DUOC trong goi hoc vien"
    assert exc.sqlstate == "42P01"


def test_cot_dirty_flag_khong_ton_tai(student):
    exc = _refused(student, "SELECT dirty_flag FROM aivb.raw_account_transaction LIMIT 1")
    assert exc is not None and exc.sqlstate == "42703"
    # Bang thi van con - chi thieu dung mot cot.
    assert _refused(student, "SELECT 1 FROM aivb.raw_account_transaction LIMIT 1") is None


def test_khong_the_doc_cheo_database(student):
    exc = _refused(student, "SELECT 1 FROM aivb_instructor.aivb.meta_dirty_log")
    assert exc is not None
    # PostgreSQL tu chan: khong ho tro tham chieu cheo database.
    assert exc.sqlstate in ("0A000", "42P01", "3D000")


# ---------------------------------------------------------------------------
# 2. Doc catalog - khac biet lon nhat so voi DuckDB
# ---------------------------------------------------------------------------

def test_doc_duoc_pg_catalog_nhung_khong_thay_gi_bi_giau(student):
    """`pg_catalog` KHONG THE thu hoi: lam vay la hong psql, Power BI, moi driver.

    Nen cau hoi khong phai 'co doc duoc khong' ma 'doc ra thay gi'. Cau tra loi
    phai la: khong gi ca - vi thu can giau khong ton tai VAT LY. Do chinh la ly
    do chon hai database vat ly thay vi giau bang GRANT: neu giau bang GRANT thi
    catalog se khai ra het.
    """
    n = student.execute("SELECT count(*) FROM pg_class").fetchone()[0]
    assert n > 0, "khong doc duoc pg_class - moi truong khac du kien"

    giau = ["meta_dirty_log", "meta_scenario_label", "mart_customer_360",
            "fact_account_daily_balance", "cfg_fee_rule"]
    thay = student.execute(
        "SELECT relname FROM pg_class WHERE relname = ANY(%s)", (giau,)
    ).fetchall()
    assert thay == [], f"catalog khai ra bang bi giau: {thay}"

    thay_cot = student.execute(
        "SELECT c.relname, a.attname FROM pg_attribute a "
        "JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'dirty_flag'"
    ).fetchall()
    assert thay_cot == [], f"catalog khai ra cot bi cat: {thay_cot}"


def test_chi_thay_dung_so_bang_duoc_phep(student):
    n = student.execute(
        "SELECT count(*) FROM pg_class WHERE relnamespace='aivb'::regnamespace "
        "AND relkind='r'"
    ).fetchone()[0]
    assert n == 77, f"thay {n} bang, phai la 77"


def test_khong_co_view_nao(student):
    """View la duong vong: mot view duoc phep co the SELECT tu bang bi giau."""
    n = student.execute(
        "SELECT count(*) FROM pg_class WHERE relnamespace='aivb'::regnamespace "
        "AND relkind IN ('v','m','f')"
    ).fetchone()[0]
    assert n == 0


def test_khong_doc_duoc_mat_khau_vai_tro_khac(student):
    exc = _refused(student, "SELECT rolname, rolpassword FROM pg_authid")
    assert exc is not None and exc.sqlstate == "42501"


def test_khong_doc_duoc_noi_dung_truy_van_cua_nguoi_khac(student):
    """Thay duoc TEN phien khac (khong tranh duoc), nhung khong thay noi dung."""
    rows = student.execute(
        "SELECT query FROM pg_stat_activity WHERE usename <> current_user "
        "AND usename IS NOT NULL"
    ).fetchall()
    for (q,) in rows:
        assert q in (None, "", "<insufficient privilege>"), f"lo truy van: {q!r}"


# ---------------------------------------------------------------------------
# 3. Ghi, DDL, nang quyen
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "sql",
    [
        "CREATE TABLE aivb.hack(i int)",
        "CREATE SCHEMA hack",
        "CREATE TEMP TABLE t(i int)",
        "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
        "CREATE EXTENSION dblink",
        "CREATE EXTENSION file_fdw",
        "CREATE EXTENSION plpython3u",
        "DROP TABLE aivb.core_customer",
        "ALTER ROLE aivb_bi_student SUPERUSER",
        "GRANT CONNECT ON DATABASE aivb_instructor TO aivb_bi_student",
        "SET ROLE aivb_reader_instructor",
    ],
)
def test_ghi_va_nang_quyen_bi_chan(student, sql):
    exc = _refused(student, sql)
    assert exc is not None, f"CHAY DUOC: {sql}"


def test_tat_read_only_van_khong_ghi_duoc(student):
    """`default_transaction_read_only` KHONG phai bien phap bao mat.

    Bat ky client nao cung tu tat duoc. Thu THUC SU chan ghi la cac vai tro chi
    duoc GRANT SELECT. Test nay chung minh ca hai ve: tat duoc, va van bi chan.
    """
    assert _refused(student, "SET default_transaction_read_only = off") is None, (
        "hoc vien khong tat duoc read_only - gia dinh trong tai lieu da sai"
    )
    try:
        exc = _refused(student, "CREATE TABLE aivb.hack2(i int)")
        assert exc is not None, "sau khi tat read_only thi ghi duoc"
        assert exc.sqlstate == "42501", (
            f"phai bi chan boi GRANT (42501), khong phai boi read_only; "
            f"thuc te {exc.sqlstate}"
        )
    finally:
        student.execute("SET default_transaction_read_only = on")


# ---------------------------------------------------------------------------
# 4. He thong tap tin, mang, DoS
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "sql",
    [
        "SELECT pg_read_file('postgresql.conf')",
        "SELECT pg_read_binary_file('postgresql.conf')",
        "SELECT * FROM pg_ls_dir('.')",
        "SELECT * FROM pg_stat_file('postgresql.conf')",
        "SELECT lo_import('C:/Windows/win.ini')",
        "SELECT lo_export(1, 'C:/leak.txt')",
        "SELECT current_setting('data_directory')",
        "SELECT current_setting('hba_file')",
        "COPY aivb.core_customer TO 'C:/leak.csv'",
        "COPY aivb.core_customer FROM PROGRAM 'cmd /c dir'",
        "SELECT * FROM pg_hba_file_rules()",
        "SELECT pg_sleep(5)",
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
    ],
)
def test_duong_tan_cong_dac_thu_postgres_bi_chan(student, sql):
    exc = _refused(student, sql)
    assert exc is not None, f"CHAY DUOC: {sql}"


# ---------------------------------------------------------------------------
# 5. Tham so phien va ma hoa
# ---------------------------------------------------------------------------

def test_ket_noi_ma_hoa_chay_duoc():
    """Power BI mac dinh BAT ma hoa; `ssl = off` la khong ket noi duoc."""
    try:
        conn = _connect("bi_student", "aivb_student", sslmode="require")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong co PostgreSQL: {exc}")
    with conn:
        ssl, version, _cipher = conn.execute(
            "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
        ).fetchone()
        assert ssl is True
        assert version and version.startswith("TLSv1.")


def test_lc_messages_duoc_ghim():
    """Tang guard tai lap NGUYEN VAN thong bao loi cua Postgres.

    Neu lc_messages doi sang ngon ngu khac, van ban that cua engine khong con
    khop van ban guard tai lap, va mot cot bi giau phan biet duoc voi mot cot go
    sai - trong im lang, khong loi nao duoc nem ra.
    """
    try:
        conn = _connect("bi_student", "aivb_student")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong co PostgreSQL: {exc}")
    with conn:
        assert conn.execute("SHOW lc_messages").fetchone()[0] == "C"


def test_thu_tu_sap_xep_chuoi_theo_byte(student):
    """Collation phai la C de trung ket qua ban DuckDB dung cham bai.

    Phep doi chieu parity bang md5 HOAN TOAN mu voi thu tu sap xep, nen day la
    cho duy nhat bat duoc loi nay.
    """
    assert student.execute("SELECT 'a' < 'B'").fetchone()[0] is False
    rows = student.execute(
        "SELECT x FROM (VALUES ('apple'),('Banana'),('Anh'),('anh'),('Zebra')) t(x) "
        "ORDER BY x"
    ).fetchall()
    assert [r[0] for r in rows] == ["Anh", "Banana", "Zebra", "anh", "apple"]


def test_thong_bao_loi_khong_phan_biet_bi_giau_voi_go_sai(student):
    """Tinh chat 'khong do duoc su ton tai', do o tang engine.

    Khong phai vi tang ung dung viet lai thong bao - ma vi bang bi giau THUC SU
    khong ton tai. Do chinh la ly do cat vat ly la tru cot.
    """
    go_sai = _refused(student, "SELECT 1 FROM aivb.core_custome")
    bi_giau = _refused(student, "SELECT 1 FROM aivb.meta_dirty_log")
    assert go_sai is not None and bi_giau is not None
    assert go_sai.sqlstate == bi_giau.sqlstate == "42P01"
    # Cung mot khuon van ban, chi khac ten.
    assert go_sai.diag.message_primary == 'relation "aivb.core_custome" does not exist'
    assert bi_giau.diag.message_primary == 'relation "aivb.meta_dirty_log" does not exist'
    # Va khong co goi y nao chi ra bang that.
    assert not bi_giau.diag.message_hint
