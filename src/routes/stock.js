const express = require('express');
const db = require('../db');
const { ah, int } = require('../lib/http');
const lookups = require('../lib/lookups');
const { reservedQty } = require('../services/stock');

const router = express.Router();

router.get(
  '/',
  ah(async (req, res) => {
    const f = {
      q: (req.query.q || '').trim(),
      warehouse_id: int(req.query.warehouse_id) || null,
      location_id: int(req.query.location_id) || null,
      status: req.query.status || '',
      view: req.query.view === 'variant' ? 'variant' : 'location',
    };
    const where = ['s.quantity > 0'];
    const params = [];
    if (f.q) { where.push('(v.sku LIKE ? OR v.name LIKE ? OR v.barcode LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    if (f.warehouse_id) { where.push('s.warehouse_id = ?'); params.push(f.warehouse_id); }
    if (f.location_id) { where.push('s.location_id = ?'); params.push(f.location_id); }
    if (f.status === 'OTHER') where.push("s.stock_status <> 'NEW'");
    else if (f.status) { where.push('s.stock_status = ?'); params.push(f.status); }

    let rows;
    if (f.view === 'variant') {
      rows = await db.query(
        `SELECT v.id, v.sku, v.name, w.code AS warehouse_code, s.warehouse_id,
                SUM(CASE WHEN s.stock_status = 'NEW' THEN s.quantity ELSE 0 END) AS qty_new,
                SUM(CASE WHEN s.stock_status = 'USED' THEN s.quantity ELSE 0 END) AS qty_used,
                SUM(CASE WHEN s.stock_status = 'DAMAGED' THEN s.quantity ELSE 0 END) AS qty_damaged,
                GROUP_CONCAT(l.code ORDER BY l.code SEPARATOR ', ') AS locations
           FROM inventory_stocks s
           JOIN product_variants v ON v.id = s.variant_id
           JOIN warehouses w ON w.id = s.warehouse_id
           JOIN warehouse_locations l ON l.id = s.location_id
          WHERE ${where.join(' AND ')}
          GROUP BY v.id, v.sku, v.name, w.code, s.warehouse_id ORDER BY v.sku LIMIT 500`,
        params
      );
      for (const r of rows) {
        r.reserved = await reservedQty(db.pool, r.warehouse_id, r.id);
        r.available = r.qty_new - r.reserved;
      }
    } else {
      rows = await db.query(
        `SELECT s.*, v.sku, v.name, w.code AS warehouse_code, l.code AS location_code
           FROM inventory_stocks s
           JOIN product_variants v ON v.id = s.variant_id
           JOIN warehouses w ON w.id = s.warehouse_id
           JOIN warehouse_locations l ON l.id = s.location_id
          WHERE ${where.join(' AND ')} ORDER BY w.code, l.code, v.sku LIMIT 500`,
        params
      );
    }
    res.render('stock/index', {
      title: 'Tồn kho',
      rows,
      f,
      warehouses: await lookups.warehouses(),
      locations: await lookups.locations(),
    });
  })
);

router.get(
  '/transactions',
  ah(async (req, res) => {
    const f = {
      q: (req.query.q || '').trim(),
      warehouse_id: int(req.query.warehouse_id) || null,
      type: req.query.type || '',
      from: req.query.from || '',
      to: req.query.to || '',
    };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('(v.sku LIKE ? OR l.code LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
    if (f.warehouse_id) { where.push('t.warehouse_id = ?'); params.push(f.warehouse_id); }
    if (f.type) { where.push('t.transaction_type = ?'); params.push(f.type); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) { where.push('t.created_at >= ?'); params.push(f.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) { where.push('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(f.to); }
    const rows = await db.query(
      `SELECT t.*, v.sku, l.code AS location_code, w.code AS warehouse_code, u.full_name,
              COALESCE(g.code, r.code, gi.code, tr.code, adj.code) AS ref_code
         FROM inventory_transactions t
         JOIN product_variants v ON v.id = t.variant_id
         JOIN warehouse_locations l ON l.id = t.location_id
         JOIN warehouses w ON w.id = t.warehouse_id
         JOIN users u ON u.id = t.created_by
         LEFT JOIN goods_receipts g ON t.reference_type = 'goods_receipt' AND g.id = t.reference_id
         LEFT JOIN return_receipts r ON t.reference_type = 'return_receipt' AND r.id = t.reference_id
         LEFT JOIN goods_issues gi ON t.reference_type = 'goods_issue' AND gi.id = t.reference_id
         LEFT JOIN stock_transfers tr ON t.reference_type = 'stock_transfer' AND tr.id = t.reference_id
         LEFT JOIN stock_adjustments adj ON t.reference_type = 'stock_adjustment' AND adj.id = t.reference_id
        WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 500`,
      params
    );
    res.render('stock/transactions', { title: 'Thẻ kho', rows, f, warehouses: await lookups.warehouses() });
  })
);

module.exports = router;
