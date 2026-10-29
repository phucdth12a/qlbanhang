const { can } = require('./permissions');

// Bọc route async để lỗi đi vào error handler
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (can(req.session.user, perm)) return next();
    res.status(403).render('error', { title: 'Không có quyền', message: 'Bạn không có quyền thực hiện thao tác này.' });
  };
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Form có dòng động gửi lên items[0][x]... -> mảng
function toArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : Object.values(x);
}

function int(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function dec(v, def = 0) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : def;
}

function str(v) {
  const s = (v ?? '').toString().trim();
  return s === '' ? null : s;
}

module.exports = { ah, requireLogin, requirePerm, flash, toArray, int, dec, str };

// Lấy câu báo lỗi cho người dùng; lỗi hệ thống thì ném tiếp ra error handler
function userMessage(err) {
  const { friendlyMessage } = require('./errors');
  const msg = friendlyMessage(err);
  if (!msg) throw err;
  return msg;
}

module.exports.userMessage = userMessage;
