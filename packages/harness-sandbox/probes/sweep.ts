// Delete every probe sandbox and Drive left in the linked project: a run the
// Function's maxDuration cut short, or a laptop probe killed mid-way.
//
//   node sweep.ts <scratch-project> [name to keep...]
//
// The project name must match the directory's link (`.vercel/project.json`),
// so a sweep can't run against a project it wasn't meant for. It refuses a
// project that holds any session Drive (a `dh-` name that isn't a probe's),
// takes only `dh-probe-` names, deletes a sandbox only if it carries the
// probes' tag, and reads every page of each list. Names to keep (a probe
// still running elsewhere) can follow the project.
import { readFileSync } from 'node:fs';
import { Drive, Sandbox } from '@vercel/sandbox';
import { SWEEP_PREFIX, describeError, leftovers, listProbes, log, sleep } from './lib.ts';

const [project, ...keepNames] = process.argv.slice(2);
if (!project) throw new Error('usage: node sweep.ts <scratch-project> [name to keep...]');
const link = JSON.parse(readFileSync('.vercel/project.json', 'utf8')) as { projectName?: string };
if (link.projectName !== project) throw new Error(`this directory is linked to ${link.projectName ?? 'an unnamed project'}, not ${project}`);
const sessions = (await (await Drive.list({ namePrefix: 'dh-', sortBy: 'name', limit: 50 })).toArray()).filter((d) => !d.name.startsWith(SWEEP_PREFIX));
if (sessions.length) throw new Error(`${project} holds ${sessions.length} session Drive(s); not a scratch project, nothing deleted`);

const keep = new Set(keepNames);
const { sandboxes, drives } = await listProbes();
log('found', { sandboxes: sandboxes.length, drives: drives.length });
for (const s of sandboxes) {
  if (keep.has(s.name)) continue;
  await Sandbox.get({ name: s.name })
    .then((sb) => sb.delete({ deleteOrphanSnapshots: true }))
    .then(() => log(`deleted.${s.name}`, s.status), (err: unknown) => log(`error.${s.name}`, describeError(err)));
}
// A Drive can be deleted only some seconds after its sandbox detached.
for (const d of drives) {
  if (keep.has(d.name)) continue;
  for (let i = 0; ; i++) {
    try {
      await d.delete();
      log(`deleted.${d.name}`, { tries: i + 1 });
      break;
    } catch (err) {
      const e = describeError(err);
      if (e.status === 404) break;
      if (i === 29) {
        log(`error.${d.name}`, e);
        break;
      }
      await sleep(2000);
    }
  }
}
const left = await leftovers();
log('remaining', left);
process.exit(left.sandboxes.filter((s) => !keep.has(s.split(':')[0]!)).length + left.drives.filter((d) => !keep.has(d)).length ? 1 : 0);
