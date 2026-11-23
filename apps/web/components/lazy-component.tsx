import {
  createElement,
  Suspense,
  use,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { CodeLoadFailed } from "@/components/code-load-notice";
import { CodeLoad } from "@/lib/code-load";

type Loading<P> =
  | { kind: "idle" }
  | { kind: "loading"; done: Promise<void> }
  | { kind: "loaded"; Component: ComponentType<P> }
  | { kind: "failed" };

/**
 * A component whose code loads on first render, showing `fallback` until it arrives. For
 * dialogs, previews and other UI that most visits never open.
 *
 * Loads through `CodeLoad.load`. A load that fails, also after its retries, shows the code load
 * notice, which offers Reload, and renders nothing, so the page stays as it is. It starts over
 * when the component mounts again, such as when its dialog opens again; never on its own, so a
 * file that stays missing is not asked for again and again. Content shown in place, which has a
 * `fallback`, shows `CodeLoadFailed` there instead, since a dialog around it can cover the notice.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = null,
) {
  let state: Loading<P> = { kind: "idle" };
  const start = () => {
    const done = CodeLoad.load(load).then(
      (module) => {
        state = { kind: "loaded", Component: module.default };
      },
      (error: unknown) => {
        state = { kind: "failed" };
        CodeLoad.failed(error);
      },
    );
    state = { kind: "loading", done };
  };
  const again = () => {
    if (state.kind !== "failed") return false;
    state = { kind: "idle" };
    return true;
  };

  // Suspends on the load this boundary shares across renders: a render that suspends keeps no
  // state of its own, so it must never start a load of its own.
  function Loaded(props: P) {
    if (state.kind === "idle") start();
    if (state.kind === "loading") use(state.done);
    if (state.kind === "loaded") return createElement(state.Component, props);
    return fallback === null ? null : <CodeLoadFailed />;
  }

  return function LazyComponent(props: P) {
    useState(again);
    return (
      <Suspense fallback={fallback}>{createElement(Loaded, props)}</Suspense>
    );
  };
}
