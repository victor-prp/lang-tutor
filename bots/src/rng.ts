/**
 * Seeded randomness (spec D13). Every draw in `bots/` comes from here, never from Math.random,
 * so a bot's day can be replayed exactly from its name and the day number.
 */
export type Rng = () => number;

/** FNV-1a over the string's UTF-16 units: a stable unsigned 32-bit seed. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small 32-bit generator returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generator for one bot's one day. */
export function rngFor(name: string, day: number | string): Rng {
  return mulberry32(seedFrom(`${name}|${day}`));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** A standard normal draw (Box-Muller). */
export function normal(rng: Rng): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
