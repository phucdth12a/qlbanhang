// Phiếu nhập hàng trả về: hàng vào kho theo tình trạng NEW / USED / DAMAGED sau khi được duyệt
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const { LABELS, label } = require('../lib/labels');
const lookups = require('../lib/lookups');
const { addStock, checkLocationStatus } = require('../services/stock');

const router = express.Router();
const EDITABLE = ['DRAFT', 'REJECTED'];

function parseForm(b) {
  const header = {
    warehouse_id: int(b.warehouse_id) || null,
    return_date: str(b.return_date) || today(),
    source_type: LABELS.returnSource[b.source_type] ? b.source_type : 'CUSTOMER',
    order_code: str(b.order_code),
    tracking_code: str(b.tracking_code),
    customer_name: str(b.customer_name),
    customer_phone: str(b.customer_phone),
    reason: str(b.reason),
    note: str(b.note),
  };
  const items = toArray(b.items)
    .map((r) => ({
      variant_id: int(r.variant_id) || null,
      location_id: int(r.location_id) || null,
      stock_status: r.stock_status,
      quantity: int(r.quantity),
      return_reason: str(r.return_reason),
      note: str(r.note),
    }))
    .filter((r) => r.variant_id || r.quantity);
  return { header, items };
}

async function validate(conn, header, items, { checkLocations }) {
  if (!header.warehouse_id) throw new AppError('Chọn kho nhận hàng trả về.');
  if (!items.length) throw new AppError('Phiếu phải có ít nhất 1 dòng hàng.');
  const [locs] = await conn.query('SELECT id FROM warehouse_locations WHERE warehouse_id = ? AND is_active = 1', [header.warehouse_id]);
  const locIds = new Set(locs.map((l) => l.id));
  const seen = new Map();
  for (const [i, it] of items.entries()) {
    const n = `Dòng ${i + 1}`;
    if (!it.variant_id) throw new AppError(`${n}: chọn sản phẩm.`);
    if (!(it.quantity > 0)) throw new AppError(`${n}: số lượng phải lớn hơn 0.`);
    if (!LABELS.stockStatus[it.stock_status]) throw new AppError(`${n}: chọn tình trạng hàng.`);
    if (!locIds.has(it.location_id)) throw new AppError(`${n}: chọn vị trí trong kho.`);
    if (it.return_reason && !LABELS.returnReason[it.return_reason]) throw new AppError(`${n}: lý do trả không hợp lệ.`);
    const key = `${it.location_id}:${it.variant_id}`;
    if (seen.has(key)) {
      throw new AppError(
        seen.get(key) === it.stock_status
          ? `${n}: trùng sản phẩm và vị trí với dòng trên, hãy gộp số lượng vào một dòng.`
          : `${n}: một vị trí không được chứa cùng sản phẩm với nhiều tình trạng. Hãy cất hàng "${label('stockStatus', it.stock_status)}" vào vị trí khác.`
      );
    }
    seen.set(key, it.stock_status);
    if (checkLocations) {
      const conflict = await checkLocationStatus(conn, it.location_id, it.variant_id, it.stock_status);
      if (conflict) throw new AppError(`${n}: ${conflict} Hãy chọn vị trí khác.`);
    }
  }
}

async function saveItems(conn, id, items) {
  await conn.query('DELETE FROM return_receipt_items WHERE return_receipt_id = ?', [id]);
  for (const it of items) await conn.query('INSERT INTO return_receipt_items SET ?', [{ ...it, return_receipt_id: id }]);
}

async function logApproval(conn, req, id, action, from, to, comment = null) {
  await conn.query('INSERT INTO return_receipt_approvals SET ?', [{ return_receipt_id: id, action, from_status: from, to_status: to, comment, acted_by: req.session.user.id }]);
  await audit(conn, req, action, 'return_receipts', id, { status: from }, { status: to, ...(comment ? { comment } : {}) });
}

