const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const dotenv = require('dotenv');
const fs = require('node:fs');
const path = require('node:path');

dotenv.config();

const EMBED_BLACK = 0x000000;

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

const booleanFromEnv = (name, fallback) => {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(process.env[name].toLowerCase());
};

const config = {
  token: process.env.DISCORD_TOKEN,
  ownerUserId: process.env.OWNER_USER_ID || null,
  prefix: process.env.COMMAND_PREFIX || '>',
  defaultLogChannelId: process.env.LOG_CHANNEL_ID || null,
  windowMs: numberFromEnv('NUKE_WINDOW_MS', 30_000, 1_000),
  autoBackupOnRisk: booleanFromEnv('AUTO_BACKUP_ON_RISK', true),
  thresholds: {
    channel_delete: numberFromEnv('CHANNEL_DELETE_THRESHOLD', 5),
    channel_create: numberFromEnv('CHANNEL_CREATE_THRESHOLD', 5),
    role_delete: numberFromEnv('ROLE_DELETE_THRESHOLD', 5),
    role_create: numberFromEnv('ROLE_CREATE_THRESHOLD', 5),
    kick: numberFromEnv('KICK_THRESHOLD', 10),
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
const runtimeFile = path.join(dataDirectory, 'runtime.json');
const backupDirectory = path.join(dataDirectory, 'backups');
const maxBackupsPerGuild = 25;
const snowflakePattern = /^\d{15,20}$/;

const whitelistNames = {
  category: 'categories',
  categories: 'categories',
  channel: 'channels',
  channels: 'channels',
  role: 'roles',
  roles: 'roles',
  user: 'users',
  users: 'users',
};

const thresholdNames = {
  channel_delete: 'channel_delete',
  'channel-delete': 'channel_delete',
  channel_create: 'channel_create',
  'channel-create': 'channel_create',
  role_delete: 'role_delete',
  'role-delete': 'role_delete',
  role_create: 'role_create',
  'role-create': 'role_create',
  kick: 'kick',
  kicks: 'kick',
  'mass-create': 'channel_create',
  mass_create: 'channel_create',
  ban: 'ban',
  bans: 'ban',
};

const auditActionLabels = {
  ChannelCreate: 'channel create',
  ChannelDelete: 'channel delete',
  RoleCreate: 'role create',
  RoleDelete: 'role delete',
  MemberBanAdd: 'member ban',
  MemberKick: 'member kick',
  MemberPrune: 'member prune',
  MessageBulkDelete: 'bulk message delete',
  MemberRoleUpdate: 'member role update',
  ChannelOverwriteCreate: 'channel permission create',
  ChannelOverwriteUpdate: 'channel permission update',
  ChannelOverwriteDelete: 'channel permission delete',
};

function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read data/settings.json:', error.message);
    }
    return {};
  }
}

const settings = loadSettings();


const mediaRotationTimers = { avatar: null, banner: null };

function getMediaRotation(kind) {
  const saved = settings.__rotatingMedia && settings.__rotatingMedia[kind];
  if (Array.isArray(saved)) return { items: saved, index: 0 };
  if (!saved || !Array.isArray(saved.items)) return { items: [], index: 0 };
  return {
    items: saved.items.filter((item) => item && typeof item.path === 'string'),
    index: Number.isInteger(saved.index) && saved.index >= 0 ? saved.index : 0,
  };
}

function getMediaPath(item) {
  if (!item || typeof item.path !== 'string') return null;
  const root = path.resolve(dataDirectory) + path.sep;
  const candidate = path.resolve(__dirname, item.path);
  return candidate.startsWith(root) ? candidate : null;
}

function isImageAttachment(attachment) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  const name = String(attachment.name || attachment.url || '').toLowerCase();
  return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name);
}

function mediaExtension(attachment) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  const typeMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  if (typeMap[contentType]) return typeMap[contentType];
  const match = String(attachment.name || '').match(/\.(png|jpe?g|gif|webp)$/i);
  return match ? (match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()) : 'png';
}

async function applyRotatingMedia(kind) {
  if (!client.user) return false;
  const rotation = getMediaRotation(kind);
  const items = rotation.items.filter((item) => getMediaPath(item) && fs.existsSync(getMediaPath(item)));
  if (!items.length) return false;
  const index = rotation.index % items.length;
  const item = items[index];
  const filePath = getMediaPath(item);
  try {
    const buffer = fs.readFileSync(filePath);
    if (kind === 'avatar') await client.user.setAvatar(buffer);
    else await client.user.setBanner(buffer);
    settings.__rotatingMedia = settings.__rotatingMedia || {};
    settings.__rotatingMedia[kind] = { items, index: (index + 1) % items.length };
    saveSettings();
    return true;
  } catch (error) {
    console.error('Could not rotate ' + kind + ':', error.message);
    return false;
  }
}

async function startMediaRotation(kind) {
  if (mediaRotationTimers[kind]) clearInterval(mediaRotationTimers[kind]);
  if (!client.user) return;
  await applyRotatingMedia(kind);
  mediaRotationTimers[kind] = setInterval(() => {
    applyRotatingMedia(kind).catch((error) => console.error('Media rotation error:', error.message));
  }, 60 * 60 * 1000);
}

function lastMediaCommandTimestamp(messages, message, kind) {
  let timestamp = -1;
  const commandText = config.prefix + kind;
  for (const candidate of messages) {
    if (candidate.id === message.id || candidate.author.id !== message.author.id) continue;
    const firstToken = String(candidate.content || '').trim().split(/\s+/)[0].toLowerCase();
    if (firstToken === commandText.toLowerCase()) timestamp = Math.max(timestamp, candidate.createdTimestamp);
  }
  return timestamp;
}

async function collectDirectMessageAttachments(message, kind) {
  const history = await message.channel.messages.fetch({ limit: 100 });
  const messages = [...history.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);
  const previousCommandAt = lastMediaCommandTimestamp(messages, message, kind);
  return messages
    .filter((candidate) => candidate.author.id === message.author.id && (candidate.id === message.id || candidate.createdTimestamp > previousCommandAt))
    .flatMap((candidate) => [...candidate.attachments.values()])
    .filter(isImageAttachment)
    .slice(-25);
}

