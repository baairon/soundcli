// Decode a Spotify base62 track id into its "gid": the 16-byte identifier as a
// 32-char lowercase hex string, which is what spclient's metadata/4 endpoint
// takes (metadata/4/track/{gid}). The alphabet ordering (digits, then
// lowercase, then uppercase) is pinned by a live-verified vector, see the test:
// "190jyVPHYjAqEaOGmMzdyk" -> "25a10c749bd64f24b9d58ebded472f2c".

const BASE62 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Convert a base62 Spotify id (e.g. a 22-char track id) to its 32-char hex gid.
 *
 * @param id - The base62 id from a `spotify:track:<id>` uri.
 * @returns The 16-byte gid as lowercase hex, zero-padded to 32 chars.
 * @throws If the id contains a non-base62 character or overflows 16 bytes.
 */
export function gidFromId(id: string): string {
  let n = 0n;
  for (const ch of id) {
    const v = BASE62.indexOf(ch);
    if (v < 0) throw new Error(`invalid base62 char "${ch}" in id`);
    n = n * 62n + BigInt(v);
  }
  const hex = n.toString(16);
  if (hex.length > 32) throw new Error(`id "${id}" overflows a 16-byte gid`);
  return hex.padStart(32, "0");
}
