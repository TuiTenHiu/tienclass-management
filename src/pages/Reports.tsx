import { useMemo, useState } from 'react';
import {
  Download,
  Star,
  Printer,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
} from 'recharts';
import { useApp } from '../state/AppContext';
import { useStudents, useAttendance, useTransactions } from '../state/hooks';
import { PageHeader, Card } from '../components/ui';
import { StudentAvatar } from '../components/StudentAvatar';
import { EmptyState } from '../components/States';
import { downloadSheets, studentsToRows } from '../lib/excel';
import { pointsByStudent, rankStudents, summarizeAttendance } from '../lib/stats';
import { periodRange, type PeriodKind, formatDateVN } from '../lib/utils';
import { useToast } from '../components/ToastNotification';

const PASTEL_COLORS = ['#CFF3E4', '#FFE9A8', '#F7A8C4', '#E5627A'];

export default function ReportsPage() {
  const { currentClass } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const [period, setPeriod] = useState<PeriodKind>('month');

  const students = useStudents(classId, 'active');
  const attendance = useAttendance(classId);
  const txs = useTransactions(classId);

  const range = useMemo(() => periodRange(period), [period]);

  // Lọc dữ liệu theo khoảng thời gian
  const filteredAttendance = useMemo(() => {
    if (!attendance) return [];
    return attendance.filter((a) => a.date >= range.from && a.date <= range.to);
  }, [attendance, range]);

  const attSummary = useMemo(() => {
    return summarizeAttendance(filteredAttendance);
  }, [filteredAttendance]);

  // Bảng xếp hạng điểm thi đua trong kỳ
  const studentPoints = useMemo(() => {
    return pointsByStudent(txs ?? [], range);
  }, [txs, range]);

  const ranking = useMemo(() => {
    if (!students) return [];
    return rankStudents(students, studentPoints);
  }, [students, studentPoints]);

  // Dữ liệu cho biểu đồ tròn Điểm danh
  const pieData = [
    { name: 'Có mặt', value: attSummary.present },
    { name: 'Đi muộn', value: attSummary.late },
    { name: 'Có phép', value: attSummary.excused },
    { name: 'Không phép', value: attSummary.unexcused },
  ].filter((d) => d.value > 0);

  // Dữ liệu Top 8 học sinh cho BarChart
  const barData = ranking.slice(0, 8).map((r) => ({
    name: r.student.fullName.split(' ').pop() || r.student.fullName,
    fullName: r.student.fullName,
    points: r.points,
  }));

  const handlePrint = () => {
    window.print();
  };

  const handleExport = () => {
    if (!currentClass || !students) return;

    // Xuất bảng tổng hợp
    const rows = ranking.map((r, i) => ({
      'Xếp hạng': i + 1,
      'Mã HS': r.student.code,
      'Họ và tên': r.student.fullName,
      'Điểm thi đua': r.points,
      'Tỷ lệ chuyên cần': `${Math.round(
        (summarizeAttendance(
          (attendance ?? []).filter((a) => a.studentId === r.student.id)
        ).rate ?? 1) * 100
      )}%`,
    }));

    downloadSheets(`Bao_cao_lop_${currentClass.name}`, [
      { name: 'TongHopThiDua', rows },
      {
        name: 'DanhSachHocSinh',
        rows: studentsToRows(students, () => currentClass.name),
      },
    ]);
    toast.success('Đã tải xuống file báo cáo Excel');
  };

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title={`Báo cáo thống kê: Lớp ${currentClass.name}`}
        description={`Khoảng thời gian: ${formatDateVN(range.from)} đến ${formatDateVN(range.to)}`}
        actions={
          <div className="flex flex-wrap gap-2 no-print">
            <select
              className="input h-10 w-44"
              value={period}
              onChange={(e) => setPeriod(e.target.value as PeriodKind)}
            >
              <option value="week">Tuần này</option>
              <option value="month">Tháng này</option>
              <option value="semester1">Học kỳ 1</option>
              <option value="semester2">Học kỳ 2</option>
              <option value="year">Cả năm học</option>
              <option value="all">Toàn bộ thời gian</option>
            </select>
            <button className="btn-outline" onClick={handlePrint}>
              <Printer className="w-4 h-4" /> In báo cáo
            </button>
            <button className="btn-primary" onClick={handleExport}>
              <Download className="w-4 h-4" /> Xuất Excel
            </button>
          </div>
        }
      />

      {/* Grid thống kê tổng quan */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-5 bg-pink-50/50">
          <span className="text-xs font-semibold text-ink-soft uppercase">Sĩ số lớp</span>
          <p className="font-display font-black text-3xl mt-1 text-ink">{students?.length ?? 0}</p>
          <span className="text-xs text-ink-soft mt-1 block">Học sinh đang học</span>
        </div>
        <div className="card p-5 bg-mint/30">
          <span className="text-xs font-semibold text-mint-dark uppercase">Tỷ lệ chuyên cần</span>
          <p className="font-display font-black text-3xl mt-1 text-mint-dark">
            {attSummary.rate != null ? `${Math.round(attSummary.rate * 100)}%` : '—'}
          </p>
          <span className="text-xs text-ink-soft mt-1 block">
            {attSummary.present + attSummary.late} lượt có mặt
          </span>
        </div>
        <div className="card p-5 bg-cream/40">
          <span className="text-xs font-semibold text-cream-dark uppercase">Lượt vắng</span>
          <p className="font-display font-black text-3xl mt-1 text-cream-dark">
            {attSummary.excused + attSummary.unexcused}
          </p>
          <span className="text-xs text-ink-soft mt-1 block">
            {attSummary.excused} có phép · {attSummary.unexcused} không phép
          </span>
        </div>
        <div className="card p-5 bg-lavender/30">
          <span className="text-xs font-semibold text-lavender-dark uppercase">Tổng điểm thi đua</span>
          <p className="font-display font-black text-3xl mt-1 text-lavender-dark">
            {ranking.reduce((s, r) => s + r.points, 0)}
          </p>
          <span className="text-xs text-ink-soft mt-1 block">Tích lũy trong kỳ</span>
        </div>
      </div>

      {/* Biểu đồ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Biểu đồ Chuyên cần (PieChart) */}
        <Card title="Tỷ lệ chuyên cần học sinh">
          {pieData.length === 0 ? (
            <p className="text-sm text-ink-soft text-center py-16">
              Chưa có dữ liệu điểm danh trong khoảng thời gian này.
            </p>
          ) : (
            <div className="h-64 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {pieData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={PASTEL_COLORS[index % PASTEL_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-2 text-xs">
                {pieData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ background: PASTEL_COLORS[i % PASTEL_COLORS.length] }}
                    />
                    <span className="font-semibold text-ink">{d.name}:</span>
                    <span className="text-ink-soft">{d.value} lượt</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Biểu đồ Thi đua Top học sinh (BarChart) */}
        <Card title="Top học sinh có điểm thi đua nổi bật">
          {barData.length === 0 || barData.every((b) => b.points === 0) ? (
            <p className="text-sm text-ink-soft text-center py-16">
              Chưa có dữ liệu điểm thi đua trong khoảng thời gian này.
            </p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#FCE7F0" />
                  <XAxis dataKey="name" stroke="#8D8190" fontSize={12} tickLine={false} />
                  <YAxis stroke="#8D8190" fontSize={12} tickLine={false} />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload || !payload.length) return null;
                      const item = payload[0].payload;
                      return (
                        <div className="card p-2 text-xs shadow-soft bg-white border border-pink-100">
                          <p className="font-bold">{item.fullName}</p>
                          <p className="text-pink-600 font-semibold">{item.points} điểm thi đua</p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="points" fill="#F7A8C4" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Bảng xếp hạng chi tiết toàn lớp */}
      <Card title="Bảng tổng hợp thi đua học sinh">
        {ranking.length === 0 ? (
          <EmptyState illustration="bunny-star" title="Chưa có dữ liệu học sinh" />
        ) : (
          <div className="overflow-x-auto scroll-soft p-1">
            <table className="table-base min-w-[650px]">
              <thead>
                <tr>
                  <th className="w-16">Xếp hạng</th>
                  <th>Học sinh</th>
                  <th>Mã HS</th>
                  <th className="text-right">Điểm thi đua</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r, idx) => (
                  <tr key={r.student.id}>
                    <td>
                      <span
                        className={`w-7 h-7 rounded-full text-xs font-bold inline-flex items-center justify-center ${
                          idx === 0
                            ? 'bg-cream text-cream-dark'
                            : idx === 1
                            ? 'bg-lavender text-lavender-dark'
                            : idx === 2
                            ? 'bg-pink-100 text-pink-600'
                            : 'bg-pink-50 text-ink-soft'
                        }`}
                      >
                        {idx + 1}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <StudentAvatar student={r.student} size={32} />
                        <span className="font-semibold">{r.student.fullName}</span>
                      </div>
                    </td>
                    <td className="font-mono text-sm text-ink-soft">{r.student.code}</td>
                    <td className="text-right">
                      <span className="chip bg-pink-100 text-pink-600 font-bold">
                        <Star className="w-3.5 h-3.5 fill-pink-400 text-pink-400" />
                        {r.points}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
