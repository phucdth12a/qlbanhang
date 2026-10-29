const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const lookups = require('../lib/lookups');
const svc = require('../services/goodsReceipts');

const router = express.Router();
const EDITABLE = ['DRAFT', 'REJECTED'];

function parseForm(b) {
  const header = { receipt_date: str(b.receipt_date) || today(), delivery_note_no: str(b.delivery_note_no), note: str(b.note) };
  const items = toArray(b.items)
    .map((r) => ({
      purchase_order_item_id: int(r.purchase_order_item_id),
      location_id: int(r.location_id) || null,
      quantity_accepted: int(r.quantity_accepted),
      quantity_issue: int(r.quantity_issue),
      issue_type: str(r.issue_type),
      issue_description: str(r.issue_description),
      note: str(r.note),
    }));
  return { header, items, filled: items.filter((r) => r.quantity_accepted > 0 || r.quantity_issue > 0) };
}

async function renderForm(res, { gr, po, items, error, status = 200 }) {
  const lines = await svc.poLines(db.pool, po.id, gr.id || 0);
  const byPoItem = new Map(items.map((i) => [i.purchase_order_item_id, i]));
  const rows = lines.map((l) => ({ ...l, input: byPoItem.get(l.id) || {} }));
  res.status(status).render('goods-receipts/form', {
    title: gr.id ? `Sửa phiếu nhập ${gr.code}` : 'Tạo phiếu nhập kho',
    gr,
    po,
    rows,
    locations: await lookups.locations(po.warehouse_id),
    error,
  });
}

async function loadPo(id) {
  return db.one(
    `SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id WHERE po.id = ?`,
    [id]
  );
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '' };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('(g.code LIKE ? OR po.code LIKE ? OR g.delivery_note_no LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    if (f.status) { where.push('g.status = ?'); params.push(f.status); }
    const rows = await db.query(
      `SELECT g.*, po.code AS po_code, s.name AS supplier_name, w.code AS warehouse_code, u.full_name,
              (SELECT SUM(quantity_accepted) FROM goods_receipt_items WHERE goods_receipt_id = g.id) AS qty_accepted,
              (SELECT SUM(quantity_issue) FROM goods_receipt_items WHERE goods_receipt_id = g.id) AS qty_issue
         FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id JOIN suppliers s ON s.id = po.supplier_id
         JOIN warehouses w ON w.id = g.warehouse_id JOIN users u ON u.id = g.created_by
        WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT 300`,
      params
    );
    const openPos = await db.query(
      `SELECT po.id, po.code, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.status IN ('CONFIRMED','PARTIALLY_RECEIVED') ORDER BY po.id DESC`
    );
    res.render('goods-receipts/index', { title: 'Phiếu nhập kho', rows, f, openPos });
  })
);

