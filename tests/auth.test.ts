import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { config } from "../src/config.js";
import { createApp } from "../src/http/server.js";
import { freshDb } from "./helpers.js";

let server: Server;
let base: string;
let originalPassword: string;
let originalUser: string;
let originalEnv: string;

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

beforeEach(async () => {
  await freshDb();
  originalPassword = config.auth.password;
  originalUser = config.auth.user;
  originalEnv = config.env;
  config.auth.password = "hemmelig";
  config.auth.user = "bryllup";

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Ingen port.");
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  config.auth.password = originalPassword;
  config.auth.user = originalUser;
  config.env = originalEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("adgangskode på dashboard og API", () => {
  it("afviser API-kald uden kode", async () => {
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`);
    expect(res.status).toBe(401);
    // Uden denne header spørger browseren aldrig brugeren om koden.
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
  });

  it("afviser forkert kode", async () => {
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`, {
      headers: { authorization: basic("bryllup", "forkert") },
    });
    expect(res.status).toBe(401);
  });

  it("afviser rigtig kode under forkert brugernavn", async () => {
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`, {
      headers: { authorization: basic("nogen-anden", "hemmelig") },
    });
    expect(res.status).toBe(401);
  });

  it("lukker ind med rigtig kode", async () => {
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`, {
      headers: { authorization: basic("bryllup", "hemmelig") },
    });
    expect(res.status).not.toBe(401);
  });

  it("beskytter også den statiske frontend", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(401);
  });
});

describe("det der bevidst står åbent", () => {
  it("lader /health være — ellers kan ingen platform sundhedstjekke appen", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it("lader webhooken være — mailudbyderen kan ikke sende Basic Auth", async () => {
    // Webhooken har sin egen hemmelighed. Den skal afvise på sine egne
    // præmisser, ikke på manglende Basic Auth.
    const res = await fetch(`${base}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });
});

describe("når APP_PASSWORD ikke er sat", () => {
  it("er åben lokalt, så udvikling ikke kræver opsætning", async () => {
    config.auth.password = "";
    config.env = "development";
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it("nægter at svare i produktion i stedet for at lukke op", async () => {
    // En gate der falder tilbage til at lukke op, er værre end ingen gate:
    // en glemt miljøvariabel ville lægge alt åbent uden at nogen opdager det.
    config.auth.password = "";
    config.env = "production";
    const res = await fetch(`${base}/api/weddings/findes-ikke/dashboard`);
    expect(res.status).toBe(503);
  });
});
