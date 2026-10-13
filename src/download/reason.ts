/**
 * A calm, human reason for a failed download. Raw tool output (exit codes,
 * stderr dumps) never reaches the screen: we bucket the few causes a user can
 * actually do something about and fall back to a generic phrase. "f Retry"
 * covers the ones a retry can still fix.
 *
 * Lives outside the dashboard so a run with no dashboard names failures in
 * the same words.
 */
export function shortError(e?: string): string {
  if (!e) return "couldn't save";
  const m = e.toLowerCase();
  if (m.includes("missing on disk")) return "file didn't save";
  if (m.includes("drm")) return "DRM protected";
  // The host's words, not the track's: these clear up on their own, so they
  // read like any other blip instead of a dead track.
  if (/service unavailable|temporarily unavailable/.test(m))
    return "network hiccup";
  // Ahead of the generic case: YouTube's region message also says
  // "unavailable", and naming the lock beats calling the track gone.
  if (m.includes("your country") || /geo.?restrict/.test(m))
    return "region-locked";
  if (
    m.includes("unavailable") ||
    m.includes("private") ||
    m.includes("removed") ||
    m.includes("not exist") ||
    m.includes("404")
  )
    return "track unavailable";
  // Checked before the generic sign-in case: this one is skipped rather than
  // retried, so saying which kind of sign-in it wanted is worth the words.
  if (/confirm your age|age.?restrict/.test(m)) return "age-restricted";
  // No bare "age" here: it matched "webpage", so a refused page read as a
  // sign-in wall.
  if (m.includes("sign in") || m.includes("login")) return "needs sign-in";
  // Not "retry later": for label uploads the source refuses every attempt, so
  // promising a later success is the misleading half of the old message.
  if (m.includes("403") || m.includes("forbidden")) return "blocked by source";
  if (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("connection") ||
    m.includes("getaddrinfo")
  )
    return "network hiccup";
  return "couldn't save";
}
