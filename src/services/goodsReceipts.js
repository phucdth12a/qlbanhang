const { AppError } = require('../lib/errors');
const { label } = require('../lib/labels');
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

// Kiểm tra các dòng phiếu nhập; dùng khi lưu, gửi duyệt và duyệt
async function validateLines(conn, { poId, warehouseId, grId = 0, items, checkLocations = false, checkIssueType = true }) {
  if (!items.length) throw new AppError('Nhập số lượng cho ít nhất 1 dòng hàng.');
  const lines = await poLines(conn, poId, grId);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const [locs] = await conn.query('SELECT id, code FROM warehouse_locations WHERE warehouse_id = ? AND is_active = 1', [warehouseId]);
  const locIds = new Set(locs.map((l) => l.id));
  for (const it of items) {
    const line = byId.get(it.purchase_order_item_id);
    if (!line) throw new AppError('Dòng hàng không thuộc phiếu mua.');
    if (it.quantity_accepted < 0 || it.quantity_issue < 0) throw new AppError(`${line.sku}: số lượng không được âm.`);
    if (it.quantity_accepted > line.remaining) {
      throw new AppError(
        `${line.sku}: SL đạt ${it.quantity_accepted} vượt số còn được nhập ${Math.max(line.remaining, 0)} ` +
          `(mua ${line.quantity_ordered}, đã nhập ${line.quantity_received}, đang chờ duyệt ${line.qty_pending}).`
      );
    }
    if (it.quantity_accepted > 0 && !locIds.has(it.location_id)) throw new AppError(`${line.sku}: chọn vị trí cất hàng trong kho.`);
    if (checkIssueType && it.quantity_issue > 0 && !it.issue_type) throw new AppError(`${line.sku}: chọn loại phát sinh.`);
    if (checkLocations && it.quantity_accepted > 0) {
      const conflict = await checkLocationStatus(conn, it.location_id, line.variant_id, 'NEW');
      if (conflict) throw new AppError(`${line.sku}: ${conflict} Hãy chọn vị trí khác.`);
    }
    it.variant_id = line.variant_id;
  }
}

async function saveItems(conn, req, grId, items) {
  await conn.query('DELETE FROM goods_receipt_items WHERE goods_receipt_id = ?', [grId]);
  for (const it of items) {
    const [r] = await conn.query('INSERT INTO goods_receipt_items SET ?', [
      {
        goods_receipt_id: grId,
        purchase_order_item_id: it.purchase_order_item_id,
        variant_id: it.variant_id,
        location_id: it.quantity_accepted > 0 ? it.location_id : it.location_id || null,
        quantity_accepted: it.quantity_accepted,
        quantity_issue: it.quantity_issue,
        note: it.note,
      },
    ]);
    if (it.quantity_issue > 0) {
      await conn.query('INSERT INTO goods_receipt_issues SET ?', [
        {
          goods_receipt_item_id: r.insertId,
          issue_type: it.issue_type,
          quantity: it.quantity_issue,
          description: it.issue_description,
          created_by: req.session.user.id,
        },
      ]);
    }
  }
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

  const [items] = await conn.query('SELECT * FROM goods_receipt_items WHERE goods_receipt_id = ?', [grId]);
  await validateLines(conn, {
    poId: gr.purchase_order_id,
    warehouseId: gr.warehouse_id,
    grId,
    items: items.map((i) => ({ ...i })),
    checkIssueType: false,
  });

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

module.exports = { poLines, validateLines, saveItems, approve, logApproval };
