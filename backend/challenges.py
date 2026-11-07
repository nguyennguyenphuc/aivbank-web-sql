"""Khu vuc "Luyen SQL": bai tap kieu HackerRank, cham tren may chu.

Ba phan, tach rieng de test duoc khong can PostgreSQL:

  * Catalogue  - doc backend/challenges/<domain>.json. Moi bai co DAP AN
                 (`reference_sql`, `expected_state_sql`) va BAN CONG KHAI.
                 Dap an KHONG BAO GIO roi khoi may chu: thu muc backend/ khong
                 duoc phuc vu qua HTTP, va `public()` la cua duy nhat ra ngoai.
  * compare()  - so hai bang ket qua: so cot, roi tap dong (hoac day dong khi
                 de yeu cau thu tu), co sai so cho so thuc. Phan hoi chi gom
                 CON SO (bao nhieu dong khop), khong bao gio la dong cua dap an.
  * ChallengeStore - tien do trong `aivb_app` (database/schema/20_challenges.sql).
                 Bang diem RIENG, khong dung vao sao / kim cuong cua console.

Bai `dml` (UPDATE / DELETE / INSERT) chay trong TRINH DUYET tren mot ban sao
nho cua bang (`sample_sql`). May chu khong bao gio chay DML: dap an la mot
SELECT (`expected_state_sql`) dien ta trang thai bang SAU khi sua dung, chay
tren CTE `sample`, va duoc so voi trang thai trinh duyet nop len.
"""
from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import json
import math
import os
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

LEVELS = ("easy", "medium", "difficult", "advanced")
LEVEL_POINTS = {"easy": 5, "medium": 10, "difficult": 20, "advanced": 30}

#: Nhung truong KHONG BAO GIO ra khoi may chu.
HIDDEN_FIELDS = frozenset({"reference_sql", "expected_state_sql", "takeaway"})

#: Gioi han trang thai bang ma trinh duyet duoc nop cho bai dml.
MAX_STATE_ROWS = 2000
MAX_STATE_COLS = 40

#: So dong toi da so sanh. Dap an cua moi bai deu nho hon nhieu.
MAX_COMPARE_ROWS = 5000


class CatalogueError(RuntimeError):
    """File de bai hong: thieu truong, trung id, muc do la."""


@dataclass(frozen=True)
class Challenge:
    id: str
    domain: str
    dataset: str
    level: str
    points: int
    title: str
    topic: str
    kind: str  # 'select' | 'dml'
    statement: str
    output: str
    lesson: dict
    hints: tuple
    tables: tuple
    order_matters: bool
    float_tol: float
    reference_sql: str = ""
    sample_sql: str = ""
    sample_table: str = ""
    expected_state_sql: str = ""
    takeaway: str = ""

    def public(self, *, solved: bool = False) -> dict[str, Any]:
        """Ban gui cho trinh duyet. `takeaway` chi co khi da giai."""
        out = {
            "id": self.id,
            "domain": self.domain,
            "level": self.level,
            "points": self.points,
            "title": self.title,
            "topic": self.topic,
            "kind": self.kind,
            "statement": self.statement,
            "output": self.output,
            "lesson": self.lesson,
            "hints": list(self.hints),
            "tables": list(self.tables),
            "order_matters": self.order_matters,
            "sample_table": self.sample_table or None,
            "solved": solved,
        }
        if solved and self.takeaway:
            out["takeaway"] = self.takeaway
        return out


@dataclass
class Catalogue:
    domains: dict[str, dict] = field(default_factory=dict)  # domain -> {label, dataset}
    by_id: dict[str, Challenge] = field(default_factory=dict)

    def list(self, domain: str | None = None) -> list[Challenge]:
        items = [c for c in self.by_id.values() if domain is None or c.domain == domain]
        return sorted(items, key=lambda c: (LEVELS.index(c.level), c.id))

    def get(self, challenge_id: str) -> Challenge | None:
        return self.by_id.get(challenge_id)


def default_dir() -> Path:
    return Path(os.environ.get("AIVB_CHALLENGES_DIR") or Path(__file__).resolve().parent / "challenges")


