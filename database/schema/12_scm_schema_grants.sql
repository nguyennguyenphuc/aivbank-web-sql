-- =====================================================================
-- SupplyChain dataset - schema, 20 bang, GRANT
-- =====================================================================
-- Chay bang superuser, BEN TRONG database `scm`, sau 11_scm_database.sql:
--   psql -h 127.0.0.1 -U postgres -d scm -f database/schema/12_scm_schema_grants.sql
--
-- Nguyen tac giu nguyen tu AIV Bank (03_schema_grants.sql):
--   - chi GRANT SELECT CAP BANG, KHONG BAO GIO cap cot. Ly do day du o cuoi
--     file 03_schema_grants.sql: GRANT cap cot tao ra oracle do su ton tai
--     (42501 vs 42703) va pha `SELECT *`.
--   - kiem collation bang HANH VI truoc khi tao gi ca.
--   - xoa schema `public`, dat moi thu trong mot schema co ten.
--
-- VE KIEU DU LIEU: mot so cot la CHUOI chu khong phai DATE/NUMERIC, va do la
-- CO Y - dung nhu file nguon. `sales.date`, `inventory_snapshots.ym`,
-- `orders.order_date`, `purchase_orders.*_date` va `shipments.week` giu
-- nguyen dang chuoi cua bo du lieu goc. Doi chung sang DATE o day se lam
-- ket qua truy van cua hoc vien lech khoi bai lab va khoi data dictionary,
-- va lam mat mot bai hoc that (biet khi nao phai CAST).
-- =====================================================================

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------
-- 0. Phep kiem collation - hanh vi, khong phai metadata
-- --------------------------------------------------------------------
-- Xem ARCHITECTURE.md muc 4. Neu database nay bi tao thieu BUILTIN_LOCALE 'C'
-- thi day la cho duy nhat bat duoc, va no phai bat TRUOC khi co du lieu.
DO $$
BEGIN
    IF ('a' < 'B') THEN
        RAISE EXCEPTION
            'COLLATION SAI: database nay khong dung C. Sap xep chuoi se lech '
            'khoi bai giang va phep kiem md5 KHONG bat duoc. Tao lai database '
            'voi LOCALE_PROVIDER builtin / BUILTIN_LOCALE C.';
    END IF;
END
$$;

-- --------------------------------------------------------------------
-- 1. Schema
-- --------------------------------------------------------------------
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA IF NOT EXISTS scm AUTHORIZATION scm_owner;

GRANT USAGE ON SCHEMA scm TO scm_reader;

SET search_path = scm;

-- ====================================================================
-- 2. CHOM SAO A - bo sung hang B2B (bai 1)
-- ====================================================================

-- ------------------------------ dimensions -------------------------
CREATE TABLE IF NOT EXISTS city_geo (
    city    text PRIMARY KEY,
    lat     double precision,
    long    double precision
);

CREATE TABLE IF NOT EXISTS stores (
    store_nbr   smallint PRIMARY KEY,
    city        text,
    state       text,
    type        text,
    cluster     smallint
);

-- Mo rong 1:1 cua stores, giu rieng vi bo du lieu goc giu rieng.
CREATE TABLE IF NOT EXISTS store_attributes (
    store_nbr       smallint PRIMARY KEY REFERENCES stores(store_nbr),
    city            text,
    state           text,
    type            text,
    cluster         smallint,
    lat             double precision,
    long            double precision,
    area_m2         double precision,
    rent_month_usd  double precision
);

CREATE TABLE IF NOT EXISTS items (
    item_nbr    integer PRIMARY KEY,
    family      text,
    class       integer,
    perishable  smallint
);

CREATE TABLE IF NOT EXISTS item_costs (
    item_nbr    integer PRIMARY KEY REFERENCES items(item_nbr),
    family      text,
    perishable  smallint,
    unit_price  double precision,
    unit_cost   double precision
);

CREATE TABLE IF NOT EXISTS warehouses (
    warehouse_id  text PRIMARY KEY,
    city          text,
    lat           double precision,
    long          double precision
);

-- suppliers.family -> items.family CO Y khong co FK: quan he la nhieu-nhieu
-- (hai nha cung cap moi nganh hang), khong phai mot FK sach.
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id         text PRIMARY KEY,
    supplier_name       text,
    family              text,
    city                text,
    lat                 double precision,
    long                double precision,
    promised_lead_days  smallint,
    warehouse_id        text REFERENCES warehouses(warehouse_id)
);

