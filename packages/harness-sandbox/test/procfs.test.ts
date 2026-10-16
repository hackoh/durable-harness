/**
 * The relay's `/proc` readers (docs/workspaces.md §5.4 "Auth" step 2), on
 * fixtures: a non-root listener, or another process's, on the relay's port is
 * refused at arm.
 */
import { describe, expect, it } from 'vitest';
import { clientSocketInode, listenerProblem, parseListeners, procMasks, socketInodes } from '../src/relay/procfs.ts';

// Two listeners (port 0x07DA = 2010 by uid 0, inode 111; 0x1004 = 4100 by uid 0, inode 222) and one established connection.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:07DA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1004 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1004 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 333 1 0000000000000000 20 4 30 10 -1
`;
// An agent (uid 1001) listener on 2010 over IPv6.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:07DA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 444 1 0000000000000000 100 0 0 10 0
`;

describe('the listener check at arm', () => {
  it('parses LISTEN entries only', () => {
    expect(parseListeners(TCP)).toEqual([
      { port: 2010, uid: 0, inode: 111 },
      { port: 4100, uid: 0, inode: 222 },
    ]);
  });

  it("passes when both ports are the relay's own sockets, as root", () => {
    expect(listenerProblem(parseListeners(TCP), [2010, 4100], socketInodes(['socket:[111]', 'socket:[222]', 'pipe:[9]']), 0)).toBeUndefined();
  });

  it('refuses a non-root listener on the port', () => {
    const all = [...parseListeners(TCP), ...parseListeners(TCP6)];
    expect(listenerProblem(all, [2010, 4100], socketInodes(['socket:[111]', 'socket:[222]', 'socket:[444]']), 0)).toMatch(/uid 1001/);
  });

  it("refuses a root listener that is not the relay's", () => {
    expect(listenerProblem(parseListeners(TCP), [2010, 4100], socketInodes(['socket:[222]']), 0)).toMatch(/another process/);
  });

  it('refuses when nothing listens', () => {
    expect(listenerProblem(parseListeners(TCP), [2010, 9999], socketInodes(['socket:[111]']), 0)).toMatch(/nothing listens on 9999/);
  });
});

// The model port's client side: the CLI's connection from 127.0.0.1:50000 (0xC350) to 4100 (0x1004), inode 555, and the server's end of it (inode 333).
const CONNECTED = `${TCP}   3: 0100007F:C350 0100007F:1004 01 00000000:00000000 00:00000000 00000000  1001        0 555 1 0000000000000000 20 4 30 10 -1
`;

describe('the model port peer check (§5.5)', () => {
  it("finds the client's own socket inode, not the server's end of the connection", () => {
    expect(clientSocketInode(CONNECTED, 50000, 4100)).toBe(555);
    expect(clientSocketInode(CONNECTED, 50001, 4100)).toBeUndefined();
    expect(clientSocketInode(TCP, 50000, 4100)).toBeUndefined();
  });

  it('ignores a connection that is not loopback to loopback', () => {
    const remote = CONNECTED.replace('3: 0100007F:C350 0100007F:1004', '3: 0A00000A:C350 0100007F:1004');
    expect(clientSocketInode(remote, 50000, 4100)).toBeUndefined();
  });
});

describe("the platform's /proc masks (P0.10)", () => {
  it('names /proc/kcore and /proc/keys when /dev/null covers them, nothing else', () => {
    const info = [
      '22 1 0:21 / /proc rw,relatime - proc proc rw',
      '23 22 0:5 /null /proc/kcore ro,relatime - devtmpfs devtmpfs ro',
      '24 22 0:5 /null /proc/keys ro,relatime - devtmpfs devtmpfs ro',
      '25 22 0:5 /null /proc/sysrq-trigger ro,relatime - devtmpfs devtmpfs ro',
      '26 1 0:22 / /sys rw,relatime - sysfs sysfs rw',
    ].join('\n');
    expect(procMasks(info)).toEqual(['/proc/kcore', '/proc/keys']);
    expect(procMasks('22 1 0:21 / /proc rw,relatime - proc proc rw')).toEqual([]);
  });
});