async function saveRotatingMediaFromDm(message, kind) {
  const attachments = await collectDirectMessageAttachments(message, kind);
  if (!attachments.length) {
    await message.reply('Send one or more image attachments in this DM, then send ' + config.prefix + kind + '.');
    return;
  }

  const directory = path.join(dataDirectory, 'rotating-assets', kind);
  fs.mkdirSync(directory, { recursive: true });
  const savedItems = [];
  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error('Attachment download returned HTTP ' + response.status);
      const filePath = path.join(directory, Date.now() + '-' + index + '.' + mediaExtension(attachment));
      fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      savedItems.push({ path: path.relative(__dirname, filePath), name: attachment.name || 'image' });
    }

    const oldRotation = getMediaRotation(kind);
    const newPaths = new Set(savedItems.map((item) => getMediaPath(item)));
    for (const oldItem of oldRotation.items) {
      const oldPath = getMediaPath(oldItem);
      if (oldPath && !newPaths.has(oldPath) && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    settings.__rotatingMedia = settings.__rotatingMedia || {};
    settings.__rotatingMedia[kind] = { items: savedItems, index: 0 };
    saveSettings();
    await startMediaRotation(kind);
    await message.reply('Saved ' + savedItems.length + ' ' + kind + ' image(s). Rotation will change every hour.');
  } catch (error) {
    for (const item of savedItems) {
      const filePath = getMediaPath(item);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await message.reply('Could not save the ' + kind + ' images: ' + error.message);
  }
}

async function handleDirectMessageCommand(message) {
  if (!config.ownerUserId || message.author.id !== config.ownerUserId) return;
  const commandText = message.content.slice(config.prefix.length).trim();
  if (!commandText) return;
  const args = commandText.split(/ +/);
  const command = args.shift().toLowerCase();
  if (command === 'pfp' || command === 'avatar') {
    await saveRotatingMediaFromDm(message, 'avatar');
  } else if (command === 'banner') {
    await saveRotatingMediaFromDm(message, 'banner');
  }
}

function getGuildSettings(guildId) {
  const guildSettings = settings[guildId] || {};
  guildSettings.enabled = guildSettings.enabled !== false;
  guildSettings.dryRun = guildSettings.dryRun === true;
  guildSettings.lockdown = guildSettings.lockdown === true;
  guildSettings.windowMs =
    Number.isInteger(guildSettings.windowMs) && guildSettings.windowMs >= 5_000
      ? Math.min(guildSettings.windowMs, 3_600_000)
      : config.windowMs;
  guildSettings.autoBackupOnRisk = guildSettings.autoBackupOnRisk !== false;
  guildSettings.thresholds = guildSettings.thresholds || {};
  for (const type of Object.keys(config.thresholds)) {
    if (
      !Number.isInteger(guildSettings.thresholds[type]) ||
      guildSettings.thresholds[type] < 1
    ) {
      guildSettings.thresholds[type] = config.thresholds[type];
    }
  }
  guildSettings.logChannelId = guildSettings.logChannelId || null;
  guildSettings.alertAdminIds = Array.isArray(guildSettings.alertAdminIds)
    ? guildSettings.alertAdminIds
    : [];
  guildSettings.whitelist = guildSettings.whitelist || {};

  for (const listName of Object.values(whitelistNames)) {
    guildSettings.whitelist[listName] = Array.isArray(guildSettings.whitelist[listName])
      ? guildSettings.whitelist[listName]
      : [];
  }

  settings[guildId] = guildSettings;
  return guildSettings;
}

function getThreshold(guildId, type) {
  return getGuildSettings(guildId).thresholds[type] || config.thresholds[type];
}

function getWindowMs(guildId) {
  return getGuildSettings(guildId).windowMs;
}

function saveSettings() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function getLogChannelId(guildId) {
  return getGuildSettings(guildId).logChannelId || config.defaultLogChannelId;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeId(value) {
  if (!value) return null;
  const id = value.replace(/[<@!#&>]/g, '');
  return snowflakePattern.test(id) ? id : null;
}


function getOwnerUserId(guild) {
  return config.ownerUserId || guild.ownerId;
}

function isGuildOwner(message) {
  return message.author.id === getOwnerUserId(message.guild);
}

function sanitizeLogText(value) {
  return String(value ?? '[empty]')
    .replace(/@everyone/g, '@ everyone')
    .replace(/@here/g, '@ here')
    .replace(/<@&?(\d+)>/g, '[mention:$1]');
}

function splitLogMessage(content, maxLength = 1900) {
  const text = String(content);
  const chunks = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks.length ? chunks : ['[empty log]'];
}

async function sendOwnerMessage(guild, content) {
  const ownerId = getOwnerUserId(guild);
  if (!ownerId) return false;
  const owner = await client.users.fetch(ownerId).catch((error) => {
    console.error('Could not resolve the configured owner for DM logging:', error.message);
    return null;
  });
  if (!owner) return false;

  for (const chunk of splitLogMessage(content)) {
    await owner
      .send({ content: chunk, allowedMentions: { parse: [] } })
      .catch((error) => console.error('Could not DM the server owner:', error.message));
  }
  return true;
}

function isAdministrator(member) {
  return Boolean(member && member.permissions.has(PermissionFlagsBits.Administrator));
}

async function logAction(guild, title, description, color = 0x050505) {
  const logMessage =
    '[Anti-nuke security log]\n' +
    'Server: ' +
    sanitizeLogText(guild.name) +
    ' (' +
    guild.id +
    ')\n' +
    'Title: ' +
    sanitizeLogText(title) +
    '\n' +
    sanitizeLogText(description);
  await sendOwnerMessage(guild, logMessage);
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

async function isWhitelisted(guild, executorId, target, type) {
  const whitelist = getGuildSettings(guild.id).whitelist;

  if (whitelist.users.includes(executorId) || config.trustedUserIds.has(executorId)) {
    return true;
  }

  if (target && whitelist.channels.includes(target.id)) {
    return true;
  }

  if (
    target &&
    target.type === ChannelType.GuildCategory &&
    whitelist.categories.includes(target.id)
  ) {
    return true;
  }

  if (target && target.parentId && whitelist.categories.includes(target.parentId)) {
    return true;
  }

  if (target && whitelist.roles.includes(target.id)) {
    return true;
  }

  const member = await guild.members.fetch(executorId).catch(() => null);
  return Boolean(
    member && member.roles.cache.some((role) => whitelist.roles.includes(role.id)),
  );
}

const activity = new Collection();
const mitigations = new Collection();


function saveRuntimeState() {
  const now = Date.now();
  const persistedActivity = [...activity.entries()]
    .filter(([key, record]) => {
      const guildId = key.split(':')[0];
      return (
        record &&
        Number.isInteger(record.count) &&
        Number.isInteger(record.startedAt) &&
        now - record.startedAt <= getWindowMs(guildId)
      );
    })
    .map(([key, record]) => ({ key, count: record.count, startedAt: record.startedAt }));

  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ savedAt: new Date().toISOString(), activity: persistedActivity }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

function restoreRuntimeState() {
  try {
    const saved = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!saved || !Array.isArray(saved.activity)) return;
    const now = Date.now();
    for (const record of saved.activity) {
      if (!record || typeof record.key !== 'string') continue;
      const guildId = record.key.split(':')[0];
      if (
        Number.isInteger(record.count) &&
        Number.isInteger(record.startedAt) &&
        now - record.startedAt <= getWindowMs(guildId)
      ) {
        activity.set(record.key, { count: record.count, startedAt: record.startedAt });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not restore runtime state:', error.message);
  }
}

restoreRuntimeState();


function trackActivity(userId, guildId, type) {
  const now = Date.now();
  const key = guildId + ':' + userId + ':' + type;
  let record = activity.get(key);

  if (!record || now - record.startedAt > getWindowMs(guildId)) {
    record = { count: 0, startedAt: now };
    activity.set(key, record);
  }

  record.count += 1;
  return record.count;
}

function riskKey(guildId, userId, type) {
  return guildId + ':' + userId + ':' + type;
}

function resetGuildState(guildId) {
  for (const key of activity.keys()) {
    if (key.startsWith(guildId + ':')) activity.delete(key);
  }
  for (const key of mitigations.keys()) {
    if (key.startsWith(guildId + ':')) mitigations.delete(key);
  }
}

async function handleSuspiciousUser(guild, userId, reason) {
  if (userId === guild.ownerId || userId === client.user.id) return;

  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    if (!member.manageable) {
      await logAction(
        guild,
        'Suspicious user',
        '<@' +
          userId +
          '> - ' +
          reason +
          '\nThe member is above the bot in the role hierarchy, so no roles were removed.',
        0xff9900,
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
        'Suspicious user',
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
      'Suspicious user',
      '<@' +
        userId +
        '> - ' +
        reason +
        ' - removed ' +
        dangerousRoles.size +
        ' dangerous role(s).',
      0xff0000,
    );
  } catch (error) {
    console.error('Could not handle suspicious user:', error.message);
  }
}

function serializePermissionOverwrites(channel) {
  return channel.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
}

function serializeRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    managed: role.managed,
    mentionable: role.mentionable,
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
  };
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    position: channel.rawPosition || 0,
    topic: channel.topic || null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser || 0,
    bitrate: channel.bitrate || null,
    userLimit: channel.userLimit || null,
    permissionOverwrites: channel.permissionOverwrites
      ? serializePermissionOverwrites(channel)
      : [],
  };
}

function backupFileName(guildId) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  return guildId + '-' + timestamp + '.json';
}

async function createServerBackup(guild, reason) {
  const backup = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    reason,
    guild: {
      id: guild.id,
      name: guild.name,
      description: guild.description || null,
      verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter,
      systemChannelId: guild.systemChannelId,
      rulesChannelId: guild.rulesChannelId,
      publicUpdatesChannelId: guild.publicUpdatesChannelId,
    },
    roles: [...guild.roles.cache.values()]
      .sort((first, second) => first.position - second.position)
      .map(serializeRole),
    channels: [...guild.channels.cache.values()]
      .sort((first, second) => first.rawPosition - second.rawPosition)
      .map(serializeChannel),
  };

  fs.mkdirSync(backupDirectory, { recursive: true });
  const fileName = backupFileName(guild.id);
  fs.writeFileSync(path.join(backupDirectory, fileName), JSON.stringify(backup, null, 2) + '\n', {
    mode: 0o600,
  });

  const backups = fs
    .readdirSync(backupDirectory)
    .filter((file) => file.startsWith(guild.id + '-') && file.endsWith('.json'))
    .sort()
    .reverse();

  for (const oldBackup of backups.slice(maxBackupsPerGuild)) {
    fs.unlinkSync(path.join(backupDirectory, oldBackup));
  }

  return { fileName, roles: backup.roles.length, channels: backup.channels.length };
}

function listServerBackups(guildId) {
  if (!fs.existsSync(backupDirectory)) return [];
  return fs
    .readdirSync(backupDirectory)
    .filter((file) => file.startsWith(guildId + '-') && file.endsWith('.json'))
    .sort()
    .reverse();
}

function getBackupPath(guildId, fileName) {
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(fileName)) return null;
  const expectedPrefix = guildId + '-';
  if (!fileName.startsWith(expectedPrefix)) return null;
  const candidate = path.join(backupDirectory, fileName);
  return fs.existsSync(candidate) ? candidate : null;
}

