/**
 * What the relay reads from Linux's `/proc` (docs/workspaces.md §5.4 "Auth"
 * step 2): who listens on its ports, which sockets are its own, and the
 * kernel's boot id. Pure parsers over the files' text, so the tests check them
 * with fixtures on any OS; `listenerCheck` reads the live files, and is skipped
 * where there is no `/proc` (the degraded tier on macOS).
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';

/** One listening TCP socket from `/proc/net/tcp` or `tcp6`. */
export interface Listener {
  port: number;
  uid: number;
  inode: number;
}

/** The LISTEN (`st` 0A) entries of a `/proc/net/tcp`/`tcp6` text. */
export function parseListeners(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || f[3] !== '0A') continue;
    const port = Number.parseInt(f[1]!.split(':').at(-1)!, 16);
    const uid = Number.parseInt(f[7]!, 10);
    const inode = Number.parseInt(f[9]!, 10);
    if (Number.isFinite(port) && Number.isFinite(uid) && Number.isFinite(inode)) out.push({ port, uid, inode });
  }
  return out;
}

/** The socket inodes behind a process's fds (`socket:[N]` links in `/proc/<pid>/fd`). */
export function socketInodes(fdLinks: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const link of fdLinks) {
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * Why `ports` are not held only by this process as `uid`, or undefined when
 * they are: every listener on each port must be one of `ours` (this process's
 * sockets) and owned by `uid`, and each port must have one. A model-run
 * listener (`agent` bound on PORT while the relay was down) fails this.
 */
export function listenerProblem(listeners: readonly Listener[], ports: readonly number[], ours: ReadonlySet<number>, uid: number): string | undefined {
  for (const port of ports) {
    const on = listeners.filter((l) => l.port === port);
    if (on.length === 0) return `nothing listens on ${port}`;
    for (const l of on) {
      if (l.uid !== uid) return `port ${port} is held by uid ${l.uid}`;
      if (!ours.has(l.inode)) return `port ${port} is held by another process`;
    }
  }
  return undefined;
}

/** Check the live `/proc` (Linux only; undefined elsewhere): the relay's ports are this process's and its uid's. */
export function listenerCheck(ports: readonly number[]): string | undefined {
  if (!existsSync('/proc/net/tcp')) return undefined;
  const listeners = [...parseListeners(readFileSync('/proc/net/tcp', 'utf8')), ...(existsSync('/proc/net/tcp6') ? parseListeners(readFileSync('/proc/net/tcp6', 'utf8')) : [])];
  const links: string[] = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      links.push(readlinkSync(`/proc/self/fd/${fd}`));
    } catch {}
  }
  return listenerProblem(listeners, ports, socketInodes(links), process.getuid?.() ?? -1);
}

/** An IPv4 address and port as `/proc/net/tcp` writes them (`0100007F:1004`: the address's bytes in host order, little-endian here, then the port), or undefined for another shape. */
function hexEndpoint(field: string): { ip: string; port: number } | undefined {
  const m = /^([0-9A-F]{8}):([0-9A-F]{4})$/i.exec(field);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 16);
  return { ip: [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.'), port: Number.parseInt(m[2]!, 16) };
}

/**
 * The socket inode of a loopback TCP client (`127.0.0.1:<clientPort>`
 * connected to `127.0.0.1:<serverPort>`) in a `/proc/net/tcp` text: the
 * client's own entry, whose local end is the client's port and whose remote
 * end is the server's. Undefined when there is none (or more than one).
 */
export function clientSocketInode(text: string, clientPort: number, serverPort: number): number | undefined {
  const found: number[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = hexEndpoint(f[1]!);
    const remote = hexEndpoint(f[2]!);
    if (!local || !remote || local.ip !== '127.0.0.1' || remote.ip !== '127.0.0.1') continue;
    if (local.port !== clientPort || remote.port !== serverPort) continue;
    const inode = Number.parseInt(f[9]!, 10);
    if (Number.isFinite(inode) && inode > 0) found.push(inode);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Whether the model-port peer check can run here: Linux's `/proc` (the degraded tier on macOS can't tell processes apart). */
export function canCheckPeers(): boolean {
  return existsSync('/proc/net/tcp') && existsSync('/proc/self/fd');
}

/**
 * Whether a process can't be traced by an unprivileged user: it isn't
 * dumpable, so the kernel gives the files under its `/proc/<pid>` to root
 * (its environ, fd and mem then need root, and so do `ptrace` and
 * `pidfd_getfd` on it; the directory itself keeps the process's uid,
 * measured). Meaningful for a process that runs as another uid than root
 * (the agent): Codex, whose binary the base installs execute-only
 * (`base.ts`), so its exec leaves it not dumpable.
 */
export function notDumpable(pid: number): boolean {
  try {
    return statSync(`/proc/${pid}/environ`).uid === 0;
  } catch {
    return false;
  }
}

/**
 * Which of `pids` holds the loopback client socket on `clientPort` connected
 * to `serverPort`, from the live `/proc` (§5.5: the model port admits only the
 * CLI itself, never a descendant: a descendant's socket is in its own fd
 * table, not the CLI's). Undefined when none does, or when it can't be told.
 */
export function peerPid(clientPort: number, serverPort: number, pids: Iterable<number>): number | undefined {
  let text: string;
  try {
    text = readFileSync('/proc/net/tcp', 'utf8');
  } catch {
    return undefined;
  }
  const inode = clientSocketInode(text, clientPort, serverPort);
  if (inode === undefined) return undefined;
  const want = `socket:[${inode}]`;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return pid;
      } catch {}
    }
  }
  return undefined;
}

/**
 * The platform masks `/proc/kcore` and `/proc/keys` with `/dev/null`
 * (bind mounts, as a container runtime does), and a masked `/proc` is one an
 * unprivileged user namespace may not mount afresh: bwrap's `--proc /proc`
 * then fails ("Can't mount proc ... Operation not permitted", P0.10), which
 * Claude Code's own sandbox needs. The mount points of such masks under
 * `/proc`, from a `/proc/self/mountinfo` text (the root unmounts them at
 * relay start; `/proc/kcore` is root-only and `/proc/keys` per user anyway).
 */
export function procMasks(mountinfo: string): string[] {
  const out: string[] = [];
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    // id parent major:minor root mountpoint ...
    if (f.length < 5) continue;
    if ((f[4] === '/proc/kcore' || f[4] === '/proc/keys') && f[3] === '/null') out.push(f[4]);
  }
  return out;
}

/** The kernel's boot id (`/proc/sys/kernel/random/boot_id`), or undefined off Linux. */
export function kernelBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
