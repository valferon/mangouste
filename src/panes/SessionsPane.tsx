import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { expandSearchTerms, listSessions, onSessionsChanged, searchSessions } from "../lib/ipc";
import {
  ArchiveIcon,
  ChevronRightIcon,
  ClearIcon,
  DeepSearchIcon,
  MarkAllReadIcon,
  ReadToggleIcon,
  RefreshIcon,
  RepoIcon,
  SearchIcon,
  StatusGlyph,
  SubagentGlyph,
  UnarchiveIcon,
  UnreadToggleIcon,
  WorkflowGlyph,
} from "../lib/icons";
import { useFlags } from "../lib/sessionFlagsContext";
import type {
  ProjectGroup,
  RunningAgent,
  SessionHit,
  SessionMeta,
  SessionStatus,
} from "../lib/types";

interface SessionsPaneProps {
  /** Session currently attached to the chat pane, highlighted in the list. */
  activeSessionId: string | null;
  onResume: (session: SessionMeta) => void;
  onNewSession: (cwd: string) => void;
  /** Clicking a group label switches the sidebars to that repo. */
  onSelectRepo: (cwd: string) => void;
  /** Repo currently shown in the other panes, highlighted in the list. */
  activeCwd: string | null;
  /** Lifts the scanned groups so the quick-open palette can reuse them. */
  onGroups: (groups: ProjectGroup[]) => void;
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

/**
 * Every Claude Code session on the machine, grouped by repo.
 *
 * This is the pane that removes the one-window-per-repo problem: the list is
 * global, so a session running in another repo stays visible while you work here.
 * The Rust watcher pushes `sessions://changed`, and a slow interval covers the
 * status field, which ages out on a timer rather than on a file event.
 *
 * Rows are one line each, with live subagent and workflow fan-outs nested under
 * their session. Read and archive state is an overlay in `sessionStore`, not a
 * fact about the transcript.
 */
export const SessionsPane = memo(function SessionsPane({
  activeSessionId,
  onResume,
  onNewSession,
  onSelectRepo,
  activeCwd,
  onGroups,
}: SessionsPaneProps) {
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
      if (flags.isArchived(session.id) && !showArchived) return false;
      const status = flags.effectiveStatus(session);
      if (onlyLive) return status === "active" || status === "awaiting";
      return showIdle || status !== "idle";
    };
    return groups
      .map((group) => ({ ...group, sessions: group.sessions.filter(keep) }))
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
    bodyRef.current
      ?.querySelector('[data-selected="true"]')
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
    (session: SessionMeta) => {
      flags.markSeen(session);
      onResume(session);
    },
    [flags, onResume],
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
      <div className="pane-header">
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
                  const markedUnread = flags.isMarkedUnread(session.id);
                  const archived = flags.isArchived(session.id);
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
                        onClick={() => openSession(session)}
                        title={[
                          session.title ?? session.id,
                          session.lastPrompt,
                          hit ? `${hit.matchCount} transcript match${hit.matchCount === 1 ? "" : "es"}` : null,
                          ...(hit?.snippets ?? []),
                          `${status} · ${shortAge(session.lastActivityMs)} ago`,
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
                      {/* Why this row is here, when the reason is not in its
                          title: one line of the conversation that matched. */}
                      {hit && hit.snippet && (
                        <div
                          className="match-row"
                          onClick={() => openSession(session)}
                          title={hit.snippets.join("\n\n")}
                        >
                          <span className="match-count">{hit.matchCount}×</span>
                          <span className="match-text">{hit.snippet}</span>
                        </div>
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
