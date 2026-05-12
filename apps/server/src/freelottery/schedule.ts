export interface ScheduleConfig {
  /** YYYY-MM-DD; the draw date of day 1. Undefined → feature disabled. */
  startUtcDate: string | undefined;
  /** Length of campaign in days. */
  totalDays: number;
  /** UTC hour at which entry closes and the draw runs (0–23). */
  drawHourUtc: number;
}

function parseDateUtc(yyyyMmDd: string): Date {
  // Treat as UTC midnight; we only care about the date, not the time.
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function drawMomentFor(dateYmd: string, cfg: ScheduleConfig): Date {
  return new Date(`${dateYmd}T${String(cfg.drawHourUtc).padStart(2, '0')}:00:00Z`);
}

function endMoment(cfg: ScheduleConfig): Date | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const last = new Date(start);
  last.setUTCDate(last.getUTCDate() + cfg.totalDays - 1);
  return drawMomentFor(formatDateUtc(last), cfg);
}

/**
 * The `day_utc` for the entry window containing `now` — i.e. the date whose
 * draw at `drawHourUtc:00 UTC` closes the window. Returns null when before
 * the campaign starts or after it ends.
 */
export function getDayUtc(now: Date, cfg: ScheduleConfig): string | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const end = endMoment(cfg);
  if (!end) return null;
  if (now.getTime() >= end.getTime()) return null;

  // The day whose draw is the first one at-or-after `now`.
  const todayYmd = formatDateUtc(now);
  const todayDraw = drawMomentFor(todayYmd, cfg);
  let candidate: string;
  if (now.getTime() < todayDraw.getTime()) {
    candidate = todayYmd;
  } else {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    candidate = formatDateUtc(tomorrow);
  }

  // Clamp to the campaign window.
  if (parseDateUtc(candidate).getTime() < start.getTime()) return null;
  return candidate;
}

/** Returns the 1-based day index for a given `day_utc`, or null if outside the campaign. */
export function dayIndex(dayUtc: string, cfg: ScheduleConfig): number | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const d = parseDateUtc(dayUtc);
  const idx = Math.floor((d.getTime() - start.getTime()) / 86_400_000) + 1;
  if (idx < 1 || idx > cfg.totalDays) return null;
  return idx;
}

export function nextDrawAt(now: Date, cfg: ScheduleConfig): Date | null {
  const ymd = getDayUtc(now, cfg);
  if (!ymd) return null;
  return drawMomentFor(ymd, cfg);
}

export function hasStarted(_now: Date, cfg: ScheduleConfig): boolean {
  // The campaign is "started" iff it is enabled and not yet ended. Entry is
  // open from feature-enable time through day-100 close.
  if (!cfg.startUtcDate) return false;
  return !hasEnded(_now, cfg);
}

export function hasEnded(now: Date, cfg: ScheduleConfig): boolean {
  const end = endMoment(cfg);
  if (!end) return true;
  return now.getTime() >= end.getTime();
}
