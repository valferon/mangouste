import { useCallback, useEffect, useRef, useState } from "react";
import { formatRun, nextRun, parseCron } from "../lib/cron";
import {
  ClockIcon,
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
  groupOf,
  isTimed,
  movePrompt,
  newPromptId,
  normaliseDraft,
  PROMPTS_CHANGED_EVENT,
  PROMPTS_KEY,
  readPrompts,
  removePrompt,
  updatePrompt,
  writePrompts,
  type QuickPrompt,
  type QuickPromptDraft,
} from "../lib/quickPrompts";
import { whenCaption } from "../lib/sessionControl";

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

/**
 * The editor for one prompt, used both to add and to edit.
 *
 * Ctrl+Enter saves and Escape cancels, the same pair the commit box answers to,
 * so a prompt can be written without reaching for the mouse.
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
  // `schedule` is null when the box is off, and a string (maybe still empty)
  // while it is on, so ticking it does not need a valid cron to show the field.
  const scheduled = draft.schedule !== null;
  const scheduleHint = scheduled
    ? draft.schedule!.trim() === ""
      ? "minute hour day month weekday, e.g. 0 9 * * 1-5"
      : nextCaption(draft.schedule!, new Date())
    : null;
  const canSave =
    normaliseDraft(draft) !== null && !(scheduled && draft.schedule!.trim() === "");
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
    <div className="prompt-editor" onKeyDown={onKeyDown}>
      <input
        className="prompt-editor-label"
        placeholder="Button label (defaults to the first line)"
        value={draft.label}
        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        spellCheck={false}
      />
      <textarea
        ref={textRef}
        className="commit-message prompt-editor-text"
        rows={4}
        placeholder="What to paste into the session"
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        spellCheck={false}
      />
      <label className="prompt-editor-submit">
        <input
          type="checkbox"
          checked={draft.submit || scheduled}
          disabled={scheduled}
          onChange={(event) => setDraft({ ...draft, submit: event.target.checked })}
        />
        Send on click
      </label>
      <label className="prompt-editor-submit">
        <input
          type="checkbox"
          checked={draft.newSession || scheduled}
          disabled={scheduled}
          onChange={(event) => setDraft({ ...draft, newSession: event.target.checked })}
        />
        Always in a new session
      </label>
      <label className="prompt-editor-submit">
        <input
          type="checkbox"
          checked={scheduled}
          onChange={(event) => setDraft({ ...draft, schedule: event.target.checked ? "" : null })}
        />
        On a schedule
      </label>
      {scheduled && (
        <>
          <input
            className="prompt-editor-label prompt-editor-cron"
            placeholder="cron, e.g. 0 9 * * 1-5 or @daily"
            value={draft.schedule!}
            onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
            spellCheck={false}
          />
          <div
            className="prompt-editor-hint"
            data-error={draft.schedule!.trim() !== "" && !parseCron(draft.schedule!).ok}
          >
            {scheduleHint} · only while mangouste is open
          </div>
        </>
      )}
      {(draft.newSession || scheduled) && (
        <select
          className="prompt-editor-label"
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
      )}
      <div className="commit-actions">
        <button
          className="toggle-button commit-button"
          disabled={!canSave}
          onClick={save}
          title="Save (Ctrl+Enter)"
        >
          Save
        </button>
        <button className="toggle-button commit-button" onClick={onCancel} title="Cancel (Escape)">
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
            onClick={() => {
              setConfirming(null);
              setEditing("new");
            }}
            title="New prompt"
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        {editing === "new" && (
          <PromptEditor
            initial={EMPTY_DRAFT}
            projects={projects}
            onSave={saveDraft}
            onCancel={() => setEditing(null)}
          />
        )}
        {prompts.length === 0 && editing !== "new" && (
          <div className="empty-note">
            No prompts yet. Save a message you keep typing, then send it to the session in front
            with one click.
            <div>
              <button className="toggle-button commit-button" onClick={() => setEditing("new")}>
                <PlusIcon /> New prompt
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
