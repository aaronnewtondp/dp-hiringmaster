/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // DigitalPaani brand book — Teal family ("interactive elements,
        // small text, and data signal" per the book's own hard rule).
        // This scale drives every button/link/badge/focus-ring across the
        // app via existing dp-* classes — one token change re-themes all
        // of it. Navy (below) is kept separate for structural/dark
        // surfaces (the sidebar) since the book treats the two as
        // distinct roles, not shades of one hue.
        dp: {
          50:  '#E8F5F6',
          100: '#BDE3E6',
          200: '#95CFD3',
          400: '#6DBCC1',
          600: '#5AABB0',
          700: '#468A8E',
          800: '#35696D',
          900: '#234749',
        },
        // Brand book Navy family — "Primary authority · structure ·
        // backgrounds". Used for the sidebar and other dark structural
        // surfaces; not for buttons/links (that's dp/teal, above).
        navy: {
          50:  '#E8F0FA',
          100: '#C3D5E8',
          200: '#93B0D0',
          400: '#3D5F85',
          600: '#193650',
          700: '#0F2A40',
          800: '#002454',
          900: '#001A3D',
        },
        sage: {
          50:  '#F1F8EC',
          100: '#C9E2B9',
          400: '#8AB878',
          600: '#4A7C3F',
          800: '#2E5924',
        },
        rust: {
          50:  '#FAF0EB',
          100: '#E8C4B0',
          400: '#E8845A',
          600: '#C4511E',
        },
      },
      fontFamily: {
        // Figtree carries body text/UI copy per the brand book.
        sans:    ['Figtree', 'system-ui', 'sans-serif'],
        // Plus Jakarta Sans carries display/headers/brand voice.
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        // IBM Plex Mono is a hard rule in the brand book: "carries every
        // numeric value, sensor reading, measurement... No exceptions."
        mono:    ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
