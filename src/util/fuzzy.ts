/**
 * Dependency-free fzf-style fuzzy matching for the search boxes. Substring
 * hits rank highest (earlier and word-aligned is better); otherwise the query
 * must appear in order as a subsequence ("lvr" finds "Lovebird"), scored with
 * bonuses for consecutive runs and word starts and penalties for gaps.
 */

const ASCII_ONLY = /^[\x00-\x7f]*$/;
// The same few thousand titles re-fold on every keystroke; cache them.
const foldCache = new Map<string, string>();

/** Lowercase and fold diacritics so "renee" finds "Renée". */
function fold(s: string): string {
  if (ASCII_ONLY.test(s)) return s.toLowerCase();
  const hit = foldCache.get(s);
  if (hit !== undefined) return hit;
  const folded = s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  if (foldCache.size >= 8000) foldCache.clear();
  foldCache.set(s, folded);
  return folded;
}

const WORD_BREAK = /[\s\-_.,/()[\]'"&+]/;

function isWordStart(text: string, i: number): boolean {
  return i === 0 || WORD_BREAK.test(text[i - 1]!);
}

/**
 * Match score, higher is better; null when the query doesn't match at all.
 * Empty queries match everything with a neutral score of 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  return scoreFolded(fold(query.trim()), text);
}

/** Scoring core; `q` is already trimmed + folded so filters fold it once. */
function scoreFolded(q: string, text: string): number | null {
  if (!q) return 0;
  const t = fold(text);
  if (!t) return null;

  // Tier 1: substring. Word-aligned beats mid-word; earlier beats later.
  const at = t.indexOf(q);
  if (at >= 0) {
    return 1000 + (isWordStart(t, at) ? 100 : 0) - Math.min(at, 99);
  }

  // Tier 2: greedy in-order subsequence.
  let score = 0;
  let ti = 0;
  let prev = -2;
  let first = -1;
  let wordStarts = 0;
  let n = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (found === prev + 1) score += 10; // consecutive run
    else score -= Math.min(found - ti, 10); // gap penalty
    if (isWordStart(t, found)) {
      score += 15; // initials ("lvr", "bts")
      wordStarts++;
    }
    prev = found;
    ti = found + 1;
    n++;
  }
  // A subsequence only counts when it's tight (near-typo, "lvr" in "Lovebird")
  // or reads as initials; letters scattered across a long title are noise,
  // not a match ("xxnippet" must not hit every title with those letters).
  const span = prev - first + 1;
  if (span > n * 2 + 2 && wordStarts < n) return null;
  return score;
}

/**
 * Filter + rank `items` by their best-scoring key. Non-matches drop out;
 * matches sort by score descending, ties keeping the incoming order (which is
 * newest-first everywhere we search). An empty query returns items untouched.
 */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  keys: (item: T) => Array<string | undefined>,
): T[] {
  const q = fold(query.trim());
  if (!q) return items;
  const scored: Array<{ item: T; score: number; i: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let best: number | null = null;
    for (const key of keys(item)) {
      if (!key) continue;
      const s = scoreFolded(q, key);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) scored.push({ item, score: best, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
