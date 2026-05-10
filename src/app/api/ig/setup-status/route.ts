/**
 * Health/status endpoint for the IG inbound engine.
 * GET /api/ig/setup-status
 * Returns: per-brand readiness + counts of inbound log activity.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

export async function GET() {
  const env = {
    META_VERIFY_TOKEN: !!META_VERIFY_TOKEN,
    META_APP_SECRET: !!META_APP_SECRET,
    SUPABASE_URL: !!SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_KEY,
  };

  if (!SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ ok: false, env, brands: null, error: 'no_service_key' });
  }

  // Per-brand readiness
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_social_handles?select=brand_key,ig_handle,ig_business_account_id,meta_app_access_token_encrypted,meta_webhook_subscribed&order=brand_key.asc`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const brands = (await r.json()) as Array<{
    brand_key: string;
    ig_handle: string | null;
    ig_business_account_id: string | null;
    meta_app_access_token_encrypted: string | null;
    meta_webhook_subscribed: boolean | null;
  }>;

  const total = brands.length;
  const withAccountId = brands.filter((b) => !!b.ig_business_account_id).length;
  const withToken = brands.filter((b) => !!b.meta_app_access_token_encrypted).length;
  const subscribed = brands.filter((b) => b.meta_webhook_subscribed === true).length;

  // Last 10 inbound log entries
  const lr = await fetch(
    `${SUPABASE_URL}/rest/v1/ig_inbound_log?select=id,brand_key,sender_id,message_text,matched_intent,reply_sent,reply_error,received_at&order=received_at.desc&limit=10`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const recent = (await lr.json()) as any[];

  return NextResponse.json({
    ok: true,
    env,
    summary: {
      total_brands: total,
      with_ig_account_id: withAccountId,
      with_access_token: withToken,
      webhook_subscribed: subscribed,
      ready_to_fire: brands.filter(
        (b) =>
          !!b.ig_business_account_id &&
          !!b.meta_app_access_token_encrypted &&
          b.meta_webhook_subscribed === true,
      ).length,
    },
    brands: brands.map((b) => ({
      brand_key: b.brand_key,
      ig_handle: b.ig_handle,
      ig_account_id: !!b.ig_business_account_id,
      has_token: !!b.meta_app_access_token_encrypted,
      subscribed: !!b.meta_webhook_subscribed,
    })),
    recent_inbound: recent,
  });
}
