import { describe, expect, it } from "bun:test";
import { MoveUp } from "./move-up";

describe("MoveUp.steady", () => {
  const into: MoveUp = { kind: "into", path: "docs" };

  it("enables Move up once the answer arrives in a menu that opened before it", () => {
    expect(MoveUp.steady(MoveUp.unknown, into)).toEqual(into);
  });

  it("keeps it in place, disabled, when the answer is no", () => {
    expect(MoveUp.steady(MoveUp.unknown, MoveUp.none)).toEqual(MoveUp.unknown);
    expect(MoveUp.steady(into, MoveUp.none)).toEqual(MoveUp.unknown);
  });

  it("never adds it to a menu that opened without it", () => {
    expect(MoveUp.steady(MoveUp.none, into)).toEqual(MoveUp.none);
  });
});
