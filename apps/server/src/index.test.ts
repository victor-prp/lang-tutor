import { describe, expect, it } from '@jest/globals';

// The guard is the point. Before this task, importing this module read the
// environment, opened a pool and bound port 3001 as a side effect of the import
// itself — which is why nothing in the suite referenced it.
describe('index.ts', () => {
  it('exports main, and importing it starts nothing', async () => {
    const before = process.listenerCount('SIGTERM');
    const { main } = await import('./index');
    expect(typeof main).toBe('function');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