def load_catalogue(directory: Path | None = None, *, datasets: Iterable[str] | None = None) -> Catalogue:
    """Doc moi `<domain>.json` trong thu muc. Hong la nem loi, khong bo qua:
    mot bai thieu dap an ma van hien ra thi hoc vien nop mai khong bao gio dung."""
    directory = directory or default_dir()
    cat = Catalogue()
    if not directory.is_dir():
        return cat
    known = set(datasets) if datasets is not None else None
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        domain = str(data.get("domain") or path.stem)
        dataset = str(data.get("dataset") or domain)
        if known is not None and dataset not in known:
            raise CatalogueError(f"{path.name}: dataset {dataset!r} khong co trong AIVB_DATASETS")
        cat.domains[domain] = {"domain": domain, "label": data.get("label", domain), "dataset": dataset}
        for raw in data.get("challenges", []):
            ch = _parse(raw, domain, dataset, path.name)
            if ch.id in cat.by_id:
                raise CatalogueError(f"{path.name}: trung id {ch.id!r}")
            cat.by_id[ch.id] = ch
    return cat


def _parse(raw: dict, domain: str, dataset: str, source: str) -> Challenge:
    def need(key: str) -> Any:
        if not raw.get(key):
            raise CatalogueError(f"{source}: bai {raw.get('id', '?')!r} thieu {key!r}")
        return raw[key]

    level = need("level")
    if level not in LEVELS:
        raise CatalogueError(f"{source}: muc do {level!r} khong hop le")
    kind = raw.get("kind", "select")
    if kind not in ("select", "dml"):
        raise CatalogueError(f"{source}: kind {kind!r} khong hop le")
    if kind == "select":
        need("reference_sql")
    else:
        need("sample_sql")
        need("sample_table")
        need("expected_state_sql")
    return Challenge(
        id=need("id"),
        domain=domain,
        dataset=dataset,
        level=level,
        points=int(raw.get("points") or LEVEL_POINTS[level]),
        title=need("title"),
        topic=raw.get("topic", ""),
        kind=kind,
        statement=need("statement"),
        output=raw.get("output", ""),
        lesson=raw.get("lesson") or {},
        hints=tuple(raw.get("hints") or ()),
        tables=tuple(need("tables")),
        order_matters=bool(raw.get("order_matters", False)),
        float_tol=float(raw.get("float_tol", 0.006)),
        reference_sql=raw.get("reference_sql", ""),
        sample_sql=raw.get("sample_sql", ""),
        sample_table=raw.get("sample_table", ""),
        expected_state_sql=raw.get("expected_state_sql", ""),
        takeaway=raw.get("takeaway", ""),
    )


def expected_state_query(ch: Challenge) -> str:
    """Dap an cua bai dml: trang thai dung, tinh tren CTE `sample`."""
    return f"WITH sample AS ({ch.sample_sql}) {ch.expected_state_sql}"


# ---------------------------------------------------------------- so sanh --


def _norm(v: Any) -> Any:
    """Mot gia tri ve dang so sanh duoc giua PostgreSQL, JSON va DuckDB."""
    if v is None:
        return None
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float, decimal.Decimal)):
        f = float(v)
        return None if math.isnan(f) else f
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat().replace("T", " ")
    if isinstance(v, dict) and "__exactDigits" in v:  # BIGINT tu trinh duyet
        return float(v["__exactDigits"])
    s = unicodedata.normalize("NFC", str(v)).strip()
    # Chuoi so (Decimal sau _jsonable, hoac so trong o text) so nhu so.
    try:
        if s and s.lstrip("-").replace(".", "", 1).isdigit():
            return float(s)
    except ValueError:
        pass
    if s.lower() in ("true", "false"):
        return 1.0 if s.lower() == "true" else 0.0
    return s


def _same(a: Any, b: Any, tol: float) -> bool:
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= max(tol, 1e-9 * max(abs(a), abs(b)))
    return a == b


def _row_same(r1: tuple, r2: tuple, tol: float) -> bool:
    return len(r1) == len(r2) and all(_same(x, y, tol) for x, y in zip(r1, r2))


