-- AIV Bank - database trang thai ung dung (`aivb_app`)
-- =====================================================================
--   psql -U postgres -v pw_app_rw=... -f database/schema/16_app_database.sql
--
-- Chay SAU 15_class_roles.sql. Idempotent.
--
-- ---------------------------------------------------------------------
-- VI SAO PHAI LA MOT DATABASE RIENG
-- ---------------------------------------------------------------------
-- `ARCHITECTURE.md` dong 34 dat mot bat bien: "PostgreSQL la ban sao, khong
-- bao gio la ban goc. Muon sua du lieu thi dung lai tu DuckDB, nghiem thu,
-- seal, roi nap lai."
--
-- Session, throttle va gamification la state GHI DUOC cua ung dung - chung
-- khong den tu DuckDB va khong dung lai duoc. De chung trong `aivb_student`
-- hay `aivb_instructor` la pha bat bien do, va cu the hon: `restore.py`
-- dung lai hai database ay moi lan nap dump, nen diem so va lich su luyen
-- tap cua ca lop se BIEN MAT ma khong ai nhan ra cho toi luc hoc vien hoi.
--
-- `aivb_app` nam ngoai `EXPECTED` cua restore.py (database/restore.py dong
-- 41-50), nen no khong bao gio bi dung toi.
--
-- ---------------------------------------------------------------------
-- CAI GI KHONG NAM O DAY
-- ---------------------------------------------------------------------
-- MAT KHAU. Danh tinh song trong `pg_authid` + `pg_auth_members`, do
-- PostgreSQL quan ly. Day la ca diem cua viec bo SQLite: Power BI xac thuc
-- voi `pg_authid`, nen do phai la nguon su that duy nhat.
--
-- Bang `app.user_profile` chi giu phan METADATA khong nhet vao vai tro duoc
-- (ho ten, lan dang nhap cuoi). Vai tro STUDENT/INSTRUCTOR suy tu
-- `pg_auth_members`, trang thai khoa suy tu `rolcanlogin` - khong nhan ban
-- o day, vi hai nguon su that ve cung mot thu thi som muon cung lech.
-- ---------------------------------------------------------------------

\set ON_ERROR_STOP on

-- =====================================================================
-- 1. Database
-- =====================================================================
-- Dung cung locale `C` voi hai database du lieu cho nhat quan. O day
-- collation khong anh huong cham bai, nhung mot cluster hai kieu sap xep la
-- thu se lam ai do mat buoi chieu vao mot ngay nao do.
SELECT format(
    'CREATE DATABASE aivb_app OWNER %I TEMPLATE template0 '
    'ENCODING ''UTF8'' LOCALE_PROVIDER ''builtin'' BUILTIN_LOCALE ''C''',
    current_user)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aivb_app')
\gexec

-- =====================================================================
-- 2. Vai tro ghi - quyen ghi DUY NHAT ma ung dung duoc cap
-- =====================================================================
-- Backend van CHI DOC tren aivb_student / aivb_instructor / scm. Vai tro
-- nay ghi duoc, nhung CHI trong aivb_app va CHI trong schema `app`.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_app_rw') THEN
        CREATE ROLE aivb_app_rw LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 20;
    END IF;
END $$;

-- Han muc ket noi cua `aivb_app_rw`. Ngan sach, doi xung voi khoi chu thich o
-- `backend/config.py` canh `pg_auth_pool_max`:
--
--     pool xac thuc (AuthStore)            <= 4   AIVB_PG_AUTH_POOL_MAX
--     pool diem so  (GamificationStore)    <= 6   AIVB_PG_GAMIFICATION_POOL_MAX
--     `admin_cli` / bo test / `psql`       ~ 2 moi cai
--     cho tho cho van hanh                 ~ 2
--                                          ------
--                                            20
--
-- Truoc day la 12, va no khong con bao ve duoc gi: rieng backend da muon 10.
-- `ALTER` chay ca tren duong idempotent (vai tro da ton tai tu lan chay truoc).
ALTER ROLE aivb_app_rw CONNECTION LIMIT 20;

ALTER ROLE aivb_app_rw PASSWORD :'pw_app_rw';

REVOKE ALL ON DATABASE aivb_app FROM PUBLIC;
GRANT CONNECT ON DATABASE aivb_app TO aivb_app_rw;

-- Hai nhom lop can CONNECT vi ĐANG NHAP WEB = MO MOT KET NOI PostgreSQL
-- bang chinh tai khoan do. Neu khong mo noi ket noi thi khong xac thuc duoc.
--
-- Dung `aivb_app` lam cua dang nhap chu khong dung `aivb_student`: moi lan
-- go sai mat khau cung ton mot ket noi, va tran cua aivb_student (45) la de
-- danh cho truy van cua hoc vien, khong phai de danh cho nguoi go nham.
GRANT CONNECT ON DATABASE aivb_app TO aivb_class_student;
GRANT CONNECT ON DATABASE aivb_app TO aivb_class_instructor;

