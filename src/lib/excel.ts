import * as XLSX from 'xlsx';
import type { Student } from '../types';
import { validateStudentInput, type StudentInput } from '../data/repo';
import { normalizeVN, toISODate } from './utils';
import { randomAvatarKey } from '../components/avatars';

/* ---------------- Xuất file ---------------- */

export function downloadSheets(filename: string, sheets: { name: string; rows: Record<string, unknown>[] }[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ 'Thông báo': 'Chưa có dữ liệu' }]);
    const keys = Object.keys(s.rows[0] ?? { 'Thông báo': '' });
    ws['!cols'] = keys.map((k) => ({
      wch: Math.min(40, Math.max(k.length + 2, ...s.rows.map((r) => String(r[k] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

const GENDER_LABEL: Record<string, string> = { male: 'Nam', female: 'Nữ', other: 'Khác', '': '' };

export function studentsToRows(students: Student[], className: (id: string) => string) {
  return students.map((s, i) => ({
    STT: i + 1,
    'Mã học sinh': s.code,
    'Họ và tên': s.fullName,
    'Ngày sinh': s.birthDate ? s.birthDate.split('-').reverse().join('/') : '',
    'Giới tính': GENDER_LABEL[s.gender] ?? '',
    Lớp: className(s.classId),
    'Họ tên phụ huynh': s.parentName ?? '',
    'SĐT phụ huynh': s.parentPhone ?? '',
    'Ghi chú': s.note ?? '',
    'Trạng thái': s.status === 'active' ? 'Đang học' : 'Lưu trữ',
  }));
}

export const TEMPLATE_HEADERS = ['Mã học sinh', 'Họ và tên', 'Ngày sinh', 'Giới tính', 'Họ tên phụ huynh', 'SĐT phụ huynh', 'Ghi chú'];
export const REQUIRED_HEADERS = ['Mã học sinh', 'Họ và tên'];

export function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    TEMPLATE_HEADERS,
    ['HS9001', 'Nguyễn Văn Mẫu', '15/03/2019', 'Nam', 'Nguyễn Văn Phụ Huynh', '0901234567', 'Dòng ví dụ – hãy xóa trước khi nhập'],
    ['', 'Trần Thị Ví Dụ', '2019-08-20', 'Nữ', '', '', 'Để trống mã → hệ thống tự tạo'],
  ]);
  ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(16, h.length + 4) }));
  const guide = XLSX.utils.aoa_to_sheet([
    ['HƯỚNG DẪN NHẬP DANH SÁCH HỌC SINH – PINK CLASSROOM'],
    [''],
    ['Cột bắt buộc phải có: "Mã học sinh", "Họ và tên" (giữ nguyên tên cột ở dòng đầu tiên).'],
    ['Ô "Mã học sinh" có thể để trống, hệ thống sẽ tự tạo mã HSxxxx.'],
    ['Ngày sinh: dd/mm/yyyy hoặc yyyy-mm-dd.'],
    ['Giới tính: Nam / Nữ / Khác hoặc để trống.'],
    ['SĐT phụ huynh: bắt đầu bằng 0 hoặc +84.'],
    ['Hệ thống sẽ hiển thị bản xem trước và báo lỗi từng dòng trước khi lưu.'],
  ]);
  guide['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
  XLSX.utils.book_append_sheet(wb, guide, 'HuongDan');
  XLSX.writeFile(wb, 'Mau_nhap_hoc_sinh_PinkClassroom.xlsx');
}

/* ---------------- Nhập file ---------------- */

export interface ImportRow {
  rowNumber: number; // số dòng trong Excel (bắt đầu từ 2)
  input: StudentInput;
  errors: string[];
  warnings: string[];
  autoCode: boolean;
}

export interface ImportResult {
  rows: ImportRow[];
  missingHeaders: string[];
  fileError?: string;
}

function parseDateCell(v: unknown): { value?: string; error?: string } {
  if (v === undefined || v === null || v === '') return {};
  if (v instanceof Date && !isNaN(v.getTime())) return { value: toISODate(v) };
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return { value: `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` };
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return { value: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return { value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` };
  return { error: `Ngày sinh "${s}" không đúng định dạng` };
}

function parseGender(v: unknown): StudentInput['gender'] | null {
  const s = normalizeVN(String(v ?? ''));
  if (!s) return '';
  if (['nam', 'm', 'male', 'trai'].includes(s)) return 'male';
  if (['nu', 'f', 'female', 'gai'].includes(s)) return 'female';
  if (['khac', 'other'].includes(s)) return 'other';
  return null;
}

/**
 * Đọc và kiểm tra file Excel. Không ghi gì vào cơ sở dữ liệu.
 * @param existingCodes mã học sinh đã có trong hệ thống (viết hoa)
 * @param classStudents học sinh trong lớp đích để phát hiện trùng họ tên + ngày sinh
 */
export async function parseStudentFile(
  file: File,
  existingCodes: Set<string>,
  classStudents: Student[],
  nextCodeStart: number,
): Promise<ImportResult> {
  if (file.size > 5 * 1024 * 1024) return { rows: [], missingHeaders: [], fileError: 'File quá lớn (tối đa 5MB)' };
  let wb: XLSX.WorkBook;
  try {
    const buf = await file.arrayBuffer();
    wb = XLSX.read(buf, { type: 'array', cellDates: true });
  } catch {
    return { rows: [], missingHeaders: [], fileError: 'Không đọc được file. Hãy dùng file .xlsx, .xls hoặc .csv' };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], missingHeaders: [], fileError: 'File không có trang tính nào' };
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: false });
  if (aoa.length === 0) return { rows: [], missingHeaders: REQUIRED_HEADERS, fileError: 'File trống' };

  const header = (aoa[0] as unknown[]).map((h) => normalizeVN(String(h ?? '')));
  const col = (name: string) => header.indexOf(normalizeVN(name));
  const missingHeaders = REQUIRED_HEADERS.filter((h) => col(h) < 0);
  if (missingHeaders.length) return { rows: [], missingHeaders };

  const idx = {
    code: col('Mã học sinh'),
    name: col('Họ và tên'),
    birth: col('Ngày sinh'),
    gender: col('Giới tính'),
    parentName: col('Họ tên phụ huynh'),
    parentPhone: col('SĐT phụ huynh'),
    note: col('Ghi chú'),
  };
  const get = (r: unknown[], i: number) => (i >= 0 ? r[i] : '');

  const seenCodes = new Map<string, number>();
  const seenNameBirth = new Map<string, number>();
  const classKeys = new Set(classStudents.map((s) => `${normalizeVN(s.fullName)}|${s.birthDate ?? ''}`));
  let codeCounter = nextCodeStart;
  const rows: ImportRow[] = [];

  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] as unknown[];
    if (r.every((c) => String(c ?? '').trim() === '')) continue;
    const errors: string[] = [];
    const warnings: string[] = [];
    let code = String(get(r, idx.code) ?? '').trim().toUpperCase();
    let autoCode = false;
    if (!code) {
      while (existingCodes.has(`HS${String(codeCounter).padStart(4, '0')}`) || seenCodes.has(`HS${String(codeCounter).padStart(4, '0')}`)) codeCounter++;
      code = `HS${String(codeCounter).padStart(4, '0')}`;
      codeCounter++;
      autoCode = true;
    }
    const birth = parseDateCell(get(r, idx.birth));
    if (birth.error) errors.push(birth.error);
    const gender = parseGender(get(r, idx.gender));
    if (gender === null) errors.push(`Giới tính "${String(get(r, idx.gender))}" không hợp lệ (Nam/Nữ/Khác)`);
    const input: StudentInput = {
      code,
      fullName: String(get(r, idx.name) ?? '').trim(),
      birthDate: birth.value,
      gender: gender ?? '',
      avatar: randomAvatarKey(),
      parentName: String(get(r, idx.parentName) ?? '').trim(),
      parentPhone: String(get(r, idx.parentPhone) ?? '').trim(),
      note: String(get(r, idx.note) ?? '').trim(),
    };
    const v = validateStudentInput(input);
    for (const [k, msg] of Object.entries(v)) {
      if (k === 'birthDate' && birth.error) continue;
      errors.push(msg);
    }
    if (existingCodes.has(code)) errors.push(`Mã ${code} đã tồn tại trong hệ thống`);
    if (seenCodes.has(code)) errors.push(`Mã ${code} bị trùng với dòng ${seenCodes.get(code)}`);
    else seenCodes.set(code, i + 1);
    const nb = `${normalizeVN(input.fullName)}|${input.birthDate ?? ''}`;
    if (input.fullName) {
      if (classKeys.has(nb)) warnings.push('Trùng họ tên và ngày sinh với học sinh đã có trong lớp');
      if (seenNameBirth.has(nb)) warnings.push(`Trùng họ tên và ngày sinh với dòng ${seenNameBirth.get(nb)}`);
      else seenNameBirth.set(nb, i + 1);
    }
    rows.push({ rowNumber: i + 1, input, errors, warnings, autoCode });
  }
  return { rows, missingHeaders: [] };
}
