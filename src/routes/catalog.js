// Nhóm sản phẩm + thuộc tính biến thể (Size, Màu...)
const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');

const router = express.Router();

// ---------- Nhóm sản phẩm ----------
router.get(
  '/categories',
  ah(async (req, res) => {
    const categories = await db.query(
      `SELECT c.*, p.name AS parent_name, (SELECT COUNT(*) FROM products WHERE category_id = c.id AND deleted_at IS NULL) AS product_count
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id ORDER BY COALESCE(p.name, c.name), c.parent_id IS NOT NULL, c.name`
    );
    const editing = req.query.edit ? categories.find((c) => c.id === int(req.query.edit)) : null;
    res.render('catalog/categories', { title: 'Nhóm sản phẩm', categories, editing });
  })
);

router.post(
  '/categories',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const id = int(req.body.id) || null;
    const data = { name: str(req.body.name), parent_id: int(req.body.parent_id) || null };
    if (!data.name) throw new AppError('Nhập tên nhóm.');
    if (id && data.parent_id === id) throw new AppError('Nhóm không thể là cha của chính nó.');
    await db.tx(async (conn) => {
      if (id) {
        const [[old]] = await conn.query('SELECT name, parent_id FROM categories WHERE id = ?', [id]);
        await conn.query('UPDATE categories SET ? WHERE id = ?', [data, id]);
        await audit(conn, req, 'UPDATE', 'categories', id, old, data);
      } else {
        const [r] = await conn.query('INSERT INTO categories SET ?', [data]);
        await audit(conn, req, 'CREATE', 'categories', r.insertId, null, data);
      }
    });
    flash(req, 'success', 'Đã lưu nhóm sản phẩm.');
    res.redirect('/categories');
  })
);

router.post(
  '/categories/:id/delete',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      const [[old]] = await conn.query('SELECT name, parent_id FROM categories WHERE id = ?', [req.params.id]);
      await conn.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
      await audit(conn, req, 'DELETE', 'categories', req.params.id, old, null);
    });
    flash(req, 'success', 'Đã xoá nhóm.');
    res.redirect('/categories');
  })
);

// ---------- Thuộc tính ----------
router.get(
  '/attributes',
  ah(async (req, res) => {
    const attributes = await db.query('SELECT * FROM attributes ORDER BY id');
    const values = await db.query(
      `SELECT av.*, (SELECT COUNT(*) FROM variant_attribute_values WHERE attribute_value_id = av.id) AS used
         FROM attribute_values av ORDER BY attribute_id, sort_order, value`
    );
    attributes.forEach((a) => (a.values = values.filter((v) => v.attribute_id === a.id)));
    res.render('catalog/attributes', { title: 'Thuộc tính biến thể', attributes });
  })
);

router.post(
  '/attributes',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const data = { code: (str(req.body.code) || '').toUpperCase(), name: str(req.body.name) };
    if (!data.code || !data.name) throw new AppError('Nhập mã và tên thuộc tính.');
    await db.tx(async (conn) => {
      const [r] = await conn.query('INSERT INTO attributes SET ?', [data]);
      await audit(conn, req, 'CREATE', 'attributes', r.insertId, null, data);
    });
    flash(req, 'success', `Đã thêm thuộc tính ${data.name}.`);
    res.redirect('/attributes');
  })
);

router.post(
  '/attributes/:id/values',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const values = (req.body.values || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!values.length) throw new AppError('Nhập ít nhất một giá trị.');
    await db.tx(async (conn) => {
      const [[{ maxOrder }]] = await conn.query('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM attribute_values WHERE attribute_id = ?', [req.params.id]);
      let order = maxOrder;
      for (const value of values) {
        const [r] = await conn.query('INSERT INTO attribute_values (attribute_id, value, sort_order) VALUES (?, ?, ?)', [req.params.id, value, ++order]);
        await audit(conn, req, 'CREATE', 'attribute_values', r.insertId, null, { attribute_id: req.params.id, value });
      }
    });
    flash(req, 'success', `Đã thêm ${values.length} giá trị.`);
    res.redirect('/attributes');
  })
);

router.post(
  '/attribute-values/:id/delete',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      const [[old]] = await conn.query('SELECT attribute_id, value FROM attribute_values WHERE id = ?', [req.params.id]);
      await conn.query('DELETE FROM attribute_values WHERE id = ?', [req.params.id]);
      await audit(conn, req, 'DELETE', 'attribute_values', req.params.id, old, null);
    });
    flash(req, 'success', 'Đã xoá giá trị.');
    res.redirect('/attributes');
  })
);

module.exports = router;
