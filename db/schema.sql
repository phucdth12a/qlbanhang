-- =====================================================================
--  LOGISTIC WEB ADMIN - Schema MySQL 8.0.16+ (InnoDB, utf8mb4)
--  Phân hệ: Người dùng | Sản phẩm & biến thể | Nhà cung cấp | Kho & vị trí
--           Tồn kho & thẻ kho | Mua hàng | Nhập kho (duyệt, phát sinh) | Lịch sử
-- =====================================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- 1. NGƯỜI DÙNG
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL,
  full_name     VARCHAR(150) NOT NULL,
  email         VARCHAR(150) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('ADMIN','PURCHASER','WAREHOUSE_STAFF','WAREHOUSE_MANAGER') NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_users_username (username),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 2. NHÀ CUNG CẤP
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(30)  NOT NULL,                 -- NCC0001
  name          VARCHAR(200) NOT NULL,
  contact_name  VARCHAR(150) NULL,
  phone         VARCHAR(20)  NULL,
  email         VARCHAR(150) NULL,
  address       VARCHAR(255) NULL,
  tax_code      VARCHAR(20)  NULL,                     -- mã số thuế
  note          TEXT         NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME     NULL,                     -- xoá mềm
  UNIQUE KEY uk_suppliers_code (code),
  CONSTRAINT fk_suppliers_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 3. SẢN PHẨM & BIẾN THỂ
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id  BIGINT UNSIGNED NULL,
  name       VARCHAR(150) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL,                   -- AO-THUN-001
  name        VARCHAR(255) NOT NULL,
  category_id BIGINT UNSIGNED NULL,
  unit        VARCHAR(20)  NOT NULL DEFAULT 'cái',     -- đơn vị tính
  description TEXT         NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  DATETIME     NULL,
  UNIQUE KEY uk_products_code (code),
  CONSTRAINT fk_products_category   FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_products_created_by FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Thuộc tính biến thể: SIZE, COLOR...
CREATE TABLE attributes (
  id   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30)  NOT NULL,                          -- SIZE
  name VARCHAR(100) NOT NULL,                          -- Kích cỡ
  UNIQUE KEY uk_attributes_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Giá trị thuộc tính: S, M, L / Đỏ, Xanh...
