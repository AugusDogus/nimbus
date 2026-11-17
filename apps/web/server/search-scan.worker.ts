// A scan worker for the search index (see @nimbus/api/search-scan-pool). It
// keeps the latest layout the search worker shared and scans its share of a
// search's slots when asked. Imports only packages, like search.worker.ts.
import {
  collector,
  ScanCounts,
  scanLayout,
  type ScanScratch,
  type SearchLayout,
} from "@nimbus/api/search-scan";
import type {
  ScanWorkerInbound,
  ScanWorkerOutbound,
} from "@nimbus/api/search-scan-pool";

declare const self: Worker;

let current: {
  generation: number;
  layout: SearchLayout;
  scratch: ScanScratch;
} | null = null;

const post = (message: ScanWorkerOutbound, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

self.onmessage = (event: MessageEvent<ScanWorkerInbound>) => {
  const message = event.data;
  switch (message.type) {
    case "layout": {
      // Structured cloning keeps the shared memory but not the Buffer type.
      const asBuffer = (bytes: Uint8Array) =>
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      const layout: SearchLayout = {
        ...message.layout,
        folded: asBuffer(message.layout.folded),
        plain: asBuffer(message.layout.plain),
      };
      current = {
        generation: message.generation,
        layout,
        scratch: message.scratch,
      };
      return;
    }
    case "drop":
      if (current?.generation === message.generation) current = null;
      return;
    case "scan": {
      const { job, control } = message;
      const held = current;
      if (held?.generation !== message.generation) {
        post({
          type: "failed",
          job,
          message: `Scan worker has no layout ${message.generation}; it holds ${held?.generation ?? "none"}.`,
        });
        return;
      }
      const results = collector(message.limit);
      const counts = ScanCounts.none(message.plan.terms.length);
      const finished = scanLayout(
        held.layout,
        message.plan,
        held.scratch,
        (rank) => results.add(rank),
        counts,
        () => Atomics.load(control, 0) !== job,
      );
      if (!finished) {
        post({ type: "stopped", job });
        return;
      }
      // A copy, so the transfer does not detach the collector's larger buffer.
      const best = results.best().slice();
      post(
        { type: "ranks", job, ranks: { best, total: results.total, counts } },
        [best.buffer],
      );
      return;
    }
  }
};
