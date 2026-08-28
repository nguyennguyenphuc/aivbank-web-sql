"""Vai trò PostgreSQL của từng học viên — hàng rào chống rò đáp án.

===========================================================================
VÌ SAO FILE NÀY TỒN TẠI
===========================================================================

Từ khi mỗi học viên là một vai trò PostgreSQL riêng, việc cấp phát trở thành
tự động — và một dòng sai trong `pgroles.set_role` hay `15_class_roles.sql` sẽ
cấp cho cả lớp quyền đọc `aivb_instructor`, tức là bảng đáp án chấm bài.

Kiểu hỏng đó **không có triệu chứng nào khác**: console web vẫn chạy, Power BI
vẫn chạy, không có lỗi nào được ghi. Chỉ một phép thử chủ động mới bắt được.

Mọi phép kiểm ở đây dùng KẾT NỐI THẬT, đúng cách `test_pg_engine_defenses.py`
làm — không đọc cấu hình rồi suy ra, vì hai lớp bảo vệ (`pg_hba` và quyền
CONNECT ở tầng database) độc lập nhau và có thể lệch nhau.
"""
from __future__ import annotations

import psycopg
import pytest

from backend import pgroles

STUDENT_ROLE = "zz_t_class_sv"
INSTRUCTOR_ROLE = "zz_t_class_gv"
PASSWORD = "class-role-fixture-pw-2026"

#: Hai thông báo PostgreSQL dùng khi từ chối ở tầng `pg_hba`:
#:   * `reject` tường minh  -> "pg_hba.conf rejects connection"
#:   * rơi hết luật         -> "no pg_hba.conf entry"
#: Chấp nhận cả hai: chúng khác nhau về cơ chế nhưng giống nhau về kết quả.
HBA_DENIED = ("pg_hba.conf rejects connection", "no pg_hba.conf entry")


@pytest.fixture(scope="module")
def class_roles(admin_dsn):
    """Một học viên và một giảng viên thật trong `pg_authid`."""
    try:
        with psycopg.connect(admin_dsn, connect_timeout=5):
            pass
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"khong noi duoc toi PostgreSQL ({exc})")

    with psycopg.connect(admin_dsn, autocommit=True) as con:
        row = con.execute(
            "SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_student'"
        ).fetchone()
        if row is None:
            pytest.skip("chua chay database/schema/15_class_roles.sql")
        for name in (STUDENT_ROLE, INSTRUCTOR_ROLE):
            if pgroles.role_exists(con, name):
                pgroles.drop_role(con, name)
        pgroles.ensure_role(con, STUDENT_ROLE, "STUDENT", PASSWORD)
        pgroles.ensure_role(con, INSTRUCTOR_ROLE, "INSTRUCTOR", PASSWORD)

    yield {"student": STUDENT_ROLE, "instructor": INSTRUCTOR_ROLE}

    with psycopg.connect(admin_dsn, autocommit=True) as con:
        for name in (STUDENT_ROLE, INSTRUCTOR_ROLE):
            if pgroles.role_exists(con, name):
                pgroles.drop_role(con, name)


def _try_connect(username: str, database: str) -> tuple[bool, str]:
    from backend.config import settings

    dsn = (
        f"host={settings.pg_host} port={settings.pg_port} dbname={database} "
        f"user={username} password={PASSWORD} sslmode={settings.pg_sslmode} "
        "connect_timeout=10"
    )
    try:
        with psycopg.connect(dsn) as con:
            con.execute("SELECT 1")
        return True, ""
    except psycopg.OperationalError as exc:
        return False, str(exc)


# ===========================================================================
# 1. Hàng rào chống rò đáp án — phép kiểm quan trọng nhất cả file
# ===========================================================================
def test_student_cannot_reach_the_instructor_database(class_roles):
    """Học viên nối `aivb_instructor` phải HỎNG, ở bất kỳ tầng nào.

    Hai lớp chặn độc lập:
      * `pg_hba` không có dòng nào cho `+aivb_class_student` tới database đó
      * quyền CONNECT ở tầng database cũng không cấp cho nhóm học viên

    `02_databases.sql` dòng 82-91 gọi lớp thứ hai là "dòng quan trọng nhất về
    bảo mật trong cả hệ thống": một lỗi định tuyến chỉ làm học viên cầm một bộ
    thông tin đăng nhập KHÔNG MỞ NỔI kết nối — sai sót thành lỗi kết nối, không
    thành rò rỉ dữ liệu.
    """
    ok, message = _try_connect(class_roles["student"], "aivb_instructor")
    assert not ok, "HOC VIEN NOI DUOC VAO DATABASE GIANG VIEN - ro ri dap an"
    assert any(m in message for m in HBA_DENIED) or "permission denied" in message, message


def test_student_can_reach_the_student_database(class_roles):
    """Đối chứng dương: nếu phép kiểm trên đạt chỉ vì không ai nối được thì
    nó chứng minh không gì cả."""
    ok, message = _try_connect(class_roles["student"], "aivb_student")
    assert ok, f"hoc vien khong vao duoc database cua chinh minh: {message}"


