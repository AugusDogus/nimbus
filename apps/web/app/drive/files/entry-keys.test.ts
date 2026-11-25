import { describe, expect, it } from "bun:test";
import { commandFor, typeaheadMatch, type KeyInput } from "./entry-keys";

const key = (value: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key: value,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  ...modifiers,
});
const list = {
  index: 4,
  count: 10,
  columns: 1,
  pageSize: 5,
  isMac: false,
  split: "none",
} as const;
const grid = { ...list, columns: 3, pageSize: 9 };

describe("file browser keys", () => {
  it("moves in a list and by visual rows in a grid", () => {
    expect(commandFor(key("ArrowDown"), list)).toEqual({
      type: "move",
      index: 5,
      mode: "select",
    });
    expect(commandFor(key("ArrowRight"), list)).toBeNull();
    expect(commandFor(key("ArrowDown"), grid)).toEqual({
      type: "move",
      index: 7,
      mode: "select",
    });
    expect(commandFor(key("ArrowUp"), grid)).toEqual({
      type: "move",
      index: 1,
      mode: "select",
    });
    expect(commandFor(key("ArrowLeft"), grid)).toEqual({
      type: "move",
      index: 3,
      mode: "select",
    });
    expect(commandFor(key("ArrowDown"), { ...grid, index: 8 })).toEqual({
      type: "move",
      index: 9,
      mode: "select",
    });
    expect(commandFor(key("End"), grid)).toEqual({
      type: "move",
      index: 9,
      mode: "select",
    });
    expect(commandFor(key("PageDown"), list)).toEqual({
      type: "move",
      index: 9,
      mode: "select",
    });
    expect(commandFor(key("PageUp"), grid)).toEqual({
      type: "move",
      index: 0,
      mode: "select",
    });
    expect(commandFor(key("ArrowDown"), { ...list, index: -1 })).toEqual({
      type: "move",
      index: 0,
      mode: "select",
    });
  });

  it("extends with shift and moves focus only with the platform modifier", () => {
    expect(
      commandFor(key("ArrowDown", { shiftKey: true }), list),
    ).toMatchObject({ mode: "extend" });
    expect(commandFor(key("ArrowDown", { ctrlKey: true }), list)).toMatchObject(
      { mode: "focus" },
    );
    expect(
      commandFor(key("ArrowDown", { metaKey: true }), { ...list, isMac: true }),
    ).toMatchObject({ mode: "focus" });
    expect(commandFor(key("ArrowDown", { metaKey: true }), list)).toBeNull();
    expect(commandFor(key("ArrowDown", { altKey: true }), list)).toBeNull();
  });

  it("maps actions and ignores composition and repeated destructive keys", () => {
    expect(commandFor(key("Enter"), list)).toEqual({ type: "open" });
    expect(commandFor(key(" "), list)).toEqual({ type: "preview" });
    expect(commandFor(key(" ", { ctrlKey: true }), list)).toEqual({
      type: "toggle",
    });
    expect(
      commandFor(key(" ", { ctrlKey: true }), { ...list, isMac: true }),
    ).toEqual({ type: "toggle" });
    expect(commandFor(key("a", { ctrlKey: true }), list)).toEqual({
      type: "selectAll",
    });
    expect(
      commandFor(key("A", { metaKey: true }), { ...list, isMac: true }),
    ).toEqual({ type: "selectAll" });
    expect(commandFor(key("Delete"), list)).toEqual({ type: "trash" });
    expect(
      commandFor(key("Backspace", { metaKey: true }), { ...list, isMac: true }),
    ).toEqual({ type: "trash" });
    expect(commandFor(key("Backspace"), list)).toBeNull();
    expect(commandFor(key("Delete", { repeat: true }), list)).toBeNull();
    expect(commandFor(key("F2"), list)).toEqual({ type: "rename" });
    expect(commandFor(key("Escape"), list)).toEqual({ type: "clear" });
    expect(commandFor(key("?", { shiftKey: true }), list)).toEqual({
      type: "help",
    });
    expect(commandFor(key("r"), list)).toEqual({
      type: "typeahead",
      text: "r",
    });
    expect(commandFor(key("r", { ctrlKey: true }), list)).toBeNull();
    expect(
      commandFor(key("ArrowDown", { isComposing: true }), list),
    ).toBeNull();
    expect(commandFor(key("Tab"), list)).toBeNull();
  });

  it("matches typeahead prefixes, cycling on a repeated letter", () => {
    const names = ["apple", "Banana", "berry", "blue", "cherry"];
    expect(typeaheadMatch(names, -1, "b")).toBe(1);
    expect(typeaheadMatch(names, 1, "b")).toBe(2);
    expect(typeaheadMatch(names, 2, "bb")).toBe(3);
    expect(typeaheadMatch(names, 3, "bbb")).toBe(1);
    expect(typeaheadMatch(names, 1, "bl")).toBe(3);
    expect(typeaheadMatch(names, 1, "ba")).toBe(1);
    expect(typeaheadMatch(names, 0, "z")).toBe(-1);
  });
});

describe("split view keys", () => {
  it("opens and closes the split with a bar, and moves to the other pane with a backslash", () => {
    const closed = { ...list, split: "closed" } as const;
    const open = { ...list, split: "open" } as const;
    expect(commandFor(key("|", { shiftKey: true }), closed)).toEqual({
      type: "toggleSplit",
    });
    expect(commandFor(key("|", { shiftKey: true }), open)).toEqual({
      type: "toggleSplit",
    });
    expect(commandFor(key("\\"), open)).toEqual({ type: "focusOtherPane" });
    // AltGr, as some layouts type them, reports Ctrl and Alt together.
    expect(
      commandFor(key("|", { ctrlKey: true, altKey: true }), closed),
    ).toEqual({ type: "toggleSplit" });
  });

  it("leaves the keys alone without a split to open or a pane beside", () => {
    expect(commandFor(key("|", { shiftKey: true }), list)).toEqual({
      type: "typeahead",
      text: "|",
    });
    expect(commandFor(key("\\"), { ...list, split: "closed" })).toEqual({
      type: "typeahead",
      text: "\\",
    });
  });

  it("never takes browser shortcuts or function keys", () => {
    const open = { ...list, split: "open" } as const;
    expect(commandFor(key("\\", { metaKey: true }), open)).toBeNull();
    expect(commandFor(key("\\", { ctrlKey: true }), open)).toBeNull();
    expect(
      commandFor(key("|", { altKey: true, shiftKey: true }), open),
    ).toBeNull();
    for (const name of ["F5", "F6", "F11", "F12"])
      expect(commandFor(key(name), open)).toBeNull();
    expect(commandFor(key("r", { ctrlKey: true }), open)).toBeNull();
    expect(commandFor(key("l", { ctrlKey: true }), open)).toBeNull();
  });
});
