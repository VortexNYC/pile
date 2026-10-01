# Pile agent runner — shared core.
#
# This file is concatenated with a per-agent driver (cursor.py, devin.py,
# codex.py) and shipped to the sandbox as RUNNER_PY_B64. Everything an agent
# lane needs that is NOT agent-specific lives here: transcript tee, redact,
# agent env allowlist, GitHub token refresh/revoke,
# repo ops, GitHub API, PR creation, lane digest, GitHub token refresh, log
# shipping, pnpm-store cache, postgres warmup, .pile/setup.sh. Drivers only
# define: ensure(), agent_env(), the run mechanism, and main().
#
# Contract with the adapter: the process writes RESULT_FILE
# (/tmp/agent-result.json) with {status, prUrl, branch, result, report?,
# infraFailure?} — infraFailure marks substrate failures (git transport,
# codeload, token mint) so the sweep retries instead of failing the task.
import base64
import calendar
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
    run(['git', '-C', REPO_DIR, 'remote', 'add', 'origin', f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git'], check=True)
    run_transport(['timeout', '300', 'git', '-C', REPO_DIR, '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--depth', '1', 'origin', BRANCH])
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
    run(['timeout', '120', 'git', '-C', REPO_DIR, 'fetch', '--depth', '50', 'origin', BRANCH], check=False)
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


def commit_and_push(agent_env):
    refresh_github_token()
    # Re-set the remote so the just-refreshed token (not the dispatch-time
    # one, possibly >1h stale) is what push authenticates with.
    run(['git', '-C', REPO_DIR, 'remote', 'set-url', 'origin', f'https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git'], env=agent_env, check=False)
    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=agent_env, capture_output=True, text=True, check=True)
    ahead = run(['git', '-C', REPO_DIR, 'rev-list', '--count', f'origin/{BRANCH}..HEAD'], env=agent_env, capture_output=True, text=True, check=True)
    if status.stdout.strip():
        run(['git', '-C', REPO_DIR, 'add', '-A'], env=agent_env, check=True)
        run(['git', '-C', REPO_DIR, 'commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=agent_env, check=True)
    elif ahead.stdout.strip() == '0':
        print('no changes to commit')
        return False
    run_transport(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=agent_env)
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
    pr_url = ''
    if pushed:
        pr_url = find_pr() or create_pr(digest)
    result_text = json.dumps({'output_tail': output, 'transcript': read_transcript(output), 'pr_errors': PR_ERRORS, 'digest': digest})
    write_result('completed', pr_url, result_text, report=report)
    return 0


def fail_result(error):
    write_result('failed', '', str(error), infra=isinstance(error, TransportError))
