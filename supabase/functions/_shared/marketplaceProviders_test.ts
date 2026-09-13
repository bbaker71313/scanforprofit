import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapEbayResultToEvidence } from "./marketplaceProviders.ts";
import type { MarketDataSuccess } from "./marketData.ts";

function resultWithEvidence(options: { soldCount: number; active: boolean }): MarketDataSuccess {
  return {
    ok: true,
    identity: {
      itemName: 'GE Superadio III', brand: 'General Electric', model: '7-2887', variant: null,
      gtin: null, gtinKind: null, manufacturerPartNumber: null, modelFamilyHint: null,
      likelyEbayCategory: 'Portable radios', categoryHints: ['Portable radios'], conditionHints: 'used',
      unresolvedAttributes: [], identityConfidence: 95, evidenceUsed: ['model_number'],
      normalizedSearchTerms: ['general electric 7 2887'], providerId: 'text-input',
    },
    catalogMatch: null,
    category: null,
    soldProviderId: 'sold-comps.com',
    metrics: {
      compMatchPrecision: 'exact_model',
      soldPriceStats: {
        compCount: options.soldCount, excludedBestOfferCount: 0,
        medianSoldPrice: options.soldCount ? 38.99 : null,
        averageSoldPrice: options.soldCount ? 38.99 : null,
        soldPriceLow: options.soldCount ? 29.99 : null,
        soldPriceHigh: options.soldCount ? 49.99 : null,
        evidenceQuality: options.soldCount >= 3 || options.active ? 'strong' : 'none',
      },
      activeMarketEvidence: options.active ? {
        totalActiveResultCount: 5, sampledCount: 5, retainedCount: 5,
        sampledListings: [], retainedListings: [], askingPriceLow: 35, askingPriceHigh: 55,
      } : null,
      turnover: null,
      sellThroughRate: null,
      demandLevel: null,
    },
  };
}

Deno.test('eBay source label does not claim active evidence when Browse found none', () => {
  const mapped = mapEbayResultToEvidence(resultWithEvidence({ soldCount: 6, active: false }));
  if (!mapped.ok) throw new Error('expected mapped evidence');
  assertEquals(mapped.evidence.sourceName, 'eBay sold listings (sold-comps.com)');
});

Deno.test('eBay source label names both evidence sources only when both are present', () => {
  const mapped = mapEbayResultToEvidence(resultWithEvidence({ soldCount: 6, active: true }));
  if (!mapped.ok) throw new Error('expected mapped evidence');
  assertEquals(mapped.evidence.sourceName, 'eBay sold listings (sold-comps.com) + active market data');
});

Deno.test('eBay active-only source label remains explicit', () => {
  const mapped = mapEbayResultToEvidence(resultWithEvidence({ soldCount: 0, active: true }));
  if (!mapped.ok) throw new Error('expected mapped evidence');
  assertEquals(mapped.evidence.sourceName, 'eBay active market data');
});
