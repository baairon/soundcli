import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useQueueItems } from "../store";
import { Header } from "../components/Header";
import { COLOR, ICON } from "../theme";
import { getActiveSchedules, type SourceSchedule } from "../../download/resume-schedule";

export function Progress() {
  const { queue, section, region } = useStore();
  const focused = section === "progress" && region === "content";
  const items = useQueueItems(queue);
  const [schedules, setSchedules] = useState<SourceSchedule[]>([]);
  const [now, setNow] = useState(Date.now());

  // Update current time every second for countdown display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Load active schedules on mount and refresh periodically
  useEffect(() => {
    const load = async () => {
      const active = await getActiveSchedules();
      setSchedules(active);
      // Check if any schedules expired and auto-resume
      await queue.checkScheduledResumes();
    };
    load();
    const interval = setInterval(load, 1000); // Refresh every second
    return () => clearInterval(interval);
  }, [queue]);

  // Calculate remaining downloads per source from queue items
  const remainingBySource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.status === "pending" || item.status === "paused") {
        const count = counts.get(item.sourceLabel) ?? 0;
        counts.set(item.sourceLabel, count + 1);
      }
    }
    return counts;
  }, [items]);

  // Calculate batch progress per source
  const batchProgressBySource = useMemo(() => {
    const progress = new Map<string, { current: number; limit: number }>();
    for (const item of items) {
      if (item.status === "downloading" || item.status === "done" || item.status === "pending" || item.status === "paused") {
        const current = queue.getBatchCount(item.source);
        progress.set(item.sourceLabel, { current, limit: 20 });
      }
    }
    return progress;
  }, [items, queue]);

  // Combine queue data with schedule data
  const sourceStatus = useMemo(() => {
    const status = new Map<string, { remaining: number; scheduled: boolean; resumeAt?: number; reason?: string; batchProgress?: { current: number; limit: number } }>();
    
    // Add data from schedules
    for (const schedule of schedules) {
      status.set(schedule.sourceLabel, {
        remaining: schedule.remaining,
        scheduled: true,
        resumeAt: schedule.resumeAt,
        reason: schedule.reason,
        batchProgress: batchProgressBySource.get(schedule.sourceLabel),
      });
    }
    
    // Add data from queue items (for sources not in schedule)
    for (const [label, count] of remainingBySource) {
      if (!status.has(label)) {
        status.set(label, {
          remaining: count,
          scheduled: false,
          batchProgress: batchProgressBySource.get(label),
        });
      }
    }
    
    return status;
  }, [schedules, remainingBySource, batchProgressBySource]);

  const sortedSources = Array.from(sourceStatus.entries()).sort((a, b) => {
    // Sort by scheduled time (soonest first), then by remaining count
    if (a[1].scheduled && b[1].scheduled) {
      return (a[1].resumeAt ?? 0) - (b[1].resumeAt ?? 0);
    }
    if (a[1].scheduled) return -1;
    if (b[1].scheduled) return 1;
    return b[1].remaining - a[1].remaining;
  });

  const totalRemaining = Array.from(sourceStatus.values()).reduce((sum, s) => sum + s.remaining, 0);

  // Handle resume now key
  useInput(
    (input) => {
      if (input === "r") {
        // Resume all scheduled sources immediately
        queue.resumeAll();
      }
    },
    { isActive: focused },
  );

  // Format time until resume with seconds for ticking animation
  const formatTimeUntil = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  return (
    <Box flexDirection="column">
      <Header
        title="In Progress"
        subtitle={`${totalRemaining} remaining`}
        focused={focused}
      />
      {sortedSources.length === 0 ? (
        <Text dimColor>No downloads in progress.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sortedSources.map(([label, status]) => {
            const timeUntil = status.resumeAt ? Math.max(0, status.resumeAt - now) : 0;
            const timeStr = timeUntil > 0 ? formatTimeUntil(timeUntil) : "Ready";
            const batch = status.batchProgress;
            const batchRemaining = batch ? Math.max(0, batch.limit - batch.current) : 0;
            const batchStr = batch ? `${batchRemaining} left in batch` : "";
            const approachingLimit = batch && batch.current >= batch.limit * 0.8; // 80% threshold
            
            return (
              <Box key={label} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={status.scheduled ? COLOR.warn : approachingLimit ? COLOR.warn : COLOR.good}>
                    {status.scheduled ? ICON.pending : approachingLimit ? ICON.warn : ICON.done}
                  </Text>
                  <Text> {label}</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor>
                    {status.remaining} remaining
                    {batchStr && ` · ${batchStr}`}
                    {status.scheduled ? ` · resumes in ${timeStr}` : ""}
                  </Text>
                </Box>
                {status.reason && (
                  <Box marginLeft={2}>
                    <Text dimColor color={COLOR.warn}>
                      ({status.reason})
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
