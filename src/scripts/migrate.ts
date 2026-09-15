import { migrate } from "../db/migrate.js";
import { getDb } from "../db/index.js";

await migrate();
const db = await getDb();
console.log(`Migration OK (${db.kind}).`);
await db.close();
