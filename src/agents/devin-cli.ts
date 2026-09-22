import { z } from "zod";

import { getInstallationTokenForRepo } from "../global/github-auth.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import { computeBackend } from "./compute.js";
import type { ComputeBackend } from "./compute.js";
import {
  writeAgentSessionActivity,
  openAgentSessionSpan,
  closeAgentSessionSpan,
} from "./daytona.js";
import type { ActivitySpanOptions } from "./daytona.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

const DEFAULT_MODEL = "swe-2";
const RESULT_PATH = "/tmp/devin-result.json";
const NAME_PREFIX = "vortex-devin";
const AGENT_LABEL = "devin-cli";

const devinResultSchema = z.object({
  status: z.enum(["completed", "failed"]).optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  result: z.string().optional(),
});

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

function normalizeCredentialsB64(
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    if (decoded.includes("=")) return value;
  } catch {
    // not valid base64 — encode raw TOML below
  }
  return encodeBase64(value);
}

function parseRepo(repo: string): [string, string] {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Invalid repository format: ${repo}`,
    });
  }
  return [parts[0], parts[1]];
}

function buildPrompt(issue: Issue, gitIdentity?: GitIdentity | null): string {
  const repo = issue.repo ?? "this repository";
  const branch = issue.branch ?? `issue-${issue.id}`;
  const identityLines = gitIdentity
    ? [
        `Git identity: ${gitIdentity.name} <${gitIdentity.email}>`,
        ...(gitIdentity.githubUsername
          ? [`GitHub user: ${gitIdentity.githubUsername}`]
          : []),
        ...(gitIdentity.signingKeyRef
          ? [`Signing key reference: ${gitIdentity.signingKeyRef}`]
          : []),
      ]
    : [];
  return [
    `# ${issue.title}`,
    "",
    `Repository: https://github.com/${repo}`,
    `Branch: ${branch}`,
    `Issue tracker: https://github.com/VortexNYC/pile`,
    `Issue: ${issue.identifier ?? issue.id}`,
    "",
    issue.description ?? "",
    "",
    ...identityLines,
    "",
    "Implement the requested change. Run the project's dependency installation and test/lint commands (for example `pnpm install` and `pnpm run check`). Make commits with clear messages. Do not push and do not open a pull request — the runner handles that after you exit.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the status back automatically.",
  ].join("\n");
}

function sanitizeEnv(value: string): string {
  return value
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\0", "");
}

