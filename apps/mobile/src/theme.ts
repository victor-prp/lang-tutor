export const colors = {
  background: '#F5F6FA',
  surface: '#FFFFFF',
  text: '#16161D',
  muted: '#8A8A99',
  border: '#E3E4EC',
  primary: '#3B5BDB',
  onPrimary: '#FFFFFF',
  correct: '#1F9254',
  correctSurface: '#E7F6EC',
  wrong: '#C92A2A',
  wrongSurface: '#FCEBEB',
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radii = { sm: 8, md: 14, lg: 22, pill: 999 } as const;

export const fontSizes = { sm: 14, md: 17, lg: 20, xl: 28, xxl: 40 } as const;

// Hebrew has no capitals and a different vertical rhythm from Latin script, so
// line heights are deliberately generous. Tune these during the play-test.
export const lineHeights = { sm: 22, md: 27, lg: 30, xl: 38, xxl: 50 } as const;
