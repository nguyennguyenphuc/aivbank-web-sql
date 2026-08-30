-- AIV Bank - nhom vai tro cho tung hoc vien / giang vien
-- =====================================================================
--   psql -U postgres -f database/schema/15_class_roles.sql
--
-- Chay SAU 01_roles.sql (can aivb_reader_student / aivb_reader_instructor).
-- Idempotent.
--
-- ---------------------------------------------------------------------
-- VI SAO CO FILE NAY
-- ---------------------------------------------------------------------
-- Truoc day ca lop dung chung `aivb_bi_student` khi noi Power BI. Hau qua:
-- `pg_stat_activity` chi thay MOT cai ten, khong biet ai chay truy van nao,
-- va thu hoi mot em thi ca lop mat quyen theo.
--
-- Ly do goc: `sv001`/`gv001` song trong SQLite, con Power BI xac thuc voi
-- `pg_authid`. Chuyen bang `users` sang PostgreSQL KHONG giai quyet duoc -
-- Power BI khong xac thuc voi mot bang ung dung. Dong bo that buoc phai co
-- nghia la MOI NGUOI LA MOT VAI TRO PostgreSQL.
--
-- File nay dung phan HA TANG cho viec do: hai nhom, tran ket noi, va tham
-- so KDF. Vai tro cua tung nguoi do `backend/pgroles.py` tao.
-- ---------------------------------------------------------------------

\set ON_ERROR_STOP on

-- =====================================================================
-- 1. So vong lap KDF - PHAI DAT TRUOC KHI TAO BAT KY MAT KHAU NAO
-- =====================================================================
-- Kho SQLite cu bam mat khau bang scrypt N=2^15, r=8 (~132 MB, memory-hard).
-- PostgreSQL mac dinh SCRAM-SHA-256 voi `scram_iterations = 4096` - PBKDF2
-- 4096 vong, YEU HON NHIEU BAC truoc tan cong offline. Day la thu duy nhat
-- thuc su yeu di khi bo SQLite, nen phai bu lai.
--
-- Gia tri chi duoc ap LUC DAT MAT KHAU. Doi no sau khong hoi to len cac mat
-- khau da tao - nen dong nay phai chay TRUOC buoc di tru.
--
-- Vi sao 100000 chu khong phai 600000: trong SCRAM, phan lap PBKDF2 do
-- CLIENT tinh, server chi so HMAC. Nang no khong lam nang server, nhung MOI
-- KET NOI phai tra (~30-60 ms o muc 100k). Power BI mo 4-8 ket noi moi lan
-- refresh, nen dat qua cao la lam cham chinh nguoi dung.
ALTER SYSTEM SET scram_iterations = 100000;
SELECT pg_reload_conf();

-- =====================================================================
-- 2. Hai nhom (NOLOGIN)
-- =====================================================================
-- Dung nhom RIENG chu khong dung thang `aivb_reader_student` trong pg_hba:
-- goi doc do da co `aivb_api_student` va `aivb_bi_student` lam thanh vien,
-- nen `+aivb_reader_student` se mo lai dung may vai tro ma
-- 14_pg_hba_docker.conf vua chan.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_student') THEN
        CREATE ROLE aivb_class_student NOLOGIN
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_class_instructor') THEN
        CREATE ROLE aivb_class_instructor NOLOGIN
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- CHU Y HUONG MUI TEN - day la cho hong dat nhat trong ca file
--
-- `01_roles.sql` dong 95-99 canh bao: `aivb_bi_student` KHONG BAO GIO duoc
-- gan `aivb_reader_instructor`, vi do la duong ro ri dap an cham bai. Nhom
-- hoc vien o day phai giu dung bat doi xung ay.
--
-- Sai mot dong o duoi la ca lop doc duoc bang dap an, va KHONG CO trieu
-- chung nao bao. `backend/tests/test_class_roles.py` muc 1-2 ton tai de bat
-- dung viec nay - dung xoa no.
-- ---------------------------------------------------------------------
GRANT aivb_reader_student    TO aivb_class_student;

GRANT aivb_reader_student    TO aivb_class_instructor;
GRANT aivb_reader_instructor TO aivb_class_instructor;

