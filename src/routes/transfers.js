// Phiếu chuyển kho / chuyển vị trí: trừ ở vị trí đi, cộng ở vị trí đến khi được duyệt
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const { label } = require('../lib/labels');
const lookups = require('../lib/lookups');
const stock = require('../services/stock');
const docs = require('../services/documents');

const router = express.Router();
const TYPE = 'stock_transfer';
const BASE = '/transfers';

function parseForm(b) {
  const header = {
    from_warehouse_id: int(b.from_warehouse_id) || null,
    to_warehouse_id: int(b.to_warehouse_id) || null,
    transfer_date: str(b.transfer_date) || today(),
    note: str(b.note),
  };
  const items = toArray(b.items)
    .map((r) => ({ stock_id: int(r.stock_id) || null, to_location_id: int(r.to_location_id) || null, quantity: int(r.quantity), note: str(r.note) }))
    .filter((r) => r.stock_id || r.quantity);
  return { header, items };
}

async function validate(conn, header, items, { strict = false } = {}) {
  if (!header.from_warehouse_id || !header.to_warehouse_id) throw new AppError('Chọn kho đi và kho đến.');
  if (!items.length) throw new AppError('Phiếu phải có ít nhất 1 dòng hàng.');
  const [toLocs] = await conn.query('SELECT id, code FROM warehouse_locations WHERE warehouse_id = ? AND is_active = 1', [header.to_warehouse_id]);
  const toIds = new Set(toLocs.map((l) => l.id));
  const seen = new Set();
  const dest = new Map(); // "loc:variant" -> status trong phiếu này
  const newOut = new Map();
  for (const [i, it] of items.entries()) {
    const n = `Dòng ${i + 1}`;
    if (!(it.quantity > 0)) throw new AppError(`${n}: số lượng phải lớn hơn 0.`);
    const [[s]] = await conn.query(
      `SELECT s.*, l.code AS location_code, v.sku FROM inventory_stocks s JOIN warehouse_locations l ON l.id = s.location_id
         JOIN product_variants v ON v.id = s.variant_id WHERE s.id = ?`,
      [it.stock_id]
    );
    if (!s || s.warehouse_id !== header.from_warehouse_id) throw new AppError(`${n}: chọn hàng trong kho đi.`);
    Object.assign(it, { variant_id: s.variant_id, from_location_id: s.location_id, stock_status: s.stock_status });
    if (seen.has(it.stock_id)) throw new AppError(`${n}: ${s.sku} ở ${s.location_code} bị chọn 2 lần, hãy gộp số lượng.`);
    seen.add(it.stock_id);
    if (!toIds.has(it.to_location_id)) throw new AppError(`${n}: chọn vị trí đến trong kho đến.`);
    if (it.to_location_id === s.location_id) throw new AppError(`${n}: vị trí đến phải khác vị trí đi.`);
    if (it.quantity > s.quantity) throw new AppError(`${n}: ${s.location_code} chỉ còn ${s.quantity} ${s.sku}.`);
    const key = `${it.to_location_id}:${s.variant_id}`;
    if (dest.has(key) && dest.get(key) !== s.stock_status) throw new AppError(`${n}: một vị trí đến không được nhận cùng sản phẩm với nhiều tình trạng.`);
    dest.set(key, s.stock_status);
    if (strict) {
      const conflict = await stock.checkLocationStatus(conn, it.to_location_id, s.variant_id, s.stock_status);
      if (conflict) throw new AppError(`${n}: ${conflict} Hãy chọn vị trí đến khác.`);
    }
    if (s.stock_status === 'NEW' && header.from_warehouse_id !== header.to_warehouse_id) {
      newOut.set(s.variant_id, (newOut.get(s.variant_id) || 0) + it.quantity);
    }
  }
  if (strict) {
    for (const [variantId, qty] of newOut) {
      const avail = await stock.availableQty(conn, header.from_warehouse_id, variantId);
      if (avail < qty) {
        const [[v]] = await conn.query('SELECT sku FROM product_variants WHERE id = ?', [variantId]);
        throw new AppError(`${v.sku}: chỉ còn ${Math.max(avail, 0)} hàng mới không bị giữ cho đơn bán ở kho đi, không chuyển được ${qty}.`);
      }
    }
  }
}

