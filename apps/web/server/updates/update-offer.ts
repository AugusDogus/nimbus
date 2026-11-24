import type { ReleaseManifest } from "./release-manifest";

/** What this image can run: compared with what a release needs. */
export type ImageAbi = {
  bun: string;
  supervisorProtocol: number;
  /** Native packages it provides, by version. */
  native: Record<string, string>;
};

/**
 * What a verified manifest means for this installation (see the rules in docs/updates.md).
 *
 * - `offer`: newer than anything run on the channel, and this image can run it.
 * - `current`: not newer than what this installation already ran; never installed by a check.
 * - `needs-newer-image`: newer, but this image lacks what it needs.
 * - `other-channel`: published for another channel than the image's.
 */
export type UpdateOffer =
  | { kind: "offer"; manifest: ReleaseManifest }
  | { kind: "current"; manifest: ReleaseManifest }
  | { kind: "needs-newer-image"; manifest: ReleaseManifest; reasons: string[] }
  | { kind: "other-channel"; manifest: ReleaseManifest };

/** Why `image` cannot run a release that needs `requires`; empty when it can. */
function missing(requires: ReleaseManifest["requires"], image: ImageAbi) {
  const reasons: string[] = [];
  if (requires.bun !== image.bun)
    reasons.push(`Bun ${requires.bun}, where this image has ${image.bun}`);
  if (requires.supervisorProtocol !== image.supervisorProtocol)
    reasons.push(
      `supervisor protocol ${requires.supervisorProtocol}, where this image speaks ${image.supervisorProtocol}`,
    );
  for (const [name, version] of Object.entries(requires.native)) {
    const provided = image.native[name];
    if (provided !== version)
      reasons.push(
        provided === undefined
          ? `${name} ${version}, which this image does not provide`
          : `${name} ${version}, where this image has ${provided}`,
      );
  }
  return reasons;
}

export const UpdateOffer = {
  missing,

  decide({
    manifest,
    channel,
    highestRun,
    image,
  }: {
    manifest: ReleaseManifest;
    /** The image's channel. */
    channel: string;
    /** The highest sequence any release this installation ran on the channel had. */
    highestRun: number;
    image: ImageAbi;
  }): UpdateOffer {
    if (manifest.build.channel !== channel)
      return { kind: "other-channel", manifest };
    if (manifest.build.sequence <= highestRun)
      return { kind: "current", manifest };
    const reasons = missing(manifest.requires, image);
    return reasons.length
      ? { kind: "needs-newer-image", manifest, reasons }
      : { kind: "offer", manifest };
  },

  /** One line for the administrator about `offer`. */
  describe(offer: UpdateOffer) {
    const build = `build ${offer.manifest.build.sequence} (${offer.manifest.build.commit.slice(0, 12)})`;
    switch (offer.kind) {
      case "offer":
        return `Nimbus ${build} is available.`;
      case "current":
        return `Nimbus is up to date: the newest release on the ${offer.manifest.build.channel} channel is ${build}, which this installation already runs or ran.`;
      case "needs-newer-image":
        return `Nimbus ${build} is available but needs ${offer.reasons.join("; ")}. Pull ${offer.manifest.requires.image} and recreate the container to get it; Nimbus keeps running the current release until then.`;
      case "other-channel":
        return `The update source offers ${build} for the ${offer.manifest.build.channel} channel, not this image's channel, so it was not offered. Check NIMBUS_UPDATE_SOURCE.`;
    }
  },
} as const;
