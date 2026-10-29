// Phiếu kiểm kê: nhập số đếm thực tế, khi duyệt tồn hệ thống được đặt bằng số đếm.
// Đổi tình trạng hàng trong 1 ô (VD phát hiện hàng mới bị hỏng): ghi 2 dòng thẻ kho, trừ hết tình trạng cũ rồi cộng tình trạng mới.
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const { nextCode } = require('../lib/codes');
const { today } = require('../lib/format');
const { LABELS } = require('../lib/labels');
const lookups = require('../lib/lookups');
const docs = require('../services/documents');

const router = express.Router();
const TYPE = 'stock_adjustment';
const BASE = '/adjustments';

function parseForm(b) {
  const header = { warehouse_id: int(b.warehouse_id) || null, adjustment_date: str(b.adjustment_date) || today(), reason: str(b.reason) };
  const items = toArray(b.items)
    .map((r) => ({
      variant_id: int(r.variant_id) || null,
      location_id: int(r.location_id) || null,
      stock_status: r.stock_status,
      quantity_counted: r.quantity_counted === '' || r.quantity_counted === undefined ? null : int(r.quantity_counted, -1),
      note: str(r.note),
    }))
    .filter((r) => r.variant_id || r.quantity_counted !== null);
  return { header, items };
}

async function validate(conn, header, items) {
  if (!header.warehouse_id) throw new AppError('Chọn kho kiểm kê.');
  if (!items.length) throw new AppError('Phiếu phải có ít nhất 1 dòng.');
  const [locs] = await conn.query('SELECT id FROM warehouse_locations WHERE warehouse_id = ?', [header.warehouse_id]);
  const locIds = new Set(locs.map((l) => l.id));
  const seen = new Set();
  for (const [i, it] of items.entries()) {
    const n = `Dòng ${i + 1}`;
    if (!it.variant_id) throw new AppError(`${n}: chọn sản phẩm.`);
    if (!locIds.has(it.location_id)) throw new AppError(`${n}: chọn vị trí trong kho.`);
    if (!LABELS.stockStatus[it.stock_status]) throw new AppError(`${n}: chọn tình trạng.`);
    if (it.quantity_counted === null || it.quantity_counted < 0) throw new AppError(`${n}: nhập số lượng đếm được (0 trở lên).`);
    const key = `${it.location_id}:${it.variant_id}`;
    if (seen.has(key)) throw new AppError(`${n}: trùng sản phẩm và vị trí với dòng trên.`);
    seen.add(key);
  }
}

async function saveItems(conn, id, items) {
  await conn.query('DELETE FROM stock_adjustment_items WHERE stock_adjustment_id = ?', [id]);
  for (const it of items) {
    await conn.query('INSERT INTO stock_adjustment_items SET ?', [
      { stock_adjustment_id: id, variant_id: it.variant_id, location_id: it.location_id, stock_status: it.stock_status, quantity_counted: it.quantity_counted, note: it.note },
    ]);
  }
}

async function tx(conn, d, it, status, qty, balance, userId) {
  await conn.query(
    `INSERT INTO inventory_transactions (warehouse_id, location_id, variant_id, stock_status, transaction_type,
       quantity, balance_after, reference_type, reference_id, reference_item_id, created_by)
     VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, ?, 'stock_adjustment', ?, ?, ?)`,
    [d.warehouse_id, it.location_id, it.variant_id, status, qty, balance, d.id, it.id, userId]
  );
}

async function renderForm(res, { adj, items, error, status = 200 }) {
  res.status(status).render('adjustments/form', {
    title: adj.id ? `Sửa phiếu kiểm kê ${adj.code}` : 'Tạo phiếu kiểm kê',
    adj,
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
    const f = { status: req.query.status || '' };
    const rows = await db.query(
      `SELECT a.*, w.code AS warehouse_code, u.full_name, (SELECT COUNT(*) FROM stock_adjustment_items WHERE stock_adjustment_id = a.id) AS line_count
         FROM stock_adjustments a JOIN warehouses w ON w.id = a.warehouse_id JOIN users u ON u.id = a.created_by
        ${f.status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC LIMIT 300`,
      f.status ? [f.status] : []
    );
    res.render('adjustments/index', { title: 'Kiểm kê', rows, f });
  })
);

router.get(
  '/new',
  requirePerm('adj.create'),
  ah(async (req, res) => {
    const [w] = await lookups.warehouses();
    // Mở từ trang tồn kho: ?stock=<id> điền sẵn dòng
    const items = [];
    const s = int(req.query.stock) ? await db.one('SELECT * FROM inventory_stocks WHERE id = ?', [int(req.query.stock)]) : null;
    if (s) items.push({ variant_id: s.variant_id, location_id: s.location_id, stock_status: s.stock_status, quantity_counted: s.quantity });
    await renderForm(res, { adj: { warehouse_id: s ? s.warehouse_id : w?.id, adjustment_date: today() }, items, error: null });
  })
);

