/**
 * Instagram Messaging Webhook receiver.
 *
 * Meta Graph API will:
 *   GET  /api/ig/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 *        → respond with the challenge string if verify_token matches.
 *
 *   POST /api/ig/webhook
 *        with x-hub-signature-256 header (HMAC-SHA256 of raw body using META_APP_SECRET)
 *        → for each entry, find the matching auto-reply rule, send a reply via Meta Send API,
 *          log every step into ig_inbound_log.
 *
 * Required env vars on Vercel:
 *   META_VERIFY_TOKEN          - shared secret you also enter in Meta dashboard
 *   META_APP_SECRET            - app secret from Meta App settings (for HMAC verification)
 *   SUPABASE_URL               - already set
 *   SUPABASE_SERVICE_ROLE_KEY  - already set
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dzlmtvodpyhetvektfuo.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_GRAPH_VERSION = 'v21.0';

// ─── GET: Meta webhook verification handshake ────────────────────────────────
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get('hub.mode');
  const token = sp.get('hub.verify_token');
  const challenge = sp.get('hub.challenge');
  if (mode === 'subscribe' && token && token === META_VERIFY_TOKEN) {
    return new NextResponse(challenge || '', { status: 200 });
  }
  return new NextResponse('forbidden', { status: 403 });
}

// ─── POST: Meta sends inbound DMs ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const raw = await req.text();

  // 1. Verify signature
  if (META_APP_SECRET) {
    const sig = req.headers.get('x-hub-signature-256') || '';
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', META_APP_SECRET).update(raw).digest('hex');
    // timingSafeEqual requires equal-length buffers
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[ig-webhook] bad signature');
      return new NextResponse('bad signature', { status: 401 });
    }
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  // 2. Meta payload shape:
  // { object: 'instagram', entry: [{ id, time, messaging: [{sender:{id}, recipient:{id}, message:{mid, text}}] }] }
  if (body.object !== 'instagram') {
    return NextResponse.json({ ok: true, ignored: 'not_instagram' });
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];
  let processed = 0;

  for (const entry of entries) {
    const igAccountId = String(entry.id || '');
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const ev of events) {
      // Skip echoes of our own outbound messages
      if (ev.message?.is_echo) continue;
      // Only process inbound text/messages for now
      if (!ev.message || !ev.sender?.id) continue;
      try {
        await handleIncomingMessage(igAccountId, ev);
        processed++;
      } catch (err: any) {
        console.error('[ig-webhook] processing error:', err);
      }
    }
  }

  // Meta REQUIRES 200 within a few seconds; return fast.
  return NextResponse.json({ ok: true, processed });
}

// ─── Core: process one incoming message ──────────────────────────────────────
async function handleIncomingMessage(igAccountId: string, ev: any) {
  const senderId = String(ev.sender.id);
  const messageId = String(ev.message.mid || `${Date.now()}-${senderId}`);
  const messageText = (ev.message.text || '').toString();

  // 1. Look up which brand this account belongs to
  const brandLookup = await sb<
    Array<{ brand_key: string; access_token_encrypted: string | null }>
  >('GET', `/rest/v1/v_ig_account_to_brand?ig_account_id=eq.${igAccountId}&select=brand_key,access_token_encrypted`);
  const brand = brandLookup?.[0];
  if (!brand) {
    // Unknown account — log to inbound table without brand_key so we can debug
    await sb('POST', '/rest/v1/ig_inbound_log', {
      ig_account_id: igAccountId,
      sender_id: senderId,
      message_id: messageId,
      message_text: messageText,
      message_type: 'text',
      raw_payload: ev,
      reply_sent: false,
      reply_error: 'no_brand_for_ig_account_id',
    }).catch(() => {});
    return;
  }
  const brandKey = brand.brand_key;
  const accessToken = brand.access_token_encrypted; // assumed plain or already decrypted upstream

  // 2. Detect first DM for this (brand, sender) pair
  const state = await sb<Array<{ total_dms: number; opted_out: boolean }>>(
    'GET',
    `/rest/v1/ig_sender_state?brand_key=eq.${brandKey}&sender_id=eq.${senderId}&select=total_dms,opted_out`,
  );
  const isFirstDm = !state || state.length === 0;
  const optedOut = !!state?.[0]?.opted_out;

  // 3. Find matching rule
  let matchedRule: any = null;
  if (!optedOut) {
    matchedRule = await findMatchingRule(brandKey, messageText, isFirstDm);
  }

  // 4. Insert inbound log row (idempotent on message_id thanks to UNIQUE constraint)
  const inboundInsert = await sb<Array<{ id: number }>>(
    'POST',
    '/rest/v1/ig_inbound_log',
    {
      brand_key: brandKey,
      ig_account_id: igAccountId,
      sender_id: senderId,
      message_id: messageId,
      message_text: messageText,
      message_type: 'text',
      raw_payload: ev,
      matched_rule_id: matchedRule?.id ?? null,
      matched_intent: matchedRule?.rule_name ?? null,
    },
    { Prefer: 'return=representation,resolution=ignore-duplicates' },
  );
  const inboundId = inboundInsert?.[0]?.id;

  // 5. Upsert sender state
  await sb('POST', '/rest/v1/ig_sender_state', {
    brand_key: brandKey,
    sender_id: senderId,
    last_dm_at: new Date().toISOString(),
    total_dms: (state?.[0]?.total_dms ?? 0) + 1,
  }, { Prefer: 'resolution=merge-duplicates' });

  // 6. Send reply if we have a rule + a token
  if (matchedRule && accessToken && inboundId) {
    try {
      const replyText = matchedRule.response_template;
      await sendIgReply(accessToken, senderId, replyText);
      await sb('PATCH', `/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
        reply_sent: true,
        reply_text: replyText,
        reply_sent_at: new Date().toISOString(),
      });
      // Bump reply counter
      await sb('POST', '/rest/v1/ig_sender_state', {
        brand_key: brandKey,
        sender_id: senderId,
        last_reply_at: new Date().toISOString(),
        total_replies: (state?.[0]?.total_dms ?? 0) + 1, // best-effort, race-tolerant
      }, { Prefer: 'resolution=merge-duplicates' });
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[ig-webhook] reply send failed:', msg);
      await sb('PATCH', `/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
        reply_error: msg.slice(0, 1000),
      }).catch(() => {});
    }
  } else if (!accessToken && inboundId) {
    await sb('PATCH', `/rest/v1/ig_inbound_log?id=eq.${inboundId}`, {
      reply_error: 'no_access_token_for_brand',
    }).catch(() => {});
  }
}

// ─── Match: keyword rules first by priority, fall back to first-DM if applicable ─
async function findMatchingRule(brandKey: string, text: string, isFirstDm: boolean) {
  type Rule = {
    id: number;
    rule_name: string;
    rule_priority: number;
    trigger_type: string;
    keywords: string[];
    response_template: string;
  };
  const rules = await sb<Rule[]>(
    'GET',
    `/rest/v1/ig_auto_reply_rules?brand_key=eq.${brandKey}&select=id,rule_name,rule_priority,trigger_type,keywords,response_template&order=rule_priority.asc`,
  );
  if (!rules || rules.length === 0) return null;

  const lower = text.toLowerCase().trim();

  // 1. Try keyword rules first (sorted by priority asc, so most important wins)
  for (const r of rules) {
    if (r.trigger_type !== 'keyword_dm') continue;
    if (!r.keywords || r.keywords.length === 0) continue;
    for (const kw of r.keywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        return r;
      }
    }
  }

  // 2. If first DM with no keyword match → first_dm rule
  if (isFirstDm) {
    const firstRule = rules.find((r) => r.trigger_type === 'first_dm');
    if (firstRule) return firstRule;
  }

  return null;
}

// ─── Outbound: send a reply via Meta Send API ──────────────────────────────────
async function sendIgReply(accessToken: string, recipientId: string, text: string) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: text.slice(0, 1000) },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`meta_send_failed ${res.status}: ${errText.slice(0, 500)}`);
  }
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────
async function sb<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: any,
  extraHeaders?: Record<string, string>,
): Promise<T | null> {
  if (!SUPABASE_SERVICE_KEY) {
    console.warn('[ig-webhook] SUPABASE_SERVICE_ROLE_KEY not set');
    return null;
  }
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'content-type': 'application/json',
    Prefer: 'return=representation',
    ...(extraHeaders || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`sb_${method}_${res.status}: ${t.slice(0, 300)}`);
  }
  if (method === 'DELETE') return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return null;
  return (await res.json()) as T;
}
