const { AppError } = require('../lib/errors');
const { label, LABELS } = require('../lib/labels');
const { addStock, checkLocationStatus } = require('./stock');
const { audit } = require('../lib/audit');

// Các dòng PO kèm số còn được nhập = SL mua - đã nhập - đang chờ duyệt ở phiếu khác
async function poLines(conn, poId, excludeGrId = 0) {
  const [rows] = await conn.query(
    `SELECT i.id, i.variant_id, i.quantity_ordered, i.quantity_received, v.sku, v.name,
            (SELECT COALESCE(SUM(gi.quantity_accepted),0) FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.goods_receipt_id
              WHERE gi.purchase_order_item_id = i.id AND g.status = 'PENDING_APPROVAL' AND g.id <> ?) AS qty_pending
       FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id
      WHERE i.purchase_order_id = ? ORDER BY i.id`,
    [excludeGrId, poId]
  );
  rows.forEach((r) => (r.remaining = r.quantity_ordered - r.quantity_received - r.qty_pending));
  return rows;
}

// Một dòng PO trong phiếu nhập:
//   { purchase_order_item_id, alloc: [{ location_id, quantity }], issues: [{ issue_type, quantity, description }] }
// alloc: hàng đạt chia vào nhiều vị trí; issues: nhiều loại phát sinh (không vào tồn)

// Kiểm tra các dòng; dùng khi lưu, gửi duyệt và duyệt. Trả về các dòng có số lượng.
async function validateLines(conn, { poId, warehouseId, grId = 0, lines, checkLocations = false }) {
  const filled = lines
    .map((l) => ({
      ...l,
      alloc: (l.alloc || []).filter((a) => a.quantity || a.location_id),
      issues: (l.issues || []).filter((x) => x.quantity || x.issue_type || x.description),
    }))
    .filter((l) => l.alloc.length || l.issues.length);
  if (!filled.length) throw new AppError('Nhập số lượng cho ít nhất 1 dòng hàng.');
  const poLinesById = new Map((await poLines(conn, poId, grId)).map((l) => [l.id, l]));
  const [locs] = await conn.query('SELECT id FROM warehouse_locations WHERE warehouse_id = ? AND is_active = 1', [warehouseId]);
  const locIds = new Set(locs.map((l) => l.id));
  const seenLine = new Set();
  for (const l of filled) {
    const line = poLinesById.get(l.purchase_order_item_id);
    if (!line) throw new AppError('Dòng hàng không thuộc phiếu mua.');
    if (seenLine.has(line.id)) throw new AppError(`${line.sku}: dòng hàng bị lặp.`);
    seenLine.add(line.id);
    l.variant_id = line.variant_id;
    const seenLoc = new Set();
    let accepted = 0;
    for (const a of l.alloc) {
      if (!(a.quantity > 0)) throw new AppError(`${line.sku}: số lượng nhập vào vị trí phải lớn hơn 0.`);
      if (!locIds.has(a.location_id)) throw new AppError(`${line.sku}: chọn vị trí cất hàng trong kho.`);
      if (seenLoc.has(a.location_id)) throw new AppError(`${line.sku}: một vị trí bị chọn 2 lần, hãy gộp số lượng.`);
      seenLoc.add(a.location_id);
      accepted += a.quantity;
      if (checkLocations) {
        const conflict = await checkLocationStatus(conn, a.location_id, line.variant_id, 'NEW');
        if (conflict) throw new AppError(`${line.sku}: ${conflict} Hãy chọn vị trí khác.`);
      }
    }
    if (accepted > line.remaining) {
      throw new AppError(
        `${line.sku}: SL đạt ${accepted} vượt số còn được nhập ${Math.max(line.remaining, 0)} ` +
          `(mua ${line.quantity_ordered}, đã nhập ${line.quantity_received}, đang chờ duyệt ${line.qty_pending}).`
      );
    }
    for (const x of l.issues) {
      if (!(x.quantity > 0)) throw new AppError(`${line.sku}: số lượng phát sinh phải lớn hơn 0.`);
      if (!LABELS.issueType[x.issue_type]) throw new AppError(`${line.sku}: chọn loại phát sinh.`);
    }
    l.accepted = accepted;
    l.issueTotal = l.issues.reduce((n, x) => n + x.quantity, 0);
  }
  return filled;
}

async function saveItems(conn, req, grId, lines) {
  await conn.query('DELETE FROM goods_receipt_items WHERE goods_receipt_id = ?', [grId]);
  for (const l of lines) {
    const base = { goods_receipt_id: grId, purchase_order_item_id: l.purchase_order_item_id, variant_id: l.variant_id };
    let issueItemId = null;
    for (const [j, a] of l.alloc.entries()) {
      // Phát sinh gắn vào dòng vị trí đầu tiên để tổng SL giao của dòng PO đúng
      const [r] = await conn.query('INSERT INTO goods_receipt_items SET ?', [
        { ...base, location_id: a.location_id, quantity_accepted: a.quantity, quantity_issue: j === 0 ? l.issueTotal : 0 },
      ]);
      if (j === 0) issueItemId = r.insertId;
    }
    if (l.issues.length && !issueItemId) {
      const [r] = await conn.query('INSERT INTO goods_receipt_items SET ?', [{ ...base, location_id: null, quantity_accepted: 0, quantity_issue: l.issueTotal }]);
      issueItemId = r.insertId;
    }
    for (const x of l.issues) {
      await conn.query('INSERT INTO goods_receipt_issues SET ?', [
        { goods_receipt_item_id: issueItemId, issue_type: x.issue_type, quantity: x.quantity, description: x.description || null, created_by: req.session.user.id },
      ]);
    }
  }
}