router.post(
  ['/', '/:id(\\d+)'],
  requirePerm('adj.create'),
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
        await validate(conn, header, items);
        let aid = id;
        if (id) {
          const pick = (o) => Object.fromEntries(Object.keys(header).map((k) => [k, o[k]]));
          await conn.query('UPDATE stock_adjustments SET ? WHERE id = ?', [header, id]);
          await audit(conn, req, 'UPDATE', 'stock_adjustments', id, pick(existing), { ...header, lines: items.length });
        } else {
          const code = await nextCode(conn, 'ADJ');
          const [r] = await conn.query('INSERT INTO stock_adjustments SET ?', [{ ...header, code, status: 'DRAFT', created_by: req.session.user.id }]);
          aid = r.insertId;
          await audit(conn, req, 'CREATE', 'stock_adjustments', aid, null, { code, ...header, lines: items.length });
        }
        await saveItems(conn, aid, items);
        if (submitNow) {
          await conn.query("UPDATE stock_adjustments SET status = 'PENDING_APPROVAL', submitted_at = NOW() WHERE id = ?", [aid]);
          await docs.logApproval(conn, req, TYPE, aid, 'SUBMIT', existing ? existing.status : 'DRAFT', 'PENDING_APPROVAL');
        }
        return aid;
      });
      flash(req, 'success', submitNow ? 'Đã lưu và gửi duyệt phiếu kiểm kê.' : 'Đã lưu phiếu kiểm kê (nháp).');
      res.redirect(`${BASE}/${newId}`);
    } catch (err) {
      await renderForm(res, { adj: { ...(existing || {}), ...header, id }, items, error: userMessage(err), status: 422 });
    }
  })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const adj = await db.one(
      `SELECT a.*, w.name AS warehouse_name, u.full_name AS created_by_name, r.full_name AS reviewed_by_name
         FROM stock_adjustments a JOIN warehouses w ON w.id = a.warehouse_id JOIN users u ON u.id = a.created_by
         LEFT JOIN users r ON r.id = a.reviewed_by WHERE a.id = ?`,
      [req.params.id]
    );
    if (!adj) return next();
    const items = await db.query(
      `SELECT i.*, v.sku, v.name, l.code AS location_code, s.quantity AS cur_qty, s.stock_status AS cur_status
         FROM stock_adjustment_items i JOIN product_variants v ON v.id = i.variant_id JOIN warehouse_locations l ON l.id = i.location_id
         LEFT JOIN inventory_stocks s ON s.location_id = i.location_id AND s.variant_id = i.variant_id
        WHERE i.stock_adjustment_id = ? ORDER BY i.id`,
      [adj.id]
    );
    res.render('adjustments/show', { title: adj.code, adj, items, approvals: await docs.approvals(TYPE, adj.id), logs: await docs.auditLogs(TYPE, adj.id) });
  })
);

router.get(
  '/:id(\\d+)/edit',
  requirePerm('adj.create'),
  ah(async (req, res, next) => {
    const adj = await db.one('SELECT * FROM stock_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return next();
    if (!docs.EDITABLE.includes(adj.status)) {
      flash(req, 'warning', 'Chỉ sửa được phiếu Nháp hoặc bị Từ chối.');
      return res.redirect(`${BASE}/${adj.id}`);
    }
    const items = await db.query('SELECT * FROM stock_adjustment_items WHERE stock_adjustment_id = ? ORDER BY id', [adj.id]);
    await renderForm(res, { adj, items, error: null });
  })
);

docs.workflowRoutes(router, {
  type: TYPE,
  base: BASE,
  createPerm: 'adj.create',
  approvePerm: 'adj.approve',
  approvedMessage: 'Đã duyệt. Tồn kho đã được điều chỉnh theo số đếm.',
  async validate(conn, doc) {
    const [items] = await conn.query('SELECT * FROM stock_adjustment_items WHERE stock_adjustment_id = ?', [doc.id]);
    await validate(conn, doc, items);
  },
  async approve(conn, req, doc) {
    const [items] = await conn.query('SELECT * FROM stock_adjustment_items WHERE stock_adjustment_id = ?', [doc.id]);
    const userId = req.session.user.id;
    for (const it of items) {
      const [[s]] = await conn.query('SELECT * FROM inventory_stocks WHERE location_id = ? AND variant_id = ? FOR UPDATE', [it.location_id, it.variant_id]);
      const before = s ? s.quantity : 0;
      await conn.query('UPDATE stock_adjustment_items SET quantity_before = ? WHERE id = ?', [before, it.id]);
      if (!s) {
        if (it.quantity_counted > 0) {
          await conn.query('INSERT INTO inventory_stocks (warehouse_id, location_id, variant_id, stock_status, quantity) VALUES (?, ?, ?, ?, ?)', [
            doc.warehouse_id, it.location_id, it.variant_id, it.stock_status, it.quantity_counted,
          ]);
          await tx(conn, doc, it, it.stock_status, it.quantity_counted, it.quantity_counted, userId);
        }
        continue;
      }
      if (s.stock_status !== it.stock_status && before > 0) {
        // Đổi tình trạng: trừ hết tình trạng cũ (ô về 0) rồi cộng số đếm với tình trạng mới
        await conn.query('UPDATE inventory_stocks SET quantity = 0 WHERE id = ?', [s.id]);
        await tx(conn, doc, it, s.stock_status, -before, 0, userId);
        await conn.query('UPDATE inventory_stocks SET stock_status = ?, quantity = ? WHERE id = ?', [it.stock_status, it.quantity_counted, s.id]);
        if (it.quantity_counted > 0) await tx(conn, doc, it, it.stock_status, it.quantity_counted, it.quantity_counted, userId);
      } else if (it.quantity_counted !== before || s.stock_status !== it.stock_status) {
        await conn.query('UPDATE inventory_stocks SET stock_status = ?, quantity = ? WHERE id = ?', [it.stock_status, it.quantity_counted, s.id]);
        if (it.quantity_counted !== before) await tx(conn, doc, it, it.stock_status, it.quantity_counted - before, it.quantity_counted, userId);
      }
    }
  },
});

module.exports = router;
