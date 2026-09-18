import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { getDb } from "./db/index.js";
import { createApp } from "./http/server.js";
import { startOutboxWorker } from "./services/outbox.js";

// Fejl hellere ved opstart end ved første request: en glemt APP_PASSWORD i
// produktion ville udstille dashboardet og API'et, og et 503 pr. request
// er en dårligere måde at opdage det på end en server der ikke starter.
if (config.env === "production" && !config.auth.password) {
  console.error(
    "APP_PASSWORD er ikke sat. Dashboardet og API'et ville stå åbent — starter ikke.",
  );
  process.exit(1);
}

await migrate();
const db = await getDb();

const app = createApp();
app.listen(config.port, () => {
  console.log(`Bryllupsplanlægger kører på ${config.baseUrl} (db: ${db.kind})`);
  console.log(
    `Afsendelse: ${config.sending.dryRun ? "TØR-KØRSEL (intet sendes)" : `LIVE via ${config.email.provider}`}` +
      ` · maks ${config.sending.maxPerHour}/time · godkendelse ${config.sending.requireApproval ? "påkrævet" : "fra"}`,
  );
  console.log(
    `Adgang: ${config.auth.password ? `adgangskode kræves (bruger ${config.auth.user})` : "ÅBEN — APP_PASSWORD er ikke sat"}`,
  );
  if (!config.anthropic.apiKey) {
    console.warn("ANTHROPIC_API_KEY er ikke sat — udkast og udtræk vil fejle.");
  }
  startOutboxWorker();
});
