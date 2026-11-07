"""So do du lieu cua database game (`candy_game`, schema `jelly_analytics`).

Day KHONG phai mot bo du lieu cua console: hoc vien truy van no bang psql /
Power BI qua cong 5433 (`database/schema/19_game_class_access.sql`), con console
chi ve so do de ho biet bang nao noi voi bang nao truoc khi viet SQL.

Ba gioi han, ca ba deu fail-closed:

  * CHI schema `jelly_analytics`. Schema `public` cua game chua tai khoan, token
    va vi; ham nay khong bao gio doc ten nao trong do.
  * CHI nhung quan he `candy_reader` (role ma lop hoc duoc cap) SELECT duoc.
    Mot bang hoc vien khong doc duoc thi cung khong len so do.
  * CHI catalog. Ket noi la `candy_app` (backend khong co ket noi nao khac toi
    database nay), nhung giao dich la READ ONLY va khong co cau nao cham du lieu.

Quan he suy luan
----------------
`jelly_analytics` khong khai bao FOREIGN KEY nao (dem ngay 2026-11-07: 0). Bo
du lieu duoc nap tu file phang, nen rang buoc khong duoc dung lai. Nhung ten cot
nhat quan: `user_id` o moi bang su kien la `users.user_id`, `session_id` la
`sessions.session_id`... Vi vay, KHI VA CHI KHI schema khong co FK nao, so do
suy ra canh theo mot luat chat:

    cot X cua bang T  ->  bang U (U != T) co khoa chinh MOT cot ten dung la X

Canh suy luan mang `inferred: true` de giao dien ve khac di (net dut) va noi ro
day la suy luan. Mot FK that xuat hien la luat nay tu tat.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import psycopg

from .config import Settings
from .db import _pg_display_type, fetch_foreign_keys

GAME_SCHEMA = "jelly_analytics"
#: Role ma lop hoc duoc cap tren candy_game. So do chi ve nhung gi role nay doc duoc.
CLASS_READER = "candy_reader"
CACHE_TTL_S = 600.0


class GameSchemaUnavailable(RuntimeError):
    """Game chua bat, hoac database game khong ket noi duoc."""


@dataclass(frozen=True)
class GameColumn:
    name: str
    type: str
    nullable: bool
    primary_key: bool


@dataclass(frozen=True)
class GameTable:
    name: str
    kind: str  # 'table' | 'view'
    columns: tuple[GameColumn, ...]


@dataclass(frozen=True)
class GameEdge:
    from_table: str
    from_columns: tuple[str, ...]
    to_table: str
    to_columns: tuple[str, ...]
    inferred: bool


@dataclass(frozen=True)
class GameSchema:
    schema: str
    tables: tuple[GameTable, ...]
    relationships: tuple[GameEdge, ...]


_TABLES_SQL = """
    SELECT lower(c.relname), c.relkind::text
    FROM pg_class c
    WHERE c.relnamespace = %s::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND NOT c.relispartition
      AND has_table_privilege(%s, c.oid, 'SELECT')
    ORDER BY 1
"""

_COLUMNS_SQL = """
    SELECT lower(c.table_name), c.column_name, c.data_type, c.is_nullable,
           c.numeric_precision, c.numeric_scale
    FROM information_schema.columns c
    WHERE c.table_schema = %s
    ORDER BY 1, c.ordinal_position
"""

_PK_SQL = """
    SELECT lower(c.relname), a.attname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND c.relnamespace = %s::regnamespace
