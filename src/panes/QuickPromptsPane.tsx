import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { formatRun, nextRun, parseCron } from "../lib/cron";
import { createFile, deletePath, readTextFile, writeTextFile } from "../lib/ipc";
import {
  ClockIcon,
  OverflowIcon,
  PasteIcon,
  PencilIcon,
  PlusIcon,
  QuickPromptsIcon,
  SendIcon,
  TrashIcon,
} from "../lib/icons";
import { useMenu, type MenuEntry } from "../lib/menu";
import { repoLabel } from "../lib/visitedRepos";
import {
  addPrompt,
  deriveLabel,
  duplicateDraft,
  exportPrompts,
  fromLocalInput,
  groupOf,
  importedMode,
  importPrompts,
  isTimed,
  movePrompt,
  newPromptId,
  normaliseDraft,
  parseImport,
  PROMPT_MODES,
  PROMPTS_CHANGED_EVENT,
  PROMPTS_KEY,
  readPrompts,
  removePrompt,
  toLocalInput,
  updatePrompt,
  writePrompts,
  type QuickPrompt,
  type PromptMode,
  type QuickPromptDraft,
} from "../lib/quickPrompts";
import { MAX_TIMED, whenCaption } from "../lib/sessionControl";

interface QuickPromptsPaneProps {
  /** Put this prompt into the session in front, or a new one when there is none. */
  onRun: (prompt: QuickPrompt) => void;
  /**
   * Where a click will land, for the header hint: the front session's label,
   * or null when a click would have to open a session of its own.
   */
  target: string | null;
  /** Repos a new-session prompt can be pinned to, most recently worked on first. */
  projects: ProjectChoice[];
}

export interface ProjectChoice {
  path: string;
  label: string;
}

const EMPTY_DRAFT: QuickPromptDraft = {
  label: "",
  text: "",
  submit: false,
  newSession: false,
  project: null,
  schedule: null,
  at: null,
  session: null,
  origin: null,
};

/** How often the "next run" captions are recomputed. Runs are per minute. */
const CLOCK_MS = 30_000;

/** The next run of a scheduled prompt, said briefly, or why there is none. */
function nextCaption(schedule: string, now: Date): string {
  const parsed = parseCron(schedule);
  if (!parsed.ok) return parsed.error;
  const next = nextRun(parsed.cron, now);
  return next ? `next ${formatRun(next, now)}` : "never fires";
}

/** What a new-session prompt's project reads as, on its row and in the picker. */
const projectName = (project: string | null): string =>
  project ? repoLabel(project) : "active repo";

/** "new" is the add form; any other string is the id of the prompt being edited. */
type Editing = "new" | string | null;

/** Where a prompt goes, as the editor's first choice. Timed implies a new session. */
type Where = "here" | "new" | "timed";

/** Schedules most prompts want, one click from the cron field. */
const CRON_PRESETS: ReadonlyArray<readonly [label: string, cron: string]> = [
  ["Weekdays 9:00", "0 9 * * 1-5"],
  ["Daily 9:00", "0 9 * * *"],
  ["Mondays 9:00", "0 9 * * 1"],
  ["Hourly", "0 * * * *"],
];

const MODE_LABELS: Record<PromptMode, string> = {
  default: "default",
  acceptEdits: "edits",
  plan: "plan",
  bypassPermissions: "bypass",
};

/** A row of mutually exclusive buttons; `danger` tints one choice red when picked. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  danger,
}: {
  value: T;
  options: ReadonlyArray<readonly [value: T, label: string, title?: string]>;
  onChange: (value: T) => void;
  danger?: T;
}) {
  return (
    <div className="segmented prompt-form-segmented" role="radiogroup">
      {options.map(([option, label, title]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          data-active={value === option}
          data-danger={option === danger}
          title={title}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One labelled line of the editor's field grid. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="prompt-form-label">{label}</span>
      <div className="prompt-form-value">{children}</div>
    </>
  );
}

/**
 * The editor for one prompt, used both to add and to edit.
 *
 * A card: the label as its title, the text as its body, then one labelled row
 * per choice, each shown only when it means something for the choices above
 * it. Ctrl+Enter saves and Escape cancels, the same pair the commit box
 * answers to, so a prompt can be written without reaching for the mouse.
 */
