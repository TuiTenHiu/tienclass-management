# TIENCLASS — QUY TRÌNH TRIỂN KHAI VÀ ĐỒNG BỘ SCHEMA CLOUD PREVIEW (SOP & RUNBOOK)

> **Cấp độ an toàn:** BẮT BUỘC PHÊ DUYỆT BỞI QUẢN TRỊ VIÊN (ADMIN-CONTROLLED)  
> **Phiên bản tài liệu:** v1.0-preview  
> **Nguyên tắc cốt lõi:** Không bao giờ ghi đè hoặc thực thi DDL lên Cloud khi chưa xác nhận danh tính môi trường và chưa có bản backup kiểm chứng.

---

## 1. ĐIỀU KIỆN TIÊN QUYẾT XÁC NHẬN CLOUD PREVIEW

Trước khi thực hiện bất kỳ lệnh DDL hay `supabase db push` nào, Quản trị viên (Admin) bắt buộc phải đối soát và ký duyệt các điều kiện sau:

1. **Xác nhận Project Reference:**
   - Giá trị `project-ref` trích xuất từ URL Cloud (ví dụ: qua Dashboard của Supabase: Settings $\rightarrow$ General $\rightarrow$ Reference ID) phải khớp chính xác với dự án Preview / Staging được tạo riêng cho đợt kiểm thử.
   - Tuyệt đối không thực thi trên dự án chứa dữ liệu học sinh thật (Production).
2. **Quyền hạn quản trị:**
   - Quản trị viên phải đăng nhập Supabase CLI qua Personal Access Token (`SUPABASE_ACCESS_TOKEN`) có quyền quản trị trên đúng project Preview.
3. **Môi trường mạng & Trạng thái dịch vụ:**
   - Dịch vụ PostgreSQL, PostgREST và Supabase Auth trên Cloud Preview ở trạng thái hoạt động bình thường (`HTTP 200 OK` trên `/auth/v1/settings`).

---

## 2. QUY TRÌNH KIỂM TRA VÀ TẠO BẢN SAO LƯU (BACKUP)

Tuyệt đối không áp dụng migration nếu chưa có snapshot sao lưu có thể phục hồi.

### Bước 2.1. Tạo bản sao lưu vật lý từ Supabase Dashboard hoặc CLI
Quản trị viên thực thi lệnh xuất bản sao lưu nhị phân có đầy đủ schema và dữ liệu hiện có:
```bash
# Thực hiện bởi Quản trị viên trên máy quản trị được bảo mật
supabase db dump --project-ref <CONFIRMED_PREVIEW_PROJECT_REF> -f backup_preview_pre_migration.dump --data-only=false
```
*Lưu ý: Không lưu tệp dump chứa dữ liệu thật vào workspace git hoặc commit lên repository.*

### Bước 2.2. Kiểm chứng khả năng phục hồi (TOC Verification)
Kiểm tra cấu trúc bản sao lưu để đảm bảo file dump không bị hỏng:
```bash
pg_restore -l backup_preview_pre_migration.dump | head -n 30
```
Xác nhận có đầy đủ các schema `public`, `auth`, `storage` và các bảng cốt lõi (`profiles`, `classes`, `students`).

---

## 3. DANH SÁCH MIGRATION DỰ KIẾN VÀ QUAN HỆ PHỤ THUỘC

Quá trình đồng bộ bao gồm 10 migration (từ 05 đến 14), phải được áp dụng tuần tự theo đúng thứ tự thời gian:

| Thứ tự | Tên Migration | Loại thay đổi | Phụ thuộc | Tác động dữ liệu |
| :---: | :--- | :--- | :--- | :--- |
| **05** | `20261028000005_unique_active_criteria.sql` | DDL (Partial Unique Index) | Bảng `criteria` | Ngăn trùng lặp tên tiêu chí thi đua đang kích hoạt |
| **06** | `20261028000006_legacy_import_sessions_and_ledger.sql` | DDL, RLS, Grants | Bảng `profiles` | Tạo bảng `legacy_import_sessions` & `legacy_import_records` |
| **07** | `20261028000007_legacy_import_session_rpcs.sql` | RPC (SECURITY DEFINER) | Migration 06 | Tạo RPC: `start_import_session`, `record_import_provenance_batch`, `commit_import_session` |
| **08** | `20261028000008_harden_rollback_and_ledger.sql` | RPC (SECURITY DEFINER) | Migration 07 | Tạo RPC `rollback_legacy_import_session_safe` với lease fencing |
| **09** | `20261028000009_rollback_comment_trigger_coordination.sql` | Trigger / RPC Update | Migration 08, `weekly_comments` | Điều phối trigger nhận xét khi hoàn tác |
| **10** | `20261028000010_provenance_atomicity_and_barrier_hardening.sql` | DDL Constraint, RPC | Migration 06, 07 | Thắt chặt ràng buộc nguồn gốc và rào cản nguyên tử hóa |
| **11** | `20261028000011_safe_updated_rollback_and_security.sql` | RPC, RLS Policy | Migration 06, 08 | RPC `reconcile_stale_import_sessions()`, thu hồi hoàn toàn direct write |
| **12** | `20261028000012_final_acceptance_hardening.sql` | RPC Idempotency | Migration 07, 08 | Bảo đảm tính bất biến khi retry và xử lý Lost ACK |
| **13** | `20261028000013_exhaustive_cas_coverage.sql` | RPC CAS Rollback | Migration 08, 12, `students` | Mở rộng CAS bao phủ toàn diện 7 trường học sinh |
| **14** | `20261028000014_backend_parent_rate_limiting.sql` | DDL, RLS, RPC | `parent_invitation_tokens` | Tạo bảng `parent_invitation_rate_limits`, row-lock và cooldown 60s |

