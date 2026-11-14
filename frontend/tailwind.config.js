import v3Palette from './tailwind.v3-palette.js';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tailwind 3's own palette for the families the app uses, pinned (see tailwind.v3-palette.js).
        ...v3Palette,
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
      // Tailwind 3's line heights, as fixed lengths. Tailwind 4 makes them ratios (1.333 for text-xs, ...),
      // which a child with its own `text-[10px]` / `text-[11px]` then re-scales; here it inherited 16px / 20px.
      fontSize: {
        xs:    ['0.75rem',  '1rem'],
        sm:    ['0.875rem', '1.25rem'],
        base:  ['1rem',     '1.5rem'],
        lg:    ['1.125rem', '1.75rem'],
        xl:    ['1.25rem',  '1.75rem'],
        '2xl': ['1.5rem',   '2rem'],
        '3xl': ['1.875rem', '2.25rem'],
        '4xl': ['2.25rem',  '2.5rem'],
        '5xl': ['3rem',     '1'],
        '6xl': ['3.75rem',  '1'],
        '7xl': ['4.5rem',   '1'],
        '8xl': ['6rem',     '1'],
        '9xl': ['8rem',     '1'],
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
