import { useRef, useState } from 'react';
import { FileSpreadsheet, Download, Upload, AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/ToastNotification';
import { AnimalAvatarSVG } from '../../components/avatars';
import { LEGACY_DB_NAME, type PinkDB } from '../../data/db';
import { bulkAddStudents } from '../../data/repo';
import { downloadTemplate, parseStudentFile, type ImportResult, REQUIRED_HEADERS } from '../../lib/excel';
import { useApp } from '../../state/AppContext';
import type { Student } from '../../types';

export interface ExistingStudentsImportContext {
  existingCodes: Set<string>;
  existingInClass: Student[];
  nextCodeStart: number;
}

/**
 * Đọc danh sách mã học sinh hiện có và chỉ số mã HSxxx kế tiếp trên đúng database của tài khoản đã xác thực.
 * Tuyệt đối không truy cập hoặc fallback về database legacy ('pink-classroom').
 */
export async function loadImportStudentContext(
  userDb: PinkDB | null | undefined,
  classId: string,
): Promise<ExistingStudentsImportContext> {
  if (!userDb || userDb.name === LEGACY_DB_NAME) {
    throw new Error('Cơ sở dữ liệu tài khoản chưa sẵn sàng hoặc không hợp lệ.');
  }
  const all = await userDb.students.toArray();
  const existingCodes = new Set(all.map((s) => s.code.toUpperCase()));
  let max = 0;
  all.forEach((s) => {
    const m = /^HS(\d+)$/i.exec(s.code);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return {
    existingCodes,
    existingInClass: all.filter((s) => s.classId === classId),
    nextCodeStart: max + 1,
  };
}

/**
 * Phân tích file Excel/CSV học sinh dựa trên dữ liệu học sinh của đúng tài khoản hiện hành.
 */
export async function parseStudentFileForDatabase(
  userDb: PinkDB | null | undefined,
  file: File,
  classId: string,
): Promise<ImportResult> {
  const ctx = await loadImportStudentContext(userDb, classId);
  return parseStudentFile(
    file,
    ctx.existingCodes,
    ctx.existingInClass,
    ctx.nextCodeStart,
  );
}

function useSafeUserDb(): PinkDB | null {
  try {
    const app = useApp();
    if (!app?.db || app.db.name === LEGACY_DB_NAME) {
      return null;
    }
    return app.db;
  } catch {
    return null;
  }
}

export function ImportExcelModal({ open, onClose, classId, className }: { open: boolean; onClose: () => void; classId: string; className: string }) {
  const toast = useToast();
  const userDb = useSafeUserDb();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [skipWarnings, setSkipWarnings] = useState(false);

  const close = () => {
    setResult(null);
    setFileName('');
    onClose();
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!userDb) {
      toast.error('Cơ sở dữ liệu tài khoản chưa sẵn sàng');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setParsing(true);
    setFileName(f.name);
    try {
      const r = await parseStudentFileForDatabase(userDb, f, classId);
      setResult(r);
    } catch {
      toast.error('Không đọc được file');
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const valid = result?.rows.filter((r) => r.errors.length === 0) ?? [];
  const toSave = skipWarnings ? valid.filter((r) => r.warnings.length === 0) : valid;
  const errCount = (result?.rows.length ?? 0) - valid.length;
  const warnCount = valid.filter((r) => r.warnings.length > 0).length;

  const confirm = async () => {
    if (!toSave.length) return;
    if (!userDb) {
      toast.error('Cơ sở dữ liệu tài khoản chưa sẵn sàng');
      return;
    }
    setSaving(true);
    try {
      const n = await bulkAddStudents(
        classId,
        toSave.map((r) => r.input),
      );
      toast.success(`Đã nhập ${n} học sinh vào lớp ${className}`);
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nhập dữ liệu thất bại');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      locked={saving}
      size="xl"
      title="Nhập danh sách từ Excel"
      subtitle={`Học sinh sẽ được thêm vào lớp ${className}. Dữ liệu chỉ được lưu khi bạn bấm xác nhận.`}
      footer={
        result && !result.fileError && !result.missingHeaders.length ? (
          <>
            {warnCount > 0 && (
              <label className="mr-auto flex items-center gap-2 text-[14px] text-ink-soft cursor-pointer">
                <input type="checkbox" className="accent-pink-500 w-4 h-4" checked={skipWarnings} onChange={(e) => setSkipWarnings(e.target.checked)} />
                Bỏ qua {warnCount} dòng nghi trùng
              </label>
            )}
            <button className="btn-ghost" onClick={() => setResult(null)} disabled={saving}>
              Chọn file khác
            </button>
            <button className="btn-primary" onClick={confirm} disabled={saving || toSave.length === 0}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Xác nhận nhập {toSave.length} học sinh
            </button>
          </>
        ) : undefined
      }
    >
      {!result ? (
        <div className="space-y-4">
          <div className="rounded-2xl bg-sky/50 p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
            <FileSpreadsheet className="w-8 h-8 text-sky-dark shrink-0" />
            <div className="flex-1 text-[14px]">
              <p className="font-semibold">Bước 1: Tải file mẫu</p>
              <p className="text-ink-soft">
                Cột bắt buộc: <b>{REQUIRED_HEADERS.join(', ')}</b>. Các cột khác: Ngày sinh, Giới tính, Họ tên phụ huynh, SĐT phụ huynh, Ghi chú.
              </p>
            </div>
            <button className="btn-outline" onClick={downloadTemplate}>
              <Download className="w-4 h-4" /> Tải file mẫu
            </button>
          </div>
          <button
            type="button"
            className="w-full border-2 border-dashed border-pink-200 hover:border-pink-400 hover:bg-pink-50 rounded-[20px] py-12 flex flex-col items-center gap-2 transition"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files[0]);
            }}
            disabled={parsing}
          >
            {parsing ? <Loader2 className="w-10 h-10 text-pink-400 animate-spin" /> : <Upload className="w-10 h-10 text-pink-400" />}
            <span className="font-semibold">{parsing ? `Đang đọc ${fileName}...` : 'Bước 2: Bấm để chọn hoặc kéo thả file vào đây'}</span>
            <span className="text-[13px] text-ink-soft">Hỗ trợ .xlsx, .xls, .csv – tối đa 5MB</span>
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      ) : result.fileError || result.missingHeaders.length ? (
        <div className="rounded-2xl bg-danger-soft/60 p-5 text-[14.5px]">
          <p className="font-semibold text-danger flex items-center gap-2">
            <AlertCircle className="w-5 h-5" /> Không thể nhập file “{fileName}”
          </p>
          {result.fileError && <p className="mt-1">{result.fileError}</p>}
          {result.missingHeaders.length > 0 && (
            <p className="mt-1">
              Thiếu cột bắt buộc: <b>{result.missingHeaders.join(', ')}</b>. Hãy dùng file mẫu và giữ nguyên tên cột ở dòng đầu tiên.
            </p>
          )}
          <button className="btn-outline btn-sm mt-3" onClick={() => setResult(null)}>
            Chọn file khác
          </button>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap gap-2 mb-3 text-[13.5px]">
            <span className="chip bg-pink-100 text-pink-700">{result.rows.length} dòng dữ liệu</span>
            <span className="chip bg-mint text-mint-dark">
              <CheckCircle2 className="w-3.5 h-3.5" /> {valid.length} hợp lệ
            </span>
            {errCount > 0 && (
              <span className="chip bg-danger-soft text-danger">
                <AlertCircle className="w-3.5 h-3.5" /> {errCount} lỗi (sẽ bỏ qua)
              </span>
            )}
            {warnCount > 0 && (
              <span className="chip bg-cream text-cream-dark">
                <AlertTriangle className="w-3.5 h-3.5" /> {warnCount} nghi trùng
              </span>
            )}
          </div>
          {result.rows.length === 0 ? (
            <p className="text-ink-soft text-center py-8">File không có dòng dữ liệu nào.</p>
          ) : (
            <div className="overflow-auto max-h-[50vh] scroll-soft rounded-2xl border border-pink-100">
              <table className="table-base min-w-[760px]">
                <thead className="sticky top-0">
                  <tr>
                    <th>Dòng</th>
                    <th>Họ và tên</th>
                    <th>Mã HS</th>
                    <th>Ngày sinh</th>
                    <th>Giới tính</th>
                    <th>Kiểm tra</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.rowNumber} className={r.errors.length ? '!bg-danger-soft/40' : r.warnings.length ? '!bg-cream/30' : ''}>
                      <td className="text-ink-soft">{r.rowNumber}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <AnimalAvatarSVG avatarKey={r.input.avatar} size={28} />
                          <span className="font-semibold">{r.input.fullName || <i className="text-ink-soft">(trống)</i>}</span>
                        </div>
                      </td>
                      <td className="font-mono text-[13px]">
                        {r.input.code}
                        {r.autoCode && <span className="chip bg-lavender/60 text-lavender-dark ml-1 !text-[10.5px]">tự tạo</span>}
                      </td>
                      <td>{r.input.birthDate ? r.input.birthDate.split('-').reverse().join('/') : '—'}</td>
                      <td>{{ male: 'Nam', female: 'Nữ', other: 'Khác', '': '—' }[r.input.gender]}</td>
                      <td className="text-[13px]">
                        {r.errors.map((e) => (
                          <div key={e} className="text-danger flex gap-1">
                            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            {e}
                          </div>
                        ))}
                        {r.warnings.map((w) => (
                          <div key={w} className="text-cream-dark flex gap-1">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            {w}
                          </div>
                        ))}
                        {!r.errors.length && !r.warnings.length && (
                          <span className="text-mint-dark flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Hợp lệ
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
