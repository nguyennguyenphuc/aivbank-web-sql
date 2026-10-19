-- AIV Bank - lop hoc doc du lieu phan tich cua game (`candy_game.jelly_analytics`)
-- =====================================================================
--   psql -U postgres -f database/schema/19_game_class_access.sql
--
-- Chay SAU 15_class_roles.sql, 18_game_database.sql va sau khi `game-migrate`
-- da tao schema `jelly_analytics`. Idempotent.
--
-- ---------------------------------------------------------------------
-- VI SAO
-- ---------------------------------------------------------------------
-- Moi tai khoan hoc vien noi thang (psql / Power BI) duoc vao Finance va
-- Supply Chain. Du lieu game la bo thu ba cho cung muc dich, nen cung duoc
-- mo theo DUNG khuon SCM: mot goi NOLOGIN `candy_reader`, cap cho hai nhom
-- `aivb_class_*` - user tao moi tu co quyen, khong phai sua gi o day.
--
-- KHAC SCM o mot cho, co chu y: `candy_game` con chua du lieu VAN HANH cua
-- game trong schema `public` (hash mat khau, token phien, IP, ve SSO, vi).
-- Lop hoc chi thay `jelly_analytics`; `public` bi thu hoi USAGE (muc 3).
-- So du vi - thu co ich cho phan tich - di qua view
-- `jelly_analytics.live_player_wallets`, chi co cot so, khong cot nhay cam.
-- ---------------------------------------------------------------------

\set ON_ERROR_STOP on

-- =====================================================================
-- 1. Goi quyen doc - NOLOGIN
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'candy_reader') THEN
        CREATE ROLE candy_reader NOLOGIN;
    END IF;
END $$;

GRANT CONNECT ON DATABASE candy_game TO candy_reader;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_student') THEN
        EXECUTE 'GRANT candy_reader TO aivb_class_student';
        EXECUTE 'GRANT candy_reader TO aivb_class_instructor';
    ELSE
        RAISE NOTICE 'chua co aivb_class_* (15_class_roles.sql) - bo qua lane game';
    END IF;
END $$;

-- =====================================================================
-- 2. Tham so phien cho moi ai noi vao candy_game
-- =====================================================================
-- Giong SCM (15_class_roles.sql muc 4): chi doc, search_path tro vao du lieu
-- phan tich, timeout cho truy van cua lop.
ALTER ROLE ALL IN DATABASE candy_game SET default_transaction_read_only       = on;
ALTER ROLE ALL IN DATABASE candy_game SET search_path                         = 'jelly_analytics';
ALTER ROLE ALL IN DATABASE candy_game SET statement_timeout                   = '300s';
ALTER ROLE ALL IN DATABASE candy_game SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE ALL IN DATABASE candy_game SET lock_timeout                        = '5s';

-- MIEN TRU: game-api, game-migrate, game_sync deu la `candy_app` va ghi vao
-- `public`. Muc "role + database" thang muc "moi role", nen may dong nay giu
-- game chay nhu truoc. (idle_in_transaction va lock_timeout cua candy_app
-- da dat o 18_game_database.sql.)
ALTER ROLE candy_app IN DATABASE candy_game SET default_transaction_read_only = off;
ALTER ROLE candy_app IN DATABASE candy_game SET search_path = "$user", public;
ALTER ROLE candy_app IN DATABASE candy_game SET statement_timeout = 0;
ALTER ROLE postgres  IN DATABASE candy_game SET default_transaction_read_only = off;
ALTER ROLE postgres  IN DATABASE candy_game SET search_path = "$user", public;
ALTER ROLE postgres  IN DATABASE candy_game SET statement_timeout = 0;

-- =====================================================================
-- 3. Quyen ben trong candy_game
-- =====================================================================
\connect candy_game

