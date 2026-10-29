// Đơn bán hàng: Nháp -> Xác nhận (giữ hàng) -> Xuất một phần -> Đã xuất đủ / Đóng
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, dec, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const lookups = require('../lib/lookups');
const { availableQty } = require('../services/stock');

const router = express.Router();

function parseForm(b) {
  const header = {
    customer_id: int(b.customer_id) || null,
    warehouse_id: int(b.warehouse_id) || null,
    order_date: str(b.order_date) || today(),
    shipping_address: str(b.shipping_address),
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
  if (!header.customer_id) throw new AppError('Chọn khách hàng.');
  if (!header.warehouse_id) throw new AppError('Chọn kho xuất hàng.');
  if (!items.length) throw new AppError('Đơn phải có ít nhất 1 dòng hàng.');
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
  return { customers: await lookups.customers(), warehouses: await lookups.warehouses(), variants: await lookups.variants() };
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '', customer_id: int(req.query.customer_id) || null };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('o.code LIKE ?'); params.push(`%${f.q}%`); }
    if (f.status === 'OPEN') where.push("o.status IN ('CONFIRMED','PARTIALLY_SHIPPED')");
    else if (f.status) { where.push('o.status = ?'); params.push(f.status); }
    if (f.customer_id) { where.push('o.customer_id = ?'); params.push(f.customer_id); }
    const rows = await db.query(
      `SELECT o.*, c.name AS customer_name, w.code AS warehouse_code,
              (SELECT SUM(quantity_ordered) FROM sales_order_items WHERE sales_order_id = o.id) AS qty_ordered,
              (SELECT SUM(quantity_shipped) FROM sales_order_items WHERE sales_order_id = o.id) AS qty_shipped
         FROM sales_orders o JOIN customers c ON c.id = o.customer_id JOIN warehouses w ON w.id = o.warehouse_id
        WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 300`,
      params
    );
    res.render('sales-orders/index', { title: 'Đơn bán hàng', rows, f, customers: await lookups.customers() });
  })
);

router.get(
  '/new',
  requirePerm('so.manage'),
  ah(async (req, res) => {
    const data = await formData();
    const c = data.customers.find((x) => x.id === int(req.query.customer_id));
    res.render('sales-orders/form', {
      title: 'Tạo đơn bán hàng',
      so: { order_date: today(), customer_id: c ? c.id : null, shipping_address: c ? c.address : null, warehouse_id: data.warehouses[0]?.id },
      items: [{}],
      ...data,
      error: null,
    });
  })
);

router.post(
  '/',
  requirePerm('so.manage'),
  ah(async (req, res) => {
    const form = parseForm(req.body);
    try {
      validate(form);
      const t = totals(form.items);
      const id = await db.tx(async (conn) => {
        const code = await nextCode(conn, 'SO');
        const [r] = await conn.query('INSERT INTO sales_orders SET ?', [{ ...form.header, ...t, code, status: 'DRAFT', created_by: req.session.user.id }]);
        for (const it of form.items) await conn.query('INSERT INTO sales_order_items SET ?', [{ ...it, sales_order_id: r.insertId }]);
        await audit(conn, req, 'CREATE', 'sales_orders', r.insertId, null, { code, ...form.header, ...t, items: form.items.length });
        return r.insertId;
      });
      flash(req, 'success', 'Đã tạo đơn bán (nháp). Bấm Xác nhận để giữ hàng cho đơn.');
      res.redirect(`/sales-orders/${id}`);
    } catch (err) {
      res.status(422).render('sales-orders/form', { title: 'Tạo đơn bán hàng', so: form.header, items: form.items.length ? form.items : [{}], ...(await formData()), error: userMessage(err) });
    }
  })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const so = await db.one(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, w.name AS warehouse_name,
              u.full_name AS created_by_name, x.full_name AS confirmed_by_name
         FROM sales_orders o JOIN customers c ON c.id = o.customer_id JOIN warehouses w ON w.id = o.warehouse_id
         JOIN users u ON u.id = o.created_by LEFT JOIN users x ON x.id = o.confirmed_by
        WHERE o.id = ?`,
      [req.params.id]
    );
    if (!so) return next();
    const items = await db.query(
      `SELECT i.*, v.sku, v.name,
              (SELECT COALESCE(SUM(gi.quantity),0) FROM goods_issue_items gi JOIN goods_issues g ON g.id = gi.goods_issue_id
                WHERE gi.sales_order_item_id = i.id AND g.status = 'PENDING_APPROVAL') AS qty_pending
         FROM sales_order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.sales_order_id = ? ORDER BY i.id`,
      [so.id]
    );
    // Tồn khả dụng hiện tại (không tính phần đơn này đang giữ)
    for (const it of items) it.available = await availableQty(db.pool, so.warehouse_id, it.variant_id, so.id);
    const issues = await db.query(
      `SELECT g.*, u.full_name, (SELECT SUM(quantity) FROM goods_issue_items WHERE goods_issue_id = g.id) AS qty
         FROM goods_issues g JOIN users u ON u.id = g.created_by WHERE g.sales_order_id = ? ORDER BY g.id`,
      [so.id]
    );
    const returns = await db.query(
      `SELECT r.*, (SELECT SUM(quantity) FROM return_receipt_items WHERE return_receipt_id = r.id) AS qty
         FROM return_receipts r WHERE r.sales_order_id = ? ORDER BY r.id`,
      [so.id]
    );
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'sales_orders' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 50`,
      [so.id]
    );
    const hasIssues = issues.some((g) => ['PENDING_APPROVAL', 'APPROVED'].includes(g.status));
    res.render('sales-orders/show', { title: so.code, so, items, issues, returns, logs, canCancel: !hasIssues });
  })
);

