import { PROTOCOL_VERSION } from "../supervisor/protocol";
import { expect, test } from "bun:test";
import { UpdateOffer, type ImageAbi } from "./update-offer";
import { testManifest } from "./updates-testing";

const image: ImageAbi = {
  bun: "1.4.4",
  supervisorProtocol: PROTOCOL_VERSION,
  native: { sharp: "0.35.4" },
};

test("a newer release this image can run is offered", () => {
  expect(
    UpdateOffer.decide({
      manifest: testManifest(11),
      identity: { repository: "example/nimbus", channel: "edge" },
      highestRun: 10,
      image,
    }).kind,
  ).toBe("offer");
});

test("a release no newer than one already run is never offered, however it is signed", () => {
  for (const sequence of [10, 9, 1])
    expect(
      UpdateOffer.decide({
        manifest: testManifest(sequence),
        identity: { repository: "example/nimbus", channel: "edge" },
        highestRun: 10,
        image,
      }).kind,
    ).toBe("current");
});

test("a newer release that needs another image is reported with what it needs and which image to pull", () => {
  const manifest = testManifest(12, {
    requires: {
      bun: "1.5.0",
      supervisorProtocol: PROTOCOL_VERSION + 1,
      native: { sharp: "0.36.0", "@example/codec": "1.0.0" },
      image: "ghcr.io/example/nimbus:edge",
    },
  });
  const offer = UpdateOffer.decide({
    manifest,
    identity: { repository: "example/nimbus", channel: "edge" },
    highestRun: 10,
    image,
  });
  expect(offer.kind).toBe("needs-newer-image");
  if (offer.kind !== "needs-newer-image") return;
  expect(offer.reasons).toEqual([
    "Bun 1.5.0, where this image has 1.4.4",
    `supervisor protocol ${PROTOCOL_VERSION + 1}, where this image speaks ${PROTOCOL_VERSION}`,
    "sharp 0.36.0, where this image has 0.35.4",
    "@example/codec 1.0.0, which this image does not provide",
  ]);
  expect(UpdateOffer.describe(offer)).toContain(
    "Pull ghcr.io/example/nimbus:edge",
  );
});

test("a release of another channel or repository is not offered", () => {
  for (const other of [{ channel: "stable" }, { repository: "example/fork" }]) {
    const manifest = testManifest(20);
    manifest.build = { ...manifest.build, ...other };
    expect(
      UpdateOffer.decide({
        manifest,
        identity: { repository: "example/nimbus", channel: "edge" },
        highestRun: 10,
        image,
      }).kind,
    ).toBe("other-release");
  }
});
