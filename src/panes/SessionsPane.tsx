import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  expandSearchTerms,
  listSessions,
  onSessionsChanged,
  revealPath,
  searchSessions,
  sessionRecap,
} from "../lib/ipc";

import {
  ArchiveIcon,
  BranchIcon,
  ChevronRightIcon,
  ClearIcon,
  CommitIcon,
  DeepSearchIcon,
  MarkAllReadIcon,
  PencilIcon,
  PinIcon,
  ReadToggleIcon,
  RecapIcon,
  RefreshIcon,
  RepoIcon,
  SearchIcon,
  StatusGlyph,
  SubagentGlyph,
  UnarchiveIcon,
  UnpinIcon,
  UnreadToggleIcon,
  WorkflowGlyph,
} from "../lib/icons";
import { copyText } from "../lib/editing";
import { CHORD } from "../lib/keybindings";
import { markTerms } from "../lib/marks";
import { useMenu, type MenuEntry } from "../lib/menu";
import { recapFileLabel, recapHeadline } from "../lib/recap";
import { useFlags } from "../lib/sessionFlagsContext";
import { pinnedFirst } from "../lib/sessionStore";
import type {
  ProjectGroup,
  RunningAgent,
  SessionHit,
  SessionMeta,
  SessionRecap,
  SessionStatus,
} from "../lib/types";

interface SessionsPaneProps {
  /** Session currently attached to the chat pane, highlighted in the list. */
  activeSessionId: string | null;
  /**
   * Open a session. `anchor` is a byte offset into its transcript, from a search
   * hit: the pane it opens hydrates the conversation around that record instead
   * of the tail, which is the difference between finding a match and reading it.
   */
  onResume: (session: SessionMeta, anchor?: number) => void;
  onNewSession: (cwd: string) => void;
  /** Clicking a group label switches the sidebars to that repo. */
  onSelectRepo: (cwd: string) => void;
  /** Repo currently shown in the other panes, highlighted in the list. */
  activeCwd: string | null;
  /** Lifts the scanned groups so the quick-open palette can reuse them. */
  onGroups: (groups: ProjectGroup[]) => void;
  /** Open a file a recap lists, so "what was done" is one click from the work. */
  onOpenFile: (path: string) => void;
}

/**
 * Recency ramp for the badge column, in minutes.
 *
 * A size ramp rather than a colour one, and in the badge slot rather than the
 * glyph slot: the glyph already carries status, and only the recent handful of
 * rows should carry a square at all.
 */
const HEAT_CUTOFF_MINUTES = [20, 120, 480];
const HEAT_BADGES = ["■", "▪", "▫"];
const HEAT_TOOLTIPS = ["Worked in just now", "Worked in recently", "Worked in earlier today"];

