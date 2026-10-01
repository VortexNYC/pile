# Pile agent runner — shared core.
#
# This file is concatenated with a per-agent driver (cursor.py, devin.py,
# codex.py) and shipped to the sandbox as RUNNER_PY_B64. Everything an agent
# lane needs that is NOT agent-specific lives here: transcript tee, redact,
# repo ops, GitHub API, PR creation, lane digest, GitHub token refresh, log
# shipping, pnpm-store cache, postgres warmup, .pile/setup.sh, and lane exec
# isolation (lane_env scrubbing + restricted-mode command guard). Drivers only
# define: ensure(), agent_env() (built on lane_env), the run mechanism, and
# main().
#
# Contract with the adapter: the process writes RESULT_FILE
# (/tmp/agent-result.json) with {status, prUrl, branch, result, report?,
# infraFailure?} — infraFailure marks substrate failures (git transport,
# codeload, token mint) so the sweep retries instead of failing the task.
import base64
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Tee everything this runner prints (including the agent subprocess, whose
# output flows through sys.stdout) to a transcript file Pile can read live.
class _Tee:
    def __init__(self, *streams):
        self.streams = streams
    def write(self, s):
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
REPO_DIR = os.path.join(HOME, 'repo')
RESULT_FILE = '/tmp/agent-result.json'
AGENT_LABEL = os.environ.get('AGENT_LABEL', 'Agent')
PR_ERRORS = []
RUN_STARTED = time.time()


# Lane exec isolation (PILE-281). The runner holds the substrate secrets —
# GitHub token, lane/log tokens, provider credentials — and keeps them to
# itself: the agent, the setup hook, and every shell they spawn run under
# lane_env(), which strips them. Tokens are never ambient in the lane.
RUNNER_SECRET_KEYS = frozenset((
    'GITHUB_TOKEN', 'GH_TOKEN', 'LANE_TOKEN', 'PILE_TOKEN_URL',
    'PILE_LOG_TOKEN', 'PILE_LOG_URL', 'PILE_CACHE_URL',
    'CURSOR_API_KEY', 'DEVIN_CREDENTIALS_B64', 'CODEX_AUTH_JSON_B64',
    'RUNNER_PY_B64', 'PROMPT_B64', 'PILE_AGENT_ENV_PASSTHROUGH',
))
# Anything secret-shaped that isn't a known runner key (provider tokens the
# compute substrate injected, cloud creds baked into an image) goes too.
_SECRET_NAME_RE = re.compile(
    r'(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY(_ID)?|PRIVATE_KEY|CREDENTIALS?|AUTH_?TOKEN|AUTH_JSON)S?(_|$)',
    re.IGNORECASE,
)
GUARD_DIR = os.environ.get('PILE_GUARD_DIR', '/tmp/pile-guard')
GUARD_BIN = os.path.join(GUARD_DIR, 'bin')
_RESTRICTED_MARKER = os.path.join(GUARD_DIR, 'restricted')
# The marker outlives the process so a follow-up run on a kept sandbox stays
# restricted even though its env is rebuilt from scratch.
RESTRICTED = os.environ.get('PILE_LANE_RESTRICTED') == '1' or os.path.exists(_RESTRICTED_MARKER)


def _passthrough_keys(env):
    # Keys the dispatcher deliberately hands the agent — the scoped Pile API
    # credential and the repo's `.pile/config.json` env allowlist.
    return {k.strip() for k in env.get('PILE_AGENT_ENV_PASSTHROUGH', '').split(',') if k.strip()}


def scrub_env(env, keep=()):
    keep = set(keep)
    passthrough = _passthrough_keys(env) | keep
    out = {}
    for key, value in env.items():
        if key in keep:
            out[key] = value
        elif key in RUNNER_SECRET_KEYS:
            continue
        elif key in passthrough or not _SECRET_NAME_RE.search(key):
            out[key] = value
    return out


def _write_unset_rc(keys):
    # `keep` keys must reach the agent binary itself (its own provider
    # credential) but not the shells it spawns: non-interactive bash sources
    # BASH_ENV first, so the key is gone before the command runs. A top-level
    # bash whose stdin is a socket sources ~/.bashrc instead, so hook it too.
    os.makedirs(GUARD_DIR, exist_ok=True)
    rc = os.path.join(GUARD_DIR, 'shell-env.sh')
    with open(rc, 'w') as f:
        f.write('unset ' + ' '.join(sorted(keys)) + '\n')
    hook = f'[ -f {shlex.quote(rc)} ] && . {shlex.quote(rc)}\n'
    bashrc = os.path.join(HOME, '.bashrc')
    try:
        with open(bashrc) as f:
            current = f.read()
    except FileNotFoundError:
        current = ''
    if hook not in current:
        with open(bashrc, 'w') as f:
            f.write(hook + current)
    return rc


def lane_env(keep=(), extra=None):
    if RESTRICTED:
        install_guard()
    env = scrub_env(os.environ, keep)
    env['HOME'] = HOME
    path = INSTALL_DIR + ':' + env.get('PATH', '')
    if RESTRICTED:
        env['PILE_LANE_RESTRICTED'] = '1'
        path = GUARD_BIN + ':' + path
    env['PATH'] = path
    if keep:
        env['BASH_ENV'] = _write_unset_rc(keep)
    env.update(extra or {})
    return env


def git_auth_env(base=None):
    # Runner-only git auth: the token rides a GIT_CONFIG_* extraheader on the
    # runner's own fetch/push instead of living in .git/config, where the
    # agent could read it back out of the remote URL.
    env = dict(os.environ if base is None else base)
    basic = base64.b64encode(f'x-access-token:{GITHUB_TOKEN}'.encode()).decode()
    n = int(env.get('GIT_CONFIG_COUNT', '0') or 0)
    env['GIT_CONFIG_COUNT'] = str(n + 1)
    env[f'GIT_CONFIG_KEY_{n}'] = 'http.https://github.com/.extraheader'
    env[f'GIT_CONFIG_VALUE_{n}'] = f'AUTHORIZATION: basic {basic}'
    return env


# Restricted mode: dangerous git/network commands go through a policy shim
# on PATH ahead of the real binaries. Defense in depth on top of scrub_env —
# the lane already holds no push credential; the shim makes intent explicit
# and stops prompt-injected exfil via the common CLIs.
GUARDED_COMMANDS = (
    'git', 'gh', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat',
    'netcat', 'socat', 'telnet', 'ftp',
)
DEFAULT_ALLOWED_HOSTS = (
    'github.com', 'codeload.github.com', 'raw.githubusercontent.com',
    'objects.githubusercontent.com', 'registry.npmjs.org',
    'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
)

GUARD_PY = r'''
import os
import re
import sys
import urllib.parse

BLOCKED_TOOLS = {'gh', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'}
GIT_BLOCKED_SUBCOMMANDS = {'push', 'send-email', 'daemon', 'http-push', 'credential', 'credential-store', 'credential-cache'}
GIT_REMOTE_MUTATIONS = {'add', 'set-url', 'rename', 'remove', 'rm', 'set-branches'}
GIT_URL_SUBCOMMANDS = {'clone', 'fetch', 'pull', 'ls-remote', 'submodule'}
GIT_DANGEROUS_KEY = re.compile(r'^(remote\..+\.(url|pushurl)|credential(\..*)?|url\..+\.(insteadof|pushinsteadof)|http\..*extraheader|core\.sshcommand|alias\..+)$', re.IGNORECASE)
GIT_VALUE_GLOBALS = {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'}
CURL_VALUE_OPTS = {
    '-o', '--output', '-d', '--data', '--data-binary', '--data-raw', '--data-urlencode', '--data-ascii', '--json',
    '-H', '--header', '-X', '--request', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie',
    '-c', '--cookie-jar', '-F', '--form', '--form-string', '-T', '--upload-file', '-w', '--write-out', '-m',
    '--max-time', '--connect-timeout', '-E', '--cert', '--key', '--cacert', '--capath', '-r', '--range', '--retry',
    '--retry-delay', '--retry-max-time', '-y', '--speed-time', '-Y', '--speed-limit', '-z', '--time-cond',
    '--limit-rate', '--oauth2-bearer', '-U', '--proxy-user', '--output-dir', '--max-filesize', '--trace',
    '--trace-ascii', '--stderr', '-D', '--dump-header', '--interface', '--dns-servers',
}
CURL_BLOCKED_OPTS = {'-K', '--config', '-x', '--proxy', '--preproxy', '--connect-to', '--resolve', '--socks4', '--socks4a', '--socks5', '--socks5-hostname'}
WGET_VALUE_OPTS = {
    '-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix',
    '-U', '--user-agent', '--header', '--post-data', '--post-file', '--body-data', '--body-file', '--method',
    '--user', '--password', '--http-user', '--http-password', '-t', '--tries', '-T', '--timeout', '-w', '--wait',
    '--referer', '--load-cookies', '--save-cookies', '-Q', '--quota',
}
WGET_BLOCKED_OPTS = {'-i', '--input-file', '-e', '--execute', '--config', '-B', '--base'}


LOCAL_HOSTS = {'', 'localhost', '127.0.0.1', '::1', '0.0.0.0'}


def host_allowed(host, allowed):
    host = (host or '').lower().rstrip('.')
    if host in LOCAL_HOSTS:
        return True
    return any(host == a or host.endswith('.' + a) for a in allowed)


def url_host(arg, default_scheme=None):
    if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', arg):
        return urllib.parse.urlsplit(arg).hostname or ''
    # scp-like git remotes: user@host:path, or a dotted host:path.
    m = re.match(r'^(?:[^@/\s:]+@([^:/\s]+)|([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)):(?!//)', arg)
    if m and default_scheme is None:
        return m.group(1) or m.group(2)
    if default_scheme:
        return urllib.parse.urlsplit(default_scheme + '://' + arg).hostname or ''
    return None


def positionals(args, value_opts, blocked_opts):
    out = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            out.extend(args[i + 1:])
            break
        if a.startswith('--'):
            name = a.split('=', 1)[0]
            if name in blocked_opts:
                raise PermissionError(f'option {name} is not allowed')
            if name == '--url':
                out.append(a[6:] if '=' in a else (args[i + 1] if i + 1 < len(args) else ''))
                i += 1 if '=' in a else 2
                continue
            if name in value_opts and '=' not in a:
                i += 1
        elif a.startswith('-') and a != '-':
            # Short-flag cluster (getopt): a value-taking flag consumes the
            # rest of the cluster, or the next arg when it ends the cluster.
            for j, ch in enumerate(a[1:]):
                flag = '-' + ch
                if flag in blocked_opts:
                    raise PermissionError(f'option {flag} is not allowed')
                if flag in value_opts:
                    if j == len(a) - 2:
                        i += 1
                    break
        else:
            out.append(a)
        i += 1
    return out


def check_http(tool, args, allowed):
    value_opts, blocked = (CURL_VALUE_OPTS, CURL_BLOCKED_OPTS) if tool == 'curl' else (WGET_VALUE_OPTS, WGET_BLOCKED_OPTS)
    try:
        urls = positionals(args, value_opts, blocked)
    except PermissionError as e:
        return f'{tool}: {e}'
    for u in urls:
        host = url_host(u, default_scheme='http')
        if not host_allowed(host, allowed):
            return f'{tool}: host {host or u!r} is not on the lane network allowlist'
    return None


def check_git(args, allowed, environ):
    i = 0
    n = int(environ.get('GIT_CONFIG_COUNT', '0') or 0)
    for k in range(n):
        if GIT_DANGEROUS_KEY.match(environ.get(f'GIT_CONFIG_KEY_{k}', '')):
            return 'git: GIT_CONFIG_* may not set credential/remote/alias keys'
    while i < len(args) and args[i].startswith('-'):
        a = args[i]
        name = a.split('=', 1)[0]
        if name in ('-c', '--config-env'):
            attached = name == '--config-env' and '=' in a
            val = a.split('=', 1)[1] if attached else (args[i + 1] if i + 1 < len(args) else '')
            key = val.split('=', 1)[0]
            if GIT_DANGEROUS_KEY.match(key):
                return f'git: {name} {key} is not allowed'
            i += 1 if attached else 2
            continue
        i += 2 if a in GIT_VALUE_GLOBALS else 1
    if i >= len(args):
        return None
    sub, rest = args[i], args[i + 1:]
    if sub in GIT_BLOCKED_SUBCOMMANDS:
        return f'git {sub} is not allowed — the runner pushes after the agent exits'
    if sub == 'remote' and rest and rest[0] in GIT_REMOTE_MUTATIONS:
        return f'git remote {rest[0]} is not allowed'
    if sub == 'config' and any(GIT_DANGEROUS_KEY.match(a.split('=', 1)[0]) for a in rest):
        return 'git config may not set credential/remote/alias keys'
    if sub in GIT_URL_SUBCOMMANDS:
        for a in rest:
            if a.startswith('-'):
                continue
            host = url_host(a)
            if host is not None and not host_allowed(host, allowed):
                return f'git {sub}: host {host!r} is not on the lane network allowlist'
    return None


def check(tool, args, allowed, environ=None):
    environ = os.environ if environ is None else environ
    if tool in BLOCKED_TOOLS:
        return f'{tool} is not allowed'
    if tool == 'git':
        return check_git(args, allowed, environ)
    if tool in ('curl', 'wget'):
        return check_http(tool, args, allowed)
    return None


def allowed_hosts(path):
    try:
        with open(path) as f:
            return [h.strip().lower() for h in f.read().split(',') if h.strip()]
    except OSError:
        return []


def real_binary(tool, guard_bin):
    for d in os.environ.get('PATH', '').split(os.pathsep):
        if not d or os.path.realpath(d) == os.path.realpath(guard_bin):
            continue
        p = os.path.join(d, tool)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    tool, args = sys.argv[1], sys.argv[2:]
    reason = check(tool, args, allowed_hosts(os.path.join(here, 'allowed-hosts')))
    if reason:
        sys.stderr.write(f'pile restricted mode: blocked — {reason}\n')
        sys.exit(126)
    real = real_binary(tool, os.path.join(here, 'bin'))
    if not real:
        sys.stderr.write(f'{tool}: command not found\n')
        sys.exit(127)
    os.execv(real, [tool] + args)
'''

_guard = {'__name__': 'pile_guard'}
exec(compile(GUARD_PY, 'pile_guard', 'exec'), _guard)
guard_check = _guard['check']


def lane_allowed_hosts():
    hosts = list(DEFAULT_ALLOWED_HOSTS)
    api = os.environ.get('PILE_API_URL')
    if api:
        hosts.append(urllib.parse.urlsplit(api).hostname or '')
    hosts += [h.strip() for h in os.environ.get('PILE_LANE_NET_ALLOW', '').split(',') if h.strip()]
    return ','.join(sorted({h.lower() for h in hosts if h}))


def install_guard():
    os.makedirs(GUARD_BIN, exist_ok=True)
    guard_py = os.path.join(GUARD_DIR, 'guard.py')
    with open(guard_py, 'w') as f:
        f.write(GUARD_PY)
    python = sys.executable or 'python3'
    for tool in GUARDED_COMMANDS:
        shim = os.path.join(GUARD_BIN, tool)
        with open(shim, 'w') as f:
            f.write(f'#!/bin/sh\nexec {python} {guard_py} {tool} "$@"\n')
        os.chmod(shim, 0o755)
    with open(os.path.join(GUARD_DIR, 'allowed-hosts'), 'w') as f:
        f.write(lane_allowed_hosts())
    with open(_RESTRICTED_MARKER, 'w') as f:
        f.write('1\n')


def _redact(s):
    s = re.sub(r'(Bearer|x-access-token:)\s*\S+', r'\1 ***', s)
    s = re.sub(r'ghs_[A-Za-z0-9_.-]+', 'ghs_***', s)
    return s


def run(cmd, cwd=None, env=None, check=False, **kwargs):
    print(_redact('+ ' + ' '.join(str(c) for c in cmd)))
    result = subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)
    if check and result.returncode != 0:
        raise RuntimeError(f'Command failed: {_redact(str(cmd))} returned {result.returncode}; stdout={_redact(result.stdout or "")}; stderr={_redact(result.stderr or "")}')
    return result


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