const PYTHON_RUNNER = [
  "import base64",
  "import json",
  "import os",
  "import shutil",
  "import subprocess",
  "import sys",
  "import urllib.error",
  "import urllib.request",
  "",
  "HOME = os.environ.get('HOME', '/tmp')",
  "DEVIN_HOME = os.path.join(HOME, '.local', 'share', 'devin')",
  "DEVIN_INSTALL_DIR = os.path.join(HOME, '.local', 'bin')",
  "REPO = os.environ['REPO']",
  "BRANCH = os.environ['BRANCH']",
  "GITHUB_TOKEN = os.environ['GITHUB_TOKEN']",
  "REPO_DIR = os.path.join(HOME, 'repo')",
  "",
  "def run(cmd, cwd=None, env=None, check=False, **kwargs):",
  "    print('+ ' + ' '.join(str(c) for c in cmd))",
  "    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)",
  "    if check and result.returncode != 0:",
  "        raise RuntimeError(f'Command failed: {cmd} returned {result.returncode}; stdout={result.stdout}; stderr={result.stderr}')",
  "    return result",
  "",
  "def ensure_devin():",
  "    devin_bin = os.path.join(DEVIN_INSTALL_DIR, 'devin')",
  "    if not os.path.exists(devin_bin):",
  "        subprocess.run(['bash', '-c', 'curl -fsSL https://cli.devin.ai/install.sh | bash'], check=False)",
  "    # installer exits non-zero when its interactive wizard bails without a TTY; verify the binary directly",
  "    result = subprocess.run([devin_bin, '--version'], capture_output=True, text=True)",
  "    if result.returncode != 0:",
  "        raise RuntimeError(f'devin install failed: {result.stdout} {result.stderr}')",
  "    print('devin version:', result.stdout.strip())",
  "    return devin_bin",
  "",
  "def write_devin_home(creds_b64):",
  "    os.makedirs(DEVIN_HOME, exist_ok=True)",
  "    creds_path = os.path.join(DEVIN_HOME, 'credentials.toml')",
  "    with open(creds_path, 'wb') as f:",
  "        f.write(base64.b64decode(creds_b64))",
  "    os.chmod(creds_path, 0o600)",
  "",
  "def github_api(method, path, body=None):",
  "    owner, name = REPO.split('/')",
  "    url = f'https://api.github.com/repos/{owner}/{name}{path}'",
  "    headers = {",
  "        'Authorization': f'Bearer {GITHUB_TOKEN}',",
  "        'Accept': 'application/vnd.github+json',",
  "        'Content-Type': 'application/json',",
  "        'X-GitHub-Api-Version': '2022-11-28',",
  "    }",
  "    data = json.dumps(body).encode() if body is not None else None",
  "    req = urllib.request.Request(url, data=data, headers=headers, method=method)",
  "    try:",
  "        with urllib.request.urlopen(req) as resp:",
  "            return json.load(resp) if resp.status != 204 else None",
  "    except urllib.error.HTTPError as e:",
  "        text = e.read().decode()",
  "        print(f'GitHub API error {method} {path}: {e.code} {text}')",
  "        raise",
  "",
  "def default_branch():",
  "    repo = github_api('GET', '')",
  "    return repo.get('default_branch', 'main')",
  "",
  "def create_branch():",
  "    base = default_branch()",
  "    try:",
  "        ref = github_api('GET', f'/git/ref/heads/{base}')",
  "    except urllib.error.HTTPError as e:",
  "        if e.code == 404:",
  "            ref = github_api('GET', '/git/ref/heads/master')",
  "        else:",
  "            raise",
  "    sha = ref['object']['sha']",
  "    try:",
  "        github_api('POST', '/git/refs', {'ref': f'refs/heads/{BRANCH}', 'sha': sha})",
  "        print(f'created branch {BRANCH} from {base}')",
  "    except urllib.error.HTTPError as e:",
  "        if e.code == 422:",
  "            print(f'branch {BRANCH} already exists')",
  "        else:",
  "            raise",
  "",
  "def clone_repo():",
  "    if os.path.exists(REPO_DIR):",
  "        shutil.rmtree(REPO_DIR)",
  "    os.makedirs(os.path.dirname(REPO_DIR), exist_ok=True)",
  "    run(['timeout', '300', 'git', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'clone', '--depth', '1', '--branch', BRANCH, '--single-branch', f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git', REPO_DIR], check=True)",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', 'Devin')], check=True)",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'devin@pile.nyc')], check=True)",
  "",
  "def find_pr():",
  "    owner, name = REPO.split('/')",
  "    try:",
  "        pulls = github_api('GET', f'/pulls?state=all&head={owner}:{BRANCH}')",
  "        if pulls:",
  "            return pulls[0]['html_url']",
  "    except Exception as e:",
  "        print('find_pr error:', e)",
  "    return ''",
  "",
  "PR_ERRORS = []",
  "",
  "def create_pr():",
  "    try:",
  "        body = {",
  "            'title': os.environ['ISSUE_TITLE'],",
  "            'head': BRANCH,",
  "            'base': default_branch(),",
  "            'body': f'Closes {os.environ[\"ISSUE_IDENTIFIER\"]}\\n\\nGenerated with Devin CLI',",
  "        }",
  "        pr = github_api('POST', '/pulls', body)",
  "        return pr['html_url']",
  "    except Exception as e:",
  "        print('create_pr error:', e)",
  "        PR_ERRORS.append(f'create_pr: {e}')",
  "    return ''",
  "",
  "def devin_env():",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['PATH'] = DEVIN_INSTALL_DIR + ':' + env.get('PATH', '')",
  "    return env",
  "",
  "def run_devin(devin_bin):",
  "    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')",
  "    model = os.environ.get('MODEL', 'swe-2')",
  "    result = subprocess.run(",
  "        [devin_bin, '-p', prompt, '--model', model, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'],",
  "        cwd=REPO_DIR, env=devin_env(), capture_output=True, text=True, timeout=7200",
  "    )",
  "    print('devin exit:', result.returncode)",
  "    if result.stdout:",
  "        print(result.stdout[-4000:])",
  "    if result.stderr:",
  "        print(result.stderr[-2000:], file=sys.stderr)",
  "    if result.returncode != 0:",
  "        raise RuntimeError(f'devin -p failed ({result.returncode}): {result.stderr[-500:]}')",
  "    return result.stdout[-4000:]",
  "",
  "def commit_and_push():",
  "    env = devin_env()",
  "    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=env, capture_output=True, text=True, check=True)",
  "    ahead = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'origin/{BRANCH}..HEAD'], env=env, capture_output=True, text=True, check=True)",
  "    if status.stdout.strip():",
  "        run(['git', '-C', REPO_DIR, 'add', '-A'], env=env, check=True)",
  "        run(['git', '-C', REPO_DIR, 'commit', '-m', f'Devin CLI changes for {BRANCH}'], env=env, check=True)",
  "    elif ahead.stdout.strip() == '0':",
  "        print('no changes to commit')",
  "        return False",
  "    run(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=env, check=True)",
  "    return True",
  "",
  "def main():",
  "    creds_b64 = os.environ['DEVIN_CREDENTIALS_B64']",
  "    write_devin_home(creds_b64)",
  "    devin_bin = ensure_devin()",
  "    create_branch()",
  "    clone_repo()",
  "    output = run_devin(devin_bin)",
  "    pushed = commit_and_push()",
  "    pr_url = ''",
  "    if pushed:",
  "        pr_url = find_pr() or create_pr()",
  "    result_text = json.dumps({'output_tail': output, 'pr_errors': PR_ERRORS})",
  "    with open('/tmp/devin-result.json', 'w') as f:",
  "        json.dump({'status': 'completed', 'prUrl': pr_url, 'branch': BRANCH, 'result': result_text}, f)",
  "    return 0",
  "",
  "if __name__ == '__main__':",
  "    try:",
  "        sys.exit(main())",
  "    except Exception as e:",
  "        with open('/tmp/devin-result.json', 'w') as f:",
  "            json.dump({'status': 'failed', 'prUrl': '', 'branch': BRANCH, 'result': str(e)}, f)",
  "        sys.exit(1)",
].join("\n");

