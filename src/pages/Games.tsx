import { useNavigate } from 'react-router-dom';
import { Dog, Rocket, Sparkles, Play, History, Users, RefreshCw } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useGamePicks } from '../state/hooks';
import { PageHeader } from '../components/ui';
import { formatDateTimeVN } from '../lib/utils';
import { clearGamePicks } from '../data/repo';
import { useToast } from '../components/ToastNotification';

export default function GamesPage() {
  const { currentClass } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const picks = useGamePicks(classId);

  const handleClearHistory = async () => {
    if (!classId) return;
    await clearGamePicks(classId);
    toast.info('Đã làm mới lịch sử chọn học sinh');
  };

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title="Trò chơi lớp học"
        description="Các hoạt động minigame vui nhộn tạo không khí hứng khởi trong giờ học."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Game Card 1: Chú chó đuổi bắt */}
        <div className="card overflow-hidden flex flex-col justify-between border-2 border-pink-200 hover:border-pink-300 transition-all shadow-card hover:shadow-soft">
          <div className="bg-gradient-to-br from-pink-100 via-amber-50 to-pink-50 p-6 relative overflow-hidden">
            <div className="absolute right-2 top-2 opacity-15">
              <Dog className="w-32 h-32 text-pink-600" />
            </div>
            <span className="chip bg-pink-500 text-white font-bold mb-3">Minigame 2D Kawaii</span>
            <h3 className="font-display font-black text-2xl text-ink">Chú chó đuổi bắt</h3>
            <p className="text-sm text-ink-soft mt-1 max-w-sm">
              Mô phỏng sân trường tiểu học hoạt hình 2D sinh động. Học sinh rón rén vào lớp, sự cố rơi sách đánh thức chú chó Corgi đáng yêu rượt đuổi sôi động để chọn bạn lên bảng!
            </p>
          </div>

          <div className="p-6 bg-white space-y-4">
            <div className="flex items-center gap-4 text-sm text-ink-soft">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-pink-500" /> {students?.length ?? 0} học sinh sẵn sàng
              </span>
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-500" /> Chọn ngẫu nhiên công bằng
              </span>
            </div>

            <button
              className="btn-primary w-full py-3 h-auto text-base bg-gradient-to-r from-pink-500 to-amber-500 hover:from-pink-600 hover:to-amber-600 text-white"
              onClick={() => navigate('/games/dog')}
              disabled={!students?.length}
            >
              <Play className="w-5 h-5 fill-white" /> Bắt đầu trò chơi
            </button>
          </div>
        </div>

        {/* Game Card 2: UFO gắp học sinh */}
        <div className="card overflow-hidden flex flex-col justify-between border-2 border-indigo-200 hover:border-cyan-300 transition-all shadow-card hover:shadow-soft">
          <div className="bg-gradient-to-br from-indigo-100 via-sky-50 to-amber-50 p-6 relative overflow-hidden">
            <div className="absolute right-2 top-2 opacity-15">
              <Rocket className="w-32 h-32 text-indigo-600" />
            </div>
            <span className="chip bg-indigo-600 text-white font-bold mb-3">Minigame 2D Canvas</span>
            <h3 className="font-display font-black text-2xl text-ink">UFO gắp học sinh</h3>
            <p className="text-sm text-ink-soft mt-1 max-w-sm">
              Mô phỏng đĩa bay UFO ngoài không gian hạ cánh xuống sân trường tiểu học. UFO quét tia sáng kỳ ảo và hút ngẫu nhiên một bạn học sinh lên đĩa bay để gọi tên!
            </p>
          </div>

          <div className="p-6 bg-white space-y-4">
            <div className="flex items-center gap-4 text-sm text-ink-soft">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-indigo-500" /> {students?.length ?? 0} học sinh sẵn sàng
              </span>
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-500" /> Chọn ngẫu nhiên công bằng
              </span>
            </div>

            <button
              className="btn-primary w-full py-3 h-auto text-base bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white"
              onClick={() => navigate('/games/ufo')}
              disabled={!students?.length}
            >
              <Play className="w-5 h-5 fill-white" /> Bắt đầu trò chơi
            </button>
          </div>
        </div>

        {/* Lịch sử các bạn đã được chọn */}
        <div className="card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-extrabold text-base flex items-center gap-2">
                <History className="w-5 h-5 text-pink-500" />
                Lịch sử chọn gần đây
              </h3>
              {picks && picks.length > 0 && (
                <button
                  className="btn-ghost btn-sm text-[12.5px]"
                  onClick={handleClearHistory}
                  data-tip="Làm mới danh sách"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Xóa lịch sử
                </button>
              )}
            </div>

            {!picks || picks.length === 0 ? (
              <p className="text-sm text-ink-soft text-center py-8">
                Chưa có lượt chọn nào. Hãy mở trò chơi và bấm bắt đầu để gọi tên bạn đầu tiên nhé!
              </p>
            ) : (
              <ul className="space-y-2 max-h-64 overflow-y-auto scroll-soft pr-1">
                {picks.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-pink-50/60 border border-pink-100"
                  >
                    <span className="font-semibold text-sm text-ink">{p.studentName}</span>
                    <span className="text-[12px] text-ink-soft">{formatDateTimeVN(p.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
