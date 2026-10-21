import { describe, expect, it } from "@jest/globals";
import { retrievability, review } from "./memory";
import type { Dimension } from "./progress";
import {
  READINESS_BONUS_RECORDED,
  READINESS_CARD_BAR,
  applyReadiness,
  cardPct,
  cardWordPct,
  countedSkills,
  readinessFromMemory,
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
/** Phase 67b (spec D3): the day before the due date, the only day later answers count. */
const EVE = "2026-10-21";

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

  it("before the eve, a later right and a later miss the same day are ignored (phase 67b D3)", () => {
    const a = first(3).row;
    expect(applyReadiness(a, 3, D1, DUE, "homework")).toBeNull();
    expect(applyReadiness(a, 1, D1, DUE, "homework")).toBeNull();
    expect(applyReadiness(a, 3, D2, DUE, "exam")).not.toBeNull();
  });

  it("on the eve, after a first right, the first later miss counts once and the second is ignored", () => {
    const a = first(3, EVE).row;
    const m = applyReadiness(a, 1, EVE, DUE, "homework")!;
    expect(m.why).toBe("miss");
    expect(m.row.state).toEqual(review(a.state, 1, EVE));
    expect(applyReadiness(m.row, 1, EVE, DUE, "homework")).toBeNull();
  });

  it("on the eve, a later right lifts the chance by a quarter of the gap, state otherwise unchanged", () => {
    const a = first(3, EVE).row;
    const r = skillChance(a, DUE);
    const b = applyReadiness(a, 3, EVE, DUE, "homework")!;
    expect(b.why).toBe("bonus");
    expect(skillChance(b.row, DUE)).toBeCloseTo(r + 0.25 * (1 - r), 9);
    expect(b.row.state.lastDay).toBe(a.state.lastDay);
    expect(b.row.state.difficulty).toBe(a.state.difficulty);
  });

  it("on the eve, every later right keeps closing the gap, and bonus_used stops at 2 (phase 67b D3)", () => {
    let row = first(3, EVE).row;
    let last = skillChance(row, DUE);
    for (let i = 0; i < 5; i++) {
      const out = applyReadiness(row, 3, EVE, DUE, "homework")!;
      expect(out.why).toBe("bonus");
      expect(skillChance(out.row, DUE)).toBeGreaterThan(last);
      last = skillChance(out.row, DUE);
      row = out.row;
    }
    expect(READINESS_BONUS_RECORDED).toBe(2);
    expect(row.bonusUsed).toBe(2);
  });

  it("an exam holds a skill whose first answer of the day was a miss, at half its chance", () => {
    const { row } = first(1, D1, "exam");
    expect(row.held).toBe(true);
    expect(skillChance(row, DUE)).toBeCloseTo(
      0.5 * retrievability(row.state, DUE),
      9,
    );
  });

  it("before the eve, an exam hold stays through the day: a later right is ignored", () => {
    const held = first(1, D1, "exam").row;
    expect(applyReadiness(held, 3, D1, DUE, "exam")).toBeNull();
  });

  it("on the eve, a later right wins back a cold miss's hold and raises the memory under it (phase 67b D3)", () => {
    const held = first(1, EVE, "exam").row;
    expect(held.held).toBe(true);
    const bonus = applyReadiness(held, 3, EVE, DUE, "exam")!;
    expect(bonus.why).toBe("bonus");
    expect(bonus.row.held).toBe(false);
    expect(retrievability(bonus.row.state, DUE)).toBeGreaterThan(
      retrievability(held.state, DUE),
    );
    expect(skillChance(bonus.row, DUE)).toBeCloseTo(
      retrievability(bonus.row.state, DUE),
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

  it("on the eve, a bonus on a row at full chance still counts", () => {
    const row: ReadinessRow = {
      ...first(3, EVE).row,
      state: { ...first(3, EVE).row.state, stability: 1e9 },
    };
    const out = applyReadiness(row, 3, EVE, DUE, "homework")!;
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
    let row = first(3, EVE).row;
    row = applyReadiness(row, 3, EVE, DUE, "homework")!.row;
    row = applyReadiness(row, 3, EVE, DUE, "homework")!.row;
    const later = skillChance(row, "2026-11-05");
    expect(Number.isFinite(later)).toBe(true);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(1);
    expect(later).toBeLessThan(skillChance(row, DUE));
  });
});

describe("readinessFromMemory", () => {
  it("wraps a memory state: its last day's answer was that day's first, so before the eve a later one is ignored and on the eve a right is a bonus", () => {
    const state = review(null, 3, D1);
    const row = readinessFromMemory(state);
    expect(row).toEqual({
      state,
      day: state.lastDay,
      missedToday: false,
      bonusUsed: 0,
      held: false,
    });
    expect(applyReadiness(row, 3, state.lastDay, DUE, "homework")).toBeNull();
    const eve = readinessFromMemory(review(null, 3, EVE));
    expect(applyReadiness(eve, 3, EVE, DUE, "homework")!.why).toBe("bonus");
  });
});

describe("aggregation", () => {
  it("wordChance is its weakest skill (phase 67b D1)", () => {
    expect(wordChance([0.92, 0.94, 0.94])).toBe(0.92);
    expect(wordChance([0.84, 0.84, 0])).toBe(0);
    expect(wordChance([])).toBe(0);
  });
  it("the card counts a word at its kind's bar as 100: homework 90, a test 95 (phase 67b D2)", () => {
    expect(READINESS_CARD_BAR).toEqual({ homework: 90, exam: 95 });
    expect(cardWordPct(89, "homework")).toBe(89);
    expect(cardWordPct(90, "homework")).toBe(100);
    expect(cardWordPct(94, "exam")).toBe(94);
    expect(cardWordPct(95, "exam")).toBe(100);
    expect(cardPct([92, 50], "homework")).toBe(75);
    expect(cardPct([92, 50], "exam")).toBe(71);
    expect(cardPct([], "homework")).toBe(0);
  });
  it("readinessPct floors 100 times the mean", () => {
    expect(readinessPct([0.46, 0.89])).toBe(67);
    expect(readinessPct([])).toBe(0);
  });
});
