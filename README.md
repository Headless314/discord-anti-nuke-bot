# discord-anti-nuke-bot

A Discord.js anti-nuke bot that watches destructive server actions, attributes them through the Discord audit log, and removes manageable dangerous roles when a user crosses a configurable threshold.

## What it protects

- Channel creation and deletion
- Role creation and deletion
- Member bans
- Bulk message-delete logging

Each action type has its own counter and time window. The bot only takes action after it can attribute the event to an audit-log executor. It never removes roles from the server owner, itself, or IDs listed in `TRUSTED_USER_IDS`.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user
- The bot's role positioned above the roles it may need to remove
- The bot can **View Audit Log**, **Manage Roles**, **Send Messages**, **Embed Links**, and **Read Message History**
- Enable the **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal

The bot cannot remove a role above its highest role, and it cannot undo already-deleted channels or roles. Audit-log attribution can also be unavailable briefly while Discord propagates an event; those events are logged as unattributed and are not used for automatic punishment.

## Setup

1. Create a Discord application and bot at the Discord Developer Portal.
2. Enable the Server Members and Message Content privileged intents.
3. Invite the bot with the permissions listed above and the `bot` scope.
4. Install dependencies:

   ~~~sh
   npm install
   ~~~

5. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
6. Start the bot:

   ~~~sh
   npm start
   ~~~

7. In each server, run `!setup` in the channel where security alerts should be posted. The setting is saved to `data/settings.json` and survives restarts.

## Configuration

- `NUKE_WINDOW_MS`: counting window in milliseconds; defaults to `30000`.
- `CHANNEL_DELETE_THRESHOLD`, `CHANNEL_CREATE_THRESHOLD`, `ROLE_DELETE_THRESHOLD`, `ROLE_CREATE_THRESHOLD`, `BAN_THRESHOLD`: per-action thresholds.
- `TRUSTED_USER_IDS`: comma-separated Discord user IDs excluded from automatic action.
- `LOG_CHANNEL_ID`: optional fallback log channel for servers that have not run `!setup`.
- `COMMAND_PREFIX`: command prefix; defaults to `!`.

Keep `.env` and `data/settings.json` private. They are ignored by Git.

## Commands

- `!setup` — save the current channel as this server's security log channel (administrator only)
- `!status` — show bot and log-channel status
- `!help` — show available commands