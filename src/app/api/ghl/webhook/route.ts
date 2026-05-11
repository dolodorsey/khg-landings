/**
 * GHL Conversation Webhook receiver.
 *
 * When a brand has IG OAuth connected via GHL (Settings → Integrations → Instagram),
 * GHL forwards inbound IG DMs to its own webhook subscribers. We subscribe to
 * the "InboundMessage" event in each brand's GHL subaccount → GHL POSTs here.
 *
 * Flow:
 *   1. GHL fires POST /api/ghl/webhook with the inbound message payload
 *   2. We look up brand by locationId, run keyword match against ig_auto_reply_rules
 *   3. Reply via GHL Conversations API (POST /conversations/messages) using
 *      the same PIT token already in brand_ghl_map
 *   4. Log everything to ig_inbound_log (source='ghl')
 *
 * Required env vars (already set on Vercel):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional: GHL_WEBHOOK_SECRET — if set, we'll validate x-wh-signature header.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// ─── Webhook receiver ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const raw = await req.text();

  // Optional signature verification
  if (GHL_WEBHOOK_SECRET) {
    const sig = req.headers.get('x-wh-signature') || '';
    const expected = crypto.createHmac('sha256', GHL_WEBHOOK_SECRET).update(raw).digest('hex');
    if (sig !== expected) {
      console.warn('[ghl-webhook] bad signature');
      return new NextResponse('bad signature', { status: 401 });
    }
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  // GHL InboundMessage event shape (varies by version):
  // {
  //   type: 'InboundMessage',
  //   locationId: '...',
  //   contactId: '...',
  //   conversationId: '...',
  //   messageId: '...',
  //   body: '<text>',
  //   messageType: 'IG',  // or 'SMS', 'Email', 'FB', etc.
  //   direction: 'inbound',
  //   ...
  // }

  const event = body;
  const eventType = event.type || event.event || '';

  if (eventType !== 'InboundMessage' && eventType !== 'inbound_message') {
    return NextResponse.json({ ok: true, ignored: eventType || 'unknown' });
  }

  // Filter for IG only — ignore SMS / email / FB DMs
  const channel = (event.messageType || event.message_type || '').toUpperCase();
  if (channel !== 'IG' && channel !== 'INSTAGRAM') {
    return NextResponse.json({ ok: true, ignored: `channel:${channel}` });
  }

  try {
    await handleInbound(event);
  } catch (err: any) {
    console.error('[ghl-webhook] processing error:', err);
    // Still return 200 so GHL doesn't keep retrying
  }

  return NextResponse.json({ ok: true });
}

async function handleInbound(event: any) {
  const locationId = String(event.locationId || event.location_id || '');
  const contactId = String(event.contactId || event.contact_id || '');
  const conversationId = String(event.conversationId || event.conversation_id || '');
  const messageId = String(event.messageId || event.message_id || `${Date.now()}-${contactId}`);
  const messageText = String(event.body || event.message || '').trim();

  if (!locationId) {
    console.warn('[ghl-webhook] no locationId in event');
    return;
  }

  // 1. Resolve brand_key + PIT token from location
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_ghl_map?ghl_location_id=eq.${locationId}&select=brand_key,pit_token&is_active=eq.true`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const lookup = (await lookupRes.json()) as Array<{ brand_key: string; pit_token: string }>;
  const brandRow = lookup?.[0];
  if (!brandRow) {
    await logInbound({
      brand_key: null, ig_account_id: locationId, sender_id: contactId,
      message_id: messageId, message_text: messageText,
      raw_payload: event, reply_sent: false, reply_error: 'no_brand_for_location',
      ghl_conversation_id: conversationId, ghl_contact_id: contactId,
      source: 'ghl',
    });
    return;
  }
  const brandKey = brandRow.brand_key;
  const pit = brandRow.pit_token;

  // 2. Check sender state — first DM?
  const stateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/ig_sender_state?brand_key=eq.${brandKey}&sender_id=eq.${contactId}&select=total_dms,opted_out`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const stateRows = (await stateRes.json()) as Array<{ total_dms: number; opted_out: boolean }>;
  const isFirstDm = !stateRows || stateRows.length === 0;
  const optedOut = !!stateRows?.[0]?.opted_out;

  // 3. Match rule
  let matchedRule: any = null;
  if (!optedOut) {
    matchedRule = await findMatchingRule(brandKey, messageText, isFirstDm);
  }

  // 4. Log inbound (idempotent on message_id UNIQUE)
  const inboundInsert = await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify({
      brand_key: brandKey,
      ig_account_id: locationId,  // we use the GHL location id as our brand-account proxy
      sender_id: contactId,
      message_id: messageId,
      message_text: messageText,
      message_type: 'text',
      raw_payload: event,
      matched_rule_id: matchedRule?.id ?? null,
      matched_intent: matchedRule?.rule_name ?? null,
      ghl_conversation_id: conversationId,
      ghl_contact_id: contactId,
      ghl_message_id: messageId,
      source: 'ghl',
      channel: 'instagram',
    }),
  });
  const inboundRows = inboundInsert.ok ? await inboundInsert.json() : [];
  const inboundId = (inboundRows as any[])?.[0]?.id;

  // 5. Upsert sender state
  await fetch(`${SUPABASE_URL}/rest/v1/ig_sender_state`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      brand_key: brandKey,
      sender_id: contactId,
      last_dm_at: new Date().toISOString(),
      total_dms: (stateRows?.[0]?.total_dms ?? 0) + 1,
      ghl_contact_id: contactId,
    }),
  });

  // 6. Send reply if matched
  if (matchedRule && inboundId) {
    try {
      const replyText = matchedRule.response_template;
      const replyRes = await fetch(`${GHL_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pit}`,
          Version: GHL_VERSION,
          'content-type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          type: 'IG',
          contactId: contactId,
          message: replyText.slice(0, 1000),
        }),
      });
      if (!replyRes.ok) {
        const errText = await replyRes.text();
        throw new Error(`ghl_send_${replyRes.status}: ${errText.slice(0, 500)}`);
      }
      const replyBody: any = await replyRes.json().catch(() => ({}));

      // Mark inbound as replied
      await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reply_sent: true,
          reply_text: replyText,
          reply_sent_at: new Date().toISOString(),
          ghl_message_id: replyBody?.messageId || replyBody?.id || null,
        }),
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error('[ghl-webhook] reply failed:', errMsg);
      await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reply_error: errMsg.slice(0, 1000) }),
      });
    }
  }
}

async function findMatchingRule(brandKey: string, text: string, isFirstDm: boolean) {
  const rulesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/ig_auto_reply_rules?brand_key=eq.${brandKey}&select=id,rule_name,rule_priority,trigger_type,keywords,response_template&order=rule_priority.asc`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const rules = (await rulesRes.json()) as Array<{
    id: number;
    rule_name: string;
    rule_priority: number;
    trigger_type: string;
    keywords: string[] | null;
    response_template: string;
  }>;
  if (!rules || rules.length === 0) return null;

  const lower = text.toLowerCase().trim();

  for (const r of rules) {
    if (r.trigger_type !== 'keyword_dm') continue;
    if (!r.keywords || r.keywords.length === 0) continue;
    for (const kw of r.keywords) {
      if (kw && lower.includes(kw.toLowerCase())) return r;
    }
  }

  if (isFirstDm) {
    const firstRule = rules.find((r) => r.trigger_type === 'first_dm');
    if (firstRule) return firstRule;
  }
  return null;
}

async function logInbound(row: any) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'content-type': 'application/json',
        Prefer: 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error('[ghl-webhook] log error:', err);
  }
}

// GET — quick health check
export async function GET() {
  return NextResponse.json({
    service: 'khg-ghl-inbound',
    method: 'POST application/json',
    events: ['InboundMessage'],
    channels: ['IG'],
    description: 'Subscribe this URL to InboundMessage events in each GHL subaccount with IG OAuth connected.',
  });
}
