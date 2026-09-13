// R3 (docs/files/DECISIONS.md "R3 identification is SerpAPI-first..."):
// photo -> Google visual product search via SerpAPI (engine=google_lens) ->
// normalized product title. This is now the PRIMARY identification signal
// (a confident top visual match's title takes priority over the AI vision
// call's own item_name guess — see identityFromAiScan in
// claude-proxy/index.ts) — Claude's own vision call is retained alongside it
// for structured attributes SerpAPI's reverse-image match can't reliably
// read from a photo (GTIN digits, condition notes, category hints).
//
// MECHANISM NOTE (recorded in DECISIONS.md for review): SerpAPI's Google
// Lens API requires a publicly-fetchable image URL — this sandbox's
// verified, reachable API surface does not confirm a raw-upload/base64
// alternative (serpapi.com itself is unreachable from this sandbox's
// egress, same class of restriction R0 hit with deno.land — see
// soldCompsProvider.ts's Trawl header for the precedent). app.html never
// uploads scan photos to server-side storage today (photos live in client
// IndexedDB only). So this module uploads the photo to a PRIVATE Supabase
// Storage bucket for the duration of one SerpAPI call only, generates a
// short-lived signed URL, calls SerpAPI, and deletes the object in a
// `finally` block regardless of outcome — the photo is never retained past
// that single call.
//
// SerpAPI's own visible prices are SUPPORTING market signal only —
// evidenceType 'other', never verified sold-price evidence, never fed into
// calcProfit/decide/maxBuyPrice directly (see DECISIONS.md's authority-
// boundary note). AI/reverse-image-search remains barred from independently
// establishing an authoritative sold price — unchanged.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"
import { externalCall, ExternalCallError } from "./externalCall.ts"

export interface SerpApiVisualMatch {
  title: string
  source: string | null
  link: string | null
  exactMatch: boolean
  price: number | null
  currency: string | null
  condition: string | null
}

export type SerpApiIdentityResult =
  | { ok: true; itemName: string | null; matches: SerpApiVisualMatch[] }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'STORAGE_UNAVAILABLE' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'MALFORMED_PROVIDER_RESPONSE'; detail: string }

const SERP_API_KEY_ENV_NAME = 'SERP_API_KEY';
const TEMP_BUCKET = 'scan-temp-images';
const SIGNED_URL_TTL_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 15_000;

function extOf(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

function numLike(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Runtime-validates one raw visual_matches entry. Drops (never fabricates)
// anything that fails to parse — a malformed match is simply excluded, not
// coerced into a guessed value.
function parseVisualMatch(raw: unknown, exactMatch = false): SerpApiVisualMatch | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title);
  if (!title) return null;
  const priceObj = (typeof r.price === 'object' && r.price !== null) ? r.price as Record<string, unknown> : null;
  return {
    title,
    source: str(r.source),
    link: str(r.link),
    exactMatch,
    price: priceObj ? numLike(priceObj.extracted_value) : null,
    currency: priceObj ? str(priceObj.currency) : null,
    condition: str(r.condition),
  };
}

function isConfiguredKey(): string | null {
  return Deno.env.get(SERP_API_KEY_ENV_NAME) ?? null;
}

async function callSerpApiLens(imageUrl: string, apiKey: string): Promise<SerpApiIdentityResult> {
  const qs = new URLSearchParams({ engine: 'google_lens', url: imageUrl, api_key: apiKey });
  try {
    const data = await externalCall<Record<string, unknown>>(
      `https://serpapi.com/search.json?${qs.toString()}`,
      { method: 'GET' },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 1, isIdempotent: true },
      (res) => res.json() as Promise<Record<string, unknown>>,
    );
    const status = (data.search_metadata as Record<string, unknown> | undefined)?.status;
    if (status !== 'Success') {
      const errorMsg = str(data.error) ?? `SerpAPI reported status: ${String(status ?? 'unknown')}`;
      return { ok: false, reason: 'PROVIDER_UNAVAILABLE', detail: errorMsg };
    }
    // SerpAPI exposes exact_matches and visual_matches as separate top-level
    // arrays. Preserve that distinction explicitly; an arbitrary field on a
    // visual-match row must never be treated as proof of exact identity.
    const rawExact = Array.isArray(data.exact_matches) ? data.exact_matches as unknown[] : [];
    const rawVisual = Array.isArray(data.visual_matches) ? data.visual_matches as unknown[] : [];
    const matches = [
      ...rawExact.map((row) => parseVisualMatch(row, true)),
      ...rawVisual.map((row) => parseVisualMatch(row, false)),
    ].filter((m): m is SerpApiVisualMatch => m !== null);
    // Exact matches lead; otherwise preserve the provider's visual ranking.
    const itemName = matches.length ? matches[0].title : null;
    return { ok: true, itemName, matches };
  } catch (err) {
    if (err instanceof ExternalCallError) {
      if (err.kind === 'timeout') {
        return { ok: false, reason: 'PROVIDER_TIMEOUT', detail: `SerpAPI request exceeded ${REQUEST_TIMEOUT_MS}ms` };
      }
      if (err.kind === 'parse') {
        return { ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE', detail: typeof err.cause === 'string' ? err.cause : err.message };
      }
      const status = err.status !== undefined ? `${err.status} ` : '';
      return { ok: false, reason: 'PROVIDER_UNAVAILABLE', detail: `SerpAPI ${status}${err.bodyText ?? err.message}`.slice(0, 500) };
    }
    return { ok: false, reason: 'PROVIDER_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Identifies a scanned item via SerpAPI's Google Lens visual product search.
 * Uploads the photo to a private, short-lived Supabase Storage object,
 * generates a signed URL, calls SerpAPI, and ALWAYS deletes the object
 * afterward regardless of outcome (success, failure, or a thrown error) —
 * the photo is never retained past this one call. Returns NOT_CONFIGURED
 * (never a silent skip) when SERP_API_KEY is absent.
 */
export async function identifyViaSerpApi(
  supabase: SupabaseClient,
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<SerpApiIdentityResult> {
  const apiKey = isConfiguredKey();
  if (!apiKey) {
    return { ok: false, reason: 'NOT_CONFIGURED', detail: `${SERP_API_KEY_ENV_NAME} is not configured` };
  }

  const objectPath = `identify/${crypto.randomUUID()}.${extOf(mimeType)}`;
  try {
    const { error: uploadError } = await supabase.storage
      .from(TEMP_BUCKET)
      .upload(objectPath, imageBytes, { contentType: mimeType, upsert: false });
    if (uploadError) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', detail: uploadError.message };
    }

    const { data: signedUrlData, error: signError } = await supabase.storage
      .from(TEMP_BUCKET)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
    if (signError || !signedUrlData?.signedUrl) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', detail: signError?.message ?? 'No signed URL returned' };
    }

    return await callSerpApiLens(signedUrlData.signedUrl, apiKey);
  } catch (err) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    // Best-effort cleanup — never lets a delete failure mask the real result
    // above, and never retries (a leaked temp object is a minor storage
    // cost, not a correctness issue; it lives in a private bucket only this
    // service-role key can list).
    await supabase.storage.from(TEMP_BUCKET).remove([objectPath]).catch(() => {});
  }
}
