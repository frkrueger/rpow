export function emailWrap(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#08080a;">
<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;background:#08080a;color:#e8e3d3;max-width:560px;margin:0 auto;padding:32px 24px;">
  <!-- Header -->
  <div style="border:1px solid rgba(110,231,183,0.2);margin-bottom:24px;">
    <div style="background:rgba(110,231,183,0.03);border-bottom:1px solid rgba(110,231,183,0.2);padding:8px 16px;font-size:11px;letter-spacing:3px;color:#6ee7b7;">RPOW2</div>
    <div style="padding:24px 16px;">
      ${content}
    </div>
  </div>
  <!-- Footer -->
  <div style="font-size:11px;color:#3a3a3a;text-align:center;">
    <a href="https://rpow2.com" style="color:#6b6b6b;text-decoration:none;">rpow2.com</a> — a tribute to Hal Finney's original RPOW
  </div>
</div>
</body>
</html>`;
}

export function magicLinkEmail(link: string): string {
  return emailWrap(`
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b6b;letter-spacing:2px;text-transform:uppercase;">SIGN IN</p>
      <p style="margin:0 0 20px;font-size:14px;color:#e8e3d3;">Click below to sign in to your rpow2 account.</p>
      <a href="${link}" style="display:inline-block;background:transparent;color:#6ee7b7;border:1px solid #6ee7b7;padding:10px 24px;text-decoration:none;font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;letter-spacing:1px;">[ SIGN IN ]</a>
      <p style="margin:20px 0 0;font-size:11px;color:#3a3a3a;">Or paste this link:</p>
      <p style="margin:4px 0 0;font-size:11px;color:#6b6b6b;word-break:break-all;"><a href="${link}" style="color:#6b6b6b;">${link}</a></p>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(110,231,183,0.1);font-size:11px;color:#3a3a3a;">
        Link expires in 15 minutes. If you didn't request this, ignore this email.
      </div>
  `);
}

export function claimEmail(sender: string, displayAmount: string, claimUrl: string, expiryDays: number): string {
  return emailWrap(`
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b6b;letter-spacing:2px;text-transform:uppercase;">INCOMING TRANSFER</p>
      <p style="margin:0 0 6px;font-size:14px;color:#e8e3d3;">
        <strong style="color:#6ee7b7;">${sender}</strong> sent you
      </p>
      <p style="margin:0 0 20px;font-size:28px;font-weight:700;color:#6ee7b7;">${displayAmount} RPOW</p>
      <a href="${claimUrl}" style="display:inline-block;background:#6ee7b7;color:#08080a;padding:12px 28px;text-decoration:none;font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:700;letter-spacing:1px;">[ CLAIM ${displayAmount} RPOW ]</a>
      <p style="margin:20px 0 0;font-size:11px;color:#3a3a3a;">Or paste this link:</p>
      <p style="margin:4px 0 0;font-size:11px;color:#6b6b6b;word-break:break-all;"><a href="${claimUrl}" style="color:#6b6b6b;">${claimUrl}</a></p>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(110,231,183,0.1);">
        <p style="font-size:11px;color:#6b6b6b;margin:0;">RPOW (Reusable Proofs of Work) are proof-of-work tokens mined in the browser at <a href="https://rpow2.com" style="color:#6ee7b7;">rpow2.com</a>.</p>
      </div>
      <div style="margin-top:12px;font-size:11px;color:#3a3a3a;">
        Link expires in ${expiryDays} days.
      </div>
  `);
}
