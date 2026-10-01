# Pile agent runner — shared core.
#
# This file is concatenated with a per-agent driver (cursor.py, devin.py,
# codex.py) and shipped to the sandbox as RUNNER_PY_B64. Everything an agent
# lane needs that is NOT agent-specific lives here: transcript tee, redact,
# agent env allowlist, GitHub token refresh/revoke,
# repo ops, GitHub API, PR creation, lane digest, GitHub token refresh, log
# shipping, pnpm-store cache, postgres warmup, .pile/setup.sh, lane lifecycle
# hooks. Drivers only define: ensure(), agent_env(), the run mechanism, and
# main().
#
# Contract with the adapter: the process writes RESULT_FILE
# (/tmp/agent-result.json) with {status, prUrl, branch, result, report?,
# infraFailure?} — infraFailure marks substrate failures (git transport,
# codeload, token mint) so the sweep retries instead of failing the task.
import base64
import calendar
import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# Credential masking. The lane is assumed compromised: anything it prints —
# runner commands, agent output, errors — may carry a secret, so every line
# is masked before it reaches the transcript, the shipped log, or the result
# file. Exact values of secret-bearing env vars are masked verbatim; known
# token shapes are masked even when the value was never in our env.
_SECRET_ENV_RE = re.compile(r'TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS|AUTH', re.I)
_MASKS = set()
_REDACT_PATTERNS = (
    (re.compile(r'(://[^:/\s@]+:)[^@\s/]+@'), r'\1***@'),
    (re.compile(r'(Bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*'), r'\1 ***'),
    (re.compile(r'(authorization:\s*token)\s+\S+', re.I), r'\1 ***'),
    (re.compile(r'(x-access-token:)\s*[^@\s]+'), r'\1***'),
    (re.compile(r'(authorization:\s*basic\s+)\S+', re.I), r'\1***'),
    (re.compile(r'\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_.-]+'), r'\1_***'),
    (re.compile(r'\bgithub_pat_[A-Za-z0-9_]+'), 'github_pat_***'),
    (re.compile(r'\bsk-[A-Za-z0-9_-]{16,}'), 'sk-***'),
    (re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{8,}'), 'xox-***'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}'), 'jwt-***'),
)


def add_mask(value):
    if isinstance(value, str) and len(value) >= 8:
        _MASKS.add(value)


def mask_credential_blob(raw):
    # Credential files (devin credentials.toml, codex auth.json) are decoded
    # inside the sandbox — mask every long quoted value they contain.
    text = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else raw
    for value in re.findall(r'"([^"\s]{16,})"', text):
        add_mask(value)


for _key, _value in os.environ.items():
    if _SECRET_ENV_RE.search(_key):
        add_mask(_value)


def _redact(s):
    if not isinstance(s, str):
        s = str(s)
    for value in sorted(_MASKS, key=len, reverse=True):
        if value in s:
            s = s.replace(value, '***')
    for pattern, repl in _REDACT_PATTERNS:
        s = pattern.sub(repl, s)
    return s


# Tee everything this runner prints (including the agent subprocess, whose
# output flows through sys.stdout) to a transcript file Pile can read live.
class _Tee:
    def __init__(self, *streams):
        self.streams = streams
    def write(self, s):
        s = _redact(s)
        for st in self.streams:
            st.write(s)
    def flush(self):
        for st in self.streams:
            st.flush()
sys.stdout = sys.stderr = _Tee(sys.__stdout__, open('/tmp/agent.log', 'a', buffering=1))

HOME = os.environ.get('HOME', '/tmp')
INSTALL_DIR = os.path.join(HOME, '.local', 'bin')
REPO = os.environ.get('REPO', '')
BRANCH = os.environ.get('BRANCH', '')
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')


def _parse_expiry(value):
    try:
        return calendar.timegm(time.strptime(value or '', '%Y-%m-%dT%H:%M:%SZ'))
    except ValueError:
        return 0


GITHUB_TOKEN_EXPIRES_AT = _parse_expiry(os.environ.get('GITHUB_TOKEN_EXPIRES_AT'))
# Re-mint this long before expiry so no GitHub call races the TTL.
TOKEN_REFRESH_MARGIN_SEC = 300
REPO_DIR = os.path.join(HOME, 'repo')
RESULT_FILE = '/tmp/agent-result.json'
AGENT_LABEL = os.environ.get('AGENT_LABEL', 'Agent')
PR_ERRORS = []
RUN_STARTED = time.time()
# Resolved before the agent runs: the agent can write ~/.local/bin (first on
# its PATH), so the runner's own commit/push never resolves git through it.
GIT = shutil.which('git') or '/usr/bin/git'




_SAFE_BRANCH_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]*$')


def validate_branch():
    # BRANCH reaches git argv, refspecs and the codeload URL. Refuse anything
    # git could read as an option, refspec, qualified/symbolic ref or
    # revision expression (mirrors isSafeLaneBranch on the Pile side).
    b = BRANCH
    ok = (
        0 < len(b) <= 200
        and _SAFE_BRANCH_RE.match(b)
        and '..' not in b and '//' not in b
        and not b.endswith(('/', '.', '.lock'))
        and not any(part.startswith('.') for part in b.split('/'))
        and not re.match(r'^(refs|heads|tags|remotes)/', b, re.I)
        and not re.match(r'^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$', b, re.I)
    )
    if not ok:
        raise RuntimeError(f'refusing unsafe lane branch name: {b!r}')

