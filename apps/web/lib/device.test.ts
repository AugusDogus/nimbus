import { describe, expect, test } from "bun:test";
import { Device } from "./device";

/** A matcher answering the given queries true and every other one false. */
const matching =
  (...queries: string[]) =>
  (query: string) =>
    queries.includes(query);

describe("Device.read", () => {
  test("a phone is narrow, with a coarse primary pointer that cannot hover", () => {
    expect(
      Device.read(matching(Device.query.narrow, Device.query.coarse)),
    ).toEqual({ room: "narrow", pointer: "coarse", anyFine: false });
  });

  test("a touch tablet 768 px wide or more has room, and stays touch", () => {
    expect(Device.read(matching(Device.query.coarse))).toEqual({
      room: "wide",
      pointer: "coarse",
      anyFine: false,
    });
  });

  test("a narrow window with a mouse is narrow, and stays a mouse", () => {
    expect(
      Device.read(
        matching(Device.query.narrow, Device.query.fine, Device.query.anyFine),
      ),
    ).toEqual({ room: "narrow", pointer: "fine", anyFine: true });
  });

  test("a hybrid laptop's primary pointer is its trackpad, and it can drag", () => {
    expect(
      Device.read(matching(Device.query.fine, Device.query.anyFine)),
    ).toEqual({ room: "wide", pointer: "fine", anyFine: true });
  });

  test("a device with no pointer at all, such as a keyboard-only one, is not coarse", () => {
    expect(Device.read(matching())).toEqual({
      room: "wide",
      pointer: "none",
      anyFine: false,
    });
  });
});

describe("Device.isMac", () => {
  test("macOS, iPhone and iPad use Command for shortcuts", () => {
    expect(
      Device.isMac(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_2) AppleWebKit/605.1.15",
      ),
    ).toBe(true);
    expect(
      Device.isMac("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)"),
    ).toBe(true);
    expect(Device.isMac("Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X)")).toBe(
      true,
    );
  });

  test("Windows, Linux and Android use Ctrl", () => {
    expect(Device.isMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      false,
    );
    expect(Device.isMac("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
    expect(Device.isMac("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(
      false,
    );
  });

  test("without a navigator, as on the server, it is not a Mac", () => {
    expect(Device.isMac(undefined)).toBe(false);
  });
});
