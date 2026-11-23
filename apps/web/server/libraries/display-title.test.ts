import { expect, test } from "bun:test";
import { DisplayTitle } from "./display-title";
import { ItemKind } from "./item-kind";

const id = "itm_exampleexampleABC123";
const title = (name: string) =>
  DisplayTitle.fromFileName(name, ItemKind.of(name).kind, id);

test.each([
  ["2026-10-08_sourdough-basics.mp4", "sourdough basics"],
  ["TRAIL_MAP_FOR_THE_NORTH_LOOP_20261101.PDF", "Trail map for the north loop"],
  ["2026-02-29_notes.pdf", "2026 02 29 notes"],
  ["2024-02-29.pdf", "Document ABC123"],
  ["B12-and-5-minute-stretches.mp4", "B12 and 5 minute stretches"],
  ["Chapter_2_2026.pdf", "Chapter 2 2026"],
  ["GPS_SETUP.mp4", "GPS setup"],
  ["FAQ.pdf", "FAQ"],
  ["___---.pdf", "Document ABC123"],
  ["version.2_notes.pdf", "version.2 notes"],
])("%s is shown as %s", (name, expected) => {
  expect(title(name)).toBe(expected);
});

test.each([
  // A short leading sequence number and its separator go.
  ["01 Getting started.mp4", "Getting started"],
  ["02_Next steps.mp4", "Next steps"],
  ["3 - Follow up.mp4", "Follow up"],
  ["1. Introduction.pdf", "Introduction"],
  ["4) Wrap up.mp4", "Wrap up"],
  ["001_bike repair notes.pdf", "bike repair notes"],
  ["04-2026-10-08_ridge walk.mp4", "ridge walk"],
  // A number that is part of the title, or the whole title, stays.
  ["2026 plan.pdf", "2026 plan"],
  ["101 questions.pdf", "101 questions"],
  ["7.mp4", "7"],
  ["05.mp4", "05"],
  ["12 days of baking.mp4", "12 days of baking"],
  ["3-step guide.pdf", "3 step guide"],
  ["1.5 cups of flour.pdf", "1.5 cups of flour"],
])("sequence numbers: %s is shown as %s", (name, expected) => {
  expect(title(name)).toBe(expected);
});

test("only whole dates at the start or end go, with calendar rules", () => {
  expect(title("Weekly plan 2026_11_02.mp4")).toBe("Weekly plan");
  expect(title("Packing list 2026-11-02 draft.pdf")).toBe(
    "Packing list 2026 11 02 draft",
  );
  expect(title("2026-11-01 2026-11-02 Trip log.pdf")).toBe("Trip log");
  expect(title("Exercises 2026-13-01.mp4")).toBe("Exercises 2026 13 01");
  expect(title("Notes 2100-02-29.pdf")).toBe("Notes 2100 02 29");
  expect(title("Notes 2000-02-29.pdf")).toBe("Notes");
  expect(title("Dose 20g.pdf")).toBe("Dose 20g");
  expect(title("Tour 2026.mp4")).toBe("Tour 2026");
  expect(title("12.05.2026 checklist.pdf")).toBe("12.05.2026 checklist");
});

test("only the final extension is removed, for any kind", () => {
  expect(title("report.final.pdf")).toBe("report.final");
  expect(title("clip.pdf.mp4")).toBe("clip.pdf");
  expect(title("Garden walk.MP4")).toBe("Garden walk");
  expect(title("Ridge_photo.jpeg")).toBe("Ridge photo");
  expect(title("archive.tar.gz")).toBe("archive.tar");
  expect(title(".hidden")).toBe("hidden");
  expect(title("2026-01-01.zip")).toBe("File ABC123");
  expect(title("2026-01-01.flac")).toBe("Audio ABC123");
});

test("mixed case is kept and short lone uppercase words are kept as acronyms", () => {
  expect(title("How to shape a sourdough loaf.mp4")).toBe(
    "How to shape a sourdough loaf",
  );
  expect(title("DIY_shelf.pdf")).toBe("DIY shelf");
  expect(title("NEXT.pdf")).toBe("NEXT");
  expect(title("USB_SETUP_FOR_THE_DVD_PLAYER.mp4")).toBe(
    "USB setup for the DVD player",
  );
});

test("controls are removed and long titles end at a character boundary", () => {
  expect(title("Walk\u0007ing\u202e gui\u200fde.mp4")).toBe("Walking guide");
  const long = `${"a".repeat(158)}👍🏽👍🏽👍🏽.pdf`;
  const shown = title(long);
  expect([...new Intl.Segmenter().segment(shown)]).toHaveLength(160);
  expect(shown.endsWith("👍🏽👍🏽")).toBe(true);
});

test("collections are cleaned folder names", () => {
  expect(DisplayTitle.collection("trail-maps")).toBe("trail maps");
  expect(DisplayTitle.collection("Guides")).toBe("Guides");
  expect(DisplayTitle.collection("---")).toBeNull();
});
