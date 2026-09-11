import { useState, type DragEvent } from "react";
import { FileEntry } from "./types";

const entryDragType = "application/x-nimbus-entry";
type DragState =
  | { status: "idle" }
  | { status: "dragging"; source: FileEntry; targetPath: string | null }
  | { status: "moving"; source: FileEntry; targetPath: string }
  | { status: "error"; message: string };

export function useFileDrag(moveEntry: (sourcePath: string, destinationPath: string) => Promise<void>) {
  const [state, setState] = useState<DragState>({ status: "idle" });

  const move = async (source: FileEntry, destination: FileEntry) => {
    setState({ status: "moving", source, targetPath: destination.path });
    try {
      await moveEntry(source.path, destination.path);
      setState({ status: "idle" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Refresh the folder and try again.";
      setState({ status: "error", message: `Could not move “${source.name}” to “${destination.name}”. ${reason}` });
    }
  };

  const isDropTarget = (entry: FileEntry) =>
    (state.status === "dragging" || state.status === "moving") && state.targetPath === entry.path;
  const isDragging = (entry: FileEntry) =>
    (state.status === "dragging" || state.status === "moving") && state.source.path === entry.path;

  const getDragProps = (entry: FileEntry) => ({
    draggable: state.status !== "moving" && FileEntry.canMove(entry),
    "aria-busy": state.status === "moving" && isDragging(entry),
    "data-drop-target": isDropTarget(entry) || undefined,
    onDragStart(event: DragEvent<HTMLElement>) {
      if (state.status === "moving" || !FileEntry.canMove(entry)) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.clearData();
      event.dataTransfer.setData(entryDragType, entry.path);
      event.dataTransfer.effectAllowed = "move";
      setState({ status: "dragging", source: entry, targetPath: null });
    },
    onDragEnd() {
      // A successful drop starts moving before the browser ends its drag session.
      setState((current) => current.status === "dragging" ? { status: "idle" } : current);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (state.status !== "dragging" || !event.dataTransfer.types.includes(entryDragType)) return;
      event.preventDefault();
      event.stopPropagation();
      const allowed = FileEntry.canMoveInto(state.source, entry);
      event.dataTransfer.dropEffect = allowed ? "move" : "none";
      const targetPath = allowed ? entry.path : null;
      setState((current) => current.status === "dragging" && current.targetPath !== targetPath
        ? { ...current, targetPath } : current);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setState((current) => current.status === "dragging" && current.targetPath === entry.path
        ? { ...current, targetPath: null } : current);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      // Only this view's active drag can move an entry. OS file drops still reach the uploader.
      if (state.status !== "dragging" || !event.dataTransfer.types.includes(entryDragType)) return;
      event.preventDefault();
      event.stopPropagation();
      if (FileEntry.canMoveInto(state.source, entry)) void move(state.source, entry);
      else setState({ status: "idle" });
    },
  });

  return { state, getDragProps, isDropTarget, isDragging };
}