-- KHONG co primary key: `date` KHONG unique trong bo du lieu goc (mot ngay
-- co the mang nhieu ngay le o nhieu locale). Dat PK o day se lam mat dong.
-- Ngoai ra, day la ngay le Ecuador mang ten tieng Viet - bug da ghi nhan o
-- muc 8b cua data dictionary.
CREATE TABLE IF NOT EXISTS holidays (
    date         date,
    type         text,
    locale       text,
    locale_name  text,
    description  text,
    transferred  boolean
);

CREATE TABLE IF NOT EXISTS oil (
    date        date PRIMARY KEY,
    dcoilwtico  double precision   -- NULL vao cuoi tuan, co y
);

-- -------------------------------- facts -----------------------------

CREATE TABLE IF NOT EXISTS transactions (
    date          date,
    store_nbr     smallint REFERENCES stores(store_nbr),
    transactions  integer,
    PRIMARY KEY (date, store_nbr)
);

-- 125.497.040 dong. Phan vung theo NAM.
--
-- `date` la TEXT dang 'YYYY-MM-DD', va range partitioning tren text so sanh
-- theo thu tu tu dien - voi dinh dang ISO thi trung khop hoan toan voi thu
-- tu thoi gian. (Dieu nay chi dung vi collation la C; xem phep kiem o tren.)
--
-- Phan vung khong phai de tiet kiem cho. No de: nap song song tung nam,
-- VACUUM/REINDEX tung phan thay vi ca bang 9 GB, partition pruning cho truy
-- van loc theo nam, va - khong kem quan trong - de chinh bang nay tro thanh
-- vi du day EXPLAIN tot nhat trong ca hai bo du lieu.
CREATE TABLE IF NOT EXISTS sales (
    date         text    NOT NULL,
    store_nbr    smallint,
    item_nbr     integer,
    unit_sales   real,               -- co gia tri AM (hang tra) va thap phan
    onpromotion  boolean             -- NULL o ~21,7 trieu dong, co y
) PARTITION BY RANGE (date);

CREATE TABLE IF NOT EXISTS sales_2013 PARTITION OF sales FOR VALUES FROM ('2013-01-01') TO ('2014-01-01');
CREATE TABLE IF NOT EXISTS sales_2014 PARTITION OF sales FOR VALUES FROM ('2014-01-01') TO ('2015-01-01');
CREATE TABLE IF NOT EXISTS sales_2015 PARTITION OF sales FOR VALUES FROM ('2015-01-01') TO ('2016-01-01');
CREATE TABLE IF NOT EXISTS sales_2016 PARTITION OF sales FOR VALUES FROM ('2016-01-01') TO ('2017-01-01');
CREATE TABLE IF NOT EXISTS sales_2017 PARTITION OF sales FOR VALUES FROM ('2017-01-01') TO ('2018-01-01');

CREATE TABLE IF NOT EXISTS inventory_snapshots (
    store_nbr        smallint,
    item_nbr         integer,
    ym               text,           -- 'YYYY-MM', chuoi trong nguon
    on_hand_begin    real,
    received         real,
    sold             real,
    on_hand_end      real,
    inventory_value  double precision,
    PRIMARY KEY (store_nbr, item_nbr, ym)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    po_id               text PRIMARY KEY,
    supplier_id         text REFERENCES suppliers(supplier_id),
    item_nbr            integer REFERENCES items(item_nbr),
    po_date             text,
    qty_ordered         real,
    promised_lead_days  smallint,
    promised_date       text,
    received_date       text,
    km_supplier_to_dc   double precision
);

CREATE TABLE IF NOT EXISTS shipments (
    shipment_id     text PRIMARY KEY,
    warehouse_id    text REFERENCES warehouses(warehouse_id),
    store_nbr       smallint REFERENCES stores(store_nbr),
    week            text,           -- '2012-12-31/2013-01-06', mot khoang
    km_to_dc        double precision,
    units_shipped   double precision,
    promised_days   smallint,
    actual_days     double precision,
    on_time         smallint,
    in_full         smallint,
    otif            smallint
);

-- ====================================================================
-- 3. CHOM SAO B - chang cuoi B2C (bai logistic)
-- ====================================================================
-- CO Y doc lap voi chom sao A: no chi dung chung khai niem kho/thanh pho/
-- lich, va KHONG duoc doi chieu so lieu voi `shipments`. Data dictionary noi
-- ro dieu nay; hoc vien nao cong hai ben lai se ra mot con so vo nghia.

