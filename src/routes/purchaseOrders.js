const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, dec, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const lookups = require('../lib/lookups');

const router = express.Router();

function parseForm(b) {
  const header = {
    supplier_id: int(b.supplier_id) || null,
    warehouse_id: int(b.warehouse_id) || null,
    order_date: str(b.order_date) || today(),
    expected_date: str(b.expected_date),
    note: str(b.note),
  };
  const items = toArray(b.items)
    .map((r) => ({
      variant_id: int(r.variant_id) || null,
      quantity_ordered: int(r.quantity_ordered),
      unit_price: dec(r.unit_price),
      tax_rate: dec(r.tax_rate),
      note: str(r.note),
    }))
    .filter((r) => r.variant_id || r.quantity_ordered);
  return { header, items };
}

function validate({ header, items }) {
  if (!header.supplier_id) throw new AppError('Chọn nhà cung cấp.');
  if (!header.warehouse_id) throw new AppError('Chọn kho nhận hàng.');
  if (!items.length) throw new AppError('Phiếu mua phải có ít nhất 1 dòng hàng.');
  const seen = new Set();
  items.forEach((it, i) => {
    if (!it.variant_id) throw new AppError(`Dòng ${i + 1}: chọn sản phẩm.`);
    if (!(it.quantity_ordered > 0)) throw new AppError(`Dòng ${i + 1}: số lượng phải lớn hơn 0.`);
    if (it.unit_price < 0 || it.tax_rate < 0) throw new AppError(`Dòng ${i + 1}: đơn giá và thuế không được âm.`);
    if (seen.has(it.variant_id)) throw new AppError(`Dòng ${i + 1}: sản phẩm bị trùng, hãy gộp vào một dòng.`);
    seen.add(it.variant_id);
  });
}

function totals(items) {
  let subtotal = 0;
  let tax = 0;
  items.forEach((it) => {
    it.line_total = it.quantity_ordered * it.unit_price;
    subtotal += it.line_total;
    tax += (it.line_total * it.tax_rate) / 100;
  });
  return { subtotal, tax_amount: Math.round(tax), total_amount: Math.round(subtotal + tax) };
}

async function formData() {
  return { suppliers: await lookups.suppliers(), warehouses: await lookups.warehouses(), variants: await lookups.variants() };
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '', supplier_id: int(req.query.supplier_id) || null };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('po.code LIKE ?'); params.push(`%${f.q}%`); }
    if (f.status === 'OPEN') where.push("po.status IN ('CONFIRMED','PARTIALLY_RECEIVED')");
    else if (f.status) { where.push('po.status = ?'); params.push(f.status); }
    if (f.supplier_id) { where.push('po.supplier_id = ?'); params.push(f.supplier_id); }
    const rows = await db.query(
      `SELECT po.*, s.name AS supplier_name, w.code AS warehouse_code,
              (SELECT SUM(quantity_ordered) FROM purchase_order_items WHERE purchase_order_id = po.id) AS qty_ordered,
              (SELECT SUM(quantity_received) FROM purchase_order_items WHERE purchase_order_id = po.id) AS qty_received
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id
        WHERE ${where.join(' AND ')} ORDER BY po.id DESC LIMIT 300`,
      params
    );
    res.render('purchase-orders/index', { title: 'Phiếu mua hàng', rows, f, suppliers: await lookups.suppliers() });
  })
);

router.get(
  '/new',
  requirePerm('po.manage'),
  ah(async (req, res) => {
    res.render('purchase-orders/form', {
      title: 'Tạo phiếu mua hàng',
      po: { order_date: today() },
      items: [{}],
      ...(await formData()),
      error: null,
    });
  })
);

router.post(
  '/',
  requirePerm('po.manage'),
  ah(async (req, res) => {
    const form = parseForm(req.body);
    try {
      validate(form);
      const t = totals(form.items);
      const id = await db.tx(async (conn) => {
        const code = await nextCode(conn, 'PO');
        const [r] = await conn.query('INSERT INTO purchase_orders SET ?', [{ ...form.header, ...t, code, status: 'DRAFT', created_by: req.session.user.id }]);
        for (const it of form.items) await conn.query('INSERT INTO purchase_order_items SET ?', [{ ...it, purchase_order_id: r.insertId }]);
        await audit(conn, req, 'CREATE', 'purchase_orders', r.insertId, null, { code, ...form.header, ...t, items: form.items.length });
        return r.insertId;
      });
      flash(req, 'success', 'Đã tạo phiếu mua hàng (nháp). Kiểm tra lại rồi bấm Xác nhận để gửi NCC.');
      res.redirect(`/purchase-orders/${id}`);
    } catch (err) {
      res.status(422).render('purchase-orders/form', { title: 'Tạo phiếu mua hàng', po: form.header, items: form.items.length ? form.items : [{}], ...(await formData()), error: userMessage(err) });
    }
  })
);

