// Hàng phát sinh khi nhập kho: bộ phận thu mua theo dõi và làm việc với NCC
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { LABELS } = require('../lib/labels');
const lookups = require('../lib/lookups');

const router = express.Router();
// Chỉ hiện phát sinh của phiếu nhập đã gửi duyệt hoặc đã duyệt
const VISIBLE = "g.status IN ('PENDING_APPROVAL','APPROVED')";

const BASE = `
  FROM goods_receipt_issues x
  JOIN goods_receipt_items gi ON gi.id = x.goods_receipt_item_id
  JOIN goods_receipts g ON g.id = gi.goods_receipt_id
  JOIN purchase_orders po ON po.id = g.purchase_order_id
  JOIN suppliers s ON s.id = po.supplier_id
  JOIN product_variants v ON v.id = gi.variant_id
  LEFT JOIN users a ON a.id = x.assigned_to`;

router.get(
  '/',
  ah(async (req, res) => {
    const f = { status: req.query.status ?? 'OPEN_ALL', type: req.query.type || '', supplier_id: int(req.query.supplier_id) || null };
    const where = [VISIBLE];
    const params = [];
    if (f.status === 'OPEN_ALL') where.push("x.status NOT IN ('RESOLVED','REJECTED')");
    else if (f.status) { where.push('x.status = ?'); params.push(f.status); }
    if (f.type) { where.push('x.issue_type = ?'); params.push(f.type); }
    if (f.supplier_id) { where.push('po.supplier_id = ?'); params.push(f.supplier_id); }
    const rows = await db.query(
      `SELECT x.*, v.sku, v.name, g.id AS gr_id, g.code AS gr_code, g.status AS gr_status, po.id AS po_id, po.code AS po_code,
              s.name AS supplier_name, a.full_name AS assigned_name
         ${BASE} WHERE ${where.join(' AND ')} ORDER BY x.id DESC LIMIT 300`,
      params
    );
    res.render('issues/index', { title: 'Hàng phát sinh', rows, f, suppliers: await lookups.suppliers() });
  })
);

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const x = await db.one(
      `SELECT x.*, v.sku, v.name, g.id AS gr_id, g.code AS gr_code, g.status AS gr_status, g.receipt_date, po.id AS po_id, po.code AS po_code,
              s.name AS supplier_name, s.phone AS supplier_phone, s.contact_name, c.full_name AS created_by_name, r.full_name AS resolved_by_name
         ${BASE} JOIN users c ON c.id = x.created_by LEFT JOIN users r ON r.id = x.resolved_by
        WHERE x.id = ?`,
      [req.params.id]
    );
    if (!x) return next();
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'goods_receipt_issues' AND l.entity_id = ? ORDER BY l.id DESC`,
      [x.id]
    );
    res.render('issues/show', { title: `Phát sinh ${x.sku}`, x, logs, purchasers: await lookups.purchasers() });
  })
);

router.post(
  '/:id',
  requirePerm('issues.manage'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const data = {
      status: req.body.status,
      resolution: str(req.body.resolution),
      resolution_note: str(req.body.resolution_note),
      assigned_to: int(req.body.assigned_to) || null,
    };
    if (!LABELS.issueStatus[data.status]) throw new AppError('Trạng thái không hợp lệ.');
    if (data.resolution && !LABELS.resolution[data.resolution]) throw new AppError('Hướng xử lý không hợp lệ.');
    if (data.status === 'RESOLVED' && !data.resolution) throw new AppError('Chọn hướng xử lý trước khi đóng phát sinh.');
    await db.tx(async (conn) => {
      const [[old]] = await conn.query('SELECT status, resolution, resolution_note, assigned_to FROM goods_receipt_issues WHERE id = ? FOR UPDATE', [id]);
      const closing = ['RESOLVED', 'REJECTED'].includes(data.status);
      await conn.query('UPDATE goods_receipt_issues SET ?, resolved_by = ?, resolved_at = ? WHERE id = ?', [
        data,
        closing ? req.session.user.id : null,
        closing ? new Date() : null,
        id,
      ]);
      await audit(conn, req, 'UPDATE', 'goods_receipt_issues', id, old, data);
    });
    flash(req, 'success', 'Đã cập nhật xử lý phát sinh.');
    res.redirect(`/issues/${id}`);
  })
);

module.exports = router;
