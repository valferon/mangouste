/**
 * Five-field cron, for prompts that run on a schedule while the app is open.
 *
 * `minute hour day-of-month month day-of-week`, with `*`, lists, ranges, steps
 * and the three-letter month and day names, plus the usual `@hourly`-style
 * macros. Day-of-week takes 0 or 7 for Sunday. When both day fields are
 * restricted a day matching either one matches, which is what every cron since
 * Vixie's does and what a schedule copied out of a crontab will expect.
 *
 * Local time throughout: "0 9 * * 1-5" means nine on this machine's clock.
 */

export interface Cron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  /** Whether each day field was `*`, which decides the AND/OR rule above. */
  domAny: boolean;
  dowAny: boolean;
}

export type CronParse = { ok: true; cron: Cron } | { ok: false; error: string };

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Names accepted in place of numbers, indexed from `min`. */
  names?: string[];
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  // 7 is accepted and folded onto 0 after parsing.
  { name: "day of week", min: 0, max: 7, names: DAYS },
];

function parseValue(token: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const index = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  return index >= 0 ? index + spec.min : null;
}

function parseField(field: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === "") return `bad ${spec.name}: "${part}"`;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return `bad step in ${spec.name}: "${part}"`;
    let from: number | null;
    let to: number | null;
    if (range === "*") {
      from = spec.min;
      to = spec.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) return `bad range in ${spec.name}: "${part}"`;
      from = parseValue(a, spec);
      to = parseValue(b, spec);
    } else {
      from = parseValue(range, spec);
      // "5/15" is "from 5, every 15", as cronie reads it.
      to = stepText === undefined ? from : spec.max;
    }
    if (from === null || to === null) return `bad ${spec.name}: "${part}"`;
    if (from < spec.min || to > spec.max || from > to) {
      return `${spec.name} out of range (${spec.min}-${spec.max}): "${part}"`;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    return { ok: false, error: "expected 5 fields: minute hour day month weekday" };
  }
  const sets: Set<number>[] = [];
  for (let index = 0; index < 5; index += 1) {
    const parsed = parseField(fields[index], FIELDS[index]);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    sets.push(parsed);
  }
  const dow = sets[4];
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    ok: true,
    cron: {
      minute: sets[0],
      hour: sets[1],
      dom: sets[2],
      month: sets[3],
      dow,
      domAny: fields[2] === "*",
      dowAny: fields[4] === "*",
    },
  };
}

function dayMatches(cron: Cron, date: Date): boolean {
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  if (cron.domAny || cron.dowAny) return dom && dow;
  return dom || dow;
}

/** Whether `date`'s minute is one the schedule fires on. Seconds are ignored. */
export function cronMatches(cron: Cron, date: Date): boolean {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.month.has(date.getMonth() + 1) &&
    dayMatches(cron, date)
  );
}

/** Far enough for "0 0 29 2 *" from any date, and a bound on a schedule that never fires. */
const SEARCH_DAYS = 366 * 8;

/**
 * The first minute strictly after `from` the schedule fires on, or null if
 * none comes within the search bound ("0 0 31 2 *" never does).
 *
 * Walks days, then hours, then minutes, skipping any unit that cannot match,
 * so a yearly schedule costs a few thousand steps and not half a million.
 */
export function nextRun(cron: Cron, from: Date): Date | null {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let step = 0; step < SEARCH_DAYS; step += 1) {
    if (cron.month.has(day.getMonth() + 1) && dayMatches(cron, day)) {
      const sameDay = day.getTime() === new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
      for (let hour = sameDay ? start.getHours() : 0; hour < 24; hour += 1) {
        if (!cron.hour.has(hour)) continue;
        const firstMinute = sameDay && hour === start.getHours() ? start.getMinutes() : 0;
        for (let minute = firstMinute; minute < 60; minute += 1) {
          if (!cron.minute.has(minute)) continue;
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
          // A DST gap can turn 02:30 into 03:30; a time the clock skipped is
          // not a time the schedule asked for.
          if (candidate.getHours() === hour && candidate.getMinutes() === minute) return candidate;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/**
 * When a run is, said briefly: the time alone today, the weekday within the
 * week, the date beyond that.
 */
export function formatRun(when: Date, now: Date): string {
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((when.getTime() - startOfToday) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${when.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