router.get(
  '/new',
  requirePerm('gr.create'),
  ah(async (req, res) => {
    const po = await loadPo(int(req.query.po));
    if (!po || !['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      flash(req, 'warning', 'Chọn một phiếu mua hàng đã xác nhận và còn hàng chưa nhập.');
      return res.redirect('/goods-receipts');
    }
    await renderForm(res, { gr: { receipt_date: today() }, po, items: [], error: null });
  })
);

router.post(
  '/',
  requirePerm('gr.create'),
  ah(async (req, res) => {
    const po = await loadPo(int(req.body.purchase_order_id));
    if (!po) throw new AppError('Phiếu mua hàng không tồn tại.');
    const form = parseForm(req.body);
    const submitNow = !!req.body.submit_now;
    try {
      if (!['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new AppError('Phiếu mua không còn nhận hàng.');
      const id = await db.tx(async (conn) => {
        await svc.validateLines(conn, { poId: po.id, warehouseId: po.warehouse_id, items: form.filled, checkLocations: submitNow });
        const code = await nextCode(conn, 'GR');
        const [r] = await conn.query('INSERT INTO goods_receipts SET ?', [
          { ...form.header, code, purchase_order_id: po.id, warehouse_id: po.warehouse_id, status: 'DRAFT', created_by: req.session.user.id },
        ]);
        await svc.saveItems(conn, req, r.insertId, form.filled);
        await audit(conn, req, 'CREATE', 'goods_receipts', r.insertId, null, { code, po: po.code, ...form.header, lines: form.filled.length });
        if (submitNow) {
          await conn.query("UPDATE goods_receipts SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [r.insertId]);
          await svc.logApproval(conn, req, r.insertId, 'SUBMIT', 'DRAFT', 'PENDING_APPROVAL');
        }
        return r.insertId;
      });
      flash(req, 'success', submitNow ? 'Đã tạo phiếu nhập và gửi duyệt.' : 'Đã lưu phiếu nhập (nháp).');
      res.redirect(`/goods-receipts/${id}`);
    } catch (err) {
      await renderForm(res, { gr: form.header, po, items: form.items, error: userMessage(err), status: 422 });
    }
  })
);

async function loadGr(id) {
  return db.one(
    `SELECT g.*, po.code AS po_code, s.name AS supplier_name, w.name AS warehouse_name, u.full_name AS created_by_name, r.full_name AS reviewed_by_name
       FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = g.warehouse_id JOIN users u ON u.id = g.created_by LEFT JOIN users r ON r.id = g.reviewed_by
      WHERE g.id = ?`,
    [id]
  );
}

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const gr = await loadGr(req.params.id);
    if (!gr) return next();
    const items = await db.query(
      `SELECT gi.*, v.sku, v.name, l.code AS location_code, i.quantity_ordered, i.quantity_received
         FROM goods_receipt_items gi JOIN product_variants v ON v.id = gi.variant_id
         JOIN purchase_order_items i ON i.id = gi.purchase_order_item_id LEFT JOIN warehouse_locations l ON l.id = gi.location_id
        WHERE gi.goods_receipt_id = ? ORDER BY gi.id`,
      [gr.id]
    );
    const issues = await db.query(
      `SELECT x.*, v.sku FROM goods_receipt_issues x JOIN goods_receipt_items gi ON gi.id = x.goods_receipt_item_id
         JOIN product_variants v ON v.id = gi.variant_id WHERE gi.goods_receipt_id = ? ORDER BY x.id`,
      [gr.id]
    );
    const approvals = await db.query(
      'SELECT a.*, u.full_name FROM goods_receipt_approvals a JOIN users u ON u.id = a.acted_by WHERE a.goods_receipt_id = ? ORDER BY a.id',
      [gr.id]
    );
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'goods_receipts' AND l.entity_id = ? ORDER BY l.id DESC`,
      [gr.id]
    );
    res.render('goods-receipts/show', { title: gr.code, gr, items, issues, approvals, logs, EDITABLE });
  })
);

router.get(
  '/:id/edit',
  requirePerm('gr.create'),
  ah(async (req, res, next) => {
    const gr = await db.one('SELECT * FROM goods_receipts WHERE id = ?', [req.params.id]);
    if (!gr) return next();
    if (!EDITABLE.includes(gr.status)) {
      flash(req, 'warning', 'Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
      return res.redirect(`/goods-receipts/${gr.id}`);
    }
    const items = await db.query(
      `SELECT gi.*, x.issue_type, x.description AS issue_description FROM goods_receipt_items gi
         LEFT JOIN goods_receipt_issues x ON x.id = (SELECT MIN(id) FROM goods_receipt_issues WHERE goods_receipt_item_id = gi.id)
        WHERE gi.goods_receipt_id = ?`,
      [gr.id]
    );
    await renderForm(res, { gr, po: await loadPo(gr.purchase_order_id), items, error: null });
  })
);

router.post(
  '/:id',
  requirePerm('gr.create'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const gr = await db.one('SELECT * FROM goods_receipts WHERE id = ?', [id]);
    if (!gr) throw new AppError('Phiếu không tồn tại.');
    const po = await loadPo(gr.purchase_order_id);
    const form = parseForm(req.body);
    const submitNow = !!req.body.submit_now;
    try {
      await db.tx(async (conn) => {
        const [[cur]] = await conn.query('SELECT status, receipt_date, delivery_note_no, note FROM goods_receipts WHERE id = ? FOR UPDATE', [id]);
        if (!EDITABLE.includes(cur.status)) throw new AppError('Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
        await svc.validateLines(conn, { poId: po.id, warehouseId: gr.warehouse_id, grId: id, items: form.filled, checkLocations: submitNow });
        await conn.query('UPDATE goods_receipts SET ? WHERE id = ?', [form.header, id]);
        await svc.saveItems(conn, req, id, form.filled);
        await audit(conn, req, 'UPDATE', 'goods_receipts', id, { receipt_date: cur.receipt_date, delivery_note_no: cur.delivery_note_no, note: cur.note }, { ...form.header, lines: form.filled.length });
        if (submitNow) {
          await conn.query("UPDATE goods_receipts SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [id]);
          await svc.logApproval(conn, req, id, 'SUBMIT', cur.status, 'PENDING_APPROVAL');
        }
      });
      flash(req, 'success', submitNow ? 'Đã lưu và gửi duyệt.' : 'Đã lưu phiếu nhập.');
      res.redirect(`/goods-receipts/${id}`);
    } catch (err) {
      await renderForm(res, { gr: { ...gr, ...form.header }, po, items: form.items, error: userMessage(err), status: 422 });
    }
  })
);

router.post(
  '/:id/submit',
  requirePerm('gr.create'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[gr]] = await conn.query('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [id]);
      if (!EDITABLE.includes(gr.status)) throw new AppError('Phiếu không ở trạng thái Nháp / Từ chối.');
      const [items] = await conn.query('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ?', [id]);
      await svc.validateLines(conn, { poId: gr.purchase_order_id, warehouseId: gr.warehouse_id, grId: id, items, checkLocations: true, checkIssueType: false });
      await conn.query("UPDATE goods_receipts SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [id]);
      await svc.logApproval(conn, req, id, 'SUBMIT', gr.status, 'PENDING_APPROVAL');
    });
    flash(req, 'success', 'Đã gửi duyệt.');
    res.redirect(`/goods-receipts/${id}`);
  })
);

router.post(
  '/:id/approve',
  requirePerm('gr.approve'),
  ah(async (req, res) => {
    await db.tx((conn) => svc.approve(conn, req, Number(req.params.id)));
    flash(req, 'success', 'Đã duyệt. Hàng đã vào tồn kho và cập nhật số lượng đã nhập trên phiếu mua.');
    res.redirect(`/goods-receipts/${req.params.id}`);
  })
);

router.post(
  '/:id/reject',
  requirePerm('gr.approve'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const reason = str(req.body.reason);
    if (!reason) throw new AppError('Nhập lý do từ chối.');
    await db.tx(async (conn) => {
      const [[gr]] = await conn.query('SELECT status FROM goods_receipts WHERE id = ? FOR UPDATE', [id]);
      if (gr.status !== 'PENDING_APPROVAL') throw new AppError('Phiếu không ở trạng thái chờ duyệt.');
      await conn.query("UPDATE goods_receipts SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?", [req.session.user.id, reason, id]);
      await svc.logApproval(conn, req, id, 'REJECT', 'PENDING_APPROVAL', 'REJECTED', reason);
    });
    flash(req, 'success', 'Đã từ chối phiếu. Người lập có thể sửa và gửi lại.');
    res.redirect(`/goods-receipts/${id}`);
  })
);

router.post(
  '/:id/cancel',
  requirePerm('gr.create'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[gr]] = await conn.query('SELECT status FROM goods_receipts WHERE id = ? FOR UPDATE', [id]);
      if (!EDITABLE.includes(gr.status)) throw new AppError('Chỉ huỷ được phiếu Nháp hoặc bị Từ chối.');
      await conn.query("UPDATE goods_receipts SET status = 'CANCELLED' WHERE id = ?", [id]);
      await svc.logApproval(conn, req, id, 'CANCEL', gr.status, 'CANCELLED');
    });
    flash(req, 'success', 'Đã huỷ phiếu nhập.');
    res.redirect(`/goods-receipts/${id}`);
  })
);

module.exports = router;
