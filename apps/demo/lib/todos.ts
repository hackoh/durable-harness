/**
 * The demo's todo list document, as plain data: `docs.ts` makes it a kernel
 * document (`defineDoc`), and the native baseline (`native.ts`) offers the
 * same read_todos and update_todos without loading the kernel.
 */
export const TODOS = {
  name: 'todos',
  kind: 'demo.todos',
  version: 1,
  initial: () => ({ items: [] as string[] }),
  // The model-facing type of update_todos' value (strict tool calling needs the properties).
  schema: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'string' }, description: 'The todo items, in order.' } },
    required: ['items'],
    additionalProperties: false,
  },
  validate: (value: { items?: unknown }) => {
    if (!Array.isArray(value.items) || value.items.some((i) => typeof i !== 'string')) throw new Error('todos: items must be an array of strings');
  },
};