async function renderForm(res, { rr, items, error, status = 200 }) {
  res.status(status).render('returns/form', {
    title: rr.id ? `Sửa phiếu trả về ${rr.code}` : 'Nhập hàng trả về',
    rr,
    items: items.length ? items : [{ stock_status: 'NEW' }],
    warehouses: await lookups.warehouses(),
    locations: await lookups.locations(),
    variants: await lookups.variants(),
    error,
  });
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '' };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('(r.code LIKE ? OR r.order_code LIKE ? OR r.tracking_code LIKE ? OR r.customer_phone LIKE ?)'); params.push(...Array(4).fill(`%${f.q}%`)); }
    if (f.status) { where.push('r.status = ?'); params.push(f.status); }
    const rows = await db.query(
      `SELECT r.*, w.code AS warehouse_code, u.full_name,
              (SELECT SUM(quantity) FROM return_receipt_items WHERE return_receipt_id = r.id AND stock_status = 'NEW') AS qty_new,
              (SELECT SUM(quantity) FROM return_receipt_items WHERE return_receipt_id = r.id AND stock_status = 'USED') AS qty_used,
              (SELECT SUM(quantity) FROM return_receipt_items WHERE return_receipt_id = r.id AND stock_status = 'DAMAGED') AS qty_damaged
         FROM return_receipts r JOIN warehouses w ON w.id = r.warehouse_id JOIN users u ON u.id = r.created_by
        WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 300`,
      params
    );
    res.render('returns/index', { title: 'Hàng trả về', rows, f });
  })
);

router.get(
  '/new',
  requirePerm('rr.create'),
  ah(async (req, res) => {
    const [w] = await lookups.warehouses();
    await renderForm(res, { rr: { return_date: today(), source_type: 'CUSTOMER', warehouse_id: w ? w.id : null }, items: [], error: null });
  })
);

