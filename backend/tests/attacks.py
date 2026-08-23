"""Attack corpus for the student SQL guard.

MUST_BLOCK entries are (id, sql). Every one of them is expected to be refused
before it ever reaches DuckDB. MUST_ALLOW entries guard against over-blocking,
which would make the tool useless for teaching.

Tests run against `fixture_full.duckdb`, in which the INSTRUCTOR tables
physically exist - so a "blocked" result really means the backend blocked it,
not that the table happened to be missing.
"""

from pathlib import Path

from backend.catalog import load_contract_visibility
from backend.config import DEFAULT_CONTRACT_PATH
from backend.release_contract import load_visibility_policy

_VISIBILITY = load_visibility_policy()
# Dung dung ban hop dong ma ung dung dung luc chay, thay vi tu dung lai duong
# dan - neu hai ban lech nhau thi bo test bao mat se kiem tren mot the gioi
# khac voi the gioi that.
_CONTRACT_VISIBILITY = load_contract_visibility(DEFAULT_CONTRACT_PATH)
INSTRUCTOR_TABLES = sorted(_CONTRACT_VISIBILITY.restricted_tables)
INSTRUCTOR_ALIASES = sorted(_VISIBILITY["object_alias_resolution"])
OWNER_RESTRICTED_NAMES = sorted(_VISIBILITY["instructor_only_tables"])

# --------------------------------------------------------------------------
# Group 1 - direct access to the grading answer key
# --------------------------------------------------------------------------
DIRECT = [
    ("direct.scenario_label", "SELECT * FROM meta_scenario_label"),
    ("direct.dirty_log", "SELECT * FROM meta_dirty_log"),
    ("direct.cfg_interest_rule", "SELECT * FROM cfg_interest_rule"),
    ("direct.cfg_fee_rule", "SELECT * FROM cfg_fee_rule"),
    ("direct.count", "SELECT count(*) FROM meta_dirty_log"),
    ("direct.column", "SELECT label FROM meta_scenario_label"),
]
DIRECT += [
    (f"direct.owner_alias.{alias}", f"SELECT * FROM {alias}")
    for alias in INSTRUCTOR_ALIASES
]
DIRECT += [
    (f"direct.owner_restricted.{name}", f"SELECT * FROM {name}")
    for name in OWNER_RESTRICTED_NAMES
    if name not in INSTRUCTOR_TABLES
]

# --------------------------------------------------------------------------
# Group 2 - lexical evasion
# --------------------------------------------------------------------------
LEXICAL = [
    ("lex.upper", "SELECT * FROM META_DIRTY_LOG"),
    ("lex.mixedcase", "SeLeCt * FrOm MeTa_ScEnArIo_LaBeL"),
    ("lex.block_comment", "SELECT * FROM /*x*/ meta_dirty_log"),
    ("lex.line_comment", "SELECT * FROM -- comment\n meta_dirty_log"),
    ("lex.comment_inside_name", "SELECT * FROM meta_dirty_log /* trailing */"),
    ("lex.quoted", 'SELECT * FROM "meta_dirty_log"'),
    ("lex.quoted_upper", 'SELECT * FROM "META_DIRTY_LOG"'),
    ("lex.tab_newline", "SELECT\t*\nFROM\r\n\tmeta_dirty_log"),
    ("lex.many_spaces", "SELECT    *     FROM        meta_dirty_log"),
    ("lex.nested_comment", "SELECT * FROM /* a /* b */ meta_dirty_log"),
    ("lex.from_first", "FROM meta_dirty_log SELECT *"),
    ("lex.trailing_semicolon", "SELECT * FROM meta_dirty_log;"),
]

# --------------------------------------------------------------------------
# Group 3 - qualified / schema-hopping references
# --------------------------------------------------------------------------
QUALIFIED = [
    ("qual.aivb", "SELECT * FROM aivb.meta_dirty_log"),
    ("qual.aivb_quoted", 'SELECT * FROM "aivb"."meta_dirty_log"'),
    ("qual.main", "SELECT * FROM main.meta_dirty_log"),
    ("qual.public", "SELECT * FROM public.meta_dirty_log"),
    ("qual.catalog", "SELECT * FROM aivb_test_hostile.aivb.meta_dirty_log"),
    ("qual.other_database", "SELECT * FROM aivb_instructor.aivb.meta_dirty_log"),
    ("qual.temp", "SELECT * FROM pg_temp.meta_dirty_log"),
    ("qual.info_schema_tables", "SELECT * FROM information_schema.tables"),
    ("qual.info_schema_columns", "SELECT * FROM information_schema.columns"),
    ("qual.pg_catalog", "SELECT * FROM pg_catalog.pg_class"),
    ("qual.pg_tables", "SELECT * FROM pg_tables"),
]

