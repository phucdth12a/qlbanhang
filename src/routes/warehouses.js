const express = require('express');
const db = require('../db');
const { ah, requirePerm, flash, str, int, userMessage } = require('../lib/http');
const { audit } = require('../lib/audit');
const { AppError } = require('../lib/errors');

const router = express.Router();

// Sắp vị trí theo cây: cha trước, con thụt vào
function toTree(rows) {
  const byParent = new Map();
  rows.forEach((r) => {
    const k = r.parent_id || 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  });
  const out = [];
  const walk = (pid, depth) => (byParent.get(pid) || []).forEach((r) => { out.push({ ...r, depth }); walk(r.id, depth + 1); });
  walk(0, 0);
  const seen = new Set(out.map((r) => r.id));
  rows.filter((r) => !seen.has(r.id)).forEach((r) => out.push({ ...r, depth: 0 }));
  return out;
}

router.get(
  '/',
  ah(async (req, res) => {
    const warehouses = await db.query(
      `SELECT w.*, u.full_name AS manager_name,
              (SELECT COUNT(*) FROM warehouse_locations WHERE warehouse_id = w.id) AS location_count,
              (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks WHERE warehouse_id = w.id) AS qty
         FROM warehouses w LEFT JOIN users u ON u.id = w.manager_id ORDER BY w.name`
    );
    res.render('warehouses/index', { title: 'Kho & vị trí', warehouses });
  })
);

const managers = () => db.query("SELECT id, full_name FROM users WHERE is_active = 1 AND role IN ('WAREHOUSE_MANAGER','ADMIN') ORDER BY full_name");

router.get(
  '/new',
  requirePerm('warehouses.manage'),
  ah(async (req, res) => res.render('warehouses/form', { title: 'Thêm kho', w: { is_active: 1 }, managers: await managers(), error: null }))
);

router.get(
  '/:id',
  ah(async (req, res, next) => {
    const w = await db.one('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
    if (!w) return next();
    const locations = toTree(
      await db.query(
        `SELECT l.*,
                (SELECT COUNT(*) FROM inventory_stocks s WHERE s.location_id = l.id AND s.quantity > 0) AS sku_count,
                (SELECT COALESCE(SUM(quantity),0) FROM inventory_stocks s WHERE s.location_id = l.id) AS qty
           FROM warehouse_locations l WHERE l.warehouse_id = ? ORDER BY l.code`,
        [w.id]
      )
    );
    const editing = req.query.edit ? locations.find((l) => l.id === int(req.query.edit)) : null;
    res.render('warehouses/show', { title: w.name, w, locations, editing, managers: await managers() });
  })
);

router.post(
  ['/', '/:id'],
  requirePerm('warehouses.manage'),
  ah(async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const data = {
      code: (str(req.body.code) || '').toUpperCase(),
      name: str(req.body.name),
      address: str(req.body.address),
      manager_id: int(req.body.manager_id) || null,
      is_active: req.body.is_active ? 1 : 0,
    };
    try {
      if (!data.code || !data.name) throw new AppError('Nhập mã và tên kho.');
      const newId = await db.tx(async (conn) => {
        if (id) {
          const [[old]] = await conn.query('SELECT code, name, address, manager_id, is_active FROM warehouses WHERE id = ?', [id]);
          await conn.query('UPDATE warehouses SET ? WHERE id = ?', [data, id]);
          await audit(conn, req, 'UPDATE', 'warehouses', id, old, data);
          return id;
        }
        const [r] = await conn.query('INSERT INTO warehouses SET ?', [data]);
        await audit(conn, req, 'CREATE', 'warehouses', r.insertId, null, data);
        return r.insertId;
      });
      flash(req, 'success', 'Đã lưu kho.');
      res.redirect(`/warehouses/${newId}`);
    } catch (err) {
      res.status(422).render('warehouses/form', { title: 'Kho', w: { ...data, id }, managers: await managers(), error: userMessage(err) });
    }
  })
);

router.post(
  '/:id/locations',
  requirePerm('warehouses.manage'),
  ah(async (req, res) => {
    const warehouseId = Number(req.params.id);
    const locId = int(req.body.location_id) || null;
    const data = {
      code: (str(req.body.code) || '').toUpperCase(),
      name: str(req.body.name),
      location_type: req.body.location_type || 'BIN',
      parent_id: int(req.body.parent_id) || null,
      is_active: req.body.is_active ? 1 : 0,
    };
    if (!data.code) throw new AppError('Nhập mã vị trí.');
    if (locId && data.parent_id === locId) throw new AppError('Vị trí không thể là cha của chính nó.');
    await db.tx(async (conn) => {
      if (data.parent_id) {
        const [[parent]] = await conn.query('SELECT warehouse_id FROM warehouse_locations WHERE id = ?', [data.parent_id]);
        if (!parent || parent.warehouse_id !== warehouseId) throw new AppError('Vị trí cha phải cùng kho.');
      }
      if (locId) {
        const [[old]] = await conn.query('SELECT code, name, location_type, parent_id, is_active FROM warehouse_locations WHERE id = ? AND warehouse_id = ?', [locId, warehouseId]);
        if (!old) throw new AppError('Vị trí không tồn tại.');
        await conn.query('UPDATE warehouse_locations SET ? WHERE id = ?', [data, locId]);
        await audit(conn, req, 'UPDATE', 'warehouse_locations', locId, old, data);
      } else {
        const [r] = await conn.query('INSERT INTO warehouse_locations SET ?', [{ ...data, warehouse_id: warehouseId }]);
        await audit(conn, req, 'CREATE', 'warehouse_locations', r.insertId, null, { ...data, warehouse_id: warehouseId });
      }
    });
    flash(req, 'success', `Đã lưu vị trí ${data.code}.`);
    res.redirect(`/warehouses/${warehouseId}`);
  })
);

router.post(
  '/:id/locations/:locId/delete',
  requirePerm('warehouses.manage'),
  ah(async (req, res) => {
    await db.tx(async (conn) => {
      const [[{ n }]] = await conn.query('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stocks WHERE location_id = ?', [req.params.locId]);
      if (n > 0) throw new AppError('Vị trí còn hàng, không xoá được.');
      const [[old]] = await conn.query('SELECT code, name FROM warehouse_locations WHERE id = ?', [req.params.locId]);
      await conn.query('DELETE FROM inventory_stocks WHERE location_id = ? AND quantity = 0', [req.params.locId]);
      await conn.query('DELETE FROM warehouse_locations WHERE id = ? AND warehouse_id = ?', [req.params.locId, req.params.id]);
      await audit(conn, req, 'DELETE', 'warehouse_locations', req.params.locId, old, null);
    });
    flash(req, 'success', 'Đã xoá vị trí.');
    res.redirect(`/warehouses/${req.params.id}`);
  })
);

module.exports = router;
