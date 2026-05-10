const THEMES = ['default', 'amber', 'blue'] as const;
export type Theme = (typeof THEMES)[number];

export function applyTheme(t: Theme) {
  if (t === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('rpow_theme', t);
}

export function loadTheme(): Theme {
  const t = localStorage.getItem('rpow_theme') as Theme | null;
  return t && THEMES.includes(t) ? t : 'default';
}

export function nextTheme(t: Theme): Theme {
  const i = THEMES.indexOf(t);
  return THEMES[(i + 1) % THEMES.length]!;
}
