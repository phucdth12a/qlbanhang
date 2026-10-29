// Sinh mã chứng từ tăng dần theo tháng: PO-202610-0001
async function nextCode(conn, prefix) {
  const d = new Date();
  const period = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  await conn.query(
    `INSERT INTO document_sequences (prefix, period, last_no) VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`,
    [prefix, period]
  );
  const [[{ no }]] = await conn.query('SELECT LAST_INSERT_ID() AS no');
  return `${prefix}-${period}-${String(no).padStart(4, '0')}`;
}

module.exports = { nextCode };
