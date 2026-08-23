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

from .authstore import ROLES, AuthError, AuthStore
from .config import assert_auth_store_isolated, settings


def _store(args: argparse.Namespace) -> AuthStore:
    path = Path(args.auth_db or settings.auth_db_path)
    # Same fail-closed check the server runs: never create a credential store
    # inside a student-facing directory, even from the CLI.
    assert_auth_store_isolated(path, settings.dataset_paths())
    return AuthStore(path)


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
    except AuthError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.password:
        print(f"created {user.username} ({user.role}) with the supplied password")
    else:
        _print_credentials([(user.username, user.role, password)])
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
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or "username" not in [
            (f or "").strip().lower() for f in reader.fieldnames
        ]:
            print("error: CSV must have a 'username' column", file=sys.stderr)
            return 2
        for row in reader:
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
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
            except AuthError as exc:
                if "already exists" in str(exc):
                    skipped.append(username)
                else:
                    failed.append(f"{username}: {exc}")

    _print_credentials(created)
    if skipped:
        print(f"\nskipped {len(skipped)} existing account(s): {', '.join(skipped[:20])}"
              + (" ..." if len(skipped) > 20 else ""))
    if failed:
        print(f"\n{len(failed)} failure(s):", file=sys.stderr)
        for line in failed:
            print(f"  {line}", file=sys.stderr)
    return 0 if not failed else 1


def cmd_reset_password(args: argparse.Namespace) -> int:
    store = _store(args)
    user = store.get_user(args.username)
    if user is None:
        print(f"error: no such user: {args.username}", file=sys.stderr)
        return 2
    password = store.reset_password(args.username)
    print(f"all sessions for {user.username} were revoked")
    _print_credentials([(user.username, user.role, password)])
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    store = _store(args)
    try:
        store.set_disabled(args.username, True)
    except AuthError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"{args.username} disabled; live sessions revoked")
    return 0


def cmd_enable(args: argparse.Namespace) -> int:
    store = _store(args)
    try:
        store.set_disabled(args.username, False)
    except AuthError as exc:
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
    print(f"\n{len(users)} account(s) in {store.path}")
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.admin_cli",
        description="Manage AIV Bank SQL-interface accounts.",
    )
    parser.add_argument(
        "--auth-db",
        default=None,
        help=f"auth store path (default: {settings.auth_db_path})",
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

    p = sub.add_parser("list", help="list accounts")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("sessions", help="inspect / revoke sessions")
    p.add_argument("--revoke-user", default=None)
    p.add_argument("--purge", action="store_true", help="delete expired session rows")
    p.set_defaults(func=cmd_sessions)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