def clone_repo():
    # Refresh before the first GitHub call — the dispatch-time token may
    # already be old if the lane queued, and this proves the lane-token
    # refresh path fires on every run, not just at push time.
    refresh_github_token()
    if os.path.exists(REPO_DIR):
        shutil.rmtree(REPO_DIR)
    os.makedirs(REPO_DIR, exist_ok=True)
    t0 = time.time()
    run_transport(['curl', '-fsSL', '--max-time', '120', '-H', f'Authorization: Bearer {GITHUB_TOKEN}', '-o', '/tmp/repo.tgz', f'https://codeload.github.com/{REPO}/tar.gz/{BRANCH}'])
    run_transport(['tar', '-xzf', '/tmp/repo.tgz', '--strip-components=1', '-C', REPO_DIR])
    print(f'[timing] codeload tarball: {time.time() - t0:.0f}s')
    t1 = time.time()
    run(['git', '-C', REPO_DIR, 'init', '-b', BRANCH], check=True)
    run(['git', '-C', REPO_DIR, 'remote', 'add', 'origin', f'https://github.com/{REPO}.git'], check=True)
    run_transport(['timeout', '300', 'git', '-C', REPO_DIR, '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--depth', '1', 'origin', BRANCH], env=git_auth_env())
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


def resume_repo():
    # Follow-up prompt on a kept sandbox: the checkout and branch survive
    # from the prior run — fetch and fast-forward so the agent resumes on
    # current remote state (its earlier push included).
    run(['git', '-C', REPO_DIR, 'remote', 'set-url', 'origin', f'https://github.com/{REPO}.git'], check=False)
    run(['timeout', '120', 'git', '-C', REPO_DIR, 'fetch', '--depth', '50', 'origin', BRANCH], env=git_auth_env(), check=False)
    run(['git', '-C', REPO_DIR, 'merge', '--ff-only', f'origin/{BRANCH}'], check=False)


