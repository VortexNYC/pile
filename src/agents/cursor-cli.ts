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
import { agentLogToken, agentLogUrl } from "./credentials.js";
import {
  writeAgentSessionActivity,
  openAgentSessionSpan,
  closeAgentSessionSpan,
} from "./daytona.js";
import type { ActivitySpanOptions } from "./daytona.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  DispatchComment,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

const DEFAULT_MODEL = "grok-4.6-medium";
const RESULT_PATH = "/tmp/cursor-result.json";
const NAME_PREFIX = "vortex-cursorcli";
const AGENT_LABEL = "cursor-cli";

const cursorResultSchema = z.object({
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

function buildPrompt(
  issue: Issue,
  gitIdentity?: GitIdentity | null,
  comments?: DispatchComment[]
): string {
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
    ...(comments && comments.length > 0
      ? [
          "",
          "## Follow-up comments",
          "",
          ...comments.map(
            (c) =>
              `- ${c.author}${c.createdAt ? ` (${c.createdAt})` : ""}: ${c.body}`
          ),
        ]
      : []),
    "",
    ...identityLines,
    "",
    "Implement the requested change. Verify proportionate to the diff: always run the project's lint/typecheck (for example `pnpm run check`) when the toolchain exists; when you change code, add or extend tests covering the change and run the relevant suites; skip tests entirely when the diff is docs/config-only. Do not burn time on suites that need network egress the sandbox lacks — note the limitation and move on. Make commits with clear messages. Do not push and do not open a pull request — the runner handles that after you exit.",
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
  "import re",
  "import shutil",
  "import subprocess",
  "import sys",
  "import threading",
  "import time",
  "import urllib.error",
  "import urllib.request",
  "",
  "# Tee everything this runner prints (including the agent subprocess, whose",
  "# output flows through sys.stdout) to a transcript file Pile can read live.",
  "class _Tee:",
  "    def __init__(self, *streams):",
  "        self.streams = streams",
  "    def write(self, s):",
  "        for st in self.streams:",
  "            st.write(s)",
  "    def flush(self):",
  "        for st in self.streams:",
  "            st.flush()",
  "sys.stdout = sys.stderr = _Tee(sys.__stdout__, open('/tmp/agent.log', 'a', buffering=1))",
  "",
  "# Push appended transcript lines back to Pile so they land in the session",
  "# event log and stream out over SSE — no polling of this sandbox's fs.",
  "PILE_LOG_URL = os.environ.get('PILE_LOG_URL')",
  "PILE_LOG_TOKEN = os.environ.get('PILE_LOG_TOKEN')",
  "_ship_stop = threading.Event()",
  "_ship_pos = 0",
  "",
  "def _ship_logs():",
  "    global _ship_pos",
  "    if not (PILE_LOG_URL and PILE_LOG_TOKEN):",
  "        return",
  "    try:",
  "        with open('/tmp/agent.log') as f:",
  "            f.seek(_ship_pos)",
  "            data = f.read()",
  "            _ship_pos = f.tell()",
  "        lines = [l for l in data.splitlines() if l.strip()]",
  "        if not lines:",
  "            return",
  "        req = urllib.request.Request(",
  "            PILE_LOG_URL,",
  "            data=json.dumps({'lines': lines[-100:]}).encode(),",
  "            headers={'Authorization': 'Bearer ' + PILE_LOG_TOKEN, 'Content-Type': 'application/json'})",
  "        urllib.request.urlopen(req, timeout=10)",
  "    except Exception:",
  "        pass",
  "",
  "def _ship_loop():",
  "    while not _ship_stop.is_set():",
  "        _ship_logs()",
  "        _ship_stop.wait(1)",
  "",
  "if PILE_LOG_URL and PILE_LOG_TOKEN:",
  "    threading.Thread(target=_ship_loop, daemon=True).start()",
  "",
  "HOME = os.environ.get('HOME', '/tmp')",
  "CURSOR_INSTALL_DIR = os.path.join(HOME, '.local', 'bin')",
  "REPO = os.environ['REPO']",
  "BRANCH = os.environ['BRANCH']",
  "GITHUB_TOKEN = os.environ['GITHUB_TOKEN']",
  "REPO_DIR = os.path.join(HOME, 'repo')",
  "",
  "def run(cmd, cwd=None, env=None, check=False, **kwargs):",
  "    print(_redact('+ ' + ' '.join(str(c) for c in cmd)))",
  "    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)",
  "    if check and result.returncode != 0:",
  '        raise RuntimeError(f\'Command failed: {_redact(str(cmd))} returned {result.returncode}; stdout={_redact(result.stdout or "")}; stderr={_redact(result.stderr or "")}\')',
  "    return result",
  "",
  "def ensure_cursor():",
  "    on_path = shutil.which('cursor-agent') or shutil.which('agent')",
  "    if on_path:",
  "        return on_path",
  "    for name in ('cursor-agent', 'agent'):",
  "        candidate = os.path.join(CURSOR_INSTALL_DIR, name)",
  "        if os.path.exists(candidate):",
  "            return candidate",
  "    subprocess.run(['bash', '-c', 'curl https://cursor.com/install -fsS | bash'], check=False)",
  "    for name in ('cursor-agent', 'agent'):",
  "        candidate = os.path.join(CURSOR_INSTALL_DIR, name)",
  "        if os.path.exists(candidate):",
  "            result = subprocess.run([candidate, '--version'], capture_output=True, text=True)",
  "            print('cursor version:', result.stdout.strip(), result.stderr.strip())",
  "            return candidate",
  "    raise RuntimeError('cursor-agent install failed: binary not found in ~/.local/bin')",
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
  "    os.makedirs(REPO_DIR, exist_ok=True)",
  "    t0 = time.time()",
  "    run(['curl', '-fsSL', '--max-time', '120', '-H', f'Authorization: Bearer {GITHUB_TOKEN}', '-o', '/tmp/repo.tgz', f'https://codeload.github.com/{REPO}/tar.gz/{BRANCH}'], check=True)",
  "    run(['tar', '-xzf', '/tmp/repo.tgz', '--strip-components=1', '-C', REPO_DIR], check=True)",
  "    print(f'[timing] codeload tarball: {time.time() - t0:.0f}s')",
  "    t1 = time.time()",
  "    run(['git', '-C', REPO_DIR, 'init', '-b', BRANCH], check=True)",
  "    run(['git', '-C', REPO_DIR, 'remote', 'add', 'origin', f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git'], check=True)",
  "    run(['timeout', '300', 'git', '-C', REPO_DIR, '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--depth', '1', 'origin', BRANCH], check=True)",
  "    run(['git', '-C', REPO_DIR, 'update-ref', f'refs/heads/{BRANCH}', 'FETCH_HEAD'], check=True)",
  "    run(['git', '-C', REPO_DIR, 'symbolic-ref', 'HEAD', f'refs/heads/{BRANCH}'], check=True)",
  "    run(['git', '-C', REPO_DIR, 'reset'], check=True)",
  "    print(f'[timing] git fetch: {time.time() - t1:.0f}s')",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', 'Cursor')], check=True)",
  "    run(['git', '-C', REPO_DIR, 'config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'cursor@pile.nyc')], check=True)",
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
  "            'body': f'Closes {os.environ[\"ISSUE_IDENTIFIER\"]}\\n\\nGenerated with Cursor CLI',",
  "        }",
  "        pr = github_api('POST', '/pulls', body)",
  "        return pr['html_url']",
  "    except Exception as e:",
  "        print('create_pr error:', e)",
  "        PR_ERRORS.append(f'create_pr: {e}')",
  "    return ''",
  "",
  "def cli_env():",
  "    env = os.environ.copy()",
  "    env['HOME'] = HOME",
  "    env['PATH'] = CURSOR_INSTALL_DIR + ':' + env.get('PATH', '')",
  "    return env",
  "",
  "def _redact(s):",
  "    s = re.sub(r'(Bearer|x-access-token:)\\s*\\S+', r'\\1 ***', s)",
  "    s = re.sub(r'ghs_[A-Za-z0-9_.-]+', 'ghs_***', s)",
  "    return s",
  "",
  "def _render_event(evt):",
  "    # Render one cursor-agent stream-json event as a readable log line.",
  "    t = evt.get('type')",
  "    if t == 'assistant':",
  "        for part in (evt.get('message') or {}).get('content') or []:",
  "            if part.get('type') == 'text' and part.get('text'):",
  "                return part['text'].rstrip()",
  "        return None",
  "    if t == 'tool_call':",
  "        if evt.get('subtype') != 'started':",
  "            return None",
  "        call = evt.get('tool_call') or {}",
  "        name = next(iter(call), 'tool')",
  "        args = call.get(name) or {}",
  "        a = args.get('args') or {}",
  "        target = a.get('path') or a.get('command') or a.get('cmd') or a.get('pattern') or ''",
  '        return f\'→ {name.replace("ToolCall","")} {str(target)[:120]}\'.rstrip()',
  "    if t == 'result':",
  '        return f\'[result] {evt.get("subtype", "")} duration={evt.get("duration_ms", "?")}ms\'',
  "    if t in ('user', 'thinking', 'system'):",
  "        return None",
  "    return None",
  "",
  "def run_cursor(agent_bin):",
  "    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')",
  "    model = os.environ.get('MODEL', '')",
  "    cmd = [agent_bin, '-p', prompt, '--force', '--trust', '--output-format', 'stream-json']",
  "    if model:",
  "        cmd += ['--model', model]",
  "    proc = subprocess.Popen(",
  "        cmd, cwd=REPO_DIR, env=cli_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True",
  "    )",
  "    tail = []",
  "    events = open('/tmp/agent-events.ndjson', 'a', buffering=1)",
  "    try:",
  "        for line in proc.stdout:",
  "            events.write(line)",
  "            tail.append(line)",
  "            try:",
  "                evt = json.loads(line)",
  "            except ValueError:",
  "                print(_redact(line), end='')",
  "                continue",
  "            rendered = _render_event(evt)",
  "            if rendered:",
  "                print(_redact(rendered))",
  "        proc.wait(timeout=7200)",
  "    except subprocess.TimeoutExpired:",
  "        proc.kill()",
  "        raise",
  "    finally:",
  "        events.close()",
  "    output = ''.join(tail)[-4000:]",
  "    print('cursor-agent exit:', proc.returncode)",
  "    if proc.returncode != 0:",
  "        raise RuntimeError(f'cursor-agent -p failed ({proc.returncode}): {_redact(output[-500:])}')",
  "    return output",
  "",
  "def commit_and_push():",
  "    env = cli_env()",
  "    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=env, capture_output=True, text=True, check=True)",
  "    ahead = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'origin/{BRANCH}..HEAD'], env=env, capture_output=True, text=True, check=True)",
  "    if status.stdout.strip():",
  "        run(['git', '-C', REPO_DIR, 'add', '-A'], env=env, check=True)",
  "        run(['git', '-C', REPO_DIR, 'commit', '-m', f'Cursor CLI changes for {BRANCH}'], env=env, check=True)",
  "    elif ahead.stdout.strip() == '0':",
  "        print('no changes to commit')",
  "        return False",
  "    run(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=env, check=True)",
  "    return True",
  "",
  "def main():",
  "    agent_bin = ensure_cursor()",
  "    create_branch()",
  "    clone_repo()",
  "    output = run_cursor(agent_bin)",
  "    pushed = commit_and_push()",
  "    pr_url = ''",
  "    if pushed:",
  "        pr_url = find_pr() or create_pr()",
  "    try:",
  "        with open('/tmp/agent.log') as f:",
  "            transcript = f.read()[-65536:]",
  "    except OSError:",
  "        transcript = output",
  "    result_text = json.dumps({'output_tail': output, 'transcript': transcript, 'pr_errors': PR_ERRORS})",
  "    with open('/tmp/cursor-result.json', 'w') as f:",
  "        json.dump({'status': 'completed', 'prUrl': pr_url, 'branch': BRANCH, 'result': result_text}, f)",
  "    _ship_stop.set()",
  "    _ship_logs()",
  "    return 0",
  "",
  "if __name__ == '__main__':",
  "    try:",
  "        sys.exit(main())",
  "    except Exception as e:",
  "        with open('/tmp/cursor-result.json', 'w') as f:",
  "            json.dump({'status': 'failed', 'prUrl': '', 'branch': BRANCH, 'result': str(e)}, f)",
  "        _ship_stop.set()",
  "        _ship_logs()",
  "        sys.exit(1)",
].join("\n");

function buildSandboxEnv(
  issue: Issue,
  model: string,
  apiKey: string,
  githubToken: string,
  gitIdentity: GitIdentity,
  comments?: DispatchComment[],
  logUrl?: string | null,
  logToken?: string | null
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity, comments);
  return {
    ...(logUrl && logToken
      ? { PILE_LOG_URL: logUrl, PILE_LOG_TOKEN: logToken }
      : {}),
    CURSOR_API_KEY: apiKey,
    GITHUB_TOKEN: githubToken,
    GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity.name),
    GIT_AUTHOR_EMAIL: sanitizeEnv(gitIdentity.email),
    REPO: repo,
    BRANCH: branch,
    ISSUE_TITLE: sanitizeEnv(issue.title),
    ISSUE_IDENTIFIER: identifier,
    MODEL: model,
    PROMPT_B64: encodeBase64(prompt),
    // Daytona mounts DAYTONA_VOLUME_ID at /home/daytona/cache; on CF sandboxes
    // this is just a local dir — harmless, and keeps the path consistent.
    npm_config_store_dir: "/home/daytona/cache/pnpm-store",
    RUNNER_PY_B64: encodeBase64(PYTHON_RUNNER),
  };
}

