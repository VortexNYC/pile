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
import {
  daytonaConfig,
  daytonaSandboxListSchema,
  daytonaSandboxSchema,
  writeAgentSessionActivity,
} from "./outpost.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderHealth,
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
    "Implement the requested change. Run the project's dependency installation and test/lint commands (for example `pnpm install` and `pnpm run check`). Make commits with clear messages. Push your changes to the current branch and open a GitHub pull request. Include the full PR URL in your final message.",
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
  "import time",
  "import urllib.error",
  "import urllib.request",
  "",
  "HOME = os.environ.get('HOME', '/tmp')",
  "CODEX_HOME = os.path.join(HOME, '.codex')",
  "CODEX_INSTALL_DIR = os.path.join(HOME, '.local', 'bin')",
  "REPO = os.environ['REPO']",
  "BRANCH = os.environ['BRANCH']",
  "GITHUB_TOKEN = os.environ['GITHUB_TOKEN']",
  "ENV_ID = os.environ['CODEX_CLI_ENV_ID']",
  "REPO_DIR = os.path.join(HOME, 'repo')",
  "",
  "def run(cmd, cwd=None, env=None, check=False, **kwargs):",
  "    print('+ ' + ' '.join(str(c) for c in cmd))",
  "    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)",
  "    if check and result.returncode != 0:",
  "        raise RuntimeError(f'Command failed: {cmd} returned {result.returncode}; stdout={result.stdout}; stderr={result.stderr}')",
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
  "    os.makedirs(CODEX_HOME, exist_ok=True)",
  "    with open(os.path.join(CODEX_HOME, 'auth.json'), 'wb') as f:",
  "        f.write(base64.b64decode(auth_b64))",
  "    with open(os.path.join(CODEX_HOME, 'config.toml'), 'w') as f:",
  "        f.write(f'model = \"{model}\"\\n')",
  "        f.write('approval_policy = \"never\"\\n')",
  "        f.write('sandbox_mode = \"danger-full-access\"\\n')",
  "        f.write('[shell_environment_policy]\\n')",
  "        f.write('inherit = \"all\"\\n')",
  "        f.write('ignore_default_excludes = true\\n')",
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
  "    run(['git', 'clone', '--branch', BRANCH, '--single-branch', f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git', REPO_DIR], check=True)",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', 'Codex')], check=True)",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'codex@pile.nyc')], check=True)",
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
  "def create_pr():",
  "    try:",
  "        body = {",
  "            'title': os.environ['ISSUE_TITLE'],",
  "            'head': BRANCH,",
  "            'base': default_branch(),",
  "            'body': f'Closes {os.environ[\"ISSUE_IDENTIFIER\"]}\\n\\nGenerated with Codex Cloud',",
  "        }",
  "        pr = github_api('POST', '/pulls', body)",
  "        return pr['html_url']",
  "    except Exception as e:",
  "        print('create_pr error:', e)",
  "    return ''",
  "",
  "def submit_task(codex_bin):",
  "    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['CODEX_HOME'] = CODEX_HOME",
  "    env['CODEX_INSTALL_DIR'] = CODEX_INSTALL_DIR",
  "    env['PATH'] = CODEX_INSTALL_DIR + ':' + env.get('PATH', '')",
  "    result = subprocess.run(",
  "        [codex_bin, 'cloud', 'exec', '--env', ENV_ID, '--branch', BRANCH, '-'],",
  "        input=prompt, text=True, env=env, capture_output=True",
  "    )",
  "    if result.returncode != 0:",
  "        print('codex cloud exec failed:', result.returncode, result.stdout, result.stderr)",
  "        raise RuntimeError(f'codex cloud exec failed: {result.stderr}')",
  "    task_url = result.stdout.strip().splitlines()[-1]",
  "    print('task url:', task_url)",
  "    return task_url",
  "",
  "def poll_task(codex_bin, task_url):",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['CODEX_HOME'] = CODEX_HOME",
  "    env['CODEX_INSTALL_DIR'] = CODEX_INSTALL_DIR",
  "    env['PATH'] = CODEX_INSTALL_DIR + ':' + env.get('PATH', '')",
  "    for _ in range(240):  # up to 2 hours",
  "        result = subprocess.run(",
  "            [codex_bin, 'cloud', 'list', '--json', '--env', ENV_ID],",
  "            env=env, capture_output=True, text=True",
  "        )",
  "        if result.returncode == 0:",
  "            try:",
  "                data = json.loads(result.stdout)",
  "                for task in data.get('tasks', []):",
  "                    if task.get('url') == task_url:",
  "                        status = task.get('status')",
  "                        print('task status:', status)",
  "                        if status in ('ready', 'applied'):",
  "                            return task",
  "                        if status == 'error':",
  "                            raise RuntimeError(f'Codex Cloud task failed: {task}')",
  "            except Exception as e:",
  "                print('poll parse error:', e)",
  "        time.sleep(30)",
  "    raise RuntimeError('Codex Cloud task did not finish in time')",
  "",
  "def apply_and_push(codex_bin, task_url):",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['CODEX_HOME'] = CODEX_HOME",
  "    env['CODEX_INSTALL_DIR'] = CODEX_INSTALL_DIR",
  "    env['PATH'] = CODEX_INSTALL_DIR + ':' + env.get('PATH', '')",
  "    result = run([codex_bin, 'cloud', 'apply', task_url], cwd=REPO_DIR, env=env, check=False)",
  "    if result.returncode != 0:",
  "        print('codex cloud apply failed:', result.returncode, result.stdout, result.stderr)",
  "        return False",
  "    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=env, capture_output=True, text=True, check=True)",
  "    if not status.stdout.strip():",
  "        print('no changes to commit')",
  "        return False",
  "    run(['git', '-C', REPO_DIR, 'add', '-A'], env=env, check=True)",
  "    run(['git', '-C', REPO_DIR, 'commit', '-m', f'Codex Cloud changes for {BRANCH}'], env=env, check=True)",
  "    run(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=env, check=True)",
  "    return True",
  "",
  "def main():",
  "    auth_b64 = os.environ['CODEX_AUTH_JSON_B64']",
  "    model = os.environ.get('MODEL', 'gpt-reserve')",
  "    write_codex_home(auth_b64, model)",
  "    codex_bin = ensure_codex()",
  "    create_branch()",
  "    clone_repo()",
  "    task_url = submit_task(codex_bin)",
  "    task = poll_task(codex_bin, task_url)",
  "    applied = apply_and_push(codex_bin, task_url)",
  "    pr_url = ''",
  "    if applied:",
  "        pr_url = find_pr() or create_pr()",
  "    summary = task.get('summary', {}) if isinstance(task.get('summary'), dict) else {}",
  "    result_text = json.dumps({'status': task.get('status'), 'files_changed': summary.get('files_changed', 0), 'lines_added': summary.get('lines_added', 0), 'lines_removed': summary.get('lines_removed', 0)})",
  "    with open('/tmp/codex-result.json', 'w') as f:",
  "        json.dump({'status': 'completed' if task.get('status') in ('ready', 'applied') else 'failed', 'prUrl': pr_url, 'branch': BRANCH, 'result': result_text}, f)",
  "    return 0",
  "",
  "if __name__ == '__main__':",
  "    try:",
  "        sys.exit(main())",
  "    except Exception as e:",
  "        with open('/tmp/codex-result.json', 'w') as f:",
  "            json.dump({'status': 'failed', 'prUrl': '', 'branch': BRANCH, 'result': str(e)}, f)",
  "        sys.exit(1)",
].join("\n");

