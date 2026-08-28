"""Tạo / sửa / xoá vai trò PostgreSQL của từng học viên và giảng viên.

===========================================================================
BA ĐIỀU PHẢI BIẾT TRƯỚC KHI SỬA FILE NÀY
===========================================================================

1. BACKEND KHÔNG BAO GIỜ GỌI MODULE NÀY.

   Mọi hàm ở đây cần `CREATEROLE`, và web app cố ý **không** có quyền đó.
   Chỉ `admin_cli.py` (giảng viên chạy) và script di trú dùng nó, với một
   kết nối superuser riêng.

   Nếu một ngày nào đó `main.py` import file này, đó là dấu hiệu ai đó vừa
   trao quyền quản trị vai trò cho một tiến trình phục vụ Internet.

2. TÊN VAI TRÒ KHÔNG THAM SỐ HOÁ ĐƯỢC.

   `CREATE ROLE :name` không tồn tại trong SQL — tên định danh phải nội suy
   vào câu lệnh. Vì vậy mọi tên đi qua `_ident()`, và mọi mật khẩu đi qua
   `sql.Literal`. Đừng bao giờ nối chuỗi tay ở đây.

3. MỖI NGƯỜI THUỘC ĐÚNG MỘT NHÓM.

   `aivb_class_student` và `aivb_class_instructor` quyết định người đó thấy
   database nào. Cấp cả hai cho một người là cho học viên đọc bảng đáp án
   chấm bài — `set_role()` vì thế luôn THU HỒI nhóm kia trước khi cấp, chứ
   không chỉ cộng thêm.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

from psycopg import sql

from .errors import OperatorError

ROLE_STUDENT = "STUDENT"
ROLE_INSTRUCTOR = "INSTRUCTOR"

GROUP_OF_ROLE = {
    ROLE_STUDENT: "aivb_class_student",
    ROLE_INSTRUCTOR: "aivb_class_instructor",
}
ALL_GROUPS = tuple(GROUP_OF_ROLE.values())

#: Power BI mở 4-8 kết nối mỗi lần refresh. 4 là đủ cho một mô hình vừa phải
#: mà 30 học viên cùng lúc vẫn nằm dưới `ALTER DATABASE ... CONNECTION LIMIT`
#: đặt ở `15_class_roles.sql`.
DEFAULT_CONNECTION_LIMIT = 4

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,62}$")

#: Tên bị cấm: trùng với hạ tầng thì `ensure_role` sẽ sửa mật khẩu hoặc đổi
#: nhóm của chính các vai trò đang chạy hệ thống.
_RESERVED = {
    "postgres",
    "aivb_owner",
    "aivb_loader",
    "aivb_app_rw",
    "aivb_reader_student",
    "aivb_reader_instructor",
    "aivb_api_student",
    "aivb_api_instructor",
    "aivb_bi_student",
    "aivb_bi_instructor",
    "scm_owner",
    "scm_reader",
    "scm_loader",
    "scm_api",
    "scm_bi",
    *ALL_GROUPS,
}


class RoleError(OperatorError):
    """Sai sót của người vận hành, không bao giờ hiện ra cho học viên."""


def normalise_username(username: str) -> str:
    return (username or "").strip().lower()


def validate_username(username: str) -> str:
    """Kiểm tên tài khoản rồi trả về dạng đã chuẩn hoá. Ném `RoleError`.

    CÔNG KHAI để `AuthStore.create_user` kiểm được TRƯỚC khi mở kết nối quản
    trị. Trước đây luật này chỉ sống bên trong `_ident`, tức là tên sai chỉ bị
    phát hiện giữa chừng `ensure_role` - sau khi `CREATE ROLE` đã chạy.
    """
    name = normalise_username(username)
    if not _NAME_RE.match(name):
        raise RoleError(
            f"ten tai khoan khong hop le: {username!r} "
            "(chi a-z 0-9 _, bat dau bang chu, 3-63 ky tu)"
        )
    if name in _RESERVED:
        raise RoleError(f"{name!r} la vai tro ha tang, khong duoc dung lam tai khoan")
    if name.startswith(("pg_", "aivb_", "scm_")):
        raise RoleError(f"{name!r} dung tien to danh cho ha tang")
    return name


def is_valid_username(username: str) -> bool:
    """Cùng ba luật của `validate_username`, nhưng trả bool thay vì ném.

    Dùng trên đường ĐĂNG NHẬP, nơi một cái tên hỏng không phải sự cố vận hành
    mà chỉ là một lần gõ sai (hoặc một lần dò). Gọi nó trước khi tiêu một kết
    nối PostgreSQL, và nó cũng là thứ chặn `aivb_app_rw` bị THỬ làm tên đăng
    nhập - trước đây nối được thật, chỉ bị loại sau đó vì `app.role_of` trả NULL.
    """
    try:
        validate_username(username)
    except RoleError:
        return False
    return True


def _ident(username: str) -> sql.Identifier:
    """Kiểm tên rồi trả về định danh đã trích dẫn đúng cách."""
    return sql.Identifier(validate_username(username))


def role_exists(conn, username: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM pg_roles WHERE rolname = %s", (normalise_username(username),)
    ).fetchone()
    return row is not None


def role_of(conn, username: str) -> str | None:
    """STUDENT / INSTRUCTOR / None — suy từ `pg_auth_members`, không từ bảng."""
    row = conn.execute(
        "SELECT app.role_of(%s)", (normalise_username(username),)
    ).fetchone()
    return row[0] if row else None


def is_disabled(conn, username: str) -> bool:
    row = conn.execute(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = %s",
        (normalise_username(username),),
    ).fetchone()
    if row is None:
        raise RoleError(f"khong co vai tro {username!r}")
    return not row[0]


def set_role(conn, username: str, role: str) -> None:
    """Đặt nhóm, và THU HỒI nhóm kia.

    Thu hồi trước khi cấp là chỗ quan trọng: nếu chỉ cộng thêm, một lần đổi
    STUDENT -> INSTRUCTOR rồi đổi ngược lại sẽ để người đó ở cả hai nhóm, tức
    là một học viên đọc được `aivb_instructor`. Không có triệu chứng nào.
    """
    role = (role or "").upper()
    if role not in GROUP_OF_ROLE:
        raise RoleError(f"vai tro khong hop le: {role!r}")
    ident = _ident(username)
    for group in ALL_GROUPS:
        conn.execute(
            sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(group), ident)
        )
    conn.execute(
        sql.SQL("GRANT {} TO {}").format(
            sql.Identifier(GROUP_OF_ROLE[role]), ident
        )
    )


def ensure_role(
    conn,
    username: str,
    role: str,
    password: str | None = None,
    connection_limit: int = DEFAULT_CONNECTION_LIMIT,
) -> None:
    """Tạo vai trò nếu chưa có, rồi đặt nhóm / mật khẩu / hạn mức.

    Idempotent. `password=None` thì giữ nguyên mật khẩu hiện tại.
    """
    ident = _ident(username)
    if not role_exists(conn, username):
        conn.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN INHERIT "
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS "
                "CONNECTION LIMIT {}"
            ).format(ident, sql.Literal(int(connection_limit)))
        )
    else:
        conn.execute(
            sql.SQL("ALTER ROLE {} LOGIN CONNECTION LIMIT {}").format(
                ident, sql.Literal(int(connection_limit))
            )
        )
    set_role(conn, username, role)
    if password is not None:
        set_password(conn, username, password)


#: `15_class_roles.sql` dòng 41 đặt `scram_iterations = 100000`. Đây là SÀN —
#: người vận hành nâng tham số máy chủ thì `server_scram_iterations` sẽ theo.
SCRAM_MIN_ITERATIONS = 100_000

#: `SCRAM_DEFAULT_SALT_LEN` của PostgreSQL.
SCRAM_SALT_LEN = 16

#: Khuôn verifier của PostgreSQL (`src/common/scram-common.c`):
#:     SCRAM-SHA-256$<iterations>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>
#: Dấu phân cách là `$`, `:`, `$`, `:` — theo đúng thứ tự đó.
_SCRAM_VERIFIER_RE = re.compile(
    r"^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$"
)


def _is_saslprep_safe(password: str) -> bool:
    """Mật khẩu có bất biến qua SASLprep hay không.

    SCRAM (RFC 5802) bắt client áp SASLprep (RFC 4013) TRƯỚC `Hi()`. libpq làm
    việc đó lúc đăng nhập. Nếu ta tính verifier mà KHÔNG SASLprep, còn mật khẩu
    thì không bất biến qua nó, verifier sẽ không bao giờ khớp và tài khoản chết
    vĩnh viễn. Python không có SASLprep trong thư viện chuẩn.

    Với một lớp tiếng Việt đây là rủi ro sống chứ không lý thuyết: `nguyễn`
    NFKC ra khác nhau tuỳ cách gõ.

    Cách vòng qua: thu hẹp đầu vào cho tới khi SASLprep THÀNH hàm đồng nhất.
    Với chuỗi toàn ký tự U+0020..U+007E:
      - bước 1 không ánh xạ gì (C.1.1 space ASCII KHÔNG bị SASLprep ánh xạ, chỉ
        C.1.2 phi-ASCII mới bị; B.1 rỗng ở đây),
      - bước 2 NFKC là đồng nhất trên ASCII in được,
      - bước 3 cấm C.2.1 điều khiển — đã loại theo dải,
      - bước 4 bidi rỗng nghĩa (không có ký tự RandALCat).

    Nên: cấm phi-ASCII, mà CHO PHÉP khoảng trắng. Ràng buộc thật là SASLprep,
    không phải cú pháp chuỗi kết nối — chỗ đó `Settings._pg_dsn` lo rồi.
    """
    return all(" " <= ch <= "~" for ch in password)


def scram_sha256_verifier(
    password: str, *, iterations: int = SCRAM_MIN_ITERATIONS, salt: bytes | None = None
) -> str:
    r"""Tính verifier SCRAM-SHA-256 PHÍA CLIENT, để plaintext không rời tiến trình.

    `ALTER ROLE ... PASSWORD '<plaintext>'` đặt mật khẩu thô vào THÂN CÂU LỆNH:
    nó hiện trong `pg_stat_activity.query` với bất kỳ superuser hay thành viên
    `pg_read_all_stats` nào trong lúc câu lệnh chạy, và vào log máy chủ nếu câu
    lệnh lỗi (`log_min_error_statement = error` là mặc định) hay nếu ai đó bật
    `log_statement = ddl`. Bản SQLite chưa bao giờ để plaintext rời tiến trình;
    đây là khôi phục tính chất đó. Chính là việc `psql \password` làm.

    Verifier VẪN nằm trong thân câu lệnh, và đó vẫn là một cải thiện thật chứ
    không phải mỹ phẩm: `StoredKey`/`ServerKey` KHÔNG tương đương mật khẩu với
    một client. Máy chủ khôi phục `ClientKey` từ proof rồi kiểm
    `SHA256(ClientKey) == StoredKey`, mà `ClientKey` không suy ra được từ
    `StoredKey`. Rò verifier cho phép giả mạo máy chủ và crack offline ở 100k
    vòng — đúng mức phơi nhiễm mà `pg_authid` vốn đã mang — nhưng KHÔNG cho
    "đọc log rồi đăng nhập làm học viên đó".

    `salt` CHỈ để test known-answer. Đường chạy thật luôn sinh muối ngẫu nhiên.
    """
    if not password:
        raise RoleError("mat khau rong")
    if not _is_saslprep_safe(password):
        raise RoleError(
            "mat khau phai la ASCII in duoc (U+0020..U+007E). Xem `_is_saslprep_safe`: "
            "SCRAM bat client ap SASLprep truoc khi bam, va Python khong co SASLprep."
        )
    iterations = max(int(iterations), SCRAM_MIN_ITERATIONS)
    if salt is None:
        salt = secrets.token_bytes(SCRAM_SALT_LEN)

    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()

    b64 = lambda raw: base64.b64encode(raw).decode("ascii")  # noqa: E731
    verifier = (
        f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"
    )

    # Tu kiem lai, va day KHONG phai hoang tuong. Neu chuoi dua vao
    # `ALTER ROLE ... PASSWORD` khong dung khuon verifier thi PostgreSQL KHONG
    # bao loi: `encrypt_password()` roi xuong coi no la CLEARTEXT roi bam. Mat
    # khau tai khoan lang le tro thanh dung chuoi "SCRAM-SHA-256$..." do, khong
    # ai dang nhap duoc, va log khong noi mot loi nao.
    if not _SCRAM_VERIFIER_RE.match(verifier):  # pragma: no cover - phong thu
        raise RoleError("verifier SCRAM sinh ra sai khuon - TU CHOI gui di")
    return verifier


def server_scram_iterations(conn) -> int:
    """`scram_iterations` của máy chủ, nhưng không bao giờ dưới sàn của ta.

    Tồn tại để người vận hành NÂNG tham số máy chủ vẫn còn tác dụng sau khi
    phép băm chuyển sang phía client.
    """
    try:
        row = conn.execute("SHOW scram_iterations").fetchone()
        return max(int(row[0]), SCRAM_MIN_ITERATIONS)
    except Exception:  # pragma: no cover - máy chủ cũ, quyền lạ, v.v.
        return SCRAM_MIN_ITERATIONS


def set_password(conn, username: str, password: str) -> None:
    """Đặt mật khẩu.

    Băm bằng SCRAM-SHA-256 PHÍA CLIENT (`scram_sha256_verifier`), nên plaintext
    không bao giờ đi vào thân câu lệnh — xem lý do đầy đủ ở đó. Số vòng lấy từ
    `scram_iterations` của máy chủ, nhưng không bao giờ dưới `SCRAM_MIN_ITERATIONS`.
    Giá trị chỉ áp LÚC ĐẶT, nên đổi tham số sau không hồi tố lên mật khẩu cũ.
    """
    verifier = scram_sha256_verifier(
        password, iterations=server_scram_iterations(conn)
    )
    conn.execute(
        sql.SQL("ALTER ROLE {} PASSWORD {}").format(
            _ident(username), sql.Literal(verifier)
        )
    )


def set_disabled(conn, username: str, disabled: bool) -> None:
    """Khoá / mở tài khoản.

    `NOLOGIN` đóng CẢ HAI lane cùng lúc — console web lẫn Power BI — vì cả hai
    đều xác thực với chính vai trò này. Đó là điều mà kho SQLite cũ không làm
    được: khoá trên web xong Power BI vẫn vào bình thường.
    """
    ident = _ident(username)
    conn.execute(
        sql.SQL("ALTER ROLE {} {}").format(
            ident, sql.SQL("NOLOGIN" if disabled else "LOGIN")
        )
    )


def drop_role(conn, username: str) -> None:
    ident = _ident(username)
    for group in ALL_GROUPS:
        conn.execute(sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(group), ident))
    conn.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(ident))


def list_class_roles(conn) -> list[tuple[str, str, bool]]:
    """(username, STUDENT|INSTRUCTOR, disabled) cho mọi thành viên hai nhóm."""
    rows = conn.execute(
        """
        SELECT r.rolname, app.role_of(r.rolname), NOT r.rolcanlogin
        FROM pg_roles r
        WHERE EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = r.oid AND g.rolname = ANY(%s)
        )
        ORDER BY r.rolname
        """,
        (list(ALL_GROUPS),),
    ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def assert_no_leak(conn) -> None:
    """Không học viên nào được với tới database giảng viên.

    Gọi sau mỗi lần cấp phát hàng loạt. Rẻ, và nó bắt đúng loại lỗi mà không
    có triệu chứng nào khác báo cho ta biết.
    """
    bad = conn.execute(
        """
        SELECT r.rolname
        FROM pg_roles r
        WHERE pg_has_role(r.rolname, 'aivb_class_student', 'MEMBER')
          AND NOT pg_has_role(r.rolname, 'aivb_class_instructor', 'MEMBER')
          AND has_database_privilege(r.rolname, 'aivb_instructor', 'CONNECT')
        """
    ).fetchall()
    if bad:
        names = ", ".join(r[0] for r in bad)
        raise RoleError(
            f"DUNG LAI: hoc vien co CONNECT tren aivb_instructor: {names}. "
            "Xem database/schema/02_databases.sql dong 82-91."
        )
