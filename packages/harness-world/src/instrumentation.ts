import type { DriveContext, Harness } from './types.ts';
import type { World } from '@workflow/world';

export interface TraceOperation {
  end(output?: unknown, error?: unknown): void;
}

export interface TraceScope {
  start(name: string, input?: unknown, key?: string): TraceOperation;
  end(error?: unknown, outcome?: 'completed' | 'running' | 'cancelled' | 'failed'): void;
  /** Wait for best-effort Workflow trace metadata writes owned by this invocation. */
  flush?(): Promise<void>;
}

export interface InstrumentationRuntime {
  drive(harness: Harness, ctx: DriveContext): Promise<void>;
  session(sessionId: string, harness: string, turnId: string, input?: unknown, audience?: 'public' | 'private' | 'unknown', world?: World): TraceScope;
}

export const INSTRUMENTATION = Symbol.for('durable-harness.instrumentation');

/** Browser-safe bridge: the Node exporter is installed by the app, never by the kernel. */
export function instrumentation(): InstrumentationRuntime | undefined {
  return (globalThis as { [INSTRUMENTATION]?: InstrumentationRuntime })[INSTRUMENTATION];
}

export function instrumentedDrive(harness: Harness, ctx: DriveContext): Promise<void> {
  return instrumentation()?.drive(harness, ctx) ?? harness.drive(ctx);
}
