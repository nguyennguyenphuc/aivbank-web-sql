"""Đồng bộ ba file hợp đồng từ kho gốc vào `app/backend/contract/`.

    python app/database/sync_contract.py          # kiểm, không ghi
    python app/database/sync_contract.py --write  # chép đè

`app/` giữ **bản sao** của ba file hợp đồng để nó tự chứa — chuyển sang máy
khác chỉ cần mang theo `app/`. Bản gốc do bộ sinh dữ liệu tạo ra và nằm ngoài
`app/`.

Cái giá của bản sao là nó **trôi được**. Chạy script này sau mỗi lần chủ sở hữu
phát hành package mới, hoặc sau khi `extract_full_spec.py` chạy lại.

Trôi hợp đồng cột là kiểu hỏng tệ nhất trong hệ thống này: ứng dụng vẫn chạy
bình thường, nhưng nó quyết định cột nào vai trò nào được thấy dựa trên một
phiên bản cũ — tức là có thể để lộ cột đáng lẽ phải giấu, mà không có lỗi nào.
Vì vậy chế độ mặc định là KIỂM, và mã thoát khác 0 khi lệch.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

# Console Windows mac dinh la cp1252 va se NEM UnicodeEncodeError khi gap chu
# co dau - script chet giua chung thay vi in ra ket qua. Ep UTF-8 ngay tu dau.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):  # pragma: no cover - moi truong la
        pass

APP_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = APP_ROOT.parent
CONTRACT_DIR = APP_ROOT / "backend" / "contract"

#: (bản sao trong app/, bản gốc ở kho)
PAIRS = [
    (
        CONTRACT_DIR / "column-contract.json",
        PROJECT_ROOT / "_workspace" / "00_spec-reader_column-contract.json",
    ),
    (
        CONTRACT_DIR / "owner-config.json",
        PROJECT_ROOT / "AIV_Bank_full_standalone_v5.1.6.4" / "01_cau_hinh_owner_v1.0.json",
    ),
    (
        CONTRACT_DIR / "release-manifest.json",
        PROJECT_ROOT / "AIV_Bank_full_standalone_v5.1.6.4" / "05_release_manifest_v5.1.6.4.json",
    ),
]


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="chép đè bản sao trong app/")
    args = ap.parse_args(argv)

    drifted = 0
    checked = 0
    skipped = 0
    for copy, source in PAIRS:
        if not source.is_file():
            skipped += 1
            print(f"  [BỎ QUA] {copy.name}: không thấy bản gốc {source}")
            print("           (bình thường khi chỉ triển khai `app/` mà không có kho đầy đủ)")
            continue
        checked += 1
        if not copy.is_file():
            print(f"  [THIẾU ] {copy.name}")
            drifted += 1
            if args.write:
                shutil.copy2(source, copy)
                print(f"           đã chép từ {source}")
            continue

        same = _sha256(copy) == _sha256(source)
        if same:
            print(f"  [KHỚP  ] {copy.name}")
            continue

        drifted += 1
        print(f"  [LỆCH  ] {copy.name}")
        if args.write:
            shutil.copy2(source, copy)
            print("           đã cập nhật")

    print()
    if drifted and not args.write:
        print(
            f"{drifted} file lệch khỏi bản gốc. Chạy lại với --write để cập nhật.",
            file=sys.stderr,
        )
        return 1
    if drifted:
        print(f"Đã cập nhật {drifted} file. Chạy lại bộ test trước khi commit.")
    elif checked == 0:
        # KHÔNG nói "mọi thứ đều khớp" khi chẳng kiểm được gì. Đây là bản triển
        # khai độc lập, không có kho gốc để đối chiếu - trạng thái hợp lệ, nhưng
        # nói nhầm thành "đã kiểm và khớp" sẽ tạo ra một sự yên tâm không có
        # thật về đúng thứ dễ trôi nhất.
        print(f"Không kiểm được gì: cả {skipped} bản gốc đều không có mặt.")
        print("Đây là bản triển khai độc lập. Muốn đối chiếu thì chạy lệnh này")
        print("trong kho đầy đủ, nơi bộ sinh dữ liệu sinh ra bản gốc.")
    else:
        print(f"Đã đối chiếu {checked} hợp đồng, tất cả khớp bản gốc.")
        if skipped:
            print(f"({skipped} file không có bản gốc để đối chiếu.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