async function notifyAdmins(guild, reason, executorId, backupName) {
  const guildSettings = getGuildSettings(guild.id);
  const now = Date.now();
  if (guildSettings.lastRiskAlertAt && now - guildSettings.lastRiskAlertAt < 60_000) return;

  guildSettings.lastRiskAlertAt = now;
  try {
    saveSettings();
  } catch (error) {
    console.error('Could not save risk alert state:', error.message);
  }

  await sendOwnerMessage(
    guild,
    '[ANTI-NUKE ALERT]\n' +
      'Reason: ' +
      sanitizeLogText(reason) +
      '\nExecutor: ' +
      executorId +
      '\nBackup: ' +
      (backupName || 'not created') +
      '\nMode: ' +
      (getGuildSettings(guild.id).dryRun ? 'dry run' : 'active mitigation') +
      '\nReview the server audit log immediately.',
  );
}

async function sendAdminTest(guild) {
  const recipients = [...new Set(getGuildSettings(guild.id).alertAdminIds)].slice(0, 10);
  let sent = 0;

  for (const userId of recipients) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || (!isAdministrator(member) && member.id !== guild.ownerId)) continue;
    await member
      .send(
        'ANTI-NUKE TEST\n' +
          'This is a test alert from ' +
          guild.name +
          '. Administrator notifications are configured correctly.',
      )
      .then(() => {
        sent += 1;
      })
      .catch((error) => {
        console.error('Could not send test alert to ' + userId + ':', error.message);
      });
    await wait(300);
  }

  return sent;
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
  ignoreUnknown = false,
}) {
  if (!getGuildSettings(guild.id).enabled) return;

  const executor = await findExecutor(guild, auditAction, target.id);
  if (!executor) {
    if (ignoreUnknown) return;
    await logAction(
      guild,
      title,
      details + '\nBy: Unknown (the audit log entry was not available yet).',
      color,
    );
    return;
  }

  if (executor.bot) return;
  if (await isWhitelisted(guild, executor.id, target, type)) return;

  const count = trackActivity(executor.id, guild.id, type);
  const threshold = getThreshold(guild.id, type);
  await logAction(
    guild,
    title,
    details + '\nBy: <@' + executor.id + '>\nCount: ' + count + '/' + threshold,
    color,
  );

  if (count < threshold) return;

  const key = riskKey(guild.id, executor.id, type);
  if (mitigations.has(key)) return;
  mitigations.set(key, true);
  setTimeout(() => mitigations.delete(key), getWindowMs(guild.id));

  let backup = null;
  if (getGuildSettings(guild.id).autoBackupOnRisk) {
    backup = await createServerBackup(guild, 'Risk detected: ' + reason).catch((error) => {
      console.error('Could not create risk backup:', error.message);
      return null;
    });
  }

  if (getGuildSettings(guild.id).dryRun) {
    await logAction(
      guild,
      'Dry run risk threshold reached',
      'No roles were changed because dry run mode is enabled.\nExecutor: <@' +
        executor.id +
        '>\nReason: ' +
        reason,
      0xff9900,
    );
  } else {
    await handleSuspiciousUser(guild, executor.id, reason);
  }
  await notifyAdmins(guild, reason, executor.id, backup && backup.fileName);
}

