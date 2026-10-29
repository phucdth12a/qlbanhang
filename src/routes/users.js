const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ah, requirePerm, flash, str, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');

const router = express.Router();
router.use(requirePerm('users.manage'));

router.get(
  '/',
  ah(async (req, res) => {
    const users = await db.query('SELECT * FROM users ORDER BY id');
    res.render('users/index', { title: 'Người dùng', users });
  })
);

router.get('/new', (req, res) => res.render('users/form', { title: 'Thêm người dùng', u: { is_active: 1 }, error: null }));

router.get(
  '/:id/edit',
  ah(async (req, res, next) => {
    const u = await db.one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) return next();
    res.render('users/form', { title: 'Sửa người dùng', u, error: null });
  })
);

router.post(
  ['/', '/:id'],
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const b = req.body;
    const data = {
      username: str(b.username),
      full_name: str(b.full_name),
      email: str(b.email),
      role: b.role,
      is_active: b.is_active ? 1 : 0,
    };
    try {
      if (!data.username || !data.full_name) throw new AppError('Nhập tên đăng nhập và họ tên.');
      if (!id && !b.password) throw new AppError('Nhập mật khẩu cho người dùng mới.');
      if (b.password && b.password.length < 6) throw new AppError('Mật khẩu tối thiểu 6 ký tự.');
      if (id === req.session.user.id && (!data.is_active || data.role !== 'ADMIN')) {
        throw new AppError('Bạn không thể tự khoá hoặc bỏ quyền quản trị của chính mình.');
      }
      await db.tx(async (conn) => {
        if (id) {
          const [[old]] = await conn.query('SELECT username, full_name, email, role, is_active FROM users WHERE id = ?', [id]);
          await conn.query('UPDATE users SET ? WHERE id = ?', [data, id]);
          if (b.password) await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(b.password, 10), id]);
          await audit(conn, req, 'UPDATE', 'users', id, old, { ...data, ...(b.password ? { password: '(đã đổi)' } : {}) });
        } else {
          const [r] = await conn.query('INSERT INTO users SET ?', [{ ...data, password_hash: bcrypt.hashSync(b.password, 10) }]);
          await audit(conn, req, 'CREATE', 'users', r.insertId, null, data);
        }
      });
      flash(req, 'success', 'Đã lưu người dùng.');
      res.redirect('/users');
    } catch (err) {
      const msg = userMessage(err);
      res.status(422).render('users/form', { title: id ? 'Sửa người dùng' : 'Thêm người dùng', u: { ...data, id }, error: msg });
    }
  })
);

module.exports = router;
