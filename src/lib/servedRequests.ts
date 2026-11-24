/**
 * Which prompt requests a pane has already acted on, by pane id.
 *
 * A saved prompt or a scheduled follow-up reaches its pane as a tokened request
 * held in App state, and the pane remembers the newest token it has served so a
 * re-render does not act on it twice. Kept in the pane, that memory died with
 * the pane while the request lived on. Closing a session's tab and opening the
 * session again mounts a fresh pane under the same id, which found the old
 * request, took it for news and sent the prompt again: a saved prompt once, a
 * scheduled follow-up once for every earlier fire still on its list. A pane
 * rebuilt by its error boundary did the same.
 *
 * So the memory lives here, for as long as the requests do: one webview, one
 * run. Tokens only ever grow (`pasteTokenRef` in App), which is what makes
 * "the newest one served" enough to tell old from new.
 */

/** `paste` lands in a composer or a pty; `direct` is a turn sent as it is. */
export type RequestChannel = "paste" | "direct";

const served = new Map<string, number>();

const slot = (pane: string, channel: RequestChannel): string => `${channel}\n${pane}`;

/** The newest token `pane` has served on `channel`, or 0 when it has none. */
export function servedUpTo(pane: string, channel: RequestChannel): number {
  return served.get(slot(pane, channel)) ?? 0;
}

/** Record that `pane` acted on everything up to `token`. Never moves back. */
export function markServed(pane: string, channel: RequestChannel, token: number): void {
  if (token > servedUpTo(pane, channel)) served.set(slot(pane, channel), token);
}

/** The requests `pane` has not acted on yet, in the order they were given. */
export function unserved<T extends { token: number }>(
  pane: string,
  channel: RequestChannel,
  requests: readonly T[],
): T[] {
  const upTo = servedUpTo(pane, channel);
  return requests.filter((request) => request.token > upTo);
}

/** Drop everything. For tests. */
export function forgetServed(): void {
  served.clear();
}
