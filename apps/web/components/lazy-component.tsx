import { createElement, lazy, Suspense, type ComponentType } from "react";

/**
 * A component whose code loads on first render, showing nothing until it arrives. For dialogs
 * and other UI that most visits never open.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
) {
  const Lazy = lazy(load);
  return function LazyComponent(props: P) {
    return <Suspense fallback={null}>{createElement(Lazy, props)}</Suspense>;
  };
}