-- `public` la cua game: khong ai ngoai chu (candy_app, qua pg_database_owner)
-- dung duoc. Thu USAGE la du - khong co USAGE thi khong tham chieu duoc bang
-- hay ham nao trong schema, ke ca `aivb_upsert_account`.
--
-- KHONG `REVOKE EXECUTE ... FROM PUBLIC` tren ham cua `public`: cac ham
-- pgcrypto (digest, crypt, hmac...) nam o day nhung chu la `postgres`, va
-- candy_app goi duoc chung CHINH NHO quyen EXECUTE mac dinh cua PUBLIC.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- `restore` chay TRUOC `game-migrate`. Tao san schema (chu la candy_app) cung
-- default privileges: migration 0006 dung `create schema if not exists`, nen
-- moi bang no tao sau nay tu mo cho lop ma khong phai chay lai file nay.
CREATE SCHEMA IF NOT EXISTS jelly_analytics AUTHORIZATION candy_app;
ALTER SCHEMA jelly_analytics OWNER TO candy_app;
GRANT USAGE ON SCHEMA jelly_analytics TO candy_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA jelly_analytics TO candy_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE candy_app IN SCHEMA jelly_analytics
    GRANT SELECT ON TABLES TO candy_reader;

-- View tao duoi ten candy_app: view chay voi quyen cua CHU, nen lop hoc doc
-- duoc so du vi ma khong can quyen gi tren `wallets`. Chi tao khi bang cua
-- game da co (lan `up` dau tien tren may moi: lan `restore` ke tiep se tao).
DO $$
BEGIN
    IF to_regclass('public.wallets') IS NULL OR to_regclass('public.account_identities') IS NULL THEN
        RAISE NOTICE 'chua co bang game (game-migrate chua chay) - bo qua live_player_wallets';
        RETURN;
    END IF;
    EXECUTE 'SET LOCAL ROLE candy_app';
    EXECUTE $v$
        CREATE OR REPLACE VIEW jelly_analytics.live_player_wallets AS
        SELECT 'aivb_' || i.provider_subject AS user_id,
               w.soft_currency, w.hard_currency, w.lifetime_earned, w.lifetime_spent,
               w.updated_at
          FROM public.wallets w
          JOIN public.account_identities i
            ON i.account_id = w.account_id AND i.provider = 'aivb' AND i.deleted_at IS NULL
         WHERE w.deleted_at IS NULL
    $v$;
    EXECUTE 'RESET ROLE';
    EXECUTE 'GRANT SELECT ON jelly_analytics.live_player_wallets TO candy_reader';
END $$;

-- =====================================================================
-- 4. Nghiem thu - hong o day con hon hong luc dang day
-- =====================================================================
DO $$
DECLARE
    t text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_student') THEN
        RETURN;
    END IF;
    IF NOT has_database_privilege('aivb_class_student', 'candy_game', 'CONNECT') THEN
        RAISE EXCEPTION 'hoc vien thieu CONNECT tren candy_game';
    END IF;
    FOREACH t IN ARRAY ARRAY['jelly_analytics.users', 'jelly_analytics.level_attempts',
                             'jelly_analytics.live_player_wallets'] LOOP
        CONTINUE WHEN to_regclass(t) IS NULL;
        IF NOT has_table_privilege('aivb_class_student', t, 'SELECT') THEN
            RAISE EXCEPTION 'hoc vien khong doc duoc %', t;
        END IF;
        IF has_table_privilege('aivb_class_student', t, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
            RAISE EXCEPTION 'DUNG LAI: hoc vien ghi duoc %', t;
        END IF;
    END LOOP;
    IF has_schema_privilege('aivb_class_student', 'public', 'USAGE')
       OR has_schema_privilege('aivb_class_instructor', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'DUNG LAI: lop hoc thay schema public cua game (tai khoan, token, vi)';
    END IF;
    FOREACH t IN ARRAY ARRAY['public.accounts', 'public.auth_sessions', 'public.wallets'] LOOP
        IF to_regclass(t) IS NOT NULL AND has_table_privilege('aivb_class_student', t, 'SELECT') THEN
            RAISE EXCEPTION 'DUNG LAI: hoc vien doc duoc %', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'OK: lop hoc doc duoc jelly_analytics, khong cham duoc public';
END $$;
