const {
  AuditLogEvent,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const dotenv = require('dotenv');
const fs = require('node:fs');
const path = require('node:path');

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const numberFromEnv = (name, fallback, minimum = 1) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
};

const config = {
  token: process.env.DISCORD_TOKEN,
  prefix: process.env.COMMAND_PREFIX || '!',
  defaultLogChannelId: process.env.LOG_CHANNEL_ID || null,
  windowMs: numberFromEnv('NUKE_WINDOW_MS', 30_000, 1_000),
  thresholds: {
    channel_delete: numberFromEnv('CHANNEL_DELETE_THRESHOLD', 5),
    channel_create: numberFromEnv('CHANNEL_CREATE_THRESHOLD', 5),
    role_delete: numberFromEnv('ROLE_DELETE_THRESHOLD', 5),
    role_create: numberFromEnv('ROLE_CREATE_THRESHOLD', 5),
    ban: numberFromEnv('BAN_THRESHOLD', 10),
  },
  trustedUserIds: new Set(
    (process.env.TRUSTED_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ),
};

const dataDirectory = path.join(__dirname, 'data');
const settingsFile = path.join(dataDirectory, 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read data/settings.json:', error.message);
    }
    return {};
  }
}

const settings = loadSettings();

function saveSettings() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function getGuildSettings(guildId) {
  return settings[guildId] || {};
}

function getLogChannelId(guildId) {
  return getGuildSettings(guildId).logChannelId || config.defaultLogChannelId;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logAction(guild, title, description, color = 0xff0000) {
  const logChannelId = getLogChannelId(guild.id);
  if (!logChannelId) return;

  const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle('🛡️ ' + title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: 'Guild: ' + guild.name });

  await logChannel.send({ embeds: [embed] }).catch((error) => {
    console.error('Could not send security log:', error.message);
  });
}

async function findExecutor(guild, action, targetId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const auditLogs = await guild.fetchAuditLogs({ type: action, limit: 10 });
      const entry = auditLogs.entries.find((candidate) => {
        const isRecent = Date.now() - candidate.createdTimestamp < 15_000;
        return isRecent && candidate.target && candidate.target.id === targetId;
      });
      if (entry && entry.executor) return entry.executor;
    } catch (error) {
      if (attempt === 2) {
        console.error('Could not read audit log:', error.message);
      }
    }
    if (attempt < 2) await wait(500);
  }
  return null;
}

const activity = new Collection();

function trackActivity(userId, guildId, type) {
  const now = Date.now();
  const key = guildId + ':' + userId + ':' + type;
  let record = activity.get(key);

  if (!record || now - record.startedAt > config.windowMs) {
    record = { count: 0, startedAt: now };
    activity.set(key, record);
  }

  record.count += 1;
  return record.count;
}

function isTrusted(userId) {
  return config.trustedUserIds.has(userId);
}

async function handleSuspiciousUser(guild, userId, reason) {
  if (isTrusted(userId) || userId === guild.ownerId || userId === client.user.id) {
    return;
  }

  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    if (!member.manageable) {
      await logAction(
        guild,
        '🚨 SUSPICIOUS USER',
        '<@' + userId + '> - ' + reason + '\nI could not remove roles because this member is above the bot in the role hierarchy.',
        0xff0000,
      );
      return;
    }

    const dangerousRoles = member.roles.cache.filter((role) => {
      const isDangerous = [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
      ].some((permission) => role.permissions.has(permission));
      return isDangerous && role.editable && role.id !== guild.id;
    });

    if (dangerousRoles.size === 0) {
      await logAction(
        guild,
        '🚨 SUSPICIOUS USER',
        '<@' + userId + '> - ' + reason + '\nNo manageable dangerous roles were found.',
        0xff0000,
      );
      return;
    }

    for (const role of dangerousRoles.values()) {
      await member.roles.remove(role, 'Anti-nuke: ' + reason).catch((error) => {
        console.error('Could not remove role:', error.message);
      });
    }

    await logAction(
      guild,
      '🚨 SUSPICIOUS USER',
      '<@' + userId + '> - ' + reason + ' - removed ' + dangerousRoles.size + ' dangerous role(s).',
      0xff0000,
    );
  } catch (error) {
    console.error('Could not handle suspicious user:', error.message);
  }
}

