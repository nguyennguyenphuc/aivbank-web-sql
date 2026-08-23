"""HTTP-level tests against the real FastAPI app + real DuckDB file."""

from __future__ import annotations

import time

import pytest

from .attacks import INSTRUCTOR_TABLES, MUST_ALLOW, MUST_BLOCK


def _post(client, sql, **kw):
    body = {"sql": sql}
    body.update(kw)
    return client.post("/query", json=body)


# ---------------------------------------------------------------- happy path
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["status"] == "healthy"
    assert body["table_count"] > 0


def test_valid_query_returns_data(client):
    r = _post(client, "SELECT party_id FROM core_party ORDER BY party_id LIMIT 5")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["columns"] == ["party_id"]
    assert body["row_count"] == 5
    assert len(body["rows"]) == 5
    assert body["tables_used"] == ["core_party"]
    assert body["elapsed_ms"] >= 0


@pytest.mark.parametrize("case_id,sql", MUST_ALLOW, ids=[c[0] for c in MUST_ALLOW])
def test_legit_queries_execute(case_id, sql, client):
    r = _post(client, sql)
    assert r.status_code == 200, f"{case_id}: {r.text}"
    assert r.json()["ok"] is True


# ------------------------------------------------------------------- attacks
@pytest.mark.parametrize("case_id,sql", MUST_BLOCK, ids=[c[0] for c in MUST_BLOCK])
def test_attacks_are_blocked(case_id, sql, client):
    r = _post(client, sql)
    assert r.status_code != 200, f"{case_id}: query was ALLOWED -> {r.text[:400]}"
    body = r.json()
    assert body.get("ok") is False
    assert body.get("error_code")

    blob = r.text.lower()
    # Never return actual answer-key content.
    assert "churn_risk" not in blob, f"{case_id}: leaked meta_scenario_label content"
    assert "null_inject" not in blob, f"{case_id}: leaked meta_dirty_log content"
    # Never confirm an instructor table the student did not already name.
    for name in INSTRUCTOR_TABLES:
        if name in sql.lower():
            continue
        assert name not in blob, f"{case_id}: response leaked table name {name}"


def test_no_response_ever_contains_answer_key_rows(client):
    for name in INSTRUCTOR_TABLES:
        for sql in (
            f"SELECT * FROM {name}",
            f'SELECT * FROM "{name}"',
            f"SELECT * FROM main.{name}",
            f"WITH q AS (SELECT * FROM {name}) SELECT * FROM q",
        ):
            r = _post(client, sql)
            assert r.status_code == 400, f"{sql} -> {r.status_code}"
            assert r.json()["error_code"] in {
                "E_UNKNOWN_TABLE",
                "E_RESERVED_CTE_NAME",
            }


def test_error_message_is_identical_for_typo_and_restricted(client):
    a = _post(client, "SELECT * FROM meta_dirty_log").json()
    b = _post(client, "SELECT * FROM no_such_table_xyz").json()
    assert a["error_code"] == b["error_code"] == "E_UNKNOWN_TABLE"
    # Same template, only the echoed identifier differs.
    assert a["message"].replace("meta_dirty_log", "X") == b["message"].replace(
        "no_such_table_xyz", "X"
    )


# --------------------------------------------------------------- schema APIs
def test_schema_tables_excludes_instructor(client):
    r = client.get("/schema/tables")
    assert r.status_code == 200
    body = r.json()
    names = {t["name"] for t in body["tables"]}
    assert body["table_count"] == len(names)
    for bad in INSTRUCTOR_TABLES:
        assert bad not in names
    assert "core_party" in names
    assert bad not in r.text


def test_full_schema_excludes_instructor(client):
    r = client.get("/schema")
    assert r.status_code == 200
    blob = r.text.lower()
    for bad in INSTRUCTOR_TABLES:
        assert bad not in blob
    assert "core_party" in blob


def test_table_detail_ok(client):
    r = client.get("/schema/tables/core_party")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "core_party"
    assert len(body["columns"]) > 0


def test_table_detail_row_count(client):
    r = client.get("/schema/tables/core_party", params={"include_row_count": True})
    assert r.status_code == 200
    assert r.json()["row_count"] > 0

def test_mart_catalog_is_role_visible_and_descriptive(client):
    r = client.get("/schema/marts")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mart_count"] == len(body["marts"])
    assert all(item["name"].startswith("mart_") for item in body["marts"])
    for item in body["marts"]:
        assert set(item) == {"name", "column_count", "row_count"}
        assert item["row_count"] is None
        detail = client.get(
            "/schema/marts/" + item["name"], params={"include_row_count": True}
        )
        assert detail.status_code == 200
        assert detail.json()["name"] == item["name"]
        assert detail.json()["columns"]
        assert detail.json()["row_count"] is not None
    for forbidden in INSTRUCTOR_TABLES:
        assert forbidden not in r.text

def test_mart_endpoint_does_not_alias_non_mart_tables(client):
    r = client.get("/schema/marts/core_party")
    assert r.status_code == 404
    assert r.json()["error_code"] == "E_UNKNOWN_TABLE"


@pytest.mark.parametrize("name", INSTRUCTOR_TABLES + ["no_such_table_xyz"])
def test_table_detail_hides_instructor(name, client):
    r = client.get(f"/schema/tables/{name}")
    assert r.status_code == 404
    assert r.json()["error_code"] == "E_UNKNOWN_TABLE"


