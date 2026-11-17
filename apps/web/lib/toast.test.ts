import { expect, test } from "bun:test";
import { connectToasts, toast, type ToastRequest } from "./toast";

test("toasts asked for before the UI connects show once it does, in order", () => {
  toast("Uploading");
  toast.success("Uploaded");
  toast.error("Could not upload");
  const shown: ToastRequest[] = [];
  const disconnect = connectToasts((request) => shown.push(request));
  expect(shown).toEqual([
    { title: "Uploading" },
    { title: "Uploaded", type: "success" },
    { title: "Could not upload", type: "error" },
  ]);

  toast("Moved");
  expect(shown.at(-1)).toEqual({ title: "Moved" });

  // A disconnected UI, such as one unmounting in development, queues again for the next.
  disconnect();
  toast("Renamed");
  expect(shown).toHaveLength(4);
  const later: ToastRequest[] = [];
  const reconnect = connectToasts((request) => later.push(request));
  expect(later).toEqual([{ title: "Renamed" }]);
  reconnect();
});
