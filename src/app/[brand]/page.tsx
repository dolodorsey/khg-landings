import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ALL_BRANDS, ALL_LANDINGS, getBrand } from '@/lib/data';

export function generateStaticParams() {
  return Object.keys(ALL_BRANDS).map((brand) => ({ brand }));
}

export default function BrandIndex({
  params,
}: {
  params: { brand: string };
}) {
  const b = getBrand(params.brand);
  if (!b) notFound();
  const routes = ALL_LANDINGS.filter((l) => l.brand_key === params.brand);
  return (
    <main className="container" style={{
      ['--brand-primary' as any]: b.primary_color,
      ['--brand-text' as any]: '#fff',
    }}>
      <div className="brand-bar" style={{ background: b.primary_color, marginLeft: -24, marginRight: -24, marginTop: -32, marginBottom: 24 }} />
      <div className="brand-mark">
        <span className="dot" /> {b.short_name}
      </div>
      <div className="eyebrow">@{b.ig_handle}</div>
      <h1 className="title">{b.tagline}</h1>
      <p className="lede">
        {routes.length} live landing routes. Pick one or visit the{' '}
        <a style={{ color: b.primary_color, textDecoration: 'underline' }} href={b.website}>
          main site
        </a>.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {routes.map((r) => (
          <Link
            key={r.intent_path}
            href={`/${r.brand_key}/${r.intent_path}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              borderRadius: 10,
              border: '1px solid #eee',
            }}
          >
            <span style={{ flex: 1, fontWeight: 600 }}>{r.intent_name}</span>
            <span style={{ color: '#888', fontSize: 13 }}>/{r.intent_path}</span>
          </Link>
        ))}
      </div>
      <div className="footer">© KHG · @{b.ig_handle}</div>
    </main>
  );
}
