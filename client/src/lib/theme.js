import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'inkwell-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPreference() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

function apply(preference) {
  const dark = preference === 'dark' || (preference === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121110' : '#f7f5f0');
}

/** Theme preference: 'system' (follow the OS), 'light' or 'dark'.  Remembered per browser. */
export function useTheme() {
  const [preference, setPreference] = useState(readPreference);

  useEffect(() => {
    apply(preference);
    if (preference !== 'system') return undefined;
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setTheme = useCallback((next) => {
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode: the choice simply lasts for this visit.
    }
    setPreference(next);
  }, []);

  return { theme: preference, setTheme };
}
