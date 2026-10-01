# devin CLI driver — appended to core.py. Defines ensure(), agent_env(),
# the run mechanism (interactive process with a mid-run follow-up channel),
# and main() including the FOLLOWUP resume path.

DEVIN_HOME = os.path.join(HOME, '.local', 'share', 'devin')
FOLLOWUP_DIR = '/tmp/followups'


def agent_env():
    env = os.environ.copy()
    env['HOME'] = HOME
    env['PATH'] = INSTALL_DIR + ':' + env.get('PATH', '')
    return env


def ensure():
    devin_bin = shutil.which('devin') or os.path.join(INSTALL_DIR, 'devin')
    if not os.path.exists(devin_bin):
        subprocess.run(['bash', '-c', 'curl -fsSL https://cli.devin.ai/install.sh | bash'], check=False)
    # installer exits non-zero when its interactive wizard bails without a TTY; verify the binary directly
    result = subprocess.run([devin_bin, '--version'], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'devin install failed: {result.stdout} {result.stderr}')
    print('devin version:', result.stdout.strip())
    return devin_bin


def write_devin_home(creds_b64):
    os.makedirs(DEVIN_HOME, exist_ok=True)
    creds_path = os.path.join(DEVIN_HOME, 'credentials.toml')
    with open(creds_path, 'wb') as f:
        f.write(base64.b64decode(creds_b64))
    os.chmod(creds_path, 0o600)


def inject_followups(proc):
    # Mid-run prompt channel: sendPrompt drops files in FOLLOWUP_DIR via a
    # sandbox writeFile RPC; we feed them into the live devin process's
    # stdin. Injected files get an .injected marker — if devin didn't
    # actually consume stdin, the post-run drain still re-runs only files
    # that were never injected.
    while proc.poll() is None:
        try:
            os.makedirs(FOLLOWUP_DIR, exist_ok=True)
            for name in sorted(os.listdir(FOLLOWUP_DIR)):
                if not name.endswith('.prompt'):
                    continue
                path = os.path.join(FOLLOWUP_DIR, name)
                with open(path) as f:
                    text = f.read()
                proc.stdin.write(text.rstrip() + '\n')
                proc.stdin.flush()
                os.rename(path, path[:-7] + '.injected')
                print('follow-up prompt injected mid-run:', name)
        except (BrokenPipeError, OSError):
            return
        time.sleep(2)


def run_agent(devin_bin, prompt=None):
    prompt = prompt or base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    model = os.environ.get('MODEL', 'swe-2')
    proc = subprocess.Popen(
        [devin_bin, '-p', prompt, '--model', model, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'],
        cwd=REPO_DIR, env=agent_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE, text=True
    )
    threading.Thread(target=inject_followups, args=(proc,), daemon=True).start()
    tail = []
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            tail.append(line)
        proc.wait(timeout=7200)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise
    output = ''.join(tail)[-4000:]
    print('devin exit:', proc.returncode)
    if proc.returncode != 0:
        raise RuntimeError(f'devin -p failed ({proc.returncode}): {output[-500:]}')
    return output


def drain_followups(devin_bin):
    # Prompts that arrived while devin ran but were never consumed through
    # stdin get a proper continuation run on the same checkout. Bounded so
    # a caller can't keep a lane alive forever by spamming prompts.
    output = ''
    for _ in range(3):
        pending = sorted(n for n in os.listdir(FOLLOWUP_DIR) if n.endswith('.prompt'))
        if not pending:
            return output
        name = pending[0]
        path = os.path.join(FOLLOWUP_DIR, name)
        with open(path) as f:
            text = f.read()
        os.rename(path, path[:-7] + '.drained')
        print('running queued follow-up prompt:', name)
        output = run_turn(devin_bin, prompt=text)
        commit_and_push(agent_env())
    return output


def run_turn(devin_bin, prompt=None):
    # One agent turn, gated by the repo's stop hook: a failing hook resumes
    # devin with the failure before anything is pushed.
    task = prompt or base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    output = run_agent(devin_bin, prompt=prompt)
    healed = self_heal(agent_env(), lambda p: run_agent(devin_bin, prompt=p), task)
    return output if healed is None else healed


def main():
    os.makedirs(FOLLOWUP_DIR, exist_ok=True)
    creds_b64 = os.environ['DEVIN_CREDENTIALS_B64']
    write_devin_home(creds_b64)
    devin_bin = ensure()
    if os.environ.get('FOLLOWUP') == '1':
        # Resume path: sandbox was kept after the prior run. Drop the stale
        # result file so a mid-run poll can't serve the previous outcome.
        try:
            os.remove(RESULT_FILE)
        except OSError:
            pass
        ensure_postgres()
        if REPO:
            resume_repo()
            run_hook('postCheckout', agent_env())
        else:
            os.makedirs(REPO_DIR, exist_ok=True)
        output = run_turn(devin_bin)
        output = drain_followups(devin_bin) or output
        pushed = commit_and_push(agent_env()) if REPO else False
        return finalize(output, pushed)
    if not REPO:
        # Repo-less lane — research/docs/design work. The agent runs in an
        # empty workdir; its result text is the deliverable, no git surface.
        os.makedirs(REPO_DIR, exist_ok=True)
        ensure_postgres()
        output = run_agent(devin_bin)
        output = drain_followups(devin_bin) or output
        return finalize(output, False)
    create_branch()
    clone_repo()
    run_hook('postCheckout', agent_env())
    run_setup_hook(agent_env)
    ensure_postgres()
    output = run_turn(devin_bin)
    output = drain_followups(devin_bin) or output
    pushed = commit_and_push(agent_env())
    return finalize(output, pushed)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        fail_result(e)
        sys.exit(1)
