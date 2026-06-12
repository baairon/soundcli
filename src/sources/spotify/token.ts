// Anonymous Spotify web-player access token (TOTP + /api/token), mirroring
// the approach used by spotify_monitor and librespot reverse-engineering notes.
// Secrets are fetched from a maintained community dict and cached in-memory.

import { createHmac, randomBytes } from "node:crypto";
import { fetchResilient } from "../../util/net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TOKEN_URL = "https://open.spotify.com/api/token";
const SECRETS_URL =
  "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json";

const SECRETS_TTL_MS = 60 * 60 * 1000;
const TOKEN_SKEW_MS = 30_000;

export interface WebPlayerToken {
  accessToken: string;
  clientId: string;
  expiresAtMs: number;
}

let secretsCache: { at: number; dict: Record<string, number[]> } | undefined;
let tokenCache: WebPlayerToken | undefined;

function totpCode(secretB32: string, unixSeconds: number): string {
  const padded = secretB32.padEnd(Math.ceil(secretB32.length / 8) * 8, "=");
  const key = Buffer.from(padded, "base64");
  const counter = Math.floor(unixSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

function secretFromCipher(bytes: number[]): string {
  const transformed = bytes.map((e, t) => e ^ ((t % 33) + 9));
  const joined = transformed.map((n) => String(n)).join("");
  const hex = Buffer.from(joined, "utf8").toString("hex");
  return Buffer.from(hex, "hex").toString("base64").replace(/=+$/g, "");
}

async function loadSecrets(): Promise<{
  version: string;
  cipher: number[];
}> {
  const hit = secretsCache;
  if (hit && Date.now() - hit.at < SECRETS_TTL_MS) {
    const version = String(Math.max(...Object.keys(hit.dict).map(Number)));
    return { version, cipher: hit.dict[version]! };
  }
  const res = await fetchResilient(SECRETS_URL, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Couldn't load Spotify TOTP secrets (${res.status}).`);
  }
  const dict = (await res.json()) as Record<string, number[]>;
  secretsCache = { at: Date.now(), dict };
  const version = String(Math.max(...Object.keys(dict).map(Number)));
  return { version, cipher: dict[version]! };
}

async function serverTimeSeconds(): Promise<number> {
  const res = await fetchResilient("https://open.spotify.com/", {
    method: "HEAD",
    headers: { "User-Agent": UA, Accept: "*/*" },
  });
  const date = res.headers.get("date");
  if (!date) throw new Error("Spotify server time unavailable.");
  return Math.floor(new Date(date).getTime() / 1000);
}

/** Clear cached token/secrets (tests). */
export function clearSpotifyTokenCache(): void {
  secretsCache = undefined;
  tokenCache = undefined;
}

/** Fetch (or reuse) an anonymous web-player bearer token. */
export async function getWebPlayerToken(): Promise<WebPlayerToken> {
  const hit = tokenCache;
  if (hit && hit.expiresAtMs - Date.now() > TOKEN_SKEW_MS) {
    return hit;
  }

  const { version, cipher } = await loadSecrets();
  const serverTime = await serverTimeSeconds();
  const otp = totpCode(secretFromCipher(cipher), serverTime);
  const params = new URLSearchParams({
    reason: "init",
    productType: "web-player",
    totp: otp,
    totpServer: otp,
    totpVer: version,
  });

  if (Number(version) < 10) {
    params.set("sTime", String(serverTime));
    params.set("cTime", String(Date.now()));
    const day = new Date(serverTime * 1000).toISOString().slice(0, 10);
    params.set("buildDate", day);
    params.set(
      "buildVer",
      `web-player_${day}_${serverTime * 1000}_${randomBytes(2).toString("hex")}`,
    );
  }

  const res = await fetchResilient(`${TOKEN_URL}?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://open.spotify.com/",
      "App-Platform": "WebPlayer",
    },
  });
  if (!res.ok) {
    tokenCache = undefined;
    throw new Error(`Spotify token request failed (${res.status}).`);
  }
  const data = (await res.json()) as {
    accessToken?: string;
    clientId?: string;
    accessTokenExpirationTimestampMs?: number;
  };
  if (!data.accessToken || !data.clientId) {
    throw new Error("Spotify token response was incomplete.");
  }
  tokenCache = {
    accessToken: data.accessToken,
    clientId: data.clientId,
    expiresAtMs: data.accessTokenExpirationTimestampMs ?? Date.now() + 3_600_000,
  };
  return tokenCache;
}
