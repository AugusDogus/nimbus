import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startFileWatch, type FileEvent } from "./watch.worker";

const waitForEvent = (queue: FileEvent[], timeoutMs = 2000) => {
  return new Promise<FileEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for watcher event."));
    }, timeoutMs);

    const interval = setInterval(() => {
      const event = queue.shift();
      if (event) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(event);
      }
    }, 5);
  });
};

const run = async () => {
  const queue: FileEvent[] = [];
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-watch-smoke-"));

  try {
    process.env.NIMBUS_DATA_ROOT = root;
    const handle = startFileWatch(root, 50, (event) => queue.push(event));

    const filePath = path.join(root, "smoke.txt");
    let event = waitForEvent(queue);
    await writeFile(filePath, "hello");
    const created = await event;

    event = waitForEvent(queue);
    await writeFile(filePath, "hello again");
    const modified = await event;

    event = waitForEvent(queue);
    await unlink(filePath);
    const deleted = await event;

    handle.close();

    console.log("[watch.smoke] created:", created);
    console.log("[watch.smoke] modified:", modified);
    console.log("[watch.smoke] deleted:", deleted);
    console.log("[watch.smoke] OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error("[watch.smoke] FAILED", error);
  process.exitCode = 1;
});
