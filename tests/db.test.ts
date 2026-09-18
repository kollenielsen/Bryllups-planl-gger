import { describe, expect, it } from "vitest";
import { resolveSslOption } from "../src/db/index.js";

const SUPABASE = "postgresql://postgres:kode@db.projekt.supabase.co:5432/postgres";
const COMPOSE = "postgresql://bryllup:bryllup@db:5432/bryllup";

describe("resolveSslOption", () => {
  it("bruger TLS mod en hostet database", () => {
    expect(resolveSslOption(SUPABASE, null)).toEqual({ rejectUnauthorized: false });
  });

  it("dropper TLS mod localhost", () => {
    expect(resolveSslOption("postgresql://a:b@localhost:5432/db", null)).toBe(false);
  });

  // Den gamle heuristik var `url.includes("localhost")`. De to næste var
  // dermed TLS-forbindelser mod en Postgres, der taler ren TCP — altså en
  // hård forbindelsesfejl, ikke bare et unødigt håndtryk.
  it("dropper TLS mod 127.0.0.1", () => {
    expect(resolveSslOption("postgresql://a:b@127.0.0.1:5432/db", null)).toBe(false);
  });

  it("dropper TLS mod ::1", () => {
    expect(resolveSslOption("postgresql://a:b@[::1]:5432/db", null)).toBe(false);
  });

  it("gætter på TLS for et compose-servicenavn — derfor findes DATABASE_SSL", () => {
    expect(resolveSslOption(COMPOSE, null)).toEqual({ rejectUnauthorized: false });
    expect(resolveSslOption(COMPOSE, false)).toBe(false);
  });

  it("lader et eksplicit valg vinde over værtsnavnet", () => {
    expect(resolveSslOption(SUPABASE, false)).toBe(false);
    expect(resolveSslOption("postgresql://a:b@localhost:5432/db", true)).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("falder tilbage til navnetjek på en url der ikke kan parses", () => {
    expect(resolveSslOption("ikke en url med localhost i", null)).toBe(false);
    expect(resolveSslOption("ikke en url", null)).toEqual({ rejectUnauthorized: false });
  });
});
