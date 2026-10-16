import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { createRegistry, defineExtension, defineTool, Harness, ROOT_CONVERSATION_ID, type ToolRegistration } from '@earendil-works/pi-durable';
import type { World } from '@workflow/world';
import { NativeWorkspace } from 'harness-world-hands/workspace';
import { bashResultText, resolvePath, TOOL_SPECS, UNSAFE_CONFIRM_MS, type UnsafeToolName, unsafeResultText } from 'harness-world-hands/specs';
import type { Anchor } from 'harness-world/anchor';
import { type WorldStorage, type WorldStorageOptions } from './storage.ts';
import { worldStorage } from './index.ts';

const ctx = BACKGROUND_CONTEXT;

/** The provider id pi-ai 1.0 gives the Vercel AI Gateway. */
export const GATEWAY_PROVIDER = 'vercel-ai-gateway';

export interface PiDurableAgentOptions {
  world: World;
  /** A Gateway model id, e.g. `anthropic/claude-opus-5.5-fast`. */
  modelId: string;
  /** The Gateway credential (an OIDC token or an API key), asked for at every request. */
  apiKey: () => Promise<string>;
  instructions: string;
  /** Workflow name for runs this creates. Default `pi-durable`. */
  name?: string;
  storage?: WorldStorageOptions;
}

export interface PiDurableAgent {
  /**
   * `Harness.open(await worldStorage(world, id, { anchor }), ...)`: what
   * `worldStorage.wakeHandler` and the routes open. `anchor` is the delivery
   * (or deadline drive) its commits are written under.
   */
  openAgent(sessionId: string, anchor?: Anchor): Promise<Harness>;
  /** The storage behind the last harness `openAgent` opened for `sessionId` in this process (for a simulated crash). */
  storageOf(sessionId: string): WorldStorage | undefined;
  /** The root conversation with this agent's model and instructions (created on first use). */
  root(harness: Harness, context?: Context): ReturnType<Harness['root']>;
  modelId: string;
}

type FileSnapshot = Record<string, string>;
const filesOf = (details: unknown): FileSnapshot | undefined => {
  const files = (details as { files?: unknown } | undefined)?.files;
  return files && typeof files === 'object' ? (files as FileSnapshot) : undefined;
};

/**
 * Pi 1.0's durable Harness on a World with the demo's model, prompt and
 * workspace tools. The workspace is just-bash on an in-memory filesystem,
 * the same as the other harnesses' native baseline; every tool that can
 * change it records the whole workspace in its result's `details`, and a
 * process that opens the session rebuilds the workspace from the newest
 * one. So a crashed `bash` reruns against the files as of its start (the
 * crashed call recorded nothing), which is what makes the workspace tools
 * `replay: 'safe'`. The two unsafe example tools keep Pi's default (an
 * interrupted call comes back `interrupted`, never reruns).
 */
export function piDurableAgent(options: PiDurableAgentOptions): PiDurableAgent {
  const models = createModels({
    // The Gateway provider reads AI_GATEWAY_API_KEY from its auth context: hand it a fresh credential each time.
    authContext: {
      env: async (name) => (name === 'AI_GATEWAY_API_KEY' ? options.apiKey() : process.env[name]),
      fileExists: async () => false,
    },
  });
  models.setProvider(vercelAIGatewayProvider());
  if (!models.getModel(GATEWAY_PROVIDER, options.modelId)) throw new Error(`pi-ai 1.0 does not know ${options.modelId}`);
  const storages = new Map<string, WorldStorage>();

  const openAgent = async (sessionId: string, anchor?: Anchor): Promise<Harness> => {
    const storage = await worldStorage(options.world, sessionId, { name: options.name ?? 'pi-durable', ...options.storage, ...(anchor ? { anchor } : {}) });
    storages.set(sessionId, storage);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'workspace', tools: workspaceTools(() => hydrate(storage)) }));
    return Harness.open(storage, { models, registry, settings: { toolExecution: 'sequential' } }, ctx);
  };

  return {
    openAgent,
    storageOf: (id) => storages.get(id),
    root: (harness, context = ctx) =>
      harness.root(context, { agent: { model: { provider: GATEWAY_PROVIDER, modelId: options.modelId }, instructions: options.instructions } }),
    modelId: options.modelId,
  };
}

