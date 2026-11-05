// Collects the evidence of one finished GitHub Actions run for a
// docs/VERIFICATION_LOG.md entry (design part 1 §3.1, §3.3; Requirement 1.15,
// 3.3, 3.8, 4.3): run id, head_sha, run conclusion, the name and conclusion of
// every step of every job, the runner image of every job, the number of
// skipped steps and the number of Node.js 20 deprecation annotations. The
// output is a `依据来源` YAML fragment that can be pasted into an entry.
//
// Usage: node scripts/collect-ci-run-evidence.mjs --repo <owner/repo> --run-id <id>
//          [--format yaml|json] [--api-url <url>]
//   Reads GET /repos/{repo}/actions/runs/{id}, /repos/{repo}/actions/runs/{id}/jobs
//   and /repos/{repo}/check-runs/{job_id}/annotations. When GITHUB_TOKEN is set
//   (it needs actions:read) it also downloads /repos/{repo}/actions/jobs/{job_id}/logs
//   and reads Image and Version from the "Runner Image" group of the "Set up job"
//   log. Without a token the job logs are not readable, the image is printed as
//   待抄录 and must be copied from the run page.
//   --format   yaml (default) or json.
//   --api-url  GitHub REST API base, default https://api.github.com; must be
//              https://, or http:// on a loopback host (tests).
//   GITHUB_TOKEN is read only from the environment and only sent in the
//   Authorization header of requests to --api-url. It is never printed or
//   written to a file, and it is not sent to the log storage host that the
//   logs endpoint redirects to.
// Exit codes: 0 evidence printed; 1 the run has not completed yet; 2 usage
// error, network error or HTTP error (`ERROR ...`; HTTP 403 or 429 usually means
// the unauthenticated rate limit, so set GITHUB_TOKEN and retry).
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/** Annotation text of a deprecated Node.js 20 (or older) action runtime (design part 1 §3.3). */
export const NODE20_DEPRECATION = /Node\.js (1\d|20)\b.*deprecated/i;
/** Placeholder written when the runner image could not be read from the job log. */
export const IMAGE_NOT_COLLECTED = "待抄录";

const DEFAULT_API_URL = "https://api.github.com";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);

/** Number of steps, over all jobs, whose conclusion is "skipped" (Property 11). */
export function countSkippedSteps(jobs) {
  return jobs.reduce((total, job) => total + stepsOf(job).filter((step) => step.conclusion === "skipped").length, 0);
}

/** True when an annotation reports an action running on a Node.js 20 or older runtime. */
export function isNode20Deprecation(annotation) {
  const text = [annotation?.title, annotation?.message].filter((part) => typeof part === "string").join(" ").replace(/\s+/g, " ");
  return NODE20_DEPRECATION.test(text);
}

export function countNode20DeprecationWarnings(annotations) {
  return annotations.filter(isNode20Deprecation).length;
}

/** Steps whose conclusion is "failure", in job order and step number order. */
export function failedSteps(jobs) {
  return jobs.flatMap((job) =>
    [...stepsOf(job)]
      .sort((left, right) => left.number - right.number)
      .filter((step) => step.conclusion === "failure")
      .map((step) => ({ job: job.name, number: step.number, name: step.name }))
  );
}

/**
 * Runner image name and version from a job log: the `Image:` and `Version:`
 * lines inside the `##[group]Runner Image` group of the "Set up job" step.
 * Leading UTC timestamps, a BOM and CRLF line ends are ignored. The search is
 * limited to that group because the preceding "Runner Image Provisioner" group
 * has a `Version:` line of its own. Missing values are null.
 * @returns {{ image: string|null, version: string|null }}
 */
export function extractRunnerImage(logText) {
  const lines = String(logText)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\uFEFF/, "").replace(LOG_TIMESTAMP, "").trimEnd());
  const start = lines.findIndex((line) => line.trim() === "##[group]Runner Image");
  if (start < 0) return { image: null, version: null };
  const length = lines.slice(start + 1).findIndex((line) => line.trim().startsWith("##[endgroup]"));
  const group = lines.slice(start + 1, length < 0 ? undefined : start + 1 + length);
  const first = (pattern) => {
    for (const line of group) {
      const match = pattern.exec(line);
      if (match) return match[1];
    }
    return null;
  };
  return { image: first(/^\s*Image: (\S+)$/), version: first(/^\s*Version: (\S+)$/) };
}

/**
 * Evidence of one run from the API responses.
 * @param {{ run: object, jobs: object[], annotationsByJob?: Map<number, object[]>, logsByJob?: Map<number, string> }} input
 *   `run` is the /actions/runs/{id} response, `jobs` the `jobs` array of the
 *   jobs response, the maps are keyed by job id.
 */
