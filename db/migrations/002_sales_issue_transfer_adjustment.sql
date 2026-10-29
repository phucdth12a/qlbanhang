-- =====================================================================
-- 002: Bán hàng, xuất kho, chuyển kho, kiểm kê
--   - Vai trò SALES (nhân viên bán hàng)
--   - Khách hàng, đơn bán hàng (giữ hàng khi xác nhận)
--   - Phiếu xuất kho (bán hàng / trả NCC / huỷ hàng / nội bộ)
--   - Phiếu chuyển kho / chuyển vị trí
--   - Phiếu kiểm kê (điều chỉnh tồn)
--   - Lịch sử duyệt dùng chung cho các phiếu mới: document_approvals
--   - Hàng trả về liên kết đơn bán
-- =====================================================================

ALTER TABLE users
  MODIFY role ENUM('ADMIN','PURCHASER','SALES','WAREHOUSE_STAFF','WAREHOUSE_MANAGER') NOT NULL;

-- Hàng giữ cho đơn bán được tính từ đơn (SL đặt - SL đã xuất), không lưu theo vị trí
ALTER TABLE inventory_stocks DROP CHECK chk_stock_qty;
ALTER TABLE inventory_stocks DROP COLUMN reserved_quantity;
ALTER TABLE inventory_stocks ADD CONSTRAINT chk_stock_qty CHECK (quantity >= 0);

-- ---------------------------------------------------------------------
-- KHÁCH HÀNG & ĐƠN BÁN HÀNG
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(30)  NOT NULL,                    -- KH0001
  name       VARCHAR(200) NOT NULL,
  phone      VARCHAR(20)  NULL,
  email      VARCHAR(150) NULL,
  address    VARCHAR(255) NULL,
  note       TEXT         NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME     NULL,
  UNIQUE KEY uk_customers_code (code),
  KEY idx_customers_phone (phone),
  CONSTRAINT fk_customers_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Đơn đã CONFIRMED / PARTIALLY_SHIPPED giữ hàng: SL giữ = quantity_ordered - quantity_shipped
