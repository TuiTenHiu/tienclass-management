import { memo } from 'react';

/**
 * Bộ avatar hoạt hình tự thiết kế cho Pink Classroom (SVG thuần, không dùng tài sản bên ngoài).
 * Khóa avatar: "<con vật>-<màu nền>", ví dụ "cat-pink".
 */

export const ANIMALS = ['cat', 'bunny', 'bear', 'capybara', 'panda', 'chick', 'fox', 'frog'] as const;
export type Animal = (typeof ANIMALS)[number];

export const ANIMAL_LABEL: Record<Animal, string> = {
  cat: 'Mèo',
  bunny: 'Thỏ',
  bear: 'Gấu',
  capybara: 'Capybara',
  panda: 'Gấu trúc',
  chick: 'Gà con',
  fox: 'Cáo',
  frog: 'Ếch',
};

export const AVATAR_BGS: Record<string, string> = {
  pink: '#FCE7F0',
  lavender: '#ECE6FF',
  cream: '#FFF3CC',
  mint: '#DDF7EC',
  sky: '#E4F2FF',
};
export const BG_KEYS = Object.keys(AVATAR_BGS);

export const ALL_AVATAR_KEYS = ANIMALS.flatMap((a) => BG_KEYS.map((b) => `${a}-${b}`));

export function randomAvatarKey() {
  const a = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const b = BG_KEYS[Math.floor(Math.random() * BG_KEYS.length)];
  return `${a}-${b}`;
}

export function parseAvatarKey(key: string): { animal: Animal; bg: string } {
  const [a, b] = (key || '').split('-');
  const animal = (ANIMALS as readonly string[]).includes(a) ? (a as Animal) : 'cat';
  return { animal, bg: AVATAR_BGS[b] ?? AVATAR_BGS.pink };
}

const INK = '#514553';
const BLUSH = '#F49AC1';

function Face({ y = 56, eyeGap = 12, mouth = true }: { y?: number; eyeGap?: number; mouth?: boolean }) {
  return (
    <g>
      <circle cx={50 - eyeGap} cy={y} r={3.6} fill={INK} />
      <circle cx={50 + eyeGap} cy={y} r={3.6} fill={INK} />
      <circle cx={50 - eyeGap + 1.2} cy={y - 1.3} r={1.1} fill="#fff" />
      <circle cx={50 + eyeGap + 1.2} cy={y - 1.3} r={1.1} fill="#fff" />
      <ellipse cx={50 - eyeGap - 6} cy={y + 7} rx={5} ry={3.2} fill={BLUSH} opacity={0.6} />
      <ellipse cx={50 + eyeGap + 6} cy={y + 7} rx={5} ry={3.2} fill={BLUSH} opacity={0.6} />
      {mouth && (
        <path d={`M${46} ${y + 7} Q50 ${y + 11} ${54} ${y + 7}`} stroke={INK} strokeWidth={2.2} fill="none" strokeLinecap="round" />
      )}
    </g>
  );
}

