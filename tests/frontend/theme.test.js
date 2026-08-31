// @vitest-environment jsdom
// Tests for src/lib/theme.js — preference resolution and how it reaches the DOM.
//
// Dark is the stylesheet default, expressed by the ABSENCE of data-theme. That
// is what keeps a document with no scripting rendering the way it always did,
// so these assert the attribute is removed rather than set to "dark".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  THEME_KEY, THEMES, storedTheme, systemTheme, resolveTheme, applyTheme, persistTheme,
} from '../../src/lib/theme.js';

function mockPrefersLight(matches) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  mockPrefersLight(false);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('storedTheme', () => {
  it('defaults to system when nothing is stored', () => {
    expect(storedTheme()).toBe('system');
  });

  it('returns a stored preference', () => {
    localStorage.setItem(THEME_KEY, 'light');
    expect(storedTheme()).toBe('light');
  });

  it('ignores a value that is not one of the three settings', () => {
    localStorage.setItem(THEME_KEY, 'solarized');
    expect(storedTheme()).toBe('system');
  });

  it('falls back rather than throwing when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled');
    });
    expect(storedTheme()).toBe('system');
    spy.mockRestore();
  });

  it('offers exactly the three settings', () => {
    expect(THEMES).toEqual(['light', 'dark', 'system']);
  });
});

describe('resolveTheme', () => {
  it('passes explicit preferences straight through', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('resolves system against the OS setting', () => {
    mockPrefersLight(true);
    expect(resolveTheme('system')).toBe('light');
    mockPrefersLight(false);
    expect(resolveTheme('system')).toBe('dark');
  });

  it('treats dark as the default when matchMedia is unavailable', () => {
    window.matchMedia = () => { throw new Error('unsupported'); };
    expect(systemTheme()).toBe('dark');
    expect(resolveTheme('system')).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('marks light with the attribute', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('expresses dark by removing the attribute, not by setting it', () => {
    applyTheme('light');
    applyTheme('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('is idempotent', () => {
    applyTheme('light');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('persistTheme', () => {
  it('round-trips through storage', () => {
    persistTheme('dark');
    expect(storedTheme()).toBe('dark');
  });

  it('does not throw when storage rejects the write', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => persistTheme('light')).not.toThrow();
    spy.mockRestore();
  });
});

describe('the pre-paint script in index.html agrees with this module', () => {
  // The script is duplicated deliberately (importing a module would defer past
  // first paint). These lock the two contracts it depends on.
  it('uses the same storage key', () => {
    expect(THEME_KEY).toBe('neocloud.theme');
  });

  it('only ever needs to set the attribute for light', () => {
    for (const pref of THEMES) {
      applyTheme(resolveTheme(pref));
      const attr = document.documentElement.getAttribute('data-theme');
      expect(attr === null || attr === 'light').toBe(true);
    }
  });
});
