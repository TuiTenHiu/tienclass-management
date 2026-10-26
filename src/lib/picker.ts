/**
 * Logic chọn ngẫu nhiên học sinh – hoàn toàn độc lập với vị trí nhân vật trong game.
 * Dùng crypto.getRandomValues + rejection sampling để mỗi học sinh có xác suất như nhau.
 */

export type RandomSource = (maxExclusive: number) => number;

export const secureRandomInt: RandomSource = (maxExclusive: number) => {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('maxExclusive phải là số nguyên dương');
  const g = globalThis.crypto;
  if (!g?.getRandomValues) return Math.floor(Math.random() * maxExclusive);
  const range = 0x100000000; // 2^32
  const limit = range - (range % maxExclusive);
  const buf = new Uint32Array(1);
  let x: number;
  do {
    g.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % maxExclusive;
};

export interface PickOptions {
  /** Danh sách id học sinh đã được chọn trước đó */
  alreadyPicked?: string[];
  /** Bật chế độ không lặp */
  noRepeat?: boolean;
  random?: RandomSource;
}

export interface PickResult<T> {
  picked: T | null;
  /** Số học sinh còn có thể được chọn (sau lượt này) */
  remaining: number;
  /** true khi chế độ không lặp đã hết người, cần làm mới vòng */
  exhausted: boolean;
}

export function pickRandom<T extends { id: string }>(participants: T[], opts: PickOptions = {}): PickResult<T> {
  const random = opts.random ?? secureRandomInt;
  const pickedSet = new Set(opts.alreadyPicked ?? []);
  const pool = opts.noRepeat ? participants.filter((p) => !pickedSet.has(p.id)) : participants.slice();
  if (pool.length === 0) return { picked: null, remaining: 0, exhausted: participants.length > 0 };
  const picked = pool[random(pool.length)];
  return { picked, remaining: opts.noRepeat ? pool.length - 1 : participants.length, exhausted: false };
}
