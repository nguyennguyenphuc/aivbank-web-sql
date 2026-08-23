-- AIV Bank v5.1.6.4 - tao hai database PostgreSQL 18
--
--   psql -U postgres -f deploy/postgres/02_databases.sql
--
-- Chay SAU 01_roles.sql. Idempotent.
--
-- ===========================================================================
-- DIEU QUAN TRONG NHAT TRONG FILE NAY: LC_COLLATE PHAI LA 'C'
-- ===========================================================================
-- DuckDB so sanh VARCHAR theo THU TU BYTE UTF-8. Da do tren DuckDB 1.3.2:
--     SELECT 'a' < 'B'  ->  false          (vi 'a'=0x61 > 'B'=0x42)
--     ORDER BY  ->  Anh, Ba, Banana, Zebra, anh, apple, ba, cherry, zebra
--
-- Cluster nay mac dinh 'English_United States.1252', duoi locale do
-- 'a' < 'B' la TRUE va thu tu sap xep hoan toan khac.
--
-- Goi hoc vien co 272 cot text. Neu de mac dinh thi MOI cau ORDER BY tren cot
-- text, moi min()/max() tren text, moi LIKE va moi phep so sanh chuoi deu tra
-- ket qua KHAC voi ban DuckDB da duoc nghiem thu - tuc la khac dap an cham bai.
--
-- Va day la phan nguy hiem nhat: phep doi chieu parity bang md5 KHONG phat hien
-- duoc loi nay. md5 bam noi dung tung dong, hoan toan mu voi thu tu sap xep.
-- Parity se bao PASS trong khi bai cham thi sai. Cho nen ep collation o ngay
-- lenh CREATE DATABASE la BIEN PHAP DUY NHAT, khong the de kiem thu bat sau.
--
-- 'builtin' provider (PostgreSQL 17+) duoc chon thay cho libc vi no nhanh hon
-- va on dinh qua cac lan nang cap he dieu hanh; libc 'C' cung dung ve ket qua.
-- ===========================================================================

\set ON_ERROR_STOP on

SELECT format(
    'CREATE DATABASE %I OWNER aivb_owner TEMPLATE template0 '
    'ENCODING ''UTF8'' LOCALE_PROVIDER ''builtin'' BUILTIN_LOCALE ''C''',
    d.name)
FROM (VALUES ('aivb_student'), ('aivb_instructor')) AS d(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d.name)
\gexec

-- --------------------------------------------------------------------------
-- Khang dinh collation da dung.
--
-- CHU Y - da mac bay nay mot lan: voi provider 'builtin' thi hai cot
-- `datcollate`/`datctype` VAN mang gia tri libc cu (o may nay la
-- 'English_United States.1252') va HOAN TOAN KHONG dieu khien hanh vi so sanh.
-- Cot quyet dinh la `datlocprovider` + `datlocale`. Kiem nham hai cot kia se
-- bao dong gia tren mot database that ra da dung.
--
-- Chap nhan hai cau hinh:
--   provider 'b' (builtin) + datlocale = 'C'
--   provider 'c' (libc)    + datcollate = 'C'
--
-- Neu database duoc tao truoc do bang mac dinh thi DUNG LAI - phai DROP va tao
-- lai, khong ALTER duoc collation cua database da co du lieu.
-- --------------------------------------------------------------------------
DO $$
DECLARE
    bad text;
BEGIN
    SELECT string_agg(format('%s (provider=%s locale=%s collate=%s)',
                             datname, datlocprovider,
                             coalesce(datlocale, '<null>'), datcollate), '; ')
      INTO bad
      FROM pg_database
     WHERE datname IN ('aivb_student', 'aivb_instructor')
       AND NOT (
             (datlocprovider = 'b' AND datlocale  IN ('C', 'C.UTF-8'))
          OR (datlocprovider = 'c' AND datcollate IN ('C', 'C.UTF-8'))
       );
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION
            'DUNG LAI: collation sai tren %. Phai la C. '
            'Database da ton tai voi collation khac phai DROP va tao lai - '
            'khong ALTER duoc. Xem phan dau file nay de biet vi sao.', bad;
    END IF;
END $$;

-- Phep kiem bang HANH VI (quan trong hon kiem metadata o tren) nam trong
-- 03_schema_grants.sql, vi no phai chay BEN TRONG tung database moi - chay o
-- day la dang do locale cua database `postgres`, khong lien quan gi.

-- --------------------------------------------------------------------------
-- Bien gioi cung giua hai goi.
--
-- Day la dong quan trong nhat ve bao mat trong ca he thong moi: vai tro hoc
-- vien khong co CONNECT tren aivb_instructor. Duoi DuckDB, viec tach goi phu
-- thuoc vao `db_for_role()` tra ve doi tuong Database nao - mot loi dinh tuyen
-- la giao nham ca file dap an. Duoi PostgreSQL, mot loi dinh tuyen chi lam
-- hoc vien cam mot bo thong tin dang nhap KHONG MO NOI ket noi toi
-- aivb_instructor. Sai sot tro thanh loi ket noi, khong con la ro ri du lieu.
-- --------------------------------------------------------------------------
REVOKE ALL ON DATABASE aivb_student    FROM PUBLIC;
REVOKE ALL ON DATABASE aivb_instructor FROM PUBLIC;

GRANT CONNECT ON DATABASE aivb_student TO
    aivb_loader, aivb_api_student, aivb_bi_student,
    aivb_api_instructor, aivb_bi_instructor;

GRANT CONNECT ON DATABASE aivb_instructor TO
    aivb_loader, aivb_api_instructor, aivb_bi_instructor;
-- aivb_api_student va aivb_bi_student: KHONG CO CONNECT o tren. Co y.

REVOKE TEMPORARY ON DATABASE aivb_student    FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE aivb_instructor FROM PUBLIC;

-- --------------------------------------------------------------------------
-- Tham so cap database.
--
-- lc_messages='C' giu cho van ban thong bao loi la tieng Anh co dinh. Tang
-- guard cua API tai lap NGUYEN VAN thong bao "column ... does not exist" de mot
-- cot bi giau khong phan biet duoc voi mot cot go sai. Neu lc_messages doi theo
-- locale cua may thi tinh chat do vo, va hoc vien do duoc su ton tai cua cot.
--
-- DateStyle/TimeZone co dinh de ket qua khong phu thuoc phien lam viec.
-- jit=off vi thoi gian bien dich JIT lon hon ca truy van 15 giay cua hoc vien.
-- --------------------------------------------------------------------------
ALTER DATABASE aivb_student    SET lc_messages         = 'C';
ALTER DATABASE aivb_student    SET DateStyle           = 'ISO, YMD';
ALTER DATABASE aivb_student    SET TimeZone            = 'UTC';
ALTER DATABASE aivb_student    SET client_min_messages = error;
ALTER DATABASE aivb_student    SET jit                 = off;

ALTER DATABASE aivb_instructor SET lc_messages         = 'C';
ALTER DATABASE aivb_instructor SET DateStyle           = 'ISO, YMD';
ALTER DATABASE aivb_instructor SET TimeZone            = 'UTC';
ALTER DATABASE aivb_instructor SET client_min_messages = error;
ALTER DATABASE aivb_instructor SET jit                 = off;

\echo 'OK: 02_databases.sql hoan tat.'
