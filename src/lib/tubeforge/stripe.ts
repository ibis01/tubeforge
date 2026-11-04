// Minimal Stripe REST client — the checkout + customer-portal door.
//
// The webhook (billing.ts) verifies Stripe's signatures with Web Crypto and
// parses events by hand — this module stays in the same house: NO stripe SDK
// dependency, just `fetch` against api.stripe.com with form-encoded bodies
// (the only format Stripe's REST API accepts). Both money-moving routes
// (POST /api/billing/checkout, POST /api/billing/portal) go through here.
//
// Activation is purely env-driven (the Stage 3 driver pattern — SMTP, S3,
// the shared voice server):
//   TUBEFORGE_STRIPE_SECRET_KEY       — the API key; WITHOUT it both routes
//                                       fail closed (503), never a fake
//                                       success.
//   TUBEFORGE_STRIPE_PRICE_CREATOR    — the Stripe Price id for the Creator
//   TUBEFORGE_STRIPE_PRICE_STUDIO     — and Studio plans (mode=subscription
//                                       needs a recurring Price id).
//
// MASTER_PLAN's pricing law is honored by construction: this module never
// knows a NUMBER — the plan card never displays a price; the Stripe-hosted
// checkout page (built from the Price objects) is the only place money is
// named. When real costs land, only the Stripe dashboard changes.

const STRIPE_API = "https://api.stripe.com/v1";

/** The paid tiers a checkout can lead to, and the env that must hold their
 *  recurring Price id. Starter is deliberately absent — it is the free
 *  fallback, nothing to buy. */
export const CHECKOUT_TIERS = ["creator", "studio"] as const;
export type CheckoutTier = (typeof CHECKOUT_TIERS)[number];

export function isCheckoutTier(tier: string): tier is CheckoutTier {
  return (CHECKOUT_TIERS as readonly string[]).includes(tier);
}

function priceEnvFor(tier: CheckoutTier): string | null {
  const raw =
    tier === "creator"
      ? process.env.TUBEFORGE_STRIPE_PRICE_CREATOR
      : process.env.TUBEFORGE_STRIPE_PRICE_STUDIO;
  const id = (raw ?? "").trim();
  return id || null;
}

export interface StripeGate {
  secret: string | null;
  prices: Partial<Record<CheckoutTier, string>>;
}

/** Everything the two routes need to know about this deployment's Stripe
 *  wiring — booleans reach the plan card so it can disable its buttons with
 *  an honest hint instead of dead ends. */
export function stripeGate(): StripeGate {
  const secret = (process.env.TUBEFORGE_STRIPE_SECRET_KEY ?? "").trim() || null;
  const prices: Partial<Record<CheckoutTier, string>> = {};
  if (secret) {
    for (const tier of CHECKOUT_TIERS) {
      const id = priceEnvFor(tier);
      if (id) prices[tier] = id;
    }
  }
  return { secret, prices };
}

/** Is checkout fully wired for this tier (key + price)? */
export function checkoutReady(tier: CheckoutTier): boolean {
  const { secret, prices } = stripeGate();
  return Boolean(secret && prices[tier]);
}

/** Is the customer portal wired (key set)? The portal itself is configured
 *  in the Stripe dashboard; the API key is the only app-side requirement. */
export function portalReady(): boolean {
  return Boolean(stripeGate().secret);
}

export interface StripeCallResult {
  ok: boolean;
  status: number;
  /** Stripe's human-readable message on failure — safe to show (never
   *  contains the key; Stripe echoes request ids, not credentials). */
  error?: string;
  /** The parsed response body on success (checkout/portal session objects). */
  data?: Record<string, unknown>;
}

/** POST a form-encoded request to Stripe's REST API. 15 s timeout — Stripe
 *  is normally sub-second; hanging the settings page on a dead upstream is
 *  worse than a clear timeout. Errors are normalized, never thrown. */
export async function stripeCreate(
  path: string,
  params: Record<string, string>,
  secret: string,
): Promise<StripeCallResult> {
  const body = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Stripe pins API behavior by version; omitting the header uses the
        // account default — the webhook parser reads only fields that have
        // been stable across versions (id/customer/subscription/metadata).
        "Stripe-Version": "2024-06-20",
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        status: res.status,
        error:
          (typeof err.message === "string" && err.message) ||
          `Stripe responded ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data: json };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Stripe did not answer within 15 s"
          : err.message
        : String(err);
    return { ok: false, status: 502, error: `Stripe request failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The checkout session params for one tier upgrade. client_reference_id
 *  carries OUR userId — the webhook's checkout.session.completed handler
 *  reads it back (billing.ts) to bind the Subscription row; planTier rides
 *  in metadata because the handler needs the tier before the invoice
 *  events arrive. */
export function checkoutParams(opts: {
  priceId: string;
  userId: string;
  tier: CheckoutTier;
  successUrl: string;
  cancelUrl: string;
}): Record<string, string> {
  return {
    mode: "subscription",
    "line_items[0][price]": opts.priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: opts.userId,
    "metadata[planTier]": opts.tier,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    // The customer must be able to pay for a DIFFERENT plan than the one
    // their (possibly canceled) subscription still points at.
    "subscription_data[metadata][planTier]": opts.tier,
  };
}

/** The customer portal session params — return_url lands back on the app. */
export function portalParams(opts: {
  customerId: string;
  returnUrl: string;
}): Record<string, string> {
  return {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  };
}
