const { AppError } = require('../lib/errors');
const { label } = require('../lib/labels');

// Cộng hàng vào 1 vị trí và ghi thẻ kho. Gọi bên trong transaction.
// Một vị trí chỉ chứa 1 tình trạng của 1 biến thể: kiểm tra ở đây để báo lỗi rõ ràng,
// trigger trg_stock_status_guard trong DB chặn thêm một lớp nữa.
async function addStock(conn, { warehouseId, locationId, variantId, status, quantity, type, refType, refId, refItemId, userId }) {
  const [[loc]] = await conn.query('SELECT id, code, warehouse_id FROM warehouse_locations WHERE id = ?', [locationId]);
  if (!loc || loc.warehouse_id !== warehouseId) throw new AppError('Vị trí không thuộc kho của phiếu.');

  const [[stock]] = await conn.query(
    'SELECT id, stock_status, quantity FROM inventory_stocks WHERE location_id = ? AND variant_id = ? FOR UPDATE',
    [locationId, variantId]
  );
  if (stock && stock.quantity > 0 && stock.stock_status !== status) {
    const [[v]] = await conn.query('SELECT sku FROM product_variants WHERE id = ?', [variantId]);
    throw new AppError(
      `Vị trí ${loc.code} đang chứa ${stock.quantity} ${v.sku} tình trạng "${label('stockStatus', stock.stock_status)}", ` +
        `không nhận thêm hàng "${label('stockStatus', status)}". Hãy chọn vị trí khác.`
    );
  }

  let balance;
  if (stock) {
    await conn.query('UPDATE inventory_stocks SET stock_status = ?, quantity = quantity + ? WHERE id = ?', [status, quantity, stock.id]);
    balance = stock.quantity + quantity;
  } else {
    await conn.query(
      'INSERT INTO inventory_stocks (warehouse_id, location_id, variant_id, stock_status, quantity) VALUES (?, ?, ?, ?, ?)',
      [warehouseId, locationId, variantId, status, quantity]
    );
    balance = quantity;
  }

  await conn.query(
    `INSERT INTO inventory_transactions (warehouse_id, location_id, variant_id, stock_status, transaction_type,
       quantity, balance_after, reference_type, reference_id, reference_item_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [warehouseId, locationId, variantId, status, type, quantity, balance, refType, refId, refItemId, userId]
  );
}

// Kiểm tra trước (không ghi): vị trí có nhận được hàng tình trạng này không
async function checkLocationStatus(conn, locationId, variantId, status) {
  const [[stock]] = await conn.query(
    `SELECT s.stock_status, s.quantity, l.code, v.sku
       FROM inventory_stocks s JOIN warehouse_locations l ON l.id = s.location_id JOIN product_variants v ON v.id = s.variant_id
      WHERE s.location_id = ? AND s.variant_id = ?`,
    [locationId, variantId]
  );
  if (stock && stock.quantity > 0 && stock.stock_status !== status) {
    return `Vị trí ${stock.code} đang chứa ${stock.quantity} ${stock.sku} tình trạng "${label('stockStatus', stock.stock_status)}", không nhận thêm hàng "${label('stockStatus', status)}".`;
  }
  return null;
}

module.exports = { addStock, checkLocationStatus };
