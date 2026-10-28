import { describe, expect, it, vi } from "vitest";
import type { HttpAnswer, HttpGet } from "@keepdeck/plugin-api";
import { declaredDefault } from "./home";
import { readKimiLimits, tokenStorageName, usageSource, type LimitsPorts } from "./limits";

const MAINLAND = `
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"
type = "kimi"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
`;

const GLOBAL = `
[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"
type = "kimi"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0123456789abcdef"
oauth_host = "https://auth.kimi.ai"
`;

const DEFAULT_BASE = "https://api.kimi.com/coding/v1";
const source = (config: string | null, env: string | null = null) => usageSource(config, env, DEFAULT_BASE);

describe("kimi usage source", () => {
  it("a mainland login reads the com API with the default token", () => {
    expect(source(MAINLAND)).toEqual({ url: "https://api.kimi.com/coding/v1/usages", file: "kimi-code.json" });
  });

  it("a global login reads its own API with its own token", () => {
    // The bug this exists for: a global login has no kimi-code.json, and
    // its token is not valid on the mainland deployment either.
    expect(source(GLOBAL)).toEqual({
      url: "https://api.kimi.ai/coding/v1/usages",
      file: "kimi-code-env-0123456789abcdef.json",
    });
  });

  it("KIMI_CODE_BASE_URL names the API over the config, with one joining slash", () => {
    expect(source(GLOBAL, "https://proxy.example/kimi/")).toEqual({
      url: "https://proxy.example/kimi/usages",
      file: "kimi-code-env-0123456789abcdef.json",
    });
    // Set but empty still overrides — a URL the host refuses, not a quiet
    // fallback to another endpoint.
    expect(source(MAINLAND, "")?.url).toBe("/usages");
  });

  it("no usable config reads as the mainland default", () => {
    const fallback = source(MAINLAND);
    expect(source(null)).toEqual(fallback);
    expect(source("not [toml")).toEqual(fallback);
    expect(source('[providers.other]\nbase_url = "x"')).toEqual(fallback);
  });

  it("a bare key is its own file name", () => {
    expect(source(MAINLAND.replace("oauth/kimi-code", "kimi-code-custom"))?.file).toBe("kimi-code-custom.json");
  });

  it("a key that would leave the credentials directory is refused", () => {
    for (const key of ["oauth/../secret", "oauth/a/b", "oauth/.hidden", "oauth/", ".."]) {
      expect(source(MAINLAND.replace("oauth/kimi-code", key)), key).toBeNull();
    }
    // A Windows separator too — TOML would read "a\b" in a basic string as
    // a backspace, so this one is asked of the mapping directly.
    expect(tokenStorageName("oauth/a\\b")).toBeNull();
  });

  it("takes its defaults from the manifest declaration the host resolves too", () => {
    expect(declaredDefault("KIMI_CODE_BASE_URL")).toBe(DEFAULT_BASE);
    expect(declaredDefault("KIMI_CODE_HOME")).toBe("~/.kimi-code");
    expect(() => declaredDefault("NOT_DECLARED")).toThrow("declares no default");
  });
});

describe("readKimiLimits", () => {
  function ports({
    env = {},
    files = {},
    answer = { status: 200, body: '{"usage":1}', truncated: false, sentAt: 5_000 },
  }: {
    env?: Record<string, string>;
    files?: Record<string, string>;
    answer?: HttpAnswer;
  }) {
    const get = vi.fn(async (_request: HttpGet) => answer);
    const readFile = vi.fn(async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such path: ${path}`);
      return { path, text, isBinary: false, size: text.length, truncated: false, readBytes: text.length };
    });
    const services: LimitsPorts["services"] = {
      fs: { readFile },
      http: { get },
      env: { get: async (name) => env[name] ?? null },
    };
    return { services, get, readFile };
  }

  it("reads the default home's config and signs with the default source", async () => {
    const { services, get, readFile } = ports({ files: { "~/.kimi-code/config.toml": GLOBAL } });

    await expect(readKimiLimits({ services })).resolves.toEqual({ body: '{"usage":1}', sourceAt: 5_000 });

    expect(readFile).toHaveBeenCalledWith("~/.kimi-code/config.toml");
    expect(get).toHaveBeenCalledWith({
      url: "https://api.kimi.ai/coding/v1/usages",
      credential: { source: "kimi-code", file: "kimi-code-env-0123456789abcdef.json" },
    });
  });

  it("reads the config under KIMI_CODE_HOME, and the default home when it is empty", async () => {
    const custom = ports({ env: { KIMI_CODE_HOME: "/elsewhere/kimi" }, files: { "/elsewhere/kimi/config.toml": GLOBAL } });
    await readKimiLimits({ services: custom.services });
    expect(custom.readFile).toHaveBeenCalledWith("/elsewhere/kimi/config.toml");

    const empty = ports({ env: { KIMI_CODE_HOME: "" } });
    await readKimiLimits({ services: empty.services });
    expect(empty.readFile).toHaveBeenCalledWith("~/.kimi-code/config.toml");
    // No config at all is the mainland default, not a failure.
    expect(empty.get).toHaveBeenCalledWith(expect.objectContaining({ url: `${DEFAULT_BASE}/usages` }));
  });

  it("a relative KIMI_CODE_HOME is read as given, as kimi reads it", async () => {
    const relative = ports({ env: { KIMI_CODE_HOME: "rel/kimi" } });
    await readKimiLimits({ services: relative.services });
    expect(relative.readFile).toHaveBeenCalledWith("rel/kimi/config.toml");
  });

  it("KIMI_CODE_BASE_URL wins over the config's base", async () => {
    const { services, get } = ports({
      env: { KIMI_CODE_BASE_URL: "https://custom.example:8443/v9" },
      files: { "~/.kimi-code/config.toml": GLOBAL },
    });
    await readKimiLimits({ services });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ url: "https://custom.example:8443/v9/usages" }));
  });

  it("refuses a config whose key would leave the credentials directory, before any request", async () => {
    const { services, get } = ports({
      files: { "~/.kimi-code/config.toml": MAINLAND.replace("oauth/kimi-code", "oauth/../secret") },
    });
    await expect(readKimiLimits({ services })).rejects.toThrow("outside its credentials directory");
    expect(get).not.toHaveBeenCalled();
  });

  it("a non-200 answer or a cut body is a failure the lane logs", async () => {
    const idle = ports({ answer: { status: 401, body: "", truncated: false, sentAt: 1 } });
    await expect(readKimiLimits({ services: idle.services })).rejects.toThrow("kimi usages HTTP 401");
    const cut = ports({ answer: { status: 200, body: "{", truncated: true, sentAt: 1 } });
    await expect(readKimiLimits({ services: cut.services })).rejects.toThrow("larger than the host carries");
  });
});
