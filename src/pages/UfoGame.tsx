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
  Rocket,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useGamePicks } from '../state/hooks';
import { pickRandom } from '../lib/picker';
import { saveGamePick, clearGamePicks } from '../data/repo';
import { AnimalAvatarSVG } from '../components/avatars';
import { formatDateTimeVN } from '../lib/utils';
import { useToast } from '../components/ToastNotification';
import { useGameOrientationAndFullscreen, LandscapeRotateOverlay } from '../components/LandscapeFullscreenGuard';
import type { Student } from '../types';

export type UfoGameStage = 'idle' | 'scan' | 'abduct' | 'celebrate';

export type AbductStep =
  | 'none'
  | 'lock_on' // Bước 1: Khóa mục tiêu (1.2s)
  | 'beam_activate' // Bước 2: Kích hoạt tia hút (1.4s)
  | 'ascend' // Bước 3: Học sinh từ từ bay lên (3.5s)
  | 'enter_ufo' // Bước 4: Đưa vào UFO & thu tia sáng (1.4s)
  | 'wait_reveal' // Bước 5 nhịp chờ trước khi mở modal vinh danh (0.8s)
  // Các bước gắp thử rồi thả xuống:
  | 'fake_lock' // Khóa mục tiêu bạn thử (0.9s)
  | 'fake_beam' // Kích hoạt tia hút thử (0.8s)
  | 'fake_lift' // Nhấc chân bay lên một đoạn 40-50% (1.4s)
  | 'fake_drop'; // Từ từ hạ xuống an toàn (1.2s)

export interface ChibiStudent {
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
  isTarget: boolean;
  facing: 1 | -1;
  stepOffset: number;
  // Hoạt ảnh học sinh bị hút bay lên UFO
  isFloating: boolean;
  floatProgress: number; // 0 (mặt đất) -> 1 (đã bay tới cửa hút UFO)
  baseY: number;
  opacity: number; // Độ mờ khi vào trong bụng UFO (1 -> 0)
  scale: number; // Tỉ lệ co nhỏ khi vào UFO (1 -> 0.2)
  // Hoạt ảnh di chuyển tự nhiên & chạy toán loạn
  isMoving: boolean;
  pauseTimer: number;
  panicTimer: number;
  emote: 'none' | 'shock' | 'sweat' | 'awe';
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  rotation: number;
  vRot: number;
  type?: 'confetti' | 'star' | 'beam_spark' | 'cosmic_dust' | 'dust';
}

// Bảng tài nguyên sprite hình ảnh 2D Kawaii
const ASSETS = {
  bg: '/assets/game/ufo_school_bg.jpg',
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
};

// Ranh giới khu vực chơi hợp lệ (Walkable Zone Boundaries trên sân trường đêm)
// Kích thước canvas chuẩn logic: 1000 x 560
export const UFO_BOUNDS = {
  // Sân trường đi lại hợp lệ (sân gạch rộng phía trước trường tiểu học)
  minX: 110,
  maxX: 890,
  minY: 350,
  maxY: 495,
  // Bầu trời UFO tuần tra di chuyển
  ufo: {
    minX: 180,
    maxX: 820,
    hoverY: 110,
    scanMinY: 90,
    scanMaxY: 130,
  },
};

