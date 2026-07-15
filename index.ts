import { App, type BlockButtonAction } from "@slack/bolt";
import type { KnownBlock, ModalView } from "@slack/types";

const PORT = Number(Bun.env.PORT ?? 3000);

type Submission = {
  headline: string;
  source: string;
  quote: string;
  submitter: string;
};

type ReviewReference = {
  channel: string;
  ts: string;
  submitter: string;
};

type MessagePayload = {
  text: string;
  blocks: KnownBlock[];
};

const requiredEnvironment = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_REVIEW_CHANNEL_ID",
  "SLACK_PUBLISH_CHANNEL_ID",
] as const;

const inFlight = new Set<string>();

function env(name: (typeof requiredEnvironment)[number]): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function encodeSubmission(submission: Submission): string {
  const encoded = JSON.stringify(submission);
  if (encoded.length > 2000) throw new Error("Submission is too large for Slack");
  return encoded;
}

function decodeSubmission(value?: string): Submission {
  if (!value) throw new Error("Missing submission data");
  const parsed = JSON.parse(value) as Partial<Submission>;
  if (
    typeof parsed.headline !== "string" ||
    typeof parsed.source !== "string" ||
    typeof parsed.quote !== "string" ||
    typeof parsed.submitter !== "string"
  ) {
    throw new Error("Invalid submission data");
  }
  return parsed as Submission;
}

function inputValue(
  values: Record<string, Record<string, { value?: string }>>,
  blockId: string,
  actionId: string,
): string {
  return values[blockId]?.[actionId]?.value?.trim() ?? "";
}

function submissionFromView(
  values: Record<string, Record<string, { value?: string }>>,
  submitter: string,
): Submission {
  return {
    headline: inputValue(values, "headline", "headline_input"),
    source: inputValue(values, "source", "source_input"),
    quote: inputValue(values, "quote", "quote_input"),
    submitter,
  };
}

function validationErrors(submission: Submission): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!submission.headline) errors.headline = "Add a headline.";
  if (!submission.source) errors.source = "Add a source.";
  return errors;
}

export function submissionModal(
  submission?: Submission,
  reference?: Omit<ReviewReference, "submitter">,
): ModalView {
  const editing = Boolean(reference);
  return {
    type: "modal",
    callback_id: editing ? "edit_submission" : "new_submission",
    private_metadata: editing
      ? JSON.stringify({
          channel: reference!.channel,
          ts: reference!.ts,
          submitter: submission!.submitter,
        })
      : "",
    title: { type: "plain_text", text: editing ? "Edit submission" : "Submit a story" },
    submit: { type: "plain_text", text: editing ? "Save" : "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "headline",
        label: { type: "plain_text", text: "What is your headline?" },
        hint: {
          type: "plain_text",
          text: "One concise, informative sentence that can be read in under 15 seconds.",
        },
        element: {
          type: "plain_text_input",
          action_id: "headline_input",
          max_length: 180,
          ...(submission ? { initial_value: submission.headline } : {}),
        },
      },
      {
        type: "input",
        block_id: "source",
        label: { type: "plain_text", text: "What is your source?" },
        hint: {
          type: "plain_text",
          text: "Paste a Slack message, website, or GitHub link.",
        },
        element: {
          type: "plain_text_input",
          action_id: "source_input",
          max_length: 500,
          ...(submission ? { initial_value: submission.source } : {}),
        },
      },
      {
        type: "input",
        block_id: "quote",
        optional: true,
        label: { type: "plain_text", text: "Anything we should quote exactly?" },
        hint: {
          type: "plain_text",
          text: "If the source is long, paste the exact section to focus on.",
        },
        element: {
          type: "plain_text_input",
          action_id: "quote_input",
          multiline: true,
          max_length: 900,
          ...(submission ? { initial_value: submission.quote } : {}),
        },
      },
    ],
  };
}

export function reviewMessage(submission: Submission): MessagePayload {
  const value = encodeSubmission(submission);
  const quoteBlocks: KnownBlock[] = submission.quote
    ? [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Exact quote*\n>${escapeMrkdwn(submission.quote).replaceAll("\n", "\n>")}`,
          },
        },
      ]
    : [];

  return {
    text: `News Wire submission: ${submission.headline}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "New News Wire submission" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Headline*\n${escapeMrkdwn(submission.headline)}\n\n*Source*\n${escapeMrkdwn(submission.source)}`,
        },
      },
      ...quoteBlocks,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Submitted by <@${submission.submitter}>` }],
      },
      {
        type: "actions",
        block_id: "review_actions",
        elements: [
          {
            type: "button",
            action_id: "send_submission",
            text: { type: "plain_text", text: "Send" },
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: "edit_submission",
            text: { type: "plain_text", text: "Edit" },
            value,
          },
          {
            type: "button",
            action_id: "reject_submission",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            value,
            confirm: {
              title: { type: "plain_text", text: "Reject this submission?" },
              text: { type: "mrkdwn", text: "This removes it from the review queue." },
              confirm: { type: "plain_text", text: "Reject" },
              deny: { type: "plain_text", text: "Cancel" },
              style: "danger",
            },
          },
        ],
      },
    ],
  };
}

