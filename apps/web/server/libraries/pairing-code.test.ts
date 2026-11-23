import { expect, test } from "bun:test";
import { PairingCode } from "./pairing-code";

test("the alphabet has no lookalike symbols", () => {
  expect(PairingCode.alphabet).toHaveLength(31);
  for (const lookalike of ["0", "O", "1", "I", "L"])
    expect(PairingCode.alphabet).not.toContain(lookalike);
  expect(new Set(PairingCode.alphabet).size).toBe(PairingCode.alphabet.length);
});

test("codes are 8 symbols drawn with the alphabet's size as the only bound", () => {
  const bounds: number[] = [];
  let next = 0;
  const code = PairingCode.generate((bound) => {
    bounds.push(bound);
    return next++ % bound;
  });
  // Each symbol is one uniform draw below 31, never a modulo of a wider random number.
  expect(bounds).toEqual(Array.from({ length: 8 }, () => 31));
  expect(code).toBe("ABCDEFGH");
  expect(PairingCode.display(code)).toBe("ABCD-EFGH");
});

test("generated codes use every symbol about equally", () => {
  const counts = new Map<string, number>();
  const codes = 8000;
  for (let index = 0; index < codes; index++)
    for (const symbol of PairingCode.generate())
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  expect(counts.size).toBe(31);
  // Chi-square with 30 degrees of freedom: 70 is far past p = 0.0001 for a uniform source.
  const expected = (codes * 8) / 31;
  let chiSquare = 0;
  for (const count of counts.values())
    chiSquare += (count - expected) ** 2 / expected;
  expect(chiSquare).toBeLessThan(70);
});

test("typed codes ignore case, spaces and the display hyphen", () => {
  expect(PairingCode.parse("b7kd-m4q9")).toBe("B7KDM4Q9");
  expect(PairingCode.parse(" B7KD M4Q9 ")).toBe("B7KDM4Q9");
  expect(PairingCode.parse("B7KDM4Q9")).toBe("B7KDM4Q9");
  expect(PairingCode.parse("B7KD-M4Q")).toBeNull();
  expect(PairingCode.parse("B7KD-M4Q0")).toBeNull();
  expect(PairingCode.parse("B7KD-M4Q9X")).toBeNull();
});
