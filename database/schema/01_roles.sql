-- AIV Bank v5.1.6.4 - vai tro PostgreSQL 18
--
-- Chay bang superuser, KHONG chua mat khau trong file nay:
--   psql -U postgres -f deploy/postgres/01_roles.sql ^
--        -v pw_loader=... -v pw_api_s=... -v pw_api_i=... ^
--        -v pw_bi_s=...   -v pw_bi_i=...
--
-- Idempotent: chay lai nhieu lan khong loi.
--
-- ---------------------------------------------------------------------------
-- Vi sao tach chu so huu / vai tro quyen / vai tro dang nhap
-- ---------------------------------------------------------------------------
-- Chu so huu (aivb_owner) la NOLOGIN: khong ton tai bo thong tin dang nhap nao
-- co the DROP mot bang. Quyen doc di qua hai "goi quyen" NOLOGIN, va cac vai tro
-- dang nhap chi la thanh vien cua goi. Nho vay doi han muc ket noi hay timeout
-- cua BI khong dung gi den quyen, va thu hoi mot tai khoan khong keo theo thu
-- hoi quyen cua tai khoan khac.
--
-- API va BI dung vai tro dang nhap KHAC NHAU du cung quyen doc: timeout cua
-- console hoc vien la 20 giay, cua Power BI la 300 giay, va nhat ky ket noi
-- phai phan biet duoc hai duong nay.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Chu so huu doi tuong
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_owner') THEN
        CREATE ROLE aivb_owner NOLOGIN
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;

-- --------------------------------------------------------------------------
-- Goi quyen doc (NOLOGIN) - mot goi cho moi database
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_reader_student') THEN
        CREATE ROLE aivb_reader_student NOLOGIN
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_reader_instructor') THEN
        CREATE ROLE aivb_reader_instructor NOLOGIN
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;

-- --------------------------------------------------------------------------
-- Vai tro dang nhap
--
-- CONNECTION LIMIT khac nhau la co chu dinh: Power BI mo 4-8 ket noi moi lan
-- refresh, nen han muc cua BI phai rong hon API, nhung van huu han de mot lop
-- dong nguoi khong lam can max_connections cua ca cluster.
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_loader') THEN
        CREATE ROLE aivb_loader LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 8;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_api_student') THEN
        CREATE ROLE aivb_api_student LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 12;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_api_instructor') THEN
        CREATE ROLE aivb_api_instructor LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 8;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_bi_student') THEN
        CREATE ROLE aivb_bi_student LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 40;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aivb_bi_instructor') THEN
        CREATE ROLE aivb_bi_instructor LOGIN INHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 10;
    END IF;
END $$;

-- Dat/doi mat khau. Tach khoi CREATE de chay lai script la doi duoc mat khau.
ALTER ROLE aivb_loader         PASSWORD :'pw_loader';
ALTER ROLE aivb_api_student    PASSWORD :'pw_api_s';
ALTER ROLE aivb_api_instructor PASSWORD :'pw_api_i';
ALTER ROLE aivb_bi_student     PASSWORD :'pw_bi_s';
ALTER ROLE aivb_bi_instructor  PASSWORD :'pw_bi_i';

-- --------------------------------------------------------------------------
-- Gan goi quyen
--
-- CHU Y huong mui ten: aivb_api_instructor / aivb_bi_instructor duoc gan CA HAI
-- goi, vi giang vien phai xem duoc ca hai database. Nguoc lai thi KHONG:
-- aivb_api_student / aivb_bi_student KHONG BAO GIO duoc gan
-- aivb_reader_instructor. Do la duong ro ri dap an cham bai.
-- --------------------------------------------------------------------------
GRANT aivb_reader_student    TO aivb_api_student, aivb_bi_student;
GRANT aivb_reader_student    TO aivb_api_instructor, aivb_bi_instructor;
GRANT aivb_reader_instructor TO aivb_api_instructor, aivb_bi_instructor;

-- aivb_loader la vai tro DUY NHAT ghi duoc. No phai lam thanh vien cua
-- aivb_owner de tao bang, va script nap PHAI `SET ROLE aivb_owner` truoc khi
-- tao - co the bang do thuoc aivb_owner thi `ALTER DEFAULT PRIVILEGES FOR ROLE
-- aivb_owner` moi ap duoc quyen doc cho cac bang tao sau nay.
--
-- Sau moi dot nap, thu hoi kha nang dang nhap:
--     ALTER ROLE aivb_loader NOLOGIN;
-- de he thong o trang thai binh thuong khong ton tai bo thong tin dang nhap nao
-- ghi duoc vao du lieu da nghiem thu.
GRANT aivb_owner TO aivb_loader;

-- --------------------------------------------------------------------------
-- Phep kiem tu dong: khang dinh vai tro hoc vien KHONG he thuoc goi giang vien.
-- Dat ngay trong script bootstrap chu khong doi den luc kiem thu, vi mot dong
-- GRANT go nham o tren se lam ro ri toan bo dap an.
-- --------------------------------------------------------------------------
DO $$
DECLARE
    leaked text;
BEGIN
    SELECT string_agg(m.rolname, ', ')
      INTO leaked
      FROM pg_auth_members am
      JOIN pg_roles m ON m.oid = am.member
      JOIN pg_roles r ON r.oid = am.roleid
     WHERE r.rolname = 'aivb_reader_instructor'
       AND m.rolname IN ('aivb_api_student', 'aivb_bi_student');
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION
            'DUNG LAI: vai tro hoc vien (%) dang thuoc aivb_reader_instructor. '
            'Day la duong ro ri meta_dirty_log / meta_scenario_label.', leaked;
    END IF;
END $$;

\echo 'OK: 01_roles.sql hoan tat.'
