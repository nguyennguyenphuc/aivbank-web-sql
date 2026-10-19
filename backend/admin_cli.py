"""Instructor CLI for the AIV Bank auth store.

There is no self-service registration endpoint, by design: the cohort is a
known list of people, and an open /auth/register on a service that fronts the
grading dataset is an invitation. Accounts are created here, on the server, by
someone with shell access.

    python -m backend.admin_cli list
    python -m backend.admin_cli create-user --username sv001 --role STUDENT
    python -m backend.admin_cli import-csv --file class_2026a.csv --role STUDENT
    python -m backend.admin_cli reset-password --username sv001
    python -m backend.admin_cli disable --username sv001
    python -m backend.admin_cli enable  --username sv001
    python -m backend.admin_cli sessions --revoke-user sv001
    python -m backend.admin_cli reapply-limits --dry-run

Initial and reset passwords are RANDOM and printed EXACTLY ONCE. They are not
stored in plaintext anywhere and cannot be recovered - reset again if lost.
Every such account is created with must_change_password set, so the printed
value only survives until the student's first sign-in.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from .authstore import ROLES, AuthStore, UserExistsError
from .config import settings
from .errors import OperatorError
from .pgadmin import admin_conninfo

#: Chuoi ket noi superuser. CHI file nay dung - backend co y KHONG co no.
def _admin_conninfo(args: argparse.Namespace) -> str:
    """Ket noi co quyen CREATEROLE, dung de tao/xoa/khoa vai tro PostgreSQL.

    Tach hoan toan khoi ket noi ma web app dung. Web app chua bao gio can
    quyen nay: hoc vien tu doi mat khau bang `ALTER ROLE CURRENT_USER`, mot
    thao tac moi vai tro deu lam duoc voi chinh no.

    Luat tim mat khau nam o `backend/pgadmin.py`, MOT ban cho ca CLI lan test.
    """
    return admin_conninfo(args.admin_dsn)


def _store(args: argparse.Namespace) -> AuthStore:
    return AuthStore(
        settings.pg_conninfo_app(),
        user_conninfo=settings.pg_conninfo_as_user,
        admin_conninfo=_admin_conninfo(args),
        # CLI mot luong: 2 la du. Ngan sach cua `aivb_app_rw` chia cho pool xac
        # thuc cua backend (4), pool diem so (6), va phan con lai - xem khoi chu
        # thich canh `pg_auth_pool_max` trong `backend/config.py`.
        pool_max=2,
    )


def _print_credentials(rows: list[tuple[str, str, str]]) -> None:
    if not rows:
        return
    print()
    print("=" * 72)
    print("ONE-TIME PASSWORDS - copy them now, they are not recoverable.")
    print("Every account must change its password at first sign-in.")
    print("=" * 72)
    width = max(len(r[0]) for r in rows)
    for username, role, password in rows:
        print(f"  {username.ljust(width)}  {role:<10}  {password}")
    print("=" * 72)
    print(f"{len(rows)} account(s). Distribute over a channel you trust.")


def _game_upsert(store: AuthStore, usernames: list[str]) -> None:
    """Dua user vua tao sang game ngay. BEST-EFFORT: game la tuy chon, nen
    game chua bat (thieu `pw_candy_app`, `candy_game` chua dung...) chi in canh
    bao - viec tao tai khoan AIV Bank KHONG duoc hong vi no. SSO luc mo tab
    Tro choi va `game-sync` deu bu lai sau."""
    if not usernames:
        return
    from . import game_sync

    try:
        conninfo = settings.pg_conninfo_game()
    except (OSError, KeyError, ValueError):
        return  # game chua bat tren may nay: im lang la dung
    done = 0
    for username in usernames:
        user = store.get_user(username)
        if user is None:
            continue
        try:
            game_sync.upsert_one(user, conninfo)
            done += 1
        except Exception as exc:  # noqa: BLE001
            print(f"warning: chua dong bo {username} sang game: {exc}", file=sys.stderr)
            return
    print(f"game: da dong bo {done} tai khoan sang {settings.pg_db_game}")


def cmd_game_sync(args: argparse.Namespace) -> int:
    """Dua `candy_game` ve dung danh sach tai khoan AIV Bank hien tai."""
    from . import game_sync

    store = _store(args)
    try:
        conninfo = settings.pg_conninfo_game()
    except (OSError, KeyError, ValueError) as exc:
        print(f"error: game chua cau hinh ({exc}). Xem scripts/Enable-Game.ps1", file=sys.stderr)
        return 2
    users = store.list_users()
    try:
        result = game_sync.sync_all(users, conninfo)
    except Exception as exc:  # noqa: BLE001
        print(f"error: dong bo that bai, KHONG doi gi (mot giao dich): {exc}", file=sys.stderr)
        return 1
    print(f"game-sync: {len(users)} tai khoan AIV Bank -> {settings.pg_db_game}: {result}")
    return 0


def cmd_create_user(args: argparse.Namespace) -> int:
    store = _store(args)
    try:
        user, password = store.create_user(
            username=args.username,
            role=args.role,
            password=args.password,
            full_name=args.full_name or "",
            must_change_password=not args.no_force_change,
        )
    except OperatorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.password:
        print(f"created {user.username} ({user.role}) with the supplied password")
    else:
        _print_credentials([(user.username, user.role, password)])
    _game_upsert(store, [user.username])
    return 0


def cmd_import_csv(args: argparse.Namespace) -> int:
    """Bulk-create a class list.

    CSV needs a `username` column; `full_name` and `role` are optional (role
    falls back to --role). Existing usernames are SKIPPED, never overwritten -
    a re-run must not silently reset a student who already changed their
    password.
    """
    store = _store(args)
    path = Path(args.file)
    if not path.exists():
        print(f"error: no such file: {path}", file=sys.stderr)
        return 2

    created: list[tuple[str, str, str]] = []
    skipped: list[str] = []
    failed: list[str] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames or "username" not in [
                (f or "").strip().lower() for f in reader.fieldnames
            ]:
                print("error: CSV must have a 'username' column", file=sys.stderr)
                return 2
            for row in reader:
                row = {
                    (k or "").strip().lower(): (v or "").strip()
                    for k, v in row.items()
                }
                username = row.get("username", "")
                if not username:
                    continue
                role = (row.get("role") or args.role or "STUDENT").upper()
                if role not in ROLES:
                    failed.append(f"{username}: bad role {role!r}")
                    continue
                try:
                    user, password = store.create_user(
                        username=username,
                        role=role,
                        full_name=row.get("full_name", ""),
                        must_change_password=True,
                    )
                    created.append((user.username, user.role, password))
                except UserExistsError:
                    skipped.append(username)
                except OperatorError as exc:
                    failed.append(f"{username}: {exc}")
                except Exception as exc:  # noqa: BLE001
                    # KHONG de mot loi khong luong truoc lam mat mat khau cua
                    # nhung nguoi da tao xong trong chinh lan chay nay.
                    failed.append(f"{username}: loi khong luong truoc: {exc!r}")
    finally:
        # In NGAY CA khi vong lap vo, ke ca Ctrl-C. Mat khau mot lan khong lay
        # lai duoc: vai tro PostgreSQL da ton tai nen lan chay sau bao "da co"
        # roi bo qua, con mat khau thi mat vinh vien. `finally` MOI la ban va;
        # cac lop ngoai le o tren la thu khien no khong phai dung toi.
        _print_credentials(created)
    if skipped:
        print(f"\nskipped {len(skipped)} existing account(s): {', '.join(skipped[:20])}"
              + (" ..." if len(skipped) > 20 else ""))
    if failed:
        print(f"\n{len(failed)} failure(s):", file=sys.stderr)
        for line in failed:
            print(f"  {line}", file=sys.stderr)
    _game_upsert(store, [username for username, _, _ in created])
    return 0 if not failed else 1


def cmd_reset_password(args: argparse.Namespace) -> int:
    store = _store(args)
    user = store.get_user(args.username)
    if user is None:
        print(f"error: no such user: {args.username}", file=sys.stderr)
        return 2
    try:
        password = store.reset_password(args.username)
    except OperatorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"all sessions for {user.username} were revoked")
    _print_credentials([(user.username, user.role, password)])
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    store = _store(args)
    try:
        store.set_disabled(args.username, True)
    except OperatorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"{args.username} disabled; live sessions revoked")
    return 0


def cmd_enable(args: argparse.Namespace) -> int:
    store = _store(args)
    try:
        store.set_disabled(args.username, False)
    except OperatorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"{args.username} enabled")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    store = _store(args)
    users = store.list_users()
    if not users:
        print("no accounts yet")
        return 0
    print(f"{'username':<24} {'role':<11} {'state':<10} {'sessions':>8}  last login")
    print("-" * 88)
    for user in users:
        state = "disabled" if user.disabled else ("first-login" if user.must_change_password else "active")
        print(
            f"{user.username:<24} {user.role:<11} {state:<10} "
            f"{store.active_session_count(user.username):>8}  {user.last_login_at or '-'}"
        )
    print(chr(10) + f"{len(users)} account(s) in PostgreSQL {settings.pg_db_app}")
    return 0


def cmd_sessions(args: argparse.Namespace) -> int:
    store = _store(args)
    if args.revoke_user:
        n = store.revoke_all_sessions(args.revoke_user)
        print(f"revoked {n} session(s) for {args.revoke_user}")
    if args.purge:
        n = store.purge_expired()
        print(f"purged {n} expired/revoked session row(s)")
    print(f"{store.active_session_count()} active session(s)")
    return 0


def cmd_reapply_limits(args: argparse.Namespace) -> int:
    """Ap lai han muc ket noi cho MOI vai tro lop dang ton tai.

    `pgroles.ensure_role` chi chay luc TAO vai tro, nen doi
    `DEFAULT_CONNECTION_LIMIT` / `DEFAULT_IDLE_SESSION_TIMEOUT` khong tu dong
    cham toi tai khoan da phat ra tu truoc. Lenh nay lam viec do.

    Dung `pgroles.apply_limits` chu KHONG dung `ensure_role`: `ensure_role`
    chay `ALTER ROLE ... LOGIN` nen se mo khoa lai moi tai khoan dang bi
    `disable`. Nho vay lenh nay ap duoc cho ca tai khoan da khoa ma khong doi
    trang thai khoa cua ho.
    """
    import psycopg

    from . import pgroles

    with psycopg.connect(_admin_conninfo(args), autocommit=True) as conn:
        rows = pgroles.list_class_roles(conn)
        if not rows:
            print("khong co vai tro lop nao")
            return 0
        print(
            f"connection_limit={pgroles.DEFAULT_CONNECTION_LIMIT}  "
            f"idle_session_timeout={pgroles.DEFAULT_IDLE_SESSION_TIMEOUT}  "
            f"idle_in_transaction_session_timeout={pgroles.DEFAULT_IDLE_IN_TXN_TIMEOUT}  "
            f"{'/'.join(pgroles.BI_DATABASES)}.idle_session_timeout={pgroles.DEFAULT_SCM_IDLE_SESSION_TIMEOUT}"
        )
        print()
        width = max(len(r[0]) for r in rows)
        for username, role, disabled in rows:
            state = "disabled" if disabled else "active"
            if args.dry_run:
                print(f"  [dry-run] {username.ljust(width)}  {role:<11} {state}")
                continue
            pgroles.apply_limits(conn, username)
            print(f"  ok        {username.ljust(width)}  {role:<11} {state}")
        print()
        verb = "se ap cho" if args.dry_run else "da ap cho"
        print(f"{verb} {len(rows)} vai tro.")
        if not args.dry_run:
            print(
                "Han muc moi chi ap dung cho KET NOI MOI. Ket noi dang mo giu "
                "nguyen han muc cu cho toi khi chung dong."
            )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.admin_cli",
        description="Manage AIV Bank SQL-interface accounts.",
    )
    parser.add_argument(
        "--admin-dsn",
        default=None,
        help="chuoi ket noi PostgreSQL co quyen CREATEROLE "
        "(mac dinh: superuser doc tu PGPASSWORD / config/pg_superuser.txt)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create-user", help="create one account")
    p.add_argument("--username", required=True)
    p.add_argument("--role", required=True, choices=list(ROLES))
    p.add_argument("--full-name", default="")
    p.add_argument(
        "--password",
        default=None,
        help="set an explicit password (discouraged: it lands in your shell history)",
    )
    p.add_argument(
        "--no-force-change",
        action="store_true",
        help="do not require a password change at first sign-in",
    )
    p.set_defaults(func=cmd_create_user)

    p = sub.add_parser("import-csv", help="bulk-create from a class list")
    p.add_argument("--file", required=True)
    p.add_argument("--role", default="STUDENT", choices=list(ROLES))
    p.set_defaults(func=cmd_import_csv)

    p = sub.add_parser("reset-password", help="new random password + revoke sessions")
    p.add_argument("--username", required=True)
    p.set_defaults(func=cmd_reset_password)

    p = sub.add_parser("disable", help="block an account and kill its sessions")
    p.add_argument("--username", required=True)
    p.set_defaults(func=cmd_disable)

    p = sub.add_parser("enable", help="unblock an account")
    p.add_argument("--username", required=True)
    p.set_defaults(func=cmd_enable)

    p = sub.add_parser(
        "game-sync",
        help="dong bo moi tai khoan sang database game (candy_game); "
        "tai khoan da xoa/khoa bi vo hieu hoa ben game",
    )
    p.set_defaults(func=cmd_game_sync)

    p = sub.add_parser("list", help="list accounts")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("sessions", help="inspect / revoke sessions")
    p.add_argument("--revoke-user", default=None)
    p.add_argument("--purge", action="store_true", help="delete expired session rows")
    p.set_defaults(func=cmd_sessions)

    p = sub.add_parser(
        "reapply-limits",
        help="ap lai han muc ket noi cho moi tai khoan lop da ton tai",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="chi in ra se ap cho ai, khong doi gi",
    )
    p.set_defaults(func=cmd_reapply_limits)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
