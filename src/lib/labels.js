// Nhãn tiếng Việt + màu badge cho các giá trị ENUM
const L = {
  role: {
    ADMIN: ['Quản trị', 'dark'],
    PURCHASER: ['Thu mua', 'primary'],
    WAREHOUSE_STAFF: ['Nhân viên kho', 'info'],
    WAREHOUSE_MANAGER: ['Quản lý kho', 'success'],
  },
  poStatus: {
    DRAFT: ['Nháp', 'secondary'],
    CONFIRMED: ['Đã xác nhận', 'primary'],
    PARTIALLY_RECEIVED: ['Nhập một phần', 'warning'],
    RECEIVED: ['Đã nhập đủ', 'success'],
    CLOSED: ['Đã đóng', 'dark'],
    CANCELLED: ['Đã huỷ', 'danger'],
  },
  docStatus: {
    DRAFT: ['Nháp', 'secondary'],
    PENDING_APPROVAL: ['Chờ duyệt', 'warning'],
    APPROVED: ['Đã duyệt', 'success'],
    REJECTED: ['Từ chối', 'danger'],
    CANCELLED: ['Đã huỷ', 'dark'],
  },
  approvalAction: {
    SUBMIT: ['Gửi duyệt', 'primary'],
    APPROVE: ['Duyệt', 'success'],
    REJECT: ['Từ chối', 'danger'],
    CANCEL: ['Huỷ', 'dark'],
  },
  stockStatus: {
    NEW: ['Mới', 'success'],
    USED: ['Đã qua sử dụng', 'warning'],
    DAMAGED: ['Hư hỏng', 'danger'],
  },
  issueType: {
    DEFECTIVE: ['Hàng lỗi', 'danger'],
    WRONG_ITEM: ['Sai mặt hàng', 'warning'],
    WRONG_VARIANT: ['Sai size / màu', 'warning'],
    EXPIRED: ['Hết hạn', 'secondary'],
    EXCESS: ['Giao thừa', 'info'],
    OTHER: ['Khác', 'secondary'],
  },
  issueStatus: {
    OPEN: ['Mới báo', 'danger'],
    PURCHASING_REVIEWING: ['Thu mua đang xử lý', 'warning'],
    SUPPLIER_CONFIRMED: ['NCC đã xác nhận', 'info'],
    RESOLVED: ['Đã xử lý', 'success'],
    REJECTED: ['Không chấp nhận', 'dark'],
  },
  resolution: {
    RETURN: ['Trả hàng NCC', 'secondary'],
    REPLACE: ['NCC đổi hàng', 'secondary'],
    REFUND: ['NCC hoàn tiền', 'secondary'],
    DISCOUNT: ['Giảm giá', 'secondary'],
    ACCEPT: ['Chấp nhận', 'secondary'],
  },
  returnSource: {
    CUSTOMER: ['Khách trả', 'primary'],
    CARRIER: ['Hoàn từ vận chuyển', 'info'],
    OTHER: ['Khác', 'secondary'],
  },
  returnReason: {
    CUSTOMER_CHANGED_MIND: ['Khách đổi ý', 'secondary'],
    WRONG_SIZE: ['Sai size', 'secondary'],
    DEFECTIVE: ['Hàng lỗi', 'secondary'],
    DELIVERY_FAILED: ['Giao không thành công', 'secondary'],
    OTHER: ['Khác', 'secondary'],
  },
  locationType: {
    ZONE: ['Khu', 'secondary'],
    AISLE: ['Dãy', 'secondary'],
    RACK: ['Kệ', 'secondary'],
    SHELF: ['Tầng', 'secondary'],
    BIN: ['Ô', 'secondary'],
    RECEIVING: ['Khu nhận hàng', 'info'],
    DAMAGED: ['Khu hư hỏng', 'danger'],
  },
  txType: {
    GOODS_RECEIPT: ['Nhập mua hàng', 'success'],
    RETURN_RECEIPT: ['Nhập hàng trả về', 'info'],
    GOODS_ISSUE: ['Xuất kho', 'danger'],
    TRANSFER_IN: ['Chuyển đến', 'primary'],
    TRANSFER_OUT: ['Chuyển đi', 'warning'],
    ADJUSTMENT: ['Điều chỉnh', 'secondary'],
  },
};

function label(group, value) {
  return (L[group] && L[group][value] && L[group][value][0]) || value || '';
}

function badge(group, value) {
  if (!value) return '';
  const [text, color] = (L[group] && L[group][value]) || [value, 'secondary'];
  const esc = String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<span class="badge text-bg-${color}">${esc}</span>`;
}

function options(group) {
  return Object.entries(L[group]).map(([value, [text]]) => ({ value, text }));
}

module.exports = { label, badge, options, LABELS: L };
