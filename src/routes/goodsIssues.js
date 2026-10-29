// Phiếu xuất kho: bán hàng (từ đơn bán) / trả NCC / huỷ hàng / dùng nội bộ / khác
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const { LABELS, label } = require('../lib/labels');
const lookups = require('../lib/lookups');
const stock = require('../services/stock');
const docs = require('../services/documents');

const router = express.Router();
const TYPE = 'goods_issue';
const BASE = '/goods-issues';

// Dòng đơn bán còn phải xuất = đặt - đã xuất - đang chờ duyệt ở phiếu khác
async function soLines(conn, soId, excludeGiId = 0) {
  const [rows] = await conn.query(
    `SELECT i.id, i.variant_id, i.quantity_ordered, i.quantity_shipped, v.sku, v.name,
            (SELECT COALESCE(SUM(gi.quantity),0) FROM goods_issue_items gi JOIN goods_issues g ON g.id = gi.goods_issue_id
              WHERE gi.sales_order_item_id = i.id AND g.status = 'PENDING_APPROVAL' AND g.id <> ?) AS qty_pending
       FROM sales_order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.sales_order_id = ? ORDER BY i.id`,
    [excludeGiId, soId]
  );
  rows.forEach((r) => (r.remaining = r.quantity_ordered - r.quantity_shipped - r.qty_pending));
  return rows;
}

function parseForm(b) {
  const header = {
    warehouse_id: int(b.warehouse_id) || null,
    purpose: LABELS.giPurpose[b.purpose] ? b.purpose : 'OTHER',
    sales_order_id: int(b.sales_order_id) || null,
    supplier_id: int(b.supplier_id) || null,
    issue_date: str(b.issue_date) || today(),
    note: str(b.note),
  };
  let items;
  if (header.purpose === 'SALE') {
    items = toArray(b.lines).flatMap((line) =>
      toArray(line.alloc).map((a) => ({ sales_order_item_id: int(line.so_item_id), stock_id: int(a.stock_id) || null, quantity: int(a.quantity), note: null }))
    );
  } else {
    items = toArray(b.items).map((r) => ({ sales_order_item_id: null, stock_id: int(r.stock_id) || null, quantity: int(r.quantity), note: str(r.note) }));
  }
  return { header, items: items.filter((i) => i.stock_id || i.quantity) };
}

