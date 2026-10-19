"""Dong bo user AIV Bank sang database cua game (`candy_game`).

Hai duong vao cung mot ham SQL `aivb_upsert_account` (migration 0013 cua
game), nen chi co MOT logic tao/cap nhat tai khoan:

  * SSO luc hoc vien mo tab Tro choi - game tu goi ham do;
  * file nay - dong bo HANG LOAT (`admin_cli game-sync`) va dong bo tung
    nguoi ngay khi `admin_cli create-user` / `import-csv` tao xong.

Nguon su that la `AuthStore.list_users()` (vai tro PostgreSQL + `app.user_profile`).
User bi xoa HOAC bi khoa ben AIV Bank -> tai khoan game bi `disabled` va moi
phien game cua ho bi thu hoi (`aivb_disable_missing`).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import psycopg

from .authstore import User


@dataclass(frozen=True)
class SyncResult:
    created: int
    updated: int
    disabled: int

    def __str__(self) -> str:
        return f"tao moi {self.created}, cap nhat {self.updated}, vo hieu hoa {self.disabled}"


def _role(user: User) -> str:
    return "instructor" if user.role.upper() == "INSTRUCTOR" else "student"


def sync_all(users: Iterable[User], conninfo: str) -> SyncResult:
    """Dua `candy_game` ve dung danh sach `users`, trong MOT giao dich."""
    active = [u for u in users if not u.disabled]
    with psycopg.connect(conninfo, connect_timeout=5) as con:
        with con.transaction():
            known = {
                row[0]
                for row in con.execute(
                    "SELECT provider_subject FROM account_identities "
                    "WHERE provider = 'aivb' AND deleted_at IS NULL"
                )
            }
            for user in active:
                con.execute(
                    "SELECT aivb_upsert_account(%s, %s, %s)",
                    (user.username, user.full_name or user.username, _role(user)),
                )
            disabled = con.execute(
                "SELECT aivb_disable_missing(%s)", ([u.username for u in active],)
            ).fetchone()[0]
    created = sum(1 for u in active if u.username not in known)
    return SyncResult(created=created, updated=len(active) - created, disabled=disabled)


def upsert_one(user: User, conninfo: str) -> None:
    with psycopg.connect(conninfo, connect_timeout=5, autocommit=True) as con:
        con.execute(
            "SELECT aivb_upsert_account(%s, %s, %s)",
            (user.username, user.full_name or user.username, _role(user)),
        )
