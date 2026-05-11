/**
 * Admin/setup endpoint — queries Meta Graph API using credentials in Supabase
 * to discover every Facebook Page + linked Instagram Business Account owned by
 * the KHG Meta Business. Returns the data so we can auto-match to brand_social_handles
 * by ig_handle.
 *
 * Protected by a probe key — call with ?key=<ADMIN_PROBE_KEY>.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';
const META_GRAPH_VERSION = 'v21.0';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Pull Meta creds from Supabase
  const credRes = await fetch(
    `${SUPABASE_URL}/rest/v1/credentials?credential_key=in.(meta_business,meta_facebook_page_token)&select=credential_key,credential_value`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const creds = (await credRes.json()) as Array<{
    credential_key: string;
    credential_value: any;
  }>;
  const metaBiz = creds.find((c) => c.credential_key === 'meta_business')?.credential_value;
  const pageTokenCred = creds.find((c) => c.credential_key === 'meta_facebook_page_token')?.credential_value;

  if (!metaBiz) {
    return NextResponse.json({ error: 'no_meta_business_cred' }, { status: 500 });
  }

  const systemToken: string | undefined = metaBiz.meta_system_user_token;
  const businessId: string | undefined = metaBiz.meta_business_id;
  const appId: string | undefined = metaBiz.meta_app_id;
  const pageToken: string | undefined = pageTokenCred?.token;

  const probes: any = {
    has_system_token: !!systemToken,
    has_business_id: !!businessId,
    has_app_id: !!appId,
    has_page_token: !!pageToken,
  };

  // Probe 1: validate system token
  if (systemToken) {
    const r = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me?fields=id,name&access_token=${encodeURIComponent(systemToken)}`,
    );
    probes.system_token_me = await r.json();
  }

  // Probe 2: validate page token
  if (pageToken) {
    const r = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me?fields=id,name&access_token=${encodeURIComponent(pageToken)}`,
    );
    probes.page_token_me = await r.json();
  }

  // Probe 3: list business-owned pages with IG account info (system user token)
  if (systemToken && businessId) {
    const r = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${businessId}/owned_pages?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}&limit=100&access_token=${encodeURIComponent(systemToken)}`,
    );
    probes.owned_pages = await r.json();
  }

  // Probe 4: also try /me/accounts on page token (sometimes user/system tokens give different results)
  if (pageToken) {
    const r = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&limit=100&access_token=${encodeURIComponent(pageToken)}`,
    );
    probes.page_token_accounts = await r.json();
  }

  // Probe 5: granular_scopes on the system token
  if (systemToken && appId) {
    const r = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(systemToken)}&access_token=${encodeURIComponent(systemToken)}`,
    );
    probes.system_token_debug = await r.json();
  }

  return NextResponse.json(probes);
}
