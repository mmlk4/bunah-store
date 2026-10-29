'use strict';
// Payment providers. The store creates a pending donation first, then hands the
// donor to the provider. A donation is marked "paid" ONLY after the server has
// verified the payment with the provider's API (never on the browser's word).
//
// Supported now:
//   PAYMENT_PROVIDER=moyasar  -> Moyasar hosted payment form (mada, Visa/MC, Apple Pay)
//   PAYMENT_PROVIDER=none     -> online payment disabled; donors see bank-transfer details
// Another gateway (HyperPay, Tap, PayTabs ...) can be added by implementing the
// same three functions: isConfigured(), clientConfig(donation), verify(paymentId, donation).

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'none').toLowerCase();

const moyasar = {
  name: 'moyasar',
  isConfigured() {
    return !!(process.env.MOYASAR_PUBLISHABLE_KEY && process.env.MOYASAR_SECRET_KEY);
  },
  clientConfig(donation, baseUrl) {
    return {
      provider: 'moyasar',
      publishableKey: process.env.MOYASAR_PUBLISHABLE_KEY,
      amount: Math.round(donation.total * 100), // halalas
      currency: 'SAR',
      description: 'تبرع لجمعية بُناة - ' + donation.ref,
      callbackUrl: baseUrl + '/payment/callback?ref=' + encodeURIComponent(donation.ref),
      methods: (process.env.MOYASAR_METHODS || 'creditcard,applepay').split(',').map(s => s.trim()).filter(Boolean),
      applePayLabel: process.env.APPLE_PAY_LABEL || 'جمعية بناة',
      metadata: { donation_ref: donation.ref }
    };
  },
  async verify(paymentId, donation) {
    if (!/^[\w-]{6,80}$/.test(String(paymentId || ''))) return { ok: false, reason: 'invalid id' };
    const auth = Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64');
    const res = await fetch('https://api.moyasar.com/v1/payments/' + encodeURIComponent(paymentId), {
      headers: { Authorization: 'Basic ' + auth }
    });
    if (!res.ok) return { ok: false, reason: 'provider http ' + res.status };
    const p = await res.json();
    const expected = Math.round(donation.total * 100);
    const refOk = !p.metadata || !p.metadata.donation_ref || p.metadata.donation_ref === donation.ref;
    if (p.status === 'paid' && p.amount === expected && String(p.currency).toUpperCase() === 'SAR' && refOk) {
      return { ok: true, status: 'paid', raw: { id: p.id, source: p.source && p.source.type, company: p.source && p.source.company } };
    }
    return { ok: false, status: p.status === 'failed' ? 'failed' : 'pending', reason: 'status ' + p.status + ' amount ' + p.amount };
  }
};

const providers = { moyasar };

function active() {
  const p = providers[PROVIDER];
  return p && p.isConfigured() ? p : null;
}

function status() {
  if (PROVIDER === 'none') return { enabled: false, label: 'غير مفعّل (التحويل البنكي فقط)' };
  const p = providers[PROVIDER];
  if (!p) return { enabled: false, label: 'مزوّد غير معروف: ' + PROVIDER };
  if (!p.isConfigured()) return { enabled: false, label: PROVIDER + ' — المفاتيح غير مكتملة في ملف .env' };
  const live = (process.env.MOYASAR_PUBLISHABLE_KEY || '').startsWith('pk_live');
  return { enabled: true, label: PROVIDER + (live ? ' — وضع حقيقي' : ' — وضع تجريبي (test)') };
}

module.exports = { active, status };
