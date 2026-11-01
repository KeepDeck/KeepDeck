#!/usr/bin/env node
// Looks up one GitHub release by its exact tag through the REST API. The
// release workflow needs three distinct outcomes: an existing release, an
// explicit 404 (safe to create), and every other failure (unsafe to hide).
// `gh release view` also probes draft releases through GraphQL, so it is a
// broader and less reliable existence check than this endpoint.
//
// Transient failures — network errors and 5xx/429 responses, the shape of a
// GitHub availability incident — are retried with exponential backoff before
// giving up. Deterministic 4xx failures (401, 403, …) stay immediately fatal:
// repeating a rejected request cannot change the answer.
import { pathToFileURL } from "node:url";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A failed release lookup, tagged with whether repeating the request can help. */
class LookupFailure extends Error {
  /**
   * @param {string} message
   * @param {boolean} retryable
   */
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

/**
 * @param {string[]} argv
 * @returns {{ repo: string, tag: string }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let repo;
  /** @type {string | undefined} */
  let tag;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--repo") repo = argv[++i];
    else if (flag === "--tag") tag = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!repo) throw new Error("--repo is required");
  if (!tag) throw new Error("--tag is required");
  return { repo, tag };
}

/**
 * @param {string} repo
 * @returns {string[]}
 */
function repositoryParts(repo) {
  const parts = repo.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error(`invalid GitHub repository: ${repo}`);
  }
  return parts;
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function responseDetail(response) {
  try {
    const body = (await response.text()).trim();
    if (!body) return "";
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
      ) {
        return parsed.message;
      }
    } catch {
      // A proxy or GitHub outage may return plain text/HTML. Keep a bounded,
      // single-line excerpt so the Actions log still explains the failure.
    }
    return body.replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * @typedef {typeof fetch} Request
 */

/**
 * @param {{ endpoint: string, repo: string, tag: string, token: string, request: Request }} options
 * @returns {Promise<"exists" | "missing">}
 */
async function probe({ endpoint, repo, tag, token, request }) {
  let response;
  try {
    response = await request(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "KeepDeck-release-workflow",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LookupFailure(`GitHub release lookup failed: ${message}`, true);
  }

  if (response.ok) return "exists";
  if (response.status === 404) return "missing";

  const detail = await responseDetail(response);
  throw new LookupFailure(
    `GitHub release lookup failed for ${repo}@${tag}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    RETRYABLE_STATUSES.has(response.status),
  );
}

/**
 * @param {{
 *   repo: string,
 *   tag: string,
 *   token: string | undefined,
 *   apiUrl?: string,
 *   request?: Request,
 *   attempts?: number,
 *   backoffMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 * @returns {Promise<"exists" | "missing">}
 */
export async function lookupRelease({
  repo,
  tag,
  token,
  apiUrl = "https://api.github.com",
  request = fetch,
  attempts = 4,
  backoffMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!token) throw new Error("GH_TOKEN is required");
  const [owner, name] = repositoryParts(repo);
  if (!tag) throw new Error("release tag is required");

  const endpoint = [
    apiUrl.replace(/\/$/, ""),
    "repos",
    encodeURIComponent(owner),
    encodeURIComponent(name),
    "releases/tags",
    encodeURIComponent(tag),
  ].join("/");

  for (let attempt = 1; ; attempt++) {
    try {
      return await probe({ endpoint, repo, tag, token, request });
    } catch (error) {
      if (
        !(error instanceof LookupFailure) ||
        !error.retryable ||
        attempt >= attempts
      ) {
        throw error;
      }
      const delay = backoffMs * 2 ** (attempt - 1);
      // Stderr only: the workflow captures stdout as the release state.
      console.error(
        `${error.message}; retrying in ${delay / 1000}s (attempt ${attempt}/${attempts})`,
      );
      await sleep(delay);
    }
  }
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Request} [request]
 * @returns {Promise<"exists" | "missing">}
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  request = fetch,
) {
  const args = parseArgs(argv);
  const state = await lookupRelease({
    ...args,
    token: env.GH_TOKEN,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    request,
  });
  process.stdout.write(`${state}\n`);
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
