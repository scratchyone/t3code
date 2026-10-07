import type { ThreadUserInputQuestion } from "../state/threadRequests.ts";
import { record } from "./controller.ts";

/** Render rewrites change presentation while answers retain the provider's stable IDs. */
export function modUiQuestions(original: ReadonlyArray<ThreadUserInputQuestion>, value: unknown) {
  if (!Array.isArray(value) || value.length !== original.length) return original;
  return original.map((question, index) => {
    const rewrite = record(value[index]);
    const options = Array.isArray(rewrite.options) ? rewrite.options : [];
    if (options.length !== question.options.length) return question;
    return {
      ...question,
      header: typeof rewrite.header === "string" ? rewrite.header : question.header,
      question: typeof rewrite.question === "string" ? rewrite.question : question.question,
      multiSelect:
        typeof rewrite.multiSelect === "boolean" ? rewrite.multiSelect : question.multiSelect,
      options: question.options.map((option, slot) => {
        const next = record(options[slot]);
        return {
          ...option,
          label: typeof next.label === "string" ? next.label : option.label,
          description: typeof next.description === "string" ? next.description : option.description,
        };
      }),
    };
  });
}