async function loadPo(id) {
  return db.one(
    `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code, s.phone AS supplier_phone, w.name AS warehouse_name,
            u.full_name AS created_by_name, c.full_name AS confirmed_by_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id
       JOIN users u ON u.id = po.created_by LEFT JOIN users c ON c.id = po.confirmed_by
      WHERE po.id = ?`,
    [id]
  );
}

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const po = await loadPo(req.params.id);
    if (!po) return next();
    const items = await db.query(
      `SELECT i.*, v.sku, v.name,
              (SELECT COALESCE(SUM(gi.quantity_accepted),0) FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.goods_receipt_id
                WHERE gi.purchase_order_item_id = i.id AND g.status = 'PENDING_APPROVAL') AS qty_pending
         FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.purchase_order_id = ? ORDER BY i.id`,
      [po.id]
    );
    const receipts = await db.query(
      `SELECT g.*, u.full_name, (SELECT SUM(quantity_accepted) FROM goods_receipt_items WHERE goods_receipt_id = g.id) AS qty_accepted,
              (SELECT SUM(quantity_issue) FROM goods_receipt_items WHERE goods_receipt_id = g.id) AS qty_issue
         FROM goods_receipts g JOIN users u ON u.id = g.created_by WHERE g.purchase_order_id = ? ORDER BY g.id`,
      [po.id]
    );
    const [{ approved }] = await db.query("SELECT COUNT(*) AS approved FROM goods_receipts WHERE purchase_order_id = ? AND status IN ('APPROVED','PENDING_APPROVAL')", [po.id]);
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'purchase_orders' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 50`,
      [po.id]
    );
    res.render('purchase-orders/show', { title: po.code, po, items, receipts, logs, canCancel: approved === 0 });
  })
);

router.get(
  '/:id/edit',
  requirePerm('po.manage'),
  ah(async (req, res, next) => {
    const po = await db.one('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return next();
    if (po.status !== 'DRAFT') {
      flash(req, 'warning', 'Chỉ sửa được phiếu ở trạng thái Nháp.');
      return res.redirect(`/purchase-orders/${po.id}`);
    }
    const items = await db.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id', [po.id]);
    res.render('purchase-orders/form', { title: `Sửa ${po.code}`, po, items, ...(await formData()), error: null });
  })
);

router.post(
  '/:id',
  requirePerm('po.manage'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const form = parseForm(req.body);
    try {
      validate(form);
      const t = totals(form.items);
      await db.tx(async (conn) => {
        const [[old]] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [id]);
        if (!old || old.status !== 'DRAFT') throw new AppError('Chỉ sửa được phiếu ở trạng thái Nháp.');
        await conn.query('UPDATE purchase_orders SET ? WHERE id = ?', [{ ...form.header, ...t }, id]);
        await conn.query('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [id]);
        for (const it of form.items) await conn.query('INSERT INTO purchase_order_items SET ?', [{ ...it, purchase_order_id: id }]);
        const pick = (o) => ({ supplier_id: o.supplier_id, warehouse_id: o.warehouse_id, order_date: o.order_date, expected_date: o.expected_date, note: o.note, total_amount: o.total_amount });
        await audit(conn, req, 'UPDATE', 'purchase_orders', id, pick(old), { ...pick({ ...form.header, ...t }), items: form.items.length });
      });
      flash(req, 'success', 'Đã lưu phiếu mua hàng.');
      res.redirect(`/purchase-orders/${id}`);
    } catch (err) {
      const po = await db.one('SELECT id, code, status FROM purchase_orders WHERE id = ?', [id]);
      res.status(422).render('purchase-orders/form', { title: `Sửa ${po.code}`, po: { ...po, ...form.header }, items: form.items.length ? form.items : [{}], ...(await formData()), error: userMessage(err) });
    }
  })
);

// Đổi trạng thái: confirm | cancel | close
const TRANSITIONS = {
  confirm: { from: ['DRAFT'], to: 'CONFIRMED', action: 'CONFIRM', msg: 'Đã xác nhận phiếu mua hàng.' },
  cancel: { from: ['DRAFT', 'CONFIRMED'], to: 'CANCELLED', action: 'CANCEL', msg: 'Đã huỷ phiếu mua hàng.' },
  close: { from: ['CONFIRMED', 'PARTIALLY_RECEIVED'], to: 'CLOSED', action: 'CLOSE', msg: 'Đã đóng phiếu mua hàng. Không nhập thêm hàng cho phiếu này.' },
};

router.post(
  '/:id/:op(confirm|cancel|close)',
  requirePerm('po.manage'),
  ah(async (req, res) => {
    const t = TRANSITIONS[req.params.op];
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[po]] = await conn.query('SELECT status FROM purchase_orders WHERE id = ? FOR UPDATE', [id]);
      if (!po || !t.from.includes(po.status)) throw new AppError('Trạng thái phiếu không cho phép thao tác này.');
      const [[{ open }]] = await conn.query(
        "SELECT COUNT(*) AS open FROM goods_receipts WHERE purchase_order_id = ? AND status IN ('PENDING_APPROVAL','APPROVED')",
        [id]
      );
      if (req.params.op === 'cancel' && open > 0) throw new AppError('Phiếu đã có phiếu nhập kho, không huỷ được. Hãy dùng Đóng phiếu.');
      if (req.params.op === 'close') {
        const [[{ pending }]] = await conn.query("SELECT COUNT(*) AS pending FROM goods_receipts WHERE purchase_order_id = ? AND status = 'PENDING_APPROVAL'", [id]);
        if (pending > 0) throw new AppError('Còn phiếu nhập kho đang chờ duyệt. Duyệt hoặc từ chối trước khi đóng.');
      }
      const extra = req.params.op === 'confirm' ? { confirmed_by: req.session.user.id, confirmed_at: new Date() } : {};
      await conn.query('UPDATE purchase_orders SET ? WHERE id = ?', [{ status: t.to, ...extra }, id]);
      await audit(conn, req, t.action, 'purchase_orders', id, { status: po.status }, { status: t.to, ...(req.body.reason ? { reason: req.body.reason } : {}) });
    });
    flash(req, 'success', t.msg);
    res.redirect(`/purchase-orders/${id}`);
  })
);

module.exports = router;
