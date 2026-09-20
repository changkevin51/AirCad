/**
 * Small static 16px SVG icon set drawn with `currentColor`.  Strings are
 * fixed at build time — never interpolate user data into them.
 */
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  undo: svg('<path d="M3 6h6a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 3.5 3 6l2.5 2.5"/>'),
  redo: svg('<path d="M13 6H7a3.5 3.5 0 0 0 0 7h3"/><path d="M10.5 3.5 13 6l-2.5 2.5"/>'),
  delete: svg('<path d="M3 4.5h10"/><path d="M6 4.5V3h4v1.5"/><path d="M4.5 4.5 5.2 13h5.6l.7-8.5"/><path d="M6.8 7v4M9.2 7v4"/>'),
  line: svg('<path d="M3.5 12.5 12.5 3.5"/><circle cx="3.5" cy="12.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12.5" cy="3.5" r="1.4" fill="currentColor" stroke="none"/>'),
  rectangle: svg('<rect x="2.5" y="4" width="11" height="8"/><circle cx="2.5" cy="4" r="1.1" fill="currentColor" stroke="none"/><circle cx="13.5" cy="12" r="1.1" fill="currentColor" stroke="none"/>'),
  box: svg('<path d="M8 1.8 14 4.6v6.8L8 14.2 2 11.4V4.6Z"/><path d="M2 4.6 8 7.4l6-2.8M8 7.4v6.8"/>'),
  polygon: svg('<path d="M8 2.2 13.6 6.1 11.8 12.8H4.2L2.4 6.1Z"/>'),
  triangle: svg('<path d="M8 2.4 14 13.2H2Z"/>'),
  circle: svg('<circle cx="8" cy="8" r="5.2"/>'),
  plane: svg('<path d="M2 10.5 8 7l6 3.5-6 3.5Z"/><path d="M8 7V2.5"/><path d="M6 3.6 8 2.5l2 1.1"/>'),
  grid: svg('<path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12"/>'),
  camera: svg('<rect x="1.8" y="4.5" width="9" height="7.5" rx="1"/><path d="M10.8 7.5 14 5.5v5l-3.2-2"/>'),
  chevron: svg('<path d="M5.5 3.5 10 8l-4.5 4.5"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  help: svg('<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2A1.9 1.9 0 0 1 10 6.4c0 1.3-2 1.6-2 2.9"/><circle cx="8" cy="11.6" r="0.4" fill="currentColor" stroke="none"/>'),
  panelLeft: svg('<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M6.5 2.5v11"/>'),
  panelRight: svg('<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M9.5 2.5v11"/>'),
} as const;

export type IconName = keyof typeof icons;
