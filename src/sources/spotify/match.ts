// Pure YouTube match scoring, ported from spotDL's matching engine
// (spotify-downloader/spotdl/utils/matching.py and providers/audio/base.py).
//
// spotDL slugifies names, token-sorts them, then scores name similarity,
// artist similarity, and duration proximity (exp(-0.1 * |diff|)), penalizing
// titles that contain "forbidden" words (live, remix, slowed, ...) the target
// does not. We reimplement the same heuristics here with no new dependencies:
// a normalized Indel ratio (the rapidfuzz fuzz.ratio spotDL uses), the same
// FORBIDDEN_WORDS list, and the same time / name / artist combination.

/**
 * Words that mark a non-studio or altered version. Ported verbatim from
 * spotDL's FORBIDDEN_WORDS (matching.py), with multi-word variants kept as
 * readable phrases (we slug-compare, so spacing and punctuation do not
 * matter).
 */
export const FORBIDDEN_WORDS = [
  "live",
  "remix",
  "remaster",
  "remastered",
  "cover",
  "acoustic",
  "instrumental",
  "slowed",
  "reverb",
  "sped up",
  "nightcore",
  "8d",
  "bass boosted",
  "karaoke",
  "mashup",
  // extra spotDL entries kept for parity:
  "concert",
  "acapella",
];

/** A YouTube candidate we score against the target track. */
export interface MatchCandidate {
  title: string;
  uploader?: string;
  durationSec?: number;
}

/** The Spotify track we are trying to match on YouTube. */
export interface MatchTarget {
  title: string;
  artist?: string;
  durationSec?: number;
}

/**
 * Slugify a string the way spotDL does for matching: lowercase, drop accents,
 * and reduce to [a-z0-9] groups joined by single hyphens. (We skip spotDL's
 * Japanese romaji path; ASCII folding covers the common cases without a dep.)
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks (accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalized Indel similarity in 0..100, matching rapidfuzz's fuzz.ratio
 * (the `ratio` spotDL imports). Indel distance is Levenshtein without
 * substitution (insertions + deletions only); the score is
 * 100 * (1 - dist / (len(a) + len(b))).
 */
function indelRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100;
  const total = a.length + b.length;
  // LCS via rolling DP. Indel distance = total - 2 * lcs.
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[n] ?? 0;
  const dist = total - 2 * lcs;
  return (1 - dist / total) * 100;
}

/** Sort the hyphen tokens of a slug, so word order does not hurt the score. */
function sortTokens(slug: string): string {
  return slug.split("-").filter(Boolean).sort().join("-");
}

/**
 * Compact token-sort ratio in 0..100. Mirrors spotDL's approach of slugifying,
 * sorting tokens (based_sort), then calling ratio. We take the better of the
 * raw-slug ratio and the token-sorted ratio so reordered words still match.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns Similarity from 0 (nothing alike) to 100 (identical).
 */
export function ratio(a: string, b: string): number {
  const sa = slugify(a);
  const sb = slugify(b);
  if (!sa && !sb) return 100;
  const direct = indelRatio(sa, sb);
  const sorted = indelRatio(sortTokens(sa), sortTokens(sb));
  return Math.max(direct, sorted);
}

/**
 * Forbidden words present in `candidateTitle` but NOT in `targetTitle`. A remix
 * of a song actually titled "... Remix" should not be penalized, exactly like
 * spotDL's check_forbidden_words (it skips words already in the song name).
 */
export function forbiddenWordsIn(
  candidateTitle: string,
  targetTitle: string,
): string[] {
  const cand = slugify(candidateTitle).replace(/-/g, "");
  const target = slugify(targetTitle).replace(/-/g, "");
  const hits: string[] = [];
  for (const word of FORBIDDEN_WORDS) {
    const w = slugify(word).replace(/-/g, "");
    if (w && cand.includes(w) && !target.includes(w)) hits.push(word);
  }
  return hits;
}

/**
 * Duration proximity in 0..100, ported from spotDL's calc_time_match:
 * exp(-0.1 * |diff_seconds|) * 100. ~7s off is ~50, ~15s off is ~22, and it
 * falls off steeply beyond that.
 */
