import { App, type BlockButtonAction } from "@slack/bolt";
import type { Button, InputBlock, KnownBlock, ModalView } from "@slack/types";

type Submission = {
  headline: string;
  source: string;
  quote: string;
  submitter: string;
  credit: boolean;
};

type Values = Record<
  string,
  Record<string, { value?: string; selected_options?: { value: string }[] }>
>;

type Reference = {
  channel: string;
  ts: string;
  submitter: string;
};

type Payload = {
  text: string;
  blocks: KnownBlock[];
};

const required = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_REVIEW_CHANNEL_ID",
  "SLACK_PUBLISH_CHANNEL_ID",
] as const;
const fields = [
  [
    "headline",
    "What is your headline?",
    "One concise, informative sentence that can be read in under 15 seconds.",
    180,
  ],
  ["source", "What is your source?", "Paste a Slack message, website, or GitHub link.", 500],
  [
    "quote",
    "Anything we should quote exactly?",
    "If the source is long, paste the exact section to focus on.",
    900,
    true,
  ],
] as const;
type Field = (typeof fields)[number][0];

const busy = new Set<string>();
const plain = (text: string) => ({ type: "plain_text" as const, text });
const mrkdwn = (text: string) => ({ type: "mrkdwn" as const, text });
const section = (text: string): KnownBlock => ({ type: "section", text: mrkdwn(text) });
const context = (text: string): KnownBlock => ({
  type: "context",
  elements: [mrkdwn(text)],
});
const creditOption = {
  text: plain("Credit me for this submission"),
  value: "credit_me",
};

