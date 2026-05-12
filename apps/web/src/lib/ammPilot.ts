// Single source of truth for who can see the AMM pilot UI surfaces
// (Apps.tsx entry, Wallet.tsx USDC balance cell). The backend gate is
// independent — it's controlled by AMM_ALLOWED_EMAILS in /etc/rpow/.env.
// Keep them in sync until the pilot opens up.
export const AMM_PILOT_EMAILS = new Set<string>(['frk314@gmail.com']);
