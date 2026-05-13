/**
 * Polling tick for IG inbound — runs every minute via Vercel Cron.
 *
 * For each brand with ghl_ig_oauth_connected=true:
 *   1. Pull last 20 IG conversations updated in last 5 minutes via GHL Conversations API
 *   2. For each conversation, get the most recent inbound message (newer than our last seen)
 *   3. If we haven't replied to that message_id yet → run rule match → send reply via GHL
 *   4. Log everything to ig_inbound_log (source='ghl_poll')
 *
 * This is the bootstrap path — works immediately with no webhook subscription.
 * Once Marketplace App webhook is up, this can stop running.
 *
 * Triggered by Vercel Cron at /api/ig/poll-tick (configured in vercel.json).
 * Also callable manually with ?key=ADMIN_PROBE_KEY for testing.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PROBE_KEY = process.env.ADMIN_PROBE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const ACTIVE_BRANDS = [
  'casper_group', 'dr_dorsey', 'forever_futbol', 'good_times',
  'huglife', 'peoples_dept', 'pronto_energy', 'umbrella_group',
  'help_911',
];

export async function GET(req: NextRequest) {
  // Auth: either probe key (manual) or Vercel cron header
  const probeKey = req.nextUrl.searchParams.get('key');
  const cronAuth = req.headers.get('authorization');
  const isAuthorized =
    (PROBE_KEY && probeKey === PROBE_KEY) ||
    (CRON_SECRET && cronAuth === `Bearer ${CRON_SECRET}`);
  if (!isAuthorized) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Pull GHL maps
  const ghlRes = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_ghl_map?brand_key=in.(${ACTIVE_BRANDS.join(',')})&is_active=eq.true&select=brand_key,ghl_location_id,pit_token`,
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

  const lookbackParam = req.nextUrl.searchParams.get('lookback_min');
  const lookbackMin = lookbackParam ? Math.min(60 * 24, parseInt(lookbackParam, 10) || 5) : 5;

  const summary: Record<string, any> = {};

  for (const m of maps) {
    summary[m.brand_key] = await pollOne(m, lookbackMin);
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    summary,
  });
}

type GhlMap = { brand_key: string; ghl_location_id: string; pit_token: string };

async function pollOne(m: GhlMap, lookbackMin: number = 5) {
  const headers = {
    Authorization: `Bearer ${m.pit_token}`,
    Version: GHL_VERSION,
    Accept: 'application/json',
  };

  // 1. Get conversations updated in last 5 min, IG channel only, with unread inbound
  // GHL search supports: locationId, lastMessageType=TYPE_IG, status, sort
  const sinceMs = Date.now() - lookbackMin * 60 * 1000;
  const searchUrl = new URL(`${GHL_BASE}/conversations/search`);
  searchUrl.searchParams.set('locationId', m.ghl_location_id);
  searchUrl.searchParams.set('limit', '20');
  searchUrl.searchParams.set('sortBy', 'last_message_date');
  searchUrl.searchParams.set('sort', 'desc');

  const cRes = await fetch(searchUrl.toString(), { headers });
  if (!cRes.ok) {
    return { error: `search_${cRes.status}`, body: (await cRes.text()).slice(0, 200) };
  }
  const cBody = (await cRes.json()) as any;
  const conversations: any[] = cBody?.conversations || [];
  if (conversations.length === 0) return { conversations_scanned: 0, replied: 0 };

  let scanned = 0;
  let replied = 0;
  const errors: string[] = [];

  for (const conv of conversations) {
    // Skip if last message wasn't recent
    const lastMs = new Date(conv.lastMessageDate || conv.dateUpdated || 0).getTime();
    if (lastMs < sinceMs) continue;

    // Skip if last message wasn't inbound IG
    const lastType = conv.lastMessageType;
    const lastDir = conv.lastMessageDirection;
    const isIg = lastType === 'TYPE_IG' || lastType === 'IG' || lastType === 'Instagram' || lastType === 'TYPE_INSTAGRAM';
    if (!isIg || lastDir !== 'inbound') continue;

    scanned++;
    try {
      const result = await replyToConversation(m, conv);
      if (result.replied) replied++;
      if (result.error) errors.push(`${conv.id}:${result.error}`);
    } catch (err: any) {
      errors.push(`${conv.id}:${err?.message || String(err)}`.slice(0, 200));
    }
  }

  return {
    conversations_returned: conversations.length,
    scanned_recent_inbound: scanned,
    replied,
    errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
  };
}

async function replyToConversation(m: GhlMap, conv: any) {
  const headers = {
    Authorization: `Bearer ${m.pit_token}`,
    Version: GHL_VERSION,
    Accept: 'application/json',
  };

  // Fetch last message in conversation
  const msgsRes = await fetch(
    `${GHL_BASE}/conversations/${conv.id}/messages?limit=5`,
    { headers },
  );
  if (!msgsRes.ok) {
    return { replied: false, error: `msgs_${msgsRes.status}` };
  }
  const msgs = (await msgsRes.json()) as any;
  const messages: any[] = msgs?.messages?.messages || msgs?.messages || [];

  // Find latest INBOUND IG message
  const lastInbound = messages.find(
    (mm) => mm.direction === 'inbound' && (
      mm.messageType === 'TYPE_IG' ||
      mm.messageType === 'IG' ||
      mm.messageType === 'Instagram' ||
      mm.messageType === 'TYPE_INSTAGRAM' ||
      mm.type === 29
    ),
  );
  if (!lastInbound) return { replied: false, error: 'no_inbound_msg' };

  const ghlMessageId = String(lastInbound.id || lastInbound.messageId || '');
  const messageText = String(lastInbound.body || lastInbound.message || '').trim();
  if (!messageText) return { replied: false, error: 'empty_text' };

  // Check if we've already logged this message
  const dupCheck = await fetch(
    `${SUPABASE_URL}/rest/v1/ig_inbound_log?message_id=eq.${ghlMessageId}&select=id,reply_sent`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  const dupRows = (await dupCheck.json()) as Array<{ id: number; reply_sent: boolean }>;
  if (dupRows.length > 0 && dupRows[0].reply_sent) {
    return { replied: false, error: 'already_replied' };
  }
  // If we've seen it but not replied (e.g. error before), we'll retry below

  // Check sender state for first-DM detection
  const contactId = String(conv.contactId || lastInbound.contactId || '');
  const stateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/ig_sender_state?brand_key=eq.${m.brand_key}&sender_id=eq.${contactId}&select=total_dms,opted_out`,
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

  // Match rule
  let matchedRule: any = null;
  if (!optedOut) {
    matchedRule = await findMatchingRule(m.brand_key, messageText, isFirstDm);
  }

  // Log inbound (idempotent on message_id UNIQUE constraint)
  let inboundId: number | null = null;
  if (dupRows.length === 0) {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'content-type': 'application/json',
        Prefer: 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify({
        brand_key: m.brand_key,
        ig_account_id: m.ghl_location_id,
        sender_id: contactId,
        message_id: ghlMessageId,
        message_text: messageText,
        message_type: 'text',
        raw_payload: lastInbound,
        matched_rule_id: matchedRule?.id ?? null,
        matched_intent: matchedRule?.rule_name ?? null,
        ghl_conversation_id: conv.id,
        ghl_contact_id: contactId,
        ghl_message_id: ghlMessageId,
        source: 'ghl_poll',
        channel: 'instagram',
      }),
    });
    const inserted = (await insertRes.json()) as any[];
    inboundId = inserted?.[0]?.id || null;
  } else {
    inboundId = dupRows[0].id;
  }

  // Upsert sender state
  await fetch(`${SUPABASE_URL}/rest/v1/ig_sender_state`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      brand_key: m.brand_key,
      sender_id: contactId,
      last_dm_at: new Date().toISOString(),
      total_dms: (stateRows?.[0]?.total_dms ?? 0) + 1,
      ghl_contact_id: contactId,
    }),
  });

  if (!matchedRule) {
    return { replied: false, error: 'no_rule_match' };
  }

  // Send reply via GHL
  const replyText = matchedRule.response_template;
  const sendRes = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'IG',
      contactId,
      message: replyText.slice(0, 1000),
    }),
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text();
    if (inboundId) {
      await fetch(`${SUPABASE_URL}/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reply_error: `send_${sendRes.status}:${errText.slice(0,500)}` }),
      });
    }
    return { replied: false, error: `send_${sendRes.status}` };
  }
  const sendBody: any = await sendRes.json().catch(() => ({}));

  if (inboundId) {
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
        ghl_message_id: sendBody?.messageId || sendBody?.id || null,
      }),
    });
  }

  return { replied: true };
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
