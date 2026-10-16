import type { SandboxJob, SandboxReport } from './sandbox-sync.ts';

/**
 * A detached `sandbox_exec`: the command runs in the VM under a small
 * wrapper that outlives any function. The function writes a job directory
 * (in the same `writeFiles` call as the workspace sync), starts the wrapper
 * detached, and stops. When the command exits the wrapper writes
 * `result.json` there and, when a callback is configured, POSTs it to the app
 * with a capability token for this one step. The result is always readable
 * from the VM too, so a lost report is collected by polling.
 */

/** Where jobs live in the VM. The wrapper keeps the last 20. */
export const JOB_ROOT = '/tmp/harness';
export const jobDirFor = (stepId: string) => `${JOB_ROOT}/${stepId}`;

/** Head and tail kept per stream in `result.json` (the body stays under 64 KiB). */
export const REPORT_CLIP_CHARS = 8000;
export const MAX_REPORT_BYTES = 64 * 1024;

/** Extra seconds the Sandbox API's own hard stop gives a wrapper past its command's budget. */
const HARD_STOP_SLACK_S = 120;

export const hardStopMs = (timeoutSeconds: number) => (timeoutSeconds + HARD_STOP_SLACK_S) * 1000;

/**
 * The wrapper. `setsid` puts the command in a process group of its own
 * (its pid is the group id, recorded in `child.pid`), so a kill reaches
 * everything it started while the wrapper survives to report the exit code.
 * `timeout` enforces the command's own budget: exit 124, or 137 after the
 * grace kill.
 */
export const WRAPPER = `#!/usr/bin/env bash
# harness sandbox_exec wrapper v1. args: <jobdir> <timeoutSeconds>
set -u; D="$1"; T="$2"
: > "$D/stdout"; : > "$D/stderr"
[ -f "$D/report.env" ] && chmod 600 "$D/report.env"
# keep the last 20 job dirs only
ls -1dt ${JOB_ROOT}/*/ 2>/dev/null | tail -n +21 | xargs -r rm -rf
# The sandbox lane's daemon runs commands as another user in the same VM: take the workspace back.
[ "$(stat -c %U /workspace 2>/dev/null)" = "$(id -un)" ] || sudo -n chown -R "$(id -u):$(id -g)" /workspace 2>/dev/null || true
cd /workspace 2>/dev/null || cd /
setsid timeout --kill-after=5s "\${T}s" bash -l "$D/cmd" > "$D/stdout" 2> "$D/stderr" < /dev/null &
child=$!; echo "$child" > "$D/child.pid"
trap 'kill -TERM -- "-$child" 2>/dev/null' TERM INT
wait "$child"; code=$?
python3 - "$D" "$code" <<'PY'
import json,os,stat,sys,time
d,code=sys.argv[1],int(sys.argv[2]); H=${REPORT_CLIP_CHARS}
def clip(p):
  # Only the head and tail, and only of a regular file: the command can
  # swap its output for a huge file, a symlink to /dev/zero, or a FIFO.
  try:
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  except OSError:
    return {"bytes":0,"head":"","tail":""}
  try:
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode): return {"bytes":0,"head":"","tail":""}
    n=st.st_size; B=H*4; head=os.read(fd,B)
    tail=b''
    if n>B:
      os.lseek(fd,max(B,n-B),os.SEEK_SET); tail=os.read(fd,B)
  finally:
    os.close(fd)
  if tail:
    ht=head.decode('utf-8','replace')[:H]; tt=tail.decode('utf-8','replace')[-H:]
  else:
    # The whole file is in hand: head, then whatever follows it (up to H).
    t=head.decode('utf-8','replace'); ht=t[:H]; tt=t[max(H,len(t)-H):] if len(t)>H else ""
  return {"bytes":n,"head":ht,"tail":tt}
r={"v":1,"exitCode":code,"timedOut":code==124,"stdout":clip(d+"/stdout"),"stderr":clip(d+"/stderr"),"endedAt":int(time.time()*1000)}
open(d+"/result.json.tmp","w").write(json.dumps(r)); os.replace(d+"/result.json.tmp",d+"/result.json")
PY
if [ -f "$D/report.env" ]; then . "$D/report.env"
  for i in 1 2 3 4 5 6 7 8; do
    s=$(curl -sS --max-time 30 -o "$D/report.out" -w '%{http_code}' -X POST \\
        -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
        --data-binary @"$D/result.json" "$URL" 2>>"$D/report.err" || echo 000)
    echo "$s" >> "$D/reported"
    case "$s" in 2*|400|401|403|404|410|413) break;; esac   # retry only 409/429/5xx/000
    sleep $(( i < 4 ? i : 4 ))
  done
fi
exit "$code"
`;

/** `baseline.json`'s exact content (its sha256 goes in the park, so a collector can check what it reads back). */
export const baselineText = (baseline: Map<string, string>) => JSON.stringify(Object.fromEntries(baseline));

/** The job directory's files, written with the workspace sync. */
export function jobFiles(job: SandboxJob, baseline: Map<string, string>): { path: string; content: string }[] {
  const dir = jobDirFor(job.stepId);
  const files = [
    { path: `${dir}/run.sh`, content: WRAPPER },
    { path: `${dir}/cmd`, content: `${job.command}\n` },
    {
      path: `${dir}/job.json`,
      content: JSON.stringify({ v: 1, runId: job.runId, stepId: job.stepId, key: job.key, timeoutSeconds: job.timeoutSeconds, startedAt: job.startedAt }),
    },
    { path: `${dir}/baseline.json`, content: baselineText(baseline) },
  ];
  if (job.report) {
    files.push({ path: `${dir}/report.env`, content: `URL=${shellQuote(job.report.url)}\nTOKEN=${shellQuote(job.report.token)}\n` });
  }
  return files;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Parse and check a report (the wrapper's `result.json`, or a push body). */
export function parseReport(value: unknown): SandboxReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Partial<SandboxReport>;
  const stream = (x: unknown) =>
    !!x &&
    typeof x === 'object' &&
    typeof (x as { bytes?: unknown }).bytes === 'number' &&
    typeof (x as { head?: unknown }).head === 'string' &&
    typeof (x as { tail?: unknown }).tail === 'string';
  if (r.v !== 1 || typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode)) return undefined;
  if (!stream(r.stdout) || !stream(r.stderr)) return undefined;
  return r as SandboxReport;
}

/** What follows a stream's head: the last `REPORT_CLIP_CHARS`, never overlapping the head (so nothing between them is dropped silently). */
export const clipTail = (t: string) =>
  t.length > REPORT_CLIP_CHARS ? t.slice(Math.max(REPORT_CLIP_CHARS, t.length - REPORT_CLIP_CHARS)) : '';

/** A report built from raw output (a wrapper killed before it wrote `result.json`). */
export function reportFromOutput(exitCode: number, stdout: string, stderr: string): SandboxReport {
  const clip = (t: string) => ({
    bytes: new TextEncoder().encode(t).byteLength,
    head: t.slice(0, REPORT_CLIP_CHARS),
    tail: clipTail(t),
  });
  return { v: 1, exitCode, timedOut: exitCode === 124, stdout: clip(stdout), stderr: clip(stderr) };
}

/** A clipped stream back as text, marking what the report left out. */
export function streamText(s: SandboxReport['stdout']): string {
  if (!s.tail) return s.head;
  const elided = Math.max(0, s.bytes - new TextEncoder().encode(s.head + s.tail).byteLength);
  if (elided === 0) return s.head + s.tail;
  return `${s.head}\n… [${elided} bytes elided] …\n${s.tail}`;
}
