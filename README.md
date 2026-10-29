# QL Bán hàng – Web admin

Web quản trị cho mua hàng và kho:

- **Sản phẩm nhiều biến thể**: Size S/M/L, Màu…; mỗi tổ hợp là một SKU riêng.
- **Nhà cung cấp**, **kho** và **vị trí trong kho** dạng cây (Khu > Kệ > Ô).
- **Phiếu mua hàng (PO)**: Nháp → Xác nhận → Nhập một phần → Đã nhập đủ / Đóng.
- **Phiếu nhập kho** lập từ PO, nhập nhiều lần (VD: mua 100, nhập 10 + 20 + 70). Ghi **SL đạt** (vào tồn) và **SL phát sinh** (lỗi, sai mẫu… báo thu mua). Phải **duyệt** thì hàng mới vào kho.
- **Hàng phát sinh**: thu mua theo dõi và ghi kết quả làm việc với NCC (trả hàng, đổi hàng, hoàn tiền…).
- **Hàng trả về**: nhập lại kho theo tình trạng **Mới / Đã qua sử dụng / Hư hỏng**, cũng phải duyệt. Một vị trí chỉ chứa **một tình trạng** của mỗi biến thể.
- **Tồn kho** theo vị trí và tình trạng, **thẻ kho** ghi mọi biến động.
- **Lịch sử thao tác** của mọi thay đổi: ai làm, lúc nào, giá trị cũ → mới.

Stack: Node.js 18+ · Express · EJS · Bootstrap 5 · MySQL 8.0.16+

## Chạy local

### 1. Cài MySQL 8

**Cách A – Docker (khuyên dùng):**

```bash
docker compose up -d          # MySQL 8 ở cổng 3306, user root / mật khẩu root
```

**Cách B – MySQL cài sẵn trên máy:** dùng MySQL **8.0.16 trở lên** (bản cũ hơn không chạy ràng buộc `CHECK`). Sửa thông tin kết nối trong `.env` ở bước 2.

### 2. Cấu hình và tạo database

```bash
npm install
cp .env.example .env          # sửa DB_USER / DB_PASSWORD nếu cần
npm run db:init               # tạo database qlbanhang, các bảng, trigger và dữ liệu mẫu
```

`npm run db:reset` **xoá toàn bộ** database rồi tạo lại từ đầu.

### 3. Chạy web

```bash
npm start                     # hoặc: npm run dev (tự khởi động lại khi sửa code)
```

Mở http://localhost:3000

| Tài khoản | Mật khẩu | Vai trò | Được làm |
|---|---|---|---|
| `admin` | `admin123` | Quản trị | Tất cả |
| `thumua` | `123456` | Thu mua | Sản phẩm, NCC, phiếu mua hàng, xử lý hàng phát sinh |
| `nvkho` | `123456` | Nhân viên kho | Lập phiếu nhập kho, phiếu hàng trả về |
| `qlkho` | `123456` | Quản lý kho | Như nhân viên kho, cộng thêm duyệt / từ chối phiếu, quản lý kho & vị trí, xem lịch sử thao tác |

## Quy trình mẫu

1. `thumua` tạo **phiếu mua hàng** 100 áo → **Xác nhận**.
2. `nvkho` mở PO → **Tạo phiếu nhập kho** → nhập 10 cái vào ô `A-01-01` → **Lưu và gửi duyệt**.
3. `qlkho` mở phiếu → **Duyệt nhập kho**. Tồn kho +10, PO ghi "đã nhập 10/100".
4. Lần 2 nhận 30 cái, 10 cái lỗi: SL đạt 20, SL phát sinh 10, loại "Hàng lỗi". Sau khi duyệt, 10 cái lỗi hiện ở mục **Hàng phát sinh** cho thu mua xử lý.
5. Lần 3 nhập 70 → PO tự chuyển **Đã nhập đủ**. Nhập vượt số còn lại sẽ bị chặn.
6. **Hàng trả về**: chọn tình trạng và vị trí cho từng dòng. Nếu ô đang chứa áo M loại Mới thì không cất thêm áo M Đã qua sử dụng vào đó.

## Cấu trúc thư mục

```
db/schema.sql            Toàn bộ bảng (MySQL 8)
db/triggers.sql          Trigger chặn 2 tình trạng trên cùng 1 vị trí
scripts/db-init.js       Tạo database + dữ liệu mẫu
src/server.js            Khởi động Express, middleware, gắn route
src/routes/              Mỗi màn hình một file
src/services/            Nghiệp vụ dùng chung: cộng tồn kho, duyệt phiếu nhập
src/lib/                 Kết nối DB, phân quyền, nhãn tiếng Việt, ghi lịch sử, sinh mã phiếu
views/                   Giao diện EJS
public/                  CSS / JS phía trình duyệt
```

## Quy tắc nghiệp vụ chính

- `purchase_order_items.quantity_received` chỉ tăng khi phiếu nhập được **duyệt**. DB có `CHECK (quantity_received <= quantity_ordered)` chặn nhập vượt.
- Khi lập và gửi duyệt, app kiểm tra: đã nhập + đang chờ duyệt ở phiếu khác + phiếu này ≤ SL mua.
- Hàng phát sinh **không vào tồn** và không chiếm suất SL mua. NCC giao bù thì lập thêm phiếu nhập cho cùng PO.
- Phiếu nhập / trả về đã duyệt không sửa được. Phiếu bị từ chối thì sửa và gửi lại.
- `inventory_stocks` có `UNIQUE (location_id, variant_id)` và một cột `stock_status`. Trigger `trg_stock_status_guard` chặn đổi tình trạng khi ô còn hàng.
- Mọi thao tác ghi vào `audit_logs` (user, IP, giá trị cũ / mới dạng JSON). Mọi biến động tồn ghi vào `inventory_transactions`.

## Lưu ý khi đưa lên server thật

- Đổi `SESSION_SECRET` và mật khẩu các tài khoản mẫu.
- Session đang lưu trong bộ nhớ (khởi động lại server sẽ phải đăng nhập lại). Khi chạy nhiều tiến trình, hãy chuyển sang lưu session bằng MySQL hoặc Redis.
- Chạy sau HTTPS và bật `cookie.secure` trong `src/server.js`.