ALTER DATABASE aivb_app CONNECTION LIMIT 60;

-- LUOI THU HAI, khong phai ban va. Ban va nam o `backend/gamification.py`
-- (pool that su, `autocommit=True`, giao dich tuong minh).
--
-- `15_class_roles.sql` dat cac tham so nay cho aivb_student / aivb_instructor /
-- scm nhung KHONG cho aivb_app, va do chinh la cho mot ket noi ket "idle in
-- transaction" song duoc vo han: bat duoc mot ket noi nhu vay tren cum dang
-- chay la thu dan toi ban va nay.
--
-- `lock_timeout` KHONG tuy chon mot khi `record_success` da dung
-- `SELECT ... FOR UPDATE`: khong co no thi hai luot ghi cua cung mot hoc vien
-- cho nhau vo han thay vi hong nhanh va hong ro.
ALTER ROLE aivb_app_rw IN DATABASE aivb_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE aivb_app_rw IN DATABASE aivb_app SET statement_timeout = '10s';
ALTER ROLE aivb_app_rw IN DATABASE aivb_app SET lock_timeout = '3s';

\connect aivb_app

-- =====================================================================
-- 3. Schema
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO aivb_app_rw;

-- Hoc vien KHONG duoc cap gi trong schema `app`. Ho co CONNECT de dang nhap
-- va khong hon. Ket noi dang nhap chi chay `SELECT 1` roi dong.

-- =====================================================================
-- 4. Bang - chuyen nguyen ven tu SQLite
-- =====================================================================
-- Kieu du lieu giu DUNG ngu nghia cu, khong "hien dai hoa":
--   * moc thoi gian cua session/throttle van la epoch (double precision) vi
--     ma nguon so sanh voi `time.time()`;
--   * ngay thang cua gamification van la TEXT 'YYYY-MM-DD' vi ma nguon so
--     sanh chuoi va tinh chuoi ngay lien tiep bang chuoi.
-- Doi kieu o buoc chuyen kho la them mot bien so vao mot viec da du rui ro.

-- --- Ho so nguoi dung (KHONG chua mat khau) --------------------------
CREATE TABLE IF NOT EXISTS app.user_profile (
    username             text PRIMARY KEY,
    full_name            text NOT NULL DEFAULT '',
    must_change_password boolean NOT NULL DEFAULT true,
    created_at           text NOT NULL,
    password_changed_at  text,
    last_login_at        text
);

COMMENT ON TABLE app.user_profile IS
    'Metadata khong nhet vao vai tro PostgreSQL duoc. Vai tro STUDENT/INSTRUCTOR suy tu pg_auth_members; trang thai khoa suy tu rolcanlogin. Khong nhan ban o day.';

