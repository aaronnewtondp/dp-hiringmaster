// One delegated listener for the whole app — scroll events fire on ancestors
// during the capture phase even though they don't bubble, so this catches
// every scrollable element (tables, modals, etc.) without each one wiring up
// its own listener. Toggles a single class the CSS in index.css keys off of
// to fade scrollbar thumbs in while scrolling and back out at rest.
const HIDE_DELAY_MS = 650;
let hideTimer: number | undefined;

export function initScrollbarFade() {
  document.addEventListener('scroll', () => {
    document.documentElement.classList.add('is-scrolling');
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      document.documentElement.classList.remove('is-scrolling');
    }, HIDE_DELAY_MS);
  }, { capture: true, passive: true });
}