// Tính toán vị trí ban đầu của các bạn học sinh rải đều trên sân trường
export function calculateStudentSlots(total: number): Array<{ x: number; y: number }> {
  if (total <= 0) return [];
  const positions: Array<{ x: number; y: number }> = [];
  const cols = Math.min(Math.max(total, 1), 6);
  const rows = Math.ceil(total / cols);

  const startX = 150;
  const endX = 850;
  const startY = 365;
  const endY = 485;

  const stepX = cols > 1 ? (endX - startX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (endY - startY) / (rows - 1) : 0;

  for (let i = 0; i < total; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // So le tự nhiên giữa các hàng để học sinh không che nhau
    const stagger = row % 2 === 1 ? stepX * 0.4 : 0;
    const x = Math.min(880, Math.max(120, startX + col * stepX + stagger + ((i * 17) % 25 - 12)));
    const y = Math.min(490, Math.max(350, startY + row * stepY + ((i * 13) % 15 - 7)));
    positions.push({ x, y });
  }

  return positions;
}

export default function UfoGamePage() {
  const navigate = useNavigate();
  const { currentClass, settings } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const picks = useGamePicks(classId);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Cấu hình trò chơi
  const [noRepeat, setNoRepeat] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  // Trạng thái kịch bản 4 phân cảnh (idle -> scan -> abduct -> celebrate)
  const [stage, setStage] = useState<UfoGameStage>('idle');
  const [abductStep, setAbductStep] = useState<AbductStep>('none');
  const [isPaused, setIsPaused] = useState(false);
  const [countdown, setCountdown] = useState<number>(10);
  const [pickedStudent, setPickedStudent] = useState<Student | null>(null);
  const [roundExhausted, setRoundExhausted] = useState(false);

  // Lưu trạng thái đang chơi trước khi xoay dọc để bảo toàn tiến trình
  const wasPlayingBeforeRotateRef = useRef<boolean>(false);

  // Hook quản lý xoay ngang bắt buộc và toàn màn hình
  const {
    isPortrait,
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
      // Khi xoay ngang lại: lớp phủ tự ẩn, giữ nguyên trạng thái để người dùng bấm tiếp tục an toàn
    },
  });

  const isLandscape = !isPortrait;

  // Danh sách ID đã được chọn
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

  // Audio Context & BGM synthesizer
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bgmTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abductSequenceTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Bộ nhớ đệm tài nguyên hình ảnh Image elements
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});

  // Delta time clock ref
  const lastTimeRef = useRef<number>(performance.now());

  // Trạng thái bộ nhớ hoạt ảnh Canvas
  const stateRef = useRef({
    stage: 'idle' as UfoGameStage,
    abductStep: 'none' as AbductStep,
    abductStepTime: 0,
    isPaused: false,
    frame: 0,
    elapsedTime: 0,
    countdown: 10,
    students: [] as ChibiStudent[],
    particles: [] as Particle[],
    cosmicDust: [] as Particle[],
    ufo: {
      x: 500,
      y: UFO_BOUNDS.ufo.hoverY,
      targetX: 500,
      targetY: UFO_BOUNDS.ufo.hoverY,
      vx: 0,
      vy: 0,
      speed: 130,
      tilt: 0,
      targetTilt: 0,
      lightPhase: 0,
      beamActive: false,
      beamIntensity: 0,
      beamWidth: 80,
      shakeAmount: 0,
      bodyGlow: 0,
    },
    targetStudentId: null as string | null,
    targetChar: null as ChibiStudent | null,
    roundId: '',
  });

  // Tải trước toàn bộ Sprite 2D & Background
  useEffect(() => {
    const loadImg = (key: string, src: string) => {
      const img = new Image();
      img.src = src;
      imagesRef.current[key] = img;
    };

    loadImg('bg', ASSETS.bg);
    loadImg('boy_sneak', ASSETS.boy.sneak);
    loadImg('boy_alarm', ASSETS.boy.alarm);
    loadImg('boy_run', ASSETS.boy.run);
    loadImg('boy_celebrate', ASSETS.boy.celebrate);

    loadImg('girl_sneak', ASSETS.girl.sneak);
    loadImg('girl_alarm', ASSETS.girl.alarm);
    loadImg('girl_run', ASSETS.girl.run);
    loadImg('girl_celebrate', ASSETS.girl.celebrate);
  }, []);

  // Đồng bộ stage và paused vào ref
  useEffect(() => {
    stateRef.current.stage = stage;
  }, [stage]);

  useEffect(() => {
    stateRef.current.abductStep = abductStep;
    stateRef.current.abductStepTime = 0;
  }, [abductStep]);

  useEffect(() => {
    stateRef.current.isPaused = isPaused;
    if (!isPaused) {
      lastTimeRef.current = performance.now();
    }
  }, [isPaused]);

  useEffect(() => {
    stateRef.current.countdown = countdown;
  }, [countdown]);

  // Khởi tạo các hạt bụi sao lấp lánh trong không gian đêm
  useEffect(() => {
    const dust: Particle[] = [];
    for (let i = 0; i < 24; i++) {
      dust.push({
        x: Math.random() * 1000,
        y: Math.random() * 320,
        vx: (Math.random() - 0.5) * 12,
        vy: (Math.random() - 0.5) * 8,
        color: ['#A7F3D0', '#FDE047', '#93C5FD', '#F472B6', '#E9D5FF'][i % 5],
        size: 1.5 + Math.random() * 2.5,
        alpha: 0.3 + Math.random() * 0.7,
        rotation: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 2,
        type: 'cosmic_dust',
      });
    }
    stateRef.current.cosmicDust = dust;
  }, []);

  // =========================================================================
  // ÂM THANH: WEB AUDIO SYNTHESIZER (HIỆU ỨNG SCI-FI KAWAII)
  // =========================================================================
  const getAudioContext = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  // Rung phản hồi cảm ứng xúc giác (Haptic Feedback) trên điện thoại khi hỗ trợ
  const triggerHaptic = useCallback((pattern: number | number[] = 40) => {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Bỏ qua nếu trình duyệt không hỗ trợ hoặc không cấp quyền
      }
    }
  }, []);

  const playSfx = useCallback((type: 'scan' | 'lock' | 'beam' | 'fanfare' | 'tick' | 'whoosh' | 'pop' | 'enter' | 'drop') => {
    if (!soundEnabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'scan') {
      // Âm thanh radar quét không gian
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.22);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.26);
    } else if (type === 'lock') {
      // Âm thanh khóa mục tiêu
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(659.25, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
      osc.frequency.setValueAtTime(1174.66, now + 0.16);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'beam') {
      // Âm thanh tia sáng hút UFO bồng bềnh
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.6);
      osc.frequency.exponentialRampToValueAtTime(440, now + 1.2);
      gain.gain.setValueAtTime(0.02, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
      osc.start(now);
      osc.stop(now + 1.55);
    } else if (type === 'tick') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(987.77, now);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'fanfare') {
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      notes.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(freq, now + idx * 0.1);
        g.gain.setValueAtTime(0, now);
        g.gain.setValueAtTime(0.24, now + idx * 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.5);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + idx * 0.1);
        o.stop(now + idx * 0.1 + 0.55);
      });
    } else if (type === 'whoosh') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(450, now + 0.15);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.35);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.36);
    } else if (type === 'pop') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(800, now + 0.07);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.09);
    } else if (type === 'enter') {
      // Âm thanh hút gọn vào bụng UFO kèm tiếng chuông nhẹ
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.2);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.4);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.start(now);
      osc.stop(now + 0.46);
    } else if (type === 'drop') {
      // Âm thanh nhẹ nhàng khi UFO đổi ý thả học sinh xuống mặt đất
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(261.63, now + 0.35);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  }, [soundEnabled, getAudioContext]);

  // Nhạc nền BGM không gian vui nhộn Kawaii
  useEffect(() => {
    if (!musicEnabled) {
      if (bgmTimerRef.current) {
        clearInterval(bgmTimerRef.current);
        bgmTimerRef.current = null;
      }
      return;
    }

    const spaceMelody = [329.63, 392.0, 493.88, 587.33, 659.25, 587.33, 493.88, 392.0];
    let noteIdx = 0;

    bgmTimerRef.current = setInterval(() => {
      const ctx = getAudioContext();
      if (!ctx || ctx.state !== 'running') return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(spaceMelody[noteIdx % spaceMelody.length], now);
      noteIdx++;

      gain.gain.setValueAtTime(0.03, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.38);
    }, 450);

    return () => {
      if (bgmTimerRef.current) {
        clearInterval(bgmTimerRef.current);
        bgmTimerRef.current = null;
      }
    };
  }, [musicEnabled, getAudioContext]);

  // Dọn dẹp triệt để AudioContext và các timer khi component unmount
  useEffect(() => {
    return () => {
      if (bgmTimerRef.current) {
        clearInterval(bgmTimerRef.current);
        bgmTimerRef.current = null;
      }
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      abductSequenceTimersRef.current.forEach((t) => clearTimeout(t));
      abductSequenceTimersRef.current = [];
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Khởi tạo học sinh trong lớp trên sân trường
  useEffect(() => {
    if (!students || students.length === 0) {
      stateRef.current.students = [];
      return;
    }

    const count = students.length;
    const slots = calculateStudentSlots(count);

    const reconciled: ChibiStudent[] = students.map((s, idx) => {
      const slot = slots[idx] || { x: 200 + (idx % 6) * 110, y: 380 + Math.floor(idx / 6) * 50 };
      return {
        student: s,
        x: slot.x,
        y: slot.y,
        startX: slot.x,
        startY: slot.y,
        targetX: slot.x + (Math.random() * 40 - 20),
        targetY: slot.y + (Math.random() * 20 - 10),
        vx: 0,
        vy: 0,
        speed: 24 + (idx % 3) * 4,
        gender: s.gender === 'female' ? 'female' : 'male',
        isTarget: false,
        facing: (idx % 2 === 0 ? 1 : -1) as 1 | -1,
        stepOffset: (idx * Math.PI) / 3,
        isFloating: false,
        floatProgress: 0,
        baseY: slot.y,
        opacity: 1,
        scale: 1,
        isMoving: true,
        pauseTimer: Math.random() * 2,
        panicTimer: Math.random() * 0.8,
        emote: 'none',
      };
    });

    stateRef.current.students = reconciled;
  }, [students]);

  // Sinh hiệu ứng ăn mừng pháo hoa giấy & ngôi sao lấp lánh (tối ưu số lượng trên thiết bị di động để mượt mà)
  const spawnCelebrationParticles = (centerX: number, centerY: number) => {
    const isMobileDevice = typeof window !== 'undefined' && window.innerWidth < 768;
    const colors = ['#F43F5E', '#EC4899', '#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#FBBF24', '#06B6D4', '#E879F9'];
    const parts: Particle[] = [];

    // Confetti: 45 hạt trên điện thoại, 80 hạt trên máy tính để tiết kiệm CPU/GPU
    const confettiCount = isMobileDevice ? 45 : 80;
    for (let i = 0; i < confettiCount; i++) {
      const angle = (Math.PI * 2 * i) / confettiCount + (Math.random() * 0.4 - 0.2);
      const speed = 110 + Math.random() * 190;
      parts.push({
        x: centerX + (Math.random() * 80 - 40),
        y: centerY + (Math.random() * 40 - 20),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 130,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 6 + Math.random() * 4,
        alpha: 1,
        rotation: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 8,
        type: 'confetti',
      });
    }

    // Sao bay rực rỡ: 16 hạt trên mobile, 28 hạt trên máy tính
    const starCount = isMobileDevice ? 16 : 28;
    for (let i = 0; i < starCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 120;
      parts.push({
        x: centerX,
        y: centerY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: '#FDE047',
        size: 8 + Math.random() * 5,
        alpha: 1,
        rotation: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 4,
        type: 'star',
      });
    }

    stateRef.current.particles = parts;
  };

  // =========================================================================
  // VÒNG LẶP RENDER CANVAS 2D CHUẨN DELTA TIME (TỐC ĐỘ ỔN ĐỊNH TRÊN MỌI THIẾT BỊ)
  // =========================================================================
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    lastTimeRef.current = performance.now();

    const render = (time: number) => {
      // 1. Delta time (giây) mượt mà, chặn giật tối đa 0.05s
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = time;

      const state = stateRef.current;
      const { stage: currentStage, isPaused: paused, students: chibiList, ufo, particles, cosmicDust } = state;
      const imgs = imagesRef.current;

      if (!paused) {
        state.frame++;
        state.elapsedTime += dt;
        ufo.lightPhase += dt * 5;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // =======================================================================
      // 1. VẼ BACKGROUND SÂN TRƯỜNG KHÔNG GIAN THẬT (GIỮ ĐÚNG TỈ LỆ 16:9, KHÔNG MÉO)
      // =======================================================================
      const bgImg = imgs.bg;
      if (bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
        ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);
      } else {
        // Fallback bầu trời đêm
        const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        skyGrad.addColorStop(0, '#0F172A');
        skyGrad.addColorStop(0.5, '#1E1B4B');
        skyGrad.addColorStop(1, '#312E81');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Lớp bụi sao vũ trụ lấp lánh
      cosmicDust.forEach((star) => {
        if (!paused) {
          star.x += star.vx * dt;
          star.y += star.vy * dt;
          if (star.x < 0) star.x = 1000;
          if (star.x > 1000) star.x = 0;
          if (star.y < 0) star.y = 320;
          if (star.y > 320) star.y = 0;
        }
        ctx.save();
        ctx.globalAlpha = star.alpha * (0.6 + 0.4 * Math.sin(state.elapsedTime * 2 + star.rotation));
        ctx.fillStyle = star.color;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // Biển tên lớp học phong cách Hologram không gian
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.beginPath();
      ctx.roundRect(800, 20, 180, 32, 10);
      ctx.fill();
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.8;
      ctx.shadowColor = '#38BDF8';
      ctx.shadowBlur = 8;
      ctx.stroke();

      ctx.fillStyle = '#E0F2FE';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`🛸 ${currentClass?.name ?? 'Lớp 5A'} 🌟`, 890, 41);
      ctx.restore();

      // =======================================================================
      // 2. CẬP NHẬT VỊ TRÍ VÀ TRẠNG THÁI CỦA UFO
      // =======================================================================
      if (!paused) {
        state.abductStepTime += dt;

        if (currentStage === 'idle') {
          // Bay lơ lửng nhẹ nhàng tại trung tâm, chuyển động mềm mại
          ufo.targetX = 500;
          ufo.targetY = UFO_BOUNDS.ufo.hoverY + Math.sin(state.elapsedTime * 1.5) * 6;
          ufo.targetTilt = 0;
          ufo.beamActive = false;
          ufo.beamIntensity = 0;
          ufo.shakeAmount = 0;
          ufo.bodyGlow = 0;
        } else if (currentStage === 'scan') {
          // Tuần tra chậm rãi với đường bay cong mềm mại (Lissajous figure-8 / smooth wave)
          const patrolPeriod = 7.5; // Chậm hơn đáng kể (7.5s/chu kỳ thay vì 4.2s)
          const phase = (state.elapsedTime / patrolPeriod) * Math.PI * 2;
          const sweepX = Math.sin(phase);
          const sweepY = Math.sin(phase * 2) * 0.5;

          // Giới hạn trong vùng hiển thị an toàn (220 -> 780)
          ufo.targetX = 500 + sweepX * 240;
          ufo.targetY = UFO_BOUNDS.ufo.hoverY + sweepY * 16;
          ufo.targetTilt = -Math.cos(phase) * 0.05; // Nghiêng thân xe mềm mại theo hướng chuyển động
          ufo.beamActive = true;
          ufo.beamWidth = 130;
          ufo.beamIntensity = 0.5 + Math.sin(state.elapsedTime * 3) * 0.15;
          ufo.shakeAmount = 0;
          ufo.bodyGlow = 0.3;
        } else if (currentStage === 'abduct' && state.targetChar) {
          const step = state.abductStep;
          const stepTime = state.abductStepTime;

          if (step === 'lock_on' || step === 'fake_lock') {
            // Bước 1 / fake_lock: UFO giảm tốc từ từ tiến thẳng đến phía trên đầu học sinh
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY;
            ufo.targetTilt = (state.targetChar.x - ufo.x) * 0.0006;
            ufo.beamActive = true;
            ufo.beamWidth = 26; // Tia laser mảnh khóa mục tiêu
            ufo.beamIntensity = Math.min(1, stepTime / 0.4);
            ufo.shakeAmount = 0;
            ufo.bodyGlow = 0.4;
          } else if (step === 'beam_activate' || step === 'fake_beam') {
            // Bước 2 / fake_beam: Kích hoạt luồng hút Tractor Beam mở rộng từ từ
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY;
            ufo.targetTilt = 0;
            ufo.beamActive = true;
            const openProgress = Math.min(1, stepTime / 0.8);
            ufo.beamWidth = 30 + openProgress * 70; // Mở rộng từ 30 -> 100
            ufo.beamIntensity = 0.6 + openProgress * 0.4;
            ufo.shakeAmount = 0;
            ufo.bodyGlow = 0.7;

            // Sinh các hạt sáng năng lượng bay từ mặt đất lên UFO
            if (state.frame % 3 === 0) {
              particles.push({
                x: state.targetChar.x + (Math.random() * 60 - 30),
                y: 380 + Math.random() * 80,
                vx: (Math.random() - 0.5) * 15,
                vy: -(70 + Math.random() * 90),
                color: '#FEF08A',
                size: 2.5 + Math.random() * 2,
                alpha: 0.9,
                rotation: Math.random() * Math.PI * 2,
                vRot: (Math.random() - 0.5) * 4,
                type: 'beam_spark',
              });
            }
          } else if (step === 'ascend' || step === 'fake_lift') {
            // Bước 3 / fake_lift: Học sinh từ từ bay lên, UFO giữ cố định hoàn toàn
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY;
            ufo.targetTilt = 0;
            ufo.beamActive = true;
            ufo.beamWidth = 100;
            ufo.beamIntensity = 1;
            ufo.shakeAmount = 0;
            ufo.bodyGlow = 0.9;

            // Hạt sáng năng lượng cuộn xoáy quanh học sinh bay lên
            if (state.frame % 2 === 0) {
              particles.push({
                x: state.targetChar.x + (Math.random() * 70 - 35),
                y: state.targetChar.y + (Math.random() * 30 - 15),
                vx: (Math.random() - 0.5) * 20,
                vy: -(60 + Math.random() * 80),
                color: Math.random() > 0.4 ? '#38BDF8' : '#FDE047',
                size: 3 + Math.random() * 2.5,
                alpha: 1,
                rotation: Math.random() * Math.PI * 2,
                vRot: (Math.random() - 0.5) * 6,
                type: 'beam_spark',
              });
            }
          } else if (step === 'fake_drop') {
            // fake_drop: Thả học sinh xuống mặt đất, tia sáng mờ dần rồi thu lại
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY;
            ufo.targetTilt = 0;
            const dropProgress = Math.min(1, stepTime / 1.1);
            ufo.beamActive = dropProgress < 0.9;
            ufo.beamWidth = Math.max(20, 100 * (1 - dropProgress * 0.7));
            ufo.beamIntensity = Math.max(0, 1 - dropProgress);
            ufo.shakeAmount = 0;
            ufo.bodyGlow = 0.4;
          } else if (step === 'enter_ufo') {
            // Bước 4: Đưa vào UFO & tia sáng thu hẹp dần (1.4s), UFO phát sáng & rung nhẹ
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY;
            ufo.targetTilt = 0;
            const closeProgress = Math.min(1, stepTime / 1.0);
            ufo.beamActive = closeProgress < 0.95;
            ufo.beamWidth = Math.max(0, 100 * (1 - closeProgress));
            ufo.beamIntensity = Math.max(0, 1 - closeProgress);
            ufo.shakeAmount = (1 - closeProgress) * 2.5; // Rung nhẹ hoàn tất
            ufo.bodyGlow = 1;
          } else {
            // Bước 5 (wait_reveal): UFO lơ lửng ổn định
            ufo.targetX = state.targetChar.x;
            ufo.targetY = UFO_BOUNDS.ufo.hoverY + Math.sin(state.elapsedTime * 2) * 4;
            ufo.targetTilt = 0;
            ufo.beamActive = false;
            ufo.shakeAmount = 0;
            ufo.bodyGlow = 0.5;
          }
        } else if (currentStage === 'celebrate') {
          ufo.targetY = 110 + Math.sin(state.elapsedTime * 2) * 5;
          ufo.targetTilt = 0;
          ufo.beamActive = false;
          ufo.shakeAmount = 0;
          ufo.bodyGlow = 0.4;
        }

        // Chuyển động quán tính mượt mà với damping mềm mại (smooth ease-in-out)
        const lerpFactor = currentStage === 'scan' ? Math.min(1, dt * 1.8) : Math.min(1, dt * 2.8);
        ufo.x += (ufo.targetX - ufo.x) * lerpFactor;
        ufo.y += (ufo.targetY - ufo.y) * lerpFactor;
        ufo.tilt += (ufo.targetTilt - ufo.tilt) * (dt * 3.5);

        // Hiệu ứng rung nhẹ UFO khi hút hoàn tất
        if (ufo.shakeAmount > 0.05) {
          ufo.x += (Math.random() - 0.5) * ufo.shakeAmount;
          ufo.y += (Math.random() - 0.5) * ufo.shakeAmount;
        }
      }

      // =======================================================================
      // 3. VẼ TIA QUÉT ÁNH SÁNG & TRACTOR BEAM CỦA UFO
      // =======================================================================
      if (ufo.beamActive && ufo.beamWidth > 1) {
        ctx.save();
        ctx.translate(ufo.x, ufo.y + 24);
        ctx.rotate(ufo.tilt);

        const beamGroundY = 370; // Chiều dài nón ánh sáng chạm mặt đất
        const halfTop = Math.min(18, ufo.beamWidth * 0.4);
        const halfBottom = ufo.beamWidth;
        const intensity = ufo.beamIntensity;

        // Gradient phát sáng của luồng ánh sáng gắp / quét
        const beamGrad = ctx.createLinearGradient(0, 0, 0, beamGroundY);
        if (currentStage === 'scan') {
          beamGrad.addColorStop(0, `rgba(56, 189, 248, ${0.7 * intensity})`);
          beamGrad.addColorStop(0.3, `rgba(14, 165, 233, ${0.35 * intensity})`);
          beamGrad.addColorStop(1, `rgba(56, 189, 248, ${0.05 * intensity})`);
        } else if (state.abductStep === 'lock_on' || state.abductStep === 'fake_lock') {
          // Tia laser mảnh màu đỏ/cam khóa mục tiêu
          beamGrad.addColorStop(0, `rgba(244, 63, 94, ${0.85 * intensity})`);
          beamGrad.addColorStop(0.5, `rgba(251, 146, 60, ${0.45 * intensity})`);
          beamGrad.addColorStop(1, `rgba(244, 63, 94, ${0.1 * intensity})`);
        } else {
          // Tractor beam gắp học sinh: màu vàng kim & cyan cực quang
          beamGrad.addColorStop(0, `rgba(254, 240, 138, ${0.85 * intensity})`);
          beamGrad.addColorStop(0.3, `rgba(250, 204, 21, ${0.45 * intensity})`);
          beamGrad.addColorStop(0.7, `rgba(56, 189, 248, ${0.35 * intensity})`);
          beamGrad.addColorStop(1, `rgba(56, 189, 248, ${0.08 * intensity})`);
        }

        // Hình nón tia sáng
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(-halfTop, 0);
        ctx.lineTo(halfTop, 0);
        ctx.lineTo(halfBottom, beamGroundY);
        ctx.lineTo(-halfBottom, beamGroundY);
        ctx.closePath();
        ctx.fill();

        // Đường viền neon phát quang của tia sáng
        const isReticle = state.abductStep === 'lock_on' || state.abductStep === 'fake_lock';
        const strokeColor =
          currentStage === 'scan'
            ? `rgba(56, 189, 248, ${0.8 * intensity})`
            : isReticle
              ? `rgba(244, 63, 94, ${0.9 * intensity})`
              : `rgba(253, 224, 71, ${0.9 * intensity})`;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = isReticle ? 1.5 : 2;
        ctx.beginPath();
        ctx.moveTo(-halfTop, 0);
        ctx.lineTo(-halfBottom, beamGroundY);
        ctx.moveTo(halfTop, 0);
        ctx.lineTo(halfBottom, beamGroundY);
        ctx.stroke();

        // Vòng tròn năng lượng khóa mục tiêu / quét trên mặt đất
        ctx.save();
        ctx.translate(0, beamGroundY);
        ctx.fillStyle =
          currentStage === 'scan'
            ? `rgba(56, 189, 248, ${0.25 * intensity})`
            : isReticle
              ? `rgba(244, 63, 94, ${0.3 * intensity})`
              : `rgba(250, 204, 21, ${0.4 * intensity})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, halfBottom, 22, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle =
          currentStage === 'scan'
            ? '#38BDF8'
            : isReticle
              ? '#F43F5E'
              : '#FDE047';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = isReticle ? '#F43F5E' : '#38BDF8';
        ctx.shadowBlur = 12;
        ctx.stroke();

        // Thước ngắm laser xoay quanh vòng tròn khóa mục tiêu ở Bước lock-on
        if (isReticle) {
          ctx.rotate(state.elapsedTime * 4);
          ctx.strokeStyle = '#FDE047';
          ctx.lineWidth = 2;
          for (let k = 0; k < 4; k++) {
            const rot = (k * Math.PI) / 2;
            ctx.beginPath();
            ctx.arc(0, 0, halfBottom + 6, rot - 0.2, rot + 0.2);
            ctx.stroke();
          }
        }

        ctx.restore();

        // Vòng sóng ánh sáng năng lượng di chuyển dọc theo luồng hút
        if (!isReticle) {
          for (let r = 0; r < 4; r++) {
            const ringProgress = (state.elapsedTime * 1.2 + r * 0.25) % 1;
            const ringY = currentStage === 'scan' ? ringProgress * beamGroundY : (1 - ringProgress) * beamGroundY;
            const ringScale = halfTop + (halfBottom - halfTop) * (ringY / beamGroundY);

            ctx.save();
            ctx.translate(0, ringY);
            ctx.strokeStyle =
              currentStage === 'scan'
                ? `rgba(56, 189, 248, ${0.7 * (1 - ringProgress) * intensity})`
                : `rgba(254, 240, 138, ${0.85 * (1 - ringY / beamGroundY) * intensity})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(0, 0, ringScale, ringScale * 0.24, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }

        ctx.restore();
      }

      // =======================================================================
      // 4. CẬP NHẬT & VẼ HỌC SINH (Y-SORTING ĐỘ SÂU, BƯỚC CHÂN, HIỆU ỨNG HÚT BAY LÊN)
      // =======================================================================
      const numStudents = chibiList.length;

      chibiList.forEach((char, i) => {
        if (!paused) {
          if (currentStage === 'idle') {
            // DI CHUYỂN BÌNH THƯỜNG KHÔNG CỨNG NHẮC:
            // Bước đi thong dong, dừng lại ngó nghiêng rồi chọn điểm đến mới quanh vị trí
            if (char.pauseTimer > 0) {
              char.pauseTimer -= dt;
              char.isMoving = false;
              char.vx *= 0.82;
              char.vy *= 0.82;
            } else {
              char.isMoving = true;
              const wanderDist = Math.hypot(char.targetX - char.x, char.targetY - char.y);
              if (wanderDist < 8) {
                // Đã tới nơi: dừng lại nghỉ chân 1.2s - 2.5s ngắm sân trường
                char.pauseTimer = 1.2 + Math.random() * 1.5;
                char.targetX = char.startX + (Math.random() * 70 - 35);
                char.targetY = char.startY + (Math.random() * 40 - 20);
              } else {
                const dx = char.targetX - char.x;
                const dy = char.targetY - char.y;
                const dist = Math.hypot(dx, dy);
                char.facing = dx > 0 ? 1 : -1;
                const targetVx = (dx / dist) * char.speed;
                const targetVy = (dy / dist) * char.speed;
                char.vx += (targetVx - char.vx) * dt * 4;
                char.vy += (targetVy - char.vy) * dt * 4;
                char.x += char.vx * dt;
                char.y += char.vy * dt;
              }
            }
          } else if (currentStage === 'scan') {
            // PHÁT HIỆN UFO: HỌC SINH BẮT ĐẦU CHẠY TOÁN LOẠN!
            char.isMoving = true;
            char.emote = i % 2 === 0 ? 'shock' : 'sweat';
            const panicSpeed = 95 + (i % 4) * 8; // Tốc độ chạy hối hả

            char.panicTimer -= dt;
            if (char.panicTimer <= 0) {
              // Định kỳ 0.6s - 1.2s đổi hướng chạy zig-zag toán loạn
              char.panicTimer = 0.6 + Math.random() * 0.7;
              char.targetX = UFO_BOUNDS.minX + Math.random() * (UFO_BOUNDS.maxX - UFO_BOUNDS.minX);
              char.targetY = UFO_BOUNDS.minY + Math.random() * (UFO_BOUNDS.maxY - UFO_BOUNDS.minY);
            }

            // Xung lực né tránh cực mạnh nếu UFO hoặc luồng quét ở gần
            const distToUfoX = char.x - ufo.x;
            if (Math.abs(distToUfoX) < 160) {
              const dodgeDir = distToUfoX >= 0 ? 1 : -1;
              char.targetX += dodgeDir * 140;
            }

            const dx = char.targetX - char.x;
            const dy = char.targetY - char.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 4) {
              char.facing = dx > 0 ? 1 : -1;
              const targetVx = (dx / dist) * panicSpeed;
              const targetVy = (dy / dist) * panicSpeed;
              char.vx += (targetVx - char.vx) * dt * 7;
              char.vy += (targetVy - char.vy) * dt * 7;
              char.x += char.vx * dt;
              char.y += char.vy * dt;

              // Thỉnh thoảng tung bụi hoạt hình dưới chân khi chạy toán loạn
              if (state.frame % 8 === 0) {
                particles.push({
                  x: char.x - char.facing * 8,
                  y: char.y + 32,
                  vx: -char.facing * (15 + Math.random() * 20),
                  vy: -Math.random() * 15,
                  color: 'rgba(241, 245, 249, 0.65)',
                  size: 3.5 + Math.random() * 2.5,
                  alpha: 0.65,
                  rotation: Math.random() * Math.PI * 2,
                  vRot: (Math.random() - 0.5) * 4,
                  type: 'dust',
                });
              }
            }
          } else if (currentStage === 'abduct') {
            const step = state.abductStep;
            const stepTime = state.abductStepTime;

            if (char.isTarget) {
              if (step === 'lock_on' || step === 'fake_lock') {
                // Bước 1 / fake_lock: Đứng yên, học sinh nhận ra mình bị khóa mục tiêu
                char.isMoving = false;
                char.isFloating = false;
                char.floatProgress = 0;
                char.opacity = 1;
                char.scale = 1;
                char.emote = 'shock';
                char.x += (ufo.x - char.x) * dt * 4; // Căn thẳng hàng hoàn hảo
              } else if (step === 'beam_activate' || step === 'fake_beam') {
                // Bước 2 / fake_beam: Luồng hút mở rộng, học sinh phát sáng nhẹ, chuẩn bị nhấc chân
                char.isMoving = false;
                char.isFloating = false;
                char.floatProgress = 0;
                char.opacity = 1;
                char.scale = 1;
                char.emote = 'awe';
              } else if (step === 'fake_lift') {
                // Gắp thử: Học sinh từ từ nhấc chân bay lên khoảng 40% - 50% độ cao
                char.isFloating = true;
                const liftRatio = Math.min(1, Math.max(0, stepTime / 1.4));
                const smoothLift = (liftRatio * liftRatio * (3 - 2 * liftRatio)) * 0.42; // Tối đa 42%
                char.floatProgress = smoothLift;
                const targetFlyY = ufo.y + 36;
                char.y = char.baseY - (char.baseY - targetFlyY) * smoothLift;
                char.x += (ufo.x - char.x) * dt * 5;
                char.opacity = 1;
                char.scale = 1;
                char.emote = 'shock';
              } else if (step === 'fake_drop') {
                // Thả xuống: Học sinh từ từ hạ chân chạm lại mặt đất
                char.isFloating = true;
                const dropRatio = Math.min(1, Math.max(0, stepTime / 1.1));
                const smoothDrop = (1 - dropRatio * dropRatio * (3 - 2 * dropRatio)) * 0.42;
                char.floatProgress = Math.max(0, smoothDrop);
                const targetFlyY = ufo.y + 36;
                char.y = char.baseY - (char.baseY - targetFlyY) * Math.max(0, smoothDrop);
                char.opacity = 1;
                char.scale = 1;
                char.emote = dropRatio > 0.8 ? 'sweat' : 'shock';
                if (dropRatio >= 0.98) {
                  char.isFloating = false;
                  char.floatProgress = 0;
                  char.y = char.baseY;
                }
              } else if (step === 'ascend') {
                // Bước 3 (3.5s): Học sinh từ từ bay lên theo phương thẳng đứng (ease-in-out)
                char.isFloating = true;
                const ascendRatio = Math.min(1, Math.max(0, stepTime / 3.5));
                // Hàm ease-in-out mượt mà: 3 * t^2 - 2 * t^3
                const smoothAscend = ascendRatio * ascendRatio * (3 - 2 * ascendRatio);
                char.floatProgress = smoothAscend;
                const targetFlyY = ufo.y + 36;
                char.y = char.baseY - (char.baseY - targetFlyY) * smoothAscend;
                char.x += (ufo.x - char.x) * dt * 5; // Luôn giữ thẳng đứng dưới UFO
                char.opacity = 1;
                char.scale = 1;
                char.emote = 'none';
              } else if (step === 'enter_ufo') {
                // Bước 4 (1.4s): Đưa vào bụng UFO, thu nhỏ dần theo phối cảnh và mờ dần
                char.isFloating = true;
                char.floatProgress = 1;
                const enterRatio = Math.min(1, Math.max(0, stepTime / 1.1));
                char.scale = Math.max(0.1, 1 - enterRatio * 0.85); // Thu nhỏ 1 -> 0.15
                char.opacity = Math.max(0, 1 - enterRatio * 1.1); // Mờ dần biến mất
                char.y = ufo.y + 36 - enterRatio * 16; // Hút thẳng vào đáy UFO
                char.x = ufo.x;
              } else {
                // Bước 5 (wait_reveal) & celebrate: Ẩn hoàn toàn trong bụng UFO
                char.isFloating = true;
                char.floatProgress = 1;
                char.opacity = 0;
                char.scale = 0.1;
              }
            } else {
              // Các bạn khác: Dừng lại ngay, ngước nhìn về bạn được chọn với biểu cảm ngạc nhiên
              char.vx *= 0.7;
              char.vy *= 0.7;
              char.x += char.vx * dt;
              char.y += char.vy * dt;
              char.isMoving = false;
              char.emote = 'awe';
              if (state.targetChar) {
                char.facing = state.targetChar.x > char.x ? 1 : -1;
              }
            }
          }

          // Tránh chồng lấn nhau trên mặt đất khi không bay
          if (!char.isFloating) {
            for (let j = 0; j < numStudents; j++) {
              if (i === j) continue;
              const other = chibiList[j];
              if (other.isFloating) continue;
              const d = Math.hypot(char.x - other.x, char.y - other.y);
              if (d < 50 && d > 0) {
                const push = (50 - d) / 50;
                char.x += ((char.x - other.x) / d) * push * 35 * dt;
                char.y += ((char.y - other.y) / d) * push * 35 * dt;
              }
            }

            // Giới hạn trong sân trường
            char.x = Math.max(UFO_BOUNDS.minX, Math.min(UFO_BOUNDS.maxX, char.x));
            char.y = Math.max(UFO_BOUNDS.minY, Math.min(UFO_BOUNDS.maxY, char.y));
          }
        }
      });

      // Y-sorting: Vẽ nhân vật theo thứ tự Y từ xa đến gần
      const sortedStudents = [...chibiList].sort((a, b) => a.y - b.y);

      sortedStudents.forEach((char) => {
        let bob = 0;
        let runLean = 0;

        if (char.isFloating) {
          bob = Math.sin(state.elapsedTime * 8) * 3;
        } else if (currentStage === 'scan') {
          // Chạy dồn dập, thân người hơi chúi về phía trước
          bob = Math.abs(Math.sin(state.elapsedTime * 16 + char.stepOffset)) * 4.5;
          runLean = char.facing * 0.14;
        } else if (char.isMoving) {
          // Đi bộ thư thả bình thường, lắc lư nhẹ nhàng tự nhiên
          bob = Math.abs(Math.sin(state.elapsedTime * 7 + char.stepOffset)) * 2.2;
          runLean = Math.sin(state.elapsedTime * 7 + char.stepOffset) * 0.04;
        } else {
          // Đứng yên thở nhẹ nhàng
          bob = Math.sin(state.elapsedTime * 2.5 + char.stepOffset) * 1.0;
        }

        const drawY = char.y - bob;

        ctx.save();
        ctx.translate(char.x, drawY);

        // Đổ bóng dưới chân
        ctx.save();
        if (char.isFloating) {
          // Bóng trên mặt đất thu nhỏ dần khi bay lên cao
          const shadowScale = Math.max(0.2, 1 - char.floatProgress * 0.7);
          ctx.translate(0, char.baseY - drawY);
          ctx.fillStyle = `rgba(15, 23, 42, ${0.4 * shadowScale})`;
          ctx.beginPath();
          ctx.ellipse(0, 36, 18 * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
          ctx.beginPath();
          ctx.ellipse(0, 36, 18, 6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // Hiệu ứng phát sáng hào quang quanh bạn học sinh đang được gắp
        if (char.isTarget && currentStage === 'abduct') {
          const step = state.abductStep;
          const stepTime = state.abductStepTime;
          let glowIntensity = 0;

          if (step === 'lock_on' || step === 'fake_lock') {
            glowIntensity = 0.3 * Math.sin(state.elapsedTime * 8);
          } else if (step === 'beam_activate' || step === 'fake_beam') {
            glowIntensity = Math.min(1, stepTime / 0.8) * 0.7;
          } else if (step === 'fake_lift') {
            glowIntensity = 0.5 + char.floatProgress * 0.5;
          } else if (step === 'fake_drop') {
            glowIntensity = Math.max(0, 0.6 * (1 - stepTime / 1.1));
          } else if (step === 'ascend') {
            // Tăng dần độ sáng của quầng sáng quanh nhân vật theo độ cao
            glowIntensity = 0.7 + char.floatProgress * 0.6;
          } else if (step === 'enter_ufo') {
            glowIntensity = 1.3 * char.opacity;
          }

          if (glowIntensity > 0.05) {
            ctx.save();
            ctx.shadowColor = '#FDE047';
            ctx.shadowBlur = 15 + glowIntensity * 20;
            ctx.strokeStyle = `rgba(253, 224, 71, ${Math.min(0.9, glowIntensity)})`;
            ctx.lineWidth = 2.5 + glowIntensity * 2;
            ctx.beginPath();
            ctx.ellipse(0, 0, 26 + glowIntensity * 6, 38 + glowIntensity * 6, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }

        // Độ nghiêng khi chạy hoặc bước đi
        ctx.rotate(runLean);
        ctx.scale(char.facing * char.scale, char.scale);
        ctx.globalAlpha = Math.max(0, Math.min(1, char.opacity));

        // Lấy Sprite 2D chibi chất lượng cao
        const genderKey = char.gender === 'female' ? 'girl' : 'boy';
        let poseKey = 'sneak';
        if (currentStage === 'scan') {
          poseKey = 'run'; // Đang chạy toán loạn
        } else if (currentStage === 'abduct') {
          poseKey = char.isTarget ? 'celebrate' : 'alarm';
        } else if (char.isTarget || currentStage === 'celebrate') {
          poseKey = 'celebrate';
        }

        const spriteImg = imgs[`${genderKey}_${poseKey}`];
        const spriteH = 68;
        const spriteW = spriteImg && spriteImg.complete && spriteImg.naturalHeight > 0
          ? (spriteImg.naturalWidth / spriteImg.naturalHeight) * spriteH
          : 44;

        if (spriteImg && spriteImg.complete && spriteImg.naturalWidth > 0) {
          ctx.drawImage(spriteImg, -spriteW / 2, -34, spriteW, spriteH);
        } else {
          // Fallback Chibi vẽ hình học
          ctx.fillStyle = '#FED7AA';
          ctx.beginPath();
          ctx.arc(0, -6, 14, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();

        // Biểu tượng cảm xúc khi phát hiện UFO hoặc nhìn bạn bay lên
        if (currentStage === 'scan') {
          ctx.save();
          const emoteChar = char.emote === 'sweat' ? '💦' : '❗';
          ctx.font = 'bold 15px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(emoteChar, char.x, drawY - 42 + Math.sin(state.elapsedTime * 12) * 3);
          ctx.restore();
        } else if (currentStage === 'abduct' && !char.isTarget) {
          ctx.save();
          ctx.font = 'bold 13px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('😮', char.x, drawY - 42);
          ctx.restore();
        }

        // BẢNG TÊN DƯỚI CHÂN HỌC SINH (FROSTED GLASS PILL, KHÔNG CHE MẶT)
        // Khi bay lên cao hoặc vào trong UFO: mờ dần theo độ cao để thẩm mỹ và tập trung vào nhân vật
        const nameOpacity = char.isTarget && char.isFloating ? Math.max(0, 1 - char.floatProgress * 1.3) : 1;

        if (nameOpacity > 0.05) {
          const nameParts = char.student.fullName.trim().split(/\s+/);
          const displayName = nameParts.length > 2 ? `${nameParts[0]} ${nameParts[nameParts.length - 1]}` : char.student.fullName;

          ctx.font = char.isTarget ? 'bold 11px sans-serif' : '10px sans-serif';
          const txtW = ctx.measureText(displayName).width;
          const pillW = txtW + 12;
          const pillH = 17;
          const pillX = char.x - pillW / 2;
          const pillY = (char.isFloating ? drawY : char.y) + 40;

          ctx.save();
          ctx.globalAlpha = nameOpacity;
          ctx.fillStyle = char.isTarget ? 'rgba(254, 240, 138, 0.95)' : 'rgba(255, 255, 255, 0.9)';
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, pillH, 8);
          ctx.fill();

          ctx.strokeStyle = char.isTarget ? '#EAB308' : '#94A3B8';
          ctx.lineWidth = char.isTarget ? 1.8 : 0.8;
          ctx.stroke();

          ctx.fillStyle = char.isTarget ? '#854D0E' : '#0F172A';
          ctx.textAlign = 'center';
          ctx.fillText(displayName, char.x, pillY + 12);
          ctx.restore();
        }
      });

      // =======================================================================
      // 5. VẼ UFO KAWAII 2D ĐẦY ĐỦ CHI TIẾT (BUỒNG LÁI, ĐÈN LED CHỚP NHÁY, THÙNG MÁY)
      // =======================================================================
      ctx.save();
      ctx.translate(ufo.x, ufo.y);
      ctx.rotate(ufo.tilt);

      // Đổ bóng mềm của UFO
      ctx.save();
      const glowBlur = 14 + (ufo.bodyGlow || 0) * 16;
      ctx.shadowColor = (ufo.bodyGlow || 0) > 0.8 ? 'rgba(253, 224, 71, 0.8)' : 'rgba(56, 189, 248, 0.5)';
      ctx.shadowBlur = glowBlur;

      // 5.1. Vòm kính buồng lái UFO (Glass Dome with Cute Alien)
      const domeGrad = ctx.createRadialGradient(-6, -14, 2, 0, -8, 30);
      domeGrad.addColorStop(0, '#E0F2FE');
      domeGrad.addColorStop(0.4, '#7DD3FC');
      domeGrad.addColorStop(1, '#0284C7');

      ctx.fillStyle = domeGrad;
      ctx.beginPath();
      ctx.arc(0, -6, 26, Math.PI, 0, false);
      ctx.closePath();
      ctx.fill();

      // Bạn Chibi Alien dễ thương bên trong buồng lái
      ctx.fillStyle = '#86EFAC';
      ctx.beginPath();
      ctx.arc(0, -10, 10, 0, Math.PI * 2);
      ctx.fill();

      // Đôi mắt to tròn Kawaii của Alien
      ctx.fillStyle = '#064E3B';
      ctx.beginPath();
      ctx.ellipse(-3.5, -10, 2.5, 3.5, 0, 0, Math.PI * 2);
      ctx.ellipse(3.5, -10, 2.5, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // Đốm sáng long lanh trong mắt
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(-4, -11, 1, 0, Math.PI * 2);
      ctx.arc(3, -11, 1, 0, Math.PI * 2);
      ctx.fill();

      // Cặp ăng-ten ngộ nghĩnh trên đầu Alien
      ctx.strokeStyle = '#86EFAC';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-4, -18);
      ctx.lineTo(-7, -23);
      ctx.moveTo(4, -18);
      ctx.lineTo(7, -23);
      ctx.stroke();

      ctx.fillStyle = '#FDE047';
      ctx.beginPath();
      ctx.arc(-7, -23, 2.5, 0, Math.PI * 2);
      ctx.arc(7, -23, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Vết lóa phản chiếu ánh sáng trên vòm kính (Glass Reflection)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, -6, 21, Math.PI * 1.15, Math.PI * 1.45);
      ctx.stroke();

      // 5.2. Thân đĩa bay UFO (Saucer Hull)
      const hullGrad = ctx.createLinearGradient(0, -8, 0, 18);
      hullGrad.addColorStop(0, '#E0E7FF');
      hullGrad.addColorStop(0.5, '#C7D2FE');
      hullGrad.addColorStop(1, '#818CF8');

      ctx.fillStyle = hullGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, 68, 17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#4F46E5';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Vành đai dưới của đĩa bay
      const bottomGrad = ctx.createLinearGradient(0, 6, 0, 22);
      bottomGrad.addColorStop(0, '#6366F1');
      bottomGrad.addColorStop(1, '#3730A3');
      ctx.fillStyle = bottomGrad;
      ctx.beginPath();
      ctx.ellipse(0, 8, 48, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      // 5.3. Vành đèn LED đa sắc màu nhấp nháy liên tục quanh UFO
      const numLeds = 8;
      const ledColors = ['#FDE047', '#38BDF8', '#F472B6', '#4ADE80'];
      for (let l = 0; l < numLeds; l++) {
        const angle = (l / numLeds) * Math.PI * 2 + ufo.lightPhase * 0.4;
        const ledX = Math.cos(angle) * 54;
        const ledY = Math.sin(angle) * 11;
        // Chỉ vẽ đèn nằm phía nửa trước để tạo chiều sâu 3D
        if (Math.sin(angle) > -0.3) {
          const colorIdx = (l + Math.floor(ufo.lightPhase)) % ledColors.length;
          ctx.fillStyle = ledColors[colorIdx];
          ctx.beginPath();
          ctx.arc(ledX, ledY, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowColor = ledColors[colorIdx];
          ctx.shadowBlur = 6;
        }
      }

      // 5.4. Lõi phóng năng lượng ở đáy UFO (Bottom Emitter Core)
      ctx.fillStyle = currentStage === 'scan' ? '#38BDF8' : '#FDE047';
      ctx.beginPath();
      ctx.ellipse(0, 15, 14, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      ctx.restore();

      // =======================================================================
      // 6. CẬP NHẬT & VẼ PHÁO HOA ĂN MỪNG VÀ BÓNG BAY (STAGE 4 CELEBRATE)
      // =======================================================================
      if (particles.length > 0) {
        particles.forEach((p) => {
          if (!paused) {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.type === 'confetti') {
              p.vy += 280 * dt;
              p.rotation += p.vRot * dt;
              p.alpha -= 0.2 * dt;
            } else if (p.type === 'star') {
              p.rotation += p.vRot * dt;
              p.alpha -= 0.28 * dt;
            } else if (p.type === 'dust') {
              p.size += 5 * dt;
              p.alpha -= 1.4 * dt;
            }
          }

          if (p.alpha > 0) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.globalAlpha = Math.max(0, p.alpha);

            if (p.type === 'dust') {
              ctx.fillStyle = p.color;
              ctx.beginPath();
              ctx.arc(0, 0, p.size, 0, Math.PI * 2);
              ctx.fill();
            } else if (p.type === 'star') {
              ctx.rotate(p.rotation);
              ctx.fillStyle = p.color;
              ctx.beginPath();
              for (let s = 0; s < 5; s++) {
                const a1 = (s * Math.PI * 2) / 5;
                const a2 = a1 + Math.PI / 5;
                ctx.lineTo(Math.cos(a1) * p.size, Math.sin(a1) * p.size);
                ctx.lineTo(Math.cos(a2) * (p.size * 0.45), Math.sin(a2) * (p.size * 0.45));
              }
              ctx.closePath();
              ctx.fill();
            } else {
              ctx.rotate(p.rotation);
              ctx.fillStyle = p.color;
              ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
            }

            ctx.restore();
          }
        });
        state.particles = particles.filter((p) => p.alpha > 0 && p.y > -50);
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [currentClass]);

  // =========================================================================
  // LOGIC ĐIỀU KHIỂN LUỒNG GAME (IDLE -> SCAN -> ABDUCT -> CELEBRATE)
  // =========================================================================

  const finishGame = useCallback(async (winner: Student) => {
    setStage('celebrate');
    setPickedStudent(winner);

    triggerHaptic([60, 40, 80]);
    playSfx('fanfare');
    spawnCelebrationParticles(stateRef.current.ufo.x, 240);

    if (classId) {
      try {
        await saveGamePick(classId, winner, stateRef.current.roundId);
      } catch (err) {
        console.error('Không thể lưu lượt gọi vào CSDL:', err);
      }
    }
  }, [classId, playSfx]);

  // Bắt đầu gắp học sinh:
  // 1. Chuyển sang stage scan (quét tia trong 10 giây)
  // 2. Đếm ngược 10s
  // 3. Chọn học sinh mục tiêu -> stage abduct (UFO bay tới và hút lên)
  // 4. Hoàn tất -> stage celebrate
  const handleStartGame = () => {
    // Tận dụng user gesture để gọi Fullscreen và khóa xoay ngang
    requestGameFullscreen().catch(() => {});

    if (!students || students.length === 0) {
      toast.info('Lớp học chưa có học sinh. Vui lòng thêm học sinh trước.');
      return;
    }

    const result = pickRandom(students, {
      alreadyPicked: alreadyPickedIds,
      noRepeat,
    });

    if (!result.picked) {
      if (result.exhausted) {
        setRoundExhausted(true);
        toast.info('Tất cả học sinh trong lớp đã được UFO gọi một lượt! Bạn có thể bắt đầu vòng mới.');
      } else {
        toast.error('Không thể chọn học sinh.');
      }
      return;
    }

    const targetStudent = result.picked;
    const roundId = `ufo-round-${Date.now()}`;
    stateRef.current.roundId = roundId;
    stateRef.current.targetStudentId = targetStudent.id;

    // Chọn ngẫu nhiên tối đa 2 học sinh khác để gắp thử rồi thả xuống
    // Tuyệt đối không trùng bạn thắng cuộc targetStudent và không trùng nhau
    const otherCandidates = students.filter((s) => s.id !== targetStudent.id);
    const shuffledOthers = [...otherCandidates].sort(() => Math.random() - 0.5);
    const maxFakeCount = Math.min(2, otherCandidates.length);
    // Có thể chọn 1 hoặc 2 bạn thử (nếu có đủ bạn)
    const fakeCount = maxFakeCount > 0 ? (maxFakeCount === 1 ? 1 : Math.random() > 0.4 ? 2 : 1) : 0;
    const selectedFakes = shuffledOthers.slice(0, fakeCount);

    stateRef.current.students.forEach((char) => {
      char.isTarget = false;
      char.isFloating = false;
      char.floatProgress = 0;
      char.opacity = 1;
      char.scale = 1;
    });

    // 1. Kích hoạt giai đoạn Quét ánh sáng (Scan 10 giây)
    setStage('scan');
    setCountdown(10);
    stateRef.current.countdown = 10;
    playSfx('whoosh');

    let timeLeft = 10;
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);

    countdownTimerRef.current = setInterval(() => {
      if (!stateRef.current.isPaused) {
        timeLeft -= 1;
        setCountdown(timeLeft);
        stateRef.current.countdown = timeLeft;
        playSfx('tick');

        if (timeLeft <= 0) {
          if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          triggerAbduction(targetStudent, selectedFakes);
        }
      }
    }, 1000);
  };

  // Helper dọn dẹp các timer trong chuỗi sequence gắp học sinh
  const clearAbductSequenceTimers = useCallback(() => {
    abductSequenceTimersRef.current.forEach((t) => clearTimeout(t));
    abductSequenceTimersRef.current = [];
  }, []);

  // Kích hoạt chuỗi animation gắp học sinh:
  // - Nếu lớp có từ 2 học sinh trở lên: thực hiện gắp thử rồi thả xuống tối đa 2 bạn (chọn ngẫu nhiên 1 hoặc 2 lần thử, hoặc 0 nếu lớp chỉ có 1 bạn)
  // - Không trùng học sinh trong cùng lượt chơi
  // - Lần gắp cuối cùng giữ trọn vẹn animation 8.3 giây
  // - Chỉ lưu học sinh cuối cùng vào CSDL lịch sử
  const triggerAbduction = useCallback((targetStudent: Student, fakeStudents: Student[] = []) => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    clearAbductSequenceTimers();

    setStage('abduct');

    let currentTimelineMs = 0;

    // Helper thiết lập học sinh mục tiêu hiện tại trong stateRef
    const setFocusChar = (stud: Student) => {
      stateRef.current.students.forEach((char) => {
        char.isTarget = char.student.id === stud.id;
        char.opacity = 1;
        char.scale = 1;
        if (char.isTarget) {
          stateRef.current.targetChar = char;
        }
      });
    };

    // 1. CHUỖI GẮP THỬ TỐI ĐA 2 LẦN (MỖI LẦN THỬ KÉO DÀI ~4.3 GIÂY)
    fakeStudents.forEach((fakeStudent) => {
      // 1.1. Khóa mục tiêu bạn thử (0.9s)
      const tLock = setTimeout(() => {
        setFocusChar(fakeStudent);
        setAbductStep('fake_lock');
        stateRef.current.abductStep = 'fake_lock';
        stateRef.current.abductStepTime = 0;
        playSfx('lock');
      }, currentTimelineMs);
      abductSequenceTimersRef.current.push(tLock);
      currentTimelineMs += 900;

      // 1.2. Mở tia hút (0.8s)
      const tBeam = setTimeout(() => {
        setAbductStep('fake_beam');
        stateRef.current.abductStep = 'fake_beam';
        stateRef.current.abductStepTime = 0;
        playSfx('beam');
      }, currentTimelineMs);
      abductSequenceTimersRef.current.push(tBeam);
      currentTimelineMs += 800;

      // 1.3. Nhấc chân bay lên một đoạn 40-50% (1.4s)
      const tLift = setTimeout(() => {
        setAbductStep('fake_lift');
        stateRef.current.abductStep = 'fake_lift';
        stateRef.current.abductStepTime = 0;
        playSfx('beam');
      }, currentTimelineMs);
      abductSequenceTimersRef.current.push(tLift);
      currentTimelineMs += 1400;

      // 1.4. Đổi ý: từ từ thả học sinh xuống mặt đất (1.2s)
      const tDrop = setTimeout(() => {
        setAbductStep('fake_drop');
        stateRef.current.abductStep = 'fake_drop';
        stateRef.current.abductStepTime = 0;
        playSfx('drop');
      }, currentTimelineMs);
      abductSequenceTimersRef.current.push(tDrop);
      currentTimelineMs += 1200;
    });

    // 2. LẦN GẮP CUỐI CÙNG (GIỮ NGUYÊN TOÀN BỘ 8.3 GIÂY ĐẦY ĐỦ CAO TRÀO)
    // 2.1. Bước 1: Khóa mục tiêu chính thức (1.2s)
    const tFinalLock = setTimeout(() => {
      setFocusChar(targetStudent);
      setAbductStep('lock_on');
      stateRef.current.abductStep = 'lock_on';
      stateRef.current.abductStepTime = 0;
      playSfx('lock');
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalLock);
    currentTimelineMs += 1200;

    // 2.2. Bước 2: Kích hoạt tia hút mở rộng (1.4s)
    const tFinalBeam = setTimeout(() => {
      setAbductStep('beam_activate');
      stateRef.current.abductStep = 'beam_activate';
      stateRef.current.abductStepTime = 0;
      playSfx('beam');
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalBeam);
    currentTimelineMs += 1400;

    // 2.3. Bước 3: Học sinh từ từ bay lên theo phương thẳng đứng (3.5s)
    const tFinalAscend = setTimeout(() => {
      setAbductStep('ascend');
      stateRef.current.abductStep = 'ascend';
      stateRef.current.abductStepTime = 0;
      playSfx('beam');
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalAscend);
    currentTimelineMs += 3500;

    // 2.4. Bước 4: Đưa vào bụng UFO (1.4s)
    const tFinalEnter = setTimeout(() => {
      setAbductStep('enter_ufo');
      stateRef.current.abductStep = 'enter_ufo';
      stateRef.current.abductStepTime = 0;
      playSfx('enter');
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalEnter);
    currentTimelineMs += 1400;

    // 2.5. Bước 5: Nhịp chờ & công bố vinh danh (0.8s)
    const tFinalWait = setTimeout(() => {
      setAbductStep('wait_reveal');
      stateRef.current.abductStep = 'wait_reveal';
      stateRef.current.abductStepTime = 0;
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalWait);
    currentTimelineMs += 800;

    const tFinalFinish = setTimeout(() => {
      setAbductStep('none');
      stateRef.current.abductStep = 'none';
      finishGame(targetStudent);
    }, currentTimelineMs);
    abductSequenceTimersRef.current.push(tFinalFinish);
  }, [playSfx, finishGame, clearAbductSequenceTimers]);

  const handleTogglePause = () => {
    setIsPaused((prev) => !prev);
  };

  // Đưa UFO và học sinh về trạng thái ban đầu
  const handleResetGame = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    clearAbductSequenceTimers();

    setStage('idle');
    setAbductStep('none');
    setIsPaused(false);
    setCountdown(10);
    setPickedStudent(null);

    stateRef.current.ufo.x = 500;
    stateRef.current.ufo.y = UFO_BOUNDS.ufo.hoverY;
    stateRef.current.ufo.beamActive = false;
    stateRef.current.ufo.beamIntensity = 0;
    stateRef.current.ufo.shakeAmount = 0;
    stateRef.current.ufo.bodyGlow = 0;
    stateRef.current.particles = [];
    stateRef.current.targetStudentId = null;
    stateRef.current.targetChar = null;
    stateRef.current.abductStep = 'none';
    stateRef.current.abductStepTime = 0;

    stateRef.current.students.forEach((char) => {
      char.x = char.startX;
      char.y = char.startY;
      char.vx = 0;
      char.vy = 0;
      char.isTarget = false;
      char.isFloating = false;
      char.floatProgress = 0;
      char.opacity = 1;
      char.scale = 1;
      char.facing = 1;
      char.isMoving = true;
      char.pauseTimer = Math.random() * 2;
      char.panicTimer = Math.random() * 0.8;
      char.emote = 'none';
    });
  };

  const handleNextRound = () => {
    handleResetGame();
    setTimeout(() => {
      handleStartGame();
    }, 300);
  };

  const toggleFullscreen = () => {
    toggleGameFullscreen().catch(() => {});
  };

  const handleStartNewCycle = async () => {
    if (!classId) return;
    await clearGamePicks(classId);
    setRoundExhausted(false);
    handleResetGame();
    toast.success('Đã làm mới vòng chơi! Tất cả học sinh đã sẵn sàng.');
  };

  const handleClearHistory = async () => {
    if (!classId) return;
    await clearGamePicks(classId);
    toast.info('Đã xóa toàn bộ lịch sử chọn học sinh.');
  };

  const handleSkipToResult = () => {
    if (stage === 'scan' && stateRef.current.targetStudentId) {
      const winner = students?.find((s) => s.id === stateRef.current.targetStudentId);
      if (winner) {
        // Khi bấm bỏ qua: bỏ qua các lượt thử và nhảy thẳng vào lượt gắp chính thức
        triggerAbduction(winner, []);
      }
    }
  };

  if (!currentClass) {
    return (
      <div className="min-h-screen bg-slate-900 p-6 flex flex-col items-center justify-center text-center">
        <div className="card p-8 max-w-md w-full border-2 border-indigo-200 bg-white">
          <Users className="w-12 h-12 text-indigo-500 mx-auto mb-3" />
          <h2 className="font-display font-black text-xl text-ink">Chưa chọn lớp học</h2>
          <p className="text-sm text-ink-soft mt-1">Vui lòng chọn hoặc tạo lớp học trước khi mở minigame UFO.</p>
          <button className="btn-primary mt-6 w-full" onClick={() => navigate('/classes')}>
            Đi đến danh sách lớp
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 select-none relative overflow-x-hidden ${
        isFullscreen || isPseudoFullscreen
          ? 'fixed inset-0 z-40 w-screen h-[100dvh] overflow-hidden flex flex-col justify-between'
          : isLandscape
          ? 'p-1 flex flex-col justify-between h-[100dvh] overflow-hidden'
          : 'p-2 sm:p-4 flex flex-col items-center justify-between'
      }`}
      style={{
        paddingTop: isFullscreen || isPseudoFullscreen ? 'max(0.25rem, env(safe-area-inset-top))' : undefined,
        paddingBottom: isFullscreen || isPseudoFullscreen ? 'max(0.25rem, env(safe-area-inset-bottom))' : undefined,
        paddingLeft: isFullscreen || isPseudoFullscreen ? 'max(0.5rem, env(safe-area-inset-left))' : undefined,
        paddingRight: isFullscreen || isPseudoFullscreen ? 'max(0.5rem, env(safe-area-inset-right))' : undefined,
      }}
    >
      {/* Lớp phủ bắt buộc xoay ngang trên điện thoại */}
      {showRotateOverlay && <LandscapeRotateOverlay onTryLockLandscape={lockLandscape} />}

      {/* =======================================================================
       * 1. THANH ĐIỀU KHIỂN PHÍA TRÊN (HEADER CONTROLS)
       * ======================================================================= */}
      <header
        className={`w-full max-w-5xl flex items-center justify-between gap-1.5 sm:gap-2 mb-1.5 sm:mb-2 px-2.5 sm:px-3 bg-slate-900/90 backdrop-blur-md py-1.5 sm:py-2.5 rounded-xl sm:rounded-2xl border border-indigo-500/30 shadow-lg text-white ${
          isLandscape ? 'h-10 py-1' : ''
        }`}
      >
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            className="btn-ghost btn-sm text-xs sm:text-sm h-8 sm:h-9 px-2 sm:px-3 text-slate-200 hover:text-white hover:bg-slate-800"
            onClick={() => navigate('/games')}
          >
            <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> <span className="hidden sm:inline">Về</span> Trò chơi
          </button>
          <div className="flex items-center gap-1 bg-indigo-950/80 text-cyan-300 px-2 sm:px-3 py-0.5 sm:py-1 rounded-lg sm:rounded-xl font-bold text-xs sm:text-sm border border-indigo-500/40 truncate max-w-[140px] sm:max-w-none">
            <span className="truncate">{currentClass.name}</span>
            <span className="text-indigo-400 hidden sm:inline">•</span>
            <span className="text-indigo-300 font-normal hidden sm:inline">{currentClass.schoolYear}</span>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          {totalStudents > 0 && (
            <span className="chip bg-cyan-950 text-cyan-300 border border-cyan-700/60 font-bold text-[10px] sm:text-xs px-2 sm:px-2.5 py-0.5 sm:py-1 hidden sm:inline-flex">
              <Users className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-cyan-400" />
              <span>{validPickedCount}/{totalStudents}</span>
            </span>
          )}

          <label className="flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-slate-200 cursor-pointer bg-slate-800/80 hover:bg-slate-800 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg sm:rounded-xl border border-slate-700 transition">
            <input
              type="checkbox"
              className="accent-cyan-400 w-3 h-3 sm:w-3.5 sm:h-3.5 rounded"
              checked={noRepeat}
              onChange={(e) => setNoRepeat(e.target.checked)}
            />
            <span className="hidden sm:inline">Không lặp</span>
          </label>

          <button
            className={`icon-btn w-8 h-8 sm:w-9 sm:h-9 ${musicEnabled ? 'text-cyan-300 bg-indigo-900/60 border border-cyan-500/40' : 'text-slate-400 bg-slate-800'}`}
            onClick={() => setMusicEnabled(!musicEnabled)}
            data-tip={musicEnabled ? 'Tắt nhạc nền' : 'Bật nhạc nền'}
            aria-label="Nhạc nền"
          >
            <Music className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>

          <button
            className={`icon-btn w-8 h-8 sm:w-9 sm:h-9 ${soundEnabled ? 'text-cyan-300 bg-indigo-900/60 border border-cyan-500/40' : 'text-slate-400 bg-slate-800'}`}
            onClick={() => setSoundEnabled(!soundEnabled)}
            data-tip={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
            aria-label="Âm thanh"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
          </button>

          <button
            className="icon-btn w-8 h-8 sm:w-9 sm:h-9 text-slate-200 bg-slate-800 hover:bg-slate-700"
            onClick={toggleFullscreen}
            data-tip={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
            aria-label="Toàn màn hình"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Maximize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
          </button>

          <button
            className="btn-outline btn-sm text-[11px] sm:text-xs h-8 sm:h-9 px-2 sm:px-3 bg-slate-800 text-slate-200 border-indigo-500/40 hover:bg-slate-700"
            onClick={() => setShowHistory(true)}
            data-tip="Xem lịch sử các bạn đã được UFO gắp"
          >
            <History className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Lịch sử</span> ({picks?.length ?? 0})
          </button>
        </div>
      </header>

      {/* =======================================================================
       * 2. VÙNG KHUNG HÌNH TRÒ CHƠI CHÍNH (CANVAS 1000x560 WIDESCREEN 16:9)
       * ======================================================================= */}
      <main className="w-full max-w-5xl flex-1 flex flex-col items-center justify-center relative">
        {totalStudents === 0 ? (
          <div className="card p-8 text-center max-w-md w-full border-2 border-indigo-500/40 bg-slate-900/95 text-white shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-500/40 mx-auto flex items-center justify-center mb-4">
              <Users className="w-8 h-8" />
            </div>
            <h3 className="font-display font-black text-xl text-white">Lớp học chưa có học sinh</h3>
            <p className="text-sm text-slate-300 mt-1">
              Hãy thêm học sinh vào {currentClass.name} để đĩa bay UFO chuẩn bị hạ cánh đón các bạn nhé!
            </p>
            <button className="btn-primary mt-6 w-full" onClick={() => navigate('/students')}>
              <UserPlus className="w-4 h-4" /> Thêm học sinh vào lớp
            </button>
          </div>
        ) : (
          <div className="relative w-full max-w-[1000px] card overflow-hidden border-2 sm:border-4 border-cyan-500/40 shadow-2xl bg-black aspect-[1000/560] max-h-[calc(100dvh-95px)]">
            <canvas
              ref={canvasRef}
              width={1000}
              height={560}
              className="w-full h-full block"
            />

            {/* Huy hiệu chỉ dẫn phân cảnh */}
            <div className="absolute top-3 left-3 flex items-center gap-2">
              <div className="bg-slate-900/90 border border-cyan-500/50 backdrop-blur-xs text-white font-black text-xs sm:text-sm px-3.5 py-1.5 rounded-full shadow-lg flex items-center gap-2 animate-fadeIn">
                <span className="w-5 h-5 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center text-xs font-black">
                  {stage === 'idle' ? '1' : stage === 'scan' ? '2' : stage === 'abduct' ? '3' : '4'}
                </span>
                <span className="text-cyan-200">
                  {stage === 'idle' && 'UFO lơ lửng trên sân trường 🛸'}
                  {stage === 'scan' && 'UFO đang quét tìm học sinh... ⚡'}
                  {stage === 'abduct' && abductStep === 'fake_lock' && 'UFO ngắm thử học sinh... 🎯'}
                  {stage === 'abduct' && abductStep === 'fake_beam' && 'Thử nghiệm luồng ánh sáng! ⚡'}
                  {stage === 'abduct' && abductStep === 'fake_lift' && 'Nhấc bổng thử một đoạn! ✨'}
                  {stage === 'abduct' && abductStep === 'fake_drop' && 'UFO đổi ý thả bạn xuống... 🍃'}
                  {stage === 'abduct' && abductStep === 'lock_on' && 'Khóa mục tiêu chính thức! 🎯'}
                  {stage === 'abduct' && abductStep === 'beam_activate' && 'Kích hoạt tia hút ánh sáng! ⚡'}
                  {stage === 'abduct' && abductStep === 'ascend' && 'Học sinh từ từ bay lên đĩa bay! ✨'}
                  {stage === 'abduct' && abductStep === 'enter_ufo' && 'Đưa bạn vào bụng UFO... 🛸'}
                  {stage === 'abduct' && abductStep === 'wait_reveal' && 'Chuẩn bị công bố kết quả... 🌟'}
                  {stage === 'celebrate' && 'Vinh danh học sinh may mắn 🎉'}
                </span>
              </div>
            </div>

            {/* Đồng hồ đếm ngược 10 giây ở góc phải trên khi đang quét */}
            {stage === 'scan' && (
              <div className="absolute top-3 right-3 flex items-center gap-2 animate-pop">
                <div className="bg-slate-900/95 border-2 border-cyan-400 text-cyan-300 font-mono font-black text-sm sm:text-base px-3.5 py-1.5 rounded-full shadow-lg flex items-center gap-2">
                  <span className="animate-spin text-lg">⏱️</span>
                  <span>00:{String(countdown).padStart(2, '0')}</span>
                </div>
                <button
                  className="btn-ghost btn-sm h-8 bg-slate-900/90 hover:bg-slate-800 text-xs text-cyan-300 border border-cyan-500/50 rounded-full font-bold shadow-md"
                  onClick={handleSkipToResult}
                  data-tip="Xem kết quả ngay"
                >
                  <FastForward className="w-3.5 h-3.5 text-cyan-400" /> Bỏ qua
                </button>
              </div>
            )}

            {/* Thông báo Tạm dừng */}
            {isPaused && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn z-20">
                <div className="card p-6 bg-slate-900/95 rounded-3xl text-center max-w-xs shadow-2xl border-2 border-cyan-400 animate-pop text-white">
                  <div className="w-12 h-12 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-500/50 mx-auto flex items-center justify-center mb-3">
                    <Pause className="w-6 h-6 fill-cyan-400" />
                  </div>
                  <h3 className="font-display font-black text-xl text-white">Đang tạm dừng</h3>
                  <p className="text-xs text-slate-300 mt-1">Toàn bộ chuyển động UFO và đồng hồ đếm ngược đã dừng.</p>
                  <button className="btn-primary mt-5 w-full h-11 text-sm font-bold bg-cyan-600 hover:bg-cyan-500 text-white" onClick={handleTogglePause}>
                    <Play className="w-4 h-4 fill-white" /> Tiếp tục giờ chơi
                  </button>
                </div>
              </div>
            )}

            {/* Thông báo hết lượt cả lớp */}
            {roundExhausted && stage === 'idle' && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn z-20">
                <div className="card p-6 bg-slate-900 rounded-[26px] text-center max-w-sm w-full shadow-2xl animate-pop border-2 border-cyan-400 text-white">
                  <h3 className="font-display font-black text-xl text-cyan-300">🎉 Đã gọi hết cả lớp!</h3>
                  <p className="text-sm text-slate-300 mt-1.5">
                    Tất cả {totalStudents} học sinh đã được đĩa bay UFO gắp một lượt. Thầy cô có muốn bắt đầu vòng chơi mới?
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button className="btn-ghost flex-1 text-sm text-slate-300 hover:text-white" onClick={() => setRoundExhausted(false)}>
                      Để sau
                    </button>
                    <button className="btn-primary flex-1 text-sm font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950" onClick={handleStartNewCycle}>
                      Bắt đầu vòng mới
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* =================================================================
             * STAGE 4: BẢNG CHÚC MỪNG & VINH DANH HỌC SINH ĐƯỢC CHỌN NGẪU NHIÊN
             * ================================================================= */}
            {stage === 'celebrate' && pickedStudent && (
              <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 animate-fadeIn z-30">
                <div className="relative card p-4 sm:p-6 bg-gradient-to-b from-slate-900 via-indigo-950 to-slate-900 rounded-[28px] sm:rounded-[32px] text-center max-w-[92vw] sm:max-w-md w-full shadow-2xl border-2 sm:border-4 border-yellow-400 animate-pop text-white max-h-[92vh] overflow-y-auto">
                  <div className="inline-flex items-center gap-1.5 sm:gap-2 bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 text-slate-950 font-display font-black text-xs sm:text-base px-4 sm:px-6 py-1.5 rounded-full shadow-xl border border-yellow-200 mx-auto mb-2">
                    <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-slate-950 text-slate-950" />
                    <span>CHÚC MỪNG BẠN ĐƯỢC CHỌN!</span>
                    <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-slate-950 text-slate-950" />
                  </div>

                  <div className="my-2 sm:my-3 flex justify-center">
                    <div className="p-2.5 sm:p-3.5 rounded-2xl sm:rounded-3xl bg-gradient-to-br from-indigo-900 via-cyan-900 to-slate-800 border-2 sm:border-4 border-yellow-400 shadow-xl transform hover:scale-105 transition">
                      <AnimalAvatarSVG avatarKey={pickedStudent.avatar} size={isLandscape ? 64 : 84} />
                    </div>
                  </div>

                  <h2 className="font-display font-black text-xl sm:text-2xl md:text-3xl text-cyan-200 tracking-tight truncate px-2">
                    {pickedStudent.fullName}
                  </h2>

                  <div className="mt-1 flex items-center justify-center gap-2">
                    <span className="font-mono text-[11px] sm:text-sm font-bold bg-indigo-900/80 text-yellow-300 px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full border border-yellow-400/40">
                      Mã HS: {pickedStudent.code}
                    </span>
                    <span className="text-[11px] sm:text-xs text-slate-300">
                      • {currentClass.name}
                    </span>
                  </div>

                  <div className="mt-4 sm:mt-6 flex gap-2">
                    <button
                      className="btn-outline flex-1 min-h-[44px] sm:h-11 text-xs sm:text-sm font-bold text-slate-200 border-slate-700 hover:bg-slate-800 active:scale-95"
                      onClick={handleResetGame}
                    >
                      <RotateCcw className="w-4 h-4" /> Chơi lại
                    </button>
                    <button
                      className="btn-primary flex-1 min-h-[44px] sm:h-11 text-xs sm:text-sm font-bold shadow-lg bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-slate-950 active:scale-95"
                      onClick={handleNextRound}
                    >
                      <Play className="w-4 h-4 fill-slate-950" /> Lượt tiếp theo
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* =======================================================================
       * 3. THANH ĐIỀU KHIỂN CHÍNH PHÍA DƯỚI (BOTTOM CONTROLS)
       * ======================================================================= */}
      <footer className="w-full max-w-5xl mt-2 sm:mt-3 flex flex-wrap items-center justify-center gap-2 sm:gap-3 px-2 pb-2">
        {stage === 'idle' && (
          <button
            className="btn-primary min-h-[48px] px-8 text-base font-black shadow-lg bg-gradient-to-r from-cyan-500 via-indigo-500 to-fuchsia-500 hover:from-cyan-400 hover:to-fuchsia-400 text-white transform hover:scale-102 transition border border-cyan-300/40"
            onClick={handleStartGame}
            disabled={totalStudents === 0}
          >
            <Rocket className="w-5 h-5" /> Bắt đầu giờ chơi 🛸
          </button>
        )}

        {(stage === 'scan' || stage === 'abduct') && (
          <>
            <button
              className={`btn-outline min-h-[46px] px-6 text-sm sm:text-base font-bold shadow-sm ${
                isPaused ? 'bg-cyan-500 text-slate-950 border-cyan-400' : 'bg-slate-900 border-indigo-500/50 text-cyan-300'
              }`}
              onClick={handleTogglePause}
            >
              {isPaused ? (
                <>
                  <Play className="w-4 h-4 fill-slate-950" /> Tiếp tục
                </>
              ) : (
                <>
                  <Pause className="w-4 h-4 fill-cyan-400" /> Tạm dừng
                </>
              )}
            </button>

            <button
              className="btn-outline min-h-[46px] px-5 text-sm sm:text-base font-bold bg-slate-900 text-slate-200 border-indigo-500/40 hover:bg-slate-800"
              onClick={handleResetGame}
            >
              <RotateCcw className="w-4 h-4" /> Chơi lại
            </button>
          </>
        )}

        {stage === 'celebrate' && (
          <>
            <button
              className="btn-primary min-h-[48px] px-7 text-sm sm:text-base font-bold shadow-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950"
              onClick={handleNextRound}
            >
              <Play className="w-4 h-4 fill-slate-950" /> Lượt tiếp theo
            </button>

            <button
              className="btn-outline min-h-[48px] px-6 text-sm sm:text-base font-bold bg-slate-900 text-slate-200 border-slate-700 hover:bg-slate-800"
              onClick={handleResetGame}
            >
              <RotateCcw className="w-4 h-4" /> Về ban đầu
            </button>
          </>
        )}
      </footer>

      {/* =======================================================================
       * 4. BẢNG LỊCH SỬ GỌI TÊN BÊN PHẢI (SIDEBAR / DRAWER)
       * ======================================================================= */}
      {showHistory && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
          <div className="card p-5 sm:p-6 bg-slate-900 rounded-3xl max-w-md w-full shadow-2xl max-h-[85vh] flex flex-col border border-indigo-500/40 text-white animate-pop">
            <div className="flex items-center justify-between pb-3 border-b border-indigo-500/30">
              <h3 className="font-display font-black text-lg flex items-center gap-2 text-cyan-300">
                <History className="w-5 h-5 text-cyan-400" />
                Lịch sử gọi tên
              </h3>
              <button
                className="icon-btn w-8 h-8 text-slate-400 hover:text-white"
                onClick={() => setShowHistory(false)}
                aria-label="Đóng"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-2">
              {!picks || picks.length === 0 ? (
                <div className="text-center py-10 text-slate-400 text-sm">
                  Chưa có lượt gọi nào trong lớp này.
                </div>
              ) : (
                picks.map((p, idx) => (
                  <div
                    key={p.id ?? idx}
                    className="flex items-center justify-between p-2.5 rounded-2xl bg-indigo-950/50 border border-indigo-500/30"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-500/40 flex items-center justify-center font-bold text-xs shrink-0">
                        {idx + 1}
                      </div>
                      <div>
                        <div className="font-bold text-sm text-slate-100">{p.studentName}</div>
                        <div className="text-[11px] text-slate-400">{formatDateTimeVN(p.createdAt)}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {picks && picks.length > 0 && (
              <div className="pt-3 border-t border-indigo-500/30 flex gap-2">
                <button
                  className="btn-outline flex-1 text-xs text-red-400 border-red-500/40 hover:bg-red-950/40 h-9"
                  onClick={handleClearHistory}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Xóa lịch sử
                </button>
                <button className="btn-primary flex-1 text-xs h-9 bg-cyan-500 text-slate-950 font-bold" onClick={() => setShowHistory(false)}>
                  Đóng
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
