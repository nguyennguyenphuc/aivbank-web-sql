"""Luyen SQL: ngan hang bai, ban cong khai va ham cham. Khong can PostgreSQL.

Dieu quan trong nhat duoc test o day: DAP AN KHONG BAO GIO ra khoi may chu.
`public()` la cua duy nhat, va noi dung no tra ve khong duoc chua cau SQL dap
an hay trang thai dung cua bai dml - kiem bang cach quet chuoi, khong bang cach
tin danh sach truong.
"""
from __future__ import annotations

import decimal
import json

import pytest

from backend import challenges as ch


@pytest.fixture(scope="module")
def catalogue():
    return ch.load_catalogue()


def test_catalogue_loads_and_covers_every_level(catalogue):
    scm = catalogue.list("scm")
    assert len(scm) >= 17
    assert {c.level for c in scm} == set(ch.LEVELS)
    assert any(c.kind == "dml" for c in scm), "Easy phai co bai UPDATE/DELETE"
    for c in scm:
        assert c.dataset == "scm"
        assert c.points == ch.LEVEL_POINTS[c.level]
        assert c.lesson.get("concept") and c.lesson.get("why"), f"{c.id}: thieu phan nghiep vu"


def test_public_view_never_carries_the_answer(catalogue):
    for c in catalogue.list():
        for solved in (False, True):
            text = json.dumps(c.public(solved=solved), ensure_ascii=False)
            for secret in (c.reference_sql, c.expected_state_sql):
                if secret:
                    assert secret not in text, f"{c.id}: dap an lot ra ngoai"
            assert "reference_sql" not in text and "expected_state_sql" not in text
        assert "takeaway" not in c.public(solved=False)


def test_unknown_dataset_is_rejected(tmp_path):
    (tmp_path / "x.json").write_text(
        json.dumps({"domain": "x", "dataset": "nope", "challenges": []}), encoding="utf-8"
    )
    with pytest.raises(ch.CatalogueError):
        ch.load_catalogue(tmp_path, datasets=["aivb", "scm"])


def test_challenge_without_answer_is_rejected(tmp_path):
    bad = {"id": "b1", "level": "easy", "title": "t", "statement": "s", "tables": ["t"]}
    (tmp_path / "x.json").write_text(json.dumps({"domain": "x", "challenges": [bad]}), encoding="utf-8")
    with pytest.raises(ch.CatalogueError):
        ch.load_catalogue(tmp_path)


def test_compare_unordered_with_float_and_decimal():
    exp = [["A", decimal.Decimal("10.25")], ["B", decimal.Decimal("3.10")]]
    yours = [["B", 3.1], ["A", 10.2549]]
    v = ch.compare(["x", "y"], yours, ["x", "y"], exp)
    assert v["passed"] and v["matched_rows"] == 2


def test_compare_order_matters():
    exp = [["A", 1], ["B", 2]]
    v = ch.compare(["x", "y"], [["B", 2], ["A", 1]], ["x", "y"], exp, order_matters=True)
    assert not v["passed"] and v["reason"] == "order"


def test_compare_counts_duplicates_and_extra_rows():
    exp = [["A"], ["A"], ["B"]]
    assert not ch.compare(["x"], [["A"], ["B"]], ["x"], exp)["passed"]
    v = ch.compare(["x"], [["A"], ["A"], ["B"], ["C"]], ["x"], exp)
    assert not v["passed"] and v["matched_rows"] == 3 and v["reason"] == "rows"


def test_compare_wrong_column_count_and_nulls():
    assert ch.compare(["x"], [[1]], ["x", "y"], [[1, 2]])["reason"] == "columns"
    assert ch.compare(["x", "y"], [[None, "a"]], ["x", "y"], [[None, "a"]])["passed"]


def test_compare_normalises_unicode_and_browser_bigint():
    # 'Đạt' gõ bang to hop dau (NFD) van phai khop 'Đạt' dung san (NFC).
    import unicodedata

    nfd = unicodedata.normalize("NFD", "Đạt")
    v = ch.compare(["x", "n"], [[nfd, {"__exactDigits": "42"}]], ["x", "n"], [["Đạt", 42]])
    assert v["passed"]


def test_feedback_never_contains_expected_rows():
    exp = [["SECRET_VALUE", 1]]
    v = ch.compare(["x", "y"], [["mine", 2]], ["x", "y"], exp)
    assert "SECRET_VALUE" not in json.dumps(v)


def test_expected_state_query_wraps_sample(catalogue):
    dml = [c for c in catalogue.list() if c.kind == "dml"]
    for c in dml:
        q = ch.expected_state_query(c)
        assert q.startswith("WITH sample AS (") and c.sample_sql in q
