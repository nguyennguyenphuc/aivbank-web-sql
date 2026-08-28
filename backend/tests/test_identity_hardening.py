"""Hoi quy cho 12 phat hien cua `/code-review` tren lop danh tinh PostgreSQL.

Moi test o day tuong ung mot khiem khuyet CO THAT trong ban chuyen tu kho mat
khau SQLite sang danh tinh PostgreSQL goc. Tach thanh file rieng (nhu
`test_ops_hardening.py`) chu khong tron vao `test_auth.py`: chung khong kiem
mot tinh nang nao ca, chung canh nhung tinh chat da TUNG mat mot lan.

Cai dat truoc tien va quan trong nhat: `test_the_password_never_becomes_a_
connection_parameter`. Truoc ban va, mot mat khau `x host=evil.example.com` doi
duoc may chu DICH cua chinh phep xac thuc, va `verify_password` coi "noi duoc"
la "mat khau dung" - mot duong VONG QUA toan bo phep dang nhap, voi bat ky tai
khoan nao doan duoc ten.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from backend.config import APP_ROOT, settings

# ===========================================================================
# 1. Chuoi ket noi: khong gia tri nao tro thanh mot THAM SO duoc
# ===========================================================================
# DSN kieu keyword/value cua libpq tach nhau bang KHOANG TRANG, va khoa trung
# thi lan CUOI thang. `Settings` truoc day noi chuoi bang f-string voi mat khau
# THO tu body POST.


def test_the_password_never_becomes_a_connection_parameter():
    """Dung chinh bo phan tich cua libpq lam trong tai, khong doan bang regex."""
    from psycopg.conninfo import conninfo_to_dict

    hostile_values = [
        "x host=evil.example.com",
        "x port=1",
        "x sslmode=disable",
        "x dbname=postgres",
        "x' host='evil",
        "x\thost=evil",
        "  ",
        "x\\ host=evil",
        "correct horse host=evil.example.com battery",
    ]
    for hostile in hostile_values:
        parsed = conninfo_to_dict(settings.pg_conninfo_as_user("test_student", hostile))
        assert parsed["password"] == hostile, hostile
        assert parsed["host"] == settings.pg_host, hostile
        assert parsed["dbname"] == settings.pg_db_app, hostile
        assert str(parsed["port"]) == str(settings.pg_port), hostile


def test_a_hostile_username_cannot_redirect_the_connection():
    from psycopg.conninfo import conninfo_to_dict

    from backend import pgroles

    hostile = "sv001 host=evil.example.com"
    assert conninfo_to_dict(settings.pg_conninfo_as_user(hostile, "pw"))["host"] == (
        settings.pg_host
    )
    # Va no khong bao gio toi duoc libpq: `verify_password` loai truoc do.
    assert pgroles.is_valid_username(hostile) is False
    # `aivb_app_rw` truoc day noi duoc that, chi bi loai sau do vi
    # `app.role_of` tra NULL - dung mot lop phong thu.
    assert pgroles.is_valid_username("aivb_app_rw") is False
    assert pgroles.is_valid_username("sv001") is True


def test_a_secret_containing_a_space_does_not_redirect_the_app_connection(tmp_path):
    """Gia tri ket thuc o dau cach dau tien - va phan sau KHONG thanh tham so."""
    from psycopg.conninfo import conninfo_to_dict

    secrets_file = tmp_path / "pg_secrets.env"
    secrets_file.write_text(
        "# chu thich\npw_app_rw=abc host=evil.example.com\n", encoding="utf-8"
    )
    fresh = replace(settings, pg_password_file=secrets_file)
    parsed = conninfo_to_dict(fresh.pg_conninfo_app())
    assert parsed["password"] == "abc"
    assert parsed["host"] == fresh.pg_host


def test_a_blank_secret_line_names_the_key_instead_of_indexerror(tmp_path):
    """`pw_app_rw=` truoc day la `IndexError` luc khoi dong, khong noi khoa nao."""
    secrets_file = tmp_path / "pg_secrets.env"
    secrets_file.write_text("pw_app_rw=\npw_api_s=abc ghi chu\n", encoding="utf-8")
    fresh = replace(settings, pg_password_file=secrets_file)
    with pytest.raises(ValueError) as exc:
        fresh.pg_conninfo_app()
    assert not isinstance(exc.value, IndexError)
    assert "pw_app_rw" in str(exc.value)


# ===========================================================================
# 2. Loi may chu khong duoc tinh la sai mat khau
# ===========================================================================
@pytest.mark.parametrize(
    "sqlstate,message,is_user_error",
    [
        ("28P01", 'password authentication failed for user "sv001"', True),
        ("28P01", "", True),
        ("28000", 'role "sv001" is not permitted to log in', True),
        # Hang quan trong nhat cua bang: `no pg_hba.conf entry` CUNG la 28000.
        # Xep ca 28000 vao "sai mat khau" thi mot lan sua hong
        # `14_pg_hba_docker.conf` se khoa ca lop 15 phut - dung cai su co ma
        # `AuthUnavailable` sinh ra de diet.
        ("28000", 'no pg_hba.conf entry for host "10.0.0.5", user "sv001"', False),
        ("53300", 'too many connections for role "sv001"', False),
        ("57P03", "the database system is starting up", False),
        ("3D000", 'database "aivb_app" does not exist', False),
        # Khong co sqlstate: psycopg khong gan no on dinh cho loi nem tu
        # `psycopg.connect()` tren toan dai pin. Duong lui doc van ban BAT BUOC.
        (None, "connection failed: password authentication failed", True),
        (None, 'role "sv001" is not permitted to log in', True),
        (None, "connection refused", False),
        (None, "timeout expired", False),
        (None, 'no pg_hba.conf entry for host "10.0.0.5"', False),
    ],
)
def test_only_a_real_bad_password_counts_as_a_bad_password(
    sqlstate, message, is_user_error
):
    from backend.authstore import _classify_connect_failure

    assert _classify_connect_failure(sqlstate, message) is is_user_error


def test_verify_password_raises_when_the_server_is_unreachable():
    """May chu khong noi duoc KHONG duoc bao la "sai mat khau"."""
    from psycopg.conninfo import make_conninfo

    from backend.authstore import AuthStore, AuthUnavailable

    store = AuthStore.__new__(AuthStore)  # khong mo pool
    store._user_conninfo = lambda user, password: make_conninfo(
        host="127.0.0.1",
        port=1,
        dbname="x",
        user=user,
        password=password,
        connect_timeout=2,
    )
    with pytest.raises(AuthUnavailable):
        store.verify_password("sv001", "mot-mat-khau-du-dai")


def test_a_disabled_account_is_still_bad_credentials_not_unavailable(pg_store):
    """Ranh gioi 28000: NOLOGIN la loi nguoi dung, pg_hba la loi ha tang."""
    from backend.authstore import AuthUnavailable

    _, password = pg_store.create_user(
        "inject_b", "STUDENT", must_change_password=False
    )
    pg_store.set_disabled("inject_b", True)
    try:
        assert pg_store.verify_password("inject_b", password) is None
    except AuthUnavailable:  # pragma: no cover - chinh la thu dang canh
        pytest.fail("tai khoan bi khoa bi bao nham thanh su co ha tang")


def test_too_many_connections_does_not_burn_a_lockout_strike(pg_store, admin_dsn):
    """Kich ban Power BI: CONNECTION LIMIT can kiet != sai mat khau.

    Truoc ban va nay, mot lan refresh Power BI mo 4-8 ket noi la cham tran cua
    vai tro hoc vien, va dang nhap web bao "sai mat khau" tren mot mat khau
    DUNG - dong thoi dot mot strike khoa tai khoan.
    """
    import psycopg

    from backend.authstore import AuthUnavailable

    _, password = pg_store.create_user(
        "budget_x", "STUDENT", must_change_password=False
    )
    assert pg_store.verify_password("budget_x", password) is not None
    pg_store.clear_failures("user", "budget_x")

    with psycopg.connect(admin_dsn, autocommit=True) as con:
        con.execute("ALTER ROLE budget_x CONNECTION LIMIT 0")
    try:
        with pytest.raises(AuthUnavailable):
            pg_store.verify_password("budget_x", password)
        assert pg_store.fail_count("user", "budget_x") == 0
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as con:
            con.execute("ALTER ROLE budget_x CONNECTION LIMIT 4")
    assert pg_store.verify_password("budget_x", password) is not None


# ===========================================================================
# 3. Kho danh tinh: nguyen tu va dong thoi
# ===========================================================================
def test_concurrent_failures_are_all_counted(pg_store):
    """Doc-roi-ghi khong khoa lam mat luot dem - phong tuyen duy nhat bi hut.

    So luong <= `max_size` cua pool xac thuc, de khong ai phai cho muon ket noi:
    phep do nay ve TINH NGUYEN TU, khong phai ve thong luong.
    """
    from concurrent.futures import ThreadPoolExecutor

    key = "10.9.9.9"
    pg_store.clear_failures("ip", key)
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: pg_store.record_failure("ip", key), range(24)))
        assert pg_store.fail_count("ip", key) == 24
        # Va khoa khong bao gio ngan di khi cac luot dua nhau.
        assert pg_store.lock_remaining("ip", key) >= (
            pg_store.throttle.delay_for("ip", 24) - 1.0
        )
    finally:
        pg_store.clear_failures("ip", key)


def test_a_failed_profile_write_leaves_no_usable_role(pg_store, admin_dsn, monkeypatch):
    """Vai tro va ho so phai cung song hoac cung chet.

    Truoc day vai tro duoc commit tren mot ket noi RIENG truoc khi ghi ho so,
    nen buoc hai hong = mot vai tro dang nhap duoc ma khong ai biet mat khau, va
    lan chay sau bao "da co" roi bo qua vinh vien.
    """
    import psycopg

    from backend import pgroles

    def boom(*args, **kwargs):
        raise RuntimeError("ghi ho so hong")

    monkeypatch.setattr(pg_store, "_write_profile", boom)
    with pytest.raises(RuntimeError):
        pg_store.create_user("dup_a", "STUDENT", must_change_password=False)

    with psycopg.connect(admin_dsn, autocommit=True) as con:
        assert pgroles.role_exists(con, "dup_a") is False


def test_creating_an_existing_user_does_not_reset_their_profile(pg_store):
    """Phep kiem ton tai phai chay TRUOC khi ghi ho so."""
    from backend.authstore import UserExistsError

    pg_store.create_user(
        "dup_b", "STUDENT", full_name="Nguyen Van A", must_change_password=False
    )
    with pytest.raises(UserExistsError):
        pg_store.create_user(
            "dup_b", "STUDENT", full_name="Ten Khac", must_change_password=True
        )
    after = pg_store.get_user("dup_b")
    assert after.full_name == "Nguyen Van A"
    assert after.must_change_password is False


def test_the_operator_error_hierarchy_is_one_family():
    """`admin_cli` bat MOT lop; ca hai nhanh loi phai nam duoi no.

    Truoc day `RoleError` va `AuthError` la anh em khong ho hang, nen mot ten
    tai khoan hong trong CSV bay thang qua `except AuthError` va lam
    `import-csv` chet giua chung - mat het mat khau mot lan da sinh.
    """
    from backend.authstore import AuthError, UserExistsError
    from backend.errors import OperatorError
    from backend.pgroles import RoleError

    assert issubclass(AuthError, OperatorError)
    assert issubclass(RoleError, OperatorError)
    assert issubclass(UserExistsError, AuthError)


# ===========================================================================
# 4. Bang xep hang khong duoc goi N+1 truy van moi request
# ===========================================================================
def test_list_users_takes_one_round_trip(pg_store):
    calls = []
    original = pg_store._pool.connection

    def counting(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    pg_store._pool.connection = counting
    try:
        pg_store.list_users()
    finally:
        pg_store._pool.connection = original
    assert len(calls) == 1


def test_list_users_and_get_user_agree(pg_store):
    """Canh phep tach `_USER_SELECT` khoi hai duong doc."""
    pg_store.create_user(
        "dup_a", "STUDENT", full_name="Mot Ten", must_change_password=True
    )
    for user in pg_store.list_users():
        assert user == pg_store.get_user(user.username)


def test_active_usernames_is_the_enabled_students(pg_store):
    from backend.authstore import ROLE_INSTRUCTOR, ROLE_STUDENT

    pg_store.create_user("dup_a", "STUDENT", must_change_password=False)
    pg_store.create_user("dup_b", "INSTRUCTOR", must_change_password=False)
    pg_store.create_user("inject_a", "STUDENT", must_change_password=False)
    pg_store.set_disabled("inject_a", True)

    students = pg_store.active_usernames(ROLE_STUDENT)
    assert "dup_a" in students
    assert "dup_b" not in students
    # Khoa co hieu luc NGAY - day la ly do khong dat cache TTL o duong nay.
    assert "inject_a" not in students
    assert "dup_b" in pg_store.active_usernames(ROLE_INSTRUCTOR)


# ===========================================================================
# 5. Mat khau: rang buoc la SASLprep, khong phai cu phap chuoi ket noi
# ===========================================================================
def test_a_passphrase_with_spaces_is_allowed_but_non_ascii_is_not():
    """Cam khoang trang (nhu ban SQLite) bay gio chi la chan passphrase vo co.

    Ly do cu la chuoi ket noi noi tay, ma `make_conninfo` da dong lo do. Cai
    phai cam la PHI-ASCII, vi SCRAM bat client ap SASLprep truoc khi bam va
    Python khong co SASLprep.
    """
    from backend.authstore import AuthError, validate_password_strength

    validate_password_strength("correct horse battery staple")
    with pytest.raises(AuthError) as exc:
        validate_password_strength("mat-khẩu-rất-dài")
    assert "ascii" in str(exc.value).lower()


def test_the_pool_budget_stays_inside_the_app_role_connection_limit():
    """Con so nay song o hai file; khong duoc de chung troi khoi nhau."""
    import re

    schema = (APP_ROOT / "database" / "schema" / "16_app_database.sql").read_text(
        encoding="utf-8"
    )
    limits = [int(n) for n in re.findall(r"CONNECTION LIMIT (\d+)", schema)]
    assert limits, "khong tim thay CONNECTION LIMIT trong 16_app_database.sql"
    role_limit = min(limits)
    budget = settings.pg_auth_pool_max + settings.pg_gamification_pool_max + 2
    assert budget <= role_limit, (
        f"ngan sach {budget} vuot CONNECTION LIMIT {role_limit} cua aivb_app_rw"
    )
