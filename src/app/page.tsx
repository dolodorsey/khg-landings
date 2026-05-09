import Link from 'next/link';
import { ALL_BRANDS, ALL_LANDINGS } from '@/lib/data';

export default function HomePage() {
  const brandKeys = Object.keys(ALL_BRANDS).sort();
  const totalRoutes = ALL_LANDINGS.length;
  return (
    <main className="container">
      <div className="eyebrow">KHG · Landing Network</div>
      <h1 className="title">{brandKeys.length} brands, {totalRoutes} routes.</h1>
      <p className="lede">
        Every Instagram auto-reply CTA across The Kollective Hospitality Group resolves here.
        Each landing is brand-locked, intent-tagged, and pipes leads straight into Supabase + GHL.
      </p>
      <div style={{ display: 'grid', gap: 8, marginTop: 32 }}>
        {brandKeys.map((k) => {
          const b = ALL_BRANDS[k];
          const count = ALL_LANDINGS.filter((l) => l.brand_key === k).length;
          return (
            <Link
              key={k}
              href={`/${k}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid #eee',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: b.primary_color,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, fontWeight: 600 }}>{b.short_name}</span>
              <span style={{ color: '#888', fontSize: 13 }}>@{b.ig_handle}</span>
              <span
                style={{
                  fontSize: 11,
                  color: '#666',
                  background: '#f3f4f6',
                  borderRadius: 6,
                  padding: '3px 8px',
                  marginLeft: 8,
                }}
              >
                {count} routes
              </span>
            </Link>
          );
        })}
      </div>
      <div className="footer">© KHG · The Kollective Hospitality Group · Atlanta</div>
    </main>
  );
}