function AnimalArt({ animal }: { animal: Animal }) {
  switch (animal) {
    case 'cat':
      return (
        <g>
          <path d="M22 44 L26 16 L44 32 Z" fill="#FFD6E5" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <path d="M78 44 L74 16 L56 32 Z" fill="#FFD6E5" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <path d="M28 36 L29 24 L38 32 Z" fill={BLUSH} />
          <path d="M72 36 L71 24 L62 32 Z" fill={BLUSH} />
          <ellipse cx={50} cy={58} rx={32} ry={28} fill="#FFE3EE" stroke={INK} strokeWidth={2} />
          <Face y={56} />
          <path d="M18 60 L30 61 M18 67 L30 65 M82 60 L70 61 M82 67 L70 65" stroke={INK} strokeWidth={1.6} strokeLinecap="round" />
        </g>
      );
    case 'bunny':
      return (
        <g>
          <ellipse cx={37} cy={22} rx={8} ry={20} fill="#FFFFFF" stroke={INK} strokeWidth={2} />
          <ellipse cx={63} cy={22} rx={8} ry={20} fill="#FFFFFF" stroke={INK} strokeWidth={2} />
          <ellipse cx={37} cy={24} rx={3.6} ry={13} fill="#FFC9DE" />
          <ellipse cx={63} cy={24} rx={3.6} ry={13} fill="#FFC9DE" />
          <ellipse cx={50} cy={62} rx={30} ry={26} fill="#FFFFFF" stroke={INK} strokeWidth={2} />
          <Face y={60} eyeGap={11} />
        </g>
      );
    case 'bear':
      return (
        <g>
          <circle cx={26} cy={34} r={11} fill="#E8C3A0" stroke={INK} strokeWidth={2} />
          <circle cx={74} cy={34} r={11} fill="#E8C3A0" stroke={INK} strokeWidth={2} />
          <circle cx={26} cy={34} r={5} fill="#F5D8BD" />
          <circle cx={74} cy={34} r={5} fill="#F5D8BD" />
          <ellipse cx={50} cy={58} rx={31} ry={28} fill="#E8C3A0" stroke={INK} strokeWidth={2} />
          <ellipse cx={50} cy={68} rx={12} ry={9} fill="#F7E3CF" />
          <ellipse cx={50} cy={64} rx={4} ry={3} fill={INK} />
          <Face y={54} mouth={false} />
          <path d="M46 70 Q50 73 54 70" stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" />
        </g>
      );
    case 'capybara':
      return (
        <g>
          <ellipse cx={30} cy={30} rx={6} ry={5} fill="#B98B68" stroke={INK} strokeWidth={2} />
          <ellipse cx={70} cy={30} rx={6} ry={5} fill="#B98B68" stroke={INK} strokeWidth={2} />
          <rect x={20} y={28} width={60} height={58} rx={26} fill="#D2A47F" stroke={INK} strokeWidth={2} />
          <rect x={32} y={60} width={36} height={22} rx={11} fill="#C08F6B" />
          <ellipse cx={44} cy={67} rx={2} ry={1.6} fill={INK} />
          <ellipse cx={56} cy={67} rx={2} ry={1.6} fill={INK} />
          <path d="M37 50 Q40 47 43 50 M57 50 Q60 47 63 50" stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <ellipse cx={28} cy={58} rx={4.5} ry={3} fill={BLUSH} opacity={0.55} />
          <ellipse cx={72} cy={58} rx={4.5} ry={3} fill={BLUSH} opacity={0.55} />
          <path d="M46 74 Q50 77 54 74" stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" />
          <circle cx={63} cy={24} r={6} fill="#FFB4CF" />
          <circle cx={63} cy={24} r={2.4} fill="#FFE9A8" />
        </g>
      );
    case 'panda':
      return (
        <g>
          <circle cx={26} cy={33} r={11} fill={INK} />
          <circle cx={74} cy={33} r={11} fill={INK} />
          <ellipse cx={50} cy={58} rx={32} ry={28} fill="#FFFFFF" stroke={INK} strokeWidth={2} />
          <ellipse cx={37} cy={55} rx={8} ry={10} fill={INK} transform="rotate(-20 37 55)" />
          <ellipse cx={63} cy={55} rx={8} ry={10} fill={INK} transform="rotate(20 63 55)" />
          <circle cx={38} cy={54} r={3} fill="#fff" />
          <circle cx={62} cy={54} r={3} fill="#fff" />
          <ellipse cx={50} cy={66} rx={3.6} ry={2.6} fill={INK} />
          <path d="M46 71 Q50 74 54 71" stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" />
          <ellipse cx={26} cy={68} rx={5} ry={3} fill={BLUSH} opacity={0.6} />
          <ellipse cx={74} cy={68} rx={5} ry={3} fill={BLUSH} opacity={0.6} />
        </g>
      );
    case 'chick':
      return (
        <g>
          <path d="M46 22 Q50 10 54 22 Q58 14 58 26" fill="#FFD66B" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <ellipse cx={50} cy={58} rx={32} ry={30} fill="#FFE58A" stroke={INK} strokeWidth={2} />
          <Face y={52} mouth={false} />
          <path d="M44 62 L56 62 L50 70 Z" fill="#FFA65C" stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
        </g>
      );
    case 'fox':
      return (
        <g>
          <path d="M20 46 L24 14 L44 32 Z" fill="#FFB27D" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <path d="M80 46 L76 14 L56 32 Z" fill="#FFB27D" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <path d="M27 36 L28 24 L37 32 Z" fill="#FFF3E8" />
          <path d="M73 36 L72 24 L63 32 Z" fill="#FFF3E8" />
          <ellipse cx={50} cy={58} rx={32} ry={28} fill="#FFB27D" stroke={INK} strokeWidth={2} />
          <path d="M20 62 Q35 60 50 84 Q65 60 80 62 Q76 84 50 86 Q24 84 20 62 Z" fill="#FFF3E8" />
          <Face y={56} />
        </g>
      );
    case 'frog':
      return (
        <g>
          <circle cx={32} cy={34} r={13} fill="#A8E6C1" stroke={INK} strokeWidth={2} />
          <circle cx={68} cy={34} r={13} fill="#A8E6C1" stroke={INK} strokeWidth={2} />
          <ellipse cx={50} cy={62} rx={34} ry={25} fill="#A8E6C1" stroke={INK} strokeWidth={2} />
          <circle cx={32} cy={34} r={6} fill="#fff" />
          <circle cx={68} cy={34} r={6} fill="#fff" />
          <circle cx={32} cy={35} r={3.4} fill={INK} />
          <circle cx={68} cy={35} r={3.4} fill={INK} />
          <path d="M36 64 Q50 74 64 64" stroke={INK} strokeWidth={2.2} fill="none" strokeLinecap="round" />
          <ellipse cx={26} cy={64} rx={5} ry={3} fill={BLUSH} opacity={0.6} />
          <ellipse cx={74} cy={64} rx={5} ry={3} fill={BLUSH} opacity={0.6} />
        </g>
      );
  }
}

export const AnimalAvatarSVG = memo(function AnimalAvatarSVG({ avatarKey, size = 48 }: { avatarKey: string; size?: number }) {
  const { animal, bg } = parseAvatarKey(avatarKey);
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
      <rect width={100} height={100} rx={30} fill={bg} />
      <g transform="translate(0 4)">
        <AnimalArt animal={animal} />
      </g>
    </svg>
  );
});
