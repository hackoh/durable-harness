export declare const appDir: string;
export interface DevServer {
  url: string;
  pid: number;
  output(): string;
  /** SIGKILL the whole process group: wrangler, workerd, every isolate. */
  kill(): Promise<unknown>;
}
export declare function startDev(options: { port: number; persistTo: string; vars?: Record<string, string>; log?: (chunk: string) => void }): Promise<DevServer>;