router.post(
  ['/', '/:id(\\d+)'],
  requirePerm('rr.create'),
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const { header, items } = parseForm(req.body);
    const submitNow = !!req.body.submit_now;
    let existing = null;
    try {
      const newId = await db.tx(async (conn) => {
        if (id) {
          [[existing]] = await conn.query('SELECT * FROM return_receipts WHERE id = ? FOR UPDATE', [id]);
          if (!existing || !EDITABLE.includes(existing.status)) throw new AppError('Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
        }
        await validate(conn, header, items, { checkLocations: submitNow });
        let rid = id;
        if (id) {
          const pick = (o) => Object.fromEntries(Object.keys(header).map((k) => [k, o[k]]));
          await conn.query('UPDATE return_receipts SET ? WHERE id = ?', [header, id]);
          await audit(conn, req, 'UPDATE', 'return_receipts', id, pick(existing), { ...header, lines: items.length });
        } else {
          const code = await nextCode(conn, 'RR');
          const [r] = await conn.query('INSERT INTO return_receipts SET ?', [{ ...header, code, status: 'DRAFT', created_by: req.session.user.id }]);
          rid = r.insertId;
          await audit(conn, req, 'CREATE', 'return_receipts', rid, null, { code, ...header, lines: items.length });
        }
        await saveItems(conn, rid, items);
        if (submitNow) {
          await conn.query("UPDATE return_receipts SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [rid]);
          await logApproval(conn, req, rid, 'SUBMIT', existing ? existing.status : 'DRAFT', 'PENDING_APPROVAL');
        }
        return rid;
      });
      flash(req, 'success', submitNow ? 'Đã lưu và gửi duyệt phiếu trả về.' : 'Đã lưu phiếu trả về (nháp).');
      res.redirect(`/returns/${newId}`);
    } catch (err) {
      await renderForm(res, { rr: { ...(existing || {}), ...header, id }, items, error: userMessage(err), status: 422 });
    }
  })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const rr = await db.one(
      `SELECT r.*, w.name AS warehouse_name, u.full_name AS created_by_name, v.full_name AS reviewed_by_name
         FROM return_receipts r JOIN warehouses w ON w.id = r.warehouse_id JOIN users u ON u.id = r.created_by LEFT JOIN users v ON v.id = r.reviewed_by
        WHERE r.id = ?`,
      [req.params.id]
    );
    if (!rr) return next();
    const items = await db.query(
      `SELECT i.*, v.sku, v.name, l.code AS location_code,
              s.stock_status AS cur_status, s.quantity AS cur_qty
         FROM return_receipt_items i JOIN product_variants v ON v.id = i.variant_id JOIN warehouse_locations l ON l.id = i.location_id
         LEFT JOIN inventory_stocks s ON s.location_id = i.location_id AND s.variant_id = i.variant_id
        WHERE i.return_receipt_id = ? ORDER BY i.id`,
      [rr.id]
    );
    const approvals = await db.query(
      'SELECT a.*, u.full_name FROM return_receipt_approvals a JOIN users u ON u.id = a.acted_by WHERE a.return_receipt_id = ? ORDER BY a.id',
      [rr.id]
    );
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'return_receipts' AND l.entity_id = ? ORDER BY l.id DESC`,
      [rr.id]
    );
    res.render('returns/show', { title: rr.code, rr, items, approvals, logs, EDITABLE });
  })
);

router.get(
  '/:id(\\d+)/edit',
  requirePerm('rr.create'),
  ah(async (req, res, next) => {
    const rr = await db.one('SELECT * FROM return_receipts WHERE id = ?', [req.params.id]);
    if (!rr) return next();
    if (!EDITABLE.includes(rr.status)) {
      flash(req, 'warning', 'Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
      return res.redirect(`/returns/${rr.id}`);
    }
    const items = await db.query('SELECT * FROM return_receipt_items WHERE return_receipt_id = ? ORDER BY id', [rr.id]);
    await renderForm(res, { rr, items, error: null });
  })
);

router.post(
  '/:id(\\d+)/submit',
  requirePerm('rr.create'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[rr]] = await conn.query('SELECT * FROM return_receipts WHERE id = ? FOR UPDATE', [id]);
      if (!EDITABLE.includes(rr.status)) throw new AppError('Phiếu không ở trạng thái Nháp / Từ chối.');
      const [items] = await conn.query('SELECT * FROM return_receipt_items WHERE return_receipt_id = ?', [id]);
      await validate(conn, rr, items, { checkLocations: true });
      await conn.query("UPDATE return_receipts SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [id]);
      await logApproval(conn, req, id, 'SUBMIT', rr.status, 'PENDING_APPROVAL');
    });
    flash(req, 'success', 'Đã gửi duyệt.');
    res.redirect(`/returns/${id}`);
  })
);

router.post(
  '/:id(\\d+)/approve',
  requirePerm('rr.approve'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[rr]] = await conn.query('SELECT * FROM return_receipts WHERE id = ? FOR UPDATE', [id]);
      if (rr.status !== 'PENDING_APPROVAL') throw new AppError('Phiếu không ở trạng thái chờ duyệt.');
      const [items] = await conn.query('SELECT * FROM return_receipt_items WHERE return_receipt_id = ?', [id]);
      for (const it of items) {
        await addStock(conn, {
          warehouseId: rr.warehouse_id,
          locationId: it.location_id,
          variantId: it.variant_id,
          status: it.stock_status,
          quantity: it.quantity,
          type: 'RETURN_RECEIPT',
          refType: 'return_receipt',
          refId: id,
          refItemId: it.id,
          userId: req.session.user.id,
        });
      }
      await conn.query("UPDATE return_receipts SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW(), review_note = NULL WHERE id = ?", [req.session.user.id, id]);
      await logApproval(conn, req, id, 'APPROVE', 'PENDING_APPROVAL', 'APPROVED', str(req.body.comment));
    });
    flash(req, 'success', 'Đã duyệt. Hàng trả về đã vào tồn kho theo đúng tình trạng.');
    res.redirect(`/returns/${id}`);
  })
);

router.post(
  '/:id(\\d+)/reject',
  requirePerm('rr.approve'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const reason = str(req.body.reason);
    if (!reason) throw new AppError('Nhập lý do từ chối.');
    await db.tx(async (conn) => {
      const [[rr]] = await conn.query('SELECT status FROM return_receipts WHERE id = ? FOR UPDATE', [id]);
      if (rr.status !== 'PENDING_APPROVAL') throw new AppError('Phiếu không ở trạng thái chờ duyệt.');
      await conn.query("UPDATE return_receipts SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?", [req.session.user.id, reason, id]);
      await logApproval(conn, req, id, 'REJECT', 'PENDING_APPROVAL', 'REJECTED', reason);
    });
    flash(req, 'success', 'Đã từ chối phiếu trả về.');
    res.redirect(`/returns/${id}`);
  })
);

router.post(
  '/:id(\\d+)/cancel',
  requirePerm('rr.create'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[rr]] = await conn.query('SELECT status FROM return_receipts WHERE id = ? FOR UPDATE', [id]);
      if (!EDITABLE.includes(rr.status)) throw new AppError('Chỉ huỷ được phiếu Nháp hoặc bị Từ chối.');
      await conn.query("UPDATE return_receipts SET status = 'CANCELLED' WHERE id = ?", [id]);
      await logApproval(conn, req, id, 'CANCEL', rr.status, 'CANCELLED');
    });
    flash(req, 'success', 'Đã huỷ phiếu trả về.');
    res.redirect(`/returns/${id}`);
  })
);

module.exports = router;
