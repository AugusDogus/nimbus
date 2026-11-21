import { TransferCode } from "./transfer-code";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { DropTarget, type DragPayload, type DropVerdict } from "./drop-target";
import { FileEntry } from "./types";

const entryDragType = "application/x-nimbus-entry";

type DragState =
  | { status: "idle" }
  | {
      status: "dragging";
      payload: DragPayload;
      /** The target under the pointer, and what dropping there would do. */
      over: { target: DropTarget; verdict: DropVerdict } | null;
    }
  | { status: "moving"; sources: readonly FileEntry[]; target: DropTarget };

type Options = {
  moveEntries: (
    sources: readonly FileEntry[],
    destinationPath: string,
  ) => Promise<unknown>;
  /**
   * Uploads files dropped from the computer into a folder. It must read `transfer` at once: the
   * browser empties it when the drop event ends. Without it, such drops reach the page instead.
   */
  uploadInto?: (transfer: DataTransfer, destinationPath: string) => void;
};

const isFileDrag = (event: DragEvent<HTMLElement>) =>
  event.dataTransfer.types.includes("Files");

/** A compact "3 items" drag image, so a multi-item drag does not show a single row. */
function setCountImage(event: DragEvent<HTMLElement>, count: number) {
  const badge = document.createElement("div");
  badge.textContent = `${count.toLocaleString()} items`;
  badge.className =
    "fixed -left-[1000px] top-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-md";
  document.body.append(badge);
  event.dataTransfer.setDragImage(badge, -12, -12);
  // The browser snapshots the image synchronously during dragstart.
  setTimeout(() => badge.remove());
}

/**
 * Dragging items onto folders. Items drag from a listing; any place that names a folder takes
 * them through `targetProps`, given the folder as a `DropTarget`, so rows and breadcrumbs share
 * one drag and one set of rules (see `DropTarget.verdict`).
 */
