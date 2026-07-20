/**
 * Self-scheduling poll loop that is resilient to flaky networks.
 *
 * Unlike `setInterval`, it waits for each run to finish before scheduling the next,
 * so slow/hanging requests can never pile up dozens of in-flight fetches (which was
 * exhausting memory and hammering the backend during outages). On failure it backs
 * off exponentially, and it pauses entirely while the tab is hidden or offline.
 *
 * `fn` should THROW (or reject) on failure so backoff can engage; return normally on
 * success. Returns a stop function that cancels the loop.
 */
export function startPolling(
  fn: () => Promise<void>,
  baseMs: number,
  opts: { maxMs?: number } = {},
): () => void {
  const maxMs = opts.maxMs ?? Math.max(baseMs * 8, 15000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fails = 0;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
  };

  const run = async () => {
    if (stopped) return;
    // Don't poll while unseen or offline: no point streaming when hidden, and it avoids
    // stacking up requests that will only fail while the network is down.
    const hidden = typeof document !== "undefined" && document.hidden;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (hidden || offline) {
      schedule(baseMs);
      return;
    }
    try {
      await fn();
      fails = 0;
      schedule(baseMs);
    } catch {
      fails = Math.min(fails + 1, 8);
      schedule(Math.min(baseMs * 2 ** fails, maxMs));
    }
  };

  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
