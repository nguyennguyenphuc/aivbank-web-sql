"""Goc chung cho cac loi VAN HANH cua kho danh tinh.

`pgroles.RoleError` va `authstore.AuthError` deu ke thua `OperatorError`.
Truoc day hai lop do doc lap nhau, ca hai deu ke thua thang `RuntimeError`, va
hau qua thi khong hien nhien chut nao:

`AuthStore.create_user` kiem vai tro va do manh mat khau, nhung TEN TAI KHOAN
lan dau duoc kiem la o sau trong `pgroles.ensure_role` -> `_ident`, cho do nem
`RoleError`. `admin_cli` chi bat `AuthError`. Nen mot o CSV hong - ten viet hoa,
co gach noi, hai ky tu, hay mot ten danh cho ha tang - lam `import-csv` chet
giua chung bang traceback, va vi `_print_credentials` chay SAU vong lap nen
MAT KHAU MOT LAN cua moi tai khoan da tao trong lan chay do mat vinh vien.
Vai tro PostgreSQL thi van con, nen lan chay sau bao "da co" roi bo qua.

Dat lop nay o file rieng chu khong o `pgroles` hay `authstore`: `authstore`
import `pgroles`, nen chieu nguoc lai la vong tron.
"""

from __future__ import annotations


class OperatorError(RuntimeError):
    """Sai sot cua nguoi VAN HANH, khong bao gio hien ra cho hoc vien."""
