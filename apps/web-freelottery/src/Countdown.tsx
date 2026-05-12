import { useEffect, useState } from 'react';

interface CountdownProps {
  to: string | null;
}

interface Parts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  done: boolean;
}

function computeParts(to: string | null, now: number): Parts {
  if (!to) return { days: 0, hours: 0, minutes: 0, seconds: 0, done: true };
  const target = new Date(to).getTime();
  if (!Number.isFinite(target)) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, done: true };
  }
  const diff = Math.max(0, target - now);
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return { days, hours, minutes, seconds, done: diff === 0 };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function Countdown({ to }: CountdownProps) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const parts = computeParts(to, now);

  if (parts.done) {
    return (
      <div className="countdown-frame" aria-live="polite">
        <div className="countdown-label">
          <span>Next draw</span>
          <span className="blink">● Drawing</span>
        </div>
        <p className="countdown-drawn">Draw in progress…</p>
      </div>
    );
  }

  return (
    <div className="countdown-frame" aria-live="polite">
      <div className="countdown-label">
        <span>Time until 19:00 UTC draw</span>
        <span className="blink">● LIVE</span>
      </div>
      <div className="countdown-digits" role="timer">
        <div className="countdown-cell">
          <span className="countdown-num">{pad(parts.days)}</span>
          <span className="countdown-unit">Days</span>
        </div>
        <span className="countdown-colon" aria-hidden="true">:</span>
        <div className="countdown-cell">
          <span className="countdown-num">{pad(parts.hours)}</span>
          <span className="countdown-unit">Hrs</span>
        </div>
        <span className="countdown-colon" aria-hidden="true">:</span>
        <div className="countdown-cell">
          <span className="countdown-num">{pad(parts.minutes)}</span>
          <span className="countdown-unit">Min</span>
        </div>
        <span className="countdown-colon" aria-hidden="true">:</span>
        <div className="countdown-cell">
          <span className="countdown-num">{pad(parts.seconds)}</span>
          <span className="countdown-unit">Sec</span>
        </div>
      </div>
    </div>
  );
}
