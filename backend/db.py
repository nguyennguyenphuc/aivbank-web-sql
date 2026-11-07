"""Tang truy cap PostgreSQL cho giao dien SQL hoc vien.

Doi chieu voi ban DuckDB (`api/db.py`)
--------------------------------------
- MOT pool ket noi cho moi vai tro, thay cho mot ket noi read-only duy nhat.
  Vai tro STUDENT va INSTRUCTOR dung HAI BO THONG TIN DANG NHAP khac nhau tro
  toi HAI DATABASE VAT LY khac nhau. Duoi DuckDB, viec tach goi phu thuoc vao
  `db_for_role()` tra ve doi tuong nao; mot loi dinh tuyen la giao nham ca file
  dap an. O day, loi dinh tuyen chi lam hoc vien cam mot bo thong tin dang nhap
  KHONG MO NOI ket noi toi aivb_instructor - quyen CONNECT khong duoc cap.

- Timeout do MAY CHU cat (`statement_timeout`) thay vi
  `threading.Timer` + `cursor.interrupt()`. Manh hon han: backend tu cat du
  luong Python co bi treo hay bi deschedule. Van giu mot watchdog phia client
  goi `cancel_safe()` lam luoi thu hai, vi statement_timeout khong phu duoc
  truong hop phien ket ket o mot khoa hay nghen o tang socket.

- `_sanitize_engine_error` duoc VIET LAI chu khong port. Ly do o docstring cua
  chinh no; tom tat: `str(exception)` cua psycopg co kem `LINE 1:` in nguyen cau
  SQL da boc, va truong HINT cua PostgreSQL goi y TEN COT THAT tu catalog
  ("Perhaps you meant to reference the column ..."). DuckDB khong co truong do.

- `slot()` GIU NGUYEN. Pool gioi han so KET NOI, con `slot()` gioi han khoi
  luong CPU ke ca phan PHAN TICH CU PHAP cua guard - phan do chay TRUOC khi
  muon ket noi nen pool khong the phu.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

from . import pgtypes
from .catalog import Catalog, ColumnInfo, ForeignKeyInfo, TableInfo
from .config import Settings
from .pg_function_policy import PgFunctionPolicy

log = logging.getLogger("aivb.db")


class QueryTimeout(Exception):
    pass


class ServiceBusy(Exception):
    pass


class QueryFailed(Exception):
    """PostgreSQL tu choi truy van da qua guard."""

    def __init__(self, message: str, internal: str) -> None:
        super().__init__(message)
        self.message = message
        self.internal = internal


class SessionSettingError(RuntimeError):
    """Tham so phien khong dung nhu khai bao - KHONG phuc vu."""


@dataclass
class QueryResult:
    columns: list[str]
    column_types: list[str]
    rows: list[list]
    row_count: int
    truncated: bool
    elapsed_ms: float


class Database:
    def __init__(
        self,
        settings: Settings,
        expose_restricted: bool = False,
        role: str = "STUDENT",
        dataset: str | None = None,
    ) -> None:
        """Mot ket noi toi MOT (bo du lieu, vai tro).

        `dataset` bo trong = bo du lieu mac dinh, tuc la hanh vi truoc khi truc
        nay ton tai. Moi thu rieng cua bo du lieu - database, user, schema,
        hop dong cot - deu doc tu DatasetSpec chu khong tu cac truong phang
        cua Settings, de hai bo du lieu khong the dinh vao nhau.
        """
        self.settings = settings
        self.role = role
        self.expose_restricted = expose_restricted
        spec = settings.dataset(dataset)
        self.dataset = spec.name
        self.spec = spec
        self.schema = spec.schema

        self._session_settings = settings.pg_session_settings(schema=spec.schema)
        self._required_settings = settings.pg_required_settings()

        pool_max = settings.pg_pool_max or max(1, settings.max_concurrent_queries)
        self._pool = ConnectionPool(
            conninfo=settings.pg_conninfo(role, spec.name),
            min_size=max(1, settings.pg_pool_min),
            max_size=max(1, pool_max),
            # `slot()` da lam toan bo viec xep hang. Neu den day con phai cho lau
            # thi khong phai nghen ma la ket noi hong.
            timeout=5.0,
            max_lifetime=1800.0,
            max_idle=300.0,
            configure=self._configure,
            kwargs={"autocommit": True},
            open=False,
            name=f"{spec.name}-{role.lower()}",
        )
        self._pool.open(wait=True, timeout=30.0)

        self._slots = threading.Semaphore(max(1, settings.max_concurrent_queries))
        self._queued = 0
        self._queue_lock = threading.Lock()

        with self._pool.connection() as con:
            self.database_name = con.execute("SELECT current_database()").fetchone()[0]
            self.function_policy = PgFunctionPolicy.from_connection(con)
            physical = self._introspect(con)

        self.catalog = Catalog(
            contract_path=spec.contract_path,
            physical_tables=physical,
            database_name=self.database_name,
            expose_restricted=expose_restricted,
            owner_config_path=spec.owner_config_path,
            schema_name=self.schema,
        )
        if not expose_restricted:
            self._drop_leaky_views()

        log.info(
            "connected role=%s db=%s schema=%s physical_tables=%d exposed=%d "
            "withheld_tables=%d withheld_columns=%d allowed_functions=%d/%d",
            self.role, self.database_name, self.schema,
            len(self.catalog.physical_tables), len(self.catalog.allowed_tables),
            self.catalog.hidden_count, self.catalog.hidden_column_count,
            len(self.function_policy.allowed),
            len(self.function_policy.engine_universe),
        )
        if self.catalog.withheld_columns_present:
            log.error(
                "SECURITY: %s still physically contains contract-withheld "
                "column(s) %s. They are hidden from the catalog and refused by "
                "the guard, but the student database should not contain them at "
                "all - reload it with generator/load_postgres.py.",
                self.database_name,
                sorted(self.catalog.withheld_columns_present),
            )

    # -- ket noi ----------------------------------------------------------
    def _configure(self, con: psycopg.Connection) -> None:
        """Ap tham so phien, roi DOC LAI de xac nhan.

        Doc lai khong phai thua. Tham so con duoc dat o cap vai tro va cap
        database tren may chu, va ca hai deu co the troi. Neu gia tri thuc te
        khong khop khai bao thi ket noi bi tu choi ngay - de mot ket noi
        `search_path` sai vao pool la de guard kiem tra mot the gioi khac voi
        the gioi ma truy van chay trong do.
        """
        # `SET` khong nhan tham so; `set_config()` thi co. Dung set_config de
        # khong bao gio phai noi chuoi vao SQL.
        for name, value in self._session_settings.items():
            con.execute("SELECT set_config(%s, %s, false)", (name, value))

        # Tham so hang SUSET: API khong dat duoc, va do la dieu TOT - nghia la
        # mot phien khong the tu noi long. Chi kiem chung.
        for name, expected in self._required_settings.items():
            actual = con.execute("SELECT current_setting(%s)", (name,)).fetchone()[0]
            if actual != expected:
                raise SessionSettingError(
                    f"{name} = {actual!r} nhung phai la {expected!r}. "
                    "Chay lai deploy/postgres/03_schema_grants.sql. "
                    "Voi lc_messages: tang guard tai lap NGUYEN VAN thong bao loi "
                    "cua PostgreSQL de mot cot bi giau khong phan biet duoc voi "
                    "mot cot go sai; doi ngon ngu la pha tinh chat do."
                )

        for name in ("search_path", "default_transaction_read_only"):
            actual = con.execute("SELECT current_setting(%s)", (name,)).fetchone()[0]
            expected = self._session_settings[name]
            if actual.replace('"', "") != expected:
                raise SessionSettingError(
                    f"{name} = {actual!r} nhung phai la {expected!r}."
                )

    # -- noi soi (chi phia may chu, khong bao gio do SQL hoc vien dieu khien) --
    def _introspect(self, con: psycopg.Connection) -> dict[str, TableInfo]:
        rows = con.execute(
            """
            SELECT lower(c.table_name), c.column_name, c.data_type,
                   c.is_nullable, c.ordinal_position,
                   c.numeric_precision, c.numeric_scale
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = %s
              AND t.table_type IN ('BASE TABLE', 'VIEW', 'LOCAL TEMPORARY')
            ORDER BY 1, c.ordinal_position
            """,
            (self.schema,),
        ).fetchall()

        pk_rows = con.execute(
            """
            SELECT lower(c.relname), a.attname
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
            WHERE i.indisprimary AND c.relnamespace = %s::regnamespace
            """,
            (self.schema,),
        ).fetchall()
        pks: dict[str, set[str]] = {}
        for tname, col in pk_rows:
            pks.setdefault(tname, set()).add(col)

        fks = fetch_foreign_keys(con, self.schema)

        grouped: dict[str, list[ColumnInfo]] = {}
        for tname, col, dtype, nullable, _pos, precision, scale in rows:
            grouped.setdefault(tname, []).append(
                ColumnInfo(
                    name=col,
                    # Ten kieu di ra tan trinh duyet. Doi sang phong cach DuckDB
                    # de `web/format.js` nhan ra cot so va de hoc vien doc thay
                    # dung ten kieu nhu trong tai lieu. Xem api/pgtypes.py.
                    duckdb_type=_pg_display_type(dtype, precision, scale),
                    nullable=(str(nullable).upper() == "YES"),
                    is_primary_key=col in pks.get(tname, set()),
                )
            )
        return {
            name: TableInfo(
                name=name, columns=tuple(cols), foreign_keys=fks.get(name, ())
            )
            for name, cols in grouped.items()
        }

    def table_row_count(self, table: str) -> int | None:
        """So dong cua mot bang DA nam trong allowlist."""
        if not self.catalog.is_allowed(table):
            return None
        with self._pool.connection() as con:
            # An toan: `table` da duoc doi chieu voi mot allowlist dinh danh co dinh.
            return con.execute(
                f'SELECT count(*) FROM "{self.schema}"."{table}"'
            ).fetchone()[0]

    # -- thuc thi ---------------------------------------------------------
    @contextmanager
    def slot(self):
        """Gioi han so yeu cau dang lam viec CPU cung luc.

        Phu ca phan XAC THUC SQL: phan tich cu phap cung la viec CPU, va no chay
        TRUOC khi muon ket noi - nen pool khong the thay the phan nay.

        Yeu cau khong con cho trong thi CHO mot chut thay vi bi tu choi ngay.
        Khac biet do quan trong trong lop hoc: do tren ban 9,1GB, muoi hoc vien
        bam Run cung luc tao ra sau loi 503 du truy van chi mat 60ms, chi vi bon
        cho tam thoi ban.
        """
        busy = ServiceBusy(
            "The query service is busy. Please try again in a few seconds."
        )
        with self._queue_lock:
            if self._queued >= max(0, self.settings.max_queued_queries):
                raise busy
            self._queued += 1
        try:
            acquired = self._slots.acquire(
                timeout=max(0.0, self.settings.admission_wait_s)
            )
        finally:
            with self._queue_lock:
                self._queued -= 1
        if not acquired:
            raise busy
        try:
            yield
        finally:
            self._slots.release()

    def execute(self, sql: str, timeout_s: float, row_limit: int) -> QueryResult:
        started = time.perf_counter()
        with self._pool.connection() as con:
            # Luoi thu hai: statement_timeout la may chu cat, nhung no khong phu
            # duoc phien ket o mot khoa hay nghen o tang socket.
            watchdog = threading.Timer(timeout_s + 2.0, _safe_cancel, args=(con,))
            watchdog.daemon = True
            try:
                watchdog.start()
                with con.cursor() as cur:
                    cur.execute(
                        "SELECT set_config('statement_timeout', %s, true)",
                        (f"{int(timeout_s * 1000)}ms",),
                    )
                    cur.execute(sql)
                    if cur.description is None:
                        raise QueryFailed(
                            "The query did not return a result set.",
                            internal="no description",
                        )
                    pgtypes.assert_no_forbidden_types(cur.description)
                    columns = [d.name for d in cur.description]
                    types = pgtypes.types_from_description(cur.description)
                    fetched = cur.fetchmany(row_limit + 1)
            except psycopg.errors.QueryCanceled as exc:
                raise QueryTimeout(
                    f"The query took longer than {timeout_s:g}s and was cancelled. "
                    "Try adding a WHERE filter or a LIMIT."
                ) from exc
            except psycopg.Error as exc:
                raise QueryFailed(
                    _sanitize_engine_error(exc, self._hidden_names()),
                    internal=f"{type(exc).__name__}[{exc.sqlstate}]",
                ) from exc
            except ValueError as exc:  # kieu bi cam tu pgtypes
                raise QueryFailed(
                    "The query produced a column type this service cannot return.",
                    internal=str(exc),
                ) from exc
            finally:
                watchdog.cancel()

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        truncated = len(fetched) > row_limit
        rows = fetched[:row_limit]
        return QueryResult(
            columns=columns,
            column_types=types,
            rows=[list(r) for r in rows],
            row_count=len(rows),
            truncated=truncated,
            elapsed_ms=round(elapsed_ms, 2),
        )

    def _drop_leaky_views(self) -> None:
        """Mot VIEW duoc phep van co the SELECT tu bang bi giau ben duoi.

        Ban DuckDB do bang regex tren van ban SQL cua view. O PostgreSQL do
        duoc CHINH XAC qua do thi phu thuoc (`pg_depend`), nen khong bo sot
        truong hop ten bi dat trong ngoac kep, co bi danh, hay co schema.

        Tren goi hoc vien dung chuan, truy van nay phai tra ve rong: goi khong
        co view nao.
        """
        try:
            with self._pool.connection() as con:
                rows = con.execute(
                    """
                    SELECT DISTINCT lower(v.relname), lower(t.relname)
                    FROM pg_rewrite r
                    JOIN pg_class  v ON v.oid = r.ev_class
                    JOIN pg_depend d ON d.objid = r.oid
                                    AND d.classid = 'pg_rewrite'::regclass
                    JOIN pg_class  t ON t.oid = d.refobjid
                                    AND t.relkind IN ('r','p','v','m','f')
                    WHERE v.relnamespace = %s::regnamespace
                      AND v.relkind IN ('v','m')
                      AND t.oid <> v.oid
                    """,
                    (self.schema,),
                ).fetchall()
        except psycopg.Error as exc:  # pragma: no cover
            log.warning("could not inspect views: %s", exc)
            return

        restricted = self.catalog.contract_restricted | (
            self.catalog.physical_tables - self.catalog.allowed_tables
        )
        leaky = set()
        for view_name, referenced in rows:
            if view_name not in self.catalog.allowed_tables:
                continue
            if referenced in restricted:
                leaky.add(view_name)
                log.error(
                    "SECURITY: view %r references restricted relation %r - "
                    "removing it from the student allowlist",
                    view_name, referenced,
                )
        if leaky:
            self.catalog.revoke(leaky)

    def _hidden_names(self) -> frozenset[str]:
        """Ten khong bao gio duoc xuat hien trong thong bao gui hoc vien."""
        if self.expose_restricted:
            return frozenset()
        return frozenset(
            (self.catalog.physical_tables - self.catalog.allowed_tables)
            | self.catalog.contract_restricted
            | self.catalog.restricted_column_names
            # Ten database kia va cac vai tro cua no: thong bao loi ket noi cua
            # PostgreSQL co the mang chung theo.
            | {"aivb_instructor", "aivb_reader_instructor",
               "aivb_api_instructor", "aivb_bi_instructor"}
        )

    def ping(self, timeout_s: float = 0.5) -> bool:
        """Database con song khong - tra loi NHANH ke ca khi dang qua tai.

        Khac biet so voi ban DuckDB, va la mot khac biet that: DuckDB dung MOT
        ket noi chung voi nhieu cursor, nen `/health` khong bao gio phai xep
        hang sau `/query`. PostgreSQL dung pool huu han, nen mot dot truy van
        nang co the chiem het ket noi va lam `/health` cho hang giay - do duoc
        5,03s trong bo test khi 8 luong cung doi truy van.
        `/health` cham theo tai la `/health` vo dung: no se bao dong khi dich vu
        van hoan toan khoe.
        Nen: cho ngan, va neu pool ban thi coi la SONG - pool ban chinh la bang
        chung dich vu dang phuc vu. Chi ket noi HONG moi la khong song.
        """
        try:
            with self._pool.connection(timeout=timeout_s) as con:
                return con.execute("SELECT 1").fetchone()[0] == 1
        except PoolTimeout:
            # Het ket noi ranh = dang ban, khong phai chet.
            return True
        except Exception:  # pragma: no cover
            return False

    def close(self) -> None:
        try:
            self._pool.close()
        except Exception:  # pragma: no cover
            pass


def _safe_cancel(con: psycopg.Connection) -> None:  # pragma: no cover
    try:
        con.cancel_safe()
    except Exception:
        pass


#: Rang buoc FK nam GON trong mot schema, tung cap cot theo dung thu tu khai
#: bao. `conparentid = 0`: bang phan vung (scm.sales_20xx) nhan mot ban sao FK
#: cho MOI phan vung; chi giu rang buoc goc tren bang cha, khong thi so do ve
#: mot canh cho tung nam du lieu. FK tro sang schema khac bi bo: dau kia khong
#: nam trong catalog nao ma hoc vien duoc thay.
_FOREIGN_KEY_SQL = """
    SELECT lower(src.relname), c.conname, lower(dst.relname),
           k.ord, sa.attname, da.attname
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class dst ON dst.oid = c.confrelid
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey)
         WITH ORDINALITY AS k(src_att, dst_att, ord)
    JOIN pg_attribute sa ON sa.attrelid = c.conrelid  AND sa.attnum = k.src_att
    JOIN pg_attribute da ON da.attrelid = c.confrelid AND da.attnum = k.dst_att
    WHERE c.contype = 'f'
      AND c.conparentid = 0
      AND src.relnamespace = %s::regnamespace
      AND dst.relnamespace = %s::regnamespace
    ORDER BY 1, 2, 4
