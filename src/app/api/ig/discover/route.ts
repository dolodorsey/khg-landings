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
    if (!m.pit_token || !m.ghl_location_id) {
      results[m.brand_key] = { error: 'missing_creds' };
      continue;
    }
    const headers = {
      Authorization: `Bearer ${m.pit_token}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    };

    const locRes = await fetch(`${GHL_BASE}/locations/${m.ghl_location_id}`, { headers });
    const locStatus = locRes.status;
    let locName = null;
    let locErr: any = null;
    if (locStatus === 200) {
      const b = await locRes.json();
      locName = b?.location?.name || b?.name;
    } else {
      locErr = (await locRes.text()).slice(0, 200);
    }

    const convRes = await fetch(
      `${GHL_BASE}/conversations/search?locationId=${m.ghl_location_id}&limit=3`,
      { headers },
    );
    const convStatus = convRes.status;
    let convCount = null;
    let convErr: any = null;
    if (convStatus === 200) {
      const b = await convRes.json();
      convCount = b?.conversations?.length ?? b?.total ?? 0;
    } else {
      convErr = (await convRes.text()).slice(0, 200);
    }

    results[m.brand_key] = {
      location_id: m.ghl_location_id,
      pit_chars: m.pit_token.length,
      location: { status: locStatus, name: locName, error: locErr },
      conversations: { status: convStatus, count: convCount, error: convErr },
    };
  }

  return NextResponse.json({ results });
}
