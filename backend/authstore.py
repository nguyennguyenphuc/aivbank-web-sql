"""Kho danh tính và phiên — PostgreSQL.

===========================================================================
CÁI GÌ NẰM Ở ĐÂU, VÀ VÌ SAO
===========================================================================

* MẬT KHẨU và VAI TRÒ nằm trong `pg_authid` / `pg_auth_members`, do chính
  PostgreSQL quản lý. Module này KHÔNG băm mật khẩu và KHÔNG lưu mật khẩu.

  Đó là cả điểm của việc bỏ SQLite: Power BI xác thực với `pg_authid`, nên
  nếu danh tính nằm ở nơi khác thì hai lane không bao giờ đồng bộ được. Một
  người = một vai trò PostgreSQL, dùng chung cho web và Power BI.

* PHIÊN, CHẶN ĐĂNG NHẬP SAI và HỒ SƠ nằm trong `aivb_app` (schema `app`).
  Đó là state ghi được của ứng dụng, tách khỏi hai database dữ liệu vì
  `restore.py` dựng lại chúng — xem `16_app_database.sql`.

===========================================================================
XÁC THỰC HOẠT ĐỘNG THẾ NÀO
===========================================================================

`verify_password` MỞ MỘT KẾT NỐI PostgreSQL bằng chính tài khoản đó. Nối
được nghĩa là mật khẩu đúng. Không có bản sao mật khẩu nào để so.

Hệ quả tốt, và chúng là lý do chọn cách này:

  * Ứng dụng KHÔNG cần `CREATEROLE` hay superuser. Nó chưa bao giờ đọc được
    `pg_authid.rolpassword`, nên thủng web app cũng không lấy được verifier
    để bẻ offline.
  * Tài khoản bị `NOLOGIN` là hỏng ngay ở tầng PostgreSQL — web và Power BI
    đóng cùng lúc, không phải nhớ khoá hai chỗ.
  * PostgreSQL từ v10 làm *mock authentication* cho SCRAM: vai trò không tồn
    tại được trả lời bằng một verifier giả với cùng khối lượng tính toán, nên
    "không có người này" và "sai mật khẩu" không phân biệt được. Bản SQLite
    phải tự dựng tính chất đó bằng một lần scrypt giả; ở đây nó có sẵn.

Cái giá: mỗi lần đăng nhập tốn một kết nối và một lần PBKDF2 100000 vòng
phía client (~30-60 ms). `app.throttle` chặn dò mật khẩu TRƯỚC khi thử nối,
nên chi phí đó không thành đường làm nghẽn dịch vụ.
"""
from __future__ import annotations

import hmac
import secrets
import contextlib
import string
import time
from dataclasses import dataclass

import psycopg
from psycopg import sql
from psycopg_pool import ConnectionPool, PoolTimeout

from . import pgroles
from .errors import OperatorError

ROLE_STUDENT = "STUDENT"
ROLE_INSTRUCTOR = "INSTRUCTOR"
ROLES = (ROLE_STUDENT, ROLE_INSTRUCTOR)

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256


#: Than SELECT dung chung cho `get_user` va `list_users`. MOT ban, de hai
#: duong doc khong the troi khoi nhau.
_USER_SELECT = """
    SELECT r.rolname,
           app.role_of(r.rolname)         AS role,
           COALESCE(p.full_name, '')      AS full_name,
           COALESCE(p.must_change_password, true) AS must_change_password,
           NOT r.rolcanlogin              AS disabled,
           COALESCE(p.created_at, '')     AS created_at,
           p.password_changed_at,
           p.last_login_at
    FROM pg_roles r
    LEFT JOIN app.user_profile p ON p.username = r.rolname
"""


class AuthError(OperatorError):
    """Sai sót của người vận hành, không bao giờ hiện ra cho học viên."""


class UserExistsError(AuthError):
    """Vai trò đã tồn tại.

    Một LỚP RIÊNG chứ không phải một thông điệp: `admin_cli.cmd_import_csv`
    trước đây so `"already exists" in str(exc)`, tức biến nguyên văn một dòng
    thông báo thành giao diện - sửa chính tả là "bỏ qua" lặng lẽ thành "hỏng".
    """


#: SQLSTATE cua PostgreSQL cho hai nhom that bai luc bat tay xac thuc.
_SQLSTATE_INVALID_PASSWORD = "28P01"
_SQLSTATE_INVALID_AUTHORIZATION = "28000"

#: Manh thong bao cua libpq khi khong co sqlstate di kem (xem `_is_bad_credentials`).
_BAD_CREDENTIAL_HINTS = (
    "password authentication failed",
    "is not permitted to log in",
    "role does not exist",
)


