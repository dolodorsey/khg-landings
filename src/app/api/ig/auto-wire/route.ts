/**
 * Auto-wire all 24 KHG brands from a Graph API Explorer me/accounts response.
 *
 * POST /api/ig/auto-wire?key=ADMIN_PROBE_KEY
 *   body: { user_token: "...", accounts: { data: [...] } }
 *
 * For each page in accounts.data:
 *   1. Match by instagram_business_account.username → brand_social_handles.ig_handle
 *   2. Exchange short-lived user token for long-lived (60-day) version
 *   3. Re-fetch me/accounts with long token → never-expiring page token
 *   4. POST /{page-id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions
 *   5. Update brand_social_handles with ig_business_account_id + encrypted page token
 *   6. Flip meta_webhook_subscribed=true
 *
 * Returns: per-brand result + summary.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_APP_ID = '1587663608772885';
const META_GRAPH_VERSION = 'v21.0';

type AcctEntry = {
  id: string;                // page id
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
  };
};

export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || (!body.user_token && !body.accounts)) {
    return NextResponse.json({
      error: 'bad_body',
      hint: 'POST JSON with { user_token: "...", accounts?: { data: [...] } }. If accounts not provided, we will query /me/accounts with user_token.',
    }, { status: 400 });
  }

  // Step 1: exchange short-lived user token for long-lived (60-day) — optional but recommended
  let longUserToken = body.user_token as string;
  if (body.user_token && body.exchange_token !== false) {
    const exchangeRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${encodeURIComponent(META_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(body.user_token)}`,
    );
    const exJson = await exchangeRes.json();
    if (exJson?.access_token) {
      longUserToken = exJson.access_token;
    }
  }

  // Step 2: get accounts (either from body or query fresh with long-lived token)
  let accountsData: AcctEntry[] = body?.accounts?.data || [];
  if (accountsData.length === 0 && longUserToken) {
    const accRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&limit=100&access_token=${encodeURIComponent(longUserToken)}`,
    );
    const accJson = await accRes.json();
    accountsData = accJson?.data || [];
    if (!accountsData.length && accJson?.error) {
      return NextResponse.json({ error: 'meta_fetch_failed', detail: accJson.error }, { status: 502 });
    }
  }

  if (accountsData.length === 0) {
    return NextResponse.json({ error: 'no_accounts_in_response' }, { status: 400 });
  }

  // Step 3: pull our brand handles to match by username
  const handlesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_social_handles?select=brand_key,ig_handle`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const handles = (await handlesRes.json()) as Array<{ brand_key: string; ig_handle: string }>;
  const byHandle = new Map<string, string>();
  for (const h of handles) {
    if (h.ig_handle) byHandle.set(h.ig_handle.toLowerCase(), h.brand_key);
  }

  const results: any[] = [];

  for (const acct of accountsData) {
    const igUsername = acct.instagram_business_account?.username?.toLowerCase();
    const igAccountId = acct.instagram_business_account?.id;
    if (!igUsername) {
      results.push({ page_id: acct.id, page_name: acct.name, status: 'skipped_no_ig' });
      continue;
    }
    const brandKey = byHandle.get(igUsername);
    if (!brandKey) {
      results.push({
        page_id: acct.id, page_name: acct.name, ig_username: igUsername,
        status: 'no_brand_match',
      });
      continue;
    }

    // Subscribe page to webhook fields (this is what activates Meta → our webhook delivery)
    let subStatus = 'unknown';
    let subErr: string | null = null;
    const subRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${acct.id}/subscribed_apps`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscribed_fields: 'messages,messaging_postbacks,message_reactions,message_seen',
          access_token: acct.access_token,
        }),
      },
    );
    const subJson = await subRes.json();
    if (subRes.ok && subJson?.success) {
      subStatus = 'subscribed';
    } else {
      subStatus = 'sub_failed';
      subErr = JSON.stringify(subJson).slice(0, 500);
    }

    // Update brand_social_handles
    const upRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brand_social_handles?brand_key=eq.${brandKey}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'content-type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          ig_business_account_id: igAccountId,
          meta_app_access_token_encrypted: acct.access_token, // plain for now; pgcrypto layer added in follow-up
          meta_webhook_subscribed: subStatus === 'subscribed',
          meta_webhook_subscribed_at: subStatus === 'subscribed' ? new Date().toISOString() : null,
        }),
      },
    );
    const upBody = await upRes.json().catch(() => null);

    results.push({
      brand_key: brandKey,
      ig_username: igUsername,
      ig_account_id: igAccountId,
      page_id: acct.id,
      page_name: acct.name,
      subscribe_status: subStatus,
      subscribe_error: subErr,
      db_update_status: upRes.status,
      db_rows: Array.isArray(upBody) ? upBody.length : 0,
    });
  }

  const summary = {
    pages_in_response: accountsData.length,
    matched_brands: results.filter((r) => r.brand_key).length,
    subscribed: results.filter((r) => r.subscribe_status === 'subscribed').length,
    no_match: results.filter((r) => r.status === 'no_brand_match').length,
    skipped_no_ig: results.filter((r) => r.status === 'skipped_no_ig').length,
  };

  return NextResponse.json({ summary, results });
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({
    service: 'khg-auto-wire',
    instructions: 'POST with body { user_token: "EAAW..." } from Graph API Explorer. Optionally include { accounts: { data: [...] } } to skip the /me/accounts fetch step.',
    permissions_required: [
      'instagram_basic', 'instagram_manage_messages',
      'pages_show_list', 'pages_manage_metadata',
      'pages_read_engagement', 'business_management',
    ],
  });
}
