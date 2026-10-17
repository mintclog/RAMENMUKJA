import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/theme.js', import.meta.url), 'utf8');
function boot(value, blocked = false) {
  const root = { dataset: {} }, meta = {};
  const context = {
    window: {},
    document: { documentElement: root, querySelector: () => ({ setAttribute: (key, value) => { meta[key] = value; } }) },
    localStorage: {
      getItem: () => { if (blocked) throw Error('Storage blocked'); return value; },
      setItem: (key, next) => { if (blocked) throw Error('Storage blocked'); value = next; },
    },
  };
  runInNewContext(source, context);
  return { theme: context.window.ramenTheme, stored: () => value, meta };
}

test('theme defaults safely, restores dark mode and persists only known choices', () => {
  assert.equal(boot(null).theme.get(), 'light');
  assert.equal(boot('unknown').theme.get(), 'light');
  const dark = boot('dark');
  assert.equal(dark.theme.get(), 'dark');
  assert.equal(dark.meta.content, '#1C1917');
  assert.equal(dark.theme.set('light'), true);
  assert.equal(dark.stored(), 'light');
  assert.equal(dark.theme.set('invalid'), false);
  assert.equal(dark.theme.get(), 'light');
  assert.equal(boot(dark.stored()).theme.get(), 'light');
});

test('blocked preference storage still allows changing the visible theme', () => {
  const view = boot(null, true);
  assert.equal(view.theme.get(), 'light');
  assert.equal(view.theme.set('dark'), false);
  assert.equal(view.theme.get(), 'dark');
  assert.equal(view.meta.content, '#1C1917');
});

test('light and dark text, accent and button pairs meet 4.5:1 contrast', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const luminance = hex => {
    if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
    const values = hex.match(/[a-f\d]{2}/gi).map(value => {
      const s = parseInt(value, 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  for (const selector of [/:root\{([^}]+)/, /:root\[data-theme="dark"\]\{([^}]+)/]) {
    const tokens = Object.fromEntries([...css.match(selector)[1].matchAll(/--([\w-]+):\s*(#[a-f\d]{3,6})\b/gi)].map(m => [m[1], m[2]]));
    for (const [fg, bg] of [['text','bg'], ['muted','surface'], ['primary','surface'], ['on-primary','primary'], ['on-primary','error']]) {
      const [high, low] = [luminance(tokens[fg]), luminance(tokens[bg])].sort((a, b) => b - a);
      assert.ok((high + 0.05) / (low + 0.05) >= 4.5, `${fg}/${bg} needs more contrast`);
    }
  }
});