function buildSandboxEnv(
  issue: Issue,
  model: string,
  authB64: string,
  githubToken: string,
  gitIdentity: GitIdentity,
  envId: string
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity);
  return {
    CODEX_AUTH_JSON_B64: authB64,
    CODEX_CLI_ENV_ID: envId,
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

  private async note(
    organizationId: string | undefined,
    sessionId: string | undefined,
    type: "status" | "error" | "action",
    message: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return;
    await writeAgentSessionActivity(
      this.env as WorkerEnv,
      organizationId,
      sessionId,
      type,
      message,
      payload
    );
  }

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

  private requireEnvId(): string {
    const envId = this.env.CODEX_CLI_ENV_ID;
    if (!envId) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_CLI_ENV_ID is not configured",
      });
    }
    return envId;
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

  private async createProcessSession(
    base: string,
    sessionId: string,
    apiKey: string
  ) {
    const res = await fetch(`${base}/process/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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

  private async execCommand(
    base: string,
    sessionId: string,
    command: string,
    apiKey: string
  ) {
    const res = await fetch(`${base}/process/session/${sessionId}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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

  private async getProcessSession(
    base: string,
    sessionId: string,
    apiKey: string
  ) {
    const res = await fetch(`${base}/process/session/${sessionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
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
    base: string,
    apiKey: string
  ): Promise<z.infer<typeof codexResultSchema> | null> {
    const res = await fetch(`${base}/process/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        command: "cat /tmp/codex-result.json",
        cwd: "/",
      }),
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
    const envId = this.requireEnvId();
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

    try {
      const list = await this.listSandboxes(config);
      const existing = list.items.find(
        (s) => s.labels?.["vortex.session"] === sessionId || s.name === name
      );
      if (existing) {
        await this.note(
          organizationId,
          sessionId,
          "status",
          "codex-cli sandbox exists, recreating",
          { sandbox: existing.id, state: existing.state }
        );
        await this.deleteSandbox(config, existing.id);
      }

      const sandboxEnv = buildSandboxEnv(
        issue,
        model,
        authB64,
        githubToken,
        gitIdentity,
        envId
      );
      const sandbox = await this.createSandbox(
        config,
        name,
        sessionId,
        organizationId,
        sandboxEnv
      );
      await this.note(
        organizationId,
        sessionId,
        "status",
        "codex-cli sandbox created",
        { sandbox: sandbox.id, state: sandbox.state }
      );
      const started = await this.waitForStarted(config, sandbox.id);
      await this.note(
        organizationId,
        sessionId,
        "status",
        "codex-cli sandbox started",
        { sandbox: started.id, state: started.state }
      );
      const base = toolboxBase(started);
      await this.createProcessSession(base, sessionId, config.apiKey);
      await this.execCommand(
        base,
        sessionId,
        buildRunnerCommand(),
        config.apiKey
      );
      await this.note(
        organizationId,
        sessionId,
        "action",
        "codex-cli runner started",
        { sandbox: started.id }
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "codex-cli provision failed",
        {
          error: err instanceof Error ? err.message : String(err),
        }
      );
      throw err;
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
    const session = await this.getProcessSession(
      base,
      sessionId,
      config.apiKey
    );
    if (!session) {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    const completedCommand = session.commands.find(
      (c) => typeof c.exitCode === "number"
    );
    if (!completedCommand || completedCommand.exitCode === undefined) {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const result = await this.readResult(base, config.apiKey);
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
      await this.note(
        sandbox.labels?.["vortex.org"],
        sessionId,
        "status",
        "codex-cli sandbox deleted",
        { sandbox: sandbox.id }
      );
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
    const session = await this.getProcessSession(
      base,
      providerSessionId,
      config.apiKey
    );
    return { provider: session, compute: sandbox };
  }

  async health(): Promise<AgentProviderHealth> {
    try {
      this.requireAuth();
      const config = this.requireDaytona();
      this.requireEnvId();
      const res = await fetch(`${config.apiUrl}/sandbox`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, message: `${res.status} ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
