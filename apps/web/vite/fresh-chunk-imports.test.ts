import { describe, expect, it } from "bun:test";
import { freshChunkImports } from "./fresh-chunk-imports";

describe("freshChunkImports", () => {
  it("asks nimbusChunkUrl for the address of every chunk it imports", () => {
    const code =
      'd(()=>import(`./trash-a1.js`),[]);d(()=>import("./picker-b2.js").then(e=>e.n),[])';
    expect(
      freshChunkImports(code, "assets/index.js", [
        "assets/trash-a1.js",
        "assets/picker-b2.js",
      ]),
    ).toBe(
      'd(()=>import((globalThis.nimbusChunkUrl||String)(`./trash-a1.js`)),[]);d(()=>import((globalThis.nimbusChunkUrl||String)("./picker-b2.js")).then(e=>e.n),[])',
    );
  });

  it("leaves chunks without dynamic imports as they are", () => {
    expect(freshChunkImports("export const x=1;", "assets/x.js", [])).toBe(
      "export const x=1;",
    );
  });

  it("fails on an import it does not recognise", () => {
    expect(() =>
      freshChunkImports("import(base+`trash-a1.js`)", "assets/index.js", [
        "assets/trash-a1.js",
      ]),
    ).toThrow("assets/index.js imports trash-a1.js");
  });
});
