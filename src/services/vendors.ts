import { exec, logEvent, many, newId, one } from "./repo.js";
import type { Vendor, VendorCategory, VendorStatus } from "../domain/types.js";

export interface VendorInput {
  wedding_id: string;
  name: string;
  category: VendorCategory;
  contact_email?: string | null;
  website?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  source?: string;
  source_ref?: string | null;
  rating?: number | null;
}

export async function upsertVendor(input: VendorInput): Promise<Vendor> {
  const email = normalizeEmail(input.contact_email);
  const status: VendorStatus = email ? "discovered" : "no_contact";

  if (email) {
    const existing = await one<Vendor>(
      `SELECT * FROM vendors WHERE wedding_id = $1 AND category = $2 AND contact_email = $3`,
      [input.wedding_id, input.category, email],
    );
    if (existing) return existing;
  } else {
    const existing = await one<Vendor>(
      `SELECT * FROM vendors WHERE wedding_id = $1 AND category = $2 AND lower(name) = lower($3)`,
      [input.wedding_id, input.category, input.name],
    );
    if (existing) return existing;
  }

  const id = newId("ven");
  await exec(
    `INSERT INTO vendors (id, wedding_id, name, category, contact_email, website, phone,
       address, city, source, source_ref, rating, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      input.wedding_id,
      input.name.trim(),
      input.category,
      email,
      input.website ?? null,
      input.phone ?? null,
      input.address ?? null,
      input.city ?? null,
      input.source ?? "manual",
      input.source_ref ?? null,
      input.rating ?? null,
      status,
    ],
  );
  await logEvent({
    weddingId: input.wedding_id,
    vendorId: id,
    type: "vendor.discovered",
    payload: { name: input.name, source: input.source ?? "manual", hasEmail: Boolean(email) },
  });
  const created = await getVendor(id);
  if (!created) throw new Error("Leverandør kunne ikke oprettes.");
  return created;
}

export async function getVendor(id: string): Promise<Vendor | null> {
  return one<Vendor>(`SELECT * FROM vendors WHERE id = $1`, [id]);
}

export async function listVendors(
  weddingId: string,
  opts: { category?: VendorCategory } = {},
): Promise<Vendor[]> {
  return opts.category
    ? many<Vendor>(
        `SELECT * FROM vendors WHERE wedding_id = $1 AND category = $2 ORDER BY name`,
        [weddingId, opts.category],
      )
    : many<Vendor>(`SELECT * FROM vendors WHERE wedding_id = $1 ORDER BY category, name`, [
        weddingId,
      ]);
}

export async function setVendorStatus(
  vendorId: string,
  status: VendorStatus,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const vendor = await getVendor(vendorId);
  if (!vendor) return;
  // Booket og frameldt er endestationer; en sen mail må ikke rulle dem tilbage.
  if (vendor.status === "booked" || vendor.status === "opted_out") return;
  await exec(`UPDATE vendors SET status = $2, updated_at = now() WHERE id = $1`, [vendorId, status]);
  await logEvent({
    weddingId: vendor.wedding_id,
    vendorId,
    type: "vendor.status",
    payload: { from: vendor.status, to: status, ...payload },
  });
}

export async function excludeVendor(vendorId: string, reason: string): Promise<void> {
  await exec(
    `UPDATE vendors SET excluded = TRUE, exclude_reason = $2, updated_at = now() WHERE id = $1`,
    [vendorId, reason],
  );
}

export async function suppress(email: string, reason: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await exec(
    `INSERT INTO suppressions (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`,
    [normalized, reason],
  );
}

export async function isSuppressed(email: string | null): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const row = await one<{ email: string }>(`SELECT email FROM suppressions WHERE email = $1`, [
    normalized,
  ]);
  return Boolean(row);
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) ? trimmed : null;
}