# --------------------------------------------------------------------------
# Group 3b - PostgreSQL-specific. None of these exist on DuckDB, so none of
# them were covered before the engine change.
#
# The two families that matter most:
#
#   pg.oracle.*  Existence oracles that contain NO exp.Table node at all.
#                `'meta_dirty_log'::regclass` returns an OID if the relation
#                exists and raises if it does not, and it never touches the
#                table allowlist because there is no table reference to check.
#                Blocked by removing `ObjectIdentifier` from ALLOWED_NODES.
#
#   pg.catalog.* Reading pg_catalog directly. Unlike DuckDB's
#                `information_schema`, these tables are world-readable by
#                design and CANNOT be revoked. The guard's schema check is the
#                only barrier for the web console. (BI users reach them freely;
#                that is safe only because the withheld objects are physically
#                absent - see api/tests/test_pg_engine_defenses.py.)
# --------------------------------------------------------------------------
PG_ORACLE = [
    ("pg.oracle.regclass", "SELECT 'meta_dirty_log'::regclass"),
    ("pg.oracle.regclass_qual", "SELECT 'aivb.meta_dirty_log'::regclass"),
    ("pg.oracle.regclass_cast_fn", "SELECT CAST('meta_dirty_log' AS regclass)"),
    ("pg.oracle.regtype", "SELECT 'bigint'::regtype"),
    ("pg.oracle.regproc", "SELECT 'pg_read_file'::regproc"),
    ("pg.oracle.regrole", "SELECT 'aivb_api_instructor'::regrole"),
    ("pg.oracle.regnamespace", "SELECT 'aivb'::regnamespace"),
    ("pg.oracle.tableoid", "SELECT tableoid::regclass FROM core_party"),
    ("pg.oracle.to_regclass", "SELECT to_regclass('meta_dirty_log')"),
    ("pg.oracle.to_regclass_isnull", "SELECT to_regclass('aivb.meta_dirty_log') IS NULL"),
    ("pg.oracle.has_table_priv", "SELECT has_table_privilege('meta_dirty_log', 'SELECT')"),
    ("pg.oracle.has_column_priv",
     "SELECT has_column_privilege('raw_account_transaction', 'dirty_flag', 'SELECT')"),
    ("pg.oracle.relation_size", "SELECT pg_relation_size('meta_dirty_log')"),
    ("pg.oracle.column_size", "SELECT pg_column_size(dirty_flag) FROM raw_account_transaction"),
    ("pg.oracle.obj_description", "SELECT obj_description('meta_dirty_log'::regclass)"),
    ("pg.oracle.pg_typeof", "SELECT pg_typeof(dirty_flag) FROM raw_account_transaction"),
    ("pg.oracle.get_viewdef", "SELECT pg_get_viewdef('meta_dirty_log'::regclass, true)"),
    ("pg.oracle.filepath", "SELECT pg_relation_filepath('core_party')"),
]

PG_CATALOG = [
    ("pg.catalog.pg_class", "SELECT relname FROM pg_class"),
    ("pg.catalog.pg_class_filtered", "SELECT relname FROM pg_class WHERE relname LIKE 'meta_%'"),
    ("pg.catalog.pg_attribute",
     "SELECT attname FROM pg_attribute WHERE attrelid = 'core_party'::regclass"),
    ("pg.catalog.pg_namespace", "SELECT nspname FROM pg_namespace"),
    ("pg.catalog.pg_proc", "SELECT proname FROM pg_proc"),
    ("pg.catalog.pg_type", "SELECT typname FROM pg_type"),
    ("pg.catalog.pg_views", "SELECT viewname FROM pg_views"),
    ("pg.catalog.pg_indexes", "SELECT indexdef FROM pg_indexes"),
    ("pg.catalog.pg_matviews", "SELECT matviewname FROM pg_matviews"),
    ("pg.catalog.pg_stat_activity", "SELECT query FROM pg_stat_activity"),
    ("pg.catalog.pg_stat_user_tables", "SELECT relname, n_live_tup FROM pg_stat_user_tables"),
    ("pg.catalog.pg_settings", "SELECT name, setting FROM pg_settings"),
    ("pg.catalog.pg_roles", "SELECT rolname FROM pg_roles"),
    ("pg.catalog.pg_authid", "SELECT rolname, rolpassword FROM pg_authid"),
    ("pg.catalog.pg_shadow", "SELECT usename, passwd FROM pg_shadow"),
    ("pg.catalog.pg_database", "SELECT datname FROM pg_database"),
    ("pg.catalog.pg_hba_rules", "SELECT * FROM pg_hba_file_rules()"),
    ("pg.catalog.pg_show_all_settings", "SELECT * FROM pg_show_all_settings()"),
]

