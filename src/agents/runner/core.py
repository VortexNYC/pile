# Pile agent runner — shared core.
#
# This file is concatenated with a per-agent driver (cursor.py, devin.py,
# codex.py) and shipped to the sandbox as RUNNER_PY_B64. Everything an agent
# lane needs that is NOT agent-specific lives here: transcript tee, redact,
# agent env allowlist, GitHub token refresh/revoke,
# repo ops, GitHub API, PR creation, lane digest, GitHub token refresh, log
# shipping, pnpm-store cache, postgres warmup, .pile/setup.sh, lane lifecycle
# hooks, lane isolation (scrubbed agent env + restricted-mode command shims),
# optional headless browser. Drivers only define: ensure(), agent_env(), the
# run mechanism, and main().
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
import urllib.parse
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
# 'plan' lanes (PILE-283) read the repo and report a plan — never push.
LANE_MODE = os.environ.get('PILE_LANE_MODE', '')
PR_ERRORS = []
SECONDARY_PRS = []
# Live secondary-repo tokens by repo, so run end can revoke them too.
SECONDARY_TOKENS = {}
RUN_STARTED = time.time()


def _start_health_server():
    """Binds :8787 so provision detection can waitForPort instead of
    scraping the 'runner started' event — the lane only reads as live once
    the runner process is actually accepting connections."""
    try:
        import http.server
        import socketserver

        class _H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'ok')
            def log_message(self, *a):
                pass

        srv = socketserver.TCPServer(('127.0.0.1', 8787), _H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    except OSError:
        pass


_start_health_server()
LANE_RESTRICTED = os.environ.get('PILE_LANE_RESTRICTED') == '1'
SHIM_DIR = '/tmp/pile-shims'
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
    # hook would inherit the credential — and the token rides a command-scope
    # extraheader so .git/config and argv never hold it (restricted lanes
    # keep the remote tokenless even at push=enabled).
    base = _with_git_config(git_env(env), NO_HOOKS_GIT_CONFIG)
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
    'PILE_LOG_TOKEN', 'PILE_LOG_URL', 'PILE_CACHE_URL', 'PILE_AGENT_ENV_KEYS', 'SECONDARY_REPOS_JSON',
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


# --- Lane isolation -------------------------------------------------------
# The runner holds provider tokens (GitHub, lane/log auth, CLI credentials);
# the agent and repo hooks it spawns must not. Agent subprocesses get
# scrubbed_env() (the agent_env_base() allowlist), never os.environ. Restricted lanes additionally run behind
# PATH shims that refuse credential/remote git ops and off-allowlist network
# tools, and keep the GitHub token out of .git/config while the agent runs.

_DEFAULT_NET_ALLOWLIST = (
    'github.com', 'api.github.com', 'codeload.github.com',
    'raw.githubusercontent.com', 'objects.githubusercontent.com',
    'registry.npmjs.org', 'registry.yarnpkg.com',
    'pypi.org', 'files.pythonhosted.org',
    'localhost', '127.0.0.1',
)
_SHIMMED_COMMANDS = (
    'git', 'curl', 'wget', 'gh', 'ssh', 'scp', 'sftp', 'rsync',
    'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp',
)

# Shim policy — written verbatim into SHIM_DIR and exec'd here so the runner
# and the shims share one definition.
SHIM_POLICY_SRC = r"""
import os
import re
import sys
from urllib.parse import urlsplit

DENY_ALWAYS = {'gh', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'}
GIT_DENY = {'push', 'send-pack', 'http-push', 'send-email', 'imap-send', 'credential',
            'credential-store', 'credential-cache', 'daemon'}
GIT_REMOTE_DENY = {'add', 'set-url', 'rename', 'remove', 'rm'}
GIT_SENSITIVE_KEY = re.compile(r'^(credential|url\.|remote\.|http\.|alias\.|include\.|includeif\.|core\.sshcommand|core\.askpass)', re.I)
GIT_VALUE_OPTS = {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'}
GIT_CONFIG_READ = {'--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', 'get', 'list'}
NET_DENY_FLAGS = {
    'curl': {'-K', '--config', '-x', '--proxy', '--preproxy', '--connect-to', '--resolve', '--unix-socket', '--abstract-unix-socket'},
    'wget': {'-i', '--input-file', '-e', '--execute', '--config', '-B', '--base'},
}
NET_VALUE_SHORT = {'curl': set('oHdXuAeFTwmbcrKxEDCyYzQtUP'), 'wget': set('OoPUeiaTtwQlARDIXB')}
NET_VALUE_LONG = {
    'curl': {'--output', '--header', '--data', '--data-binary', '--data-raw', '--data-urlencode', '--json',
             '--request', '--user', '--user-agent', '--referer', '--form', '--upload-file', '--write-out',
             '--max-time', '--cookie', '--cookie-jar', '--range', '--cert', '--key', '--cacert', '--retry',
             '--connect-timeout', '--output-dir', '--dump-header', '--trace', '--trace-ascii', '--limit-rate'},
    'wget': {'--output-document', '--output-file', '--directory-prefix', '--user-agent', '--header',
             '--user', '--password', '--tries', '--timeout', '--post-data', '--post-file', '--referer',
             '--load-cookies', '--save-cookies', '--append-output'},
}
URL_SCHEME = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*://')


def _git_key_sensitive(spec):
    return bool(GIT_SENSITIVE_KEY.match(spec.split('=', 1)[0].strip()))


def git_denial(args, env):
    for k, v in env.items():
        if k == 'GIT_CONFIG_PARAMETERS' and any(_git_key_sensitive(t) for t in re.findall(r"'([^']*)'", v)):
            return 'GIT_CONFIG_PARAMETERS sets credential/remote config'
        if k.startswith('GIT_CONFIG_KEY_') and _git_key_sensitive(v):
            return k + ' sets credential/remote config'
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('-c', '--config-env') and i + 1 < len(args):
            if _git_key_sensitive(args[i + 1]):
                return 'git ' + a + ' ' + args[i + 1].split('=', 1)[0] + ' is not allowed'
            i += 2
            continue
        if a.startswith('--config-env=') and _git_key_sensitive(a.split('=', 1)[1]):
            return 'git --config-env on credential/remote config is not allowed'
        if a in GIT_VALUE_OPTS:
            i += 2
            continue
        if a.startswith('-'):
            i += 1
            continue
        break
    if i >= len(args):
        return None
    sub, rest = args[i], args[i + 1:]
    if sub in GIT_DENY:
        return 'git ' + sub + ' is handled by the runner'
    if sub == 'remote':
        verbs = [r for r in rest if not r.startswith('-')]
        if verbs and verbs[0] in GIT_REMOTE_DENY:
            return 'git remote ' + verbs[0] + ' is not allowed'
    if sub == 'config' and not any(r in GIT_CONFIG_READ for r in rest):
        for r in rest:
            if not r.startswith('-') and _git_key_sensitive(r):
                return 'git config ' + r.split('=', 1)[0] + ' is not allowed'
    return None


def _host_allowed(host, allowed):
    host = (host or '').lower().rstrip('.')
    return any(host == h or host.endswith('.' + h) for h in allowed)


def net_targets(tool, args):
    short, long_ = NET_VALUE_SHORT[tool], NET_VALUE_LONG[tool]
    targets = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--url' and i + 1 < len(args):
            targets.append(args[i + 1])
            i += 2
            continue
        if a.startswith('--url='):
            targets.append(a.split('=', 1)[1])
        elif a.startswith('--'):
            if a in long_:
                i += 1
        elif a.startswith('-') and len(a) > 1:
            for j, ch in enumerate(a[1:]):
                if ch in short:
                    if j == len(a) - 2:
                        i += 1
                    break
        else:
            targets.append(a)
        i += 1
    return targets


def net_denial(tool, args, allowed):
    for a in args:
        if a.split('=', 1)[0] in NET_DENY_FLAGS[tool]:
            return tool + ' ' + a.split('=', 1)[0] + ' is not allowed'
    for t in net_targets(tool, args):
        url = t if URL_SCHEME.match(t) else 'http://' + t
        try:
            parts = urlsplit(url)
            host = parts.hostname
        except ValueError:
            return 'unparseable URL ' + t
        if parts.scheme not in ('http', 'https'):
            return 'scheme ' + parts.scheme + ' is not allowed'
        if not _host_allowed(host, allowed):
            return 'host ' + str(host) + ' is not on the lane allowlist'
    return None


def denial(name, args, env, allowed):
    if name in DENY_ALWAYS:
        return name + ' is disabled in restricted lanes'
    if name == 'git':
        return git_denial(args, env)
    if name in NET_DENY_FLAGS:
        return net_denial(name, args, allowed)
    return None


def _real_binary(name, shim_dir):
    for d in os.environ.get('PATH', '').split(os.pathsep):
        if not d or os.path.abspath(d) == shim_dir:
            continue
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def shim_main(allowed):
    name = os.path.basename(sys.argv[0])
    reason = denial(name, sys.argv[1:], os.environ, allowed)
    if reason:
        sys.stderr.write('pile restricted lane: ' + name + ' blocked: ' + reason + '\n')
        sys.exit(126)
    real = _real_binary(name, os.path.dirname(os.path.abspath(sys.argv[0])))
    if not real:
        sys.stderr.write(name + ': command not found\n')
        sys.exit(127)
    os.execv(real, [real] + sys.argv[1:])
"""

_shim_policy = {}
exec(SHIM_POLICY_SRC, _shim_policy)


def net_allowlist():
    hosts = list(_DEFAULT_NET_ALLOWLIST)
    api = os.environ.get('PILE_API_URL')
    if api:
        try:
            host = urllib.parse.urlsplit(api).hostname
        except ValueError:
            host = None
        if host:
            hosts.append(host)
    hosts += [h.strip().lower() for h in os.environ.get('PILE_NET_ALLOWLIST', '').split(',') if h.strip()]
    return sorted(set(hosts))


def restricted_denial(argv):
    # Why a restricted-lane shim would refuse argv, or None when allowed.
    name = os.path.basename(argv[0])
    return _shim_policy['denial'](name, list(argv[1:]), os.environ, set(net_allowlist()))


def install_shims():
    # Allowlist is baked at install time from the runner's env — the agent
    # can't widen it by exporting PILE_NET_ALLOWLIST itself.
    os.makedirs(SHIM_DIR, exist_ok=True)
    src = os.path.join(SHIM_DIR, '_pile_shim.py')
    with open(src, 'w') as f:
        f.write('#!/usr/bin/env python3\n' + SHIM_POLICY_SRC)
        f.write('\nif __name__ == "__main__":\n    shim_main(' + repr(set(net_allowlist())) + ')\n')
    os.chmod(src, 0o755)
    for name in _SHIMMED_COMMANDS:
        link = os.path.join(SHIM_DIR, name)
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(src, link)


def runner_env():
    # Full env for the runner's own git/transport calls — never the agent's.
    env = os.environ.copy()
    env['HOME'] = HOME
    env['PATH'] = INSTALL_DIR + ':' + env.get('PATH', '')
    return env


def scrubbed_env(extra=None, shims=True):
    # Agent-facing env: the allowlist base passed through the lane-tier
    # scrubber, plus PATH shims in restricted lanes (shims=False skips them
    # for CLI installers).
    env = scrub_env(agent_env_base(extra))
    if shims and LANE_RESTRICTED:
        install_shims()
        env['PATH'] = SHIM_DIR + ':' + env['PATH']
    return env


def tokenless_remote_url():
    return f'https://github.com/{REPO}.git'


def set_remote(with_token):
    url = remote_url() if with_token else tokenless_remote_url()
    run([GIT, '-C', REPO_DIR, 'remote', 'set-url', 'origin', url], env=runner_env(), check=False)


def lock_remote():
    # Restricted lanes keep the token out of .git/config between runner ops.
    if LANE_RESTRICTED and REPO:
        set_remote(False)

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


def github_api(method, path, body=None, repo=None, token=None):
    if token is None:
        if not GITHUB_TOKEN:
            refresh_github_token()
        ensure_fresh_github_token()
        token = GITHUB_TOKEN
    owner, name = (repo or REPO).split('/')
    url = f'https://api.github.com/repos/{owner}/{name}{path}'
    headers = {
        'Authorization': f'Bearer {token}',
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


def default_branch(repo=None, token=None):
    info = github_api('GET', '', repo=repo, token=token) if repo else github_api('GET', '')
    return info.get('default_branch', 'main')


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
            run([GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['config', k, v], check=True)
    lock_remote()
    snapshot_git_config()


def resume_repo():
    # Follow-up prompt on a kept sandbox: the checkout and branch survive
    # from the prior run — fetch and fast-forward so the agent resumes on
    # current remote state (its earlier push included).
    validate_branch()
    validate_branch()
    if PUSH_POLICY == 'disabled':
        return
    refresh_github_token()
    # The kept checkout's .git/config is agent-writable — rebuild it before
    # any runner git call so a tampered config can't redirect or hook us.
    _reset_git_config()
    run(['timeout', '120', GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['fetch', '--depth', '50', 'origin', BRANCH], env=git_auth_env(), check=False)
    run([GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS + ['merge', '--ff-only', f'origin/{BRANCH}'], env=git_env(), check=False)
    lock_remote()


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
    if SECONDARY_PRS:
        digest['secondaryPrs'] = list(SECONDARY_PRS)
    return digest


def create_pr(digest=None):
    try:
        summary = ''
        if digest and digest.get('filesChanged') is not None:
            summary = f"\n\n---\nLane digest: {len(digest['filesChanged'])} files changed, {digest.get('commits', 0)} commits, ~{digest['durationSec']}s."
        if SECONDARY_PRS:
            summary += '\n\nCross-repo PRs:\n' + '\n'.join(f"- {p['repo']}: {p['prUrl']}" for p in SECONDARY_PRS)
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


def _revoke_installation_token(token, label):
    try:
        req = urllib.request.Request(
            'https://api.github.com/installation/token', method='DELETE',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pile-agent-runner/1.0'})
        urllib.request.urlopen(req, timeout=15)
        print(f'{label} revoked')
    except Exception as e:
        print(f'{label} revoke failed:', e)


def revoke_github_token():
    # Run end: kill the installation token now rather than leaving it live
    # for the rest of its ~1h TTL in a sandbox that may be kept for
    # follow-ups. Pile's sweep revokes server-side too; this is the fast path.
    revoke_secondary_tokens()
    token = globals()['GITHUB_TOKEN']
    if not token:
        return
    globals()['GITHUB_TOKEN'] = ''
    if REPO and os.path.isdir(os.path.join(REPO_DIR, '.git')):
        run(['git', '-C', REPO_DIR, 'remote', 'set-url', 'origin', f'https://github.com/{REPO}.git'], check=False)
    _revoke_installation_token(token, 'github token')


def revoke_secondary_tokens():
    for repo, token in list(SECONDARY_TOKENS.items()):
        SECONDARY_TOKENS.pop(repo, None)
        dest = secondary_dir(repo)
        if os.path.isdir(os.path.join(dest, '.git')):
            run([GIT, '-C', dest] + _GIT_SAFE_FLAGS + ['remote', 'set-url', 'origin', f'https://github.com/{repo}.git'], env=_git_env(), check=False)
        _revoke_installation_token(token, f'github token for {repo}')


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


def _reset_git_config(repo_dir=REPO_DIR, url=None, with_token=True):
    # url pins the remote verbatim (secondary repos); otherwise with_token
    # picks the policy URL — tokenless under restricted lanes.
    git_dir = os.path.join(repo_dir, '.git')
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
            f'[remote "origin"]\n\turl = {url or (remote_url() if with_token else tokenless_remote_url())}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
            f'[user]\n\tname = {name}\n\temail = {email}\n'
        )


def _refuse_default_branch():
    try:
        base = default_branch()
    except Exception as e:
        raise TransportError(f'default branch lookup failed: {e}') from e
    if BRANCH == base:
        raise RuntimeError(f'refusing to push lane branch {BRANCH!r}: it is the default branch')


def commit_and_push(agent_env=None):
    # agent_env only feeds the prePush hook; the runner's git never runs
    # through the agent's PATH (or a restricted lane's shims).
    if LANE_MODE == 'plan':
        print('plan lane: skipping commit/push')
        return False
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
    # can't have smuggled a credential or hook into .git/config. Restricted
    # lanes keep the remote tokenless; auth rides the push env's extraheader.
    _reset_git_config(with_token=not LANE_RESTRICTED)
    git = [GIT, '-C', REPO_DIR] + _GIT_SAFE_FLAGS
    env = git_auth_env()
    committed = commit_local(agent_env)
    ahead = run(git + ['rev-list', '--count', f'refs/remotes/origin/{BRANCH}..HEAD'], env=env, capture_output=True, text=True, check=True)
    if not committed and ahead.stdout.strip() == '0':
        print('no changes to commit')
        return False
    gate = run_hook('prePush', agent_env or scrubbed_env())
    if gate and gate[0] != 0:
        raise HookFailure(f'prePush hook failed (exit {gate[0]}); push blocked:\n{gate[1][-2000:]}')
    # The prePush hook is repo code and may have re-rigged .git/config.
    # Rebuilt with the just-refreshed token (not the dispatch-time one,
    # possibly >1h stale) as what push authenticates with.
    _reset_git_config()
    try:
        run_transport(push_command(), env=git_auth_env())
        return True
    finally:
        lock_remote()


# Cross-repo lanes (PILE-294): sibling repos cloned under ~/xrepo/<owner>/<name>.
# SECONDARY_REPOS_JSON = [{repo, access: read|write, token}] at dispatch; the
# tokenless list is persisted so a follow-up run on a kept sandbox can push.
XREPO_DIR = os.path.join(HOME, 'xrepo')
XREPO_STATE = os.path.join(XREPO_DIR, '.pile-xrepo.json')


def secondary_repos():
    raw = os.environ.get('SECONDARY_REPOS_JSON', '')
    if raw:
        entries = [e for e in json.loads(raw) if isinstance(e, dict) and e.get('repo')]
        for e in entries:
            add_mask(e.get('token'))
        return entries
    try:
        with open(XREPO_STATE) as f:
            return [dict(e, token='') for e in json.load(f)]
    except (OSError, ValueError):
        return []


def secondary_dir(repo):
    return os.path.join(XREPO_DIR, *repo.split('/'))


def secondary_remote_url(repo, token):
    # Mirrors remote_url()/lock_remote(): only an unrestricted push=enabled
    # lane keeps the token in the clone's remote; otherwise auth rides
    # secondary_auth_env's extraheader.
    if PUSH_POLICY == 'enabled' and not LANE_RESTRICTED:
        return f'https://x-access-token:{token}@github.com/{repo}.git'
    return f'https://github.com/{repo}.git'


def secondary_auth_env(token):
    base = _with_git_config(git_env(), NO_HOOKS_GIT_CONFIG)
    if not token:
        return base
    basic = base64.b64encode(f'x-access-token:{token}'.encode()).decode()
    return _with_git_config(base, [
        ('http.https://github.com/.extraheader', f'AUTHORIZATION: basic {basic}'),
    ])


def secondary_token(repo, fallback=''):
    # Same lane-token re-mint as refresh_github_token, scoped by ?repo= to one
    # of this session's secondary repos. Falls back to the dispatch-time token.
    url = os.environ.get('PILE_TOKEN_URL')
    token = os.environ.get('LANE_TOKEN')
    if not (url and token):
        return fallback
    try:
        req = urllib.request.Request(url + '?repo=' + urllib.parse.quote(repo, safe=''), headers={'Authorization': 'Bearer ' + token, 'User-Agent': 'pile-agent-runner/1.0'}, method='POST')
        with urllib.request.urlopen(req, timeout=30) as resp:
            fresh = json.load(resp)['token']
        add_mask(fresh)
        return fresh
    except Exception as e:
        print(f'github token refresh failed for {repo}:', e)
        return fallback


def clone_secondary_repos():
    entries = secondary_repos()
    if not entries:
        return
    os.makedirs(XREPO_DIR, exist_ok=True)
    for entry in entries:
        repo = entry['repo']
        dest = secondary_dir(repo)
        if os.path.exists(dest):
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        token = entry.get('token') or secondary_token(repo)
        if token:
            SECONDARY_TOKENS[repo] = token
        auth_env = secondary_auth_env(token)
        git = [GIT, '-C', dest] + _GIT_SAFE_FLAGS
        run_transport(['timeout', '300', GIT] + _GIT_SAFE_FLAGS + ['clone', '--quiet', '--depth', '1', secondary_remote_url(repo, token), dest], env=auth_env)
        if entry.get('access') == 'write':
            # Resume the lane branch when a prior run already pushed it.
            heads = run_transport(git + ['ls-remote', '--heads', 'origin', BRANCH], env=auth_env, capture_output=True, text=True)
            if (heads.stdout or '').strip():
                run_transport(['timeout', '300'] + git + ['fetch', '--depth', '1', 'origin', f'+refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}'], env=auth_env)
                run(git + ['checkout', '-B', BRANCH, f'origin/{BRANCH}'], env=git_env(), check=True)
            else:
                run(git + ['checkout', '-b', BRANCH], env=git_env(), check=True)
            run(git + ['config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', AGENT_LABEL)], env=git_env(), check=True)
            run(git + ['config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'agent@pile.nyc')], env=git_env(), check=True)
        print(f'cloned secondary repo {repo} ({entry.get("access", "read")}) -> {dest}')
    with open(XREPO_STATE, 'w') as f:
        json.dump([{'repo': e['repo'], 'access': e.get('access', 'read')} for e in entries], f)


def push_secondary_repos(agent_env):
    # Write-mode secondaries: commit leftovers, push the lane branch, open a
    # PR in that repo. A failure here is recorded, not fatal — the primary
    # repo's push and PR already happened.
    if PUSH_POLICY == 'disabled':
        if any(e.get('access') == 'write' for e in secondary_repos()):
            print('push disabled by lane policy — leaving secondary repo changes unpushed')
        return
    for entry in secondary_repos():
        if entry.get('access') != 'write':
            continue
        repo = entry['repo']
        dest = secondary_dir(repo)
        if not os.path.isdir(os.path.join(dest, '.git')):
            continue
        try:
            validate_branch()
            token = secondary_token(repo, SECONDARY_TOKENS.get(repo) or entry.get('token', ''))
            if token:
                SECONDARY_TOKENS[repo] = token
            # Same hardened push as commit_and_push: ~/xrepo was agent-writable.
            base = default_branch(repo, token)
            if BRANCH == base:
                raise RuntimeError(f'refusing to push lane branch {BRANCH!r}: it is the default branch of {repo}')
            _reset_git_config(dest, secondary_remote_url(repo, token))
            git = [GIT, '-C', dest] + _GIT_SAFE_FLAGS
            env = git_env()
            status = run(git + ['status', '--porcelain'], env=env, capture_output=True, text=True, check=True)
            if status.stdout.strip():
                run(git + ['add', '-A'], env=env, check=True)
                run(git + ['commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=env, check=True)
            remote_head = run(git + ['rev-parse', '--verify', '--quiet', f'refs/remotes/origin/{BRANCH}'], env=env, capture_output=True, text=True, check=False)
            base_ref = f'refs/remotes/origin/{BRANCH}' if remote_head.returncode == 0 else 'refs/remotes/origin/HEAD'
            ahead = run(git + ['rev-list', '--count', f'{base_ref}..refs/heads/{BRANCH}'], env=env, capture_output=True, text=True, check=False)
            if (ahead.stdout or '0').strip() == '0':
                print(f'no changes to push in secondary repo {repo}')
                continue
            refspec = f'refs/heads/{BRANCH}:refs/heads/{BRANCH}'
            # Same shape as push_command(): below push=enabled an explicit URL
            # so no remote config can widen the push.
            target = ['origin'] if PUSH_POLICY == 'enabled' else ['--no-follow-tags', f'https://github.com/{repo}.git']
            run_transport(git + ['push'] + target + [refspec], env=secondary_auth_env(token))
            owner = repo.split('/')[0]
            pulls = github_api('GET', f'/pulls?state=open&head={owner}:{BRANCH}', repo=repo, token=token)
            if pulls:
                pr_url = pulls[0]['html_url']
            else:
                primary = f' alongside {REPO}' if REPO else ''
                pr = github_api('POST', '/pulls', {
                    'title': os.environ.get('ISSUE_TITLE', BRANCH),
                    'head': BRANCH,
                    'base': base,
                    'body': f'Part of {os.environ.get("ISSUE_IDENTIFIER", BRANCH)} — cross-repo change{primary}.\n\nGenerated with {AGENT_LABEL}',
                }, repo=repo, token=token)
                pr_url = pr['html_url']
            SECONDARY_PRS.append({'repo': repo, 'prUrl': pr_url})
            print(f'secondary repo {repo} PR: {pr_url}')
        except Exception as e:
            print(f'secondary push failed for {repo}:', _redact(str(e)))
            PR_ERRORS.append(f'secondary {repo}: {_redact(str(e))}')


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


# Optional headless browser (PILE-292). Images built with LANE_BROWSER=1
# bake Google Chrome + agent-browser so UI-touching lanes can run e2e suites and
# screenshot their work instead of shipping blind. Absent = no-op.
BROWSER_CANDIDATES = ('chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome')
# Lanes run as root in a container with no usable /dev/shm.
BROWSER_ARGS = '--no-sandbox,--disable-dev-shm-usage'


def find_browser():
    for name in BROWSER_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def with_browser_env(env):
    path = find_browser()
    if not path:
        return env
    env.setdefault('PILE_BROWSER', path)
    env.setdefault('CHROME_PATH', path)
    env.setdefault('PUPPETEER_EXECUTABLE_PATH', path)
    env.setdefault('AGENT_BROWSER_EXECUTABLE_PATH', path)
    env.setdefault('AGENT_BROWSER_ARGS', BROWSER_ARGS)
    return env


def browser_prompt_note():
    path = find_browser()
    if not path or SHELL_POLICY == 'disabled':
        return ''
    lines = [
        '',
        '## Headless browser',
        '',
        f'A headless Chrome is installed at $PILE_BROWSER ({path}). If your change touches UI, verify it visually before finishing: start the dev server, load the affected page, take a screenshot, and look at it.',
    ]
    if shutil.which('agent-browser'):
        lines.append('`agent-browser` is on PATH and preconfigured for it: `agent-browser open http://localhost:5173 && agent-browser wait --load networkidle && agent-browser screenshot /tmp/shot.png` (also `snapshot -i`, `click`, `fill`; `agent-browser close` when done).')
    lines += [
        'One-shot screenshot: `"$PILE_BROWSER" --headless=new --no-sandbox --disable-dev-shm-usage --window-size=1280,800 --screenshot=/tmp/shot.png <url>`.',
        'For Playwright/Puppeteer e2e suites, launch with `executablePath: process.env.PILE_BROWSER` and args `--no-sandbox`, `--disable-dev-shm-usage` instead of downloading a browser.',
        'Do not commit screenshots unless the task asks for them.',
    ]
    return '\n'.join(lines)


def lane_prompt():
    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    return prompt + browser_prompt_note()


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