def _classify_connect_failure(sqlstate: str | None, message: str) -> bool:
    """True = that bai cua NGUOI DUNG (sai mat khau). False = su co HA TANG.

    Ham THUAN, tach rieng de bang quyet dinh nay unit-test duoc ma khong can
    mot may chu that: `psycopg.Error.sqlstate` la property chi-doc dua tren
    pgresult, nen khong dung duoc mot exception tong hop voi sqlstate tuy chon.

    ⚠ `28000` KHONG duoc xep het vao "sai mat khau". `FATAL: no pg_hba.conf
    entry for host ...` CUNG la 28000. Xep ca 28000 vao nhom nguoi dung thi mot
    lan sua hong `14_pg_hba_docker.conf` - dung loai thay doi lop nay hay lam
    khi phong may doi dai chi - se bien moi lan dang nhap thanh "sai mat khau"
    va khoa ca lop 15 phut. Dung cai su co ma `AuthUnavailable` sinh ra de diet.
    """
    text = (message or "").lower()
    if sqlstate == _SQLSTATE_INVALID_PASSWORD:
        # Ke ca khi vai tro khong ton tai: PostgreSQL tra loi gia (mock
        # authentication) de khong lo danh sach tai khoan.
        return True
    if sqlstate == _SQLSTATE_INVALID_AUTHORIZATION:
        return "pg_hba" not in text
    if sqlstate is not None:
        # 53300 too_many_connections, 57P03 cannot_connect_now, 3D000, ...
        return False
    # Khong co sqlstate: psycopg khong gan no on dinh cho loi nem tu
    # `psycopg.connect()` tren toan dai pin `>=3.2,<3.4` - vai duong ma dung
    # thang `PQerrorMessage`. Doc van ban la duong lui BAT BUOC, dung xoa vi
    # "psycopg gio co sqlstate roi".
    if "pg_hba" in text:
        return False
    return any(hint in text for hint in _BAD_CREDENTIAL_HINTS)


def _is_bad_credentials(exc: BaseException) -> bool:
    """Boc `_classify_connect_failure` cho mot exception that."""
    return _classify_connect_failure(
        getattr(exc, "sqlstate", None), str(exc)
    )


class AuthUnavailable(RuntimeError):
    """Máy chủ danh tính đang không trả lời. KHÔNG phải "sai mật khẩu".

    Phân biệt này là load-bearing, không phải chuyện gọn gàng. Trước đây
    `verify_password` gộp mọi `OperationalError` thành `None`, và `main.py` đọc
    `None` là sai mật khẩu rồi ghi hai lượt `record_failure`. Hai hậu quả THẬT:

      - PostgreSQL restart giữa buổi học: cả phòng gõ lại, mỗi lần gõ lại là
        một strike, và cả lớp tự khoá mình tới 15 phút.
      - Vai trò học viên có `CONNECTION LIMIT 4`. Một lần Power BI refresh mở
        4-8 kết nối là chạm trần; trong lúc đó đăng nhập web báo "sai mật khẩu"
        trên một mật khẩu ĐÚNG, và vẫn đốt strike.

    Đừng gộp lại khi dọn dẹp.
    """


@dataclass(frozen=True)
class User:
    username: str
    role: str
    full_name: str
    must_change_password: bool
    disabled: bool
    created_at: str
    password_changed_at: str | None
    last_login_at: str | None


@dataclass(frozen=True)
class Session:
    token_hash: str
    username: str
    role: str
    created_at: float
    last_seen_at: float
    absolute_expires_at: float
    idle_expires_at: float
    must_change_password: bool

    @property
    def session_id(self) -> str:
        """Định danh ngắn, không đảo ngược được, an toàn để ghi vào nhật ký."""
        return self.token_hash[:12]


def _user_from_row(row) -> User:
    """Mot hang cua `_USER_SELECT` -> `User`."""
    return User(
        username=row[0],
        role=row[1],
        full_name=row[2],
        must_change_password=bool(row[3]),
        disabled=bool(row[4]),
        created_at=row[5],
        password_changed_at=row[6],
        last_login_at=row[7],
    )