function helpEmbed(command, page = 1) {
  const commandText = (value) => String.fromCharCode(96) + value + String.fromCharCode(96);
  const embed = new EmbedBuilder()
    .setTitle('Anti-Nuke Command Center')
    .setColor(EMBED_BLACK);

  if (command === 'whitelist' || command === 'wl') {
    return embed.addFields({
      name: 'Whitelist Commands',
      value:
        commandText('>whitelist add @user') + ' - Owner-only shorthand\n' +
        commandText('>whitelist user add <id>') + '\n' +
        commandText('>whitelist user remove <id>') + '\n' +
        commandText('>whitelist channel add <id>') + '\n' +
        commandText('>whitelist category add <id>') + '\n' +
        commandText('>whitelist role add <id>') + '\n' +
        commandText('>whitelist list'),
    });
  }

  if (command === 'backup') {
    return embed.addFields({
      name: 'Backup Commands',
      value:
        commandText('>backup create') + ' - Save server structure\n' +
        commandText('>backup list') + ' - List this server backups\n' +
        commandText('>backup inspect <file>') + ' - Inspect one backup',
    });
  }

  if (command === 'admin') {
    return embed.addFields({
      name: 'Administrator Alerts',
      value:
        commandText('>admin add <id>') + ' - Add an administrator alert recipient\n' +
        commandText('>admin remove <id>') + ' - Remove a recipient\n' +
        commandText('>admin list') + ' - List configured recipients\n' +
        commandText('>admin test') + ' - Send a test alert',
    });
  }

  if (command === 'audit' || command === 'logs') {
    return embed.addFields({
      name: 'Audit Commands',
      value:
        commandText('>audit recent') + ' - Show recent server audit entries\n' +
        commandText('>audit recent 15') + ' - Show up to 15 entries',
    });
  }

  if (command === 'utility' || command === 'tools') {
    return embed.addFields({
      name: 'Utility and Moderation Commands',
      value:
        commandText('>ping') + ' - Check bot latency\n' +
        commandText('>serverinfo') + ' - Show server details\n' +
        commandText('>userinfo [@user]') + ' - Show user details\n' +
        commandText('>channelinfo [#channel]') + ' - Show channel details\n' +
        commandText('>roleinfo <@role>') + ' - Show role details\n' +
        commandText('>purge <1-100>') + ' - Delete recent messages\n' +
        commandText('>slowmode <0-21600>') + ' - Set channel slowmode\n' +
        commandText('>lockdown on|off|status') + ' - Lock or unlock text channels',
    });
  }

  if (command === 'config') {
    return embed.addFields({
      name: 'Configuration Commands',
      value:
        commandText('>config show') + ' - Show server overrides\n' +
        commandText('>config threshold <type> <number>') + '\n' +
        commandText('>config window <seconds>') + '\n' +
        commandText('>config backup on|off') + '\n' +
        commandText('>config dry-run on|off'),
    });
  }

  const pageNumber = page === 2 ? 2 : 1;
  embed.setFooter({ text: 'Page ' + pageNumber + ' of 2 - Use the buttons to navigate' });

  if (pageNumber === 1) {
    return embed.addFields(
      {
        name: 'Protection',
        value:
          commandText('>antinuke status') + ' - Show protection status\n' +
          commandText('>antinuke enable') + ' - Enable automatic mitigation\n' +
          commandText('>antinuke disable') + ' - Disable automatic mitigation\n' +
          commandText('>antinuke dry-run on|off') + ' - Preview mitigation\n' +
          commandText('>antinuke reset') + ' - Clear activity counters\n' +
          commandText('>setup') + ' - Save this channel for security logs',
      },
      {
        name: 'Dashboard',
        value:
          commandText('>dashboard') + ' - Open the interactive control panel\n' +
          commandText('>status') + ' - Alias for ' + commandText('>antinuke status'),
      },
      {
        name: 'Access Control',
        value:
          commandText('>whitelist ...') + ' - Manage trusted users, roles, channels, and categories\n' +
          commandText('>admin ...') + ' - Manage risk alert recipients',
      },
    );
  }

  return embed.addFields(
    {
      name: 'Backups',
      value:
        commandText('>backup create') + ' - Snapshot roles, channels, categories, and overwrites\n' +
        commandText('>backup list') + ' - List saved snapshots\n' +
        commandText('>backup inspect <file>') + ' - Inspect a snapshot',
    },
    {
      name: 'Utilities',
      value:
        commandText('>ping') + '  ' + commandText('>serverinfo') + '  ' + commandText('>userinfo') + '  ' + commandText('>channelinfo') + '\n' +
        commandText('>roleinfo') + '  ' + commandText('>purge') + '  ' + commandText('>slowmode') + '  ' + commandText('>lockdown'),
    },
    {
      name: 'Configuration',
      value:
        commandText('>config show') + ' - Show server overrides\n' +
        commandText('>config threshold <type> <number>') + '\n' +
        commandText('>config window <seconds>') + '\n' +
        commandText('>config backup on|off') + '\n' +
        commandText('>config dry-run on|off'),
    },
    {
      name: 'Detailed Help',
      value:
        commandText('>help whitelist') + '  ' + commandText('>help backup') + '  ' + commandText('>help admin') + '\n' +
        commandText('>help audit') + '  ' + commandText('>help config') + '  ' + commandText('>help utility'),
    },
  );
}

