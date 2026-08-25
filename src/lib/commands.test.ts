import { describe, expect, it } from "vitest";
import {
  byId,
  commandEntry,
  duplicateChords,
  claimedByShell,
  matchChord,
  parseChord,
  runChord,
  type Command,
} from "./commands";
import { CHORD } from "./keybindings";

/** Enough of a KeyboardEvent for `matchChord`, which reads five fields. */
function press(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): KeyboardEvent {
  return {
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  } as KeyboardEvent;
}

describe("parseChord", () => {
  it("maps letters to their physical code", () => {
    expect(parseChord("Ctrl+N")).toEqual({
      code: "KeyN",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    });
  });

  it("maps digits, which is the case `key` gets wrong", () => {
    // Shifted "5" arrives as "%" on most layouts, so a `key` comparison never
    // fires for Ctrl+Shift+5.
    expect(parseChord("Ctrl+Shift+5")).toEqual({
      code: "Digit5",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
  });

  it("maps the punctuation the app actually binds", () => {
    expect(parseChord("Ctrl+,")?.code).toBe("Comma");
    expect(parseChord("Ctrl+`")?.code).toBe("Backquote");
    expect(parseChord("Ctrl+=")?.code).toBe("Equal");
    expect(parseChord("Ctrl+-")?.code).toBe("Minus");
  });

  it("maps named keys", () => {
    expect(parseChord("F11")?.code).toBe("F11");
    expect(parseChord("Escape")?.code).toBe("Escape");
    expect(parseChord("Shift+Enter")).toEqual({
      code: "Enter",
      meta: false,
      ctrl: false,
      shift: true,
      alt: false,
    });
  });

  it("refuses a chord that names no key", () => {
    // "Middle-click" lives in the same table as the keyboard chords, because it
    // belongs in the shortcuts sheet. It must never match a keystroke.
    expect(parseChord("Middle-click")).toBeNull();
    expect(parseChord("Select text")).toBeNull();
    expect(parseChord("")).toBeNull();
  });

  it("refuses an unknown modifier rather than ignoring it", () => {
    // Silently dropping "Hyper" would turn Hyper+P into bare P.
    expect(parseChord("Hyper+P")).toBeNull();
  });
});

describe("matchChord", () => {
  it("matches the keystroke it names", () => {
    expect(matchChord("Ctrl+N", press("KeyN", { ctrl: true }))).toBe(true);
  });

  it("is indifferent to the character the layout produces", () => {
    expect(matchChord("Ctrl+Shift+5", press("Digit5", { ctrl: true, shift: true }))).toBe(true);
  });

  it("does not fire on a superset of its modifiers", () => {
    // The bug this prevents: Ctrl+N and Ctrl+Shift+N both running on one press.
    expect(matchChord("Ctrl+N", press("KeyN", { ctrl: true, shift: true }))).toBe(false);
  });

  it("does not fire on a subset either", () => {
    expect(matchChord("Ctrl+Shift+E", press("KeyE", { ctrl: true }))).toBe(false);
  });

  it("keeps the two panel toggles off each other's keystroke", () => {
    // The chat and the terminal sit one Shift apart on the same key, so the
    // exactness above is what stops one press hiding both panels.
    const backquote = press("Backquote", { ctrl: true });
    const shifted = press("Backquote", { ctrl: true, shift: true });
    expect(matchChord(CHORD.toggleTerminal, backquote)).toBe(true);
    expect(matchChord(CHORD.toggleTerminal, shifted)).toBe(false);
    expect(matchChord(CHORD.toggleChat, shifted)).toBe(true);
    expect(matchChord(CHORD.toggleChat, backquote)).toBe(false);
  });

  it("never fires when the desktop's super key is held", () => {
    expect(matchChord("Ctrl+N", press("KeyN", { ctrl: true, meta: true }))).toBe(false);
  });

  it("is false for a chord that names no key", () => {
    expect(matchChord("Middle-click", press("KeyN", { ctrl: true }))).toBe(false);
  });
});

describe("runChord", () => {
  const calls: string[] = [];
  const commands: Command[] = [
    { id: "a", label: "A", chord: "Ctrl+A", run: () => calls.push("a") },
    { id: "b", label: "B", chord: "Ctrl+B", disabled: true, run: () => calls.push("b") },
    { id: "c", label: "C", run: () => calls.push("c") },
  ];

  it("runs the match and reports it", () => {
    calls.length = 0;
    expect(runChord(commands, press("KeyA", { ctrl: true }))).toBe(true);
    expect(calls).toEqual(["a"]);
  });

  it("will not run a disabled command", () => {
    calls.length = 0;
    expect(runChord(commands, press("KeyB", { ctrl: true }))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports no match, so the caller knows not to preventDefault", () => {
    calls.length = 0;
    expect(runChord(commands, press("KeyZ", { ctrl: true }))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("runs only the first of two commands sharing a chord", () => {
    calls.length = 0;
    const clashing: Command[] = [
      { id: "x", label: "X", chord: "Ctrl+K", run: () => calls.push("x") },
      { id: "y", label: "Y", chord: "Ctrl+K", run: () => calls.push("y") },
    ];
    runChord(clashing, press("KeyK", { ctrl: true }));
    expect(calls).toEqual(["x"]);
  });
});

describe("commandEntry", () => {
  const command: Command = {
    id: "t",
    label: "Terminal Panel",
    chord: CHORD.toggleTerminal,
    checked: true,
    run: () => {},
  };

  it("carries the label, chord and state into the menu row", () => {
    const entry = commandEntry(command);
    expect(entry.label).toBe("Terminal Panel");
    expect(entry.accelerator).toBe(CHORD.toggleTerminal);
    expect(entry.checked).toBe(true);
    expect(entry.run).toBe(command.run);
  });

  it("lets a call site override one field without restating the rest", () => {
    expect(commandEntry(command, { label: "Show Terminal" })).toMatchObject({
      label: "Show Terminal",
      accelerator: CHORD.toggleTerminal,
    });
  });
});

describe("byId", () => {
  const commands: Command[] = [{ id: "real", label: "Real", run: () => {} }];

  it("finds a command", () => {
    expect(byId(commands, "real").label).toBe("Real");
  });

  it("throws on a typo, because a missing menu row is worse than a crash", () => {
    expect(() => byId(commands, "raal")).toThrow(/no such command/);
  });
});

describe("duplicateChords", () => {
  it("finds a clash", () => {
    expect(
      duplicateChords([
        { id: "a", label: "A", chord: "Ctrl+K", run: () => {} },
        { id: "b", label: "B", chord: "Ctrl+K", run: () => {} },
      ]),
    ).toEqual(["Ctrl+K"]);
  });

  it("ignores commands with no chord, of which there are many", () => {
    expect(
      duplicateChords([
        { id: "a", label: "A", run: () => {} },
        { id: "b", label: "B", run: () => {} },
      ]),
    ).toEqual([]);
  });
});

describe("matchChord and Cmd", () => {
  it("fires a Cmd chord only with Cmd held", () => {
    expect(matchChord("Cmd+P", press("KeyP", { meta: true }))).toBe(true);
    expect(matchChord("Cmd+P", press("KeyP", { ctrl: true }))).toBe(false);
    expect(matchChord("Cmd+P", press("KeyP", {}))).toBe(false);
  });

  it("keeps a Ctrl chord off Cmd", () => {
    // The two modifiers are the same key on neither platform, and a chord that
    // answered both would fire twice on a Mac reading a Linux keymap.
    expect(matchChord("Ctrl+P", press("KeyP", { meta: true }))).toBe(false);
    expect(matchChord("Ctrl+P", press("KeyP", { ctrl: true }))).toBe(true);
  });

  it("matches the both-modifiers chord macOS uses for full screen", () => {
    expect(matchChord("Ctrl+Cmd+F", press("KeyF", { ctrl: true, meta: true }))).toBe(true);
    expect(matchChord("Ctrl+Cmd+F", press("KeyF", { ctrl: true }))).toBe(false);
  });
});

describe("claimedByShell", () => {
  const command = (chord: string) => ({
    id: "x",
    label: "X",
    chord,
    shellFirst: true,
    run: () => {},
  });

  it("stands down for a Ctrl chord readline wants", () => {
    expect(claimedByShell(command("Ctrl+W"))).toBe(true);
  });

  it("does not stand down once the chord has moved to Cmd", () => {
    // The shell binds Ctrl+W, not Cmd+W. Dropping the command on macOS anyway
    // left the keystroke doing nothing at all inside a terminal.
    expect(claimedByShell(command("Cmd+W"))).toBe(false);
  });

  it("says nothing about a command that never claimed the exception", () => {
    expect(claimedByShell({ id: "x", label: "X", chord: "Ctrl+W", run: () => {} })).toBe(false);
  });
});

describe("the CHORD table", () => {
  it("parses every chord it claims is a key chord", () => {
    // Guards against a typo like "Ctlr+P" reaching the accelerator column and
    // never firing. The three prose entries are the documented exceptions.
    const prose = new Set<string>([CHORD.primaryPaste, CHORD.closeTabAlt]);
    const broken = Object.entries(CHORD)
      .filter(([, chord]) => !prose.has(chord) && parseChord(chord) === null)
      .map(([name]) => name);
    expect(broken).toEqual([]);
  });
});
