import { useState, type DragEvent } from "react";
import { FileEntry } from "./types";

const entryDragType = "application/x-nimbus-entry";
type DragState =
  | { status: "idle" }
  | { status: "dragging"; sources: readonly FileEntry[]; targetPath: string | null }
  | { status: "moving"; sources: readonly FileEntry[]; targetPath: string }
  | { status: "error"; message: string };

type Moves = {
  moveEntry: (sourcePath: string, destinationPath: string) => Promise<void>;
  moveEntries: (sources: readonly FileEntry[], destinationPath: string) => Promise<unknown>;
};

const canMoveAllInto = (sources: readonly FileEntry[], destination: FileEntry) =>
  sources.length > 0 && sources.every((source) => FileEntry.canMoveInto(source, destination));

/** A compact "3 items" drag image, so a multi-item drag does not show a single row. */
function setCountImage(event: DragEvent<HTMLElement>, count: number) {
  const badge = document.createElement("div");
  badge.textContent = `${count.toLocaleString()} items`;
  badge.className = "fixed -left-[1000px] top-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-md";
  document.body.append(badge);
  event.dataTransfer.setDragImage(badge, -12, -12);
  // The browser snapshots the image synchronously during dragstart.
  setTimeout(() => badge.remove());
}

export function useFileDrag({ moveEntry, moveEntries }: Moves) {
  const [state, setState] = useState<DragState>({ status: "idle" });

  const move = async (sources: readonly FileEntry[], destination: FileEntry) => {
    setState({ status: "moving", sources, targetPath: destination.path });
    const [source, ...rest] = sources;
    if (source && rest.length === 0) {
      try {
        await moveEntry(source.path, destination.path);
        setState({ status: "idle" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Refresh the folder and try again.";
        setState({ status: "error", message: `Could not move “${source.name}” to “${destination.name}”. ${reason}` });
      }
      return;
    }
    // Bulk moves report their outcome in a summary toast.
    await moveEntries(sources, destination.path);
    setState({ status: "idle" });
  };

  const active = state.status === "dragging" || state.status === "moving" ? state : null;
  const isDropTarget = (entry: FileEntry) => active?.targetPath === entry.path;
  const isDragging = (entry: FileEntry) => active?.sources.some((source) => source.path === entry.path) ?? false;

  /** `sources` is what dragging `entry` moves: the selection when it includes `entry`. */
  const getDragProps = (entry: FileEntry, sources: () => readonly FileEntry[]) => ({
    draggable: state.status !== "moving" && FileEntry.canMove(entry),
    "aria-busy": state.status === "moving" && isDragging(entry),
    "data-drop-target": isDropTarget(entry) || undefined,
    onDragStart(event: DragEvent<HTMLElement>) {
      const dragged = sources().filter(FileEntry.canMove);
      if (state.status === "moving" || dragged.length === 0) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.clearData();
      event.dataTransfer.setData(entryDragType, dragged.map((source) => source.path).join("\n"));
      event.dataTransfer.effectAllowed = "move";
      if (dragged.length > 1) setCountImage(event, dragged.length);
      setState({ status: "dragging", sources: dragged, targetPath: null });
    },
    onDragEnd() {
      // A successful drop starts moving before the browser ends its drag session.
      setState((current) => (current.status === "dragging" ? { status: "idle" } : current));
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (state.status !== "dragging" || !event.dataTransfer.types.includes(entryDragType)) return;
      event.preventDefault();
      event.stopPropagation();
      const allowed = canMoveAllInto(state.sources, entry);
      event.dataTransfer.dropEffect = allowed ? "move" : "none";
      const targetPath = allowed ? entry.path : null;
      setState((current) =>
        current.status === "dragging" && current.targetPath !== targetPath ? { ...current, targetPath } : current,
      );
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setState((current) =>
        current.status === "dragging" && current.targetPath === entry.path ? { ...current, targetPath: null } : current,
      );
    },
    onDrop(event: DragEvent<HTMLElement>) {
      // Only this view's active drag can move entries. OS file drops still reach the uploader.
      if (state.status !== "dragging" || !event.dataTransfer.types.includes(entryDragType)) return;
      event.preventDefault();
      event.stopPropagation();
      if (canMoveAllInto(state.sources, entry)) void move(state.sources, entry);
      else setState({ status: "idle" });
    },
  });

  return { state, getDragProps, isDropTarget, isDragging };
}
