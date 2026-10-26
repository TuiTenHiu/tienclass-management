import { useState } from 'react';
import {
  User,
  Shield,
  Download,
  Upload,
  Trash2,
  Sparkles,
  Save,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { PageHeader, Field, Toggle } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastNotification';
import {
  saveSettings,
  exportBackup,
  importBackup,
  wipeAll,
  createClass,
  bulkAddStudents,
} from '../data/repo';
import { sha256 } from '../lib/utils';

export default function SettingsPage() {
  const { settings, setCurrentClassId } = useApp();
  const toast = useToast();

  const [teacherName, setTeacherName] = useState(settings.teacherName);
  const [teacherTitle, setTeacherTitle] = useState<'cô' | 'thầy'>(settings.teacherTitle);
  const [defaultSession, setDefaultSession] = useState(settings.defaultSession);
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);

  // Cấu hình mã PIN
  const [newPin, setNewPin] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);

  const handleSaveProfile = async () => {
    try {
      await saveSettings({
        teacherName,
        teacherTitle,
        defaultSession,
        soundEnabled,
      });
      toast.success('Đã lưu cài đặt tài khoản');
    } catch (e) {
      toast.error('Lỗi khi lưu cài đặt');
    }
  };

  const handleSetPin = async () => {
    if (newPin && newPin.length < 4) {
      toast.error('Mã PIN phải có ít nhất 4 số');
      return;
    }
    try {
      if (!newPin) {
        // Xóa PIN
        await saveSettings({ pinHash: undefined, pinSalt: undefined });
        toast.info('Đã hủy khóa mã PIN');
      } else {
        const salt = Math.random().toString(36).substring(2);
        const hash = await sha256(`${salt}:${newPin}`);
        await saveSettings({ pinHash: hash, pinSalt: salt });
        toast.success('Đã thiết lập mã PIN bảo vệ ứng dụng');
        setNewPin('');
      }
    } catch {
      toast.error('Lỗi khi cài đặt mã PIN');
    }
  };

  // Sao lưu JSON
  const handleBackup = async () => {
    try {
      const data = await exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PinkClassroom_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Đã tải xuống bản sao lưu dữ liệu toàn hệ thống');
    } catch {
      toast.error('Không thể tạo file sao lưu');
    }
  };

  // Khôi phục từ file JSON
  const handleRestoreFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const json = JSON.parse(evt.target?.result as string);
        await importBackup(json);
        toast.success('Đã khôi phục dữ liệu thành công!');
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        toast.error('File sao lưu không hợp lệ hoặc bị lỗi');
      }
    };
    reader.readAsText(file);
  };

  // Nạp dữ liệu mẫu để trải nghiệm thử
  const handleLoadDemo = async () => {
    setLoadingDemo(true);
    try {
      const cls = await createClass({
        name: '3A1',
        schoolYear: '2026-2027',
        teacherName: `${teacherTitle === 'cô' ? 'Cô' : 'Thầy'} ${teacherName}`,
        subject: 'Chủ nhiệm',
        note: 'Lớp học vui vẻ, tràn ngập tiếng cười!',
      });

      const demoStudents = [
        { code: 'HS0001', fullName: 'Nguyễn Bông Bông', gender: 'female' as const, avatar: 'bunny-pink' },
        { code: 'HS0002', fullName: 'Trần Gia Bảo', gender: 'male' as const, avatar: 'bear-sky' },
        { code: 'HS0003', fullName: 'Lê Thảo My', gender: 'female' as const, avatar: 'cat-pink' },
        { code: 'HS0004', fullName: 'Phạm Minh Khôi', gender: 'male' as const, avatar: 'capybara-cream' },
        { code: 'HS0005', fullName: 'Vũ Hoàng Yến', gender: 'female' as const, avatar: 'chick-mint' },
        { code: 'HS0006', fullName: 'Đỗ Tuấn Kiệt', gender: 'male' as const, avatar: 'fox-lavender' },
        { code: 'HS0007', fullName: 'Bùi Ánh Dương', gender: 'female' as const, avatar: 'panda-pink' },
        { code: 'HS0008', fullName: 'Đinh Nhật Nam', gender: 'male' as const, avatar: 'frog-mint' },
      ];

      await bulkAddStudents(
        cls.id,
        demoStudents.map((s) => ({
          ...s,
          birthDate: '2018-05-12',
          parentName: 'Phụ huynh học sinh',
          parentPhone: '0901234567',
        }))
      );

      setCurrentClassId(cls.id);
      toast.success('Đã tạo lớp mẫu 3A1 với 8 bạn học sinh xinh xắn!');
    } catch {
      toast.error('Lỗi khi nạp dữ liệu mẫu');
    } finally {
      setLoadingDemo(false);
    }
  };

  const handleWipe = async () => {
    await wipeAll();
    toast.info('Đã xóa trắng toàn bộ dữ liệu');
    setTimeout(() => window.location.reload(), 600);
  };

  return (
    <div className="animate-fadeIn space-y-6 max-w-4xl">
      <PageHeader
        title="Cài đặt hệ thống"
        description="Quản lý tài khoản giáo viên, bảo mật mã PIN và sao lưu dữ liệu."
      />

      {/* Thông tin giáo viên */}
      <div className="card p-6 space-y-4">
        <h3 className="font-display font-extrabold text-base flex items-center gap-2">
          <User className="w-5 h-5 text-pink-500" />
          Thông tin giáo viên
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Danh xưng">
            <select
              className="input"
              value={teacherTitle}
              onChange={(e) => setTeacherTitle(e.target.value as 'cô' | 'thầy')}
            >
              <option value="cô">Cô</option>
              <option value="thầy">Thầy</option>
            </select>
          </Field>
          <Field label="Tên giáo viên" className="sm:col-span-2">
            <input
              className="input"
              value={teacherName}
              onChange={(e) => setTeacherName(e.target.value)}
              placeholder="Tiên"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <Field label="Buổi điểm danh mặc định">
            <select
              className="input"
              value={defaultSession}
              onChange={(e) => setDefaultSession(e.target.value as 'morning' | 'afternoon')}
            >
              <option value="morning">Buổi sáng</option>
              <option value="afternoon">Buổi chiều</option>
            </select>
          </Field>
          <div className="flex items-center pt-6">
            <Toggle
              checked={soundEnabled}
              onChange={setSoundEnabled}
              label="Âm thanh hiệu ứng"
              hint="Phát âm thanh khi chọn học sinh trong trò chơi"
            />
          </div>
        </div>

        <button className="btn-primary mt-2" onClick={handleSaveProfile}>
          <Save className="w-4 h-4" /> Lưu thông tin
        </button>
      </div>

      {/* Bảo mật mã PIN */}
      <div className="card p-6 space-y-4">
        <h3 className="font-display font-extrabold text-base flex items-center gap-2">
          <Shield className="w-5 h-5 text-pink-500" />
          Mã PIN bảo vệ ứng dụng
        </h3>
        <p className="text-sm text-ink-soft">
          Thiết lập mã PIN để tránh học sinh hoặc người khác tò mò can thiệp dữ liệu khi mượn máy tính của cô/thầy.
        </p>

        <div className="flex flex-wrap items-end gap-3 max-w-md">
          <Field label={settings.pinHash ? 'Đổi mã PIN mới (để trống để xóa)' : 'Đặt mã PIN mới (4-8 số)'} className="flex-1">
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              placeholder="••••"
              className="input tracking-widest text-center"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <button className="btn-secondary" onClick={handleSetPin}>
            {newPin ? 'Cập nhật PIN' : 'Gỡ bỏ PIN'}
          </button>
        </div>
      </div>

      {/* Trải nghiệm & Dữ liệu mẫu */}
      <div className="card p-6 bg-gradient-to-r from-pink-50 to-cream/30 space-y-3">
        <h3 className="font-display font-extrabold text-base flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-pink-500" />
          Dữ liệu trải nghiệm thử
        </h3>
        <p className="text-sm text-ink-soft">
          Bạn mới dùng ứng dụng? Bấm vào đây để tạo nhanh một lớp học mẫu <b>3A1</b> với 8 học sinh minh họa, giúp bạn thử nghiệm ngay các tính năng điểm danh, thi đua và trò chơi.
        </p>
        <button
          className="btn-primary"
          onClick={handleLoadDemo}
          disabled={loadingDemo}
        >
          {loadingDemo ? 'Đang tạo...' : 'Nạp dữ liệu lớp mẫu 3A1'}
        </button>
      </div>

      {/* Sao lưu & Phục hồi */}
      <div className="card p-6 space-y-4">
        <h3 className="font-display font-extrabold text-base flex items-center gap-2">
          <Download className="w-5 h-5 text-pink-500" />
          Sao lưu & Khôi phục dữ liệu
        </h3>
        <p className="text-sm text-ink-soft">
          Toàn bộ dữ liệu lớp học, học sinh, điểm danh và thi đua được lưu an toàn trong trình duyệt của bạn. Bạn nên tải bản sao lưu định kỳ để lưu trữ hoặc chuyển sang máy tính khác.
        </p>

        <div className="flex flex-wrap gap-3">
          <button className="btn-outline" onClick={handleBackup}>
            <Download className="w-4 h-4" /> Tải bản sao lưu (.json)
          </button>

          <label className="btn-secondary cursor-pointer">
            <Upload className="w-4 h-4" /> Khôi phục từ file
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleRestoreFile}
            />
          </label>
        </div>
      </div>

      {/* Vùng nguy hiểm: Xóa sạch */}
      <div className="card p-6 border-danger/30 space-y-3">
        <h3 className="font-display font-extrabold text-base text-danger flex items-center gap-2">
          <Trash2 className="w-5 h-5 text-danger" />
          Vùng nguy hiểm
        </h3>
        <p className="text-sm text-ink-soft">
          Xóa toàn bộ các lớp học, học sinh, điểm danh và lịch sử thi đua trong trình duyệt để bắt đầu lại từ đầu.
        </p>
        <button className="btn-danger" onClick={() => setConfirmWipe(true)}>
          Xóa toàn bộ dữ liệu
        </button>
      </div>

      <ConfirmDialog
        open={confirmWipe}
        danger
        title="Xác nhận xóa sạch dữ liệu?"
        confirmLabel="Xóa toàn bộ"
        message="Hành động này sẽ xóa vĩnh viễn toàn bộ lớp học và dữ liệu trong máy. Hãy chắc chắn bạn đã tải file sao lưu trước khi thực hiện."
        onConfirm={handleWipe}
        onClose={() => setConfirmWipe(false)}
      />
    </div>
  );
}
