const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, dec, toArray, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');
const lookups = require('../lib/lookups');

const router = express.Router();

// "Trắng" -> "TRANG"
function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

async function loadAttributes() {
  const attributes = await db.query('SELECT * FROM attributes ORDER BY id');
  const values = await db.query('SELECT * FROM attribute_values ORDER BY attribute_id, sort_order, value');
  attributes.forEach((a) => (a.values = values.filter((v) => v.attribute_id === a.id)));
  return attributes;
}

// Tạo các biến thể còn thiếu từ các giá trị thuộc tính đã chọn (tích Đề-các)
async function generateVariants(conn, req, product, selected, prices) {
  const [allValues] = await conn.query(
    'SELECT av.id, av.value, av.attribute_id FROM attribute_values av JOIN attributes a ON a.id = av.attribute_id ORDER BY a.id, av.sort_order'
  );
  const groups = [];
  for (const [attrId, ids] of Object.entries(selected || {})) {
    const vals = allValues.filter((v) => String(v.attribute_id) === String(attrId) && toArray(ids).map(String).includes(String(v.id)));
    if (vals.length) groups.push(vals);
  }
  groups.sort((a, b) => a[0].attribute_id - b[0].attribute_id);
  let combos = [[]];
  for (const g of groups) combos = combos.flatMap((c) => g.map((v) => [...c, v]));

  const [existing] = await conn.query(
    `SELECT v.id, GROUP_CONCAT(vav.attribute_value_id ORDER BY vav.attribute_value_id) AS vals
       FROM product_variants v LEFT JOIN variant_attribute_values vav ON vav.variant_id = v.id
      WHERE v.product_id = ? AND v.deleted_at IS NULL GROUP BY v.id`,
    [product.id]
  );
  const existingKeys = new Set(existing.map((e) => e.vals || ''));
  let created = 0;
  for (const combo of combos) {
    const key = combo.map((v) => v.id).sort((a, b) => a - b).join(',');
    if (existingKeys.has(key)) continue;
    const baseSku = [product.code, ...combo.map((v) => slug(v.value))].join('-');
    let sku = baseSku;
    for (let n = 2; ; n++) {
      const [[dup]] = await conn.query('SELECT id FROM product_variants WHERE sku = ?', [sku]);
      if (!dup) break;
      sku = `${baseSku}-${n}`;
    }
    const name = [product.name, ...combo.map((v) => v.value)].join(' - ');
    const [r] = await conn.query(
      'INSERT INTO product_variants (product_id, sku, name, cost_price, sale_price) VALUES (?, ?, ?, ?, ?)',
      [product.id, sku, name, prices.cost, prices.sale]
    );
    for (const v of combo) {
      await conn.query('INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES (?, ?)', [r.insertId, v.id]);
    }
    await audit(conn, req, 'CREATE', 'product_variants', r.insertId, null, { product_id: product.id, sku, name, cost_price: prices.cost, sale_price: prices.sale });
    existingKeys.add(key);
    created++;
  }
  return created;
}

router.get(
  '/',
  ah(async (req, res) => {
    const q = (req.query.q || '').trim();
    const cat = int(req.query.category_id) || null;
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    if (q) {
      where.push('(p.code LIKE ? OR p.name LIKE ? OR EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND (x.sku LIKE ? OR x.barcode LIKE ?)))');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (cat) {
      where.push('p.category_id = ?');
      params.push(cat);
    }
    const products = await db.query(
      `SELECT p.*, c.name AS category_name,
              (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
              (SELECT COALESCE(SUM(s.quantity),0) FROM inventory_stocks s JOIN product_variants v ON v.id = s.variant_id
                WHERE v.product_id = p.id AND s.stock_status = 'NEW') AS stock_new
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC`,
      params
    );
    res.render('products/index', { title: 'Sản phẩm', products, q, cat, categories: await lookups.categories() });
  })
);

router.get(
  '/new',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    res.render('products/new', {
      title: 'Thêm sản phẩm',
      p: { unit: 'cái' },
      selected: {},
      categories: await lookups.categories(),
      attributes: await loadAttributes(),
      error: null,
    });
  })
);

