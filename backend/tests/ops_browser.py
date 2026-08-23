"""Kiem tra khu vuc "Thuc hanh SQL" trong mot trinh duyet THAT.

    python -m pip install playwright        # KHONG nam trong docker/requirements.txt
    uvicorn backend.main:app --port 8099    # cua so khac
    python backend/tests/ops_browser.py

KHONG phai test pytest. Cung khuon voi ops_bench.py / ops_conc.py / ops_http.py:
no can mot may chu dang chay va mot Chrome cai san, nen no khong the la mot phan
cua bo test chay moi lan sua code.

VI SAO NO PHAI TON TAI

Ba loi lot qua CA pytest LAN `node --check`, va chi hien ra o day:

  1. ban ESM cua DuckDB mang mot import tran cua apache-arrow. Trang chet ngay
     luc import; phia Python khong co dau hieu gi.
  2. duoi .mjs duoc phuc vu la text/plain, va trinh duyet tu choi import() mot
     module co MIME khong phai JS.
  3. gan chuoi rong cho .value cua o chon file lam rong FileList SONG, truoc khi
     ham async kip doc no - keo tha file vao thi khong nap duoc gi, lang le.

Khong cai nao trong ba cai do lam do mot dong test Python nao.

HAI TINH CHAT NO DO, chu khong suy doan:

  - KHONG mot request nao mang noi dung file roi khoi may. Do bang cach quan sat
    mang, khong bang cach doc code.
  - CSP THAT cua may chu khong chan engine da vendor.

Vi tinh chat thu hai, phai chay tren BACKEND THAT. Chay tren frontend/serve.py
se cho mot ket qua xanh vo nghia: serve.py khong gui CSP nao ca.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Mac dinh la may cuc bo. Dat AIVB_BROWSER_BASE de do BAN DA TRIEN KHAI: CSP,
# kieu MIME cua .wasm va thoi gian tai 34 MB engine deu do nginx tren VPS quyet
# dinh, nen mot ket qua xanh o localhost khong noi gi ve cai hoc vien gap.
BASE = os.environ.get("AIVB_BROWSER_BASE", "http://127.0.0.1:8099").rstrip("/")
SCRATCH = Path(__file__).parent
FIXTURES = SCRATCH / "fx"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

pass_n = fail_n = 0


def check(name: str, ok: bool, extra: str = "") -> None:
    global pass_n, fail_n
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {extra}" if extra else ""))
    if ok:
        pass_n += 1
    else:
        fail_n += 1


def make_fixtures() -> tuple[Path, Path]:
    FIXTURES.mkdir(exist_ok=True)
    a = FIXTURES / "don_hang.csv"
    b = FIXTURES / "khach_hang.csv"
    a.write_text(
        "ma_don,khach,so_tien,ngay\n"
        "1,Anh Minh,12500000000,2024-01-05\n"
        "2,Chi Lan,9007199254740993,2024-02-11\n"   # > 2^53: phep thu chinh xac
        "3,Anh Minh,-500,2024-03-02\n",
        encoding="utf-8",
    )
    b.write_text("khach,thanh_pho\nAnh Minh,Ha Noi\nChi Lan,TP HCM\n", encoding="utf-8")
    return a, b


def main() -> int:
    a, b = make_fixtures()
    console_errors: list[str] = []
    csp_violations: list[str] = []
    posts: list[tuple[str, int]] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, headless=True)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()

        def on_console(msg):
            if msg.type == "error":
                console_errors.append(msg.text)
                if "Content Security Policy" in msg.text or "CSP" in msg.text:
                    csp_violations.append(msg.text)

        page.on("console", on_console)
        # Moi request roi trang: ghi lai request nao mang THAN (body) di dau.
        page.on(
            "request",
            lambda r: posts.append((r.url, len(r.post_data or "")))
            if r.method in ("POST", "PUT", "PATCH")
            else None,
        )

        page.goto(BASE, wait_until="networkidle")

        # --- 1. man hinh dang nhap la thu duy nhat thay duoc khi chua co phien ---
        gate_visible = page.locator("#auth-gate").is_visible()
        app_hidden = page.locator("#app").get_attribute("hidden") is not None
        check("fail-closed: hien lop che dang nhap, #app van hidden", gate_visible and app_hidden)

        # --- 2. mo khung ung dung de vao duoc khu vuc sandbox ---
        # Sandbox khong can phien (no khong cham may chu), nhung no nam trong #app.
        page.evaluate(
            """() => {
                document.getElementById('app').hidden = false;
                document.getElementById('auth-gate').hidden = true;
                document.body.classList.remove('is-gated');
            }"""
        )
        page.locator('[data-section="sandbox"]').click()
        page.wait_for_timeout(400)
        check(
            "chuyen sang khu vuc Thuc hanh SQL",
            page.locator("#sandbox-workspace").is_visible()
            and not page.locator("#main-workspace").is_visible(),
        )

        # --- 3. nap hai file, do ca thoi gian tai engine 33 MB ---
        t0 = time.time()
        page.locator("#sandbox-file").set_input_files([str(a), str(b)])
        try:
            page.wait_for_function(
                "() => document.querySelectorAll('#sandbox-tables .sbtable').length >= 2",
                timeout=180_000,
            )
        except Exception as exc:
            check("nap 2 file CSV thanh bang", False, str(exc)[:80])
            print("\n  console errors:", console_errors[:5])
            browser.close()
            return 1
        boot_s = time.time() - t0

        names = page.locator(".sbtable-name").all_inner_texts()
        check("nap 2 file CSV thanh bang", len(names) == 2, f"{names}  ({boot_s:.1f}s ke ca tai engine)")
        check("ten bang sinh tu ten file", set(names) == {"don_hang", "khach_hang"}, str(names))

        rows_txt = page.locator(".sbtable-rows").all_inner_texts()
        check("dem dung so dong", "3" in rows_txt[0] or "3" in rows_txt[1], str(rows_txt))

        # --- 4. cau truy van co san duoc gieo tu chinh file da nap ---
        seeded = page.evaluate("() => document.querySelector('#sandbox-workspace .CodeMirror').CodeMirror.getValue()")
        check("tu gieo cau SELECT theo bang vua nap", "don_hang" in seeded, seeded.replace("\n", " ")[:60])

        # --- 5. JOIN hai file, va so nguyen > 2^53 phai giu du chu so ---
        sql = (
            "SELECT k.thanh_pho, count(*) AS n, max(d.so_tien) AS lon_nhat "
            "FROM don_hang d JOIN khach_hang k USING (khach) GROUP BY 1 ORDER BY 1"
        )
        page.evaluate(
            "sql => document.querySelector('#sandbox-workspace .CodeMirror').CodeMirror.setValue(sql)",
            sql,
        )
        page.locator("#sandbox-run").click()
        page.wait_for_function(
            "() => document.querySelectorAll('#sandbox-grid tbody tr').length > 0", timeout=60_000
        )
        grid = page.locator("#sandbox-grid tbody tr").all_inner_texts()
        check("JOIN hai file da nap", len(grid) == 2, str(grid))

        big = page.locator("#sandbox-grid tbody").inner_text()
        check(
            "BIGINT 9007199254740993 giu nguyen chu so (khong lam tron)",
            "9,007,199,254,740,993" in big or "9007199254740993" in big,
            big.replace("\n", " | ")[:90],
        )

        # --- 6. nhan thoi gian phai noi that: chay tren may nay, khong phai may chu ---
        meta = page.locator("#sandbox-meta").inner_text()
        check("nhan thoi gian noi 'tren may ban', khong noi 'may chu'",
              "may chu" not in meta.lower().replace("á", "a").replace("ủ", "u"),
              meta.replace("\n", " ")[:80])

        # --- 7. tai CSV ve ---
        with page.expect_download(timeout=30_000) as dl_info:
            page.get_by_role("button", name="Tải CSV").click()
        dl = dl_info.value
        out = SCRATCH / "tai_ve.csv"
        dl.save_as(str(out))
        text = out.read_text(encoding="utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        check("tai CSV ve duoc", out.exists() and len(rows) == 3, f"{dl.suggested_filename}, {len(rows)} dong")
        check("CSV giu gia tri GOC (khong co dau phay nhom nghin)",
              any("9007199254740993" in c for r in rows for c in r), str(rows[1:]))

        # --- 7b. thanh dieu huong phai CAO THAT, khong chi "hien thi" ---
        # Da co luc .sections bi .layout ep tu ~70px xuong 13px: van visible,
        # van bam duoc, va Playwright van bao PASS - nhung khong ai doc noi.
        # Do chieu cao, dung hoi "co hien khong".
        nav_h = page.evaluate("() => document.getElementById('sections').getBoundingClientRect().height")
        check("thanh khu vuc cao that (>= 48px, khong bi flex ep bep)", nav_h >= 48, f"{nav_h:.0f}px")

        # --- 7c. o soan thao phai cao hon mot dong ---
        ed_h = page.evaluate(
            "() => document.querySelector('#sandbox-workspace .CodeMirror').getBoundingClientRect().height"
        )
        # Nguong 60px, khong phai 100: tokens.css co tier thu nho o soan thao theo
        # chieu cao viewport (max-height 800px va 640px), nen tren cua so thap thi
        # 92px la DUNG. Loi that can bat la "co ve dung mot dong" (~25px).
        check("o soan thao cao hon mot dong (>= 60px)", ed_h >= 60, f"{ed_h:.0f}px")

        # --- 7d. chu tieng Viet phai dung font co dau ---
        # Georgia thieu gan het khoi U+1EXX: "dieu" hien ra thanh "die `u".
        serif = page.evaluate("() => getComputedStyle(document.querySelector('.auth-brand-text') || document.body).fontFamily")
        check("font serif khong bat dau bang Georgia", "Georgia" not in serif.split(",")[0], serif[:60])

        # --- 8. HAI TINH CHAT QUAN TRONG NHAT ---
        body_carrying = [(u, n) for u, n in posts if n > 0]
        check("KHONG request nao mang noi dung file roi may",
              not body_carrying, str(body_carrying[:3]))

        same_origin = all(u.startswith(BASE) for u, _ in posts)
        check("moi request deu cung origin", same_origin, str([u for u, _ in posts][:3]))

        check("CSP khong chan gi (khong co violation trong console)",
              not csp_violations, str(csp_violations[:2]))

        # /auth/me tra 401 khi chua dang nhap - dung hop dong, khong phai loi.
        other_errors = [e for e in console_errors
                        if "favicon" not in e.lower() and "401" not in e and "404" not in e]
        check("khong loi console nao khac", not other_errors, str(other_errors[:3]))

        # --- 9. loi SQL hien nguyen van ---
        page.evaluate(
            "() => document.querySelector('#sandbox-workspace .CodeMirror').CodeMirror.setValue('SELECT * FROM khong_co_bang')"
        )
        page.locator("#sandbox-run").click()
        page.wait_for_selector("#sandbox-error:not([hidden])", timeout=30_000)
        err = page.locator("#sandbox-error").inner_text()
        check("loi SQL hien nguyen van, co ich", "khong_co_bang" in err, err.replace("\n", " ")[:90])

        browser.close()

    print(f"\n  {pass_n} pass, {fail_n} fail")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
