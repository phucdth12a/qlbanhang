# QL Bán hàng – Web admin

Web quản trị bán hàng, mua hàng và kho:

- **Sản phẩm nhiều biến thể**: Size S/M/L, Màu…; mỗi tổ hợp là một SKU riêng.
- **Nhà cung cấp**, **kho** và **vị trí trong kho** dạng cây (Khu > Kệ > Ô).
- **Phiếu mua hàng (PO)**: Nháp → Xác nhận → Nhập một phần → Đã nhập đủ / Đóng.
- **Phiếu nhập kho** lập từ PO, nhập nhiều lần (VD: mua 100, nhập 10 + 20 + 70). Hàng đạt **chia được vào nhiều vị trí**. Hàng **phát sinh** (lỗi, sai size, giao thừa…) ghi được nhiều loại trên một dòng và được báo cho thu mua. Phải **duyệt** thì hàng mới vào kho.
- **Hàng phát sinh**: thu mua theo dõi và ghi kết quả làm việc với NCC (trả hàng, đổi hàng, hoàn tiền…).
- **Khách hàng, đơn bán hàng**: khi xác nhận đơn, hệ thống kiểm tra và **giữ hàng** cho đơn.
- **Phiếu xuất kho**: xuất bán theo đơn (lấy hàng từ nhiều vị trí), trả NCC, huỷ hàng, dùng nội bộ. Phải duyệt thì mới trừ tồn.
- **Hàng trả về**: nhập lại kho theo tình trạng **Mới / Đã qua sử dụng / Hư hỏng**, gắn được với đơn bán, cũng phải duyệt. Một vị trí chỉ chứa **một tình trạng** của mỗi biến thể.
- **Chuyển kho / chuyển vị trí** và **kiểm kê** (điều chỉnh tồn theo số đếm, phân loại lại tình trạng), đều có duyệt.
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
npm run db:init               # tạo database qlbanhang, các bảng, trigger, migration và dữ liệu mẫu
```

- **Cập nhật code mới về:** chạy `npm run db:migrate` để nâng cấp database, dữ liệu cũ vẫn giữ nguyên. Các thay đổi nằm trong `db/migrations/`, file nào đã chạy được ghi vào bảng `schema_migrations`.
- `npm run db:reset` **xoá toàn bộ** database rồi tạo lại từ đầu.

### 3. Chạy web

```bash
npm start                     # hoặc: npm run dev (tự khởi động lại khi sửa code)
```

Mở http://localhost:3000

| Tài khoản | Mật khẩu | Vai trò | Được làm |
|---|---|---|---|
| `admin` | `admin123` | Quản trị | Tất cả |
| `banhang` | `123456` | Bán hàng | Khách hàng, đơn bán hàng |
| `thumua` | `123456` | Thu mua | Sản phẩm, NCC, phiếu mua hàng, xử lý hàng phát sinh |
| `nvkho` | `123456` | Nhân viên kho | Lập phiếu nhập, xuất, trả về, chuyển kho, kiểm kê |
| `qlkho` | `123456` | Quản lý kho | Như nhân viên kho, cộng thêm duyệt / từ chối phiếu, quản lý kho & vị trí, xem lịch sử thao tác |

Tài khoản `banhang` được tạo khi chạy `db:init` lần đầu. Nếu database đã có từ bản trước, tạo thêm người dùng vai trò "Bán hàng" ở trang **Người dùng**.

## Quy trình mẫu

1. `thumua` tạo **phiếu mua hàng** 100 áo → **Xác nhận**.
2. `nvkho` mở PO → **Tạo phiếu nhập kho** → nhập 10 cái vào ô `A-01-01` → **Lưu và gửi duyệt**.
3. `qlkho` mở phiếu → **Duyệt nhập kho**. Tồn kho +10, PO ghi "đã nhập 10/100".
4. Lần 2 nhận 30 cái, 10 cái lỗi: SL đạt 20, SL phát sinh 10, loại "Hàng lỗi". Sau khi duyệt, 10 cái lỗi hiện ở mục **Hàng phát sinh** cho thu mua xử lý.
5. Lần 3 nhập 70 → PO tự chuyển **Đã nhập đủ**. Nhập vượt số còn lại sẽ bị chặn.
6. `banhang` tạo **đơn bán** → **Xác nhận**. Không đủ hàng khả dụng thì hệ thống báo thiếu bao nhiêu. Xác nhận xong, hàng được giữ cho đơn.
7. `nvkho` mở đơn → **Tạo phiếu xuất kho** → chọn vị trí lấy hàng (một sản phẩm lấy được từ nhiều ô). `qlkho` duyệt → tồn giảm, đơn ghi "đã xuất".
8. **Hàng trả về**: chọn tình trạng và vị trí cho từng dòng. Nếu ô đang chứa áo M loại Mới thì không cất thêm áo M Đã qua sử dụng vào đó. Gắn với đơn bán thì không trả quá số đã xuất.
9. **Kiểm kê**: nhập số đếm thực tế. Duyệt xong, tồn được đặt bằng số đếm và chênh lệch được ghi vào thẻ kho.

## Cấu trúc thư mục

```
db/schema.sql            Bảng gốc (MySQL 8)
db/triggers.sql          Trigger chặn 2 tình trạng trên cùng 1 vị trí
db/migrations/           Thay đổi database sau bản gốc, chạy theo thứ tự tên file
scripts/db-init.js       Tạo database + dữ liệu mẫu
src/server.js            Khởi động Express, middleware, gắn route
src/routes/              Mỗi màn hình một file
src/services/            Nghiệp vụ dùng chung: cộng/trừ tồn, hàng giữ cho đơn, duyệt phiếu
src/lib/                 Kết nối DB, phân quyền, nhãn tiếng Việt, ghi lịch sử, sinh mã phiếu
views/                   Giao diện EJS
public/                  CSS / JS phía trình duyệt
```

## Quy tắc nghiệp vụ chính

- `purchase_order_items.quantity_received` chỉ tăng khi phiếu nhập được **duyệt**. DB có `CHECK (quantity_received <= quantity_ordered)` chặn nhập vượt.
- Khi lập và gửi duyệt, app kiểm tra: đã nhập + đang chờ duyệt ở phiếu khác + phiếu này ≤ SL mua.
- Hàng phát sinh **không vào tồn** và không chiếm suất SL mua. NCC giao bù thì lập thêm phiếu nhập cho cùng PO.
- **Hàng giữ cho đơn** = SL đặt − SL đã xuất của các đơn đã xác nhận. **Khả dụng** = tồn hàng mới − hàng giữ cho đơn. Xác nhận đơn, xuất kho cho mục đích khác bán hàng và chuyển sang kho khác đều không được lấy vào phần đang giữ. Đóng hoặc huỷ đơn thì hàng giữ được trả lại.
- Chỉ xuất bán **hàng mới**. Hàng cũ / hư hỏng xuất bằng phiếu trả NCC, huỷ hàng hoặc dùng nội bộ.
- `sales_order_items.quantity_shipped` / `quantity_returned` chỉ tăng khi phiếu xuất / phiếu trả về được duyệt. DB có `CHECK` chặn xuất quá SL đặt và trả quá SL đã xuất.
- Kiểm kê đổi tình trạng của cả ô (VD hàng mới bị phát hiện hỏng): ghi 2 dòng thẻ kho, trừ hết tình trạng cũ rồi cộng tình trạng mới.
- Phiếu nhập / trả về đã duyệt không sửa được. Phiếu bị từ chối thì sửa và gửi lại.
- `inventory_stocks` có `UNIQUE (location_id, variant_id)` và một cột `stock_status`. Trigger `trg_stock_status_guard` chặn đổi tình trạng khi ô còn hàng.
- Mọi thao tác ghi vào `audit_logs` (user, IP, giá trị cũ / mới dạng JSON). Mọi biến động tồn ghi vào `inventory_transactions`.

## Lưu ý khi đưa lên server thật

- Đổi `SESSION_SECRET` và mật khẩu các tài khoản mẫu.
- Session đang lưu trong bộ nhớ (khởi động lại server sẽ phải đăng nhập lại). Khi chạy nhiều tiến trình, hãy chuyển sang lưu session bằng MySQL hoặc Redis.
- Chạy sau HTTPS và bật `cookie.secure` trong `src/server.js`.
