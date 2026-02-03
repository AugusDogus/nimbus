import { getDataRoot } from "@nimbus/api/data-root";

const dataRoot = getDataRoot();
const debounceMs = Number.parseInt(
  process.env.NIMBUS_WATCH_DEBOUNCE_MS ?? "300",
  10,
);

type WatchEvent = "rename" | "change" | "delete" | "unknown";

type FileEvent = {
  path: string;
  event: WatchEvent;
  ts: number;
};

const pending = new Map<string, FileEvent>();
let timer: ReturnType<typeof setTimeout> | null = null;

const flush = () => {
  for (const event of pending.values()) {
    postMessage(event);
  }
  pending.clear();
  timer = null;
};

Bun.watch({
  paths: [dataRoot],
  recursive: true,
  onChange(event, path) {
    const normalizedEvent: WatchEvent =
      event === "rename" || event === "change" ? event : "unknown";

    const payload: FileEvent = {
      path,
      event: normalizedEvent,
      ts: Date.now(),
    };

    pending.set(path, payload);
    if (!timer) {
      timer = setTimeout(flush, debounceMs);
    }
  },
});
