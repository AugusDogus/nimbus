/**
 * Run `task` now, then at most once per `intervalMs` while triggers keep arriving. A burst of
 * triggers inside one interval produces a single trailing run.
 */
export function coalesce(task: () => void, intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const tick = () => {
    if (!pending) {
      timer = null;
      return;
    }
    pending = false;
    task();
    timer = setTimeout(tick, intervalMs);
  };
  const trigger = () => {
    if (timer) {
      pending = true;
      return;
    }
    task();
    timer = setTimeout(tick, intervalMs);
  };
  trigger.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  return trigger;
}
