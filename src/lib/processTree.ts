/**
 * The probe's process list, drawn as the tree it is.
 *
 * Rust sends every process the turn started, flat, with its parent pid. Here
 * they become a tree, oldest first so the command you asked for leads, with
 * identical siblings folded into one line: an ansible run forks one worker per
 * host, and five copies of the same `ansible-playbook` line say less than
 * `×5` does. Their children are pooled under the folded line, so the `ssh`
 * each worker runs still shows, one per host.
 */

/** One process, as `claude://tool-activity` carries it. */
export interface ProbeProcess {
  pid: number;
  ppid: number;
  startedMs: number;
  /** Shaped for a glance by Rust: short program names, no ssh options. */
  command: string;
  /** The whole command line, for the hover title. */
  full: string;
}

export interface ProcessRow {
  /** Tree glyphs drawn before the command, e.g. `│ ├ `. */
  prefix: string;
  command: string;
  full: string;
  /** Identical siblings folded into this line. */
  count: number;
  /** The oldest of them, so a stuck one is never hidden by a fresh one. */
  startedMs: number;
}

/**
 * The CLI runs every Bash call as `bash -c source …/shell-snapshots/… && eval
 * '<command>'`. The tool card already shows that command, so the wrapper only
 * earns a line when nothing runs under it.
 */
const WRAPPER = /\/shell-snapshots\/snapshot-/;

interface Group {
  command: string;
  full: string;
  count: number;
  startedMs: number;
  members: ProbeProcess[];
}

export function processRows(processes: ProbeProcess[]): ProcessRow[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const children = new Map<number, ProbeProcess[]>();
  for (const p of processes) {
    const list = children.get(p.ppid) ?? [];
    children.set(p.ppid, [...list, p]);
  }
  const spliced = (p: ProbeProcess) => WRAPPER.test(p.command) && children.has(p.pid);

  // A spliced wrapper hands its children to its own parent.
  // Bounded: a pid reused mid-scan can make a parent loop.
  const parentOf = (p: ProbeProcess): ProbeProcess | null => {
    let parent = byPid.get(p.ppid) ?? null;
    for (let hops = 0; parent && spliced(parent); hops++) {
      if (hops > processes.length) return null;
      parent = byPid.get(parent.ppid) ?? null;
    }
    return parent;
  };
  const shown = processes.filter((p) => !spliced(p));
  const under = new Map<number | null, ProbeProcess[]>();
  for (const p of shown) {
    const key = parentOf(p)?.pid ?? null;
    under.set(key, [...(under.get(key) ?? []), p]);
  }

  const rows: ProcessRow[] = [];
  const walk = (members: ProbeProcess[], indent: string, root: boolean) => {
    const groups = fold(members);
    groups.forEach((group, index) => {
      const last = index === groups.length - 1;
      rows.push({
        prefix: root ? "" : `${indent}${last ? "└ " : "├ "}`,
        command: group.command,
        full: group.full,
        count: group.count,
        startedMs: group.startedMs,
      });
      const next = group.members.flatMap((m) => under.get(m.pid) ?? []);
      walk(next, root ? "" : `${indent}${last ? "  " : "│ "}`, false);
    });
  };
  walk(under.get(null) ?? [], "", true);
  return rows;
}

/** Same command, one group, in order of first start. */
function fold(members: ProbeProcess[]): Group[] {
  const sorted = [...members].sort((a, b) => a.startedMs - b.startedMs || a.pid - b.pid);
  const groups = new Map<string, Group>();
  for (const p of sorted) {
    const group = groups.get(p.command);
    groups.set(
      p.command,
      group
        ? { ...group, count: group.count + 1, members: [...group.members, p] }
        : { command: p.command, full: p.full, count: 1, startedMs: p.startedMs, members: [p] },
    );
  }
  return [...groups.values()];
}

/**
 * Filters that block-buffer into a file: piped through one, a command's output
 * file stays empty until a buffer fills or the pipeline ends.
 */
const BUFFERING = new Set([
  "grep", "egrep", "fgrep", "rg", "awk", "gawk", "sed", "jq",
  "sort", "uniq", "head", "tail", "cut", "tr", "wc",
]);

/** The first buffering filter running, by name, or null. */
export function bufferingFilter(processes: ProbeProcess[]): string | null {
  for (const p of processes) {
    const program = p.command.split(" ", 1)[0];
    if (BUFFERING.has(program)) return program;
  }
  return null;
}

/** `42s`, `6m`, `2h`: how long a process has been running. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
