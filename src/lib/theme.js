// Theme state. Lives outside React so the pre-paint script in index.html and
// the app agree on one source of truth.
//
// Three settings, not two: 'system' follows the OS and is the default, so a new
// user gets whatever they already prefer rather than whatever we picked.

export const THEME_KEY = 'neocloud.theme';
export const THEMES = ['light', 'dark', 'system'];

/** The stored preference, or 'system' when nothing valid is stored. */
export function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch {
    // Private mode / storage disabled. Fall back rather than crash the app.
    return 'system';
  }
}

/** What 'system' currently resolves to. */
export function systemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Resolve a preference to the theme actually rendered. */
export function resolveTheme(pref) {
  return pref === 'system' ? systemTheme() : pref;
}

/**
 * Apply a resolved theme to the document.
 *
 * Dark is the default in theme.css, so it is expressed by REMOVING the
 * attribute rather than setting data-theme="dark". That keeps a document with
 * no scripting rendering exactly as it did before themes existed.
 */
export function applyTheme(resolved) {
  const root = document.documentElement;
  if (resolved === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

export function persistTheme(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
}
