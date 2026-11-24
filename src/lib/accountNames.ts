import type { Account } from "./types";

/**
 * What an account is called on screen.
 *
 * An account's `name` is its directory and never changes: the CLI's config
 * dir, the macOS keychain item and every running session are tied to it. What
 * is shown is the label the person gave it, else the address it is signed in
 * as, else that name. The backend's `labels::title` is the same rule, for the
 * messages it writes.
 */
export function accountTitle(account: Account): string {
  return account.label ?? account.email ?? account.name;
}

/**
 * The title with what tells the account apart behind it: `Ops (o@example.com)`,
 * `o@example.com (work)`, or the title alone when there is nothing to add.
 * For the switcher's menu and its tooltip, where there is room.
 */
export function accountLabel(account: Account): string {
  const title = accountTitle(account);
  const detail = account.label ? account.email : account.email ? account.name : null;
  return detail ? `${title} (${detail})` : title;
}

/**
 * The title of the account named `name`. The name itself when the list does
 * not hold it: an account removed since a session started on it still has to
 * be called something.
 */
export function titleOf(accounts: Account[] | undefined, name: string): string {
  const account = accounts?.find((entry) => entry.name === name);
  return account ? accountTitle(account) : name;
}

/** The longest label the backend keeps, checked here only to grey a button. */
export const MAX_LABEL = 40;

/**
 * A directory name for an account the person called `typed`: `Ops team`
 * becomes `ops-team`. Null when nothing usable is left.
 *
 * The backend takes letters, digits, `-` and `_` and nothing else, since the
 * name becomes a path. Asking for that in the box is what made every account
 * a one-word lowercase name; this lets the box take anything, and the thing
 * typed is kept as the label.
 */
export function accountSlug(typed: string): string | null {
  const slug = typed
    .normalize("NFKD")
    // The accents NFKD split off their letters, so `é` keeps its `e`.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[øßłđðþæœı]/g, (letter) => UNACCENTED[letter] ?? letter)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? null : slug;
}

/**
 * Latin letters that are whole letters rather than a letter and an accent,
 * so NFKD leaves them be, spelled the way they are written without them.
 * Left out, `Søren` came out as `s-ren`.
 */
const UNACCENTED: Record<string, string> = {
  ø: "o",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
  ı: "i",
};

/**
 * The directory a new account called `typed` gets, given the ones `taken`
 * (every account's, `main` among them). Null only when nothing was typed.
 *
 * A plain version of the name where it has one, and `account` where it has
 * none: a name in another script is still a name, and it is kept whole as the
 * label. Numbered from 2 when the directory is taken, so the box never has to
 * explain a collision between two names that are not the ones typed. Compared
 * without case, since on macOS `Work` and `work` are one directory.
 */
export function accountDirectory(typed: string, taken: readonly string[]): string | null {
  if (typed.trim() === "") return null;
  const base = accountSlug(typed) ?? "account";
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
