/**
 * A helper that breaks the relay's pipe rules on request (`RelayConfig.testHelperEntry`,
 * the stand-in only): `exec` with one of the commands below misbehaves in
 * that way; `pid` answers honestly with this process's pid, so a test can
 * tell a fresh helper from the old one. Plain JavaScript, no imports from the
 * package: it speaks the `HELPER` framing (`src/relay/protocol.ts`) by hand.
 */
const CALL = 1;
const DATA = 3;
const RESULT = 4;

function frameOf(type, id, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(9 + payload.length);
  out.writeUInt32BE(5 + payload.length, 0);
  out[4] = type;
  out.writeUInt32BE(id, 5);
  payload.copy(out, 9);
  return out;
}
const send = (type, id, payload) => process.stdout.write(frameOf(type, id, payload));
const result = (id, value) => send(RESULT, id, Buffer.from(JSON.stringify(value)));

const modes = {
  pid(id) {
    const out = Buffer.from(String(process.pid));
    send(DATA, id, out);
    result(id, { ok: true, value: { exitCode: 0, stdoutBytes: out.length, stderrBytes: 0 }, data: 'bytes' });
  },
  garbage() {
    process.stdout.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
  },
  'big-data'(id) {
    send(DATA, id, Buffer.alloc((512 << 10) + 1));
  },
  'over-limit'(id) {
    for (let i = 0; i < 41; i++) send(DATA, id, Buffer.alloc(512 << 10));
  },
  'unknown-hid'(id) {
    result(id + 1000, { ok: true });
  },
  'big-result'(id) {
    result(id, { ok: true, value: 'x'.repeat(70 << 10) });
  },
  'bad-type'(id) {
    send(9, id);
  },
  'bad-code'(id) {
    result(id, { ok: false, error: { code: 'nope', message: 'a code that is not POSIX-like' } });
  },
  'long-message'(id) {
    result(id, { ok: false, error: { code: 'EIO', message: 'm'.repeat(600) } });
  },
  'stray-bytes'(id) {
    send(DATA, id, Buffer.from('stray'));
    result(id, { ok: true });
  },
  'bad-kind'(id) {
    result(id, { ok: true, data: 'xml' });
  },
  silent() {},
};

let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) return;
    const type = buf[4];
    const id = buf.readUInt32BE(5);
    const payload = buf.subarray(9, 4 + len);
    buf = buf.subarray(4 + len);
    if (type !== CALL) continue;
    const jsonLen = payload.readUInt32BE(0);
    const header = JSON.parse(payload.subarray(4, 4 + jsonLen).toString('utf8'));
    const mode = modes[header.op === 'exec' ? header.args[0] : ''];
    if (mode) mode(id);
    else result(id, { ok: false, error: { code: 'ENOSYS', message: `the hostile helper has no ${header.op}` } });
  }
});
process.stdin.on('end', () => process.exit(0));
