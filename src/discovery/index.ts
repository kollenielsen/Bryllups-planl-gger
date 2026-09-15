import seed from "./seed.json" with { type: "json" };
import { config } from "../config.js";
import { findContactEmail } from "./emailFinder.js";
import { upsertVendor } from "../services/vendors.js";
import type { Vendor, VendorCategory } from "../domain/types.js";

export interface Candidate {
  name: string;
  category: VendorCategory;
  contact_email: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  rating: number | null;
  source: string;
  source_ref: string | null;
}

interface SeedVendor {
  name: string;
  category: string;
  region: string;
  city: string;
  contact_email: string;
  website: string;
  rating: number;
}

const CATEGORY_QUERY: Record<VendorCategory, string> = {
  venue: "bryllupslokale festlokale bryllupsgård",
  photographer: "bryllupsfotograf",
};

export async function discoverVendors(input: {
  weddingId: string;
  category: VendorCategory;
  region: string;
  limit?: number;
}): Promise<Vendor[]> {
  const limit = input.limit ?? config.discovery.maxResults;
  const candidates =
    config.discovery.provider === "places" && config.discovery.googlePlacesKey
      ? await searchPlaces(input.category, input.region, limit)
      : searchSeed(input.category, input.region, limit);

  const vendors: Vendor[] = [];
  for (const c of candidates) {
    vendors.push(
      await upsertVendor({
        wedding_id: input.weddingId,
        name: c.name,
        category: c.category,
        contact_email: c.contact_email,
        website: c.website,
        phone: c.phone,
        address: c.address,
        city: c.city,
        source: c.source,
        source_ref: c.source_ref,
        rating: c.rating,
      }),
    );
  }
  return vendors;
}

export function searchSeed(category: VendorCategory, region: string, limit: number): Candidate[] {
  const all = (seed.vendors as SeedVendor[]).filter((v) => v.category === category);
  const needle = region.trim().toLowerCase();
  const inRegion = all.filter(
    (v) => v.region.toLowerCase().includes(needle) || v.city.toLowerCase().includes(needle),
  );
  const chosen = inRegion.length > 0 ? inRegion : all;
  return chosen.slice(0, limit).map((v) => ({
    name: v.name,
    category,
    contact_email: v.contact_email,
    website: v.website,
    phone: null,
    address: null,
    city: v.city,
    rating: v.rating,
    source: "demo",
    source_ref: null,
  }));
}

/**
 * Google Places (New) Text Search. Places returnerer ikke mailadresser, så
 * hjemmesiden skrabes bagefter. Leverandører uden fundet mail beholdes med
 * contact_email = null og status "no_contact".
 */
export async function searchPlaces(
  category: VendorCategory,
  region: string,
  limit: number,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<Candidate[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": config.discovery.googlePlacesKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({
      textQuery: `${CATEGORY_QUERY[category]} ${region} Danmark`,
      languageCode: "da",
      regionCode: "DK",
      maxResultCount: Math.min(limit, 20),
    }),
  });

  if (!res.ok) {
    throw new Error(`Google Places svarede ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { places?: PlacesResult[] };
  const places = data.places ?? [];
  const out: Candidate[] = [];

  for (const p of places.slice(0, limit)) {
    const website = p.websiteUri ?? null;
    let email: string | null = null;
    if (website && config.discovery.scrapeEmails) {
      email = await findContactEmail(website).catch(() => null);
    }
    out.push({
      name: p.displayName?.text ?? "Ukendt",
      category,
      contact_email: email,
      website,
      phone: p.nationalPhoneNumber ?? null,
      address: p.formattedAddress ?? null,
      city: cityFromAddress(p.formattedAddress ?? null),
      rating: p.rating ?? null,
      source: "places",
      source_ref: p.id ?? null,
    });
  }
  return out;
}

interface PlacesResult {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
}

/** Dansk adresseformat: "Vej 1, 4000 Roskilde, Danmark". */
export function cityFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = /\b\d{4}\s+([^,]+)/.exec(address);
  return m?.[1]?.trim() ?? null;
}