def run_setup_hook(agent_env):
    # Repo-declared environment hook (.pile/setup.sh) — each repo wires its
    # own toolchain instead of the image hardcoding per-repo steps.
    hook = os.path.join(REPO_DIR, '.pile', 'setup.sh')
    if not os.path.exists(hook):
        return
    t0 = time.time()
    print('running .pile/setup.sh')
    result = run(['bash', hook], cwd=REPO_DIR, env=agent_env(), check=False)
    print(f'[timing] setup.sh: {time.time() - t0:.0f}s exit={result.returncode}')


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
    try:
        with open('/tmp/base_sha') as f:
            base = f.read().strip()
    except OSError:
        base = ''
    if REPO and base:
        files = run(['git', '-C', REPO_DIR, 'diff', '--name-only', f'{base}...HEAD'], capture_output=True, text=True, check=False)
        digest['filesChanged'] = [f for f in (files.stdout or '').splitlines() if f]
        commits = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'{base}..HEAD'], capture_output=True, text=True, check=False)
        digest['commits'] = int((commits.stdout or '0').strip() or 0)
    return digest


def create_pr(digest=None):
    try:
        summary = ''
        if digest and digest.get('filesChanged') is not None:
            summary = f"\n\n---\nLane digest: {len(digest['filesChanged'])} files changed, {digest.get('commits', 0)} commits, ~{digest['durationSec']}s."
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
        globals()['GITHUB_TOKEN'] = data['token']
        _TRANSPORT_NOTES.clear()
        print('github token refreshed')
    except Exception as e:
        # Not fatal on its own — the dispatch-time token may still be valid —
        # but if a later transport call dies, the note rides along so the
        # retried lane's failure shows the mint failure as the cause.
        _TRANSPORT_NOTES.append(f'github token refresh failed: {e}')
        print('github token refresh failed:', e)


