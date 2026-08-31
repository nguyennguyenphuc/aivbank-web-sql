-- ============================================================================
-- Migration scm: cac cot/bang moi tu dot sua bo sinh du lieu (2026-08-31)
-- ============================================================================
--
-- VI SAO CAN FILE NAY. `12_scm_schema_grants.sql` dung `CREATE TABLE IF NOT
-- EXISTS`. Tren mot database CON TRONG nhu `scm` dang chay, cac lenh do la
-- no-op: bang da ton tai nen dinh nghia moi KHONG duoc ap. Chay `load_scm.py`
-- ngay se hong o buoc COPY, vi file nguon co cot ma bang khong co:
--
--     ERROR: column "qty_received" of relation "purchase_orders" does not exist
--
-- Da kiem tren DB dang chay ngay 2026-08-31: ca 4 bang deu thieu dung cac cot
-- duoi day, va `item_costs_monthly` chua ton tai.
--
-- CHAY TREN VPS, voi quyen `scm_owner` (hoac postgres):
--
--     psql -U postgres -d scm -f 17_scm_migration_2026-08-31.sql
--
-- File nay CHI doi luoc do, khong dong vao du lieu. Chay xong moi chay
-- `load_scm.py load`. Chay lai nhieu lan khong sao (idempotent).
-- ============================================================================

SET search_path TO scm;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. purchase_orders: chat luong hang nhan
-- ---------------------------------------------------------------------------
-- `received_date` NULL = don con dang tren duong o moc cat du lieu; khi do ba
-- cot so lieu duoi day cung NULL va `inspection_result` la 'Pending'. Nho vay
-- %Pass + %Pending + %Fail = 100% mot cach tu nhien.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS qty_received      real;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS qty_defect        real;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS defect_rate       double precision;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS inspection_result text;

-- ---------------------------------------------------------------------------
-- 2. inventory_snapshots: phan cau khong dap ung duoc
-- ---------------------------------------------------------------------------
-- `sold` van la CAU THAT, khong bi cat bot, nen dang thuc luon dung:
--     on_hand_end = on_hand_begin + received - sold + thieu_hut
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS thieu_hut real;

-- ---------------------------------------------------------------------------
-- 3. staffing_plan: quan so CO MAT
-- ---------------------------------------------------------------------------
-- Nang luc kho tinh theo cot nay, khong theo cot ke hoach.
ALTER TABLE staffing_plan ADD COLUMN IF NOT EXISTS headcount_thuc_te integer;

-- ---------------------------------------------------------------------------
-- 4. warehouse_daily_ops: them cot ke hoach de so sanh
-- ---------------------------------------------------------------------------
-- `headcount` la so nguoi CO MAT.
ALTER TABLE warehouse_daily_ops ADD COLUMN IF NOT EXISTS headcount_ke_hoach integer;

-- ---------------------------------------------------------------------------
-- 5. item_costs_monthly: bang moi, gia ban / gia von THEO THANG
-- ---------------------------------------------------------------------------
-- `item_costs` giu nguyen lam gia goc; bang nay la gia theo tung thang quanh no.
-- Co vi `item_costs` chi co MOT gia cho ca 4,5 nam va bien loi nhuan cua moi ma
-- la hang so, nen khong the tra loi "bien dang mong di hay day len".
CREATE TABLE IF NOT EXISTS item_costs_monthly (
    item_nbr    integer REFERENCES items(item_nbr),
    ym          text,             -- 'YYYY-MM'
    unit_price  double precision,
    unit_cost   double precision,
    margin_pct  double precision, -- 1 - unit_cost / unit_price
    PRIMARY KEY (item_nbr, ym)
);

-- Bang tao ve sau khong duoc `GRANT SELECT ON ALL TABLES` cu bao phu, va
-- ALTER DEFAULT PRIVILEGES chi ap cho bang do CHINH `scm_owner` tao ra. Cap
-- tuong minh cho chac.
GRANT SELECT ON item_costs_monthly TO scm_reader;
GRANT ALL    ON item_costs_monthly TO scm_loader;

COMMIT;

-- ---------------------------------------------------------------------------
-- Nghiem thu: cau lenh nay phai tra ve 5 dong, khong dong nao 'THIEU'
-- ---------------------------------------------------------------------------
SELECT 'purchase_orders.qty_received'      AS cot,
       CASE WHEN to_regclass('scm.purchase_orders') IS NOT NULL
             AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='scm' AND table_name='purchase_orders'
                           AND column_name='qty_received')
            THEN 'OK' ELSE 'THIEU' END AS trang_thai
UNION ALL SELECT 'inventory_snapshots.thieu_hut',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='scm' AND table_name='inventory_snapshots'
                           AND column_name='thieu_hut') THEN 'OK' ELSE 'THIEU' END
UNION ALL SELECT 'staffing_plan.headcount_thuc_te',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='scm' AND table_name='staffing_plan'
                           AND column_name='headcount_thuc_te') THEN 'OK' ELSE 'THIEU' END
UNION ALL SELECT 'warehouse_daily_ops.headcount_ke_hoach',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='scm' AND table_name='warehouse_daily_ops'
                           AND column_name='headcount_ke_hoach') THEN 'OK' ELSE 'THIEU' END
UNION ALL SELECT 'item_costs_monthly',
       CASE WHEN to_regclass('scm.item_costs_monthly') IS NOT NULL
            THEN 'OK' ELSE 'THIEU' END;
