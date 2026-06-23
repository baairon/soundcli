// Resilient HTTP fetch, ported from spotDL's urllib3 Retry strategy
// (spotify-downloader/spotdl/utils/spotify.py). spotDL configures urllib3 with
// status_forcelist=(429, 500, 502, 503, 504, ...) plus a retry loop around
// Timeout / ConnectionError. We mirror that: retry on those statuses AND on
// network errors, honor Retry-After, and back off exponentially with jitter.
//
// Everything is injectable (fetchImpl, sleepImpl) so tests run with a fake
// fetch and a fake sleep and incur ZERO real delay.

/** HTTP statuses worth retrying. Mirrors urllib3's status_forcelist plus 408/425. */
export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * User-Agent for our own outbound requests. GitHub serves release assets to a
 * UA-less client with 403 on some IP ranges (mobile/CGNAT, datacenter, Termux),
 * so every GitHub fetch must send one. Mirrors the convention the Spotify calls
 * already follow.
 */
export const USER_AGENT = "soundcli (+https://www.npmjs.com/package/sndcli)";

/** Minimal fetch signature we depend on, so tests can inject a fake. */
export type FetchImpl = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Sleep signature, injectable so tests resolve instantly (no real timers). */
export type SleepImpl = (ms: number) => Promise<void>;

export interface FetchResilientOptions extends RequestInit {
  /** Max retry attempts after the first try. Default 5 (spotipy's default). */
  retries?: number;
  /** Base backoff in ms (delay = baseMs * 2^attempt). Default 500. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 20000. */
  capMs?: number;
  /** Injected fetch (defaults to the global fetch). */
  fetchImpl?: FetchImpl;
  /** Injected sleep (defaults to a real setTimeout-based wait). */
  sleepImpl?: SleepImpl;
}

/** Thrown when retries are exhausted on a retryable HTTP status. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

const DEFAULT_RETRIES = 5;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 20000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if the error looks like an abort (so we never retry it). */
function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /aborted/i.test(e.message))
  );
}

/**
 * Parse a Retry-After header into milliseconds. Supports both forms the spec
 * allows: delta-seconds (a number) or an HTTP-date. Returns undefined if absent
 * or unparseable.
 */
export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - nowMs);
  }
  return undefined;
}

/**
 * Exponential backoff with full jitter (delay randomized in [0, exp]). If the
 * server sent a larger Retry-After we honor that instead. Mirrors the intent of
 * urllib3's backoff with a jittered cap.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = Math.floor(rand() * exp);
  if (retryAfterMs !== undefined) {
    return Math.max(jittered, retryAfterMs);
  }
  return jittered;
}

/**
 * Fetch a URL, retrying on network errors and retryable HTTP statuses
 * (408, 425, 429, 500, 502, 503, 504) the way spotDL's urllib3 Retry does.
 *
 * - Honors Retry-After (delta-seconds or HTTP-date) on 429/503.
 * - Backs off exponentially with full jitter, capped at capMs.
 * - Stops immediately if the AbortSignal fires.
 * - Throws HttpError after retries are exhausted on a retryable status; returns
 *   the Response on success or on a non-retryable status (caller checks res.ok).
 *
 * @param url - The URL to fetch.
 * @param opts - Fetch init plus retry tuning and injectable fetch/sleep.
 * @returns The successful (or final non-retryable) Response.
 */
export async function fetchResilient(
  url: string,
  opts: FetchResilientOptions = {},
): Promise<Response> {
  const {
    retries = DEFAULT_RETRIES,
    baseMs = DEFAULT_BASE_MS,
    capMs = DEFAULT_CAP_MS,
    fetchImpl = fetch as FetchImpl,
    sleepImpl = realSleep,
    signal,
    ...init
  } = opts;

  const fetchInit: RequestInit = signal ? { ...init, signal } : init;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw new HttpError(0, "aborted");
    }

    let res: Response | undefined;
    try {
      res = await fetchImpl(url, fetchInit);
    } catch (e) {
      // Abort wins immediately, no retry.
      if (isAbortError(e) || signal?.aborted) throw e;
      lastError = e;
      // Network error (Timeout / ConnectionError equivalent): retry with backoff.
      if (attempt < retries) {
        await sleepImpl(backoffDelay(attempt, baseMs, capMs));
        continue;
      }
      throw e;
    }

    // Success or a status we don't retry: hand it back to the caller.
    if (!RETRY_STATUS.has(res.status)) {
      return res;
    }

    // Retryable status. If we're out of attempts, surface it as HttpError.
    if (attempt >= retries) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    await sleepImpl(backoffDelay(attempt, baseMs, capMs, retryAfterMs));
  }

  // Unreachable in practice (the loop always returns or throws), but keeps the
  // type-checker happy and gives a sane error if logic ever changes.
  throw lastError instanceof Error
    ? lastError
    : new HttpError(0, "fetchResilient exhausted without a response");
}
