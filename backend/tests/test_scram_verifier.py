"""Bam mat khau PHIA CLIENT, de plaintext khong roi tien trinh.

`ALTER ROLE ... PASSWORD '<plaintext>'` dat mat khau THO vao than cau lenh: no
hien trong `pg_stat_activity.query` voi bat ky superuser hay thanh vien
`pg_read_all_stats` nao trong luc cau lenh chay, va vao log may chu neu cau
lenh loi (`log_min_error_statement = error` la mac dinh) hay neu ai do bat
`log_statement = ddl`. Ban SQLite chua bao gio de plaintext roi tien trinh.

THAM HOA LANG - ly do file nay ton tai
======================================
Neu chuoi dua vao `ALTER ROLE ... PASSWORD` KHONG dung khuon verifier thi
PostgreSQL **khong bao loi**: `encrypt_password()` roi xuong coi no la
CLEARTEXT roi bam. Mat khau tai khoan lang le tro thanh dung chuoi
"SCRAM-SHA-256$..." do, khong ai dang nhap duoc, va log khong noi mot loi nao.

`test_postgres_stores_our_verifier_verbatim` la phep kiem DUY NHAT phan biet
duoc "luu nguyen van" voi "bam nhu cleartext".
"""

from __future__ import annotations

import base64

import psycopg
import pytest

from backend import pgroles

#: Vector cong bo trong RFC 7677 muc 3 (user `user`, password `pencil`).
#: Da tinh lai va doi chieu: `StoredKey`/`ServerKey` duoi day tai tao dung
#: `p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=` va
#: `v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=` ma RFC in ra.
RFC7677_SALT = base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ==")
RFC7677_VERIFIER = (
    "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$"
    "WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:"
    "wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU="
)


def test_scram_verifier_matches_the_published_test_vector(monkeypatch):
    """Known-answer, khong can may chu.

    Ha san bang `monkeypatch` chu KHONG them mot cua thoat vao chinh ham: mot
    san co cua thoat thi khong con la san. Duong chay that luon >= 100000.
    """
    monkeypatch.setattr(pgroles, "SCRAM_MIN_ITERATIONS", 4096)
    got = pgroles.scram_sha256_verifier("pencil", iterations=4096, salt=RFC7677_SALT)
    assert got == RFC7677_VERIFIER


def test_the_iteration_floor_holds_and_the_salt_is_random():
    first = pgroles.scram_sha256_verifier("mot-mat-khau-du-dai", iterations=1000)
    second = pgroles.scram_sha256_verifier("mot-mat-khau-du-dai", iterations=1000)
    assert int(first.split("$")[1].split(":")[0]) == pgroles.SCRAM_MIN_ITERATIONS
    assert pgroles._SCRAM_VERIFIER_RE.match(first)
    # Cung mat khau, hai verifier khac nhau: muoi phai ngau nhien.
    assert first != second


def test_a_non_ascii_password_is_refused_before_it_can_brick_an_account():
    """SASLprep: bam sai o day nghia la tai khoan chet VINH VIEN.

    SCRAM bat client ap SASLprep (RFC 4013) truoc `Hi()`. libpq lam viec do luc
    dang nhap. Python khong co SASLprep, nen ta thu hep dau vao cho toi khi
    SASLprep THANH ham dong nhat - ASCII in duoc. Voi mot lop tieng Viet day la
    rui ro song: `nguyễn` NFKC ra khac nhau tuy cach go.
    """
    with pytest.raises(pgroles.RoleError):
        pgroles.scram_sha256_verifier("mật-khẩu-rất-dài-lắm")
    with pytest.raises(pgroles.RoleError):
        pgroles.scram_sha256_verifier("co\ttab-trong-mat-khau")
    # Khoang trang thi VAN duoc: rang buoc la SASLprep, khong phai chuoi ket noi.
    assert pgroles.scram_sha256_verifier("correct horse battery staple")


def test_the_plaintext_never_appears_in_the_statement_text():
    """Ghi lai moi cau lenh `set_password` gui di, roi tim chuoi mat khau."""
    marker = "a-very-secret-marker-2026"
    recorded: list[str] = []

    class _Recorder:
        def execute(self, query, params=None):
            recorded.append(
                query.as_string() if hasattr(query, "as_string") else str(query)
            )
            return self

        def fetchone(self):
            return ("100000",)

    pgroles.set_password(_Recorder(), "sv001", marker)
    assert recorded, "khong ghi duoc cau lenh nao"
    assert not any(marker in stmt for stmt in recorded), (
        "mat khau THO nam trong than cau lenh"
    )
    assert any("SCRAM-SHA-256$" in stmt for stmt in recorded)


def test_postgres_stores_our_verifier_verbatim(pg_store, admin_dsn):
    """Phep kiem chong THAM HOA LANG - xem docstring dau file.

    (c) la khang dinh mang tat ca suc nang: neu PostgreSQL da coi chuoi cua ta
    la cleartext roi bam, thi dang nhap BANG CHINH CHUOI DO se thanh cong.
    """
    password = "known-user-pw-2026"
    pg_store.create_user(
        "known_user", "STUDENT", password=password, must_change_password=False
    )
    with psycopg.connect(admin_dsn) as con:
        stored = con.execute(
            "SELECT rolpassword FROM pg_authid WHERE rolname = %s", ("known_user",)
        ).fetchone()[0]

    # (a) dung khuon, va gia KDF khong tut ve mac dinh 4096 cua PostgreSQL
    assert pgroles._SCRAM_VERIFIER_RE.match(stored), stored[:40]
    assert int(stored.split("$")[1].split(":")[0]) >= pgroles.SCRAM_MIN_ITERATIONS
    # (b) mat khau that van dang nhap duoc
    assert pg_store.verify_password("known_user", password) is not None
    # (c) chuoi verifier thi KHONG
    assert pg_store.verify_password("known_user", stored) is None