"""


def introspect(con: psycopg.Connection) -> GameSchema:
    """Doc catalog cua `jelly_analytics` tren mot ket noi da mo."""
    kinds = {
        name: ("view" if kind in ("v", "m") else "table")
        for name, kind in con.execute(_TABLES_SQL, (GAME_SCHEMA, CLASS_READER)).fetchall()
    }
    pks: dict[str, set[str]] = {}
    for tname, col in con.execute(_PK_SQL, (GAME_SCHEMA,)).fetchall():
        pks.setdefault(tname, set()).add(col)

    cols: dict[str, list[GameColumn]] = {}
    for tname, col, dtype, nullable, precision, scale in con.execute(
        _COLUMNS_SQL, (GAME_SCHEMA,)
    ).fetchall():
        if tname not in kinds:
            continue  # khong doc duoc -> khong ton tai tren so do
        cols.setdefault(tname, []).append(
            GameColumn(
                name=col,
                type=_pg_display_type(dtype, precision, scale),
                nullable=str(nullable).upper() == "YES",
                primary_key=col in pks.get(tname, set()),
            )
        )

    tables = tuple(
        GameTable(name=name, kind=kinds[name], columns=tuple(cols.get(name, ())))
        for name in sorted(kinds)
    )
    declared = fetch_foreign_keys(con, GAME_SCHEMA)
    return GameSchema(
        schema=GAME_SCHEMA,
        tables=tables,
        relationships=build_edges(tables, declared),
    )


def build_edges(tables, declared) -> tuple[GameEdge, ...]:
    """FK that neu co; khong co FK nao thi moi suy luan theo ten cot.

    Ca hai nhanh chi giu canh ma HAI DAU deu la bang tren so do, voi dung cot
    co tren so do - cung luat voi `Catalog.relationships`.
    """
    by_name = {t.name: t for t in tables}
    present = {t.name: {c.name for c in t.columns} for t in tables}

    edges: list[GameEdge] = []
    for src, fks in sorted(declared.items()):
        if src not in by_name:
            continue
        for fk in fks:
            dst = fk.ref_table
            if dst not in by_name:
                continue
            if not set(fk.columns) <= present[src] or not set(fk.ref_columns) <= present[dst]:
                continue
            edges.append(GameEdge(src, fk.columns, dst, fk.ref_columns, inferred=False))
    if edges or any(declared.values()):
        return tuple(edges)

    # Bang dich: dung MOT cot khoa chinh. Khoa ghep (ab_assignments) khong lam
    # dich duoc, vi mot ten cot don le khong noi duoc toi no mot cach chac chan.
    single_pk: dict[str, str] = {}
    for t in tables:
        pk = [c.name for c in t.columns if c.primary_key]
        if t.kind == "table" and len(pk) == 1:
            # Hai bang cung khoa chinh mot ten -> mo ho, khong suy luan cot do.
            single_pk[pk[0]] = "" if pk[0] in single_pk else t.name
    for t in tables:
        for c in t.columns:
            dst = single_pk.get(c.name)
            if not dst or dst == t.name:
                continue
            edges.append(GameEdge(t.name, (c.name,), dst, (c.name,), inferred=True))
    return tuple(edges)


_cache_lock = threading.Lock()
_cache: tuple[float, GameSchema] | None = None


def load_game_schema(settings: Settings) -> GameSchema:
    """So do game, cache trong tien trinh `CACHE_TTL_S` giay.

    Catalog game chi doi khi chay migration, con moi lan mo tab ERD deu goi
    toi day; khong cache thi moi hoc vien ton mot ket noi toi candy_game.
    """
    global _cache
    if not settings.game_enabled:
        raise GameSchemaUnavailable("game is not enabled")
    with _cache_lock:
        if _cache and time.monotonic() - _cache[0] < CACHE_TTL_S:
            return _cache[1]
        try:
            with psycopg.connect(settings.pg_conninfo_game(), connect_timeout=5) as con:
                con.execute("SET TRANSACTION READ ONLY")
                schema = introspect(con)
                con.rollback()
        # Moi loi (thieu file mat khau, sai DSN, mat mang) deu chi co mot
        # nghia voi trinh duyet: "chua co so do game". Chi tiet o log, khong
        # o HTTP.
        except Exception as exc:  # noqa: BLE001
            raise GameSchemaUnavailable(type(exc).__name__) from exc
        _cache = (time.monotonic(), schema)
        return schema


def reset_cache() -> None:
    """Cho test."""
    global _cache
    with _cache_lock:
        _cache = None