-- Bo SupplyChain: CA HAI nhom doc chung, khong tach doi nhu AIV Bank.
-- Ly do o README.md dong 114-119: SCM khong co bang dap an trong du lieu
-- (dap an cua no nam o labs/vn/*.py va MO-TA-BO-DU-LIEU.md - deu la file
-- ngoai database), nen khong co gi de giau giua hoc vien va giang vien.
--
-- `scm_reader` do 10_scm_roles.sql tao. Neu chua chay file do thi khoi DO
-- ben duoi bo qua, va lane SCM chi don gian la chua dung duoc.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_reader') THEN
        EXECUTE 'GRANT scm_reader TO aivb_class_student';
        EXECUTE 'GRANT scm_reader TO aivb_class_instructor';
        RAISE NOTICE 'da cap scm_reader cho hai nhom';
    ELSE
        RAISE NOTICE 'chua co scm_reader - bo qua lane SupplyChain';
    END IF;
END $$;

-- =====================================================================
-- 2b. Quyen CONNECT o TANG DATABASE - lop bao ve thu hai
-- =====================================================================
-- `02_databases.sql` dong 92-101 REVOKE ALL FROM PUBLIC roi cap CONNECT cho
-- TUNG VAI TRO DANG NHAP, khong cap cho goi doc. Nen thanh vien nhom KHONG
-- thua huong CONNECT, va do la ly do `aivb_class_student` noi vao
-- aivb_student bi bao "permission denied for database".
--
-- (Lane SCM khong dinh loi nay: `12_scm_schema_grants.sql` cap CONNECT cho
-- chinh `scm_reader`, ma hai nhom la thanh vien cua no.)
--
-- Chu thich o 02_databases.sql dong 82-91 goi day la "dong quan trong nhat
-- ve bao mat trong ca he thong": hoc vien KHONG CO CONNECT tren
-- aivb_instructor, nen mot loi dinh tuyen chi lam ho cam mot bo thong tin
-- dang nhap khong mo noi ket noi - sai sot thanh LOI KET NOI chu khong thanh
-- RO RI DU LIEU.
--
-- Hai dong duoi giu nguyen tinh chat do. `aivb_class_student` KHONG xuat
-- hien o dong aivb_instructor, va do la co y - dung "sua" bang cach them vao.
GRANT CONNECT ON DATABASE aivb_student    TO aivb_class_student;
GRANT CONNECT ON DATABASE aivb_student    TO aivb_class_instructor;
GRANT CONNECT ON DATABASE aivb_instructor TO aivb_class_instructor;

-- =====================================================================
-- 3. Tran ket noi TONG - dung bo qua muc nay
-- =====================================================================
-- Truoc day `aivb_bi_student` co CONNECTION LIMIT 40, va vi ca lop dung
-- chung mot vai tro nen 40 la TRAN CUNG cho toan bo luu luong BI.
--
-- Moi nguoi mot vai tro thi tran do bien mat, va tran theo vai tro KHONG cong
-- thanh tran tong. `ALTER DATABASE ... CONNECTION LIMIT` khoi phuc tinh chat do.
--
-- PHEP TINH, cap nhat 2026-08-30 sau su co Power BI cua sv001:
--
--   Tran moi nguoi len 8 (xem `backend/pgroles.py`, DEFAULT_CONNECTION_LIMIT -
--   4 lam Power BI hong ngay voi mo hinh nhieu hon mot bang). Cao diem 10 nguoi
--   cung luc:
--
--       10 nguoi x 8 = 80  ket noi cho lop
--       pool ung dung    ~15
--       superuser          3
--       -------------------------
--       tong             ~98
--
--   Vi vay `max_connections` da nang 100 -> 150 o
--   `docker/docker-compose.override.yml`. Neu chay ban bare-metal thi phai tu
--   dat, PostgreSQL mac dinh la 100 va cum se cham tran truoc lop.
--
-- Tong ba tran duoi day CO Y vuot `max_connections`: khong bao gio ca ba
-- database day cung luc, va `max_connections` moi la buc tuong that.
ALTER DATABASE aivb_student    CONNECTION LIMIT 80;
ALTER DATABASE aivb_instructor CONNECTION LIMIT 30;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'scm') THEN
        EXECUTE 'ALTER DATABASE scm CONNECTION LIMIT 80';
    END IF;
END $$;

-- =====================================================================
-- 4. Tham so phien mac dinh theo DATABASE
-- =====================================================================
-- `ALTER ROLE ... SET` KHONG di truyen qua thanh vien nhom. Neu dat tren
-- nhom thi vai tro cua tung nguoi van khong co gi - phai dat tren tung vai
-- tro dang nhap, tuc la N lenh moi lan them mot hoc vien.
--
-- Dat mac dinh o tang database thi khong phai lam vay. Tham so theo VAI TRO
-- van thang mac dinh nay, nen `aivb_api_student` giu nguyen 20s ma
-- `03_schema_grants.sql` dong 81 da dat tuong minh.
ALTER ROLE ALL IN DATABASE aivb_student SET default_transaction_read_only       = on;
ALTER ROLE ALL IN DATABASE aivb_student SET search_path                         = 'aivb';
ALTER ROLE ALL IN DATABASE aivb_student SET statement_timeout                   = '300s';
ALTER ROLE ALL IN DATABASE aivb_student SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE ALL IN DATABASE aivb_student SET lock_timeout                        = '5s';
ALTER ROLE ALL IN DATABASE aivb_student SET work_mem                            = '128MB';
ALTER ROLE ALL IN DATABASE aivb_student SET temp_file_limit                     = '8GB';

ALTER ROLE ALL IN DATABASE aivb_instructor SET default_transaction_read_only       = on;
ALTER ROLE ALL IN DATABASE aivb_instructor SET search_path                         = 'aivb';
ALTER ROLE ALL IN DATABASE aivb_instructor SET statement_timeout                   = '300s';
ALTER ROLE ALL IN DATABASE aivb_instructor SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE ALL IN DATABASE aivb_instructor SET lock_timeout                        = '5s';
ALTER ROLE ALL IN DATABASE aivb_instructor SET work_mem                            = '128MB';
ALTER ROLE ALL IN DATABASE aivb_instructor SET temp_file_limit                     = '8GB';

-- --------------------------------------------------------------------
-- MIEN TRU cho cac vai tro PHAI GHI DUOC.
--
-- `ALL IN DATABASE` ap cho MOI vai tro, ke ca `postgres` va `aivb_loader`.
-- Thieu khoi nay thi `03_schema_grants.sql` chet ngay dong 45 voi
-- "cannot execute DROP SCHEMA in a read-only transaction", va ca buoc
-- `restore.py restore` khong chay duoc nua.
--
-- `default_transaction_read_only` von KHONG phai bien phap bao mat -
-- `03_schema_grants.sql` dong 72-78 noi ro dieu do: bat ky client nao cung
-- tu tat duoc no. Thu that su chan ghi la cac vai tro doc chi duoc GRANT
-- SELECT. O day no chi la luoi thu hai, nen mien tru khong lam yeu gi.
-- --------------------------------------------------------------------
DO $$
DECLARE
    db   text;
    who  text;
BEGIN
    FOREACH db IN ARRAY ARRAY['aivb_student', 'aivb_instructor'] LOOP
        FOREACH who IN ARRAY ARRAY['postgres', 'aivb_owner', 'aivb_loader'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who) THEN
                EXECUTE format(
                    'ALTER ROLE %I IN DATABASE %I SET default_transaction_read_only = off',
                    who, db);
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- SCM dung schema `scm`, khong phai `aivb`.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'scm') THEN
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET default_transaction_read_only       = on$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET search_path                         = 'scm'$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET statement_timeout                   = '300s'$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET idle_in_transaction_session_timeout = '120s'$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET lock_timeout                        = '5s'$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET work_mem                            = '128MB'$q$;
        EXECUTE $q$ALTER ROLE ALL IN DATABASE scm SET temp_file_limit                     = '8GB'$q$;
        -- Cung mien tru nhu tren, cho cac vai tro ghi duoc cua SCM.
        FOR i IN 1..3 LOOP
            EXECUTE format(
                'ALTER ROLE %I IN DATABASE scm SET default_transaction_read_only = off',
                (ARRAY['postgres', 'scm_owner', 'scm_loader'])[i]);
        END LOOP;
    END IF;
END $$;

-- =====================================================================
-- 5. Khang dinh - hong o day con hon hong luc dang day
-- =====================================================================
DO $$
DECLARE
    n int;
BEGIN
    -- Nhom hoc vien TUYET DOI khong duoc la thanh vien cua goi giang vien.
    SELECT count(*) INTO n
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles g ON g.oid = m.member
    WHERE g.rolname = 'aivb_class_student'
      AND r.rolname = 'aivb_reader_instructor';
    IF n > 0 THEN
        RAISE EXCEPTION 'DUNG LAI: aivb_class_student dang co aivb_reader_instructor - day la duong ro ri dap an cham bai';
    END IF;

    -- Nhom giang vien phai co CA HAI goi.
    SELECT count(*) INTO n
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles g ON g.oid = m.member
    WHERE g.rolname = 'aivb_class_instructor'
      AND r.rolname IN ('aivb_reader_student', 'aivb_reader_instructor');
    IF n <> 2 THEN
        RAISE EXCEPTION 'aivb_class_instructor phai co ca hai goi doc, dang co %', n;
    END IF;

    -- Lop thu hai: hoc vien khong duoc co CONNECT tren aivb_instructor.
    -- Kiem ca hai lop vi chung doc lap nhau - pg_hba co the dung ma CONNECT
    -- sai, hoac nguoc lai.
    IF has_database_privilege('aivb_class_student', 'aivb_instructor', 'CONNECT') THEN
        RAISE EXCEPTION 'DUNG LAI: aivb_class_student co CONNECT tren aivb_instructor - xem 02_databases.sql dong 82-91';
    END IF;

    IF NOT has_database_privilege('aivb_class_student', 'aivb_student', 'CONNECT') THEN
        RAISE EXCEPTION 'aivb_class_student thieu CONNECT tren aivb_student';
    END IF;
    IF NOT has_database_privilege('aivb_class_instructor', 'aivb_instructor', 'CONNECT') THEN
        RAISE EXCEPTION 'aivb_class_instructor thieu CONNECT tren aivb_instructor';
    END IF;

    RAISE NOTICE 'OK: hai nhom da dung, bat doi xung chong ro ri con nguyen (ca vai tro lan CONNECT)';
END $$;
