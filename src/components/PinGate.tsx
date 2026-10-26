import { useState, type ReactNode, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { sha256 } from '../lib/utils';
import { LogoMark } from './illustrations';
import { LoadingState } from './States';

const SS_KEY = 'pink-classroom.unlocked';

/**
 * Khóa ứng dụng bằng mã PIN (tùy chọn). PIN được băm SHA-256 kèm salt, không lưu dạng thuần.
 * Lưu ý: đây là lớp bảo vệ cục bộ trên máy dùng chung; với đồng bộ nhiều thiết bị hãy dùng Supabase Auth.
 */
export function PinGate({ children }: { children: ReactNode }) {
  const { ready, settings } = useApp();
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SS_KEY) === '1');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);

  if (!ready) return <LoadingState label="Đang mở Pink Classroom..." />;
  if (!settings.pinHash || unlocked) return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (attempts >= 5) return;
    const h = await sha256(`${settings.pinSalt}:${pin}`);
    if (h === settings.pinHash) {
      sessionStorage.setItem(SS_KEY, '1');
      setUnlocked(true);
    } else {
      const n = attempts + 1;
      setAttempts(n);
      setPin('');
      setError(n >= 5 ? 'Nhập sai quá nhiều lần. Vui lòng thử lại sau 30 giây.' : 'Mã PIN chưa đúng, thử lại nhé.');
      if (n >= 5) setTimeout(() => setAttempts(0), 30000);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50">
      <form onSubmit={submit} className="card card-pad w-full max-w-sm text-center animate-pop">
        <div className="flex justify-center">
          <LogoMark size={64} />
        </div>
        <h1 className="font-display font-black text-2xl mt-3">Pink Classroom</h1>
        <p className="text-ink-soft text-sm mt-1">Nhập mã PIN để mở lớp học của bạn</p>
        <div className="relative mt-5">
          <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            className={`input pl-10 text-center tracking-[0.5em] text-lg ${error ? 'input-error' : ''}`}
            type="password"
            inputMode="numeric"
            autoFocus
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            aria-label="Mã PIN"
          />
        </div>
        {error && <p className="text-danger text-sm mt-2">{error}</p>}
        <button className="btn-primary w-full mt-4" disabled={pin.length < 4 || attempts >= 5}>
          Mở khóa
        </button>
      </form>
    </div>
  );
}