CREATE TABLE IF NOT EXISTS sorting_hubs (
    hub_id     text PRIMARY KEY,
    dc_parent  text,                -- tu tham chieu, dat FK sau khi nap
    city       text,
    role       text,
    lat        double precision,
    long       double precision
);

CREATE TABLE IF NOT EXISTS delivery_points (
    point_id  text PRIMARY KEY,
    city      text,
    lat       double precision,
    long      double precision,
    weight    double precision
);

CREATE TABLE IF NOT EXISTS event_calendar (
    date               date PRIMARY KEY,
    event_name         text,
    tier               text,
    demand_multiplier  double precision
);

CREATE TABLE IF NOT EXISTS staffing_plan (
    hub_id              text REFERENCES sorting_hubs(hub_id),
    date                date,
    headcount_ke_hoach  integer,
    PRIMARY KEY (hub_id, date)
);

CREATE TABLE IF NOT EXISTS orders (
    order_id                  text PRIMARY KEY,
    order_date                text,
    region                    text,
    origin_hub_id             text REFERENCES sorting_hubs(hub_id),
    dest_hub_id               text REFERENCES sorting_hubs(hub_id),
    dest_city                 text,
    dest_point_id             text REFERENCES delivery_points(point_id),
    family                    text,
    weight_kg                 double precision,
    order_value_usd           double precision,
    created_at                timestamp,
    picked_at                 timestamp,
    dispatched_at             timestamp,
    hub_arrived_at            timestamp,
    delivered_at              timestamp,
    t1_tao_don_pick_h         double precision,
    t2_pick_xuat_h            double precision,
    t3a_di_chuyen_h           double precision,
    t3b_sorting_h             double precision,
    t4_kho_giao_h             double precision,
    lead_time_total_h         double precision,
    promised_h                double precision,
    on_time                   smallint,
    checkout_group            text,
    voucher_manually_applied  boolean,
    voucher_applied           boolean,
    is_cancelled              boolean
);

CREATE TABLE IF NOT EXISTS warehouse_daily_ops (
    hub_id             text REFERENCES sorting_hubs(hub_id),
    date               date,
    orders_to_process  integer,
    backlog_dau_ngay   double precision,
    backlog_cuoi_ngay  double precision,
    headcount          integer,
    total_weight_kg    double precision,
    avg_sort_time_min  double precision,
    workload_ratio     double precision,
    PRIMARY KEY (hub_id, date)
);

-- ====================================================================
-- 4. Chu so huu
-- ====================================================================
-- File nay chay bang superuser, nen moi bang vua tao thuoc ve `postgres`,
-- KHONG phai `scm_owner`. Hai hau qua, ca hai deu im lang:
--   - ALTER DEFAULT PRIVILEGES FOR ROLE scm_owner o duoi se khong ap cho bang
--     nao ca, nen mot bang them ve sau se khong duoc GRANT tu dong;
--   - muc dich cua 10_scm_roles.sql - "khong bo thong tin dang nhap nao DROP
--     duoc mot bang" - bi pha, vi postgres dang nhap duoc.
-- Nen chuyen quyen so huu ve dung cho truoc khi cap quyen.
DO $$
DECLARE r record;
BEGIN
    EXECUTE 'ALTER SCHEMA scm OWNER TO scm_owner';
    FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'scm' AND c.relkind IN ('r', 'p')
    LOOP
        EXECUTE format('ALTER TABLE scm.%I OWNER TO scm_owner', r.relname);
    END LOOP;
END
$$;

-- ====================================================================
-- 5. GRANT - cap bang, khong bao gio cap cot
-- ====================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA scm TO scm_reader;

-- Bang tao ve sau cung tu dong duoc doc, de khong ai phai nho chay lai GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE scm_owner IN SCHEMA scm
    GRANT SELECT ON TABLES TO scm_reader;

-- Loader can ghi; chi loader.
GRANT ALL ON SCHEMA scm TO scm_loader;
GRANT ALL ON ALL TABLES IN SCHEMA scm TO scm_loader;
ALTER DEFAULT PRIVILEGES FOR ROLE scm_owner IN SCHEMA scm
    GRANT ALL ON TABLES TO scm_loader;

-- Khong ai duoc tao bang moi trong schema nay ngoai chu so huu va loader.
REVOKE CREATE ON SCHEMA scm FROM PUBLIC;
