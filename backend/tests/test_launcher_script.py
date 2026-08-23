"""Regression tests for scripts/aivb.ps1, the manual launcher.

Static tests, deliberately: driving PowerShell from pytest would need a real
Windows host, a free port 8000 and ~40s per case, so it would be skipped
everywhere and would therefore guard nothing. What follows pins the two
defects the launcher actually shipped with, both of which were invisible from
inside the script's own output.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "aivb.ps1"


@pytest.fixture(scope="module")
def source() -> str:
    return SCRIPT.read_text(encoding="utf-8-sig")


def _body(source: str, func: str) -> str:
    """Text of one PowerShell function, up to the next top-level closing brace."""
    start = source.index(f"function {func}")
    end = source.index("\n}\n", start)
    return source[start:end]


def _code(source: str, func: str) -> str:
    """Same, minus comment lines.

    These tests are about what the script DOES. Matching bare words against the
    whole text also matches the prose explaining why the old way was wrong -- a
    comment that names the mistake would fail the very test that guards against
    it, which teaches the next person to delete the explanation.
    """
    return chr(10).join(
        line
        for line in _body(source, func).splitlines()
        if not line.lstrip().startswith("#")
    )


def test_script_exists_and_is_bom_utf8():
    # Windows PowerShell 5.1 reads a BOM-less file as ANSI: the Vietnamese in
    # this script then arrives as mojibake and the parse fails on a string that
    # looks fine in every editor.
    assert SCRIPT.is_file(), SCRIPT
    assert SCRIPT.read_bytes().startswith(b"\xef\xbb\xbf")


# --- DEFECT 1 ------------------------------------------------------------
# `down` called Stop-Process on the saved pid only. But the API runs three
# processes deep -- powershell.exe wrapper -> .venv launcher -> the real
# interpreter -- so killing the pid we saved left uvicorn alive, still holding
# port 8000. `down` printed "da dung" and was wrong.
def test_down_kills_the_whole_process_tree(source):
    down = _body(source, "Invoke-Down")
    assert "/T" in down, "phai giet ca cay tien trinh, khong chi pid da luu"
    assert "Stop-Process" not in down, (
        "Stop-Process chi giet mot tien trinh; dung taskkill /T"
    )


# --- DEFECT 2 ------------------------------------------------------------
# Worse than defect 1, and caused by it: an orphan from a previous run kept
# port 8000. The new API died on bind, but `up` asked only "is anything
# listening?" -- something was -- so it printed "xong" and `status` reported
# "dang chay". The stale build kept serving, with no error anywhere.
def test_up_and_status_check_ownership_not_mere_listening(source):
    up = _body(source, "Invoke-Up")
    status = _body(source, "Invoke-Status")

    # Bare Test-Listening is still right for PostgreSQL, which we do not own.
    for name, body in (("Invoke-Up", up), ("Invoke-Status", status)):
        for port in ("8000", "15433"):
            assert f"Test-Listening '127.0.0.1' {port}" not in body, name
            assert f"Test-Listening '127.0.0.3' {port}" not in body, name

    assert "Wait-Ours" in up
    assert "Get-PortState" in up and "Get-PortState" in status
    assert up.count("'foreign'") >= 2, "ca relay lan API phai tu choi cong bi chiem"


def test_port_owner_is_matched_against_the_process_tree(source):
    state = _body(source, "Get-PortState")
    assert "Get-Tree" in state, (
        "so pid nghe cong voi DUNG pid da luu se luon sai: tien trinh nghe la "
        "chau cua no"
    )


# --- DEFECT 3 ------------------------------------------------------------
# `taskkill /T` prints to stderr when a child has already exited on its own
# ("could not be terminated"). Windows PowerShell 5.1 wraps a native command's
# stderr in an ErrorRecord, and with $ErrorActionPreference = 'Stop' at the top
# of the script that became a terminating error: `down` died halfway, leaving
# half the stack running while reporting a crash.
def test_process_kill_does_not_route_native_stderr_through_powershell(source):
    down = _code(source, "Invoke-Down")
    assert "taskkill" not in down, (
        "goi taskkill truc tiep trong PowerShell: dung Stop-Tree, noi viec chuyen "
        "huong do chinh cmd lam"
    )
    assert "Stop-Tree" in down

    killer = _code(source, "Stop-Tree")
    # Chuyen huong phai nam TRONG chuoi cmd. `... 2>&1 | Out-Null` o phia
    # PowerShell van di qua duong boc ErrorRecord va van no.
    assert ">nul 2>&1" in killer, killer
    assert "2>&1 | Out-Null" not in killer



# A `\a` typed into a generated string became a literal BEL byte, so the hint
# rendered as `.\scriptsivb.ps1`. Nothing failed; the advice was just wrong.
def test_no_stray_control_characters(source):
    bad = {c for c in source if ord(c) < 32 and c not in "\t\r\n"}
    assert not bad, f"ky tu dieu khien lac trong script: {[hex(ord(c)) for c in bad]}"


def test_hint_paths_point_at_this_script(source):
    for hint in re.findall(r"\.\scripts\[A-Za-z0-9_.-]+", source):
        assert hint == r".\scripts\aivb.ps1", hint
