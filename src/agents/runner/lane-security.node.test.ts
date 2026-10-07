import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isSafeLaneBranch } from "../../global/lane-guard.js";
import { resolvePython } from "./python";

// PILE-277 — runner half of the lane adversarial suite, ported from
// pullfrog's test/crossagent + test/adhoc vectors. Each case plays the
// hostile agent: it gets the checkout, $HOME and its PATH to itself, plants
// whatever it likes, then the real core.py (+ cursor driver) runs its
// commit/push against a local bare "origin". A canary file appearing, a
// ref moving where it must not, or a token surfacing means the lane broke
// out. Pile-side endpoints are covered in src/api/lane-security.test.ts.
//
// Not ported: pullfrog's nobash / nobashcreative suites target a tier with
// the shell tool disabled. Pile lanes always run the agent with a shell, so
// "agent executes a command" is the baseline here, not an escape — the
// boundary is what that shell can reach, which the cases below exercise.

const CORE_PATH = join(import.meta.dirname, "core.py");
const DRIVER_PATH = join(import.meta.dirname, "cursor.py");
const LANE_BRANCH = "issue-277-lane";
const INSTALLATION_TOKEN = "ghs_LaneSecurityFakeInstallationToken0001";
const LANE_TOKEN = "a".repeat(64);

const HARNESS = `
import json
import os
import sys
import types

core_path, driver_path, mode, arg = sys.argv[1:5]
mod = types.ModuleType("pile_runner")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    src = f.read()
with open(driver_path) as f:
    src += "\\n" + f.read()
exec(compile(src, core_path, "exec"), mod.__dict__)
g = mod.__dict__
g["RESULT_FILE"] = os.environ["TEST_RESULT_FILE"]
g["github_api"] = lambda method, path, body=None: {"default_branch": "main"}
g["remote_url"] = lambda: "file://" + os.environ["TEST_REMOTE"]

out = {}
if mode == "push":
    try:
        out["pushed"] = g["commit_and_push"](g["agent_env"]())
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
elif mode == "branches":
    out["results"] = {}
    for b in json.loads(arg):
        g["BRANCH"] = b
        try:
            g["commit_and_push"](g["agent_env"]())
            out["results"][b] = "pushed"
        except Exception as e:
            out["results"][b] = "%s: %s" % (type(e).__name__, e)
elif mode == "env":
    env = g["agent_env"]()
    out["keys"] = sorted(k for k in env if k in os.environ)
elif mode == "result":
    g["write_result"]("completed", "", arg, report=arg)
    with open(g["RESULT_FILE"]) as f:
        out["file"] = f.read()
print("RESULT:" + json.dumps(out), flush=True)
`;

interface Lane {
  root: string;
  home: string;
  repo: string;
  remote: string;
  evil: string;
  canary: string;
  harness: string;
  resultFile: string;
}

const lanes: string[] = [];

// Real CPython resolved past any PATH shim; the suite skips when absent.
const PYTHON = resolvePython();
const describePy = describe.skipIf(PYTHON === null);

afterEach(() => {
  for (const dir of lanes.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Host env minus anything that could steer git or the runner, so every case
// starts from the same clean slate regardless of the developer's machine.
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|PILE_|LANE_|npm_config_store_dir$)/.test(key)) delete env[key];
  }
  return env;
}

function seedEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Seed",
    GIT_AUTHOR_EMAIL: "seed@example.com",
    GIT_COMMITTER_NAME: "Seed",
    GIT_COMMITTER_EMAIL: "seed@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: seedEnv(),
    encoding: "utf8",
  }).trim();
}

