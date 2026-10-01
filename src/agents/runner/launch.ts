// Sandbox process command that materializes and starts the lane runner.
// `exec` replaces the wrapper shell: otherwise it lingers as the runner's
// parent with the runner secrets in its /proc/<pid>/environ.
export const RUNNER_LAUNCH_COMMAND =
  "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && exec python3 /tmp/run.py";
