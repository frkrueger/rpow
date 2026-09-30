import type { FastifyInstance } from 'fastify';
import { getDayUtc, dayIndex, nextDrawAt, hasEnded } from '../../freelottery/schedule.js';

export async function statusRoutes(app: FastifyInstance) {
  app.get('/api/freelottery/status', async () => {
    const cfg = app.config;
    const sched = {
      startUtcDate: cfg.freelotteryStartUtcDate,
      totalDays: cfg.freelotteryTotalDays,
      drawHourUtc: cfg.freelotteryDrawHourUtc,
    };
    const now = new Date();
    const currentDayUtc = getDayUtc(now, sched);
    return {
      enabled: !!cfg.freelotteryStartUtcDate,
      startUtcDate: cfg.freelotteryStartUtcDate ?? null,
      totalDays: cfg.freelotteryTotalDays,
      prizeBaseUnits: cfg.freelotteryPrizeBaseUnits.toString(),
      drawHourUtc: cfg.freelotteryDrawHourUtc,
      dayIndex: currentDayUtc ? dayIndex(currentDayUtc, sched) : null,
      currentDayUtc: currentDayUtc ?? null,
      nextDrawAt: nextDrawAt(now, sched)?.toISOString() ?? null,
      ended: hasEnded(now, sched),
    };
  });
}
