"""Permission catalog - TABLE level *and* COLUMN level.

Source of truth for *what a student may reference* is the intersection of:

  A. the column contract `20.CFG Column Contract` (+ the delta overlay)
  B. what physically exists in the connected DuckDB file

Intersecting is deliberate and fail-closed in both directions:

  * If the connected DB is the FULL database by misconfiguration, the 12
    INSTRUCTOR tables are still not in (A) so they stay unreachable.
  * If a table appears in the DB that the contract never described, it is not
    in (A) either, so it is not exposed.

Why this file grew a column dimension (2026-08-04)
--------------------------------------------------
Until the mentor's ruling of 2026-08-04, `student_visibility` was effectively a
per-TABLE flag: every column of a table carried the same value, so a table-level
allowlist was a complete implementation of the contract.

That ruling moved `raw_account_transaction.dirty_flag` to INSTRUCTOR while the
other five columns of that table stay STUDENT. The table is therefore MIXED, and
a table-level allowlist can only answer it two ways, both wrong:

  * treat the table as STUDENT  -> the answer key leaks through one column;
  * treat the table as INSTRUCTOR -> students lose the five columns the
    contract grants them, and the raw-staging exercise becomes unteachable.

So visibility is now resolved per column, from the per-column
`student_visibility` values in the contract's `columns` array (which is the
authoritative record - the per-table value in `tables` is only a summary):

  * a table is student-visible iff it has >= 1 STUDENT column;
  * a student catalog carries ONLY that table's STUDENT columns, so
    /schema and /schema/tables never mention a withheld column;
  * `restricted_columns` feeds api/guard.py, which refuses any query naming
    one of them (defense layer 2) - see guard._check_column.

NOTE ON PREFIXES: the handoff docs describe STUDENT tables as the
`raw_/ref_/core_/bridge_/fact_/mart_` prefixes, but the contract actually marks
`hist_customer_segment` and `organization_financial_snapshot` as STUDENT too.
A prefix-based allowlist would therefore be *wrong*. We only ever use explicit
names read from the contract.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .release_contract import ReleaseContractError, load_visibility_policy


class CatalogError(RuntimeError):
    pass


@dataclass(frozen=True)
class ColumnInfo:
    name: str
    duckdb_type: str
    nullable: bool
    is_primary_key: bool


@dataclass(frozen=True)
class ForeignKeyInfo:
    """Mot rang buoc FOREIGN KEY, doc tu `pg_constraint` cua CHINH database.

    `columns[i]` tro toi `ref_columns[i]` - giu thu tu de FK nhieu cot van
    ghep dung cap. Chi dung de ve so do ERD; guard khong bao gio dua vao no.
    """

    columns: tuple[str, ...]
    ref_table: str
    ref_columns: tuple[str, ...]


@dataclass(frozen=True)
class TableInfo:
    name: str
    columns: tuple[ColumnInfo, ...]
    row_count: int | None = None
    foreign_keys: tuple[ForeignKeyInfo, ...] = ()


@dataclass(frozen=True)
class ContractVisibility:
    """What the column contract says, resolved to the column level.

    `student_tables`     tables with at least one STUDENT column.
    `restricted_tables`  tables with no STUDENT column at all (the 12).
    `student_columns`    table -> the STUDENT column names of that table.
    `restricted_columns` table -> the non-STUDENT column names of a table that
                         is otherwise student-visible (the MIXED case). Tables
                         in `restricted_tables` are absent here: they are
                         withheld whole, so listing their columns would only
                         duplicate the table rule.
    """

    student_tables: frozenset[str]
    restricted_tables: frozenset[str]
    student_columns: dict[str, frozenset[str]]
    restricted_columns: dict[str, frozenset[str]]

    @property
    def mixed_tables(self) -> frozenset[str]:
        return frozenset(t for t, cols in self.restricted_columns.items() if cols)

    @property
    def restricted_column_names(self) -> frozenset[str]:
        """Every withheld column name, flattened and lower-cased.

        The guard matches on the bare name rather than on (table, column)
        because resolving an unqualified column to its table needs full scope
        analysis, and getting that subtly wrong is exactly how column-level
        filters leak. A flat name check over-blocks at worst (a student who
        aliases something *to* a withheld name), and over-blocking is the safe
        direction. Verified against the contract: no student-visible column
        anywhere shares a name with a withheld one, so the over-block set is
        currently empty.
        """
        names: set[str] = set()
        for cols in self.restricted_columns.values():
            names |= set(cols)
        return frozenset(names)


def load_contract_visibility(contract_path: Path) -> ContractVisibility:
    """Resolve the contract to per-table and per-column visibility.

    Fail closed everywhere: anything whose `student_visibility` is not exactly
    the string "STUDENT" is treated as restricted, a table that the `columns`
    array does not describe is treated as restricted, and a table whose STUDENT
    column set comes out empty is withheld whole.
    """
    if not contract_path.exists():
        raise CatalogError(f"column contract not found: {contract_path}")

    data = json.loads(contract_path.read_text(encoding="utf-8"))
    tables = data.get("tables")
    if not isinstance(tables, dict) or not tables:
        raise CatalogError(f"column contract has no usable 'tables' object: {contract_path}")

    columns = data.get("columns")
    if not isinstance(columns, list) or not columns:
        raise CatalogError(
            f"column contract has no usable 'columns' array: {contract_path}. "
            "Column-level visibility cannot be resolved, so the API refuses to "
            "start rather than fall back to a table-level guess."
        )

    student_cols: dict[str, set[str]] = {}
    restricted_cols: dict[str, set[str]] = {}
    described: set[str] = set()
    for entry in columns:
        if not isinstance(entry, dict):
            continue
        table = str(entry.get("table_name", "")).lower()
        column = str(entry.get("column_name", "")).lower()
        if not table or not column:
            continue
        described.add(table)
        bucket = student_cols if entry.get("student_visibility") == "STUDENT" else restricted_cols
        bucket.setdefault(table, set()).add(column)

    student: set[str] = set()
    restricted: set[str] = set()
    for name in tables:
        lowered = name.lower()
        if lowered not in described:
            # The contract lists the table but never describes its columns.
            # We cannot prove any column is student-visible => withhold it.
            restricted.add(lowered)
            continue
        if student_cols.get(lowered):
            student.add(lowered)
        else:
            restricted.add(lowered)

    if not student:
        raise CatalogError("column contract yielded 0 STUDENT tables - refusing to start")

    return ContractVisibility(
        student_tables=frozenset(student),
        restricted_tables=frozenset(restricted),
        student_columns={t: frozenset(c) for t, c in student_cols.items() if t in student},
        # Only MIXED tables matter here; a fully restricted table is already
        # unreachable by name.
        restricted_columns={
            t: frozenset(c) for t, c in restricted_cols.items() if t in student and c
        },
    )


class Catalog:
    """Immutable snapshot built once at startup.

    `allowed_tables`  -> names a student query may reference.
    `physical_tables` -> every relation name that physically exists in the DB.
                         Used to stop CTE-shadowing attacks (a CTE may not be
                         named after a real relation).
    `restricted_column_names`
                      -> column names a student query may not reference at all.
                         Empty on an instructor catalog.
    `withheld_columns_present`
                      -> the subset of those that PHYSICALLY exist in this
                         file. Non-empty only when the connected database still
                         carries a column the contract withholds (a stale build
                         or a misconfiguration); the guard uses it to decide
                         whether `SELECT *` over a MIXED table can leak.
    """

    def __init__(
        self,
        contract_path: Path,
        physical_tables: dict[str, TableInfo],
        database_name: str,
        expose_restricted: bool = False,
        owner_config_path: Path | None = None,
        schema_name: str = "main",
    ) -> None:
        """`expose_restricted` is the INSTRUCTOR catalog.

        It is *only* ever set for a connection opened against the instructor
        database, and only after the session's role has been read from the
        credential store. A student session is never handed a catalog built
        with this flag, and the two catalogs live on two different Database
        objects with two different DuckDB files underneath - so the split is
        not a boolean an attacker can flip, it is which connection their
        request reaches.
        """
        contract = load_contract_visibility(contract_path)
        try:
            owner_visibility = load_visibility_policy(owner_config_path) if owner_config_path else None
        except ReleaseContractError as exc:
            raise CatalogError(str(exc)) from exc
        self.contract = contract
        self.contract_student: frozenset[str] = contract.student_tables
        self.contract_restricted: frozenset[str] = contract.restricted_tables
        self.database_name: str = database_name
        self.expose_restricted: bool = expose_restricted
        self.object_aliases: dict[str, str] = (
            dict(owner_visibility["object_alias_resolution"]) if owner_visibility else {}
        )
        # Resolve aliases before applying the table denylist.  An alias whose
        # target is not instructor-only is invalid owner configuration and must
        # not silently become a new query surface.
        if owner_visibility:
            declared_restricted = owner_visibility["instructor_only_tables"]
            invalid_aliases = {
                alias: target for alias, target in self.object_aliases.items()
                if target not in declared_restricted
            }
            if invalid_aliases:
                raise CatalogError(
                    "owner object aliases must resolve to instructor-only tables: "
                    f"{invalid_aliases}"
                )
            # Owner-declared names that are absent from the physical/column
            # contract remain denied by default. They are still reserved below
            # for CTE collision checks; absence can never grant access.
            self.owner_declared_restricted = frozenset(declared_restricted)
        else:
            self.owner_declared_restricted = frozenset()

        self.physical_tables: frozenset[str] = frozenset(physical_tables)

        if expose_restricted:
            self._tables: dict[str, TableInfo] = dict(physical_tables)
            self.restricted_columns: dict[str, frozenset[str]] = {}
        else:
            self.restricted_columns = dict(contract.restricted_columns)
            self._tables = {}
            for name, info in physical_tables.items():
                if name not in contract.student_tables:
                    continue
                withheld = self.restricted_columns.get(name, frozenset())
                if withheld:
                    kept = tuple(c for c in info.columns if c.name.lower() not in withheld)
                    if not kept:
                        # Every physical column of this table is withheld.
                        # Nothing to serve, so do not advertise the table.
                        continue
                    kept_names = {c.name.lower() for c in kept}
                    info = TableInfo(
                        name=info.name,
                        columns=kept,
                        row_count=info.row_count,
                        # Mot FK dung tren cot bi giu lai se lo ten cot do qua
                        # so do ERD, nen no di cung cot.
                        foreign_keys=tuple(
                            fk for fk in info.foreign_keys
                            if all(c.lower() in kept_names for c in fk.columns)
                        ),
                    )
                self._tables[name] = info

        self.allowed_tables: frozenset[str] = frozenset(self._tables)
        self.restricted_column_names: frozenset[str] = (
            frozenset() if expose_restricted else contract.restricted_column_names
        )
        # Which withheld columns are really sitting in this file, as
        # "table.column". On a correctly built student.duckdb this is EMPTY
        # (defense layer 0 removed them); anything else means the guard is the
        # only thing standing between the student and the answer key.
        present: set[str] = set()
        leaky: set[str] = set()
        if not expose_restricted:
            for name, info in physical_tables.items():
                withheld = self.restricted_columns.get(name)
                if not withheld:
                    continue
                hits = {c.name.lower() for c in info.columns if c.name.lower() in withheld}
                if hits:
                    present |= {f"{name}.{c}" for c in hits}
                    if name in self._tables:
                        leaky.add(name)
        self.withheld_columns_present: frozenset[str] = frozenset(present)
        # Tables that still physically carry a withheld column. `SELECT *` over
        # one of these would hand the column back, so the guard refuses the star
        # (and only the star) for them.
        self.leaky_star_tables: frozenset[str] = frozenset(leaky)

        # Schemas a query may name explicitly. Anything else (information_schema,
        # pg_catalog, system, temp, an attached catalog) is refused.
        #
        # This check carries much more weight on PostgreSQL than it did on
        # DuckDB. Under DuckDB, `information_schema` was blocked here AND
        # `duckdb_tables()` was blocked by the function policy - two independent
        # layers. Under PostgreSQL, `pg_class` / `pg_attribute` / `pg_proc` are
        # ordinary world-readable tables that are always implicitly in scope and
        # CANNOT be revoked (doing so breaks psql, Power BI, and every driver's
        # introspection). This check plus the name allowlist are the only barrier.
        #
        # What makes that acceptable is not this line: it is that the withheld
        # tables and `dirty_flag` are physically ABSENT from the student
        # database, so reading the catalog reveals nothing. See
        # api/tests/test_pg_engine_defenses.py, which proves it against the
        # live database.
        self.schema_name: str = schema_name.lower()
        self.allowed_schemas: frozenset[str] = frozenset({"", self.schema_name})
        self.allowed_catalogs: frozenset[str] = frozenset({"", database_name.lower()})

    def revoke(self, names: set[str]) -> None:
        """Remove relations from the allowlist after startup inspection.

        Used when a view turns out to reference a restricted relation. Revoking
        only ever shrinks the exposed surface.
        """
        for name in names:
            self._tables.pop(name.lower(), None)
        self.allowed_tables = frozenset(self._tables)
        self.leaky_star_tables = frozenset(self.leaky_star_tables & self.allowed_tables)

    # -- lookups ---------------------------------------------------------
    def is_allowed(self, table_name: str) -> bool:
        return table_name.lower() in self.allowed_tables

    def is_physical(self, table_name: str) -> bool:
        return table_name.lower() in self.physical_tables

    def is_restricted_column(self, column_name: str) -> bool:
        return column_name.lower() in self.restricted_column_names

    def resolve_object_alias(self, table_name: str) -> str:
        """Return the owner-canonical object name before authorization."""
        lowered = table_name.lower()
        return self.object_aliases.get(lowered, lowered)

    def get(self, table_name: str) -> TableInfo | None:
        return self._tables.get(table_name.lower())

    def list_tables(self) -> list[TableInfo]:
        return [self._tables[k] for k in sorted(self._tables)]

    def relationships(self) -> list[tuple[str, ForeignKeyInfo]]:
        """Cac canh FK ma phien nay duoc thay, dang (bang nguon, FK).

        Fail-closed o CA HAI dau: mot canh chi ra ngoai khi bang nguon va bang
        dich deu nam trong allowlist, va moi cot o ca hai dau deu nam trong cot
        ma catalog nay phuc vu. Mot canh tro toi bang bi giu lai van noi len
        rang bang do TON TAI - ma `hidden_count` co chu dinh khong bao gio noi.
        `revoke()` thu hep `_tables`, nen ham nay tu dong thu hep theo.
        """
        out: list[tuple[str, ForeignKeyInfo]] = []
        for name in sorted(self._tables):
            info = self._tables[name]
            src_cols = {c.name.lower() for c in info.columns}
            for fk in info.foreign_keys:
                target = self._tables.get(fk.ref_table.lower())
                if target is None:
                    continue
                dst_cols = {c.name.lower() for c in target.columns}
                if not all(c.lower() in src_cols for c in fk.columns):
                    continue
                if not all(c.lower() in dst_cols for c in fk.ref_columns):
                    continue
                out.append((info.name, fk))
        return out

    @property
    def hidden_count(self) -> int:
        """How many physically-present tables are being withheld.

        Deliberately NOT exposed on any HTTP endpoint - internal diagnostics
        and startup logging only.
        """
        return len(self.physical_tables - self.allowed_tables)

    @property
    def hidden_column_count(self) -> int:
        """How many physically-present COLUMNS are being withheld.

        Same rule as `hidden_count`: diagnostics and startup logging only.
        """
        return len(self.withheld_columns_present)
