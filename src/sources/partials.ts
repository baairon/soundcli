// A tiny process-level registry of playlists that came back cut short: cases
// where we know the source's true total but couldn't fetch every track. The
// add/gather flow clears it when a new batch begins; the queue view reads it to
// show one calm "got N of M" line. Kept out of the queue and store so the fix
// stays small and contained.

import type { SourceId } from "../library/types";

export interface PartialNotice {
  source: SourceId;
  title: string;
  got: number;
  total: number;
}

let notices: PartialNotice[] = [];

/** Record a list that arrived shorter than its true total. */
export function recordPartial(notice: PartialNotice): void {
  // De-dupe by source + title, so re-enumerating the same list (e.g. a cache
  // miss) never stacks duplicate notices.
  notices = notices.filter(
    (p) => !(p.source === notice.source && p.title === notice.title),
  );
  notices.push(notice);
}

/** Every cut-short list recorded since the last clear. */
export function getPartials(): PartialNotice[] {
  return notices;
}

/** Reset before a fresh add, so stale notices never linger across batches. */
export function clearPartials(): void {
  notices = [];
}