// Kiểm tra và gắn location/variant/status cho từng dòng từ ô tồn đã chọn
async function validate(conn, header, items, { grId = 0, strict = false } = {}) {
  if (!header.warehouse_id) throw new AppError('Chọn kho xuất.');
  if (header.purpose === 'SALE' && !header.sales_order_id) throw new AppError('Phiếu xuất bán phải gắn với đơn bán.');
  if (header.purpose === 'RETURN_TO_SUPPLIER' && !header.supplier_id) throw new AppError('Chọn nhà cung cấp nhận hàng trả.');
  if (!items.length) throw new AppError('Nhập số lượng xuất cho ít nhất 1 dòng.');

  let lines = new Map();
  if (header.purpose === 'SALE') {
    const [[so]] = await conn.query('SELECT status, warehouse_id FROM sales_orders WHERE id = ?', [header.sales_order_id]);
    if (!so || !['CONFIRMED', 'PARTIALLY_SHIPPED'].includes(so.status)) throw new AppError('Đơn bán không còn chờ xuất hàng.');
    if (so.warehouse_id !== header.warehouse_id) throw new AppError('Kho xuất phải là kho của đơn bán.');
    lines = new Map((await soLines(conn, header.sales_order_id, grId)).map((l) => [l.id, { ...l, sum: 0 }]));
  }
  const seen = new Set();
  const newOut = new Map(); // variant -> SL hàng mới xuất không phải bán (để kiểm tra hàng đang giữ cho đơn)
  for (const it of items) {
    if (!(it.quantity > 0)) throw new AppError('Số lượng xuất phải lớn hơn 0.');
    const [[s]] = await conn.query(
      `SELECT s.*, l.code AS location_code, v.sku FROM inventory_stocks s JOIN warehouse_locations l ON l.id = s.location_id
         JOIN product_variants v ON v.id = s.variant_id WHERE s.id = ?`,
      [it.stock_id]
    );
    if (!s || s.warehouse_id !== header.warehouse_id) throw new AppError('Chọn vị trí lấy hàng trong kho xuất.');
    Object.assign(it, { location_id: s.location_id, variant_id: s.variant_id, stock_status: s.stock_status });
    if (seen.has(it.stock_id)) throw new AppError(`${s.sku} ở ${s.location_code} bị chọn 2 lần, hãy gộp số lượng.`);
    seen.add(it.stock_id);
    if (it.quantity > s.quantity) throw new AppError(`${s.location_code} chỉ còn ${s.quantity} ${s.sku}, không đủ ${it.quantity}.`);
    if (header.purpose === 'SALE') {
      const line = lines.get(it.sales_order_item_id);
      if (!line) throw new AppError('Dòng hàng không thuộc đơn bán.');
      if (line.variant_id !== s.variant_id) throw new AppError(`Vị trí ${s.location_code} không chứa ${line.sku}.`);
      if (s.stock_status !== 'NEW') throw new AppError(`Chỉ xuất bán hàng mới. ${s.location_code} đang chứa hàng "${label('stockStatus', s.stock_status)}".`);
      line.sum += it.quantity;
      if (line.sum > line.remaining) throw new AppError(`${line.sku}: xuất ${line.sum} vượt số còn phải xuất ${Math.max(line.remaining, 0)}.`);
    } else if (s.stock_status === 'NEW') {
      newOut.set(s.variant_id, (newOut.get(s.variant_id) || 0) + it.quantity);
    }
  }
  if (strict) {
    // Xuất hàng mới cho mục đích khác không được lấy vào phần đang giữ cho đơn bán
    for (const [variantId, qty] of newOut) {
      const avail = await stock.availableQty(conn, header.warehouse_id, variantId);
      if (avail < qty) {
        const [[v]] = await conn.query('SELECT sku FROM product_variants WHERE id = ?', [variantId]);
        throw new AppError(`${v.sku}: chỉ còn ${Math.max(avail, 0)} hàng mới không bị giữ cho đơn bán, không xuất được ${qty}.`);
      }
    }
  }
}

async function saveItems(conn, id, items) {
  await conn.query('DELETE FROM goods_issue_items WHERE goods_issue_id = ?', [id]);
  for (const it of items) {
    await conn.query('INSERT INTO goods_issue_items SET ?', [
      { goods_issue_id: id, sales_order_item_id: it.sales_order_item_id, variant_id: it.variant_id, location_id: it.location_id, stock_status: it.stock_status, quantity: it.quantity, note: it.note },
    ]);
  }
}

// Dòng đã lưu -> dạng form (gắn lại stock_id)
async function itemsFromDb(conn, id) {
  const [rows] = await conn.query(
    `SELECT gi.*, s.id AS stock_id FROM goods_issue_items gi
       LEFT JOIN inventory_stocks s ON s.location_id = gi.location_id AND s.variant_id = gi.variant_id
      WHERE gi.goods_issue_id = ? ORDER BY gi.id`,
    [id]
  );
  return rows;
}

