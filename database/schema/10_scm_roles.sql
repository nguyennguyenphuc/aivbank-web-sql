-- =====================================================================
-- SupplyChain dataset - roles
-- =====================================================================
-- Nhan khuon 01_roles.sql cua AIV Bank, doi tien to sang `scm_`. Cung mot
-- nguyen tac: chu so huu KHONG dang nhap duoc, quyen doc di qua mot goi
-- NOLOGIN, va vai tro dang nhap cua API tach roi vai tro cua BI.
--
-- KHAC voi AIV Bank o mot cho, co chu y: SupplyChain chi co MOT database.
-- AIV Bank tach hai database vat ly vi trong du lieu co bang dap an
-- (meta_dirty_log, meta_scenario_label). SupplyChain khong co bang nao nhu
-- vay - dap an cua no nam o labs/vn/*.py, outputs/ va muc 6.7/10 cua data
-- dictionary, tuc la FILE chu khong phai BANG. Nhan doi 15 GB `sales` chi de
-- giau vai dong KPI la vo ly, nen o day hoc vien va giang vien doc cung mot
-- database. Viec tach vai tro nam ngoai database: phat ban data dictionary
-- da rut gon cho hoc vien.
--
-- Chay bang superuser:
--   psql -h 127.0.0.1 -U postgres -f database/schema/10_scm_roles.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------
-- 1. Chu so huu - NOLOGIN
-- --------------------------------------------------------------------
-- Khong ton tai bo thong tin dang nhap nao co the DROP mot bang cua
-- SupplyChain. Muon sua cau truc thi phai la superuser, co chu y.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_owner') THEN
        CREATE ROLE scm_owner NOLOGIN;
    END IF;
END
$$;

-- --------------------------------------------------------------------
-- 2. Goi quyen doc - NOLOGIN
-- --------------------------------------------------------------------
-- Moi GRANT SELECT deu cap cho goi nay, khong bao gio cap thang cho mot
-- vai tro dang nhap. Them mot nguoi dung moi = GRANT scm_reader cho ho.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_reader') THEN
        CREATE ROLE scm_reader NOLOGIN;
    END IF;
END
$$;

-- --------------------------------------------------------------------
-- 3. Vai tro dang nhap
-- --------------------------------------------------------------------
-- `scm_loader` chi dung luc nap du lieu. Sau khi nap xong nen tat dang nhap:
--     ALTER ROLE scm_loader NOLOGIN;
-- `scm_api` la vai tro backend dung. `scm_bi` danh cho Excel/Power BI noi
-- thang vao PostgreSQL - voi ho, bien an ninh la GRANT o day chu khong phai
-- guard.py (ARCHITECTURE.md muc 3).
-- CONNECTION LIMIT lay dung khuon `01_roles.sql`: Power BI mo 4-8 ket noi moi
-- lan refresh, nen han muc BI phai rong hon API, nhung van huu han de mot lop
-- dong nguoi khong lam can `max_connections` cua ca cluster (nay la 350, xem
-- docker-compose.override.yml; ghi "200" truoc day la sai, va
-- AIV Bank da chiem 8+12+8+40+10).
--
-- Thieu han muc KHONG bao loi gi: no chi hien ra vao dung luc te nhat - ca lop
-- refresh cung luc, cluster het slot, va ke ca backend lan cong cu quan tri deu
-- khong ket noi duoc nua.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_loader') THEN
        CREATE ROLE scm_loader LOGIN INHERIT PASSWORD NULL
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 8;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_api') THEN
        CREATE ROLE scm_api LOGIN INHERIT PASSWORD NULL
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 12;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scm_bi') THEN
        CREATE ROLE scm_bi LOGIN INHERIT PASSWORD NULL
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
            CONNECTION LIMIT 20;
    END IF;
END
$$;

-- Ba vai tro tren co the da ton tai tu lan chay truoc ma chua co han muc; khoi
-- CREATE o tren se bo qua chung. Ap lai bang ALTER de file nay that su idempotent.
ALTER ROLE scm_loader CONNECTION LIMIT 8;
ALTER ROLE scm_api    CONNECTION LIMIT 12;
ALTER ROLE scm_bi     CONNECTION LIMIT 20;
ALTER ROLE scm_loader NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE scm_api    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE scm_bi     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Ca hai vai tro dang nhap deu chi nhan quyen DOC, qua goi.
GRANT scm_reader TO scm_api, scm_bi;

-- Loader can quyen ghi, nen no - va chi no - duoc lam chu so huu.
GRANT scm_owner TO scm_loader;

-- --------------------------------------------------------------------
-- 4. Siet tham so o CAP VAI TRO
-- --------------------------------------------------------------------
-- BAT BUOC, khong phai toi uu. `backend/config.py::pg_required_settings()` liet
-- ke `lc_messages` va `temp_file_limit`; ca hai la SUSET, nghia la ung dung chi
-- KIEM duoc chu khong DAT duoc. `backend/db.py::_configure` doc lai chung tren
-- moi ket noi va NEM SessionSettingError neu lech - nen thieu dong duoi day thi
-- pool khong mo duoc va trieu chung la "pool initialization incomplete after
-- 30 sec", khong he nhac gi den temp_file_limit.
--
-- Vi tri khac AIV Bank, co chu y: ben do dat cac tham so nay trong
-- `03_schema_grants.sql` (dong 81-93), tuc la sau khi da co database. O day
-- chung nam ngay trong file role, vi SupplyChain chi co MOT database nen khong
-- can doi - va de moi thu ve mot vai tro nam trong mot file.
--
-- `lc_messages = C` khong chi de doc log: `AIVB_PG_LC_MESSAGES` khac C lam thong
-- bao loi cua engine doi ngon ngu, guard khong tai lap nguyen van duoc nua, va
-- hoc vien do duoc su ton tai cua cot (ARCHITECTURE.md muc 6).
ALTER ROLE scm_api SET default_transaction_read_only = on;
ALTER ROLE scm_api SET search_path = scm;
ALTER ROLE scm_api SET statement_timeout = '20s';
ALTER ROLE scm_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE scm_api SET lock_timeout = '2s';
ALTER ROLE scm_api SET work_mem = '64MB';
ALTER ROLE scm_api SET temp_file_limit = '2GB';
ALTER ROLE scm_api SET lc_messages = 'C';

-- Vai tro BI co ho so KHAC vai tro API, va su khac biet la co chu dinh. Power
-- BI / Excel / Tableau keo ca bang ve de lam mo hinh, chu khong chay mot cau
-- SELECT ngan nhu hoc vien tren web. Voi 125 trieu dong `sales`, mot lan refresh
-- that se cham tran `statement_timeout` 20s va tran `temp_file_limit` 2GB cua
-- ho so API, va thong bao bao ra la "canceling statement" chu khong noi rang
-- gioi han sai cho.
--
-- Cac con so duoi day lay dung theo `aivb_bi_student` / `aivb_bi_instructor`
-- da chay tren cluster nay, de hai bo du lieu hanh xu giong nhau voi cung mot
-- cong cu BI.
ALTER ROLE scm_bi SET default_transaction_read_only = on;
ALTER ROLE scm_bi SET search_path = scm;
ALTER ROLE scm_bi SET statement_timeout = '300s';
ALTER ROLE scm_bi SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE scm_bi SET lock_timeout = '5s';
ALTER ROLE scm_bi SET work_mem = '128MB';
ALTER ROLE scm_bi SET temp_file_limit = '8GB';
ALTER ROLE scm_bi SET lc_messages = 'C';

-- Loader thi KHONG chi-doc (no phai COPY vao) va khong bi tran temp file (no
-- dung index tren 125 trieu dong).
ALTER ROLE scm_loader SET search_path = scm;
ALTER ROLE scm_loader SET lc_messages = 'C';

-- --------------------------------------------------------------------
-- 5. Mat khau
-- --------------------------------------------------------------------
-- Cac vai tro tren duoc tao voi PASSWORD NULL: chung ton tai nhung chua
-- dang nhap duoc. Dat mat khau rieng, KHONG ghi vao file nay:
--     ALTER ROLE scm_api    PASSWORD '...';
--     ALTER ROLE scm_bi     PASSWORD '...';
--     ALTER ROLE scm_loader PASSWORD '...';
-- roi luu vao config/pg_secrets.env theo dung khuon pw_api_s / pw_api_i.
