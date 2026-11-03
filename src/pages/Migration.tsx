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
  RotateCcw,
  History,
  ShieldAlert,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import { useToast } from '../components/ToastNotification';
import { useAuth } from '../state/AuthContext';
import {
  buildMigrationPreview,
  createMigrationBackup,
  getLastMigrationReport,
  validateMigrationBackup,
  verifyBackupRoundTrip,
  getActiveImportSession,
  resumeImportSession,
  rollbackImportSession,
  reconcileStaleImportSessions,
  type ImportSessionState,
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
  const [activeSession, setActiveSession] = useState<ImportSessionState | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  const loadActiveSession = async () => {
    setSessionLoading(true);
    try {
      const sess = await getActiveImportSession();
      setActiveSession(sess);
    } catch {
      setActiveSession(null);
    } finally {
      setSessionLoading(false);
    }
  };

  useEffect(() => {
    getLastMigrationReport()
      .then((rep) => {
        if (rep) setReport(rep);
      })
      .catch(() => {});
    loadActiveSession();
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

  const handleRestoreFromFile = async (_file: File | undefined) => {
    toast.error('Chức năng phục hồi legacy database tạm thời bị khóa ở Bước 2.2 để bảo vệ toàn vẹn dữ liệu.');
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
    setProgress(null);
    toast.error('Chức năng di trú dữ liệu legacy lên Cloud tạm thời bị khóa ở Bước 2.2 để bảo vệ dữ liệu legacy.');
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

  const handleResumeSession = async () => {
    if (!activeSession) return;
    if (!backup?.checksum) {
      toast.error('Vui lòng tạo hoặc kiểm tra file sao lưu để xác minh checksum trước khi phục hồi phiên.');
      return;
    }
    setSessionLoading(true);
    try {
      const res = await resumeImportSession(activeSession.id, backup.checksum);
      if (res.ok) {
        toast.success(`Đã phục hồi phiên di trú thành công (lock v${res.lock_version ?? 1})`);
        await loadActiveSession();
      } else {
        toast.error(res.error || 'Không thể phục hồi phiên');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Lỗi phục hồi phiên');
    } finally {
      setSessionLoading(false);
    }
  };

  const handleRollbackSession = async () => {
    if (!activeSession) return;
    const confirmed = window.confirm(
      'CẢNH BÁO AN TOÀN: Thao tác này sẽ hoàn tác dữ liệu đã nhập của phiên này theo thứ tự LIFO và bảo vệ dữ liệu đã tồn tại trước đó. Bạn có chắc chắn muốn thực hiện?',
    );
    if (!confirmed) return;

    setSessionLoading(true);
    try {
      const res = await rollbackImportSession(activeSession.id, activeSession.leaseToken);
      if (res.ok) {
        toast.success('Đã hoàn tác phiên di trú an toàn.');
        await loadActiveSession();
      } else {
        if (res.status === 'requires_manual_review') {
          toast.error(`Rào cản an toàn kích hoạt: ${res.reason || 'Dữ liệu cần rà soát thủ công'}. Chuyển sang requires_manual_review.`);
        } else {
          toast.error(res.error || res.message || 'Không thể rollback phiên');
        }
        await loadActiveSession();
      }
    } catch (err: any) {
      toast.error(err?.message || 'Lỗi hoàn tác phiên');
    } finally {
      setSessionLoading(false);
    }
  };

  const handleReconcileStale = async () => {
    setSessionLoading(true);
    try {
      const res = await reconcileStaleImportSessions();
      if (res.ok) {
        toast.success(`Đã quét đối soát: cập nhật ${res.updated_count ?? 0} phiên hết hạn`);
        await loadActiveSession();
      } else {
        toast.error(res.error || 'Lỗi quét đối soát phiên hết hạn');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Lỗi quét đối soát phiên hết hạn');
    } finally {
      setSessionLoading(false);
    }
  };

  const isTeacherOrAdmin = Boolean(user && profile && (profile.role === 'teacher' || profile.role === 'admin'));
  const canStartMigration = Boolean(backup && backupCheck?.ok && preview && isTeacherOrAdmin && !busy);

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title="Di trú dữ liệu Offline lên Supabase"
        description="Sao lưu, kiểm tra khả năng khôi phục, xem trước và di trú có kiểm soát lên Supabase Local kèm đối soát (Giai đoạn A–D)."
      />

      <div className="card p-4 flex items-start gap-3 border border-amber-300 bg-amber-50 text-sm text-amber-900 rounded-2xl">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-bold">BẢO VỆ DỮ LIỆU BƯỚC 2.2 — TẠM DỪNG DI TRÚ TỪ DATABASE LEGACY</p>
          <p>
            Hệ thống đang hoạt động với kiến trúc cơ sở dữ liệu riêng biệt theo từng tài khoản. Toàn bộ database legacy <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-xs font-bold">pink-classroom</code> được bảo toàn nguyên trạng và tạm thời khóa thao tác ghi/di trú từ giao diện để ngăn ngừa rủi ro trộn lẫn dữ liệu giữa các tài khoản.
          </p>
          <p className="text-xs text-amber-700">Quy trình nhập dữ liệu legacy có kiểm soát sẽ được kích hoạt tại Bước 2.3.</p>
        </div>
      </div>

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

      {/* Giai đoạn 2.6: Quản lý Phiên Di Trú & Rollback An Toàn */}
      <section className="card p-5 space-y-4 border border-pink-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-pink-100 pb-3">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-pink-600" />
            <h3 className="font-display font-bold text-base text-ink">
              Quản lý Phiên Di Trú & Rollback An Toàn (Giai đoạn 2.6)
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-outline btn-sm"
              onClick={handleReconcileStale}
              disabled={sessionLoading}
              title="Quét và đánh dấu failed cho các phiên hết hạn lease"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${sessionLoading ? 'animate-spin' : ''}`} /> Quét phiên hết hạn
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={loadActiveSession}
              disabled={sessionLoading}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${sessionLoading ? 'animate-spin' : ''}`} /> Tải lại
            </button>
          </div>
        </div>

        {activeSession ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 bg-pink-50/50 rounded-xl border border-pink-100">
                <span className="text-ink-soft">Mã phiên (Session ID):</span>
                <p className="font-mono font-bold text-ink mt-0.5 truncate">{activeSession.id}</p>
              </div>
              <div className="p-3 bg-pink-50/50 rounded-xl border border-pink-100">
                <span className="text-ink-soft">Trạng thái (Status):</span>
                <p className="mt-0.5">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                      activeSession.status === 'committed'
                        ? 'bg-mint/30 text-mint-dark'
                        : activeSession.status === 'in_progress'
                        ? 'bg-blue-100 text-blue-800'
                        : activeSession.status === 'rolled_back'
                        ? 'bg-purple-100 text-purple-800'
                        : activeSession.status === 'requires_manual_review'
                        ? 'bg-amber-100 text-amber-900 border border-amber-300'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {activeSession.status.toUpperCase()}
                  </span>
                </p>
              </div>
              <div className="p-3 bg-pink-50/50 rounded-xl border border-pink-100">
                <span className="text-ink-soft">Lock Version / Lease:</span>
                <p className="font-mono font-semibold text-ink mt-0.5">
                  v{activeSession.lockVersion} · {new Date(activeSession.leaseExpiresAt).toLocaleTimeString('vi-VN')}
                </p>
              </div>
              <div className="p-3 bg-pink-50/50 rounded-xl border border-pink-100">
                <span className="text-ink-soft">Bản sao lưu Checksum:</span>
                <p className="font-mono text-ink mt-0.5 truncate" title={activeSession.backupChecksum}>
                  {activeSession.backupChecksum.slice(0, 16)}...
                </p>
              </div>
            </div>

            {activeSession.status === 'requires_manual_review' && (
              <div className="card p-3.5 flex items-start gap-3 border border-amber-300 bg-amber-50 text-xs text-amber-900 rounded-xl">
                <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-sm text-amber-950">YÊU CẦU ĐỐI SOÁT THỦ CÔNG (REQUIRES MANUAL REVIEW)</p>
                  <p>
                    Rào cản an toàn Cloud kích hoạt: {activeSession.lastErrorMessage || 'Phát hiện dữ liệu phụ thuộc hoặc liên kết phụ huynh ngoài phiên.'}
                  </p>
                  <p className="text-amber-700">
                    Giai đoạn rà soát ({activeSession.lastErrorStage || 'barrier'}): Rollback tự động bị từ chối để tránh xóa nhầm dữ liệu liên đới.
                  </p>
                </div>
              </div>
            )}

            {activeSession.status === 'rolled_back' && (
              <div className="card p-3 flex items-center gap-2 border border-purple-200 bg-purple-50 text-xs text-purple-900 rounded-xl">
                <CheckCircle2 className="w-4 h-4 text-purple-600 shrink-0" />
                <span>Phiên đã hoàn tất rollback an toàn. Toàn bộ dữ liệu được hoàn tác có kiểm chứng, bảo vệ 100% bản ghi liên kết có sẵn.</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {(activeSession.status === 'in_progress' || activeSession.status === 'failed') && (
                <>
                  <button
                    className="btn-outline btn-sm text-blue-700 border-blue-300 hover:bg-blue-50"
                    onClick={handleResumeSession}
                    disabled={sessionLoading}
                  >
                    <RefreshCw className="w-4 h-4" /> Tiếp tục phiên (Resume)
                  </button>
                  <button
                    className="btn-outline btn-sm text-danger border-red-300 hover:bg-red-50"
                    onClick={handleRollbackSession}
                    disabled={sessionLoading}
                  >
                    <RotateCcw className="w-4 h-4 text-danger" /> Hoàn tác an toàn (Rollback LIFO)
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-soft">
            Chưa có phiên di trú nào được ghi nhận cho tài khoản của bạn trên Cloud ledger.
          </p>
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