export function useFileDrag({ moveEntries, uploadInto }: Options) {
  const [state, setRendered] = useState<DragState>({ status: "idle" });
  // Handlers read the latest state from this ref: memoized rows keep handlers from earlier renders.
  const stateRef = useRef<DragState>(state);
  const setState = (next: DragState | ((current: DragState) => DragState)) => {
    const value = typeof next === "function" ? next(stateRef.current) : next;
    if (value === stateRef.current) return;
    stateRef.current = value;
    setRendered(value);
  };

  // The item the pointer last pressed. The browser starts a drag from whatever lies under the
  // point that was pressed when the pointer has moved far enough, not from what was pressed: if
  // the list moved meanwhile, such as when an item arrives above or the list scrolls, that is
  // another item, perhaps not one that is selected. Such a drag never starts.
  const pressed = useRef<string | null>(null);
  useEffect(() => {
    const remember = (event: PointerEvent) => {
      pressed.current =
        event.target instanceof Element
          ? (event.target
              .closest("[data-entry-path]")
              ?.getAttribute("data-entry-path") ?? null)
          : null;
    };
    addEventListener("pointerdown", remember, true);
    return () => removeEventListener("pointerdown", remember, true);
  }, []);

  const move = async (sources: readonly FileEntry[], target: DropTarget) => {
    setState({ status: "moving", sources, target });
    // The summary toast reports the outcome, one item or many; a failure stays until closed.
    await moveEntries(sources, target.path);
    setState({ status: "idle" });
  };

  /** The drag this event belongs to, if it is this view's item drag. */
  const itemDrag = (event: DragEvent<HTMLElement>) => {
    const current = stateRef.current;
    return current.status === "dragging" &&
      current.payload.kind === "entries" &&
      event.dataTransfer.types.includes(entryDragType)
      ? current
      : null;
  };

  /** Drag handlers for an item: `sources` is what dragging it moves, the selection if it is in it. */
  const sourceProps = (
    entry: FileEntry,
    sources: () => readonly FileEntry[],
  ) => ({
    draggable: state.status !== "moving" && FileEntry.canMove(entry),
    onDragStart(event: DragEvent<HTMLElement>) {
      if (pressed.current !== entry.path) {
        event.preventDefault();
        return;
      }
      TransferCode.prepare();
      const selected = sources();
      const dragged = selected.filter(FileEntry.canMove);
      if (stateRef.current.status === "moving" || dragged.length === 0) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.clearData();
      event.dataTransfer.setData(
        entryDragType,
        dragged.map((source) => source.path).join("\n"),
      );
      event.dataTransfer.effectAllowed = "move";
      if (dragged.length > 1) setCountImage(event, dragged.length);
      setState({
        status: "dragging",
        // Items that cannot be moved stay behind, and the drag hint says so.
        payload: {
          kind: "entries",
          sources: dragged,
          skipped: selected.length - dragged.length,
        },
        over: null,
      });
    },
    onDragEnd() {
      // A successful drop starts moving before the browser ends its drag session.
      setState((current) =>
        current.status === "dragging" ? { status: "idle" } : current,
      );
    },
  });

  /**
   * The drag an event over a target belongs to: this view's item drag, or files from the
   * computer when this page uploads. Other drags pass through to the page.
   */
  const dragOf = (event: DragEvent<HTMLElement>): DragPayload | null => {
    const items = itemDrag(event);
    if (items) return items.payload;
    // Files from the computer drop independently of a move still running.
    return uploadInto && isFileDrag(event) ? { kind: "files" } : null;
  };

  /** Drop handlers for a folder shown anywhere: a row, a breadcrumb. */
  const targetProps = (target: DropTarget) => ({
    onDragOver(event: DragEvent<HTMLElement>) {
      const payload = dragOf(event);
      if (!payload) return;
      // A refused target takes the event too, so the page does not upload the files itself.
      event.preventDefault();
      event.stopPropagation();
      const verdict = DropTarget.verdict(payload, target);
      event.dataTransfer.dropEffect =
        verdict.kind === "refused"
          ? "none"
          : verdict.kind === "upload"
            ? "copy"
            : "move";
      setState((latest) =>
        latest.status === "moving"
          ? latest
          : latest.status === "idle"
            ? { status: "dragging", payload, over: { target, verdict } }
            : latest.over?.target.path !== target.path ||
                latest.over.verdict.kind !== verdict.kind
              ? { ...latest, over: { target, verdict } }
              : latest,
      );
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      // Files from the computer end their drag outside the page without telling it.
      setState((current) =>
        current.status === "dragging" &&
        current.over?.target.path === target.path
          ? current.payload.kind === "files"
            ? { status: "idle" }
            : { ...current, over: null }
          : current,
      );
    },
    onDrop(event: DragEvent<HTMLElement>) {
      const payload = dragOf(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      const accepted = DropTarget.accepts(payload, target);
      if (payload.kind === "entries" && accepted)
        void move(payload.sources, target);
      else {
        if (payload.kind === "files" && accepted)
          uploadInto?.(event.dataTransfer, target.path);
        // A move still running keeps its state until it ends.
        setState((current) =>
          current.status === "moving" ? current : { status: "idle" },
        );
      }
    },
  });

  const over = state.status === "dragging" ? state.over : null;
  /** Whether a drop on the folder at `path` would be taken, refused, or it is not under the pointer. */
  const dropState = (path: string) =>
    state.status === "moving"
      ? state.target.path === path
        ? "allowed"
        : null
      : over?.target.path === path
        ? over.verdict.kind === "refused"
          ? "refused"
          : "allowed"
        : null;
  const isDragging = (entry: FileEntry) =>
    (state.status === "moving"
      ? state.sources
      : state.status === "dragging" && state.payload.kind === "entries"
        ? state.payload.sources
        : []
    ).some((source) => source.path === entry.path);

  return { state, over, sourceProps, targetProps, dropState, isDragging };
}

export type FileDrag = ReturnType<typeof useFileDrag>;
