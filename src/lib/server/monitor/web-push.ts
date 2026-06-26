import { db } from '../db/index.js';
import { push_subscriptions, vapid_keys } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Web Push transport for host-monitor alerts.
//
// Lazy-imports `web-push` so installs without the dep (e.g. a future
// `--minimal` flag) don't crash at boot. Skip everything cleanly when:
//   - BERTH_CONTROL_MONITOR_PUSH_CONTACT is unset (VAPID requires a
//     subject), OR
//   - the web-push module isn't installed, OR
//   - no subscriptions have been recorded yet.
//
// Privacy/security:
//   - The push CONTACT (mailto:/https:) comes from .env, not source. It's
//     required by the VAPID spec as a way for push providers to reach the
//     server operator if there's abuse. Set it to a mailto: or URL you
//     control.
//   - VAPID private key never logged. Public key is shared with browsers
//     (that's the whole point of "public" key crypto).
//   - Subscription endpoints are treated as credentials — never logged in
//     plain, never returned in API listings.

interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

let cachedVapid: VapidKeyPair | null = null;
let webPushModule: typeof import('web-push') | null = null;
let pushConfigured = false;
let lastInitError: string | null = null;

/** Idempotent boot. Generates a VAPID keypair on first call if none exists,
 *  loads web-push, configures it with the env-supplied contact. Failures are
 *  swallowed so the rest of the collector keeps running. Returns true if
 *  push is usable. */
export async function ensureWebPushReady(): Promise<boolean> {
  if (pushConfigured) return true;
  const contact = process.env.BERTH_CONTROL_MONITOR_PUSH_CONTACT;
  if (!contact || contact.trim() === '') {
    lastInitError =
      'BERTH_CONTROL_MONITOR_PUSH_CONTACT not set; push notifications disabled';
    return false;
  }
  if (!isValidContact(contact)) {
    lastInitError = `BERTH_CONTROL_MONITOR_PUSH_CONTACT must be a mailto: or http(s)://, got ${contact.slice(0, 40)}`;
    return false;
  }

  if (!webPushModule) {
    try {
      webPushModule = await import('web-push');
    } catch {
      lastInitError = "web-push module not installed; run `bun add web-push`";
      return false;
    }
  }

  // Load existing keys or generate a new pair.
  const existing = db.select().from(vapid_keys).where(eq(vapid_keys.id, 1)).get();
  if (existing) {
    cachedVapid = { publicKey: existing.public_key, privateKey: existing.private_key };
  } else {
    const wp = webPushModule.default ?? webPushModule;
    const keys = wp.generateVAPIDKeys();
    db.insert(vapid_keys)
      .values({
        id: 1,
        public_key: keys.publicKey,
        private_key: keys.privateKey,
        created_at: new Date()
      })
      .run();
    cachedVapid = keys;
  }

  const wp = webPushModule.default ?? webPushModule;
  wp.setVapidDetails(contact, cachedVapid.publicKey, cachedVapid.privateKey);
  pushConfigured = true;
  return true;
}

function isValidContact(v: string): boolean {
  return /^mailto:.+@.+\..+/.test(v) || /^https?:\/\/.+/.test(v);
}

/** Returns the public VAPID key for client-side subscription, or null if
 *  push isn't usable in this deployment. */
export async function getVapidPublicKey(): Promise<string | null> {
  const ok = await ensureWebPushReady();
  return ok && cachedVapid ? cachedVapid.publicKey : null;
}

/** Status used by the UI to render "Enable notifications" vs "Push not
 *  configured — set BERTH_CONTROL_MONITOR_PUSH_CONTACT". */
export function pushStatus(): { ready: boolean; reason: string | null } {
  return { ready: pushConfigured, reason: pushConfigured ? null : lastInitError };
}

/** Send a notification payload to every saved subscription. Subscriptions
 *  that return 404/410 are GONE (the user revoked or the push service
 *  rotated) and get pruned from the DB. Other errors are swallowed and
 *  counted; we don't want one borked subscriber to break alert delivery
 *  for the rest. */
export async function broadcastNotification(payload: {
  title: string;
  body: string;
  tag?: string;
}): Promise<{ sent: number; pruned: number; failed: number }> {
  if (!(await ensureWebPushReady())) return { sent: 0, pruned: 0, failed: 0 };
  const wp = webPushModule!.default ?? webPushModule!;
  const subs = db.select().from(push_subscriptions).all();
  if (subs.length === 0) return { sent: 0, pruned: 0, failed: 0 };

  let sent = 0;
  let pruned = 0;
  let failed = 0;

  for (const s of subs) {
    try {
      await wp.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh_key, auth: s.auth_key }
        },
        JSON.stringify(payload)
      );
      sent++;
    } catch (e) {
      // Type from web-push: statusCode on the thrown error.
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        db.delete(push_subscriptions).where(eq(push_subscriptions.id, s.id)).run();
        pruned++;
      } else {
        failed++;
      }
    }
  }
  return { sent, pruned, failed };
}

/** Subscription CRUD used by the API endpoints. Pulled out to centralise
 *  the "treat endpoint as a credential" rule (no logging of full URLs,
 *  prefix-only in any visible string). */
export function recordSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): { id: string } {
  // Use endpoint hash as the stable id so re-subscribing the same browser
  // updates rather than creating a duplicate.
  const id = simpleHash(input.endpoint);
  const existing = db
    .select()
    .from(push_subscriptions)
    .where(eq(push_subscriptions.endpoint, input.endpoint))
    .get();
  if (existing) {
    db.update(push_subscriptions)
      .set({
        p256dh_key: input.p256dh,
        auth_key: input.auth,
        user_agent: input.userAgent ?? existing.user_agent
      })
      .where(eq(push_subscriptions.id, existing.id))
      .run();
    return { id: existing.id };
  }
  db.insert(push_subscriptions)
    .values({
      id,
      endpoint: input.endpoint,
      p256dh_key: input.p256dh,
      auth_key: input.auth,
      user_agent: input.userAgent ?? null,
      created_at: new Date()
    })
    .run();
  return { id };
}

/** Tiny non-cryptographic hash — only used for naming rows; collisions are
 *  fine because the endpoint itself is UNIQUE in the schema and dedup logic
 *  in recordSubscription handles both insert + update. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `sub_${(h >>> 0).toString(36)}`;
}
