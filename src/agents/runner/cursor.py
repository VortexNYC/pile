# cursor-agent driver — appended to core.py. Defines ensure(), agent_env(),
# the run mechanism (stream-json parse), and main().

CURSOR_HOME = os.path.join(HOME, '.local', 'share', 'cursor-agent')


def agent_env():
    # cursor-agent authenticates from CURSOR_API_KEY itself; the shells it
    # spawns still lose it (BASH_ENV unset rc).
    return lane_env(keep=('CURSOR_API_KEY',))


def ensure():
    on_path = shutil.which('cursor-agent') or shutil.which('agent')
    if on_path:
        return on_path
    for name in ('cursor-agent', 'agent'):
        candidate = os.path.join(INSTALL_DIR, name)
        if os.path.exists(candidate):
            return candidate
    subprocess.run(['bash', '-c', 'curl https://cursor.com/install -fsS | bash'], check=False)
    for name in ('cursor-agent', 'agent'):
        candidate = os.path.join(INSTALL_DIR, name)
        if os.path.exists(candidate):
            result = subprocess.run([candidate, '--version'], capture_output=True, text=True)
            print('cursor version:', result.stdout.strip(), result.stderr.strip())
            return candidate
    raise RuntimeError('cursor-agent install failed: binary not found in ~/.local/bin')


def _render_event(evt):
    # Render one cursor-agent stream-json event as a readable log line.
    t = evt.get('type')
    if t == 'assistant':
        for part in (evt.get('message') or {}).get('content') or []:
            if part.get('type') == 'text' and part.get('text'):
                return part['text'].rstrip()
        return None
    if t == 'tool_call':
        if evt.get('subtype') != 'started':
            return None
        call = evt.get('tool_call') or {}
        name = next(iter(call), 'tool')
        args = call.get(name) or {}
        a = args.get('args') or {}
        target = a.get('path') or a.get('command') or a.get('cmd') or a.get('pattern') or ''
        return f'→ {name}({target})'
    if t in ('result', 'user', 'thinking', 'system'):
        return None
    return None


def run_agent(agent_bin):
    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    model = os.environ.get('MODEL', '')
    cmd = [agent_bin, '-p', prompt, '--force', '--trust', '--output-format', 'stream-json']
    if model:
        cmd += ['--model', model]
    proc = subprocess.Popen(
        cmd, cwd=REPO_DIR if REPO else HOME, env=agent_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    tail = []
    last_text = ''
    events = open('/tmp/agent-events.ndjson', 'a', buffering=1)
    try:
        for line in proc.stdout:
            events.write(_redact(line))
            tail.append(line)
            try:
                evt = json.loads(line)
            except ValueError:
                print(_redact(line), end='')
                continue
            if evt.get('type') == 'assistant':
                _c = (evt.get('message') or {}).get('content') or []
                _t = ''.join(b.get('text', '') for b in _c if isinstance(b, dict))
                if _t.strip():
                    last_text = _t
            rendered = _render_event(evt)
            if rendered:
                print(_redact(rendered))
        proc.wait(timeout=7200)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise
    finally:
        events.close()
    output = ''.join(tail)[-4000:]
    print('cursor-agent exit:', proc.returncode)
    if proc.returncode != 0:
        raise RuntimeError(f'cursor-agent -p failed ({proc.returncode}): {_redact(output[-500:])}')
    return output, last_text


def main():
    agent_bin = ensure()
    if REPO:
        create_branch()
        clone_repo()
        warm_pnpm_store()
    output, report = run_agent(agent_bin)
    pushed = commit_and_push(agent_env()) if REPO else False
    rc = finalize(output, pushed, report=report)
    revoke_github_token()
    save_pnpm_store()
    stop_log_ship()
    return rc


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        fail_result(e)
        revoke_github_token()
        save_pnpm_store()
        stop_log_ship()
        sys.exit(1)
