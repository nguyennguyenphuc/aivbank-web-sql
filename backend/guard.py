"""SQL guard - the primary server-side enforcement layer (defense layer 2).

Design rules, in order of importance:

1. FAIL CLOSED. Anything we cannot fully understand is refused. There is no
   regex blacklist anywhere in the accept path; the only accept path goes
   through a real `sqlglot` parse of the DuckDB dialect.

2. EXECUTE WHAT WE VALIDATED. We never hand the student's raw text to DuckDB.
   After validation we re-render SQL from the validated AST and execute that.
   This kills comment smuggling, trailing junk and any lexer-level divergence
   between sqlglot and DuckDB, because bytes that sqlglot did not turn into an
   approved AST node simply do not survive the round trip.

3. NODE-TYPE ALLOWLIST. Every AST node class must appear in
   ALLOWED_NODES (or be a function that passes the function policy). A new /
   unknown sqlglot node class => refusal, not silent acceptance.

4. NAME ALLOWLIST. Every physical relation referenced must be in
   Catalog.allowed_tables (STUDENT contract names that physically exist), and
   every COLUMN referenced must not be one the contract withholds
   (Catalog.restricted_column_names). Since 2026-08-04 the contract is no
   longer table-uniform: `raw_account_transaction` is MIXED - five STUDENT
   columns plus `dirty_flag`, which the mentor moved to INSTRUCTOR. A
   table-level allowlist alone would either leak that column or delete a whole
   teaching table, so the guard checks both levels.

5. NO EXISTENCE ORACLE. A restricted table and a typo produce the exact same
   error text: "Table 'x' does not exist or is not available." The same holds
   one level down: a withheld COLUMN is refused with the byte-identical
   DuckDB Binder Error text a nonexistent column produces, because on a
   correctly built student.duckdb the column really is absent and that is the
   message the engine really returns. The guard's job here is to make a stale
   or misconfigured deployment behave exactly like a correct one.

CTE handling and why it is safe without full scope analysis
-----------------------------------------------------------
A CTE alias may not collide with ANY table name known to this dataset
(physical tables + every contract name and owner-declared alias). Given that rule, a name that is a
declared CTE alias can never also be a physical table, so the simple check
"table reference is either a declared CTE alias OR an allowlisted table" is
airtight - including the sibling-scope shadowing attack

    SELECT * FROM (WITH cfg_interest_rule AS (SELECT 1) SELECT 1) q,
                  cfg_interest_rule

which is rejected at CTE-declaration time.
"""

from __future__ import annotations

import inspect
import logging
import re
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError

from .catalog import Catalog
from .pg_function_policy import PgFunctionPolicy
from .pg_function_policy import is_denied as is_denied_pg_function

#: Phuong ngu de PHAN TICH va de KET XUAT LAI. Phai khop engine dang phuc vu:
#: guard chay lai truy van tu AST da xac thuc, nen neu phuong ngu lech engine
#: thi thu duoc kiem tra khong con la thu duoc chay.
DIALECT = "postgres"

_HEAD_NAME_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)")


def _build_render_name_map() -> dict[type, frozenset[str]]:
    """Map each sqlglot Func class to the function name(s) it actually EMITS
    in the DuckDB dialect.

    This matters: `exp.CurrentVersion.sql_names()` says "CURRENT_VERSION" but
    the DuckDB generator emits `VERSION()`. Checking only `sql_names()` would
    therefore have let `SELECT version()` through - it did, until this was
    added. We check the emitted name, i.e. exactly what DuckDB will receive.
    """
    mapping: dict[type, frozenset[str]] = {}
    # Rendering arg-less Func instances makes sqlglot log "X is not supported"
    # warnings; they are expected here and must not pollute the server log.
    sqlglot_log = logging.getLogger("sqlglot")
    previous_level = sqlglot_log.level
    sqlglot_log.setLevel(logging.CRITICAL)
    for _, cls in inspect.getmembers(exp, inspect.isclass):
        if not (issubclass(cls, exp.Func) and cls is not exp.Func):
            continue
        names: set[str] = set()
        try:
            names.update(s.lower() for s in cls.sql_names())
        except Exception:
            pass
        try:
            rendered = cls().sql(dialect=DIALECT)
            match = _HEAD_NAME_RE.match(rendered.strip())
            if match:
                names.add(match.group(1).lower())
        except Exception:
            pass
        if names:
            mapping[cls] = frozenset(names)
    sqlglot_log.setLevel(previous_level)
    return mapping


_RENDER_NAMES: dict[type, frozenset[str]] = _build_render_name_map()


