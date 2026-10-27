import { useState, useMemo } from 'react';
import {
  Link2,
  Copy,
  MessageCircle,
  RotateCcw,
  ShieldCheck,
  Search,
  Phone,
  CheckCircle2,
  Ban,
  KeyRound,
  Clock,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useParentLinks } from '../state/hooks';
import { PageHeader } from '../components/ui';
import { StudentAvatar } from '../components/StudentAvatar';
import { EmptyState, LoadingState } from '../components/States';
import { useToast } from '../components/ToastNotification';
import {
  getOrCreateParentLink,
  regenerateParentLink,
  revokeParentInvitationToken,
  recordParentLinkSent,
} from '../data/repo';
import { formatDateTimeVN, formatDateVN, matchesSearch } from '../lib/utils';
import type { Student, ParentLink } from '../types';

export default function ParentLinksPage() {
  const { currentClass, teacherCall } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const parentLinks = useParentLinks(classId);

  const [query, setQuery] = useState('');
  const [busyStudentId, setBusyStudentId] = useState<string | null>(null);
  /**
   * Lưu tạm mã raw_token một lần trong RAM ngay tại phiên vừa tạo/cấp lại
   * để giáo viên sao chép gửi phụ huynh; tuyệt đối không lưu raw_token vào DB hay URL.
   */
  const [issuedTokens, setIssuedTokens] = useState<Record<string, string>>({});

  // Map studentId -> ParentLink
  const linkMap = useMemo(() => {
    const map = new Map<string, ParentLink>();
    (parentLinks ?? []).forEach((l) => map.set(l.studentId, l));
    return map;
  }, [parentLinks]);

  // Đường dẫn Cổng Phụ Huynh sạch (TUYỆT ĐỐI KHÔNG đính kèm raw_token vào URL query)
  const makeParentPortalUrl = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/parent/portal`;
  };

  // Lấy mã mời khả dụng trong phiên hiện tại (hoặc mã Offline cục bộ)
  const getAvailableRawToken = (studentId: string, link?: ParentLink): string | null => {
    if (issuedTokens[studentId]) return issuedTokens[studentId];
    if (link?.issuedRawToken) return link.issuedRawToken;
    if (link?.token && !link.isRevoked && !link.usedAt) return link.token;
    return null;
  };

  // Tạo mẫu tin nhắn thân thiện gửi Zalo (kèm cổng đăng nhập và mã mời riêng biệt, không gắn token lên URL)
  const makeZaloMessage = (student: Student, rawToken: string) => {
    const teacher = teacherCall.charAt(0).toUpperCase() + teacherCall.slice(1);
    const portalUrl = makeParentPortalUrl();
    return `Kính gửi phụ huynh em ${student.fullName},\n\n${teacher} gửi phụ huynh thông tin truy cập Cổng Phụ Huynh để theo dõi chuyên cần, điểm thi đua và nhận xét tuần của con tại lớp ${currentClass?.name}:\n🌐 Cổng phụ huynh: ${portalUrl}\n🔑 Mã mời liên kết (dùng 1 lần): ${rawToken}\n\nHướng dẫn: Phụ huynh mở Cổng phụ huynh, đăng nhập (hoặc đăng ký tài khoản Phụ huynh) và nhập Mã mời liên kết ở trên để xác minh.\n\nChúc con một tuần học tập thật vui và chăm ngoan! 🌸`;
  };

  const handleGenerate = async (studentId: string, studentName: string) => {
    if (!classId) return;
    setBusyStudentId(studentId);
    try {
      const link = await getOrCreateParentLink(classId, studentId);
      const raw = link.issuedRawToken || link.token;
      if (raw) {
        setIssuedTokens((prev) => ({ ...prev, [studentId]: raw }));
      }
      toast.success(`Đã tạo mã mời bảo mật cho em ${studentName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Lỗi khi tạo mã mời phụ huynh');
    } finally {
      setBusyStudentId(null);
    }
  };

  const handleRegenerate = async (studentId: string, studentName: string) => {
    if (!classId) return;
    if (!confirm(`Cấp lại mã mời mới cho em ${studentName}? Mã mời cũ chưa sử dụng sẽ bị thu hồi ngay lập tức.`)) {
      return;
    }
    setBusyStudentId(studentId);
    try {
      const link = await regenerateParentLink(classId, studentId);
      const raw = link.issuedRawToken || link.token;
      if (raw) {
        setIssuedTokens((prev) => ({ ...prev, [studentId]: raw }));
      }
      toast.success(`Đã cấp mã mời mới cho ${studentName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Lỗi khi cấp lại mã mời');
    } finally {
      setBusyStudentId(null);
    }
  };

  const handleRevoke = async (studentId: string, studentName: string, link: ParentLink) => {
    if (!confirm(`Thu hồi mã mời hiện tại của em ${studentName}? Phụ huynh sẽ không thể dùng mã này nữa.`)) {
      return;
    }
    setBusyStudentId(studentId);
    try {
      const res = await revokeParentInvitationToken(link.id);
      setIssuedTokens((prev) => {
        const next = { ...prev };
        delete next[studentId];
        return next;
      });
      toast.success(res.message || `Đã thu hồi mã mời của ${studentName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể thu hồi mã mời');
    } finally {
      setBusyStudentId(null);
    }
  };

  const handleCopyToken = async (student: Student, link: ParentLink) => {
    const raw = getAvailableRawToken(student.id, link);
    if (!raw) {
      toast.error('Mã gốc chỉ hiển thị 1 lần khi tạo. Hãy bấm "Cấp lại mã mới" nếu bạn cần gửi lại cho phụ huynh.');
      return;
    }
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(`Đã sao chép mã mời của em ${student.fullName}!`);
    } catch {
      toast.error('Không thể tự động sao chép');
    }
  };

  const handleCopyMessage = async (student: Student, link: ParentLink) => {
    const raw = getAvailableRawToken(student.id, link);
    if (!raw) {
      toast.error('Mã gốc chỉ hiển thị 1 lần khi tạo. Vui lòng bấm "Cấp lại mã mới" để tạo tin nhắn kèm mã mời mới.');
      return;
    }
    const msg = makeZaloMessage(student, raw);
    try {
      await navigator.clipboard.writeText(msg);
      await recordParentLinkSent(link.id);
      toast.success(`Đã sao chép nội dung tin nhắn gửi Zalo cho PH em ${student.fullName}!`);
    } catch {
      toast.error('Không thể sao chép tin nhắn');
    }
  };

  const handleOpenZaloWeb = (student: Student, link: ParentLink) => {
    const phone = student.parentPhone ? student.parentPhone.replace(/\D/g, '') : '';
    if (phone) {
      window.open(`https://zalo.me/${phone}`, '_blank', 'noopener,noreferrer');
    } else {
      window.open('https://chat.zalo.me/', '_blank', 'noopener,noreferrer');
    }
    void recordParentLinkSent(link.id);
  };

  const filteredStudents = useMemo(() => {
    if (!students) return [];
    return students.filter((s) => matchesSearch([s.fullName, s.code, s.parentPhone ?? ''], query));
  }, [students, query]);

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title={`Quản lý Mã Mời Phụ Huynh: Lớp ${currentClass.name}`}
        description="Cấp mã mời bảo mật một lần (băm SHA-256) cho từng học sinh và gửi hướng dẫn liên kết qua Zalo phụ huynh."
      />

      {/* Thông tin bảo mật Bước 3.5 */}
      <div className="card p-5 bg-gradient-to-r from-pink-50 via-lavender/30 to-mint/30 border border-pink-200">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-6 h-6 text-pink-600 shrink-0 mt-0.5" />
          <div className="text-sm space-y-1">
            <h4 className="font-display font-bold text-ink text-base">
              Cơ chế bảo mật Mã mời & Cổng Phụ Huynh (Supabase RLS + SHA-256)
            </h4>
            <p className="text-ink-soft">
              • <b>Chỉ lưu bản băm SHA-256:</b> Mã mời gốc (128-bit) chỉ hiển thị một lần ngay khi tạo để giáo viên sao chép gửi phụ huynh; cơ sở dữ liệu chỉ lưu mã băm <code>token_hash</code> và không đưa mã vào URL.
            </p>
            <p className="text-ink-soft">
              • <b>Xác thực phụ huynh & Thu hồi tức thì:</b> Phụ huynh phải đăng nhập tài khoản trên Cổng Phụ Huynh và kích hoạt mã mời qua RPC nguyên tử. Giáo viên có thể thu hồi hoặc cấp lại mã bất cứ lúc nào khi mã chưa được sử dụng.
            </p>
            <p className="text-ink-soft">
              • <b>Bảo vệ nhận xét nháp:</b> Phụ huynh đã xác minh chỉ xem được dữ liệu của đúng con mình và chỉ thấy các nhận xét ở trạng thái <b>Đã gửi</b>.
            </p>
          </div>
        </div>
      </div>

      {/* Tìm kiếm */}
      <div className="card p-3 max-w-sm">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            className="input pl-9 h-9 text-sm"
            placeholder="Tìm theo họ tên, mã HS, SĐT phụ huynh..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Danh sách học sinh & Mã mời */}
      {students === undefined ? (
        <LoadingState />
      ) : filteredStudents.length === 0 ? (
        <div className="card">
          <EmptyState
            illustration="bunny-star"
            title={query ? 'Không tìm thấy học sinh phù hợp' : 'Lớp chưa có học sinh'}
            description="Hãy thêm học sinh trước khi tạo mã mời phụ huynh."
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto scroll-soft p-2">
            <table className="table-base min-w-[920px]">
              <thead>
                <tr>
                  <th className="w-12">STT</th>
                  <th>Học sinh</th>
                  <th>SĐT Phụ huynh</th>
                  <th>Trạng thái & Mã mời bảo mật</th>
                  <th>Lần gửi gần nhất</th>
                  <th className="text-right">Thao tác gửi Zalo</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((s, idx) => {
                  const link = linkMap.get(s.id);
                  const rawToken = getAvailableRawToken(s.id, link);
                  const isBusy = busyStudentId === s.id;
                  const isExpired = Boolean(link?.expiresAt && link.expiresAt <= Date.now());
                  const isUsed = Boolean(link?.usedAt || link?.isVerifiedParentLinked);
                  const isRevoked = Boolean(link?.isRevoked);
                  const canRevoke = Boolean(link && !isRevoked && !link.usedAt);

                  return (
                    <tr key={s.id} className="hover:bg-pink-50/50">
                      <td className="text-ink-soft">{idx + 1}</td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <StudentAvatar student={s} size={36} />
                          <div>
                            <span className="font-semibold block text-ink">{s.fullName}</span>
                            <span className="text-[11px] text-ink-soft font-mono">{s.code}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        {s.parentPhone ? (
                          <span className="text-sm font-medium flex items-center gap-1.5 text-ink">
                            <Phone className="w-3.5 h-3.5 text-pink-500" />
                            {s.parentPhone}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-soft italic">Chưa có SĐT</span>
                        )}
                      </td>
                      <td>
                        {link ? (
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {isUsed ? (
                                <span className="chip bg-mint text-mint-dark text-[11px] font-semibold">
                                  <CheckCircle2 className="w-3 h-3" /> Đã liên kết PH
                                </span>
                              ) : isRevoked ? (
                                <span className="chip bg-red-100 text-danger text-[11px] font-semibold">
                                  <Ban className="w-3 h-3" /> Đã thu hồi
                                </span>
                              ) : isExpired ? (
                                <span className="chip bg-cream text-cream-dark text-[11px] font-semibold">
                                  <Clock className="w-3 h-3" /> Đã hết hạn
                                </span>
                              ) : (
                                <span className="chip bg-pink-100 text-pink-700 text-[11px] font-semibold">
                                  <KeyRound className="w-3 h-3" /> Đang hiệu lực
                                </span>
                              )}

                              {rawToken && !isRevoked && !link.usedAt ? (
                                <span
                                  className="font-mono text-xs bg-pink-50 text-pink-700 px-2 py-0.5 rounded-md border border-pink-200"
                                  title="Mã mời một lần (chỉ hiển thị trong phiên vừa tạo)"
                                >
                                  Mã: {rawToken.slice(0, 6)}...{rawToken.slice(-4)}
                                </span>
                              ) : link.tokenHash ? (
                                <span
                                  className="font-mono text-[11px] text-ink-soft bg-surface px-2 py-0.5 rounded border border-pink-100"
                                  title="Bản băm SHA-256 lưu trên máy chủ"
                                >
                                  SHA256: {link.tokenHash.slice(0, 8)}...
                                </span>
                              ) : null}

                              {rawToken && !isRevoked && !link.usedAt && (
                                <button
                                  className="icon-btn w-7 h-7"
                                  onClick={() => handleCopyToken(s, link)}
                                  disabled={isBusy}
                                  data-tip="Sao chép mã mời"
                                  aria-label="Sao chép mã mời"
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                              )}

                              <button
                                className="icon-btn w-7 h-7 text-ink-soft hover:text-pink-600"
                                onClick={() => handleRegenerate(s.id, s.fullName)}
                                disabled={isBusy}
                                data-tip="Cấp lại mã mời mới (vô hiệu hóa mã cũ chưa dùng)"
                                aria-label="Cấp lại mã mời mới"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>

                              {canRevoke && (
                                <button
                                  className="icon-btn w-7 h-7 text-ink-soft hover:text-danger"
                                  onClick={() => handleRevoke(s.id, s.fullName, link)}
                                  disabled={isBusy}
                                  data-tip="Thu hồi mã mời này"
                                  aria-label="Thu hồi mã mời"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>

                            {link.expiresAt && !isRevoked && !link.usedAt && (
                              <div className="text-[11px] text-ink-soft">
                                Hạn dùng: {formatDateVN(new Date(link.expiresAt))}
                                {!rawToken && ' · Bấm "Cấp lại" nếu cần lấy mã mới gửi PH'}
                              </div>
                            )}
                          </div>
                        ) : (
                          <button
                            className="btn-outline btn-sm text-xs"
                            onClick={() => handleGenerate(s.id, s.fullName)}
                            disabled={isBusy}
                          >
                            <Link2 className="w-3.5 h-3.5 text-pink-500" />
                            {isBusy ? 'Đang tạo...' : 'Tạo mã mời'}
                          </button>
                        )}
                      </td>
                      <td>
                        {link?.lastSentAt ? (
                          <span className="chip bg-mint text-mint-dark text-[11px]">
                            <CheckCircle2 className="w-3 h-3" /> {formatDateTimeVN(link.lastSentAt)}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-soft">Chưa gửi</span>
                        )}
                      </td>
                      <td className="text-right">
                        {link && !isRevoked ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              className="btn-secondary btn-sm text-xs"
                              onClick={() => handleCopyMessage(s, link)}
                              disabled={isBusy}
                              data-tip="Sao chép nội dung tin nhắn kèm mã mời để dán vào Zalo"
                            >
                              <Copy className="w-3.5 h-3.5" /> Sao chép tin nhắn
                            </button>
                            <button
                              className="btn-primary btn-sm text-xs bg-[#0068FF] hover:bg-[#0054CC] border-none text-white"
                              onClick={() => handleOpenZaloWeb(s, link)}
                              disabled={isBusy}
                              data-tip="Mở Zalo và dán tin nhắn gửi phụ huynh"
                            >
                              <MessageCircle className="w-3.5 h-3.5" /> Mở Zalo
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-ink-soft italic">
                            {isRevoked ? 'Mã đã thu hồi (Cần cấp lại)' : 'Cần tạo mã mời trước'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
