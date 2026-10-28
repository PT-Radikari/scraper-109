import {
  GlintsConfigJson,
  buildGlintsAccountConfig,
  glintsBucketSessionKey,
  glintsCredentialEnvPrefix,
  resolveGlintsAccounts,
} from "../src/glints";

function makeConfig(overrides: Partial<GlintsConfigJson> = {}): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: "../db/glints.db",
    target_company: "PT RADIKARI",
    ...overrides,
  };
}

/** Env with exactly the given Glints credential env vars set, nothing else. */
function envWith(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars };
}

describe("resolveGlintsAccounts", () => {
  it("resolves the implicit default account from the top-level config when no accounts are configured", () => {
    const accounts = resolveGlintsAccounts(makeConfig(), {});
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      targetCompany: "PT RADIKARI",
      credentialEnvPrefix: "GLINTS",
      bucketSessionKey: "glints/session/current.json",
    });
  });

  it("resolves additional accounts with their own credential prefix and target company", () => {
    const config = makeConfig({
      accounts: [{ id: "second-brand", target_company: "PT Lain" }],
    });
    const accounts = resolveGlintsAccounts(
      config,
      envWith({
        GLINTS_SECOND_BRAND_EMAIL: "second@example.com",
        GLINTS_SECOND_BRAND_PASSWORD: "s3cret",
      }),
    );
    expect(accounts.map((a) => a.id)).toEqual(["default", "second-brand"]);
    expect(accounts[1]).toMatchObject({
      id: "second-brand",
      targetCompany: "PT Lain",
      credentialEnvPrefix: "GLINTS_SECOND_BRAND",
      bucketSessionKey: "glints/accounts/second-brand/session/current.json",
    });
  });

  it("rejects an account id named 'default' (reserved for the top-level account)", () => {
    const config = makeConfig({ accounts: [{ id: "default" }] });
    expect(() => resolveGlintsAccounts(config, {})).toThrow(/duplicate account id "default"/);
  });

  it("rejects duplicate account ids", () => {
    const config = makeConfig({
      accounts: [{ id: "dup" }, { id: "dup" }],
    });
    expect(() =>
      resolveGlintsAccounts(
        config,
        envWith({ GLINTS_DUP_EMAIL: "a@example.com", GLINTS_DUP_PASSWORD: "x" }),
      ),
    ).toThrow(/duplicate account id "dup"/);
  });

  it.each(["Second-Brand", "second_brand", "second brand", "", "2nd-brand"])(
    "rejects a malformed account id %p",
    (id) => {
      const config = makeConfig({ accounts: [{ id }] });
      expect(() => resolveGlintsAccounts(config, {})).toThrow(/invalid account id/);
    },
  );

  it("rejects a configured account whose credential pair is missing", () => {
    const config = makeConfig({ accounts: [{ id: "second-brand" }] });
    expect(() => resolveGlintsAccounts(config, {})).toThrow(
      /GLINTS_SECOND_BRAND_EMAIL\/GLINTS_SECOND_BRAND_PASSWORD are not set/,
    );
  });

  it("rejects the third account's missing credentials even when earlier accounts are fine (fail at startup, not mid-run)", () => {
    const config = makeConfig({
      accounts: [{ id: "second" }, { id: "third" }],
    });
    expect(() =>
      resolveGlintsAccounts(
        config,
        envWith({ GLINTS_SECOND_EMAIL: "a@example.com", GLINTS_SECOND_PASSWORD: "x" }),
      ),
    ).toThrow(/account "third"/);
  });

  it("never requires credentials for the default account (unchanged, cookie-warm-start-only behavior)", () => {
    expect(() => resolveGlintsAccounts(makeConfig(), {})).not.toThrow();
  });
});

describe("glintsCredentialEnvPrefix", () => {
  it("keeps the unprefixed GLINTS prefix for the default account", () => {
    expect(glintsCredentialEnvPrefix("default")).toBe("GLINTS");
  });

  it("derives an uppercased, underscore-joined prefix for other accounts", () => {
    expect(glintsCredentialEnvPrefix("second-brand")).toBe("GLINTS_SECOND_BRAND");
  });
});

describe("glintsBucketSessionKey", () => {
  it("keeps the legacy session key for the default account", () => {
    expect(glintsBucketSessionKey("default")).toBe("glints/session/current.json");
  });

  it("derives a distinct, namespaced key per account id", () => {
    expect(glintsBucketSessionKey("second-brand")).toBe(
      "glints/accounts/second-brand/session/current.json",
    );
    expect(glintsBucketSessionKey("third-brand")).toBe(
      "glints/accounts/third-brand/session/current.json",
    );
  });

  it("produces different keys for two different account ids", () => {
    expect(glintsBucketSessionKey("account-a")).not.toBe(glintsBucketSessionKey("account-b"));
  });
});

describe("buildGlintsAccountConfig", () => {
  it("overrides cookies, local_storage and target_company with the account's own values", () => {
    const base = makeConfig({
      cookies: [{ name: "base", value: "1", domain: "x", path: "/", expires: 0, httpOnly: false, secure: false }],
    });
    const accounts = resolveGlintsAccounts(
      makeConfig({ accounts: [{ id: "second-brand", target_company: "PT Lain" }] }),
      envWith({ GLINTS_SECOND_BRAND_EMAIL: "a@example.com", GLINTS_SECOND_BRAND_PASSWORD: "x" }),
    );
    const account = accounts[1];
    const built = buildGlintsAccountConfig(base, account);
    expect(built.cookies).toEqual([]);
    expect(built.target_company).toBe("PT Lain");
    expect(built.headless).toBe(base.headless);
  });

  it("namespaces db_path per non-default account and leaves the default account's path untouched", () => {
    const base = makeConfig({ db_path: "../db/glints.db" });
    const accounts = resolveGlintsAccounts(
      makeConfig({ accounts: [{ id: "second-brand" }] }),
      envWith({ GLINTS_SECOND_BRAND_EMAIL: "a@example.com", GLINTS_SECOND_BRAND_PASSWORD: "x" }),
    );
    expect(buildGlintsAccountConfig(base, accounts[0]).db_path).toBe("../db/glints.db");
    expect(buildGlintsAccountConfig(base, accounts[1]).db_path).toBe(
      "../db/glints-second-brand.db",
    );
  });
});
