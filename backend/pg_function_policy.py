"""Chinh sach ham cho PostgreSQL: danh sach CHO PHEP, khong phai danh sach cam.

Doc `api/pg_functions_allowed.txt` truoc khi doc file nay - phan giai thich vi
sao chieu suy luan bi dao nguoc nam o day.

Tom tat: ban DuckDB suy ra tap ham an toan TU ENGINE (`duckdb_functions()`, ~1200
ten, gan nhu deu vo hai) va cam them mot nhum nho. `pg_proc` cua PostgreSQL 18 co
2787 ten trong `pg_catalog`, hang tram trong so do doc file, do catalog hoac doi
trang thai may chu. Port nguyen xi se lam nhanh fail-closed cho `exp.Anonymous`
trong `api/guard.py` AM THAM tro thanh fail-open.

Nen o day `pg_proc` chi dung de KIEM CHUNG danh sach cho phep, va hai phep kiem
duoi day lam API KHONG khoi dong duoc neu that bai:

  1. moi ten trong danh sach phai TON TAI trong engine
     -> danh sach khong the muc dan qua cac ban nang cap ma khong ai biet;
  2. khong ten nao vua duoc phep vua thuoc mot ho nguy hiem
     -> mot dong them nham vao file se lam dich vu khong len, chu khong tro
        thanh mot lo hong im lang.

Da do tren PostgreSQL 18.3: danh sach 159 ten = 5,7% cua engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ALLOWLIST = Path(__file__).with_name("pg_functions_allowed.txt")

#: Ho ham nguy hiem, nhan dien theo TIEN TO chu khong theo ten.
#:
#: Tien to quan trong hon danh sach ten cu the: rieng `pg_stat_get_*` da co
#: khoang 200 ham, va moi ban PostgreSQL lai them vai cai. Mot danh sach ten
#: khong bao gio duoi kip; mot quy tac tien to thi khong can duoi.
DENIED_PREFIXES: tuple[str, ...] = (
    "pg_read", "pg_write", "pg_file", "pg_ls",
    "pg_stat", "pg_statio", "pgstat",
    "pg_sleep", "pg_advisory", "pg_try_advisory",
    "pg_terminate", "pg_cancel", "pg_signal",
    "pg_logical", "pg_replication", "pg_wal", "pg_control", "pg_backup",
    "pg_create_", "pg_drop_", "pg_import", "pg_export",
    "lo_", "dblink", "postgres_fdw", "binary_upgrade", "_pg_",
)

#: Ham nguy hiem khong bat duoc bang tien to. Phan lon la kenh DO SU TON TAI
#: (`to_regclass` tra ve OID neu quan he ton tai, NULL neu khong - qua mat hoan
#: toan phep kiem allowlist bang vi truy van khong he co node exp.Table nao) va
#: kenh lo cau hinh may chu.
DENIED_NAMES: frozenset[str] = frozenset({
    # do su ton tai
    "to_regclass", "to_regtype", "to_regproc", "to_regprocedure",
    "to_regoper", "to_regoperator", "to_regrole", "to_regnamespace",
    "to_regcollation",
    "has_table_privilege", "has_column_privilege", "has_schema_privilege",
    "has_database_privilege", "has_function_privilege", "has_sequence_privilege",
    "has_any_column_privilege", "has_language_privilege", "has_server_privilege",
    "has_tablespace_privilege", "has_type_privilege", "has_parameter_privilege",
    "has_foreign_data_wrapper_privilege", "pg_has_role", "row_security_active",
    # lo dinh nghia doi tuong
    "pg_get_viewdef", "pg_get_ruledef", "pg_get_indexdef", "pg_get_constraintdef",
    "pg_get_triggerdef", "pg_get_functiondef", "pg_get_function_arguments",
    "pg_get_function_identity_arguments", "pg_get_function_result",
    "pg_get_expr", "pg_get_userbyid", "pg_get_serial_sequence",
    "pg_get_partkeydef", "pg_get_statisticsobjdef", "pg_get_acl",
    "pg_describe_object", "pg_identify_object", "pg_identify_object_as_address",
    "obj_description", "col_description", "shobj_description",
    "format_type", "pg_typeof", "pg_collation_actual_version",
    # lo cau hinh / moi truong
    "current_setting", "set_config", "version", "current_database",
    "current_catalog", "current_schema", "current_schemas",
    "current_user", "session_user", "user", "current_role",
    "inet_server_addr", "inet_server_port", "inet_client_addr", "inet_client_port",
    "pg_postmaster_start_time", "pg_conf_load_time", "pg_current_logfile",
    "pg_reload_conf", "pg_config",
    # kich thuoc / vi tri vat ly (do gian tiep noi dung bang bi giau)
    "pg_relation_size", "pg_table_size", "pg_indexes_size",
    "pg_total_relation_size", "pg_database_size", "pg_column_size",
    "pg_relation_filepath", "pg_relation_filenode", "pg_tablespace_location",
    "pg_tablespace_databases", "pg_size_pretty", "pg_size_bytes",
    # xuat du lieu ra ngoai
    "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
    "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
    "schema_to_xml", "schema_to_xmlschema", "schema_to_xml_and_xmlschema",
    "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
    "cursor_to_xml", "cursor_to_xmlschema",
    "xpath", "xpath_exists", "xmltable", "xmlelement", "xmlforest",
    "xmlconcat", "xmlpi", "xmlroot", "xmlagg", "xmlserialize",
    # doi trang thai
    "nextval", "setval", "currval", "lastval", "pg_notify",
    "pg_sequence_last_value", "pg_sequence_parameters",
    "txid_current", "txid_current_snapshot", "pg_current_xact_id",
    "pg_current_snapshot", "pg_snapshot_xip", "pg_snapshot_xmin",
    "pg_snapshot_xmax", "pg_visible_in_snapshot",
    # doc catalog dang tap hop
    "pg_show_all_settings", "pg_show_all_file_settings", "pg_hba_file_rules",
    "pg_ident_file_mappings", "pg_lock_status", "pg_prepared_statement",
    "pg_prepared_xact", "pg_cursor", "pg_get_keywords", "pg_options_to_table",
    "pg_timezone_names", "pg_timezone_abbrevs", "pg_available_extensions",
    "pg_available_extension_versions", "pg_extension_update_paths",
    "pg_partition_tree", "pg_partition_ancestors", "pg_partition_root",
    "pg_backend_memory_contexts", "pg_backend_pid", "pg_blocking_pids",
})


class FunctionPolicyError(RuntimeError):
    """Danh sach cho phep khong con mo ta dung engine - KHONG khoi dong dich vu."""


def is_denied(name: str) -> bool:
    """Ten co thuoc mot ho nguy hiem khong."""
    low = (name or "").strip().lower()
    return low in DENIED_NAMES or low.startswith(DENIED_PREFIXES)


def load_allowlist(path: Path | str = DEFAULT_ALLOWLIST) -> frozenset[str]:
    """Doc file danh sach cho phep. Bo dong trong va dong chu thich."""
    path = Path(path)
    if not path.exists():
        raise FunctionPolicyError(f"Khong thay danh sach cho phep: {path}")
    names: set[str] = set()
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", line):
            raise FunctionPolicyError(
                f"{path}:{lineno}: {line!r} khong phai mot ten ham hop le. "
                "Moi dong phai la MOT ten, chu thuong, khong tham so."
            )
        names.add(line)
    if not names:
        raise FunctionPolicyError(f"{path}: danh sach rong.")
    return frozenset(names)


@dataclass(frozen=True)
class PgFunctionPolicy:
    """Tap ham duoc phep, da doi chieu voi engine that.

    `allowed`         - danh sach do NGUOI SOAN, tu file; day la nguon.
    `set_returning`   - ten tra ve TAP HOP (proretset), lay tu engine; chung chi
                        duoc xuat hien o vi tri FROM.
    `engine_universe` - moi ten engine biet; CHI dung de kiem chung, khong bao
                        gio dung de cho phep.
    """

    allowed: frozenset[str]
    set_returning: frozenset[str]
    engine_universe: frozenset[str]

    @classmethod
    def from_connection(
        cls, conn, allowlist_path: Path | str = DEFAULT_ALLOWLIST
    ) -> "PgFunctionPolicy":
        rows = conn.execute(
            """
            SELECT lower(p.proname) AS name, bool_or(p.proretset) AS srf
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            GROUP BY 1
            """
        ).fetchall()
        universe = {r[0] for r in rows}
        srf = {r[0] for r in rows if r[1]}
        allowed = load_allowlist(allowlist_path)

        # (1) Danh sach phai mo ta dung engine nay.
        missing = sorted(allowed - universe)
        if missing:
            raise FunctionPolicyError(
                "Danh sach cho phep nhac toi ham KHONG CO trong cluster nay: "
                f"{missing}. Tu choi khoi dong - danh sach da khong con mo ta "
                "dung engine, va mot danh sach sai thi khong bao ve duoc gi."
            )

        # (2) Khong duoc vua cho phep vua nguy hiem.
        conflict = sorted(n for n in allowed if is_denied(n))
        if conflict:
            raise FunctionPolicyError(
                f"Ten vua nam trong danh sach cho phep vua thuoc ho nguy hiem: "
                f"{conflict}. Tu choi khoi dong."
            )

        # (3) Danh sach phai NHO hon engine rat nhieu. Neu mot ngay nao do ai do
        # sinh file nay tu chinh pg_proc thi phep dao nguoc da mat va ta quay ve
        # dung cai fail-open ma ca thiet ke nay sinh ra de tranh.
        if len(allowed) > len(universe) // 4:
            raise FunctionPolicyError(
                f"Danh sach cho phep co {len(allowed)} ten tren {len(universe)} "
                "ten cua engine - qua lon de con la mot danh sach do nguoi soan. "
                "Rat co the no da duoc sinh tu pg_proc, tuc la fail-open."
            )

        return cls(
            allowed=allowed,
            set_returning=frozenset(srf),
            engine_universe=frozenset(universe),
        )

    def permits(self, candidates: set[str]) -> bool:
        """Mot ham `exp.Anonymous` co duoc chay khong.

        Fail closed: khong ten ung vien nao nam trong danh sach thi tu choi.
        """
        return bool(candidates & self.allowed)
