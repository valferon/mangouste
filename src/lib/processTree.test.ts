import { describe, expect, it } from "vitest";
import { bufferingFilter, formatElapsed, processRows, type ProbeProcess } from "./processTree";

const proc = (pid: number, ppid: number, startedMs: number, command: string): ProbeProcess => ({
  pid,
  ppid,
  startedMs,
  command,
  full: `full ${command}`,
});

const lines = (processes: ProbeProcess[]) =>
  processRows(processes).map((r) => `${r.prefix}${r.command}${r.count > 1 ? ` ×${r.count}` : ""}`);

describe("processRows", () => {
  it("draws the ansible run from the screenshot as a tree, forks folded", () => {
    const wrapper = "bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh && eval";
    const processes = [
      // newest first, as the probe sends them
      proc(16, 13, 900, "ssh 10.0.0.4 /bin/sh -c x"),
      proc(15, 12, 800, "ssh 10.0.0.2 /bin/sh -c x"),
      proc(14, 11, 700, "ssh 10.0.0.1 /bin/sh -c x"),
      proc(13, 10, 600, "ansible-playbook -i inv.yaml"),
      proc(12, 10, 500, "ansible-playbook -i inv.yaml"),
      proc(11, 10, 400, "ansible-playbook -i inv.yaml"),
      proc(20, 2, 300, "grep -E ^fatal|ok="),
      proc(10, 3, 200, "ansible-playbook -i inv.yaml"),
      proc(3, 2, 150, "rollout.sh rs-prod"),
      proc(2, 1, 100, wrapper),
    ];
    expect(lines(processes)).toEqual([
      "rollout.sh rs-prod",
      "└ ansible-playbook -i inv.yaml",
      "  └ ansible-playbook -i inv.yaml ×3",
      "    ├ ssh 10.0.0.1 /bin/sh -c x",
      "    ├ ssh 10.0.0.2 /bin/sh -c x",
      "    └ ssh 10.0.0.4 /bin/sh -c x",
      "grep -E ^fatal|ok=",
    ]);
  });

  it("dates a folded line from its oldest member", () => {
    const rows = processRows([proc(3, 1, 900, "sleep 5"), proc(2, 1, 100, "sleep 5")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, startedMs: 100, full: "full sleep 5" });
  });

  it("keeps the wrapper when it is the only thing running", () => {
    const wrapper = "bash -c source /h/.claude/shell-snapshots/snapshot-bash-1.sh && eval";
    expect(lines([proc(2, 1, 100, wrapper)])).toEqual([wrapper]);
  });

  it("survives a parent loop among wrappers", () => {
    const wrapper = "bash -c source /h/.claude/shell-snapshots/snapshot-bash-1.sh && eval";
    expect(lines([proc(2, 3, 100, wrapper), proc(3, 2, 100, wrapper), proc(4, 2, 200, "sleep 9")])).toEqual([
      "sleep 9",
    ]);
  });

  it("carries the bar down past a sibling with children", () => {
    expect(
      lines([
        proc(1, 0, 100, "make all"),
        proc(2, 1, 200, "cc a.c"),
        proc(4, 2, 250, "as a.s"),
        proc(3, 1, 300, "cc b.c"),
      ]),
    ).toEqual(["make all", "├ cc a.c", "│ └ as a.s", "└ cc b.c"]);
  });
});

describe("bufferingFilter", () => {
  it("names a filter in the pipeline", () => {
    expect(bufferingFilter([proc(1, 0, 0, "rollout.sh x"), proc(2, 0, 0, "grep -E x")])).toBe("grep");
    expect(bufferingFilter([proc(1, 0, 0, "kubectl get pods")])).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("picks one unit", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(372_000)).toBe("6m");
    expect(formatElapsed(7_300_000)).toBe("2h");
  });
});