def commit_and_push(agent_env):
    refresh_github_token()
    # Token-free remote: push authenticates via git_auth_env() with the
    # just-refreshed token, and a kept sandbox's legacy token-in-URL remote
    # is scrubbed before the next agent run can read it.
    run(['git', '-C', REPO_DIR, 'remote', 'set-url', 'origin', f'https://github.com/{REPO}.git'], check=False)
    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=agent_env, capture_output=True, text=True, check=True)
    ahead = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'origin/{BRANCH}..HEAD'], env=agent_env, capture_output=True, text=True, check=True)
    if status.stdout.strip():
        run(['git', '-C', REPO_DIR, 'add', '-A'], env=agent_env, check=True)
        run(['git', '-C', REPO_DIR, 'commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=agent_env, check=True)
    elif ahead.stdout.strip() == '0':
        print('no changes to commit')
        return False
    run_transport(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=git_auth_env())
    return True


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
    payload = {'status': status, 'prUrl': pr_url, 'branch': BRANCH, 'result': result}
    if report:
        payload['report'] = report
    if infra:
        payload['infraFailure'] = True
    with open(RESULT_FILE, 'w') as f:
        json.dump(payload, f)


def finalize(output, pushed, report=None):
    # Terminal bookkeeping shared by every driver: digest → PR → result file.
    digest = collect_digest()
    pr_url = ''
    if pushed:
        pr_url = find_pr() or create_pr(digest)
    result_text = json.dumps({'output_tail': output, 'transcript': read_transcript(output), 'pr_errors': PR_ERRORS, 'digest': digest})
    write_result('completed', pr_url, result_text, report=report)
    return 0


def fail_result(error):
    write_result('failed', '', str(error), infra=isinstance(error, TransportError))