/** Bare origin with `main` + the lane branch, cloned into $HOME/repo. */
function makeLane(): Lane {
  const root = mkdtempSync(join(tmpdir(), "pile-lane-sec-"));
  lanes.push(root);
  const home = join(root, "home");
  const remote = join(root, "remote.git");
  const evil = join(root, "evil.git");
  const seed = join(root, "seed");
  mkdirSync(home);
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "--bare", "-b", "main", evil);
  git(root, "init", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", remote, "main", `main:${LANE_BRANCH}`);
  const repo = join(home, "repo");
  git(root, "clone", "-q", "-b", LANE_BRANCH, remote, repo);
  const harness = join(root, "harness.py");
  writeFileSync(harness, HARNESS);
  return {
    root,
    home,
    repo,
    remote,
    evil,
    canary: join(root, "CANARY"),
    harness,
    resultFile: join(root, "agent-result.json"),
  };
}

function runnerEnv(
  lane: Lane,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    HOME: lane.home,
    REPO: "acme/widgets",
    BRANCH: LANE_BRANCH,
    GITHUB_TOKEN: INSTALLATION_TOKEN,
    GIT_AUTHOR_NAME: "Lane Bot",
    GIT_AUTHOR_EMAIL: "lane@example.com",
    GIT_COMMITTER_NAME: "Lane Bot",
    GIT_COMMITTER_EMAIL: "lane@example.com",
    AGENT_LABEL: "Cursor",
    PROMPT_B64: "",
    TEST_REMOTE: lane.remote,
    TEST_RESULT_FILE: lane.resultFile,
    ...extra,
  };
}

interface HarnessOut {
  pushed?: boolean;
  error?: string;
  results?: Record<string, string>;
  keys?: string[];
  file?: string;
}

function runHarness(
  lane: Lane,
  mode: "push" | "branches" | "env" | "result",
  arg = "",
  extraEnv: Record<string, string> = {}
): HarnessOut {
  if (!PYTHON) throw new Error("unreachable: suite skipped without CPython");
  const out = execFileSync(
    PYTHON,
    [lane.harness, CORE_PATH, DRIVER_PATH, mode, arg],
    { encoding: "utf8", env: runnerEnv(lane, extraEnv), timeout: 60_000 }
  );
  const line = out
    .trim()
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`harness emitted no RESULT line:\n${out}`);
  return JSON.parse(line.slice("RESULT:".length)) as HarnessOut;
}