function statusEmbed(guild) {
  const guildSettings = getGuildSettings(guild.id);
  const whitelist = guildSettings.whitelist;
  return new EmbedBuilder()
    .setTitle('Anti-Nuke Status')
    .setColor(EMBED_BLACK)
    .addFields(
      { name: 'Automatic mitigation', value: guildSettings.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Log channel', value: getLogChannelId(guild.id) ? '<#' + getLogChannelId(guild.id) + '>' : 'Not configured', inline: true },
      { name: 'Risk backup', value: guildSettings.autoBackupOnRisk ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Dry run', value: guildSettings.dryRun ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Lockdown', value: guildSettings.lockdown ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Window', value: Math.round(guildSettings.windowMs / 1000) + ' seconds', inline: true },
      { name: 'Channel delete limit', value: String(getThreshold(guild.id, 'channel_delete')), inline: true },
      { name: 'Channel create limit', value: String(getThreshold(guild.id, 'channel_create')), inline: true },
      { name: 'Role delete limit', value: String(getThreshold(guild.id, 'role_delete')), inline: true },
      { name: 'Role create limit', value: String(getThreshold(guild.id, 'role_create')), inline: true },
      { name: 'Kick limit', value: String(getThreshold(guild.id, 'kick')), inline: true },
      { name: 'Ban limit', value: String(getThreshold(guild.id, 'ban')), inline: true },
      { name: 'Whitelisted users', value: String(whitelist.users.length), inline: true },
      { name: 'Whitelisted roles', value: String(whitelist.roles.length), inline: true },
      { name: 'Whitelisted channels', value: String(whitelist.channels.length), inline: true },
      { name: 'Whitelisted categories', value: String(whitelist.categories.length), inline: true },
      { name: 'Alert recipients', value: String(guildSettings.alertAdminIds.length), inline: true },
    );
}

async function handleUtilityCommand(message, command, args) {
  if (command === 'ping') {
    await message.reply('Pong! WebSocket latency: ' + message.client.ws.ping() + 'ms.');
    return;
  }

  if (command === 'serverinfo') {
    const guild = message.guild;
    const owner = await guild.fetchOwner().catch(() => null);
    const channels = guild.channels.cache;
    const roles = guild.roles.cache.filter((role) => role.id !== guild.id);
    const embed = new EmbedBuilder()
      .setTitle(guild.name)
      .setColor(EMBED_BLACK)
      .addFields(
        { name: 'Owner', value: owner ? owner.user.tag : guild.ownerId, inline: true },
        { name: 'Members', value: String(guild.memberCount), inline: true },
        { name: 'Roles', value: String(roles.size), inline: true },
        { name: 'Channels', value: String(channels.size), inline: true },
        { name: 'Created', value: '<t:' + Math.floor(guild.createdTimestamp / 1000) + ':F>', inline: true },
        { name: 'Server ID', value: guild.id, inline: true },
      )
      .setFooter({ text: 'Requested by ' + message.author.tag });
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === 'userinfo') {
    const requestedId = normalizeId(args[0]);
    const requestedUser = message.mentions.users.first() ||
      (requestedId ? await client.users.fetch(requestedId).catch(() => null) : null) ||
      message.author;
    const member = await message.guild.members.fetch(requestedUser.id).catch(() => null);
    const roles = member
      ? member.roles.cache.filter((role) => role.id !== message.guild.id).map((role) => role.name).slice(0, 10)
      : [];
    const embed = new EmbedBuilder()
      .setTitle('User information')
      .setColor(EMBED_BLACK)
      .setThumbnail(requestedUser.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'User', value: requestedUser.tag, inline: true },
        { name: 'User ID', value: requestedUser.id, inline: true },
        { name: 'Account created', value: '<t:' + Math.floor(requestedUser.createdTimestamp / 1000) + ':F>', inline: true },
        { name: 'Joined server', value: member ? '<t:' + Math.floor(member.joinedTimestamp / 1000) + ':F>' : 'Not a current member', inline: true },
        { name: 'Server roles', value: roles.length ? roles.join(', ') : 'No additional roles', inline: false },
      );
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === 'channelinfo') {
    const requestedId = normalizeId(args[0]);
    const channel = message.mentions.channels.first() ||
      (requestedId ? message.guild.channels.cache.get(requestedId) : null) ||
      message.channel;
    const embed = new EmbedBuilder()
      .setTitle('Channel information')
      .setColor(EMBED_BLACK)
      .addFields(
        { name: 'Name', value: channel.name || 'Unnamed', inline: true },
        { name: 'Type', value: String(channel.type), inline: true },
        { name: 'Channel ID', value: channel.id, inline: true },
        { name: 'Category', value: channel.parent ? channel.parent.name : 'None', inline: true },
        { name: 'Position', value: String(channel.rawPosition ?? 'n/a'), inline: true },
        { name: 'Slowmode', value: channel.rateLimitPerUser !== undefined ? channel.rateLimitPerUser + ' seconds' : 'n/a', inline: true },
      );
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === 'roleinfo') {
    const requestedId = normalizeId(args[0]);
    const role = message.mentions.roles.first() ||
      (requestedId ? message.guild.roles.cache.get(requestedId) : null);
    if (!role) {
      await message.reply('Mention a role or provide a valid role ID.');
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('Role information')
      .setColor(EMBED_BLACK)
      .addFields(
        { name: 'Name', value: role.name, inline: true },
        { name: 'Role ID', value: role.id, inline: true },
        { name: 'Position', value: String(role.position), inline: true },
        { name: 'Members', value: String(role.members.size), inline: true },
        { name: 'Managed', value: role.managed ? 'Yes' : 'No', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Permissions', value: role.permissions.toArray().join(', ').slice(0, 1000) || 'None', inline: false },
      );
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply('Manage Messages permission required.');
      return;
    }
    const amount = Number.parseInt(args.shift(), 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
      await message.reply('Use >purge <1-100>.');
      return;
    }
    if (!message.channel.bulkDelete) {
      await message.reply('This channel does not support bulk deletion.');
      return;
    }
    const deleted = await message.channel.bulkDelete(amount, true).catch((error) => {
      console.error('Could not purge messages:', error.message);
      return null;
    });
    if (!deleted) {
      await message.reply('Could not delete messages. Check Manage Messages permission.');
      return;
    }
    await message.channel.send('Deleted ' + deleted.size + ' message(s).').then((reply) => {
      setTimeout(() => reply.delete().catch(() => {}), 5000);
    });
    return;
  }

  if (command === 'slowmode') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply('Manage Channels permission required.');
      return;
    }
    const value = args.shift();
    if (value === undefined) {
      await message.reply('Current slowmode: ' + (message.channel.rateLimitPerUser || 0) + ' seconds.');
      return;
    }
    const seconds = Number.parseInt(value, 10);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
      await message.reply('Use >slowmode <0-21600>.');
      return;
    }
    if (!message.channel.setRateLimitPerUser) {
      await message.reply('This channel does not support slowmode.');
      return;
    }
    await message.channel.setRateLimitPerUser(seconds, 'Anti-nuke moderation command');
    await message.reply('Slowmode set to ' + seconds + ' second(s) in this channel.');
    return;
  }

  if (command === 'lockdown') {
    if (!isAdministrator(message.member)) {
      await message.reply('Administrator permission required.');
      return;
    }
    const action = args.shift()?.toLowerCase() || 'status';
    const guildSettings = getGuildSettings(message.guild.id);
    if (action === 'status') {
      await message.reply('Server lockdown is currently ' + (guildSettings.lockdown ? 'enabled.' : 'disabled.'));
      return;
    }
    if (!['on', 'off'].includes(action)) {
      await message.reply('Use >lockdown on, >lockdown off, or >lockdown status.');
      return;
    }
    const locked = action === 'on';
    let updated = 0;
    let failed = 0;
    const botMember = message.guild.members.me;
    for (const channel of message.guild.channels.cache.values()) {
      if (!channel.isTextBased() || !channel.permissionOverwrites?.edit) continue;
      if (!botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) continue;
      await channel.permissionOverwrites
        .edit(message.guild.roles.everyone, { SendMessages: locked ? false : null }, { reason: 'Anti-nuke lockdown ' + action })
        .then(() => { updated += 1; })
        .catch(() => { failed += 1; });
    }
    guildSettings.lockdown = locked;
    saveSettings();
    await message.reply(
      'Server lockdown ' + (locked ? 'enabled' : 'disabled') + ' across ' + updated + ' channel(s)' +
      (failed ? '; ' + failed + ' channel(s) could not be updated.' : '.')
    );
  }
}

function configEmbed(guild) {
  const guildSettings = getGuildSettings(guild.id);
  return new EmbedBuilder()
    .setTitle('Anti-Nuke Configuration')
    .setColor(EMBED_BLACK)
    .addFields(
      { name: 'Activity window', value: Math.round(guildSettings.windowMs / 1000) + ' seconds', inline: true },
      { name: 'Backup on risk', value: guildSettings.autoBackupOnRisk ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Dry run', value: guildSettings.dryRun ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Channel delete', value: String(getThreshold(guild.id, 'channel_delete')), inline: true },
      { name: 'Channel create', value: String(getThreshold(guild.id, 'channel_create')), inline: true },
      { name: 'Role delete', value: String(getThreshold(guild.id, 'role_delete')), inline: true },
      { name: 'Role create', value: String(getThreshold(guild.id, 'role_create')), inline: true },
      { name: 'Kick', value: String(getThreshold(guild.id, 'kick')), inline: true },
      { name: 'Ban', value: String(getThreshold(guild.id, 'ban')), inline: true },
    );
}

function dashboardEmbed(guild) {
  const guildSettings = getGuildSettings(guild.id);
  return new EmbedBuilder()
    .setTitle('Anti-Nuke Dashboard')
    .setColor(EMBED_BLACK)
    .addFields(
      { name: 'Protection', value: guildSettings.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Dry run', value: guildSettings.dryRun ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Activity window', value: Math.round(guildSettings.windowMs / 1000) + ' seconds', inline: true },
      { name: 'Channel create / mass create', value: String(getThreshold(guild.id, 'channel_create')), inline: true },
      { name: 'Channel delete', value: String(getThreshold(guild.id, 'channel_delete')), inline: true },
      { name: 'Role create / mass create', value: String(getThreshold(guild.id, 'role_create')), inline: true },
      { name: 'Role delete', value: String(getThreshold(guild.id, 'role_delete')), inline: true },
      { name: 'Kick', value: String(getThreshold(guild.id, 'kick')), inline: true },
      { name: 'Ban', value: String(getThreshold(guild.id, 'ban')), inline: true },
    );
}

