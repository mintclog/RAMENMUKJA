// Load before styles so a saved dark preference is applied before the app renders.
(() => {
  const key = 'ramenmukja-theme';
  const root = document.documentElement;
  function apply(mode, save) {
    if (!['light', 'dark'].includes(mode)) return false;
    root.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#1C1917' : '#FFF8EE');
    if (save) {
      try { localStorage.setItem(key, mode); }
      catch { return false; }
    }
    return true;
  }
  let initial = 'light';
  try { if (localStorage.getItem(key) === 'dark') initial = 'dark'; } catch {}
  apply(initial, false);
  window.ramenTheme = { get: () => root.dataset.theme, set: mode => apply(mode, true) };
})();