async function saveItems(conn, id, items) {
  await conn.query('DELETE FROM stock_transfer_items WHERE stock_transfer_id = ?', [id]);
  for (const it of items) {
    await conn.query('INSERT INTO stock_transfer_items SET ?', [
      { stock_transfer_id: id, variant_id: it.variant_id, from_location_id: it.from_location_id, to_location_id: it.to_location_id, stock_status: it.stock_status, quantity: it.quantity, note: it.note },
    ]);
  }
}

async function itemsFromDb(conn, id) {
  const [rows] = await conn.query(
    `SELECT t.*, s.id AS stock_id FROM stock_transfer_items t
       LEFT JOIN inventory_stocks s ON s.location_id = t.from_location_id AND s.variant_id = t.variant_id
      WHERE t.stock_transfer_id = ? ORDER BY t.id`,
    [id]
  );
  return rows;
}

async function renderForm(res, { tr, items, error, status = 200 }) {
  res.status(status).render('transfers/form', {
    title: tr.id ? `Sửa phiếu chuyển ${tr.code}` : 'Tạo phiếu chuyển kho',
    tr,
    items: items.length ? items : [{}],
    warehouses: await lookups.warehouses(),
    locations: await lookups.locations(),
    stocks: await stock.stockRows(db.pool, null),
    error,
  });
}

router.get(
  '/',
  ah(async (req, res) => {
    const f = { q: (req.query.q || '').trim(), status: req.query.status || '' };
    const where = ['1=1'];
    const params = [];
    if (f.q) { where.push('t.code LIKE ?'); params.push(`%${f.q}%`); }
    if (f.status) { where.push('t.status = ?'); params.push(f.status); }
    const rows = await db.query(
      `SELECT t.*, a.code AS from_code, b.code AS to_code, u.full_name,
              (SELECT SUM(quantity) FROM stock_transfer_items WHERE stock_transfer_id = t.id) AS qty
         FROM stock_transfers t JOIN warehouses a ON a.id = t.from_warehouse_id JOIN warehouses b ON b.id = t.to_warehouse_id
         JOIN users u ON u.id = t.created_by
        WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 300`,
      params
    );
    res.render('transfers/index', { title: 'Chuyển kho', rows, f });
  })
);

router.get(
  '/new',
  requirePerm('tr.create'),
  ah(async (req, res) => {
    const [w] = await lookups.warehouses();
    await renderForm(res, { tr: { from_warehouse_id: w?.id, to_warehouse_id: w?.id, transfer_date: today() }, items: [], error: null });
  })
);

