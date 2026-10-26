/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pink: {
          50: '#FFF6FA',
          100: '#FCE7F0',
          200: '#F9CFE0',
          300: '#F7A8C4',
          400: '#F08DB6',
          500: '#E879A9',
          600: '#D35E93',
          700: '#B4487A',
        },
        lavender: { DEFAULT: '#DCD2FF', dark: '#7E6BD6' },
        cream: { DEFAULT: '#FFE9A8', dark: '#B98A12' },
        mint: { DEFAULT: '#CFF3E4', dark: '#2E9A6D' },
        sky: { DEFAULT: '#D9EDFF', dark: '#3B82C4' },
        ink: { DEFAULT: '#514553', soft: '#8D8190' },
        danger: { DEFAULT: '#E5627A', soft: '#FDE4E8' },
      },
      fontFamily: {
        sans: ['"Be Vietnam Pro"', 'Nunito', 'system-ui', 'sans-serif'],
        display: ['Nunito', '"Be Vietnam Pro"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '20px',
        btn: '14px',
      },
      boxShadow: {
        soft: '0 4px 18px -6px rgba(232, 121, 169, 0.18)',
        card: '0 2px 10px -4px rgba(81, 69, 83, 0.10)',
      },
      keyframes: {
        pop: {
          '0%': { transform: 'scale(.6)', opacity: '0' },
          '60%': { transform: 'scale(1.08)', opacity: '1' },
          '100%': { transform: 'scale(1)' },
        },
        floatUp: {
          '0%': { transform: 'translateY(0)', opacity: '1' },
          '100%': { transform: 'translateY(-48px)', opacity: '0' },
        },
        fadeIn: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        slideIn: { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        pop: 'pop .35s ease-out',
        floatUp: 'floatUp 1s ease-out forwards',
        fadeIn: 'fadeIn .25s ease-out',
        slideIn: 'slideIn .25s ease-out',
      },
    },
  },
  plugins: [],
};