function buildSandboxEnv(
  issue: Issue,
  model: string,
  credentialsB64: string,
  githubToken: string,
  gitIdentity: GitIdentity
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity);
  return {
    DEVIN_CREDENTIALS_B64: credentialsB64,
    GITHUB_TOKEN: githubToken,
    GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity.name),
    GIT_AUTHOR_EMAIL: sanitizeEnv(gitIdentity.email),
    REPO: repo,
    BRANCH: branch,
    ISSUE_TITLE: sanitizeEnv(issue.title),
    ISSUE_IDENTIFIER: identifier,
    MODEL: model,
    PROMPT_B64: encodeBase64(prompt),
    RUNNER_PY_B64: encodeBase64(PYTHON_RUNNER),
  };
}

function sandboxName(sessionId: string): string {
  return `${NAME_PREFIX}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function buildRunnerCommand(): string {
  return "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py";
}

export class DevinCliAgentProvider implements AgentProvider {
  readonly id = "devin-cli";

  constructor(private env: AppEnv) {}

  private async note(
    organizationId: string | undefined,
    sessionId: string | undefined,
    type: "status" | "error" | "action",
    message: string,
    payload?: Record<string, unknown>,
    span?: ActivitySpanOptions
  ): Promise<void> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return;
    await writeAgentSessionActivity(
      this.env as WorkerEnv,
      organizationId,
      sessionId,
      type,
      message,
      payload,
      span
    );
  }

  private async openSpan(
    organizationId: string | undefined,
    sessionId: string | undefined,
    message: string,
    payload?: Record<string, unknown>
  ): Promise<string | undefined> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return undefined;
    return openAgentSessionSpan(
      this.env as WorkerEnv,
      organizationId,
      sessionId,
      message,
      payload
    );
  }

  private async closeSpan(
    organizationId: string | undefined,
    spanId: string | undefined
  ): Promise<void> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return;
    await closeAgentSessionSpan(this.env as WorkerEnv, organizationId, spanId);
  }

  private requireAuth(): string {
    const creds = normalizeCredentialsB64(this.env.DEVIN_CLI_CREDENTIALS_B64);
    if (!creds) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_CLI_CREDENTIALS_B64 is not configured",
      });
    }
    return creds;
  }

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env);
  }

  private async githubToken(repo: string): Promise<string> {
    const [owner, name] = parseRepo(repo);
    const token = await getInstallationTokenForRepo(this.env, owner, name);
    if (!token) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: `Could not obtain GitHub installation token for ${repo}`,
      });
    }
    return token;
  }

  private async start(
    organizationId: string,
    issue: Issue,
    model: string,
    sessionId: string,
    gitIdentity: GitIdentity
  ) {
    const credentialsB64 = this.requireAuth();
    const compute = this.requireCompute();
    if (!issue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue must have a repository",
      });
    }
    const githubToken = await this.githubToken(issue.repo);
    const name = sandboxName(sessionId);

    const spanId = await this.openSpan(
      organizationId,
      sessionId,
      "provision devin-cli sandbox",
      { session: sessionId }
    );
    try {
      const existing = await compute.findSandbox(sessionId, name);
      if (existing) {
        await this.note(
          organizationId,
          sessionId,
          "status",
          "devin-cli sandbox exists, recreating",
          { sandbox: existing.id, state: existing.state },
          { parentId: spanId }
        );
        await compute.deleteSandbox(existing);
      }

      const sandboxEnv = buildSandboxEnv(
        issue,
        model,
        credentialsB64,
        githubToken,
        gitIdentity
      );
      const sandbox = await compute.createSandbox({
        name,
        sessionId,
        organizationId,
        agentLabel: AGENT_LABEL,
        env: sandboxEnv,
      });
      await this.note(
        organizationId,
        sessionId,
        "status",
        "devin-cli sandbox started",
        { sandbox: sandbox.id, state: sandbox.state, backend: compute.kind },
        { parentId: spanId }
      );
      await compute.startRunner(sandbox, sessionId, buildRunnerCommand());
      await this.note(
        organizationId,
        sessionId,
        "action",
        "devin-cli runner started",
        { sandbox: sandbox.id },
        { parentId: spanId }
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "devin-cli provision failed",
        {
          error: err instanceof Error ? err.message : String(err),
        },
        { parentId: spanId }
      );
      throw err;
    } finally {
      await this.closeSpan(organizationId, spanId);
    }
  }

  async dispatch(
    organizationId: string,
    issue: Issue,
    model = DEFAULT_MODEL,
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession> {
    const sessionId = sessionContext?.sessionId;
    if (!sessionId) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Missing tracker session id",
      });
    }
    const gitIdentity = sessionContext?.gitIdentity;
    if (!gitIdentity) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "Git identity is required for devin-cli",
      });
    }
    const effectiveModel = model ?? this.env.DEVIN_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity
    );

    if (sessionContext?.waitUntil) {
      sessionContext.waitUntil(startPromise);
    } else {
      await startPromise;
    }

    return {
      id: sessionId,
      agentId: this.id,
      issueId: issue.id,
      status: "created",
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      sessionId,
      sandboxName(sessionId),
      RESULT_PATH
    );
    if (!sandbox) {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    if (sandbox.state === "error") {
      return {
        id: sessionId,
        agentId: this.id,
        status: "failed",
        result: sandbox.error ?? "compute sandbox error",
      };
    }
    if (sandbox.state !== "started") {
      return { id: sessionId, agentId: this.id, status: "created" };
    }

    const runner = await compute.runnerState(sandbox, sessionId);
    if (runner === "pending") {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    if (runner === "running") {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const raw = await compute.readFile(sandbox, RESULT_PATH);
    let result: z.infer<typeof devinResultSchema> | null = null;
    if (raw) {
      try {
        const parsed = devinResultSchema.safeParse(JSON.parse(raw));
        if (parsed.success) result = parsed.data;
      } catch {
        result = null;
      }
    }
    if (!result) {
      await compute.deleteSandbox(sandbox);
      return {
        id: sessionId,
        agentId: this.id,
        status: "failed",
        result: `runner exited (code ${runner.exitCode}) without a result file`,
      };
    }

    const status: AgentSessionStatus =
      result.status === "completed" ? "completed" : "failed";
    const prUrl = result.prUrl?.trim() || null;
    const prState = prUrl ? "open" : null;

    await compute.deleteSandbox(sandbox);
    await this.note(
      sandbox.organizationId,
      sessionId,
      "status",
      "sandbox deleted after terminal result",
      { sandbox: sandbox.id }
    );

    return {
      id: sessionId,
      agentId: this.id,
      status,
      result: result.result,
      prUrl,
      prState,
      branch: result.branch ?? null,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      sessionId,
      sandboxName(sessionId),
      RESULT_PATH
    );
    if (sandbox) {
      await compute.deleteSandbox(sandbox);
      await this.note(
        sandbox.organizationId,
        sessionId,
        "status",
        "devin-cli sandbox deleted",
        { sandbox: sandbox.id }
      );
    }
  }

  async getState(
    providerSessionId: string,
    _trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      providerSessionId,
      sandboxName(providerSessionId),
      RESULT_PATH
    );
    if (!sandbox) return null;
    const runner = await compute.runnerState(sandbox, providerSessionId);
    const logs =
      (await compute.runnerLogs?.(sandbox, providerSessionId)) ?? null;
    return { provider: { state: runner, logs }, compute: sandbox };
  }

  async health(): Promise<AgentProviderHealth> {
    try {
      this.requireAuth();
      return await this.requireCompute().health();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