const thresholdLabels = {
  channel_create: 'Channel create / mass create',
  channel_delete: 'Channel delete',
  role_create: 'Role create / mass create',
  role_delete: 'Role delete',
  kick: 'Member kick',
  ban: 'Member ban',
};

function dashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('dashboard:threshold:type')
        .setPlaceholder('Choose a threshold to configure')
        .addOptions(
          ...Object.entries(thresholdLabels).map(([value, label]) => ({ label, value })),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dashboard:window').setLabel('Set Time Window').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('dashboard:toggle').setLabel('Enable / Disable').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dashboard:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function helpNavigation(page) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('help:page:1').setLabel('🙏🏻🙏🏻').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
      new ButtonBuilder().setCustomId('help:page:2').setLabel('🙏🏻').setStyle(ButtonStyle.Danger).setDisabled(page === 2),
    ),
  ];
}

function textInputRow(customId, label, placeholder, value) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (value !== undefined) input.setValue(String(value));
  return new ActionRowBuilder().addComponents(input);
}

function thresholdModal(guildId, type) {
  return new ModalBuilder()
    .setCustomId('dashboard:threshold:modal:' + type)
    .setTitle('Set ' + thresholdLabels[type] + ' threshold')
    .addComponents(
      textInputRow('value', 'Actions allowed in the window', '1 to 100', getThreshold(guildId, type)),
    );
}

function windowModal() {
  return new ModalBuilder()
    .setCustomId('dashboard:window:modal')
    .setTitle('Configure activity window')
    .addComponents(textInputRow('seconds', 'Window in seconds', '5 to 3600'));
}

function auditActionLabel(action) {
  const raw = String(action);
  return auditActionLabels[raw] || raw.toLowerCase().replace(/_/g, ' ');
}

async function auditEmbed(guild, requestedLimit) {
  const limit = Math.min(Math.max(Number.parseInt(requestedLimit, 10) || 10, 1), 15);
  const auditLogs = await guild.fetchAuditLogs({ limit });
  const lines = auditLogs.entries.map((entry) => {
    const executor = entry.executor ? entry.executor.tag : 'unknown executor';
    const target = entry.target ? entry.target.name || entry.target.id : 'unknown target';
    const age = Math.max(0, Math.round((Date.now() - entry.createdTimestamp) / 1000));
    return auditActionLabel(entry.action) + ' | ' + executor + ' | ' + target + ' | ' + age + 's ago';
  });

  return new EmbedBuilder()
    .setTitle('Recent audit activity')
    .setColor(EMBED_BLACK)
    .setDescription(
      lines.length
        ? lines.join('\n').slice(0, 3900)
        : 'No recent audit entries were returned.',
    )
    .setFooter({ text: 'Audit log entries require View Audit Log permission.' });
}

async function handleWhitelistCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await message.reply('Administrator permission required.');
    return;
  }

  const guildSettings = getGuildSettings(message.guild.id);
  const first = args.shift()?.toLowerCase();

  const mutationRequested =
    first === 'clear' ||
    first === 'add' ||
    first === 'remove' ||
    ['user', 'users', 'role', 'roles', 'channel', 'channels', 'category', 'categories'].includes(first) &&
      ['add', 'remove'].includes(args[0]?.toLowerCase());
  if (mutationRequested && !isGuildOwner(message)) {
    await message.reply('Only the configured server owner can change the whitelist.');
    return;
  }

  if (first === 'add' || first === 'remove') {
    const id = normalizeId(message.mentions.users.first()?.id || args.shift());
    if (!id) {
      await message.reply('Use >whitelist add @user or >whitelist remove @user.');
      return;
    }
    const list = guildSettings.whitelist.users;
    if (first === 'add' && !list.includes(id)) list.push(id);
    if (first === 'remove') {
      const index = list.indexOf(id);
      if (index !== -1) list.splice(index, 1);
    }
    saveSettings();
    await message.reply('User whitelist ' + first + ' completed: ' + id);
    return;
  }

  if (first === 'list' || !first) {
    const lines = Object.entries(guildSettings.whitelist).map(
      ([name, values]) => name + ': ' + (values.length ? values.join(', ') : 'none'),
    );
    await message.reply({
      embeds: [helpEmbed('whitelist').addFields({ name: 'Current whitelist', value: lines.join('\n') })],
    });
    return;
  }

  if (first === 'clear') {
    const scope = args.shift()?.toLowerCase();
    if (scope === 'all') {
      for (const listName of Object.values(whitelistNames)) {
        guildSettings.whitelist[listName] = [];
      }
      saveSettings();
      await message.reply('All whitelist entries were cleared.');
      return;
    }

    const typeToClear = whitelistNames[scope];
    if (!typeToClear) {
      await message.reply('Use >whitelist clear all, or specify user, role, channel, or category.');
      return;
    }
    guildSettings.whitelist[typeToClear] = [];
    saveSettings();
    await message.reply('Whitelist entries cleared for ' + typeToClear + '.');
    return;
  }

  const type = whitelistNames[first];
  const action = args.shift()?.toLowerCase();

  if (!type || !action || action === 'list') {
    const lines = Object.entries(guildSettings.whitelist).map(
      ([name, values]) => name + ': ' + (values.length ? values.join(', ') : 'none'),
    );
    await message.reply({ embeds: [helpEmbed('whitelist').addFields({ name: 'Current whitelist', value: lines.join('\n') })] });
    return;
  }

  if (!['add', 'remove'].includes(action)) {
    await message.reply('Use add, remove, or list. Example: >whitelist user add 123456789012345678');
    return;
  }

  const id = normalizeId(args.shift());
  if (!id) {
    await message.reply('Provide a valid Discord user, role, channel, or category ID.');
    return;
  }

  const list = guildSettings.whitelist[type];
  if (action === 'add' && !list.includes(id)) list.push(id);
  if (action === 'remove') {
    const index = list.indexOf(id);
    if (index !== -1) list.splice(index, 1);
  }
  saveSettings();
  await message.reply('Whitelist ' + action + ' completed for ' + type + ': ' + id);
}

async function handleAdminCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await message.reply('Administrator permission required.');
    return;
  }

  const action = args.shift()?.toLowerCase();
  const guildSettings = getGuildSettings(message.guild.id);

  if (action === 'list') {
    await message.reply(
      guildSettings.alertAdminIds.length
        ? 'Configured alert administrator IDs:\n' + guildSettings.alertAdminIds.join('\n')
        : 'No alert administrator IDs configured.',
    );
    return;
  }

  if (action === 'test') {
    const sent = await sendAdminTest(message.guild);
    await message.reply('Test alert sent to ' + sent + ' configured administrator(s).');
    return;
  }

  if (!['add', 'remove'].includes(action)) {
    await message.reply('Use >admin add <id>, >admin remove <id>, >admin list, or >admin test.');
    return;
  }

  const id = normalizeId(args.shift());
  if (!id) {
    await message.reply('Provide a valid Discord user ID.');
    return;
  }

  if (action === 'add' && !guildSettings.alertAdminIds.includes(id)) {
    guildSettings.alertAdminIds.push(id);
  }
  if (action === 'remove') {
    const index = guildSettings.alertAdminIds.indexOf(id);
    if (index !== -1) guildSettings.alertAdminIds.splice(index, 1);
  }
  saveSettings();
  await message.reply('Administrator alert recipient ' + action + ': ' + id);
}