def test_table_detail_404_message_identical(client):
    a = client.get("/schema/tables/meta_dirty_log").json()["message"]
    b = client.get("/schema/tables/no_such_table_xyz").json()["message"]
    assert a.replace("meta_dirty_log", "X") == b.replace("no_such_table_xyz", "X")


def test_openapi_does_not_leak(client):
    blob = client.get("/openapi.json").text.lower()
    for bad in INSTRUCTOR_TABLES:
        assert bad not in blob


# ------------------------------------------------------------ resource caps
def test_row_cap_enforced(client):
    r = _post(client, "SELECT * FROM core_party")
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] <= body["row_limit"]
    assert body["truncated"] is True


def test_client_max_rows_is_clamped(client):
    r = _post(client, "SELECT * FROM core_party", max_rows=10_000_000)
    assert r.status_code == 200
    assert r.json()["row_count"] <= r.json()["row_limit"]


def test_heavy_query_times_out_without_hanging(client):
    sql = (
        "SELECT count(*) FROM core_party a, core_party b, core_party c, "
        "core_party d, core_party e"
    )
    started = time.perf_counter()
    r = _post(client, sql)
    elapsed = time.perf_counter() - started
    assert r.status_code == 408, r.text
    assert r.json()["error_code"] == "E_TIMEOUT"
    assert elapsed < 30, f"timeout did not fire promptly: {elapsed:.1f}s"


def test_server_still_works_after_timeout(client):
    r = _post(client, "SELECT count(*) AS n FROM core_party")
    assert r.status_code == 200
    assert r.json()["rows"][0][0] > 0


def test_recursive_cte_bomb_times_out(client):
    sql = (
        "WITH RECURSIVE bomb(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bomb) "
        "SELECT count(*) FROM bomb"
    )
    r = _post(client, sql)
    assert r.status_code in (400, 408), r.text


# ------------------------------------------------------- write-protection
#
# Ba phep kiem nay do LOP DUOI cua tang guard: chung chay lenh THANG qua ket noi
# ma API dung, khong qua `validate()`. Y nghia khong doi khi chuyen engine, chi
# doi cach thuc hien: DuckDB chan bang `read_only=True` va `lock_configuration`,
# PostgreSQL chan bang vai tro chi co GRANT SELECT.
def _direct(db, sql):
    """Chay SQL thang qua pool cua Database, bo qua guard."""
    with db._pool.connection() as con:  # noqa: SLF001
        return con.execute(sql).fetchone()


def test_database_is_read_only(hostile_db):
    import psycopg

    with pytest.raises(psycopg.Error) as exc:
        _direct(hostile_db, "CREATE TABLE should_fail (a INT)")
    # Co the bi chan boi read-only transaction (25006) HOAC boi GRANT (42501).
    # Ca hai deu dat, nhung chi 42501 la bien phap that - xem
    # test_only_grants_actually_enforce_read_only ben duoi.
    assert exc.value.sqlstate in ("25006", "42501")


def test_only_grants_actually_enforce_read_only(hostile_db):
    """`default_transaction_read_only` KHONG phai bien phap bao mat.

    Bat ky client nao cung tat duoc no. Thu THUC SU chan ghi la vai tro chi co
    GRANT SELECT. Test nay chung minh ca hai ve, de khong ai viet nham trong
    tai lieu rang tham so kia bao dam chi-doc.
    """
    import psycopg

    with hostile_db._pool.connection() as con:  # noqa: SLF001
        con.execute("SET default_transaction_read_only = off")
        try:
            with pytest.raises(psycopg.Error) as exc:
                con.execute("CREATE TABLE should_fail_2 (a INT)")
            assert exc.value.sqlstate == "42501", (
                "sau khi tat read_only, phai bi chan boi GRANT chu khong phai "
                f"boi tham so; thuc te {exc.value.sqlstate}"
            )
        finally:
            con.execute("SET default_transaction_read_only = on")


def test_external_access_is_disabled(hostile_db):
    """Doc he thong tap tin: `read_csv` cua DuckDB -> `pg_read_file` cua PostgreSQL."""
    import psycopg

    with pytest.raises(psycopg.Error) as exc:
        _direct(hostile_db, "SELECT pg_read_file('postgresql.conf')")
    assert exc.value.sqlstate == "42501"


def test_privileged_settings_cannot_be_changed(hostile_db):
    """DuckDB khoa cau hinh bang `lock_configuration`; PostgreSQL bang hang SUSET.

    `lc_messages` la tham so quan trong nhat trong so nay: tang guard tai lap
    NGUYEN VAN thong bao loi cua PostgreSQL de mot cot bi giau khong phan biet
    duoc voi mot cot go sai, nen doi ngon ngu thong bao la pha tinh chat do.
    """
    import psycopg

    with pytest.raises(psycopg.Error) as exc:
        _direct(hostile_db, "SELECT set_config('lc_messages', 'vi_VN', false)")
    assert exc.value.sqlstate == "42501"
    # Va gia tri that van dung.
    assert _direct(hostile_db, "SHOW lc_messages")[0] == "C"


# ----------------------------------------------- production-shape database
def test_student_shaped_db_exposes_only_student_tables(student_db):
    assert student_db.catalog.hidden_count == 0
    for bad in INSTRUCTOR_TABLES:
        assert bad not in student_db.catalog.physical_tables
        assert not student_db.catalog.is_allowed(bad)
