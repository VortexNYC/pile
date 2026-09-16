import { z } from "zod";

import { getInstallationTokenForRepo } from "../global/github-auth.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import {
  daytonaConfig,
  daytonaSandboxListSchema,
  daytonaSandboxSchema,
} from "./outpost.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

const DEFAULT_MODEL = "gpt-reserve";
const DEFAULT_FALLBACK_TOOLBOX = "https://proxy.app.daytona.io/toolbox";
const POLL_INTERVAL_MS = 5000;
const MAX_START_POLLS = 60; // 5 minutes

const daytonaProcessSessionSchema = z.object({
  sessionId: z.string(),
  commands: z
    .array(
      z.object({
        id: z.string(),
        command: z.string(),
        exitCode: z.number().optional(),
      })
    )
    .default([]),
});

const daytonaCommandExecSchema = z.object({
  cmdId: z.string().optional(),
  exitCode: z.number().optional(),
  output: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

const daytonaSyncExecSchema = z.object({
  result: z.string().optional(),
  exitCode: z.number().optional(),
});

const codexResultSchema = z.object({
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

function normalizeAuthB64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    JSON.parse(decoded);
    return value;
  } catch {
    return encodeBase64(value);
  }
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
    "Implement the requested change. Run the project's dependency installation and test/lint commands (for example `pnpm install` and `pnpm run check`). Make commits with clear messages. Do not push your changes yourself — the runner will push and open the pull request. Include the full PR URL in your final message if a PR is opened, otherwise summarize what you did.",
    "Do not attempt to update the issue tracker yourself — an external system will poll your session and write the status back automatically.",
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
  "HOME = '/workspace/codex-home'",
  "CODEX_HOME = HOME",
  "CODEX_INSTALL_DIR = os.path.join(HOME, '.local', 'bin')",
  "REPO_DIR = '/workspace/repo'",
  "",
  "def run(cmd, cwd=None, env=None, check=False, **kwargs):",
  "    print('+ ' + ' '.join(str(c) for c in cmd))",
  "    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)",
  "    if check and result.returncode != 0:",
  "        raise RuntimeError(f'Command failed: {cmd} returned {result.returncode}')",
  "    return result",
  "",
  "def ensure_codex():",
  "    codex_bin = os.path.join(CODEX_INSTALL_DIR, 'codex')",
  "    if os.path.exists(codex_bin):",
  "        return codex_bin",
  "    os.makedirs(CODEX_INSTALL_DIR, exist_ok=True)",
  "    install_url = 'https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh'",
  "    install_script = subprocess.run(['curl', '-fsSL', install_url], check=True, capture_output=True, text=True).stdout",
  "    env = os.environ.copy()",
  "    env['CODEX_NON_INTERACTIVE'] = '1'",
  "    env['CODEX_INSTALL_DIR'] = CODEX_INSTALL_DIR",
  "    env['CODEX_HOME'] = CODEX_HOME",
  "    subprocess.run(['sh'], input=install_script, env=env, check=True, text=True)",
  "    return codex_bin",
  "",
  "def write_codex_home(auth_b64, model):",
  "    os.makedirs(os.path.join(CODEX_HOME, '.codex'), exist_ok=True)",
  "    with open(os.path.join(CODEX_HOME, '.codex', 'auth.json'), 'wb') as f:",
  "        f.write(base64.b64decode(auth_b64))",
  "    with open(os.path.join(CODEX_HOME, '.codex', 'config.toml'), 'w') as f:",
  "        f.write(f'model = \"{model}\"\\n')",
  "        f.write('approval_policy = \"never\"\\n')",
  "        f.write('sandbox_mode = \"danger-full-access\"\\n')",
  "        f.write('[shell_environment_policy]\\n')",
  "        f.write('inherit = \"all\"\\n')",
  "        f.write('ignore_default_excludes = true\\n')",
  "",
  "def setup_git():",
  "    os.makedirs(HOME, exist_ok=True)",
  "    os.environ['HOME'] = HOME",
  "    run(['git', 'config', '--global', 'user.name', os.environ['GIT_AUTHOR_NAME']], check=True)",
  "    run(['git', 'config', '--global', 'user.email', os.environ['GIT_AUTHOR_EMAIL']], check=True)",
  "    run(['git', 'config', '--global', 'init.defaultBranch', 'main'], check=True)",
  "    creds_path = os.path.join(HOME, '.git-credentials')",
  "    with open(creds_path, 'w') as f:",
  "        f.write(f'https://oauth2:{os.environ[\"GITHUB_TOKEN\"]}@github.com\\n')",
  "    run(['git', 'config', '--global', 'credential.helper', 'store'], check=True)",
  "",
  "def clone_and_branch(repo, branch):",
  "    os.makedirs('/workspace', exist_ok=True)",
  "    if os.path.exists(REPO_DIR):",
  "        shutil.rmtree(REPO_DIR)",
  "    run(['git', 'clone', f'https://github.com/{repo}.git', REPO_DIR], check=True)",
  "    run(['git', '-C', REPO_DIR, 'checkout', '-b', branch], check=True)",
  "",
  "def run_codex(codex_bin):",
  "    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')",
  "    prompt_path = '/tmp/prompt.txt'",
  "    with open(prompt_path, 'w') as f:",
  "        f.write(prompt)",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['CODEX_HOME'] = CODEX_HOME",
  "    env['CODEX_INSTALL_DIR'] = CODEX_INSTALL_DIR",
  "    env['PATH'] = CODEX_INSTALL_DIR + ':' + os.environ.get('PATH', '')",
  "    with open('/tmp/codex-stdout.txt', 'w') as out:",
  "        result = subprocess.run(",
  "            [codex_bin, 'exec', '-m', os.environ.get('MODEL', 'gpt-reserve'), '--dangerously-bypass-approvals-and-sandbox', '--json',",
  "             '--output-last-message', '/tmp/codex-last.txt', '--skip-git-repo-check', prompt],",
  "            cwd=REPO_DIR, env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL",
  "        )",
  "    return result.returncode",
  "",
  "def commit_and_push(branch):",
  "    status = subprocess.run(['git', '-C', REPO_DIR, 'status', '--porcelain'], capture_output=True, text=True).stdout.strip()",
  "    if status:",
  "        run(['git', '-C', REPO_DIR, 'add', '-A'], check=True)",
  "        run(['git', '-C', REPO_DIR, 'commit', '-m', f'Changes for {os.environ[\"ISSUE_IDENTIFIER\"]}', '--no-verify'], check=False)",
  "        run(['git', '-C', REPO_DIR, 'push', '-u', 'origin', branch], check=False)",
  "",
  "def create_pr(repo, branch, title, issue_id):",
  "    token = os.environ['GITHUB_TOKEN']",
  "    url = f'https://api.github.com/repos/{repo}/pulls'",
  "    body = {'title': title, 'head': branch, 'base': 'main', 'body': f'Closes {issue_id}\\n\\nGenerated with Codex'}",
  "    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={",
  "        'Authorization': f'Bearer {token}',",
  "        'Accept': 'application/vnd.github+json',",
  "        'Content-Type': 'application/json',",
  "    }, method='POST')",
  "    try:",
  "        with urllib.request.urlopen(req) as resp:",
  "            data = json.load(resp)",
  "            return data.get('html_url', '')",
  "    except urllib.error.HTTPError as e:",
  "        print('PR create failed:', e.code, e.read().decode())",
  "        return ''",
  "",
  "def main():",
  "    auth_b64 = os.environ['CODEX_AUTH_JSON_B64']",
  "    model = os.environ.get('MODEL', 'gpt-reserve')",
  "    write_codex_home(auth_b64, model)",
  "    codex_bin = ensure_codex()",
  "    setup_git()",
  "    clone_and_branch(os.environ['REPO'], os.environ['BRANCH'])",
  "    exit_code = run_codex(codex_bin)",
  "    commit_and_push(os.environ['BRANCH'])",
  "    pr_url = ''",
  "    try:",
  "        pr_url = create_pr(os.environ['REPO'], os.environ['BRANCH'], os.environ['ISSUE_TITLE'], os.environ['ISSUE_IDENTIFIER'])",
  "    except Exception as e:",
  "        print('create_pr error:', e)",
  "    last = ''",
  "    try:",
  "        with open('/tmp/codex-last.txt') as f:",
  "            last = f.read()",
  "    except FileNotFoundError:",
  "        pass",
  "    with open('/tmp/codex-result.json', 'w') as f:",
  "        json.dump({'status': 'completed' if exit_code == 0 else 'failed', 'prUrl': pr_url, 'branch': os.environ['BRANCH'], 'result': last}, f)",
  "    return exit_code",
  "",
  "if __name__ == '__main__':",
  "    sys.exit(main())",
].join("\n");

function buildSandboxEnv(
  issue: Issue,
  model: string,
  authB64: string,
  githubToken: string,
  gitIdentity: GitIdentity
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity);
  return {
    CODEX_AUTH_JSON_B64: authB64,
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

function buildRunnerCommand(): string {
  return "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py";
}

function toolboxBase(sandbox: {
  id: string;
  toolboxProxyUrl?: string | null;
}): string {
  const proxy = sandbox.toolboxProxyUrl ?? DEFAULT_FALLBACK_TOOLBOX;
  return `${proxy}/${sandbox.id}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexCliAgentProvider implements AgentProvider {
  readonly id = "codex-cli";

  constructor(private env: AppEnv) {}

  private requireAuth(): string {
    const auth = normalizeAuthB64(this.env.CODEX_AUTH_JSON_B64);
    if (!auth) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_AUTH_JSON_B64 is not configured",
      });
    }
    return auth;
  }

  private requireDaytona() {
    const config = daytonaConfig(this.env);
    if (!config) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DAYTONA_API_KEY is not configured",
      });
    }
    return config;
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

  private async listSandboxes(config: { apiKey: string; apiUrl: string }) {
    const res = await fetch(`${config.apiUrl}/sandbox`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona sandbox list failed: ${res.status} ${text}`,
      });
    }
    return daytonaSandboxListSchema.parse(await res.json());
  }

  private async deleteSandbox(
    config: { apiKey: string; apiUrl: string },
    sandboxId: string
  ) {
    const res = await fetch(`${config.apiUrl}/sandbox/${sandboxId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona sandbox delete failed: ${res.status} ${text}`,
      });
    }
  }

  private async findSandbox(
    config: { apiKey: string; apiUrl: string },
    sessionId: string
  ) {
    const list = await this.listSandboxes(config);
    return (
      list.items.find(
        (s) =>
          s.labels?.["vortex.session"] === sessionId ||
          s.name ===
            `vortex-codex-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`
      ) ?? null
    );
  }

  private async createSandbox(
    config: { apiKey: string; apiUrl: string },
    name: string,
    sessionId: string,
    organizationId: string,
    sandboxEnv: Record<string, string>
  ) {
    const res = await fetch(`${config.apiUrl}/sandbox`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        snapshot: this.env.DAYTONA_SNAPSHOT ?? "daytona-vm-small",
        env: sandboxEnv,
        labels: {
          "vortex.session": sessionId,
          "vortex.org": organizationId,
          "vortex.agent": "codex-cli",
        },
        autoStopInterval: 0,
        autoDeleteInterval: 0,
        ...(this.env.DAYTONA_VOLUME_ID
          ? {
              volumes: [
                {
                  volumeId: this.env.DAYTONA_VOLUME_ID,
                  mountPath: "/home/daytona/cache",
                },
              ],
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona sandbox create failed: ${res.status} ${text}`,
      });
    }
    return daytonaSandboxSchema.parse(await res.json());
  }

  private async waitForStarted(
    config: { apiKey: string; apiUrl: string },
    sandboxId: string
  ) {
    const poll = async (i: number) => {
      if (i >= MAX_START_POLLS) {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 504,
          message: "Daytona sandbox did not start in time",
        });
      }
      const res = await fetch(`${config.apiUrl}/sandbox/${sandboxId}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: `Daytona sandbox get failed: ${res.status} ${text}`,
        });
      }
      const sandbox = daytonaSandboxSchema.parse(await res.json());
      if (sandbox.state === "started") return sandbox;
      if (sandbox.state === "error") {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: `Daytona sandbox failed: ${sandbox.error ?? "unknown error"}`,
        });
      }
      await delay(POLL_INTERVAL_MS);
      return poll(i + 1);
    };
    return poll(0);
  }

  private async createProcessSession(base: string, sessionId: string) {
    const res = await fetch(`${base}/process/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona process session create failed: ${res.status} ${text}`,
      });
    }
  }

  private async execCommand(base: string, sessionId: string, command: string) {
    const res = await fetch(`${base}/process/session/${sessionId}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, runAsync: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona process exec failed: ${res.status} ${text}`,
      });
    }
    return daytonaCommandExecSchema.parse(await res.json());
  }

  private async getProcessSession(base: string, sessionId: string) {
    const res = await fetch(`${base}/process/session/${sessionId}`);
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Daytona process session get failed: ${res.status} ${text}`,
      });
    }
    if (!res.ok) return null;
    return daytonaProcessSessionSchema.parse(await res.json());
  }

  private async readResult(
    base: string
  ): Promise<z.infer<typeof codexResultSchema> | null> {
    const res = await fetch(`${base}/process/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat /tmp/codex-result.json", cwd: "/" }),
    });
    if (!res.ok) return null;
    const data = daytonaSyncExecSchema.parse(await res.json());
    if (data.exitCode !== 0 || !data.result) return null;
    const parsed = codexResultSchema.safeParse(JSON.parse(data.result));
    return parsed.success ? parsed.data : null;
  }

  private async start(
    organizationId: string,
    issue: Issue,
    model: string,
    sessionId: string,
    gitIdentity: GitIdentity
  ) {
    const authB64 = this.requireAuth();
    const config = this.requireDaytona();
    if (!issue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue must have a repository",
      });
    }
    const githubToken = await this.githubToken(issue.repo);

    const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    const name = `vortex-codex-${shortId}`;

    const list = await this.listSandboxes(config);
    const existing = list.items.find(
      (s) => s.labels?.["vortex.session"] === sessionId || s.name === name
    );
    if (existing) {
      await this.deleteSandbox(config, existing.id);
    }

    const sandboxEnv = buildSandboxEnv(
      issue,
      model,
      authB64,
      githubToken,
      gitIdentity
    );
    const sandbox = await this.createSandbox(
      config,
      name,
      sessionId,
      organizationId,
      sandboxEnv
    );
    const started = await this.waitForStarted(config, sandbox.id);
    const base = toolboxBase(started);
    await this.createProcessSession(base, sessionId);
    await this.execCommand(base, sessionId, buildRunnerCommand());
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
        message: "Git identity is required for codex-cli",
      });
    }
    const effectiveModel = model ?? this.env.CODEX_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity
    ).catch((err) => {
      console.error("codex-cli start failed", err);
      throw err;
    });

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
    const config = this.requireDaytona();
    const sandbox = await this.findSandbox(config, sessionId);
    if (!sandbox) {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    if (sandbox.state === "error") {
      return {
        id: sessionId,
        agentId: this.id,
        status: "failed",
        result: sandbox.error ?? "Daytona sandbox error",
      };
    }
    if (sandbox.state !== "started") {
      return { id: sessionId, agentId: this.id, status: "created" };
    }

    const base = toolboxBase(sandbox);
    const session = await this.getProcessSession(base, sessionId);
    if (!session) {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    const completedCommand = session.commands.find(
      (c) => typeof c.exitCode === "number"
    );
    if (!completedCommand || completedCommand.exitCode === undefined) {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const result = await this.readResult(base);
    if (!result) {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const status: AgentSessionStatus =
      result.status === "completed" ? "completed" : "failed";
    const prUrl = result.prUrl?.trim() || null;
    const prState = prUrl ? "open" : null;

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
    const config = this.requireDaytona();
    const sandbox = await this.findSandbox(config, sessionId);
    if (sandbox) {
      await this.deleteSandbox(config, sandbox.id);
    }
  }

  async getState(
    providerSessionId: string,
    _trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const config = this.requireDaytona();
    const sandbox = await this.findSandbox(config, providerSessionId);
    if (!sandbox) return null;
    const base = toolboxBase(sandbox);
    const session = await this.getProcessSession(base, providerSessionId);
    return { provider: session, compute: sandbox };
  }
}
