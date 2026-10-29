// Tạo database MySQL local, chạy schema + trigger và nạp dữ liệu mẫu.
//   npm run db:init    -> tạo nếu chưa có (không đụng dữ liệu cũ)
//   npm run db:reset   -> XOÁ database rồi tạo lại từ đầu
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
const DB_NAME = process.env.DB_NAME || 'qlbanhang';
const reset = process.argv.includes('--reset');

function readSql(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
}

async function main() {
  const conn = await mysql.createConnection({ ...cfg, multipleStatements: true, charset: 'utf8mb4' });
  if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) throw new Error('DB_NAME chỉ được chứa chữ, số và dấu _');

  if (reset) {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    console.log(`Đã xoá database ${DB_NAME}`);
  }
  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [DB_NAME]);
  const exists = dbs.length > 0;
  if (!exists) {
    await conn.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
  await conn.query(`USE \`${DB_NAME}\``);

  const [tables] = await conn.query("SHOW TABLES LIKE 'users'");
  if (tables.length === 0) {
    await conn.query(readSql('schema.sql'));
    await conn.query(readSql('triggers.sql').replace(/^--.*$/gm, ''));
    console.log('Đã tạo bảng và trigger');
  } else {
    console.log('Bảng đã tồn tại, bỏ qua bước tạo bảng (dùng npm run db:reset để tạo lại)');
  }

  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM users');
  if (n === 0) {
    await seed(conn);
    console.log('Đã nạp dữ liệu mẫu');
  }
  await conn.end();
  console.log(`Xong. Database: ${DB_NAME} @ ${cfg.host}:${cfg.port}`);
}

async function seed(conn) {
  const hash = (p) => bcrypt.hashSync(p, 10);
  await conn.query(
    `INSERT INTO users (id, username, full_name, email, password_hash, role) VALUES
     (1, 'admin',  'Quản trị hệ thống', 'admin@example.com', ?, 'ADMIN'),
     (2, 'thumua', 'Nguyễn Văn Thu Mua', NULL, ?, 'PURCHASER'),
     (3, 'nvkho',  'Trần Thị Kho', NULL, ?, 'WAREHOUSE_STAFF'),
     (4, 'qlkho',  'Lê Văn Quản Lý', NULL, ?, 'WAREHOUSE_MANAGER')`,
    [hash('admin123'), hash('123456'), hash('123456'), hash('123456')]
  );

  await conn.query(`INSERT INTO attributes (id, code, name) VALUES (1, 'SIZE', 'Kích cỡ'), (2, 'COLOR', 'Màu sắc')`);
  await conn.query(`INSERT INTO attribute_values (id, attribute_id, value, sort_order) VALUES
    (1, 1, 'S', 1), (2, 1, 'M', 2), (3, 1, 'L', 3), (4, 1, 'XL', 4),
    (5, 2, 'Đen', 1), (6, 2, 'Trắng', 2), (7, 2, 'Đỏ', 3)`);
  await conn.query(`INSERT INTO categories (id, parent_id, name) VALUES (1, NULL, 'Thời trang'), (2, 1, 'Áo'), (3, 1, 'Quần')`);

  await conn.query(`INSERT INTO suppliers (id, code, name, contact_name, phone, email, address, tax_code, created_by) VALUES
    (1, 'NCC0001', 'Công ty May mặc Việt Tiến', 'Chị Hoa', '0901234567', 'sales@viettien.example', '7 Lê Minh Xuân, Tân Bình, TP.HCM', '0300401524', 1),
    (2, 'NCC0002', 'Xưởng may Phú Nhuận', 'Anh Tuấn', '0912345678', NULL, '120 Phan Đăng Lưu, Phú Nhuận, TP.HCM', NULL, 1)`);

  await conn.query(`INSERT INTO products (id, code, name, category_id, unit, description, created_by) VALUES
    (1, 'AO-THUN', 'Áo thun cotton cổ tròn', 2, 'cái', 'Cotton 100%, 220gsm', 1),
    (2, 'QUAN-JEAN', 'Quần jean slim fit', 3, 'cái', NULL, 1)`);
  // Áo thun: Đen/Trắng x S/M/L ; Quần jean: S/M/L/XL
  const variants = [
    [1, 1, 'AO-THUN-DEN-S', 'Áo thun cotton cổ tròn - Đen - S', 85000, 159000, [5, 1]],
    [2, 1, 'AO-THUN-DEN-M', 'Áo thun cotton cổ tròn - Đen - M', 85000, 159000, [5, 2]],
    [3, 1, 'AO-THUN-DEN-L', 'Áo thun cotton cổ tròn - Đen - L', 85000, 159000, [5, 3]],
    [4, 1, 'AO-THUN-TRANG-S', 'Áo thun cotton cổ tròn - Trắng - S', 85000, 159000, [6, 1]],
    [5, 1, 'AO-THUN-TRANG-M', 'Áo thun cotton cổ tròn - Trắng - M', 85000, 159000, [6, 2]],
    [6, 1, 'AO-THUN-TRANG-L', 'Áo thun cotton cổ tròn - Trắng - L', 85000, 159000, [6, 3]],
    [7, 2, 'QUAN-JEAN-S', 'Quần jean slim fit - S', 210000, 399000, [1]],
    [8, 2, 'QUAN-JEAN-M', 'Quần jean slim fit - M', 210000, 399000, [2]],
    [9, 2, 'QUAN-JEAN-L', 'Quần jean slim fit - L', 210000, 399000, [3]],
    [10, 2, 'QUAN-JEAN-XL', 'Quần jean slim fit - XL', 210000, 399000, [4]],
  ];
  for (const [id, pid, sku, name, cost, sale, vals] of variants) {
    await conn.query(
      'INSERT INTO product_variants (id, product_id, sku, name, cost_price, sale_price) VALUES (?, ?, ?, ?, ?, ?)',
      [id, pid, sku, name, cost, sale]
    );
    for (const v of vals) {
      await conn.query('INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES (?, ?)', [id, v]);
    }
    await conn.query(
      'INSERT INTO supplier_variants (supplier_id, variant_id, purchase_price, is_preferred) VALUES (?, ?, ?, 1)',
      [pid === 1 ? 1 : 2, id, cost]
    );
  }

  await conn.query(`INSERT INTO warehouses (id, code, name, address, manager_id) VALUES
    (1, 'KHO-HCM', 'Kho Tân Bình', '15 Cộng Hoà, Tân Bình, TP.HCM', 4)`);
  await conn.query(`INSERT INTO warehouse_locations (id, warehouse_id, parent_id, code, name, location_type) VALUES
    (1, 1, NULL, 'A', 'Khu A - hàng mới', 'ZONE'),
    (2, 1, 1, 'A-01', 'Kệ A-01', 'RACK'),
    (3, 1, 2, 'A-01-01', 'Ô A-01-01', 'BIN'),
    (4, 1, 2, 'A-01-02', 'Ô A-01-02', 'BIN'),
    (5, 1, 2, 'A-01-03', 'Ô A-01-03', 'BIN'),
    (6, 1, NULL, 'R', 'Khu R - hàng trả về', 'ZONE'),
    (7, 1, 6, 'R-01', 'Ô R-01', 'BIN'),
    (8, 1, 6, 'R-02', 'Ô R-02', 'BIN'),
    (9, 1, NULL, 'DMG', 'Khu hàng hư hỏng', 'DAMAGED')`);
}

main().catch((err) => {
  console.error('Lỗi khởi tạo database:', err.message);
  process.exit(1);
});
