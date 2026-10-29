const express = require('express');
const db = require('../db');
const { ah } = require('../lib/http');

const router = express.Router();

router.get(
  '/',
  ah(async (req, res) => {
    const [stats] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('CONFIRMED','PARTIALLY_RECEIVED')) AS po_open,
         (SELECT COUNT(*) FROM goods_receipts WHERE status = 'PENDING_APPROVAL') AS gr_pending,
         (SELECT COUNT(*) FROM return_receipts WHERE status = 'PENDING_APPROVAL') AS rr_pending,
         (SELECT COUNT(*) FROM goods_receipt_issues x JOIN goods_receipt_items gi ON gi.id = x.goods_receipt_item_id JOIN goods_receipts g ON g.id = gi.goods_receipt_id
           WHERE x.status NOT IN ('RESOLVED','REJECTED') AND g.status IN ('PENDING_APPROVAL','APPROVED')) AS issues_open,
         (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE stock_status = 'NEW') AS qty_new,
         (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE stock_status <> 'NEW') AS qty_other`
    );
    const pending = await db.query(
      `SELECT 'gr' AS kind, g.id, g.code, g.submitted_at, u.full_name, po.code AS ref
         FROM goods_receipts g JOIN users u ON u.id = g.created_by JOIN purchase_orders po ON po.id = g.purchase_order_id
        WHERE g.status = 'PENDING_APPROVAL'
       UNION ALL
       SELECT 'rr', r.id, r.code, r.submitted_at, u.full_name, r.order_code
         FROM return_receipts r JOIN users u ON u.id = r.created_by
        WHERE r.status = 'PENDING_APPROVAL'
       ORDER BY submitted_at LIMIT 10`
    );
    const issues = await db.query(
      `SELECT i.id, i.issue_type, i.quantity, i.status, v.sku, g.code AS gr_code, s.name AS supplier_name
         FROM goods_receipt_issues i
         JOIN goods_receipt_items gi ON gi.id = i.goods_receipt_item_id
         JOIN goods_receipts g ON g.id = gi.goods_receipt_id
         JOIN purchase_orders po ON po.id = g.purchase_order_id
         JOIN suppliers s ON s.id = po.supplier_id
         JOIN product_variants v ON v.id = gi.variant_id
        WHERE i.status NOT IN ('RESOLVED','REJECTED') AND g.status IN ('PENDING_APPROVAL','APPROVED')
        ORDER BY i.created_at DESC LIMIT 8`
    );
    const txs = await db.query(
      `SELECT t.*, v.sku, l.code AS location_code
         FROM inventory_transactions t JOIN product_variants v ON v.id = t.variant_id JOIN warehouse_locations l ON l.id = t.location_id
        ORDER BY t.id DESC LIMIT 8`
    );
    res.render('dashboard/index', { title: 'Tổng quan', stats, pending, issues, txs });
  })
);

module.exports = router;
