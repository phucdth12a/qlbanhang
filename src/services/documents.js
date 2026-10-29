// Luồng duyệt dùng chung cho phiếu xuất kho, chuyển kho, kiểm kê:
// Nháp / Từ chối --gửi duyệt--> Chờ duyệt --duyệt--> Đã duyệt
//                                         --từ chối--> Từ chối (sửa và gửi lại)
// Nháp / Từ chối --huỷ--> Đã huỷ
const db = require('../db');
const { AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { ah, requirePerm, flash, str } = require('../lib/http');
const { label } = require('../lib/labels');

const EDITABLE = ['DRAFT', 'REJECTED'];
const TABLES = {
  goods_issue: 'goods_issues',
  stock_transfer: 'stock_transfers',
  stock_adjustment: 'stock_adjustments',
};

async function logApproval(conn, req, type, id, action, from, to, comment = null) {
  await conn.query('INSERT INTO document_approvals SET ?', [
    { document_type: type, document_id: id, action, from_status: from, to_status: to, comment, acted_by: req.session.user.id },
  ]);
  await audit(conn, req, action, TABLES[type], id, { status: from }, { status: to, ...(comment ? { comment } : {}) });
}

async function lock(conn, type, id) {
  const [[doc]] = await conn.query(`SELECT * FROM ${TABLES[type]} WHERE id = ? FOR UPDATE`, [id]);
  if (!doc) throw new AppError('Phiếu không tồn tại.');
  return doc;
}

async function setStatus(conn, type, id, status, extra = {}) {
  await conn.query(`UPDATE ${TABLES[type]} SET ? WHERE id = ?`, [{ status, ...extra }, id]);
}

async function submit(conn, req, type, id, validate) {
  const doc = await lock(conn, type, id);
  if (!EDITABLE.includes(doc.status)) throw new AppError('Phiếu không ở trạng thái Nháp / Từ chối.');
  await validate(conn, doc);
  await setStatus(conn, type, id, 'PENDING_APPROVAL', { submitted_at: new Date() });
  await logApproval(conn, req, type, id, 'SUBMIT', doc.status, 'PENDING_APPROVAL');
}

function approvals(type, id) {
  return db.query(
    `SELECT a.*, u.full_name FROM document_approvals a JOIN users u ON u.id = a.acted_by
      WHERE a.document_type = ? AND a.document_id = ? ORDER BY a.id`,
    [type, id]
  );
}

function auditLogs(type, id) {
  return db.query(
    `SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.entity_type = ? AND l.entity_id = ? ORDER BY l.id DESC`,
    [TABLES[type], id]
  );
}

// Gắn các route /:id/submit|approve|reject|cancel cho 1 loại phiếu
function workflowRoutes(router, { type, base, createPerm, approvePerm, validate, approve, approvedMessage }) {
  const back = (req, res) => res.redirect(`${base}/${req.params.id}`);

  router.post(
    '/:id(\\d+)/submit',
    requirePerm(createPerm),
    ah(async (req, res) => {
      await db.tx((conn) => submit(conn, req, type, Number(req.params.id), validate));
      flash(req, 'success', 'Đã gửi duyệt.');
      back(req, res);
    })
  );

  router.post(
    '/:id(\\d+)/approve',
    requirePerm(approvePerm),
    ah(async (req, res) => {
      const id = Number(req.params.id);
      await db.tx(async (conn) => {
        const doc = await lock(conn, type, id);
        if (doc.status !== 'PENDING_APPROVAL') throw new AppError(`Phiếu đang "${label('docStatus', doc.status)}", không duyệt được.`);
        await approve(conn, req, doc);
        await setStatus(conn, type, id, 'APPROVED', { reviewed_by: req.session.user.id, reviewed_at: new Date(), review_note: null });
        await logApproval(conn, req, type, id, 'APPROVE', 'PENDING_APPROVAL', 'APPROVED', str(req.body.comment));
      });
      flash(req, 'success', approvedMessage);
      back(req, res);
    })
  );

  router.post(
    '/:id(\\d+)/reject',
    requirePerm(approvePerm),
    ah(async (req, res) => {
      const id = Number(req.params.id);
      const reason = str(req.body.reason);
      if (!reason) throw new AppError('Nhập lý do từ chối.');
      await db.tx(async (conn) => {
        const doc = await lock(conn, type, id);
        if (doc.status !== 'PENDING_APPROVAL') throw new AppError('Phiếu không ở trạng thái chờ duyệt.');
        await setStatus(conn, type, id, 'REJECTED', { reviewed_by: req.session.user.id, reviewed_at: new Date(), review_note: reason });
        await logApproval(conn, req, type, id, 'REJECT', 'PENDING_APPROVAL', 'REJECTED', reason);
      });
      flash(req, 'success', 'Đã từ chối phiếu. Người lập có thể sửa và gửi lại.');
      back(req, res);
    })
  );

  router.post(
    '/:id(\\d+)/cancel',
    requirePerm(createPerm),
    ah(async (req, res) => {
      const id = Number(req.params.id);
      await db.tx(async (conn) => {
        const doc = await lock(conn, type, id);
        if (!EDITABLE.includes(doc.status)) throw new AppError('Chỉ huỷ được phiếu Nháp hoặc bị Từ chối.');
        await setStatus(conn, type, id, 'CANCELLED');
        await logApproval(conn, req, type, id, 'CANCEL', doc.status, 'CANCELLED');
      });
      flash(req, 'success', 'Đã huỷ phiếu.');
      back(req, res);
    })
  );
}

module.exports = { EDITABLE, logApproval, lock, submit, approvals, auditLogs, workflowRoutes };