def test_instructor_reaches_both_databases(class_roles):
    for database in ("aivb_student", "aivb_instructor"):
        ok, message = _try_connect(class_roles["instructor"], database)
        assert ok, f"giang vien khong vao duoc {database}: {message}"


def test_student_group_never_holds_the_instructor_reader_pack(admin_dsn):
    """Kiểm ở tầng vai trò, độc lập với `pg_hba`.

    Hai lớp có thể lệch nhau: sửa `pg_hba` cho đúng mà quên thu hồi gói đọc thì
    phép kiểm kết nối vẫn xanh, còn quyền thì đã sai.
    """
    with psycopg.connect(admin_dsn) as con:
        assert not con.execute(
            "SELECT pg_has_role('aivb_class_student', 'aivb_reader_instructor', 'MEMBER')"
        ).fetchone()[0], "nhom hoc vien co goi doc cua giang vien"
        assert not con.execute(
            "SELECT has_database_privilege('aivb_class_student', 'aivb_instructor', 'CONNECT')"
        ).fetchone()[0], "nhom hoc vien co CONNECT tren aivb_instructor"


def test_set_role_revokes_the_other_group(admin_dsn, class_roles):
    """Đổi vai trò phải THU HỒI nhóm cũ, không chỉ cộng thêm nhóm mới.

    Chỉ cộng thêm thì một lần đổi STUDENT -> INSTRUCTOR rồi đổi ngược lại sẽ để
    người đó ở CẢ HAI nhóm — một học viên đọc được bảng đáp án, và không có gì
    báo.
    """
    name = class_roles["student"]
    with psycopg.connect(admin_dsn, autocommit=True) as con:
        pgroles.set_role(con, name, "INSTRUCTOR")
        assert pgroles.role_of(con, name) == "INSTRUCTOR"
        pgroles.set_role(con, name, "STUDENT")
        assert pgroles.role_of(con, name) == "STUDENT"
        assert not con.execute(
            "SELECT pg_has_role(%s, 'aivb_class_instructor', 'MEMBER')", (name,)
        ).fetchone()[0], "nhom giang vien khong duoc thu hoi"
    # Va hang rao that su van con nguyen sau khi doi qua doi lai.
    ok, _ = _try_connect(name, "aivb_instructor")
    assert not ok, "sau khi doi vai tro hai lan, hoc vien vao duoc database giang vien"


# ===========================================================================
# 2. Khoá tài khoản đóng CẢ HAI lane
# ===========================================================================
def test_disable_closes_web_and_power_bi_together(admin_dsn, class_roles):
    """Đây là thứ kho SQLite cũ không làm được.

    Trước đây khoá trên web không đụng gì tới Power BI: hai kho danh tính tách
    rời. Bây giờ cả hai xác thực với cùng một vai trò PostgreSQL, nên `NOLOGIN`
    đóng cả hai cùng lúc.
    """
    name = class_roles["student"]
    with psycopg.connect(admin_dsn, autocommit=True) as con:
        pgroles.set_disabled(con, name, True)
    try:
        ok, _ = _try_connect(name, "aivb_student")
        assert not ok, "tai khoan bi khoa van noi duoc"
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as con:
            pgroles.set_disabled(con, name, False)
    ok, message = _try_connect(name, "aivb_student")
    assert ok, f"mo khoa xong van khong vao duoc: {message}"


# ===========================================================================
# 3. Tên vai trò — chặn tiêm SQL và chặn ghi đè hạ tầng
# ===========================================================================
@pytest.mark.parametrize(
    "bad",
    [
        'sv001"; DROP ROLE aivb_owner; --',
        "postgres",
        "aivb_bi_student",
        "aivb_class_student",
        "pg_signal_backend",
        "",
        "a",
        "SV-001",
    ],
)
def test_reserved_and_malformed_names_are_refused(bad):
    """Tên vai trò KHÔNG tham số hoá được trong SQL, nên nó phải qua bộ lọc.

    `admin_cli import-csv` nhận file danh sách lớp từ bên ngoài, nên tên ở đây
    là dữ liệu do người khác đặt.
    """
    with pytest.raises(pgroles.RoleError):
        pgroles._ident(bad)


def test_password_uses_the_agreed_kdf_cost(admin_dsn, class_roles):
    """`scram_iterations` phải là 100000, không phải mặc định 4096 của PostgreSQL."""
    with psycopg.connect(admin_dsn) as con:
        verifier = con.execute(
            "SELECT rolpassword FROM pg_authid WHERE rolname = %s",
            (class_roles["student"],),
        ).fetchone()[0]
    assert verifier.startswith("SCRAM-SHA-256$")
    iterations = int(verifier.split("$")[1].split(":")[0])
    assert iterations >= 100000, f"scram_iterations tut ve {iterations}"
