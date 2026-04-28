/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Backblaze brand red
        bb: {
          red: '#E61F18',
          redDim: '#B81814',
          redGlow: 'rgba(230, 31, 24, 0.18)',
        },
        // Dark mode surface palette
        ink: {
          950: '#07090F',
          900: '#0B0E16',
          850: '#10141F',
          800: '#161B28',
          700: '#1F2638',
          600: '#2A334B',
          500: '#3A455F',
          400: '#5C6786',
          300: '#8A95B2',
          200: '#B8C0D6',
          100: '#E5E9F2',
        },
        accent: {
          teal: '#3DD9D6',
          violet: '#9B7CFF',
          amber: '#F5B73E',
          green: '#2BD68A',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(230, 31, 24, 0.45), 0 8px 32px -8px rgba(230, 31, 24, 0.5)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
      },
      animation: {
        'pulse-slow': 'pulse 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