function PromptEditor({
  initial,
  projects,
  onSave,
  onCancel,
}: {
  initial: QuickPromptDraft;
  projects: ProjectChoice[];
  onSave: (draft: QuickPromptDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textRef.current?.focus();
  }, []);
  // `schedule` and `at` are null when off, and a string (maybe still empty)
  // while on, so picking one does not need a valid value to show its field.
  // At most one is on: a cron replaces a one-off.
  const scheduled = draft.schedule !== null;
  const once = !scheduled && draft.at !== null;
  const timed = scheduled || once;
  const where: Where = timed ? "timed" : draft.newSession ? "new" : "here";
  // A follow-up goes to the session that asked for it, in that session's mode.
  const followUp = timed && draft.session !== null;
  const opensSession = where !== "here" && !followUp;

  const setWhere = (next: Where) => {
    if (next === where) return;
    setDraft({
      ...draft,
      newSession: next !== "here",
      schedule: next === "timed" ? "" : null,
      at: null,
    });
  };

  const cronHint = scheduled
    ? draft.schedule!.trim() === ""
      ? "minute hour day month weekday"
      : nextCaption(draft.schedule!, new Date())
    : "";
  const cronBad = scheduled && draft.schedule!.trim() !== "" && !parseCron(draft.schedule!).ok;
  const onceTime = once ? Date.parse(draft.at!) : NaN;
  const onceHint = Number.isNaN(onceTime)
    ? "pick a day and time"
    : onceTime <= Date.now()
      ? "in the past: runs as soon as it is saved"
      : `${formatRun(new Date(onceTime), new Date())}, late if mangouste was closed`;

  const canSave =
    normaliseDraft(draft) !== null &&
    !(scheduled && draft.schedule!.trim() === "") &&
    !(once && Number.isNaN(onceTime));
  const save = () => canSave && onSave(draft);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="prompt-form" onKeyDown={onKeyDown}>
      <input
        className="prompt-form-title"
        placeholder={deriveLabel(draft.text) || "Label (defaults to the first line)"}
        value={draft.label}
        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        spellCheck={false}
      />
      <textarea
        ref={textRef}
        className="prompt-form-text"
        rows={5}
        placeholder="What to send to the session"
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        spellCheck={false}
      />
      <div className="prompt-form-fields">
        <Field label="Runs">
          {followUp ? (
            <span className="prompt-form-note">
              Follow-up in session <code>{draft.session!.slice(0, 8)}</code>, in its own mode
            </span>
          ) : (
            <Segmented<Where>
              value={where}
              onChange={setWhere}
              options={[
                ["here", "This session", "Into the session in front"],
                ["new", "New session", "Always opens its own session"],
                ["timed", "Scheduled", "Opens a new session and sends, on its own"],
              ]}
            />
          )}
          {!timed && (
            <label className="prompt-form-check">
              <input
                type="checkbox"
                checked={draft.submit}
                onChange={(event) => setDraft({ ...draft, submit: event.target.checked })}
              />
              Send straight away, rather than leave it in the composer
            </label>
          )}
        </Field>

        {timed && (
          <Field label="When">
            <Segmented<"repeat" | "once">
              value={scheduled ? "repeat" : "once"}
              onChange={(next) =>
                setDraft({
                  ...draft,
                  schedule: next === "repeat" ? "" : null,
                  at: next === "once" ? "" : null,
                })
              }
              options={[
                ["repeat", "Repeat"],
                ["once", "Once"],
              ]}
            />
            {scheduled ? (
              <>
                <input
                  className="prompt-form-input prompt-form-mono"
                  placeholder="cron, e.g. 0 9 * * 1-5 or @daily"
                  value={draft.schedule!}
                  data-error={cronBad}
                  onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
                  spellCheck={false}
                />
                <div className="prompt-form-chips">
                  {CRON_PRESETS.map(([label, cron]) => (
                    <button
                      key={cron}
                      type="button"
                      className="prompt-form-chip"
                      data-active={draft.schedule!.trim() === cron}
                      onClick={() => setDraft({ ...draft, schedule: cron })}
                      title={cron}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="prompt-form-hint" data-error={cronBad}>
                  {cronHint} · only while mangouste is open
                </span>
              </>
            ) : (
              <>
                <input
                  type="datetime-local"
                  className="prompt-form-input"
                  value={draft.at ? toLocalInput(draft.at) : ""}
                  onChange={(event) =>
                    setDraft({ ...draft, at: fromLocalInput(event.target.value) ?? "" })
                  }
                />
                <span className="prompt-form-hint" data-error={Number.isNaN(onceTime)}>
                  {onceHint}
                </span>
              </>
            )}
          </Field>
        )}

        {opensSession && (
          <Field label="Repo">
            <select
              className="prompt-form-input"
              value={draft.project ?? ""}
              onChange={(event) => setDraft({ ...draft, project: event.target.value || null })}
              title="The repo the new session opens in"
            >
              <option value="">Active repo</option>
              {/* A saved repo that no scan finds any more stays pickable, rather
                  than the select silently showing "Active repo" over it. */}
              {draft.project && !projects.some((choice) => choice.path === draft.project) && (
                <option value={draft.project}>{projectName(draft.project)} (not found)</option>
              )}
              {projects.map((choice) => (
                <option key={choice.path} value={choice.path} title={choice.path}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {opensSession && (
          <Field label="Mode">
            <Segmented<PromptMode | "app">
              value={draft.permissionMode ?? "app"}
              danger="bypassPermissions"
              onChange={(next) => {
                const { permissionMode: _, ...rest } = draft;
                setDraft(next === "app" ? rest : { ...rest, permissionMode: next });
              }}
              options={[
                ["app", "app", "Whatever the app-wide permission mode is"],
                ...PROMPT_MODES.map((mode) => [mode, MODE_LABELS[mode]] as const),
              ]}
            />
            {draft.permissionMode === undefined && draft.origin !== null && timed && (
              <span className="prompt-form-hint">made by a session: runs in default, or plan</span>
            )}
          </Field>
        )}
      </div>
      <div className="prompt-form-footer">
        <span className="prompt-form-hint">Ctrl+Enter to save</span>
        <button type="button" className="toggle-button commit-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="toggle-button commit-button prompt-form-save"
          disabled={!canSave}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** Largest prompts file an import will read. */
const IMPORT_MAX_BYTES = 1024 * 1024;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Drafts read from a file, waiting for the user to look before they join the list. */
interface PendingImport {
  prompts: QuickPromptDraft[];
  /** One-offs left out because their time had passed. */
  expired: number;
}

/**
 * What an import will add, shown before it does. Timed prompts run on their
 * own once imported, so they are listed with when, and permission modes from
 * the file are dropped unless the box is ticked.
 */
function ImportPreview({
  pending,
  onImport,
  onCancel,
}: {
  pending: PendingImport;
  onImport: (keepModes: boolean) => void;
  onCancel: () => void;
}) {
  const [keepModes, setKeepModes] = useState(false);
  const withMode = pending.prompts.filter((prompt) => prompt.permissionMode);
  return (
    <div className="prompt-editor">
      <div className="prompt-editor-hint">
        Import {plural(pending.prompts.length, "prompt")}
        {pending.expired > 0 && `, skipping ${plural(pending.expired, "one-off")} already past`}:
      </div>
      <ul className="prompt-import-list">
        {/* The text and where it runs are on screen, not in a tooltip: the
            label is whatever the file says, and says nothing about either. */}
        {pending.prompts.map((prompt, at) => {
          const mode = importedMode(prompt, keepModes);
          return (
            <li key={at}>
              {prompt.label}
              {prompt.schedule && <span className="prompt-meta"> · {prompt.schedule}</span>}
              {prompt.at && <span className="prompt-meta"> · once</span>}
              {prompt.submit && <span className="prompt-meta"> · sends</span>}
              <span className="prompt-meta"> · {mode ? MODE_LABELS[mode] : "app mode"}</span>
              {prompt.project && <span className="prompt-meta"> · {repoLabel(prompt.project)}</span>}
              <div className="prompt-import-text" title={prompt.text}>
                {prompt.text}
              </div>
            </li>
          );
        })}
      </ul>
      {pending.prompts.some((prompt) => prompt.schedule || prompt.at) && (
        <div className="prompt-editor-hint">Scheduled ones start running as soon as they are imported.</div>
      )}
      {withMode.length > 0 && (
        <label className="prompt-editor-submit">
          <input type="checkbox" checked={keepModes} onChange={(event) => setKeepModes(event.target.checked)} />
          Keep their permission modes ({plural(withMode.length, "prompt")})
        </label>
      )}
      <div className="commit-actions">
        <button className="toggle-button commit-button" onClick={() => onImport(keepModes)}>
          Import
        </button>
        <button className="toggle-button commit-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One of the pane's lists, under a caption saying where its prompts go. */
function PromptGroup({
  title,
  detail,
  detailTitle,
  children,
}: {
  title: string;
  detail: string;
  detailTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="prompt-group">
      <div className="prompt-group-head" title={detailTitle}>
        <span className="prompt-group-title">{title}</span>
        <span className="prompt-group-detail">{detail}</span>
      </div>
      <div className="prompt-list">{children}</div>
    </section>
  );
}

/**
 * The Prompts rail view: one button per saved message.
 *
 * A click hands the prompt to the session in front, which puts it in its
 * composer (or sends it, for a prompt saved with "Send on click"). Adding,
 * editing, reordering and deleting all happen in place.
 */
export function QuickPromptsPane({ onRun, target, projects }: QuickPromptsPaneProps) {
  const menu = useMenu();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const [prompts, setPrompts] = useState<QuickPrompt[]>(readPrompts);
  const [editing, setEditing] = useState<Editing>(null);
  /** What the add form opens on: blank, or a copy of a prompt. */
  const [newInitial, setNewInitial] = useState<QuickPromptDraft>(EMPTY_DRAFT);
  /**
   * Bumped per open, as the add form's key. The editor reads `initial` once, so
   * Duplicate… while the form was already open changed nothing on screen.
   */
  const [newSeq, setNewSeq] = useState(0);
  const startNew = (initial: QuickPromptDraft) => {
    setConfirming(null);
    setNewInitial(initial);
    setNewSeq((seq) => seq + 1);
    setEditing("new");
  };
  const [importing, setImporting] = useState<PendingImport | null>(null);
  /** The last import or export that went wrong, or what it did. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The row asking "delete?", so one stray click on the bin deletes nothing. */
  const [confirming, setConfirming] = useState<string | null>(null);

  // Another window edited the list, or something in this one did: a session
  // scheduling a follow-up, a one-off removing itself once it ran. `storage`
  // only fires in the windows that did not write, hence the second event.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPTS_KEY) setPrompts(readPrompts());
    };
    const onChanged = () => setPrompts(readPrompts());
    window.addEventListener("storage", onStorage);
    window.addEventListener(PROMPTS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROMPTS_CHANGED_EVENT, onChanged);
    };
  }, []);

  const commit = useCallback((next: QuickPrompt[]) => {
    setPrompts(next);
    writePrompts(next);
  }, []);

  const saveDraft = (draft: QuickPromptDraft) => {
    commit(
      editing === "new" ? addPrompt(prompts, draft, newPromptId()) : updatePrompt(prompts, editing!, draft),
    );
    setEditing(null);
  };

  /** Whether a move would change what is on screen, for greying the menu row. */
  const canMove = (id: string, delta: -1 | 1): boolean =>
    movePrompt(prompts, id, delta).some((prompt, at) => prompt.id !== prompts[at].id);

  const rowMenu = (prompt: QuickPrompt): MenuEntry[] => [
    {
      label: isTimed(prompt) ? "Run Now" : prompt.submit ? "Send" : "Paste into Session",
      run: () => onRun(prompt),
    },
    !prompt.newSession && {
      label: "Run in a New Session",
      run: () => onRun({ ...prompt, newSession: true }),
    },
    "separator",
    { label: "Edit…", run: () => setEditing(prompt.id) },
    { label: "Duplicate…", run: () => startNew(duplicateDraft(prompt)) },
    {
      label: prompt.submit ? "Paste Only, Don't Send" : "Send on Click",
      run: () => commit(updatePrompt(prompts, prompt.id, { ...prompt, submit: !prompt.submit })),
    },
    { label: "Move Up", disabled: !canMove(prompt.id, -1), run: () => commit(movePrompt(prompts, prompt.id, -1)) },
    {
      label: "Move Down",
      disabled: !canMove(prompt.id, 1),
      run: () => commit(movePrompt(prompts, prompt.id, 1)),
    },
    "separator",
    { label: "Delete", danger: true, run: () => setConfirming(prompt.id) },
  ];

  const runExport = async () => {
    try {
      const path = await saveDialog({
        defaultPath: "mangouste-prompts.json",
        filters: [{ name: "Prompts", extensions: ["json"] }],
      });
      if (!path) return;
      // `write_text_file` only replaces a file that exists, so make it first;
      // one already there is the overwrite the save dialog asked about.
      const made = await createFile(path).then(
        () => true,
        (error) => {
          if (String(error) !== "already exists") throw error;
          return false;
        },
      );
      try {
        await writeTextFile(path, exportPrompts(prompts));
      } catch (error) {
        // An empty file left where the export should be reads as one that worked.
        if (made) await deletePath(path).catch(() => {});
        throw error;
      }
      setNotice(`Exported ${plural(prompts.length, "prompt")}.`);
    } catch (error) {
      setNotice(`Export failed: ${String(error)}`);
    }
  };

  const pickImport = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Prompts", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const parsed = parseImport(await readTextFile(path, IMPORT_MAX_BYTES), new Date());
      if (!parsed.ok) {
        setNotice(`Nothing imported: ${parsed.error}.`);
        return;
      }
      setNotice(null);
      setEditing(null);
      setImporting({ prompts: parsed.prompts, expired: parsed.expired });
    } catch (error) {
      setNotice(`Import failed: ${String(error)}`);
    }
  };

  const here = prompts.filter((prompt) => groupOf(prompt) === "here");
  const fresh = prompts.filter((prompt) => groupOf(prompt) === "new");
  const timed = prompts.filter((prompt) => groupOf(prompt) === "scheduled");

  const renderPrompt = (prompt: QuickPrompt) => {
    if (editing === prompt.id) {
      return (
        <PromptEditor
          key={prompt.id}
          initial={prompt}
          projects={projects}
          onSave={saveDraft}
          onCancel={() => setEditing(null)}
        />
      );
    }
    if (confirming === prompt.id) {
      return (
        <div key={prompt.id} className="prompt-button" data-confirming="true">
          <span className="prompt-label">Delete “{prompt.label}”?</span>
          <button
            className="toggle-button prompt-danger"
            onClick={() => {
              commit(removePrompt(prompts, prompt.id));
              setConfirming(null);
            }}
          >
            Delete
          </button>
          <button className="toggle-button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      );
    }
    const Glyph = isTimed(prompt) ? ClockIcon : prompt.submit ? SendIcon : PasteIcon;
    const when = whenCaption(prompt, now);
    const where = prompt.session
      ? `its session ${prompt.session.slice(0, 8)}`
      : projectName(prompt.project);
    return (
      <div
        key={prompt.id}
        className="prompt-button"
        role="button"
        tabIndex={0}
        data-submit={prompt.submit}
        onClick={() => onRun(prompt)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onRun(prompt);
          }
        }}
        onContextMenu={(event) => menu.openContextMenu(event, rowMenu(prompt))}
        title={
          isTimed(prompt)
            ? `Runs ${prompt.schedule ? `on “${prompt.schedule}”` : "once"} (${when}), ${
                prompt.session ? `as a follow-up in ${where}` : `in a new session in ${where}`
              }. Click to run now:\n${prompt.text}`
            : `${prompt.submit ? "Sends" : "Pastes, doesn't send"}${
                prompt.newSession ? `, in a new session in ${projectName(prompt.project)}` : ""
              }:\n${prompt.text}`
        }
      >
        <Glyph className="prompt-glyph" />
        <span className="prompt-label">{prompt.label}</span>
        {prompt.newSession && (
          <span className="prompt-meta">
            {when ? `${when} · ` : ""}
            {where}
          </span>
        )}
        <div className="prompt-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="toggle-button icon-button"
            onClick={() => {
              setConfirming(null);
              setEditing(prompt.id);
            }}
            title="Edit"
          >
            <PencilIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => setConfirming(prompt.id)}
            title="Delete"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div className="pane-header">
        <QuickPromptsIcon />
        <span className="pane-title">Prompts</span>
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => startNew(EMPTY_DRAFT)}
            title="New prompt"
          >
            <PlusIcon />
          </button>
          <button
            className="toggle-button icon-button"
            title="More prompt actions"
            onClick={(event) => {
              const at = event.currentTarget.getBoundingClientRect();
              menu.openMenu({
                items: [
                  { label: "Import Prompts…", run: () => void pickImport() },
                  { label: "Export Prompts…", disabled: prompts.length === 0, run: () => void runExport() },
                ],
                x: at.left,
                y: at.bottom + 2,
              });
            }}
          >
            <OverflowIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        {notice && (
          <div className="prompt-notice" onClick={() => setNotice(null)} title="Dismiss">
            {notice}
          </div>
        )}
        {importing && (
          <ImportPreview
            pending={importing}
            onImport={(keepModes) => {
              const next = importPrompts(prompts, importing.prompts, keepModes, newPromptId, MAX_TIMED);
              const added = next.length - prompts.length;
              const capped = importing.prompts.length - added;
              commit(next);
              setNotice(
                `Imported ${plural(added, "prompt")}` +
                  (capped > 0 ? `; ${plural(capped, "timed one")} left out, ${MAX_TIMED} is the most held.` : "."),
              );
              setImporting(null);
            }}
            onCancel={() => setImporting(null)}
          />
        )}
        {editing === "new" && (
          <PromptEditor
            key={newSeq}
            initial={newInitial}
            projects={projects}
            onSave={saveDraft}
            onCancel={() => setEditing(null)}
          />
        )}
        {prompts.length === 0 && editing !== "new" && !importing && (
          <div className="empty-note">
            No prompts yet. Save a message you keep typing, then send it to the session in front
            with one click.
            <div>
              <button className="toggle-button commit-button" onClick={() => startNew(EMPTY_DRAFT)}>
                <PlusIcon /> New prompt
              </button>
              <button className="toggle-button commit-button" onClick={() => void pickImport()}>
                Import…
              </button>
            </div>
          </div>
        )}
        {here.length > 0 && (
          <PromptGroup
            title="This session"
            detail={target ?? "none open, starts one"}
            detailTitle={target ? `Pastes into “${target}”` : "No session in front: a click starts one"}
          >
            {here.map(renderPrompt)}
          </PromptGroup>
        )}
        {fresh.length > 0 && (
          <PromptGroup title="New session" detail="opens its own">
            {fresh.map(renderPrompt)}
          </PromptGroup>
        )}
        {timed.length > 0 && (
          <PromptGroup
            title="Scheduled"
            detail="while mangouste is open"
            detailTitle="Each run opens a new session and sends. Runs missed while the app was closed or asleep are skipped."
          >
            {timed.map(renderPrompt)}
          </PromptGroup>
        )}
      </div>
    </div>
  );
}
