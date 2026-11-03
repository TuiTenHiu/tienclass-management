import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RotateCw } from 'lucide-react';

/**
 * Kiểm tra xem thiết bị hiện tại có phải thiết bị di động (smartphone/tablet cảm ứng) hay không
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const isSmallScreen = window.innerWidth <= 960 || window.innerHeight <= 960;
  return (hasTouch && isSmallScreen) || isMobileUA;
}

/**
 * Kiểm tra xem màn hình đang ở chế độ dọc (portrait) hay không
 */
export function isPortraitOrientation(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.screen?.orientation?.type) {
    return window.screen.orientation.type.startsWith('portrait');
  }
  return window.innerHeight > window.innerWidth;
}

/**
 * Kiểm tra xem thiết bị có phải iOS Safari hay không
 */
export function isIosSafari(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isIos;
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
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState<boolean>(false);

  const prevPortraitRef = useRef(isPortrait);

  // Cập nhật hướng và kiểu thiết bị
  const updateOrientationState = useCallback(() => {
    const portrait = isPortraitOrientation();
    const mobile = isMobileDevice();
    setIsPortrait(portrait);
    setIsMobile(mobile);

    if (portrait !== prevPortraitRef.current) {
      if (portrait) {
        options?.onOrientationToPortrait?.();
      } else {
        options?.onOrientationToLandscape?.();
      }
      prevPortraitRef.current = portrait;
    }
  }, [options]);

  useEffect(() => {
    updateOrientationState();

    const handleResize = () => updateOrientationState();
    const handleOrientationChange = () => {
      // Đợi ngắn để kích thước window ổn định sau khi xoay
      setTimeout(updateOrientationState, 150);
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);

    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', handleOrientationChange);
    }

    const handleFsChange = () => {
      const active = Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        setIsPseudoFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', handleOrientationChange);
      }
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, [updateOrientationState]);

  // Thử khóa hướng ngang bằng Screen Orientation API
  const lockLandscape = useCallback(async (): Promise<boolean> => {
    try {
      if (typeof window !== 'undefined' && window.screen?.orientation && 'lock' in window.screen.orientation) {
        await (window.screen.orientation as any).lock('landscape');
        return true;
      }
    } catch {
      // Orientation lock may fail if unsupported or permissions policy restricts
    }
    return false;
  }, []);

  // Yêu cầu toàn màn hình (với fallback pseudo fullscreen cho iOS Safari)
  const requestGameFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;

    let success = false;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
        success = true;
      } else if ((el as any).webkitRequestFullscreen) {
        await (el as any).webkitRequestFullscreen();
        success = true;
      }
    } catch {
      // Native fullscreen failed or denied
    }

    if (!success) {
      // Fallback pseudo-fullscreen cho iOS Safari
      setIsPseudoFullscreen(true);
    }

    // Luôn thử khóa hướng ngang trong gesture
    await lockLandscape();
  }, [containerRef, lockLandscape]);

  // Thoát toàn màn hình
  const exitGameFullscreen = useCallback(async () => {
    setIsPseudoFullscreen(false);
    try {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      }
    } catch {
      // ignore
    }
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

  return {
    isPortrait,
    isMobile,
    showRotateOverlay,
    isFullscreen: isFullscreen || isPseudoFullscreen,
    isPseudoFullscreen,
    requestGameFullscreen,
    exitGameFullscreen,
    toggleGameFullscreen,
    lockLandscape,
  };
}

/**
 * Lớp phủ bắt buộc xoay ngang điện thoại (Landscape Mandatory Overlay)
 */
export function LandscapeRotateOverlay({
  onTryLockLandscape,
}: {
  onTryLockLandscape?: () => Promise<boolean | void>;
}) {
  const isIos = isIosSafari();

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Yêu cầu xoay ngang điện thoại"
      className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-white pointer-events-auto select-none animate-fadeIn overflow-hidden"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1.5rem, env(safe-area-inset-left))',
        paddingRight: 'max(1.5rem, env(safe-area-inset-right))',
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
      <div className="relative w-28 h-28 flex items-center justify-center mb-6">
        {/* Vòng hào quang nhịp nhàng */}
        <div className="absolute inset-0 rounded-full bg-cyan-500/20 blur-xl animate-pulse" />

        {/* Khung điện thoại hoạt họa xoay 90 độ */}
        <div className="relative animate-phone-rotate text-cyan-400">
          <svg
            width="80"
            height="80"
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

        {/* Mũi tên cong chỉ hướng xoay */}
        <div className="absolute -bottom-1 -right-1 bg-cyan-950/90 border border-cyan-400/60 rounded-full p-2 text-cyan-300 shadow-lg">
          <RotateCw className="w-5 h-5 animate-spin" style={{ animationDuration: '6s' }} />
        </div>
      </div>

      {/* Tiêu đề thông báo chính */}
      <h2 className="font-display font-black text-2xl sm:text-3xl text-cyan-200 tracking-tight max-w-sm leading-snug">
        Vui lòng xoay ngang điện thoại để bắt đầu trò chơi
      </h2>

      {/* Mô tả giải thích */}
      <p className="text-sm sm:text-base text-slate-300 mt-3 max-w-xs sm:max-w-md leading-relaxed font-medium">
        Trò chơi được tối ưu hiển thị toàn diện ở màn hình ngang để thầy cô và các bạn quan sát rõ ràng nhất.
      </p>

      {/* Nút hỗ trợ xoay nhanh */}
      {onTryLockLandscape && (
        <button
          type="button"
          onClick={() => {
            onTryLockLandscape();
          }}
          className="mt-6 btn-primary min-h-[46px] px-6 text-sm font-bold bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-slate-950 shadow-lg shadow-cyan-500/25 border-0 rounded-full active:scale-95 transition"
        >
          <RotateCw className="w-4 h-4 mr-1.5" />
          Thử xoay ngang ngay
        </button>
      )}

      {/* Hướng dẫn chi tiết cho iOS và Android */}
      <div className="mt-6 px-4 py-3 rounded-2xl bg-slate-900/80 border border-slate-800 text-xs text-slate-400 max-w-xs sm:max-w-sm text-center">
        {isIos ? (
          <span>
            💡 <strong>Mẹo trên iPhone:</strong> Nếu màn hình chưa tự xoay, hãy mở <em>Trung tâm điều khiển</em> (vuốt từ góc trên bên phải xuống) và tắt <strong>Khóa hướng dọc</strong>.
          </span>
        ) : (
          <span>
            💡 <strong>Mẹo:</strong> Hãy bật tính năng <strong>Tự động xoay màn hình</strong> trong cài đặt nhanh của điện thoại nhé!
          </span>
        )}
      </div>
    </div>
  );
}