class GuardRejection(Exception):
    """Raised when a query must not be executed.

    `message` is student-facing and must never reveal the existence of a table
    the student is not allowed to see. `internal` is for server logs only.
    """

    def __init__(self, code: str, message: str, internal: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.internal = internal or message


# ---------------------------------------------------------------------------
# Node-type allowlist (non-function AST classes usable by a read-only query).
# Anything absent from this set is refused. Deliberately excluded, among
# others: Command, Semicolon, Placeholder, Parameter, Into, Copy, Attach,
# Detach, Pragma, Set, Show, Describe, Summarize, Use, Call, Execute, Export,
# Install, Insert, Update, Delete, Merge, Create, Drop, Alter, Grant, Revoke,
# Transaction, Commit, Rollback, Kill, Cache, Refresh, Analyze, TruncateTable.
# ---------------------------------------------------------------------------
ALLOWED_NODES: frozenset[str] = frozenset(
    {
        # literals / atoms
        "Boolean", "BitString", "ByteString", "HexString", "Literal", "Null",
        "RawString", "UnicodeString", "National", "Star", "Var", "Identifier",
        "DataType", "DataTypeParam", "PseudoType", "Interval", "IntervalSpan",
        "Introducer", "CharacterSet",
        # references
        "Column", "TableColumn", "Table", "TableAlias", "Alias", "Aliases",
        "Dot", "Bracket", "Slice", "Tuple", "Paren",
        # query shape
        "Select", "Subquery", "From", "Join", "Where", "Group", "Having",
        "Order", "Ordered", "Sort", "Limit",
        "LimitOptions", "Offset", "Fetch", "Distinct", "With", "CTE",
        "Union", "Except", "Intersect", "SetOperation", "Qualify",
        "Values", "Lateral", "TableSample",
        "Cube", "Rollup", "GroupingSets", "Window",
        "WindowSpec", "WithinGroup", "Filter", "IgnoreNulls", "RespectNulls",
        "Schema", "Kwarg",
        "OnCondition", "FormatJson", "JSONSchema", "JSONColumnDef",
        # Named function arguments (`name => value`). Safe: the function itself
        # is still policed by the function policy.
        "PropertyEQ", "Pseudocolumn", "WithOperator",
        # json path (json_extract style)
        "JSONPath", "JSONPathRoot", "JSONPathKey", "JSONPathSubscript",
        "JSONPathWildcard", "JSONPathRecursive", "JSONPathSlice",
        "JSONPathSelector", "JSONPathUnion", "JSONPathFilter", "JSONKeyValue",
        # operators
        "Add", "Sub", "Mul", "Div", "IntDiv", "Mod", "Neg", "Unary",
        "BitwiseAnd", "BitwiseOr", "BitwiseXor", "BitwiseNot",
        "BitwiseLeftShift", "BitwiseRightShift", "DPipe",
        "EQ", "NEQ", "GT", "GTE", "LT", "LTE", "NullSafeEQ", "NullSafeNEQ",
        "Is", "In", "Between", "Like", "ILike", "SimilarTo", "Glob",
        "Escape", "Not", "All", "Any", "Overlaps", "AtTimeZone",
    }
)

# ---------------------------------------------------------------------------
# Bon lop node DA BI GO khi chuyen sang phuong ngu postgres. Ghi lai o day vi
# ba trong so do la lo hong THAT tren PostgreSQL, khong phai don dep cho gon,
# va nguoi doc sau nay phai biet de khong them lai.
#
#   ObjectIdentifier  `'meta_dirty_log'::regclass`
#       Da do tren sqlglot 30.15/postgres: cau nay phan giai thanh MOT node
#       ObjectIdentifier va KHONG HE co node exp.Table nao. Nghia la no di qua
#       toan bo phep kiem bang cua `_check_table` ma khong cham vao do, roi khi
#       chay se tra ve OID neu quan he ton tai va nem loi neu khong - dung mot
#       kenh do su ton tai. `::regtype`, `::regproc`, `::regrole`,
#       `tableoid::regclass` deu the.
#
#   Operator          `a OPERATOR(pg_catalog.=) 1`
#       Toan tu cua PostgreSQL phan giai thanh ham. Goi ham qua duong nay khong
#       di qua `_check_function`.
#
#   Pivot/PivotAlias/PivotAny/UnpivotColumns, Comprehension, Lambda,
#   PositionalColumn, WithFill, Final, Cluster, Distribute, Connect, Prior,
#   Adjacent, Distance, JoinHint, Hint, QueryOption, RecursiveWithSearch,
#   Heredoc
#       Cu phap cua phuong ngu khac, khong ton tai trong PostgreSQL. Giu lai
#       chi lam be mat chap nhan rong hon that su ma khong duoc gi.
#
# Ba lop sau DA nam ngoai allowlist tu truoc va van phai o ngoai. Chung khong
# duoc go o day, nhung day la ly do chung quan trong tren PostgreSQL:
#   ColumnDef   `SELECT * FROM dblink('','') AS t(a int)` - danh sach cot cua
#               ham tra ve tap hop. Day la CONG NGU PHAP vao dblink,
#               json_to_recordset, crosstab. Chan ColumnDef la diet ca ho, doc
#               lap voi ten ham.
#   Lock        `SELECT ... FOR UPDATE` - bien truy van chi doc thanh yeu cau
#               khoa dong.
#   Parameter   `SELECT $1`.
# ---------------------------------------------------------------------------

# Lop Func cua sqlglot doc/ghi file hoac xuat du lieu ra ngoai, du sqlglot mo
# hinh hoa chung nhu node hang mot. `ReadCSV`/`ReadParquet` da duoc go: chung la
# cua DuckDB, PostgreSQL khong co.
DENIED_FUNC_CLASSES: frozenset[str] = frozenset(
    {
        "ToFile", "ParseUrl",
        # Ho XML cua PostgreSQL: `query_to_xml` chay MOT TRUY VAN LONG NHAU va
        # tra ve ket qua duoi dang xml - mot duong chay SQL tuy y hoan toan nam
        # ngoai moi phep kiem bang/cot cua guard.
        "XMLElement", "XMLTable", "XMLNamespace", "XMLKeyValueOption",
    }
)

# Ham tra ve TAP HOP duoc phep dung o vi tri FROM: chung sinh dong tu HANG SO,
# khong cham catalog hay he thong tap tin.
#
# `range` DA BI GO: PostgreSQL khong co ham range(), nen no phan giai thanh
# exp.Anonymous, duoc guard cho qua roi moi loi o engine - mot lan chap nhan
# thua khong doi lay gi.
#
# `exploding_generate_series` va `explode` la ten NOI BO cua sqlglot, khong
# phai ten hoc vien go. Da do tren sqlglot 30.15/postgres:
#     SELECT * FROM generate_series(1,5) -> exp.ExplodingGenerateSeries,
#         ten ung vien {'exploding_generate_series', 'generate_series'}
#     SELECT unnest(ARRAY[1])            -> exp.Explode,
#         ten ung vien {'explode', 'unnest'}
# Phep kiem o `_check_function` doi TAT CA ten ung vien phai nam trong tap nay,
# nen thieu hai ten noi bo do se lam `generate_series` va `unnest` - hai ham
# hoan toan binh thuong - bi tu choi.
SAFE_TABLE_FUNCTIONS: frozenset[str] = frozenset(
    {"generate_series", "exploding_generate_series", "unnest", "explode"}
)

ROOT_TYPES = (exp.Select, exp.SetOperation, exp.Subquery)

_UNKNOWN_TABLE_MSG = (
    "Table '{name}' does not exist or is not available in this dataset. "
    "Call GET /schema/tables for the list of tables you can query."
)

# Van ban NGUYEN VAN cua PostgreSQL 18 cho mot cot khong co trong pham vi.
# Tai lap chu khong dien giai lai, co chu dinh: mot cot BI GIAU va mot cot GO
# SAI phai khong the phan biet duoc tu ben ngoai.
#
# Tren goi hoc vien dung chuan, cot bi giau THUC SU khong ton tai, nen day CHINH
# LA thong bao that. Tinh chat nay khong den tu viec ung dung viet lai thong
# bao - no den tu viec cat cot VAT LY. Guard tai lap y nguyen de mot ban trien
# khai cu hay cau hinh sai cung xu su giong het ban dung.
#
# Da do tren PostgreSQL 18.3 (xem api/tests/test_pg_engine_defenses.py):
#     SELECT zzz FROM t      -> 42703  column "zzz" does not exist
#     SELECT t.zzz FROM t t  -> 42703  column t.zzz does not exist
# Luu y khac biet: dang CO BI DANH khong co ngoac kep, dang khong bi danh thi co.
# Sao chep dung nhu vay; "sua cho nhat quan" la tao ra mot khac biet do duoc.
_UNKNOWN_COLUMN_MSG = 'column "{name}" does not exist'
_UNKNOWN_QUALIFIED_COLUMN_MSG = 'column {table}.{name} does not exist'


#: Chinh sach ham. Xem `api/pg_function_policy.py` - chieu suy luan o do bi DAO
#: NGUOC so voi ban DuckDB, va do la thay doi bao mat quan trong nhat cua ca dot
#: chuyen engine.
#:
#: Giu ten `FunctionPolicy` de moi chu ky ham va type hint san co khong phai
#: doi; kieu thuc te la `PgFunctionPolicy`.
FunctionPolicy = PgFunctionPolicy


@dataclass(frozen=True)
class ComplexityLimits:
    """Pre-parse resource limits.

    These are NOT a security control - the allowlist is. They exist because
    `sqlglot.parse` is EXPONENTIAL on a chain of consecutive ON-less JOINs:
    measured on sqlglot 30.14 / DuckDB dialect, cost doubles per extra join
    (n=15 -> 0.13s, n=20 -> 3.9s, n=25 -> 126s) while the resulting AST stays
    tiny. 184 characters of SQL could therefore burn minutes of CPU inside the
    guard, before any DuckDB timeout could apply. The limits below are checked
    on the token stream (linear, ~1us/token) so the pathological input never
    reaches the parser. At the default of 10, worst-case parse is ~4ms.
    """

    max_tokens: int = 4000
    max_joins: int = 32
    max_consecutive_onless_joins: int = 10
    max_paren_depth: int = 64
    max_selects: int = 64


DEFAULT_LIMITS = ComplexityLimits()

_TOO_COMPLEX = (
    "The query is too complex to be analysed safely. "
    "Please simplify it (fewer joins / less nesting) and try again."
)


def _check_complexity(sql: str, limits: ComplexityLimits) -> None:
    from sqlglot.tokens import TokenType

    try:
        tokens = sqlglot.tokenize(sql, dialect=DIALECT)
    except Exception as exc:
        raise GuardRejection(
            "E_PARSE",
            f"Could not read the SQL: {str(exc).splitlines()[0][:200]}",
            internal=f"tokenizer error: {type(exc).__name__}: {exc}",
        ) from exc

    joins = 0
    consecutive = 0
    depth = 0
    max_depth = 0
    selects = 0
    count = 0
    previous: TokenType | None = None
    # JOIN flavours that never take an ON/USING clause, so they do not trigger
    # the parser's backtracking.
    no_on_join = {TokenType.CROSS, TokenType.NATURAL, TokenType.POSITIONAL}

    for token in tokens:
        count += 1
        if count > limits.max_tokens:
            raise GuardRejection(
                "E_TOO_COMPLEX", _TOO_COMPLEX,
                internal=f"token count exceeded {limits.max_tokens}",
            )
        ttype = token.token_type
        if ttype == TokenType.L_PAREN:
            depth += 1
            max_depth = max(max_depth, depth)
            if max_depth > limits.max_paren_depth:
                raise GuardRejection(
                    "E_TOO_COMPLEX", _TOO_COMPLEX,
                    internal=f"paren depth exceeded {limits.max_paren_depth}",
                )
        elif ttype == TokenType.R_PAREN:
            depth = max(0, depth - 1)
        elif ttype == TokenType.SELECT:
            selects += 1
            if selects > limits.max_selects:
                raise GuardRejection(
                    "E_TOO_COMPLEX", _TOO_COMPLEX,
                    internal=f"SELECT count exceeded {limits.max_selects}",
                )
        elif ttype == TokenType.JOIN:
            joins += 1
            if joins > limits.max_joins:
                raise GuardRejection(
                    "E_TOO_COMPLEX", _TOO_COMPLEX,
                    internal=f"JOIN count exceeded {limits.max_joins}",
                )
            if previous not in no_on_join:
                consecutive += 1
                if consecutive > limits.max_consecutive_onless_joins:
                    raise GuardRejection(
                        "E_TOO_COMPLEX", _TOO_COMPLEX,
                        internal=(
                            "consecutive ON-less JOINs exceeded "
                            f"{limits.max_consecutive_onless_joins} "
                            "(exponential-parse guard)"
                        ),
                    )
        elif ttype in (TokenType.ON, TokenType.USING):
            consecutive = 0
        previous = ttype


@dataclass(frozen=True)
class ValidatedQuery:
    sql: str                     # re-rendered, validated, LIMIT-wrapped SQL
    inner_sql: str               # re-rendered query without the LIMIT wrapper
    tables: tuple[str, ...]      # physical tables referenced (lower-case)
    row_limit: int
    # Every column name the query mentions, lower-cased. Used ONLY for the
    # optional audit-column watch list (see api/main.py and
    # config.audit_columns) and never to accept or reject a query - enforcement
    # of column visibility happens earlier, in _check_column/_check_stars, and a
    # query that reaches this point has already passed it.
    columns: tuple[str, ...] = ()


def _func_name(node: exp.Expression) -> str:
    """Best single label for error messages."""
    if isinstance(node, exp.Anonymous):
        return (node.name or "").lower()
    names = _RENDER_NAMES.get(type(node))
    if names:
        return sorted(names)[0]
    try:
        return node.sql_name().lower()
    except Exception:  # pragma: no cover - sqlglot internal
        return type(node).__name__.lower()


def _func_name_candidates(node: exp.Expression) -> frozenset[str]:
    """Every name this node could turn into when handed to DuckDB.

    Checking the whole candidate set (declared names AND the name the DuckDB
    generator actually emits) is what makes the function policy fail closed.
    """
    if isinstance(node, exp.Anonymous):
        return frozenset({(node.name or "").lower()})
    names = set(_RENDER_NAMES.get(type(node), frozenset()))
    try:
        names.add(node.sql_name().lower())
    except Exception:  # pragma: no cover
        pass
    return frozenset(n for n in names if n)


def _collect_cte_aliases(tree: exp.Expression) -> set[str]:
    aliases: set[str] = set()
    for cte in tree.find_all(exp.CTE):
        alias = cte.alias_or_name
        if not alias:
            raise GuardRejection(
                "E_UNSUPPORTED_SYNTAX", "Every CTE must have a name."
            )
        aliases.add(alias.lower())
    return aliases


def _check_table(node: exp.Table, catalog: Catalog, cte_aliases: set[str]) -> str | None:
    """Validate one FROM/JOIN entry. Returns the physical table name if any."""
    inner = node.this

    # Table-valued function in table position, e.g. range(3) / read_parquet(...)
    if not isinstance(inner, exp.Identifier):
        if isinstance(inner, exp.Expression):
            fname = _func_name(inner)
            candidates = _func_name_candidates(inner)
            if candidates and candidates <= SAFE_TABLE_FUNCTIONS:
                return None
            raise GuardRejection(
                "E_UNSUPPORTED_FUNCTION",
                f"Table function '{fname or 'unknown'}' is not available. "
                "Only tables from this dataset can be queried.",
                internal=f"table-position function rejected: {fname!r} ({type(inner).__name__})",
            )
        raise GuardRejection(
            "E_UNSUPPORTED_SYNTAX",
            "Unsupported table expression in FROM clause.",
            internal=f"Table.this = {type(inner).__name__}",
        )

    name = (node.name or "").lower()
    db = (node.db or "").lower()
    catalog_part = (node.catalog or "").lower()
    qualified = ".".join(p for p in (catalog_part, db, name) if p)

    # DEC-07: legacy/object aliases are resolved before the denylist.  We keep
    # the student's spelling in the generic error envelope, so this creates no
    # oracle about the canonical instructor object.
    canonical_name = catalog.resolve_object_alias(name)

    # A CTE alias can never collide with a real table (enforced separately),
    # so resolving to a CTE here is unambiguous and safe.
    if not db and not catalog_part and name in cte_aliases:
        return None

    if db not in catalog.allowed_schemas or catalog_part not in catalog.allowed_catalogs:
        # information_schema.*, pg_catalog.*, an attached catalog, temp.* ...
        # Same generic message as a typo: no oracle.
        raise GuardRejection(
            "E_UNKNOWN_TABLE",
            _UNKNOWN_TABLE_MSG.format(name=qualified),
            internal=f"qualified reference refused: {qualified!r}",
        )

    if not catalog.is_allowed(canonical_name):
        raise GuardRejection(
            "E_UNKNOWN_TABLE",
            _UNKNOWN_TABLE_MSG.format(name=qualified or name),
            internal=(
                f"table refused: {qualified!r} "
                f"(canonical={canonical_name!r}, physical={catalog.is_physical(canonical_name)})"
            ),
        )

    # Canonicalise the reference. We do not send the student's spelling to the
    # engine, we send the exact allowlisted identifier, fully qualified and
    # quoted. This removes any chance that Python's str.lower() and the engine's
    # identifier folding disagree about which relation a spelling resolves to.
    #
    # On PostgreSQL the qualification matters more than it did on DuckDB: it
    # pins every relation to the `aivb` schema, so an unqualified name can never
    # be resolved out of `pg_catalog`, which is always implicitly first in
    # search_path and cannot be removed from it.
    node.set("this", exp.to_identifier(canonical_name, quoted=True))
    node.set("db", exp.to_identifier(catalog.schema_name, quoted=True))
    node.set("catalog", None)
    return canonical_name


#: Cot HE THONG an cua PostgreSQL. Chung khong nam trong column contract nen
#: `is_restricted_column` khong biet den, nhung chung TON TAI tren moi bang va
#: tra ve du lieu that. DuckDB khong he co khai niem nay, nen day la mot lop be
#: mat hoan toan moi do doi engine mang lai.
#:
#: Vi sao chan chu khong mac ke:
#:   ctid            vi tri VAT LY cua dong trong tep du lieu. Lo bo cuc luu tru,
#:                   va cho phep suy ra thu tu ghi.
#:   xmin, xmax      ma giao dich da ghi/xoa dong. Bo du lieu nay CO CHU DINH
#:                   cay loi vao du lieu va gan nhan kich ban; neu nhung dong do
#:                   duoc ghi o mot lan chay khac thi xmin la mot tin hieu suy ra
#:                   dau la dong "ban" - dung thu ma hoc vien phai tu tim.
#:   cmin, cmax      thu tu lenh trong giao dich.
#:   tableoid        dinh danh bang; ep sang regclass la mot kenh do ten bang.
#:
#: Khong co gia tri day hoc nao bu lai.
PG_SYSTEM_COLUMNS: frozenset[str] = frozenset(
    {"ctid", "xmin", "xmax", "cmin", "cmax", "tableoid"}
)


def _check_column(node: exp.Column, catalog: Catalog) -> None:
    """Refuse a reference to a column the contract withholds.

    Matching is by bare name (see Catalog.restricted_column_names for why), and
    the refusal reproduces PostgreSQL's own "column ... does not exist" so that
    a withheld column and a typo are indistinguishable. On the shipped student
    database the column is not there at all and PostgreSQL would say exactly
    this; the guard exists so a stale or misconfigured deployment cannot behave
    any differently.
    """
    if isinstance(node.this, exp.Star):
        return  # `t.*` - handled by _check_stars, which knows the scope
    name = (node.name or "").lower()
    if name in PG_SYSTEM_COLUMNS:
        # Khong dung thong bao "does not exist" o day: cot nay THUC SU ton tai,
        # va noi nguoc lai la mot loi noi doi ma hoc vien kiem chung duoc trong
        # ba giay bang tai lieu PostgreSQL. Noi that va noi ro.
        raise GuardRejection(
            "E_UNSUPPORTED_COLUMN",
            f"'{node.name}' is a PostgreSQL system column and is not available "
            "here. Query the columns listed by GET /schema/tables.",
            internal=f"pg system column refused: {name!r}",
        )
    if not name or not catalog.is_restricted_column(name):
        return
    qualifier = (node.table or "").strip()
    if qualifier:
        message = _UNKNOWN_QUALIFIED_COLUMN_MSG.format(table=qualifier, name=node.name)
    else:
        message = _UNKNOWN_COLUMN_MSG.format(name=node.name)
    raise GuardRejection(
        # Same code DuckDB's own Binder Error would surface through api/db.py.
        "E_QUERY_FAILED",
        message,
        internal=(
            f"RESTRICTED COLUMN probe refused: {name!r} is INSTRUCTOR-only in the "
            "column contract"
        ),
    )


def _select_sources(select: exp.Select) -> dict[str, str]:
    """alias (or name) -> physical table name for this SELECT's direct sources.

    Only FROM/JOIN entries that are real tables are collected. Subqueries, CTE
    references and table functions are deliberately absent: a star over one of
    those can only project what the inner query already projected, and the inner
    query was validated on its own.
    """
    entries: list[exp.Expression] = []
    # sqlglot renamed this arg to `from_` (it is `from` in older releases and
    # `from_` in 30.x). Read both, and never assume one of them exists: a silent
    # None here would turn the whole star check into a no-op.
    from_clause = select.args.get("from_", select.args.get("from"))
    if isinstance(from_clause, exp.From):
        entries.append(from_clause.this)
    for join in select.args.get("joins") or []:
        entries.append(join.this)

    sources: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, exp.Table) or not isinstance(entry.this, exp.Identifier):
            continue
        physical = (entry.name or "").lower()
        if not physical:
            continue
        sources[(entry.alias or "").lower() or physical] = physical
    return sources