-- --- Phien ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.sessions (
    token_hash          text PRIMARY KEY,
    username            text NOT NULL,
    created_at          double precision NOT NULL,
    last_seen_at        double precision NOT NULL,
    absolute_expires_at double precision NOT NULL,
    revoked             boolean NOT NULL DEFAULT false,
    ip                  text,
    user_agent          text
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON app.sessions(username);

COMMENT ON COLUMN app.sessions.token_hash IS
    'SHA-256 cua token, KHONG BAO GIO la token. Kho bi doc cap cung khong replay duoc thanh phien song.';

-- Cot `role` cua ban SQLite CO Y bi bo: vai tro suy tu pg_auth_members o
-- thoi diem kiem phien, nen doi nhom hay khoa tai khoan co hieu luc NGAY,
-- khong phai cho het phien.

-- --- Chan dang nhap sai ---------------------------------------------
CREATE TABLE IF NOT EXISTS app.throttle (
    scope        text NOT NULL,
    key          text NOT NULL,
    fail_count   integer NOT NULL DEFAULT 0,
    locked_until double precision NOT NULL DEFAULT 0,
    updated_at   double precision NOT NULL,
    PRIMARY KEY (scope, key)
);

COMMENT ON TABLE app.throttle IS
    'PostgreSQL KHONG co co che khoa dang nhap. Bang nay la thu duy nhat chan do mat khau, nen dung bo qua khi don dep.';

CREATE TABLE IF NOT EXISTS app.meta (k text PRIMARY KEY, v text NOT NULL);

-- --- Gamification ----------------------------------------------------
CREATE TABLE IF NOT EXISTS app.practice_events (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    username      text NOT NULL,
    practice_date text NOT NULL,
    query_hash    text NOT NULL,
    tables_used   text NOT NULL DEFAULT '',
    query_kind    text NOT NULL DEFAULT 'query',
    created_at    text NOT NULL,
    UNIQUE (username, practice_date, query_hash)
);

CREATE TABLE IF NOT EXISTS app.practice_daily (
    username           text NOT NULL,
    practice_date      text NOT NULL,
    successful_queries integer NOT NULL DEFAULT 0,
    unique_queries     integer NOT NULL DEFAULT 0,
    stars_earned       integer NOT NULL DEFAULT 0,
    PRIMARY KEY (username, practice_date)
);

CREATE TABLE IF NOT EXISTS app.user_rewards (
    username           text PRIMARY KEY,
    stars              integer NOT NULL DEFAULT 0,
    diamonds           integer NOT NULL DEFAULT 0,
    current_streak     integer NOT NULL DEFAULT 0,
    longest_streak     integer NOT NULL DEFAULT 0,
    last_practice_date text,
    updated_at         text NOT NULL
);

CREATE TABLE IF NOT EXISTS app.user_achievements (
    username         text NOT NULL,
    achievement_code text NOT NULL,
    earned_at        text NOT NULL,
    PRIMARY KEY (username, achievement_code)
);

-- =====================================================================
-- 5. Quyen
-- =====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO aivb_app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO aivb_app_rw;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aivb_app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT USAGE, SELECT ON SEQUENCES TO aivb_app_rw;

-- =====================================================================
-- 6. Ham suy vai tro tu nhom - MOT nguon su that
-- =====================================================================
-- `pg_roles` va `pg_auth_members` doc duoc boi moi vai tro, nen ham nay
-- khong can quyen dac biet nao.
-- DUNG `pg_auth_members` TRUC TIEP, KHONG dung `pg_has_role`.
--
-- `pg_has_role` la quan he BAO DONG va no dung voi MOI vai tro khi nguoi hoi la
-- superuser - nen `role_of('postgres')` se tra ve 'INSTRUCTOR'. No cung dung khi
-- hoi ve chinh nhom (`pg_has_role('aivb_class_student','aivb_class_student')`).
--
-- Hau qua neu de nguyen: `admin_cli list` liet ke `postgres` va hai nhom nhu tai
-- khoan cua lop, va logic an giang vien khoi bang xep hang o `main.py` lam viec
-- tren mot danh sach sai.
CREATE OR REPLACE FUNCTION app.role_of(p_user text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles g ON g.oid = m.roleid
            JOIN pg_roles u ON u.oid = m.member
            WHERE u.rolname = p_user AND g.rolname = 'aivb_class_instructor'
        ) THEN 'INSTRUCTOR'
        WHEN EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles g ON g.oid = m.roleid
            JOIN pg_roles u ON u.oid = m.member
            WHERE u.rolname = p_user AND g.rolname = 'aivb_class_student'
        ) THEN 'STUDENT'
        ELSE NULL
    END;
$$;

COMMENT ON FUNCTION app.role_of IS
    'STUDENT/INSTRUCTOR suy tu thanh vien TRUC TIEP cua hai nhom lop. Thu tu kiem quan trong: neu ai do cap nham ca hai nhom cho mot nguoi thi phai ra INSTRUCTOR, khong phai STUDENT.';

GRANT EXECUTE ON FUNCTION app.role_of TO aivb_app_rw;

-- =====================================================================
-- 7. Khang dinh
-- =====================================================================
DO $$
BEGIN
    IF NOT has_database_privilege('aivb_app_rw', 'aivb_app', 'CONNECT') THEN
        RAISE EXCEPTION 'aivb_app_rw thieu CONNECT tren aivb_app';
    END IF;
    IF NOT has_schema_privilege('aivb_app_rw', 'app', 'USAGE') THEN
        RAISE EXCEPTION 'aivb_app_rw thieu USAGE tren schema app';
    END IF;
    -- Hoc vien phai vao duoc de dang nhap, nhung KHONG duoc doc gi.
    IF NOT has_database_privilege('aivb_class_student', 'aivb_app', 'CONNECT') THEN
        RAISE EXCEPTION 'aivb_class_student thieu CONNECT tren aivb_app - se khong dang nhap web duoc';
    END IF;
    IF has_table_privilege('aivb_class_student', 'app.sessions', 'SELECT') THEN
        RAISE EXCEPTION 'DUNG LAI: hoc vien doc duoc app.sessions - do la doc duoc phien cua nguoi khac';
    END IF;
    IF has_table_privilege('aivb_class_student', 'app.throttle', 'UPDATE') THEN
        RAISE EXCEPTION 'DUNG LAI: hoc vien ghi duoc app.throttle - tu go khoa dang nhap duoc';
    END IF;
    RAISE NOTICE 'OK: aivb_app da dung quyen';
END $$;
