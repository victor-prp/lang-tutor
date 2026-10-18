// Phase 64 (spec D9): the look Victor chose ("clean and calm"). The background, text and
// muted values changed with it; the primary blue did not.
export const colors = {
  background: '#F6F7FB',
  surface: '#FFFFFF',
  text: '#101828',
  muted: '#667085',
  border: '#E3E4EC',
  primary: '#3B5BDB',
  onPrimary: '#FFFFFF',
  correct: '#1F9254',
  correctSurface: '#E7F6EC',
  wrong: '#C92A2A',
  wrongSurface: '#FCEBEB',
  // Phase 57 (spec D11). A target's today bar past the plan (extra-words.html), its rest
  // day's line, and its date's good luck.
  correctLight: '#7FD3A0',
  primarySurface: '#EEF2FB',
  warmSurface: '#FFF6E0',
  warmText: '#7A5200',
  // Phase 63 (spec D1, D3). Help's letters not yet typed, and its button with nothing left to give.
  faint: '#B4B4C3',
  faintSurface: '#F2F2F5',
  // Phase 64 (spec D4, D5, D9). The card header's gradient end and its pale text, progress,
  // the urgency marks' amber, sign-out's red, list hairlines and the bar's idle tabs.
  bandEnd: '#5B7BF0',
  bandSoft: '#D6DFFF',
  progress: '#12B76A',
  amber: '#F79009',
  amberBright: '#FDB022',
  amberGlow: '#FEF0C7',
  amberSurface: '#FFFAEB',
  amberText: '#93370D',
  danger: '#D92D20',
  hairline: '#F2F4F7',
  tabInactive: '#98A2B3',
} as const;

// Phase 64 (spec D9). Cards float on a soft two-layer shadow instead of a border.
// `boxShadow` is drawn by the new architecture on Android and iOS, and by the web.
export const shadows = {
  card: { boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05), 0 6px 18px rgba(16, 24, 40, 0.07)' },
  bar: { boxShadow: '0 -1px 0 #EAECF0' },
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radii = { sm: 8, md: 14, group: 16, card: 20, lg: 22, pill: 999 } as const;

export const fontSizes = { sm: 14, md: 17, lg: 20, xl: 28, xxl: 40 } as const;

// Hebrew has no capitals and a different vertical rhythm from Latin script, so
// line heights are deliberately generous. Tune these during the play-test.
export const lineHeights = { sm: 22, md: 27, lg: 30, xl: 38, xxl: 50 } as const;

// Phase 36 (spec D8). Wider than a phone (an iPad, a desktop browser), every
// screen sits in one centred column this wide instead of stretching.
export const layout = { maxContentWidth: 640 } as const;