def _assert_star_scope_resolution_works() -> None:
    """Refuse to load if `_select_sources` has been silently broken.

    It reads a sqlglot arg key that HAS already been renamed once ("from" ->
    "from_"). A rename returns None, `_select_sources` returns {}, and
    `_check_stars` becomes a no-op that still passes every negative test - the
    worst possible failure mode for a security control. This probe turns that
    into an import-time crash.
    """
    probe = sqlglot.parse_one(
        "SELECT * FROM probe_tbl JOIN other_tbl AS o ON true", dialect=DIALECT
    )
    resolved = _select_sources(probe)
    expected = {"probe_tbl": "probe_tbl", "o": "other_tbl"}
    if resolved != expected:
        raise RuntimeError(
            "api.guard: FROM/JOIN scope resolution is broken against this "
            f"sqlglot build (got {resolved!r}, expected {expected!r}). The "
            "SELECT * column guard would silently pass everything. Refusing to "
            "load - fix _select_sources for the installed sqlglot version."
        )


_assert_star_scope_resolution_works()


def _check_stars(tree: exp.Expression, catalog: Catalog) -> None:
    """Refuse `SELECT *` when it would expand over a withheld column.

    This only ever fires when the connected file STILL CONTAINS a column the
    contract withholds (`Catalog.leaky_star_tables`), i.e. on a stale build or a
    misconfigured deployment. On the correctly built student.duckdb the column
    is physically gone, the set is empty, and `SELECT * FROM
    raw_account_transaction` keeps working exactly as students expect.

    Stars that do not project columns - `count(*)`, any star nested inside a
    function - are untouched.
    """
    if not catalog.leaky_star_tables:
        return
    for star in tree.find_all(exp.Star):
        owner = star.parent
        qualifier = ""
        if isinstance(owner, exp.Column) and isinstance(owner.this, exp.Star):
            qualifier = (owner.table or "").lower()
            owner = owner.parent
        if not isinstance(owner, exp.Select):
            continue
        sources = _select_sources(owner)
        if qualifier:
            candidates = [sources[qualifier]] if qualifier in sources else []
        else:
            candidates = list(sources.values())
        for table in candidates:
            if table in catalog.leaky_star_tables:
                raise GuardRejection(
                    "E_UNSUPPORTED_SYNTAX",
                    f"'SELECT *' is not available for table '{table}' here. "
                    f"List the columns you need explicitly - "
                    f"GET /schema/tables/{table} shows them.",
                    internal=(
                        f"star refused over {table!r}: the connected file still "
                        "physically carries a column the contract withholds "
                        f"({sorted(catalog.restricted_columns.get(table, ()))}). "
                        "Rebuild the student export."
                    ),
                )


