import { describe, expect, it } from "@effect/vitest";
import { modUiQuestions } from "./questions.ts";

const questions = [
  {
    id: "provider-question",
    header: "Choice",
    question: "Which?",
    multiSelect: false,
    options: [{ value: "provider-option", label: "First", description: "Original" }],
  },
];
describe("mod question rewrites", () => {
  it("changes the visible question while preserving the response identities", () => {
    expect(
      modUiQuestions(questions, [
        {
          id: "replacement",
          header: "Revised",
          question: "Pick one",
          multiSelect: true,
          options: [{ value: "replacement", label: "One", description: "Revised option" }],
        },
      ]),
    ).toEqual([
      {
        id: "provider-question",
        header: "Revised",
        question: "Pick one",
        multiSelect: true,
        options: [{ value: "provider-option", label: "One", description: "Revised option" }],
      },
    ]);
  });
  it("keeps the original response slots when a rewrite changes their count", () => {
    expect(modUiQuestions(questions, [])).toBe(questions);
    expect(modUiQuestions(questions, [{ options: [] }])[0]).toBe(questions[0]);
  });
});
