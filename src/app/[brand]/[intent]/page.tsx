import { notFound } from 'next/navigation';
import { ALL_LANDINGS, getLanding, getBrand } from '@/lib/data';
import LeadForm from './LeadForm';
import type { Metadata } from 'next';

export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_LANDINGS.map((l) => ({
    brand: l.brand_key,
    intent: l.intent_path,
  }));
}

export function generateMetadata({
  params,
}: {
  params: { brand: string; intent: string };
}): Metadata {
  const l = getLanding(params.brand, params.intent);
  if (!l) return { title: 'Not found' };
  return {
    title: `${l.intent_name} · ${l.short_name}`,
    description: `${l.short_name} — ${l.intent_name.toLowerCase()}. Drop your details and we'll route you in 24h.`,
  };
}

export default function LandingPage({
  params,
}: {
  params: { brand: string; intent: string };
}) {
  const l = getLanding(params.brand, params.intent);
  if (!l) notFound();
  const b = getBrand(params.brand)!;

  // Dynamic copy by intent_name keyword
  const lower = l.intent_name.toLowerCase();
  let lede = `Drop the basics — we'll route you within 24 hours.`;
  if (lower.includes('vip') || lower.includes('table') || lower.includes('birthday'))
    lede = `Tell us the date, group size, and occasion. We'll lock it in within 30 minutes during business hours.`;
  else if (lower.includes('press') || lower.includes('media'))
    lede = `Outlet, topic, deadline — drop those and we'll come back within 24 hours.`;
  else if (lower.includes('invest'))
    lede = `Investment inquiries route directly to Dr. Dorsey. Drop your firm, check size, and stage focus.`;
  else if (lower.includes('partner') || lower.includes('brand') || lower.includes('sponsor'))
    lede = `Partnership pitches need three things: who you are, what you propose, what makes it real.`;
  else if (lower.includes('career') || lower.includes('job'))
    lede = `Open roles + application portal. We review weekly. If it's a fit, we'll reach out within 7 days.`;
  else if (lower.includes('book') || lower.includes('appointment') || lower.includes('schedule'))
    lede = `Book your session below. We confirm within 30 minutes during business hours.`;
  else if (lower.includes('order') || lower.includes('support'))
    lede = `Drop your order # + what's wrong. We respond within 24 hours.`;
  else if (lower.includes('volunteer'))
    lede = `Volunteers are the engine. Sign up and we'll route the next opportunity within 7 days.`;
  else if (lower.includes('donat'))
    lede = `Every donation helps. For corporate or large grants, drop the details below.`;

  return (
    <main
      className="container"
      style={{
        ['--brand-primary' as any]: b.primary_color,
        ['--brand-text' as any]: '#fff',
      }}
    >
      <div
        className="brand-bar"
        style={{
          background: b.primary_color,
          marginLeft: -24,
          marginRight: -24,
          marginTop: -32,
          marginBottom: 24,
        }}
      />
      <div className="brand-mark">
        <span className="dot" /> {b.short_name}
      </div>
      <div className="eyebrow" style={{ color: b.primary_color }}>
        {l.intent_name}
      </div>
      <h1 className="title">{b.tagline}</h1>
      <p className="lede">{lede}</p>
      <LeadForm
        brandKey={l.brand_key}
        intentPath={l.intent_path}
        intentName={l.intent_name}
        brandPrimary={b.primary_color}
      />
      {l.keywords && l.keywords.length > 0 ? (
        <div className="kw-row">
          <div className="smallnote">Triggered when DMs include:</div>
          {l.keywords.slice(0, 8).map((k) => (
            <span className="kw" key={k}>{k}</span>
          ))}
        </div>
      ) : null}
      <div className="footer">
        @{b.ig_handle} · <a style={{ color: b.primary_color }} href={b.website}>{b.website.replace(/^https?:\/\//, '')}</a> · © KHG
      </div>
    </main>
  );
}
