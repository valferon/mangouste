/**
 * Why the usage window has no numbers.
 *
 * `signIn` names the account to sign in, and is set only when that is what
 * fixes it: the account holds no sign-in, or one the CLI could not renew. A
 * lapsed token is not among them. The backend renews those by itself, which
 * is why switching accounts no longer ends in the browser.
 */
export interface UsageFault {
  message: string;
  signIn: string | null;
  /**
   * How long until asking again is worth it, for the one fault that clears
   * by itself: a renewal that found no network. Null for the rest.
   */
  retryMs: number | null;
}

const NO_MESSAGE = "usage request failed";

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * A rejected `fetchUsage`, as something the panel can show.
 *
 * The backend rejects with `{ message, signIn, retryMs }`. Anything else is taken as
 * its text: `invoke` itself can fail with a string or an `Error`, and none of
 * those is a reason to offer a sign-in.
 */
export function usageFaultOf(error: unknown): UsageFault {
  const plain = (message: unknown): UsageFault => ({
    message: textOf(message) ?? NO_MESSAGE,
    signIn: null,
    retryMs: null,
  });
  if (error instanceof Error) return plain(error.message);
  if (typeof error === "object" && error !== null) {
    const { message, signIn, retryMs } = error as {
      message?: unknown;
      signIn?: unknown;
      retryMs?: unknown;
    };
    return {
      ...plain(message),
      signIn: textOf(signIn),
      // A timer is set from this, so only a delay that is one: a real, positive number.
      retryMs: typeof retryMs === "number" && Number.isFinite(retryMs) && retryMs > 0 ? retryMs : null,
    };
  }
  return plain(error);
}
