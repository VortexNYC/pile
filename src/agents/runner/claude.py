# Claude Code driver — appended to core.py. Defines ensure(), agent_env(),
# the run mechanism (stream-json parse), and main().

CLAUDE_HOME = os.path.join(HOME, '.claude')


def agent_env():
    env = os.environ.copy()
    env['HOME'] = HOME
    env['PATH'] = INSTALL_DIR + ':' + env.get('PATH', '')
    # Sandbox runs as root; Claude Code only allows skip-permissions there
    # when told it is sandboxed.
    env['IS_SANDBOX'] = '1'
    env['DISABLE_AUTOUPDATER'] = '1'
    env.pop('CLAUDE_CREDENTIALS_JSON_B64', None)
    return env


def write_claude_credentials():
    creds_b64 = os.environ.get('CLAUDE_CREDENTIALS_JSON_B64', '')
    if not creds_b64:
        return
    os.makedirs(CLAUDE_HOME, exist_ok=True)
    path = os.path.join(CLAUDE_HOME, '.credentials.json')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(creds_b64))
    os.chmod(path, 0o600)


def ensure():
    on_path = shutil.which('claude')
    if on_path:
        return on_path
    candidate = os.path.join(INSTALL_DIR, 'claude')
    if os.path.exists(candidate):
        return candidate
    subprocess.run(['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'], check=False)
    if os.path.exists(candidate):
        result = subprocess.run([candidate, '--version'], capture_output=True, text=True)
        print('claude version:', result.stdout.strip(), result.stderr.strip())
        return candidate
    raise RuntimeError('claude install failed: binary not found in ~/.local/bin')


def _render_event(evt):
    # Render one Claude Code stream-json event as a readable log line.
    if evt.get('type') != 'assistant':
        return None
    lines = []
    for part in (evt.get('message') or {}).get('content') or []:
        if not isinstance(part, dict):
            continue
        if part.get('type') == 'text' and part.get('text'):
            lines.append(part['text'].rstrip())
        elif part.get('type') == 'tool_use':
            a = part.get('input') or {}
            target = a.get('file_path') or a.get('command') or a.get('pattern') or a.get('path') or ''
            lines.append(f"→ {part.get('name', 'tool')}({target})")
    return '\n'.join(lines) or None


def run_agent(agent_bin):
    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    model = os.environ.get('MODEL', '')
    cmd = [agent_bin, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
    if model:
        cmd += ['--model', model]
    proc = subprocess.Popen(
        cmd, cwd=REPO_DIR if REPO else HOME, env=agent_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    tail = []
    last_text = ''
    result_error = None
    events = open('/tmp/agent-events.ndjson', 'a', buffering=1)
    try:
        for line in proc.stdout:
            events.write(line)
            tail.append(line)
            try:
                evt = json.loads(line)
            except ValueError:
                print(_redact(line), end='')
                continue
            if not isinstance(evt, dict):
                continue
            if evt.get('type') == 'result':
                if isinstance(evt.get('result'), str) and evt['result'].strip():
                    last_text = evt['result']
                if evt.get('is_error'):
                    result_error = evt.get('result') or evt.get('subtype') or 'error'
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
    print('claude exit:', proc.returncode)
    if proc.returncode != 0 or result_error:
        detail = result_error or output[-500:]
        raise RuntimeError(f'claude -p failed ({proc.returncode}): {_redact(str(detail))}')
    return output, last_text


def main():
    agent_bin = ensure()
    write_claude_credentials()
    if REPO:
        create_branch()
        clone_repo()
        warm_pnpm_store()
    output, report = run_agent(agent_bin)
    pushed = commit_and_push(agent_env()) if REPO else False
    rc = finalize(output, pushed, report=report)
    save_pnpm_store()
    stop_log_ship()
    return rc


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        fail_result(e)
        save_pnpm_store()
        stop_log_ship()
        sys.exit(1)
