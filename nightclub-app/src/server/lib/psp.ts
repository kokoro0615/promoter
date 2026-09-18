// Payment-service-provider abstraction (PSP seam).
//
// Business rule (non-negotiable): each store receives customer money under
// its own merchant contract. The platform NEVER centrally receives,
// transfers, or settles store funds. Providers modelled here are therefore
// "direct charge" style: the store's merchant account is the charge target
// (provider_account identifies the store's account, not a platform pot).
//
// Implemented providers:
//   devpsp — deterministic dev adapter used by tests/staging dry-runs.
//   stripe — seam only. Real charges need contract credentials
//            (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET + per-store
//            connected account) which are an external blocker; until they
//            exist the provider reports unavailable and every entry point
//            throws E.unavailable() instead of silently degrading.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { E } from './errors.js';
import { uuid } from './crypto.js';

export interface PspCheckout {
  provider: string;
  provider_account: string;
  provider_reference: string;
  checkout_url: string;
}

export interface PspWebhookEvent {
  provider: string;
  provider_account: string;
  provider_reference: string;
  result: 'success' | 'failure';
  // Unique id for integration_events dedup (provider-side event identity).
  external_event_id: string;
}

export interface PaymentProvider {
  key: string;
  available(): boolean;
  // Create a hosted checkout for a store-side charge. Returns the URL the
  // payer opens; the outcome only ever arrives via webhook.
  createCheckout(args: {
    amount_minor: number; currency: string;
    provider_account: string;
  }): Promise<PspCheckout>;
  // Verify the provider signature on a raw webhook payload and normalize it.
  // Throws E.unauthenticated on signature failure, E.invalid on shape errors.
  verifyWebhook(body: unknown): PspWebhookEvent;
}

// ------------------------------------------------------------- devpsp ------
function devSign(ref: string, result: string): string {
  return createHmac('sha256', config.snapshotSecret)
    .update(`devpsp:${ref}:${result}`).digest('hex');
}

export const devPsp: PaymentProvider = {
  key: 'devpsp',
  available: () => true,
  async createCheckout({ provider_account }) {
    const ref = `devpsp_${uuid()}`;
    return {
      provider: 'devpsp', provider_account,
      provider_reference: ref,
      checkout_url: `/devpsp/checkout/${ref}`,
    };
  },
  verifyWebhook(body) {
    const b = body as {
      provider_reference?: string; result?: string;
      signature?: string; account?: string;
    };
    if (!b?.provider_reference || !b.result || !b.signature) {
      throw E.invalid('provider_reference, result, signature required');
    }
    if (!['success', 'failure'].includes(b.result)) throw E.invalid('result');
    const expect = devSign(b.provider_reference, b.result);
    if (expect.length !== b.signature.length
        || !timingSafeEqual(Buffer.from(expect), Buffer.from(b.signature))) {
      throw E.unauthenticated('bad signature');
    }
    return {
      provider: 'devpsp',
      provider_account: b.account ?? 'dev',
      provider_reference: b.provider_reference,
      result: b.result as 'success' | 'failure',
      external_event_id: `${b.provider_reference}:${b.result}`,
    };
  },
};

// ------------------------------------------------------------- stripe ------
// Seam: the dispatch/shape is final; the transport is intentionally absent.
// Required env (staging/prod): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
// Per-store merchant mapping uses payments.provider_account (Stripe
// connected account id, e.g. acct_*) configured per store contract.
const stripePsp: PaymentProvider = {
  key: 'stripe',
  available: () =>
    !!(config.psp.stripeSecretKey && config.psp.stripeWebhookSecret),
  async createCheckout() {
    if (!stripePsp.available()) throw E.unavailable('stripe not configured');
    // Real implementation: POST /v1/checkout/sessions with the store's
    // connected account as the direct-charge destination. Blocked on
    // contract credentials — see docs/execution/blockers.md (B-01/D-05).
    throw E.unavailable('stripe adapter pending contract credentials');
  },
  verifyWebhook() {
    if (!stripePsp.available()) throw E.unavailable('stripe not configured');
    // Real implementation: Stripe-Signature HMAC verification over the raw
    // body, then map checkout.session.completed / .expired / failed.
    throw E.unavailable('stripe webhook pending contract credentials');
  },
};

const providers: Record<string, PaymentProvider> = {
  devpsp: devPsp,
  stripe: stripePsp,
};

export function getProvider(key: string): PaymentProvider {
  const p = providers[key];
  if (!p) throw E.notFound('provider');
  return p;
}
