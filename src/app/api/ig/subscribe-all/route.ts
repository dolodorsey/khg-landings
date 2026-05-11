/**
 * Admin: bulk-subscribe all GHL-connected KHG brands to fire InboundMessage
 * webhooks at our /api/ghl/webhook endpoint.
 *
 * GHL native webhook API documentation:
 *   POST /hooks/  with body { url, locationId, eventType }
 *
 * NOTE: GHL's webhook system varies. The current public API uses the "App Marketplace"
 * for webhooks (requires a developer app), but PIT tokens can also use the simpler
 * Workflow trigger to call a URL. This endpoint TRIES the direct hooks API; if it
 * fails for a brand, the activation guide explains the GHL UI fallback path.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const WEBHOOK_URL = 'https://khg-landings.vercel.app/api/ghl/webhook';

const ACTIVE_BRANDS = [
  'casper_group', 'dr_dorsey', 'forever_futbol', 'good_times',
  'huglife', 'peoples_dept', 'pronto_energy', 'umbrella_group',
];

export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Pull GHL maps
  const ghlRes = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_ghl_map?brand_key=in.(${ACTIVE_BRANDS.join(',')})&select=brand_key,ghl_location_id,pit_token`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const maps = (await ghlRes.json()) as Array<{
    brand_key: string;
    ghl_location_id: string;
    pit_token: string;
  }>;

  const results: Record<string, any> = {};

  for (const m of maps) {
    if (!m.pit_token || !m.ghl_location_id) {
      results[m.brand_key] = { error: 'missing_creds' };
      continue;
    }

    const headers = {
      Authorization: `Bearer ${m.pit_token}`,
      Version: GHL_VERSION,
      'content-type': 'application/json',
      Accept: 'application/json',
    };

    // Attempt direct webhook subscription via /hooks/
    const res1 = await fetch(`${GHL_BASE}/hooks/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: WEBHOOK_URL,
        locationId: m.ghl_location_id,
        eventType: 'InboundMessage',
      }),
    });
    const body1 = await res1.text();

    // Alternate: /webhooks/ (some GHL variants)
    const res2 = await fetch(`${GHL_BASE}/webhooks/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: WEBHOOK_URL,
        locationId: m.ghl_location_id,
        eventType: 'InboundMessage',
      }),
    });
    const body2 = await res2.text();

    results[m.brand_key] = {
      location_id: m.ghl_location_id,
      hooks_attempt: {
        status: res1.status,
        body: body1.slice(0, 300),
      },
      webhooks_attempt: {
        status: res2.status,
        body: body2.slice(0, 300),
      },
    };
  }

  return NextResponse.json({
    target_webhook: WEBHOOK_URL,
    results,
  });
}

// GET — show plan without executing
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({
    target_webhook: WEBHOOK_URL,
    brands_to_subscribe: ACTIVE_BRANDS,
    method: 'POST this endpoint with the same key to attempt subscription',
  });
}
