-- AIV Bank v5.1.6.4 - schema `aivb` + quyen doc, chay MOT LAN CHO MOI DATABASE.
--
--   psql -U postgres -d aivb_student    -f deploy/postgres/03_schema_grants.sql ^
--        -v reader=aivb_reader_student -v api=aivb_api_student -v bi=aivb_bi_student
--
--   psql -U postgres -d aivb_instructor -f deploy/postgres/03_schema_grants.sql ^
--        -v reader=aivb_reader_instructor -v api=aivb_api_instructor -v bi=aivb_bi_instructor
--
-- Mot file dung cho ca hai database, tham so hoa bang bien psql, de hai ben
-- khong thoat ly nhau qua thoi gian. Idempotent.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Phep kiem collation bang HANH VI - chay TRUOC moi thu khac.
--
-- Kiem metadata o 02_databases.sql de bat cau hinh sai; kiem o day de bat
-- HANH VI sai, ke ca vi mot nguyen nhan chua ai nghi ra. Da mac bay mot lan:
-- voi provider 'builtin' thi `datcollate` van mang gia tri libc cu va khong he
-- dieu khien so sanh - nhin metadata thi tuong sai, do hanh vi thi moi biet dung.
--
-- Duoi thu tu byte (giong DuckDB 1.3.2) thi 'a'=0x61 > 'B'=0x42 nen 'a' < 'B'
-- la FALSE. Duoi locale en_US thi nguoc lai, va khi do moi ORDER BY / min / max
-- / LIKE tren 272 cot text cua goi hoc vien deu lech dap an cham bai - trong im
-- lang, vi khong co loi nao duoc nem ra.
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF ('a' < 'B') THEN
        RAISE EXCEPTION
            'DUNG LAI: so sanh chuoi khong theo thu tu byte trong database %. '
            'Do duoc ''a'' < ''B'' = true; DuckDB 1.3.2 cho false. Database nay '
            'phai duoc tao lai voi BUILTIN_LOCALE ''C'' - khong ALTER duoc.',
            current_database();
    END IF;
END $$;

-- --------------------------------------------------------------------------
-- Bo schema `public`.
--
-- Khong dung den no, va de lai thi no la mot khong gian ten ma nguoi dung co
-- the tro toi. Bo han de chi con dung mot schema `aivb`, khien phep kiem schema
-- o tang guard (`api/guard.py`) tro thanh mot phep so sanh duy nhat.
-- --------------------------------------------------------------------------
DROP SCHEMA IF EXISTS public CASCADE;

CREATE SCHEMA IF NOT EXISTS aivb AUTHORIZATION aivb_owner;
REVOKE ALL ON SCHEMA aivb FROM PUBLIC;

GRANT USAGE ON SCHEMA aivb TO :reader;

-- Quyen doc o CAP BANG. Khong bao gio o cap cot - xem phan cuoi file.
GRANT SELECT ON ALL TABLES IN SCHEMA aivb TO :reader;

-- Bang tao SAU nay cung tu dong duoc doc, de mot lan nap lai du lieu khong
-- lam mat quyen ma khong ai nhan ra.
ALTER DEFAULT PRIVILEGES FOR ROLE aivb_owner IN SCHEMA aivb
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE aivb_owner IN SCHEMA aivb
    GRANT SELECT ON TABLES TO :reader;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA aivb FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aivb FROM PUBLIC;

-- --------------------------------------------------------------------------
-- Tham so theo vai tro.
--
-- API phuc vu console hoc vien: truy van ngan, cat som, giu tai nguyen cho
-- nguoi khac. BI thi nguoc lai - mot lan refresh Power BI quet ca bang 29 trieu
-- dong la binh thuong - nen duoc noi thoi gian va bo nho tam, nhung van huu han.
--
-- LUU Y VE `default_transaction_read_only`:
-- Day KHONG PHAI mot bien phap bao mat. Bat ky client nao cung co the tu chay
-- `SET default_transaction_read_only = off`. Thu THUC SU chan ghi la viec cac
-- vai tro nay chi duoc GRANT SELECT, khong he co INSERT/UPDATE/DELETE/DDL.
-- Dung viet trong bat ky tai lieu nao rang "chi doc duoc bao dam boi tham so
-- nay" - no chi la tien nghi va mot lop luoi thu hai.
-- --------------------------------------------------------------------------
ALTER ROLE :api SET default_transaction_read_only            = on;
ALTER ROLE :api SET search_path                              = 'aivb';
ALTER ROLE :api SET statement_timeout                        = '20s';
ALTER ROLE :api SET idle_in_transaction_session_timeout      = '30s';
ALTER ROLE :api SET lock_timeout                             = '2s';
ALTER ROLE :api SET work_mem                                 = '64MB';
ALTER ROLE :api SET temp_file_limit                          = '2GB';