async function handleConfigCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await message.reply('Administrator permission required.');
    return;
  }

  const action = args.shift()?.toLowerCase();
  const guildSettings = getGuildSettings(message.guild.id);

  if (action === 'show' || !action) {
    await message.reply({ embeds: [configEmbed(message.guild)] });
    return;
  }

  if (action === 'threshold') {
    const type = thresholdNames[args.shift()?.toLowerCase()];
    const value = Number.parseInt(args.shift(), 10);
    if (!type || !Number.isInteger(value) || value < 1 || value > 100) {
      await message.reply(
        'Use >config threshold <channel-delete|channel-create|role-delete|role-create|ban> <1-100>.',
      );
      return;
    }
    guildSettings.thresholds[type] = value;
    saveSettings();
    await message.reply('Threshold updated for ' + type + ': ' + value + '.');
    return;
  }

  if (action === 'window') {
    const seconds = Number.parseInt(args.shift(), 10);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
      await message.reply('Use >config window <seconds> with a value from 5 to 3600.');
      return;
    }
    guildSettings.windowMs = seconds * 1000;
    saveSettings();
    await message.reply('Activity window updated to ' + seconds + ' seconds.');
    return;
  }

  if (action === 'backup' || action === 'dry-run') {
    const value = args.shift()?.toLowerCase();
    if (!['on', 'off'].includes(value)) {
      await message.reply('Use >config ' + action + ' on or >config ' + action + ' off.');
      return;
    }
    if (action === 'backup') guildSettings.autoBackupOnRisk = value === 'on';
    if (action === 'dry-run') guildSettings.dryRun = value === 'on';
    saveSettings();
    await message.reply(
      (action === 'backup' ? 'Risk backups' : 'Dry run mode') +
        ' ' +
        (value === 'on' ? 'enabled.' : 'disabled.'),
    );
    return;
  }

  await message.reply(
    'Use >config show, >config threshold, >config window, >config backup, or >config dry-run.',
  );
}

async function handleAuditCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await message.reply('Administrator permission required.');
    return;
  }

  try {
    await message.reply({ embeds: [await auditEmbed(message.guild, args.shift())] });
  } catch (error) {
    console.error('Could not read recent audit activity:', error.message);
    await message.reply('Could not read the audit log. Check the bot View Audit Log permission.');
  }
}

async function handleBackupCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await message.reply('Administrator permission required.');
    return;
  }

  const action = args.shift()?.toLowerCase();
  if (action === 'create') {
    const backup = await createServerBackup(message.guild, 'Manual backup');
    await message.reply(
      'Backup created: ' +
        backup.fileName +
        '\nRoles: ' +
        backup.roles +
        '\nChannels: ' +
        backup.channels,
    );
    return;
  }

  if (action === 'list') {
    const backups = listServerBackups(message.guild.id);
    await message.reply(
      backups.length ? 'Server backups:\n' + backups.slice(0, 10).join('\n') : 'No backups found.',
    );
    return;
  }

  if (action === 'inspect') {
    const fileName = args.shift();
    const backupPath = fileName && getBackupPath(message.guild.id, fileName);
    if (!backupPath) {
      await message.reply('Backup file not found. Use >backup list first.');
      return;
    }

    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    await message.reply(
      'Backup: ' +
        fileName +
        '\nCreated: ' +
        backup.createdAt +
        '\nReason: ' +
        backup.reason +
        '\nRoles: ' +
        backup.roles.length +
        '\nChannels: ' +
        backup.channels.length,
    );
    return;
  }

  await message.reply('Use >backup create, >backup list, or >backup inspect <file>.');
}

client.once('ready', async () => {
  console.log('Bot logged in as ' + client.user.tag);
  client.user.setPresence({ activities: [], status: 'online' });
  await startMediaRotation('avatar');
  await startMediaRotation('banner');
});

function formatDeletedMessage(message) {
  const attachmentLines = [...(message.attachments?.values() || [])].map((attachment) => {
    const type = attachment.contentType || 'attachment';
    const voiceLabel = type.startsWith('audio/') ? 'voice/audio' : type;
    return '- ' + (attachment.name || 'unnamed file') + ' [' + voiceLabel + '] ' + attachment.url;
  });
  const stickerLines = [...(message.stickers?.values() || [])].map(
    (sticker) => '- sticker: ' + sticker.name + ' (' + sticker.id + ')',
  );
  const media = [...attachmentLines, ...stickerLines];
  return (
    '[Deleted message]\n' +
    'Server: ' +
    sanitizeLogText(message.guild.name) + '\n' +
    'Channel: #' +
    sanitizeLogText(message.channel?.name || message.channelId || 'unknown') + '\n' +
    'Author: ' +
    sanitizeLogText(message.author?.tag || message.author?.id || 'unknown') + '\n' +
    'Message ID: ' +
    message.id + '\n' +
    'Content: ' +
    sanitizeLogText(message.content || '[no text content]') +
    (media.length ? '\nMedia:\n' + media.join('\n') : '\nMedia: none')
  );
}

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  await sendOwnerMessage(message.guild, formatDeletedMessage(message));
});

client.on('messageDeleteBulk', async (messages, channel) => {
  if (!channel.guild) return;
  const entries = [...messages.values()]
    .filter((message) => !message.author?.bot)
    .map(formatDeletedMessage);
  if (!entries.length) return;
  await sendOwnerMessage(
    channel.guild,
    '[Bulk message deletion]\nServer: ' + sanitizeLogText(channel.guild.name) + '\n\n' + entries.join('\n\n'),
  );
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  await recordActivity({
    guild: channel.guild,
    target: channel,
    auditAction: AuditLogEvent.ChannelDelete,
    type: 'channel_delete',
    title: 'Channel deleted',
    details: 'Channel: ' + channel.name,
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
    title: 'Channel created',
    details: 'Channel: <#' + channel.id + '>',
    reason: 'mass channel creation',
    color: 0x050505,
  });
});

client.on('roleDelete', async (role) => {
  await recordActivity({
    guild: role.guild,
    target: role,
    auditAction: AuditLogEvent.RoleDelete,
    type: 'role_delete',
    title: 'Role deleted',
    details: 'Role: ' + role.name,
    reason: 'mass role deletion',
  });
});

client.on('roleCreate', async (role) => {
  await recordActivity({
    guild: role.guild,
    target: role,
    auditAction: AuditLogEvent.RoleCreate,
    type: 'role_create',
    title: 'Role created',
    details: 'Role: ' + role.name,
    reason: 'mass role creation',
    color: 0x050505,
  });
});

client.on('guildBanAdd', async (ban) => {
  await recordActivity({
    guild: ban.guild,
    target: ban.user,
    auditAction: AuditLogEvent.MemberBanAdd,
    type: 'ban',
    title: 'Member banned',
    details: 'Member: <@' + ban.user.id + '>',
    reason: 'mass bans',
  });
});

