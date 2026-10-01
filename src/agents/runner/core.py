# Pile agent runner — shared core.
#
# This file is concatenated with a per-agent driver (cursor.py, devin.py,
# codex.py) and shipped to the sandbox as RUNNER_PY_B64. Everything an agent
# lane needs that is NOT agent-specific lives here: transcript tee, redact,
# repo ops, GitHub API, PR creation, lane digest, GitHub token refresh, log
# shipping, pnpm-store cache, postgres warmup, .pile/setup.sh. Drivers only
# define: ensure(), agent_env(), the run mechanism, and main().
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
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# Runner-only credentials. The lane agent is untrusted code on a real repo:
# these live in runner memory (secret()) and never reach an agent subprocess,
# .pile/setup.sh, or the checkout's git config.
RUNNER_SECRETS = ('GITHUB_TOKEN', 'LANE_TOKEN', 'PILE_TOKEN_URL', 'PILE_LOG_TOKEN', 'PILE_LOG_URL', 'PILE_CACHE_URL', 'DEVIN_CREDENTIALS_B64', 'CODEX_AUTH_JSON_B64')
_SEAL_FD = 'PILE_RUNNER_SEAL_FD'


def _seal_secrets():
    # /proc/<pid>/environ is the exec-time env block and readable by any
    # same-uid process — unsetenv never clears it. As the entrypoint, re-exec
    # once with the secrets moved to an inherited memfd, so an agent reading
    # /proc/$PPID/environ (or every /proc/*/environ) finds none of them.
    fd = os.environ.pop(_SEAL_FD, None)
    if fd is not None:
        with os.fdopen(int(fd), 'rb') as f:
            return json.loads(f.read())
    secrets = {k: os.environ.pop(k) for k in RUNNER_SECRETS if k in os.environ}
    if __name__ != '__main__' or not secrets:
        return secrets
    memfd = os.memfd_create('pile-runner-secrets', 0)
    os.write(memfd, json.dumps(secrets).encode())
    os.lseek(memfd, 0, os.SEEK_SET)
    os.set_inheritable(memfd, True)
    env = dict(os.environ)
    env[_SEAL_FD] = str(memfd)
    os.execve(sys.executable, [sys.executable] + sys.argv, env)


_SECRETS = _seal_secrets()


def secret(name, default=''):
    return _SECRETS.get(name) or default


# Tee everything this runner prints (including the agent subprocess, whose
# output flows through sys.stdout) to a transcript file Pile can read live.
class _Tee:
    def __init__(self, *streams):
        self.streams = streams
    def write(self, s):
        s = _scrub_secrets(s)
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
GITHUB_TOKEN = secret('GITHUB_TOKEN')
REPO_DIR = os.path.join(HOME, 'repo')
RESULT_FILE = '/tmp/agent-result.json'
AGENT_LABEL = os.environ.get('AGENT_LABEL', 'Agent')
PR_ERRORS = []
RUN_STARTED = time.time()


def _scrub_secrets(s):
    for value in (GITHUB_TOKEN, *_SECRETS.values()):
        if value and len(value) >= 8:
            s = s.replace(value, '***')
    return re.sub(r'gh[opsu]_[A-Za-z0-9_.-]+|github_pat_[A-Za-z0-9_]+', 'gh*_***', s)


def _redact(s):
    s = _scrub_secrets(s)
    s = re.sub(r'(Bearer|x-access-token:)\s*\S+', r'\1 ***', s)
    return re.sub(r'Basic [A-Za-z0-9+/=]{16,}', 'Basic ***', s)


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


# Runner-owned git. The agent had root on the checkout — .git/config, hooks,
# attributes, a `git` shim on PATH — so every git call the runner makes runs
# a binary pinned before the agent started, with system/global config off,
# hooks and fsmonitor disabled, and the local config rebuilt from an
# allowlist. Auth rides an env-scoped extraheader for github.com only; the
# token is never written to the remote URL the agent can read.
SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
_GIT_LOCKDOWN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
_KEEP_GIT_CONFIG = re.compile(r'core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf)')
GITHUB_GIT_URL = f'https://github.com/{REPO}.git'


def _sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def _pin_git():
    git = shutil.which('git', path=SAFE_PATH)
    if not git:
        return 'git', {}
    git = os.path.realpath(git)
    exec_path = subprocess.run([git, '--exec-path'], capture_output=True, text=True).stdout.strip()
    files = [git] + [os.path.join(exec_path, n) for n in ('git-remote-https', 'git-remote-http')]
    return git, {f: _sha256(f) for f in files if os.path.exists(f)}


GIT_BIN, _GIT_PINS = _pin_git()


def verify_git():
    for path, digest in _GIT_PINS.items():
        try:
            current = _sha256(path)
        except OSError:
            current = None
        if current != digest:
            raise RuntimeError(f'git binary {path} changed since the runner started — refusing to run git')


