import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Yêu cầu gõ đúng chuỗi này mới cho xác nhận (thao tác không thể hoàn tác) */
  requireText?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy',
  danger,
  requireText,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const canConfirm = !requireText || typed.trim() === requireText;

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setTyped('');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        setTyped('');
        onClose();
      }}
      locked={busy}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {danger && (
            <span className="w-9 h-9 rounded-xl bg-danger-soft text-danger inline-flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" />
            </span>
          )}
          {title}
        </span>
      }
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={run} disabled={busy || !canConfirm} data-autofocus>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[14.5px] text-ink leading-relaxed">{message}</div>
      {requireText && (
        <div className="mt-4">
          <label className="label">
            Gõ <span className="text-danger">"{requireText}"</span> để xác nhận
          </label>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}
