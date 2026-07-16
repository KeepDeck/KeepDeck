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

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--tag") args.tag = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const key of ["repo", "tag"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

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

async function responseDetail(response) {
  try {
    const body = (await response.text()).trim();
    if (!body) return "";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.message === "string") return parsed.message;
    } catch {
      // A proxy or GitHub outage may return plain text/HTML. Keep a bounded,
      // single-line excerpt so the Actions log still explains the failure.
    }
    return body.replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

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
    const failure = new Error(`GitHub release lookup failed: ${message}`);
    failure.retryable = true;
    throw failure;
  }

  if (response.ok) return "exists";
  if (response.status === 404) return "missing";

  const detail = await responseDetail(response);
  const failure = new Error(
    `GitHub release lookup failed for ${repo}@${tag}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
  );
  failure.retryable = RETRYABLE_STATUSES.has(response.status);
  throw failure;
}

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
      if (!error.retryable || attempt >= attempts) throw error;
      const delay = backoffMs * 2 ** (attempt - 1);
      // Stderr only: the workflow captures stdout as the release state.
      console.error(
        `${error.message}; retrying in ${delay / 1000}s (attempt ${attempt}/${attempts})`,
      );
      await sleep(delay);
    }
  }
}

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
