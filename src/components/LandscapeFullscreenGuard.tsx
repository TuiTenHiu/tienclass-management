import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RotateCw, Maximize2, Smartphone, CheckCircle2 } from 'lucide-react';

/**
 * Kiểm tra xem thiết bị hiện tại có phải thiết bị di động (smartphone/tablet cảm ứng) hay không
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isIpadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const minDim = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  const isSmallOrMediumTouch = hasTouch && minDim > 0 && minDim <= 960;
  return isMobileUA || isIpadOS || isSmallOrMediumTouch;
}

/**
 * Kiểm tra xem màn hình đang ở chế độ dọc (portrait) hay không.
 * Ưu tiên kích thước thực tế của viewport (visualViewport / innerWidth-innerHeight)
 * để đảm bảo chính xác tuyệt đối trên cả iOS Safari, iOS PWA và Android Chrome.
 */
export function isPortraitOrientation(): boolean {
  if (typeof window === 'undefined') return false;
  const vw = window.visualViewport?.width || window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  if (vw > 0 && vh > 0 && vw !== vh) {
    return vh > vw;
  }
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(orientation: portrait)');
    if (typeof mq.matches === 'boolean') {
      return mq.matches;
    }
  }
  if (window.screen?.orientation?.type) {
    return window.screen.orientation.type.startsWith('portrait');
  }
  return vh >= vw;
}

/**
 * Kiểm tra thiết bị có phải iOS / iPadOS (iPhone, iPad, iPod) hay không
 */
export function isIosDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Alias tương thích ngược cho kiểm tra iOS
 */
export function isIosSafari(): boolean {
  return isIosDevice();
}

/**
 * Kiểm tra thiết bị có phải Android hay không
 */
export function isAndroidDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

/**
 * Kiểm tra ứng dụng đang chạy ở chế độ PWA độc lập (Add to Home Screen / Installed WebAPK) hay không
 */
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const isStandaloneMq =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches);
  const isIosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(isStandaloneMq || isIosStandalone);
}

/**
 * Kiểm tra trình duyệt có hỗ trợ Fullscreen API cho phần tử HTML hay không
 */
