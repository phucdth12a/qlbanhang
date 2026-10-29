// Dữ liệu cho các ô chọn trong form
const db = require('../db');

const variants = () =>
  db.query(
    `SELECT v.id, v.sku, v.name, v.cost_price, v.sale_price, p.name AS product_name
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.is_active = 1 AND v.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.name, v.sku`
  );

const suppliers = () => db.query('SELECT id, code, name FROM suppliers WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name');
const warehouses = () => db.query('SELECT id, code, name FROM warehouses WHERE is_active = 1 ORDER BY name');
const locations = (warehouseId) =>
  db.query(
    `SELECT id, warehouse_id, code, name, location_type FROM warehouse_locations
      WHERE is_active = 1 ${warehouseId ? 'AND warehouse_id = ?' : ''} ORDER BY code`,
    warehouseId ? [warehouseId] : []
  );
const categories = () => db.query('SELECT id, parent_id, name FROM categories ORDER BY name');
const customers = () => db.query('SELECT id, code, name, address FROM customers WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name');
const purchasers = () => db.query("SELECT id, full_name FROM users WHERE is_active = 1 AND role IN ('PURCHASER','ADMIN') ORDER BY full_name");

module.exports = { variants, suppliers, warehouses, locations, categories, purchasers, customers };
