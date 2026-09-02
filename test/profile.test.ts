import { expect, test } from "bun:test";

import {
  chooseSegmentTargetMs,
  conservativeSegmentCount,
  patchCountForSegments,
} from "../src/profile.js";

test("selects the smallest conservative integer-millisecond patch target", () => {
  expect(chooseSegmentTargetMs(1)).toBe(6000);
  const justOverSixSecondBudget = 219 * 6000;
  const selected = chooseSegmentTargetMs(justOverSixSecondBudget);
  expect(selected).toBeGreaterThan(6000);
  expect(
    conservativeSegmentCount(justOverSixSecondBudget, selected!),
  ).toBeLessThanOrEqual(219);
  expect(patchCountForSegments(219)).toBe(666);
  expect(chooseSegmentTargetMs(219 * 10000)).toBeUndefined();
});
