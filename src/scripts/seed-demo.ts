import { migrate } from "../db/migrate.js";
import { getDb } from "../db/index.js";
import { createWedding } from "../services/weddings.js";
import { discoverVendors } from "../discovery/index.js";
import { config } from "../config.js";

await migrate();

const wedding = await createWedding({
  couple_names: "Mia og Jonas",
  contact_email: "mia.og.jonas@example.dk",
  contact_phone: "20 11 22 33",
  wedding_date: "2026-06-12",
  region: "Sjælland",
  guest_count_min: 60,
  guest_count_max: 90,
  budget_min: 150000,
  budget_max: 250000,
  style_tags: ["rustik", "udendørs vielse", "lange borde"],
  must_haves: ["plads til 90 siddende", "egen catering tilladt", "overnatning i nærheden"],
  notes: "Vielsen er i kirken kl. 14. Festen begynder ca. kl. 16.",
});

const venues = await discoverVendors({
  weddingId: wedding.id,
  category: "venue",
  region: wedding.region,
});
const photographers = await discoverVendors({
  weddingId: wedding.id,
  category: "photographer",
  region: wedding.region,
});

console.log(`Oprettet demo-bryllup ${wedding.id} (${wedding.couple_names}).`);
console.log(`  ${venues.length} lokaler og ${photographers.length} fotografer fundet via '${config.discovery.provider}'.`);
console.log(`Start serveren med 'npm run dev' og åbn ${config.baseUrl}.`);

await (await getDb()).close();