CREATE TABLE sales_orders (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(30) NOT NULL,               -- SO-202610-0001
  customer_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id     BIGINT UNSIGNED NOT NULL,           -- kho xuất hàng
  order_date       DATE NOT NULL,
  status           ENUM('DRAFT','CONFIRMED','PARTIALLY_SHIPPED','SHIPPED','CLOSED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  shipping_address VARCHAR(255) NULL,
  subtotal         DECIMAL(15,2) NOT NULL DEFAULT 0,
  discount_amount  DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
  note             TEXT NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  confirmed_by     BIGINT UNSIGNED NULL,
  confirmed_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_so_code (code),
  KEY idx_so_customer_status (customer_id, status),
  KEY idx_so_wh_status (warehouse_id, status),
  CONSTRAINT fk_so_customer     FOREIGN KEY (customer_id)  REFERENCES customers(id),
  CONSTRAINT fk_so_warehouse    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_so_created_by   FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_so_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sales_order_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sales_order_id    BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  quantity_ordered  INT NOT NULL,
  quantity_shipped  INT NOT NULL DEFAULT 0,            -- chỉ cộng khi phiếu xuất được DUYỆT
  quantity_returned INT NOT NULL DEFAULT 0,            -- chỉ cộng khi phiếu trả về được DUYỆT
  unit_price        DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_rate          DECIMAL(5,2)  NOT NULL DEFAULT 0,
  line_total        DECIMAL(15,2) NOT NULL DEFAULT 0,
  note              VARCHAR(255) NULL,
  UNIQUE KEY uk_so_item_variant (sales_order_id, variant_id),
  CONSTRAINT chk_so_item_qty CHECK (quantity_ordered > 0
                                    AND quantity_shipped >= 0 AND quantity_shipped <= quantity_ordered
                                    AND quantity_returned >= 0 AND quantity_returned <= quantity_shipped),
  CONSTRAINT fk_so_item_so      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_so_item_variant FOREIGN KEY (variant_id)     REFERENCES product_variants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- PHIẾU XUẤT KHO
-- ---------------------------------------------------------------------
CREATE TABLE goods_issues (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code           VARCHAR(30) NOT NULL,                 -- GI-202610-0001
  warehouse_id   BIGINT UNSIGNED NOT NULL,
  purpose        ENUM('SALE','RETURN_TO_SUPPLIER','DISPOSAL','INTERNAL_USE','OTHER') NOT NULL,
  sales_order_id BIGINT UNSIGNED NULL,                 -- khi purpose = SALE
  supplier_id    BIGINT UNSIGNED NULL,                 -- khi purpose = RETURN_TO_SUPPLIER
  issue_date     DATE NOT NULL,
  status         ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  note           TEXT NULL,
  created_by     BIGINT UNSIGNED NOT NULL,
  submitted_at   DATETIME NULL,
  reviewed_by    BIGINT UNSIGNED NULL,
  reviewed_at    DATETIME NULL,
  review_note    VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_gi_code (code),
  KEY idx_gi_status (status),
  KEY idx_gi_so (sales_order_id),
  CONSTRAINT fk_gi_warehouse   FOREIGN KEY (warehouse_id)   REFERENCES warehouses(id),
  CONSTRAINT fk_gi_so          FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  CONSTRAINT fk_gi_supplier    FOREIGN KEY (supplier_id)    REFERENCES suppliers(id),
  CONSTRAINT fk_gi_created_by  FOREIGN KEY (created_by)     REFERENCES users(id),
  CONSTRAINT fk_gi_reviewed_by FOREIGN KEY (reviewed_by)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lấy hàng từ vị trí nào; tình trạng lấy theo tình trạng hàng đang nằm ở vị trí đó
CREATE TABLE goods_issue_items (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  goods_issue_id      BIGINT UNSIGNED NOT NULL,
  sales_order_item_id BIGINT UNSIGNED NULL,
  variant_id          BIGINT UNSIGNED NOT NULL,
  location_id         BIGINT UNSIGNED NOT NULL,
  stock_status        ENUM('NEW','USED','DAMAGED') NOT NULL,
  quantity            INT NOT NULL,
  note                VARCHAR(255) NULL,
  UNIQUE KEY uk_gi_item (goods_issue_id, location_id, variant_id),
  CONSTRAINT chk_gi_item_qty CHECK (quantity > 0),
  CONSTRAINT fk_gi_item_gi       FOREIGN KEY (goods_issue_id)      REFERENCES goods_issues(id) ON DELETE CASCADE,
  CONSTRAINT fk_gi_item_so_item  FOREIGN KEY (sales_order_item_id) REFERENCES sales_order_items(id),
  CONSTRAINT fk_gi_item_variant  FOREIGN KEY (variant_id)          REFERENCES product_variants(id),
  CONSTRAINT fk_gi_item_location FOREIGN KEY (location_id)         REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- PHIẾU CHUYỂN KHO / CHUYỂN VỊ TRÍ (cùng kho hoặc khác kho)
-- ---------------------------------------------------------------------
CREATE TABLE stock_transfers (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(30) NOT NULL,              -- TR-202610-0001
  from_warehouse_id BIGINT UNSIGNED NOT NULL,
  to_warehouse_id   BIGINT UNSIGNED NOT NULL,
  transfer_date     DATE NOT NULL,
  status            ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  note              TEXT NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NULL,
  reviewed_by       BIGINT UNSIGNED NULL,
  reviewed_at       DATETIME NULL,
  review_note       VARCHAR(500) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tr_code (code),
  KEY idx_tr_status (status),
  CONSTRAINT fk_tr_from_wh     FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_tr_to_wh       FOREIGN KEY (to_warehouse_id)   REFERENCES warehouses(id),
  CONSTRAINT fk_tr_created_by  FOREIGN KEY (created_by)        REFERENCES users(id),
  CONSTRAINT fk_tr_reviewed_by FOREIGN KEY (reviewed_by)       REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_transfer_items (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_transfer_id BIGINT UNSIGNED NOT NULL,
  variant_id        BIGINT UNSIGNED NOT NULL,
  from_location_id  BIGINT UNSIGNED NOT NULL,
  to_location_id    BIGINT UNSIGNED NOT NULL,
  stock_status      ENUM('NEW','USED','DAMAGED') NOT NULL,
  quantity          INT NOT NULL,
  note              VARCHAR(255) NULL,
  UNIQUE KEY uk_tr_item (stock_transfer_id, from_location_id, variant_id),
  CONSTRAINT chk_tr_item CHECK (quantity > 0 AND from_location_id <> to_location_id),
  CONSTRAINT fk_tr_item_tr      FOREIGN KEY (stock_transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE,
  CONSTRAINT fk_tr_item_variant FOREIGN KEY (variant_id)        REFERENCES product_variants(id),
  CONSTRAINT fk_tr_item_from    FOREIGN KEY (from_location_id)  REFERENCES warehouse_locations(id),
  CONSTRAINT fk_tr_item_to      FOREIGN KEY (to_location_id)    REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- PHIẾU KIỂM KÊ: đếm thực tế, khi duyệt tồn được đặt bằng số đếm
-- ---------------------------------------------------------------------
CREATE TABLE stock_adjustments (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(30) NOT NULL,                -- ADJ-202610-0001
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  adjustment_date DATE NOT NULL,
  reason          VARCHAR(500) NULL,
  status          ENUM('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  created_by      BIGINT UNSIGNED NOT NULL,
  submitted_at    DATETIME NULL,
  reviewed_by     BIGINT UNSIGNED NULL,
  reviewed_at     DATETIME NULL,
  review_note     VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_adj_code (code),
  KEY idx_adj_status (status),
  CONSTRAINT fk_adj_warehouse   FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_adj_created_by  FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_adj_reviewed_by FOREIGN KEY (reviewed_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_adjustment_items (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_adjustment_id BIGINT UNSIGNED NOT NULL,
  variant_id          BIGINT UNSIGNED NOT NULL,
  location_id         BIGINT UNSIGNED NOT NULL,
  stock_status        ENUM('NEW','USED','DAMAGED') NOT NULL,
  quantity_counted    INT NOT NULL,                    -- SL đếm thực tế
  quantity_before     INT NULL,                        -- tồn hệ thống lúc duyệt
  note                VARCHAR(255) NULL,
  UNIQUE KEY uk_adj_item (stock_adjustment_id, location_id, variant_id),
  CONSTRAINT chk_adj_item CHECK (quantity_counted >= 0),
  CONSTRAINT fk_adj_item_adj      FOREIGN KEY (stock_adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  CONSTRAINT fk_adj_item_variant  FOREIGN KEY (variant_id)          REFERENCES product_variants(id),
  CONSTRAINT fk_adj_item_location FOREIGN KEY (location_id)         REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- LỊCH SỬ DUYỆT DÙNG CHUNG (goods_issue, stock_transfer, stock_adjustment)
-- ---------------------------------------------------------------------
CREATE TABLE document_approvals (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  document_type VARCHAR(30) NOT NULL,
  document_id   BIGINT UNSIGNED NOT NULL,
  action        ENUM('SUBMIT','APPROVE','REJECT','CANCEL') NOT NULL,
  from_status   VARCHAR(30) NOT NULL,
  to_status     VARCHAR(30) NOT NULL,
  comment       VARCHAR(500) NULL,
  acted_by      BIGINT UNSIGNED NOT NULL,
  acted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_doc_appr (document_type, document_id, acted_at),
  CONSTRAINT fk_doc_appr_user FOREIGN KEY (acted_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- HÀNG TRẢ VỀ LIÊN KẾT ĐƠN BÁN (tuỳ chọn)
-- ---------------------------------------------------------------------
ALTER TABLE return_receipts
  ADD COLUMN sales_order_id BIGINT UNSIGNED NULL AFTER source_type,
  ADD CONSTRAINT fk_rr_so FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id);

ALTER TABLE return_receipt_items
  ADD COLUMN sales_order_item_id BIGINT UNSIGNED NULL AFTER return_receipt_id,
  ADD CONSTRAINT fk_rr_item_so_item FOREIGN KEY (sales_order_item_id) REFERENCES sales_order_items(id);
