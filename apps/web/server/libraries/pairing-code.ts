import { randomInt } from "node:crypto";

/**
 * The short code a device shows for its owner to type on a signed-in phone or browser: 8 symbols from an alphabet
 * without lookalikes (no 0/O, no 1/I/L), shown as 4+4. 31 symbols give about 39.6 bits. The
 * code is only a lookup key for a signed-in owner; the device proves itself with its device code.
 */
export type PairingCode = string;

const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const length = 8;
const pattern = new RegExp(`^[${alphabet}]{${length}}$`);

/** A uniform index below `bound`: `crypto.randomInt` rejects out-of-range draws, so no modulo bias. */
const uniform = (bound: number) => randomInt(0, bound);

export const PairingCode = {
  alphabet,
  length,
  /** A new code. `pick` returns a uniform integer in [0, bound); tests pass their own. */
  generate(pick: (bound: number) => number = uniform): PairingCode {
    let code = "";
    for (let index = 0; index < length; index++) {
      const symbol = alphabet[pick(alphabet.length)];
      if (symbol === undefined)
        throw new Error(
          "Nimbus drew a pairing code symbol outside its alphabet. No code was issued; this is a bug in the random source.",
        );
      code += symbol;
    }
    return code;
  },
  /** The code as the device shows it: `B7KD-M4Q9`. */
  display: (code: PairingCode) => `${code.slice(0, 4)}-${code.slice(4)}`,
  /** What someone typed, without case, spaces or the display hyphen, or null when it is no code. */
  parse(input: string): PairingCode | null {
    const compact = input.replace(/[\s-]/g, "").toUpperCase();
    return pattern.test(compact) ? compact : null;
  },
} as const;
