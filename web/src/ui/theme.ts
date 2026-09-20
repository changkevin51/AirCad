/**
 * The graphite workspace palette.  `THEME` values are applied once to the
 * shell root as CSS custom properties; `THREE_COLORS` exposes the same
 * colors as numeric hex for Three.js materials.  Axes keep the existing
 * red/green/blue identity.
 */
export const THEME = {
  canvas: '#1C1E21',
  appSurface: '#24262A',
  panelSurface: '#292C30',
  controlSurface: '#32363B',
  separator: '#41454B',
  text: '#E5E7EB',
  textSecondary: '#B0B6BF',
  accent: '#78A9ED',
  hoverSnap: '#E3C27D',
  preview: '#91B9ED',
  success: '#8AB895',
  warning: '#D6B474',
  error: '#E58C85',
  axisX: '#E5534B',
  axisY: '#57AB5A',
  axisZ: '#539BF5',
} as const;

export type ThemeToken = keyof typeof THEME;

const toHex = (value: string): number => Number.parseInt(value.slice(1), 16);

/** Numeric hex colors for Three.js materials, keyed like `THEME`. */
export const THREE_COLORS: Record<ThemeToken, number> = Object.fromEntries(
  Object.entries(THEME).map(([key, value]) => [key, toHex(value)]),
) as Record<ThemeToken, number>;

const CSS_VARS: Record<ThemeToken, string> = {
  canvas: '--cad-canvas',
  appSurface: '--cad-app',
  panelSurface: '--cad-panel',
  controlSurface: '--cad-control',
  separator: '--cad-separator',
  text: '--cad-text',
  textSecondary: '--cad-text-2',
  accent: '--cad-accent',
  hoverSnap: '--cad-hover',
  preview: '--cad-preview',
  success: '--cad-ok',
  warning: '--cad-warn',
  error: '--cad-error',
  axisX: '--cad-axis-x',
  axisY: '--cad-axis-y',
  axisZ: '--cad-axis-z',
};

/** Apply the DOM custom properties once, when the shell is built. */
export function applyTheme(root: HTMLElement): void {
  for (const [token, cssVar] of Object.entries(CSS_VARS) as [ThemeToken, string][]) {
    root.style.setProperty(cssVar, THEME[token]);
  }
}