async function renderForm(res, { gi, items, error, status = 200 }) {
  const ctx = { title: gi.id ? `Sửa phiếu xuất ${gi.code}` : 'Tạo phiếu xuất kho', gi, items, error, so: null, lines: [] };
  if (gi.purpose === 'SALE') {
    ctx.so = await db.one(
      'SELECT o.*, c.name AS customer_name FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?',
      [gi.sales_order_id]
    );
    const lines = await soLines(db.pool, gi.sales_order_id, gi.id || 0);
    for (const l of lines) {
      l.stocks = await stock.stockRows(db.pool, ctx.so.warehouse_id, { variantId: l.variant_id, status: 'NEW' });
      l.alloc = items.filter((i) => i.sales_order_item_id === l.id);
      if (!l.alloc.length) l.alloc = [{}];
    }
    ctx.lines = lines;
  } else {
    ctx.stocks = await stock.stockRows(db.pool, null);
    ctx.warehouses = await lookups.warehouses();
    ctx.suppliers = await lookups.suppliers();
    if (!ctx.items.length) ctx.items = [{}];
  }
  res.status(status).render('goods-issues/form', ctx);
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '', purpose: req.query.purpose || '' };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('(g.code LIKE ? OR o.code LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
    if (f.status) { where.push('g.status = ?'); params.push(f.status); }
    if (f.purpose) { where.push('g.purpose = ?'); params.push(f.purpose); }
    const rows = await db.query(
      `SELECT g.*, o.code AS so_code, c.name AS customer_name, s.name AS supplier_name, w.code AS warehouse_code, u.full_name,
              (SELECT SUM(quantity) FROM goods_issue_items WHERE goods_issue_id = g.id) AS qty
         FROM goods_issues g JOIN warehouses w ON w.id = g.warehouse_id JOIN users u ON u.id = g.created_by
         LEFT JOIN sales_orders o ON o.id = g.sales_order_id LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN suppliers s ON s.id = g.supplier_id
        WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT 300`,
      params
    );
    const openSos = await db.query(
      `SELECT o.id, o.code, c.name AS customer_name FROM sales_orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.status IN ('CONFIRMED','PARTIALLY_SHIPPED') ORDER BY o.id DESC`
    );
    res.render('goods-issues/index', { title: 'Phiếu xuất kho', rows, f, openSos });
  })
);

router.get(
  '/new',
  requirePerm('gi.create'),
  ah(async (req, res) => {
    const soId = int(req.query.so);
    if (soId) {
      const so = await db.one('SELECT * FROM sales_orders WHERE id = ?', [soId]);
      if (!so || !['CONFIRMED', 'PARTIALLY_SHIPPED'].includes(so.status)) {
        flash(req, 'warning', 'Đơn bán phải được xác nhận và còn hàng chưa xuất.');
        return res.redirect(BASE);
      }
      return renderForm(res, { gi: { purpose: 'SALE', sales_order_id: so.id, warehouse_id: so.warehouse_id, issue_date: today() }, items: [], error: null });
    }
    const purpose = LABELS.giPurpose[req.query.purpose] && req.query.purpose !== 'SALE' ? req.query.purpose : 'DISPOSAL';
    const [w] = await lookups.warehouses();
    await renderForm(res, { gi: { purpose, warehouse_id: w ? w.id : null, issue_date: today() }, items: [], error: null });
  })
);

router.post(
  ['/', '/:id(\\d+)'],
  requirePerm('gi.create'),
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const { header, items } = parseForm(req.body);
    const submitNow = !!req.body.submit_now;
    let existing = null;
    try {
      const newId = await db.tx(async (conn) => {
        if (id) {
          existing = await docs.lock(conn, TYPE, id);
          if (!docs.EDITABLE.includes(existing.status)) throw new AppError('Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
          // không cho đổi loại phiếu / đơn bán khi sửa
          Object.assign(header, { purpose: existing.purpose, sales_order_id: existing.sales_order_id });
        }
        await validate(conn, header, items, { grId: id || 0, strict: submitNow });
        let gid = id;
        if (id) {
          const pick = (o) => Object.fromEntries(Object.keys(header).map((k) => [k, o[k]]));
          await conn.query('UPDATE goods_issues SET ? WHERE id = ?', [header, id]);
          await audit(conn, req, 'UPDATE', 'goods_issues', id, pick(existing), { ...header, lines: items.length });
        } else {
          const code = await nextCode(conn, 'GI');
          const [r] = await conn.query('INSERT INTO goods_issues SET ?', [{ ...header, code, status: 'DRAFT', created_by: req.session.user.id }]);
          gid = r.insertId;
          await audit(conn, req, 'CREATE', 'goods_issues', gid, null, { code, ...header, lines: items.length });
        }
        await saveItems(conn, gid, items);
        if (submitNow) {
          await conn.query("UPDATE goods_issues SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [gid]);
          await docs.logApproval(conn, req, TYPE, gid, 'SUBMIT', existing ? existing.status : 'DRAFT', 'PENDING_APPROVAL');
        }
        return gid;
      });
      flash(req, 'success', submitNow ? 'Đã lưu và gửi duyệt phiếu xuất.' : 'Đã lưu phiếu xuất (nháp).');
      res.redirect(`${BASE}/${newId}`);
    } catch (err) {
      await renderForm(res, { gi: { ...(existing || {}), ...header, id }, items, error: userMessage(err), status: 422 });
    }
  })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const gi = await db.one(
      `SELECT g.*, w.name AS warehouse_name, o.code AS so_code, c.name AS customer_name, s.name AS supplier_name,
              u.full_name AS created_by_name, r.full_name AS reviewed_by_name
         FROM goods_issues g JOIN warehouses w ON w.id = g.warehouse_id JOIN users u ON u.id = g.created_by
         LEFT JOIN users r ON r.id = g.reviewed_by LEFT JOIN sales_orders o ON o.id = g.sales_order_id
         LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN suppliers s ON s.id = g.supplier_id
        WHERE g.id = ?`,
      [req.params.id]
    );
    if (!gi) return next();
    const items = await db.query(
      `SELECT gi.*, v.sku, v.name, l.code AS location_code, s.quantity AS cur_qty
         FROM goods_issue_items gi JOIN product_variants v ON v.id = gi.variant_id JOIN warehouse_locations l ON l.id = gi.location_id
         LEFT JOIN inventory_stocks s ON s.location_id = gi.location_id AND s.variant_id = gi.variant_id
        WHERE gi.goods_issue_id = ? ORDER BY gi.id`,
      [gi.id]
    );
    res.render('goods-issues/show', { title: gi.code, gi, items, approvals: await docs.approvals(TYPE, gi.id), logs: await docs.auditLogs(TYPE, gi.id) });
  })
);

