# longshot.rpow2.com — deploy runbook

Get RPOW Long Shot live at `https://longshot.rpow2.com` on the existing rpow VPS (15.204.254.192).

## 1. DNS

At GoDaddy: add `longshot CNAME rpow2.com.` (or A record to the VPS IP).

Verify: `dig +short longshot.rpow2.com` returns the VPS IP.

## 2. Build the web app locally

```
cd /Users/fredkrueger/rpow
npm --workspace apps/web-longshot run build
```

## 3. Deploy the bundle

```
ssh ubuntu@15.204.254.192 "sudo mkdir -p /opt/rpow-longshot && sudo chown -R ubuntu:ubuntu /opt/rpow-longshot"
rsync -avz --delete apps/web-longshot/dist/ ubuntu@15.204.254.192:/opt/rpow-longshot/dist/
```

## 4. Install nginx vhost

```
scp ops/nginx/longshot.rpow2.com.conf ubuntu@15.204.254.192:/tmp/
ssh ubuntu@15.204.254.192 'sudo mv /tmp/longshot.rpow2.com.conf /etc/nginx/sites-available/ && sudo ln -sf /etc/nginx/sites-available/longshot.rpow2.com.conf /etc/nginx/sites-enabled/'
```

## 5. TLS via certbot

```
ssh ubuntu@15.204.254.192 'sudo certbot --nginx -d longshot.rpow2.com --redirect --agree-tos -m frkrueger@mac.com -n'
```

## 6. Apply the migration in production

```
ssh ubuntu@15.204.254.192 'sudo -u postgres psql rpow -f /opt/rpow/repo/apps/server/migrations/013_long_shot.sql'
```

(Or restart `rpow-server` and let `runMigrations()` apply it on startup.)

## 7. Set new env vars

Append to `/etc/rpow/server.env`:

```
LONGSHOT_MIN_BASE_UNITS=10000000
LONGSHOT_MAX_BASE_UNITS=1000000000
LONGSHOT_ALLOWED_EMAILS=frkrueger@mac.com
LONGSHOT_WEB_ORIGIN=https://longshot.rpow2.com
```

(Once validated, flip to `LONGSHOT_ALLOWED_EMAILS=*` and `systemctl restart rpow-server` to open access.)

Restart: `ssh ubuntu@15.204.254.192 'sudo systemctl restart rpow-server'`

## 8. Smoke test

```
curl -fsSI https://longshot.rpow2.com/
curl -fsSL https://api.rpow2.com/api/longshot/stats
```

Sign in at rpow2.com, then visit longshot.rpow2.com — balance should display, spin should work.

## 9. Subsequent updates

```
npm --workspace apps/web-longshot run build
rsync -avz --delete apps/web-longshot/dist/ ubuntu@15.204.254.192:/opt/rpow-longshot/dist/
```
