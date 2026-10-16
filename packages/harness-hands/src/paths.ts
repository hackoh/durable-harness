/*
 * The workspace's root and its shell's commands, apart from the tools'
 * schemas (specs.ts builds them with typebox as it loads): the runtime and
 * its machines need only these, so a harness that never builds those
 * schemas (OpenCode, fx) loads no typebox. specs.ts re-exports them.
 */

export const WORKSPACE_ROOT = '/workspace';

/**
 * The commands a virtual workspace's shell has: just-bash's built-ins, an
 * explicit list so a just-bash upgrade can't add one (a test pins it), and
 * without the ones that reach further than files and text: no network
 * (curl), no interpreters (python3, js-exec, node), no sqlite3. just-bash
 * registers curl, python3 and js-exec only when asked; sqlite3 it registers
 * unless left out, as here.
 */
export const VIRTUAL_COMMANDS = Object.freeze([
  'alias', 'awk', 'base64', 'basename', 'bash', 'cat', 'chmod', 'clear', 'column', 'comm', 'cp', 'cut', 'date', 'diff', 'dirname', 'du',
  'echo', 'egrep', 'env', 'expand', 'expr', 'false', 'fgrep', 'file', 'find', 'fold', 'grep', 'gunzip', 'gzip', 'head', 'help',
  'history', 'hostname', 'html-to-markdown', 'join', 'jq', 'ln', 'ls', 'md5sum', 'mkdir', 'mv', 'nl', 'od', 'paste', 'printenv',
  'printf', 'pwd', 'readlink', 'rev', 'rg', 'rm', 'rmdir', 'sed', 'seq', 'sh', 'sha1sum', 'sha256sum', 'sleep', 'sort', 'split',
  'stat', 'strings', 'tac', 'tail', 'tar', 'tee', 'time', 'timeout', 'touch', 'tr', 'tree', 'true', 'unalias', 'unexpand', 'uniq',
  'wc', 'which', 'whoami', 'xan', 'xargs', 'yq', 'zcat',
] as const);
