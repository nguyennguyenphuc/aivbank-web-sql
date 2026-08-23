-- =====================================================================
-- SupplyChain dataset - tablespace + database
-- =====================================================================
-- Chay bang superuser, SAU 10_scm_roles.sql:
--   psql -h 127.0.0.1 -U postgres -f database/schema/11_scm_database.sql
--
-- HAI DIEU QUAN TRONG, ca hai deu la loi im lang neu lam sai.
--
-- 1. TABLESPACE nam trong Web_SQL/, khong nam trong data directory.
--    README.md dong 3: "Thu muc nay tu chua". Du lieu SupplyChain ~13-17 GB;
--    data directory mac dinh nam tren o C: (con ~79 GB, da chua 36 GB cua
--    AIV Bank), con Web_SQL/ nam tren o D: (con ~281 GB).
--
--    Thu muc phai TON TAI va RONG truoc khi chay, va tai khoan chay service
--    PostgreSQL phai ghi duoc vao do. Xem scripts/setup_scm.ps1.
--
-- 2. BUILTIN_LOCALE 'C' la BAT BUOC, khong phai tuy chon.
--    ARCHITECTURE.md muc 4: phep kiem parity dua tren md5 HOAN TOAN MU voi
--    collation va se bao PASS tren mot database sai. Chi co phep kiem hanh vi
--    (SELECT 'a' < 'B') bat duoc, va no chay o 12_scm_schema_grants.sql.
--    Neu tao database nay bang lenh khac ma quen locale, khong co gi bao cho
--    biet cho toi khi ket qua sap xep cua hoc vien lech khoi bai giang.
-- =====================================================================

\set ON_ERROR_STOP on

-- TABLESPACE LA TUY CHON.
--
-- No ton tai vi mot ly do CUC BO cua may Windows dang phat trien: data directory
-- nam tren o C: gan day, con Web_SQL nam tren o D: con nhieu cho. Tren mot VPS
-- mot o dia thi ly do do bien mat - va them tablespace o do la CO HAI: trong
-- Docker chi `/var/lib/postgresql/data` la volume, nen tablespace dat ngoai
-- duong dan do se nam trong LOP CONTAINER va bay mat khi container duoc tao lai.
-- Mat 9 GB, lang le, vao dung luc nguoi ta tuong minh chi restart mot dich vu.
--
-- Vay: may nay truyen -v scm_ts_path=...; docker-compose thi khong truyen gi.
\if :{?scm_ts_path}
  SELECT EXISTS (SELECT 1 FROM pg_tablespace WHERE spcname = 'scm_ts') AS ts_exists
  \gset
  \if :ts_exists
    \echo 'tablespace scm_ts da ton tai - bo qua'
  \else
    CREATE TABLESPACE scm_ts OWNER scm_owner LOCATION :'scm_ts_path';
  \endif
  \set scm_ts_clause 'TABLESPACE scm_ts'
\else
  \echo 'khong co scm_ts_path - dung tablespace mac dinh cua cluster'
  \set scm_ts_clause ''
\endif

SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'scm') AS db_exists
\gset

\if :db_exists
  \echo 'database scm da ton tai - bo qua'
\else
  CREATE DATABASE scm
      OWNER            scm_owner
      ENCODING         'UTF8'
      LOCALE_PROVIDER  'builtin'
      BUILTIN_LOCALE   'C'
      TEMPLATE         template0
      :scm_ts_clause;
\endif

-- Khong ai duoc ket noi vao `scm` chi vi ho ton tai tren cluster nay.
REVOKE ALL ON DATABASE scm FROM PUBLIC;
GRANT CONNECT ON DATABASE scm TO scm_reader, scm_loader;