# Lane permission tiers (PILE-276), resolved from the repo's .pile/config.json
# at dispatch. Unknown values fail closed to 'disabled'.
_TIERS = ('disabled', 'restricted', 'enabled')


def _tier(name):
    value = os.environ.get(name, 'enabled')
    return value if value in _TIERS else 'disabled'


PUSH_POLICY = _tier('PILE_PUSH_POLICY')
SHELL_POLICY = _tier('PILE_SHELL_POLICY')
# Runner-owned credentials and plumbing the agent never needs.
RUNNER_SECRET_ENV = {
    'GITHUB_TOKEN', 'GH_TOKEN', 'LANE_TOKEN', 'PILE_TOKEN_URL',
    'PILE_LOG_TOKEN', 'PILE_LOG_URL', 'PILE_CACHE_URL', 'PILE_API_KEY',
    'DEVIN_CREDENTIALS_B64', 'CODEX_AUTH_JSON_B64', 'RUNNER_PY_B64',
    'PROMPT_B64',
}
# Credentials that can write to or mint for the repo — stripped from the
# agent whenever push is below 'enabled', whatever the shell tier.
PUSH_SECRET_ENV = {'GITHUB_TOKEN', 'GH_TOKEN', 'LANE_TOKEN', 'PILE_TOKEN_URL'}
SECRET_NAME = re.compile(r'(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_KEY|_KEY$|_PAT$|_DSN$|DATABASE_URL|AUTH(_|$))', re.I)
# Git config injected (command scope, beats repo config) into every git call
# the runner makes when shell=disabled: hooks and fsmonitor are how a
# file-edit-only agent would get code executed by the runner's git.
NO_HOOKS_GIT_CONFIG = [('core.hooksPath', '/dev/null'), ('core.fsmonitor', 'false')]
GIT_CONFIG_SNAPSHOT = '/tmp/pile-git-config'


def _env_list(name):
    return {k for k in os.environ.get(name, '').split(',') if k}


def scrub_env(env):
    # Agent-facing env under the lane's tiers. shell<enabled strips every
    # env-var secret except the agent CLI's own credential; push<enabled
    # strips anything that can push or mint a push token.
    env = dict(env)
    if PUSH_POLICY != 'enabled':
        for k in PUSH_SECRET_ENV:
            env.pop(k, None)
    if SHELL_POLICY != 'enabled':
        keep = _env_list('PILE_AGENT_CREDENTIAL_ENV')
        strip = RUNNER_SECRET_ENV | _env_list('PILE_EXTRA_ENV_KEYS')
        for k in list(env):
            if k in keep:
                continue
            if k in strip or SECRET_NAME.search(k):
                del env[k]
    return env


def harden_process():
    # With any tier below 'enabled', make the runner non-dumpable so a
    # same-uid agent process can't read the runner's secrets out of
    # /proc/<pid>/environ or /proc/<pid>/mem.
    if PUSH_POLICY == 'enabled' and SHELL_POLICY == 'enabled':
        return
    try:
        ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 4
    except Exception as e:
        print('prctl(PR_SET_DUMPABLE) unavailable:', e)


harden_process()


def _with_git_config(env, pairs):
    env = dict(env if env is not None else os.environ)
    start = int(env.get('GIT_CONFIG_COUNT', '0') or 0)
    for i, (k, v) in enumerate(pairs):
        env[f'GIT_CONFIG_KEY_{start + i}'] = k
        env[f'GIT_CONFIG_VALUE_{start + i}'] = v
    env['GIT_CONFIG_COUNT'] = str(start + len(pairs))
    return env


def git_env(env=None):
    # Env for runner git calls that never touch the network: the hardened
    # scrubbed env, plus hook/fsmonitor kills below shell=enabled (a hook
    # would run with the runner's credentials). The `env` arg is ignored —
    # agent-supplied env must not steer runner git.
    if SHELL_POLICY != 'enabled':
        return _with_git_config(_git_env(), NO_HOOKS_GIT_CONFIG)
    return _git_env()


def git_auth_env(env=None):
    # Env for runner git calls that authenticate. Hooks are always off — a
    # hook would inherit the credential. Below push=enabled the token rides
    # in a command-scope extraheader (never argv, never .git/config).
    base = _with_git_config(git_env(env), NO_HOOKS_GIT_CONFIG)
    if PUSH_POLICY == 'enabled':
        return base
    basic = base64.b64encode(f'x-access-token:{GITHUB_TOKEN}'.encode()).decode()
    return _with_git_config(base, [
        ('http.https://github.com/.extraheader', f'AUTHORIZATION: basic {basic}'),
    ])


def remote_url():
    # push=enabled keeps today's token-in-remote (the agent may use git
    # itself); below it the checkout's remote carries no credential — auth
    # rides a command-scope extraheader instead (see git_auth_env).
    if PUSH_POLICY == 'enabled':
        return f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git'
    return f'https://github.com/{REPO}.git'


def deny_in_cli_config(path, rules, base=None):
    # Merge `rules` into permissions.deny of an agent CLI's user-level JSON
    # config, then make the file read-only so file-edit tools can't lift it.
    config = dict(base or {})
    if os.path.exists(path):
        os.chmod(path, 0o600)
        try:
            with open(path) as f:
                config = json.load(f)
        except ValueError:
            pass
    perms = config.setdefault('permissions', {})
    perms.setdefault('allow', [])
    deny = perms.setdefault('deny', [])
    for rule in rules:
        if rule not in deny:
            deny.append(rule)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(config, f)
    os.chmod(path, 0o444)
    print(f'lane policy: denied {rules} via {path}')


