# Pink Classroom – Hệ Thống Quản Lý Lớp Học Hạnh Phúc 🌸

> **Thông điệp:** Lớp học hạnh phúc – Mỗi ngày một niềm vui.

Ứng dụng web dành riêng cho giáo viên tiểu học, quản lý lớp học, hồ sơ học sinh, điểm danh, thi đua tích cực và minigame tương tác sân trường.

---

## 🎨 Điểm nổi bật & Thiết kế

- **Bảng màu hồng pastel ấm áp**: Hồng phấn (#FFF6FA), Hồng pastel (#F7A8C4), Hồng đậm cho nút (#E879A9), kết hợp tím lavender, vàng kem, xanh mint nhẹ nhàng.
- **Font chữ thuần Việt**: Hỗ trợ đầy đủ tiếng Việt với bộ đôi `Nunito` (tiêu đề bo tròn dễ thương) và `Be Vietnam Pro` (nội dung rõ ràng, chuẩn mực).
- **Bộ Avatar SVG độc quyền**: 8 nhân vật hoạt hình dễ thương tự vẽ bằng SVG vector thuần (Mèo, Thỏ, Gấu, Capybara, Panda, Gà con, Cáo, Ếch) trên 5 nền pastel khác nhau.
- **Bộ nhớ lưu trữ IndexedDB (Dexie.js)**: Lưu trữ an toàn, hoạt động mượt mà offline trên máy tính/máy chiếu giáo viên, tự động phân tách theo từng lớp.
- **Bảo mật**: Hỗ trợ thiết lập mã PIN bảo vệ ứng dụng (mã hóa SHA-256 kèm salt), tính năng sao lưu và khôi phục toàn vẹn dữ liệu JSON.

---

## 🚀 Các chức năng chính

1. **Tổng quan (Dashboard)**: Lời chào thân thiện theo thời gian, thẻ thống kê số lượng học sinh, tình hình có mặt/vắng hôm nay, biểu đồ chuyên cần 7 ngày, Top ngôi sao thi đua tháng, danh sách việc cần làm.
2. **Quản lý lớp học (Classes)**: Tạo lớp, chỉnh sửa, chọn năm học, chuyển đổi giữa các lớp độc lập dữ liệu.
3. **Quản lý học sinh (Students)**:
   - Xem dạng thẻ lưới avatar hoặc bảng danh sách chi tiết.
   - Tìm kiếm không phân biệt dấu tiếng Việt.
   - Nhập danh sách từ Excel (.xlsx, .xls, .csv) với tính năng kiểm tra lỗi từng dòng, phát hiện trùng lặp, tải file mẫu.
   - Xuất danh sách học sinh ra file Excel chuẩn.
   - Chuyển lớp, lưu trữ mềm và khôi phục học sinh.
4. **Điểm danh (Attendance)**:
   - Điểm danh theo ngày và buổi học (Sáng / Chiều).
   - Nút thao tác nhanh "Cả lớp có mặt".
   - 4 trạng thái chuẩn: *Có mặt*, *Đi muộn*, *Có phép*, *Không phép*.
   - Khóa bản ghi theo ngày & buổi học, ngăn chặn phát sinh bản ghi trùng khi lưu nhiều lần.
5. **Điểm thưởng & Thi đua (Points)**:
   - Mô hình lớp học tích cực: sao hồng, huy hiệu pastel.
   - Chấm điểm cho 1 bạn, nhiều bạn hoặc cả lớp.
   - Tiêu chí cộng/trừ điểm tùy chỉnh linh hoạt.
   - Lịch sử chấm điểm chi tiết kèm nút **Hoàn tác (Undo)** tức thì nếu lỡ tay chọn nhầm.
6. **Nhận xét học sinh (Comments)**:
   - Ghi nhận xét theo ngày, đính kèm gợi ý lời khen/nhắc nhở thân thiện giúp giáo viên thao tác nhanh.
   - Xem lịch sử nhận xét theo từng học sinh.
7. **Trò chơi lớp học (Dog Chase Minigame)**:
   - Minigame canvas 2D "Chú chó tinh nghịch": bối cảnh sân trường, cổng trường, cây xanh và học sinh đi dạo.
   - Chú chó thức dậy đuổi theo ngẫu nhiên 1 học sinh theo thuật toán công bằng (Cryptographic Random).
   - Chế độ không lặp lại học sinh đã gọi, hiệu ứng âm thanh Web Audio sinh động.
8. **Báo cáo & Thống kê (Reports)**:
   - Biểu đồ tròn chuyên cần và biểu đồ cột thi đua (Recharts).
   - Lọc theo Tuần, Tháng, Học kỳ 1, Học kỳ 2, Cả năm học.
   - In ấn thân thiện (Print CSS) và Xuất báo cáo Excel.
9. **Cài đặt & Dữ liệu mẫu (Settings)**:
   - Đổi danh xưng giáo viên (Cô / Thầy).
   - Nạp dữ liệu mẫu **Lớp 3A1** chỉ với 1 click để trải nghiệm thử.
   - Tải file sao lưu (.json) và khôi phục khi cần chuyển máy.

---

## 🛠 Hướng dẫn cài đặt & Khởi chạy

### Yêu cầu môi trường
- **Node.js**: >= 18.0.0
- **npm** hoặc **yarn** / **pnpm**

### Khởi chạy dự án
```bash
# 1. Cài đặt thư viện phụ thuộc (nếu chưa có)
npm install

# 2. Khởi chạy máy chủ phát triển
npm run dev
```

Mở trình duyệt truy cập: `http://localhost:5173`

### Kiểm thử & Build dự án
```bash
# Chạy Unit Tests
npm test

# Build mã nguồn cho môi trường Production
npm run build
```
