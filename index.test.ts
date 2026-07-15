import { expect, test } from "bun:test";
import { publishedMessage, reviewMessage, submissionModal } from "./index";

const submission = {
  headline: "Hack Club launches something new",
  source: "https://example.com/story",
  quote: "This is the exact quote.",
  submitter: "U123",
};

test("submission modal contains the three requested fields", () => {
  const modal = submissionModal();
  expect(modal.blocks.map((block) => block.block_id)).toEqual(["headline", "source", "quote"]);
});

test("review message has send, edit, and reject controls", () => {
  const message = reviewMessage(submission);
  const actions = message.blocks.at(-1) as { elements: Array<{ action_id: string }> };
  expect(actions.elements.map((element) => element.action_id)).toEqual([
    "send_submission",
    "edit_submission",
    "reject_submission",
  ]);
});

test("user-entered Slack markup is escaped", () => {
  const message = publishedMessage({
    ...submission,
    headline: "Look <@U999> & listen",
  });
  expect(JSON.stringify(message)).toContain("Look &lt;@U999&gt; &amp; listen");
});
