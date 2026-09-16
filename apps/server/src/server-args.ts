/**
 * How this process was asked to run (§21.3).
 *
 * One flag, and it says which processes the deployment is composed of rather
 * than what any of them should do — the same kind of decision as the
 * distribution job's verbs, and not a value §102 leaves open.
 *
 * Anything else is refused. A deployment that runs the realtime tier separately
 * is relying on this server holding no connections, and `--no-socket` accepted
 * silently would leave two processes serving sockets with an ingress splitting
 * traffic between them — half the watchers on the machine that also scores
 * battles, which is the arrangement the split exists to avoid. A typo should be
 * a process that will not start, not a deployment that looks right.
 */

export const SERVER_USAGE = `Usage:
  node dist/main.js [--no-sockets]

  --no-sockets  Drive rounds and serve the API, but hold no WebSocket
                connections: the realtime tier runs as its own process
                (node dist/gateway.js). See docs/operations/deployment.md.`;

export type ServerArgs =
  | { readonly ok: true; readonly servesSockets: boolean }
  | { readonly ok: false; readonly problem: string };

export function parseServerArgs(args: readonly string[]): ServerArgs {
  let servesSockets = true;
  for (const arg of args) {
    if (arg === '--no-sockets') {
      servesSockets = false;
      continue;
    }
    return { ok: false, problem: `unknown argument ${JSON.stringify(arg)}\n\n${SERVER_USAGE}` };
  }
  return { ok: true, servesSockets };
}
