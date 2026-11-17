import { expect, test } from "bun:test";
import { SearchText } from "./search-text";

test("reads Latin and Greek letters without accents, and keeps marks that change the word", () => {
  const plain = (text: string) => SearchText.plain(SearchText.foldName(text));
  expect(plain("Crème Brûlée")).toBe("creme brulee");
  expect(plain("Ålesund Zürich Łódź")).toBe("alesund zurich lodz");
  expect(plain("Straße Røyksopp Æble Œuvre")).toBe(
    "strasse royksopp aeble oeuvre",
  );
  expect(plain("Ελληνικά ΟΔΟΣ")).toBe("ελληνικα οδοσ");
  // Cyrillic: ё reads as е, but й is its own letter.
  expect(plain("Отчёт Мой")).toBe("отчет мой");
  // Japanese voicing marks and Indic vowel signs are part of the word.
  expect(plain("がっこう")).toBe("がっこう");
  expect(plain("हिन्दी")).toBe("हिन्दी");
  // Decomposed input reads the same as composed.
  expect(plain(SearchText.foldName("Crème"))).toBe("creme");
  expect(plain("report 2024.pdf")).toBe("report 2024.pdf");
});

test("maps each plain character back to the original text", () => {
  const read = SearchText.plainWithPositions("Straße Crème");
  expect(read?.plain).toBe("strasse creme");
  // "ss" both come from ß, at 4.
  expect([read?.from[4], read?.to[5]]).toEqual([4, 5]);
  expect(read?.plain.slice(8)).toBe("creme");
  expect([read?.from[8], read?.to[12]]).toEqual([7, 12]);
  expect(SearchText.plainWithPositions("Crème")).toBeNull();
});

test("splits words joined by case, hyphens, underscores and dots", () => {
  expect(SearchText.joinedWords("backupPhotos")).toEqual(["backup", "photos"]);
  expect(SearchText.joinedWords("user-profile-card")).toEqual([
    "user",
    "profile",
    "card",
  ]);
  expect(SearchText.joinedWords("logo.final")).toEqual(["logo", "final"]);
  // Numbers keep their own readings: as typed, and as dates.
  expect(SearchText.joinedWords("IMG_4821")).toEqual([]);
  expect(SearchText.joinedWords("2024-03-15")).toEqual([]);
  expect(SearchText.joinedWords("report2024Final")).toEqual([
    "report",
    "2024",
    "final",
  ]);
  expect(SearchText.joinedWords("report")).toEqual([]);
  expect(SearchText.joinedWords("Report")).toEqual([]);
});

test("finds dates written in many ways", () => {
  for (const name of [
    "receipt 2024-03-15.pdf",
    "IMG_20240315_101500.jpg",
    "notes 2024.03.15.txt",
    "scan_2024_03_15",
    "2024 03 15 photo",
    "15-03-2024 visa",
  ])
    expect({
      name,
      day: SearchText.datesIn(name).includes("D20240315"),
      month: SearchText.datesIn(name).includes("M202403"),
    }).toEqual({ name, day: true, month: true });
  // Ambiguous order: both readings that are valid.
  expect(SearchText.datesIn("03-04-2024").sort()).toEqual([
    "D20240304",
    "D20240403",
    "M202403",
    "M202404",
  ]);
  expect(SearchText.datesIn("statement 2024-03.pdf")).toEqual(["M202403"]);
  // Not dates: digits running on, impossible days, bare years.
  expect(SearchText.datesIn("id 120240315 x")).toEqual([]);
  expect(SearchText.datesIn("2024-02-31")).toEqual([]);
  // February 29th only in leap years.
  expect(SearchText.datesIn("2023-02-29")).toEqual([]);
  expect(SearchText.datesIn("1900-02-29")).toEqual([]);
  expect(SearchText.datesIn("2024-02-29")).toEqual(["D20240229", "M202402"]);
  expect(SearchText.datesIn("2000-02-29")).toEqual(["D20000229", "M200002"]);
  expect(SearchText.datesIn("2024 report")).toEqual([]);
});

test("reads a query word as a day or a month only when it is one", () => {
  expect(SearchText.queryDates("20240315")).toEqual(["D20240315"]);
  expect(SearchText.queryDates("15-03-2024")).toEqual(["D20240315"]);
  expect(SearchText.queryDates("2024-03")).toEqual(["M202403"]);
  expect(SearchText.queryDates("2024")).toEqual([]);
  expect(SearchText.queryDates("123")).toEqual([]);
});