function sandboxName(sessionId: string): string {
  return `${NAME_PREFIX}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function buildRunnerCommand(): string {
  return "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py";
}

export class CursorCliAgentProvider implements AgentProvider {
  readonly id = "cursor-cli";

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
    const apiKey = this.env.CURSOR_API_KEY ?? this.env.AGENT_PROVIDER_TOKEN;
    if (!apiKey || typeof apiKey !== "string") {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CURSOR_API_KEY is not configured",
      });
    }
    return apiKey;
  }

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env, "cursor-cli");
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
    gitIdentity: GitIdentity,
    comments?: DispatchComment[]
  ) {
    const apiKey = this.requireAuth();
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
      "provision cursor-cli sandbox",
      { session: sessionId }
    );
    try {
      const existing = await compute.findSandbox(sessionId, name);
      if (existing) {
        await this.note(
          organizationId,
          sessionId,
          "status",
          "cursor-cli sandbox exists, recreating",
          { sandbox: existing.id, state: existing.state },
          { parentId: spanId }
        );
        await compute.deleteSandbox(existing);
      }

      const workerEnv = this.env as WorkerEnv;
      const sandboxEnv = buildSandboxEnv(
        issue,
        model,
        apiKey,
        githubToken,
        gitIdentity,
        comments,
        agentLogUrl(workerEnv, organizationId, sessionId),
        await agentLogToken(workerEnv, organizationId, sessionId)
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
        "cursor-cli sandbox started",
        { sandbox: sandbox.id, state: sandbox.state, backend: compute.kind },
        { parentId: spanId }
      );
      await compute.startRunner(sandbox, sessionId, buildRunnerCommand());
      await this.note(
        organizationId,
        sessionId,
        "action",
        "cursor-cli runner started",
        { sandbox: sandbox.id },
        { parentId: spanId }
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "cursor-cli provision failed",
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
        message: "Git identity is required for cursor-cli",
      });
    }
    const effectiveModel = model ?? this.env.CURSOR_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity,
      sessionContext?.comments
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
        infraFailure: true,
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
    let result: z.infer<typeof cursorResultSchema> | null = null;
    if (raw) {
      try {
        const parsed = cursorResultSchema.safeParse(JSON.parse(raw));
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
        infraFailure: true,
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
        "cursor-cli sandbox deleted",
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
    const transcript = await compute.readFile(sandbox, "/tmp/agent.log");
    const logs =
      (transcript ? transcript.slice(-131072) : null) ??
      (await compute.runnerLogs?.(sandbox, providerSessionId)) ??
      null;
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
