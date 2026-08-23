"""Pins the API/security adapter to the normative Full release artifacts."""

from backend.release_contract import load_release_shape, load_runtime_gates, load_visibility_policy


def test_full_release_shape_and_visibility_are_consistent():
    shape = load_release_shape()
    visibility = load_visibility_policy()
    assert shape.version == "5.1.6.4"
    assert (shape.total_tables, shape.total_columns) == (100, 611)
    assert len(visibility["instructor_only_tables"]) == 23
    assert 100 - len(visibility["instructor_only_tables"]) == 77
    assert visibility["instructor_only_columns"] == {
        ("raw_account_transaction", "dirty_flag")
    }
    assert visibility["duckdb_file_delivery_allowed"] is False


def test_runtime_gate_policy_has_one_advisory_roae_gate():
    shape = load_release_shape()
    gates = load_runtime_gates()
    assert len(gates) == shape.runtime_gate_count == 49
    blocking = [gate for gate in gates if gate["blocking_flag"]]
    advisory = [gate for gate in gates if not gate["blocking_flag"]]
    assert len(blocking) == shape.blocking_runtime_gate_count == 48
    assert [gate["gate_id"] for gate in advisory] == ["GATE.KPI.ROAE"]
    assert advisory[0]["fail_action"] == "WARN_ONLY_NO_EQUITY_PLUG"


def test_owner_aliases_only_resolve_to_instructor_objects():
    visibility = load_visibility_policy()
    for alias, canonical in visibility["object_alias_resolution"].items():
        assert alias != canonical
        assert canonical in visibility["instructor_only_tables"]