export function timeMatch(targetSec?: number, candSec?: number): number {
  if (targetSec === undefined || candSec === undefined) return 0;
  const diff = Math.abs(targetSec - candSec);
  return Math.exp(-0.1 * diff) * 100;
}

const NAME_FLOOR = 60; // spotDL skips results with name match <= 60
const TIME_FLOOR = 25; // spotDL skips results with time match < 25
const FORBIDDEN_PENALTY = 45; // increased to 45 to ensure a hard reject (< 60)

/**
 * Score a single candidate against the target in 0..100, combining the same
 * signals spotDL's order_results does:
 *   - name match (token-sorted title vs "artist title"),
 *   - artist match (folded into the name when the target has an artist),
 *   - a forbidden-word penalty (-15 each) for altered versions,
 *   - duration proximity (averaged in, like calc_time_match), with the same
 *     hard skips (name <= 60, time < 25, or time < 50 with a weak average).
 *
 * Returns 0 for any candidate spotDL would discard, so pickBest's floor drops
 * remixes / live cuts / hour-loops that drift far from the target length.
 *
 * @param target - The Spotify track (title, optional artist, optional duration).
 * @param cand - The YouTube candidate.
 * @returns A 0..100 score (0 means "reject").
 */
export function scoreCandidate(target: MatchTarget, cand: MatchCandidate): number {
  // Name match: compare the candidate title both to the bare target title and
  // to "artist - title" (YouTube titles usually include the artist), keeping
  // the better. This folds the artist into the name like spotDL's match strings.
  const bareName = ratio(cand.title, target.title);
  const withArtist = target.artist
    ? ratio(cand.title, `${target.artist} ${target.title}`)
    : 0;
  let nameMatch = Math.max(bareName, withArtist);

  // Forbidden words the target does not have: steep penalty per hit.
  const forbidden = forbiddenWordsIn(cand.title, target.title);
  nameMatch -= forbidden.length * FORBIDDEN_PENALTY;

  // Hard floor on name (mirrors order_results' "name_match <= 60 -> skip").
  if (nameMatch <= NAME_FLOOR) return 0;

  // Artist match: prefer the uploader/channel, fall back to the title. spotDL
  // checks the result's artists then the result name; we do the same compactly.
  let artistMatch = 100;
  if (target.artist) {
    const byUploader = cand.uploader
      ? ratio(cand.uploader, target.artist)
      : 0;
    const byTitle = ratio(cand.title, target.artist);
    artistMatch = Math.max(byUploader, byTitle);
  }

  const time = timeMatch(target.durationSec, cand.durationSec);
  const haveDuration =
    target.durationSec !== undefined && cand.durationSec !== undefined;

  // Average name + artist, exactly like spotDL's (artists_match + name_match)/2.
  let average = target.artist ? (nameMatch + artistMatch) / 2 : nameMatch;

  if (haveDuration) {
    // Skip clearly wrong lengths (remix edits, sped-up cuts, hour loops).
    if (time < TIME_FLOOR) return 0;
    if (time < 50 && average < 75) return 0;
    // Fold duration into the score when the name isn't already near-perfect,
    // mirroring order_results' "average_match <= 85 -> include time".
    if (average <= 85) {
      average = (average + time) / 2;
    }
  }

  return Math.min(100, Math.max(0, average));
}

interface ScoredCandidate<T extends MatchCandidate> {
  candidate: T;
  score: number;
}

const PICK_FLOOR = 55; // sane overall floor; below this we return no match.

/**
 * Pick the best candidate for the target, or null if none clears the floor.
 * Mirrors spotDL's get_best_result: score all, take the highest. We add a
 * conservative floor so "no acceptable match" yields null (the caller then
 * falls back to the blind ytsearch1 URL).
 *
 * @param target - The Spotify track to match.
 * @param candidates - YouTube candidates to choose among.
 * @returns The best candidate, or null when nothing scores well enough.
 */
export function pickBest<T extends MatchCandidate>(
  target: MatchTarget,
  candidates: T[],
): T | null {
  let best: ScoredCandidate<T> | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(target, candidate);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { candidate, score };
  }
  if (!best || best.score < PICK_FLOOR) return null;
  return best.candidate;
}
