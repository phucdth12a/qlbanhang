const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');

const router = express.Router();
const FIELDS = ['code', 'name', 'contact_name', 'phone', 'email', 'address', 'tax_code', 'note'];

router.get(
  '/',
  ah(async (req, res) => {
    const q = (req.query.q || '').trim();
    const suppliers = await db.query(
      `SELECT s.*, (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id) AS po_count
         FROM suppliers s WHERE s.deleted_at IS NULL ${q ? 'AND (s.code LIKE ? OR s.name LIKE ? OR s.phone LIKE ?)' : ''}
        ORDER BY s.name`,
      q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []
    );
    res.render('suppliers/index', { title: 'Nhà cung cấp', suppliers, q });
  })
);

router.get('/new', requirePerm('suppliers.manage'), (req, res) =>
  res.render('suppliers/form', { title: 'Thêm nhà cung cấp', s: { is_active: 1 }, error: null })
);

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const s = await db.one('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!s) return next();
    const pos = await db.query('SELECT * FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC LIMIT 20', [s.id]);
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'suppliers' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 30`,
      [s.id]
    );
    res.render('suppliers/form', { title: s.name, s, pos, logs, error: null });
  })
);

router.post(
  ['/', '/:id'],
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const data = {};
    FIELDS.forEach((f) => (data[f] = str(req.body[f])));
    data.code = data.code ? data.code.toUpperCase() : null;
    data.is_active = req.body.is_active ? 1 : 0;
    try {
      if (!data.code || !data.name) throw new AppError('Nhập mã và tên nhà cung cấp.');
      const newId = await db.tx(async (conn) => {
        if (id) {
          const [[old]] = await conn.query(`SELECT ${FIELDS.join(', ')}, is_active FROM suppliers WHERE id = ?`, [id]);
          await conn.query('UPDATE suppliers SET ? WHERE id = ?', [data, id]);
          await audit(conn, req, 'UPDATE', 'suppliers', id, old, data);
          return id;
        }
        const [r] = await conn.query('INSERT INTO suppliers SET ?', [{ ...data, created_by: req.session.user.id }]);
        await audit(conn, req, 'CREATE', 'suppliers', r.insertId, null, data);
        return r.insertId;
      });
      flash(req, 'success', 'Đã lưu nhà cung cấp.');
      res.redirect(`/suppliers/${newId}`);
    } catch (err) {
      res.status(422).render('suppliers/form', { title: 'Nhà cung cấp', s: { ...data, id }, pos: [], logs: [], error: userMessage(err) });
    }
  })
);

router.post(
  '/:id/delete',
  requirePerm('suppliers.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      await conn.query('UPDATE suppliers SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
      await audit(conn, req, 'DELETE', 'suppliers', req.params.id);
    });
    flash(req, 'success', 'Đã xoá nhà cung cấp.');
    res.redirect('/suppliers');
  })
);

module.exports = router;
