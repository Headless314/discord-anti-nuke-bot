# discord-anti-nuke-bot

A Discord.js anti-nuke bot that watches destructive server actions, attributes them through the Discord audit log, creates a structure backup when risk is detected, removes manageable dangerous roles, and sends a rate-limited alert to configured administrators.

## Protection

- Channel creation and deletion
- Role creation and deletion
- Member bans
- Member kicks
- Bulk message-delete logging
- Audit-log attribution with retries
- Separate counters for every action type
- Per-server enable or disable control
- Per-server thresholds and activity windows
- Dry-run mode for safe testing
- Recent audit-log inspection
- Activity counter reset
- Persistent user, role, channel, and category whitelists
- Structure backups before automatic mitigation
- Direct administrator alerts by Discord user ID
- Server utility and moderation commands with permission checks
- Emergency server lockdown mode
- Owner-only DM security logs for moderation events and deleted message media
- Runtime activity state restored after clean restarts
- Red two-page command-center help with button navigation
- Owner-only web dashboard for thresholds, time windows, protection state, recent activity, backups, whitelist management, and per-action punishments
- Administrator DM alerts for configured risky activity, including dangerous permission roles being granted

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

When the bot connects, it prints a private owner dashboard link to the console. Open that link to manage protection state, dry-run mode, lockdown, thresholds, activity windows, risk backups, whitelist entries, and the response for each action. The old Discord dashboard command was removed; the existing embeds and other moderation commands are unchanged.

Whitelists, alert settings, enable state, server configuration, and the global bot status are saved in `data/settings.json`. Runtime activity counters are saved in `data/runtime.json` during shutdown and restored on startup. Automatic and manual backups are saved in `data/backups/`. These data paths are ignored by Git.

## Commands

### Protection

- `>help` - Show the red two-page command-center help; press `🙏🏻` to open page two.
- `>help whitelist` - Show whitelist syntax.
- `>help backup` - Show backup syntax.
- `>help admin` - Show administrator alert syntax.
- `>help utility` - Show utility and moderation command syntax.
- `>status` - Show current server protection status.
- `>antinuke status` - Show current server protection status.
- `>antinuke enable` - Enable automatic mitigation.
- `>antinuke disable` - Disable automatic mitigation.
- `>antinuke dry-run on|off` - Detect and log risk without removing roles.
- `>antinuke reset` - Clear current activity counters and pending mitigations.
- `>setup` - Save the current channel as the security log channel.

### Utility and moderation

- `>ping` - Check WebSocket latency.
- `>serverinfo` - Show server owner, member count, roles, channels, and creation date.
- `>userinfo [@user]` - Show account, join date, and server roles.
- `>channelinfo [#channel]` - Show channel metadata.
- `>roleinfo <@role>` - Show role metadata and permissions.
- `>purge <1-100>` - Delete recent messages; requires Manage Messages.
- `>slowmode <0-21600>` - Read or set the current channel slowmode; requires Manage Channels.
- `>lockdown on|off|status` - Deny or restore @everyone message sending across manageable text channels; requires Administrator.

Whitelist changes are owner-only. Both `>whitelist add @user` and `>whitelist user add @user` are supported; Discord mentions are accepted.

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
- `>whitelist clear user|role|channel|category`
- `>whitelist clear all`

User whitelist entries ignore actions performed by those users. Role whitelist entries ignore users who hold those roles and protect a role with the matching ID from role deletion. Channel entries ignore actions on that channel. Category entries ignore actions on the category and its child channels.

IDs can be copied from Discord with Developer Mode enabled. Mentions such as `<@123>` and `<#123>` are also accepted.

### Administrator alerts

- `>admin add <id>` - Add an administrator recipient.
- `>admin remove <id>` - Remove a recipient.
- `>admin list` - List configured recipients.
- `>admin test` - Send a test notification to configured recipients.

Risk alerts and security logs are sent by DM to `OWNER_USER_ID`, or to each server owner when that setting is blank. Deleted message logs include text plus image, video, audio, voice-message, and other attachment URLs. Bot-authored actions and bot-authored deleted messages are ignored.

