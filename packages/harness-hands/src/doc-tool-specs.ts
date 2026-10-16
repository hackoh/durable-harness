/**
 * What a document's two tools say to a model (`read_<name>`, `update_<name>`)
 * and how an update reads its input: one place for `docTools` (on the
 * kernel's `io.docs`) and the native baseline (on state it carries), so both
 * advertise the same tools. No imports: the native route loads none of the
 * kernel.
 */

export interface DocToolSpec {
  name: string;
  label: string;
  description: string;
  inputSchema: object;
}

export function readDocSpec(name: string, kind: string): DocToolSpec {
  return {
    name: `read_${name}`,
    label: `Read ${name}`,
    description: `Read the session's "${name}" document (${kind}): JSON state the app keeps with this conversation. Returns {"revision": n, "value": ...}. Pass the revision to update_${name} as expectRevision.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export function updateDocSpec(name: string, kind: string, schema?: object): DocToolSpec {
  return {
    name: `update_${name}`,
    label: `Update ${name}`,
    description: `Replace the session's "${name}" document (${kind}) with a new value. Send the whole value, not a change. Read it first with read_${name}, and pass its revision as expectRevision: the update then fails instead of overwriting a change made since.`,
    inputSchema: {
      type: 'object',
      properties: {
        // Without a schema the value is JSON text: an open `{ type: 'object' }`
        // is read as "no properties" by strict tool calling (Codex sent `{}`).
        value: schema ?? { type: 'string', description: `The whole new value of ${name}, as the JSON text of an object.` },
        expectRevision: { type: 'integer', minimum: 0, description: `The revision read_${name} returned. The update fails if the document changed since.` },
      },
      required: ['value'],
      additionalProperties: false,
    },
  };
}

/** The read tool's result text. */
export const readDocText = (revision: number, value: unknown) => JSON.stringify({ revision, value });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * An update's input, checked: the revision it expects against the current
 * one (a model may send it as text), and the value as an object (some
 * models send a nested object as JSON text). Throws what the model reads.
 */
export function docUpdateValue(name: string, input: { value: unknown; expectRevision?: unknown }, currentRevision: number): object {
  const expected = typeof input.expectRevision === 'string' && /^\d+$/.test(input.expectRevision) ? Number(input.expectRevision) : input.expectRevision;
  if (expected !== undefined && expected !== null && expected !== currentRevision) {
    throw new Error(`${name} changed since revision ${String(expected)} (now ${currentRevision}): read it again`);
  }
  let next = input.value;
  if (typeof next === 'string') {
    try {
      next = JSON.parse(next);
    } catch {}
  }
  if (!isObject(next)) throw new Error(`update_${name}: value must be the whole document, a JSON object`);
  return next;
}

/** The update tool's result text. */
export const updatedDocText = (name: string) => `updated ${name}`;
