import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const ACTIVE_BRANDS = [
  'casper_group', 'dr_dorsey', 'forever_futbol', 'good_times',
  'huglife', 'peoples_dept', 'pronto_energy', 'umbrella_group',
  'help_911',
];

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const ghlRes = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_ghl_map?brand_key=in.(${ACTIVE_BRANDS.join(',')})&select=brand_key,ghl_location_id,pit_token`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  );
  const maps = (await ghlRes.json()) as Array<{ brand_key: string; ghl_location_id: string; pit_token: string }>;

  const results: Record<string, any> = {};

  for (const m of maps) {
    const headers = {
      Authorization: `Bearer ${m.pit_token}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    };

    // Probe workflows API
    const wfRes = await fetch(`${GHL_BASE}/workflows/?locationId=${m.ghl_location_id}`, { headers });
    const wfStatus = wfRes.status;
    let wfBody: any = null;
    if (wfStatus === 200) {
      const j = await wfRes.json();
      wfBody = { count: j?.workflows?.length || 0, sample: j?.workflows?.[0] || null };
    } else {
      wfBody = (await wfRes.text()).slice(0, 300);
    }

    // Probe contacts (sanity)
    const cRes = await fetch(`${GHL_BASE}/contacts/?locationId=${m.ghl_location_id}&limit=1`, { headers });

    results[m.brand_key] = {
      location_id: m.ghl_location_id,
      workflows: { status: wfStatus, body: wfBody },
      contacts: { status: cRes.status },
    };
  }

  return NextResponse.json({ results });
}
