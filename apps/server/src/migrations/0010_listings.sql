-- Marketplace listings table
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  seller_email TEXT NOT NULL,
  price_rpow INTEGER NOT NULL CHECK (price_rpow > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- Only one active listing per token at a time
CREATE UNIQUE INDEX IF NOT EXISTS listings_active_token_idx
  ON listings(token_id)
  WHERE status = 'active';