def snapshot_git_config():
    if SHELL_POLICY != 'disabled':
        return
    shutil.copyfile(os.path.join(REPO_DIR, '.git', 'config'), GIT_CONFIG_SNAPSHOT)


def restore_git_config():
    # shell=disabled: the agent can still edit .git/config with file tools
    # (filter drivers, aliases, fsmonitor). Put the runner's copy back before
    # any runner git call that follows the agent.
    if SHELL_POLICY != 'disabled' or not os.path.exists(GIT_CONFIG_SNAPSHOT):
        return
    shutil.copyfile(GIT_CONFIG_SNAPSHOT, os.path.join(REPO_DIR, '.git', 'config'))


def run(cmd, cwd=None, env=None, check=False, **kwargs):
    print(_redact('+ ' + ' '.join(str(c) for c in cmd)))
    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)
    if check and result.returncode != 0:
        raise RuntimeError(f'Command failed: {_redact(str(cmd))} returned {result.returncode}; stdout={_redact(result.stdout or "")}; stderr={_redact(result.stderr or "")}')
    return result


# Env the agent subprocess may see. Everything else — the GitHub token, the
# lane token and its URLs, the agent credential blobs, the runner bundle —
# stays in the runner. Repo-allowlisted extra keys arrive via
# PILE_AGENT_ENV_KEYS; runner-only keys can never be re-admitted that way.
_AGENT_ENV_ALLOW = frozenset((
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ',
    'TMPDIR', 'HOSTNAME', 'PWD', 'CI', 'DEBIAN_FRONTEND',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NVM_DIR', 'NODE_OPTIONS', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'VIRTUAL_ENV',
    'npm_config_store_dir',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'REPO', 'BRANCH', 'ISSUE_TITLE', 'ISSUE_IDENTIFIER', 'AGENT_LABEL', 'MODEL',
    'PILE_API_URL', 'PILE_API_KEY',
))
_AGENT_ENV_ALLOW_PREFIXES = ('LC_', 'XDG_')
_RUNNER_ONLY_ENV = frozenset((
    'GITHUB_TOKEN', 'GITHUB_TOKEN_EXPIRES_AT', 'GH_TOKEN', 'LANE_TOKEN', 'PILE_TOKEN_URL',
    'PILE_LOG_TOKEN', 'PILE_LOG_URL', 'PILE_CACHE_URL', 'PILE_AGENT_ENV_KEYS',
    'RUNNER_PY_B64', 'PROMPT_B64', 'DEVIN_CREDENTIALS_B64', 'CODEX_AUTH_JSON_B64', 'FOLLOWUP',
))


def agent_env_base(extra=None):
    allowed = set(_AGENT_ENV_ALLOW)
    allowed.update(k.strip() for k in os.environ.get('PILE_AGENT_ENV_KEYS', '').split(',') if k.strip())
    env = {
        k: v for k, v in os.environ.items()
        if k not in _RUNNER_ONLY_ENV and (k in allowed or k.startswith(_AGENT_ENV_ALLOW_PREFIXES))
    }
    env['HOME'] = HOME
    env['PATH'] = INSTALL_DIR + ':' + os.environ.get('PATH', '')
    env.update(extra or {})
    return env


class TransportError(RuntimeError):
    # Substrate failure — git transport, codeload, token mint. The lane's own
    # work may be fine, so fail_result flags these infraFailure and the sweep
    # re-drives the session instead of reporting a task failure.
    pass


_TRANSPORT_NOTES = []


def run_transport(cmd, **kwargs):
    # run(check=True) for calls that reach the network under the lane. A
    # nonzero exit is retyped as TransportError so the failure classifies as
    # infra rather than a task outcome.
    try:
        return run(cmd, check=True, **kwargs)
    except TransportError:
        raise
    except Exception as e:
        detail = str(e)
        if _TRANSPORT_NOTES:
            detail += ' [' + '; '.join(_redact(n) for n in _TRANSPORT_NOTES) + ']'
        raise TransportError(detail) from e


def github_api(method, path, body=None):
    if not GITHUB_TOKEN:
        refresh_github_token()
    ensure_fresh_github_token()
    owner, name = REPO.split('/')
    url = f'https://api.github.com/repos/{owner}/{name}{path}'
    headers = {
        'Authorization': f'Bearer {GITHUB_TOKEN}',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp) if resp.status != 204 else None
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        print(f'GitHub API error {method} {path}: {e.code} {text}')
        raise


def default_branch():
    repo = github_api('GET', '')
    return repo.get('default_branch', 'main')


def create_branch():
    if PUSH_POLICY == 'disabled':
        print('push disabled by lane policy — not creating the remote branch')
        return
    base = default_branch()
    try:
        ref = github_api('GET', f'/git/ref/heads/{base}')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            ref = github_api('GET', '/git/ref/heads/master')
        else:
            raise
    sha = ref['object']['sha']
    try:
        github_api('POST', '/git/refs', {'ref': f'refs/heads/{BRANCH}', 'sha': sha})
        print(f'created branch {BRANCH} from {base}')
    except urllib.error.HTTPError as e:
        if e.code == 422:
            print(f'branch {BRANCH} already exists')
        else:
            raise


def clone_ref():
    # push=disabled never creates the lane branch, so clone it only when a
    # prior run left one; otherwise start from the default branch.
    if PUSH_POLICY != 'disabled':
        return BRANCH
    try:
        github_api('GET', f'/git/ref/heads/{BRANCH}')
        return BRANCH
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return default_branch()
        raise


