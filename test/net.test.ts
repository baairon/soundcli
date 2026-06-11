import { describe, it, expect } from "vitest";
import {
  fetchResilient,
  HttpError,
  RETRY_STATUS,
  parseRetryAfter,
  backoffDelay,
  type FetchImpl,
  type SleepImpl,
} from "../src/util/net";

// A fake Response good enough for fetchResilient (status, ok, headers, text).
function fakeResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

/** A fetch that returns each queued result/throw in turn, recording call count. */
function scriptedFetch(steps: Array<Response | Error>): {
  impl: FetchImpl;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  const impl: FetchImpl = async () => {
    calls++;
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step as Response;
  };
  return { impl, calls: () => calls };
}

/** A sleep that records every delay and resolves instantly (no real timers). */
function recordingSleep(): { impl: SleepImpl; delays: number[] } {
  const delays: number[] = [];
  const impl: SleepImpl = async (ms) => {
    delays.push(ms);
  };
  return { impl, delays };
}

describe("RETRY_STATUS", () => {
  it("matches spotDL's status_forcelist plus 408/425", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(RETRY_STATUS.has(s)).toBe(true);
    }
    expect(RETRY_STATUS.has(200)).toBe(false);
    expect(RETRY_STATUS.has(404)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = new Date(now + 5000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(5000);
  });
  it("returns undefined for missing or junk values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    const rand = () => 1; // full exp (no shrink) so we can assert the ceiling
    expect(backoffDelay(0, 500, 20000, undefined, rand)).toBeLessThanOrEqual(500);
    expect(backoffDelay(1, 500, 20000, undefined, rand)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(2, 500, 20000, undefined, rand)).toBeLessThanOrEqual(2000);
    // Capped: 500 * 2^20 would be huge, but capMs holds it at 20000.
    expect(backoffDelay(20, 500, 20000, undefined, rand)).toBe(20000);
  });
  it("honors Retry-After when it exceeds the jittered backoff", () => {
    const rand = () => 0; // jitter -> 0, so Retry-After dominates
    expect(backoffDelay(0, 500, 20000, 9000, rand)).toBe(9000);
  });
  it("uses jittered backoff when it exceeds Retry-After", () => {
    const rand = () => 1;
    expect(backoffDelay(3, 500, 20000, 100, rand)).toBe(4000);
  });
});

