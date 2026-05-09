'use client';

import { useState } from 'react';

export default function LeadForm({
  brandKey,
  intentPath,
  intentName,
  brandPrimary,
}: {
  brandKey: string;
  intentPath: string;
  intentName: string;
  brandPrimary: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      brand_key: brandKey,
      intent_path: intentPath,
      intent_name: intentName,
      first_name: fd.get('first_name'),
      last_name: fd.get('last_name'),
      email: fd.get('email'),
      phone: fd.get('phone'),
      message: fd.get('message'),
      meta: {
        ts: new Date().toISOString(),
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        ref: typeof document !== 'undefined' ? document.referrer : null,
      },
    };
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Submit failed');
      }
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="success">
        <strong>Got it.</strong>
        <div style={{ marginTop: 6 }}>
          We'll route this within 24 hours. Watch your email/IG.
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="row-2">
        <div>
          <label>First name</label>
          <input name="first_name" required autoComplete="given-name" />
        </div>
        <div>
          <label>Last name</label>
          <input name="last_name" required autoComplete="family-name" />
        </div>
      </div>
      <div className="row-2">
        <div>
          <label>Email</label>
          <input name="email" type="email" required autoComplete="email" />
        </div>
        <div>
          <label>Phone</label>
          <input name="phone" type="tel" autoComplete="tel" />
        </div>
      </div>
      <div>
        <label>Message / details</label>
        <textarea name="message" rows={4} placeholder="Anything we should know?" />
      </div>
      <button className="cta" type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Submit'}
      </button>
      {error ? <div className="error">{error}</div> : null}
      <div className="smallnote">
        By submitting you agree to be contacted by KHG via email or DM. We never sell or share your info.
      </div>
    </form>
  );
}
