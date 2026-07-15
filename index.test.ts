import { expect, test } from "bun:test";
import { publishedMessage, reviewMessage, submissionModal } from "./index";

const submission = {
  headline: "Hack Club launches something new",
  source: "https://example.com/story",
  quote: "This is the exact quote.",
  submitter: "U123",
  credit: false,
};
const json = (value: unknown) => JSON.stringify(value);

test("submission modal includes the optional credit checkbox", () => {
  expect(submissionModal().blocks.map((b) => b.block_id)).toEqual([
    "headline",
    "source",
    "quote",
    "credit",
  ]);
});

test("review message has send, edit, and reject controls", () => {
  const blocks = reviewMessage(submission).blocks;
  expect(json(blocks)).toContain("Submitted by <@U123>");
  const actions = blocks.at(-1) as { elements: { action_id: string }[] };
  expect(actions.elements.map((e) => e.action_id)).toEqual([
    "send_submission",
    "edit_submission",
    "reject_submission",
  ]);
});

test("editing a credited submission keeps the checkbox selected", () => {
  const credit = submissionModal(
    { ...submission, credit: true },
    { channel: "C123", ts: "123.456" },
  ).blocks.find((b) => b.block_id === "credit") as {
    element: { initial_options?: unknown[] };
  };
  expect(credit.element.initial_options).toHaveLength(1);
});

test("user-entered Slack markup is escaped", () => {
  expect(json(publishedMessage({ ...submission, headline: "Look <@U999> & listen" }))).toContain(
    "Look &lt;@U999&gt; &amp; listen",
  );
});

for (const [credit, label] of [
  [true, "credited"],
  [false, "anonymous"],
] as const)
  test(`${label} submission attribution`, () => {
    expect(
      json(publishedMessage({ ...submission, credit })).includes(
        "Submitted by <@U123>\\nSource: https://example.com/story",
      ),
    ).toBe(credit);
  });
