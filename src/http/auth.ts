import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * Adgangskode på dashboardet og API'et.
 *
 * Uden den er `POST /api/weddings/:id/outreach` et åbent endpoint, der kalder
 * Claude for enhver der kender URL'en, og dashboardet udleverer parrets og
 * leverandørernes navne, mailadresser, telefonnumre og hele mailtråde.
 *
 * Basic Auth er nok her: appen er bygget til ét par ad gangen og har ingen
 * brugerkonti, browseren håndterer selv prompten, og curl kan sende det samme.
 * Skal flere par dele en installation, er svaret rigtige konti — ikke en
 * ekstra delt kode.
 *
 * Webhooken er med vilje ikke omfattet: mailudbyderen kan ikke sende Basic
 * Auth, og den har sin egen hemmelighed i `INBOUND_WEBHOOK_SECRET`.
 */
export function requireAppAuth() {
  let warned = false;

  return function appAuth(req: Request, res: Response, next: NextFunction): void {
    const expected = config.auth.password;

    if (!expected) {
      // En gate, der falder tilbage til at lukke op, er værre end ingen gate
      // — den ser sikker ud. Åben lokalt, lukket i produktion.
      if (config.env === "production") {
        res.status(503).json({
          error: "APP_PASSWORD er ikke sat. Appen nægter at køre åbent i produktion.",
        });
        return;
      }
      if (!warned) {
        warned = true;
        console.warn("[auth] APP_PASSWORD er ikke sat — dashboardet er ubeskyttet.");
      }
      next();
      return;
    }

    const supplied = parseBasic(req.get("authorization"));
    if (
      supplied &&
      safeEqual(supplied.user, config.auth.user) &&
      safeEqual(supplied.pass, expected)
    ) {
      next();
      return;
    }

    res.set("WWW-Authenticate", 'Basic realm="Bryllupsplanlaegger", charset="UTF-8"');
    res.status(401).json({ error: "Adgangskode kræves." });
  };
}

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!m || !m[1]) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i === -1) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Konstant tid, så et forkert gæt ikke kan måles frem tegn for tegn.
 * Længden lækker stadig — det er tilsigtet og uundgåeligt med timingSafeEqual.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
