const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ah } = require('../lib/http');
const { audit } = require('../lib/audit');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Đăng nhập', error: null, username: '' });
});

router.post(
  '/login',
  ah(async (req, res) => {
    const username = (req.body.username || '').trim();
    const u = await db.one('SELECT * FROM users WHERE username = ?', [username]);
    const ok = u && u.is_active && (await bcrypt.compare(req.body.password || '', u.password_hash));
    if (!ok) {
      return res.status(401).render('auth/login', { title: 'Đăng nhập', error: 'Sai tên đăng nhập hoặc mật khẩu.', username });
    }
    const returnTo = req.session.returnTo || '/';
    req.session.regenerate(async (err) => {
      if (err) return res.redirect('/login');
      req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
      await audit(db.pool, req, 'LOGIN', 'users', u.id);
      res.redirect(returnTo);
    });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