Configured `>admin add <id>` recipients receive threshold risk alerts and alerts when a role granting administrator, server management, channel management, role management, ban, or kick permissions is granted. The owner remains the default recipient.

### Backups

- `>backup create` - Save a manual structure backup.
- `>backup list` - List this server's saved backups.
- `>backup inspect <file>` - Inspect a saved backup.

### Audit and configuration

- `>audit recent` - Show the latest ten audit-log entries.
- `>audit recent 15` - Show up to fifteen audit-log entries.
- `>logs recent` - Alias for `>audit recent`.
- `>config show` - Show server-specific overrides.
- `>config threshold <type> <number>` - Set a threshold from 1 to 100.
- `>config window <seconds>` - Set the activity window from 5 to 3600 seconds.
- `>config backup on|off` - Enable or disable automatic risk backups.
- `>config dry-run on|off` - Enable or disable dry-run mode.

The dashboard can choose `remove dangerous roles`, `kick`, `ban`, or `log only` independently for channel creates/deletes, role creates/deletes, kicks, and bans. The default remains dangerous-role removal.

### Direct-message media

- `>pfp` - Save attached images for rotating bot profile pictures.
- `>banner` - Save attached images for rotating bot banners.
- `>clear pfp` - Delete all saved profile-picture images.
- `>clear banner` - Delete all saved banner images.

Supported threshold types are `channel-delete`, `channel-create`, `role-delete`, `role-create`, `kick`, and `ban`. The dashboard also accepts `mass-create` as a shortcut for channel creation.

Use dry-run mode before changing thresholds in a live server. It continues to record risk and create configured backups, but it does not remove roles.

Backups include guild metadata, roles, role permissions, channels, categories, positions, topics, slowmode, and channel permission overwrites. Discord bot backups do not include message history, member private data, tokens, or a guaranteed one-command restore. The bot keeps the newest 25 backups per server.

## Configuration

- `COMMAND_PREFIX`: defaults to `>`.
- `NUKE_WINDOW_MS`: counting window in milliseconds; defaults to `30000`.
- `AUTO_BACKUP_ON_RISK`: create a structure backup before mitigation; defaults to `true`.
- `CHANNEL_DELETE_THRESHOLD`, `CHANNEL_CREATE_THRESHOLD`, `ROLE_DELETE_THRESHOLD`, `ROLE_CREATE_THRESHOLD`, `BAN_THRESHOLD`: per-action thresholds.
- `TRUSTED_USER_IDS`: comma-separated IDs excluded from automatic action.
- `LOG_CHANNEL_ID`: optional fallback log channel for servers that have not run `>setup`.
- `OWNER_USER_ID`: optional Discord user ID that receives DM logs and owns whitelist changes; if blank, each server owner is used.
- `SERVER_PORT`: port supplied by Bot Hosting; the dashboard uses it automatically when present.
- `DASHBOARD_PORT`: fallback dashboard port for hosts that do not provide `SERVER_PORT` or `PORT`; defaults to `3000`.
- `DASHBOARD_TOKEN`: private first-factor token; if blank, a fresh token is generated on each start.
- `DASHBOARD_PASSWORD`: required second-factor password for the dashboard; keep it in the host's environment variables and use at least 12 characters.

Dashboard security uses the private access token, the password, HttpOnly/SameSite session cookies, timing-safe password comparison, five-attempt login throttling, same-origin checks for writes, and security response headers.
- `DASHBOARD_PUBLIC_URL`: optional public URL override; this deployment defaults to `https://a19nivomrr.apps.bot-hosting.cloud`, and the access token is added automatically.
- `DASHBOARD_PUBLIC_HOST`: public hostname or IP when the host exposes the dashboard port directly; the bot formats it as `http://host:<port>/dashboard/`. Bot Hosting users must expose `DASHBOARD_PORT` in the panel.

The dashboard server listens on `0.0.0.0` so hosting providers can route traffic to it. A localhost URL is only usable from the machine running the bot; configure one of the public URL/host variables for remote access.

Whitelist entries and dashboard settings are saved immediately to `data/settings.json` using an atomic file replacement, so they survive normal restarts. Make sure the hosting provider keeps the `data/` directory on persistent storage when redeploying.

Keep `.env` and `data/settings.json` private.