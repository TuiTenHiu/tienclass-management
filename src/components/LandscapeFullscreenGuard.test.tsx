import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isMobileDevice,
  isPortraitOrientation,
  isIosDevice,
  isAndroidDevice,
  isStandalonePwa,
  isNativeFullscreenSupported,
  isOrientationLockSupported,
  enterFullscreenThenLockLandscape,
} from './LandscapeFullscreenGuard';

describe('LandscapeFullscreenGuard — Android & iOS (Browser + PWA)', () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origNavigator = globalThis.navigator;

  const setupMockEnv = (opts: {
    userAgent: string;
    platform?: string;
    maxTouchPoints?: number;
    innerWidth: number;
    innerHeight: number;
    visualWidth?: number;
    visualHeight?: number;
    orientationType?: string;
    standaloneMq?: boolean;
    iosStandalone?: boolean;
    requestFullscreenImpl?: () => Promise<void>;
    lockOrientationImpl?: (mode: string) => Promise<void>;
  }) => {
    const mockElement = {
      requestFullscreen: opts.requestFullscreenImpl,
    } as unknown as HTMLElement;

    Object.defineProperty(globalThis, 'navigator', {
      writable: true,
      configurable: true,
      value: {
        userAgent: opts.userAgent,
        platform: opts.platform ?? 'Linux armv8l',
        maxTouchPoints: opts.maxTouchPoints ?? 5,
        standalone: opts.iosStandalone ?? false,
      },
    });

    Object.defineProperty(globalThis, 'document', {
      writable: true,
      configurable: true,
      value: {
        documentElement: mockElement,
        fullscreenElement: null,
        fullscreenEnabled: Boolean(opts.requestFullscreenImpl),
      },
    });

    Object.defineProperty(globalThis, 'window', {
      writable: true,
      configurable: true,
      value: {
        ontouchstart: null,
        innerWidth: opts.innerWidth,
        innerHeight: opts.innerHeight,
        visualViewport:
          opts.visualWidth && opts.visualHeight
            ? { width: opts.visualWidth, height: opts.visualHeight }
            : undefined,
        scrollTo: vi.fn(),
        matchMedia: vi.fn().mockImplementation((query: string) => {
          if (query === '(display-mode: standalone)' || query === '(display-mode: fullscreen)') {
            return { matches: Boolean(opts.standaloneMq) };
          }
          if (query === '(orientation: portrait)') {
            return { matches: opts.innerHeight > opts.innerWidth };
          }
          return { matches: false };
        }),
        screen: {
          orientation: {
            type: opts.orientationType ?? (opts.innerHeight > opts.innerWidth ? 'portrait-primary' : 'landscape-primary'),
            lock: opts.lockOrientationImpl,
            unlock: vi.fn(),
          },
        },
      },
    });

    return mockElement;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      writable: true,
      configurable: true,
      value: origWindow,
    });
    Object.defineProperty(globalThis, 'document', {
      writable: true,
      configurable: true,
      value: origDocument,
    });
    Object.defineProperty(globalThis, 'navigator', {
      writable: true,
      configurable: true,
      value: origNavigator,
    });
  });

  it('ưu tiên kích thước thực của viewport (innerHeight > innerWidth) ngay cả khi screen.orientation.type bị trễ trên iOS/Android', () => {
    setupMockEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      innerWidth: 844,
      innerHeight: 390,
      orientationType: 'portrait-primary', // giả lập API bị trễ vẫn báo portrait
    });

    // Dù screen.orientation.type báo portrait-primary, kích thước thực 844x390 là ngang -> phải trả về false
    expect(isPortraitOrientation()).toBe(false);

    // Khi xoay dọc 390x844 -> phải trả về true
    setupMockEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      innerWidth: 390,
      innerHeight: 844,
      orientationType: 'portrait-primary',
    });
    expect(isPortraitOrientation()).toBe(true);
  });

  it('Android Chrome: gọi requestFullscreen TRƯỚC, đợi hoàn tất rồi mới gọi screen.orientation.lock("landscape")', async () => {
    const callOrder: string[] = [];
    const mockTarget = setupMockEnv({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      innerWidth: 412,
      innerHeight: 915,
      requestFullscreenImpl: vi.fn().mockImplementation(async () => {
        callOrder.push('requestFullscreen');
      }),
      lockOrientationImpl: vi.fn().mockImplementation(async (mode: string) => {
        callOrder.push(`orientation.lock:${mode}`);
      }),
    });

    expect(isAndroidDevice()).toBe(true);
    expect(isIosDevice()).toBe(false);
    expect(isMobileDevice()).toBe(true);
    expect(isNativeFullscreenSupported(mockTarget)).toBe(true);
    expect(isOrientationLockSupported()).toBe(true);

    const res = await enterFullscreenThenLockLandscape(mockTarget);
    expect(callOrder).toEqual(['requestFullscreen', 'orientation.lock:landscape']);
    expect(res.nativeFullscreen).toBe(true);
    expect(res.pseudoFullscreen).toBe(false);
    expect(res.orientationLocked).toBe(true);
  });

  it('Android PWA (Standalone): nhận diện đúng chế độ PWA và hỗ trợ Fullscreen + Orientation Lock', async () => {
    const callOrder: string[] = [];
    const mockTarget = setupMockEnv({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      innerWidth: 412,
      innerHeight: 915,
      standaloneMq: true,
      requestFullscreenImpl: vi.fn().mockImplementation(async () => {
        callOrder.push('requestFullscreen');
      }),
      lockOrientationImpl: vi.fn().mockImplementation(async (mode: string) => {
        callOrder.push(`orientation.lock:${mode}`);
      }),
    });

    expect(isStandalonePwa()).toBe(true);
    const res = await enterFullscreenThenLockLandscape(mockTarget);
    expect(callOrder).toEqual(['requestFullscreen', 'orientation.lock:landscape']);
    expect(res.nativeFullscreen).toBe(true);
    expect(res.orientationLocked).toBe(true);
  });

  it('Android Chrome / WebView: xử lý an toàn khi requestFullscreen hoặc orientation.lock bị từ chối quyền', async () => {
    const mockTarget = setupMockEnv({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
      innerWidth: 360,
      innerHeight: 800,
      requestFullscreenImpl: vi.fn().mockRejectedValue(new Error('Permissions check failed')),
      lockOrientationImpl: vi.fn().mockRejectedValue(new Error('NotSupportedError: lock() is not available')),
    });

    const res = await enterFullscreenThenLockLandscape(mockTarget);
    expect(res.nativeFullscreen).toBe(false);
    expect(res.pseudoFullscreen).toBe(true);
    expect(res.orientationLocked).toBe(false);
    expect(res.errorMessage).toContain('Permissions check failed');
  });

  it('iPhone Safari & iPhone PWA: không gọi orientation.lock không hỗ trợ, tự động bật CSS Pseudo-Fullscreen', async () => {
    const lockSpy = vi.fn();
    const mockTarget = setupMockEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      innerWidth: 390,
      innerHeight: 844,
      iosStandalone: false,
      lockOrientationImpl: lockSpy,
    });

    expect(isIosDevice()).toBe(true);
    expect(isAndroidDevice()).toBe(false);
    expect(isMobileDevice()).toBe(true);
    expect(isStandalonePwa()).toBe(false);

    const res = await enterFullscreenThenLockLandscape(mockTarget);
    expect(res.nativeFullscreen).toBe(false);
    expect(res.pseudoFullscreen).toBe(true);
    expect(res.orientationLocked).toBe(false);
    expect(lockSpy).not.toHaveBeenCalled();

    // Kiểm tra chế độ iPhone PWA (Add to Home Screen -> navigator.standalone = true)
    setupMockEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      platform: 'iPhone',
      innerWidth: 844,
      innerHeight: 390,
      iosStandalone: true,
    });
    expect(isStandalonePwa()).toBe(true);
    expect(isPortraitOrientation()).toBe(false);
  });
});
