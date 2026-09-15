import type { PriceBasis } from "./money.js";

export type VendorCategory = "venue" | "photographer";

export const VENDOR_CATEGORIES: VendorCategory[] = ["venue", "photographer"];

export type VendorStatus =
  | "discovered"
  | "no_contact"
  | "approved_for_outreach"
  | "contacted"
  | "replied"
  | "awaiting_info"
  | "quoted"
  | "rejected"
  | "booked"
  | "bounced"
  | "opted_out";

export type ThreadState =
  | "draft"
  | "awaiting_vendor"
  | "needs_agent_reply"
  | "needs_human"
  | "quoted"
  | "closed";

export interface Wedding {
  id: string;
  couple_names: string;
  contact_email: string;
  contact_phone: string | null;
  wedding_date: string | null;
  date_flexible: boolean;
  region: string;
  guest_count_min: number;
  guest_count_max: number;
  budget_min: number | null;
  budget_max: number | null;
  currency: string;
  style_tags: string[];
  must_haves: string[];
  notes: string | null;
  created_at?: string;
}

export interface Vendor {
  id: string;
  wedding_id: string;
  name: string;
  category: VendorCategory;
  contact_email: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  source: string;
  source_ref: string | null;
  rating: number | null;
  status: VendorStatus;
  excluded: boolean;
  exclude_reason: string | null;
}

export interface Thread {
  id: string;
  wedding_id: string;
  vendor_id: string;
  reply_token: string;
  subject: string;
  state: ThreadState;
  turn_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export interface Message {
  id: string;
  thread_id: string;
  direction: "outbound" | "inbound";
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  raw_text: string;
  clean_text: string | null;
  message_id_hdr: string | null;
  in_reply_to: string | null;
  refs: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Quote {
  id: string;
  wedding_id: string;
  vendor_id: string;
  thread_id: string;
  message_id: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  price_basis: PriceBasis;
  price_includes_vat: boolean | null;
  estimated_total_min: number | null;
  estimated_total_max: number | null;
  availability: "available" | "unavailable" | "tentative" | "unknown";
  availability_confirmed: boolean;
  capacity_max: number | null;
  conditions_text: string | null;
  deposit_text: string | null;
  valid_until: string | null;
  confidence_score: number;
  needs_human_review: boolean;
  review_reasons: string[];
  human_reviewed_at: string | null;
  raw_extraction: Record<string, unknown>;
  is_current: boolean;
  created_at: string;
}

export interface OpenQuestion {
  id: string;
  wedding_id: string;
  vendor_id: string | null;
  thread_id: string | null;
  question: string;
  answer: string | null;
  status: "open" | "answered" | "dismissed";
  created_at: string;
}

export interface OutboxItem {
  id: string;
  wedding_id: string;
  thread_id: string;
  to_email: string;
  reply_to: string;
  subject: string;
  body_text: string;
  in_reply_to: string | null;
  refs: string | null;
  kind: "outreach" | "followup" | "manual";
  status: "queued" | "needs_approval" | "sending" | "sent" | "failed" | "cancelled";
  scheduled_at: string;
  attempts: number;
  last_error: string | null;
  dry_run: boolean;
  sent_at: string | null;
}