ALTER ROLE :bi  SET default_transaction_read_only            = on;
ALTER ROLE :bi  SET search_path                              = 'aivb';
ALTER ROLE :bi  SET statement_timeout                        = '300s';
ALTER ROLE :bi  SET idle_in_transaction_session_timeout      = '120s';
ALTER ROLE :bi  SET lock_timeout                             = '5s';
ALTER ROLE :bi  SET work_mem                                 = '128MB';
ALTER ROLE :bi  SET temp_file_limit                          = '8GB';

-- --------------------------------------------------------------------------
-- Go mot vai ham chi de lam phien.
--
-- Danh gia thanh that: viec nay it gia tri. Mot hoc vien co the lam nghen dich
-- vu de dang hon nhieu bang mot phep join cartesian tren bang 29 trieu dong, va
-- ca hai deu bi `statement_timeout` chan nhu nhau. Go pg_sleep KHONG phai mot
-- bien phap bao mat dang ke.
--
-- Van lam vi no gan nhu mien phi va bo di mot cong cu chiem giu ket noi ma
-- khong ai co ly do chinh dang de dung trong mot lop hoc phan tich du lieu.
-- Da kiem: cac ham nguy hiem that su (pg_read_file, pg_ls_dir, lo_import,
-- COPY ... TO FILE / FROM PROGRAM) DA bi PostgreSQL tu choi san cho vai tro
-- khong phai superuser - khong can lam gi them.
DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'pg_sleep(double precision)',
        'pg_sleep_for(interval)',
        'pg_sleep_until(timestamp with time zone)'
    ] LOOP
        BEGIN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.%s FROM PUBLIC', fn);
        EXCEPTION WHEN undefined_function THEN
            RAISE NOTICE 'bo qua %, khong co trong ban PostgreSQL nay', fn;
        END;
    END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Phep kiem: KHONG duoc co quyen o cap cot.
--
-- Cach "hien nhien" de giau `raw_account_transaction.dirty_flag` tren Postgres
-- la REVOKE SELECT (dirty_flag). No SAI, va sai theo huong khien nguoi lam
-- tuong minh vua siet chat them:
--
--   1) No tao ra kenh do su ton tai.
--        SELECT dirty_flag  ... -> 42501 permission denied for table ...
--        SELECT dirty_flagg ... -> 42703 column "dirty_flagg" does not exist
--      Hai ma loi khac nhau, hai cau chu khac nhau, tu hai duong code khac nhau
--      trong pha phan tich cu phap. Khong co cach nao viet lai thong bao o tang
--      ung dung de xoa khac biet nay, vi chinh ung dung phai biet cau tra loi
--      moi viet lai duoc.
--
--   2) PostgreSQL khai trien `SELECT *` ra TOAN BO cot TRUOC khi kiem quyen,
--      nen `SELECT * FROM raw_account_transaction` se hong voi MOI hoc vien -
--      pha bai tap ve bang landing.
--
-- Cach dung: cot do KHONG TON TAI VAT LY trong aivb_student. Xem
-- generator/build_pg_schema.py va generator/build_student_db.py::visibility_split.
-- --------------------------------------------------------------------------
-- Doc thang pg_attribute.attacl chu KHONG dung
-- information_schema.column_privileges: view do con liet ke ca quyen SUY RA tu
-- GRANT cap bang, nen no se bao dong gia ngay sau GRANT SELECT ON ALL TABLES.
-- `attacl` chi khac NULL khi that su co GRANT/REVOKE cap cot.
DO $$
DECLARE
    bad text;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ')
      INTO bad
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'aivb'::regnamespace
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attacl IS NOT NULL;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION
            'DUNG LAI: co quyen cap COT tren %. Khong duoc dung GRANT/REVOKE '
            'cap cot o he thong nay - no tao kenh do su ton tai. Xem giai thich '
            'trong deploy/postgres/03_schema_grants.sql.', bad;
    END IF;
END $$;

\echo 'OK: 03_schema_grants.sql hoan tat.'
