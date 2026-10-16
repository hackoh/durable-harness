import { type Doc, type DocsIO, type HostTool, type HostToolIO, namedDocs } from 'harness-world';
import { docUpdateValue, readDocSpec, readDocText, updatedDocText, updateDocSpec } from './doc-tool-specs.ts';

/**
 * Example tools that show documents to a model: for each document, a
 * `read_<name>` and an `update_<name>`. Documents are not exposed to the
 * model by default (code reads them); these are how an app opts one in, and
 * how a process harness (Claude Code, Codex, OpenCode), whose own tools never
 * see documents, reads and writes one.
 *
 * ```ts
 * const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) })
 * claudeCode({ model, tools: docTools([Todos]) })   // read_todos, update_todos
 * ```
 *
 * A name is the record's key when given a record, else the kind's last dot
 * segment (`app.todos` → `todos`). The model sends whole values (simple for
 * models); the log still stores a small edit, because the kernel diffs. The
 * value's input type is the definition's `schema` (give one: TypeBox works);
 * without it the model sends the value as JSON text, since strict tool
 * calling turns an open object into an empty one. An
 * update commits with the call's outcome (`io.docs`), so a crash or a throw
 * changes nothing. Both are `replay: 'safe'`: writing the same value twice is
 * writing it once.
 */
export function docTools(docs: readonly Doc<any>[] | Readonly<Record<string, Doc<any>>>): HostTool[] {
  return namedDocs(docs).flatMap(([name, doc]) => {
    if (!/^[A-Za-z0-9_-]{1,57}$/.test(name)) {
      throw new TypeError(`harness-world-hands: docTools: ${JSON.stringify(name)} cannot name a tool (letters, digits, _ and -, at most 57 characters)`);
    }
    return [readTool(name, doc), updateTool(name, doc)];
  });
}

function docsOf(io: HostToolIO): DocsIO {
  if (!io.docs) {
    throw new Error("harness-world-hands: docTools need the kernel's io.docs, and this harness adapter does not pass it to its tools (pass the effect's io through, e.g. with hostToolIO)");
  }
  return io.docs;
}

function readTool(name: string, doc: Doc<any>): HostTool<Record<string, never>> {
  return {
    ...readDocSpec(name, doc.definition.kind),
    replay: 'safe',
    async execute(_input, io) {
      const snap = docsOf(io).read(doc);
      return readDocText(snap.revision, snap.value);
    },
  };
}

function updateTool(name: string, doc: Doc<any>): HostTool<{ value: unknown; expectRevision?: unknown }> {
  const { kind, schema } = doc.definition;
  return {
    ...updateDocSpec(name, kind, schema),
    replay: 'safe',
    async execute(input, io) {
      const docs = docsOf(io);
      const next = docUpdateValue(name, input, docs.read(doc).revision);
      docs.update(doc, () => next);
      return updatedDocText(name);
    },
  };
}
