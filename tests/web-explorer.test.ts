import { describe, expect, it } from "vitest";
import { addressUrl, ledgerUrl, shortAddress } from "../web/lib/explorer";

const G = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const C = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("web explorer links", () => {
  it("links a ledger on the registry's network", () => {
    expect(ledgerUrl("testnet", 123456)).toBe(
      "https://stellar.expert/explorer/testnet/ledger/123456",
    );
    expect(ledgerUrl("public", 7)).toBe("https://stellar.expert/explorer/public/ledger/7");
  });

  it("routes a G account and a C contract to their own explorer paths", () => {
    expect(addressUrl("testnet", G)).toBe(
      `https://stellar.expert/explorer/testnet/account/${G}`,
    );
    expect(addressUrl("public", C)).toBe(
      `https://stellar.expert/explorer/public/contract/${C}`,
    );
  });

  it("shortens a long address and leaves a short one alone", () => {
    expect(shortAddress(G)).toBe("GBBD4…LFLA5");
    expect(shortAddress("GSHORT")).toBe("GSHORT");
  });
});