client.on('guildMemberRemove', async (member) => {
  if (!member.guild || !member.user) return;
  await recordActivity({
    guild: member.guild,
    target: member.user,
    auditAction: AuditLogEvent.MemberKick,
    type: 'kick',
    title: 'Member kicked',
    details: 'Member: <@' + member.user.id + '>',
    reason: 'mass kicks',
    ignoreUnknown: true,
  });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    if (interaction.isStringSelectMenu() && interaction.customId === 'dashboard:threshold:type') {
      if (!isAdministrator(interaction.member)) {
        await interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        return;
      }
      const type = interaction.values[0];
      if (!thresholdLabels[type]) {
        await interaction.reply({ content: 'That threshold is not available.', ephemeral: true });
        return;
      }
      await interaction.showModal(thresholdModal(interaction.guild.id, type));
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('help:page:')) {
        const page = interaction.customId.endsWith(':2') ? 2 : 1;
        await interaction.update({ embeds: [helpEmbed(null, page)], components: helpNavigation(page) });
        return;
      }

      if (!interaction.customId.startsWith('dashboard:')) return;
      if (!isAdministrator(interaction.member)) {
        await interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        return;
      }

      if (interaction.customId === 'dashboard:window') {
        await interaction.showModal(windowModal());
        return;
      }
      if (interaction.customId === 'dashboard:toggle') {
        const guildSettings = getGuildSettings(interaction.guild.id);
        guildSettings.enabled = !guildSettings.enabled;
        saveSettings();
        await interaction.update({ embeds: [dashboardEmbed(interaction.guild)], components: dashboardComponents() });
        return;
      }
      if (interaction.customId === 'dashboard:refresh') {
        await interaction.update({ embeds: [dashboardEmbed(interaction.guild)], components: dashboardComponents() });
      }
      return;
    }

    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('dashboard:')) return;
    if (!isAdministrator(interaction.member)) {
      await interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
      return;
    }

    if (interaction.customId.startsWith('dashboard:threshold:modal:')) {
      const type = interaction.customId.slice('dashboard:threshold:modal:'.length);
      const value = Number.parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
      if (!thresholdLabels[type] || !Number.isInteger(value) || value < 1 || value > 100) {
        await interaction.reply({ content: 'Choose a valid threshold value from 1 to 100.', ephemeral: true });
        return;
      }
      const guildSettings = getGuildSettings(interaction.guild.id);
      guildSettings.thresholds[type] = value;
      saveSettings();
      await interaction.reply({ content: thresholdLabels[type] + ' threshold updated to ' + value + '.', ephemeral: true });
      return;
    }

    if (interaction.customId === 'dashboard:window:modal') {
      const seconds = Number.parseInt(interaction.fields.getTextInputValue('seconds').trim(), 10);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
        await interaction.reply({ content: 'The activity window must be a whole number from 5 to 3600 seconds.', ephemeral: true });
        return;
      }
      const guildSettings = getGuildSettings(interaction.guild.id);
      guildSettings.windowMs = seconds * 1000;
      saveSettings();
      await interaction.reply({ content: 'Activity window updated to ' + seconds + ' seconds.', ephemeral: true });
      return;
    }

  } catch (error) {
    console.error('Interaction handling error:', error.message);
    if (interaction.deferred || interaction.replied) return;
    await interaction.reply({ content: 'The dashboard action could not be completed.', ephemeral: true }).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;
  if (!message.guild) {
    await handleDirectMessageCommand(message);
    return;
  }

  const commandText = message.content.slice(config.prefix.length).trim();
  if (!commandText) return;
  const args = commandText.split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'help') {
    const section = args.shift()?.toLowerCase();
    await message.reply({
      embeds: [helpEmbed(section)],
      components: section ? [] : helpNavigation(1),
    });
  } else if (command === 'dashboard' || command === 'panel') {
    if (!isAdministrator(message.member)) {
      await message.reply('Administrator permission required.');
      return;
    }
    await message.reply({ embeds: [dashboardEmbed(message.guild)], components: dashboardComponents() });
  } else if (command === 'setup') {
    if (!isAdministrator(message.member)) {
      await message.reply('Administrator permission required.');
      return;
    }
    const guildSettings = getGuildSettings(message.guild.id);
    guildSettings.logChannelId = message.channel.id;
    saveSettings();
    await message.reply('Security log channel saved for this server.');
  } else if (command === 'status' || command === 'antinuke') {
    const subcommand = command === 'status' ? 'status' : args.shift()?.toLowerCase();
    const guildSettings = getGuildSettings(message.guild.id);
    if (subcommand === 'status' || !subcommand) {
      await message.reply({ embeds: [statusEmbed(message.guild)] });
    } else if (subcommand === 'enable' || subcommand === 'disable') {
      if (!isAdministrator(message.member)) {
        await message.reply('Administrator permission required.');
        return;
      }
      guildSettings.enabled = subcommand === 'enable';
      saveSettings();
      await message.reply('Automatic anti-nuke mitigation ' + (guildSettings.enabled ? 'enabled.' : 'disabled.'));
    } else if (subcommand === 'dry-run') {
      if (!isAdministrator(message.member)) {
        await message.reply('Administrator permission required.');
        return;
      }
      const value = args.shift()?.toLowerCase();
      if (!['on', 'off'].includes(value)) {
        await message.reply('Use >antinuke dry-run on or >antinuke dry-run off.');
        return;
      }
      guildSettings.dryRun = value === 'on';
      saveSettings();
      await message.reply('Dry run mode ' + (guildSettings.dryRun ? 'enabled.' : 'disabled.'));
    } else if (subcommand === 'reset') {
      if (!isAdministrator(message.member)) {
        await message.reply('Administrator permission required.');
        return;
      }
      resetGuildState(message.guild.id);
      await message.reply('Current activity counters and pending mitigations were reset.');
    } else {
      await message.reply(
        'Use >antinuke status, >antinuke enable, >antinuke disable, >antinuke dry-run, or >antinuke reset.',
      );
    }
  } else if (['ping', 'serverinfo', 'userinfo', 'channelinfo', 'roleinfo', 'purge', 'slowmode', 'lockdown'].includes(command)) {
    await handleUtilityCommand(message, command, args);
  } else if (command === 'whitelist' || command === 'wl') {
    await handleWhitelistCommand(message, args);
  } else if (command === 'admin') {
    await handleAdminCommand(message, args);
  } else if (command === 'config') {
    await handleConfigCommand(message, args);
  } else if (command === 'audit' || command === 'logs') {
    await handleAuditCommand(message, args);
  } else if (command === 'backup') {
    await handleBackupCommand(message, args);
  }
});

client.on('error', (error) => console.error('Discord client error:', error.message));
process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));

let shutdownStarted = false;
async function persistAndShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    saveSettings();
    saveRuntimeState();
  } catch (error) {
    console.error('Could not persist data during ' + signal + ':', error.message);
  }
  if (client.isReady()) client.destroy();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    persistAndShutdown(signal);
  });
}

if (!config.token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.');
  process.exitCode = 1;
} else {
  client.login(config.token).catch((error) => {
    console.error('Could not log in to Discord:', error.message);
    process.exitCode = 1;
  });
}