export function publishedMessage(submission: Submission): MessagePayload {
  const quoteBlocks: KnownBlock[] = submission.quote
    ? [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `>${escapeMrkdwn(submission.quote).replaceAll("\n", "\n>")}`,
          },
        },
      ]
    : [];

  return {
    text: submission.headline,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(submission.headline)}*` },
      },
      ...quoteBlocks,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Source: ${escapeMrkdwn(submission.source)}` }],
      },
    ],
  };
}

function resolvedReviewMessage(
  submission: Submission,
  status: "Sent" | "Rejected",
  reviewer: string,
): MessagePayload {
  const original = reviewMessage(submission);
  return {
    text: `${status}: ${submission.headline}`,
    blocks: [
      ...original.blocks.slice(0, -1),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${status === "Sent" ? ":white_check_mark:" : ":no_entry_sign:"} *${status}* by <@${reviewer}>`,
          },
        ],
      },
    ],
  };
}

export function registerListeners(app: App): void {
  app.command("/news-wire", async ({ ack, command, client, logger, respond }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: submissionModal(),
      });
    } catch (error) {
      logger.error(error);
      await respond({
        response_type: "ephemeral",
        text: `Could not open the News Wire form: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  });

  app.view("new_submission", async ({ ack, body, view, client, logger }) => {
    const submission = submissionFromView(
      view.state.values as Record<string, Record<string, { value?: string }>>,
      body.user.id,
    );
    const errors = validationErrors(submission);
    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors });
      return;
    }

    try {
      await client.chat.postMessage({
        channel: env("SLACK_REVIEW_CHANNEL_ID"),
        ...reviewMessage(submission),
      });
      await ack();
    } catch (error) {
      logger.error(error);
      await ack({
        response_action: "errors",
        errors: {
          source: `Could not save submission: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      });
    }
  });

  app.view("edit_submission", async ({ ack, view, client, logger }) => {
    const reference = JSON.parse(view.private_metadata) as ReviewReference;
    const submission = submissionFromView(
      view.state.values as Record<string, Record<string, { value?: string }>>,
      reference.submitter,
    );
    const errors = validationErrors(submission);
    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors });
      return;
    }

    try {
      await client.chat.update({
        channel: reference.channel,
        ts: reference.ts,
        ...reviewMessage(submission),
      });
      await ack();
    } catch (error) {
      logger.error(error);
      await ack({
        response_action: "errors",
        errors: {
          source: `Could not save submission: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      });
    }
  });

  app.action<BlockButtonAction>(
    "edit_submission",
    async ({ ack, body, action, client, logger }) => {
      await ack();
      if (!body.channel || !body.message) return;
      try {
        const submission = decodeSubmission(action.value);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: submissionModal(submission, {
            channel: body.channel.id,
            ts: body.message.ts,
          }),
        });
      } catch (error) {
        logger.error(error);
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `News Wire edit failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    },
  );

  app.action<BlockButtonAction>(
    "send_submission",
    async ({ ack, body, action, client, logger }) => {
      await ack();
      if (!body.channel || !body.message) return;
      const key = `${body.channel.id}:${body.message.ts}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        const submission = decodeSubmission(action.value);
        await client.chat.postMessage({
          channel: env("SLACK_PUBLISH_CHANNEL_ID"),
          ...publishedMessage(submission),
        });
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          ...resolvedReviewMessage(submission, "Sent", body.user.id),
        });
      } catch (error) {
        logger.error(error);
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `News Wire send failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      } finally {
        inFlight.delete(key);
      }
    },
  );

  app.action<BlockButtonAction>(
    "reject_submission",
    async ({ ack, body, action, client, logger }) => {
      await ack();
      if (!body.channel || !body.message) return;
      const key = `${body.channel.id}:${body.message.ts}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        const submission = decodeSubmission(action.value);
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          ...resolvedReviewMessage(submission, "Rejected", body.user.id),
        });
      } catch (error) {
        logger.error(error);
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `News Wire rejection failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      } finally {
        inFlight.delete(key);
      }
    },
  );
}

export function createApp(): App {
  const missing = requiredEnvironment.filter((name) => !Bun.env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  const app = new App({
    token: env("SLACK_BOT_TOKEN"),
    appToken: env("SLACK_APP_TOKEN"),
    socketMode: true,
    deferInitialization: true,
  });
  registerListeners(app);
  return app;
}

if (import.meta.main) {
  const app = createApp();
  await app.init();
  await app.start();

  const healthServer = Bun.serve({
    port: PORT,
    routes: {
      "/health": () => Response.json({ ok: true }),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });

  const shutdown = async () => {
    healthServer.stop();
    await app.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  app.logger.info(`Hack Club News Wire connected over Socket Mode`);
  app.logger.info(`Health check listening on port ${PORT}`);
}
