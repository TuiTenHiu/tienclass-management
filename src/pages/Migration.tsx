import { useEffect, useState } from 'react';
import {
  DatabaseBackup,
  Download,
  FileCheck2,
  Eye,
  ShieldCheck,
  AlertTriangle,
  CloudUpload,
  CheckCircle2,
  RefreshCw,
  FileText,
  Upload,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import { useToast } from '../components/ToastNotification';
import { useAuth } from '../state/AuthContext';
import {
  buildMigrationPreview,
  createMigrationBackup,
  executeMigration,
  getLastMigrationReport,
  restoreIndexedDbFromBackup,
  validateMigrationBackup,
  verifyBackupRoundTrip,
  type BackupValidationResult,
  type MigrationBackup,
  type MigrationGroup,
  type MigrationPreview,
  type MigrationProgress,
  type MigrationReport,
} from '../data/migration';

const GROUP_LABELS: Record<MigrationGroup, string> = {
  classes: 'Lớp học',
  criteria: 'Tiêu chí',
  students: 'Học sinh',
  memberships: 'Liên kết lớp (class_memberships)',
  attendance: 'Điểm danh',
  transactions: 'Giao dịch điểm thi đua',
  comments: 'Nhận xét tuần',
  parentLinks: 'Mã mời / liên kết phụ huynh',
};

export default function MigrationPage() {
  const toast = useToast();
  const { user, profile } = useAuth();
  const [backup, setBackup] = useState<MigrationBackup | null>(null);
  const [backupCheck, setBackupCheck] = useState<BackupValidationResult | null>(null);
  const [fileCheck, setFileCheck] = useState<BackupValidationResult | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLastMigrationReport()
      .then((rep) => {
        if (rep) setReport(rep);
      })
      .catch(() => {});
  }, []);

  const handleCreateBackup = async () => {
    setBusy(true);
    try {
      const b = await createMigrationBackup();
      const check = await verifyBackupRoundTrip(b);
      setBackup(b);
      setBackupCheck(check);
      if (!check.ok) {
        toast.error('Bản sao lưu không vượt qua kiểm tra đọc lại.');
        return;
      }
      const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PinkClassroom_MigrationBackup_${b.exportedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Đã tạo, kiểm tra và tải xuống bản sao lưu (dữ liệu không rời khỏi máy).');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể tạo bản sao lưu');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      setFileCheck(await validateMigrationBackup(json));
    } catch {
      setFileCheck({ ok: false, errors: ['File không phải JSON hợp lệ'], counts: {} });
    }
  };

  const handleRestoreFromFile = async (file: File | undefined) => {
    if (!file) return;
    if (
      !window.confirm(
        'CẢNH BÁO PHỤC HỒI DỮ LIỆU (KẾ HOẠCH B):\nThao tác này sẽ khôi phục dữ liệu IndexedDB từ bản sao lưu. Các bảng sẽ được đồng bộ chính xác về trạng thái lúc sao lưu.\n\nBạn có chắc chắn muốn thực hiện?'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const json = JSON.parse(await file.text());
      const res = await restoreIndexedDbFromBackup(json);
      if (res.ok) {
        toast.success(res.message);
        setPreview(null);
      } else {
        toast.error(res.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể đọc hoặc khôi phục file sao lưu.');
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    setBusy(true);
    try {
      setPreview(await buildMigrationPreview());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể tạo bản xem trước');
    } finally {
      setBusy(false);
    }
  };

  const handleExecuteMigration = async () => {
    if (!backup) {
      toast.error('Vui lòng tạo bản sao lưu hợp lệ trước khi bắt đầu di trú.');
      return;
    }
    if (!user || !profile || (profile.role !== 'teacher' && profile.role !== 'admin')) {
      toast.error('Chỉ tài khoản giáo viên hoặc quản trị viên mới được phép di trú dữ liệu.');
      return;
    }

    setBusy(true);
    setProgress(null);
    try {
      const rep = await executeMigration(backup, {
        onProgress: (p) => setProgress(p),
      });
      setReport(rep);
      if (rep.success) {
        toast.success('Di trú dữ liệu Offline lên Supabase thành công và đã đối soát khớp 100%!');
      } else {
        toast.info(`Di trú hoàn tất nhưng có ${rep.conflicts.length} xung đột cần lưu ý.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Lỗi trong quá trình di trú');
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PinkClassroom_MigrationReport_${report.migrationId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isTeacherOrAdmin = Boolean(user && profile && (profile.role === 'teacher' || profile.role === 'admin'));
  const canStartMigration = Boolean(backup && backupCheck?.ok && preview && isTeacherOrAdmin && !busy);

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title="Di trú dữ liệu Offline lên Supabase"
        description="Sao lưu, kiểm tra khả năng khôi phục, xem trước và di trú có kiểm soát lên Supabase Local kèm đối soát (Giai đoạn A–D)."
      />

      <div className="card p-4 flex items-start gap-3 border border-pink-200 bg-pink-50/50 text-sm">
        <ShieldCheck className="w-5 h-5 text-pink-600 shrink-0 mt-0.5" />
        <div className="text-ink-soft space-y-1">
          <p>• Dữ liệu Offline trong IndexedDB được bảo toàn 100%, không bị sửa hay xóa.</p>
          <p>• ID mapping được lưu ổn định trong IndexedDB (`db.kv`), hỗ trợ chạy lại an toàn nhiều lần (idempotent).</p>
          <p>• Nhận xét đã gửi (`weekly_comments`): chỉ INSERT khi chưa tồn tại; tuyệt đối không UPDATE/DELETE.</p>
          <p>• Mọi xung đột dữ liệu sẽ được ghi nhận vào danh sách chờ xử lý, không bao giờ tự ý ghi đè.</p>
          <p>
            • Tài khoản hiện tại:{' '}
            {user && profile ? (
              <span className="font-semibold text-ink">
                {profile.fullName} ({profile.role})
              </span>
            ) : (
              <span className="text-danger font-semibold">Chưa đăng nhập Supabase (vui lòng đăng nhập ở góc trên)</span>
            )}
          </p>
        </div>
      </div>

      {/* Bước 1: sao lưu */}
      <section className="card p-5 space-y-3">
        <h3 className="font-display font-bold text-base flex items-center gap-2">
          <DatabaseBackup className="w-5 h-5 text-pink-500" /> Bước 1 — Sao lưu & kiểm tra đọc lại
        </h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary btn-sm" onClick={handleCreateBackup} disabled={busy}>
            <Download className="w-4 h-4" /> Tạo & tải bản sao lưu
          </button>
          <label className="btn-outline btn-sm cursor-pointer">
            <FileCheck2 className="w-4 h-4" /> Kiểm tra file sao lưu đã có
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                void handleVerifyFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          <label className="btn-outline btn-sm cursor-pointer text-amber-700 border-amber-300 hover:bg-amber-50">
            <Upload className="w-4 h-4 text-amber-600" /> Khôi phục IndexedDB từ bản sao lưu
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                void handleRestoreFromFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {backup && backupCheck && (
          <div className={`rounded-xl p-3 text-sm border ${backupCheck.ok ? 'bg-mint/30 border-mint' : 'bg-red-50 border-red-200'}`}>
            <p className="font-semibold">
              {backupCheck.ok ? 'Bản sao lưu hợp lệ và đọc lại thành công' : 'Bản sao lưu KHÔNG hợp lệ'} · schema v{backup.schemaVersion} ·{' '}
              {new Date(backup.exportedAt).toLocaleString('vi-VN')}
            </p>
            <p className="text-xs text-ink-soft mt-1 break-all">Checksum SHA-256: {backup.checksum}</p>
            <p className="text-xs text-ink-soft mt-1">
              Bảng: {backup.tables.map((t) => `${t} (${backup.counts[t]})`).join(' · ')}
            </p>
            <p className="text-xs text-ink-soft mt-1">Đã loại khỏi file: {backup.redactions.join('; ')}</p>
            {backupCheck.errors.map((er) => (
              <p key={er} className="text-xs text-danger">{er}</p>
            ))}
          </div>
        )}
        {fileCheck && (
          <div className={`rounded-xl p-3 text-sm border ${fileCheck.ok ? 'bg-mint/30 border-mint' : 'bg-red-50 border-red-200'}`}>
            <p className="font-semibold">{fileCheck.ok ? 'File đã chọn hợp lệ, có thể đọc lại' : 'File đã chọn không hợp lệ'}</p>
            {fileCheck.errors.map((er) => (
              <p key={er} className="text-xs text-danger">{er}</p>
            ))}
          </div>
        )}
      </section>

      {/* Bước 2: xem trước */}
      <section className="card p-5 space-y-3">
        <h3 className="font-display font-bold text-base flex items-center gap-2">
          <Eye className="w-5 h-5 text-pink-500" /> Bước 2 — Xem trước (không ghi Cloud)
        </h3>
        <button className="btn-secondary btn-sm" onClick={handlePreview} disabled={busy}>
          Phân tích dữ liệu Offline
        </button>

        {preview && (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="table-base min-w-[640px]">
                <thead>
                  <tr>
                    <th>Nhóm dữ liệu</th>
                    <th className="text-right">Nguồn</th>
                    <th className="text-right">Sẽ tạo mới</th>
                    <th className="text-right">Bỏ qua</th>
                    <th className="text-right">Cần xử lý</th>
                    <th className="text-right">Không đủ điều kiện</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(GROUP_LABELS) as MigrationGroup[]).map((g) => {
                    const s = preview.groups[g];
                    return (
                      <tr key={g}>
                        <td>{GROUP_LABELS[g]}</td>
                        <td className="text-right">{s.source}</td>
                        <td className="text-right text-mint-dark font-semibold">{s.create}</td>
                        <td className="text-right">{s.skip}</td>
                        <td className="text-right text-cream-dark font-semibold">{s.needsUser}</td>
                        <td className="text-right text-danger font-semibold">{s.ineligible}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {Object.keys(preview.idsNeedingNewUuid).length > 0 && (
              <p className="text-xs text-ink-soft">
                ID cục bộ cần UUID mới (ánh xạ ổn định ở Giai đoạn C):{' '}
                {Object.entries(preview.idsNeedingNewUuid)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
              </p>
            )}

            {preview.items.length > 0 && (
              <div className="space-y-1">
                <h4 className="font-semibold text-sm flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-cream-dark" /> Bản ghi cần chú ý ({preview.items.length})
                </h4>
                <div className="max-h-64 overflow-y-auto scroll-soft border border-pink-100 rounded-xl">
                  <table className="table-base text-xs">
                    <tbody>
                      {preview.items.slice(0, 200).map((it, i) => (
                        <tr key={`${it.group}-${it.id}-${i}`}>
                          <td>{GROUP_LABELS[it.group]}</td>
                          <td className="font-mono">{it.id.slice(0, 18)}</td>
                          <td>{it.category === 'needsUser' ? 'Cần xử lý' : it.category === 'skip' ? 'Bỏ qua' : 'Không đủ ĐK'}</td>
                          <td>{it.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="text-xs text-ink-soft space-y-1">
              <p className="font-semibold">Không di trú (chỉ tồn tại ở máy):</p>
              {preview.localOnlyTables.map((t) => (
                <p key={t.table}>
                  • {t.table} ({t.count}): {t.reason}
                </p>
              ))}
              <p className="font-semibold pt-1">Trường không có cột tương ứng trên Supabase:</p>
              {preview.unmappedFields.map((f) => (
                <p key={f}>• {f}</p>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Bước 3: Di trú */}
      <section className="card p-5 space-y-3">
        <h3 className="font-display font-bold text-base flex items-center gap-2">
          <CloudUpload className="w-5 h-5 text-pink-500" /> Bước 3 — Di trú có kiểm soát lên Supabase Local
        </h3>
        <p className="text-sm text-ink-soft">
          Đồng bộ các lớp, tiêu chí, học sinh, điểm danh, điểm thi đua và nhận xét tuần sang Supabase theo thứ tự phụ thuộc.
          Bảo toàn 100% dữ liệu Offline và tự động kiểm tra đối soát.
        </p>

        {!isTeacherOrAdmin && (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
            Cần đăng nhập tài khoản Giáo viên hoặc Admin để kích hoạt chức năng di trú.
          </div>
        )}

        <button
          className="btn-primary btn-sm flex items-center gap-2"
          onClick={handleExecuteMigration}
          disabled={!canStartMigration}
        >
          {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
          {busy ? 'Đang di trú dữ liệu...' : 'Bắt đầu di trú lên Supabase Local'}
        </button>

        {progress && (
          <div className="space-y-2 p-3 bg-pink-50/50 rounded-xl border border-pink-100 text-xs">
            <div className="flex justify-between items-center text-ink-soft">
              <span className="font-medium text-ink">{progress.message}</span>
              <span className="font-mono">{progress.percent}%</span>
            </div>
            <div className="w-full bg-pink-200/50 h-2 rounded-full overflow-hidden">
              <div
                className="bg-pink-500 h-full transition-all duration-300 rounded-full"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Bước 4: Báo cáo Đối soát Hậu Di Trú (Giai đoạn D) */}
      {report && (
        <section
          className={`card p-5 space-y-4 border ${
            report.success
              ? 'border-mint/50 bg-mint/5'
              : 'border-amber-300 bg-amber-50/40'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-pink-100 pb-3">
            <div>
              <h3
                className={`font-display font-bold text-base flex items-center gap-2 ${
                  report.success ? 'text-mint-dark' : 'text-amber-800'
                }`}
              >
                {report.success ? (
                  <CheckCircle2 className="w-5 h-5 text-mint" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                )}
                Báo cáo Đối soát Hậu Di Trú (Giai đoạn D)
              </h3>
              <p className="text-xs text-ink-soft mt-0.5">
                Mã di trú: <span className="font-mono">{report.migrationId.slice(0, 8)}</span> · Người thực hiện:{' '}
                {report.actorName} ({report.actorRole}) · Thời gian:{' '}
                {new Date(report.completedAt).toLocaleString('vi-VN')}
              </p>
            </div>
            <button className="btn-outline btn-sm" onClick={handleDownloadReport}>
              <FileText className="w-4 h-4" /> Tải Báo cáo JSON
            </button>
          </div>

          <div
            className={`p-3 rounded-xl border text-xs text-ink ${
              report.success
                ? 'bg-mint/20 border-mint/40 text-mint-dark'
                : 'bg-amber-100/70 border-amber-300 text-amber-900'
            }`}
          >
            <p className="font-semibold">{report.summaryMessage}</p>
          </div>

          {/* Bảng kết quả từng nhóm */}
          <div className="overflow-x-auto">
            <table className="table-base min-w-[640px] text-xs">
              <thead>
                <tr>
                  <th>Nhóm dữ liệu</th>
                  <th className="text-right">Nguồn</th>
                  <th className="text-right">Đã tạo mới</th>
                  <th className="text-right">Bỏ qua (đã có)</th>
                  <th className="text-right">Xung đột chờ xử lý</th>
                  <th className="text-right">Thất bại</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(GROUP_LABELS) as MigrationGroup[]).map((g) => {
                  const s = report.groups[g];
                  return (
                    <tr key={g}>
                      <td className="font-medium">{GROUP_LABELS[g]}</td>
                      <td className="text-right font-mono">{s.source}</td>
                      <td className="text-right font-mono text-mint-dark font-semibold">{s.created}</td>
                      <td className="text-right font-mono text-ink-soft">{s.skipped}</td>
                      <td className="text-right font-mono text-cream-dark font-semibold">{s.conflicts}</td>
                      <td className="text-right font-mono text-danger font-semibold">{s.failed}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Khối kiểm tra bảo toàn & đối soát */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Bảo toàn IndexedDB */}
            <div className="p-3 bg-white rounded-xl border border-pink-100 space-y-1 text-xs">
              <span className="font-semibold text-ink flex items-center gap-1.5">
                <CheckCircle2 className={`w-4 h-4 ${report.localPreservation.ok ? 'text-mint' : 'text-danger'}`} /> Bảo toàn IndexedDB
              </span>
              <p className={`font-bold ${report.localPreservation.ok ? 'text-mint-dark' : 'text-danger'}`}>
                {report.localPreservation.ok ? 'Nguyên vẹn (Băm SHA-256 khớp)' : 'Bị thay đổi ngoài dự kiến'}
              </p>
              <p className="text-ink-soft">
                {report.localPreservation.ok
                  ? 'Toàn bộ ID và nội dung các bảng nghiệp vụ gốc không bị sửa đổi hay xóa.'
                  : 'Cảnh báo: Phát hiện sai lệch dữ liệu IndexedDB gốc sau khi di trú!'}
              </p>
            </div>

            {/* Đối soát Điểm thi đua */}
            <div className="p-3 bg-white rounded-xl border border-pink-100 space-y-1 text-xs">
              <span className="font-semibold text-ink flex items-center gap-1.5">
                <CheckCircle2 className={`w-4 h-4 ${report.pointsReconciliation.matched ? 'text-mint' : 'text-danger'}`} /> Đối soát Điểm thi đua
              </span>
              <p className={`font-bold ${report.pointsReconciliation.matched ? 'text-mint-dark' : 'text-danger'}`}>
                {report.pointsReconciliation.matched ? 'Khớp tuyệt đối (Chênh lệch: 0)' : `Lệch: ${report.pointsReconciliation.difference}đ`}
              </p>
              <p className="text-ink-soft">
                Nguồn: {report.pointsReconciliation.localSumDelta}đ ({report.pointsReconciliation.localValidTxCount} gd) · Cloud:{' '}
                {report.pointsReconciliation.cloudSumDelta}đ ({report.pointsReconciliation.cloudTxCount} gd)
              </p>
            </div>

            {/* Toàn vẹn Khóa ngoại */}
            <div className="p-3 bg-white rounded-xl border border-pink-100 space-y-1 text-xs">
              <span className="font-semibold text-ink flex items-center gap-1.5">
                <CheckCircle2 className={`w-4 h-4 ${report.fkIntegrity.ok ? 'text-mint' : 'text-danger'}`} /> Toàn vẹn Khóa ngoại Cloud
              </span>
              <p className={`font-bold ${report.fkIntegrity.ok ? 'text-mint-dark' : 'text-danger'}`}>
                {report.fkIntegrity.ok ? 'Hợp lệ (0 mồ côi)' : 'Phát hiện bản ghi mồ côi'}
              </p>
              <p className="text-ink-soft">
                {report.fkIntegrity.ok
                  ? 'Mọi quan hệ (criteria, memberships, attendance, points, comments) đều gắn đúng UUID lớp & học sinh.'
                  : `Mồ côi: tiêu chí ${report.fkIntegrity.criteriaOrphans}, liên kết ${report.fkIntegrity.membershipsOrphans}, điểm danh ${report.fkIntegrity.attendanceOrphans}, điểm ${report.fkIntegrity.pointsOrphans}, nhận xét ${report.fkIntegrity.commentsOrphans}`}
              </p>
            </div>
          </div>

          {/* Danh sách xung đột nếu có */}
          {report.conflicts.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-semibold text-sm flex items-center gap-1.5 text-cream-dark">
                <AlertTriangle className="w-4 h-4 text-cream-dark" /> Danh sách xung đột đã bảo vệ ({report.conflicts.length})
              </h4>
              <div className="max-h-60 overflow-y-auto scroll-soft border border-pink-100 rounded-xl bg-white">
                <table className="table-base text-xs">
                  <thead>
                    <tr>
                      <th>Nhóm</th>
                      <th>Mã lỗi</th>
                      <th>Chi tiết bảo vệ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.conflicts.map((c, idx) => (
                      <tr key={`${c.group}-${c.id}-${idx}`}>
                        <td className="font-semibold">{GROUP_LABELS[c.group]}</td>
                        <td className="font-mono text-cream-dark">{c.code}</td>
                        <td>{c.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
