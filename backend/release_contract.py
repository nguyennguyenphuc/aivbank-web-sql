"""Machine-readable v5.1.6.4 release and visibility contract.

The owner JSON is normative for visibility, aliases, runtime gates and KPI
policy.  The release manifest supplies the independently published shape
totals.  Keeping this adapter small lets the API and its tests consume those
sources instead of copying version-specific numbers into Python.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT  # ten cu, giu lai cho ma da tham chieu

# Ba file hop dong ma ung dung CAN LUC CHAY. Ban goc nam trong package cua chu
# so huu (`AIV_Bank_full_standalone_v5.1.6.4/`) o goc kho; ban duoi day la ban
# sao dat trong `app/` de thu muc nay tu chua - chuyen sang may khac chi can
# mang theo `app/`.
#
# Dong bo lai sau khi chu so huu phat hanh package moi:
#     python app/database/sync_contract.py
CONTRACT_DIR = APP_ROOT / "backend" / "contract"
DEFAULT_PACKAGE_DIR = CONTRACT_DIR
DEFAULT_OWNER_CONFIG = CONTRACT_DIR / "owner-config.json"
DEFAULT_RELEASE_MANIFEST = CONTRACT_DIR / "release-manifest.json"


class ReleaseContractError(RuntimeError):
    pass


def _object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseContractError(f"cannot load release contract {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReleaseContractError(f"release contract {path} is not a JSON object")
    return value


@dataclass(frozen=True)
class ReleaseShape:
    version: str
    total_tables: int
    total_columns: int
    required_tables: int
    validation_count: int
    sql_validation_count: int
    config_audit_validation_count: int
    runtime_gate_count: int
    blocking_runtime_gate_count: int
    advisory_runtime_gate_count: int


def load_release_shape(path: Path = DEFAULT_RELEASE_MANIFEST) -> ReleaseShape:
    doc = _object(Path(path))
    summary = doc.get("content_summary")
    if not isinstance(summary, dict):
        raise ReleaseContractError(f"{path}: missing content_summary")
    try:
        shape = ReleaseShape(
            version=str(doc["package_version"]),
            total_tables=int(summary["physical_tables"]),
            total_columns=int(summary["column_contracts"]),
            required_tables=int(summary["required_tables"]),
            validation_count=int(summary["validation_contracts"]),
            sql_validation_count=int(summary["duckdb_sql_validations"]),
            config_audit_validation_count=int(summary["config_audit_validations"]),
            runtime_gate_count=int(summary["runtime_acceptance_gates"]),
            blocking_runtime_gate_count=int(summary["blocking_runtime_gates"]),
            advisory_runtime_gate_count=int(summary["advisory_runtime_gates"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ReleaseContractError(f"{path}: invalid content_summary: {exc}") from exc
    if shape.sql_validation_count + shape.config_audit_validation_count != shape.validation_count:
        raise ReleaseContractError(f"{path}: validation subtotal does not match total")
    if shape.blocking_runtime_gate_count + shape.advisory_runtime_gate_count != shape.runtime_gate_count:
        raise ReleaseContractError(f"{path}: runtime gate subtotal does not match total")
    return shape


def load_owner_config(path: Path = DEFAULT_OWNER_CONFIG) -> dict:
    return _object(Path(path))


def load_visibility_policy(path: Path = DEFAULT_OWNER_CONFIG) -> dict:
    policy = load_owner_config(path).get("student_delivery")
    if not isinstance(policy, dict):
        raise ReleaseContractError(f"{path}: missing student_delivery")
    tables = policy.get("instructor_only_tables")
    columns = policy.get("instructor_only_columns")
    aliases = policy.get("object_alias_resolution")
    if not isinstance(tables, list) or not isinstance(columns, list) or not isinstance(aliases, dict):
        raise ReleaseContractError(f"{path}: malformed student_delivery visibility policy")
    return {
        "instructor_only_tables": frozenset(str(v).lower() for v in tables),
        "instructor_only_columns": frozenset(
            (str(v["table"]).lower(), str(v["column"]).lower())
            for v in columns
            if isinstance(v, dict) and v.get("table") and v.get("column")
        ),
        "object_alias_resolution": {
            str(alias).lower(): str(canonical).lower()
            for alias, canonical in aliases.items()
        },
        "duckdb_file_delivery_allowed": policy.get("duckdb_file_delivery_allowed"),
    }


def load_runtime_gates(path: Path = DEFAULT_OWNER_CONFIG) -> list[dict]:
    gates = load_owner_config(path).get("runtime_acceptance")
    if not isinstance(gates, list) or not gates:
        raise ReleaseContractError(f"{path}: missing runtime_acceptance")
    return gates