def _walk(tree: exp.Expression, catalog: Catalog, policy: FunctionPolicy) -> list[str]:
    cte_aliases = _collect_cte_aliases(tree)

    # A CTE may not shadow any known table name. See module docstring.
    known = (
        catalog.physical_tables
        | catalog.contract_student
        | catalog.contract_restricted
        | catalog.owner_declared_restricted
        | frozenset(catalog.object_aliases)
    )
    for alias in sorted(cte_aliases & known):
        raise GuardRejection(
            "E_RESERVED_CTE_NAME",
            f"'{alias}' cannot be used as a CTE name because it collides with a "
            "table name in this dataset. Please rename the CTE.",
        )

    tables: list[str] = []
    for node in tree.walk():
        if not isinstance(node, exp.Expression):
            raise GuardRejection(
                "E_UNSUPPORTED_SYNTAX",
                "This query uses syntax that is not supported here.",
                internal=f"non-Expression node: {type(node).__name__}",
            )

        cls_name = type(node).__name__

        if isinstance(node, exp.Table):
            found = _check_table(node, catalog, cte_aliases)
            if found:
                tables.append(found)
            continue

        if isinstance(node, exp.Func):
            _check_function(node, policy)
            continue

        if isinstance(node, exp.Column):
            _check_column(node, catalog)
            # Falls through to the node-class allowlist below on purpose:
            # "Column" is an allowlisted class and the check above is additive.

        if cls_name not in ALLOWED_NODES:
            raise GuardRejection(
                "E_UNSUPPORTED_SYNTAX",
                "This query uses syntax that is not supported here. "
                "Only read-only SELECT queries are allowed.",
                internal=f"node class not allowlisted: {cls_name}",
            )

    return tables


