import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, RotateCcw, Volume2, VolumeX, Sparkles } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useGamePicks } from '../state/hooks';
import { pickRandom } from '../lib/picker';
import { saveGamePick } from '../data/repo';
import { AnimalAvatarSVG } from '../components/avatars';
import type { Student } from '../types';

interface Character {
  student: Student;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  speed: number;
  isTarget: boolean;
  caught: boolean;
}

export default function DogGamePage() {
  const navigate = useNavigate();
  const { currentClass, settings } = useApp();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const picks = useGamePicks(classId);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Cấu hình trò chơi
  const [noRepeat, setNoRepeat] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);

  // Trạng thái chơi: 'idle' | 'running' | 'caught'
  const [gameState, setGameState] = useState<'idle' | 'running' | 'caught'>('idle');
  const [pickedStudent, setPickedStudent] = useState<Student | null>(null);

  // Danh sách ID đã được chọn (nếu bật chế độ không lặp)
  const alreadyPickedIds = (picks ?? []).map((p) => p.studentId);

  // Biến tham chiếu vòng lặp game
  const stateRef = useRef({
    characters: [] as Character[],
    dog: {
      x: 100,
      y: 350,
      targetX: 100,
      targetY: 350,
      speed: 3.5,
      state: 'sleeping' as 'sleeping' | 'waking' | 'running' | 'happy',
    },
    targetCharacter: null as Character | null,
    animFrame: 0,
    roundId: '',
  });

  // Âm thanh Web Audio API (không cần tải file mp3 ngoài)
  const playBeep = (freq = 440, type: OscillatorType = 'sine', duration = 0.15) => {
    if (!soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      // Audio not permitted or supported
    }
  };

  // Khởi tạo nhân vật trên canvas khi có danh sách học sinh
  useEffect(() => {
    if (!students || !students.length) return;

    const width = 800;
    const height = 480;

    const chars: Character[] = students.map((s, idx) => {
      // Bố trí học sinh rải rác khu vực bên phải sân trường
      const col = idx % 6;
      const row = Math.floor(idx / 6);
      const baseX = 300 + col * 75 + (Math.random() * 20 - 10);
      const baseY = 120 + row * 85 + (Math.random() * 20 - 10);

      return {
        student: s,
        x: Math.min(width - 50, Math.max(260, baseX)),
        y: Math.min(height - 60, Math.max(100, baseY)),
        targetX: baseX,
        targetY: baseY,
        speed: 0.6 + Math.random() * 0.4,
        isTarget: false,
        caught: false,
      };
    });

    stateRef.current.characters = chars;
    stateRef.current.dog = {
      x: 90,
      y: 360,
      targetX: 90,
      targetY: 360,
      speed: 4.2,
      state: 'sleeping',
    };
  }, [students]);

  // Vòng lặp vẽ và cập nhật hoạt ảnh (Canvas 2D)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let running = true;

    const render = () => {
      if (!running) return;
      const { characters, dog, targetCharacter } = stateRef.current;

      // 1. Vẽ sân trường & bối cảnh
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Bầu trời pastel & cỏ sân trường
      const skyGrad = ctx.createLinearGradient(0, 0, 0, 160);
      skyGrad.addColorStop(0, '#D9EDFF');
      skyGrad.addColorStop(1, '#FFF6FA');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, 160);

      // Cỏ sân trường
      ctx.fillStyle = '#CFF3E4';
      ctx.fillRect(0, 150, canvas.width, canvas.height - 150);

      // Đường chạy / sân chơi pastel
      ctx.fillStyle = '#FFE9A8';
      ctx.beginPath();
      ctx.ellipse(400, 320, 360, 130, 0, 0, Math.PI * 2);
      ctx.fill();

      // Cây xanh hoạt hình
      const drawTree = (tx: number, ty: number) => {
        ctx.fillStyle = '#C08F6B';
        ctx.fillRect(tx - 6, ty, 12, 35);
        ctx.fillStyle = '#A8E6C1';
        ctx.beginPath();
        ctx.arc(tx, ty - 10, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#94D9AF';
        ctx.beginPath();
        ctx.arc(tx - 6, ty - 14, 18, 0, Math.PI * 2);
        ctx.fill();
      };
      drawTree(60, 140);
      drawTree(740, 130);

      // Cổng trường & hoa trang trí
      ctx.fillStyle = '#F7A8C4';
      ctx.fillRect(20, 80, 8, 80);
      ctx.fillRect(100, 80, 8, 80);
      ctx.fillRect(20, 80, 88, 12);
      ctx.fillStyle = '#514553';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('TRƯỜNG TIỂU HỌC', 26, 90);

      // 2. Cập nhật & vẽ các bạn học sinh
      characters.forEach((char) => {
        // Chuyển động nhẹ nhàng (đi dạo trên sân)
        if (!char.caught) {
          if (Math.abs(char.x - char.targetX) < 5 && Math.abs(char.y - char.targetY) < 5) {
            char.targetX = Math.min(canvas.width - 60, Math.max(260, char.x + (Math.random() * 60 - 30)));
            char.targetY = Math.min(canvas.height - 70, Math.max(120, char.y + (Math.random() * 40 - 20)));
          } else {
            char.x += (char.targetX - char.x) * 0.02 * char.speed;
            char.y += (char.targetY - char.y) * 0.02 * char.speed;
          }
        }

        // Vẽ bóng
        ctx.fillStyle = 'rgba(81, 69, 83, 0.12)';
        ctx.beginPath();
        ctx.ellipse(char.x, char.y + 16, 12, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Vẽ thân người & đồng phục học sinh
        ctx.fillStyle = '#514553'; // Tóc
        ctx.beginPath();
        ctx.arc(char.x, char.y - 10, 11, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFE3EE'; // Mặt
        ctx.beginPath();
        ctx.arc(char.x, char.y - 8, 9, 0, Math.PI * 2);
        ctx.fill();

        // Áo đồng phục trắng hồng
        ctx.fillStyle = char.isTarget ? '#E879A9' : '#FFFFFF';
        ctx.beginPath();
        ctx.roundRect(char.x - 9, char.y, 18, 16, [4, 4, 0, 0]);
        ctx.fill();

        // Tên học sinh bên dưới
        ctx.fillStyle = char.isTarget ? '#E879A9' : '#514553';
        ctx.font = char.isTarget ? 'bold 12px sans-serif' : '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(char.student.fullName.split(' ').pop() || '', char.x, char.y + 30);
      });

      // 3. Cập nhật & vẽ Chú Chó
      // Di chuyển chó nếu đang chạy đuổi học sinh
      if (dog.state === 'running' && targetCharacter) {
        const dx = targetCharacter.x - dog.x;
        const dy = targetCharacter.y - dog.y;
        const dist = Math.sqrt(dx * dx);

        if (dist < 18) {
          // Bắt kịp mục tiêu!
          dog.state = 'happy';
          targetCharacter.caught = true;
          setGameState('caught');
          setPickedStudent(targetCharacter.student);
          playBeep(587, 'triangle', 0.3); // Nốt chúc mừng

          if (classId) {
            saveGamePick(classId, targetCharacter.student, stateRef.current.roundId);
          }
        } else {
          dog.x += (dx / dist) * dog.speed;
          dog.y += (dy / dist) * dog.speed;
        }
      }

      // Vẽ ổ nằm của chú chó
      ctx.fillStyle = '#FCE7F0';
      ctx.beginPath();
      ctx.ellipse(90, 360, 30, 14, 0, 0, Math.PI * 2);
      ctx.fill();

      // Vẽ hình chú chó
      ctx.save();
      ctx.translate(dog.x, dog.y);

      // Bóng chú chó
      ctx.fillStyle = 'rgba(81, 69, 83, 0.15)';
      ctx.beginPath();
      ctx.ellipse(0, 8, 16, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // Thân chó nâu vàng pastel
      ctx.fillStyle = '#F5E1C8';
      ctx.beginPath();
      ctx.ellipse(0, 0, 16, 12, 0, 0, Math.PI * 2);
      ctx.fill();

      // Đầu chó
      ctx.fillStyle = '#F5E1C8';
      ctx.beginPath();
      ctx.arc(8, -8, 10, 0, Math.PI * 2);
      ctx.fill();

      // Tai chó
      ctx.fillStyle = '#C99A6E';
      ctx.beginPath();
      ctx.ellipse(4, -10, 4, 7, Math.PI / 4, 0, Math.PI * 2);
      ctx.fill();

      // Mắt & mũi
      ctx.fillStyle = '#514553';
      if (dog.state === 'sleeping') {
        // Nhắm mắt ngủ zzz
        ctx.strokeStyle = '#514553';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(10, -8, 2.5, 0, Math.PI);
        ctx.stroke();

        ctx.fillStyle = '#E879A9';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('z z Z', 16, -18);
      } else {
        // Mở to mắt
        ctx.beginPath();
        ctx.arc(10, -9, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(14, -6, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      stateRef.current.animFrame = requestAnimationFrame(render);
    };

    render();

    return () => {
      running = false;
      cancelAnimationFrame(stateRef.current.animFrame);
    };
  }, [classId, soundEnabled]);

  // Bắt đầu lượt chọn học sinh
  const handleStart = () => {
    if (!students || students.length === 0) return;

    // Chọn ngẫu nhiên công bằng bằng thuật toán độc lập (crypto)
    const result = pickRandom(students, {
      alreadyPicked: alreadyPickedIds,
      noRepeat,
    });

    if (!result.picked) {
      if (result.exhausted) {
        alert('Tất cả học sinh trong lớp đã được gọi một lượt! Bạn có thể tắt chế độ không lặp để bắt đầu vòng mới.');
      }
      return;
    }

    const targetStudent = result.picked;
    const targetChar = stateRef.current.characters.find(
      (c) => c.student.id === targetStudent.id
    );

    if (!targetChar) return;

    // Đánh dấu mục tiêu
    stateRef.current.characters.forEach((c) => {
      c.isTarget = c.student.id === targetStudent.id;
      c.caught = false;
    });

    stateRef.current.targetCharacter = targetChar;
    stateRef.current.dog.state = 'running';
    stateRef.current.roundId = String(Date.now());

    setPickedStudent(null);
    setGameState('running');
    playBeep(330, 'sine', 0.15); // Tiếng chó thức dậy sủa
  };

  const handleReset = () => {
    setGameState('idle');
    setPickedStudent(null);
    stateRef.current.dog.x = 90;
    stateRef.current.dog.y = 360;
    stateRef.current.dog.state = 'sleeping';
    stateRef.current.targetCharacter = null;
    stateRef.current.characters.forEach((c) => {
      c.isTarget = false;
      c.caught = false;
    });
  };

  if (!currentClass) return null;

  return (
    <div className="min-h-screen bg-pink-50 p-4 flex flex-col items-center justify-center relative select-none">
      {/* Thanh điều khiển trên cùng */}
      <div className="w-full max-w-4xl flex items-center justify-between mb-3 px-2">
        <button
          className="btn-ghost"
          onClick={() => navigate('/games')}
        >
          <ArrowLeft className="w-4 h-4" /> Quay lại Lớp học
        </button>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink cursor-pointer">
            <input
              type="checkbox"
              className="accent-pink-500 w-4 h-4"
              checked={noRepeat}
              onChange={(e) => setNoRepeat(e.target.checked)}
            />
            Không lặp lại học sinh đã chọn
          </label>

          <button
            className="icon-btn"
            onClick={() => setSoundEnabled(!soundEnabled)}
            data-tip={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5 text-pink-600" /> : <VolumeX className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Khung Canvas Trò chơi */}
      <div className="relative card overflow-hidden border-4 border-pink-200 shadow-soft">
        <canvas
          ref={canvasRef}
          width={800}
          height={480}
          className="w-full max-w-[800px] h-auto block bg-white"
        />

        {/* Modal chúc mừng / Hiển thị tên học sinh được bắt kịp */}
        {gameState === 'caught' && pickedStudent && (
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px] flex items-center justify-center p-4 animate-fadeIn">
            <div className="card p-6 bg-white/95 rounded-[28px] text-center max-w-sm w-full shadow-soft animate-pop border-2 border-pink-300">
              <span className="chip bg-pink-100 text-pink-600 font-bold mx-auto mb-2">
                <Sparkles className="w-3.5 h-3.5" /> Chúc mừng bạn đã được chọn!
              </span>

              <div className="my-3 flex justify-center">
                <AnimalAvatarSVG avatarKey={pickedStudent.avatar} size={88} />
              </div>

              <h2 className="font-display font-black text-2xl text-ink">
                {pickedStudent.fullName}
              </h2>
              <p className="text-sm text-ink-soft font-mono mt-0.5">{pickedStudent.code}</p>

              <div className="mt-6 flex gap-2">
                <button
                  className="btn-outline flex-1"
                  onClick={handleReset}
                >
                  <RotateCcw className="w-4 h-4" /> Đặt lại
                </button>
                <button
                  className="btn-primary flex-1"
                  onClick={() => {
                    handleReset();
                    setTimeout(handleStart, 200);
                  }}
                >
                  <Play className="w-4 h-4 fill-white" /> Lượt tiếp theo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Thanh nút hành động phía dưới */}
      <div className="mt-4 flex items-center gap-3">
        <button
          className="btn-primary btn-lg"
          onClick={handleStart}
          disabled={gameState === 'running'}
        >
          <Play className="w-5 h-5 fill-white" /> Bắt đầu chọn học sinh
        </button>

        <button
          className="btn-outline btn-lg"
          onClick={handleReset}
          disabled={gameState === 'idle'}
        >
          <RotateCcw className="w-5 h-5" /> Đặt lại sân trường
        </button>
      </div>
    </div>
  );
}
