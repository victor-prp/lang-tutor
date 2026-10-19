import { describe, expect, it } from "@jest/globals";
import { retrievability, review } from "./memory";
import type { Dimension } from "./progress";
import {
  READINESS_LITTLE,
  applyReadiness,
  countedSkills,
  readinessFromMemory,
  readinessGainBound,
  readinessPct,
  skillChance,
  wordChance,
  type ReadinessRow,
} from "./readiness";

const ALL: Dimension[] = [
  "written_receptive",
  "written_productive",
  "spelling",
  "spoken_receptive",
  "spoken_productive",
];
const DUE = "2026-10-22";
const D1 = "2026-10-17";
const D2 = "2026-10-18";

const first = (
  grade: 1 | 2 | 3,
  day = D1,
  kind: "homework" | "exam" = "homework",
) => applyReadiness(null, grade, day, DUE, kind)!;

describe("countedSkills", () => {
  it("homework counts written_productive, spelling and spoken_productive", () => {
    expect(countedSkills("homework", ALL)).toEqual([
      "written_productive",
      "spelling",
      "spoken_productive",
    ]);
  });
  it("exam counts written_productive and spelling", () => {
    expect(countedSkills("exam", ALL)).toEqual([
      "written_productive",
      "spelling",
    ]);
  });
  it("keeps only the live skills of the word", () => {
    expect(
      countedSkills("homework", ["written_productive", "spelling"]),
    ).toEqual(["written_productive", "spelling"]);
  });
});

describe("applyReadiness", () => {
  it("the first answer of a day is a long-term review", () => {
    const out = applyReadiness(null, 3, D1, DUE, "homework")!;
    expect(out.why).toBe("first_right");
    expect(out.row.state).toEqual(review(null, 3, D1));
    expect(out.row.bonusUsed).toBe(0);
    expect(out.row.missedToday).toBe(false);
  });

  it("a first miss is first_miss", () => {
    const out = first(1);
    expect(out.why).toBe("first_miss");
    expect(out.row.missedToday).toBe(true);
  });

  it("after a first miss, a second miss the same day is ignored", () => {
    expect(applyReadiness(first(1).row, 1, D1, DUE, "homework")).toBeNull();
  });

  it("after a first right, the first later miss counts once and the second is ignored", () => {
    const a = first(3).row;
    const m = applyReadiness(a, 1, D1, DUE, "homework")!;
    expect(m.why).toBe("miss");
    expect(m.row.state).toEqual(review(a.state, 1, D1));
    expect(applyReadiness(m.row, 1, D1, DUE, "homework")).toBeNull();
  });

  it("a later right the same day lifts the chance by a quarter of the gap, state otherwise unchanged", () => {
    const a = first(3).row;
    const r = skillChance(a, DUE);
    const b = applyReadiness(a, 3, D1, DUE, "homework")!;
    expect(b.why).toBe("bonus");
    expect(skillChance(b.row, DUE)).toBeCloseTo(r + 0.25 * (1 - r), 9);
    expect(b.row.state.lastDay).toBe(a.state.lastDay);
    expect(b.row.state.difficulty).toBe(a.state.difficulty);
  });

  it("the third later right the same day is ignored", () => {
    let row = first(3).row;
    row = applyReadiness(row, 3, D1, DUE, "homework")!.row;
    row = applyReadiness(row, 2, D1, DUE, "homework")!.row;
    expect(row.bonusUsed).toBe(2);
    expect(applyReadiness(row, 3, D1, DUE, "homework")).toBeNull();
  });

  it("an exam holds a skill whose first answer of the day was a miss, at half its chance", () => {
    const { row } = first(1, D1, "exam");
    expect(row.held).toBe(true);
    expect(skillChance(row, DUE)).toBeCloseTo(
      0.5 * retrievability(row.state, DUE),
      9,
    );
  });

  it("an exam hold survives a same-day bonus, which still raises the memory under it (D3.4)", () => {
    const held = first(1, D1, "exam").row;
    const bonus = applyReadiness(held, 3, D1, DUE, "exam")!;
    expect(bonus.why).toBe("bonus");
    expect(bonus.row.held).toBe(true);
    expect(retrievability(bonus.row.state, DUE)).toBeGreaterThan(
      retrievability(held.state, DUE),
    );
    // Counted at half, both before and after the bonus.
    expect(skillChance(bonus.row, DUE)).toBeCloseTo(
      0.5 * retrievability(bonus.row.state, DUE),
      9,
    );
  });

  it("an exam hold lifts on the first right of a later day", () => {
    const held = first(1, D1, "exam").row;
    expect(applyReadiness(held, 3, D2, DUE, "exam")!.row.held).toBe(false);
  });

  it("homework never holds", () => {
    expect(first(1, D1, "homework").row.held).toBe(false);
  });

  it("is frozen on and after the due date", () => {
    expect(applyReadiness(null, 3, DUE, DUE, "homework")).toBeNull();
    expect(
      applyReadiness(first(3).row, 3, "2026-10-23", DUE, "exam"),
    ).toBeNull();
  });

  it("a bonus on a row at its due date or at full chance still counts", () => {
    const row: ReadinessRow = {
      ...first(3).row,
      state: { ...first(3).row.state, stability: 1e9 },
    };
    const out = applyReadiness(row, 3, D1, DUE, "homework")!;
    expect(out.why).toBe("bonus");
    expect(out.row.bonusUsed).toBe(1);
    expect(out.row.state).toEqual(row.state);
  });
});

