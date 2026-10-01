# codex CLI driver — appended to core.py. Defines ensure(), agent_env(),
# the run mechanism (cloud task submit → poll → apply), and main().

CODEX_HOME = os.path.join(HOME, '.codex')
ENV_ID = os.environ['CODEX_CLI_ENV_ID']


def agent_env():
    env = os.environ.copy()
    env['HOME'] = HOME
    env['CODEX_HOME'] = CODEX_HOME
    env['CODEX_INSTALL_DIR'] = INSTALL_DIR
    env['PATH'] = INSTALL_DIR + ':' + env.get('PATH', '')
    return scrub_env(env)


def ensure():
    codex_bin = shutil.which('codex') or os.path.join(INSTALL_DIR, 'codex')
    if os.path.exists(codex_bin):
        return codex_bin
    os.makedirs(INSTALL_DIR, exist_ok=True)
    install_url = 'https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh'
    install_script = subprocess.run(['curl', '-fsSL', install_url], check=True, capture_output=True, text=True).stdout
    env = os.environ.copy()
    env['CODEX_NON_INTERACTIVE'] = '1'
    env['CODEX_INSTALL_DIR'] = INSTALL_DIR
    env['CODEX_HOME'] = CODEX_HOME
    subprocess.run(['sh'], input=install_script, env=env, check=True, text=True)
    return codex_bin


def write_codex_home(auth_b64, model):
    os.makedirs(CODEX_HOME, exist_ok=True)
    with open(os.path.join(CODEX_HOME, 'auth.json'), 'wb') as f:
        f.write(base64.b64decode(auth_b64))
    with open(os.path.join(CODEX_HOME, 'config.toml'), 'w') as f:
        f.write(f'model = "{model}"\n')
        f.write('approval_policy = "never"\n')
        f.write('sandbox_mode = "danger-full-access"\n')
        f.write('[shell_environment_policy]\n')
        f.write('inherit = "all"\n')
        f.write('ignore_default_excludes = true\n')


def submit_task(codex_bin):
    prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')
    result = subprocess.run(
        [codex_bin, 'cloud', 'exec', '--env', ENV_ID, '--branch', BRANCH, '-'],
        input=prompt, text=True, env=agent_env(), capture_output=True
    )
    if result.returncode != 0:
        print('codex cloud exec failed:', result.returncode, result.stdout, result.stderr)
        raise RuntimeError(f'codex cloud exec failed: {result.stderr}')
    task_url = result.stdout.strip().splitlines()[-1]
    print('task url:', task_url)
    return task_url


def poll_task(codex_bin, task_url):
    for _ in range(240):  # up to 2 hours
        result = subprocess.run(
            [codex_bin, 'cloud', 'list', '--json', '--env', ENV_ID],
            env=agent_env(), capture_output=True, text=True
        )
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                for task in data.get('tasks', []):
                    if task.get('url') == task_url:
                        status = task.get('status')
                        print('task status:', status)
                        if status in ('ready', 'applied'):
                            return task
                        if status == 'error':
                            raise RuntimeError(f'Codex Cloud task failed: {task}')
            except Exception as e:
                print('poll parse error:', e)
        time.sleep(30)
    raise RuntimeError('Codex Cloud task did not finish in time')


def apply_and_push(codex_bin, task_url):
    env = agent_env()
    result = run([codex_bin, 'cloud', 'apply', task_url], cwd=REPO_DIR, env=env, check=False)
    if result.returncode != 0:
        print('codex cloud apply failed:', result.returncode, result.stdout, result.stderr)
        return False
    status = run(['git', '-C', REPO_DIR, 'status', '--porcelain'], env=env, capture_output=True, text=True, check=True)
    if not status.stdout.strip():
        print('no changes to commit')
        return False
    run(['git', '-C', REPO_DIR, 'add', '-A'], env=env, check=True)
    run(['git', '-C', REPO_DIR, 'commit', '-m', f'{AGENT_LABEL} changes for {BRANCH}'], env=env, check=True)
    run_transport(['git', '-C', REPO_DIR, 'push', 'origin', BRANCH], env=env)
    return True


def main():
    # Cloud tasks run in OpenAI's environment with its own git credentials;
    # Pile refuses the dispatch below enabled, this is the runner backstop.
    if PUSH_POLICY != 'enabled' or SHELL_POLICY != 'enabled':
        raise RuntimeError(f'codex cloud cannot enforce lane permissions push={PUSH_POLICY} shell={SHELL_POLICY}')
    auth_b64 = os.environ['CODEX_AUTH_JSON_B64']
    model = os.environ.get('MODEL', 'gpt-reserve')
    write_codex_home(auth_b64, model)
    codex_bin = ensure()
    create_branch()
    clone_repo()
    task_url = submit_task(codex_bin)
    task = poll_task(codex_bin, task_url)
    applied = apply_and_push(codex_bin, task_url)
    pr_url = ''
    if applied:
        pr_url = find_pr() or create_pr()
    summary = task.get('summary', {}) if isinstance(task.get('summary'), dict) else {}
    result_text = json.dumps({'status': task.get('status'), 'files_changed': summary.get('files_changed', 0), 'lines_added': summary.get('lines_added', 0), 'lines_removed': summary.get('lines_removed', 0), 'transcript': read_transcript()})
    write_result('completed' if task.get('status') in ('ready', 'applied') else 'failed', pr_url, result_text)
    stop_log_ship()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        fail_result(e)
        stop_log_ship()
        sys.exit(1)
