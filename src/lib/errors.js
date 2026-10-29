// Lỗi nghiệp vụ: message hiển thị thẳng cho người dùng
class AppError extends Error {}

// Đổi lỗi MySQL thành câu dễ hiểu
function friendlyMessage(err) {
  if (err instanceof AppError) return err.message;
  if (err.sqlMessage === 'STOCK_STATUS_CONFLICT') {
    return 'Vị trí đang chứa biến thể này với tình trạng khác. Hãy chọn vị trí khác.';
  }
  switch (err.errno) {
    case 1062: return 'Dữ liệu bị trùng (mã hoặc SKU đã tồn tại).';
    case 1451: return 'Không xoá được vì dữ liệu đang được dùng ở nơi khác.';
    case 1452: return 'Dữ liệu tham chiếu không tồn tại.';
    case 3819: return 'Số lượng không hợp lệ (ví dụ: nhập vượt số lượng mua).';
    default: return null;
  }
}

module.exports = { AppError, friendlyMessage };
