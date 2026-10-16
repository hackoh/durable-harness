import { defineDoc } from 'harness-world';
import { TODOS } from './todos';

/**
 * The demo's document: a todo list kept in the session's log (harness-world
 * documents). Every harness gets `read_todos` and `update_todos`
 * (`docTools([Todos])`), the app reads and writes it through
 * `/api/sessions/<id>/docs` (`sessions.doc` / `sessions.updateDoc`), and the
 * model sees it only through those tools.
 */
export const Todos = defineDoc<{ items: string[] }>({
  kind: TODOS.kind,
  version: TODOS.version,
  initial: TODOS.initial,
  schema: TODOS.schema,
  validate: TODOS.validate,
});