/** The workspace as of the newest tool result that recorded one (in a storage `workspaceTools` wrote to). */
export async function hydrate(storage: Pick<WorldStorage, 'scanEntries'>): Promise<NativeWorkspace> {
  let cursor: Parameters<WorldStorage['scanEntries']>[2];
  for (;;) {
    const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 200, cursor as never, ctx).catch(() => undefined);
    if (!page) break;
    for (const e of page.items) {
      if (e.kind !== 'pi.tool-result') continue;
      const files = filesOf((e.model?.[0] as { details?: unknown } | undefined)?.details);
      if (files) return NativeWorkspace.from(files);
    }
    if (!page.next) break;
    cursor = page.next;
  }
  return NativeWorkspace.from();
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const specTool = (name: keyof typeof TOOL_SPECS, replay: 'safe' | undefined, execute: (args: any, context: Context) => Promise<any>) =>
  defineTool({
    name: name as string,
    description: TOOL_SPECS[name].description,
    parameters: TOOL_SPECS[name].inputSchema as never,
    ...(replay ? { replay } : {}),
    execute: async (args, _api, context) => execute(args, context),
  }) as ToolRegistration;

/** The two non-idempotent example tools, unsafe_send_email and unsafe_make_payment (Pi's default replay: an interrupted call comes back interrupted). */
export function unsafeExampleTools(): ToolRegistration[] {
  const unsafe = (name: UnsafeToolName) =>
    specTool(name, undefined, async (input, context) => {
      const ref = `${name === 'unsafe_send_email' ? 'msg' : 'pay'}_${Math.random().toString(36).slice(2, 12)}`;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, UNSAFE_CONFIRM_MS);
        context.abortSignal?.addEventListener('abort', () => (clearTimeout(timer), resolve()));
      });
      return text(unsafeResultText(name, input, ref));
    });
  return [unsafe('unsafe_send_email'), unsafe('unsafe_make_payment')];
}

/** bash, read_file, write_file, edit_file, list_files (`replay: 'safe'`) and the two unsafe example tools. */
export function workspaceTools(load: () => Promise<NativeWorkspace>): ToolRegistration[] {
  let ws: Promise<NativeWorkspace> | undefined;
  const workspace = () => (ws ??= load());
  const changed = async (w: NativeWorkspace, out: string) => ({ ...text(out), details: { files: await w.files() } });
  const tool = specTool;
  return [
    tool('bash', 'safe', async ({ command }, context) => {
      const w = await workspace();
      const result = await w.bash.exec(command, context.abortSignal ? { signal: context.abortSignal } : {});
      return changed(w, bashResultText(result));
    }),
    tool('read_file', 'safe', async ({ path }) => text(await (await workspace()).fs.readFile(resolvePath(path)))),
    tool('write_file', 'safe', async ({ path, content }) => {
      const w = await workspace();
      const target = resolvePath(path);
      await w.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await w.fs.writeFile(target, content);
      return changed(w, `wrote ${content.length} bytes to ${target}`);
    }),
    tool('edit_file', 'safe', async ({ path, oldText, newText }) => {
      const w = await workspace();
      const target = resolvePath(path);
      const before = await w.fs.readFile(target);
      const at = before.indexOf(oldText);
      if (at === -1) throw new Error(`oldText not found in ${target}`);
      if (before.indexOf(oldText, at + 1) !== -1) throw new Error(`oldText occurs more than once in ${target}`);
      await w.fs.writeFile(target, before.slice(0, at) + newText + before.slice(at + oldText.length));
      return changed(w, `edited ${target}`);
    }),
    tool('list_files', 'safe', async () => {
      const files = Object.keys(await (await workspace()).files()).sort();
      return text(files.length ? files.join('\n') : '(empty workspace)');
    }),
    ...unsafeExampleTools(),
  ];
}
