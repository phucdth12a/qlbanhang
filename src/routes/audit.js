const express = require('express');
const db = require('../db');
const { ah, requirePerm, int } = require('../lib/http');

const router = express.Router();
router.use(requirePerm('audit.view'));

// Bảng -> trang chi tiết
const LINKS = {
  purchase_orders: '/purchase-orders/',
  goods_receipts: '/goods-receipts/',
  return_receipts: '/returns/',
  goods_receipt_issues: '/issues/',
  products: '/products/',
  suppliers: '/suppliers/',
  warehouses: '/warehouses/',
  customers: '/customers/',
  sales_orders: '/sales-orders/',
  goods_issues: '/goods-issues/',
  stock_transfers: '/transfers/',
  stock_adjustments: '/adjustments/',
};
const ENTITY_NAMES = {
  purchase_orders: 'Phiếu mua hàng',
  goods_receipts: 'Phiếu nhập kho',
  return_receipts: 'Phiếu trả về',
  sales_orders: 'Đơn bán hàng',
  customers: 'Khách hàng',
  goods_issues: 'Phiếu xuất kho',
  stock_transfers: 'Phiếu chuyển kho',
  stock_adjustments: 'Phiếu kiểm kê',
  goods_receipt_issues: 'Hàng phát sinh',
  products: 'Sản phẩm',
  product_variants: 'Biến thể',
  suppliers: 'Nhà cung cấp',
  warehouses: 'Kho',
  warehouse_locations: 'Vị trí kho',
  categories: 'Nhóm sản phẩm',
  attributes: 'Thuộc tính',
  attribute_values: 'Giá trị thuộc tính',
  users: 'Người dùng',
};

router.get(
  '/',
  ah(async (req, res) => {
    const f = {
      user_id: int(req.query.user_id) || null,
      entity_type: req.query.entity_type || '',
      action: req.query.action || '',
      from: req.query.from || '',
      to: req.query.to || '',
    };
    const where = ['1=1'];
    const params = [];
    if (f.user_id) { where.push('l.user_id = ?'); params.push(f.user_id); }
    if (f.entity_type) { where.push('l.entity_type = ?'); params.push(f.entity_type); }
    if (f.action) { where.push('l.action = ?'); params.push(f.action); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) { where.push('l.created_at >= ?'); params.push(f.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(f.to); }
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 500`,
      params
    );
    const users = await db.query('SELECT id, full_name FROM users ORDER BY full_name');
    const actions = (await db.query('SELECT DISTINCT action FROM audit_logs ORDER BY action')).map((r) => r.action);
    res.render('audit/index', { title: 'Lịch sử thao tác', logs, f, users, actions, LINKS, ENTITY_NAMES });
  })
);

module.exports = router;
