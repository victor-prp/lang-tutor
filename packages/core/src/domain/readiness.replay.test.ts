import { describe, expect, it } from "@jest/globals";
import { gradesFor } from "./memoryGrades";
import {
  applyReadiness,
  countedSkills,
  readinessPct,
  skillChance,
  wordChance,
  type ReadinessKind,
  type ReadinessRow,
} from "./readiness";
import { HOMEWORK_2026_10_17 } from "./readiness.fixture";
import type { Dimension } from "./progress";

const DUE = "2026-10-22";
const ALL: Dimension[] = [
  "written_receptive",
  "written_productive",
  "spelling",
  "spoken_receptive",
  "spoken_productive",
];

/** Percent after each session, in order, with the session's day. */
function replay(kind: ReadinessKind): { day: string; pct: number }[] {
  const counted = countedSkills(kind, ALL);
  const words = [...new Set(HOMEWORK_2026_10_17.map((a) => a.word))];
  const rows = new Map<string, ReadinessRow>();
  const pct = () =>
    readinessPct(
      words.map((w) =>
        wordChance(
          counted.map((d) => skillChance(rows.get(`${w}/${d}`) ?? null, DUE)),
        ),
      ),
    );
  const out: { day: string; pct: number }[] = [];
  let session = HOMEWORK_2026_10_17[0].session;
  let day = HOMEWORK_2026_10_17[0].day;
  for (const a of HOMEWORK_2026_10_17) {
    if (a.session !== session) {
      out.push({ day, pct: pct() });
      session = a.session;
    }
    day = a.day;
    for (const { dimension, grade } of gradesFor(a)) {
      if (!counted.includes(dimension)) continue;
      const key = `${a.word}/${dimension}`;
      const next = applyReadiness(
        rows.get(key) ?? null,
        grade,
        a.day,
        DUE,
        kind,
      );
      if (next) rows.set(key, next.row);
    }
  }
  out.push({ day, pct: pct() });
  return out;
}

const dayEnds = (r: { day: string; pct: number }[]) =>
  Object.fromEntries(r.map((x) => [x.day, x.pct]));

// Phase 67b (spec D1, D3), measured 2026-10-21: the weakest skill, and before the eve only a
// skill's first answer of the day. Phase 65 read homework 45, 70, 83 and the exam 53, 55, 77
// with 60 then 46 inside 18 Oct. The numbers are the forecast (readinessPct), not the card.
describe("replay of the 2026-10-17 homework", () => {
  it("homework reads 51, 69, 81 at the day ends", () => {
    const ends = dayEnds(replay("homework"));
    expect({
      a: ends["2026-10-17"],
      b: ends["2026-10-18"],
      c: ends["2026-10-19"],
    }).toEqual({ a: 51, b: 69, c: 81 });
  });

  it("exam reads 56, 54, 73 at the day ends, with 62 then 48 inside 18 Oct (a cold miss's hold)", () => {
    const r = replay("exam");
    const ends = dayEnds(r);
    expect({
      a: ends["2026-10-17"],
      b: ends["2026-10-18"],
      c: ends["2026-10-19"],
    }).toEqual({ a: 56, b: 54, c: 73 });
    const seq = r.filter((x) => x.day === "2026-10-18").map((x) => x.pct);
    const i = seq.indexOf(62);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(seq[i + 1]).toBe(48);
  });
});
