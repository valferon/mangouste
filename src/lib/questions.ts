/**
 * `AskUserQuestion`'s payload, and the answers that go back into it.
 *
 * The encoding belongs to the CLI, not to us: answers are keyed by the question
 * text, one string per question, multi-select values joined with `", "`. That is
 * what Claude Code's own UI writes into the permission reply's `updatedInput`
 * and what the tool reads back out, verified round-trip against 2.1.241 — which
 * is also why the tool cannot simply be allowed through unchanged.
 */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * The choice every question carries implicitly.
 *
 * The CLI's own UI always offers a free-text escape hatch, so the card does too.
 * It is a placeholder for the text box, never an answer in itself: on submit it
 * is swapped out for whatever was typed.
 */
export const OTHER_LABEL = "Other";

export interface QuestionOption {
  label: string;
  description: string | null;
}

export interface ParsedQuestion {
  header: string | null;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * `AskUserQuestion`'s input, as much of it as an answerable form needs.
 *
 * Null on anything that does not match the tool's schema, which sends the card
 * back to the generic allow/deny renderer rather than showing a form that cannot
 * produce a valid answer. Question text is required rather than defaulted:
 * `answers` is keyed by it, so a blank question has nowhere to put its reply.
 * An `Other` arriving as a real option is dropped, because the form appends its
 * own and two of them would collide in the answer map.
 */
export function parseQuestions(input: unknown): ParsedQuestion[] | null {
  const questions = asRecord(input)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: ParsedQuestion[] = [];
  for (const entry of questions) {
    const record = asRecord(entry);
    const question = asText(record?.question);
    if (!record || !question) return null;
    const options = Array.isArray(record.options) ? record.options : [];
    const labelled: QuestionOption[] = [];
    for (const option of options) {
      const label = asText(asRecord(option)?.label);
      if (!label || label === OTHER_LABEL) continue;
      labelled.push({ label, description: asText(asRecord(option)?.description) });
    }
    if (labelled.length === 0) return null;
    parsed.push({
      header: asText(record.header),
      question,
      options: labelled,
      multiSelect: record.multiSelect === true,
    });
  }
  return parsed;
}

/**
 * The picks, in the shape the tool reads them back in.
 *
 * A question with nothing chosen maps to the empty string, which is what
 * `isComplete` keys off — including the `Other` case, where the CLI's own UI
 * submits the literal word "Other" as the answer and tells the model nothing.
 */
export function buildAnswers(
  questions: ParsedQuestion[],
  picked: Record<string, string[]>,
  typed: Record<string, string>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const chosen = picked[question.question] ?? [];
    const free = typed[question.question]?.trim() ?? "";
    const labels = chosen.filter((label) => label !== OTHER_LABEL);
    if (chosen.includes(OTHER_LABEL) && free) labels.push(free);
    answers[question.question] = labels.join(", ");
  }
  return answers;
}

/** Every question answered, i.e. the submit button is live. */
export const isComplete = (
  questions: ParsedQuestion[],
  answers: Record<string, string>,
): boolean => questions.every((question) => Boolean(answers[question.question]));

/**
 * One option toggled, returning the new selection for that question.
 *
 * A second click clears, so a mis-click is undoable without a "none of these"
 * option that the tool's schema does not have.
 */
export function togglePick(
  question: ParsedQuestion,
  chosen: string[],
  label: string,
): string[] {
  if (chosen.includes(label)) return chosen.filter((it) => it !== label);
  return question.multiSelect ? [...chosen, label] : [label];
}
