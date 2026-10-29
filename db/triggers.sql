-- Một vị trí chỉ chứa một tình trạng (NEW/USED/DAMAGED) của một biến thể.
-- Ô đang còn hàng (quantity > 0) thì không được đổi tình trạng.
-- File này chứa đúng 1 câu lệnh, được scripts/db-init.js chạy sau schema.sql.
CREATE TRIGGER trg_stock_status_guard
BEFORE UPDATE ON inventory_stocks
FOR EACH ROW
BEGIN
  IF NEW.stock_status <> OLD.stock_status AND OLD.quantity > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'STOCK_STATUS_CONFLICT';
  END IF;
END
