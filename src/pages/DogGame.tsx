import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Music,
  Maximize2,
  Minimize2,
  History,
  Trash2,
  Users,
  X,
  UserPlus,
  FastForward,
  Sparkles,
  Dog,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useGamePicks } from '../state/hooks';
import { pickRandom } from '../lib/picker';
import { saveGamePick, clearGamePicks } from '../data/repo';
import { AnimalAvatarSVG } from '../components/avatars';
import { formatDateTimeVN } from '../lib/utils';
import { useToast } from '../components/ToastNotification';
import {
  useGameOrientationAndFullscreen,
  useStageFit,
  LandscapeRotateOverlay,
} from '../components/LandscapeFullscreenGuard';
import type { Student } from '../types';

// ============================================================================
// KIỂU DỮ LIỆU & TRẠNG THÁI TRÒ CHƠI (STATE MACHINE)
// ============================================================================

export type DogGameStage =
  | 'idle'      // Sẵn sàng tại sân trường, chó ngủ, học sinh xếp nhóm ở cổng
  | 'sneak'     // Giai đoạn 1: Các bạn học sinh rón rén đi theo nhóm về phía lớp học
  | 'alarm'     // Giai đoạn 2: Làm rơi chồng sách -> học sinh giật mình -> chó thức giấc tuần tự
  | 'chase'     // Giai đoạn 3: Chú chó đuổi bắt học sinh khắp sân trường (đếm ngược 10s)
  | 'caught'    // Chuyển tiếp: Chọn ngẫu nhiên 1 học sinh hợp lệ & chó chạy tới bắt kịp
  | 'celebrate'; // Giai đoạn 4: Vinh danh học sinh được chọn với pháo giấy, huy hiệu & âm nhạc

export type DogWakeSubState =
  | 'sleeping'  // Đang ngủ thở nhịp nhàng + Zzz
  | 'startled'  // Pha 1: Giật mình nảy nhẹ
  | 'eye_open'  // Pha 2: Mở to mắt ngạc nhiên
  | 'ears_up'   // Pha 3: Dựng đứng hai tai, rung chuông cổ
  | 'barking'   // Pha 4: Đứng dậy sủa "Gâu! Gâu!"
  | 'chasing'   // Đang chạy đuổi bắt
  | 'catching'  // Đang chạy tới bạn được chọn
  | 'happy';    // Ngồi vẫy đuôi vui mừng

export interface ObstacleCircle {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface DogGameStudent {
  student: Student;
  x: number;
  y: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  speed: number;
  gender: 'male' | 'female';
  facing: 1 | -1;
  groupIndex: number;
  delayMoveSec: number;
  stepPhase: number;
  isBookDropper: boolean;
  isSelected: boolean;
  accessoryColor: string;
  hairVariant: number;
  emote: 'none' | 'sneak' | 'shock' | 'panic' | 'cheer';
}

export interface PawPrint {
  x: number;
  y: number;
  angle: number;
  alpha: number;
}

export interface DustPuff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
}

export interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  rotation: number;
  vRot: number;
  shape: 'rect' | 'circle' | 'star';
}

// ============================================================================
// HẰNG SỐ KHÔNG GIAN THẾ GIỚI & VẬT CẢN (WORLD COORDINATES 1000 x 560)
// ============================================================================

export const DOG_GAME_BOUNDS = {
  width: 1000,
  height: 560,
  walkable: {
    minX: 80,
    maxX: 865,
    minY: 295,
    maxY: 500,
  },
  dogBed: {
    x: 805,
    y: 438,
  },
  classroomDoor: {
    x: 755,
    y: 375,
  },
  bookDropSpot: {
    x: 525,
    y: 435,
  },
  obstacles: [
    // Ghế đá bên trái sân trường
    { id: 'bench-left', x: 125, y: 325, radius: 38 },
    // Chậu cây cảnh trước cửa lớp 5A
    { id: 'plant-door', x: 682, y: 382, radius: 32 },
    // Ổ đệm và bát ăn của chú chó khi đang rón rén
    { id: 'dog-bed-zone', x: 815, y: 445, radius: 42 },
    // Bồn hoa góc dưới trái
    { id: 'flower-bottom-left', x: 65, y: 505, radius: 52 },
    // Bồn hoa góc dưới phải
    { id: 'flower-bottom-right', x: 945, y: 500, radius: 52 },
  ] as ObstacleCircle[],
};

const ACCESSORY_PALETTE = [
  '#EC4899', // Hồng dâu
  '#3B82F6', // Xanh dương
  '#F59E0B', // Vàng cam
  '#10B981', // Xanh ngọc
  '#8B5CF6', // Tím khoai môn
  '#EF4444', // Đỏ tươi
];

const ASSETS = {
  boy: {
    sneak: '/assets/game/boy_sneak.png',
    alarm: '/assets/game/boy_alarm.png',
    run: '/assets/game/boy_run.png',
    celebrate: '/assets/game/boy_celebrate.png',
  },
  girl: {
    sneak: '/assets/game/girl_sneak.png',
    alarm: '/assets/game/girl_alarm.png',
    run: '/assets/game/girl_run.png',
    celebrate: '/assets/game/girl_celebrate.png',
  },
  corgi: {
    sleep: '/assets/game/corgi_sleep.png',
    alarm: '/assets/game/corgi_alarm.png',
    run: '/assets/game/corgi_run.png',
    happy: '/assets/game/corgi_happy.png',
  },
};

// ============================================================================
// CÁC HÀM LOGIC THUẦN KHIẾT (PURE FUNCTIONS) PHỤC VỤ GAME & UNIT TEST
// ============================================================================

/**
 * Xác định trạng thái thức giấc tuần tự của chú chó trong Giai đoạn 2 (Alarm):
 * đang ngủ -> giật mình -> mở mắt -> dựng tai -> sủa
 */
export function stepDogWakeSequence(elapsedAlarmSec: number): DogWakeSubState {
  if (elapsedAlarmSec < 0) return 'sleeping';
  if (elapsedAlarmSec < 0.35) return 'startled';
  if (elapsedAlarmSec < 0.72) return 'eye_open';
  if (elapsedAlarmSec < 1.12) return 'ears_up';
  return 'barking';
}

/**
 * Kẹp tọa độ nhân vật nằm trong vùng sân trường hợp lệ và đẩy ra khỏi các vật cản
 * (hàng rào, ghế đá, chậu cây, bồn hoa) để không đi xuyên vật thể hoặc thoát khỏi sân.
 */
export function clampAndAvoidObstacles(
  x: number,
  y: number,
  ignoreBedZone = false
): { x: number; y: number } {
  const { minX, maxX, minY, maxY } = DOG_GAME_BOUNDS.walkable;
  let nx = Math.min(maxX, Math.max(minX, x));
  let ny = Math.min(maxY, Math.max(minY, y));

  for (const obs of DOG_GAME_BOUNDS.obstacles) {
    if (ignoreBedZone && obs.id === 'dog-bed-zone') continue;
    const dx = nx - obs.x;
    const dy = ny - obs.y;
    const dist = Math.hypot(dx, dy);
    if (dist < obs.radius) {
      const safeDist = obs.radius + 2;
      const angle = dist > 0.001 ? Math.atan2(dy, dx) : -Math.PI / 4;
      nx = obs.x + Math.cos(angle) * safeDist;
      ny = obs.y + Math.sin(angle) * safeDist;
    }
  }

  nx = Math.min(maxX, Math.max(minX, nx));
  ny = Math.min(maxY, Math.max(minY, ny));
  return { x: nx, y: ny };
}

/**
 * Tính toán vị trí xuất phát theo từng nhóm nhỏ so le (staggered waves)
 * cho tối đa 20+ học sinh để bước vào lớp tự nhiên như video mẫu.
 */
export function calculateSneakSpawnSlots(total: number): Array<{
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  groupIndex: number;
  delayMoveSec: number;
}> {
  if (total <= 0) return [];
  const slots: Array<{
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    groupIndex: number;
    delayMoveSec: number;
  }> = [];

  const groupSize = 4;
  for (let i = 0; i < total; i++) {
    const groupIndex = Math.floor(i / groupSize);
    const indexInGroup = i % groupSize;

    // Hàng tiền cảnh đi rón rén từ trái sang phải (giống hệt panel 1)
    // Các nhóm sau xuất phát từ khu vực cổng trường tiến xuống sân
    let rawX: number;
    let rawY: number;
    let targetX: number;
    let targetY: number;

    if (i < 7) {
      // Hàng 1 (Tiền cảnh): 7 học sinh đi rón rén thành hàng ngang trên lối đi chính
      rawX = 90 + i * 74;
      rawY = 448 + ((i % 2) * 16 - 8);
      targetX = Math.min(650, rawX + 135);
      targetY = rawY + ((i % 2 === 0 ? -1 : 1) * 4);
    } else if (i < 14) {
      // Hàng 2 (Trung cảnh): 7 học sinh đi so le ở giữa sân trường
      const midIdx = i - 7;
      rawX = 115 + midIdx * 72;
      rawY = 382 + ((midIdx % 2) * 14 - 7);
      targetX = Math.min(630, rawX + 115);
      targetY = Math.min(480, rawY + 16);
    } else {
      // Hàng 3 (Hậu cảnh): 6 học sinh bước từ cổng trường tiến xuống sân
      const backIdx = i - 14;
      rawX = 160 + backIdx * 70;
      rawY = 320 + ((backIdx % 2) * 10 - 5);
      targetX = Math.min(590, rawX + 95);
      targetY = Math.min(440, rawY + 28);
    }

    const clampedStart = clampAndAvoidObstacles(rawX, rawY);
    const clampedTarget = clampAndAvoidObstacles(targetX, targetY);

    slots.push({
      x: clampedStart.x,
      y: clampedStart.y,
      targetX: clampedTarget.x,
      targetY: clampedTarget.y,
      groupIndex,
      delayMoveSec: groupIndex * 0.28 + indexInGroup * 0.08,
    });
  }

  return slots;
}

/**
 * Rút gọn họ tên hiển thị trên nhãn đầu nhân vật để không quá dài gây chồng lấn,
 * nhưng vẫn giữ rõ tên đệm + tên chính (VD: "Nguyễn Minh An" -> "Minh An").
 */
export function formatStudentBadgeName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 2) return fullName.trim();
  return parts.slice(-2).join(' ');
}

// ============================================================================
// COMPONENT CHÍNH: MINIGAME "CHÚ CHÓ ĐUỔI BẮT"
// ============================================================================