def _check_function(node: exp.Func, policy: FunctionPolicy) -> None:
    cls_name = type(node).__name__
    label = _func_name(node)
    if cls_name in DENIED_FUNC_CLASSES:
        raise GuardRejection(
            "E_UNSUPPORTED_FUNCTION",
            f"Function '{label}' is not available here.",
            internal=f"denied func class: {cls_name}",
        )

    candidates = _func_name_candidates(node)

    # Ho ham nguy hiem cua PostgreSQL, nhan dien theo TEN va theo TIEN TO. Tien
    # to quan trong hon: rieng `pg_stat_get_*` da khoang 200 ham, va moi ban
    # PostgreSQL lai them vai cai - mot danh sach ten khong bao gio duoi kip.
    denied = {n for n in candidates if is_denied_pg_function(n)}
    if denied:
        raise GuardRejection(
            "E_UNSUPPORTED_FUNCTION",
            f"Function '{label}' is not available here.",
            internal=f"denied pg func: {sorted(denied)}",
        )

    # Ham tra ve TAP HOP chi duoc dung qua danh sach an toan.
    set_returning = (candidates & policy.set_returning) - SAFE_TABLE_FUNCTIONS
    if set_returning:
        raise GuardRejection(
            "E_UNSUPPORTED_FUNCTION",
            f"Function '{label}' is not available here.",
            internal=f"set-returning func outside allowlist: {sorted(set_returning)}",
        )

    if isinstance(node, exp.Anonymous):
        # sqlglot khong nhan ra ten nay, nen no phai nam trong danh sach CHO
        # PHEP do nguoi soan; neu khong thi tu choi (fail closed).
        #
        # DAY LA DONG QUAN TRONG NHAT CUA CA FILE tren PostgreSQL. Ban DuckDB
        # doi chieu voi `policy.scalar_like` - tap suy ra TU ENGINE. Port
        # nguyen xi (doi `duckdb_functions()` thanh `pg_proc`) se lam tap doi
        # chieu nhay tu ~1.200 ten gan nhu vo hai cua DuckDB len 2.787 ten cua
        # PostgreSQL, trong do co pg_read_file, pg_ls_dir, to_regclass,
        # pg_get_viewdef, has_table_privilege va vai tram ham khac. Nhanh
        # fail-closed nay khi do AM THAM tro thanh fail-open.
        #
        # `policy.allowed` doc tu api/pg_functions_allowed.txt: 159 ten, 5,7%
        # cua engine. Xem header file do va api/pg_function_policy.py.
        if not (candidates & (policy.allowed | SAFE_TABLE_FUNCTIONS)):
            raise GuardRejection(
                "E_UNSUPPORTED_FUNCTION",
                f"Function '{label}' is not available here.",
                internal=f"unknown anonymous func: {label}",
            )