function env(name: (typeof required)[number]): string {
  const v = Bun.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function encode(s: Submission): string {
  const v = JSON.stringify(s);
  if (v.length > 2000) throw new Error("Submission is too large for Slack");
  return v;
}

function decode(value?: string): Submission {
  if (!value) throw new Error("Missing submission data");
  const s = JSON.parse(value) as Partial<Submission>;
  if ([s.headline, s.source, s.quote, s.submitter].some((v) => typeof v !== "string"))
    throw new Error("Invalid submission data");
  return { ...s, credit: s.credit === true } as Submission;
}

function value(values: Values, field: Field): string {
  return values[field]?.[`${field}_input`]?.value?.trim() ?? "";
}

function submissionFrom(values: Values, submitter: string): Submission {
  return {
    headline: value(values, "headline"),
    source: value(values, "source"),
    quote: value(values, "quote"),
    submitter,
    credit:
      values.credit?.credit_input?.selected_options?.some((o) => o.value === "credit_me") ?? false,
  };
}

function errors(s: Submission): Record<string, string> {
  return {
    ...(s.headline ? {} : { headline: "Add a headline." }),
    ...(s.source ? {} : { source: "Add a source." }),
  };
}

function input(
  block_id: string,
  label: string,
  hint: string,
  element: InputBlock["element"],
  optional = false,
): InputBlock {
  return {
    type: "input",
    block_id,
    label: plain(label),
    ...(hint && { hint: plain(hint) }),
    ...(optional && { optional }),
    element,
  };
}

function textInput(
  submission: Submission | undefined,
  field: Field,
  label: string,
  hint: string,
  max_length: number,
  optional = false,
): InputBlock {
  return input(
    field,
    label,
    hint,
    {
      type: "plain_text_input",
      action_id: `${field}_input`,
      max_length,
      ...(field === "quote" && { multiline: true }),
      ...(submission && { initial_value: submission[field] }),
    },
    optional,
  );
}

function button(action_id: string, text: string, value: string, style?: Button["style"]): Button {
  return {
    type: "button",
    action_id,
    text: plain(text),
    value,
    ...(style && { style }),
  };
}

function quote(text: string, label = ""): KnownBlock {
  return section(`${label}>${escape(text).replaceAll("\n", "\n>")}`);
}

const reason = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

function report(
  client: App["client"],
  channel: string,
  user: string,
  action: string,
  error: unknown,
) {
  return client.chat.postEphemeral({
    channel,
    user,
    text: `News Wire ${action} failed: ${reason(error)}`,
  });
}

export function submissionModal(
  submission?: Submission,
  reference?: Omit<Reference, "submitter">,
): ModalView {
  return {
    type: "modal",
    callback_id: reference ? "edit_submission" : "new_submission",
    private_metadata: reference
      ? JSON.stringify({
          ...reference,
          submitter: submission!.submitter,
        })
      : "",
    title: plain(reference ? "Edit submission" : "Submit a story"),
    submit: plain(reference ? "Save" : "Submit"),
    close: plain("Cancel"),
    blocks: [
      ...fields.map(([field, label, hint, max, optional]) =>
        textInput(submission, field, label, hint, max, optional),
      ),
      input(
        "credit",
        "Credit",
        "",
        {
          type: "checkboxes",
          action_id: "credit_input",
          options: [creditOption],
          ...(submission?.credit ? { initial_options: [creditOption] } : {}),
        },
        true,
      ),
    ],
  };
}

export function reviewMessage(s: Submission): Payload {
  const value = encode(s);
  return {
    text: `News Wire submission: ${s.headline}`,
    blocks: [
      {
        type: "header",
        text: plain("New News Wire submission"),
      },
      section(`*Headline*\n${escape(s.headline)}\n\n*Source*\n${escape(s.source)}`),
      ...(s.quote ? [quote(s.quote, "*Exact quote*\n")] : []),
      context(`Submitted by <@${s.submitter}>`),
      {
        type: "actions",
        block_id: "review_actions",
        elements: [
          button("send_submission", "Send", value, "primary"),
          button("edit_submission", "Edit", value),
          {
            ...button("reject_submission", "Reject", value, "danger"),
            confirm: {
              title: plain("Reject this submission?"),
              text: mrkdwn("This removes it from the review queue."),
              confirm: plain("Reject"),
              deny: plain("Cancel"),
              style: "danger",
            },
          },
        ],
      },
    ],
  };
}

export function publishedMessage(s: Submission): Payload {
  return {
    text: s.headline,
    blocks: [
      section(`*${escape(s.headline)}*`),
      ...(s.quote ? [quote(s.quote)] : []),
      context(`${s.credit ? `Submitted by <@${s.submitter}>\n` : ""}Source: ${escape(s.source)}`),
    ],
  };
}

function resolvedMessage(s: Submission, status: "Sent" | "Rejected", reviewer: string): Payload {
  return {
    text: `${status}: ${s.headline}`,
    blocks: [
      ...reviewMessage(s).blocks.slice(0, -1),
      context(
        `${status === "Sent" ? ":white_check_mark:" : ":no_entry_sign:"} *${status}* by <@${reviewer}>`,
      ),
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
        text: `Could not open the News Wire form: ${reason(error)}`,
      });
    }
  });

  app.view(/^(new|edit)_submission$/, async ({ ack, body, view, client, logger }) => {
    const reference =
      view.callback_id === "edit_submission"
        ? (JSON.parse(view.private_metadata) as Reference)
        : undefined;
    const s = submissionFrom(view.state.values as Values, reference?.submitter ?? body.user.id);
    const e = errors(s);
    if (Object.keys(e).length) return ack({ response_action: "errors", errors: e });

    try {
      const m = reviewMessage(s);
      await (reference
        ? client.chat.update({ channel: reference.channel, ts: reference.ts, ...m })
        : client.chat.postMessage({ channel: env("SLACK_REVIEW_CHANNEL_ID"), ...m }));
      await ack();
    } catch (error) {
      logger.error(error);
      await ack({
        response_action: "errors",
        errors: { source: `Could not save submission: ${reason(error)}` },
      });
    }
  });

  app.action<BlockButtonAction>(
    "edit_submission",
    async ({ ack, body, action, client, logger }) => {
      await ack();
      const { channel, message } = body;
      if (!channel || !message) return;
      try {
        const s = decode(action.value);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: submissionModal(s, { channel: channel.id, ts: message.ts }),
        });
      } catch (error) {
        logger.error(error);
        await report(client, channel.id, body.user.id, "edit", error);
      }
    },
  );

  app.action<BlockButtonAction>(
    /^(send|reject)_submission$/,
    async ({ ack, body, action, client, logger }) => {
      await ack();
      const { channel, message } = body;
      if (!channel || !message) return;
      const key = `${channel.id}:${message.ts}`;
      if (busy.has(key)) return;
      busy.add(key);
      const send = action.action_id === "send_submission";
      try {
        const s = decode(action.value);
        if (send)
          await client.chat.postMessage({
            channel: env("SLACK_PUBLISH_CHANNEL_ID"),
            ...publishedMessage(s),
          });
        await client.chat.update({
          channel: channel.id,
          ts: message.ts,
          ...resolvedMessage(s, send ? "Sent" : "Rejected", body.user.id),
        });
      } catch (error) {
        logger.error(error);
        await report(client, channel.id, body.user.id, send ? "send" : "rejection", error);
      } finally {
        busy.delete(key);
      }
    },
  );
}

export function createApp(): App {
  const missing = required.filter((name) => !Bun.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

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

  const server = Bun.serve({
    port: Number(Bun.env.PORT ?? 3000),
    routes: { "/health": () => Response.json({ ok: true }) },
    fetch: () => new Response("Not found", { status: 404 }),
  });

  const stop = async () => {
    server.stop();
    await app.stop();
    process.exit(0);
  };
  (["SIGINT", "SIGTERM"] as const).forEach((signal) => process.once(signal, stop));

  app.logger.info(`On socket`);
  app.logger.info(`health on ${server.port}`);
}
