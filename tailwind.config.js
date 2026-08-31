/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Every colour resolves through a CSS variable defined in src/theme.css,
      // which is what lets the whole app switch theme without a single `dark:`
      // prefix. The `rgb(var(--x) / <alpha-value>)` form is required for
      // opacity modifiers (bg-ink-900/60) to keep working.
      colors: {
        // Backblaze brand red
        bb: {
          red:    'rgb(var(--bb-red) / <alpha-value>)',
          redDim: 'rgb(var(--bb-red-dim) / <alpha-value>)',
          redGlow: 'rgba(230, 31, 24, 0.18)',
        },
        // Surface palette, named by role: 950 is the page background and 100
        // the primary text colour in both themes.
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          850: 'rgb(var(--ink-850) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
        },
        accent: {
          teal:   'rgb(var(--accent-teal) / <alpha-value>)',
          violet: 'rgb(var(--accent-violet) / <alpha-value>)',
          amber:  'rgb(var(--accent-amber) / <alpha-value>)',
          green:  'rgb(var(--accent-green) / <alpha-value>)',
        },
      },
      spacing: {
        // iOS safe-area insets (notch / home indicator). Requires
        // viewport-fit=cover on the viewport meta tag to resolve to non-zero.
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: 'var(--shadow-glow)',
        card: 'var(--shadow-card)',
      },
      animation: {
        'pulse-slow': 'pulse 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