def validate(
    sql: str,
    catalog: Catalog,
    policy: FunctionPolicy,
    *,
    max_sql_chars: int,
    row_limit: int,
    limits: ComplexityLimits = DEFAULT_LIMITS,
) -> ValidatedQuery:
    """Validate a student query and return the exact SQL to execute."""
    if sql is None or not sql.strip():
        raise GuardRejection("E_EMPTY_SQL", "The query is empty.")

    if len(sql) > max_sql_chars:
        raise GuardRejection(
            "E_SQL_TOO_LONG",
            f"The query is too long (max {max_sql_chars} characters).",
        )

    if "\x00" in sql:
        raise GuardRejection("E_INVALID_INPUT", "The query contains invalid characters.")

    # Cheap linear pre-check: keeps pathological input away from the parser.
    _check_complexity(sql, limits)

    try:
        statements = sqlglot.parse(sql, dialect=DIALECT, error_level=sqlglot.ErrorLevel.RAISE)
    except (ParseError, TokenError) as exc:
        raise GuardRejection(
            "E_PARSE",
            f"Could not parse the SQL: {str(exc).splitlines()[0][:300]}",
            internal=f"parse error: {exc}",
        ) from exc
    except Exception as exc:  # fail closed on anything unexpected
        raise GuardRejection(
            "E_PARSE",
            "Could not parse the SQL.",
            internal=f"unexpected parser failure: {type(exc).__name__}: {exc}",
        ) from exc

    real = [s for s in statements if s is not None and not isinstance(s, exp.Semicolon)]
    if len(real) == 0:
        raise GuardRejection("E_EMPTY_SQL", "The query is empty.")
    if len(real) > 1:
        raise GuardRejection(
            "E_MULTI_STATEMENT",
            "Only one statement per request is allowed.",
            internal=f"{len(real)} statements: {[type(s).__name__ for s in real]}",
        )

    tree = real[0]
    if not isinstance(tree, ROOT_TYPES):
        raise GuardRejection(
            "E_NOT_SELECT",
            "Only SELECT queries (optionally with a WITH clause) are allowed. "
            "Statements that modify data or schema are not permitted.",
            internal=f"root node: {type(tree).__name__}",
        )

    tables = _walk(tree, catalog, policy)
    # After _walk, every table reference has been canonicalised to its
    # lower-case allowlisted name, so scope resolution below is exact.
    _check_stars(tree, catalog)

    # Strip every comment before regeneration. sqlglot does escape "*/" inside
    # a comment body, but relying on that would make student-controlled text
    # part of the SQL we execute. After this, the executed statement contains
    # nothing but nodes we validated.
    for node in tree.walk():
        if isinstance(node, exp.Expression) and node.comments:
            node.comments = None

    try:
        inner_sql = tree.sql(dialect=DIALECT)
    except Exception as exc:  # pragma: no cover - defensive
        raise GuardRejection(
            "E_UNSUPPORTED_SYNTAX",
            "This query uses syntax that is not supported here.",
            internal=f"regeneration failed: {type(exc).__name__}: {exc}",
        ) from exc

    if not inner_sql.strip():
        raise GuardRejection(
            "E_UNSUPPORTED_SYNTAX",
            "This query uses syntax that is not supported here.",
            internal="regenerated SQL was empty",
        )

    # Hard row cap. Fetch one extra row so we can report truncation honestly.
    wrapped = (
        f"SELECT * FROM (\n{inner_sql}\n) AS _aivb_student_query LIMIT {int(row_limit) + 1}"
    )

    columns = {
        node.name.lower()
        for node in tree.find_all(exp.Column)
        if isinstance(node, exp.Column) and node.name
    }

    return ValidatedQuery(
        sql=wrapped,
        inner_sql=inner_sql,
        tables=tuple(sorted(set(tables))),
        row_limit=int(row_limit),
        columns=tuple(sorted(columns)),
    )
