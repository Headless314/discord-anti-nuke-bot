# discord-anti-nuke-bot

A Discord.js anti-nuke bot that watches destructive server actions, attributes them through the Discord audit log, creates a structure backup when risk is detected, removes manageable dangerous roles, and sends a rate-limited alert to configured administrators.

## Protection

- Channel creation and deletion
- Role creation and deletion
- Member bans
- Bulk message-delete logging
- Audit-log attribution with retries
- Separate counters for every action type
- Per-server enable or disable control
- Persistent user, role, channel, and category whitelists
- Structure backups before automatic mitigation
- Direct administrator alerts by Discord user ID

The default command prefix is `>`.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user
- The bot role positioned above the roles it may need to remove
- View Audit Log
- Manage Roles
- Send Messages
- Embed Links
- Read Message History
- Server Members Intent enabled
- Message Content Intent enabled

The bot cannot remove a role above its highest role. It cannot undo already-deleted channels or roles. Audit-log attribution can be unavailable briefly while Discord propagates an event; those events are logged as unattributed and are not used for automatic punishment.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
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

7. Run `>setup` in the channel where security alerts should be posted.
8. Add alert recipients with `>admin add <discord-user-id>`.

The log channel, whitelists, alert recipients, and enable state are saved in `data/settings.json`. Automatic and manual backups are saved in `data/backups/`. Both paths are ignored by Git.

## Commands

### Protection

- `>help` - Show the black command-center help embed.
- `>help whitelist` - Show whitelist syntax.
- `>help backup` - Show backup syntax.
- `>help admin` - Show administrator alert syntax.
- `>status` - Show current server protection status.
- `>antinuke status` - Show current server protection status.
- `>antinuke enable` - Enable automatic mitigation.
- `>antinuke disable` - Disable automatic mitigation.
- `>setup` - Save the current channel as the security log channel.

### Whitelists

- `>whitelist user add <id>`
- `>whitelist user remove <id>`
- `>whitelist role add <id>`
- `>whitelist role remove <id>`
- `>whitelist channel add <id>`
- `>whitelist channel remove <id>`
- `>whitelist category add <id>`
- `>whitelist category remove <id>`
- `>whitelist list`

User whitelist entries ignore actions performed by those users. Role whitelist entries ignore users who hold those roles and protect a role with the matching ID from role deletion. Channel entries ignore actions on that channel. Category entries ignore actions on the category and its child channels.

IDs can be copied from Discord with Developer Mode enabled. Mentions such as `<@123>` and `<#123>` are also accepted.

### Administrator alerts

- `>admin add <id>` - Add an administrator recipient.
- `>admin remove <id>` - Remove a recipient.
- `>admin list` - List configured recipients.

When a configured recipient is a server administrator or the owner, the bot sends one direct alert per risk window. Notifications are capped at ten recipients and rate-limited to avoid DM spam. No alert is sent until a recipient is explicitly configured.

### Backups

- `>backup create` - Save a manual structure backup.
- `>backup list` - List this server's saved backups.
- `>backup inspect <file>` - Inspect a saved backup.

Backups include guild metadata, roles, role permissions, channels, categories, positions, topics, slowmode, and channel permission overwrites. Discord bot backups do not include message history, member private data, tokens, or a guaranteed one-command restore. The bot keeps the newest 25 backups per server.

## Configuration

- `COMMAND_PREFIX`: defaults to `>`.
- `NUKE_WINDOW_MS`: counting window in milliseconds; defaults to `30000`.
- `AUTO_BACKUP_ON_RISK`: create a structure backup before mitigation; defaults to `true`.
- `CHANNEL_DELETE_THRESHOLD`, `CHANNEL_CREATE_THRESHOLD`, `ROLE_DELETE_THRESHOLD`, `ROLE_CREATE_THRESHOLD`, `BAN_THRESHOLD`: per-action thresholds.
- `TRUSTED_USER_IDS`: comma-separated IDs excluded from automatic action.
- `LOG_CHANNEL_ID`: optional fallback log channel for servers that have not run `>setup`.

Keep `.env` and `data/settings.json` private.