router.post(
  ['/', '/:id(\\d+)'],
  requirePerm('tr.create'),
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
        }
        await validate(conn, header, items, { strict: submitNow });
        let tid = id;
        if (id) {
          const pick = (o) => Object.fromEntries(Object.keys(header).map((k) => [k, o[k]]));
          await conn.query('UPDATE stock_transfers SET ? WHERE id = ?', [header, id]);
          await audit(conn, req, 'UPDATE', 'stock_transfers', id, pick(existing), { ...header, lines: items.length });
        } else {
          const code = await nextCode(conn, 'TR');
          const [r] = await conn.query('INSERT INTO stock_transfers SET ?', [{ ...header, code, status: 'DRAFT', created_by: req.session.user.id }]);
          tid = r.insertId;
          await audit(conn, req, 'CREATE', 'stock_transfers', tid, null, { code, ...header, lines: items.length });
        }
        await saveItems(conn, tid, items);
        if (submitNow) {
          await conn.query("UPDATE stock_transfers SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [tid]);
          await docs.logApproval(conn, req, TYPE, tid, 'SUBMIT', existing ? existing.status : 'DRAFT', 'PENDING_APPROVAL');
        }
        return tid;
      });
      flash(req, 'success', submitNow ? 'Đã lưu và gửi duyệt phiếu chuyển.' : 'Đã lưu phiếu chuyển (nháp).');
      res.redirect(`${BASE}/${newId}`);
    } catch (err) {
      await renderForm(res, { tr: { ...(existing || {}), ...header, id }, items, error: userMessage(err), status: 422 });
    }
  })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const tr = await db.one(
      `SELECT t.*, a.name AS from_name, b.name AS to_name, u.full_name AS created_by_name, r.full_name AS reviewed_by_name
         FROM stock_transfers t JOIN warehouses a ON a.id = t.from_warehouse_id JOIN warehouses b ON b.id = t.to_warehouse_id
         JOIN users u ON u.id = t.created_by LEFT JOIN users r ON r.id = t.reviewed_by WHERE t.id = ?`,
      [req.params.id]
    );
    if (!tr) return next();
    const items = await db.query(
      `SELECT t.*, v.sku, v.name, lf.code AS from_code, lt.code AS to_code, sf.quantity AS from_qty,
              st.quantity AS to_qty, st.stock_status AS to_status
         FROM stock_transfer_items t JOIN product_variants v ON v.id = t.variant_id
         JOIN warehouse_locations lf ON lf.id = t.from_location_id JOIN warehouse_locations lt ON lt.id = t.to_location_id
         LEFT JOIN inventory_stocks sf ON sf.location_id = t.from_location_id AND sf.variant_id = t.variant_id
         LEFT JOIN inventory_stocks st ON st.location_id = t.to_location_id AND st.variant_id = t.variant_id
        WHERE t.stock_transfer_id = ? ORDER BY t.id`,
      [tr.id]
    );
    res.render('transfers/show', { title: tr.code, tr, items, approvals: await docs.approvals(TYPE, tr.id), logs: await docs.auditLogs(TYPE, tr.id) });
  })
);

router.get(
  '/:id(\\d+)/edit',
  requirePerm('tr.create'),
  ah(async (req, res, next) => {
    const tr = await db.one('SELECT * FROM stock_transfers WHERE id = ?', [req.params.id]);
    if (!tr) return next();
    if (!docs.EDITABLE.includes(tr.status)) {
      flash(req, 'warning', 'Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
      return res.redirect(`${BASE}/${tr.id}`);
    }
    await renderForm(res, { tr, items: await itemsFromDb(db.pool, tr.id), error: null });
  })
);

docs.workflowRoutes(router, {
  type: TYPE,
  base: BASE,
  createPerm: 'tr.create',
  approvePerm: 'tr.approve',
  approvedMessage: 'Đã duyệt. Hàng đã được chuyển sang vị trí mới.',
  async validate(conn, doc) {
    const items = await itemsFromDb(conn, doc.id);
    if (items.some((i) => !i.stock_id)) throw new AppError('Có vị trí đi không còn hàng của sản phẩm. Hãy sửa phiếu.');
    await validate(conn, doc, items, { strict: true });
  },
  async approve(conn, req, doc) {
    const items = await itemsFromDb(conn, doc.id);
    if (items.some((i) => !i.stock_id)) throw new AppError('Có vị trí đi không còn hàng của sản phẩm.');
    await validate(conn, doc, items, { strict: true });
    const common = { refType: 'stock_transfer', refId: doc.id, userId: req.session.user.id };
    for (const it of items) {
      await stock.removeStock(conn, {
        ...common, warehouseId: doc.from_warehouse_id, locationId: it.from_location_id, variantId: it.variant_id,
        status: it.stock_status, quantity: it.quantity, type: 'TRANSFER_OUT', refItemId: it.id,
      });
      await stock.addStock(conn, {
        ...common, warehouseId: doc.to_warehouse_id, locationId: it.to_location_id, variantId: it.variant_id,
        status: it.stock_status, quantity: it.quantity, type: 'TRANSFER_IN', refItemId: it.id,
      });
    }
  },
});

module.exports = router;
