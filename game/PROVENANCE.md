# Nguồn gốc thư mục `game/`

- Repo: `https://github.com/kabuto-png/candy-kingdom-match3` (private)
- Commit: `199ddcfe5d0406ad927f1c2483b8f4494660c8bb` (nhánh `main`, 2026-09-23)
- Cách lấy: tarball của đúng commit trên (không kèm lịch sử git).
  Bỏ `artifacts/candy-product-health-report.html` (4,5 MB, báo cáo sinh ra).

## Sửa đổi so với bản gốc (để chạy trong AIV Bank dưới `/game/`)

| File | Sửa gì |
|---|---|
| `vite.config.ts` | `base: '/game/'` (đặt `GAME_BASE=/` để build độc lập); proxy dev cho `/game/api` |
| `index.html` | manifest/icon dùng đường dẫn tương đối |
| `src/features/auth/api-client.ts` | `apiUrl()` đổi `/api/...` thành `/game/api/...`; gửi `X-AIVB-Client` khi nhúng |
| `src/features/auth/auth-context.tsx` | khi nhúng: luôn SSO bằng phiên AIV Bank |
| `src/features/auth/auth-screen.tsx` | khi nhúng: không có chơi khách / đăng nhập email |
| `src/App.tsx` | khi nhúng: ẩn nút "Thoát" (đăng xuất do AIV Bank quyết) |
| `src/features/offline-sync/register-pwa.ts` | không đăng ký service worker khi nhúng |
| `server/src/config/env.ts` | `WEB_ORIGIN` nhận nhiều origin; thêm `PUBLIC_BASE_PATH`, `AIVB_SSO_SECRET` |
| `server/src/common/auth/origin-csrf.guard.ts` | `isAllowedOrigin()` theo danh sách origin |
| `server/src/modules/auth/*` | endpoint `POST /api/v1/auth/aivb-sso`, kiểm vé (`aivb-sso.ts`), cookie theo `PUBLIC_BASE_PATH` |
| `sql/migrations/0013-aivb-sso.*.sql` | `aivb_upsert_account`, `aivb_disable_missing`, bảng vé đã dùng |
| `tests/integration/auth/aivb-sso.test.ts` | test vé SSO |
| `.dockerignore` | chép từ `.containerignore` (Docker không đọc file của Podman) |