export function buildEvidence({ run, jobs, annotationsByJob = new Map(), logsByJob = new Map() }) {
  if (!run || run.id === undefined || typeof run.head_sha !== "string") throw new TypeError("run must be a workflow run with id and head_sha");
  if (!Array.isArray(jobs)) throw new TypeError("jobs must be an array");
  for (const job of jobs) {
    if (job.run_id !== undefined && String(job.run_id) !== String(run.id)) throw new Error(`job ${job.name} belongs to run ${job.run_id}, not ${run.id}`);
    if (job.head_sha !== undefined && job.head_sha !== run.head_sha) throw new Error(`job ${job.name} head_sha ${job.head_sha} differs from run head_sha ${run.head_sha}`);
  }
  const annotations = jobs.flatMap((job) => annotationsByJob.get(job.id) ?? []);
  return {
    runId: String(run.id),
    runNumber: run.run_number ?? null,
    htmlUrl: run.html_url ?? null,
    headSha: run.head_sha,
    conclusion: run.conclusion ?? null,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion ?? null,
      runnerImage: logsByJob.has(job.id) ? extractRunnerImage(logsByJob.get(job.id)) : null,
      steps: [...stepsOf(job)].sort((left, right) => left.number - right.number).map((step) => ({ number: step.number, name: step.name, conclusion: step.conclusion ?? null }))
    })),
    skippedSteps: countSkippedSteps(jobs),
    node20Warnings: countNode20DeprecationWarnings(annotations),
    failedSteps: failedSteps(jobs)
  };
}

const NOT_FINISHED = "未结束";

/** The `依据来源` fragment of design part 1 §4.3 for a GitHub Actions run. */
export function toVerificationLogSource(evidence) {
  return {
    依据来源: [
      {
        类别: "CI 或 Linux 运行",
        平台: "GitHub Actions",
        "run id": evidence.runId,
        提交: evidence.headSha,
        运行结论: evidence.conclusion ?? NOT_FINISHED,
        "runner 镜像": evidence.jobs.map((job) => ({
          job: job.name,
          镜像: job.runnerImage?.image ?? IMAGE_NOT_COLLECTED,
          版本: job.runnerImage?.version ?? IMAGE_NOT_COLLECTED
        })),
        步骤: evidence.jobs.flatMap((job) => job.steps.map((step) => ({ job: job.name, 序号: step.number, 步骤: step.name, 结论: step.conclusion ?? NOT_FINISHED }))),
        "skipped 步骤数": evidence.skippedSteps,
        "node20 弃用告警数": evidence.node20Warnings
      }
    ]
  };
}

/** Text printed by the CLI. YAML output starts with `#` comment lines that summarize the run. */
export function renderEvidence(evidence, { format = "yaml", repo } = {}) {
  const source = toVerificationLogSource(evidence);
  if (format === "json") return `${JSON.stringify(source, null, 2)}\n`;
  const failed = evidence.failedSteps.map((step) => `${step.job} #${step.number} ${step.name}`);
  const missingImages = evidence.jobs.filter((job) => !job.runnerImage?.image || !job.runnerImage?.version).map((job) => job.name);
  const header = [
    `# ci:evidence:collect --repo ${repo ?? "<owner/repo>"} --run-id ${evidence.runId}`,
    `# 运行${evidence.runNumber === null ? "" : ` #${evidence.runNumber}`}：${evidence.htmlUrl ?? "(无 html_url)"}`,
    `# 失败步骤：${failed.length === 0 ? "无" : failed.join("；")}`,
    ...(missingImages.length === 0
      ? []
      : [`# runner 镜像：${missingImages.join("、")} 未从 job 日志取得，值为"${IMAGE_NOT_COLLECTED}"；请从运行页面该 job 的 Set up job 步骤（Runner Image 组）抄录 Image 与 Version`])
  ];
  return `${header.join("\n")}\n${yaml.dump(source, { lineWidth: -1, noRefs: true, quotingType: "\"" })}`;
}

export class ApiError extends Error {
  constructor(url, { status, detail }) {
    super(status === undefined ? `network url=${url} reason=${detail}` : `http status=${status} url=${url} message=${detail}`);
    this.name = "ApiError";
    this.url = url;
    this.status = status;
  }
}

function usage(message) {
  console.error(`ERROR usage: ${message}`);
  console.error("usage: node scripts/collect-ci-run-evidence.mjs --repo <owner/repo> --run-id <id> [--format yaml|json] [--api-url <url>]");
  process.exit(2);
}