PG_FILESYSTEM = [
    ("pg.fs.read_file", "SELECT pg_read_file('postgresql.conf')"),
    ("pg.fs.read_binary", "SELECT pg_read_binary_file('postgresql.conf')"),
    ("pg.fs.ls_dir", "SELECT * FROM pg_ls_dir('.')"),
    ("pg.fs.ls_dir_scalar", "SELECT pg_ls_dir('base')"),
    ("pg.fs.ls_waldir", "SELECT * FROM pg_ls_waldir()"),
    ("pg.fs.stat_file", "SELECT * FROM pg_stat_file('postgresql.conf')"),
    ("pg.fs.lo_import", "SELECT lo_import('C:/Windows/win.ini')"),
    ("pg.fs.lo_export", "SELECT lo_export(1, 'C:/leak.txt')"),
    ("pg.fs.lo_get", "SELECT lo_get(1)"),
    ("pg.fs.dblink",
     "SELECT * FROM dblink('dbname=aivb_instructor', 'SELECT 1') AS t(a text)"),
    ("pg.fs.dblink_exec", "SELECT dblink_exec('dbname=aivb_instructor', 'SELECT 1')"),
    # Danh sach cot cua ham tra ve tap hop: CONG NGU PHAP vao ca ho tren.
    ("pg.fs.srf_coldef", "SELECT * FROM json_to_recordset('[{\"a\":1}]') AS x(a int)"),
    ("pg.fs.srf_coldef_hidden",
     "SELECT * FROM dblink('','') AS t(dirty_flag boolean)"),
]

