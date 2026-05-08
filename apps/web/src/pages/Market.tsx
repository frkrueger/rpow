import { useEffect, useState } from 'react';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';

type Listing = {
  id: string;
  token_id: string;
  seller_email: string;
  price_rpow: number;
  created_at: string;
  issued_at: string;
};

export function MarketPage() {
  const { me } = useMe();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [listTokenId, setListTokenId] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [listMsg, setListMsg] = useState('');

  async function load() {
    try {
      setLoading(true);
      const data = await api.marketListings();
      setListings(data.listings);
    } catch (e: any) {
      setErr(e?.message ?? 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleList(e: React.FormEvent) {
    e.preventDefault();
    setListMsg('');
    try {
      await api.marketList({ token_id: listTokenId.trim(), price_rpow: Number(listPrice) });
      setListMsg('listed!');
      setListTokenId('');
      setListPrice('');
      load();
    } catch (e: any) {
      setListMsg(e?.message ?? 'error');
    }
  }

  async function handleCancel(listing_id: string) {
    try {
      await api.marketCancel({ listing_id });
      load();
    } catch (e: any) {
      alert(e?.message ?? 'error cancelling');
    }
  }

  return (
    <div className="page">
      <pre className="section-header">[ marketplace ]</pre>

      {me && (
        <form onSubmit={handleList} style={{ marginBottom: 16 }}>
          <pre>list a token for sale</pre>
          <div>
            <label>token id: </label>
            <input
              value={listTokenId}
              onChange={e => setListTokenId(e.target.value)}
              placeholder="uuid"
              style={{ width: 320 }}
            />
          </div>
          <div>
            <label>price (rpow): </label>
            <input
              type="number"
              min={1}
              value={listPrice}
              onChange={e => setListPrice(e.target.value)}
              placeholder="1"
            />
          </div>
          <button type="submit">[ list ]</button>
          {listMsg && <span style={{ marginLeft: 8 }}>{listMsg}</span>}
        </form>
      )}

      {loading && <pre>loading...</pre>}
      {err && <pre style={{ color: 'red' }}>{err}</pre>}
      {!loading && listings.length === 0 && <pre>no active listings</pre>}

      {listings.map(l => (
        <div key={l.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 8 }}>
          <pre>
{`token:  ${l.token_id}
seller: ${l.seller_email}
price:  ${l.price_rpow} rpow
minted: ${new Date(l.issued_at).toLocaleDateString()}`}
          </pre>
          {me?.email === l.seller_email && (
            <button onClick={() => handleCancel(l.id)}>[ cancel listing ]</button>
          )}
        </div>
      ))}
    </div>
  );
}
