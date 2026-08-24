import { describe, expect, it } from "vitest";
import {
  buildAnswers,
  isComplete,
  OTHER_LABEL,
  parseQuestions,
  togglePick,
  type ParsedQuestion,
} from "./questions";

const input = {
  questions: [
    {
      question: "Which runtime?",
      header: "Runtime",
      multiSelect: false,
      options: [
        { label: "Node", description: "the boring one" },
        { label: "Deno" },
      ],
    },
  ],
};

const single: ParsedQuestion = {
  header: null,
  question: "Which runtime?",
  options: [{ label: "Node", description: null }, { label: "Deno", description: null }],
  multiSelect: false,
};

const multi: ParsedQuestion = { ...single, question: "Which targets?", multiSelect: true };

describe("parseQuestions", () => {
  it("keeps header, options and their descriptions", () => {
    expect(parseQuestions(input)).toEqual([
      {
        header: "Runtime",
        question: "Which runtime?",
        multiSelect: false,
        options: [
          { label: "Node", description: "the boring one" },
          { label: "Deno", description: null },
        ],
      },
    ]);
  });

  it("rejects a question with no text, which is what answers are keyed by", () => {
    expect(parseQuestions({ questions: [{ options: [{ label: "Node" }] }] })).toBeNull();
  });

  it("rejects a question with no usable options", () => {
    expect(parseQuestions({ questions: [{ question: "Which?", options: [] }] })).toBeNull();
  });

  it("drops an Other sent as a real option, so the form's own does not collide", () => {
    const parsed = parseQuestions({
      questions: [{ question: "Which?", options: [{ label: "Node" }, { label: OTHER_LABEL }] }],
    });
    expect(parsed?.[0]?.options.map((option) => option.label)).toEqual(["Node"]);
  });

  it("returns null on anything that is not the tool's payload", () => {
    expect(parseQuestions(null)).toBeNull();
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: "Node" })).toBeNull();
  });
});

describe("buildAnswers", () => {
  it("keys answers by question text", () => {
    expect(buildAnswers([single], { "Which runtime?": ["Node"] }, {})).toEqual({
      "Which runtime?": "Node",
    });
  });

  it("joins a multi-select with the separator the CLI splits on", () => {
    expect(buildAnswers([multi], { "Which targets?": ["Node", "Deno"] }, {})).toEqual({
      "Which targets?": "Node, Deno",
    });
  });

  it("swaps the Other placeholder for what was typed", () => {
    const answers = buildAnswers(
      [multi],
      { "Which targets?": ["Node", OTHER_LABEL] },
      { "Which targets?": "  Bun  " },
    );
    expect(answers).toEqual({ "Which targets?": "Node, Bun" });
  });

  it("leaves a bare Other unanswered rather than sending the word back", () => {
    const answers = buildAnswers([single], { "Which runtime?": [OTHER_LABEL] }, {});
    expect(answers).toEqual({ "Which runtime?": "" });
    expect(isComplete([single], answers)).toBe(false);
  });

  it("is incomplete until every question has an answer", () => {
    const questions = [single, multi];
    const partial = buildAnswers(questions, { "Which runtime?": ["Node"] }, {});
    expect(isComplete(questions, partial)).toBe(false);
    const full = buildAnswers(
      questions,
      { "Which runtime?": ["Node"], "Which targets?": ["Deno"] },
      {},
    );
    expect(isComplete(questions, full)).toBe(true);
  });
});

describe("togglePick", () => {
  it("replaces the pick when only one is allowed", () => {
    expect(togglePick(single, ["Node"], "Deno")).toEqual(["Deno"]);
  });

  it("accumulates when several are", () => {
    expect(togglePick(multi, ["Node"], "Deno")).toEqual(["Node", "Deno"]);
  });

  it("clears on a second click, so a mis-click is undoable", () => {
    expect(togglePick(single, ["Node"], "Node")).toEqual([]);
    expect(togglePick(multi, ["Node", "Deno"], "Node")).toEqual(["Deno"]);
  });
});
