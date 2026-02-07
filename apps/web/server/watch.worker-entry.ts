import { getDataRoot } from "@nimbus/api/data-root";

import { startFileWatch } from "./watch.worker";

const dataRoot = getDataRoot();
const debounceMs = Number.parseInt(
  process.env.NIMBUS_WATCH_DEBOUNCE_MS ?? "300",
  10,
);

startFileWatch(dataRoot, debounceMs, (event) => {
  postMessage(event);
});
