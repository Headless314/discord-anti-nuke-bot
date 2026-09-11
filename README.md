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

When the bot connects, it prints a private owner dashboard link to the console. Open that link to manage protection state, dry-run mode, lockdown, thresholds, activity windows, risk backups, whitelist entries, and the response for each action. The old Discord dashboard command was removed. Command responses use Discord ANSI code blocks with rotating green, yellow, violet, and red lines where the client supports ANSI rendering.

Whitelists, alert settings, enable state, server configuration, and the global bot status are saved in `data/settings.json`. Runtime activity counters are saved in `data/runtime.json` during shutdown and restored on startup. Automatic and manual backups are saved in `data/backups/`. These data paths are ignored by Git.

### Railway deployment

Railway detects this as a Node.js service from `package.json` and starts it with `npm start`. Set `DISCORD_TOKEN` and `DASHBOARD_PASSWORD` in Railway Variables, then attach a public domain to the service for dashboard access. Railway supplies `PORT` automatically; do not add a `requirements.txt` file or a Python build command.

## Commands

### Protection

- `>help` - Show the red two-page command-center help; press `🙏🏻` to open page two.
- `>help whitelist` - Show whitelist syntax.
- `>help backup` - Show backup syntax.
- `>help admin` - Show administrator alert syntax.
- `>help utility` - Show utility and moderation command syntax.
- `>prefix x` - Change the command prefix to `x` as the server owner; use the new prefix for all future commands. `>prefix reset` restores `>`.
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

- `COMMAND_PREFIX`: startup default is `>`. The server owner can change it at runtime with `>prefix x`; command parsing and generated help/error messages use the new value everywhere, including whitelist help.
- `NUKE_WINDOW_MS`: counting window in milliseconds; defaults to `30000`.
- `AUTO_BACKUP_ON_RISK`: create a structure backup before mitigation; defaults to `true`.
- `CHANNEL_DELETE_THRESHOLD`, `CHANNEL_CREATE_THRESHOLD`, `ROLE_DELETE_THRESHOLD`, `ROLE_CREATE_THRESHOLD`, `BAN_THRESHOLD`: per-action thresholds.
- `TRUSTED_USER_IDS`: comma-separated IDs excluded from automatic action.
- `LOG_CHANNEL_ID`: optional fallback log channel for servers that have not run `>setup`.
- `OWNER_USER_ID`: optional Discord user ID that receives DM logs and owns whitelist changes; if blank, each server owner is used.
- `PORT`: port supplied by Railway and most Node hosts; it takes priority automatically.
- `SERVER_PORT`: port supplied by Bot Hosting; used when `PORT` is not available.
- `DASHBOARD_PORT`: fallback dashboard port for hosts that provide neither `PORT` nor `SERVER_PORT`; defaults to `3000`.
- `DASHBOARD_TOKEN`: optional private access token; if blank, a fresh token is generated on each start.
- `DASHBOARD_REQUIRE_TOKEN`: set to `on` to require the private access token in addition to the password. It defaults to `off`, making the dashboard public at its HTTPS URL while still requiring `DASHBOARD_PASSWORD`.
- `DASHBOARD_PASSWORD`: required password for the public dashboard; keep it in the host's environment variables and use at least 12 characters.

Dashboard security uses the private access token, the password, HttpOnly/SameSite session cookies, timing-safe password comparison, five-attempt login throttling, same-origin checks for writes, and security response headers.
- `DASHBOARD_PUBLIC_URL`: optional public URL override for the public app endpoint; the access token is added automatically. On Bot Hosting, use the public app URL (for example, `https://your-public-app.apps.bot-hosting.cloud`), not the control-panel URL such as `https://bot-hosting.net/a/d/<id>`.
- `DASHBOARD_PUBLIC_HOST`: public hostname or IP when the host exposes the dashboard port directly; the bot formats it as `http://host:<port>/dashboard/`.
- `RAILWAY_PUBLIC_DOMAIN`: Railway's public domain, detected automatically when Railway provides it; HTTPS is assumed when no scheme is included.
- `CLOUDFLARE_TUNNEL`: starts a temporary Cloudflare Quick Tunnel automatically and prints the HTTPS dashboard link immediately, then checks reachability in the background. It is enabled by default; set it to `off` only to disable it. This does not require a Cloudflare account, but the link changes when the bot restarts.
- `CLOUDFLARED_BIN`: optional path to the `cloudflared` executable. Leave it blank or omit it; the bot uses the installed package and then falls back to `npx cloudflared`. The placeholder value `cloudflared` is also treated as blank so copied example settings work.

The dashboard server listens on `0.0.0.0` so Railway and other hosting providers can route traffic to it. Railway's `PORT` and public domain are detected automatically; for other hosts, configure a public URL/host and expose the selected port. The Bot Hosting control-panel URL is not an app endpoint and will return 404 for dashboard assets.

### Automatic HTTPS link with Cloudflare

GitHub Pages is not suitable for this dashboard because it only hosts static files; the dashboard also needs the private Node.js API running alongside the bot. The project now includes the `cloudflared` package, which downloads the matching Cloudflare executable during the first tunnel start. Set `CLOUDFLARE_TUNNEL=on` (the default) and restart the bot. The bot will start a Cloudflare Quick Tunnel to its local dashboard port and print a link like:

```text
Owner dashboard (Cloudflare): https://example.trycloudflare.com/dashboard/
```

The dashboard still requires `DASHBOARD_PASSWORD`. Quick Tunnel URLs are temporary and should be treated as private even though the password is required; do not post the printed link publicly. Use the exact hostname printed by the bot; it ends in `trycloudflare.com` (not `tryclodflare.com`), and an old link can stop resolving after a restart. If the host blocks executable downloads or outbound Cloudflare connections, Quick Tunnel cannot work there; in that case use `DASHBOARD_PUBLIC_URL` or `DASHBOARD_PUBLIC_HOST` instead.

Whitelist entries and dashboard settings are saved immediately to `data/settings.json` using an atomic file replacement, so they survive normal restarts. Make sure the hosting provider keeps the `data/` directory on persistent storage when redeploying.

Keep `.env` and `data/settings.json` private.