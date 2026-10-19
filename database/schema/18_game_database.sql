-- AIV Bank - database cua game "Vuong Quoc Keo Ngot" (`candy_game`)
-- =====================================================================
--   psql -U postgres -v pw_candy_app=... -f database/schema/18_game_database.sql
--
-- Chay SAU 16_app_database.sql. Idempotent.
--
-- Game (thu muc `game/`, service `game-api` trong docker-compose) co bo
-- migration RIENG (`game/sql/migrations/`, chay boi service `game-migrate`).
-- File nay chi dung khung: vai tro + database. Bang nao nam trong
-- `candy_game` la viec cua game, khong phai cua file nay.
--
-- ---------------------------------------------------------------------
-- VI SAO LA MOT DATABASE VA MOT VAI TRO RIENG
-- ---------------------------------------------------------------------
--   * `candy_app` la chu cua `candy_game` va KHONG co CONNECT o bat ky
--     database nao khac: mot lo hong trong API Node khong cham duoc toi
--     `aivb_app` (phien dang nhap) hay hai database du lieu.
--   * User AIV Bank la vai tro LOGIN that trong cum nay. `REVOKE CONNECT ...
--     FROM PUBLIC` ben duoi chan moi nguoi KHONG thuoc lop hoc. Hoc vien va
--     giang vien van noi thang duoc (psql / Power BI) nhung CHI DOC schema
--     `jelly_analytics` - xem 19_game_class_access.sql. Schema `public` (tai
--     khoan, hash mat khau, token phien, vi) khong ai trong lop doc/sua duoc.
--   * `restore.py` khong biet `candy_game` (nam ngoai `EXPECTED`), nen nap
--     lai dump khong bao gio xoa tien do choi cua lop.
--
-- Dong bo user: `backend/game_sync.py` noi vao day BANG `candy_app` va chi
-- goi ham `aivb_upsert_account` / `aivb_disable_missing` (migration 0013
-- cua game).
-- ---------------------------------------------------------------------

\set ON_ERROR_STOP on

-- =====================================================================
-- 1. Vai tro
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'candy_app') THEN
        CREATE ROLE candy_app LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 30;
    END IF;
END $$;

-- Ngan sach ket noi:
--     pool cua game-api (DatabaseService, max 10)     10
--     game-migrate / game_sync / admin_cli / psql     ~ 4
--     cho tho khi game-api khoi dong lai chong nhau   ~ 10
--                                                     ----
--                                                       ~ 24 -> tran 30
ALTER ROLE candy_app CONNECTION LIMIT 30;
ALTER ROLE candy_app PASSWORD :'pw_candy_app';

-- =====================================================================
-- 2. Database
-- =====================================================================
SELECT 'CREATE DATABASE candy_game OWNER candy_app TEMPLATE template0 '
       'ENCODING ''UTF8'' LOCALE_PROVIDER ''builtin'' BUILTIN_LOCALE ''C'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'candy_game')
\gexec

ALTER DATABASE candy_game OWNER TO candy_app;
REVOKE ALL ON DATABASE candy_game FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE candy_game TO candy_app;
-- 40 cho game + ~160 cho lop hoc doc `jelly_analytics` (tran moi nguoi 30,
-- `pgroles.py`). `max_connections` (350) moi la buc tuong that.
ALTER DATABASE candy_game CONNECTION LIMIT 200;

-- Ket noi treo "idle in transaction" khong duoc song mai.
ALTER ROLE candy_app IN DATABASE candy_game SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE candy_app IN DATABASE candy_game SET lock_timeout = '5s';

-- =====================================================================
-- 3. Nghiem thu
-- =====================================================================
DO $$
BEGIN
    IF NOT has_database_privilege('candy_app', 'candy_game', 'CONNECT') THEN
        RAISE EXCEPTION 'candy_app thieu CONNECT tren candy_game';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aivb_app')
       AND has_database_privilege('candy_app', 'aivb_app', 'CONNECT') THEN
        RAISE EXCEPTION 'DUNG LAI: candy_app noi duoc aivb_app - lo hong o game se cham toi phien dang nhap';
    END IF;
    -- Lop hoc CO THE noi vao (19_game_class_access.sql), nhung khong bao gio
    -- duoc tao doi tuong hay bang tam. Quyen tren tung bang cua `public` phai
    -- kiem ben trong `candy_game` - xem khoi nghiem thu cua file 19.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_student')
       AND (has_database_privilege('aivb_class_student', 'candy_game', 'CREATE')
            OR has_database_privilege('aivb_class_student', 'candy_game', 'TEMPORARY')) THEN
        RAISE EXCEPTION 'DUNG LAI: hoc vien tao duoc doi tuong trong candy_game';
    END IF;
    RAISE NOTICE 'OK: candy_game da dung quyen';
END $$;