describe("fetchResilient success path", () => {
  it("returns the response on first success with no sleeps", async () => {
    const f = scriptedFetch([fakeResponse(200, {}, "ok")]);
    const s = recordingSleep();
    const res = await fetchResilient("https://x", {
      fetchImpl: f.impl,
      sleepImpl: s.impl,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(f.calls()).toBe(1);
    expect(s.delays.length).toBe(0);
  });

  it("does not retry a non-retryable status (returns it for the caller to check)", async () => {
    const f = scriptedFetch([fakeResponse(404)]);
    const s = recordingSleep();
    const res = await fetchResilient("https://x", {
      fetchImpl: f.impl,
      sleepImpl: s.impl,
    });
    expect(res.status).toBe(404);
    expect(f.calls()).toBe(1);
    expect(s.delays.length).toBe(0);
  });
});

describe("fetchResilient retry on forcelist", () => {
  it("retries 503 then succeeds", async () => {
    const f = scriptedFetch([fakeResponse(503), fakeResponse(200, {}, "done")]);
    const s = recordingSleep();
    const res = await fetchResilient("https://x", {
      fetchImpl: f.impl,
      sleepImpl: s.impl,
    });
    expect(res.status).toBe(200);
    expect(f.calls()).toBe(2);
    expect(s.delays.length).toBe(1); // one backoff between the two tries
  });

  it("retries each forcelist status (429,500,502,503,504,408,425)", async () => {
    for (const status of [429, 500, 502, 503, 504, 408, 425]) {
      const f = scriptedFetch([fakeResponse(status), fakeResponse(200)]);
      const s = recordingSleep();
      const res = await fetchResilient("https://x", {
        fetchImpl: f.impl,
        sleepImpl: s.impl,
      });
      expect(res.status).toBe(200);
      expect(f.calls()).toBe(2);
    }
  });

  it("throws HttpError after retries are exhausted", async () => {
    const f = scriptedFetch([fakeResponse(429)]); // always 429
    const s = recordingSleep();
    await expect(
      fetchResilient("https://x", {
        retries: 3,
        fetchImpl: f.impl,
        sleepImpl: s.impl,
      }),
    ).rejects.toMatchObject({ status: 429 });
    // 1 initial + 3 retries = 4 calls, 3 sleeps.
    expect(f.calls()).toBe(4);
    expect(s.delays.length).toBe(3);
  });

  it("surfaces the failure as an HttpError instance", async () => {
    const f = scriptedFetch([fakeResponse(500)]);
    const s = recordingSleep();
    const err = await fetchResilient("https://x", {
      retries: 1,
      fetchImpl: f.impl,
      sleepImpl: s.impl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
  });
});

describe("fetchResilient retry on network errors", () => {
  it("retries a thrown network error then succeeds", async () => {
    const f = scriptedFetch([
      new Error("ECONNRESET"),
      fakeResponse(200, {}, "recovered"),
    ]);
    const s = recordingSleep();
    const res = await fetchResilient("https://x", {
      fetchImpl: f.impl,
      sleepImpl: s.impl,
    });
    expect(await res.text()).toBe("recovered");
    expect(f.calls()).toBe(2);
    expect(s.delays.length).toBe(1);
  });

  it("rethrows the network error after retries are exhausted", async () => {
    const f = scriptedFetch([new Error("ETIMEDOUT")]);
    const s = recordingSleep();
    await expect(
      fetchResilient("https://x", {
        retries: 2,
        fetchImpl: f.impl,
        sleepImpl: s.impl,
      }),
    ).rejects.toThrow("ETIMEDOUT");
    expect(f.calls()).toBe(3); // 1 + 2 retries
  });
});

describe("fetchResilient Retry-After handling", () => {
  it("honors Retry-After delta-seconds on a 429 backoff", async () => {
    const f = scriptedFetch([
      fakeResponse(429, { "retry-after": "7" }),
      fakeResponse(200),
    ]);
    const s = recordingSleep();
    await fetchResilient("https://x", {
      fetchImpl: f.impl,
      sleepImpl: s.impl,
      baseMs: 1,
      capMs: 10,
    });
    // The 7s Retry-After dominates the tiny jittered backoff.
    expect(s.delays[0]).toBe(7000);
  });
});

describe("fetchResilient abort", () => {
  it("short-circuits before any fetch when already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = scriptedFetch([fakeResponse(200)]);
    const s = recordingSleep();
    await expect(
      fetchResilient("https://x", {
        signal: ctrl.signal,
        fetchImpl: f.impl,
        sleepImpl: s.impl,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(f.calls()).toBe(0);
  });

  it("stops retrying once the signal aborts mid-flight", async () => {
    const ctrl = new AbortController();
    // First call returns a retryable status; the sleep then aborts so the
    // second attempt's pre-check bails out.
    const f = scriptedFetch([fakeResponse(503), fakeResponse(200)]);
    const abortingSleep: SleepImpl = async () => {
      ctrl.abort();
    };
    await expect(
      fetchResilient("https://x", {
        signal: ctrl.signal,
        fetchImpl: f.impl,
        sleepImpl: abortingSleep,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    // Only the first fetch ran; the abort stopped the retry.
    expect(f.calls()).toBe(1);
  });

  it("does not retry an AbortError thrown by fetch", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const f = scriptedFetch([abortErr, fakeResponse(200)]);
    const s = recordingSleep();
    await expect(
      fetchResilient("https://x", { fetchImpl: f.impl, sleepImpl: s.impl }),
    ).rejects.toThrow(/aborted/i);
    expect(f.calls()).toBe(1);
  });
});