"""


def fetch_foreign_keys(
    con: psycopg.Connection, schema: str
) -> dict[str, tuple[ForeignKeyInfo, ...]]:
    """Moi FK trong `schema`, gom theo ten bang nguon (chu thuong).

    Chi doc `pg_catalog`, khong cham du lieu. Ket qua CHUA loc quyen: Catalog
    loc o ca hai dau (`Catalog.relationships`) truoc khi ra HTTP.
    """
    rows = con.execute(_FOREIGN_KEY_SQL, (schema, schema)).fetchall()
    parts: dict[tuple[str, str], tuple[str, list[str], list[str]]] = {}
    for src, conname, dst, _ord, src_col, dst_col in rows:
        entry = parts.setdefault((src, conname), (dst, [], []))
        entry[1].append(src_col)
        entry[2].append(dst_col)
    out: dict[str, list[ForeignKeyInfo]] = {}
    for (src, _conname), (dst, cols, ref_cols) in parts.items():
        out.setdefault(src, []).append(
            ForeignKeyInfo(columns=tuple(cols), ref_table=dst, ref_columns=tuple(ref_cols))
        )
    return {name: tuple(items) for name, items in out.items()}


def _pg_display_type(data_type: str, precision, scale) -> str:
    """Ten kieu cua information_schema -> ten hien thi kieu DuckDB."""
    t = (data_type or "").lower()
    if t == "numeric":
        if precision is not None and scale is not None:
            return f"DECIMAL({precision},{scale})"
        return "DECIMAL"
    return {
        "bigint": "BIGINT",
        "integer": "INTEGER",
        "smallint": "SMALLINT",
        "text": "VARCHAR",
        "character varying": "VARCHAR",
        "character": "VARCHAR",
        "boolean": "BOOLEAN",
        "date": "DATE",
        "timestamp without time zone": "TIMESTAMP",
        "timestamp with time zone": "TIMESTAMPTZ",
        "double precision": "DOUBLE",
        "real": "FLOAT",
    }.get(t, "VARCHAR")


# ---------------------------------------------------------------------------
# Loc thong bao loi
# ---------------------------------------------------------------------------

_GENERIC_ENGINE_ERROR = "The query could not be executed."

#: Lop SQLSTATE 22 = data exception: chia cho 0, ep kieu that bai, tran so.
#: Nhung loi nay noi ve DU LIEU CUA CHINH TRUY VAN, khong noi gi ve may chu, va
#: hoc vien can doc duoc chung de sua bai.
_PASS_THROUGH_CLASSES = ("22",)

#: Loi cu phap / dinh danh. Chung noi dung ve cau lenh hoc vien vua go.
#: 42P01 va 42703 nam o day CO CHU DINH: tren goi hoc vien dung chuan, mot bang
#: bi giau THUC SU khong ton tai, nen "does not exist" la thong bao DUNG, va no
#: giong het thong bao cua mot ten go sai.
_PASS_THROUGH_STATES = frozenset({
    "42601",  # syntax_error
    "42703",  # undefined_column
    "42P01",  # undefined_table
    "42883",  # undefined_function
    "42702",  # ambiguous_column
    "42725",  # ambiguous_function
    "42804",  # datatype_mismatch
    "42846",  # cannot_coerce
    "42P10",  # invalid_column_reference
    "42P20",  # windowing_error
    "42809",  # wrong_object_type
})

#: Het tai nguyen. Van ban goc cua PostgreSQL noi ve cau hinh may chu ma hoc
#: vien khong doi duoc, nen thay bang loi khuyen ho lam duoc.
_RESOURCE_STATES = frozenset({"53100", "53200", "53400", "54000", "54001", "54011"})


def _sanitize_engine_error(
    exc: Exception, hidden_names: frozenset[str] = frozenset()
) -> str:
    """Chi tra ve thong bao cua engine khi no khong the lo noi bo may chu.

    VIET LAI, KHONG PORT tu ban DuckDB. Ban DuckDB so khop TIEN TO cua
    `str(exception)`. Lam vay tren psycopg la ro ri, vi hai ly do da do duoc:

      1. `str(exc)` cua psycopg kem `LINE 1: ...` in NGUYEN cau SQL da boc -
         tuc la ca cau `SELECT * FROM (...) AS _aivb_student_query LIMIT 1001`.
      2. PostgreSQL dinh kem truong HINT goi y TEN COT THAT lay tu catalog:
             HINT: Perhaps you meant to reference the column "core_customer.customer_id".
         Do la mot cong cu liet ke catalog, va DuckDB khong he co truong nay.

    Nen o day CHI doc `diag.message_primary`, va chi voi nhung SQLSTATE da xet.
    Khong bao gio doc `str(exc)`, `message_hint`, `message_detail`, `context`,
    `internal_query`, `schema_name`, `table_name`, `column_name` - moi thu do
    deu la kenh ro ri co cau truc.
    """
    state = getattr(exc, "sqlstate", None) or ""
    diag = getattr(exc, "diag", None)
    primary = (getattr(diag, "message_primary", None) or "").strip() if diag else ""

    if state in _RESOURCE_STATES:
        message = (
            "The query needed more resources than this shared service allows. "
            "Try grouping by fewer distinct values, adding a WHERE filter, or "
            "aggregating instead of listing every row."
        )
    elif state in _PASS_THROUGH_STATES or state.startswith(_PASS_THROUGH_CLASSES):
        message = primary[:400] if primary else _GENERIC_ENGINE_ERROR
    else:
        message = _GENERIC_ENGINE_ERROR

    # Duong dan he thong tap tin khong bao gio duoc ra ngoai.
    if "/" in message or "\\" in message:
        return _GENERIC_ENGINE_ERROR

    lowered = message.lower()
    if any(name and name in lowered for name in hidden_names):
        return _GENERIC_ENGINE_ERROR
    return message