router.get(
  '/:id(\\d+)/edit',
  requirePerm('gi.create'),
  ah(async (req, res, next) => {
    const gi = await db.one('SELECT * FROM goods_issues WHERE id = ?', [req.params.id]);
    if (!gi) return next();
    if (!docs.EDITABLE.includes(gi.status)) {
      flash(req, 'warning', 'Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
      return res.redirect(`${BASE}/${gi.id}`);
    }
    await renderForm(res, { gi, items: await itemsFromDb(db.pool, gi.id), error: null });
  })
);

docs.workflowRoutes(router, {
  type: TYPE,
  base: BASE,
  createPerm: 'gi.create',
  approvePerm: 'gi.approve',
  approvedMessage: 'Đã duyệt. Hàng đã được trừ khỏi tồn kho.',
  async validate(conn, doc) {
    const items = await itemsFromDb(conn, doc.id);
    if (items.some((i) => !i.stock_id)) throw new AppError('Có vị trí không còn hàng của sản phẩm. Hãy sửa phiếu.');
    await validate(conn, doc, items, { grId: doc.id, strict: true });
  },
  async approve(conn, req, doc) {
    const items = await itemsFromDb(conn, doc.id);
    if (items.some((i) => !i.stock_id)) throw new AppError('Có vị trí không còn hàng của sản phẩm.');
    await validate(conn, doc, items, { grId: doc.id, strict: true });
    for (const it of items) {
      await stock.removeStock(conn, {
        warehouseId: doc.warehouse_id,
        locationId: it.location_id,
        variantId: it.variant_id,
        status: it.stock_status,
        quantity: it.quantity,
        type: 'GOODS_ISSUE',
        refType: 'goods_issue',
        refId: doc.id,
        refItemId: it.id,
        userId: req.session.user.id,
      });
      if (it.sales_order_item_id) {
        await conn.query('UPDATE sales_order_items SET quantity_shipped = quantity_shipped + ? WHERE id = ?', [it.quantity, it.sales_order_item_id]);
      }
    }
    if (doc.sales_order_id) {
      const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ? FOR UPDATE', [doc.sales_order_id]);
      const [[{ notDone }]] = await conn.query(
        'SELECT COUNT(*) AS notDone FROM sales_order_items WHERE sales_order_id = ? AND quantity_shipped < quantity_ordered',
        [doc.sales_order_id]
      );
      const next = notDone === 0 ? 'SHIPPED' : 'PARTIALLY_SHIPPED';
      if (next !== so.status) {
        await conn.query('UPDATE sales_orders SET status = ? WHERE id = ?', [next, doc.sales_order_id]);
        await audit(conn, req, 'STATUS', 'sales_orders', doc.sales_order_id, { status: so.status }, { status: next, by: doc.code });
      }
    }
  },
});

module.exports = router;
