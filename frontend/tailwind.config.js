/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dp: {
          50:  '#EBF3FB',
          100: '#CFDEF0',
          200: '#9EBDDF',
          400: '#5090C8',
          600: '#1B6CA8',
          700: '#155A8A',
          800: '#0D3B66',
          900: '#082848',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