router.post(
  '/',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const b = req.body;
    const data = {
      code: (str(b.code) || '').toUpperCase(),
      name: str(b.name),
      category_id: int(b.category_id) || null,
      unit: str(b.unit) || 'cái',
      description: str(b.description),
    };
    try {
      if (!data.code || !data.name) throw new AppError('Nhập mã và tên sản phẩm.');
      if (!/^[A-Z0-9-]+$/.test(data.code)) throw new AppError('Mã sản phẩm chỉ gồm chữ không dấu, số và dấu gạch ngang.');
      const id = await db.tx(async (conn) => {
        const [r] = await conn.query('INSERT INTO products SET ?', [{ ...data, created_by: req.session.user.id }]);
        await audit(conn, req, 'CREATE', 'products', r.insertId, null, data);
        await generateVariants(conn, req, { id: r.insertId, ...data }, b.attr, { cost: dec(b.cost_price), sale: dec(b.sale_price) });
        return r.insertId;
      });
      flash(req, 'success', 'Đã tạo sản phẩm và các biến thể.');
      res.redirect(`/products/${id}`);
    } catch (err) {
      res.status(422).render('products/new', {
        title: 'Thêm sản phẩm',
        p: { ...data, cost_price: b.cost_price, sale_price: b.sale_price },
        selected: b.attr || {},
        categories: await lookups.categories(),
        attributes: await loadAttributes(),
        error: userMessage(err),
      });
    }
  })
);

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const p = await db.one('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!p) return next();
    const variants = await db.query(
      `SELECT v.*,
              (SELECT GROUP_CONCAT(av.value ORDER BY a.id SEPARATOR ' / ') FROM variant_attribute_values vav
                 JOIN attribute_values av ON av.id = vav.attribute_value_id JOIN attributes a ON a.id = av.attribute_id
                WHERE vav.variant_id = v.id) AS attrs,
              (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE variant_id = v.id AND stock_status = 'NEW') AS qty_new,
              (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE variant_id = v.id AND stock_status = 'USED') AS qty_used,
              (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE variant_id = v.id AND stock_status = 'DAMAGED') AS qty_damaged
         FROM product_variants v WHERE v.product_id = ? AND v.deleted_at IS NULL ORDER BY v.id`,
      [p.id]
    );
    const logs = await db.query(
      `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE (l.entity_type = 'products' AND l.entity_id = ?)
           OR (l.entity_type = 'product_variants' AND l.entity_id IN (SELECT id FROM product_variants WHERE product_id = ?))
        ORDER BY l.id DESC LIMIT 30`,
      [p.id, p.id]
    );
    res.render('products/show', {
      title: p.name,
      p,
      variants,
      logs,
      categories: await lookups.categories(),
      attributes: await loadAttributes(),
    });
  })
);

router.post(
  '/:id',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const b = req.body;
    const data = {
      name: str(b.name),
      category_id: int(b.category_id) || null,
      unit: str(b.unit) || 'cái',
      description: str(b.description),
      is_active: b.is_active ? 1 : 0,
    };
    if (!data.name) throw new AppError('Nhập tên sản phẩm.');
    await db.tx(async (conn) => {
      const [[old]] = await conn.query('SELECT name, category_id, unit, description, is_active FROM products WHERE id = ?', [req.params.id]);
      await conn.query('UPDATE products SET ? WHERE id = ?', [data, req.params.id]);
      await audit(conn, req, 'UPDATE', 'products', req.params.id, old, data);
    });
    flash(req, 'success', 'Đã lưu thông tin sản phẩm.');
    res.redirect(`/products/${req.params.id}`);
  })
);

router.post(
  '/:id/variants',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const rows = toArray(req.body.variants);
    await db.tx(async (conn) => {
      for (const r of rows) {
        const id = int(r.id);
        const data = {
          sku: (str(r.sku) || '').toUpperCase(),
          barcode: str(r.barcode),
          cost_price: dec(r.cost_price),
          sale_price: dec(r.sale_price),
          is_active: r.is_active ? 1 : 0,
        };
        if (!data.sku) throw new AppError('SKU không được để trống.');
        const [[old]] = await conn.query(
          'SELECT sku, barcode, cost_price, sale_price, is_active FROM product_variants WHERE id = ? AND product_id = ?',
          [id, req.params.id]
        );
        if (!old) continue;
        await conn.query('UPDATE product_variants SET ? WHERE id = ?', [data, id]);
        const [o, n] = [old, data];
        if (Object.keys(n).some((k) => String(o[k] ?? '') !== String(n[k] ?? ''))) {
          await audit(conn, req, 'UPDATE', 'product_variants', id, o, n);
        }
      }
    });
    flash(req, 'success', 'Đã lưu biến thể.');
    res.redirect(`/products/${req.params.id}`);
  })
);

router.post(
  '/:id/generate',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    const created = await db.tx(async (conn) => {
      const [[p]] = await conn.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
      return generateVariants(conn, req, p, req.body.attr, { cost: dec(req.body.cost_price), sale: dec(req.body.sale_price) });
    });
    flash(req, created ? 'success' : 'warning', created ? `Đã thêm ${created} biến thể.` : 'Các tổ hợp đã chọn đều đã có.');
    res.redirect(`/products/${req.params.id}`);
  })
);

router.post(
  '/:id/delete',
  requirePerm('catalog.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      const [[{ n }]] = await conn.query(
        'SELECT COALESCE(SUM(s.quantity),0) AS n FROM inventory_stocks s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ?',
        [req.params.id]
      );
      if (n > 0) throw new AppError('Sản phẩm còn tồn kho, không xoá được. Hãy chuyển sang ngừng kinh doanh.');
      await conn.query('UPDATE products SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
      await conn.query('UPDATE product_variants SET deleted_at = NOW() WHERE product_id = ?', [req.params.id]);
      await audit(conn, req, 'DELETE', 'products', req.params.id);
    });
    flash(req, 'success', 'Đã xoá sản phẩm.');
    res.redirect('/products');
  })
);

module.exports = router;