describe("skillChance", () => {
  it("has no today: nothing moves overnight, the same row read twice gives the same number", () => {
    const row = first(3).row;
    expect(skillChance(row, DUE)).toBe(skillChance(row, DUE));
  });

  it("is 0 without a row", () => {
    expect(skillChance(null, DUE)).toBe(0);
  });

  it("with bonuses given for one date and the date moved later is finite, in (0, 1) and lower", () => {
    let row = first(3).row;
    row = applyReadiness(row, 3, D1, DUE, "homework")!.row;
    row = applyReadiness(row, 3, D1, DUE, "homework")!.row;
    const later = skillChance(row, "2026-11-05");
    expect(Number.isFinite(later)).toBe(true);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(1);
    expect(later).toBeLessThan(skillChance(row, DUE));
  });
});

describe("readinessFromMemory", () => {
  it("wraps a memory state, and a right on its last day is a bonus", () => {
    const state = review(null, 3, D1);
    const row = readinessFromMemory(state);
    expect(row).toEqual({
      state,
      day: state.lastDay,
      missedToday: false,
      bonusUsed: 0,
      held: false,
    });
    expect(applyReadiness(row, 3, state.lastDay, DUE, "homework")!.why).toBe(
      "bonus",
    );
  });
});

describe("aggregation", () => {
  it("wordChance is the product of its skills", () => {
    expect(wordChance([0.54, 0.97, 0.88])).toBeCloseTo(0.461, 3);
    expect(wordChance([])).toBe(0);
  });
  it("readinessPct floors 100 times the mean", () => {
    expect(readinessPct([0.46, 0.89])).toBe(67);
    expect(readinessPct([])).toBe(0);
  });
});

describe("readinessGainBound", () => {
  it("is 0 when every skill already has its first review and both bonuses today", () => {
    const row: ReadinessRow = { ...first(3).row, bonusUsed: 2 };
    expect(readinessGainBound([[row, row]], D1, DUE, "homework")).toBe(0);
  });
  it("is positive for a word whose skill has no row", () => {
    expect(readinessGainBound([[null]], D1, DUE, "homework")).toBeGreaterThan(
      0,
    );
  });

  /** Readiness of one word of one skill, its row put through `grades` rights today. */
  const pctAfter = (row: ReadinessRow | null, rights: number) => {
    let at = row;
    for (let i = 0; i < rights; i++)
      at = applyReadiness(at, 3, D1, DUE, "homework")!.row;
    return readinessPct([skillChance(at, DUE)]);
  };

  it("counts, for a skill with no answer today, its first right and both bonuses", () => {
    // Never answered: a first right, then two bonuses, all still countable today.
    expect(readinessGainBound([[null]], D1, DUE, "homework")).toBe(
      pctAfter(null, 3) - pctAfter(null, 0),
    );
    // Answered on an earlier day: the same three.
    const yesterday = applyReadiness(null, 3, "2026-10-16", DUE, "homework")!
      .row;
    expect(readinessGainBound([[yesterday]], D1, DUE, "homework")).toBe(
      pctAfter(yesterday, 3) - pctAfter(yesterday, 0),
    );
    expect(pctAfter(yesterday, 3)).toBeGreaterThan(pctAfter(yesterday, 1));
  });

  it("counts, for a skill with one bonus left today, that one", () => {
    const one = applyReadiness(first(3).row, 3, D1, DUE, "homework")!.row;
    expect(one.bonusUsed).toBe(1);
    const bound = readinessGainBound([[one]], D1, DUE, "homework");
    expect(bound).toBe(pctAfter(one, 1) - pctAfter(one, 0));
    expect(bound).toBeGreaterThan(0);
  });

  it("is not little while one word of fifteen, missed today, has both bonuses left (I2)", () => {
    // Fourteen words with their first right and both bonuses spent today: nothing more to add.
    let spent = first(3).row;
    spent = applyReadiness(spent, 3, D1, DUE, "homework")!.row;
    spent = applyReadiness(spent, 3, D1, DUE, "homework")!.row;
    expect(spent.bonusUsed).toBe(2);
    // One missed first today, its two bonuses unused: two rights still lift it.
    const missed = first(1).row;
    const words = [...Array.from({ length: 14 }, () => [spent]), [missed]];
    expect(readinessGainBound(words, D1, DUE, "homework")).toBeGreaterThanOrEqual(
      READINESS_LITTLE,
    );
  });
});
