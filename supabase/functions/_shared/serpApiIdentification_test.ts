// R3: identifyViaSerpApi (docs/files/DECISIONS.md "R3 identification is
// SerpAPI-first..."). Covers: NOT_CONFIGURED when SERP_API_KEY is absent
// (never a silent skip), the happy path (upload -> sign -> call -> parse ->
// ALWAYS delete), and that a temp-object delete always fires even when the
// SerpAPI call itself fails — the mechanism note's "never retained past
// this one call" guarantee.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { identifyViaSerpApi } from "./serpApiIdentification.ts";

const ENV_NAME = 'SERP_API_KEY';
const originalFetch = globalThis.fetch;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prior[k] = Deno.env.get(k);
    if (vars[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, vars[k]!);
  }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, prior[k]!);
    }
  });
}

// Minimal fake of the Supabase storage surface identifyViaSerpApi actually
// calls (upload / createSignedUrl / remove) — records calls so the "always
// delete" guarantee can be asserted directly.
function makeFakeSupabase(opts: { uploadError?: { message: string }; signError?: { message: string } } = {}) {
  const calls = { uploaded: [] as string[], removed: [] as string[] };
  return {
    calls,
    // deno-lint-ignore no-explicit-any
    storage: {
      from(_bucket: string) {
        return {
          // deno-lint-ignore no-explicit-any
          async upload(path: string, _bytes: unknown, _opts: unknown) {
            calls.uploaded.push(path);
            if (opts.uploadError) return { data: null, error: opts.uploadError };
            return { data: { path }, error: null };
          },
          async createSignedUrl(path: string, _ttl: number) {
            if (opts.signError) return { data: null, error: opts.signError };
            return { data: { signedUrl: `https://storage.test/${path}?token=fake` }, error: null };
          },
          async remove(paths: string[]) {
            calls.removed.push(...paths);
            return { data: null, error: null };
          },
        };
      },
      // deno-lint-ignore no-explicit-any
    } as any,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function mockSerpApiFetch(handler: () => Response | Promise<Response>): typeof fetch {
  return (() => Promise.resolve(handler())) as typeof fetch;
}

Deno.test('identifyViaSerpApi: NOT_CONFIGURED when SERP_API_KEY is absent — never a silent skip', async () => {
  const result = await withEnv({ [ENV_NAME]: undefined }, () =>
    identifyViaSerpApi(makeFakeSupabase(), new Uint8Array([1, 2, 3]), 'image/jpeg'));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'NOT_CONFIGURED');
});

Deno.test('identifyViaSerpApi: happy path uploads, signs, calls SerpAPI, parses visual_matches, and always deletes the temp object', async () => {
  globalThis.fetch = mockSerpApiFetch(() => new Response(JSON.stringify({
    search_metadata: { status: 'Success' },
    visual_matches: [
      { title: 'Minolta X-700 35mm SLR Film Camera', source: 'KEH Camera', link: 'https://example.com/1', price: { extracted_value: 85, currency: 'USD' }, condition: 'Used' },
      { title: 'Minolta X-700 Body Only', source: 'eBay', link: 'https://example.com/2' },
    ],
  }), { status: 200 }));
  const fake = makeFakeSupabase();
  try {
    const result = await withEnv({ [ENV_NAME]: 'test-key' }, () =>
      identifyViaSerpApi(fake, new Uint8Array([1, 2, 3]), 'image/jpeg'));
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.itemName, 'Minolta X-700 35mm SLR Film Camera');
      assertEquals(result.matches.length, 2);
      assertEquals(result.matches[0].price, 85);
      assertEquals(result.matches[0].exactMatch, false);
    }
    assertEquals(fake.calls.uploaded.length, 1);
    assertEquals(fake.calls.removed.length, 1);
    assertEquals(fake.calls.uploaded[0], fake.calls.removed[0]);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('identifyViaSerpApi: top-level exact_matches are marked exact and take precedence', async () => {
  globalThis.fetch = mockSerpApiFetch(() => new Response(JSON.stringify({
    search_metadata: { status: 'Success' },
    exact_matches: [{ title: 'GE 7-2887 Superadio III' }],
    visual_matches: [{ title: 'Generic transistor radio' }],
  }), { status: 200 }));
  const fake = makeFakeSupabase();
  try {
    const result = await withEnv({ [ENV_NAME]: 'test-key' }, () =>
      identifyViaSerpApi(fake, new Uint8Array([1, 2, 3]), 'image/jpeg'));
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.itemName, 'GE 7-2887 Superadio III');
      assertEquals(result.matches[0].exactMatch, true);
      assertEquals(result.matches[1].exactMatch, false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('identifyViaSerpApi: a SerpAPI error status is reported, never fabricated as a match — and the temp object is still deleted', async () => {
  globalThis.fetch = mockSerpApiFetch(() => new Response(JSON.stringify({
    search_metadata: { status: 'Error' }, error: 'Google hasn\'t returned any results for this query.',
  }), { status: 200 }));
  const fake = makeFakeSupabase();
  try {
    const result = await withEnv({ [ENV_NAME]: 'test-key' }, () =>
      identifyViaSerpApi(fake, new Uint8Array([1, 2, 3]), 'image/jpeg'));
    assertEquals(result.ok, false);
    assertEquals(fake.calls.removed.length, 1); // cleanup still happened
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('identifyViaSerpApi: a storage upload failure is reported as STORAGE_UNAVAILABLE, never silently swallowed', async () => {
  const fake = makeFakeSupabase({ uploadError: { message: 'bucket not found' } });
  const result = await withEnv({ [ENV_NAME]: 'test-key' }, () =>
    identifyViaSerpApi(fake, new Uint8Array([1, 2, 3]), 'image/jpeg'));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'STORAGE_UNAVAILABLE');
});

Deno.test('identifyViaSerpApi: malformed visual_matches entries are dropped, never coerced into a fabricated match', async () => {
  globalThis.fetch = mockSerpApiFetch(() => new Response(JSON.stringify({
    search_metadata: { status: 'Success' },
    visual_matches: [{ no_title_field: true }, { title: 'Real Match', price: 'not-an-object' }],
  }), { status: 200 }));
  const fake = makeFakeSupabase();
  try {
    const result = await withEnv({ [ENV_NAME]: 'test-key' }, () =>
      identifyViaSerpApi(fake, new Uint8Array([1, 2, 3]), 'image/jpeg'));
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.matches.length, 1); // the entry with no title is dropped
      assertEquals(result.itemName, 'Real Match');
    }
  } finally { globalThis.fetch = originalFetch; }
});
