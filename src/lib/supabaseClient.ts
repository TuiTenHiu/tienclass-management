import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export interface SupabaseAuthCheckResult {
  ok: boolean;
  message: string;
  statusCode?: number;
}

/**
 * Kiểm tra kết nối mạng thực sự tới Supabase Auth API.
 * Gửi một yêu cầu mạng tới endpoint /auth/v1/settings hoặc qua getUser().
 * - Không in URL đầy đủ, API key hay thông tin nhạy cảm.
 * - Xử lý riêng các trường hợp: thiếu cấu hình, lỗi mạng / CORS, lỗi máy chủ, và phản hồi hợp lệ.
 */
export async function checkSupabaseConnection(): Promise<SupabaseAuthCheckResult> {
  if (!supabaseUrl || !supabaseKey || !supabase) {
    return {
      ok: false,
      message: 'Thiếu cấu hình biến môi trường VITE_SUPABASE_URL hoặc VITE_SUPABASE_ANON_KEY trong file .env.local.',
    };
  }

  // 1. Gửi request mạng trực tiếp tới endpoint công khai /auth/v1/settings kèm apikey header
  try {
    const cleanUrl = supabaseUrl.replace(/\/+$/, '');
    const authEndpoint = `${cleanUrl}/auth/v1/settings`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(authEndpoint, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Xử lý các mã trạng thái HTTP từ Supabase server
    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        message: `Đã kết nối thành công tới máy chủ Supabase Auth (HTTP ${response.status} OK).`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        statusCode: response.status,
        message: `Máy chủ Supabase từ chối truy cập (HTTP ${response.status}). Khóa VITE_SUPABASE_ANON_KEY có thể không hợp lệ hoặc đã hết hạn.`,
      };
    }

    if (response.status >= 500) {
      return {
        ok: false,
        statusCode: response.status,
        message: `Máy chủ Supabase đang gặp sự cố nội bộ (HTTP ${response.status}). Vui lòng thử lại sau.`,
      };
    }

    return {
      ok: false,
      statusCode: response.status,
      message: `Máy chủ Supabase phản hồi với mã trạng thái HTTP ${response.status}.`,
    };
  } catch (err: unknown) {
    // 2. Xử lý lỗi kết nối mạng, CORS, timeout hoặc URL sai định dạng
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        message: 'Hết thời gian chờ (timeout) khi kết nối tới Supabase Auth API. Vui lòng kiểm tra lại đường truyền mạng.',
      };
    }

    const rawMessage = err instanceof Error ? err.message : String(err);

    if (rawMessage.includes('Failed to fetch') || rawMessage.includes('NetworkError') || rawMessage.includes('Network Error')) {
      return {
        ok: false,
        message: 'Lỗi mạng hoặc CORS: Không thể gửi yêu cầu tới máy chủ Supabase. Hãy kiểm tra kết nối Internet và định dạng của VITE_SUPABASE_URL.',
      };
    }

    return {
      ok: false,
      message: `Không thể kết nối tới máy chủ Supabase: ${rawMessage}`,
    };
  }
}