export default function DogGamePage() {
  const navigate = useNavigate();
  const { currentClass, settings } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const picks = useGamePicks(classId);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mainStageRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Cấu hình trò chơi
  const [noRepeat, setNoRepeat] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  // Trạng thái máy trạng thái (State Machine)
  const [stage, setStage] = useState<DogGameStage>('idle');
  const [isPaused, setIsPaused] = useState(false);
  const [countdown, setCountdown] = useState<number>(10);
  const [pickedStudent, setPickedStudent] = useState<Student | null>(null);
  const [roundExhausted, setRoundExhausted] = useState(false);

  // Lưu trạng thái đang chạy trước khi xoay dọc để bảo toàn tiến trình
  const wasPlayingBeforeRotateRef = useRef<boolean>(false);

  // Hook quản lý xoay ngang bắt buộc và toàn màn hình
  const {
    isPortrait,
    isCompactLandscape,
    showRotateOverlay,
    isFullscreen,
    isPseudoFullscreen,
    requestGameFullscreen,
    toggleGameFullscreen,
    lockLandscape,
  } = useGameOrientationAndFullscreen(containerRef, {
    onOrientationToPortrait: () => {
      // Khi xoay dọc giữa trận: tự động tạm dừng đồng hồ đếm ngược và hoạt ảnh
      if (stage !== 'idle' && stage !== 'celebrate' && !isPaused) {
        wasPlayingBeforeRotateRef.current = true;
        setIsPaused(true);
      }
    },
    onOrientationToLandscape: () => {
      // Khi xoay ngang lại: lớp phủ tự ẩn, giữ nguyên trạng thái tạm dừng để người dùng tiếp tục
    },
  });

  const isLandscape = !isPortrait;
  const stageSize = useStageFit(mainStageRef, 1000 / 560);

  // Danh sách ID đã được gọi tên trong lớp
  const alreadyPickedIds = useMemo(() => {
    return (picks ?? []).map((p) => p.studentId);
  }, [picks]);

  const activeStudentIds = useMemo(() => {
    return new Set((students ?? []).map((s) => s.id));
  }, [students]);

  const validPickedCount = useMemo(() => {
    const uniquePicked = new Set(alreadyPickedIds.filter((id) => activeStudentIds.has(id)));
    return uniquePicked.size;
  }, [alreadyPickedIds, activeStudentIds]);

  const totalStudents = students?.length ?? 0;

  // Refs quản lý Audio & Timers để dọn dẹp triệt để không rò rỉ tài nguyên
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bgmTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageTimeoutRefs = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const lastTimeRef = useRef<number>(performance.now());

  // Bộ nhớ trạng thái thế giới 2D Canvas
  const stateRef = useRef({
    stage: 'idle' as DogGameStage,
    isPaused: false,
    elapsedStageSec: 0,
    totalTimeSec: 0,
    countdown: 10,
    students: [] as DogGameStudent[],
    pawPrints: [] as PawPrint[],
    dustPuffs: [] as DustPuff[],
    confetti: [] as ConfettiParticle[],
    bookDrop: {
      active: false,
      x: DOG_GAME_BOUNDS.bookDropSpot.x,
      y: DOG_GAME_BOUNDS.bookDropSpot.y,
      fallProgress: 0, // 0 -> 1
      impactBurst: 0,
    },
    dog: {
      x: DOG_GAME_BOUNDS.dogBed.x,
      y: DOG_GAME_BOUNDS.dogBed.y,
      vx: 0,
      vy: 0,
      speed: 235, // px/giây (nhanh hơn tốc độ chạy 135-160 px/s của học sinh)
      facing: -1 as 1 | -1, // -1: nhìn sang trái về phía học sinh, 1: nhìn sang phải
      subState: 'sleeping' as DogWakeSubState,
      animPhase: 0,
      earTwitch: 0,
      breathScale: 1,
      barkWaveRadius: 0,
      chaseTargetIndex: 0,
      retargetTimer: 0,
      pawStepAccum: 0,
    },
    selectedStudentId: null as string | null,
    roundId: '',
  });

  // Nạp trước các sprite PNG trong trẻo
  useEffect(() => {
    const loadImg = (key: string, src: string) => {
      const img = new Image();
      img.src = src;
      imagesRef.current[key] = img;
    };

    loadImg('boy_sneak', ASSETS.boy.sneak);
    loadImg('boy_alarm', ASSETS.boy.alarm);
    loadImg('boy_run', ASSETS.boy.run);
    loadImg('boy_celebrate', ASSETS.boy.celebrate);

    loadImg('girl_sneak', ASSETS.girl.sneak);
    loadImg('girl_alarm', ASSETS.girl.alarm);
    loadImg('girl_run', ASSETS.girl.run);
    loadImg('girl_celebrate', ASSETS.girl.celebrate);

    loadImg('corgi_sleep', ASSETS.corgi.sleep);
    loadImg('corgi_alarm', ASSETS.corgi.alarm);
    loadImg('corgi_run', ASSETS.corgi.run);
    loadImg('corgi_happy', ASSETS.corgi.happy);
  }, []);

  // Đồng bộ React state -> Ref
  useEffect(() => {
    stateRef.current.stage = stage;
  }, [stage]);

  useEffect(() => {
    stateRef.current.isPaused = isPaused;
    if (!isPaused) {
      lastTimeRef.current = performance.now();
    }
  }, [isPaused]);

  useEffect(() => {
    stateRef.current.countdown = countdown;
  }, [countdown]);

  // =========================================================================
  // HỆ THỐNG ÂM THANH WEB AUDIO SYNTHESIZER (TIẾNG BƯỚC CHÂN, SÁCH RƠI, CHÓ SỦA, NHẠC NỀN)
  // =========================================================================
  const getAudioContext = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const playSfx = useCallback(
    (type: 'tiptoe' | 'book_drop' | 'startle' | 'bark' | 'tick' | 'caught' | 'fanfare') => {
      if (!soundEnabled) return;
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      try {
        if (type === 'tiptoe') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(320, now);
          osc.frequency.exponentialRampToValueAtTime(180, now + 0.06);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.07);
        } else if (type === 'book_drop') {
          // Tiếng sách rơi "BỘP!" trầm ấm
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(190, now);
          osc.frequency.exponentialRampToValueAtTime(52, now + 0.22);
          gain.gain.setValueAtTime(0.22, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.25);
        } else if (type === 'startle') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(420, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.2);
        } else if (type === 'bark') {
          // Hai tiếng sủa "Gâu! Gâu!" đáng yêu của chú chó Corgi
          [0, 0.22].forEach((offset) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(360, now + offset);
            osc.frequency.exponentialRampToValueAtTime(520, now + offset + 0.06);
            osc.frequency.exponentialRampToValueAtTime(210, now + offset + 0.16);
            gain.gain.setValueAtTime(0.18, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.17);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.18);
          });
        } else if (type === 'tick') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(720, now);
          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.06);
        } else if (type === 'caught') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.25);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.28);
        } else if (type === 'fanfare') {
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((freq, idx) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'triangle';
            o.frequency.setValueAtTime(freq, now + idx * 0.11);
            g.gain.setValueAtTime(0.15, now + idx * 0.11);
            g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.38);
            o.connect(g);
            g.connect(ctx.destination);
            o.start(now + idx * 0.11);
            o.stop(now + idx * 0.11 + 0.4);
          });
        }
      } catch {
        // Bỏ qua nếu trình duyệt chặn tự động phát âm thanh
      }
    },
    [soundEnabled, getAudioContext]
  );

  // Nhạc nền Kawaii theo từng giai đoạn (Rón rén nhẹ nhàng -> Đuổi bắt sôi động)
  useEffect(() => {
    if (bgmTimerRef.current) {
      clearInterval(bgmTimerRef.current);
      bgmTimerRef.current = null;
    }

    if (!soundEnabled || !musicEnabled || isPaused) return;
    if (stage !== 'sneak' && stage !== 'chase') return;

    let step = 0;
    const sneakNotes = [261.63, 0, 329.63, 0, 392.0, 0, 329.63, 0];
    const chaseNotes = [392.0, 440.0, 523.25, 587.33, 659.25, 587.33, 523.25, 440.0];
    const intervalMs = stage === 'sneak' ? 320 : 165;

    bgmTimerRef.current = setInterval(() => {
      const ctx = getAudioContext();
      if (!ctx) return;
      const notes = stage === 'sneak' ? sneakNotes : chaseNotes;
      const freq = notes[step % notes.length];
      step++;
      if (freq <= 0) return;

      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = stage === 'sneak' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(stage === 'sneak' ? 0.025 : 0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.13);
      } catch {
        // ignore
      }
    }, intervalMs);

    return () => {
      if (bgmTimerRef.current) {
        clearInterval(bgmTimerRef.current);
        bgmTimerRef.current = null;
      }
    };
  }, [stage, soundEnabled, musicEnabled, isPaused, getAudioContext]);

  // Helper dọn dẹp mọi timer của lượt chơi
  const clearAllTimers = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (bgmTimerRef.current) {
      clearInterval(bgmTimerRef.current);
      bgmTimerRef.current = null;
    }
    stageTimeoutRefs.current.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    stageTimeoutRefs.current = [];
  }, []);

  // Dọn dẹp AudioContext & Timers khi unmount
  useEffect(() => {
    return () => {
      clearAllTimers();
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [clearAllTimers]);

  // =========================================================================
  // KHỞI TẠO & ĐỒNG BỘ DANH SÁCH HỌC SINH TRÊN SÂN TRƯỜNG
  // =========================================================================
  const initStudentsOnYard = useCallback((studentList: Student[]) => {
    const slots = calculateSneakSpawnSlots(studentList.length);
    // Chọn 1 bạn ở hàng đầu gần vị trí rơi sách nhất làm người vô tình làm rơi chồng sách
    let dropperIdx = 0;
    let minBookDist = Infinity;
    slots.forEach((slot, idx) => {
      const d = Math.hypot(
        slot.targetX - DOG_GAME_BOUNDS.bookDropSpot.x,
        slot.targetY - DOG_GAME_BOUNDS.bookDropSpot.y
      );
      if (d < minBookDist) {
        minBookDist = d;
        dropperIdx = idx;
      }
    });

    const chars: DogGameStudent[] = studentList.map((s, idx) => {
      const slot = slots[idx] || {
        x: 200,
        y: 400,
        targetX: 400,
        targetY: 400,
        groupIndex: 0,
        delayMoveSec: 0,
      };
      return {
        student: s,
        x: slot.x,
        y: slot.y,
        startX: slot.x,
        startY: slot.y,
        targetX: slot.targetX,
        targetY: slot.targetY,
        vx: 0,
        vy: 0,
        speed: 48 + (idx % 4) * 5, // tốc độ đi bộ rón rén nhẹ nhàng
        gender: s.gender === 'female' ? 'female' : 'male',
        facing: 1,
        groupIndex: slot.groupIndex,
        delayMoveSec: slot.delayMoveSec,
        stepPhase: (idx * 0.85) % (Math.PI * 2),
        isBookDropper: idx === dropperIdx,
        isSelected: false,
        accessoryColor: ACCESSORY_PALETTE[idx % ACCESSORY_PALETTE.length],
        hairVariant: idx % 3,
        emote: 'none',
      };
    });

    stateRef.current.students = chars;
    stateRef.current.pawPrints = [];
    stateRef.current.dustPuffs = [];
    stateRef.current.confetti = [];
    stateRef.current.bookDrop = {
      active: false,
      x: DOG_GAME_BOUNDS.bookDropSpot.x,
      y: DOG_GAME_BOUNDS.bookDropSpot.y,
      fallProgress: 0,
      impactBurst: 0,
    };
    stateRef.current.dog = {
      x: DOG_GAME_BOUNDS.dogBed.x,
      y: DOG_GAME_BOUNDS.dogBed.y,
      vx: 0,
      vy: 0,
      speed: 240,
      facing: -1,
      subState: 'sleeping',
      animPhase: 0,
      earTwitch: 0,
      breathScale: 1,
      barkWaveRadius: 0,
      chaseTargetIndex: 0,
      retargetTimer: 0,
      pawStepAccum: 0,
    };
    stateRef.current.selectedStudentId = null;
  }, []);

  useEffect(() => {
    if (!students) return;

    if (stage === 'idle') {
      initStudentsOnYard(students);
    } else {
      // Bảo vệ trường hợp biên: nếu học sinh đang chơi bị xóa hoặc lưu trữ giữa chừng
      const activeMap = new Map(students.map((s) => [s.id, s]));
      stateRef.current.students = stateRef.current.students
        .filter((c) => activeMap.has(c.student.id))
        .map((c) => ({
          ...c,
          student: activeMap.get(c.student.id)!,
        }));

      // Nếu mục tiêu đã chọn bị xóa giữa lượt, hủy an toàn và quay về idle
      if (
        stateRef.current.selectedStudentId &&
        !activeMap.has(stateRef.current.selectedStudentId)
      ) {
        clearAllTimers();
        setStage('idle');
        setPickedStudent(null);
        initStudentsOnYard(students);
      }
    }
  }, [students, stage, initStudentsOnYard, clearAllTimers]);

  // Kiểm tra trạng thái hết vòng (No Repeat Exhausted)
  useEffect(() => {
    if (!students || students.length === 0) {
      setRoundExhausted(false);
      return;
    }
    if (noRepeat) {
      const check = pickRandom(students, { noRepeat: true, alreadyPicked: alreadyPickedIds });
      setRoundExhausted(check.exhausted);
    } else {
      setRoundExhausted(false);
    }
  }, [students, noRepeat, alreadyPickedIds]);

  // =========================================================================
  // ĐIỀU PHỐI DIỄN BIẾN 4 GIAI ĐOẠN TRÒ CHƠI
  // =========================================================================

  const spawnCelebrationConfetti = useCallback(() => {
    const colors = ['#F43F5E', '#3B82F6', '#F59E0B', '#10B981', '#A855F7', '#EC4899', '#FACC15'];
    const shapes: Array<'rect' | 'circle' | 'star'> = ['rect', 'circle', 'star'];
    const particles: ConfettiParticle[] = [];
    for (let i = 0; i < 85; i++) {
      particles.push({
        x: 500 + (Math.random() - 0.5) * 680,
        y: -20 - Math.random() * 220,
        vx: (Math.random() - 0.5) * 90,
        vy: 95 + Math.random() * 140,
        color: colors[i % colors.length],
        size: 6 + Math.random() * 6,
        alpha: 1,
        rotation: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 6,
        shape: shapes[i % shapes.length],
      });
    }
    stateRef.current.confetti = particles;
  }, []);

  /**
   * Kết thúc Giai đoạn 3 (Đuổi bắt) -> Chọn ngẫu nhiên 1 học sinh hợp lệ từ danh sách lớp
   * -> Chú chó chạy tới bắt kịp học sinh đó -> Chuyển sang Giai đoạn 4 (Vinh danh)
   */
  const finishChaseAndSelectStudent = useCallback(() => {
    clearAllTimers();

    if (!students || students.length === 0 || !classId) {
      setStage('idle');
      return;
    }

    const res = pickRandom(students, {
      noRepeat,
      alreadyPicked: alreadyPickedIds,
    });

    if (res.exhausted || !res.picked) {
      setRoundExhausted(true);
      setStage('idle');
      toast.info('Tất cả học sinh trong lớp đã được gọi trong vòng này!');
      return;
    }

    const chosen = res.picked;
    const roundId = `dog_${Date.now()}`;
    stateRef.current.roundId = roundId;
    stateRef.current.selectedStudentId = chosen.id;

    // Đánh dấu nhân vật được chọn trên sân
    const stList = stateRef.current.students;
    let chosenChar = stList.find((c) => c.student.id === chosen.id);
    if (!chosenChar && stList.length > 0) {
      chosenChar = stList[0];
    }

    stList.forEach((c) => {
      c.isSelected = c.student.id === chosen.id;
      if (c.isSelected) {
        c.x = 490;
        c.y = 415;
        c.vx = 0;
        c.vy = 0;
        c.emote = 'shock';
      } else {
        c.vx = 0;
        c.vy = 0;
        c.emote = 'cheer';
      }
    });

    stateRef.current.stage = 'caught';
    stateRef.current.elapsedStageSec = 0;
    stateRef.current.dog.subState = 'catching';
    setStage('caught');
    playSfx('caught');

    // Sau 1.05s (tự động đóng băng tiến trình nếu tạm dừng / xoay dọc) khi chú chó đã chạy tới sát bạn được chọn -> Mở màn Vinh danh (Giai đoạn 4)
    let elapsedCaughtMs = 0;
    const tCelebrate = setInterval(() => {
      if (stateRef.current.isPaused) return;
      elapsedCaughtMs += 50;
      if (elapsedCaughtMs < 1050) return;
      clearInterval(tCelebrate);

      // Kiểm tra lại học sinh vẫn còn hợp lệ trong lớp
      const stillValid = (students ?? []).some((s) => s.id === chosen.id);
      if (!stillValid) {
        setStage('idle');
        return;
      }

      // Xếp các bạn học sinh còn lại thành 2 hàng hai bên vỗ tay chúc mừng giống hệt panel 4
      const others = stateRef.current.students.filter((c) => c.student.id !== chosen.id);
      others.forEach((c, idx) => {
        const isLeftCrowd = idx % 2 === 0;
        const sideIdx = Math.floor(idx / 2);
        const col = sideIdx % 3;
        const row = Math.floor(sideIdx / 3);
        if (isLeftCrowd) {
          c.x = 95 + col * 68 + (row % 2) * 20;
          c.y = 355 + row * 48;
          c.facing = 1;
        } else {
          c.x = 760 + col * 64 - (row % 2) * 18;
          c.y = 355 + row * 48;
          c.facing = -1;
        }
        c.emote = 'cheer';
      });

      // Đặt chú chó Corgi ngồi vui mừng phía trước giống panel 4
      stateRef.current.dog.x = 295;
      stateRef.current.dog.y = 465;
      stateRef.current.dog.facing = 1;
      stateRef.current.dog.subState = 'happy';

      setPickedStudent(chosen);
      setStage('celebrate');
      stateRef.current.stage = 'celebrate';
      stateRef.current.elapsedStageSec = 0;
      spawnCelebrationConfetti();
      playSfx('fanfare');

      saveGamePick(classId, chosen, roundId).catch(() => {});
    }, 50);

    stageTimeoutRefs.current.push(tCelebrate as unknown as ReturnType<typeof setTimeout>);
  }, [students, classId, noRepeat, alreadyPickedIds, clearAllTimers, playSfx, spawnCelebrationConfetti, toast]);

  /**
   * Bắt đầu Giai đoạn 3: Chú chó đuổi bắt (10 giây đếm ngược)
   */
  const startStage3Chase = useCallback(() => {
    stateRef.current.stage = 'chase';
    stateRef.current.elapsedStageSec = 0;
    stateRef.current.dog.subState = 'chasing';
    stateRef.current.dog.chaseTargetIndex = 0;
    stateRef.current.dog.retargetTimer = 0;

    // Học sinh tỏa ra chạy khắp sân trường với vận tốc chạy nhanh
    stateRef.current.students.forEach((c, idx) => {
      c.emote = 'panic';
      c.speed = 132 + (idx % 5) * 9;
      const angle = ((idx * 137.5) % 360) * (Math.PI / 180);
      const tx = 200 + ((idx * 97) % 580);
      const ty = 315 + ((idx * 67) % 170);
      const safe = clampAndAvoidObstacles(tx, ty, true);
      c.targetX = safe.x;
      c.targetY = safe.y;
      c.vx = Math.cos(angle) * c.speed;
      c.vy = Math.sin(angle) * c.speed;
    });

    setCountdown(10);
    setStage('chase');
  }, []);

  /**
   * Bắt đầu Giai đoạn 2: Tiếng động bất ngờ (rơi chồng sách -> học sinh giật mình -> chó thức giấc tuần tự)
   */
  const startStage2Alarm = useCallback(() => {
    stateRef.current.stage = 'alarm';
    stateRef.current.elapsedStageSec = 0;
    stateRef.current.bookDrop = {
      active: true,
      x: DOG_GAME_BOUNDS.bookDropSpot.x,
      y: DOG_GAME_BOUNDS.bookDropSpot.y,
      fallProgress: 0,
      impactBurst: 1,
    };

    // Học sinh dừng lại, giật mình và quay đầu nhìn về phía sách rơi & chú chó
    stateRef.current.students.forEach((c) => {
      c.vx = 0;
      c.vy = 0;
      c.emote = 'shock';
      c.facing = c.x < DOG_GAME_BOUNDS.dogBed.x ? 1 : -1;
    });

    stateRef.current.dog.subState = 'startled';
    setStage('alarm');
    playSfx('book_drop');

    const tStartleSfx = setTimeout(() => {
      if (!stateRef.current.isPaused && stateRef.current.stage === 'alarm') {
        playSfx('startle');
      }
    }, 360);

    const tBarkSfx = setTimeout(() => {
      if (!stateRef.current.isPaused && stateRef.current.stage === 'alarm') {
        playSfx('bark');
      }
    }, 1120);

    stageTimeoutRefs.current.push(tStartleSfx, tBarkSfx);
  }, [playSfx]);

  /**
   * Bắt đầu lượt chơi từ Giai đoạn 1: Học sinh rón rén vào lớp
   */
  const handleStartGame = useCallback(async () => {
    // Tận dụng user gesture để gọi Fullscreen và khóa xoay ngang
    requestGameFullscreen().catch(() => {});

    if (!students || students.length === 0 || !classId) return;

    // Nếu chế độ không lặp đã gọi hết cả lớp, tự động mở vòng mới khi giáo viên bấm Bắt đầu vòng mới
    if (noRepeat) {
      const check = pickRandom(students, { noRepeat: true, alreadyPicked: alreadyPickedIds });
      if (check.exhausted) {
        await clearGamePicks(classId);
        setRoundExhausted(false);
        toast.info('Đã bắt đầu vòng gọi tên mới cho cả lớp!');
      }
    }

    clearAllTimers();
    initStudentsOnYard(students);
    setPickedStudent(null);
    setIsPaused(false);
    setCountdown(10);

    // Chuyển sang Giai đoạn 1: Rón rén vào lớp
    stateRef.current.stage = 'sneak';
    stateRef.current.elapsedStageSec = 0;
    stateRef.current.students.forEach((c) => {
      c.emote = 'sneak';
      c.facing = 1;
    });
    stateRef.current.dog.subState = 'sleeping';
    setStage('sneak');
    playSfx('tiptoe');
  }, [students, classId, noRepeat, alreadyPickedIds, clearAllTimers, initStudentsOnYard, playSfx, toast]);

  /**
   * Quản lý đồng hồ đếm ngược 10 giây trong Giai đoạn 3 (Chase)
   */
  useEffect(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }

    if (stage !== 'chase' || isPaused) return;

    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          finishChaseAndSelectStudent();
          return 0;
        }
        playSfx('tick');
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [stage, isPaused, finishChaseAndSelectStudent, playSfx]);

  /**
   * Tạm dừng / Tiếp tục trò chơi
   */
  const handleTogglePause = useCallback(() => {
    if (stage === 'idle' || stage === 'celebrate') return;
    setIsPaused((prev) => !prev);
  }, [stage]);

  /**
   * Đặt lại / Chơi lại từ đầu
   */
  const handleResetGame = useCallback(() => {
    clearAllTimers();
    setIsPaused(false);
    setPickedStudent(null);
    setCountdown(10);
    setStage('idle');
    stateRef.current.stage = 'idle';
    stateRef.current.elapsedStageSec = 0;
    if (students) {
      initStudentsOnYard(students);
    }
  }, [clearAllTimers, students, initStudentsOnYard]);

  /**
   * Bắt đầu vòng mới (Xóa lịch sử đã gọi)
   */
  const handleClearHistory = useCallback(async () => {
    if (!classId) return;
    await clearGamePicks(classId);
    setRoundExhausted(false);
    toast.info('Đã làm mới lịch sử gọi tên để bắt đầu vòng mới!');
  }, [classId, toast]);

  /**
   * Chuyển đổi Toàn màn hình
   */
  const handleToggleFullscreen = useCallback(() => {
    toggleGameFullscreen().catch(() => {});
  }, [toggleGameFullscreen]);

  // =========================================================================
  // VÒNG LẶP GAME 2D CANVAS (UPDATE VẬT LÝ THEO DELTA TIME & VẼ ĐA LỚP)
  // =========================================================================
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let active = true;
    lastTimeRef.current = performance.now();

    const updateWorld = (dt: number) => {
      const st = stateRef.current;
      if (st.isPaused) return;

      st.totalTimeSec += dt;
      st.elapsedStageSec += dt;

      // 1. Cập nhật theo từng giai đoạn của State Machine
      if (st.stage === 'idle') {
        st.dog.subState = 'sleeping';
        st.dog.animPhase += dt * 2.2;
        st.dog.breathScale = 1 + Math.sin(st.dog.animPhase) * 0.035;
        st.dog.earTwitch = Math.sin(st.totalTimeSec * 7) > 0.92 ? 0.18 : 0;

        st.students.forEach((c) => {
          c.stepPhase += dt * 2.4;
        });
      } else if (st.stage === 'sneak') {
        // Giai đoạn 1: Học sinh rón rén đi bộ theo nhóm về phía cửa lớp
        st.dog.subState = 'sleeping';
        st.dog.animPhase += dt * 2.4;
        st.dog.breathScale = 1 + Math.sin(st.dog.animPhase) * 0.04;
        st.dog.earTwitch = Math.sin(st.totalTimeSec * 8) > 0.88 ? 0.22 : 0;

        st.students.forEach((c) => {
          if (st.elapsedStageSec < c.delayMoveSec) {
            c.stepPhase += dt * 2;
            return;
          }
          const dx = c.targetX - c.x;
          const dy = c.targetY - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 4) {
            const ux = dx / dist;
            const uy = dy / dist;
            const nextPos = clampAndAvoidObstacles(
              c.x + ux * c.speed * dt,
              c.y + uy * c.speed * dt,
              false
            );
            c.x = nextPos.x;
            c.y = nextPos.y;
            c.facing = ux >= -0.05 ? 1 : -1;
            c.stepPhase += dt * 7.5;
          } else {
            c.stepPhase += dt * 3;
          }
        });

        // Sau 3.1 giây rón rén -> Tự động kích hoạt sự kiện Giai đoạn 2: Làm rơi chồng sách!
        if (st.elapsedStageSec >= 3.1) {
          startStage2Alarm();
        }
      } else if (st.stage === 'alarm') {
        // Giai đoạn 2: Chồng sách rơi xuống nền sân -> Học sinh giật mình -> Chó thức giấc tuần tự
        st.bookDrop.fallProgress = Math.min(1, st.bookDrop.fallProgress + dt * 4.2);
        st.bookDrop.impactBurst = Math.max(0, st.bookDrop.impactBurst - dt * 1.4);

        const nextDogSub = stepDogWakeSequence(st.elapsedStageSec);
        st.dog.subState = nextDogSub;
        st.dog.animPhase += dt * 8;
        if (nextDogSub === 'barking') {
          st.dog.barkWaveRadius = ((st.elapsedStageSec - 1.12) * 140) % 95;
        }

        st.students.forEach((c) => {
          c.stepPhase += dt * 9;
        });

        // Sau 1.85 giây hoàn tất chuỗi thức giấc & sủa -> Chuyển sang Giai đoạn 3: Đuổi bắt!
        if (st.elapsedStageSec >= 1.85) {
          startStage3Chase();
        }
      } else if (st.stage === 'chase') {
        // Giai đoạn 3: Chú chó đuổi bắt sôi động trên sân trường
        st.dog.subState = 'chasing';
        st.dog.animPhase += dt * 14;
        st.dog.retargetTimer += dt;

        // Đổi mục tiêu rượt đuổi mỗi 1.8s để chú chó chạy quanh sân sinh động
        if (st.students.length > 0 && st.dog.retargetTimer >= 1.8) {
          st.dog.retargetTimer = 0;
          st.dog.chaseTargetIndex = (st.dog.chaseTargetIndex + 1) % st.students.length;
        }

        // Cập nhật di chuyển của từng học sinh (chạy + tránh vật cản + tách nhóm không chồng lấn)
        for (let i = 0; i < st.students.length; i++) {
          const c = st.students[i];
          const dxTarget = c.targetX - c.x;
          const dyTarget = c.targetY - c.y;
          const distTarget = Math.hypot(dxTarget, dyTarget);

          // Nếu đã gần điểm đến hoặc chú chó chạy tới quá gần -> chọn điểm chạy trốn mới
          const dxDog = c.x - st.dog.x;
          const dyDog = c.y - st.dog.y;
          const distDog = Math.hypot(dxDog, dyDog);

          if (distTarget < 28 || distDog < 135) {
            const fleeAngle =
              distDog < 135
                ? Math.atan2(dyDog, dxDog) + (Math.random() - 0.5) * 1.1
                : Math.random() * Math.PI * 2;
            const rawTx = c.x + Math.cos(fleeAngle) * (150 + Math.random() * 140);
            const rawTy = c.y + Math.sin(fleeAngle) * (85 + Math.random() * 75);
            const safeT = clampAndAvoidObstacles(rawTx, rawTy, true);
            c.targetX = safeT.x;
            c.targetY = safeT.y;
          }

          // Lực tách nhau (Separation force) để 20 học sinh không bao giờ chụm vào 1 điểm
          let sepX = 0;
          let sepY = 0;
          for (let j = 0; j < st.students.length; j++) {
            if (i === j) continue;
            const other = st.students[j];
            const odx = c.x - other.x;
            const ody = c.y - other.y;
            const odist = Math.hypot(odx, ody);
            if (odist > 0.01 && odist < 48) {
              const push = (48 - odist) / 48;
              sepX += (odx / odist) * push * 95;
              sepY += (ody / odist) * push * 95;
            }
          }

          const dirX = distTarget > 1 ? dxTarget / distTarget : 0;
          const dirY = distTarget > 1 ? dyTarget / distTarget : 0;

          const desiredVx = dirX * c.speed + sepX;
          const desiredVy = dirY * c.speed + sepY;

          c.vx += (desiredVx - c.vx) * Math.min(1, dt * 6);
          c.vy += (desiredVy - c.vy) * Math.min(1, dt * 6);

          const nextPos = clampAndAvoidObstacles(c.x + c.vx * dt, c.y + c.vy * dt, true);
          c.x = nextPos.x;
          c.y = nextPos.y;
          if (Math.abs(c.vx) > 6) {
            c.facing = c.vx > 0 ? 1 : -1;
          }
          c.stepPhase += dt * 13;

          // Tạo cụm bụi nhỏ dưới chân học sinh khi chạy
          if (Math.random() < dt * 3.2) {
            st.dustPuffs.push({
              x: c.x - c.facing * 12,
              y: c.y + 24,
              vx: -c.facing * (15 + Math.random() * 15),
              vy: -5 - Math.random() * 10,
              radius: 5 + Math.random() * 4,
              alpha: 0.65,
            });
          }
        }

        // Cập nhật chuyển động mượt của chú chó Corgi đuổi theo mục tiêu
        const targetChar =
          st.students[st.dog.chaseTargetIndex % Math.max(1, st.students.length)];
        const dogTargetX = targetChar ? targetChar.x : 480;
        const dogTargetY = targetChar ? targetChar.y : 400;

        const ddx = dogTargetX - st.dog.x;
        const ddy = dogTargetY - st.dog.y;
        const ddist = Math.hypot(ddx, ddy);
        if (ddist > 8) {
          const desiredDogVx = (ddx / ddist) * st.dog.speed;
          const desiredDogVy = (ddy / ddist) * st.dog.speed;
          st.dog.vx += (desiredDogVx - st.dog.vx) * Math.min(1, dt * 7.5);
          st.dog.vy += (desiredDogVy - st.dog.vy) * Math.min(1, dt * 7.5);

          const nextDog = clampAndAvoidObstacles(
            st.dog.x + st.dog.vx * dt,
            st.dog.y + st.dog.vy * dt,
            true
          );
          const stepMoved = Math.hypot(nextDog.x - st.dog.x, nextDog.y - st.dog.y);
          st.dog.x = nextDog.x;
          st.dog.y = nextDog.y;
          st.dog.pawStepAccum += stepMoved;

          if (Math.abs(st.dog.vx) > 8) {
            st.dog.facing = st.dog.vx > 0 ? 1 : -1;
          }

          // Để lại dấu chân cún và bụi chạy giống hệt panel 3
          if (st.dog.pawStepAccum >= 38) {
            st.dog.pawStepAccum = 0;
            st.pawPrints.push({
              x: st.dog.x - st.dog.facing * 18,
              y: st.dog.y + 20 + (st.pawPrints.length % 2 === 0 ? -5 : 5),
              angle: Math.atan2(st.dog.vy, st.dog.vx),
              alpha: 0.75,
            });
            if (st.pawPrints.length > 18) {
              st.pawPrints.shift();
            }

            st.dustPuffs.push({
              x: st.dog.x - st.dog.facing * 26,
              y: st.dog.y + 18,
              vx: -st.dog.facing * 28,
              vy: -12,
              radius: 9 + Math.random() * 5,
              alpha: 0.85,
            });
          }
        }
      } else if (st.stage === 'caught') {
        // Chú chó chạy nhanh tới sát bạn học sinh được chọn
        st.dog.animPhase += dt * 14;
        const chosenChar = st.students.find((c) => c.isSelected);
        if (chosenChar) {
          const targetX = chosenChar.x - 58;
          const targetY = chosenChar.y + 12;
          const dx = targetX - st.dog.x;
          const dy = targetY - st.dog.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 5) {
            st.dog.x += dx * Math.min(1, dt * 6.5);
            st.dog.y += dy * Math.min(1, dt * 6.5);
            st.dog.facing = dx >= 0 ? 1 : -1;
          } else {
            st.dog.facing = 1;
            st.dog.subState = 'happy';
          }
        }
      } else if (st.stage === 'celebrate') {
        // Giai đoạn 4: Hoạt ảnh vẫy tay, vẫy đuôi và mưa pháo giấy chúc mừng
        st.dog.subState = 'happy';
        st.dog.animPhase += dt * 8;
        st.students.forEach((c) => {
          c.stepPhase += dt * 8;
        });

        st.confetti.forEach((p) => {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rotation += p.vRot * dt;
          if (p.y > 570) {
            p.y = -15;
            p.x = 150 + Math.random() * 700;
          }
        });
      }

      // 2. Làm mờ dần dấu chân và cụm bụi chạy
      for (let i = st.pawPrints.length - 1; i >= 0; i--) {
        st.pawPrints[i].alpha -= dt * 0.22;
        if (st.pawPrints[i].alpha <= 0.02) {
          st.pawPrints.splice(i, 1);
        }
      }
      for (let i = st.dustPuffs.length - 1; i >= 0; i--) {
        const d = st.dustPuffs[i];
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.radius += dt * 12;
        d.alpha -= dt * 1.35;
        if (d.alpha <= 0.02) {
          st.dustPuffs.splice(i, 1);
        }
      }
    };

    // =======================================================================
    // HÀM VẼ BỐI CẢNH SÂN TRƯỜNG TIỂU HỌC HOẠT HÌNH 2D (MULTI-LAYERED SCENE)
    // =======================================================================
    const drawSchoolyardBackground = () => {
      const t = stateRef.current.totalTimeSec;
      const st = stateRef.current;

      // 1. Bầu trời xanh nắng ấm áp
      const skyGrad = ctx.createLinearGradient(0, 0, 0, 260);
      skyGrad.addColorStop(0, '#4FA8FF');
      skyGrad.addColorStop(0.55, '#8BD3FF');
      skyGrad.addColorStop(1, '#E0F6FF');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, 1000, 270);

      // Những đám mây bông trắng trôi nhẹ
      const drawCloud = (baseX: number, y: number, scale: number, speed: number) => {
        const cx = ((baseX + t * speed) % 1180) - 90;
        ctx.save();
        ctx.translate(cx, y);
        ctx.scale(scale, scale);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.beginPath();
        ctx.arc(0, 0, 24, 0, Math.PI * 2);
        ctx.arc(22, -6, 30, 0, Math.PI * 2);
        ctx.arc(48, 0, 22, 0, Math.PI * 2);
        ctx.arc(24, 10, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      drawCloud(140, 52, 1.0, 6);
      drawCloud(480, 38, 0.85, 4.5);
      drawCloud(760, 62, 1.1, 5.2);

      // 2. Tán cây xanh và cây hoa phượng/anh đào hồng phấn phía xa
      const drawTreeCanopy = (x: number, y: number, r: number, color1: string, color2: string) => {
        ctx.save();
        const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.25, r * 0.1, x, y, r);
        g.addColorStop(0, color1);
        g.addColorStop(1, color2);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.arc(x - r * 0.55, y + r * 0.2, r * 0.78, 0, Math.PI * 2);
        ctx.arc(x + r * 0.55, y + r * 0.2, r * 0.78, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };

      // Rặng cây hoa hồng phấn và cây xanh quanh trường
      drawTreeCanopy(195, 165, 58, '#FFAFCC', '#F472B6');
      drawTreeCanopy(290, 152, 52, '#7AE582', '#2EC4B6');
      drawTreeCanopy(635, 148, 56, '#7AE582', '#22C55E');
      drawTreeCanopy(725, 165, 48, '#A3E635', '#16A34A');

      // 3. Tòa nhà chính "TRƯỜNG TIỂU HỌC" ở trung tâm phía xa
      ctx.save();
      // Thân tòa nhà vàng kem ấm áp
      ctx.fillStyle = '#FFF3B0';
      ctx.strokeStyle = '#B45309';
      ctx.lineWidth = 2.5;
      ctx.fillRect(320, 108, 290, 165);
      ctx.strokeRect(320, 108, 290, 165);

      // Mái ngói đỏ cam truyền thống
      ctx.fillStyle = '#F97316';
      ctx.beginPath();
      ctx.moveTo(305, 110);
      ctx.lineTo(350, 72);
      ctx.lineTo(580, 72);
      ctx.lineTo(625, 110);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Tháp đồng hồ trung tâm
      ctx.fillStyle = '#FEF08A';
      ctx.fillRect(415, 70, 100, 203);
      ctx.strokeRect(415, 70, 100, 203);

      // Mái nhọn tháp đồng hồ
      ctx.fillStyle = '#EA580C';
      ctx.beginPath();
      ctx.moveTo(402, 74);
      ctx.lineTo(465, 36);
      ctx.lineTo(528, 74);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Cột cờ & Lá cờ đỏ sao vàng tung bay trên đỉnh trường
      ctx.strokeStyle = '#78350F';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(465, 36);
      ctx.lineTo(465, 8);
      ctx.stroke();

      const flagWave = Math.sin(t * 5) * 3;
      ctx.fillStyle = '#EF4444';
      ctx.beginPath();
      ctx.moveTo(465, 9);
      ctx.quadraticCurveTo(478, 9 + flagWave, 492, 12 - flagWave * 0.5);
      ctx.lineTo(492, 27 - flagWave * 0.5);
      ctx.quadraticCurveTo(478, 25 + flagWave, 465, 25);
      ctx.closePath();
      ctx.fill();
      // Ngôi sao vàng trên lá cờ
      ctx.fillStyle = '#FACC15';
      ctx.beginPath();
      ctx.arc(478, 17, 3.2, 0, Math.PI * 2);
      ctx.fill();

      // Mặt đồng hồ tròn trên tháp
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#3B82F6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(465, 72, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Kim đồng hồ
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(465, 72);
      ctx.lineTo(465, 61);
      ctx.moveTo(465, 72);
      ctx.lineTo(473, 72);
      ctx.stroke();

      // Các ô cửa sổ lớp học xanh sáng
      ctx.fillStyle = '#BAE6FD';
      ctx.strokeStyle = '#D97706';
      ctx.lineWidth = 1.8;
      const winX = [338, 375, 434, 474, 528, 565];
      winX.forEach((wx) => {
        ctx.fillRect(wx, 126, 24, 32);
        ctx.strokeRect(wx, 126, 24, 32);
        ctx.fillRect(wx, 178, 24, 32);
        ctx.strokeRect(wx, 178, 24, 32);
      });
      ctx.restore();

      // 4. Hàng rào sân trường & Cổng vòm "TRƯỜNG TIỂU HỌC"
      ctx.save();
      // Hàng rào gỗ/gạch ấm áp chạy ngang
      ctx.fillStyle = '#FDBA74';
      ctx.strokeStyle = '#9A3412';
      ctx.lineWidth = 2;
      ctx.fillRect(0, 215, 315, 58);
      ctx.fillRect(610, 215, 145, 58);
      for (let rx = 18; rx < 310; rx += 26) {
        ctx.fillStyle = '#FED7AA';
        ctx.fillRect(rx, 205, 12, 65);
        ctx.strokeRect(rx, 205, 12, 65);
      }

      // Hai trụ cổng trường lớn
      ctx.fillStyle = '#FDE047';
      ctx.strokeStyle = '#B45309';
      ctx.lineWidth = 2.5;
      // Trụ trái
      ctx.fillRect(306, 152, 34, 125);
      ctx.strokeRect(306, 152, 34, 125);
      // Trụ phải
      ctx.fillRect(590, 152, 34, 125);
      ctx.strokeRect(590, 152, 34, 125);

      // Cánh cổng sắt màu xanh lá mở rộng chào đón học sinh
      ctx.strokeStyle = '#15803D';
      ctx.lineWidth = 2.2;
      ctx.strokeRect(342, 200, 32, 74);
      ctx.strokeRect(556, 200, 32, 74);
      for (let gx = 348; gx <= 368; gx += 7) {
        ctx.beginPath();
        ctx.moveTo(gx, 200);
        ctx.lineTo(gx, 274);
        ctx.stroke();
      }
      for (let gx = 562; gx <= 582; gx += 7) {
        ctx.beginPath();
        ctx.moveTo(gx, 200);
        ctx.lineTo(gx, 274);
        ctx.stroke();
      }

      // Bảng vòm gỗ "TRƯỜNG TIỂU HỌC"
      ctx.fillStyle = '#B45309';
      ctx.strokeStyle = '#78350F';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(332, 165);
      ctx.quadraticCurveTo(465, 112, 598, 165);
      ctx.lineTo(586, 194);
      ctx.quadraticCurveTo(465, 146, 344, 194);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFBEB';
      ctx.font = '900 17px "Nunito", "Quicksand", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('TRƯỜNG TIỂU HỌC', 465, 163);
      ctx.restore();

      // 5. Mặt sân trường lát gạch hồng cam ấm áp (Perspective Courtyard Pavement)
      ctx.save();
      const groundGrad = ctx.createLinearGradient(0, 270, 0, 560);
      groundGrad.addColorStop(0, '#FDE6C4');
      groundGrad.addColorStop(0.5, '#FCD5A5');
      groundGrad.addColorStop(1, '#F6BD82');
      ctx.fillStyle = groundGrad;
      ctx.fillRect(0, 270, 1000, 290);

      // Đường kẻ gạch phối cảnh trên sân trường
      ctx.strokeStyle = 'rgba(180, 83, 9, 0.14)';
      ctx.lineWidth = 1.5;
      for (let py = 285; py <= 555; py += 32) {
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(1000, py);
        ctx.stroke();
      }
      for (let px = -100; px <= 1100; px += 75) {
        ctx.beginPath();
        ctx.moveTo(px, 270);
        ctx.lineTo(px - 90, 560);
        ctx.stroke();
      }
      ctx.restore();

      // 6. Cây cổ thụ lớn bên trái, Bảng tin & Ghế đá sân trường (giống panel 1, 2, 3)
      ctx.save();
      // Thân cây lớn góc trái
      ctx.fillStyle = '#92400E';
      ctx.strokeStyle = '#451A03';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(28, 295);
      ctx.quadraticCurveTo(45, 200, 22, 95);
      ctx.lineTo(76, 95);
      ctx.quadraticCurveTo(68, 200, 86, 295);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      drawTreeCanopy(65, 78, 86, '#4ADE80', '#15803D');

      // Bảng tin trường học bên trái
      ctx.fillStyle = '#C7D2FE';
      ctx.strokeStyle = '#92400E';
      ctx.lineWidth = 3;
      ctx.fillRect(26, 218, 86, 56);
      ctx.strokeRect(26, 218, 86, 56);
      // Các tờ giấy ghi chú nhỏ trên bảng tin
      ctx.fillStyle = '#FEF08A';
      ctx.fillRect(35, 227, 18, 22);
      ctx.fillStyle = '#FBCFE8';
      ctx.fillRect(58, 229, 18, 20);
      ctx.fillStyle = '#BAE6FD';
      ctx.fillRect(82, 226, 18, 22);

      // Ghế đá gỗ sân trường bên trái
      ctx.fillStyle = '#D97706';
      ctx.strokeStyle = '#78350F';
      ctx.lineWidth = 2;
      ctx.fillRect(86, 304, 84, 14);
      ctx.strokeRect(86, 304, 84, 14);
      ctx.fillRect(82, 318, 92, 10);
      ctx.strokeRect(82, 318, 92, 10);
      // Chân ghế
      ctx.fillRect(94, 328, 8, 15);
      ctx.fillRect(156, 328, 8, 15);
      ctx.restore();

      // 7. Khi ở giai đoạn 3 (Chase): Hiển thị thêm Trụ bóng rổ & Khung thành mini góc phải xa như panel 3
      if (st.stage === 'chase') {
        ctx.save();
        // Trụ bóng rổ phía xa
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(885, 285);
        ctx.lineTo(885, 165);
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 2.5;
        ctx.fillRect(860, 140, 48, 34);
        ctx.strokeRect(860, 140, 48, 34);

        // Khung thành bóng đá mini bên phải
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3.5;
        ctx.strokeRect(932, 220, 62, 85);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        for (let nx = 940; nx < 992; nx += 10) {
          ctx.beginPath();
          ctx.moveTo(nx, 220);
          ctx.lineTo(nx, 305);
          ctx.stroke();
        }
        ctx.restore();
      } else {
        // 8. Khu vực Hiên Lớp Học & Cửa Gỗ Lớp Học bên phải (giống hệt panel 1 & panel 2)
        ctx.save();
        // Tường lớp học bên phải
        ctx.fillStyle = '#FEF3C7';
        ctx.strokeStyle = '#B45309';
        ctx.lineWidth = 3;
        ctx.fillRect(675, 0, 325, 435);
        ctx.strokeRect(675, 0, 325, 435);

        // Không gian bên trong lớp học nhìn qua khung cửa mở
        ctx.fillStyle = '#FDE68A';
        ctx.fillRect(825, 45, 175, 385);

        // Bảng xanh viết phấn trong lớp học
        ctx.fillStyle = '#14532D';
        ctx.strokeStyle = '#92400E';
        ctx.lineWidth = 5;
        ctx.fillRect(905, 115, 92, 135);
        ctx.strokeRect(905, 115, 92, 135);
        // Nét phấn vẽ dễ thương trên bảng
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(945, 165, 16, 0, Math.PI * 2);
        ctx.stroke();

        // Bàn ghế gỗ học sinh bên trong lớp
        ctx.fillStyle = '#D97706';
        ctx.strokeStyle = '#78350F';
        ctx.lineWidth = 2;
        ctx.fillRect(855, 295, 78, 12);
        ctx.strokeRect(855, 295, 78, 12);
        ctx.fillRect(865, 307, 8, 52);
        ctx.fillRect(915, 307, 8, 52);

        ctx.fillRect(935, 325, 62, 12);
        ctx.strokeRect(935, 325, 62, 12);
        ctx.fillRect(945, 337, 8, 55);

        // Cánh cửa gỗ lớp học mở hé + Bảng tên lớp bằng gỗ treo trên cửa
        ctx.fillStyle = '#C26D2D';
        ctx.strokeStyle = '#78350F';
        ctx.lineWidth = 3;
        ctx.fillRect(712, 82, 112, 352);
        ctx.strokeRect(712, 82, 112, 352);

        // Ô kính xanh trên cánh cửa gỗ
        ctx.fillStyle = '#7DD3FC';
        ctx.fillRect(736, 178, 64, 110);
        ctx.strokeRect(736, 178, 64, 110);

        // Tay nắm cửa tròn
        ctx.fillStyle = '#FBBF24';
        ctx.beginPath();
        ctx.arc(728, 288, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Bảng tên lớp bằng gỗ (Hiển thị tên lớp thật từ dữ liệu!)
        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = '#78350F';
        ctx.lineWidth = 2.5;
        ctx.fillRect(728, 108, 80, 44);
        ctx.strokeRect(728, 108, 80, 44);
        ctx.fillStyle = '#451A03';
        ctx.font = '900 16px "Nunito", sans-serif';
        ctx.textAlign = 'center';
        const classLabel = (currentClass?.name || 'Lớp 5A').slice(0, 9);
        ctx.fillText(classLabel, 768, 136);

        // Chậu cây xanh tươi mát đặt cạnh cửa lớp
        ctx.fillStyle = '#C2410C';
        ctx.strokeStyle = '#7C2D12';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(652, 372);
        ctx.lineTo(712, 372);
        ctx.lineTo(702, 428);
        ctx.lineTo(662, 428);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Tán lá cây cảnh
        drawTreeCanopy(682, 338, 34, '#4ADE80', '#15803D');

        // Chiếc đệm tròn màu xanh dương kẻ sọc của chú chó Corgi
        ctx.fillStyle = '#3B82F6';
        ctx.strokeStyle = '#1D4ED8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(815, 456, 86, 32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#60A5FA';
        ctx.beginPath();
        ctx.ellipse(815, 450, 66, 21, 0, 0, Math.PI * 2);
        ctx.fill();

        // Bát ăn màu hồng có hình khúc xương trắng bên cạnh đệm
        ctx.fillStyle = '#EC4899';
        ctx.strokeStyle = '#9D174D';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(896, 466);
        ctx.lineTo(942, 466);
        ctx.lineTo(950, 492);
        ctx.lineTo(888, 492);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🦴', 919, 484);
        ctx.restore();
      }
    };

    // =======================================================================
    // VẼ DẤU CHÂN CÚN, BỤI CHẠY VÀ SỰ KIỆN RƠI CHỒNG SÁCH
    // =======================================================================
    const drawGroundEffectsAndBooks = () => {
      const st = stateRef.current;

      // 1. Dấu chân chú chó trên nền sân gạch
      st.pawPrints.forEach((p) => {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = `rgba(120, 53, 15, ${Math.max(0, p.alpha * 0.55)})`;
        // Đệm chân chính
        ctx.beginPath();
        ctx.ellipse(0, 0, 6, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        // 3 ngón chân nhỏ phía trước
        [-5, 0, 5].forEach((offsetY, idx) => {
          ctx.beginPath();
          ctx.arc(7 + (idx === 1 ? 2 : 0), offsetY, 2.3, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      });

      // 2. Cụm bụi trắng khi chạy
      st.dustPuffs.forEach((d) => {
        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, d.alpha * 0.8)})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
        ctx.arc(d.x - d.radius * 0.6, d.y + 2, d.radius * 0.7, 0, Math.PI * 2);
        ctx.arc(d.x + d.radius * 0.6, d.y + 2, d.radius * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // 3. Sự kiện rơi chồng sách vở & bút chì (Giai đoạn 2: Tiếng động bất ngờ)
      if (st.bookDrop.active && (st.stage === 'alarm' || st.stage === 'chase')) {
        const bx = st.bookDrop.x;
        const by = st.bookDrop.y - (1 - st.bookDrop.fallProgress) * 45;
        ctx.save();
        ctx.translate(bx, by);

        // Ngôi sao va chạm màu vàng rực rỡ dưới chồng sách (giống hệt panel 2)
        if (st.stage === 'alarm') {
          const burstScale = 0.85 + Math.sin(st.totalTimeSec * 18) * 0.12;
          ctx.save();
          ctx.scale(burstScale, burstScale);
          ctx.fillStyle = '#FDE047';
          ctx.strokeStyle = '#EA580C';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          const spikes = 10;
          for (let i = 0; i < spikes * 2; i++) {
            const r = i % 2 === 0 ? 58 : 28;
            const ang = (i * Math.PI) / spikes;
            const sx = Math.cos(ang) * r;
            const sy = Math.sin(ang) * r * 0.55;
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        // Chồng 3 cuốn sách giáo khoa nhiều màu
        const bookColors = ['#3B82F6', '#10B981', '#EF4444'];
        bookColors.forEach((col, idx) => {
          const oy = -idx * 10;
          ctx.fillStyle = col;
          ctx.strokeStyle = '#1E293B';
          ctx.lineWidth = 2;
          ctx.fillRect(-26, oy - 12, 52, 11);
          ctx.strokeRect(-26, oy - 12, 52, 11);
          // Gáy sách trắng
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(-24, oy - 9, 48, 4);
        });

        // Cây bút chì và trang vở văng bên cạnh
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#64748B';
        ctx.lineWidth = 1.5;
        ctx.fillRect(36, 4, 26, 16);
        ctx.strokeRect(36, 4, 26, 16);

        ctx.fillStyle = '#F59E0B';
        ctx.fillRect(18, 18, 22, 5);
        ctx.restore();
      }
    };

    // =======================================================================
    // VẼ NHÂN VẬT HỌC SINH CHIBI 2D TOÀN THÂN & NHÃN TÊN THẬT
    // =======================================================================
    const drawChibiStudent = (c: DogGameStudent) => {
      const st = stateRef.current;

      // Xác định tư thế và nhịp nhún hoạt ảnh theo từng giai đoạn
      let spriteKey = c.gender === 'female' ? 'girl_sneak' : 'boy_sneak';
      let bobY = 0;
      let tiltAngle = 0;
      let legSwing = 0;

      if (st.stage === 'idle') {
        spriteKey = c.gender === 'female' ? 'girl_sneak' : 'boy_sneak';
        bobY = Math.sin(c.stepPhase) * 2.5;
      } else if (st.stage === 'sneak') {
        spriteKey = c.gender === 'female' ? 'girl_sneak' : 'boy_sneak';
        bobY = -Math.abs(Math.sin(c.stepPhase)) * 5.5;
        tiltAngle = Math.sin(c.stepPhase) * 0.06;
        legSwing = Math.sin(c.stepPhase) * 6;
      } else if (st.stage === 'alarm') {
        spriteKey = c.gender === 'female' ? 'girl_alarm' : 'boy_alarm';
        bobY = -Math.abs(Math.sin(c.stepPhase)) * 6;
        tiltAngle = -0.08;
      } else if (st.stage === 'chase') {
        spriteKey = c.gender === 'female' ? 'girl_run' : 'boy_run';
        bobY = -Math.abs(Math.sin(c.stepPhase)) * 8.5;
        tiltAngle = c.facing * 0.1;
        legSwing = Math.sin(c.stepPhase) * 10;
      } else if (st.stage === 'caught') {
        spriteKey = c.isSelected
          ? c.gender === 'female'
            ? 'girl_celebrate'
            : 'boy_celebrate'
          : c.gender === 'female'
            ? 'girl_alarm'
            : 'boy_alarm';
        bobY = -Math.abs(Math.sin(c.stepPhase)) * 5;
      } else if (st.stage === 'celebrate') {
        spriteKey = c.gender === 'female' ? 'girl_celebrate' : 'boy_celebrate';
        bobY = -Math.abs(Math.sin(c.stepPhase)) * 7;
        tiltAngle = Math.sin(c.stepPhase * 0.5) * 0.05;
      }

      const img = imagesRef.current[spriteKey];

      ctx.save();
      ctx.translate(c.x, c.y);

      // 1. Bóng đổ tròn dưới chân học sinh trên nền sân
      ctx.fillStyle = 'rgba(120, 53, 15, 0.22)';
      ctx.beginPath();
      ctx.ellipse(0, 26, 22, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Vòng sáng nổi bật dưới chân nếu là học sinh vừa được chọn
      if (c.isSelected && (st.stage === 'caught' || st.stage === 'celebrate')) {
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.ellipse(0, 26, 34, 13, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 2. Vẽ thân nhân vật Chibi (Kết hợp Sprite 2D + Phụ kiện cặp sách màu riêng & hoạt ảnh bước chân)
      ctx.save();
      ctx.translate(0, bobY);
      ctx.rotate(tiltAngle);
      ctx.scale(c.facing, 1);

      // Phụ kiện cặp sách màu sắc biến thể sau lưng để phân biệt các học sinh
      ctx.fillStyle = c.accessoryColor;
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-24, -18, 16, 26, 6);
      ctx.fill();
      ctx.stroke();

      // Hoạt ảnh bước chân phụ trợ dưới gấu quần/váy giúp chuyển động chân sống động
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(-6 + legSwing * 0.4, 21, 4.5, 0, Math.PI * 2);
      ctx.arc(6 - legSwing * 0.4, 21, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (img && img.complete && img.naturalWidth > 0) {
        const w = 66;
        const h = 76;
        ctx.drawImage(img, -w / 2, -h + 26, w, h);
      } else {
        // Fallback vẽ nhân vật Chibi chi tiết bằng Canvas 2D nếu ảnh đang tải
        // Quần xanh / Váy xanh đồng phục tiểu học
        ctx.fillStyle = '#1E3A8A';
        ctx.beginPath();
        ctx.roundRect(-14, 0, 28, 16, 4);
        ctx.fill();
        // Áo trắng đồng phục
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.roundRect(-15, -18, 30, 20, 5);
        ctx.fill();
        // Khăn quàng đỏ Đội viên
        ctx.fillStyle = '#EF4444';
        ctx.beginPath();
        ctx.moveTo(-10, -16);
        ctx.lineTo(10, -16);
        ctx.lineTo(3, 0);
        ctx.lineTo(-3, 0);
        ctx.closePath();
        ctx.fill();
        // Khuôn mặt bầu bĩnh dễ thương
        ctx.fillStyle = '#FDE6C4';
        ctx.beginPath();
        ctx.arc(0, -32, 16, 0, Math.PI * 2);
        ctx.fill();
        // Mái tóc
        ctx.fillStyle = '#3B2314';
        ctx.beginPath();
        ctx.arc(0, -36, 17, Math.PI, Math.PI * 2);
        ctx.fill();
      }

      // Nơ tóc / Huy hiệu màu sắc riêng trên đầu cho học sinh nữ/nam
      if (c.gender === 'female') {
        ctx.fillStyle = c.accessoryColor;
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(-12, -42, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // 3. Biểu tượng cảm xúc trên đầu (Dấu chấm than !!! khi giật mình, giọt mồ hôi khi chạy)
      if (c.emote === 'shock' && st.stage === 'alarm') {
        ctx.save();
        ctx.translate(0, -64 + bobY * 0.5);
        ctx.fillStyle = '#EF4444';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        ctx.font = '900 20px "Nunito", sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeText('!!', 0, 0);
        ctx.fillText('!!', 0, 0);
        ctx.restore();
      }

      // 4. Nhãn họ tên thật của học sinh (Không che mặt, dễ đọc trên mọi nền)
      const labelText = formatStudentBadgeName(c.student.fullName);
      ctx.save();
      ctx.font = '800 11.5px "Nunito", "Quicksand", sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      const pillW = Math.max(48, textWidth + 14);
      const pillH = 19;
      const pillX = -pillW / 2;
      const pillY = 30;

      ctx.fillStyle = c.isSelected ? '#FEF08A' : 'rgba(255, 255, 255, 0.92)';
      ctx.strokeStyle = c.isSelected ? '#EA580C' : c.accessoryColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 9);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#0F172A';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, 0, pillY + pillH / 2 + 0.5);
      ctx.restore();

      ctx.restore();
    };

    // =======================================================================
    // VẼ CHÚ CHÓ CORGI ĐÁNG YÊU VỚI ĐẦY ĐỦ TRẠNG THÁI CHUYỂN ĐỘNG TUẦN TỰ
    // =======================================================================
    const drawCorgiDog = () => {
      const st = stateRef.current;
      const dog = st.dog;

      ctx.save();
      ctx.translate(dog.x, dog.y);

      // Bóng đổ dưới chân chú chó
      ctx.fillStyle = 'rgba(30, 58, 138, 0.22)';
      ctx.beginPath();
      ctx.ellipse(0, 22, 42, 13, 0, 0, Math.PI * 2);
      ctx.fill();

      // Chọn sprite theo trạng thái con (subState)
      let dogKey = 'corgi_sleep';
      let bounceY = 0;
      let scaleX = 1;
      let scaleY = 1;
      let rot = 0;

      if (dog.subState === 'sleeping') {
        dogKey = 'corgi_sleep';
        scaleX = dog.breathScale;
        scaleY = 2 - dog.breathScale;
        rot = dog.earTwitch * 0.15;
      } else if (dog.subState === 'startled') {
        dogKey = 'corgi_sleep';
        bounceY = -10;
        scaleX = 1.08;
        scaleY = 0.94;
      } else if (dog.subState === 'eye_open') {
        dogKey = 'corgi_alarm';
        bounceY = -6;
        scaleX = 1.02;
        scaleY = 0.98;
      } else if (dog.subState === 'ears_up') {
        dogKey = 'corgi_alarm';
        bounceY = -12;
        scaleX = 0.96;
        scaleY = 1.08;
      } else if (dog.subState === 'barking') {
        dogKey = 'corgi_alarm';
        bounceY = -Math.abs(Math.sin(dog.animPhase * 1.5)) * 12;
        rot = Math.sin(dog.animPhase * 2) * 0.08;
      } else if (dog.subState === 'chasing' || dog.subState === 'catching') {
        dogKey = 'corgi_run';
        bounceY = -Math.abs(Math.sin(dog.animPhase)) * 11;
        rot = Math.sin(dog.animPhase) * 0.09;
      } else if (dog.subState === 'happy') {
        dogKey = 'corgi_happy';
        bounceY = -Math.abs(Math.sin(dog.animPhase)) * 7;
        rot = Math.sin(dog.animPhase * 0.8) * 0.06;
      }

      const img = imagesRef.current[dogKey];

      ctx.save();
      ctx.translate(0, bounceY);
      ctx.rotate(rot);
      // Corgi sprite gốc quay mặt sang phải (corgi_run) hoặc trái (corgi_sleep/alarm)
      const flip =
        dogKey === 'corgi_run'
          ? dog.facing
          : dogKey === 'corgi_sleep' || dogKey === 'corgi_alarm'
            ? -dog.facing
            : 1;
      ctx.scale(flip * scaleX, scaleY);

      if (img && img.complete && img.naturalWidth > 0) {
        const w = 104;
        const h = 88;
        ctx.drawImage(img, -w / 2, -h + 26, w, h);
      } else {
        // Fallback vẽ Corgi bằng Canvas nếu ảnh đang nạp
        ctx.fillStyle = '#F59E0B';
        ctx.beginPath();
        ctx.ellipse(0, 0, 36, 22, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Vẽ thêm chi tiết mắt mở / tai dựng tuần tự cho Giai đoạn 2
      if (dog.subState === 'startled') {
        // Giật mình: giọt mồ hôi & nảy người
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(-28, -38, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (dog.subState === 'ears_up' || dog.subState === 'barking') {
        // Hiệu ứng tai giật & chuông vàng lắc lư
        ctx.fillStyle = '#FACC15';
        ctx.strokeStyle = '#92400E';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(-14, -6, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // Hiệu ứng "Z z z" bay lên khi chú chó đang ngủ (Giai đoạn 1)
      if (dog.subState === 'sleeping') {
        ctx.save();
        ctx.fillStyle = '#1E293B';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        ['z', 'Z', 'Z'].forEach((ch, idx) => {
          const zProgress = (st.totalTimeSec * 0.7 + idx * 0.33) % 1;
          const zx = 12 + idx * 14 + Math.sin(zProgress * Math.PI * 2) * 4;
          const zy = -46 - zProgress * 32;
          ctx.font = `900 ${13 + idx * 4}px "Nunito", sans-serif`;
          ctx.globalAlpha = 1 - zProgress * 0.7;
          ctx.strokeText(ch, zx, zy);
          ctx.fillText(ch, zx, zy);
        });
        ctx.restore();
      }

      // Hiệu ứng dấu chấm than "!!!" và sóng âm sủa "Gâu! Gâu!" khi thức giấc (Giai đoạn 2)
      if (
        dog.subState === 'startled' ||
        dog.subState === 'eye_open' ||
        dog.subState === 'ears_up' ||
        dog.subState === 'barking'
      ) {
        ctx.save();
        ctx.translate(0, -72 + bounceY * 0.5);
        ctx.fillStyle = '#EF4444';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 4;
        ctx.font = '900 26px "Nunito", sans-serif';
        ctx.textAlign = 'center';
        const mark =
          dog.subState === 'startled'
            ? '!'
            : dog.subState === 'eye_open'
              ? '!!'
              : '!!!';
        ctx.strokeText(mark, 0, 0);
        ctx.fillText(mark, 0, 0);
        ctx.restore();
      }

      if (dog.subState === 'barking') {
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(-32, -24, 18 + dog.barkWaveRadius * 0.45, (Math.PI * 3) / 4, (Math.PI * 5) / 4);
        ctx.stroke();

        ctx.fillStyle = '#DC2626';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        ctx.font = '900 16px "Nunito", sans-serif';
        ctx.strokeText('Gâu! Gâu!', -62, -42);
        ctx.fillText('Gâu! Gâu!', -62, -42);
        ctx.restore();
      }

      ctx.restore();
    };

    // =======================================================================
    // VẼ LỚP TIỀN CẢNH (BỤI HOA HAI GÓC DƯỚI, PHÁO GIẤY & HUY HIỆU GIAI ĐOẠN)
    // =======================================================================
    const drawForegroundAndStageOverlay = () => {
      const st = stateRef.current;

      // 1. Bụi hoa tiền cảnh hai góc dưới trái và phải tạo chiều sâu 3D/2.5D như video
      const drawFlowerBush = (bx: number, by: number, flipX: number) => {
        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(flipX, 1);
        ctx.fillStyle = '#15803D';
        ctx.beginPath();
        ctx.arc(0, 0, 62, 0, Math.PI * 2);
        ctx.arc(48, 16, 48, 0, Math.PI * 2);
        ctx.arc(-38, 18, 44, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#22C55E';
        ctx.beginPath();
        ctx.arc(6, -6, 48, 0, Math.PI * 2);
        ctx.arc(42, 12, 36, 0, Math.PI * 2);
        ctx.fill();

        // Những bông hoa nhỏ màu hồng/vàng trên bụi cây
        const flowers = [
          { x: -18, y: -16, c: '#F472B6' },
          { x: 18, y: -8, c: '#FBBF24' },
          { x: 42, y: 12, c: '#FB7185' },
          { x: -4, y: 16, c: '#FDE047' },
        ];
        flowers.forEach((f) => {
          ctx.fillStyle = f.c;
          ctx.beginPath();
          ctx.arc(f.x, f.y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#FEF08A';
          ctx.beginPath();
          ctx.arc(f.x, f.y, 2.8, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      };

      drawFlowerBush(45, 535, 1);
      drawFlowerBush(955, 535, -1);

      // 2. Pháo giấy Confetti rực rỡ trong Giai đoạn 4 (Celebrate)
      if (st.stage === 'celebrate') {
        st.confetti.forEach((p) => {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.fillStyle = p.color;
          if (p.shape === 'rect') {
            ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
          } else if (p.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(0, 0, p.size * 0.45, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        });
      }

      // 3. Huy hiệu Giai đoạn (Stage Pill) ở góc trên bên trái giống hệt video mẫu!
      const stageMeta: Record<
        DogGameStage,
        { num: string; title: string }
      > = {
        idle: { num: '★', title: 'Sẵn sàng trước giờ vào lớp' },
        sneak: { num: '1', title: 'Các bạn rón rén vào lớp' },
        alarm: { num: '2', title: 'Tiếng động bất ngờ' },
        chase: { num: '3', title: 'Chú chó đuổi bắt' },
        caught: { num: '4', title: 'Bắt kịp bạn may mắn!' },
        celebrate: { num: '4', title: 'Chọn 1 bạn ngẫu nhiên' },
      };
      const meta = stageMeta[st.stage];

      ctx.save();
      // Khung thuốc trắng viền hồng góc trên trái
      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.strokeStyle = '#F472B6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(22, 16, 338, 48, 24);
      ctx.fill();
      ctx.stroke();

      // Vòng tròn hồng đậm chứa số thứ tự giai đoạn
      ctx.fillStyle = '#EC4899';
      ctx.beginPath();
      ctx.arc(48, 40, 21, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '900 20px "Nunito", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(meta.num, 48, 41);

      ctx.fillStyle = '#9D174D';
      ctx.font = '900 18px "Nunito", "Quicksand", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(meta.title, 80, 41);
      ctx.restore();

      // 4. Đồng hồ đếm ngược 00:10 ở góc trên bên phải trong Giai đoạn 3 (giống hệt panel 3)
      if (st.stage === 'chase') {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
        ctx.strokeStyle = '#F472B6';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(785, 16, 192, 52, 26);
        ctx.fill();
        ctx.stroke();

        // Icon mặt đồng hồ đỏ cam bên trái
        ctx.fillStyle = '#EF4444';
        ctx.beginPath();
        ctx.arc(816, 42, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(816, 42, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(816, 42);
        ctx.lineTo(816, 33);
        ctx.moveTo(816, 42);
        ctx.lineTo(823, 42);
        ctx.stroke();

        // Chữ số 00:10
        const secStr = `00:${String(Math.max(0, st.countdown)).padStart(2, '0')}`;
        ctx.fillStyle = st.countdown <= 3 ? '#DC2626' : '#E11D48';
        ctx.font = '900 28px "Nunito", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(secStr, 908, 43);
        ctx.restore();
      }
    };

    // Vòng lặp Render chính
    const renderLoop = (now: number) => {
      if (!active) return;
      const rawDt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

      updateWorld(dt);

      ctx.clearRect(0, 0, 1000, 560);
      drawSchoolyardBackground();
      drawGroundEffectsAndBooks();

      // Sắp xếp chiều sâu (Y-sorting) cho tất cả học sinh và chú chó để nhân vật đứng trước che nhân vật đứng sau tự nhiên
      const renderables: Array<{ y: number; draw: () => void }> = [];
      stateRef.current.students.forEach((studentChar) => {
        // Trong giai đoạn 4 (celebrate), bạn được chọn sẽ hiển thị nổi bật trên bảng vinh danh chính giữa
        if (stateRef.current.stage === 'celebrate' && studentChar.isSelected) return;
        renderables.push({
          y: studentChar.y,
          draw: () => drawChibiStudent(studentChar),
        });
      });

      renderables.push({
        y: stateRef.current.dog.y + 4,
        draw: drawCorgiDog,
      });

      renderables.sort((a, b) => a.y - b.y);
      renderables.forEach((item) => item.draw());

      drawForegroundAndStageOverlay();

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => {
      active = false;
      cancelAnimationFrame(animId);
    };
  }, [currentClass?.name, startStage2Alarm, startStage3Chase]);

  if (!currentClass) return null;

  const isRunning = stage === 'sneak' || stage === 'alarm' || stage === 'chase' || stage === 'caught';

  return (
    <div
      ref={containerRef}
      className={`w-full bg-gradient-to-b from-sky-100 via-amber-50/70 to-pink-50 select-none overflow-hidden flex flex-col items-center justify-between ${
        isFullscreen || isPseudoFullscreen || isLandscape
          ? 'fixed inset-0 z-40 w-screen h-[100dvh] max-h-[100dvh]'
          : 'min-h-[100dvh] h-[100dvh] max-h-[100dvh] relative p-2 sm:p-3'
      }`}
      style={{
        paddingTop: 'max(0.25rem, env(safe-area-inset-top))',
        paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(0.5rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.5rem, env(safe-area-inset-right))',
      }}
    >
      {/* Lớp phủ bắt buộc xoay ngang trên điện thoại */}
      {showRotateOverlay && (
        <LandscapeRotateOverlay
          onEnterFullscreenAndLandscape={requestGameFullscreen}
          onTryLockLandscape={lockLandscape}
          isPausedMidGame={isPaused && isRunning}
        />
      )}
      {/* =====================================================================
          1. THANH ĐIỀU KHIỂN TRÊN CÙNG (TOP BAR)
         ===================================================================== */}
      <header
        className={`w-full max-w-6xl mx-auto shrink-0 bg-white/95 backdrop-blur-md rounded-xl sm:rounded-2xl border-2 border-pink-200 shadow-soft px-2.5 sm:px-4 flex items-center justify-between gap-1.5 sm:gap-2 z-20 ${
          isCompactLandscape ? 'h-9 py-0.5 mb-0.5' : isLandscape ? 'h-10 py-1 mb-1' : 'py-1.5 sm:py-2 mb-1.5'
        }`}
      >
        <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
          <button
            type="button"
            className="btn-ghost btn-sm text-xs sm:text-sm h-7 sm:h-8 px-2 sm:px-2.5 font-bold text-ink hover:bg-pink-50 shrink-0"
            onClick={() => navigate('/games')}
          >
            <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-pink-600" />
            <span className="hidden sm:inline">Trò chơi</span>
          </button>

          <div className="h-4 w-[1.5px] bg-pink-100 hidden sm:block shrink-0" />

          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <span className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white flex items-center justify-center shadow-sm shrink-0">
              <Dog className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <h1 className="font-display font-black text-xs sm:text-sm text-ink leading-tight truncate">
                Chú chó đuổi bắt
              </h1>
              <span className="text-[10px] sm:text-[11px] font-bold text-pink-600 bg-pink-50 px-1.5 py-0.5 rounded-md border border-pink-100 truncate">
                {currentClass.name} ({validPickedCount}/{totalStudents})
              </span>
            </div>
          </div>
        </div>

        {/* Các công tắc cấu hình: Không lặp lại, Âm thanh, Nhạc nền, Lịch sử, Toàn màn hình */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <label
            className="flex items-center gap-1 text-[11px] sm:text-xs font-bold text-ink bg-pink-50/90 hover:bg-pink-100/80 px-2 py-1 rounded-lg sm:rounded-xl border border-pink-200 cursor-pointer transition-colors"
            title="Không gọi lặp lại học sinh trong cùng một vòng"
          >
            <input
              type="checkbox"
              className="accent-pink-500 w-3.5 h-3.5 rounded cursor-pointer"
              checked={noRepeat}
              onChange={(e) => setNoRepeat(e.target.checked)}
            />
            <span className="hidden sm:inline">Không lặp lại</span>
          </label>

          <button
            type="button"
            className={`icon-btn h-7 w-7 sm:h-8 sm:w-8 rounded-lg sm:rounded-xl border ${
              soundEnabled
                ? 'bg-amber-50 border-amber-200 text-amber-600'
                : 'bg-slate-100 border-slate-200 text-slate-400'
            }`}
            onClick={() => setSoundEnabled((v) => !v)}
            title={soundEnabled ? 'Tắt âm thanh hiệu ứng' : 'Bật âm thanh hiệu ứng'}
            aria-label="Âm thanh"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
          </button>

          <button
            type="button"
            className={`icon-btn h-7 w-7 sm:h-8 sm:w-8 rounded-lg sm:rounded-xl border ${
              musicEnabled && soundEnabled
                ? 'bg-pink-50 border-pink-200 text-pink-600'
                : 'bg-slate-100 border-slate-200 text-slate-400'
            }`}
            onClick={() => setMusicEnabled((v) => !v)}
            title={musicEnabled ? 'Tắt nhạc nền' : 'Bật nhạc nền'}
            aria-label="Nhạc nền"
          >
            <Music className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>

          <button
            type="button"
            className="btn-outline btn-sm h-7 sm:h-8 px-2 text-[11px] sm:text-xs font-bold border-pink-200 text-pink-700 hover:bg-pink-50"
            onClick={() => setShowHistory(true)}
          >
            <History className="w-3.5 h-3.5 text-pink-500" />
            <span className="hidden md:inline">Lịch sử</span>
            <span className="chip bg-pink-100 text-pink-700 px-1.5 py-0 text-[10px] sm:text-[11px]">
              {picks?.length ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="icon-btn h-7 w-7 sm:h-8 sm:w-8 rounded-lg sm:rounded-xl border border-pink-200 bg-white text-ink hover:bg-pink-50"
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
            aria-label="Toàn màn hình"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Maximize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
          </button>
        </div>
      </header>

      {/* =====================================================================
          2. KHU VỰC TRUNG TÂM: SÂN TRƯỜNG 2D CANVAS (GIỮ TỶ LỆ 1000:560)
         ===================================================================== */}
      <main
        ref={mainStageRef}
        className="flex-1 min-h-0 flex items-center justify-center w-full max-w-6xl mx-auto relative overflow-hidden"
      >
        <div
          className="aspect-[1000/560] max-w-full max-h-full relative rounded-[20px] sm:rounded-[26px] overflow-hidden border-2 sm:border-4 border-amber-300 shadow-soft bg-sky-200 flex items-center justify-center"
          style={
            stageSize
              ? { width: `${stageSize.width}px`, height: `${stageSize.height}px` }
              : { width: '100%', maxWidth: '1000px' }
          }
        >
          <canvas
            ref={canvasRef}
            width={1000}
            height={560}
            className="w-full h-full object-contain block"
          />

          {/* Trường hợp lớp rỗng: Hiển thị thông báo thân thiện và nút dẫn tới trang thêm học sinh */}
          {totalStudents === 0 && (
            <div className="absolute inset-0 bg-ink/45 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-10">
              <div className="bg-white rounded-3xl p-5 sm:p-6 max-w-md w-full text-center border-2 border-pink-200 shadow-soft space-y-2.5 animate-pop">
                <div className="w-12 h-12 rounded-2xl bg-pink-100 text-pink-600 flex items-center justify-center mx-auto">
                  <Users className="w-7 h-7" />
                </div>
                <h2 className="font-display font-black text-lg sm:text-xl text-ink">
                  Lớp chưa có học sinh nào
                </h2>
                <p className="text-xs sm:text-sm text-ink-soft">
                  Hãy thêm danh sách học sinh vào lớp <strong>{currentClass.name}</strong> để các bạn cùng tham gia trò chơi Chú chó đuổi bắt nhé!
                </p>
                <button
                  type="button"
                  className="btn-primary w-full justify-center py-2"
                  onClick={() => navigate('/students')}
                >
                  <UserPlus className="w-4 h-4" /> Thêm học sinh ngay
                </button>
              </div>
            </div>
          )}

          {/* Thông báo khi đang Tạm dừng */}
          {isPaused && isRunning && (
            <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px] flex items-center justify-center p-3 z-10">
              <div className="bg-white/95 rounded-3xl px-5 sm:px-7 py-4 text-center border-2 border-amber-300 shadow-soft space-y-2.5 animate-pop max-w-xs">
                <span className="chip bg-amber-100 text-amber-800 font-extrabold text-xs">
                  ⏸ Đang tạm dừng trò chơi
                </span>
                <p className="text-xs sm:text-sm text-ink-soft">
                  Mọi chuyển động và đồng hồ đếm ngược đang được giữ nguyên.
                </p>
                <button
                  type="button"
                  className="btn-primary px-6 py-2 mx-auto text-xs sm:text-sm"
                  onClick={handleTogglePause}
                >
                  <Play className="w-4 h-4 fill-white" /> Tiếp tục ngay
                </button>
              </div>
            </div>
          )}

          {/* Thông báo khi đã gọi hết học sinh trong vòng không lặp lại */}
          {stage === 'idle' && roundExhausted && totalStudents > 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md px-4 py-2 rounded-2xl border-2 border-amber-300 shadow-soft flex flex-wrap items-center gap-2.5 z-10 max-w-[92%]">
              <span className="text-xs sm:text-sm font-bold text-amber-900">
                🎉 Cả lớp ({totalStudents} bạn) đều đã được gọi tên trong vòng này!
              </span>
              <button
                type="button"
                className="btn-primary btn-sm bg-gradient-to-r from-amber-500 to-pink-500 text-white border-0"
                onClick={handleClearHistory}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Bắt đầu vòng mới
              </button>
            </div>
          )}

          {/* =================================================================
              BẢNG VINH DANH HỌC SINH ĐƯỢC CHỌN (GIAI ĐOẠN 4 - GIỐNG HỆT PANEL 4)
             ================================================================= */}
          {stage === 'celebrate' && pickedStudent && (
            <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-4 pointer-events-auto z-10 animate-fadeIn">
              <div
                className={`relative bg-gradient-to-b from-amber-100 via-yellow-50 to-white rounded-[24px] sm:rounded-[32px] border-3 sm:border-4 border-amber-400 shadow-2xl max-w-sm w-full text-center animate-pop max-h-[94%] overflow-y-auto ${
                  isCompactLandscape ? 'px-4 pt-6 pb-3' : 'px-5 pt-8 pb-4'
                }`}
              >
                {/* Dải ruy-băng đỏ hồng "Chúc mừng!" phía trên thẻ */}
                <div className="inline-flex items-center gap-1.5 bg-gradient-to-r from-rose-500 via-pink-500 to-rose-500 text-white font-display font-black text-sm sm:text-xl px-5 sm:px-7 py-1 sm:py-1.5 rounded-full border-2 sm:border-4 border-amber-200 shadow-lg whitespace-nowrap mb-1">
                  <Sparkles className="w-4 h-4 text-yellow-200 animate-spin" />
                  <span>Chúc mừng!</span>
                  <Sparkles className="w-4 h-4 text-yellow-200 animate-spin" />
                </div>

                {/* Hào quang và chân dung Chibi + Avatar học sinh */}
                <div
                  className={`relative mx-auto flex items-center justify-center my-0.5 ${
                    isCompactLandscape ? 'w-20 h-20' : 'w-28 h-28 sm:w-32 sm:h-32'
                  }`}
                >
                  <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-amber-300/60 via-yellow-200/80 to-pink-200/60 animate-pulse" />
                  <img
                    src={
                      pickedStudent.gender === 'female'
                        ? ASSETS.girl.celebrate
                        : ASSETS.boy.celebrate
                    }
                    alt={pickedStudent.fullName}
                    className={`relative object-contain drop-shadow-md ${
                      isCompactLandscape ? 'w-18 h-18' : 'w-24 h-24 sm:w-28 sm:h-28'
                    }`}
                  />
                  <div className="absolute -bottom-1 -right-1 bg-white rounded-full p-0.5 sm:p-1 border-2 border-amber-300 shadow">
                    <AnimalAvatarSVG avatarKey={pickedStudent.avatar} size={isCompactLandscape ? 24 : 32} />
                  </div>
                </div>

                {/* Bảng tên trắng bo tròn chứa Họ tên đầy đủ & Mã học sinh thật */}
                <div className="mt-1.5 sm:mt-2.5 bg-white rounded-xl sm:rounded-2xl border-2 border-pink-200 px-3 py-1.5 sm:py-2.5 shadow-inner">
                  <h2
                    className="font-display font-black text-base sm:text-2xl text-purple-950 leading-snug truncate"
                    data-testid="picked-student-name"
                  >
                    {pickedStudent.fullName}
                  </h2>
                  <p
                    className="text-[11px] sm:text-sm font-extrabold text-rose-600 mt-0.5 font-mono"
                    data-testid="picked-student-code"
                  >
                    Mã HS: {pickedStudent.code}
                  </p>
                </div>

                {/* Nút hành động: Chơi lại hoặc Lượt tiếp theo */}
                <div className="mt-2.5 sm:mt-3.5 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-outline flex-1 py-1.5 sm:py-2 font-bold text-xs sm:text-sm min-h-[36px] sm:min-h-[42px]"
                    onClick={handleResetGame}
                  >
                    <RotateCcw className="w-4 h-4" /> Đặt lại
                  </button>
                  <button
                    type="button"
                    className="btn-primary flex-1 py-1.5 sm:py-2 font-extrabold text-xs sm:text-sm min-h-[36px] sm:min-h-[42px] bg-gradient-to-r from-pink-500 to-orange-500 border-0 text-white"
                    onClick={handleStartGame}
                  >
                    <Play className="w-4 h-4 fill-white" /> Lượt tiếp theo
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* =====================================================================
          3. THANH ĐIỀU KHIỂN DƯỚI CÙNG (BOTTOM CONTROLS BAR)
         ===================================================================== */}
      <footer
        className={`w-full max-w-6xl mx-auto shrink-0 bg-white/95 backdrop-blur-md rounded-xl sm:rounded-2xl border-2 border-pink-200 shadow-soft px-2.5 sm:px-5 flex items-center justify-between gap-2 z-20 ${
          isCompactLandscape ? 'py-1 mt-0.5' : 'py-1.5 sm:py-2 mt-1'
        }`}
      >
        {/* Trạng thái tiến trình trực quan */}
        <div className="flex items-center gap-1.5 text-[11px] sm:text-xs font-bold text-ink-soft min-w-0 truncate">
          <span
            className={`w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full shrink-0 ${
              isRunning ? 'bg-emerald-500 animate-ping' : 'bg-amber-400'
            }`}
          />
          <span className="truncate">
            {stage === 'idle' && 'Sẵn sàng: Bấm "Bắt đầu" để các bạn học sinh rón rén vào lớp!'}
            {stage === 'sneak' && 'Giai đoạn 1: Các bạn học sinh đang rón rén đi qua chú chó ngủ...'}
            {stage === 'alarm' && 'Giai đoạn 2: Ái chà! Có bạn làm rơi chồng sách khiến chú chó thức giấc!'}
            {stage === 'chase' && `Giai đoạn 3: Chú chó đang đuổi bắt! Còn ${countdown} giây...`}
            {stage === 'caught' && 'Chú chó đã bắt kịp bạn học sinh may mắn!'}
            {stage === 'celebrate' && `Chúc mừng bạn ${pickedStudent?.fullName ?? ''} đã được chọn!`}
          </span>
        </div>

        {/* Các nút điều khiển lớn, rõ ràng */}
        <div className="flex items-center gap-1.5 sm:gap-2 ml-auto shrink-0">
          <button
            type="button"
            className={`btn-primary font-extrabold bg-gradient-to-r from-pink-500 to-amber-500 hover:from-pink-600 hover:to-amber-600 border-0 text-white shadow-sm ${
              isCompactLandscape ? 'px-3.5 py-1.5 h-8 text-xs' : 'px-4 sm:px-5 py-2 h-auto text-xs sm:text-sm'
            }`}
            onClick={handleStartGame}
            disabled={isRunning || totalStudents === 0}
          >
            <Play className="w-4 h-4 fill-white" />
            <span>{roundExhausted && noRepeat ? 'Bắt đầu vòng mới' : 'Bắt đầu'}</span>
          </button>

          {isRunning && (
            <button
              type="button"
              className={`btn-outline font-bold border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100 ${
                isCompactLandscape ? 'px-3 py-1 h-8 text-xs' : 'px-3.5 py-2 h-auto text-xs sm:text-sm'
              }`}
              onClick={handleTogglePause}
            >
              {isPaused ? (
                <>
                  <Play className="w-3.5 h-3.5 fill-amber-700" /> Tiếp tục
                </>
              ) : (
                <>
                  <Pause className="w-3.5 h-3.5" /> Tạm dừng
                </>
              )}
            </button>
          )}

          {stage === 'chase' && (
            <button
              type="button"
              className={`btn-outline font-bold border-pink-300 text-pink-700 bg-pink-50 hover:bg-pink-100 ${
                isCompactLandscape ? 'px-3 py-1 h-8 text-xs' : 'px-3.5 py-2 h-auto text-xs sm:text-sm'
              }`}
              onClick={finishChaseAndSelectStudent}
              title="Bỏ qua thời gian đếm ngược và chọn ngay học sinh"
            >
              <FastForward className="w-3.5 h-3.5" /> Bỏ qua ({countdown}s)
            </button>
          )}

          <button
            type="button"
            className={`btn-outline font-bold ${
              isCompactLandscape ? 'px-3 py-1 h-8 text-xs' : 'px-3.5 py-2 h-auto text-xs sm:text-sm'
            }`}
            onClick={handleResetGame}
            disabled={stage === 'idle' && !pickedStudent}
          >
            <RotateCcw className="w-3.5 h-3.5" /> Chơi lại
          </button>
        </div>
      </footer>

      {/* =====================================================================
          4. BẢNG TRƯỢT LỊCH SỬ GỌI TÊN (SLIDE-OVER DRAWER)
         ===================================================================== */}
      {showHistory && (
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-[2px] flex justify-end z-50 animate-fadeIn">
          <div className="bg-white w-full max-w-md h-full shadow-2xl border-l-2 border-pink-200 flex flex-col justify-between p-5">
            <div className="flex items-center justify-between pb-3 border-b border-pink-100">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-pink-500" />
                <h3 className="font-display font-black text-lg text-ink">
                  Lịch sử gọi tên ({picks?.length ?? 0})
                </h3>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowHistory(false)}
                aria-label="Đóng lịch sử"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto my-4 pr-1 space-y-2 scroll-soft">
              {!picks || picks.length === 0 ? (
                <p className="text-sm text-ink-soft text-center py-12">
                  Chưa có học sinh nào được gọi trong vòng này.
                </p>
              ) : (
                picks.map((p, index) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-3 rounded-2xl bg-pink-50/70 border border-pink-100"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-6 h-6 rounded-full bg-pink-500 text-white text-xs font-extrabold flex items-center justify-center">
                        {picks.length - index}
                      </span>
                      <span className="font-bold text-sm text-ink">{p.studentName}</span>
                    </div>
                    <span className="text-xs text-ink-soft">{formatDateTimeVN(p.createdAt)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="pt-3 border-t border-pink-100 flex items-center justify-between gap-2">
              {picks && picks.length > 0 && (
                <button
                  type="button"
                  className="btn-outline text-rose-600 border-rose-200 hover:bg-rose-50 flex-1 justify-center"
                  onClick={handleClearHistory}
                >
                  <Trash2 className="w-4 h-4" /> Xóa lịch sử / Vòng mới
                </button>
              )}
              <button
                type="button"
                className="btn-primary flex-1 justify-center"
                onClick={() => setShowHistory(false)}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
