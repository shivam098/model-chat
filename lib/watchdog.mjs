// Decides what the auto-restart watchdog repairs, from what it observed. Kept pure so it can be tested.
// A tunnel whose cloudflared process is alive but whose link stops answering is replaced only after it fails on
// this many consecutive checks while this PC's internet works; a short blip or an offline PC never changes the link.
export const PUBLIC_FAILURES_BEFORE_REPLACING = 2;

export function repairPlan(observed) {
  const { wanted, foreign, tunnelAlive, appAlive, appMatchesTunnel, localOk, publicOk, internetOk, previousPublicFailures = 0 } = observed;
  if (!wanted) return { skip: "stopped" };
  if (foreign) return { skip: "foreign" };
  let publicFailures = 0;
  let replaceTunnel = false;
  if (tunnelAlive && appAlive && appMatchesTunnel && localOk && !publicOk) {
    if (!internetOk) publicFailures = previousPublicFailures;
    else {
      publicFailures = previousPublicFailures + 1;
      replaceTunnel = publicFailures >= PUBLIC_FAILURES_BEFORE_REPLACING;
    }
  }
  if (replaceTunnel) publicFailures = 0;
  const startTunnel = !tunnelAlive || replaceTunnel;
  const restartApp = startTunnel || !appAlive || !appMatchesTunnel || !localOk;
  return { skip: !startTunnel && !restartApp && publicFailures > 0 ? "waiting" : null, replaceTunnel, startTunnel, restartApp, publicFailures };
}
