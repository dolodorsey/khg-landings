import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';
const META_GRAPH = 'v21.0';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const credRes = await fetch(
    `${SUPABASE_URL}/rest/v1/credentials?credential_key=in.(meta_business,meta_facebook_page_token,instagram_secret,facebook_app_secret)&select=credential_key,credential_value`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  );
  const creds = (await credRes.json()) as Array<{ credential_key: string; credential_value: any }>;
  const bag = Object.fromEntries(creds.map(c => [c.credential_key, c.credential_value]));

  const meta_business = bag.meta_business;
  const long_page_token = bag.meta_facebook_page_token?.token;

  const probes: Record<string, any> = {
    tokens_on_file: {
      meta_system_user_token_chars: meta_business?.meta_system_user_token?.length || 0,
      meta_app_secret_chars: meta_business?.meta_app_secret?.length || 0,
      long_page_token_chars: long_page_token?.length || 0,
      facebook_app_secret_chars: bag.facebook_app_secret?.secret?.length || 0,
      instagram_secret_chars: bag.instagram_secret?.secret?.length || 0,
    },
  };

  // Try the long page token alone — most likely candidate
  if (long_page_token) {
    const r = await fetch(`https://graph.facebook.com/${META_GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(long_page_token)}`);
    probes.long_page_token_me = await r.json();

    // If it works, try to list connected IG account
    const r2 = await fetch(`https://graph.facebook.com/${META_GRAPH}/me?fields=id,name,instagram_business_account{id,username,name}&access_token=${encodeURIComponent(long_page_token)}`);
    probes.long_page_token_ig = await r2.json();
  }

  // Try system user token
  if (meta_business?.meta_system_user_token) {
    const r = await fetch(`https://graph.facebook.com/${META_GRAPH}/me?access_token=${encodeURIComponent(meta_business.meta_system_user_token)}`);
    probes.system_token_me = await r.json();
  }

  // Try as appsecret_proof (app_id|app_secret format)
  if (bag.facebook_app_secret?.secret && meta_business?.meta_app_id) {
    // The "app access token" format
    const app_access_token = `${meta_business.meta_app_id}|${bag.facebook_app_secret.secret}`;
    const r = await fetch(`https://graph.facebook.com/${META_GRAPH}/${meta_business.meta_business_id}?fields=id,name&access_token=${encodeURIComponent(app_access_token)}`);
    probes.app_access_token_business = await r.json();
    
    const r2 = await fetch(`https://graph.facebook.com/${META_GRAPH}/${meta_business.meta_business_id}/owned_pages?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(app_access_token)}`);
    probes.app_access_token_owned_pages = await r2.json();
  }

  return NextResponse.json(probes);
}
