import { describe, expect, it, vi } from "vitest";
import { lookupRelease, parseArgs } from "./github-release-state.mjs";

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
    [500, "Server Error"],
  ])(
    "surfaces HTTP %i instead of allowing release creation",
    async (status, message) => {
      const request = vi
        .fn()
        .mockResolvedValue(response(status, JSON.stringify({ message })));

      await expect(lookupRelease({ ...options, request })).rejects.toThrow(
        `HTTP ${status}: ${message}`,
      );
    },
  );

  it("surfaces transport failures", async () => {
    const request = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(lookupRelease({ ...options, request })).rejects.toThrow(
      "GitHub release lookup failed: socket closed",
    );
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