/** Shell script that records it ran (and what it saw) into the canary. */
function canaryScript(lane: Lane, path: string, tag: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "${tag} $0 $*" >> "${lane.canary}"\nenv >> "${lane.canary}"\ncat >> "${lane.canary}" 2>/dev/null\nexit 0\n`
  );
  chmodSync(path, 0o755);
}

function refs(bare: string): string {
  return git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
}

function remoteSha(lane: Lane, ref: string): string {
  return git(lane.remote, "rev-parse", ref);
}

function agentCommit(lane: Lane, file: string, body: string): void {
  writeFileSync(join(lane.repo, file), body);
  git(lane.repo, "add", "-A");
  git(lane.repo, "commit", "-q", "-m", `agent ${file}`);
}

function expectNoCanary(lane: Lane): void {
  const seen = existsSync(lane.canary) ? readFileSync(lane.canary, "utf8") : "";
  expect(seen).toBe("");
}

function expectLanePushed(lane: Lane, file: string): void {
  expect(git(lane.remote, "show", `refs/heads/${LANE_BRANCH}:${file}`)).toBe(
    readFileSync(join(lane.repo, file), "utf8").trim()
  );
}

describePy("lane security: runner commit/push (PILE-277)", () => {
  it("gitHooks: planted hooks, hooksPath and fsmonitor never run under the runner", () => {
    const lane = makeLane();
    const hooks = join(lane.repo, ".git", "hooks");
    for (const hook of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "pre-push",
      "reference-transaction",
      "post-index-change",
    ]) {
      canaryScript(lane, join(hooks, hook), `hook:${hook}`);
    }
    const altHooks = join(lane.root, "alt-hooks");
    mkdirSync(altHooks);
    for (const hook of ["pre-commit", "pre-push", "reference-transaction"]) {
      canaryScript(lane, join(altHooks, hook), `hooksPath:${hook}`);
    }
    const fsmonitor = join(lane.root, "fsmonitor.sh");
    canaryScript(lane, fsmonitor, "fsmonitor");
    git(lane.repo, "config", "core.hooksPath", altHooks);
    git(lane.repo, "config", "core.fsmonitor", fsmonitor);
    writeFileSync(join(lane.repo, "change.txt"), "uncommitted work\n");

    const res = runHarness(lane, "push");
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expectNoCanary(lane);
    expectLanePushed(lane, "change.txt");
  });

  it("pushRestrictedAdversarial: config refspecs, mirror, pushurl and local main commits cannot move other refs", () => {
    const lane = makeLane();
    const mainBefore = remoteSha(lane, "refs/heads/main");
    // Agent smuggles work onto main and a tag, then rewires push config.
    git(lane.repo, "checkout", "-q", "-b", "main", "origin/main");
    agentCommit(lane, "evil-main.txt", "on main\n");
    git(lane.repo, "tag", "v9.9.9");
    git(lane.repo, "checkout", "-q", LANE_BRANCH);
    agentCommit(lane, "lane.txt", "lane work\n");
    git(lane.repo, "remote", "add", "evil", `file://${lane.evil}`);
    git(
      lane.repo,
      "config",
      "--add",
      "remote.origin.push",
      "+refs/heads/main:refs/heads/main"
    );
    git(
      lane.repo,
      "config",
      "--add",
      "remote.origin.push",
      `+refs/heads/${LANE_BRANCH}:refs/heads/main`
    );
    git(
      lane.repo,
      "config",
      "--add",
      "remote.origin.push",
      "refs/tags/*:refs/tags/*"
    );
    git(lane.repo, "config", "remote.origin.mirror", "true");
    git(lane.repo, "config", "remote.origin.pushurl", `file://${lane.evil}`);
    git(lane.repo, "config", "push.default", "matching");
    git(lane.repo, "config", "push.followTags", "true");
    git(lane.repo, "config", `branch.${LANE_BRANCH}.merge`, "refs/heads/main");
    git(lane.repo, "config", `branch.${LANE_BRANCH}.pushRemote`, "evil");

    const res = runHarness(lane, "push");
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expect(remoteSha(lane, "refs/heads/main")).toBe(mainBefore);
    expect(refs(lane.remote)).not.toContain("refs/tags/");
    expect(refs(lane.evil)).toBe("");
    expectLanePushed(lane, "lane.txt");
  });

  it("pushRestrictedAdversarial: url rewrites, includes and $HOME git config cannot redirect the push", () => {
    const lane = makeLane();
    const rewrite = `url.file://${lane.evil}.pushInsteadOf`;
    git(lane.repo, "config", rewrite, `file://${lane.remote}`);
    git(
      lane.repo,
      "config",
      `url.file://${lane.evil}.insteadOf`,
      `file://${lane.remote}`
    );
    const include = join(lane.root, "included.gitconfig");
    writeFileSync(
      include,
      `[remote "origin"]\n\tpushurl = file://${lane.evil}\n`
    );
    git(lane.repo, "config", "include.path", include);
    git(lane.repo, "config", "extensions.worktreeConfig", "true");
    writeFileSync(
      join(lane.repo, ".git", "config.worktree"),
      `[remote "origin"]\n\tpushurl = file://${lane.evil}\n`
    );
    const homeConfig = `[url "file://${lane.evil}"]\n\tpushInsteadOf = file://${lane.remote}\n[core]\n\thooksPath = ${lane.root}\n`;
    writeFileSync(join(lane.home, ".gitconfig"), homeConfig);
    mkdirSync(join(lane.home, ".config", "git"), { recursive: true });
    writeFileSync(join(lane.home, ".config", "git", "config"), homeConfig);
    agentCommit(lane, "lane.txt", "lane work\n");

    const res = runHarness(lane, "push");
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expect(refs(lane.evil)).toBe("");
    expectLanePushed(lane, "lane.txt");
  });

  it("pushRestrictedAdversarial: refuses to push when the lane branch is the default branch", () => {
    const lane = makeLane();
    const mainBefore = remoteSha(lane, "refs/heads/main");
    git(lane.repo, "checkout", "-q", "-b", "main", "origin/main");
    agentCommit(lane, "evil-main.txt", "direct to main\n");

    const res = runHarness(lane, "push", "", { BRANCH: "main" });
    expect(res.error).toMatch(/default branch/);
    expect(remoteSha(lane, "refs/heads/main")).toBe(mainBefore);
  });

  it("gitFlagInjection: option-, refspec- and revision-shaped branch names never reach git", () => {
    const lane = makeLane();
    const marker = join(lane.root, "pwned");
    const branches = [
      `--upload-pack=touch ${marker}`,
      `--receive-pack=touch ${marker}`,
      `--exec-path=${lane.root}`,
      "-c",
      `-ccore.sshCommand=touch ${marker}`,
      "--config-env=core.hooksPath=HOME",
      `-C${lane.root}`,
      "--mirror",
      "--all",
      "--force",
      `${LANE_BRANCH}:main`,
      `${LANE_BRANCH}:refs/heads/main`,
      `+${LANE_BRANCH}`,
      "refs/heads/main",
      "heads/main",
      "HEAD",
      `${LANE_BRANCH}..main`,
      `${LANE_BRANCH}~1`,
      `${LANE_BRANCH}^{}`,
      "@{-1}",
      `${LANE_BRANCH} main`,
      `${LANE_BRANCH}\nmain`,
      ".hidden",
      `${LANE_BRANCH}.lock`,
      "",
    ];
    const mainBefore = remoteSha(lane, "refs/heads/main");
    const laneBefore = remoteSha(lane, `refs/heads/${LANE_BRANCH}`);
    agentCommit(lane, "lane.txt", "lane work\n");

    const res = runHarness(lane, "branches", JSON.stringify(branches));
    for (const branch of branches) {
      expect(isSafeLaneBranch(branch), branch).toBe(false);
      expect(res.results?.[branch], branch).toMatch(/unsafe lane branch/);
    }
    expect(existsSync(marker)).toBe(false);
    expect(remoteSha(lane, "refs/heads/main")).toBe(mainBefore);
    expect(remoteSha(lane, `refs/heads/${LANE_BRANCH}`)).toBe(laneBefore);
    expect(isSafeLaneBranch(LANE_BRANCH)).toBe(true);
    expect(isSafeLaneBranch("cursor/fix-thing")).toBe(true);
  });

  it("askpassIntercept: credential helpers, askpass and a shadowed git binary never see the push token", () => {
    const lane = makeLane();
    const helper = join(lane.root, "helper.sh");
    canaryScript(lane, helper, "credential-helper");
    const askpass = join(lane.root, "askpass.sh");
    canaryScript(lane, askpass, "askpass");
    git(lane.repo, "config", "credential.helper", helper);
    git(lane.repo, "config", "core.askPass", askpass);
    git(lane.repo, "config", "core.sshCommand", askpass);
    git(lane.repo, "config", "alias.push", `!${askpass}`);
    // A git earlier on the agent's PATH than the real one.
    const bin = join(lane.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    canaryScript(lane, join(bin, "git"), "shadow-git");
    agentCommit(lane, "lane.txt", "lane work\n");

    const res = runHarness(lane, "push");
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expectNoCanary(lane);
    expectLanePushed(lane, "lane.txt");
  });

  it("requirementsTxtAttack / packageJsonScripts: repo-declared code and filter drivers do not run in the runner's commit/push", () => {
    const lane = makeLane();
    const hook = join(lane.root, "evil.sh");
    canaryScript(lane, hook, "repo-code");
    writeFileSync(
      join(lane.repo, "package.json"),
      JSON.stringify({
        name: "victim",
        scripts: {
          preinstall: hook,
          install: hook,
          postinstall: hook,
          prepare: hook,
          prepack: hook,
          precommit: hook,
          prepush: hook,
        },
      })
    );
    writeFileSync(join(lane.repo, "requirements.txt"), "-e .\n");
    writeFileSync(
      join(lane.repo, "setup.py"),
      `import subprocess\nsubprocess.run(["${hook}"])\n`
    );
    writeFileSync(
      join(lane.repo, ".gitattributes"),
      "* filter=evil diff=evil\n"
    );
    git(lane.repo, "config", "filter.evil.clean", hook);
    git(lane.repo, "config", "filter.evil.smudge", hook);
    git(lane.repo, "config", "filter.evil.process", hook);
    git(lane.repo, "config", "filter.evil.required", "true");
    git(lane.repo, "config", "diff.evil.textconv", hook);
    git(lane.repo, "config", "core.pager", hook);

    const res = runHarness(lane, "push");
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expectNoCanary(lane);
    expectLanePushed(lane, "setup.py");
  });

  it("fsExfil: a .git swapped for a gitfile or symlink is refused instead of pushed", () => {
    for (const swap of ["gitfile", "symlink"] as const) {
      const lane = makeLane();
      const elsewhere = join(lane.root, "elsewhere.git");
      git(lane.root, "clone", "-q", "--bare", lane.remote, elsewhere);
      const dotGit = join(lane.repo, ".git");
      rmSync(dotGit, { recursive: true, force: true });
      if (swap === "gitfile") {
        writeFileSync(dotGit, `gitdir: ${elsewhere}\n`);
      } else {
        execFileSync("ln", ["-s", elsewhere, dotGit]);
      }
      const laneBefore = remoteSha(lane, `refs/heads/${LANE_BRANCH}`);
      const res = runHarness(lane, "push");
      expect(res.error, swap).toMatch(/not a plain directory/);
      expect(remoteSha(lane, `refs/heads/${LANE_BRANCH}`)).toBe(laneBefore);
    }
  });

  it("tokenExfil: the agent process does not inherit Pile lane credentials", () => {
    const lane = makeLane();
    const pileEnv = {
      LANE_TOKEN,
      PILE_TOKEN_URL: "http://127.0.0.1:9/github-token",
      PILE_LOG_TOKEN: LANE_TOKEN,
      PILE_LOG_URL: "http://127.0.0.1:9/logs",
      PILE_CACHE_URL: "http://127.0.0.1:9/cache",
      RUNNER_PY_B64: "cHJpbnQoMSk=",
    };
    const res = runHarness(lane, "env", "", pileEnv);
    for (const key of Object.keys(pileEnv)) {
      expect(res.keys).not.toContain(key);
    }
  });

  it("tokenExfil: the agent process environment carries no installation token", () => {
    const lane = makeLane();
    const res = runHarness(lane, "env");
    expect(res.keys).not.toContain("GITHUB_TOKEN");
  });

  it("tokenExfil: credentials echoed into the transcript are masked in the result file", () => {
    const lane = makeLane();
    const leak = [
      `GITHUB_TOKEN=${INSTALLATION_TOKEN}`,
      `https://x-access-token:${INSTALLATION_TOKEN}@github.com/acme/widgets.git`,
      "gho_OAuthTokenValue12345678 ghp_ClassicPat12345678 ghu_UserTok12345678",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      `Authorization: Bearer ${LANE_TOKEN}`,
    ].join("\n");
    const res = runHarness(lane, "result", leak);
    const file = res.file ?? "";
    expect(file).toContain("***");
    for (const secret of [
      INSTALLATION_TOKEN,
      "gho_OAuthTokenValue",
      "ghp_ClassicPat",
      "ghu_UserTok",
      "github_pat_11ABCDEFG",
      LANE_TOKEN,
    ]) {
      expect(file).not.toContain(secret);
    }
  });
});
