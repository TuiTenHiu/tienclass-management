// Tiện ích dùng chung: id, ngày tháng, chuỗi tiếng Việt.

export function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix + rnd;
}

/** Ngày theo giờ địa phương dạng YYYY-MM-DD */
export function toISODate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, n: number): string {
  const d = parseISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

export function formatDateVN(s: string | Date, withWeekday = false): string {
  const d = typeof s === 'string' ? parseISODate(s) : s;
  const base = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return withWeekday ? `${WEEKDAYS[d.getDay()]}, ${base}` : base;
}

export function formatDateTimeVN(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${formatDateVN(d)}`;
}

export function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts) / 1000;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} ngày trước`;
  return formatDateVN(new Date(ts));
}

/** Bỏ dấu tiếng Việt để tìm kiếm không phân biệt dấu */
export function normalizeVN(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function matchesSearch(haystack: string[], q: string): boolean {
  const nq = normalizeVN(q);
  if (!nq) return true;
  return haystack.some((h) => normalizeVN(h || '').includes(nq));
}

/** Lấy tên gọi (từ cuối) của họ tên tiếng Việt */
export function givenName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[parts.length - 2][0] + parts[parts.length - 1][0]).toUpperCase();
}

export type PeriodKind = 'week' | 'month' | 'semester1' | 'semester2' | 'year' | 'all' | 'custom';

/** Năm học bắt đầu từ tháng 9 */
export function schoolYearOf(d: Date = new Date()): string {
  const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${y + 1}`;
}

export function periodRange(kind: PeriodKind, ref: Date = new Date()): { from: string; to: string } {
  const today = toISODate(ref);
  if (kind === 'week') {
    const d = new Date(ref);
    const dow = (d.getDay() + 6) % 7; // thứ hai = 0
    d.setDate(d.getDate() - dow);
    const from = toISODate(d);
    return { from, to: addDays(from, 6) };
  }
  if (kind === 'month') {
    const from = toISODate(new Date(ref.getFullYear(), ref.getMonth(), 1));
    const to = toISODate(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));
    return { from, to };
  }
  const startYear = ref.getMonth() >= 7 ? ref.getFullYear() : ref.getFullYear() - 1;
  if (kind === 'semester1') return { from: `${startYear}-09-01`, to: `${startYear + 1}-01-15` };
  if (kind === 'semester2') return { from: `${startYear + 1}-01-16`, to: `${startYear + 1}-05-31` };
  if (kind === 'year') return { from: `${startYear}-08-15`, to: `${startYear + 1}-06-30` };
  void today;
  return { from: '1970-01-01', to: '2999-12-31' };
}

export function tsToISODate(ts: number): string {
  return toISODate(new Date(ts));
}

export function inRange(dateISO: string, r: { from: string; to: string }): boolean {
  return dateISO >= r.from && dateISO <= r.to;
}

export function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

export function classNames(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISODate(s);
  return toISODate(d) === s;
}

export function isValidPhone(s: string): boolean {
  return /^(\+?84|0)\d{8,10}$/.test(s.replace(/[\s.-]/g, ''));
}