function parseArguments(argv) {
  const options = { format: "yaml", apiUrl: DEFAULT_API_URL };
  const names = new Map([["--repo", "repo"], ["--run-id", "runId"], ["--format", "format"], ["--api-url", "apiUrl"]]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = names.get(argv[i]);
    if (!key) usage(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${argv[i]} requires a value`);
    options[key] = value;
    i += 1;
  }
  if (!options.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) usage("--repo <owner/repo> is required");
  if (!options.runId || !/^\d+$/.test(options.runId)) usage("--run-id <numeric run id> is required");
  if (!["yaml", "json"].includes(options.format)) usage(`--format must be yaml or json, found ${options.format}`);
  let apiUrl;
  try {
    apiUrl = new URL(options.apiUrl);
  } catch {
    usage(`--api-url is not a URL: ${options.apiUrl}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && loopback)) usage("--api-url must use https:// (http:// only on a loopback host)");
  options.apiUrl = apiUrl.href.replace(/\/+$/, "");
  return options;
}

async function request(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new ApiError(url, { detail: error.cause?.code ?? error.message });
  }
}

async function failureDetail(response) {
  let message = response.statusText || "request failed";
  try {
    const body = await response.json();
    if (typeof body?.message === "string") message = body.message;
  } catch {
    // keep statusText
  }
  return message.replace(/\s+/g, " ");
}

function createClient(apiUrl, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "shuzhiren-ci-evidence" };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function json(pathname) {
    const url = `${apiUrl}${pathname}`;
    const response = await request(url, { headers });
    if (!response.ok) throw new ApiError(url, { status: response.status, detail: await failureDetail(response) });
    return response.json();
  }
  return {
    json,
    async jobs(repo, runId) {
      const all = [];
      for (let page = 1; ; page += 1) {
        const body = await json(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=${PAGE_SIZE}&page=${page}`);
        const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
        all.push(...jobs);
        if (jobs.length === 0 || all.length >= (body.total_count ?? 0)) return all;
      }
    },
    async annotations(repo, jobId) {
      const all = [];
      for (let page = 1; ; page += 1) {
        const items = await json(`/repos/${repo}/check-runs/${jobId}/annotations?per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(items)) throw new ApiError(`${apiUrl}/repos/${repo}/check-runs/${jobId}/annotations`, { status: 200, detail: "response is not an array" });
        all.push(...items);
        if (items.length < PAGE_SIZE) return all;
      }
    },
    /** The logs endpoint redirects to a pre-signed storage URL, which is fetched without the token. */
    async jobLog(repo, jobId) {
      const url = `${apiUrl}/repos/${repo}/actions/jobs/${jobId}/logs`;
      const first = await request(url, { headers, redirect: "manual" });
      let response = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get("location");
        if (!location) throw new ApiError(url, { status: first.status, detail: "redirect without Location" });
        response = await request(new URL(location, url).href, { headers: { "User-Agent": headers["User-Agent"] } });
      }
      if (!response.ok) throw new ApiError(url, { status: response.status, detail: await failureDetail(response) });
      return response.text();
    }
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  const client = createClient(options.apiUrl, token);
  try {
    const run = await client.json(`/repos/${options.repo}/actions/runs/${options.runId}`);
    if (run?.status !== "completed") {
      console.error(`ERROR run ${options.runId} has not completed (status=${run?.status}); collect evidence after it finishes`);
      return 1;
    }
    const jobs = await client.jobs(options.repo, options.runId);
    const annotationsByJob = new Map();
    for (const job of jobs) annotationsByJob.set(job.id, await client.annotations(options.repo, job.id));
    const logsByJob = new Map();
    if (token) {
      for (const job of jobs) {
        try {
          logsByJob.set(job.id, await client.jobLog(options.repo, job.id));
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          console.error(`WARN runner image of job ${job.name}: job log not downloaded (${error.message})`);
        }
      }
    } else {
      console.error("WARN GITHUB_TOKEN is not set: job logs are not downloaded; copy Image and Version from the Runner Image group of each job's Set up job step on the run page");
    }
    const evidence = buildEvidence({ run, jobs, annotationsByJob, logsByJob });
    process.stdout.write(renderEvidence(evidence, { format: options.format, repo: options.repo }));
    return 0;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error(`ERROR ${error.message}`);
    if (error.status === 403 || error.status === 429) console.error("ERROR hint: HTTP 403/429 from the GitHub API is usually the unauthenticated rate limit; set GITHUB_TOKEN (actions:read) and retry");
    return 2;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2));
