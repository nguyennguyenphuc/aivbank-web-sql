"""Nén sẵn các file vendor lớn thành `<tên>.gz`.

VÌ SAO

`frontend/vendor/duckdb-wasm/duckdb-eh.wasm` nặng 32,7 MB và trước đây được gửi
nguyên vẹn: 11,2 giây qua đường hầm, **mỗi lần** một học viên mở khu vực Thực
hành SQL. gzip đưa nó về 7,3 MB — còn 22%.

VÌ SAO KHÔNG DỰA VÀO CACHE

Đã đặt `Cache-Control: public, max-age=31536000, immutable` cho cả `/vendor/`,
và với file nhỏ thì nó chạy: một file 227 KB cùng thư mục cho `transferSize = 0`
ở lần nạp thứ hai. File 32,7 MB thì **không** — Chrome từ chối cache một mục lớn
hơn khoảng 1/8 dung lượng cache đĩa. Cùng header, cùng thư mục, chỉ khác kích
thước. Nên nén là thứ có tác dụng thật, còn cache là phần thưởng thêm.

VÌ SAO NÉN SẴN CHỨ KHÔNG NÉN LÚC CHẠY

`GZipMiddleware` nén lại từ đầu cho mỗi request. Với 32,7 MB đó là khoảng một
giây CPU mỗi lần — một lớp 30 người là 30 giây CPU, đúng vào lúc đông nhất. Nén
sẵn thì tốn một lần, lúc dựng.

CÁCH DÙNG

    python scripts/build_vendor_gz.py

Chạy lại sau mỗi lần đổi file vendor. `backend/main.py` chỉ dùng bản `.gz` khi nó
MỚI HƠN bản gốc; cũ hơn thì bỏ qua, nên quên chạy script này không bao giờ làm
học viên nhận nội dung cũ.
"""

from __future__ import annotations

import gzip
import shutil
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
VENDOR = APP_ROOT / "frontend" / "vendor"

#: Dưới ngưỡng này thì không đáng: trình duyệt cache được chúng rồi, và mỗi file
#: `.gz` thừa là một thứ nữa có thể trôi khỏi bản gốc.
MIN_BYTES = 1 << 20  # 1 MB

#: Đã nén rồi thì nén nữa chỉ tốn chỗ.
SKIP_SUFFIXES = {".gz", ".br", ".zip", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2"}


def main() -> int:
    if not VENDOR.is_dir():
        print(f"Khong thay {VENDOR}", file=sys.stderr)
        return 1

    total_in = total_out = 0
    for path in sorted(VENDOR.rglob("*")):
        if not path.is_file() or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        size = path.stat().st_size
        if size < MIN_BYTES:
            continue

        packed = path.with_name(path.name + ".gz")
        if packed.is_file() and packed.stat().st_mtime >= path.stat().st_mtime:
            print(f"  bo qua (da moi)  {path.relative_to(APP_ROOT)}")
            continue

        # Mức 6, không phải 9: với file này mức 9 chỉ nhỏ hơn chưa tới 1% nhưng
        # tốn gấp mấy lần thời gian nén.
        tmp = packed.with_suffix(packed.suffix + ".tmp")
        with path.open("rb") as src, gzip.open(tmp, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst, length=1 << 20)
        tmp.replace(packed)

        out = packed.stat().st_size
        total_in += size
        total_out += out
        print(
            f"  {path.relative_to(APP_ROOT)}\n"
            f"      {size / 1048576:.1f} MB -> {out / 1048576:.1f} MB "
            f"(con {out / size * 100:.0f}%)"
        )

    if total_in:
        print(
            f"\n  Tong: {total_in / 1048576:.1f} MB -> {total_out / 1048576:.1f} MB "
            f"(con {total_out / total_in * 100:.0f}%)"
        )
    else:
        print("  Khong co gi phai nen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