---

## 4. QUY TRÌNH THỰC THI TRIỂN KHAI CÓ KIỂM SOÁT

### Bước 4.1. Kiểm tra tiền triển khai (Pre-Flight Checks)
1. Xác nhận branch hiện tại là `preview-cloud-v1` tại HEAD `2c145f1a4156bd4969b0a3b4375f0e325db8d04c`.
2. Kiểm tra danh sách migration chưa áp dụng trên Cloud bằng lệnh chỉ đọc:
   ```bash
   npx supabase migration list --project-ref <CONFIRMED_PREVIEW_PROJECT_REF>
   ```

### Bước 4.2. Thực thi áp dụng Migration tuần tự (Forward-Only)
Quản trị viên liên kết dự án và đẩy migration:
```bash
# 1. Liên kết dự án đã xác nhận
npx supabase link --project-ref <CONFIRMED_PREVIEW_PROJECT_REF>

# 2. Đẩy các migration còn thiếu
npx supabase db push
```

### Bước 4.3. Làm mới Schema Cache PostgREST
Sau khi áp dụng migration, yêu cầu PostgREST tải lại schema cache để mở các RPC và bảng mới:
```sql
-- Chạy qua Supabase SQL Editor bởi Admin
NOTIFY pgrst, 'reload schema';
```

---

## 5. BỘ TIÊU CHÍ KIỂM CHỨNG SAU TRIỂN KHAI (POST-DEPLOYMENT ACCEPTANCE)

Thực hiện kiểm tra trực tiếp trên Cloud Preview bằng dữ liệu tổng hợp:

1. **Kiểm tra Schema & Đối tượng Database:**
   - Bảng `legacy_import_sessions`, `legacy_import_records`, `parent_invitation_rate_limits` tồn tại và bật RLS.
   - Index `unique_active_criteria_per_class` hoạt động.
2. **Kiểm tra Phân quyền RLS:**
   - Role `anon` và `authenticated` bị từ chối INSERT/UPDATE/DELETE trực tiếp trên bảng `legacy_import_sessions` và `parent_invitation_rate_limits`.
   - Giáo viên A không xem được lớp của Giáo viên B.
   - Phụ huynh không xem được nhận xét trạng thái `draft` của học sinh.
3. **Kiểm tra RPC:**
   - Gọi thử RPC `claim_parent_invitation`: 5 lần sai kích hoạt khóa 60 giây (`RATE_LIMITED`).
   - Gọi thử RPC `start_import_session`: Kiểm tra cấp phát `lease_token`.
4. **Kiểm tra Frontend Preview:**
   - Đăng nhập giáo viên: `TeacherAreaGuard` xác thực thành công, mở màn hình Dashboard.
   - Cổng phụ huynh (`/parent/portal`): Mở độc lập, không kích hoạt cơ sở dữ liệu giáo viên.

---

## 6. CƠ CHẾ DỪNG KHẨN CẤP (CIRCUIT BREAKER) VÀ KẾ HOẠCH PHỤC HỒI

### 6.1. Dấu hiệu kích hoạt dừng khẩn cấp
Dừng ngay lập tức toàn bộ quá trình nếu phát hiện bất kỳ dấu hiệu nào sau đây:
- Xuất hiện dữ liệu học sinh thật hoặc tên lớp thực tế trên Cloud DB.
- Lệnh DDL trả về lỗi xung đột khóa ngoại hoặc lỗi cú pháp.
- PostgREST trả về lỗi `500 Internal Server Error` kéo dài quá 1 phút.
- Phát hiện thao tác nhầm trên dự án Production.

### 6.2. Kế hoạch Phục hồi (Recovery Strategy)
> [!WARNING]
> Không bao giờ giả định mọi migration đều có thể rollback bằng cách drop bảng ngược lại, vì thao tác drop có thể làm mất dữ liệu liên kết hoặc cascade vào bảng cốt lõi.

**Quy trình phục hồi chuẩn:**
1. Chuyển ứng dụng về trang bảo trì tạm thời (`Maintenance Mode`).
2. Khôi phục lại trạng thái database trước khi chạy migration bằng bản backup vật lý đã tạo ở Mục 2:
   ```bash
   # Thực hiện bởi Quản trị viên
   supabase db reset --project-ref <CONFIRMED_PREVIEW_PROJECT_REF>
   # Hoặc khôi phục file dump vào dự án Preview
   pg_restore -d <DATABASE_CONNECTION_STRING> --clean --if-exists backup_preview_pre_migration.dump
   ```
3. Kiểm tra lại tính toàn vẹn dữ liệu và mở lại quyền truy cập cho người dùng.
