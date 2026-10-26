/** Hình minh họa trang trí (SVG tự vẽ) – dùng tiết chế để không rối mắt */

const INK = '#514553';

export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="18" fill="#FCE7F0" />
      <path d="M14 27 L19 10 L29 22 Z" fill="#F7A8C4" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M50 27 L45 10 L35 22 Z" fill="#F7A8C4" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="32" cy="36" r="19" fill="#F7A8C4" stroke={INK} strokeWidth="1.6" />
      <circle cx="25" cy="34" r="2.6" fill={INK} />
      <circle cx="39" cy="34" r="2.6" fill={INK} />
      <path d="M28 41 Q32 45 36 41" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="20" cy="40" r="3" fill="#E879A9" opacity=".5" />
      <circle cx="44" cy="40" r="3" fill="#E879A9" opacity=".5" />
      <path d="M50 46 l2 4 4 .6 -3 2.8 .8 4 -3.8 -2 -3.8 2 .8 -4 -3 -2.8 4 -.6z" fill="#FFE9A8" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

export type IllustrationName = 'sleepy-cat' | 'bunny-star' | 'bear-book' | 'rainbow' | 'chart-bunny' | 'dog-ball';

export function Illustration({ name, size = 140 }: { name: IllustrationName; size?: number }) {
  return (
    <svg viewBox="0 0 160 140" width={size} height={(size * 140) / 160} aria-hidden="true">
      <ellipse cx="80" cy="126" rx="56" ry="8" fill="#FCE7F0" />
      {name === 'sleepy-cat' && (
        <g>
          <path d="M40 112 Q30 80 60 72 L100 72 Q130 80 120 112 Z" fill="#FFE3EE" stroke={INK} strokeWidth="2" />
          <path d="M52 76 L56 52 L72 66 Z" fill="#FFE3EE" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          <path d="M108 76 L104 52 L88 66 Z" fill="#FFE3EE" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          <circle cx="80" cy="88" r="26" fill="#FFE3EE" stroke={INK} strokeWidth="2" />
          <path d="M66 88 Q70 92 74 88 M86 88 Q90 92 94 88" stroke={INK} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <ellipse cx="62" cy="97" rx="5" ry="3" fill="#F49AC1" opacity=".6" />
          <ellipse cx="98" cy="97" rx="5" ry="3" fill="#F49AC1" opacity=".6" />
          <path d="M120 106 Q140 100 134 84" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
          <text x="112" y="50" fontFamily="Nunito" fontWeight="800" fontSize="16" fill="#E879A9">z</text>
          <text x="124" y="38" fontFamily="Nunito" fontWeight="800" fontSize="12" fill="#F7A8C4">z</text>
          <text x="134" y="28" fontFamily="Nunito" fontWeight="800" fontSize="9" fill="#DCD2FF">z</text>
        </g>
      )}
      {name === 'bunny-star' && (
        <g>
          <ellipse cx="68" cy="44" rx="8" ry="22" fill="#fff" stroke={INK} strokeWidth="2" />
          <ellipse cx="92" cy="44" rx="8" ry="22" fill="#fff" stroke={INK} strokeWidth="2" />
          <ellipse cx="68" cy="46" rx="3.5" ry="14" fill="#FFC9DE" />
          <ellipse cx="92" cy="46" rx="3.5" ry="14" fill="#FFC9DE" />
          <ellipse cx="80" cy="96" rx="30" ry="28" fill="#fff" stroke={INK} strokeWidth="2" />
          <circle cx="70" cy="90" r="3.4" fill={INK} />
          <circle cx="90" cy="90" r="3.4" fill={INK} />
          <path d="M76 98 Q80 102 84 98" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
          <ellipse cx="62" cy="99" rx="5" ry="3" fill="#F49AC1" opacity=".6" />
          <ellipse cx="98" cy="99" rx="5" ry="3" fill="#F49AC1" opacity=".6" />
          <path d="M126 50 l4 8 9 1.3 -6.5 6.2 1.6 8.8 -8.1 -4.3 -8.1 4.3 1.6 -8.8 -6.5 -6.2 9 -1.3z" fill="#FFE9A8" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M30 70 l2.5 5 5.5 .8 -4 3.8 1 5.4 -5 -2.6 -5 2.6 1 -5.4 -4 -3.8 5.5 -.8z" fill="#F7A8C4" />
        </g>
      )}
      {name === 'bear-book' && (
        <g>
          <circle cx="58" cy="52" r="11" fill="#E8C3A0" stroke={INK} strokeWidth="2" />
          <circle cx="102" cy="52" r="11" fill="#E8C3A0" stroke={INK} strokeWidth="2" />
          <circle cx="80" cy="76" r="30" fill="#E8C3A0" stroke={INK} strokeWidth="2" />
          <circle cx="70" cy="72" r="3.2" fill={INK} />
          <circle cx="90" cy="72" r="3.2" fill={INK} />
          <ellipse cx="80" cy="84" rx="9" ry="7" fill="#F7E3CF" />
          <ellipse cx="80" cy="81" rx="3" ry="2.2" fill={INK} />
          <path d="M44 100 L80 94 L116 100 L116 124 L80 118 L44 124 Z" fill="#D9EDFF" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          <path d="M80 94 L80 118" stroke={INK} strokeWidth="2" />
          <path d="M52 106 L72 103 M52 112 L72 109 M88 103 L108 106 M88 109 L108 112" stroke="#8D8190" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      )}
      {name === 'rainbow' && (
        <g fill="none" strokeLinecap="round">
          <path d="M30 110 A50 50 0 0 1 130 110" stroke="#F7A8C4" strokeWidth="10" />
          <path d="M42 110 A38 38 0 0 1 118 110" stroke="#FFE9A8" strokeWidth="10" />
          <path d="M54 110 A26 26 0 0 1 106 110" stroke="#CFF3E4" strokeWidth="10" />
          <path d="M66 110 A14 14 0 0 1 94 110" stroke="#D9EDFF" strokeWidth="10" />
          <g fill="#fff" stroke={INK} strokeWidth="2">
            <path d="M18 112 q0 -12 12 -12 q4 -8 12 -4 q8 0 8 10 q6 2 4 8 z" />
            <path d="M112 112 q0 -12 12 -12 q4 -8 12 -4 q8 0 8 10 q6 2 4 8 z" />
          </g>
        </g>
      )}
      {name === 'chart-bunny' && (
        <g>
          <rect x="34" y="84" width="16" height="34" rx="5" fill="#F7A8C4" />
          <rect x="56" y="64" width="16" height="54" rx="5" fill="#DCD2FF" />
          <rect x="78" y="74" width="16" height="44" rx="5" fill="#CFF3E4" />
          <ellipse cx="114" cy="62" rx="5" ry="15" fill="#fff" stroke={INK} strokeWidth="2" />
          <ellipse cx="128" cy="62" rx="5" ry="15" fill="#fff" stroke={INK} strokeWidth="2" />
          <ellipse cx="121" cy="98" rx="20" ry="20" fill="#fff" stroke={INK} strokeWidth="2" />
          <circle cx="114" cy="94" r="2.6" fill={INK} />
          <circle cx="128" cy="94" r="2.6" fill={INK} />
          <path d="M118 101 Q121 104 124 101" stroke={INK} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </g>
      )}
      {name === 'dog-ball' && (
        <g>
          <ellipse cx="80" cy="100" rx="34" ry="20" fill="#F5E1C8" stroke={INK} strokeWidth="2" />
          <circle cx="62" cy="76" r="22" fill="#F5E1C8" stroke={INK} strokeWidth="2" />
          <ellipse cx="44" cy="74" rx="8" ry="15" fill="#C99A6E" stroke={INK} strokeWidth="2" transform="rotate(20 44 74)" />
          <ellipse cx="80" cy="70" rx="8" ry="15" fill="#C99A6E" stroke={INK} strokeWidth="2" transform="rotate(-20 80 70)" />
          <path d="M54 76 Q57 79 60 76 M66 76 Q69 79 72 76" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
          <ellipse cx="62" cy="86" rx="3.4" ry="2.4" fill={INK} />
          <circle cx="126" cy="112" r="9" fill="#F7A8C4" stroke={INK} strokeWidth="2" />
          <path d="M118 108 Q126 114 134 108" stroke="#fff" strokeWidth="2" fill="none" />
        </g>
      )}
    </svg>
  );
}
