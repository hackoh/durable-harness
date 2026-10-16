declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
declare module 'libfx/wasm' {
  export const createFxEngine: (options: Record<string, unknown>) => Promise<any>;
}
