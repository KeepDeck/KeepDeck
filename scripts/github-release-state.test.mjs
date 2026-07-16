import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupRelease, parseArgs } from "./github-release-state.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

function response(status, body = "") {
  return new Response(body, { status });
}

describe("parseArgs", () => {
  it("reads the repository and exact release tag", () => {
    expect(
      parseArgs(["--repo", "KeepDeck/KeepDeck", "--tag", "latest"]),
    ).toEqual({ repo: "KeepDeck/KeepDeck", tag: "latest" });
  });

  it.each([
    [["--tag", "latest"], /--repo is required/],
    [["--repo", "KeepDeck/KeepDeck"], /--tag is required/],
    [["--unknown"], /unknown argument/],
  ])("rejects bad arguments %j", (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });
});

describe("lookupRelease", () => {
  const options = {
    repo: "KeepDeck/KeepDeck",
    tag: "latest",
    token: "test-token",
    apiUrl: "https://api.github.test",
  };

  it("reports an existing release from the exact REST tag endpoint", async () => {
    const request = vi.fn().mockResolvedValue(response(200, "{}"));

    await expect(lookupRelease({ ...options, request })).resolves.toBe("exists");
    expect(request).toHaveBeenCalledWith(
      "https://api.github.test/repos/KeepDeck/KeepDeck/releases/tags/latest",
      {
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer test-token",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      },
    );
  });

  it("treats only an explicit 404 as a missing release", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response(404, '{"message":"Not Found"}'));

    await expect(lookupRelease({ ...options, request })).resolves.toBe("missing");
  });

  it.each([
    [401, "Bad credentials"],
    [403, "Resource not accessible by integration"],
  ])(
    "fails immediately on HTTP %i without retrying",
    async (status, message) => {
      const request = vi
        .fn()
        .mockResolvedValue(response(status, JSON.stringify({ message })));
      const sleep = vi.fn();

      await expect(
        lookupRelease({ ...options, request, sleep }),
      ).rejects.toThrow(`HTTP ${status}: ${message}`);
      expect(request).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("retries a transient 5xx with exponential backoff until it clears", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(503, "<!DOCTYPE html>Unicorn!"))
      .mockResolvedValueOnce(response(502, ""))
      .mockResolvedValueOnce(response(200, "{}"));
    const sleep = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      lookupRelease({ ...options, request, sleep }),
    ).resolves.toBe("exists");
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [4000]]);
  });

  it("retries transport failures and still trusts a later 404", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(response(404, '{"message":"Not Found"}'));
    const sleep = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      lookupRelease({ ...options, request, sleep }),
    ).resolves.toBe("missing");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and surfaces the last failure", async () => {
    // A fresh Response per call: each attempt reads the body for its detail.
    const request = vi
      .fn()
      .mockImplementation(async () =>
        response(503, '{"message":"Service Unavailable"}'),
      );
    const sleep = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      lookupRelease({ ...options, request, sleep }),
    ).rejects.toThrow("HTTP 503: Service Unavailable");
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[2000], [4000], [8000]]);
  });

  it("requires a token and a well-formed repository", async () => {
    await expect(lookupRelease({ ...options, token: "" })).rejects.toThrow(
      "GH_TOKEN is required",
    );
    await expect(
      lookupRelease({ ...options, repo: "not/a/repository", request: vi.fn() }),
    ).rejects.toThrow("invalid GitHub repository");
  });
});
