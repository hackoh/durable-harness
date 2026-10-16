// Probe: connect to codex app-server over the sandbox's public port, run
// initialize + thread/start + fs/readFile, then time a few RPCs. The token is
// an argument (from the environment of the shell that ran start-app-server.sh's
// recipe); it is never printed.
//   node ws-client.mjs wss://<sandbox domain for 4500> "$T"
const [url, token] = process.argv.slice(2);
const t0 = Date.now();
const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
let id = 0;
const pending = new Map();
const req = (method, params) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onerror = (e) => { console.log('error', e.message ?? e.type); };
ws.onclose = (e) => { console.log('closed', e.code, e.reason); process.exit(0); };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id != null && msg.method == null) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.fail(msg.error) : p.ok(msg.result); }
  else if (msg.id != null) { console.log('server request', msg.method); ws.send(JSON.stringify({ id: msg.id, result: {} })); }
  else console.log('notification', msg.method, JSON.stringify(msg.params).slice(0, 400));
};
ws.onopen = async () => {
  console.log('open after', Date.now() - t0, 'ms');
  try {
    const init = await req('initialize', { clientInfo: { name: 'probe', version: '0', title: null }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    console.log('initialize', JSON.stringify(init).slice(0, 300));
    const t1 = Date.now();
    const started = await req('thread/start', { model: 'openai/gpt-5.4-mini', cwd: '/tmp/w', approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      dynamicTools: [{ type: 'function', name: 'lookup', description: 'x', inputSchema: { type: 'object', properties: {} } }] });
    console.log('thread/start', Date.now() - t1, 'ms', started.thread.id, started.thread.path);
    const t2 = Date.now();
    const file = await req('fs/readFile', { path: started.thread.path }).catch((e) => ({ error: e }));
    console.log('fs/readFile', Date.now() - t2, 'ms', file.error ? JSON.stringify(file.error) : Buffer.from(file.dataBase64, 'base64').toString('utf8').slice(0, 200));
    const w = await req('fs/watch', { watchId: 'r', path: started.thread.path }).catch((e) => ({ error: e }));
    console.log('fs/watch', JSON.stringify(w).slice(0, 200));
    const rtt = []; for (let i = 0; i < 5; i++) { const s = Date.now(); await req('fs/getMetadata', { path: '/tmp/w' }).catch(() => {}); rtt.push(Date.now() - s); }
    console.log('rpc rtt ms', rtt.join(','));
  } catch (err) { console.log('rpc error', JSON.stringify(err)); }
  ws.close();
};
