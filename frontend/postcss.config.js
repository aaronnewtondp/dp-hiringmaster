// Tailwind 4 ships its own PostCSS plugin and handles vendor prefixing itself,
// so autoprefixer is no longer part of the pipeline.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
