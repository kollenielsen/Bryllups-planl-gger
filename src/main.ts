import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { getDb } from "./db/index.js";
import { createApp } from "./http/server.js";
import { startOutboxWorker } from "./services/outbox.js";

await migrate();
const db = await getDb();

const app = createApp();
app.listen(config.port, () => {
  console.log(`Bryllupsplanlægger kører på ${config.baseUrl} (db: ${db.kind})`);
  console.log(
    `Afsendelse: ${config.sending.dryRun ? "TØR-KØRSEL (intet sendes)" : `LIVE via ${config.email.provider}`}` +
      ` · maks ${config.sending.maxPerHour}/time · godkendelse ${config.sending.requireApproval ? "påkrævet" : "fra"}`,
  );
  if (!config.anthropic.apiKey) {
    console.warn("ANTHROPIC_API_KEY er ikke sat — udkast og udtræk vil fejle.");
  }
  startOutboxWorker();
});
