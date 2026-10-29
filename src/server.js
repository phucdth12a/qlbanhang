require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { can } = require('./lib/permissions');
const labels = require('./lib/labels');
const fmt = require('./lib/format');
const { friendlyMessage } = require('./lib/errors');
const { requireLogin, flash } = require('./lib/http');

const app = express();
const root = path.join(__dirname, '..');

app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true, parameterLimit: 20000 }));
app.use('/static', express.static(path.join(root, 'public')));
app.use('/vendor/bootstrap', express.static(path.join(root, 'node_modules/bootstrap/dist')));
app.use('/vendor/bootstrap-icons', express.static(path.join(root, 'node_modules/bootstrap-icons/font')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  })
);

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.can = (perm) => can(req.session.user, perm);
  res.locals.fmt = fmt;
  res.locals.L = labels;
  res.locals.path = req.path;
  res.locals.title = '';
  res.locals.navCounts = {};
  next();
});

app.use(require('./routes/auth'));
app.use(requireLogin);

// Số phiếu chờ duyệt / phát sinh đang mở hiển thị trên menu
app.use(async (req, res, next) => {
  try {
    const [c] = await db.query(
      `SELECT (SELECT COUNT(*) FROM goods_receipts WHERE status = 'PENDING_APPROVAL') AS gr,
              (SELECT COUNT(*) FROM return_receipts WHERE status = 'PENDING_APPROVAL') AS rr,
              (SELECT COUNT(*) FROM goods_receipt_issues x JOIN goods_receipt_items gi ON gi.id = x.goods_receipt_item_id JOIN goods_receipts g ON g.id = gi.goods_receipt_id
                 WHERE x.status NOT IN ('RESOLVED','REJECTED') AND g.status IN ('PENDING_APPROVAL','APPROVED')) AS issues`
    );
    res.locals.navCounts = c;
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/', require('./routes/catalog'));
app.use('/products', require('./routes/products'));
app.use('/suppliers', require('./routes/suppliers'));
app.use('/warehouses', require('./routes/warehouses'));
app.use('/stock', require('./routes/stock'));
app.use('/purchase-orders', require('./routes/purchaseOrders'));
app.use('/goods-receipts', require('./routes/goodsReceipts'));
app.use('/issues', require('./routes/issues'));
app.use('/returns', require('./routes/returns'));
app.use('/audit', require('./routes/audit'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Không tìm thấy', message: 'Trang hoặc dữ liệu bạn tìm không tồn tại.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const msg = friendlyMessage(err);
  if (msg && req.method === 'POST') {
    flash(req, 'danger', msg);
    return res.redirect(req.get('Referer') || '/');
  }
  console.error(err);
  res.status(500).render('error', { title: 'Lỗi', message: msg || 'Đã có lỗi xảy ra. Xem log của server để biết chi tiết.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`QL Bán hàng đang chạy: http://localhost:${port}`));
