import { expect, test } from "bun:test";

import {
  chooseSegmentTargetMs,
  conservativeSegmentCount,
} from "../src/profile.js";

test("selects the smallest target that satisfies a generic segment bound", () => {
  expect(chooseSegmentTargetMs(1)).toBe(6000);
  const justOverSixSecondBudget = 219 * 6000;
  const selected = chooseSegmentTargetMs(justOverSixSecondBudget, 219);
  expect(selected).toBeGreaterThan(6000);
  expect(
    conservativeSegmentCount(justOverSixSecondBudget, selected!),
  ).toBeLessThanOrEqual(219);
  expect(chooseSegmentTargetMs(219 * 10000, 219)).toBeUndefined();
});
