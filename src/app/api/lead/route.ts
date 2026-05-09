import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

type Payload = {
  brand_key?: string;
  intent_path?: string;
  intent_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  message?: string;
  meta?: Record<string, unknown>;
};

function isEmail(s: unknown): s is string {
  return typeof s === 'string' && /.+@.+\..+/.test(s);
}

export async function POST(req: NextRequest) {
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Server-side validation
  if (!body.brand_key || !body.intent_path) {
    return NextResponse.json({ error: 'missing_route' }, { status: 400 });
  }
  if (!body.first_name || !body.last_name || !isEmail(body.email)) {
    return NextResponse.json({ error: 'missing_required_fields' }, { status: 400 });
  }

  const row = {
    brand_key: String(body.brand_key).slice(0, 64),
    intent_path: String(body.intent_path).slice(0, 64),
    intent_name: body.intent_name ? String(body.intent_name).slice(0, 128) : null,
    first_name: String(body.first_name).slice(0, 128),
    last_name: String(body.last_name).slice(0, 128),
    email: String(body.email).slice(0, 320),
    phone: body.phone ? String(body.phone).slice(0, 32) : null,
    message: body.message ? String(body.message).slice(0, 4000) : null,
    meta: body.meta || {},
    source: 'khg-landings',
  };

  // Persist to Supabase via REST API (no SDK needed)
  if (!SUPABASE_SERVICE_KEY) {
    // No service key configured — log only, do not fail in dev
    console.warn('[khg-landings] No SUPABASE_SERVICE_ROLE_KEY set — skipping persist:', row);
    return NextResponse.json({ ok: true, persisted: false });
  }

  const insertUrl = `${SUPABASE_URL}/rest/v1/khg_landing_leads`;
  try {
    const res = await fetch(insertUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[khg-landings] Supabase insert failed:', res.status, text);
      return NextResponse.json(
        { error: 'persist_failed', detail: text.slice(0, 500) },
        { status: 502 },
      );
    }
  } catch (err: any) {
    console.error('[khg-landings] fetch error:', err);
    return NextResponse.json({ error: 'persist_error' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, persisted: true });
}

export async function GET() {
  return NextResponse.json({
    service: 'khg-landings',
    method: 'POST application/json',
    fields: [
      'brand_key',
      'intent_path',
      'intent_name',
      'first_name',
      'last_name',
      'email',
      'phone',
      'message',
      'meta',
    ],
  });
}