def clone_repo():
    # Refresh before the first GitHub call — the dispatch-time token may
    # already be old if the lane queued, and this proves the lane-token
    # refresh path fires on every run, not just at push time.
    validate_branch()
    refresh_github_token()
    if os.path.exists(REPO_DIR):
        shutil.rmtree(REPO_DIR)
    os.makedirs(REPO_DIR, exist_ok=True)
    ref = clone_ref()
    t0 = time.time()
    # Header via a 0600 file, not argv — argv is world-readable in /proc.
    header_file = '/tmp/pile-auth-header'
    fd = os.open(header_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(f'Authorization: Bearer {GITHUB_TOKEN}\n')
    try:
        run_transport(['curl', '-fsSL', '--max-time', '120', '-H', f'@{header_file}', '-o', '/tmp/repo.tgz', f'https://codeload.github.com/{REPO}/tar.gz/{ref}'])
    finally:
        os.remove(header_file)
    run_transport(['tar', '-xzf', '/tmp/repo.tgz', '--strip-components=1', '-C', REPO_DIR])
    print(f'[timing] codeload tarball: {time.time() - t0:.0f}s')
    t1 = time.time()
    run(['git', '-C', REPO_DIR, 'init', '-b', BRANCH], check=True)
    run([GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['remote', 'add', 'origin', remote_url()], env=git_env(), check=True)
    run_transport([GIT, '-C', REPO_DIR, '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--depth', '1', 'origin', ref], env=git_auth_env())
    run(['git', '-C', REPO_DIR, 'update-ref', f'refs/heads/{BRANCH}', 'FETCH_HEAD'], check=True)
    base = run(['git', '-C', REPO_DIR, 'rev-parse', 'FETCH_HEAD'], capture_output=True, text=True, check=False)
    if base.returncode == 0:
        with open('/tmp/base_sha', 'w') as f:
            f.write(base.stdout.strip())
    run(['git', '-C', REPO_DIR, 'symbolic-ref', 'HEAD', f'refs/heads/{BRANCH}'], check=True)
    run(['git', '-C', REPO_DIR, 'reset'], check=True)
    print(f'[timing] git fetch: {time.time() - t1:.0f}s')
    run(['git', '-C', REPO_DIR, 'config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', AGENT_LABEL)], check=True)
    run(['git', '-C', REPO_DIR, 'config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'agent@pile.nyc')], check=True)
    if SHELL_POLICY == 'disabled':
        for k, v in NO_HOOKS_GIT_CONFIG:
            run(['git', '-C', REPO_DIR, 'config', k, v], check=True)
    snapshot_git_config()


def resume_repo():
    # Follow-up prompt on a kept sandbox: the checkout and branch survive
    # from the prior run — fetch and fast-forward so the agent resumes on
    # current remote state (its earlier push included).
    validate_branch()
    if PUSH_POLICY == 'disabled':
        return
    refresh_github_token()
    # The kept checkout's .git/config is agent-writable — rebuild it before
    # any runner git call so a tampered config can't redirect or hook us.
    _reset_git_config()
    run(['timeout', '120', GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['fetch', '--depth', '50', 'origin', BRANCH], env=git_auth_env(), check=False)
    run([GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['merge', '--ff-only', f'origin/{BRANCH}'], env=git_env(), check=False)


def run_setup_hook(agent_env):
    # Repo-declared environment hook (.pile/setup.sh) — each repo wires its
    # own toolchain instead of the image hardcoding per-repo steps. A
    # hooks.setup command in .pile/config.json runs right after it.
    hook = os.path.join(REPO_DIR, '.pile', 'setup.sh')
    if SHELL_POLICY == 'disabled':
        print('shell disabled by lane policy — skipping .pile/setup.sh')
        return
    if os.path.exists(hook):
        t0 = time.time()
        print('running .pile/setup.sh')
        result = run(['bash', hook], cwd=REPO_DIR, env=agent_env(), check=False)
        print(f'[timing] setup.sh: {time.time() - t0:.0f}s exit={result.returncode}')
    run_hook('setup', agent_env())


# Lane lifecycle hooks — the `hooks` block of the checkout's .pile/config.json:
#   setup         after clone, before the agent (non-fatal)
#   postCheckout  after every checkout: fresh clone and kept-sandbox resume
#   prePush       before every push; nonzero blocks the push and fails the lane
#   stop          after each agent turn; nonzero resumes the agent with the
#                 failure output (up to stopMaxAttempts), so the lane fixes its
#                 own broken work instead of opening a red PR
# Each is a bash command run from the repo root with PILE_HOOK, PILE_BRANCH,
# PILE_BASE_SHA and PILE_CHANGED_FILES (path to a newline list of files
# changed vs the lane's base) in its env.
HOOK_NAMES = ('setup', 'postCheckout', 'prePush', 'stop')
HOOK_TIMEOUT_SEC = 1800
HOOK_OUTPUT_TAIL = 8000
STOP_MAX_ATTEMPTS_DEFAULT = 2
STOP_MAX_ATTEMPTS_CAP = 5
CHANGED_FILES_PATH = '/tmp/pile-changed-files'
HOOK_RUNS = []
STOP_HOOK = {}
_LANE_HOOKS = []


class HookFailure(RuntimeError):
    pass


def lane_hooks():
    # Read once per process, after checkout — hooks come from the branch the
    # lane is working on, not the default branch.
    if _LANE_HOOKS:
        return _LANE_HOOKS[0]
    hooks = {}
    # shell=disabled: repo-declared commands are a shell escape like git
    # hooks — and the lane can edit them in its own checkout.
    if SHELL_POLICY == 'disabled':
        return hooks
    try:
        with open(os.path.join(REPO_DIR, '.pile', 'config.json')) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = None
    block = raw.get('hooks') if isinstance(raw, dict) else None
    if isinstance(block, dict):
        for name in HOOK_NAMES:
            cmd = block.get(name)
            if isinstance(cmd, str) and cmd.strip():
                hooks[name] = cmd
        attempts = block.get('stopMaxAttempts')
        if isinstance(attempts, int) and not isinstance(attempts, bool) and 0 <= attempts <= STOP_MAX_ATTEMPTS_CAP:
            hooks['stopMaxAttempts'] = attempts
    if os.path.isdir(REPO_DIR):
        _LANE_HOOKS.append(hooks)
    return hooks


def _base_sha():
    try:
        with open('/tmp/base_sha') as f:
            return f.read().strip()
    except OSError:
        return ''


def _write_changed_files(base):
    files = set()
    if base:
        diff = run(['git', '-C', REPO_DIR, 'diff', '--name-only', base], capture_output=True, text=True, check=False)
        files.update(l for l in (diff.stdout or '').splitlines() if l)
    untracked = run(['git', '-C', REPO_DIR, 'ls-files', '--others', '--exclude-standard'], capture_output=True, text=True, check=False)
    files.update(l for l in (untracked.stdout or '').splitlines() if l)
    with open(CHANGED_FILES_PATH, 'w') as f:
        f.write(''.join(l + '\n' for l in sorted(files)))


def run_hook(name, env):
    # Returns (exit_code, redacted output tail), or None when the repo
    # doesn't declare this hook. Output streams into the lane transcript.
    cmd = lane_hooks().get(name)
    if not cmd:
        return None
    base = _base_sha()
    _write_changed_files(base)
    hook_env = dict(env)
    hook_env.update({'PILE_HOOK': name, 'PILE_BRANCH': BRANCH, 'PILE_BASE_SHA': base, 'PILE_CHANGED_FILES': CHANGED_FILES_PATH})
    print(_redact(f'[hook] {name}: {cmd}'))
    t0 = time.time()
    proc = subprocess.Popen(['bash', '-c', cmd], cwd=REPO_DIR, env=hook_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    timer = threading.Timer(HOOK_TIMEOUT_SEC, proc.kill)
    timer.start()
    tail = []
    size = 0
    try:
        for line in proc.stdout:
            print(_redact(line), end='')
            tail.append(line)
            size += len(line)
            while size > HOOK_OUTPUT_TAIL and len(tail) > 1:
                size -= len(tail.pop(0))
        rc = proc.wait()
    finally:
        timer.cancel()
    timed_out = time.time() - t0 >= HOOK_TIMEOUT_SEC
    if timed_out:
        tail.append(f'\n[hook] {name} killed after {HOOK_TIMEOUT_SEC}s\n')
    duration = round(time.time() - t0)
    print(f'[hook] {name}: exit={rc} {duration}s')
    HOOK_RUNS.append({'hook': name, 'exit': rc, 'durationSec': duration})
    return rc, _redact(''.join(tail))[-HOOK_OUTPUT_TAIL:]


def stop_hook_prompt(task, cmd, rc, output, attempt, max_attempts):
    return (
        'The repository\'s stop hook (`hooks.stop` in .pile/config.json) failed after your last turn, '
        'so this work is not done yet. Fix the failures below in this checkout — do not weaken or skip the check — '
        f'then finish. Self-heal attempt {attempt}/{max_attempts}; nothing has been pushed yet.\n\n'
        f'Command: {cmd}\nExit code: {rc}\n\nOutput (tail):\n```\n{output}\n```\n\n'
        f'Original task:\n{task[:4000]}'
    )


def self_heal(env, resume, task=''):
    # Runs hooks.stop; while it exits nonzero, resume(prompt) hands the
    # failure back to the agent and the hook re-runs. Returns the last
    # resume() result, or None when the agent was never resumed. A hook that
    # still fails after stopMaxAttempts lets the lane push anyway — the
    # digest and PR body flag it so a human sees the red check up front.
    hooks = lane_hooks()
    cmd = hooks.get('stop')
    if not cmd:
        return None
    max_attempts = hooks.get('stopMaxAttempts', STOP_MAX_ATTEMPTS_DEFAULT)
    resumed = None
    attempt = 0
    while True:
        rc, output = run_hook('stop', env)
        if rc == 0:
            STOP_HOOK.update({'status': 'passed', 'attempts': attempt})
            return resumed
        if attempt >= max_attempts:
            STOP_HOOK.update({'status': 'failed', 'attempts': attempt, 'exit': rc})
            print(f'[hook] stop still failing after {attempt} self-heal attempts — pushing with failure flagged')
            return resumed
        attempt += 1
        print(f'[hook] stop failed (exit {rc}) — resuming agent with the failure ({attempt}/{max_attempts})')
        resumed = resume(stop_hook_prompt(task, cmd, rc, output, attempt, max_attempts))


def find_pr():
    owner, name = REPO.split('/')
    try:
        # state=open only: a merged/closed PR on this branch is history, not
        # coverage — a later push on the same lane branch must open a fresh
        # PR (PILE-257).
        pulls = github_api('GET', f'/pulls?state=open&head={owner}:{BRANCH}')
        if pulls:
            return pulls[0]['html_url']
    except Exception as e:
        print('find_pr error:', e)
    return ''


def collect_digest():
    # Run-summary ground truth — Pile merges this into the session.summary
    # event so a human can review 'what did this lane do' at a glance.
    digest = {'durationSec': round(time.time() - RUN_STARTED)}
    if HOOK_RUNS:
        digest['hooks'] = list(HOOK_RUNS)
    if STOP_HOOK:
        digest['stopHook'] = dict(STOP_HOOK)
    base = _base_sha()
    if REPO and base:
        files = run(['git', '-C', REPO_DIR, 'diff', '--name-only', f'{base}...HEAD'], env=git_env(), capture_output=True, text=True, check=False)
        digest['filesChanged'] = [f for f in (files.stdout or '').splitlines() if f]
        commits = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'{base}..HEAD'], env=git_env(), capture_output=True, text=True, check=False)
        digest['commits'] = int((commits.stdout or '0').strip() or 0)
    return digest


def create_pr(digest=None):
    try:
        summary = ''
        if digest and digest.get('filesChanged') is not None:
            summary = f"\n\n---\nLane digest: {len(digest['filesChanged'])} files changed, {digest.get('commits', 0)} commits, ~{digest['durationSec']}s."
        stop = (digest or {}).get('stopHook') or {}
        if stop.get('status') == 'failed':
            summary += f"\n\n**Stop hook still failing** (exit {stop.get('exit')}) after {stop.get('attempts', 0)} self-heal attempts — see the lane transcript."
        body = {
            'title': os.environ['ISSUE_TITLE'],
            'head': BRANCH,
            'base': default_branch(),
            'body': f'Closes {os.environ["ISSUE_IDENTIFIER"]}\n\nGenerated with {AGENT_LABEL}' + summary,
        }
        pr = github_api('POST', '/pulls', body)
        return pr['html_url']
    except Exception as e:
        print('create_pr error:', e)
        PR_ERRORS.append(f'create_pr: {e}')
    return ''


def refresh_github_token():
    # The installation token baked at dispatch expires ~1h in — long lanes
    # re-mint through Pile (per-session lane token auth) right before push.
    url = os.environ.get('PILE_TOKEN_URL')
    token = os.environ.get('LANE_TOKEN')
    if not (url and token):
        return
    try:
        # urllib's default UA gets 403'd by Cloudflare bot rules before
        # the request reaches the worker — identify as the lane runner.
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'User-Agent': 'pile-agent-runner/1.0'}, method='POST')
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
        add_mask(data['token'])
        globals()['GITHUB_TOKEN'] = data['token']
        globals()['GITHUB_TOKEN_EXPIRES_AT'] = _parse_expiry(data.get('expiresAt'))
        _TRANSPORT_NOTES.clear()
        print('github token refreshed')
    except Exception as e:
        # Not fatal on its own — the dispatch-time token may still be valid —
        # but if a later transport call dies, the note rides along so the
        # retried lane's failure shows the mint failure as the cause.
        _TRANSPORT_NOTES.append(f'github token refresh failed: {e}')
        print('github token refresh failed:', e)


def commit_local(agent_env):
    _reset_git_config()
    git = [GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS
    env = git_env()
    status = run(git + ['status', '--porcelain'], env=env, capture_output=True, text=True, check=True)
    if not status.stdout.strip():
        return False
    run(git + ['add', '-A'], env=env, check=True)
    run(git + ['commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=env, check=True)
    return True


def assert_push_target():
    # push=restricted: the lane's feature branch only — never the default
    # branch, a tag, HEAD, or a ref-qualified/deleting refspec.
    if PUSH_POLICY != 'restricted':
        return
    base = default_branch()
    if (not BRANCH or BRANCH == base or BRANCH == 'HEAD'
            or BRANCH.startswith(('refs/', '-', ':', '+'))
            or ':' in BRANCH or BRANCH.endswith('.lock')):
        raise RuntimeError(f'push restricted by lane policy: refusing to push {BRANCH!r} (default branch {base!r})')


def push_command():
    if PUSH_POLICY == 'enabled':
        return [GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['push', 'origin', f'refs/heads/{BRANCH}:refs/heads/{BRANCH}']
    # Explicit URL + fully qualified refspec: no remote config (mirror,
    # push refspecs, rewritten URL) and no followed tags can widen it.
    return [GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['push', '--no-follow-tags',
            f'https://github.com/{REPO}.git', f'HEAD:refs/heads/{BRANCH}']


def ensure_fresh_github_token():
    # refreshGitToken hook: re-mint ahead of expiry instead of letting a
    # long-running lane's GitHub calls start failing mid-run.
    expires_at = globals()['GITHUB_TOKEN_EXPIRES_AT']
    if expires_at and expires_at - time.time() < TOKEN_REFRESH_MARGIN_SEC:
        refresh_github_token()


def revoke_github_token():
    # Run end: kill the installation token now rather than leaving it live
    # for the rest of its ~1h TTL in a sandbox that may be kept for
    # follow-ups. Pile's sweep revokes server-side too; this is the fast path.
    token = globals()['GITHUB_TOKEN']
    if not token:
        return
    globals()['GITHUB_TOKEN'] = ''
    if REPO and os.path.isdir(os.path.join(REPO_DIR, '.git')):
        run(['git', '-C', REPO_DIR, 'remote', 'set-url', 'origin', f'https://github.com/{REPO}.git'], check=False)
    try:
        req = urllib.request.Request(
            'https://api.github.com/installation/token', method='DELETE',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pile-agent-runner/1.0'})
        urllib.request.urlopen(req, timeout=15)
        print('github token revoked')
    except Exception as e:
        print('github token revoke failed:', e)


# The agent had the checkout, $HOME and its PATH to itself, so .git/config,
# .git/hooks, ~/.gitconfig and ~/.local/bin are all hostile by the time the
# runner pushes. The runner's own git calls use a pinned binary, a rebuilt
# repo config, no global/system config and no hooks, and push one explicit
# refspec — the token never reaches agent-planted code and no config can
# redirect the push to another ref or remote.
_GIT_SAFE_FLAGS = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
]
_GIT_ENV_KEEP = ('GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL')


def _git_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') or k in _GIT_ENV_KEEP}
    for key in ('SSH_ASKPASS', 'SSH_AUTH_SOCK', 'LD_PRELOAD', 'LD_LIBRARY_PATH'):
        env.pop(key, None)
    env['PATH'] = ':'.join(p for p in env.get('PATH', os.defpath).split(':') if p and p != INSTALL_DIR)
    env['GIT_CONFIG_GLOBAL'] = '/dev/null'
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    env['GIT_TERMINAL_PROMPT'] = '0'
    return env


def _reset_git_config():
    git_dir = os.path.join(REPO_DIR, '.git')
    if os.path.islink(git_dir) or not os.path.isdir(git_dir):
        raise RuntimeError('refusing to push: .git is not a plain directory')
    config_path = os.path.join(git_dir, 'config')
    for stale in (config_path, os.path.join(git_dir, 'config.worktree')):
        if os.path.lexists(stale):
            os.unlink(stale)
    name = os.environ.get('GIT_AUTHOR_NAME', AGENT_LABEL)
    email = os.environ.get('GIT_AUTHOR_EMAIL', 'agent@pile.nyc')
    with open(config_path, 'w') as f:
        f.write(
            '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n'
            f'[remote "origin"]\n\turl = {remote_url()}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
            f'[user]\n\tname = {name}\n\temail = {email}\n'
        )


def _refuse_default_branch():
    try:
        base = default_branch()
    except Exception as e:
        raise TransportError(f'default branch lookup failed: {e}') from e
    if BRANCH == base:
        raise RuntimeError(f'refusing to push lane branch {BRANCH!r}: it is the default branch')


def commit_and_push(agent_env):
    validate_branch()
    if PUSH_POLICY == 'disabled':
        committed = commit_local(agent_env)
        print('push disabled by lane policy — leaving changes unpushed' if committed else 'no changes to commit')
        return False
    refresh_github_token()
    assert_push_target()
    _refuse_default_branch()
    # Rebuilt with the just-refreshed token (not the dispatch-time one,
    # possibly >1h stale) as what push authenticates with — and so a lane
    # can't have smuggled a credential or hook into .git/config.
    _reset_git_config()
    git = [GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS
    env = git_auth_env()
    committed = commit_local(agent_env)
    ahead = run(git + ['rev-list', '--count', f'refs/remotes/origin/{BRANCH}..HEAD'], env=env, capture_output=True, text=True, check=True)
    if not committed and ahead.stdout.strip() == '0':
        print('no changes to commit')
        return False
    gate = run_hook('prePush', agent_env)
    if gate and gate[0] != 0:
        raise HookFailure(f'prePush hook failed (exit {gate[0]}); push blocked:\n{gate[1][-2000:]}')
    # The prePush hook is repo code and may have re-rigged .git/config.
    _reset_git_config()
    run_transport(push_command(), env=git_auth_env())
    return True


def local_patch():
    # push=disabled deliverable: the lane's commits as a patch in the result.
    try:
        with open('/tmp/base_sha') as f:
            base = f.read().strip()
    except OSError:
        return ''
    diff = run(['git', '-C', REPO_DIR, 'diff', '--no-ext-diff', '--no-textconv', f'{base}..HEAD'], env=git_env(), capture_output=True, text=True, check=False)
    return (diff.stdout or '')[:200000]


def ensure_postgres():
    # Images with a baked Postgres get a running cluster + the vortex_dev
    # test database. Best-effort: images without it skip silently and suites
    # that need PG fail with their own error.
    if not shutil.which('pg_ctlcluster'):
        return
    t0 = time.time()
    # Reused containers keep a stale postmaster.pid pointing at a shared-
    # memory segment that no longer exists — pg_ctlcluster then refuses to
    # start. Clearing the pidfile makes start idempotent.
    pidfile = '/var/lib/postgresql/16/main/postmaster.pid'
    if os.path.exists(pidfile):
        os.remove(pidfile)
    # Debian's default dynamic_shared_memory_type=posix needs a working
    # /dev/shm, which CF containers don't give us — postmaster dies with
    # 'could not open shared memory segment'. mmap needs no shm at all.
    conf = '/etc/postgresql/16/main/postgresql.conf'
    if os.path.exists(conf):
        with open(conf, 'a') as f:
            f.write('\ndynamic_shared_memory_type=mmap\n')
    start = run(['pg_ctlcluster', '16', 'main', 'start'], check=False, capture_output=True, text=True)
    if start.returncode != 0 and 'already running' not in (start.stderr or ''):
        print('pg_ctlcluster start failed:', (start.stdout or '') + (start.stderr or ''))
    ready = run(['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-t', '30'], check=False, capture_output=True, text=True)
    if ready.returncode != 0:
        print('WARNING: postgres not accepting connections:', (ready.stdout or '') + (ready.stderr or ''))
    run(['su', 'postgres', '-c', "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""], check=False)
    run(['su', 'postgres', '-c', 'createdb vortex_dev'], check=False)
    print(f'[timing] postgres up: {time.time() - t0:.0f}s')


# Push appended transcript lines back to Pile so they land in the session
# event log and stream out over SSE — no polling of this sandbox's fs.
PILE_LOG_URL = os.environ.get('PILE_LOG_URL')
PILE_LOG_TOKEN = os.environ.get('PILE_LOG_TOKEN')
_ship_stop = threading.Event()
_ship_pos = 0


def _ship_logs():
    global _ship_pos
    if not (PILE_LOG_URL and PILE_LOG_TOKEN):
        return
    try:
        with open('/tmp/agent.log') as f:
            f.seek(_ship_pos)
            data = f.read()
            _ship_pos = f.tell()
        lines = [l for l in data.splitlines() if l.strip()]
        if not lines:
            return
        req = urllib.request.Request(
            PILE_LOG_URL,
            data=json.dumps({'lines': lines[-100:]}).encode(),
            headers={'Authorization': 'Bearer ' + PILE_LOG_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'pile-runner/1.0'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as _e:
        print('[log-ship] post failed: %r' % (_e,))


def _ship_loop():
    while not _ship_stop.is_set():
        _ship_logs()
        _ship_stop.wait(1)


if PILE_LOG_URL and PILE_LOG_TOKEN:
    threading.Thread(target=_ship_loop, daemon=True).start()


def stop_log_ship():
    _ship_stop.set()
    _ship_logs()


# pnpm store cache: the runner downloads a tarball of the pnpm store keyed
# by the repo's lockfile hash before the agent starts, and uploads it back
# after — turns cold monorepo installs into a single R2 fetch.
PILE_CACHE_URL = os.environ.get('PILE_CACHE_URL')
STORE_DIR = os.environ.get('npm_config_store_dir')


def _cache_request(method, url, data=None):
    req = urllib.request.Request(url, data=data, method=method,
        headers={'Authorization': 'Bearer ' + (PILE_LOG_TOKEN or ''), 'User-Agent': 'pile-runner/1.0'})
    return urllib.request.urlopen(req, timeout=900)


def _lockfile_hash():
    p = os.path.join(REPO_DIR, 'pnpm-lock.yaml')
    if not os.path.exists(p):
        return None
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def warm_pnpm_store():
    if not (PILE_CACHE_URL and PILE_LOG_TOKEN and STORE_DIR):
        return
    h = _lockfile_hash()
    if not h:
        return
    try:
        resp = _cache_request('GET', f'{PILE_CACHE_URL}/{h}')
        os.makedirs(STORE_DIR, exist_ok=True)
        subprocess.run(['tar', '-xzf', '-', '-C', STORE_DIR], input=resp.read(), check=True)
        print(f'[cache] pnpm store warm hit {h[:12]}')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f'[cache] pnpm store miss {h[:12]} — cold install')
        else:
            print(f'[cache] warm fetch failed: {e}')
    except Exception as e:
        print(f'[cache] warm fetch failed: {e}')


def save_pnpm_store():
    if not (PILE_CACHE_URL and PILE_LOG_TOKEN and STORE_DIR):
        return
    h = _lockfile_hash()
    if not h or not os.path.isdir(STORE_DIR):
        return
    try:
        subprocess.run(['tar', '-czf', '/tmp/pnpm-store.tar.gz', '-C', STORE_DIR, '.'], check=True)
        size = os.path.getsize('/tmp/pnpm-store.tar.gz')
        chunk = 64 * 1024 * 1024
        if size <= chunk:
            with open('/tmp/pnpm-store.tar.gz', 'rb') as f:
                _cache_request('PUT', f'{PILE_CACHE_URL}/{h}', f.read())
        else:
            # Worker request bodies cap below the tarball size — upload in
            # 64MB parts then commit a manifest listing the part count.
            parts = (size + chunk - 1) // chunk
            with open('/tmp/pnpm-store.tar.gz', 'rb') as f:
                for i in range(parts):
                    data = f.read(chunk)
                    _cache_request('PUT', f'{PILE_CACHE_URL}/{h}/parts/{i}', data)
            _cache_request('PUT', f'{PILE_CACHE_URL}/{h}/manifest',
                json.dumps({'parts': parts}).encode())
        print(f'[cache] pnpm store saved {h[:12]} ({size // 1024 // 1024}MB)')
    except Exception as e:
        print(f'[cache] store save failed: {e}')


def read_transcript(fallback=''):
    try:
        with open('/tmp/agent.log') as f:
            return f.read()[-65536:]
    except OSError:
        return fallback


def write_result(status, pr_url='', result='', report=None, infra=False):
    payload = {'status': status, 'prUrl': pr_url, 'branch': BRANCH, 'result': _redact(result)}
    if report:
        payload['report'] = _redact(report)
    if infra:
        payload['infraFailure'] = True
    with open(RESULT_FILE, 'w') as f:
        json.dump(payload, f)


def finalize(output, pushed, report=None):
    # Terminal bookkeeping shared by every driver: digest → PR → result file.
    digest = collect_digest()
    digest['permissions'] = {'push': PUSH_POLICY, 'shell': SHELL_POLICY}
    pr_url = ''
    if pushed:
        pr_url = find_pr() or create_pr(digest)
    payload = {'output_tail': output, 'transcript': read_transcript(output), 'pr_errors': PR_ERRORS, 'digest': digest}
    if PUSH_POLICY == 'disabled' and REPO:
        payload['patch'] = local_patch()
    result_text = json.dumps(payload)
    write_result('completed', pr_url, result_text, report=report)
    return 0


def fail_result(error):
    write_result('failed', '', str(error), infra=isinstance(error, TransportError))
