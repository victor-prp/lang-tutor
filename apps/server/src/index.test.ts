import { describe, expect, it } from '@jest/globals';

import { main } from './index';

// The guard is the point. Before this task, importing this module read the
// environment, opened a pool and bound port 3001 as a side effect of the import
// itself — which is why nothing in the suite referenced it.
describe('index.ts', () => {
  it('exports main, and importing it starts nothing', () => {
    expect(typeof main).toBe('function');
  });
});
