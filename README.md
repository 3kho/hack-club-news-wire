# Hack Club News Wire relay

A small Bun-powered Slack bot built on Slack's official [`@slack/bolt`](https://docs.slack.dev/tools/bolt-js/) TypeScript SDK. It collects News Wire submissions and relays approved stories to another channel.

## How it works

1. A Slack user runs `/news-wire`.
2. The bot opens a modal for a headline, source, and optional exact quote.
3. The submission appears in a private review channel with **Send**, **Edit**, and **Reject** buttons.
4. **Send** publishes it to the destination channel, **Edit** updates the queued submission, and **Reject** closes it without publishing.

Bolt handles the Socket Mode connection, acknowledgements, listener routing, and typed Web API client. The app stores submission state in Slack's button payload, so it does not need a database and queued submissions continue to work after a restart.

## Set up Slack

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From an app manifest**, select the workspace, and paste `manifest.yaml`.
2. Install the app to the workspace.
3. On **Basic Information**, create an app-level token with the `connections:write` scope. This is the `xapp-` token used by Socket Mode.
4. Invite the bot to both the private review channel and the channel where approved stories should be published.
5. Copy `.env.example` to `.env` and fill in:

   - `SLACK_BOT_TOKEN`: the app's `xoxb-` **Bot User OAuth Token** from OAuth & Permissions.
   - `SLACK_APP_TOKEN`: the app's `xapp-` app-level token from Basic Information.
   - `SLACK_REVIEW_CHANNEL_ID`: the private review channel ID.
   - `SLACK_PUBLISH_CHANNEL_ID`: the destination channel ID.

Channel IDs are available from **View channel details → About** in Slack. Socket Mode makes an outbound WebSocket connection, so no public Slack request URL or tunnel is required.

## Run locally

```bash
bun install
bun run dev
```

Check the running service with `curl http://localhost:3000/health`. It returns `{"ok":true}` after the Slack socket is connected. The process exits at startup with a list of any missing Slack settings.

## Deploy on Coolify

1. Create a Coolify application from this repository and choose the **Dockerfile** build pack.
2. Set port `3000` and health-check path `/health`. The Dockerfile also contains its own health check, which takes precedence in Coolify.
3. Add the four variables from `.env.example` as runtime-only environment variables. Keep both Slack tokens secret and do not set them as build variables.
4. Deploy. A domain is optional because Slack traffic uses the outbound Socket Mode connection; port 3000 only serves the internal health check.

The image installs locked production dependencies in a separate stage, runs as the unprivileged `bun` user, and shuts down the Slack connection on `SIGTERM` during Coolify deployments.

## Test it

```bash
bun test
bun run typecheck
```
