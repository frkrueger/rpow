import { useEffect, useState } from 'react';

type Listing = {
  id: string;
  token_id: string;
  seller_email: string;
  price_rpow: number;
  created_at: string;
  value: number;
};

export default function MarketPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenId, setTokenId] = useState('');
  const [price, setPrice] = useState('1');
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/market', { credentials: 'include' });
      const data = await res.json();
      setListings(data.listings ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function onList(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const res = await fetch('/market/list', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_id: tokenId, price_rpow: Number(price) }),
    });
    const data = await res.json();
    if (data.ok) {
      setMsg('Listed!');
      setTokenId('');
      setPrice('1');
      void load();
    } else {
      setMsg(data.error ?? 'Error');
    }
  }

  async function onCancel(listingId: string) {
    await fetch('/market/cancel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_id: listingId }),
    });
    void load();
  }

  return (
    <main style={{ maxWidth: 860, margin: '40px auto', padding: '0 16px', fontFamily: 'sans-serif' }}>
      <h1>RPOW Marketplace</h1>
      <p style={{ color: '#666' }}>List your mined tokens for other users to see and buy.</p>

      <form onSubmit={onList} style={{ display: 'grid', gap: 10, maxWidth: 400, margin: '24px 0' }}>
        <label>
          Token ID
          <input
            style={{ display: 'block', width: '100%', padding: '6px 10px', marginTop: 4 }}
            placeholder="paste token UUID"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
            required
          />
        </label>
        <label>
          Price (RPOW)
          <input
            style={{ display: 'block', width: '100%', padding: '6px 10px', marginTop: 4 }}
            type="number"
            min="1"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </label>
        <button type="submit" style={{ padding: '8px 20px', cursor: 'pointer' }}>List token</button>
        {msg && <p style={{ color: msg === 'Listed!' ? 'green' : 'red' }}>{msg}</p>}
      </form>

      <h2>Active listings</h2>
      {loading ? <p>Loading…</p> : null}
      {!loading && listings.length === 0 ? <p style={{ color: '#999' }}>No active listings yet.</p> : null}
      <div style={{ display: 'grid', gap: 12 }}>
        {listings.map((l) => (
          <div
            key={l.id}
            style={{
              border: '1px solid #ddd',
              borderRadius: 8,
              padding: '12px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ fontSize: 14 }}>
              <div><strong>Token:</strong> <code style={{ fontSize: 12 }}>{l.token_id}</code></div>
              <div><strong>Seller:</strong> {l.seller_email}</div>
              <div><strong>Price:</strong> {l.price_rpow} RPOW &nbsp; <strong>Value:</strong> {l.value}</div>
              <div style={{ color: '#999', fontSize: 12 }}>{new Date(l.created_at).toLocaleString()}</div>
            </div>
            <button
              onClick={() => void onCancel(l.id)}
              style={{ padding: '6px 14px', cursor: 'pointer', color: '#c00', border: '1px solid #c00', borderRadius: 6, background: 'none' }}
            >
              Cancel
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
