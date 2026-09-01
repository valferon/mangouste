import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRoot = vi.fn<(cwd: string) => Promise<string | null>>();
vi.mock("./ipc", () => ({ gitRoot: (cwd: string) => gitRoot(cwd) }));

const { knownRepoRoot, rememberRepoRoot, repoRoot, resetRepoRoots, warmRepoRoots } = await import(
  "./repoRoot"
);

describe("repo root cache", () => {
  beforeEach(() => {
    resetRepoRoots();
    gitRoot.mockReset();
  });

  /** The whole point: a click on a known repo must not wait on a child process. */
  it("answers for a remembered root without asking git", () => {
    rememberRepoRoot("/w/app", "/w/app");
    expect(knownRepoRoot("/w/app")).toBe("/w/app");
    expect(gitRoot).not.toHaveBeenCalled();
  });

  it("has no answer for a path it has not seen", () => {
    expect(knownRepoRoot("/w/app/src")).toBeNull();
  });

  it("asks git once per path and remembers both names", async () => {
    gitRoot.mockResolvedValue("/w/app");
    expect(await repoRoot("/w/app/src/deep")).toBe("/w/app");
    expect(await repoRoot("/w/app/src/deep")).toBe("/w/app");
    expect(gitRoot).toHaveBeenCalledTimes(1);
    // The root resolves to itself, which is the lookup made once it is active.
    expect(knownRepoRoot("/w/app")).toBe("/w/app");
  });

  /** Two rows clicked in the same tick must share one `rev-parse`, not race it. */
  it("shares one resolution between concurrent callers", async () => {
    let settle: (value: string | null) => void = () => {};
    gitRoot.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const both = Promise.all([repoRoot("/w/app/src"), repoRoot("/w/app/src")]);
    settle("/w/app");
    expect(await both).toEqual(["/w/app", "/w/app"]);
    expect(gitRoot).toHaveBeenCalledTimes(1);
  });

  /** A plain directory opens fine, and re-asking would spawn a process per click. */
  it("falls back to the path itself when git cannot place it", async () => {
    gitRoot.mockResolvedValue(null);
    expect(await repoRoot("/tmp/notes")).toBe("/tmp/notes");
    expect(knownRepoRoot("/tmp/notes")).toBe("/tmp/notes");
    expect(await repoRoot("/tmp/notes")).toBe("/tmp/notes");
    expect(gitRoot).toHaveBeenCalledTimes(1);
  });

  it("treats a failed call as the path itself", async () => {
    gitRoot.mockRejectedValue(new Error("git is missing"));
    expect(await repoRoot("/tmp/notes")).toBe("/tmp/notes");
  });

  it("warms only what it does not already hold, and skips empty paths", async () => {
    gitRoot.mockResolvedValue("/w/app");
    rememberRepoRoot("/w/app", "/w/app");
    warmRepoRoots(["/w/app", "", "/w/app/src"]);
    await vi.waitFor(() => expect(gitRoot).toHaveBeenCalledTimes(1));
    expect(gitRoot).toHaveBeenCalledWith("/w/app/src");
  });
});
