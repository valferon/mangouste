import { describe, expect, it } from "vitest";
import { accountDirectory, accountLabel, accountSlug, accountTitle, titleOf } from "./accountNames";
import type { Account } from "./types";

const account = (over: Partial<Account>): Account => ({
  name: "work",
  dir: "/home/someone/.claude-accounts/work",
  email: null,
  label: null,
  ...over,
});

describe("accountTitle", () => {
  it("is the label the person gave it", () => {
    expect(accountTitle(account({ label: "Ops team", email: "o@example.com" }))).toBe("Ops team");
  });

  it("is the address it is signed in as when it has no label", () => {
    expect(accountTitle(account({ email: "o@example.com" }))).toBe("o@example.com");
  });

  it("falls back to the directory name for an account with neither", () => {
    expect(accountTitle(account({}))).toBe("work");
  });
});

describe("accountLabel", () => {
  it("puts the address behind a label", () => {
    expect(accountLabel(account({ label: "Ops team", email: "o@example.com" }))).toBe(
      "Ops team (o@example.com)",
    );
  });

  it("puts the directory name behind an address", () => {
    // Two accounts can be signed in as the same address; the directory is
    // what still tells them apart.
    expect(accountLabel(account({ email: "o@example.com" }))).toBe("o@example.com (work)");
  });

  it("adds nothing to a label on a signed-out account, or to a bare name", () => {
    expect(accountLabel(account({ label: "Ops team" }))).toBe("Ops team");
    expect(accountLabel(account({}))).toBe("work");
  });
});

describe("titleOf", () => {
  const accounts = [account({ name: "main", email: "m@example.com" }), account({ label: "Ops team" })];

  it("names an account the way the switcher does", () => {
    expect(titleOf(accounts, "work")).toBe("Ops team");
    expect(titleOf(accounts, "main")).toBe("m@example.com");
  });

  it("falls back to the name it was given for an account that is not listed", () => {
    // Removed since the session started on it, or the list not loaded yet.
    expect(titleOf(accounts, "gone")).toBe("gone");
    expect(titleOf(undefined, "work")).toBe("work");
  });
});

describe("accountSlug", () => {
  it("keeps a name that is already a directory name", () => {
    expect(accountSlug("personal")).toBe("personal");
    expect(accountSlug("client-2_b")).toBe("client-2_b");
  });

  it("makes a directory name out of whatever was typed", () => {
    expect(accountSlug("Ops team")).toBe("ops-team");
    expect(accountSlug("  Client: Acme & Co.  ")).toBe("client-acme-co");
    expect(accountSlug("me@example.com")).toBe("me-example-com");
  });

  it("drops accents rather than the letters under them", () => {
    expect(accountSlug("Équipe réseau")).toBe("equipe-reseau");
  });

  it("is null when nothing usable is left", () => {
    expect(accountSlug("")).toBeNull();
    expect(accountSlug("   ")).toBeNull();
    expect(accountSlug("!!!")).toBeNull();
    expect(accountSlug("日本語")).toBeNull();
  });

  it("never yields a hidden or dash-led directory", () => {
    expect(accountSlug(".hidden")).toBe("hidden");
    expect(accountSlug("--flag")).toBe("flag");
  });

  it("spells out the letters that are not a letter and an accent", () => {
    // NFKD leaves these whole, and dropped they left a hole: `s-ren`.
    expect(accountSlug("Søren")).toBe("soren");
    expect(accountSlug("Straße")).toBe("strasse");
    expect(accountSlug("Łódź Æther Œuvre")).toBe("lodz-aether-oeuvre");
    expect(accountSlug("İstanbul ılık")).toBe("istanbul-ilik");
  });
});

describe("accountDirectory", () => {
  const taken = ["main", "work"];

  it("is the plain version of the name when that is free", () => {
    expect(accountDirectory("Ops team", taken)).toBe("ops-team");
    expect(accountDirectory("personal", taken)).toBe("personal");
  });

  it("is numbered when the directory is taken", () => {
    expect(accountDirectory("Work", taken)).toBe("work-2");
    expect(accountDirectory("work", [...taken, "work-2"])).toBe("work-3");
  });

  it("never takes main, whatever the case", () => {
    // `main` is `~/.claude`; a second one under the accounts dir is refused.
    expect(accountDirectory("Main", taken)).toBe("main-2");
    expect(accountDirectory("MAIN", ["Main"])).toBe("main-2");
  });

  it("still makes a directory for a name with no Latin letter in it", () => {
    // The name is kept whole as the label; the directory only has to exist.
    expect(accountDirectory("日本語", taken)).toBe("account");
    expect(accountDirectory("🦦", [...taken, "account"])).toBe("account-2");
  });

  it("is null only when nothing was typed", () => {
    expect(accountDirectory("", taken)).toBeNull();
    expect(accountDirectory("   ", taken)).toBeNull();
  });
});