export function isNativeFullscreenSupported(el?: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  // iOS Safari trên iPhone không hỗ trợ Fullscreen API cho phần tử div/canvas thông thường
  if (isIosDevice()) {
    const target = el || document.documentElement;
    return Boolean(
      target &&
        (typeof target.requestFullscreen === 'function' ||
          typeof (target as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen ===
            'function') &&
        (document.fullscreenEnabled ||
          (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled)
    );
  }
  const target = el || document.documentElement;
  return Boolean(
    target &&
      (typeof target.requestFullscreen === 'function' ||
        typeof (target as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen ===
          'function')
  );
}

/**
 * Kiểm tra trình duyệt có hỗ trợ Screen Orientation Lock API hay không
 */
export function isOrientationLockSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.screen?.orientation &&
      typeof (window.screen.orientation as unknown as { lock?: unknown }).lock === 'function'
  );
}

export interface GameFullscreenResult {
  nativeFullscreen: boolean;
  pseudoFullscreen: boolean;
  orientationLocked: boolean;
  errorMessage?: string;
}

/**
 * Yêu cầu Fullscreen trước rồi mới khóa hướng ngang (dùng được trực tiếp trong user gesture)
 */
export async function enterFullscreenThenLockLandscape(
  targetElement?: HTMLElement | null
): Promise<GameFullscreenResult> {
  const result: GameFullscreenResult = {
    nativeFullscreen: false,
    pseudoFullscreen: false,
    orientationLocked: false,
  };

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return result;
  }

  const el = targetElement || document.documentElement;
  const alreadyFullscreen = Boolean(
    document.fullscreenElement ||
      (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
  );

  // BƯỚC 1: Yêu cầu Fullscreen TRƯỚC (bắt buộc trên Android Chrome trước khi gọi orientation.lock)
  if (alreadyFullscreen) {
    result.nativeFullscreen = true;
  } else if (el && !isIosDevice()) {
    try {
      if (typeof el.requestFullscreen === 'function') {
        await el.requestFullscreen({ navigationUI: 'hide' });
        result.nativeFullscreen = true;
      } else if (
        typeof (el as unknown as { webkitRequestFullscreen?: () => Promise<void> })
          .webkitRequestFullscreen === 'function'
      ) {
        await (
          el as unknown as { webkitRequestFullscreen: () => Promise<void> }
        ).webkitRequestFullscreen();
        result.nativeFullscreen = true;
      }
    } catch (err) {
      // Thử fallback sang document.documentElement nếu phần tử con bị từ chối
      if (el !== document.documentElement && typeof document.documentElement.requestFullscreen === 'function') {
        try {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
          result.nativeFullscreen = true;
        } catch (innerErr) {
          result.errorMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
        }
      } else {
        result.errorMessage = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Nếu không vào được Native Fullscreen (ví dụ iOS Safari/PWA hoặc trình duyệt chặn), bật CSS Pseudo-Fullscreen
  if (!result.nativeFullscreen) {
    result.pseudoFullscreen = true;
    // Trên trình duyệt di động, cuộn nhẹ để thu gọn thanh địa chỉ nếu có thể
    try {
      if (!isStandalonePwa()) {
        window.scrollTo({ top: 1, left: 0, behavior: 'instant' as ScrollBehavior });
      }
    } catch {
      // ignore
    }
  }

  // BƯỚC 2: SAU KHI đã yêu cầu Fullscreen (hoặc đang ở PWA standalone), gọi screen.orientation.lock('landscape')
  if (isOrientationLockSupported() && !isIosDevice()) {
    try {
      await (
        window.screen.orientation as unknown as { lock: (mode: string) => Promise<void> }
      ).lock('landscape');
      result.orientationLocked = true;
    } catch (err) {
      if (!result.errorMessage) {
        result.errorMessage = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return result;
}

/**
 * Hook tính toán kích thước khung sân chơi 1000:560 vừa khít vùng <main> khả dụng,
 * đảm bảo KHÔNG méo hình, KHÔNG tràn màn hình và KHÔNG che khuất nút điều khiển trên mọi tỉ lệ màn hình.
 */
export function useStageFit(
  mainRef: React.RefObject<HTMLElement | null>,
  aspectRatio = 1000 / 560
) {
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);

  const measure = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const availW = Math.max(0, rect.width - 4);
    const availH = Math.max(0, rect.height - 4);
    if (availW <= 0 || availH <= 0) return;

    let width = Math.min(availW, 1000);
    let height = width / aspectRatio;

    if (height > availH) {
      height = availH;
      width = height * aspectRatio;
    }

    setStageSize({
      width: Math.max(240, Math.floor(width)),
      height: Math.max(135, Math.floor(height)),
    });
  }, [mainRef, aspectRatio]);

  useEffect(() => {
    measure();
    const t1 = setTimeout(measure, 60);
    const t2 = setTimeout(measure, 220);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && mainRef.current) {
      ro = new ResizeObserver(() => {
        measure();
      });
      ro.observe(mainRef.current);
    }

    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener('resize', measure);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [measure, mainRef]);

  return stageSize;
}

/**
 * Hook quản lý hướng màn hình, fullscreen và tự động pause khi chuyển dọc
 */
export function useGameOrientationAndFullscreen(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options?: {
    onOrientationToPortrait?: () => void;
    onOrientationToLandscape?: () => void;
  }
) {
  const [isPortrait, setIsPortrait] = useState<boolean>(() => isPortraitOrientation());
  const [isMobile, setIsMobile] = useState<boolean>(() => isMobileDevice());
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState<boolean>(() => isMobileDevice());
  const [isOrientationLocked, setIsOrientationLocked] = useState<boolean>(false);

  const prevPortraitRef = useRef(isPortrait);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Cập nhật hướng và kiểu thiết bị
  const updateOrientationState = useCallback(() => {
    const portrait = isPortraitOrientation();
    const mobile = isMobileDevice();
    setIsPortrait(portrait);
    setIsMobile(mobile);

    if (portrait !== prevPortraitRef.current) {
      prevPortraitRef.current = portrait;
      if (portrait) {
        optionsRef.current?.onOrientationToPortrait?.();
      } else {
        optionsRef.current?.onOrientationToLandscape?.();
      }
    }
  }, []);

  useEffect(() => {
    updateOrientationState();

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const scheduleStabilizedChecks = () => {
      updateOrientationState();
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      timers.push(setTimeout(updateOrientationState, 80));
      timers.push(setTimeout(updateOrientationState, 200));
      timers.push(setTimeout(updateOrientationState, 400));
    };

    window.addEventListener('resize', scheduleStabilizedChecks);
    window.addEventListener('orientationchange', scheduleStabilizedChecks);
    window.visualViewport?.addEventListener('resize', scheduleStabilizedChecks);

    if (window.screen?.orientation && typeof window.screen.orientation.addEventListener === 'function') {
      window.screen.orientation.addEventListener('change', scheduleStabilizedChecks);
    }

    let portraitMq: MediaQueryList | null = null;
    if (typeof window.matchMedia === 'function') {
      portraitMq = window.matchMedia('(orientation: portrait)');
      if (typeof portraitMq.addEventListener === 'function') {
        portraitMq.addEventListener('change', scheduleStabilizedChecks);
      }
    }

    const handleFsChange = () => {
      const active = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      setIsFullscreen(active);
      scheduleStabilizedChecks();
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);

    return () => {
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('resize', scheduleStabilizedChecks);
      window.removeEventListener('orientationchange', scheduleStabilizedChecks);
      window.visualViewport?.removeEventListener('resize', scheduleStabilizedChecks);
      if (window.screen?.orientation && typeof window.screen.orientation.removeEventListener === 'function') {
        window.screen.orientation.removeEventListener('change', scheduleStabilizedChecks);
      }
      if (portraitMq && typeof portraitMq.removeEventListener === 'function') {
        portraitMq.removeEventListener('change', scheduleStabilizedChecks);
      }
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, [updateOrientationState]);

  // Dọn dẹp khóa hướng khi rời khỏi trang game
  useEffect(() => {
    return () => {
      try {
        if (
          typeof window !== 'undefined' &&
          window.screen?.orientation &&
          typeof window.screen.orientation.unlock === 'function'
        ) {
          window.screen.orientation.unlock();
        }
      } catch {
        // ignore
      }
    };
  }, []);

  // Thử khóa hướng ngang bằng Screen Orientation API
  const lockLandscape = useCallback(async (): Promise<boolean> => {
    try {
      if (isOrientationLockSupported() && !isIosDevice()) {
        await (
          window.screen.orientation as unknown as { lock: (mode: string) => Promise<void> }
        ).lock('landscape');
        setIsOrientationLocked(true);
        setTimeout(updateOrientationState, 100);
        return true;
      }
    } catch {
      // Orientation lock may fail if not in fullscreen or restricted by OS
    }
    return false;
  }, [updateOrientationState]);

  // Yêu cầu Fullscreen TRƯỚC, sau đó khóa hướng landscape (chuẩn Android Chrome + fallback Pseudo-Fullscreen cho iOS)
  const requestGameFullscreen = useCallback(async (): Promise<GameFullscreenResult> => {
    const el = containerRef.current || document.documentElement;
    const res = await enterFullscreenThenLockLandscape(el);

    if (res.nativeFullscreen) {
      setIsFullscreen(true);
    }
    if (res.pseudoFullscreen) {
      setIsPseudoFullscreen(true);
    }
    if (res.orientationLocked) {
      setIsOrientationLocked(true);
    }

    setTimeout(updateOrientationState, 100);
    setTimeout(updateOrientationState, 300);
    return res;
  }, [containerRef, updateOrientationState]);

  // Thoát toàn màn hình
  const exitGameFullscreen = useCallback(async () => {
    setIsPseudoFullscreen(false);
    setIsOrientationLocked(false);
    try {
      if (
        typeof window !== 'undefined' &&
        window.screen?.orientation &&
        typeof window.screen.orientation.unlock === 'function'
      ) {
        window.screen.orientation.unlock();
      }
    } catch {
      // ignore
    }
    try {
      const hasFs = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      if (hasFs) {
        if (typeof document.exitFullscreen === 'function') {
          await document.exitFullscreen();
        } else if (
          typeof (document as unknown as { webkitExitFullscreen?: () => Promise<void> })
            .webkitExitFullscreen === 'function'
        ) {
          await (
            document as unknown as { webkitExitFullscreen: () => Promise<void> }
          ).webkitExitFullscreen();
        }
      }
    } catch {
      // ignore
    }
    setIsFullscreen(false);
  }, []);

  // Toggle toàn màn hình
  const toggleGameFullscreen = useCallback(async () => {
    const isCurrentlyFs = isFullscreen || isPseudoFullscreen;
    if (isCurrentlyFs) {
      await exitGameFullscreen();
    } else {
      await requestGameFullscreen();
    }
  }, [isFullscreen, isPseudoFullscreen, exitGameFullscreen, requestGameFullscreen]);

  const showRotateOverlay = isMobile && isPortrait;
  const isCompactLandscape = isMobile && !isPortrait;

  return {
    isPortrait,
    isMobile,
    isCompactLandscape,
    showRotateOverlay,
    isFullscreen: isFullscreen || isPseudoFullscreen,
    isNativeFullscreen: isFullscreen,
    isPseudoFullscreen,
    isOrientationLocked,
    requestGameFullscreen,
    exitGameFullscreen,
    toggleGameFullscreen,
    lockLandscape,
  };
}

/**
 * Lớp phủ bắt buộc xoay ngang điện thoại (Landscape Mandatory Overlay)
 * - Trên Android: Nút bấm kích hoạt Fullscreen TRƯỚC rồi gọi screen.orientation.lock('landscape').
 * - Trên iOS (Safari & PWA): Không giả định iOS khóa xoay phần cứng được; bật CSS Pseudo-Fullscreen 100dvh
 *   và hướng dẫn rõ thao tác tắt Khóa hướng dọc trong Trung tâm điều khiển rồi xoay ngang điện thoại.
 */
export function LandscapeRotateOverlay({
  onEnterFullscreenAndLandscape,
  onTryLockLandscape,
  isPausedMidGame = false,
}: {
  onEnterFullscreenAndLandscape?: () => Promise<GameFullscreenResult | boolean | void>;
  onTryLockLandscape?: () => Promise<boolean | void>;
  isPausedMidGame?: boolean;
}) {
  const isIos = isIosDevice();
  const isAndroid = isAndroidDevice();
  const isStandalone = isStandalonePwa();
  const [manualRotateHint, setManualRotateHint] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  const handleActionClick = async () => {
    setIsRequesting(true);
    setManualRotateHint(null);
    try {
      const action = onEnterFullscreenAndLandscape || onTryLockLandscape;
      if (action) {
        const res = await action();
        // Sau 350ms, nếu vẫn đang ở chế độ dọc (do thiết bị khóa xoay hoặc trình duyệt không cho phép lock),
        // hiển thị hướng dẫn xoay điện thoại thủ công rõ ràng.
        setTimeout(() => {
          if (isPortraitOrientation()) {
            if (isIos) {
              setManualRotateHint(
                'Đã bật chế độ khung hình tối đa. Vui lòng tắt "Khóa hướng dọc" trong Trung tâm điều khiển và xoay ngang iPhone của bạn.'
              );
            } else if (res && typeof res === 'object' && !res.orientationLocked) {
              setManualRotateHint(
                'Đã mở Toàn màn hình! Vui lòng xoay ngang điện thoại hoặc bật "Tự động xoay" trên thanh cài đặt nhanh.'
              );
            } else {
              setManualRotateHint(
                'Vui lòng xoay ngang điện thoại của bạn để màn hình chuyển sang chế độ ngang.'
              );
            }
          }
        }, 350);
      }
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Yêu cầu xoay ngang điện thoại"
      data-testid="landscape-rotate-overlay"
      className="fixed inset-0 z-[100] bg-slate-950/96 backdrop-blur-md flex flex-col items-center justify-center p-5 text-center text-white pointer-events-auto select-none animate-fadeIn overflow-y-auto"
      style={{
        height: '100dvh',
        paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
        paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
      }}
    >
      <style>{`
        @keyframes phoneRotateAnimation {
          0%, 15% {
            transform: rotate(0deg) scale(1);
          }
          45%, 70% {
            transform: rotate(-90deg) scale(1.08);
          }
          90%, 100% {
            transform: rotate(0deg) scale(1);
          }
        }
        .animate-phone-rotate {
          animation: phoneRotateAnimation 2.4s ease-in-out infinite;
          transform-origin: center center;
        }
      `}</style>

      {/* Biểu tượng điện thoại xoay ngang hoạt hình */}
      <div className="relative w-24 h-24 sm:w-28 sm:h-28 flex items-center justify-center mb-4 shrink-0">
        <div className="absolute inset-0 rounded-full bg-cyan-500/20 blur-xl animate-pulse" />

        <div className="relative animate-phone-rotate text-cyan-400">
          <svg
            width="72"
            height="72"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="drop-shadow-[0_0_12px_rgba(34,211,238,0.6)]"
          >
            <rect width="14" height="20" x="5" y="2" rx="3" ry="3" />
            <path d="M12 18h.01" />
          </svg>
        </div>

        <div className="absolute -bottom-1 -right-1 bg-cyan-950/90 border border-cyan-400/60 rounded-full p-2 text-cyan-300 shadow-lg">
          <RotateCw className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" style={{ animationDuration: '6s' }} />
        </div>
      </div>

      {/* Nhãn trạng thái bảo toàn tiến trình nếu xoay dọc giữa trận */}
      {isPausedMidGame && (
        <div className="mb-2.5 inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-300 text-xs font-bold">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Trò chơi đang tạm dừng và giữ nguyên tiến trình của bạn</span>
        </div>
      )}

      {/* Tiêu đề thông báo chính */}
      <h2 className="font-display font-black text-xl sm:text-2xl text-cyan-200 tracking-tight max-w-sm leading-snug">
        Vui lòng xoay ngang điện thoại để bắt đầu trò chơi
      </h2>

      {/* Mô tả giải thích */}
      <p className="text-xs sm:text-sm text-slate-300 mt-2 max-w-xs sm:max-w-md leading-relaxed font-medium">
        {isIos
          ? 'Hãy xoay ngang iPhone/iPad của bạn. Giao diện trò chơi sẽ tự động mở rộng toàn khung hình ngay khi xoay ngang.'
          : 'Nhấn nút bên dưới để bật Toàn màn hình và tự động khóa xoay ngang, hoặc xoay ngang điện thoại của bạn.'}
      </p>

      {/* Nút hành động tùy theo khả năng thực tế của nền tảng */}
      {(onEnterFullscreenAndLandscape || onTryLockLandscape) && !isIos && (
        <button
          type="button"
          onClick={handleActionClick}
          disabled={isRequesting}
          data-testid="btn-fullscreen-landscape"
          className="mt-5 btn-primary min-h-[46px] px-6 text-sm font-bold bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-slate-950 shadow-lg shadow-cyan-500/25 border-0 rounded-full active:scale-95 transition flex items-center gap-2"
        >
          <Maximize2 className="w-4 h-4" />
          <span>
            {isAndroid
              ? 'Toàn màn hình & Xoay ngang ngay'
              : 'Thử xoay ngang & Toàn màn hình'}
          </span>
        </button>
      )}

      {/* Nút tối ưu khung hình cho iOS (không hứa hẹn tự xoay phần cứng giả) */}
      {(onEnterFullscreenAndLandscape || onTryLockLandscape) && isIos && (
        <button
          type="button"
          onClick={handleActionClick}
          disabled={isRequesting}
          data-testid="btn-ios-pseudo-fullscreen"
          className="mt-4 btn-outline min-h-[42px] px-5 text-xs font-bold border-cyan-500/50 bg-cyan-950/50 text-cyan-200 hover:bg-cyan-900/60 rounded-full active:scale-95 transition flex items-center gap-1.5"
        >
          <Smartphone className="w-4 h-4 text-cyan-400" />
          <span>Tối ưu sẵn khung hình chờ xoay ngang</span>
        </button>
      )}

      {/* Thông báo phản hồi khi cần xoay vật lý */}
      {manualRotateHint && (
        <div
          role="status"
          className="mt-3 px-4 py-2.5 rounded-xl bg-amber-500/15 border border-amber-400/40 text-xs text-amber-200 max-w-xs sm:max-w-sm font-medium animate-fadeIn"
        >
          {manualRotateHint}
        </div>
      )}

      {/* Hướng dẫn chi tiết chuẩn xác cho iOS và Android */}
      <div className="mt-5 px-4 py-3 rounded-2xl bg-slate-900/85 border border-slate-800 text-xs text-slate-300 max-w-xs sm:max-w-sm text-left space-y-1.5">
        {isIos ? (
          <>
            <div className="font-bold text-cyan-300 flex items-center gap-1.5">
              <span>📱 Hướng dẫn trên iPhone / iPad:</span>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-slate-300 leading-relaxed">
              <li>
                Vuốt từ <strong>góc trên bên phải</strong> màn hình xuống để mở{' '}
                <em>Trung tâm điều khiển</em>.
              </li>
              <li>
                Chạm tắt biểu tượng <strong>Khóa hướng dọc</strong> (ổ khóa có vòng tròn mũi tên).
              </li>
              <li>
                <strong>Xoay ngang điện thoại</strong> để bắt đầu chơi ngay.
              </li>
            </ol>
            {!isStandalone && (
              <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                💡 Mẹo: Chọn <strong>Chia sẻ → Thêm vào MH chính</strong> để chơi toàn màn hình không vướng thanh công cụ Safari.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="font-bold text-cyan-300">💡 Mẹo trên Android:</div>
            <p className="text-slate-300 leading-relaxed">
              Nhấn nút <strong>“Toàn màn hình & Xoay ngang ngay”</strong> phía trên để tự động chuyển sang màn hình ngang, hoặc bật <strong>Tự động xoay</strong> trong cài đặt nhanh và xoay ngang máy.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
