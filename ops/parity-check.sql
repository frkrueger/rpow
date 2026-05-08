-- Run against both Neon and VPS Postgres post-restore.
-- Output should be IDENTICAL row-for-row, table-for-table.
-- If any row differs, ABORT cutover.
SELECT 'users'             AS tbl, count(*) FROM users
UNION ALL SELECT 'tokens',            count(*) FROM tokens
UNION ALL SELECT 'tokens_valid',      count(*) FROM tokens WHERE state='VALID'
UNION ALL SELECT 'tokens_invalidated',count(*) FROM tokens WHERE state='INVALIDATED'
UNION ALL SELECT 'transfers',         count(*) FROM transfers
UNION ALL SELECT 'magic_links',       count(*) FROM magic_links
UNION ALL SELECT 'magic_links_unused',count(*) FROM magic_links WHERE used_at IS NULL
UNION ALL SELECT 'email_unsubscribes', count(*) FROM email_unsubscribes
UNION ALL SELECT 'challenges',        count(*) FROM challenges
UNION ALL SELECT 'challenges_unclaimed', count(*) FROM challenges WHERE claimed_at IS NULL
UNION ALL SELECT 'pending_transfers', count(*) FROM pending_transfers
UNION ALL SELECT 'pending_transfers_unclaimed', count(*) FROM pending_transfers WHERE claimed_at IS NULL
UNION ALL SELECT 'pending_transfer_tokens', count(*) FROM pending_transfer_tokens
UNION ALL SELECT 'app_counters',      count(*) FROM app_counters
UNION ALL SELECT 'app_counters_minted_supply', count(*) FROM app_counters WHERE name='minted_supply'
ORDER BY tbl;