def runner_git_env(auth=False):
    env = os.environ.copy()
    env.update({'PATH': SAFE_PATH, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'})
    for k in [k for k in env if k.startswith('GIT_CONFIG_KEY_') or k.startswith('GIT_CONFIG_VALUE_')]:
        del env[k]
    env['GIT_CONFIG_COUNT'] = '0'
    if auth and GITHUB_TOKEN:
        basic = base64.b64encode(f'x-access-token:{GITHUB_TOKEN}'.encode()).decode()
        env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_0': f'Authorization: Basic {basic}'})
    return env


def git_cmd(*args, prefix=()):
    verify_git()
    return [*prefix, GIT_BIN, *_GIT_LOCKDOWN, '-C', REPO_DIR, *args]


def git(*args, auth=False, prefix=(), **kwargs):
    return run(git_cmd(*args, prefix=prefix), env=runner_git_env(auth), **kwargs)


def git_transport(*args, prefix=()):
    return run_transport(git_cmd(*args, prefix=prefix), env=runner_git_env(True))


def sanitize_git_config():
    git_dir = os.path.join(REPO_DIR, '.git')
    if os.path.islink(git_dir) or not os.path.isdir(git_dir) or os.path.exists(os.path.join(git_dir, 'commondir')):
        raise RuntimeError('lane checkout .git was replaced — refusing to run git')
    path = os.path.join(git_dir, 'config')
    verify_git()
    listed = subprocess.run([GIT_BIN, 'config', '--file', path, '--null', '--list'], env=runner_git_env(), capture_output=True, text=True)
    keep = []
    for entry in (listed.stdout or '').split('\0'):
        key, _, value = entry.partition('\n')
        if _KEEP_GIT_CONFIG.fullmatch(key):
            keep.append((key, value))
    for stale in (path, os.path.join(git_dir, 'config.worktree')):
        if os.path.lexists(stale):
            os.remove(stale)
    keep += [
        ('remote.origin.url', GITHUB_GIT_URL),
        ('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'),
        ('user.name', os.environ.get('GIT_AUTHOR_NAME', AGENT_LABEL)),
        ('user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'agent@pile.nyc')),
    ]
    for key, value in keep:
        subprocess.run([GIT_BIN, 'config', '--file', path, '--add', key, value], env=runner_git_env(), check=True)


# Push restriction: a lane writes exactly refs/heads/<BRANCH>, never the
# default branch, and BRANCH can't smuggle a refspec, a flag, or a ref
# outside refs/heads/ into the runner's git argv.
_PROTECTED_BRANCHES = ('main', 'master', 'head')


def lane_branch_error(branch, default=''):
    if not branch:
        return 'lane branch is empty'
    if branch.lower() in _PROTECTED_BRANCHES or (default and branch.lower() == default.lower()):
        return f'lane branch "{branch}" is the repo default branch'
    if branch.startswith(('-', '/', 'refs/')) or re.search(r'[\s:+^~?*\[\\]|\.\.|@\{|^@$', branch):
        return f'lane branch "{branch}" is not a plain branch name'
    verify_git()
    check = subprocess.run([GIT_BIN, 'check-ref-format', f'refs/heads/{branch}'], env=runner_git_env(), capture_output=True)
    if check.returncode != 0:
        return f'lane branch "{branch}" is not a valid ref name'
    return ''


def assert_lane_branch(default=''):
    error = lane_branch_error(BRANCH, default)
    if error:
        raise RuntimeError(error)


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


_DEFAULT_BRANCH = []


def default_branch():
    if not _DEFAULT_BRANCH:
        repo = github_api('GET', '')
        _DEFAULT_BRANCH.append(repo.get('default_branch', 'main'))
    return _DEFAULT_BRANCH[0]


def create_branch():
    base = default_branch()
    assert_lane_branch(base)
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
    git('init', '-b', BRANCH, check=True)
    sanitize_git_config()
    git_transport('-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '--depth', '1', 'origin', f'refs/heads/{BRANCH}', prefix=('timeout', '300'))
    git('update-ref', f'refs/heads/{BRANCH}', 'FETCH_HEAD', check=True)
    base = git('rev-parse', 'FETCH_HEAD', capture_output=True, text=True, check=False)
    if base.returncode == 0:
        with open('/tmp/base_sha', 'w') as f:
            f.write(base.stdout.strip())
    git('symbolic-ref', 'HEAD', f'refs/heads/{BRANCH}', check=True)
    git('reset', check=True)
    print(f'[timing] git fetch: {time.time() - t1:.0f}s')


def resume_repo():
    # Follow-up prompt on a kept sandbox: the checkout and branch survive
    # from the prior run — fetch and fast-forward so the agent resumes on
    # current remote state (its earlier push included).
    assert_lane_branch()
    refresh_github_token()
    sanitize_git_config()
    git('fetch', '--depth', '50', 'origin', f'refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}', auth=True, prefix=('timeout', '120'), check=False)
    git('merge', '--ff-only', f'refs/remotes/origin/{BRANCH}', check=False)


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
        files = git('diff', '--name-only', f'{base}...HEAD', capture_output=True, text=True, check=False)
        digest['filesChanged'] = [f for f in (files.stdout or '').splitlines() if f]
        commits = git('rev-list', '--count', f'{base}..HEAD', capture_output=True, text=True, check=False)
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
    url = secret('PILE_TOKEN_URL')
    token = secret('LANE_TOKEN')
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


def commit_and_push():
    # Refresh first so the push authenticates with a fresh token, not the
    # dispatch-time one (possibly >1h stale).
    refresh_github_token()
    assert_lane_branch(default_branch())
    sanitize_git_config()
    status = git('status', '--porcelain', capture_output=True, text=True, check=True)
    ahead = git('rev-list', '--count', f'refs/remotes/origin/{BRANCH}..HEAD', capture_output=True, text=True, check=False)
    if status.stdout.strip():
        git('add', '-A', check=True)
        git('commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}', check=True)
    elif ahead.returncode == 0 and ahead.stdout.strip() == '0':
        print('no changes to commit')
        return False
    git_transport('push', 'origin', f'refs/heads/{BRANCH}:refs/heads/{BRANCH}')
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
PILE_LOG_URL = secret('PILE_LOG_URL')
PILE_LOG_TOKEN = secret('PILE_LOG_TOKEN')
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
PILE_CACHE_URL = secret('PILE_CACHE_URL')
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
    payload = {'status': status, 'prUrl': pr_url, 'branch': BRANCH, 'result': _scrub_secrets(result)}
    if report:
        payload['report'] = _scrub_secrets(report) if isinstance(report, str) else report
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