async function recordActivity({
  guild,
  target,
  auditAction,
  type,
  title,
  details,
  reason,
  color = 0xff6600,
}) {
  const executor = await findExecutor(guild, auditAction, target.id);
  if (!executor) {
    await logAction(guild, title, details + '\n**By:** Unknown (audit log entry was not available yet).', color);
    return;
  }

  if (isTrusted(executor.id)) return;

  const count = trackActivity(executor.id, guild.id, type);
  const threshold = config.thresholds[type];
  await logAction(
    guild,
    title,
    details + '\n**By:** <@' + executor.id + '>\n**Count:** ' + count + '/' + threshold,
    color,
  );

  if (count >= threshold) {
    await handleSuspiciousUser(guild, executor.id, reason);
  }
}

client.once('ready', () => {
  console.log('✅ Bot logged in as ' + client.user.tag);
  client.user.setActivity('for nukes 🛡️', { type: 'WATCHING' });
});

client.on('messageDeleteBulk', async (messages, channel) => {
  if (!channel.guild || messages.size <= 10) return;
  await logAction(
    channel.guild,
    'Bulk Delete',
    messages.size +
      ' messages deleted in <#' +
      channel.id +
      '>.\nThe Discord message-delete event does not reliably identify the actor; review the server audit log for attribution.',
    0xffff00,
  );
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  await recordActivity({
    guild: channel.guild,
    target: channel,
    auditAction: AuditLogEvent.ChannelDelete,
    type: 'channel_delete',
    title: 'Channel Deleted',
    details: '**Channel:** ' + channel.name,
    reason: 'mass channel deletion',
  });
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  await recordActivity({
    guild: channel.guild,
    target: channel,
    auditAction: AuditLogEvent.ChannelCreate,
    type: 'channel_create',
    title: 'Channel Created',
    details: '**Channel:** <#' + channel.id + '>',
    reason: 'mass channel creation',
    color: 0xff0000,
  });
});

client.on('roleDelete', async (role) => {
  await recordActivity({
    guild: role.guild,
    target: role,
    auditAction: AuditLogEvent.RoleDelete,
    type: 'role_delete',
    title: 'Role Deleted',
    details: '**Role:** ' + role.name,
    reason: 'mass role deletion',
  });
});

client.on('roleCreate', async (role) => {
  await recordActivity({
    guild: role.guild,
    target: role,
    auditAction: AuditLogEvent.RoleCreate,
    type: 'role_create',
    title: 'Role Created',
    details: '**Role:** ' + role.name,
    reason: 'mass role creation',
    color: 0xff0000,
  });
});

client.on('guildBanAdd', async (ban) => {
  await recordActivity({
    guild: ban.guild,
    target: ban.user,
    auditAction: AuditLogEvent.MemberBanAdd,
    type: 'ban',
    title: 'Member Banned',
    details: '**Member:** <@' + ban.user.id + '>',
    reason: 'mass bans',
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(config.prefix)) return;

  const commandText = message.content.slice(config.prefix.length).trim();
  if (!commandText) return;
  const args = commandText.split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'status') {
    const logChannelId = getLogChannelId(message.guild.id);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🛡️ Bot Status')
          .setDescription(
            'Bot is online!\nLog channel: ' +
              (logChannelId ? '<#' + logChannelId + '>' : 'not configured'),
          )
          .setColor(0x00ff00),
      ],
    });
  } else if (command === 'setup') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply('❌ Administrator permission required.');
      return;
    }

    settings[message.guild.id] = {
      ...getGuildSettings(message.guild.id),
      logChannelId: message.channel.id,
    };
    try {
      saveSettings();
      await message.reply('✅ Log channel saved for this server.');
    } catch (error) {
      console.error('Could not save settings:', error.message);
      await message.reply('⚠️ Log channel was set for this run, but saving to disk failed.');
    }
  } else if (command === 'help') {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🛡️ Commands')
          .addFields(
            {
              name: config.prefix + 'setup',
              value: 'Save the current channel as the security log channel.',
            },
            { name: config.prefix + 'status', value: 'Check bot and log-channel status.' },
            { name: config.prefix + 'help', value: 'Show this message.' },
          )
          .setColor(0x0099ff),
      ],
    });
  }
});

client.on('error', (error) => console.error('Discord client error:', error.message));
process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));

if (!config.token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.');
  process.exitCode = 1;
} else {
  client.login(config.token).catch((error) => {
    console.error('Could not log in to Discord:', error.message);
    process.exitCode = 1;
  });
}