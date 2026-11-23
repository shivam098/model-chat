// How long a model request may run. There is no fixed deadline: a request is ended only when the Copilot runtime
// has emitted no event at all (text, reasoning, tool calls, retries or progress) for REPLY_SILENCE_MS. Model Chat's own
// keep-alive heartbeats to the browser don't count. Stop always works, at any time.
// Measured at Max thinking on a hard proof (2026-11-24): Claude Opus 5.5 streamed reasoning with no gap over 5.3 s, but
// GPT-6 Sol sent nothing at all while it thought; each of its model calls stayed silent for about 631 s before the
// service ended the call and the runtime retried (which is an event). 30 minutes is about three times that silence.
export const REPLY_SILENCE_MS = 30 * 60_000;
/** The SDK's wait needs a number; this is setTimeout's maximum (about 24.8 days), because larger values fire at once. */
export const SDK_WAIT_MS = 2_147_483_647;

export interface SilenceWatchdog {
  /** Real runtime activity: restarts the silence clock. */
  touch: () => void;
  /** Pauses the clock while waiting on the owner (for example an approval); call the returned function to resume. */
  hold: () => () => void;
  stop: () => void;
}

export function silenceWatchdog(silenceMs: number, onSilent: () => void): SilenceWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holds = 0;
  let stopped = false;
  const arm = () => {
    clearTimeout(timer);
    if (stopped || holds > 0) return;
    timer = setTimeout(() => { stopped = true; onSilent(); }, silenceMs);
  };
  arm();
  return {
    touch: arm,
    hold: () => {
      holds++;
      clearTimeout(timer);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        arm();
      };
    },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}

export function silenceMinutes(silenceMs: number) {
  const minutes = Math.round(silenceMs / 60_000);
  return minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.max(1, Math.round(silenceMs / 1000))} seconds`;
}