// Dòng đã lưu -> dạng lines
async function linesFromDb(conn, grId) {
  const [items] = await conn.query('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ? ORDER BY id', [grId]);
  const [issues] = await conn.query(
    `SELECT x.*, gi.purchase_order_item_id FROM goods_receipt_issues x JOIN goods_receipt_items gi ON gi.id = x.goods_receipt_item_id
      WHERE gi.goods_receipt_id = ? ORDER BY x.id`,
    [grId]
  );
  const map = new Map();
  const get = (id) => {
    if (!map.has(id)) map.set(id, { purchase_order_item_id: id, alloc: [], issues: [] });
    return map.get(id);
  };
  items.forEach((i) => { if (i.quantity_accepted > 0) get(i.purchase_order_item_id).alloc.push({ location_id: i.location_id, quantity: i.quantity_accepted }); });
  issues.forEach((x) => get(x.purchase_order_item_id).issues.push({ issue_type: x.issue_type, quantity: x.quantity, description: x.description }));
  return [...map.values()];
}

async function logApproval(conn, req, grId, action, from, to, comment = null) {
  await conn.query('INSERT INTO goods_receipt_approvals SET ?', [
    { goods_receipt_id: grId, action, from_status: from, to_status: to, comment, acted_by: req.session.user.id },
  ]);
  await audit(conn, req, action, 'goods_receipts', grId, { status: from }, { status: to, ...(comment ? { comment } : {}) });
}

// Duyệt: cộng SL đã nhập vào PO, cộng tồn kho (NEW), ghi thẻ kho, cập nhật trạng thái PO
async function approve(conn, req, grId) {
  const [[gr]] = await conn.query('SELECT * FROM goods_receipts WHERE id = ? FOR UPDATE', [grId]);
  if (!gr) throw new AppError('Phiếu không tồn tại.');
  if (gr.status !== 'PENDING_APPROVAL') throw new AppError(`Phiếu đang ở trạng thái "${label('docStatus', gr.status)}", không duyệt được.`);
  const [[po]] = await conn.query('SELECT id, status FROM purchase_orders WHERE id = ? FOR UPDATE', [gr.purchase_order_id]);
  if (!['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new AppError(`Phiếu mua đang "${label('poStatus', po.status)}", không nhập thêm được.`);

  await validateLines(conn, { poId: gr.purchase_order_id, warehouseId: gr.warehouse_id, grId, lines: await linesFromDb(conn, grId) });
  const [items] = await conn.query('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ?', [grId]);

  for (const it of items) {
    const [[line]] = await conn.query('SELECT * FROM purchase_order_items WHERE id = ? FOR UPDATE', [it.purchase_order_item_id]);
    if (line.quantity_received + it.quantity_accepted > line.quantity_ordered) {
      throw new AppError('Số lượng nhập vượt số lượng mua.');
    }
    await conn.query('UPDATE purchase_order_items SET quantity_received = quantity_received + ?, quantity_issue = quantity_issue + ? WHERE id = ?', [
      it.quantity_accepted,
      it.quantity_issue,
      line.id,
    ]);
    if (it.quantity_accepted > 0) {
      await addStock(conn, {
        warehouseId: gr.warehouse_id,
        locationId: it.location_id,
        variantId: it.variant_id,
        status: 'NEW',
        quantity: it.quantity_accepted,
        type: 'GOODS_RECEIPT',
        refType: 'goods_receipt',
        refId: grId,
        refItemId: it.id,
        userId: req.session.user.id,
      });
    }
  }

  const [[{ notDone }]] = await conn.query(
    'SELECT COUNT(*) AS notDone FROM purchase_order_items WHERE purchase_order_id = ? AND quantity_received < quantity_ordered',
    [po.id]
  );
  const poStatus = notDone === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  if (poStatus !== po.status) {
    await conn.query('UPDATE purchase_orders SET status = ? WHERE id = ?', [poStatus, po.id]);
    await audit(conn, req, 'STATUS', 'purchase_orders', po.id, { status: po.status }, { status: poStatus, by: gr.code });
  }
  await conn.query('UPDATE goods_receipts SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = NULL WHERE id = ?', [
    'APPROVED',
    req.session.user.id,
    grId,
  ]);
  await logApproval(conn, req, grId, 'APPROVE', 'PENDING_APPROVAL', 'APPROVED', req.body.comment || null);
}

module.exports = { poLines, validateLines, saveItems, linesFromDb, approve, logApproval };
