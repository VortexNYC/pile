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
SECONDARY_PRS = []
RUN_STARTED = time.time()


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


def github_api(method, path, body=None, repo=None):
    owner, name = (repo or REPO).split('/')
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


def default_branch(repo=None):
    info = github_api('GET', '', repo=repo) if repo else github_api('GET', '')
    return info.get('default_branch', 'main')


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


# Cross-repo lanes (PILE-294): sibling repos cloned under ~/xrepo/<owner>/<name>.
# SECONDARY_REPOS_JSON = [{repo, access: read|write, token}] at dispatch; the
# tokenless list is persisted so a follow-up run on a kept sandbox can push.
XREPO_DIR = os.path.join(HOME, 'xrepo')
XREPO_STATE = os.path.join(XREPO_DIR, '.pile-xrepo.json')


def secondary_repos():
    raw = os.environ.get('SECONDARY_REPOS_JSON', '')
    if raw:
        return [e for e in json.loads(raw) if isinstance(e, dict) and e.get('repo')]
    try:
        with open(XREPO_STATE) as f:
            return [dict(e, token='') for e in json.load(f)]
    except (OSError, ValueError):
        return []


def secondary_dir(repo):
    return os.path.join(XREPO_DIR, *repo.split('/'))


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
            return json.load(resp)['token']
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
        remote = f'https://x-access-token:{token}@github.com/{repo}.git'
        run_transport(['timeout', '300', 'git', 'clone', '--quiet', '--depth', '1', remote, dest])
        if entry.get('access') == 'write':
            # Resume the lane branch when a prior run already pushed it.
            heads = run_transport(['git', '-C', dest, 'ls-remote', '--heads', 'origin', BRANCH], capture_output=True, text=True)
            if (heads.stdout or '').strip():
                run_transport(['timeout', '300', 'git', '-C', dest, 'fetch', '--depth', '1', 'origin', f'+refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}'])
                run(['git', '-C', dest, 'checkout', '-B', BRANCH, f'origin/{BRANCH}'], check=True)
            else:
                run(['git', '-C', dest, 'checkout', '-b', BRANCH], check=True)
            run(['git', '-C', dest, 'config', 'user.name', os.environ.get('GIT_AUTHOR_NAME', AGENT_LABEL)], check=True)
            run(['git', '-C', dest, 'config', 'user.email', os.environ.get('GIT_AUTHOR_EMAIL', 'agent@pile.nyc')], check=True)
        print(f'cloned secondary repo {repo} ({entry.get("access", "read")}) -> {dest}')
    with open(XREPO_STATE, 'w') as f:
        json.dump([{'repo': e['repo'], 'access': e.get('access', 'read')} for e in entries], f)


def push_secondary_repos(agent_env):
    # Write-mode secondaries: commit leftovers, push the lane branch, open a
    # PR in that repo. A failure here is recorded, not fatal — the primary
    # repo's push and PR already happened.
    for entry in secondary_repos():
        if entry.get('access') != 'write':
            continue
        repo = entry['repo']
        dest = secondary_dir(repo)
        if not os.path.isdir(os.path.join(dest, '.git')):
            continue
        try:
            token = secondary_token(repo, entry.get('token', ''))
            if token:
                run(['git', '-C', dest, 'remote', 'set-url', 'origin', f'https://x-access-token:{token}@github.com/{repo}.git'], env=agent_env, check=False)
            status = run(['git', '-C', dest, 'status', '--porcelain'], env=agent_env, capture_output=True, text=True, check=True)
            if status.stdout.strip():
                run(['git', '-C', dest, 'add', '-A'], env=agent_env, check=True)
                run(['git', '-C', dest, 'commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=agent_env, check=True)
            remote_head = run(['git', '-C', dest, 'rev-parse', '--verify', '--quiet', f'refs/remotes/origin/{BRANCH}'], env=agent_env, capture_output=True, text=True, check=False)
            base_ref = f'origin/{BRANCH}' if remote_head.returncode == 0 else 'origin/HEAD'
            ahead = run(['git', '-C', dest, 'rev-list', '--count', f'{base_ref}..HEAD'], env=agent_env, capture_output=True, text=True, check=False)
            if (ahead.stdout or '0').strip() == '0':
                print(f'no changes to push in secondary repo {repo}')
                continue
            run_transport(['git', '-C', dest, 'push', 'origin', f'HEAD:refs/heads/{BRANCH}'], env=agent_env)
            owner = repo.split('/')[0]
            pulls = github_api('GET', f'/pulls?state=open&head={owner}:{BRANCH}', repo=repo)
            if pulls:
                pr_url = pulls[0]['html_url']
            else:
                primary = f' alongside {REPO}' if REPO else ''
                pr = github_api('POST', '/pulls', {
                    'title': os.environ.get('ISSUE_TITLE', BRANCH),
                    'head': BRANCH,
                    'base': default_branch(repo),
                    'body': f'Part of {os.environ.get("ISSUE_IDENTIFIER", BRANCH)} — cross-repo change{primary}.\n\nGenerated with {AGENT_LABEL}',
                }, repo=repo)
                pr_url = pr['html_url']
            SECONDARY_PRS.append({'repo': repo, 'prUrl': pr_url})
            print(f'secondary repo {repo} PR: {pr_url}')
        except Exception as e:
            print(f'secondary push failed for {repo}:', _redact(str(e)))
            PR_ERRORS.append(f'secondary {repo}: {_redact(str(e))}')


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