router.get(
  '/:id(\\d+)/edit',
  requirePerm('so.manage'),
  ah(async (req, res, next) => {
    const so = await db.one('SELECT * FROM sales_orders WHERE id = ?', [req.params.id]);
    if (!so) return next();
    if (so.status !== 'DRAFT') {
      flash(req, 'warning', 'Chỉ sửa được đơn ở trạng thái Nháp.');
      return res.redirect(`/sales-orders/${so.id}`);
    }
    const items = await db.query('SELECT * FROM sales_order_items WHERE sales_order_id = ? ORDER BY id', [so.id]);
    res.render('sales-orders/form', { title: `Sửa ${so.code}`, so, items, ...(await formData()), error: null });
  })
);

router.post(
  '/:id(\\d+)',
  requirePerm('so.manage'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const form = parseForm(req.body);
    try {
      validate(form);
      const t = totals(form.items);
      await db.tx(async (conn) => {
        const [[old]] = await conn.query('SELECT * FROM sales_orders WHERE id = ? FOR UPDATE', [id]);
        if (!old || old.status !== 'DRAFT') throw new AppError('Chỉ sửa được đơn ở trạng thái Nháp.');
        await conn.query('UPDATE sales_orders SET ? WHERE id = ?', [{ ...form.header, ...t }, id]);
        await conn.query('DELETE FROM sales_order_items WHERE sales_order_id = ?', [id]);
        for (const it of form.items) await conn.query('INSERT INTO sales_order_items SET ?', [{ ...it, sales_order_id: id }]);
        const pick = (o) => ({ customer_id: o.customer_id, warehouse_id: o.warehouse_id, order_date: o.order_date, shipping_address: o.shipping_address, note: o.note, total_amount: o.total_amount });
        await audit(conn, req, 'UPDATE', 'sales_orders', id, pick(old), { ...pick({ ...form.header, ...t }), items: form.items.length });
      });
      flash(req, 'success', 'Đã lưu đơn bán.');
      res.redirect(`/sales-orders/${id}`);
    } catch (err) {
      const so = await db.one('SELECT id, code, status FROM sales_orders WHERE id = ?', [id]);
      res.status(422).render('sales-orders/form', { title: `Sửa ${so.code}`, so: { ...so, ...form.header }, items: form.items.length ? form.items : [{}], ...(await formData()), error: userMessage(err) });
    }
  })
);

const TRANSITIONS = {
  confirm: { from: ['DRAFT'], to: 'CONFIRMED', action: 'CONFIRM', msg: 'Đã xác nhận đơn. Hàng đã được giữ cho đơn này.' },
  cancel: { from: ['DRAFT', 'CONFIRMED'], to: 'CANCELLED', action: 'CANCEL', msg: 'Đã huỷ đơn bán. Hàng giữ cho đơn đã được trả lại.' },
  close: { from: ['CONFIRMED', 'PARTIALLY_SHIPPED'], to: 'CLOSED', action: 'CLOSE', msg: 'Đã đóng đơn. Phần chưa xuất không còn được giữ hàng.' },
};

router.post(
  '/:id(\\d+)/:op(confirm|cancel|close)',
  requirePerm('so.manage'),
  ah(async (req, res) => {
    const t = TRANSITIONS[req.params.op];
    const id = Number(req.params.id);
    await db.tx(async (conn) => {
      const [[so]] = await conn.query('SELECT * FROM sales_orders WHERE id = ? FOR UPDATE', [id]);
      if (!so || !t.from.includes(so.status)) throw new AppError('Trạng thái đơn không cho phép thao tác này.');
      const [[{ open }]] = await conn.query(
        "SELECT COUNT(*) AS open FROM goods_issues WHERE sales_order_id = ? AND status IN ('PENDING_APPROVAL','APPROVED')",
        [id]
      );
      if (req.params.op === 'cancel' && open > 0) throw new AppError('Đơn đã có phiếu xuất kho, không huỷ được. Hãy dùng Đóng đơn.');
      if (req.params.op === 'close') {
        const [[{ pending }]] = await conn.query("SELECT COUNT(*) AS pending FROM goods_issues WHERE sales_order_id = ? AND status = 'PENDING_APPROVAL'", [id]);
        if (pending > 0) throw new AppError('Còn phiếu xuất kho đang chờ duyệt. Duyệt hoặc từ chối trước khi đóng.');
      }
      if (req.params.op === 'confirm') {
        // Khoá tồn của các biến thể trong đơn để 2 đơn không cùng giữ một lượng hàng
        const [items] = await conn.query(
          'SELECT i.variant_id, i.quantity_ordered, v.sku FROM sales_order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.sales_order_id = ?',
          [id]
        );
        await conn.query(
          `SELECT id FROM inventory_stocks WHERE warehouse_id = ? AND variant_id IN (?) FOR UPDATE`,
          [so.warehouse_id, items.map((i) => i.variant_id)]
        );
        const short = [];
        for (const it of items) {
          const avail = await availableQty(conn, so.warehouse_id, it.variant_id, id);
          if (avail < it.quantity_ordered) short.push(`${it.sku} cần ${it.quantity_ordered}, khả dụng ${Math.max(avail, 0)}`);
        }
        if (short.length) throw new AppError(`Không đủ hàng để xác nhận đơn: ${short.join('; ')}.`);
      }
      const extra = req.params.op === 'confirm' ? { confirmed_by: req.session.user.id, confirmed_at: new Date() } : {};
      await conn.query('UPDATE sales_orders SET ? WHERE id = ?', [{ status: t.to, ...extra }, id]);
      await audit(conn, req, t.action, 'sales_orders', id, { status: so.status }, { status: t.to });
    });
    flash(req, 'success', t.msg);
    res.redirect(`/sales-orders/${id}`);
  })
);

module.exports = router;
