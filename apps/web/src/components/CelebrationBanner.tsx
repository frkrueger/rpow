import { useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'celebration-100k-dismissed';

export function CelebrationBanner() {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.sessionStorage.getItem(STORAGE_KEY) === '1',
  );
  if (dismissed) return null;

  const dismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.sessionStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="celebration-banner">
      <Link to="/news" className="celebration-link">
        <pre className="celebration-art">{`+========================================================================+
|  `}<span className="celebration-star">★</span>{`  `}<span className="celebration-headline">100,000 USERS — 5 DAYS</span>{`  `}<span className="celebration-star">★</span>{`  TUE MAY 12 — 01:02 AM PST           |
+========================================================================+`}</pre>
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="dismiss celebration banner"
        className="celebration-close"
      >×</button>
      <style>{`
        .celebration-banner {
          position: relative;
          background: #100800;
          padding: 4px 0;
          margin-bottom: 8px;
          font-family: monospace;
        }
        .celebration-link {
          display: block;
          text-decoration: none;
          color: #ffd700;
          text-align: center;
        }
        .celebration-art {
          margin: 0;
          line-height: 1.15;
          color: #ffd700;
          text-shadow: 0 0 4px rgba(255, 215, 0, 0.45);
          white-space: pre;
          /* Art is 74 columns wide. Scale font with viewport so it always
             fits — ~0.6em per char in monospace × 74 cols ≈ font-size × 44.
             Hidden overflow prevents a flicker scrollbar from sub-pixel
             rounding on browsers where monospace is slightly wider. */
          font-size: clamp(8px, 2.1vw, 14px);
          overflow: hidden;
        }
        .celebration-headline {
          color: #ffec80;
          font-weight: bold;
          letter-spacing: 1px;
        }
        .celebration-star {
          display: inline-block;
          color: #ffec80;
          animation: celebration-blink 0.8s steps(2, end) infinite;
        }
        .celebration-link:hover .celebration-art {
          text-shadow: 0 0 8px rgba(255, 215, 0, 0.85);
        }
        .celebration-close {
          position: absolute;
          top: 4px;
          right: 6px;
          background: transparent;
          color: #ffd700;
          border: 1px solid #6a4a00;
          padding: 0 6px;
          font-family: monospace;
          font-size: 14px;
          cursor: pointer;
          line-height: 1.2;
        }
        .celebration-close:hover { background: #2a1c00; }
        @keyframes celebration-blink {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
