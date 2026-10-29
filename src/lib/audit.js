// Ghi lịch sử thao tác. Chỉ lưu các trường thay đổi khi có cả giá trị cũ và mới.
function diff(oldV, newV) {
  if (!oldV || !newV) return [oldV || null, newV || null];
  const o = {};
  const n = {};
  for (const k of Object.keys(newV)) {
    if (String(oldV[k] ?? '') !== String(newV[k] ?? '')) {
      o[k] = oldV[k] ?? null;
      n[k] = newV[k] ?? null;
    }
  }
  return [o, n];
}

async function audit(conn, req, action, entityType, entityId, oldV = null, newV = null) {
  const [o, n] = diff(oldV, newV);
  await conn.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.session?.user?.id || null,
      action,
      entityType,
      entityId,
      o ? JSON.stringify(o) : null,
      n ? JSON.stringify(n) : null,
      req.ip,
      (req.get('user-agent') || '').slice(0, 255),
      req.requestId,
    ]
  );
}

module.exports = { audit };
