"""So do ERD: canh FK cua console va so do database game.

Khong can PostgreSQL. Catalog duoc dung tu mot hop dong cot tu che, dung hinh
dang that cua AIV Bank: mot bang dap an (`meta_dirty_log`) co FK tro VAO mot
bang hoc vien, va mot bang MIXED (`raw_account_transaction`) co cot bi giu lai
(`dirty_flag`) mang FK. Ca hai canh do deu khong duoc ra ngoai.
"""
from __future__ import annotations

import json

import pytest

from backend import game_schema
from backend.catalog import Catalog, ColumnInfo, ForeignKeyInfo, TableInfo


def _col(name: str, pk: bool = False) -> ColumnInfo:
    return ColumnInfo(name=name, duckdb_type="BIGINT", nullable=not pk, is_primary_key=pk)


def _contract(tmp_path, spec: dict[str, dict[str, str]]):
    columns = [
        {"table_name": t, "column_name": c, "student_visibility": vis}
        for t, cols in spec.items()
        for c, vis in cols.items()
    ]
    path = tmp_path / "contract.json"
    path.write_text(
        json.dumps({"tables": {t: {} for t in spec}, "columns": columns}), encoding="utf-8"
    )
    return path


@pytest.fixture
def physical():
    fk = ForeignKeyInfo
    return {
        "core_party": TableInfo(
            "core_party",
            (_col("party_id", True), _col("segment_id")),
            foreign_keys=(fk(("segment_id",), "ref_segment", ("segment_id",)),),
        ),
        "ref_segment": TableInfo("ref_segment", (_col("segment_id", True),)),
        "core_account": TableInfo(
            "core_account",
            (_col("account_id", True), _col("party_id")),
            foreign_keys=(fk(("party_id",), "core_party", ("party_id",)),),
        ),
        "raw_account_transaction": TableInfo(
            "raw_account_transaction",
            (_col("txn_id", True), _col("account_id"), _col("dirty_flag")),
            foreign_keys=(
                fk(("account_id",), "core_account", ("account_id",)),
                # FK tren cot bi giu lai: lo ten `dirty_flag` neu ra ngoai.
                fk(("dirty_flag",), "ref_segment", ("segment_id",)),
            ),
        ),
        "meta_dirty_log": TableInfo(
            "meta_dirty_log",
            (_col("log_id", True), _col("txn_id")),
            foreign_keys=(fk(("txn_id",), "raw_account_transaction", ("txn_id",)),),
        ),
    }


@pytest.fixture
def contract(tmp_path):
    return _contract(
        tmp_path,
        {
            "core_party": {"party_id": "STUDENT", "segment_id": "STUDENT"},
            "ref_segment": {"segment_id": "STUDENT"},
            "core_account": {"account_id": "STUDENT", "party_id": "STUDENT"},
            "raw_account_transaction": {
                "txn_id": "STUDENT",
                "account_id": "STUDENT",
                "dirty_flag": "INSTRUCTOR",
            },
            "meta_dirty_log": {"log_id": "INSTRUCTOR", "txn_id": "INSTRUCTOR"},
        },
    )


def _edges(catalog: Catalog) -> set[tuple]:
    return {
        (src, fk.columns, fk.ref_table, fk.ref_columns) for src, fk in catalog.relationships()
    }


def test_student_sees_only_edges_between_visible_tables(contract, physical):
    cat = Catalog(contract, physical, database_name="aivb_student")
    assert _edges(cat) == {
        ("core_account", ("party_id",), "core_party", ("party_id",)),
        ("core_party", ("segment_id",), "ref_segment", ("segment_id",)),
        ("raw_account_transaction", ("account_id",), "core_account", ("account_id",)),
    }


def test_no_edge_names_a_withheld_table_or_column(contract, physical):
    cat = Catalog(contract, physical, database_name="aivb_student")
    text = json.dumps(sorted(map(list, _edges(cat))), default=list)
    assert "meta_dirty_log" not in text
    assert "dirty_flag" not in text


def test_revoke_also_removes_the_edges(contract, physical):
    cat = Catalog(contract, physical, database_name="aivb_student")
    cat.revoke({"core_party"})
    assert all("core_party" not in (src, dst) for src, _c, dst, _r in _edges(cat))


def test_instructor_catalog_sees_every_edge(contract, physical):
    cat = Catalog(contract, physical, database_name="aivb_instructor", expose_restricted=True)
    assert len(_edges(cat)) == 5


# ----------------------------------------------------------------- database game
def _gt(name, cols, kind="table"):
    return game_schema.GameTable(
        name=name,
        kind=kind,
        columns=tuple(
            game_schema.GameColumn(name=c.rstrip("*"), type="VARCHAR", nullable=False,
                                   primary_key=c.endswith("*"))
            for c in cols
        ),
    )


GAME_TABLES = (
    _gt("users", ["user_id*", "install_date"]),
    _gt("sessions", ["session_id*", "user_id"]),
    _gt("level_metadata", ["level_id*", "episode"]),
    _gt("level_attempts", ["attempt_id*", "user_id", "session_id", "level_id"]),
    _gt("booster_events", ["booster_event_id*", "attempt_id", "user_id"]),
    # Khoa ghep: khong lam dich duoc.
    _gt("ab_assignments", ["user_id*", "experiment_id*"]),
    _gt("live_player_wallets", ["user_id", "soft_currency"], kind="view"),
)


def test_game_infers_edges_from_single_column_primary_keys():
    edges = {
        (e.from_table, e.from_columns[0], e.to_table)
        for e in game_schema.build_edges(GAME_TABLES, {})
    }
    assert ("sessions", "user_id", "users") in edges
    assert ("level_attempts", "level_id", "level_metadata") in edges
    assert ("booster_events", "attempt_id", "level_attempts") in edges
    assert ("ab_assignments", "user_id", "users") in edges
    assert ("live_player_wallets", "user_id", "users") in edges
    # Khong co canh tu mot bang toi chinh no, va khong co dich la khoa ghep.
    assert all(src != dst for src, _c, dst in edges)
    assert not any(dst == "ab_assignments" for _s, _c, dst in edges)
    assert all(e.inferred for e in game_schema.build_edges(GAME_TABLES, {}))


def test_game_declared_foreign_keys_switch_inference_off():
    declared = {
        "sessions": (ForeignKeyInfo(("user_id",), "users", ("user_id",)),),
        # Dau kia khong co tren so do -> bi bo, khong lo ten.
        "users": (ForeignKeyInfo(("install_date",), "secret_table", ("x",)),),
    }
    edges = game_schema.build_edges(GAME_TABLES, declared)
    assert [(e.from_table, e.to_table, e.inferred) for e in edges] == [
        ("sessions", "users", False)
    ]


def test_game_disabled_is_unavailable(monkeypatch):
    game_schema.reset_cache()

    class _S:
        game_enabled = False

    with pytest.raises(game_schema.GameSchemaUnavailable):
        game_schema.load_game_schema(_S())