@dataclass(frozen=True)
class ThrottlePolicy:
    """Khoá luỹ tiến, áp riêng cho username và cho IP.

    Ngưỡng theo username là ngưỡng chặt (5 lần -> 30s, nhân đôi, trần 15 phút)
    vì đó mới là thứ đang bị đoán. Ngưỡng theo IP cố ý lỏng hơn: cả phòng máy
    ngồi sau một NAT dùng chung một địa chỉ nguồn, và luật 5 lần theo IP sẽ để
    một học viên gõ nhầm khoá cả lớp.

    PostgreSQL KHÔNG có cơ chế nào tương đương. Lớp này là thứ duy nhất chặn
    dò mật khẩu, nên đừng bỏ nó khi dọn dẹp.
    """

    user_fail_threshold: int = 5
    ip_fail_threshold: int = 20
    base_delay_s: float = 30.0
    max_delay_s: float = 900.0

    def delay_for(self, scope: str, fail_count: int) -> float:
        threshold = (
            self.user_fail_threshold if scope == "user" else self.ip_fail_threshold
        )
        if fail_count < threshold:
            return 0.0
        exponent = fail_count - threshold
        if exponent > 32:
            return self.max_delay_s
        return min(self.max_delay_s, self.base_delay_s * (2**exponent))


@dataclass(frozen=True)
class SessionPolicy:
    idle_timeout_s: float = 8 * 3600.0
    absolute_timeout_s: float = 12 * 3600.0