CREATE TABLE attribute_values (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attribute_id BIGINT UNSIGNED NOT NULL,
  value        VARCHAR(100) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_attr_values (attribute_id, value),
  CONSTRAINT fk_attr_values_attr FOREIGN KEY (attribute_id) REFERENCES attributes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Biến thể = đơn vị tồn kho thật (SKU). Mọi giao dịch kho/mua hàng trỏ vào bảng này.
CREATE TABLE product_variants (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  sku        VARCHAR(80)  NOT NULL,                    -- AO-THUN-001-DO-M
  barcode    VARCHAR(80)  NULL,
  name       VARCHAR(255) NOT NULL,                    -- Áo thun - Đỏ - M
  cost_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  sale_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME     NULL,
  UNIQUE KEY uk_variants_sku (sku),
  UNIQUE KEY uk_variants_barcode (barcode),
  KEY idx_variants_product (product_id),
  CONSTRAINT fk_variants_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Biến thể gồm những giá trị thuộc tính nào (Đỏ + M)
CREATE TABLE variant_attribute_values (
  variant_id         BIGINT UNSIGNED NOT NULL,
  attribute_value_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (variant_id, attribute_value_id),
  CONSTRAINT fk_vav_variant FOREIGN KEY (variant_id)         REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT fk_vav_value   FOREIGN KEY (attribute_value_id) REFERENCES attribute_values(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NCC nào cung cấp biến thể nào, giá nhập tham khảo
CREATE TABLE supplier_variants (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  supplier_id    BIGINT UNSIGNED NOT NULL,
  variant_id     BIGINT UNSIGNED NOT NULL,
  supplier_sku   VARCHAR(80)   NULL,                   -- mã hàng phía NCC
  purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  lead_time_days INT           NULL,
  is_preferred   TINYINT(1)    NOT NULL DEFAULT 0,
  UNIQUE KEY uk_supplier_variant (supplier_id, variant_id),
  CONSTRAINT fk_sv_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_sv_variant  FOREIGN KEY (variant_id)  REFERENCES product_variants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 4. KHO & VỊ TRÍ
-- ---------------------------------------------------------------------
CREATE TABLE warehouses (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(30)  NOT NULL,                    -- KHO-HCM
  name       VARCHAR(200) NOT NULL,
  address    VARCHAR(255) NULL,
  manager_id BIGINT UNSIGNED NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_warehouses_code (code),
  CONSTRAINT fk_warehouses_manager FOREIGN KEY (manager_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vị trí dạng cây: Khu A > Dãy 01 > Kệ 03 > Ô 02  (code: A-01-03-02)
CREATE TABLE warehouse_locations (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  warehouse_id  BIGINT UNSIGNED NOT NULL,
  parent_id     BIGINT UNSIGNED NULL,
  code          VARCHAR(50)  NOT NULL,
  name          VARCHAR(150) NULL,
  location_type ENUM('ZONE','AISLE','RACK','SHELF','BIN','RECEIVING','DAMAGED') NOT NULL DEFAULT 'BIN',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uk_location_code (warehouse_id, code),
  CONSTRAINT fk_locations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_locations_parent    FOREIGN KEY (parent_id)    REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 5. TỒN KHO & THẺ KHO
-- ---------------------------------------------------------------------
-- Tồn hiện tại theo (vị trí, biến thể). Tồn theo kho = SUM theo warehouse_id.
-- UNIQUE (location_id, variant_id) + 1 cột stock_status => trên 1 vị trí, 1 biến thể chỉ có đúng 1 tình trạng.
-- Đổi tình trạng chỉ được khi ô đã hết hàng (quantity = 0): xem trigger trg_stock_status_guard.
CREATE TABLE inventory_stocks (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  warehouse_id      BIGINT UNSIGNED NOT NULL,
  location_id       BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  stock_status      ENUM('NEW','USED','DAMAGED') NOT NULL DEFAULT 'NEW',  -- mới / đã qua sử dụng / hư hỏng
  quantity          INT NOT NULL DEFAULT 0,
  reserved_quantity INT NOT NULL DEFAULT 0,            -- đã giữ cho đơn bán
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_stock_location_variant (location_id, variant_id),
  KEY idx_stock_wh_variant (warehouse_id, variant_id, stock_status),
  CONSTRAINT chk_stock_qty CHECK (quantity >= 0 AND reserved_quantity >= 0),
  CONSTRAINT fk_stock_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_location  FOREIGN KEY (location_id)  REFERENCES warehouse_locations(id),
  CONSTRAINT fk_stock_variant   FOREIGN KEY (variant_id)   REFERENCES product_variants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Thẻ kho: mọi biến động tồn đều ghi 1 dòng, không bao giờ sửa/xoá.
CREATE TABLE inventory_transactions (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  warehouse_id      BIGINT UNSIGNED NOT NULL,
  location_id       BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  stock_status      ENUM('NEW','USED','DAMAGED') NOT NULL,
  transaction_type  ENUM('GOODS_RECEIPT','RETURN_RECEIPT','GOODS_ISSUE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT') NOT NULL,
  quantity          INT NOT NULL,                      -- (+) nhập, (-) xuất
  balance_after     INT NOT NULL,                      -- tồn tại vị trí sau giao dịch
  reference_type    VARCHAR(50)     NULL,              -- 'goods_receipt' | 'return_receipt'
  reference_id      BIGINT UNSIGNED NULL,              -- goods_receipts.id
  reference_item_id BIGINT UNSIGNED NULL,              -- goods_receipt_items.id
  note              VARCHAR(255)    NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_itx_variant_time (variant_id, warehouse_id, created_at),
  KEY idx_itx_reference (reference_type, reference_id),
  CONSTRAINT fk_itx_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_itx_location  FOREIGN KEY (location_id)  REFERENCES warehouse_locations(id),
  CONSTRAINT fk_itx_variant   FOREIGN KEY (variant_id)   REFERENCES product_variants(id),
  CONSTRAINT fk_itx_user      FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 6. PHIẾU MUA HÀNG (PO)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(30) NOT NULL,                -- PO-2026-0001
  supplier_id     BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,            -- kho dự kiến nhận
  order_date      DATE NOT NULL,
  expected_date   DATE NULL,
  status          ENUM('DRAFT','CONFIRMED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  subtotal        DECIMAL(15,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount    DECIMAL(15,2) NOT NULL DEFAULT 0,
  note            TEXT NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  confirmed_by    BIGINT UNSIGNED NULL,
  confirmed_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_po_code (code),
  KEY idx_po_supplier_status (supplier_id, status),
  CONSTRAINT fk_po_supplier     FOREIGN KEY (supplier_id)  REFERENCES suppliers(id),
  CONSTRAINT fk_po_warehouse    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_po_created_by   FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_po_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE purchase_order_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  quantity_ordered  INT NOT NULL,                      -- SL mua: 100
  quantity_received INT NOT NULL DEFAULT 0,            -- SL đã nhập kho (chỉ cộng khi phiếu nhập được DUYỆT)
  quantity_issue    INT NOT NULL DEFAULT 0,            -- tổng SL phát sinh đã báo (lỗi, sai...)
  unit_price        DECIMAL(15,2) NOT NULL DEFAULT 0,
  discount_amount   DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_rate          DECIMAL(5,2)  NOT NULL DEFAULT 0,  -- %
  line_total        DECIMAL(15,2) NOT NULL DEFAULT 0,
  note              VARCHAR(255) NULL,
  UNIQUE KEY uk_po_item_variant (purchase_order_id, variant_id),
  CONSTRAINT chk_po_item_qty CHECK (quantity_ordered > 0
                                    AND quantity_received >= 0
                                    AND quantity_received <= quantity_ordered
                                    AND quantity_issue >= 0),
  CONSTRAINT fk_po_item_po      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_po_item_variant FOREIGN KEY (variant_id)        REFERENCES product_variants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 7. PHIẾU NHẬP KHO (lập từ PO, nhập nhiều lần, phải duyệt)
-- ---------------------------------------------------------------------
CREATE TABLE goods_receipts (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(30) NOT NULL,              -- GR-2026-0001
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  warehouse_id      BIGINT UNSIGNED NOT NULL,
  receipt_date      DATE NOT NULL,
  delivery_note_no  VARCHAR(50) NULL,                  -- số phiếu giao hàng của NCC
  status            ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  note              TEXT NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NULL,
  reviewed_by       BIGINT UNSIGNED NULL,              -- người duyệt / từ chối
  reviewed_at       DATETIME NULL,
  review_note       VARCHAR(500) NULL,                 -- lý do từ chối
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_gr_code (code),
  KEY idx_gr_po (purchase_order_id),
  KEY idx_gr_status (status),
  CONSTRAINT fk_gr_po          FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_gr_warehouse   FOREIGN KEY (warehouse_id)      REFERENCES warehouses(id),
  CONSTRAINT fk_gr_created_by  FOREIGN KEY (created_by)        REFERENCES users(id),
  CONSTRAINT fk_gr_reviewed_by FOREIGN KEY (reviewed_by)       REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Một dòng PO có thể chia nhiều dòng nhập (nhiều vị trí). Nhiều phiếu nhập cho cùng 1 dòng PO.
CREATE TABLE goods_receipt_items (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  goods_receipt_id       BIGINT UNSIGNED NOT NULL,
  purchase_order_item_id BIGINT UNSIGNED NOT NULL,
  variant_id             BIGINT UNSIGNED NOT NULL,     -- lặp lại từ PO item để truy vấn nhanh
  location_id            BIGINT UNSIGNED NULL,         -- cất vào vị trí nào (bắt buộc khi quantity_accepted > 0)
  quantity_accepted      INT NOT NULL DEFAULT 0,       -- SL đạt, được nhập kho
  quantity_issue         INT NOT NULL DEFAULT 0,       -- SL phát sinh (lỗi, sai...), KHÔNG vào tồn
  quantity_delivered     INT AS (quantity_accepted + quantity_issue) STORED,  -- NCC giao thực tế
  note                   VARCHAR(255) NULL,
  UNIQUE KEY uk_gr_item (goods_receipt_id, purchase_order_item_id, location_id),
  KEY idx_gr_item_po_item (purchase_order_item_id),
  CONSTRAINT chk_gr_item_qty CHECK (quantity_accepted >= 0 AND quantity_issue >= 0
                                    AND quantity_accepted + quantity_issue > 0),
  CONSTRAINT fk_gr_item_gr       FOREIGN KEY (goods_receipt_id)       REFERENCES goods_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_gr_item_po_item  FOREIGN KEY (purchase_order_item_id) REFERENCES purchase_order_items(id),
  CONSTRAINT fk_gr_item_variant  FOREIGN KEY (variant_id)             REFERENCES product_variants(id),
  CONSTRAINT fk_gr_item_location FOREIGN KEY (location_id)            REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chi tiết hàng phát sinh: báo cho bộ phận thu mua xử lý với NCC.
-- SUM(quantity) theo goods_receipt_item_id = goods_receipt_items.quantity_issue
CREATE TABLE goods_receipt_issues (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  goods_receipt_item_id BIGINT UNSIGNED NOT NULL,
  issue_type            ENUM('DEFECTIVE','WRONG_ITEM','WRONG_VARIANT','EXPIRED','EXCESS','OTHER') NOT NULL,
  quantity              INT NOT NULL,
  description           TEXT NULL,
  status                ENUM('OPEN','PURCHASING_REVIEWING','SUPPLIER_CONFIRMED','RESOLVED','REJECTED') NOT NULL DEFAULT 'OPEN',
  resolution            ENUM('RETURN','REPLACE','REFUND','DISCOUNT','ACCEPT') NULL,  -- trả hàng / đổi / hoàn tiền / giảm giá / chấp nhận
  resolution_note       VARCHAR(500) NULL,
  assigned_to           BIGINT UNSIGNED NULL,          -- nhân viên thu mua phụ trách
  resolved_by           BIGINT UNSIGNED NULL,
  resolved_at           DATETIME NULL,
  created_by            BIGINT UNSIGNED NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_issue_status (status),
  CONSTRAINT chk_issue_qty CHECK (quantity > 0),
  CONSTRAINT fk_issue_gr_item     FOREIGN KEY (goods_receipt_item_id) REFERENCES goods_receipt_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id),
  CONSTRAINT fk_issue_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id),
  CONSTRAINT fk_issue_created_by  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lịch sử gửi duyệt / duyệt / từ chối của phiếu nhập
CREATE TABLE goods_receipt_approvals (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  goods_receipt_id BIGINT UNSIGNED NOT NULL,
  action           ENUM('SUBMIT','APPROVE','REJECT','CANCEL') NOT NULL,
  from_status      VARCHAR(30) NOT NULL,
  to_status        VARCHAR(30) NOT NULL,
  comment          VARCHAR(500) NULL,
  acted_by         BIGINT UNSIGNED NOT NULL,
  acted_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_gra_gr (goods_receipt_id, acted_at),
  CONSTRAINT fk_gra_gr   FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id),
  CONSTRAINT fk_gra_user FOREIGN KEY (acted_by)         REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 8. PHIẾU NHẬP HÀNG TRẢ VỀ (khách trả / hàng hoàn từ đơn vị vận chuyển)
--    Cùng quy trình duyệt như phiếu nhập kho. Mỗi dòng ghi rõ tình trạng hàng.
-- ---------------------------------------------------------------------
CREATE TABLE return_receipts (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code           VARCHAR(30) NOT NULL,                 -- RR-2026-0001
  warehouse_id   BIGINT UNSIGNED NOT NULL,
  return_date    DATE NOT NULL,
  source_type    ENUM('CUSTOMER','CARRIER','OTHER') NOT NULL DEFAULT 'CUSTOMER', -- khách trả / hàng hoàn vận chuyển
  order_code     VARCHAR(50)  NULL,                    -- mã đơn bán gốc
  tracking_code  VARCHAR(50)  NULL,                    -- mã vận đơn
  customer_name  VARCHAR(150) NULL,
  customer_phone VARCHAR(20)  NULL,
  reason         VARCHAR(500) NULL,                    -- lý do trả chung cho cả phiếu
  status         ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  note           TEXT NULL,
  created_by     BIGINT UNSIGNED NOT NULL,
  submitted_at   DATETIME NULL,
  reviewed_by    BIGINT UNSIGNED NULL,
  reviewed_at    DATETIME NULL,
  review_note    VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rr_code (code),
  KEY idx_rr_status (status),
  KEY idx_rr_order (order_code),
  CONSTRAINT fk_rr_warehouse   FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_rr_created_by  FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_rr_reviewed_by FOREIGN KEY (reviewed_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cùng 1 biến thể có thể trả về với nhiều tình trạng => tách nhiều dòng, mỗi tình trạng 1 vị trí khác nhau.
-- UNIQUE (return_receipt_id, location_id, variant_id): trong 1 phiếu, 1 vị trí chỉ nhận 1 tình trạng của 1 biến thể.
CREATE TABLE return_receipt_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  return_receipt_id BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  location_id       BIGINT UNSIGNED NOT NULL,
  stock_status      ENUM('NEW','USED','DAMAGED') NOT NULL,
  quantity          INT NOT NULL,
  return_reason     ENUM('CUSTOMER_CHANGED_MIND','WRONG_SIZE','DEFECTIVE','DELIVERY_FAILED','OTHER') NULL,
  note              VARCHAR(255) NULL,
  UNIQUE KEY uk_rr_item (return_receipt_id, location_id, variant_id),
  CONSTRAINT chk_rr_item_qty CHECK (quantity > 0),
  CONSTRAINT fk_rr_item_rr       FOREIGN KEY (return_receipt_id) REFERENCES return_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_rr_item_variant  FOREIGN KEY (variant_id)        REFERENCES product_variants(id),
  CONSTRAINT fk_rr_item_location FOREIGN KEY (location_id)       REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE return_receipt_approvals (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  return_receipt_id BIGINT UNSIGNED NOT NULL,
  action            ENUM('SUBMIT','APPROVE','REJECT','CANCEL') NOT NULL,
  from_status       VARCHAR(30) NOT NULL,
  to_status         VARCHAR(30) NOT NULL,
  comment           VARCHAR(500) NULL,
  acted_by          BIGINT UNSIGNED NOT NULL,
  acted_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rra_rr (return_receipt_id, acted_at),
  CONSTRAINT fk_rra_rr   FOREIGN KEY (return_receipt_id) REFERENCES return_receipts(id),
  CONSTRAINT fk_rra_user FOREIGN KEY (acted_by)          REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 9. LỊCH SỬ THAO TÁC & FILE ĐÍNH KÈM
-- ---------------------------------------------------------------------
-- Ghi mọi thao tác trên mọi bảng. Chỉ INSERT, không UPDATE/DELETE.
-- Không đặt FK cho entity_id vì trỏ tới nhiều bảng khác nhau.
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NULL,
  action      VARCHAR(30)  NOT NULL,                   -- CREATE, UPDATE, DELETE, SUBMIT, APPROVE, REJECT, CANCEL, LOGIN...
  entity_type VARCHAR(50)  NOT NULL,                   -- 'goods_receipts', 'purchase_orders'...
  entity_id   BIGINT UNSIGNED NOT NULL,
  old_values  JSON NULL,                               -- chỉ các cột bị đổi
  new_values  JSON NULL,
  ip_address  VARCHAR(45)  NULL,
  user_agent  VARCHAR(255) NULL,
  request_id  CHAR(36)     NULL,                       -- gom các log trong cùng 1 request
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_entity (entity_type, entity_id, created_at),
  KEY idx_audit_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ảnh hàng lỗi, chứng từ giao hàng...
CREATE TABLE attachments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50)  NOT NULL,                   -- 'goods_receipt_issues', 'goods_receipts'
  entity_id   BIGINT UNSIGNED NOT NULL,
  file_name   VARCHAR(255) NOT NULL,
  file_url    VARCHAR(500) NOT NULL,
  mime_type   VARCHAR(100) NULL,
  file_size   INT UNSIGNED NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attach_entity (entity_type, entity_id),
  CONSTRAINT fk_attach_user FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 11. ĐÁNH SỐ CHỨNG TỪ: PO-202610-0001, GR-..., RR-...
-- ---------------------------------------------------------------------
CREATE TABLE document_sequences (
  prefix  VARCHAR(10) NOT NULL,
  period  CHAR(6)     NOT NULL,                        -- YYYYMM
  last_no INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
