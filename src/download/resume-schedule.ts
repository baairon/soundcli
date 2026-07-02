import { promises as fs } from "node:fs";
import { resumeScheduleFile } from "../config/paths";
import type { SourceId } from "../library/types";

export interface SourceSchedule {
  source: SourceId;
  sourceLabel: string;
  /** Timestamp (ms) when downloads for this source can resume. */
  resumeAt: number;
  /** Number of downloads remaining for this source. */
  remaining: number;
  /** Reason for the rate limit (for display). */
  reason: string;
}

interface ResumeSchedule {
  version: 1;
  schedules: SourceSchedule[];
}

/** Default delay before resuming after rate limit (in milliseconds). */
const DEFAULT_RESUME_DELAY = 15 * 60 * 1000; // 15 minutes

/** Get the delay for a specific source (configurable per source if needed). */
function getResumeDelay(source: SourceId): number {
  // Different sources may have different rate limit behaviors
  switch (source) {
    case "youtube":
      return 30 * 60 * 1000; // 30 minutes for YouTube
    case "soundcloud":
      return 15 * 60 * 1000; // 15 minutes for SoundCloud
    case "spotify":
      return 20 * 60 * 1000; // 20 minutes for Spotify
    default:
      return DEFAULT_RESUME_DELAY;
  }
}

export async function loadResumeSchedule(): Promise<SourceSchedule[]> {
  try {
    const raw = await fs.readFile(resumeScheduleFile, "utf8");
    const parsed = JSON.parse(raw) as ResumeSchedule;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.schedules)) {
      // Filter out expired schedules
      const now = Date.now();
      return parsed.schedules.filter((s) => s.resumeAt > now);
    }
  } catch {
    // missing or invalid: nothing to restore
  }
  return [];
}

export async function saveResumeSchedule(
  schedules: SourceSchedule[],
): Promise<void> {
  const snapshot: ResumeSchedule = { version: 1, schedules };
  await fs.mkdir(
    resumeScheduleFile.substring(0, resumeScheduleFile.lastIndexOf("/")),
    { recursive: true },
  );
  const tmp = `${resumeScheduleFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.rename(tmp, resumeScheduleFile);
}

/**
 * Add or update a schedule for a source that was rate-limited.
 * Returns the timestamp when it should resume.
 */
export async function scheduleResume(
  source: SourceId,
  sourceLabel: string,
  remaining: number,
  reason: string,
): Promise<number> {
  const schedules = await loadResumeSchedule();
  const resumeAt = Date.now() + getResumeDelay(source);
  
  // Remove existing schedule for this source if any
  const filtered = schedules.filter((s) => s.source !== source);
  
  filtered.push({
    source,
    sourceLabel,
    resumeAt,
    remaining,
    reason,
  });
  
  await saveResumeSchedule(filtered);
  return resumeAt;
}

/**
 * Remove a schedule for a source (e.g., when downloads complete or user manually resumes).
 */
export async function clearSchedule(source: SourceId): Promise<void> {
  const schedules = await loadResumeSchedule();
  const filtered = schedules.filter((s) => s.source !== source);
  await saveResumeSchedule(filtered);
}

/**
 * Check if a source is currently scheduled for a delay (rate-limited).
 */
export async function isSourceScheduled(source: SourceId): Promise<boolean> {
  const schedules = await loadResumeSchedule();
  const schedule = schedules.find((s) => s.source === source);
  if (!schedule) return false;
  
  const now = Date.now();
  if (schedule.resumeAt <= now) {
    // Expired, clear it
    await clearSchedule(source);
    return false;
  }
  return true;
}

/**
 * Get all active schedules (for UI display).
 */
export async function getActiveSchedules(): Promise<SourceSchedule[]> {
  const schedules = await loadResumeSchedule();
  const now = Date.now();
  
  // Filter and clean up expired schedules
  const active = schedules.filter((s) => s.resumeAt > now);
  if (active.length !== schedules.length) {
    await saveResumeSchedule(active);
  }
  
  return active;
}
