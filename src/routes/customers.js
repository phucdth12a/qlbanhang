const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');

const router = express.Router();
const FIELDS = ['code', 'name', 'phone', 'email', 'address', 'note'];

router.get(
  '/',
  ah(async (req, res) => {
    const q = (req.query.q || '').trim();
    const customers = await db.query(
      `SELECT c.*, (SELECT COUNT(*) FROM sales_orders WHERE customer_id = c.id) AS so_count,
              (SELECT COALESCE(SUM(total_amount),0) FROM sales_orders WHERE customer_id = c.id AND status NOT IN ('DRAFT','CANCELLED')) AS revenue
         FROM customers c WHERE c.deleted_at IS NULL ${q ? 'AND (c.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)' : ''}
        ORDER BY c.name`,
      q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []
    );
    res.render('customers/index', { title: 'Khách hàng', customers, q });
  })
);

router.get('/new', requirePerm('customers.manage'), (req, res) =>
  res.render('customers/form', { title: 'Thêm khách hàng', c: { is_active: 1 }, orders: [], logs: [], error: null })
);

router.get(
  '/:id(\\d+)',
  ah(async (req, res, next) => {
    const c = await db.one('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!c) return next();
    const orders = await db.query('SELECT * FROM sales_orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20', [c.id]);
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity_type = 'customers' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 30`,
      [c.id]
    );
    res.render('customers/form', { title: c.name, c, orders, logs, error: null });
  })
);

router.post(
  ['/', '/:id(\\d+)'],
  requirePerm('customers.manage'),
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const data = {};
    FIELDS.forEach((f) => (data[f] = str(req.body[f])));
    data.code = data.code ? data.code.toUpperCase() : null;
    data.is_active = req.body.is_active ? 1 : 0;
    try {
      if (!data.code || !data.name) throw new AppError('Nhập mã và tên khách hàng.');
      const newId = await db.tx(async (conn) => {
        if (id) {
          const [[old]] = await conn.query(`SELECT ${FIELDS.join(', ')}, is_active FROM customers WHERE id = ?`, [id]);
          await conn.query('UPDATE customers SET ? WHERE id = ?', [data, id]);
          await audit(conn, req, 'UPDATE', 'customers', id, old, data);
          return id;
        }
        const [r] = await conn.query('INSERT INTO customers SET ?', [{ ...data, created_by: req.session.user.id }]);
        await audit(conn, req, 'CREATE', 'customers', r.insertId, null, data);
        return r.insertId;
      });
      flash(req, 'success', 'Đã lưu khách hàng.');
      res.redirect(`/customers/${newId}`);
    } catch (err) {
      res.status(422).render('customers/form', { title: 'Khách hàng', c: { ...data, id }, orders: [], logs: [], error: userMessage(err) });
    }
  })
);

router.post(
  '/:id(\\d+)/delete',
  requirePerm('customers.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      await conn.query('UPDATE customers SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
      await audit(conn, req, 'DELETE', 'customers', req.params.id);
    });
    flash(req, 'success', 'Đã xoá khách hàng.');
    res.redirect('/customers');
  })
);

module.exports = router;