def compare(
    your_cols: list,
    your_rows: list,
    exp_cols: list,
    exp_rows: list,
    *,
    order_matters: bool = False,
    tol: float = 0.006,
) -> dict[str, Any]:
    """Ket qua cham. KHONG chua dong nao cua dap an - chi con so."""
    yours = [tuple(_norm(v) for v in row) for row in your_rows[:MAX_COMPARE_ROWS]]
    want = [tuple(_norm(v) for v in row) for row in exp_rows[:MAX_COMPARE_ROWS]]
    out = {
        "your_cols": len(your_cols),
        "expected_cols": len(exp_cols),
        "your_rows": len(your_rows),
        "expected_rows": len(exp_rows),
        "matched_rows": 0,
        "passed": False,
        "reason": "",
    }
    if len(your_cols) != len(exp_cols):
        out["reason"] = "columns"
        return out
    if order_matters:
        matched = sum(1 for a, b in zip(yours, want) if _row_same(a, b, tol))
    else:
        # Ghep tham lam co sai so. Bang dap an nho (vai chuc dong), nen O(n*m)
        # la du; sap theo khoa tho truoc de dong giong nhau thuong ghep ngay.
        key = lambda r: tuple((0, round(x, 2)) if isinstance(x, float) else (1, str(x)) for x in r)
        pool = sorted(yours, key=key)
        used = [False] * len(pool)
        matched = 0
        for row in sorted(want, key=key):
            for i, cand in enumerate(pool):
                if not used[i] and _row_same(cand, row, tol):
                    used[i] = True
                    matched += 1
                    break
    out["matched_rows"] = matched
    out["passed"] = matched == len(want) == len(yours)
    if not out["passed"]:
        out["reason"] = "order" if order_matters and sorted(map(str, yours)) == sorted(map(str, want)) else "rows"
    return out


def sql_hash(sql: str) -> str:
    return hashlib.sha256(" ".join(sql.lower().split()).encode("utf-8")).hexdigest()


# ------------------------------------------------------------- tien do ----


class ChallengeStore:
    """Tien do trong `aivb_app`. Dung CHUNG pool voi kho diem: `aivb_app_rw`
    co CONNECTION LIMIT, va mot pool thu hai la mot nguon can ket noi nua."""

    def __init__(self, pool) -> None:
        self._pool = pool

    def solved(self, username: str) -> dict[str, dict]:
        with self._pool.connection() as con:
            rows = con.execute(
                "SELECT challenge_id, points, attempts, solved_at FROM app.challenge_solved WHERE username = %s",
                (username,),
            ).fetchall()
        return {r[0]: {"points": r[1], "attempts": r[2], "solved_at": r[3]} for r in rows}

    def record(self, username: str, ch: Challenge, passed: bool, hashed: str) -> dict[str, Any]:
        """Ghi mot lan nop. Diem chi cong o lan dung DAU TIEN."""
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        with self._pool.connection() as con, con.transaction():
            con.execute(
                "INSERT INTO app.challenge_attempts (username, challenge_id, submitted_at, passed, sql_hash) "
                "VALUES (%s, %s, %s, %s, %s)",
                (username, ch.id, now, passed, hashed),
            )
            already = con.execute(
                "SELECT 1 FROM app.challenge_solved WHERE username = %s AND challenge_id = %s",
                (username, ch.id),
            ).fetchone()
            awarded = 0
            if passed and not already:
                attempts = con.execute(
                    "SELECT count(*) FROM app.challenge_attempts WHERE username = %s AND challenge_id = %s",
                    (username, ch.id),
                ).fetchone()[0]
                # ON CONFLICT: hai lan nop dung cung luc chi duoc cong mot lan.
                cur = con.execute(
                    "INSERT INTO app.challenge_solved (username, challenge_id, domain, points, attempts, solved_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                    (username, ch.id, ch.domain, ch.points, attempts, now),
                )
                awarded = ch.points if cur.rowcount else 0
            total = con.execute(
                "SELECT COALESCE(SUM(points), 0), count(*) FROM app.challenge_solved WHERE username = %s AND domain = %s",
                (username, ch.domain),
            ).fetchone()
        return {
            "points_awarded": awarded,
            "already_solved": bool(already),
            "domain_points": int(total[0]),
            "domain_solved": int(total[1]),
        }

    def leaderboard(self, domain: str, only, limit: int = 20) -> list[dict[str, Any]]:
        """Cung luat voi /gamification/leaderboard: CHI nhung ten trong `only`."""
        keep = tuple(only or ())
        if not keep:
            return []
        holes = ",".join(["%s"] * len(keep))
        with self._pool.connection() as con:
            rows = con.execute(
                "SELECT username, SUM(points), count(*), MAX(solved_at) FROM app.challenge_solved "
                f"WHERE domain = %s AND username IN ({holes}) "
                "GROUP BY username ORDER BY SUM(points) DESC, count(*) DESC, MAX(solved_at) ASC, username "
                "LIMIT %s",
                (domain, *keep, max(1, min(int(limit), 100))),
            ).fetchall()
        return [
            {"rank": i, "username": r[0], "points": int(r[1]), "solved": int(r[2])}
            for i, r in enumerate(rows, start=1)
        ]