function shortAge(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Heat step for a session, or -1 for the cold tail that gets no badge.
 *
 * Keyed on the conversational watermark like the age label: opening a session
 * rewrites its log without adding conversation, and that must not re-light it.
 */
function heatLevel(session: SessionMeta): number {
  const ageMinutes = (Date.now() - session.lastActivityMs) / 60_000;
  const step = HEAT_CUTOFF_MINUTES.findIndex((cutoff) => ageMinutes < cutoff);
  return step;
}

/* ---------- search ---------- */
//
// Three rungs, cheapest first, because they answer different questions:
//
//   1. Filter the scanned metadata — instant, and enough whenever you remember
//      roughly what the session was called.
//   2. Grep inside the transcripts — an explicit Enter, because it sweeps the
//      whole corpus. This is the rung that finds the words you actually said.
//   3. Ask Haiku for other words you might have used, then re-run rung 2 over
//      them. For when you remember the problem but not the wording.
//
// Nothing escalates silently except rung 2 when rung 1 found nothing at all:
// the point of a filter box is that typing in it stays free.

/** What the transcript search found, and what question it answers. */
interface DeepSearch {
  /** Trimmed query these hits belong to; stale results are ignored, not shown. */
  query: string;
  /** `literal` — the words as typed. `haiku` — the model's guesses at them. */
  mode: "literal" | "haiku";
  /** Terms actually sent to Rust, so the UI can say what it looked for. */
  terms: string[];
  hits: Map<string, SessionHit>;
}

/** Below this a query is too short for the corpus sweep to mean anything. */
const AUTO_DEEP_MIN_CHARS = 3;

/** Settle time before an empty metadata filter escalates on its own. */
const AUTO_DEEP_DELAY_MS = 450;

/** Cap on rows returned by a transcript sweep. */
const DEEP_SEARCH_LIMIT = 300;

/**
 * Split a query into lowercase terms, keeping `"quoted phrases"` whole.
 *
 * Mirrors `search_terms` in `src-tauri/src/sessions.rs` so the same query means
 * the same thing on both rungs — a phrase that narrows the local filter must not
 * widen the transcript sweep.
 */
function queryTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query) {
    if (char === '"') {
      quoted = !quoted;
      if (!quoted && current) {
        terms.push(current);
        current = "";
      }
    } else if (!quoted && /\s/.test(char)) {
      if (current) {
        terms.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) terms.push(current);
  return terms.map((term) => term.toLowerCase());
}

/**
 * Everything about a session the local filter can see.
 *
 * The repo label and cwd are in here on purpose: "flux auth" should find the
 * auth session in the flux repo, which is how you remember it, even though the
 * repo is a property of the row's parent rather than of the row.
 */
function sessionHaystack(session: SessionMeta, group: ProjectGroup): string {
  const parts: (string | null)[] = [
    session.title,
    session.lastPrompt,
    session.id,
    session.gitBranch,
    session.model,
    session.status,
    group.label,
    group.cwd,
  ];
  for (const agent of session.runningAgents ?? []) {
    parts.push(agent.description, agent.agentType);
  }
  for (const workflow of session.runningWorkflows ?? []) {
    parts.push(workflow.name, workflow.phase);
    for (const agent of workflow.agents) parts.push(agent.description, agent.agentType);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** AND across terms: a longer query must narrow the list, never widen it. */
function matchesTerms(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/**
 * Group header summary: total, then only the states worth naming.
 *
 * `active`, `pendingReview` and `awaiting` are the three answers to "is anything
 * happening here and does it want me"; the rest is carried by the row glyphs.
 */
function groupSummary(statuses: SessionStatus[]): string {
  const count = (status: SessionStatus) => statuses.filter((s) => s === status).length;
  const parts = [String(statuses.length)];
  const live = count("active");
  const needsYou = count("awaiting");
  const review = count("pendingReview");
  if (live > 0) parts.push(`${live} live`);
  if (needsYou > 0) parts.push(`${needsYou} asking`);
  if (review > 0) parts.push(`${review} review`);
  return parts.join(" · ");
}

/* ---------- recap ---------- */

/**
 * One session's recap, as the pane holds it.
 *
 * `recap` and `loading` are independent on purpose: re-opening a row re-reads
 * the transcript, and showing the last answer while the new one is fetched beats
 * blanking a panel that is about to say almost the same thing.
 */
interface RecapState {
  recap: SessionRecap | null;
  loading: boolean;
  error: string | null;
}

/**
 * What a session did, under its row.
 *
 * Every line here is mined from tool calls rather than from prose, which is the
 * whole point: an assistant saying "I've updated the rail" is a claim, and
 * `Edit src/rail.tsx` twice followed by `[main 9f3c1aa]` is the record. Ordered
 * by how much each line settles "is this the session I am looking for" —
 * commits, then the ask, then the files.
 */
const RecapBlock = memo(function RecapBlock({
  state,
  cwd,
  onOpenFile,
}: {
  state: RecapState | undefined;
  /** The session's own repo, so paths inside it can be written relatively. */
  cwd: string | null;
  onOpenFile: (path: string) => void;
}) {
  const recap = state?.recap ?? null;
  if (!recap) {
    return (
      <div className="recap">
        <div className="recap-note">
          {state?.error ? `could not read the transcript: ${state.error}` : "reading it…"}
        </div>
      </div>
    );
  }
  const commitLabel =
    recap.commitCount > recap.commits.length
      ? `last ${recap.commits.length} of ${recap.commitCount} commits`
      : recap.commitCount === 1
        ? "commit"
        : "commits";
  const fileLabel =
    recap.fileCount > recap.files.length
      ? `top ${recap.files.length} of ${recap.fileCount} files`
      : recap.fileCount === 1
        ? "file changed"
        : "files changed";
  return (
    <div className="recap">
      <div className="recap-head">
        <span className="recap-headline">{recapHeadline(recap)}</span>
        {state?.loading && <span className="recap-note">re-reading…</span>}
        {recap.truncated && (
          <span
            className="recap-note"
            title="The transcript is longer than the scan cap, so this covers the start of it."
          >
            partial
          </span>
        )}
      </div>

      {recap.firstPrompt && (
        <div className="recap-line" title={recap.firstPrompt}>
          <span className="recap-label">asked</span>
          <span className="recap-value">{recap.firstPrompt}</span>
        </div>
      )}
      {/* Only when it differs: a one-turn session would otherwise print the same
          sentence twice under two different labels. */}
      {recap.lastPrompt && recap.lastPrompt !== recap.firstPrompt && (
        <div className="recap-line" title={recap.lastPrompt}>
          <span className="recap-label">then</span>
          <span className="recap-value">{recap.lastPrompt}</span>
        </div>
      )}
      {recap.branches.length > 0 && (
        <div className="recap-line" title={recap.branches.join("\n")}>
          <span className="recap-label">
            <BranchIcon />
          </span>
          <span className="recap-value">{recap.branches.join(", ")}</span>
        </div>
      )}

      {recap.commits.length > 0 && (
        <>
          <div className="recap-section">{commitLabel}</div>
          {recap.commits.map((commit) => (
            <div
              key={commit.sha}
              className="recap-row"
              title={`${commit.sha} on ${commit.branch}\n${commit.subject}\n\nClick to copy the sha.`}
              onClick={() => void copyText(commit.sha)}
            >
              <CommitIcon className="recap-glyph" />
              <span className="recap-sha">{commit.sha.slice(0, 7)}</span>
              <span className="recap-value">{commit.subject}</span>
            </div>
          ))}
        </>
      )}

      {recap.files.length > 0 && (
        <>
          <div className="recap-section">{fileLabel}</div>
          {recap.files.map((file) => (
            <div
              key={file.path}
              className="recap-row"
              data-written={file.written || undefined}
              title={[
                file.path,
                `${file.changes} change${file.changes === 1 ? "" : "s"}`,
                file.written ? "written whole at least once" : null,
                "Click to open it.",
              ]
                .filter(Boolean)
                .join("\n")}
              onClick={() => onOpenFile(file.path)}
            >
              <PencilIcon className="recap-glyph" />
              <span className="recap-value">{recapFileLabel(file.path, cwd)}</span>
              <span className="recap-count">×{file.changes}</span>
            </div>
          ))}
        </>
      )}

      {recap.agents.length > 0 && (
        <>
          <div className="recap-section">
            {recap.agentCount === 1 ? "fan-out" : `${recap.agentCount} fan-outs`}
          </div>
          {recap.agents.map((agent) => (
            <div
              key={agent.agentType}
              className="recap-row"
              title={[agent.agentType, agent.description].filter(Boolean).join("\n")}
            >
              <SubagentGlyph running={false} className="recap-glyph" />
              <span className="recap-value">
                {agent.agentType}
                {agent.description && <span className="dim"> — {agent.description}</span>}
              </span>
              <span className="recap-count">×{agent.count}</span>
            </div>
          ))}
        </>
      )}

      {recap.tools.length > 0 && (
        <div
          className="recap-line"
          title={recap.tools.map((tool) => `${tool.name} ${tool.count}`).join("\n")}
        >
          <span className="recap-label">tools</span>
          <span className="recap-value">
            {recap.tools.map((tool) => `${tool.name} ${tool.count}`).join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
});

/**
 * Every Claude Code session on the machine, grouped by repo.
 *
 * This is the pane that removes the one-window-per-repo problem: the list is
 * global, so a session running in another repo stays visible while you work here.
 * The Rust watcher pushes `sessions://changed`, and a slow interval covers the
 * status field, which ages out on a timer rather than on a file event.
 *
 * Rows are one line each, with live subagent and workflow fan-outs nested under
 * their session. Read, archive and pin state is an overlay in `sessionStore`,
 * not a fact about the transcript.
 */
export const SessionsPane = memo(function SessionsPane({
  activeSessionId,
  onResume,
  onNewSession,
  onSelectRepo,
  activeCwd,
  onGroups,
  onOpenFile,
}: SessionsPaneProps) {
  const menu = useMenu();
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  /** Only holds groups the user collapsed by hand; everything starts open. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Idle is >24h stale and dominates the list, so it is collapsed away by default. */
  const [showIdle, setShowIdle] = useState(false);
  const [onlyLive, setOnlyLive] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /**
   * Per-session override for the fan-out list.
   *
   * The default is "open whenever anything is running under it", which is what
   * you want without asking; this only holds sessions where you disagreed.
   */
  const [fanoutOverride, setFanoutOverride] = useState<Map<string, boolean>>(new Map());
  /** Free-text filter. Empty means the standing toggles alone decide the rows. */
  const [query, setQuery] = useState("");
  const [deep, setDeep] = useState<DeepSearch | null>(null);
  /** Which rung is running, so the note line can name it. */
  const [deepBusy, setDeepBusy] = useState<"literal" | "haiku" | null>(null);
  const [deepError, setDeepError] = useState<string | null>(null);
  /** Sessions whose recap is open, and what has been read for each. */
  const [recapOpen, setRecapOpen] = useState<Set<string>>(new Set());
  const [recaps, setRecaps] = useState<Map<string, RecapState>>(new Map());

  const flags = useFlags();

  /** Guards against overlapping scans when watcher events arrive in bursts. */
  const inFlight = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Latest query, so a sweep that lands late can tell it has been superseded. */
  const queryRef = useRef("");
  /** Query the auto-escalation already fired for; it fires once per query. */
  const autoRan = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const scanned = await listSessions();
      setGroups(scanned);
      onGroups(scanned);
    } catch {
      setGroups([]);
    } finally {
      inFlight.current = false;
    }
  }, [onGroups]);

  useEffect(() => {
    void refresh();
    const unlisten = onSessionsChanged(() => void refresh());
    // Status decays with wall-clock time, so poll independently of file events.
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      void unlisten.then((fn) => fn());
      window.clearInterval(timer);
    };
  }, [refresh]);

  // The session you are watching cannot be pending your review. Marked passive:
  // "its pane is open" is weaker evidence than a deliberate open, so it must not
  // clear an explicit "mark unread".
  useEffect(() => {
    if (!activeSessionId) return;
    for (const group of groups) {
      const open = group.sessions.find((session) => session.id === activeSessionId);
      if (open) {
        flags.markSeen(open, { passive: true });
        return;
      }
    }
  }, [activeSessionId, groups, flags]);

  const terms = useMemo(() => queryTerms(query), [query]);
  const searching = terms.length > 0;

  /** One searchable string per session, rebuilt only when a scan lands. */
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const session of group.sessions) {
        map.set(session.id, sessionHaystack(session, group));
      }
    }
    return map;
  }, [groups]);

  /**
   * Transcript hits, but only while they still answer the query in the box.
   *
   * Gated rather than cleared, so editing a query back to what it was reuses the
   * sweep instead of paying for it twice.
   */
  const activeHits = useMemo(
    () => (deep && deep.query === query.trim() ? deep.hits : null),
    [deep, query],
  );

  /** Sessions the metadata filter alone matched — rung one, and what decides
      whether rung two escalates on its own. */
  const localCount = useMemo(() => {
    if (!searching) return 0;
    let count = 0;
    for (const [, haystack] of haystacks) {
      if (matchesTerms(haystack, terms)) count += 1;
    }
    return count;
  }, [haystacks, terms, searching]);

  const visible = useMemo(() => {
    const keep = (session: SessionMeta) => {
      // A query overrides the standing toggles, archived and idle included: the
      // row hidden because it is old is exactly the row a search is for.
      if (searching) {
        return (
          matchesTerms(haystacks.get(session.id) ?? "", terms) ||
          activeHits?.has(session.id) === true
        );
      }
      // A pin is the standing answer to every one of these questions: it is
      // what you say about the session you want to find without remembering it.
      if (flags.isPinned(session.id)) return true;
      if (flags.isArchived(session.id) && !showArchived) return false;
      const status = flags.effectiveStatus(session);
      if (onlyLive) return status === "active" || status === "awaiting";
      return showIdle || status !== "idle";
    };
    return groups
      .map((group) => ({
        ...group,
        sessions: pinnedFirst(group.sessions.filter(keep), flags.isPinned),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [
    groups,
    onlyLive,
    showIdle,
    showArchived,
    flags,
    searching,
    terms,
    haystacks,
    activeHits,
  ]);

  /** Rows the query actually produced, for the header count. */
  const matchedCount = useMemo(
    () => visible.reduce((total, group) => total + group.sessions.length, 0),
    [visible],
  );

  /** Every scanned session, archived included — `tally.total` excludes those,
      and a search that matches an archived row must not read as 5/3. */
  const totalSessions = useMemo(
    () => groups.reduce((total, group) => total + group.sessions.length, 0),
    [groups],
  );

  /**
   * Run a transcript sweep. `haiku` first asks the model for other words the
   * session might have used, then sweeps those with OR semantics — the model
   * proposes terms and never decides what matches.
   */
  const runDeep = useCallback(
    async (mode: "literal" | "haiku") => {
      const raw = query.trim();
      if (!raw) return;
      setDeepBusy(mode);
      setDeepError(null);
      try {
        let sent = raw;
        let sentTerms = [raw];
        let anyTerm = false;
        if (mode === "haiku") {
          const expanded = await expandSearchTerms(raw);
          if (expanded.length === 0) {
            setDeepError("Haiku suggested no usable terms");
            return;
          }
          sentTerms = expanded;
          // Quoted, because an expansion is routinely a two-word phrase and an
          // unquoted one would be split into two independent terms.
          sent = expanded.map((term) => `"${term}"`).join(" ");
          anyTerm = true;
        }
        const hits = await searchSessions(sent, anyTerm, DEEP_SEARCH_LIMIT);
        // The box may have moved on while the corpus was being swept; a result
        // set for a query nobody is asking any more is dropped, not shown.
        if (queryRef.current.trim() !== raw) return;
        setDeep({
          query: raw,
          mode,
          terms: sentTerms,
          hits: new Map(hits.map((hit) => [hit.id, hit])),
        });
      } catch (error) {
        setDeepError(String(error));
      } finally {
        setDeepBusy(null);
      }
    },
    [query],
  );

  useEffect(() => {
    queryRef.current = query;
    setDeepError(null);
  }, [query]);

  // Escalate on the pane's behalf only when rung one found literally nothing:
  // typing in a filter box has to stay free, but a filter box that shows an
  // empty list while the words are sitting in a transcript is just wrong.
  useEffect(() => {
    const raw = query.trim();
    if (raw.length < AUTO_DEEP_MIN_CHARS) return;
    if (localCount > 0 || deepBusy || autoRan.current === raw) return;
    if (deep?.query === raw) return;
    const timer = window.setTimeout(() => {
      autoRan.current = raw;
      void runDeep("literal");
    }, AUTO_DEEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, localCount, deep, deepBusy, runDeep]);

  /**
   * Header tallies, counted over unarchived sessions only.
   *
   * Archiving a row is a statement that it should stop asking for attention, so
   * it would be perverse for it to keep contributing to the counts.
   */
  const tally = useMemo(() => {
    let live = 0;
    let needsYou = 0;
    let review = 0;
    let total = 0;
    for (const group of groups) {
      for (const session of group.sessions) {
        if (flags.isArchived(session.id)) continue;
        total += 1;
        const status = flags.effectiveStatus(session);
        if (status === "active" || status === "awaiting") live += 1;
        if (status === "awaiting") needsYou += 1;
        if (status === "pendingReview") review += 1;
      }
    }
    return { live, needsYou, review, total };
  }, [groups, flags]);

  // Keep the attached session visible when it changes out from under the scroll.
  useEffect(() => {
    if (!activeSessionId) return;
    // Qualified: the repo row above carries `data-selected` too and comes first
    // in document order, so the bare selector scrolled the group header into
    // view and left the session row wherever it already was.
    bodyRef.current
      ?.querySelector('.session-row[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSessionId, groups]);

  const toggleGroup = (dirName: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });

  const toggleFanout = (id: string, openByDefault: boolean) =>
    setFanoutOverride((current) => {
      const next = new Map(current);
      next.set(id, !(current.get(id) ?? openByDefault));
      return next;
    });

  const openSession = useCallback(
    (session: SessionMeta, anchor?: number) => {
      flags.markSeen(session);
      onResume(session, anchor);
    },
    [flags, onResume],
  );

  /**
   * The words the sweep actually looked for, which is what a snippet paints.
   *
   * Not `terms`, and not `deep.terms` either: a literal sweep is sent the raw
   * query as one string and splits it in Rust, so `deep.terms` there is the
   * whole query — highlighting with it would find nothing in a two-word search.
   * `queryTerms` is the same split Rust performs, which is what makes the marks
   * land on exactly what matched.
   */
  const hitTerms = useMemo(() => {
    if (!deep) return terms;
    return deep.mode === "haiku" ? deep.terms : queryTerms(deep.query);
  }, [deep, terms]);

  const loadRecap = useCallback(async (session: SessionMeta) => {
    setRecaps((current) => {
      const next = new Map(current);
      next.set(session.id, {
        recap: current.get(session.id)?.recap ?? null,
        loading: true,
        error: null,
      });
      return next;
    });
    try {
      const recap = await sessionRecap(session.file);
      setRecaps((current) => new Map(current).set(session.id, { recap, loading: false, error: null }));
    } catch (error) {
      setRecaps((current) => {
        const next = new Map(current);
        next.set(session.id, {
          recap: current.get(session.id)?.recap ?? null,
          loading: false,
          error: String(error),
        });
        return next;
      });
    }
  }, []);

  const toggleRecap = useCallback(
    (session: SessionMeta) => {
      const open = recapOpen.has(session.id);
      setRecapOpen((current) => {
        const next = new Set(current);
        if (open) next.delete(session.id);
        else next.add(session.id);
        return next;
      });
      // Re-read on every open rather than once: the Rust scan resumes from a
      // byte offset, so a session that has said more since costs only its new
      // bytes and one that has not costs nothing at all.
      if (!open) void loadRecap(session);
    },
    [recapOpen, loadRecap],
  );

  /** The pane's own toggles, ending every menu in here. */
  const paneEntries = useCallback(
    (): MenuEntry[] => [
      { label: "Refresh", run: () => void refresh() },
      "separator",
      { label: "Only Live Sessions", checked: onlyLive, run: () => setOnlyLive((v) => !v) },
      { label: "Include Idle", checked: showIdle, run: () => setShowIdle((v) => !v) },
      {
        label: `Include Archived (${flags.archivedCount})`,
        checked: showArchived,
        run: () => setShowArchived((v) => !v),
      },
      "separator",
      {
        label: "Mark All as Read",
        run: () => flags.markAllSeen(groups.flatMap((group) => group.sessions)),
      },
    ],
    [refresh, onlyLive, showIdle, showArchived, flags, groups],
  );

  const sessionMenu = useCallback(
    (session: SessionMeta): MenuEntry[] => {
      const archived = flags.isArchived(session.id);
      const pinned = flags.isPinned(session.id);
      const unread = flags.isMarkedUnread(session.id);
      const cwd = session.cwd ?? "";
      return [
        { header: session.title ?? session.id },
        { label: "Open Session", run: () => openSession(session) },
        cwd && { label: "Switch to this Repo", run: () => onSelectRepo(cwd) },
        cwd && {
          label: "New Session in this Repo",
          accelerator: CHORD.newSession,
          run: () => onNewSession(cwd),
        },
        "separator",
        {
          label: unread ? "Mark as Read" : "Mark as Unread",
          run: () => (unread ? flags.markSeen(session) : flags.markUnread(session.id)),
        },
        {
          label: pinned ? "Unpin" : "Pin to Top",
          run: () => flags.setPinned(session.id, !pinned),
        },
        {
          label: archived ? "Unarchive" : "Archive",
          run: () => flags.setArchived(session.id, !archived),
        },
        "separator",
        {
          label: recapOpen.has(session.id) ? "Hide What Was Done" : "What Was Done",
          run: () => toggleRecap(session),
        },
        { label: "Copy Session Id", run: () => void copyText(session.id) },
        session.title && { label: "Copy Title", run: () => void copyText(session.title ?? "") },
        cwd && { label: "Copy Working Directory", run: () => void copyText(cwd) },
        session.file && {
          label: "Reveal Transcript",
          run: () => void revealPath(session.file),
        },
        "separator",
        ...paneEntries(),
      ];
    },
    [flags, openSession, onSelectRepo, onNewSession, paneEntries, recapOpen, toggleRecap],
  );

  const repoMenu = useCallback(
    (group: ProjectGroup): MenuEntry[] => [
      { header: group.cwd },
      { label: "Switch to this Repo", run: () => onSelectRepo(group.cwd) },
      {
        label: "New Session in this Repo",
        accelerator: CHORD.newSession,
        run: () => onNewSession(group.cwd),
      },
      {
        label: collapsed.has(group.dirName) ? "Expand" : "Collapse",
        run: () => toggleGroup(group.dirName),
      },
      "separator",
      { label: "Copy Path", run: () => void copyText(group.cwd) },
      { label: "Reveal in File Manager", run: () => void revealPath(group.cwd) },
      "separator",
      ...paneEntries(),
    ],
    [onSelectRepo, onNewSession, collapsed, paneEntries],
  );

  const agentRow = (agent: RunningAgent, session: SessionMeta, nested: boolean) => (
    <div
      key={agent.id}
      className="subagent-row"
      data-nested={nested}
      onClick={() => openSession(session)}
      title={[
        agent.description || "(no description)",
        `type: ${agent.agentType}`,
        `last write ${shortAge(agent.mtimeMs)} ago`,
        agent.filePath,
      ].join("\n")}
    >
      <SubagentGlyph running />
      <span className="title">{agent.description || agent.agentType}</span>
      {agent.description && <span className="agent-type">{agent.agentType}</span>}
    </div>
  );

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div
        className="pane-header"
        onContextMenu={(event) => menu.openContextMenu(event, paneEntries())}
      >
        <span>Sessions</span>
        <span
          className="count"
          title={
            searching
              ? `${matchedCount} of ${totalSessions} sessions match`
              : `${tally.needsYou} asking · ${tally.review} to review · ${tally.live} live · ${tally.total} total`
          }
        >
          {searching ? (
            `${matchedCount}/${totalSessions}`
          ) : (
            <>
              {tally.needsYou > 0 && <b>{tally.needsYou}? </b>}
              {tally.review > 0 && `${tally.review}rev `}
              {tally.live}/{tally.total}
            </>
          )}
        </span>
        <div className="actions">
          <button
            className="toggle-button"
            data-active={onlyLive}
            onClick={() => setOnlyLive((v) => !v)}
            title="Show only active or awaiting sessions"
          >
            live
          </button>
          <button
            className="toggle-button"
            data-active={showIdle}
            onClick={() => setShowIdle((v) => !v)}
            title="Include sessions idle for over a day"
          >
            idle
          </button>
          <button
            className="toggle-button icon-button"
            data-active={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            title={`Include archived sessions (${flags.archivedCount})`}
          >
            <ArchiveIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => flags.markAllSeen(groups.flatMap((group) => group.sessions))}
            title="Mark all as read"
          >
            <MarkAllReadIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => void refresh()}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className="pane-search">
        <SearchIcon className="pane-search-icon" />
        <input
          value={query}
          placeholder="Filter sessions"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
            } else if (event.key === "Enter") {
              event.preventDefault();
              void runDeep("literal");
            }
          }}
          title={
            'Words match titles, prompts, branches, repos and ids. Quote a "phrase" to keep it whole. ' +
            "Enter searches inside the transcripts themselves."
          }
        />
        {query && (
          <button
            className="toggle-button icon-button"
            onClick={() => setQuery("")}
            title="Clear the filter (Esc)"
          >
            <ClearIcon />
          </button>
        )}
      </div>
      {searching && (
        <div className="pane-search-note">
          {deepBusy === "literal" && <span>searching transcripts…</span>}
          {deepBusy === "haiku" && <span>asking Haiku for other words…</span>}
          {!deepBusy && activeHits && (
            <span
              title={
                deep?.mode === "haiku"
                  ? `Haiku terms: ${deep.terms.join(", ")}`
                  : `Transcript matches for "${deep?.query}"`
              }
            >
              {activeHits.size > 0
                ? `${activeHits.size} in transcripts`
                : "nothing in transcripts"}
              {deep?.mode === "haiku" && " · haiku"}
            </span>
          )}
          {!deepBusy && !activeHits && (
            <button
              className="toggle-button"
              onClick={() => void runDeep("literal")}
              title="Search inside every transcript on the machine (Enter)"
            >
              <DeepSearchIcon /> transcripts
            </button>
          )}
          {/* Offered once the literal sweep has had its turn: its terms are what
              you know you typed, and Haiku's are guesses at what you might have. */}
          {!deepBusy && activeHits && deep?.mode === "literal" && (
            <button
              className="toggle-button"
              onClick={() => void runDeep("haiku")}
              data-active={activeHits.size === 0}
              title="Ask Haiku for other words this session might have used, then search those"
            >
              ask haiku
            </button>
          )}
          {deepError && (
            <span className="search-error" title={deepError}>
              search failed
            </span>
          )}
        </div>
      )}
      <div className="pane-body" ref={bodyRef}>
        {visible.length === 0 && (
          <div className="empty-note">
            {searching ? "No session matches that." : "No sessions found."}
          </div>
        )}
        {visible.map((group) => {
          // A collapsed group would hide its own matches, so a query opens
          // every group without touching what the user collapsed by hand.
          const isCollapsed = collapsed.has(group.dirName) && !searching;
          const isActiveRepo = activeCwd === group.cwd;
          return (
            <div key={group.dirName}>
              <div
                className="repo-row"
                data-selected={isActiveRepo}
                onClick={() => onSelectRepo(group.cwd)}
                onContextMenu={(event) => menu.openContextMenu(event, repoMenu(group))}
                title={group.cwd}
              >
                <span
                  className="twisty"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleGroup(group.dirName);
                  }}
                >
                  {isCollapsed ? "▸" : "▾"}
                </span>
                <RepoIcon />
                <span className="label">{group.label}</span>
                <span className="badge">
                  {groupSummary(group.sessions.map((s) => flags.effectiveStatus(s)))}
                </span>
                <button
                  className="toggle-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSession(group.cwd);
                  }}
                  title="Start a new session in this repo"
                >
                  +
                </button>
                {isActiveRepo && <ChevronRightIcon className="repo-active-marker" />}
              </div>
              {!isCollapsed &&
                group.sessions.map((session) => {
                  const status = flags.effectiveStatus(session);
                  const hit = activeHits?.get(session.id) ?? null;
                  const showRecap = recapOpen.has(session.id);
                  const markedUnread = flags.isMarkedUnread(session.id);
                  const archived = flags.isArchived(session.id);
                  const pinned = flags.isPinned(session.id);
                  const agents = session.runningAgents ?? [];
                  const workflows = session.runningWorkflows ?? [];
                  const workflowAgents = workflows.reduce((n, w) => n + w.agents.length, 0);
                  const fanout = agents.length + workflowAgents;
                  const showFanout = fanout > 0 && (fanoutOverride.get(session.id) ?? true);
                  const heat = heatLevel(session);
                  return (
                    <Fragment key={session.id}>
                      <div
                        className="session-row"
                        data-status={status}
                        data-selected={activeSessionId === session.id}
                        data-warm={status === "finished" && flags.isRecentlyChecked(session.id)}
                        data-unread={markedUnread || status === "pendingReview"}
                        data-archived={archived}
                        data-pinned={pinned}
                        onClick={() => openSession(session)}
                        onContextMenu={(event) =>
                          menu.openContextMenu(event, sessionMenu(session))
                        }
                        title={[
                          session.title ?? session.id,
                          session.lastPrompt,
                          hit ? `${hit.matchCount} transcript match${hit.matchCount === 1 ? "" : "es"}` : null,
                          `${status} · ${shortAge(session.lastActivityMs)} ago`,
                          pinned ? "pinned — kept through every filter" : null,
                          markedUnread ? "marked unread" : null,
                          session.gitBranch,
                          `${session.messageCount}${session.messageCountExact ? "" : "+"} msg`,
                          session.id,
                        ]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        {fanout > 0 ? (
                          <span
                            className="twisty"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFanout(session.id, true);
                            }}
                            title={`${fanout} agent${fanout === 1 ? "" : "s"} writing now`}
                          >
                            {showFanout ? "▾" : "▸"}
                          </span>
                        ) : (
                          <span className="twisty" />
                        )}
                        <StatusGlyph status={status} />
                        {/* Named by title only, never the last prompt: the
                            title pipeline (derived at start, Haiku upgrade,
                            manual rename) is the single source of names. */}
                        <span className="title">
                          {session.title ?? session.id.slice(0, 8)}
                        </span>
                        {fanout > 0 && !showFanout && (
                          <span className="agent-count" title={`${fanout} agents writing now`}>
                            {fanout}⚙
                          </span>
                        )}
                        {/* Wrapped rather than titled directly: a `title`
                            attribute on an <svg> is not a tooltip. */}
                        {pinned && (
                          <span className="pin-marker" title="Pinned to the top of this repo">
                            <PinIcon />
                          </span>
                        )}
                        {(markedUnread || status === "pendingReview") && (
                          <span
                            className="unread-dot"
                            title={markedUnread ? "Marked unread" : "Unseen since it finished"}
                          />
                        )}
                        {heat >= 0 && (
                          <span className="heat-badge" title={HEAT_TOOLTIPS[heat]}>
                            {HEAT_BADGES[heat]}
                          </span>
                        )}
                        <span className="age">{shortAge(session.lastActivityMs)}</span>
                        <span className="row-actions">
                          <button
                            className="toggle-button icon-button"
                            data-active={showRecap}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleRecap(session);
                            }}
                            title={
                              showRecap
                                ? "Hide what was done"
                                : "What was done: files, commits, branches, fan-outs"
                            }
                          >
                            <RecapIcon />
                          </button>
                          <button
                            className="toggle-button icon-button"
                            data-active={pinned}
                            onClick={(event) => {
                              event.stopPropagation();
                              flags.setPinned(session.id, !pinned);
                            }}
                            title={pinned ? "Unpin" : "Pin to the top, through every filter"}
                          >
                            {pinned ? <UnpinIcon /> : <PinIcon />}
                          </button>
                          <button
                            className="toggle-button icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (markedUnread) flags.markSeen(session);
                              else flags.markUnread(session.id);
                            }}
                            title={markedUnread ? "Mark read" : "Mark unread"}
                          >
                            {markedUnread ? <ReadToggleIcon /> : <UnreadToggleIcon />}
                          </button>
                          <button
                            className="toggle-button icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              flags.setArchived(session.id, !archived);
                            }}
                            title={archived ? "Unarchive" : "Archive"}
                          >
                            {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
                          </button>
                        </span>
                      </div>
                      {/* Why this row is here, and where in the session to
                          find it: one row per matching turn, each one a click
                          away from the conversation around it. Listing them all
                          rather than only the first is what makes a result
                          scannable — the first match is rarely the one that
                          tells you this is the session you meant. */}
                      {hit?.snippets.map((snippet, index) => (
                        <div
                          key={`${snippet.offset}-${index}`}
                          className="match-row"
                          data-role={snippet.role}
                          onClick={(event) => {
                            event.stopPropagation();
                            openSession(session, snippet.offset);
                          }}
                          title={[
                            snippet.text,
                            snippet.role === "user" ? "you said this" : "claude said this",
                            "Click to open the session at this turn.",
                            index === 0 && hit.matchCount > hit.snippets.length
                              ? `${hit.matchCount} matching turns in all`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n\n")}
                        >
                          {/* The count sits on the first row only, but the
                              column is held on all of them so the snippets
                              stay aligned under each other. */}
                          <span className="match-count">
                            {index === 0 ? `${hit.matchCount}×` : ""}
                          </span>
                          <span className="match-text">
                            {markTerms(snippet.text, hitTerms).map((segment, at) =>
                              segment.hit ? (
                                <mark key={at} className="search-hit">
                                  {segment.text}
                                </mark>
                              ) : (
                                <span key={at}>{segment.text}</span>
                              ),
                            )}
                          </span>
                        </div>
                      ))}
                      {showRecap && (
                        <RecapBlock
                          state={recaps.get(session.id)}
                          cwd={session.cwd ?? group.cwd}
                          onOpenFile={onOpenFile}
                        />
                      )}
                      {showFanout && (
                        <>
                          {agents.map((agent) => agentRow(agent, session, false))}
                          {workflows.map((workflow) => (
                            <Fragment key={workflow.runId}>
                              <div
                                className="workflow-row"
                                onClick={() => openSession(session)}
                                title={[
                                  `workflow ${workflow.name ?? workflow.runId}`,
                                  workflow.phase ? `phase: ${workflow.phase}` : null,
                                  `${workflow.agents.length} writing now`,
                                  workflow.agentCount
                                    ? `${workflow.agentCount} spawned over the run`
                                    : null,
                                  workflow.jsonPath,
                                ]
                                  .filter(Boolean)
                                  .join("\n")}
                              >
                                <WorkflowGlyph />
                                <span className="title">{workflow.name ?? workflow.runId}</span>
                                <span className="agent-type">
                                  {workflow.agents.length}⚡
                                  {workflow.phase ? ` ${workflow.phase}` : ""}
                                </span>
                              </div>
                              {workflow.agents.map((agent) => agentRow(agent, session, true))}
                            </Fragment>
                          ))}
                        </>
                      )}
                    </Fragment>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
});