PG_ENVIRONMENT = [
    ("pg.env.current_setting", "SELECT current_setting('data_directory')"),
    ("pg.env.current_setting_hba", "SELECT current_setting('hba_file')"),
    ("pg.env.set_config", "SELECT set_config('search_path', 'pg_catalog', false)"),
    ("pg.env.version", "SELECT version()"),
    ("pg.env.current_database", "SELECT current_database()"),
    ("pg.env.current_user", "SELECT current_user"),
    ("pg.env.session_user", "SELECT session_user"),
    ("pg.env.inet_server", "SELECT inet_server_addr()"),
    ("pg.env.backend_pid", "SELECT pg_backend_pid()"),
    ("pg.env.sleep", "SELECT pg_sleep(30)"),
    ("pg.env.sleep_in_where", "SELECT count(*) FROM core_party WHERE pg_sleep(0.01) IS NULL"),
    ("pg.env.advisory_lock", "SELECT pg_advisory_lock(1)"),
    ("pg.env.terminate", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"),
    ("pg.env.nextval", "SELECT nextval('some_seq')"),
    ("pg.env.notify", "SELECT pg_notify('c', 'x')"),
    ("pg.env.txid", "SELECT txid_current()"),
    ("pg.env.stat_get", "SELECT pg_stat_get_numscans('core_party'::regclass)"),
]

PG_SYNTAX = [
    ("pg.syntax.for_update", "SELECT * FROM core_party FOR UPDATE"),
    ("pg.syntax.for_share", "SELECT * FROM core_party FOR SHARE"),
    ("pg.syntax.for_no_key_update", "SELECT * FROM core_party FOR NO KEY UPDATE"),
    ("pg.syntax.operator_qual",
     "SELECT * FROM core_party WHERE party_id OPERATOR(pg_catalog.=) 'x'"),
    ("pg.syntax.placeholder", "SELECT $1 FROM core_party"),
    ("pg.syntax.system_col_ctid", "SELECT ctid FROM core_party"),
    ("pg.syntax.system_col_xmin", "SELECT xmin FROM core_party"),
    ("pg.syntax.system_col_xmax", "SELECT xmax FROM core_party"),
    ("pg.syntax.query_to_xml",
     "SELECT query_to_xml('SELECT * FROM aivb.meta_dirty_log', true, false, '')"),
    ("pg.syntax.table_to_xml", "SELECT table_to_xml('core_party'::regclass, true, false, '')"),
    ("pg.syntax.schema_to_xml", "SELECT schema_to_xml('aivb', true, false, '')"),
    ("pg.syntax.xmltable",
     "SELECT * FROM xmltable('/' PASSING '<a/>' COLUMNS c text PATH '.')"),
    ("pg.syntax.copy_to_file", "COPY (SELECT * FROM core_party) TO 'C:/leak.csv'"),
    ("pg.syntax.copy_program", "COPY core_party FROM PROGRAM 'cmd /c dir'"),
    ("pg.syntax.copy_stdout", "COPY core_party TO STDOUT"),
    ("pg.syntax.explain", "EXPLAIN SELECT * FROM aivb.meta_dirty_log"),
    ("pg.syntax.explain_analyze", "EXPLAIN ANALYZE SELECT * FROM core_party"),
    ("pg.syntax.declare_cursor", "DECLARE c CURSOR FOR SELECT * FROM meta_dirty_log"),
    ("pg.syntax.do_block", "DO $$ BEGIN PERFORM 1; END $$"),
    ("pg.syntax.create_extension", "CREATE EXTENSION dblink"),
    ("pg.syntax.set_search_path", "SET search_path = pg_catalog, aivb"),
    ("pg.syntax.set_readonly_off", "SET default_transaction_read_only = off"),
    ("pg.syntax.set_statement_timeout", "SET statement_timeout = 0"),
    ("pg.syntax.writable_cte",
     "WITH t AS (INSERT INTO core_party VALUES ('x') RETURNING *) SELECT * FROM t"),
    ("pg.syntax.lateral_srf", "SELECT * FROM core_party, LATERAL pg_ls_dir('.') d"),
]

#: Cot bi cat. Moi cach go phai cho CUNG MOT thong bao nhu mot cot go sai.
PG_WITHHELD_COLUMN = [
    ("pg.col.bare", "SELECT dirty_flag FROM raw_account_transaction"),
    ("pg.col.qualified", "SELECT r.dirty_flag FROM raw_account_transaction r"),
    ("pg.col.where", "SELECT count(*) FROM raw_account_transaction WHERE dirty_flag"),
    ("pg.col.order_by", "SELECT raw_row_id FROM raw_account_transaction ORDER BY dirty_flag"),
    ("pg.col.alias", "SELECT dirty_flag AS x FROM raw_account_transaction"),
    ("pg.col.group_by", "SELECT dirty_flag, count(*) FROM raw_account_transaction GROUP BY 1"),
    ("pg.col.having",
     "SELECT count(*) FROM raw_account_transaction HAVING bool_or(dirty_flag)"),
    ("pg.col.cte",
     "WITH t AS (SELECT dirty_flag FROM raw_account_transaction) SELECT * FROM t"),
]

# --------------------------------------------------------------------------
# Group 4 - structural hiding (subquery / CTE / join / set op / alias)
# --------------------------------------------------------------------------
STRUCTURAL = [
    ("struct.subquery_from", "SELECT * FROM (SELECT * FROM meta_dirty_log) x"),
    (
        "struct.subquery_where",
        "SELECT * FROM core_party WHERE party_id IN (SELECT party_id FROM meta_scenario_label)",
    ),
    (
        "struct.subquery_select",
        "SELECT (SELECT count(*) FROM meta_dirty_log) AS n FROM core_party",
    ),
    (
        "struct.subquery_having",
        "SELECT count(*) FROM core_party HAVING count(*) > (SELECT count(*) FROM meta_dirty_log)",
    ),
    (
        "struct.subquery_orderby",
        "SELECT party_id FROM core_party ORDER BY (SELECT count(*) FROM meta_dirty_log)",
    ),
    (
        "struct.exists",
        "SELECT * FROM core_party WHERE EXISTS (SELECT 1 FROM meta_dirty_log)",
    ),
    ("struct.cte", "WITH x AS (SELECT * FROM meta_dirty_log) SELECT * FROM x"),
    (
        "struct.cte_chain",
        "WITH a AS (SELECT 1 AS n), b AS (SELECT * FROM cfg_interest_rule) "
        "SELECT * FROM a, b",
    ),
    (
        "struct.cte_shadow_name",
        "WITH meta_dirty_log AS (SELECT 1 AS x) SELECT * FROM meta_dirty_log",
    ),
    (
        "struct.cte_sibling_shadow",
        "SELECT * FROM (WITH cfg_interest_rule AS (SELECT 1 AS z) SELECT z FROM "
        "cfg_interest_rule) q, cfg_interest_rule",
    ),
    (
        "struct.join",
        "SELECT * FROM core_party p JOIN meta_scenario_label m ON p.party_id = m.party_id",
    ),
    (
        "struct.positional_join",
        "SELECT * FROM core_party POSITIONAL JOIN meta_dirty_log",
    ),
    ("struct.cross_join", "SELECT * FROM core_party, meta_dirty_log"),
    ("struct.union", "SELECT party_id FROM core_party UNION SELECT party_id FROM meta_scenario_label"),
    (
        "struct.union_all",
        "SELECT party_id FROM core_party UNION ALL SELECT party_id FROM meta_scenario_label",
    ),
    (
        "struct.except",
        "SELECT party_id FROM core_party EXCEPT SELECT party_id FROM meta_scenario_label",
    ),
    (
        "struct.intersect",
        "SELECT party_id FROM core_party INTERSECT SELECT party_id FROM meta_scenario_label",
    ),
    ("struct.alias_disguise", "SELECT * FROM meta_dirty_log AS core_party"),
    (
        "struct.alias_columns",
        "SELECT * FROM meta_dirty_log t(a, b, c)",
    ),
    ("struct.lateral", "SELECT * FROM core_party, LATERAL (SELECT * FROM meta_dirty_log) l"),
    ("struct.tablesample", "SELECT * FROM meta_dirty_log TABLESAMPLE 10%"),
    (
        "struct.recursive_cte",
        "WITH RECURSIVE r AS (SELECT * FROM meta_dirty_log) SELECT * FROM r",
    ),
    (
        "struct.deep_nesting",
        "SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT * FROM "
        "(SELECT * FROM meta_dirty_log) a) b) c) d",
    ),
    (
        "struct.values_join",
        "SELECT * FROM (VALUES (1)) v(x), meta_dirty_log",
    ),
    ("struct.pivot_instructor", "SELECT * FROM meta_dirty_log PIVOT (count(*) FOR error_type IN ('a'))"),
    ("struct.star_qualified", "SELECT meta_dirty_log.* FROM meta_dirty_log"),
]

# --------------------------------------------------------------------------
# Group 5 - statement type: DDL / DML / admin / multi-statement
# --------------------------------------------------------------------------
STATEMENTS = [
    ("stmt.multi_drop", "SELECT 1; DROP TABLE core_party"),
    ("stmt.multi_instructor", "SELECT 1; SELECT * FROM meta_dirty_log"),
    ("stmt.multi_comment", "SELECT 1; -- x\nSELECT * FROM meta_dirty_log"),
    ("stmt.multi_semicolons", "SELECT 1;;SELECT 2"),
    ("stmt.create_table", "CREATE TABLE hack (a INT)"),
    ("stmt.create_view_instructor", "CREATE VIEW v AS SELECT * FROM meta_dirty_log"),
    ("stmt.create_temp_view", "CREATE TEMP VIEW v AS SELECT * FROM meta_dirty_log"),
    ("stmt.create_macro", "CREATE MACRO leak() AS (SELECT * FROM meta_dirty_log)"),
    ("stmt.create_as_select", "CREATE TABLE hack AS SELECT * FROM core_party"),
    ("stmt.drop_table", "DROP TABLE core_party"),
    ("stmt.alter_table", "ALTER TABLE core_party RENAME TO x"),
    ("stmt.truncate", "TRUNCATE core_party"),
    ("stmt.insert", "INSERT INTO core_party VALUES ('x')"),
    ("stmt.insert_select", "INSERT INTO core_party SELECT * FROM core_party"),
    ("stmt.update", "UPDATE core_party SET party_id = 'x'"),
    ("stmt.delete", "DELETE FROM core_party"),
    ("stmt.cte_insert", "WITH x AS (SELECT 1) INSERT INTO core_party SELECT * FROM x"),
    ("stmt.attach", "ATTACH '/tmp/evil.duckdb' AS evil"),
    ("stmt.attach_full_db", "ATTACH '_workspace/output/aivb_full.duckdb' AS full_db"),
    ("stmt.detach", "DETACH main"),
    ("stmt.copy_out", "COPY core_party TO '/tmp/leak.csv'"),
    ("stmt.copy_query_out", "COPY (SELECT * FROM core_party) TO '/tmp/leak.parquet'"),
    ("stmt.export", "EXPORT DATABASE '/tmp/dump'"),
    ("stmt.import", "IMPORT DATABASE '/tmp/dump'"),
    ("stmt.install", "INSTALL httpfs"),
    ("stmt.load", "LOAD httpfs"),
    ("stmt.pragma", "PRAGMA show_tables"),
    ("stmt.pragma_table_info", "PRAGMA table_info('meta_dirty_log')"),
    ("stmt.pragma_database_list", "PRAGMA database_list"),
    ("stmt.set", "SET memory_limit='16GB'"),
    ("stmt.set_external", "SET enable_external_access=true"),
    ("stmt.reset", "RESET memory_limit"),
    ("stmt.call", "CALL pragma_table_info('meta_dirty_log')"),
    ("stmt.describe", "DESCRIBE meta_dirty_log"),
    ("stmt.describe_select", "DESCRIBE SELECT * FROM meta_dirty_log"),
    ("stmt.summarize", "SUMMARIZE meta_dirty_log"),
    ("stmt.show_tables", "SHOW TABLES"),
    ("stmt.show_all_tables", "SHOW ALL TABLES"),
    ("stmt.show_table", "SHOW meta_dirty_log"),
    ("stmt.use", "USE main"),
    ("stmt.checkpoint", "CHECKPOINT"),
    ("stmt.prepare", "PREPARE p AS SELECT * FROM meta_dirty_log"),
    ("stmt.execute", "EXECUTE p"),
    ("stmt.begin", "BEGIN TRANSACTION"),
    ("stmt.pivot_stmt", "PIVOT meta_dirty_log ON error_type"),
    ("stmt.unpivot_stmt", "UNPIVOT meta_dirty_log ON dirty_id"),
    ("stmt.comment_on", "COMMENT ON TABLE core_party IS 'x'"),
    ("stmt.analyze", "ANALYZE"),
]

# --------------------------------------------------------------------------
# Group 6 - table functions / filesystem / catalog introspection
# --------------------------------------------------------------------------
FUNCTIONS = [
    ("fn.read_parquet", "SELECT * FROM read_parquet('_workspace/output/parquet/*.parquet')"),
    ("fn.read_parquet_abs", "SELECT * FROM read_parquet('/Users/nguyennp/AI/Finance/_workspace/output/parquet/core_party.parquet')"),
    ("fn.parquet_scan", "SELECT * FROM parquet_scan('/tmp/x.parquet')"),
    ("fn.read_csv", "SELECT * FROM read_csv('/etc/passwd')"),
    ("fn.read_csv_auto", "SELECT * FROM read_csv_auto('/etc/passwd')"),
    ("fn.read_json", "SELECT * FROM read_json('/tmp/x.json')"),
    ("fn.read_ndjson", "SELECT * FROM read_ndjson('/tmp/x.json')"),
    ("fn.read_text", "SELECT * FROM read_text('/etc/passwd')"),
    ("fn.read_blob", "SELECT * FROM read_blob('/etc/passwd')"),
    ("fn.glob", "SELECT * FROM glob('/Users/nguyennp/AI/Finance/_workspace/output/*')"),
    ("fn.string_path", "SELECT * FROM '/Users/nguyennp/AI/Finance/_workspace/output/parquet/core_party.parquet'"),
    ("fn.string_path_glob", "SELECT * FROM '_workspace/output/parquet/*.parquet'"),
    ("fn.duckdb_tables", "SELECT * FROM duckdb_tables()"),
    ("fn.duckdb_tables_noparen", "SELECT * FROM duckdb_tables"),
    ("fn.duckdb_columns", "SELECT * FROM duckdb_columns()"),
    ("fn.duckdb_views", "SELECT * FROM duckdb_views()"),
    ("fn.duckdb_schemas", "SELECT * FROM duckdb_schemas()"),
    ("fn.duckdb_databases", "SELECT * FROM duckdb_databases()"),
    ("fn.duckdb_settings", "SELECT * FROM duckdb_settings()"),
    ("fn.duckdb_functions", "SELECT * FROM duckdb_functions()"),
    ("fn.duckdb_constraints", "SELECT * FROM duckdb_constraints()"),
    ("fn.duckdb_secrets", "SELECT * FROM duckdb_secrets()"),
    ("fn.pragma_table_info", "SELECT * FROM pragma_table_info('meta_dirty_log')"),
    ("fn.pragma_storage_info", "SELECT * FROM pragma_storage_info('meta_dirty_log')"),
    ("fn.pragma_database_size", "SELECT * FROM pragma_database_size()"),
    ("fn.pragma_show", "SELECT * FROM pragma_show('meta_dirty_log')"),
    ("fn.sql_auto_complete", "SELECT * FROM sql_auto_complete('SELECT * FROM meta')"),
    ("fn.query", "SELECT * FROM query('SELECT * FROM meta_dirty_log')"),
    ("fn.query_concat", "SELECT * FROM query('SELECT * FROM ' || 'meta_dirty_log')"),
    ("fn.query_table", "SELECT * FROM query_table('meta_dirty_log')"),
    ("fn.json_exec_sql", "SELECT * FROM json_execute_serialized_sql('{}')"),
    ("fn.json_serialize_sql", "SELECT json_serialize_sql('SELECT * FROM meta_dirty_log')"),
    ("fn.sqlite_scan", "SELECT * FROM sqlite_scan('/tmp/a.db', 't')"),
    ("fn.postgres_scan", "SELECT * FROM postgres_scan('h', 'public', 'meta_dirty_log')"),
    ("fn.arrow_scan", "SELECT * FROM arrow_scan(1, 2)"),
    ("fn.seq_scan", "SELECT * FROM seq_scan('meta_dirty_log')"),
    ("fn.summary", "SELECT * FROM summary(meta_dirty_log)"),
    ("fn.current_setting", "SELECT current_setting('memory_limit')"),
    ("fn.current_database", "SELECT current_database()"),
    ("fn.getvariable", "SELECT getvariable('x')"),
    ("fn.version", "SELECT version()"),
    ("fn.unknown_func", "SELECT totally_made_up_function(1)"),
    ("fn.parquet_metadata", "SELECT * FROM parquet_metadata('/tmp/x.parquet')"),
    ("fn.sniff_csv", "SELECT * FROM sniff_csv('/etc/passwd')"),
    ("fn.which_secret", "SELECT which_secret('s3://x', 's3')"),
    ("fn.checkpoint_fn", "SELECT * FROM checkpoint()"),
    ("fn.repeat_row", "SELECT * FROM repeat_row(1, num_rows=5)"),
]

# --------------------------------------------------------------------------
# Group 7 - misc / parser abuse / input validation
# --------------------------------------------------------------------------
MISC = [
    ("misc.empty", ""),
    ("misc.whitespace", "   \n\t "),
    ("misc.comment_only", "-- just a comment"),
    ("misc.null_byte", "SELECT 1\x00 FROM core_party"),
    ("misc.placeholder_q", "SELECT ? FROM core_party"),
    ("misc.placeholder_dollar", "SELECT $1 FROM core_party"),
    ("misc.garbage", "this is not sql at all"),
    ("misc.unbalanced", "SELECT * FROM ("),
    (
        "misc.comment_escape_injection",
        "SELECT 1 /* a */; SELECT * FROM meta_dirty_log /* b */",
    ),
    ("misc.deep_paren_bomb", "SELECT " + "(" * 400 + "1" + ")" * 400),
    ("misc.long_query", "SELECT " + " + ".join(["1"] * 40000) + " FROM core_party"),
]

MUST_BLOCK: list[tuple[str, str]] = (
    DIRECT + LEXICAL + QUALIFIED + STRUCTURAL + STATEMENTS + FUNCTIONS + MISC
    + PG_ORACLE + PG_CATALOG + PG_FILESYSTEM + PG_ENVIRONMENT + PG_SYNTAX
    + PG_WITHHELD_COLUMN
)

# --------------------------------------------------------------------------
# Legitimate queries. Blocking these would break the teaching tool.
# --------------------------------------------------------------------------
MUST_ALLOW: list[tuple[str, str]] = [
    ("ok.simple", "SELECT * FROM core_party LIMIT 5"),
    ("ok.count", "SELECT count(*) AS n FROM core_party"),
    ("ok.upper_table", "SELECT COUNT(*) FROM CORE_PARTY"),
    ("ok.quoted_table", 'SELECT count(*) FROM "core_party"'),
    ("ok.schema_qualified", "SELECT count(*) FROM aivb.core_party"),
    ("ok.where", "SELECT * FROM core_party WHERE party_id IS NOT NULL LIMIT 3"),
    (
        "ok.join",
        "SELECT p.party_id, c.customer_id FROM core_party p "
        "JOIN core_customer c ON c.party_id = p.party_id LIMIT 5",
    ),
    (
        "ok.cte",
        "WITH t AS (SELECT party_id FROM core_party LIMIT 10) SELECT count(*) FROM t",
    ),
    (
        "ok.nested_cte",
        "WITH a AS (SELECT party_id FROM core_party), b AS (SELECT * FROM a LIMIT 5) "
        "SELECT count(*) FROM b",
    ),
    (
        "ok.union",
        "SELECT party_id FROM core_party UNION ALL SELECT party_id FROM core_party",
    ),
    (
        "ok.window",
        "SELECT party_id, row_number() OVER (ORDER BY party_id) AS rn FROM core_party LIMIT 5",
    ),
    (
        "ok.groupby",
        "SELECT party_type, count(*) AS n FROM core_party GROUP BY party_type "
        "HAVING count(*) > 0 ORDER BY n DESC",
    ),
    ("ok.case", "SELECT CASE WHEN 1=1 THEN 'a' ELSE 'b' END AS x"),
    ("ok.constant", "SELECT 1 AS one"),
    ("ok.date_fn", "SELECT current_date AS d, date_trunc('month', DATE '2024-01-15') AS m"),
    ("ok.string_fn", "SELECT upper('abc') AS u, length('abc') AS l"),
    # `range()` da bo: PostgreSQL khong co ham nay. Giu generate_series va
    # unnest voi cu phap PostgreSQL (ARRAY[...] chu khong phai [...]).
    ("ok.generate_series", "SELECT * FROM generate_series(1, 5)"),
    ("ok.generate_series_select", "SELECT generate_series(1, 5) AS v"),
    ("ok.unnest", "SELECT unnest(ARRAY[1, 2, 3]) AS v"),
    ("ok.unnest_from", "SELECT * FROM unnest(ARRAY[1, 2, 3]) AS v"),
    ("ok.values", "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name)"),
    ("ok.semicolon_in_string", "SELECT '; DROP TABLE core_party' AS s"),
    ("ok.instructor_name_as_string", "SELECT 'meta_dirty_log' AS s"),
    ("ok.subquery", "SELECT * FROM (SELECT party_id FROM core_party) x LIMIT 3"),
    ("ok.exists", "SELECT 1 WHERE EXISTS (SELECT 1 FROM core_party)"),
    ("ok.cast", "SELECT CAST(1 AS VARCHAR) AS v"),
    # `SELECT * EXCLUDE (...)` la cu phap rieng cua DuckDB, PostgreSQL khong co.
    # Thay bang cach viet chuan: liet ke cot.
    ("ok.explicit_columns", "SELECT party_id, party_type FROM core_party LIMIT 2"),
    ("ok.trailing_semicolon", "SELECT 1;"),
    ("ok.comment", "-- my query\nSELECT count(*) FROM core_party"),
    ("ok.big_limit", "SELECT * FROM core_party LIMIT 999999999"),
    ("ok.no_limit", "SELECT * FROM core_party"),
    (
        "ok.line_comment_swallows_everything",
        "SELECT 1 -- */ ; SELECT * FROM meta_dirty_log /*",
    ),
    (
        "ok.unicode_line_sep_in_comment",
        "SELECT 1 --\u2028 ; DROP TABLE core_party",
    ),
    # Da BO ba ca chi co o DuckDB, khong phai vi guard chan nham ma vi chung
    # khong phai SQL hop le cua PostgreSQL:
    #     SELECT {'a': 1}                      struct literal
    #     list_transform([1,2,3], x -> x*2)    lambda
    #     GROUP BY ALL
    # Thay bang cac cau tuong duong cua PostgreSQL:
    ("ok.array_literal", "SELECT ARRAY[1, 2, 3] AS a"),
    ("ok.json_build", "SELECT json_build_object('a', 1) AS j"),
    ("ok.group_by_ordinal", "SELECT party_type, count(*) FROM core_party GROUP BY 1"),
    ("ok.numeric_division",
     "SELECT count(*)::numeric / NULLIF(count(*), 0) AS r FROM core_party"),
    ("ok.string_agg", "SELECT string_agg(party_id, ',') AS s FROM core_party"),
    ("ok.tablesample", "SELECT * FROM core_party TABLESAMPLE SYSTEM (1)"),
    ("ok.fetch_first", "SELECT party_id FROM core_party FETCH FIRST 5 ROWS ONLY"),
    ("ok.regex_match", "SELECT * FROM core_party WHERE party_id ~ '^P' LIMIT 3"),
    ("ok.percentile",
     "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY 1) AS m FROM core_party"),
    ("ok.qualify", "SELECT party_id, row_number() OVER (ORDER BY party_id) rn FROM core_party QUALIFY rn <= 2"),
    # PostgreSQL doi bi danh KHAC NHAU khi mot bang xuat hien nhieu lan
    # (42712 DuplicateAlias); DuckDB cho phep trung. Them bi danh - day la SQL
    # chuan, khong phai giai phap tam.
    ("ok.cross_join_chain",
     "SELECT count(*) FROM ref_product a CROSS JOIN ref_product b "
     "CROSS JOIN ref_product c"),
]
