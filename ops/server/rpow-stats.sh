#!/bin/bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOAD=$(awk '{print $1}' /proc/loadavg)
MEM_FREE=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
CONN=$(ss -s | grep estab | grep -oE 'estab [0-9]+' | awk '{print $2}')
USERS_TOTAL=$(sudo -u postgres psql rpow -tAc 'SELECT count(*) FROM users;')
USERS_HOUR=$(sudo -u postgres psql rpow -tAc "SELECT count(*) FROM users WHERE last_login_at > now() - interval '1 hour';")
SIGNUPS_HOUR=$(sudo -u postgres psql rpow -tAc "SELECT count(*) FROM users WHERE created_at > now() - interval '30 minutes';")
SUPPLY=$(sudo -u postgres psql rpow -tAc "SELECT value FROM app_counters WHERE name='minted_supply';")
SUPPLY_RPOW=$(echo $SUPPLY | python3 -c 'import sys; print(int(sys.stdin.read().strip())//1000000000)')
CHALLENGES=$(sudo -u postgres psql rpow -tAc "SELECT count(*) FROM challenges WHERE issued_at > now() - interval '30 minutes';")
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
UH=$((USERS_HOUR + 1))
RATIO=$(echo "scale=1; $CONN / $UH" | bc)

C1=$(wc -l < /var/log/nginx/api.rpow2.com.access.log)
sleep 3
C2=$(wc -l < /var/log/nginx/api.rpow2.com.access.log)
REQ_S=$(( (C2 - C1) / 3 ))

CODES_200=$(tail -10000 /var/log/nginx/api.rpow2.com.access.log | grep -c ' 200 ')
CODES_403=$(tail -10000 /var/log/nginx/api.rpow2.com.access.log | grep -c ' 403 ')
CODES_429=$(tail -10000 /var/log/nginx/api.rpow2.com.access.log | grep -c ' 429 ')
CODES_503=$(tail -10000 /var/log/nginx/api.rpow2.com.access.log | grep -c ' 503 ')

echo "$TS,$LOAD,$MEM_FREE,$CONN,$USERS_TOTAL,$USERS_HOUR,$SIGNUPS_HOUR,$SUPPLY_RPOW,$CHALLENGES,$REQ_S,$RATIO,$DISK_PCT,$CODES_200,$CODES_403,$CODES_429,$CODES_503" >> /var/log/rpow-stats/metrics.csv