# --- tiện ích -----------------------------------------------------------
def validate_password_strength(password: str, username: str = "") -> None:
    if not isinstance(password, str):
        raise AuthError("Password must be a string.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters long."
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise AuthError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters.")
    if username and password.lower() == username.lower():
        raise AuthError("Password must not be the username.")
    # Ràng buộc là SASLprep, không phải cú pháp chuỗi kết nối — xem
    # `pgroles._is_saslprep_safe`. Nhân bản luật ở đây để `/auth/password` trả
    # `E_WEAK_PASSWORD` gọn gàng thay vì một 500 từ sâu trong `pgroles`.
    #
    # KHOẢNG TRẮNG ĐƯỢC PHÉP, và đừng "khôi phục" lệnh cấm nó: bản SQLite cấm
    # khoảng trắng vì chuỗi kết nối nối tay, mà `Settings._pg_dsn` đã đóng lỗ đó
    # bằng `make_conninfo`. Cấm khoảng trắng bây giờ chỉ là chặn passphrase.
    if not pgroles._is_saslprep_safe(password):
        raise AuthError(
            "Password must use printable ASCII characters only "
            "(no accented letters, tabs or newlines)."
        )


def generate_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def hash_token(raw_token: str) -> str:
    import hashlib

    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def normalise_username(username: str) -> str:
    return pgroles.normalise_username(username)


def _utc_now() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


class AuthStore:
    """Kho danh tính trên PostgreSQL. An toàn với nhiều luồng."""

    def __init__(
        self,
        conninfo: str,
        *,
        user_conninfo=None,
        admin_conninfo: str | None = None,
        throttle: ThrottlePolicy | None = None,
        sessions: SessionPolicy | None = None,
        pool_min: int = 1,
        pool_max: int = 4,
    ) -> None:
        """
        conninfo        chuỗi nối `aivb_app` bằng `aivb_app_rw` — state ứng dụng
        user_conninfo   callable(username, password) -> chuỗi nối, dùng để XÁC THỰC
        admin_conninfo  chuỗi nối superuser. CHỈ `admin_cli` truyền vào.
                        Backend để None, và khi đó mọi thao tác cần `CREATEROLE`
                        đều ném lỗi thay vì âm thầm chạy — đó là hàng rào giữ cho
                        tiến trình phục vụ Internet không cầm quyền quản trị vai trò.
        """
        self.conninfo = conninfo
        self._user_conninfo = user_conninfo
        self._admin_conninfo = admin_conninfo
        self.throttle = throttle or ThrottlePolicy()
        self.session_policy = sessions or SessionPolicy()
        # `timeout=5.0` chu khong 15.0: pool bao hoa truoc day la treo mot request
        # dang nhap 15 giay roi 500. Nay `PoolTimeout` duoc dich thanh
        # `AuthUnavailable` (xem `_conn`), tuc mot 503 nhanh kem `Retry-After`.
        #
        # `max_lifetime`/`max_idle`: tra ket noi nhan roi ve lai ngan sach cua
        # `aivb_app_rw`, thay vi giu den het doi tien trinh.
        self._pool = ConnectionPool(
            conninfo,
            min_size=max(1, pool_min),
            max_size=max(max(1, pool_min), pool_max),
            open=True,
            timeout=5.0,
            max_lifetime=1800.0,
            max_idle=300.0,
            name="aivb-app-auth",
        )

    def close(self) -> None:
        try:
            self._pool.close()
        except Exception:  # pragma: no cover - đóng hai lần không được làm hỏng gì
            pass

    # -- kết nối ----------------------------------------------------------
    @contextlib.contextmanager
    def _conn(self):
        """Muon mot ket noi tu pool, dich `PoolTimeout` thanh `AuthUnavailable`.

        Pool bao hoa la mot su co HA TANG, khong phai mot cau tra loi ve mat
        khau. Khong co lop dich nay thi no noi len thanh 500 (hoac te hon, bi
        mot `except` rong nao do o tren nuot thanh "sai mat khau").
        """
        try:
            with self._pool.connection() as con:
                yield con
        except PoolTimeout as exc:
            raise AuthUnavailable(
                f"het ket noi trong pool xac thuc sau {self._pool.timeout}s"
            ) from exc

    def _admin(self, autocommit: bool = True):
        """Ket noi quan tri. `autocommit=False` de gop nhieu lenh thanh MOT.

        `CREATE ROLE` / `GRANT` / `REVOKE` / `ALTER ROLE` deu transactional
        trong PostgreSQL, nen mot khoi nhieu lenh cuon lai duoc sach se. Xem
        `create_user`: truoc day no chay autocommit, nen `assert_no_leak` hong
        SAU khi `ensure_role` da commit se de lai mot vai tro mo coi dang nhap
        duoc - va lan chay sau bao "da co" roi bo qua vinh vien.

        Mac dinh phai giu `True`, va phep kiem CREATEROLE phai o cau lenh dau:
        `test_server_auth_store_cannot_create_roles` goi `store._admin()` khong
        tham so tren mot store dung bang `__new__`.
        """
        if not self._admin_conninfo:
            raise AuthError(
                "Thao tac nay can quyen quan tri vai tro (CREATEROLE). "
                "AuthStore duoc dung khong co admin_conninfo - dung admin_cli."
            )
        return psycopg.connect(self._admin_conninfo, autocommit=autocommit)

    def _write_profile(
        self, uname: str, full_name: str, must_change_password: bool
    ) -> None:
        with self._conn() as con:
            con.execute(
                "INSERT INTO app.user_profile "
                "(username, full_name, must_change_password, created_at, password_changed_at) "
                "VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name, "
                "must_change_password = EXCLUDED.must_change_password",
                (uname, full_name, must_change_password, _utc_now(), _utc_now()),
            )

    # -- người dùng -------------------------------------------------------
    def create_user(
        self,
        username: str,
        role: str,
        password: str | None = None,
        full_name: str = "",
        must_change_password: bool = True,
    ) -> tuple[User, str]:
        # Kiem ten TRUOC tien: hong som, hong re, chua dung toi mot ket noi nao.
        # Truoc day ten chi duoc kiem o sau trong `ensure_role`, tuc la sau khi
        # `CREATE ROLE` da chay.
        uname = pgroles.validate_username(username)
        role = (role or "").upper()
        if role not in ROLES:
            raise AuthError(f"Unknown role: {role!r}")
        plaintext = password or generate_password()
        validate_password_strength(plaintext, uname)

        # MOT giao dich cho ca vai tro lan ho so. Ghi ho so nam LONG trong giao
        # dich vai tro dang mo: no nem thi `with psycopg.connect(...)` cuon lai
        # va KHONG con vai tro mo coi - nua nguy hiem la nua duoc hoan tac.
        #
        # Cua so con lai la "ho so da commit, COMMIT vai tro hong", de lai mot
        # hang ho so MO COI VA TRO: `get_user`/`list_users` deu lai tu `pg_roles`
        # roi LEFT JOIN ho so, nen no vo hinh khap noi, va `ON CONFLICT DO UPDATE`
        # khien lan chay sau de len. Do la tot nhat co the ma khong can 2PC hai
        # database, va chat hon han chieu nguoc lai.
        with self._admin(autocommit=False) as con:
            # Phep kiem ton tai phai nam TRUOC `_write_profile`, khong thi mot
            # lan `import-csv` chay lai se reset `full_name`/`must_change_password`
            # cua hoc vien co san TRUOC khi phat hien trung.
            if pgroles.role_exists(con, uname):
                raise UserExistsError(f"User already exists: {uname}")
            pgroles.ensure_role(con, uname, role, plaintext)
            pgroles.assert_no_leak(con)
            self._write_profile(uname, full_name, must_change_password)

        user = self.get_user(uname)
        if user is None:  # pragma: no cover - vừa tạo xong
            raise AuthError(f"Tao {uname} xong nhung doc lai khong thay")
        return user, plaintext

    def get_user(self, username: str) -> User | None:
        uname = normalise_username(username)
        with self._conn() as con:
            row = con.execute(
                _USER_SELECT + " WHERE r.rolname = %s", (uname,)
            ).fetchone()
        if row is None or row[1] is None:
            # Vai trò không tồn tại, hoặc tồn tại nhưng không thuộc nhóm lớp nào
            # (ví dụ `aivb_loader`). Với tầng trên thì cả hai đều là "không có".
            return None
        return _user_from_row(row)

    def list_users(self) -> list[User]:
        """Mọi tài khoản thuộc một nhóm lớp. MỘT truy vấn.

        Bản cũ chạy một truy vấn `pg_roles` rồi một `get_user` đầy đủ cho TỪNG
        người, mỗi cái mượn một kết nối riêng trong pool — và `main.py` gọi nó
        trên MỌI request `/gamification/leaderboard`. Một lớp 100 người là 101
        vòng đi-về cho một thứ mà bảng xếp hạng chỉ cần vài cái tên.
        """
        with self._conn() as con:
            rows = con.execute(
                _USER_SELECT
                + " WHERE app.role_of(r.rolname) IS NOT NULL ORDER BY 2, 1"
            ).fetchall()
        return [_user_from_row(row) for row in rows]

    def active_usernames(self, role: str) -> frozenset[str]:
        """Tên của những tài khoản CÒN BẬT thuộc một vai trò.

        Truy vấn hẹp cho `/gamification/leaderboard`, thứ duy nhất nó cần. Cố ý
        KHÔNG có cache TTL: học viên bị khoá sẽ nán lại bảng xếp hạng hết vòng
        đời cache, trái với tính chất "khoá có hiệu lực NGAY" mà
        `validate_session` được dựng quanh.
        """
        with self._conn() as con:
            rows = con.execute(
                "SELECT r.rolname FROM pg_roles r "
                "WHERE app.role_of(r.rolname) = %s AND r.rolcanlogin",
                ((role or "").upper(),),
            ).fetchall()
        return frozenset(name for (name,) in rows)

    def set_disabled(self, username: str, disabled: bool) -> None:
        uname = normalise_username(username)
        with self._admin() as con:
            if not pgroles.role_exists(con, uname):
                raise AuthError(f"No such user: {uname}")
            pgroles.set_disabled(con, uname, disabled)
        if disabled:
            # Khoá phải có hiệu lực NGAY, không đợi phiên hết hạn.
            self.revoke_all_sessions(uname)

    def set_password(
        self, username: str, password: str, must_change_password: bool = False
    ) -> None:
        """Đổi mật khẩu bằng quyền quản trị. Dùng cho `admin_cli`.

        Người dùng tự đổi mật khẩu của mình thì đi qua `change_own_password`,
        không cần quyền gì cả.
        """
        uname = normalise_username(username)
        validate_password_strength(password, uname)
        with self._admin() as con:
            if not pgroles.role_exists(con, uname):
                raise AuthError(f"No such user: {uname}")
            pgroles.set_password(con, uname, password)
        self._mark_password_changed(uname, must_change_password)

    def change_own_password(
        self, username: str, current_password: str, new_password: str
    ) -> bool:
        """Người dùng tự đổi mật khẩu — KHÔNG cần quyền quản trị nào.

        PostgreSQL cho phép mọi vai trò `ALTER ROLE CURRENT_USER PASSWORD`. Nhờ
        vậy web app không bao giờ phải cầm `CREATEROLE`, và đây chính là lý do
        thiết kế này không phải đánh đổi quyền hạn để lấy sự đồng bộ.

        Trả về False nếu mật khẩu hiện tại sai.
        """
        uname = normalise_username(username)
        validate_password_strength(new_password, uname)
        if self._user_conninfo is None:  # pragma: no cover
            raise AuthError("AuthStore thieu user_conninfo")
        # Tach phep NOI khoi phep DOI. Bản cũ để một `try:` ôm cả hai, nên một
        # `ALTER ROLE` hỏng (kết nối đứt sau khi đã xác thực xong) bị báo là
        # "mật khẩu hiện tại sai" — người dùng ăn một strike khoá, trong khi mật
        # khẩu thì có thể đã đổi thật.
        try:
            con = psycopg.connect(
                self._user_conninfo(uname, current_password), autocommit=True
            )
        except psycopg.Error as exc:
            if _is_bad_credentials(exc):
                return False
            raise AuthUnavailable(str(exc)) from exc
        with con:
            # Lỗi ở đây KHÔNG bao giờ là "sai mật khẩu hiện tại" — cứ để nó bay.
            #
            # Hỏi `scram_iterations` của chính máy chủ, giống `pgroles.set_password`:
            # nếu không, người vận hành NÂNG tham số đó sẽ chỉ có tác dụng lên
            # mật khẩu do quản trị đặt, còn học viên tự đổi thì vẫn ở mức sàn.
            verifier = pgroles.scram_sha256_verifier(
                new_password, iterations=pgroles.server_scram_iterations(con)
            )
            con.execute(
                sql.SQL("ALTER ROLE CURRENT_USER PASSWORD {}").format(
                    sql.Literal(verifier)
                )
            )
        self._mark_password_changed(uname, must_change_password=False)
        return True

    def _mark_password_changed(self, uname: str, must_change_password: bool) -> None:
        with self._conn() as con:
            con.execute(
                "INSERT INTO app.user_profile "
                "(username, must_change_password, created_at, password_changed_at) "
                "VALUES (%s,%s,%s,%s) "
                "ON CONFLICT (username) DO UPDATE SET "
                "must_change_password = EXCLUDED.must_change_password, "
                "password_changed_at = EXCLUDED.password_changed_at",
                (uname, must_change_password, _utc_now(), _utc_now()),
            )

    def reset_password(self, username: str) -> str:
        plaintext = generate_password()
        self.set_password(username, plaintext, must_change_password=True)
        self.revoke_all_sessions(username)
        return plaintext

    # -- xác thực ---------------------------------------------------------
    def verify_password(self, username: str, password: str) -> User | None:
        """Thử mở kết nối PostgreSQL bằng chính tài khoản đó.

        Nối được = mật khẩu đúng. Không có bản sao mật khẩu nào để so, và ứng
        dụng không bao giờ đọc `pg_authid`.

        Thất bại của NGƯỜI DÙNG đều trả về None như nhau — sai mật khẩu, không
        có người này, hay tài khoản bị `NOLOGIN` đều không phân biệt được từ bên
        ngoài.

        Thất bại của HẠ TẦNG thì ném `AuthUnavailable`, và đó là điểm khác so
        với bản trước. Gộp hai loại lại nghĩa là một lần PostgreSQL restart, hay
        một vai trò chạm `CONNECTION LIMIT` vì Power BI, bị báo cho học viên là
        "sai mật khẩu" — và bị `main.py` tính thành một strike khoá tài khoản.
        """
        uname = normalise_username(username)
        if not password or len(password) > MAX_PASSWORD_LENGTH:
            return None
        # Tên hỏng không bao giờ tới được libpq. Cũng là thứ chặn `aivb_app_rw`
        # bị THỬ làm tên đăng nhập: trước đây nó nối được thật, chỉ bị loại sau
        # đó vì `app.role_of` trả NULL — đúng một lớp phòng thủ.
        #
        # Có, việc này tạo chênh lệch thời gian giữa "tên sai cú pháp" (tức thì)
        # và "tên hợp lệ nhưng không tồn tại" (nối đầy đủ + PBKDF2 100k vòng).
        # Không rò gì: văn phạm tên là công khai, nó nằm ngay trong `_NAME_RE`.
        # Tính chất mà bộ test bảo vệ (`test_unknown_user_and_wrong_password_
        # cost_the_same_time`) so hai tên HỢP LỆ, không đụng tới.
        if not pgroles.is_valid_username(uname):
            return None
        if self._user_conninfo is None:  # pragma: no cover
            raise AuthError("AuthStore thieu user_conninfo")
        try:
            with psycopg.connect(
                self._user_conninfo(uname, password), autocommit=True
            ) as con:
                con.execute("SELECT 1")
        except psycopg.Error as exc:
            if _is_bad_credentials(exc):
                return None
            raise AuthUnavailable(str(exc)) from exc
        user = self.get_user(uname)
        if user is None or user.disabled:
            return None
        return user

    def record_login(self, username: str) -> None:
        with self._conn() as con:
            con.execute(
                "INSERT INTO app.user_profile (username, created_at, last_login_at) "
                "VALUES (%s,%s,%s) "
                "ON CONFLICT (username) DO UPDATE SET last_login_at = EXCLUDED.last_login_at",
                (normalise_username(username), _utc_now(), _utc_now()),
            )

    # -- chặn đăng nhập sai ------------------------------------------------
    def lock_remaining(self, scope: str, key: str, now: float | None = None) -> float:
        now = time.time() if now is None else now
        with self._conn() as con:
            row = con.execute(
                "SELECT locked_until FROM app.throttle WHERE scope = %s AND key = %s",
                (scope, key),
            ).fetchone()
        if row is None:
            return 0.0
        return max(0.0, float(row[0]) - now)

    def record_failure(self, scope: str, key: str, now: float | None = None) -> float:
        """Cộng một lượt sai, rồi trả về độ dài khoá tương ứng.

        Phép cộng do PostgreSQL làm, KHÔNG phải đọc-rồi-ghi trong Python. Bản
        cũ `SELECT fail_count` rồi ghi lại `EXCLUDED.fail_count`, không
        `FOR UPDATE`, không khoá gì (bản SQLite giữ `_write_lock` suốt cả
        read-modify-write, phép chuyển đánh rơi nó mà không thay bằng gì). N lần
        sai đồng thời cùng đọc N và cùng ghi N+1, nên một đợt dò song song bị
        đếm hụt — đúng vào trường hợp `ThrottlePolicy` sinh ra để chặn.

        Hai câu lệnh này nguyên tử vì pool KHÔNG autocommit: `AuthStore._pool`
        dựng không `kwargs`, nên `psycopg_pool` phát connection `autocommit=False`
        và `pool.connection()` commit lúc thoát. `ON CONFLICT DO UPDATE` giữ khoá
        hàng tới lúc commit, nên luồng thứ hai CHỜ chứ không xen kẽ. Ai đó thêm
        `autocommit=True` vào pool là race quay lại, lặng lẽ.
        """
        now = time.time() if now is None else now
        with self._conn() as con:
            row = con.execute(
                "INSERT INTO app.throttle AS t "
                "(scope, key, fail_count, locked_until, updated_at) "
                "VALUES (%s,%s,1,0,%s) "
                "ON CONFLICT (scope, key) DO UPDATE SET "
                "fail_count = t.fail_count + 1, updated_at = EXCLUDED.updated_at "
                "RETURNING t.fail_count",
                (scope, key, now),
            ).fetchone()
            fails = int(row[0])
            delay = self.throttle.delay_for(scope, fails)
            # `GREATEST` la dai phong ho, khong phai co che: da tuan tu hoa thi
            # so dem don dieu roi. No chi bao dam khoa khong bao gio NGAN DI.
            con.execute(
                "UPDATE app.throttle SET locked_until = GREATEST(locked_until, %s) "
                "WHERE scope = %s AND key = %s",
                (now + delay, scope, key),
            )
        return delay

    def clear_failures(self, scope: str, key: str) -> None:
        with self._conn() as con:
            con.execute(
                "DELETE FROM app.throttle WHERE scope = %s AND key = %s", (scope, key)
            )

    def fail_count(self, scope: str, key: str) -> int:
        with self._conn() as con:
            row = con.execute(
                "SELECT fail_count FROM app.throttle WHERE scope = %s AND key = %s",
                (scope, key),
            ).fetchone()
        return int(row[0]) if row else 0

    # -- phiên -------------------------------------------------------------
    def create_session(
        self,
        username: str,
        role: str,
        ip: str = "",
        user_agent: str = "",
        now: float | None = None,
    ) -> tuple[str, Session]:
        """Cấp một phiên. Trả về (token thô, phiên).

        Token thô rời khỏi hàm này đúng một lần, vào header Set-Cookie. Chỉ
        SHA-256 của nó được lưu, nên một bản dump database không cho ra phiên
        dùng được.
        """
        now = time.time() if now is None else now
        raw = secrets.token_urlsafe(32)
        digest = hash_token(raw)
        absolute = now + self.session_policy.absolute_timeout_s
        uname = normalise_username(username)
        with self._conn() as con:
            con.execute(
                "INSERT INTO app.sessions (token_hash, username, created_at, "
                "last_seen_at, absolute_expires_at, revoked, ip, user_agent) "
                "VALUES (%s,%s,%s,%s,%s,false,%s,%s)",
                (digest, uname, now, now, absolute, ip[:64], user_agent[:200]),
            )
        user = self.get_user(uname)
        return raw, Session(
            token_hash=digest,
            username=uname,
            role=role,
            created_at=now,
            last_seen_at=now,
            absolute_expires_at=absolute,
            idle_expires_at=now + self.session_policy.idle_timeout_s,
            must_change_password=bool(user.must_change_password) if user else False,
        )

    def validate_session(
        self, raw_token: str, now: float | None = None, touch: bool = True
    ) -> Session | None:
        """Đổi giá trị cookie thành một phiên còn sống, hoặc None.

        Vai trò và trạng thái khoá được ĐỌC LẠI TỪ PostgreSQL trên mỗi request,
        nên một tài khoản bị giảng viên khoá ngừng chạy ngay lập tức chứ không
        phải chờ tới lần hết hạn kế tiếp. Cột `role` cố ý không lưu trong bảng
        phiên vì lý do đó.
        """
        if not raw_token or len(raw_token) > 256:
            return None
        now = time.time() if now is None else now
        digest = hash_token(raw_token)
        with self._conn() as con:
            row = con.execute(
                """
                SELECT s.token_hash, s.username, s.created_at, s.last_seen_at,
                       s.absolute_expires_at, s.revoked,
                       app.role_of(s.username)                AS role,
                       NOT r.rolcanlogin                      AS disabled,
                       COALESCE(p.must_change_password, true) AS must_change
                FROM app.sessions s
                JOIN pg_roles r ON r.rolname = s.username
                LEFT JOIN app.user_profile p ON p.username = s.username
                WHERE s.token_hash = %s
                """,
                (digest,),
            ).fetchone()
        if row is None:
            return None
        if not hmac.compare_digest(str(row[0]), digest):
            return None  # pragma: no cover - không tới được qua so bằng SQL
        if row[5]:
            return None
        if row[7]:  # disabled
            return None
        if row[6] is None:  # không còn thuộc nhóm lớp nào
            return None
        if now >= float(row[4]):
            self.revoke_session_hash(digest)
            return None
        idle_deadline = float(row[3]) + self.session_policy.idle_timeout_s
        if now >= idle_deadline:
            self.revoke_session_hash(digest)
            return None

        if touch:
            with self._conn() as con:
                con.execute(
                    "UPDATE app.sessions SET last_seen_at = %s WHERE token_hash = %s",
                    (now, digest),
                )
            last_seen = now
        else:
            last_seen = float(row[3])

        return Session(
            token_hash=digest,
            username=row[1],
            role=row[6],
            created_at=float(row[2]),
            last_seen_at=last_seen,
            absolute_expires_at=float(row[4]),
            idle_expires_at=last_seen + self.session_policy.idle_timeout_s,
            must_change_password=bool(row[8]),
        )

    def revoke_session(self, raw_token: str) -> bool:
        return self.revoke_session_hash(hash_token(raw_token)) if raw_token else False

    def revoke_session_hash(self, token_hash: str) -> bool:
        with self._conn() as con:
            cur = con.execute(
                "UPDATE app.sessions SET revoked = true "
                "WHERE token_hash = %s AND revoked = false",
                (token_hash,),
            )
            return cur.rowcount > 0

    def revoke_all_sessions(self, username: str) -> int:
        with self._conn() as con:
            cur = con.execute(
                "UPDATE app.sessions SET revoked = true "
                "WHERE username = %s AND revoked = false",
                (normalise_username(username),),
            )
            return cur.rowcount

    def expire_session_now(self, raw_token: str) -> None:
        """Tiện ích cho test/vận hành: đẩy một phiên qua cửa sổ nhàn rỗi."""
        digest = hash_token(raw_token)
        past = time.time() - self.session_policy.idle_timeout_s - 1
        with self._conn() as con:
            con.execute(
                "UPDATE app.sessions SET last_seen_at = %s WHERE token_hash = %s",
                (past, digest),
            )

    #: Bao lau thi mot hang `app.throttle` da het khoa duoc coi la rac.
    THROTTLE_RETENTION_S = 24 * 3600.0

    def purge_expired(self, now: float | None = None) -> int:
        """Dọn phiên hết hạn VÀ các hàng `app.throttle` đã nguội.

        `app.throttle` trước đây không có ai dọn, mà khoá của nó thì do kẻ gọi
        chọn: `main.py` ghi `record_failure("user", <username thẳng từ body>)`
        trên đường CHƯA xác thực. Một hàng mỗi request, không giới hạn — phình
        bảng chậm rãi trên database trạng thái, và không cần đăng nhập được.
        `login` vốn đã gọi hàm này sau mỗi lần thành công.
        """
        now = time.time() if now is None else now
        cutoff = now - self.session_policy.idle_timeout_s
        with self._conn() as con:
            cur = con.execute(
                "DELETE FROM app.sessions WHERE revoked = true "
                "OR absolute_expires_at < %s OR last_seen_at < %s",
                (now, cutoff),
            )
            removed = cur.rowcount
            con.execute(
                "DELETE FROM app.throttle WHERE locked_until < %s AND updated_at < %s",
                (now, now - self.THROTTLE_RETENTION_S),
            )
            return removed

    def active_session_count(self, username: str | None = None) -> int:
        with self._conn() as con:
            if username is None:
                row = con.execute(
                    "SELECT count(*) FROM app.sessions WHERE revoked = false"
                ).fetchone()
            else:
                row = con.execute(
                    "SELECT count(*) FROM app.sessions "
                    "WHERE revoked = false AND username = %s",
                    (normalise_username(username),),
                ).fetchone()
        return int(row[0])
