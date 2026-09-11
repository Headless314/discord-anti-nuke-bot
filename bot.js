const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder: DiscordEmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  Partials,
} = require('discord.js');
const dotenv = require('dotenv');
const fs = require('node:fs');
const path = require('node:path');
const { startDashboardServer } = require('./dashboard-server');

const dotenvResult = dotenv.config({ path: path.join(__dirname, '.env') });
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
  console.warn('Could not read the bot .env file: ' + dotenvResult.error.message);
}

const lowercaseEmbedText = (value) => typeof value === 'string' ? value.toLowerCase() : value;

const diffEmbedText = (value) => {
  if (typeof value !== 'string') return value;
  const tick = String.fromCharCode(96).repeat(3);
  const prefix = tick + 'diff\n';
  if (value.startsWith(prefix) && value.endsWith('\n' + tick)) return value;
  return prefix + value.split('\n').map((line) => '- ' + line).join('\n') + '\n' + tick;
};

class LowercaseEmbedBuilder extends DiscordEmbedBuilder {
  setTitle(title) {
    return super.setTitle(lowercaseEmbedText(title));
  }

  setDescription(description) {
    return super.setDescription(diffEmbedText(lowercaseEmbedText(description)));
  }

  addFields(...fields) {
    const normalizedFields = fields
      .flatMap((field) => Array.isArray(field) ? field : [field])
      .map((field) => {
        if (!field || typeof field !== 'object') return field;
        return {
          ...field,
          ...(field.name !== undefined ? { name: lowercaseEmbedText(field.name) } : {}),
          ...(field.value !== undefined ? { value: diffEmbedText(lowercaseEmbedText(field.value)) } : {}),
          inline: true,
        };
      });
    return super.addFields(...normalizedFields);
  }

  setFooter(footer) {
    if (!footer || typeof footer !== 'object') return super.setFooter(footer);
    return super.setFooter({
      ...footer,
      ...(footer.text !== undefined ? { text: lowercaseEmbedText(footer.text) } : {}),
    });
  }

  setAuthor(author) {
    if (!author || typeof author !== 'object') return super.setAuthor(author);
    return super.setAuthor({
      ...author,
      ...(author.name !== undefined ? { name: lowercaseEmbedText(author.name) } : {}),
    });
  }

  setColor() {
    return this;
  }
}

const EmbedBuilder = LowercaseEmbedBuilder;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const numberFromEnv = (name, fallback, minimum = 1) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
};

const booleanFromEnv = (name, fallback) => {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(process.env[name].toLowerCase());
};

const normalizeCommandPrefix = (value) => {
  const prefix = String(value ?? '').trim();
  return prefix && prefix.length <= 5 && !/\s/.test(prefix) ? prefix : null;
};

const config = {
  token: process.env.DISCORD_TOKEN,
  ownerUserId: process.env.OWNER_USER_ID || null,
  prefix: normalizeCommandPrefix(process.env.COMMAND_PREFIX) || '>',
  defaultLogChannelId: process.env.LOG_CHANNEL_ID || null,
  windowMs: numberFromEnv('NUKE_WINDOW_MS', 30_000, 1_000),
  autoBackupOnRisk: booleanFromEnv('AUTO_BACKUP_ON_RISK', true),
  commandAutoDeleteMs: numberFromEnv('COMMAND_AUTO_DELETE_MS', 60_000, 1_000),
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
const helpBannerFile = path.join(__dirname, process.env.HELP_BANNER_FILE || 'help-banner.txt');
const helpCommandIcon = String(process.env.HELP_COMMAND_ICON || '🙏🏻').trim();

function loadHelpBanner() {
  const configured = String(process.env.HELP_BANNER || '').replace(/\\n/g, '\n').trim();
  if (configured) return configured;
  try {
    return fs.readFileSync(helpBannerFile, 'utf8').trim();
  } catch {
    return '';
  }
}

const helpBanner = loadHelpBanner();
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

const punishmentNames = {
  role_remove: 'role_remove',
  'role-remove': 'role_remove',
  remove_roles: 'role_remove',
  remove: 'role_remove',
  kick: 'kick',
  ban: 'ban',
  none: 'none',
  log: 'none',
};

const defaultPunishments = {
  channel_delete: 'role_remove',
  channel_create: 'role_remove',
  role_delete: 'role_remove',
  role_create: 'role_remove',
  kick: 'role_remove',
  ban: 'role_remove',
};

const punishmentOptions = ['role_remove', 'kick', 'ban', 'none'];

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
const savedCommandPrefix = normalizeCommandPrefix(settings.__commandPrefix);
if (savedCommandPrefix) config.prefix = savedCommandPrefix;


const mediaRotationTimers = { avatar: null, banner: null };
const mediaRotationErrors = { avatar: null, banner: null };

function getMediaRotation(kind) {
  const saved = settings.__rotatingMedia && settings.__rotatingMedia[kind];
  if (Array.isArray(saved)) {
    return {
      items: saved
        .filter((item) => item && typeof item.path === 'string')
        .map((item) => ({ ...item, kind: item.kind || kind })),
      index: 0,
    };
  }
  if (!saved || !Array.isArray(saved.items)) return { items: [], index: 0 };
  return {
    items: saved.items
      .filter((item) => item && typeof item.path === 'string')
      .map((item) => ({ ...item, kind: item.kind || kind })),
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
  const items = rotation.items.filter((item) =>
    item.kind === kind && getMediaPath(item) && fs.existsSync(getMediaPath(item)),
  );
  if (!items.length) {
    mediaRotationErrors[kind] = 'no saved images';
    return false;
  }
  const index = rotation.index % items.length;
  const item = items[index];
  const filePath = getMediaPath(item);
  try {
    const buffer = fs.readFileSync(filePath);
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension;
    const imageData = 'data:image/' + mimeType + ';base64,' + buffer.toString('base64');
    if (kind === 'avatar') await client.user.setAvatar(imageData);
    else {
      if (typeof client.user.setBanner !== 'function') throw new Error('this discord.js version does not support bot banners');
      await client.user.setBanner(imageData);
    }
    mediaRotationErrors[kind] = null;
    settings.__rotatingMedia = settings.__rotatingMedia || {};
    settings.__rotatingMedia[kind] = { items, index: (index + 1) % items.length };
    saveSettings();
    return true;
  } catch (error) {
    mediaRotationErrors[kind] = error.message;
    console.error('Could not rotate ' + kind + ':', error.message);
    return false;
  }
}

async function startMediaRotation(kind) {
  if (mediaRotationTimers[kind]) clearInterval(mediaRotationTimers[kind]);
  if (!client.user) return;
  const applied = await applyRotatingMedia(kind);
  mediaRotationTimers[kind] = setInterval(() => {
    applyRotatingMedia(kind).catch((error) => console.error('Media rotation error:', error.message));
  }, 60 * 60 * 1000);
  return applied;
}

function lastMediaCommandTimestamp(messages, message, kind) {
  let timestamp = -1;
  const mediaCommands = [config.prefix + 'pfp', config.prefix + 'avatar', config.prefix + 'banner']
    .map((command) => command.toLowerCase());
  for (const candidate of messages) {
    if (candidate.id === message.id || candidate.author.id !== message.author.id) continue;
    const firstToken = String(candidate.content || '').trim().split(/\s+/)[0].toLowerCase();
    if (mediaCommands.includes(firstToken)) timestamp = Math.max(timestamp, candidate.createdTimestamp);
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
    await sendCommandResponse(message, 'Send one or more image attachments in this DM, then send ' + config.prefix + kind + '.');
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
      savedItems.push({
        kind,
        path: path.relative(__dirname, filePath),
        name: attachment.name || 'image',
      });
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
    const applied = await startMediaRotation(kind);
    if (!applied) {
      await sendCommandResponse(message, 'saved ' + savedItems.length + ' ' + kind + ' image(s), but discord rejected it: ' + (mediaRotationErrors[kind] || 'unknown upload error') + '.');
      return;
    }
    await sendCommandResponse(message, 'saved ' + savedItems.length + ' ' + kind + ' image(s). rotation will change every hour.');
  } catch (error) {
    for (const item of savedItems) {
      const filePath = getMediaPath(item);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await sendCommandResponse(message, 'Could not save the ' + kind + ' images: ' + error.message);
  }
}

function diffBlock(lines) {
  const tick = String.fromCharCode(96).repeat(3);
  const ansiColors = ['33']; // green, yellow, violet, red
  const withConfiguredPrefix = (line) => String(line).replace(/>(?=[a-z])/gi, config.prefix);
  return tick + 'ansi\n' + lines
    .filter(Boolean)
    .map(withConfiguredPrefix)
    .map((line) => line.startsWith('- ') ? line : '- ' + line)
    .map((line, index) => '\u001b[1;' + ansiColors[index % ansiColors.length] + 'm' + line + '\u001b[0m')
    .join('\n') + '\n' + tick;
}

function plainDiffBlock(lines, rawLineCount = 0) {
  const tick = String.fromCharCode(96).repeat(3);
  const withConfiguredPrefix = (line) => String(line).replace(/>(?=[a-z])/gi, config.prefix);
  return tick + 'diff\n' + lines
    .filter((line) => line !== undefined && line !== null)
    .map((line, index) => index < rawLineCount ? String(line) : '- ' + withConfiguredPrefix(line))
    .join('\n') + '\n' + tick;
}

function plainCommandPayload(payload) {
  if (payload && payload.__raw) {
    const { __raw, ...rawPayload } = payload;
    return rawPayload;
  }
  if (typeof payload === 'string') return { content: diffBlock([payload]) };
  if (!payload || !Array.isArray(payload.embeds) || !payload.embeds.length) return payload;
  const tick = String.fromCharCode(96).repeat(3);
  const diffPrefix = tick + 'diff\n';
  const diffSuffix = '\n' + tick;
  const lines = [];
  const addValue = (value, label) => {
    if (value === undefined || value === null || value === '') return;
    const text = String(value);
    const trimmed = text.trim();
    if (trimmed.startsWith(diffPrefix) && trimmed.endsWith(diffSuffix)) {
      const inner = trimmed.slice(diffPrefix.length, -diffSuffix.length);
      lines.push(...inner.split('\n').filter(Boolean).map((line) => line.startsWith('- ') ? line : '- ' + line));
      return;
    }
    text.split('\n').filter(Boolean).forEach((line, index) => lines.push('- ' + (index === 0 && label ? label + ': ' : '') + line));
  };
  for (const embed of payload.embeds) {
    const data = embed.data || embed;
    addValue(data.title);
    addValue(data.description);
    for (const field of data.fields || []) {
      addValue(field.value, field.name);
    }
    addValue(data.footer?.text);
  }
  const responsePayload = { content: diffBlock(lines) };
  if (payload.components) responsePayload.components = payload.components;
  return responsePayload;
}

function scheduleMessageDeletion(message) {
  if (!message || typeof message.delete !== 'function') return;
  const timer = setTimeout(() => {
    message.delete().catch(() => {});
  }, config.commandAutoDeleteMs);
  timer.unref?.();
}

async function sendCommandResponse(message, payload) {
  const response = await message.channel.send(plainCommandPayload(payload));
  scheduleMessageDeletion(message);
  scheduleMessageDeletion(response);
  return response;
}

async function sendDashboardLink(message) {
  const allowed = message.guild
    ? isGuildOwner(message)
    : Boolean(config.ownerUserId && message.author.id === config.ownerUserId);
  if (!allowed) {
    await sendCommandResponse(message, 'this command is owner-only.');
    return;
  }
  if (!dashboardPublicUrl) {
    await sendCommandResponse(message, 'the dashboard link is not available yet. Check the bot logs for the dashboard URL.');
    return;
  }
  await sendCommandResponse(message, dashboardPublicUrl);
}

async function advanceRotatingMedia(message, kind) {
  const allowed = message.guild
    ? isGuildOwner(message)
    : Boolean(config.ownerUserId && message.author.id === config.ownerUserId);
  if (!allowed) {
    await sendCommandResponse(message, 'this command is owner-only.');
    return;
  }
  const applied = await applyRotatingMedia(kind);
  if (!applied) {
    await sendCommandResponse(message, 'could not change ' + kind + ': ' + (mediaRotationErrors[kind] || 'no saved images') + '.');
    return;
  }
  await sendCommandResponse(message, kind + ' changed to the next image.');
}

async function clearRotatingMedia(kind) {
  const rotation = getMediaRotation(kind);
  for (const item of rotation.items) {
    const filePath = getMediaPath(item);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  if (mediaRotationTimers[kind]) clearInterval(mediaRotationTimers[kind]);
  mediaRotationTimers[kind] = null;
  mediaRotationErrors[kind] = null;
  settings.__rotatingMedia = settings.__rotatingMedia || {};
  settings.__rotatingMedia[kind] = { items: [], index: 0 };
  saveSettings();
}

async function handleGuildAutoDeleteCommand(message, args) {
  if (!isGuildOwner(message)) {
    await sendCommandResponse(message, 'this command is server-owner only.');
    return;
  }
  const guildSettings = getGuildSettings(message.guild.id);
  const action = args.shift()?.toLowerCase();
  if (action === 'user') {
    const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(normalizeId(args[0])).catch(() => null) : null);
    if (!target || target.bot) {
      await sendCommandResponse(message, 'use >autodelete user @target or >autodelete user <id>.');
      return;
    }
    if (target.id === message.author.id) {
      await sendCommandResponse(message, 'you cannot auto-delete yourself.');
      return;
    }
    if (!guildSettings.autoDeleteUserIds.includes(target.id)) guildSettings.autoDeleteUserIds.push(target.id);
    saveSettings();
    await sendCommandResponse(message, 'auto-delete enabled for <@' + target.id + '>.');
    return;
  }
  if (action === 'remove' || action === 'off') {
    const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(normalizeId(args[0])).catch(() => null) : null);
    if (!target) {
      await sendCommandResponse(message, 'use >autodelete remove @target or >autodelete off @target.');
      return;
    }
    guildSettings.autoDeleteUserIds = guildSettings.autoDeleteUserIds.filter((id) => id !== target.id);
    saveSettings();
    await sendCommandResponse(message, 'auto-delete removed for <@' + target.id + '>.');
    return;
  }
  if (action === 'clear') {
    guildSettings.autoDeleteUserIds = [];
    saveSettings();
    await sendCommandResponse(message, 'all server auto-delete targets cleared.');
    return;
  }
  if (action === 'list') {
    const targets = guildSettings.autoDeleteUserIds.length ? guildSettings.autoDeleteUserIds.map((id) => '<@' + id + '>').join('\n') : 'none';
    await sendCommandResponse(message, 'auto-delete targets:\n' + targets);
    return;
  }
  await sendCommandResponse(message, 'use >autodelete user @target, >autodelete remove @target, >autodelete list, or >autodelete clear.');
}
async function handleDirectMessageCommand(message) {
  if (!config.ownerUserId || message.author.id !== config.ownerUserId) return;
  const hasPrefix = message.content.startsWith(config.prefix);
  const commandText = hasPrefix ? message.content.slice(config.prefix.length).trim() : '';
  if (!commandText) {
    if (settings.__dmAutoDelete === true) void message.delete().catch(() => {});
    return;
  }
  const args = commandText.split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'autodelete' || command === 'dmdelete' || command === 'cleanup') {
    const action = args.shift()?.toLowerCase();
    if (['on', 'enable', 'enabled'].includes(action)) {
      settings.__dmAutoDelete = true;
      saveSettings();
      await sendCommandResponse(message, 'dm auto-delete enabled.');
    } else if (['off', 'disable', 'disabled'].includes(action)) {
      settings.__dmAutoDelete = false;
      saveSettings();
      await sendCommandResponse(message, 'dm auto-delete disabled.');
    } else if (action === 'status' || !action) {
      await sendCommandResponse(message, 'dm auto-delete is ' + (settings.__dmAutoDelete === true ? 'on' : 'off') + '.');
    } else {
      await sendCommandResponse(message, 'use >autodelete on, >autodelete off, or >autodelete status.');
    }
    return;
  }

  if (command === 'help' || command === 'dmhelp') {
    await sendCommandResponse(message, { embeds: [dmHelpEmbed()] });
    return;
  }

  if (command === 'status' || command === 'botstatus' || command === 'presence') {
    const status = args.shift()?.toLowerCase();
    if (!presenceStatuses.includes(status)) {
      await sendCommandResponse(message, 'use >status online, >status idle, >status dnd, or >status invisible.');
      return;
    }
    botPresenceStatus = status;
    client.user.setPresence({ activities: [], status: botPresenceStatus });
    settings.__botPresenceStatus = botPresenceStatus;
    saveSettings();
    saveRuntimeState();
    await sendCommandResponse(message, 'bot status changed to ' + botPresenceStatus + '.');
    return;
  }

  if (command === 'pfp' || command === 'avatar') {
    await saveRotatingMediaFromDm(message, 'avatar');
  } else if (command === 'banner') {
    await saveRotatingMediaFromDm(message, 'banner');
  } else if (command === 'clear') {
    const kind = args.shift()?.toLowerCase();
    if (kind === 'pfp' || kind === 'avatar' || kind === 'banner') {
      const mediaKind = kind === 'avatar' ? 'avatar' : kind;
      await clearRotatingMedia(mediaKind);
      await sendCommandResponse(message, 'deleted all saved ' + (mediaKind === 'avatar' ? 'pfp' : 'banner') + ' images. The current Discord image was not changed.');
    } else {
      await sendCommandResponse(message, 'use >clear pfp or >clear banner.');
    }
  } else {
    await sendCommandResponse(message, 'dm commands: >help, >pfp, >banner, >clear pfp, >clear banner, >status, or >autodelete.');
  }
}
function dmHelpEmbed() {
  const tick = String.fromCharCode(96).repeat(3);
  return new EmbedBuilder().setDescription(tick + 'diff\n- >pfp\n- >banner\n- >clear pfp\n- >clear banner\n- >status <online|idle|dnd|invisible>\n- >autodelete on|off|status\n' + tick);
}
function getGuildSettings(guildId) {
  const guildSettings = settings[guildId] || {};
  guildSettings.enabled = guildSettings.enabled !== false;
  guildSettings.dryRun = guildSettings.dryRun === true;
  guildSettings.lockdown = guildSettings.lockdown === true;
  guildSettings.autoDeleteUserIds = Array.isArray(guildSettings.autoDeleteUserIds) ? guildSettings.autoDeleteUserIds.filter((id) => typeof id === 'string') : [];
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
  guildSettings.punishments = guildSettings.punishments || {};
  for (const type of Object.keys(config.thresholds)) {
    const normalizedPunishment = punishmentNames[guildSettings.punishments[type]];
    guildSettings.punishments[type] = punishmentOptions.includes(normalizedPunishment)
      ? normalizedPunishment
      : defaultPunishments[type];
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
  const temporaryFile = settingsFile + '.tmp-' + process.pid;
  const serialized = JSON.stringify(settings, null, 2) + '\n';
  try {
    fs.writeFileSync(temporaryFile, serialized, { mode: 0o600 });
    fs.renameSync(temporaryFile, settingsFile);
  } catch (error) {
    try { fs.unlinkSync(temporaryFile); } catch {}
    throw error;
  }
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

function truncateLogField(value, maxLength = 1024) {
  const text = String(value ?? '[empty]');
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

async function sendOwnerMessage(guild, content) {
  const ownerId = getOwnerUserId(guild);
  if (!ownerId) return false;
  const owner = await client.users.fetch(ownerId).catch((error) => {
    console.error('Could not resolve the configured owner for DM logging:', error.message);
    return null;
  });
  if (!owner) return false;

  const payloads = typeof content === 'string'
    ? splitLogMessage(content).map((chunk) => ({ content: chunk }))
    : [content];
  for (const payload of payloads) {
    await owner
      .send({ ...payload, allowedMentions: { parse: [] } })
      .catch((error) => console.error('Could not DM the server owner:', error.message));
  }
  return true;
}

async function sendAdministratorMessage(guild, content) {
  const guildSettings = getGuildSettings(guild.id);
  const recipientIds = [...new Set([
    getOwnerUserId(guild),
    ...guildSettings.alertAdminIds,
  ].filter(Boolean))].slice(0, 11);
  let sent = 0;

  for (const userId of recipientIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || (member.id !== guild.ownerId && !isAdministrator(member))) continue;
    for (const chunk of splitLogMessage(content)) {
      await member
        .send({ content: chunk, allowedMentions: { parse: [] } })
        .then(() => { sent += 1; })
        .catch((error) => console.error('Could not DM administrator ' + userId + ':', error.message));
    }
  }
  return sent;
}

function isAdministrator(member) {
  return Boolean(member && member.permissions.has(PermissionFlagsBits.Administrator));
}

async function logAction(guild, title, description, color = 0x050505) {
  const embed = new DiscordEmbedBuilder()
    .setColor(color)
    .setTitle(sanitizeLogText(title))
    .setDescription(truncateLogField(sanitizeLogText(description), 4096))
    .addFields(
      { name: 'server', value: truncateLogField(sanitizeLogText(guild.name), 1024), inline: true },
      { name: 'server id', value: guild.id, inline: true },
    )
    .setTimestamp();
  await sendOwnerMessage(guild, { embeds: [embed] });
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
const dashboardActivity = [];
const presenceStatuses = ['online', 'idle', 'dnd', 'invisible'];
let botPresenceStatus = presenceStatuses.includes(settings.__botPresenceStatus) ? settings.__botPresenceStatus : 'online';

function addDashboardActivity(guild, action, details, severity = 'notice') {
  dashboardActivity.unshift({
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    guildId: guild.id,
    guildName: guild.name,
    action,
    details,
    severity,
    createdAt: new Date().toISOString(),
  });
  if (dashboardActivity.length > 100) dashboardActivity.length = 100;
}


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
    JSON.stringify({ savedAt: new Date().toISOString(), activity: persistedActivity, presenceStatus: botPresenceStatus }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

function restoreRuntimeState() {
  try {
    const saved = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!saved) return;
    if (!settings.__botPresenceStatus && presenceStatuses.includes(saved.presenceStatus)) botPresenceStatus = saved.presenceStatus;
    if (!Array.isArray(saved.activity)) return;
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

function dangerousRolePermissions(role) {
  const permissions = [
    [PermissionFlagsBits.Administrator, 'administrator'],
    [PermissionFlagsBits.ManageGuild, 'manage server'],
    [PermissionFlagsBits.ManageChannels, 'manage channels'],
    [PermissionFlagsBits.ManageRoles, 'manage roles'],
    [PermissionFlagsBits.BanMembers, 'ban members'],
    [PermissionFlagsBits.KickMembers, 'kick members'],
  ];
  return permissions
    .filter(([permission]) => role.permissions.has(permission))
    .map(([, label]) => label);
}

function isDangerousRole(role, guild) {
  return Boolean(
    role &&
    role.id !== guild.id &&
    !role.managed &&
    dangerousRolePermissions(role).length,
  );
}

async function handleSuspiciousUser(guild, userId, reason, punishment = 'role_remove') {
  if (userId === guild.ownerId || userId === client.user.id) return;

  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    if (punishment === 'none') {
      await logAction(
        guild,
        'Suspicious user',
        '<@' + userId + '> - ' + reason + '\nNo punishment was configured for this action.',
        0xff9900,
      );
      return;
    }

    if (punishment === 'kick') {
      if (!member.kickable) {
        await logAction(guild, 'Suspicious user', '<@' + userId + '> - ' + reason + '\nThe member is not kickable by the bot.', 0xff9900);
        return;
      }
      await member.kick('Anti-nuke: ' + reason);
      await logAction(guild, 'Suspicious user', '<@' + userId + '> - ' + reason + '\nPunishment: kicked.', 0xff0000);
      return;
    }

    if (punishment === 'ban') {
      if (!member.bannable) {
        await logAction(guild, 'Suspicious user', '<@' + userId + '> - ' + reason + '\nThe member is not bannable by the bot.', 0xff9900);
        return;
      }
      await member.ban({ deleteMessageSeconds: 0, reason: 'Anti-nuke: ' + reason });
      await logAction(guild, 'Suspicious user', '<@' + userId + '> - ' + reason + '\nPunishment: banned.', 0xff0000);
      return;
    }

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

    const dangerousRoles = member.roles.cache.filter((role) => isDangerousRole(role, guild) && role.editable);

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

  await sendAdministratorMessage(
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
  addDashboardActivity(guild, title, details, color === 0xff6600 ? 'warning' : 'notice');
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
    await handleSuspiciousUser(
      guild,
      executor.id,
      reason,
      getGuildSettings(guild.id).punishments[type],
    );
  }
  await notifyAdmins(guild, reason, executor.id, backup && backup.fileName);
}

function helpCommand(command) {
  return helpCommandIcon + config.prefix + command;
}

function helpGrid(commands) {
  const values = commands.map(helpCommand);
  const rows = [];
  const midpoint = Math.ceil(values.length / 2);
  const columnWidth = 22;

  for (let index = 0; index < midpoint; index += 1) {
    const left = values[index];
    const right = values[index + midpoint];
    rows.push(right ? left.padEnd(columnWidth, ' ') + right : left);
  }
  return rows;
}

function helpCommandPayload(command, page = 1) {
  const helpCommands = [];
  const section = (_title, commands) => {
    helpCommands.push(...commands);
  };

  if (command === 'whitelist' || command === 'wl') {
    section('whitelist commands', ['whitelist add @user', 'whitelist user add <id>', 'whitelist user remove <id>', 'whitelist channel add <id>', 'whitelist category add <id>', 'whitelist role add <id>', 'whitelist list']);
  } else if (command === 'backup') {
    section('backup commands', ['backup create', 'backup list', 'backup latest', 'backup inspect', 'backup diff', 'backup verify', 'backup stats', 'backup export', 'backup delete']);
  } else if (command === 'admin') {
    section('admin commands', ['admin add <id>', 'admin remove <id>', 'admin list', 'admin test']);
  } else if (command === 'audit' || command === 'logs') {
    section('audit commands', ['audit recent', 'audit recent 15']);
  } else if (command === 'utility' || command === 'tools') {
    section('utility commands', ['ping', 'serverinfo', 'userinfo [@user]', 'channelinfo [#channel]', 'roleinfo <@role>', 'purge <1-100>', 'slowmode <0-21600>', 'lockdown on|off|status']);
  } else if (command === 'config') {
    section('config commands', ['config show', 'config threshold <type> <number>', 'config window <seconds>', 'config backup on|off', 'config dry-run on|off']);
  } else if (page === 1) {
    section('commands', ['anti status', 'anti enable', 'anti disable', 'anti dry-run', 'anti reset', 'setup', 'status', 'anti status', 'next pfp', 'next banner', 'whitelist', 'admin', 'prefix x', 'prefix reset']);
  } else {
    section('commands', ['backup create', 'backup list', 'backup latest', 'backup inspect', 'backup diff', 'backup verify', 'backup stats', 'backup export', 'backup delete', 'ping', 'serverinfo', 'userinfo', 'channelinfo', 'roleinfo', 'purge', 'slowmode', 'lockdown', 'config show', 'config thres', 'config window', 'config backup', 'config dry-run', 'prefix x', 'prefix reset', 'help whitelist', 'help backup', 'help admin', 'help audit', 'help config', 'help utility']);
  }

  const bannerLines = helpBanner ? helpBanner.split(/\r?\n/).filter((line) => line.length > 0) : [];
  const contentLines = bannerLines.concat(helpGrid(helpCommands));
  return {
    __raw: true,
    content: plainDiffBlock(contentLines, bannerLines.length),
    components: command ? [] : helpNavigation(page),
  };
}

function helpEmbed(command, page = 1) {
  const commandList = (...commands) => {
    const tick = String.fromCharCode(96).repeat(3);
    return tick + 'diff\n' + commands.map((value) => '- ' + value.replace(/^>/, config.prefix)).join('\n') + '\n' + tick;
  };
  const embed = new EmbedBuilder();

  if (command === 'whitelist' || command === 'wl') {
    return embed.addFields({
      name: 'whitelist commands',
      value: commandList(
        '>whitelist add @user',
        '>whitelist user add <id>',
        '>whitelist user remove <id>',
        '>whitelist channel add <id>',
        '>whitelist category add <id>',
        '>whitelist role add <id>',
        '>whitelist list',
      ),
    });
  }

  if (command === 'backup') {
    return embed.addFields({
      name: 'backup commands',
      value: commandList('>backup create', '>backup list', '>backup inspect <file>'),
    });
  }

  if (command === 'admin') {
    return embed.addFields({
      name: 'admin commands',
      value: commandList('>admin add <id>', '>admin remove <id>', '>admin list', '>admin test'),
    });
  }

  if (command === 'audit' || command === 'logs') {
    return embed.addFields({
      name: 'audit commands',
      value: commandList('>audit recent', '>audit recent 15'),
    });
  }

  if (command === 'utility' || command === 'tools') {
    return embed.addFields({
      name: 'utility commands',
      value: commandList(
        '>ping',
        '>serverinfo',
        '>userinfo [@user]',
        '>channelinfo [#channel]',
        '>roleinfo <@role>',
        '>purge <1-100>',
        '>slowmode <0-21600>',
        '>lockdown on|off|status',
      ),
    });
  }

  if (command === 'config') {
    return embed.addFields({
      name: 'config commands',
      value: commandList(
        '>config show',
        '>config threshold <type> <number>',
        '>config window <seconds>',
        '>config backup on|off',
        '>config dry-run on|off',
      ),
    });
  }

  const pageNumber = page === 2 ? 2 : 1;
  if (pageNumber === 1) {
    return embed.addFields(
      { name: 'protection', value: commandList('>antinuke status', '>antinuke enable', '>antinuke disable', '>antinuke dry-run on|off', '>antinuke reset', '>setup') },
      { name: 'status', value: commandList('>status', '>antinuke status') },
      { name: 'media', value: commandList('>next pfp', '>next banner') },
      { name: 'access control', value: commandList('>whitelist ...', '>admin ...') },
      { name: 'command prefix', value: commandList('>prefix x', '>prefix reset') },
    );
  }

  return embed.addFields(
    { name: 'backups', value: commandList('>backup create', '>backup list', '>backup inspect <file>') },
    { name: 'utilities', value: commandList('>ping', '>serverinfo', '>userinfo', '>channelinfo', '>roleinfo', '>purge', '>slowmode', '>lockdown') },
    { name: 'configuration', value: commandList('>config show', '>config threshold <type> <number>', '>config window <seconds>', '>config backup on|off', '>config dry-run on|off', '>prefix x', '>prefix reset') },
    { name: 'detailed help', value: commandList('>help whitelist', '>help backup', '>help admin', '>help audit', '>help config', '>help utility') },
  );
}function statusEmbed(guild) {
  const guildSettings = getGuildSettings(guild.id);
  const whitelist = guildSettings.whitelist;
  return new EmbedBuilder()
    .setTitle('Anti-Nuke Status')
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
    await sendCommandResponse(message, 'Pong! WebSocket latency: ' + message.client.ws.ping() + 'ms.');
    return;
  }

  if (command === 'serverinfo') {
    const guild = message.guild;
    const owner = await guild.fetchOwner().catch(() => null);
    const channels = guild.channels.cache;
    const roles = guild.roles.cache.filter((role) => role.id !== guild.id);
    const embed = new EmbedBuilder()
      .setTitle(guild.name)
      .addFields(
        { name: 'Owner', value: owner ? owner.user.tag : guild.ownerId, inline: true },
        { name: 'Members', value: String(guild.memberCount), inline: true },
        { name: 'Roles', value: String(roles.size), inline: true },
        { name: 'Channels', value: String(channels.size), inline: true },
        { name: 'Created', value: '<t:' + Math.floor(guild.createdTimestamp / 1000) + ':F>', inline: true },
        { name: 'Server ID', value: guild.id, inline: true },
      )
      .setFooter({ text: 'Requested by ' + message.author.tag });
    await sendCommandResponse(message, { embeds: [embed] });
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
      .setThumbnail(requestedUser.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'User', value: requestedUser.tag, inline: true },
        { name: 'User ID', value: requestedUser.id, inline: true },
        { name: 'Account created', value: '<t:' + Math.floor(requestedUser.createdTimestamp / 1000) + ':F>', inline: true },
        { name: 'Joined server', value: member ? '<t:' + Math.floor(member.joinedTimestamp / 1000) + ':F>' : 'Not a current member', inline: true },
        { name: 'Server roles', value: roles.length ? roles.join(', ') : 'No additional roles', inline: false },
      );
    await sendCommandResponse(message, { embeds: [embed] });
    return;
  }

  if (command === 'channelinfo') {
    const requestedId = normalizeId(args[0]);
    const channel = message.mentions.channels.first() ||
      (requestedId ? message.guild.channels.cache.get(requestedId) : null) ||
      message.channel;
    const embed = new EmbedBuilder()
      .setTitle('Channel information')
      .addFields(
        { name: 'Name', value: channel.name || 'Unnamed', inline: true },
        { name: 'Type', value: String(channel.type), inline: true },
        { name: 'Channel ID', value: channel.id, inline: true },
        { name: 'Category', value: channel.parent ? channel.parent.name : 'None', inline: true },
        { name: 'Position', value: String(channel.rawPosition ?? 'n/a'), inline: true },
        { name: 'Slowmode', value: channel.rateLimitPerUser !== undefined ? channel.rateLimitPerUser + ' seconds' : 'n/a', inline: true },
      );
    await sendCommandResponse(message, { embeds: [embed] });
    return;
  }

  if (command === 'roleinfo') {
    const requestedId = normalizeId(args[0]);
    const role = message.mentions.roles.first() ||
      (requestedId ? message.guild.roles.cache.get(requestedId) : null);
    if (!role) {
      await sendCommandResponse(message, 'Mention a role or provide a valid role ID.');
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('Role information')
      .addFields(
        { name: 'Name', value: role.name, inline: true },
        { name: 'Role ID', value: role.id, inline: true },
        { name: 'Position', value: String(role.position), inline: true },
        { name: 'Members', value: String(role.members.size), inline: true },
        { name: 'Managed', value: role.managed ? 'Yes' : 'No', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Permissions', value: role.permissions.toArray().join(', ').slice(0, 1000) || 'None', inline: false },
      );
    await sendCommandResponse(message, { embeds: [embed] });
    return;
  }

  if (command === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await sendCommandResponse(message, 'Manage Messages permission required.');
      return;
    }
    const amount = Number.parseInt(args.shift(), 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
      await sendCommandResponse(message, 'Use >purge <1-100>.');
      return;
    }
    if (!message.channel.bulkDelete) {
      await sendCommandResponse(message, 'This channel does not support bulk deletion.');
      return;
    }
    const deleted = await message.channel.bulkDelete(amount, true).catch((error) => {
      console.error('Could not purge messages:', error.message);
      return null;
    });
    if (!deleted) {
      await sendCommandResponse(message, 'Could not delete messages. Check Manage Messages permission.');
      return;
    }
    await message.channel.send('Deleted ' + deleted.size + ' message(s).').then((reply) => {
      setTimeout(() => reply.delete().catch(() => {}), 5000);
    });
    return;
  }

  if (command === 'slowmode') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await sendCommandResponse(message, 'Manage Channels permission required.');
      return;
    }
    const value = args.shift();
    if (value === undefined) {
      await sendCommandResponse(message, 'Current slowmode: ' + (message.channel.rateLimitPerUser || 0) + ' seconds.');
      return;
    }
    const seconds = Number.parseInt(value, 10);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
      await sendCommandResponse(message, 'Use >slowmode <0-21600>.');
      return;
    }
    if (!message.channel.setRateLimitPerUser) {
      await sendCommandResponse(message, 'This channel does not support slowmode.');
      return;
    }
    await message.channel.setRateLimitPerUser(seconds, 'Anti-nuke moderation command');
    await sendCommandResponse(message, 'Slowmode set to ' + seconds + ' second(s) in this channel.');
    return;
  }

  if (command === 'lockdown') {
    if (!isAdministrator(message.member)) {
      await sendCommandResponse(message, 'Administrator permission required.');
      return;
    }
    const action = args.shift()?.toLowerCase() || 'status';
    const guildSettings = getGuildSettings(message.guild.id);
    if (action === 'status') {
      await sendCommandResponse(message, 'Server lockdown is currently ' + (guildSettings.lockdown ? 'enabled.' : 'disabled.'));
      return;
    }
    if (!['on', 'off'].includes(action)) {
      await sendCommandResponse(message, 'Use >lockdown on, >lockdown off, or >lockdown status.');
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
    await sendCommandResponse(message, 
      'Server lockdown ' + (locked ? 'enabled' : 'disabled') + ' across ' + updated + ' channel(s)' +
      (failed ? '; ' + failed + ' channel(s) could not be updated.' : '.')
    );
  }
}

function configEmbed(guild) {
  const guildSettings = getGuildSettings(guild.id);
  return new EmbedBuilder()
    .setTitle('Anti-Nuke Configuration')
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

function helpNavigation(page) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('help:page:1').setLabel('🙏🏻').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
      new ButtonBuilder().setCustomId('help:page:2').setLabel('🙏🏻🙏🏻').setStyle(ButtonStyle.Danger).setDisabled(page === 2),
    ),
  ];
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
    .setDescription(
      lines.length
        ? lines.join('\n').slice(0, 3900)
        : 'No recent audit entries were returned.',
    )
    .setFooter({ text: 'Audit log entries require View Audit Log permission.' });
}

async function handleWhitelistCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await sendCommandResponse(message, 'Administrator permission required.');
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
    await sendCommandResponse(message, 'Only the configured server owner can change the whitelist.');
    return;
  }

  if (first === 'add' || first === 'remove') {
    const id = normalizeId(message.mentions.users.first()?.id || args.shift());
    if (!id) {
      await sendCommandResponse(message, 'Use >whitelist add @user or >whitelist remove @user.');
      return;
    }
    const list = guildSettings.whitelist.users;
    if (first === 'add' && !list.includes(id)) list.push(id);
    if (first === 'remove') {
      const index = list.indexOf(id);
      if (index !== -1) list.splice(index, 1);
    }
    saveSettings();
    await sendCommandResponse(message, 'User whitelist ' + first + ' completed: ' + id);
    return;
  }

  if (first === 'list' || !first) {
    const lines = Object.entries(guildSettings.whitelist).map(
      ([name, values]) => name + ': ' + (values.length ? values.join(', ') : 'none'),
    );
    await sendCommandResponse(message, {
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
      await sendCommandResponse(message, 'All whitelist entries were cleared.');
      return;
    }

    const typeToClear = whitelistNames[scope];
    if (!typeToClear) {
      await sendCommandResponse(message, 'Use >whitelist clear all, or specify user, role, channel, or category.');
      return;
    }
    guildSettings.whitelist[typeToClear] = [];
    saveSettings();
    await sendCommandResponse(message, 'Whitelist entries cleared for ' + typeToClear + '.');
    return;
  }

  const type = whitelistNames[first];
  const action = args.shift()?.toLowerCase();

  if (!type || !action || action === 'list') {
    const lines = Object.entries(guildSettings.whitelist).map(
      ([name, values]) => name + ': ' + (values.length ? values.join(', ') : 'none'),
    );
    await sendCommandResponse(message, { embeds: [helpEmbed('whitelist').addFields({ name: 'Current whitelist', value: lines.join('\n') })] });
    return;
  }

  if (!['add', 'remove'].includes(action)) {
    await sendCommandResponse(message, 'Use add, remove, or list. Example: >whitelist user add 123456789012345678');
    return;
  }

  const id = normalizeId(args.shift());
  if (!id) {
    await sendCommandResponse(message, 'Provide a valid Discord user, role, channel, or category ID.');
    return;
  }

  const list = guildSettings.whitelist[type];
  if (action === 'add' && !list.includes(id)) list.push(id);
  if (action === 'remove') {
    const index = list.indexOf(id);
    if (index !== -1) list.splice(index, 1);
  }
  saveSettings();
  await sendCommandResponse(message, 'Whitelist ' + action + ' completed for ' + type + ': ' + id);
}

async function handleAdminCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await sendCommandResponse(message, 'Administrator permission required.');
    return;
  }

  const action = args.shift()?.toLowerCase();
  const guildSettings = getGuildSettings(message.guild.id);

  if (action === 'list') {
    await sendCommandResponse(message, 
      guildSettings.alertAdminIds.length
        ? 'Configured alert administrator IDs:\n' + guildSettings.alertAdminIds.join('\n')
        : 'No alert administrator IDs configured.',
    );
    return;
  }

  if (action === 'test') {
    const sent = await sendAdminTest(message.guild);
    await sendCommandResponse(message, 'Test alert sent to ' + sent + ' configured administrator(s).');
    return;
  }

  if (!['add', 'remove'].includes(action)) {
    await sendCommandResponse(message, 'Use >admin add <id>, >admin remove <id>, >admin list, or >admin test.');
    return;
  }

  const id = normalizeId(args.shift());
  if (!id) {
    await sendCommandResponse(message, 'Provide a valid Discord user ID.');
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
  await sendCommandResponse(message, 'Administrator alert recipient ' + action + ': ' + id);
}

async function handleConfigCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await sendCommandResponse(message, 'Administrator permission required.');
    return;
  }

  const action = args.shift()?.toLowerCase();
  const guildSettings = getGuildSettings(message.guild.id);

  if (action === 'show' || !action) {
    await sendCommandResponse(message, { embeds: [configEmbed(message.guild)] });
    return;
  }

  if (action === 'threshold') {
    const type = thresholdNames[args.shift()?.toLowerCase()];
    const value = Number.parseInt(args.shift(), 10);
    if (!type || !Number.isInteger(value) || value < 1 || value > 100) {
      await sendCommandResponse(message, 
        'Use >config threshold <channel-delete|channel-create|role-delete|role-create|ban> <1-100>.',
      );
      return;
    }
    guildSettings.thresholds[type] = value;
    saveSettings();
    await sendCommandResponse(message, 'Threshold updated for ' + type + ': ' + value + '.');
    return;
  }

  if (action === 'window') {
    const seconds = Number.parseInt(args.shift(), 10);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
      await sendCommandResponse(message, 'Use >config window <seconds> with a value from 5 to 3600.');
      return;
    }
    guildSettings.windowMs = seconds * 1000;
    saveSettings();
    await sendCommandResponse(message, 'Activity window updated to ' + seconds + ' seconds.');
    return;
  }

  if (action === 'backup' || action === 'dry-run') {
    const value = args.shift()?.toLowerCase();
    if (!['on', 'off'].includes(value)) {
      await sendCommandResponse(message, 'Use >config ' + action + ' on or >config ' + action + ' off.');
      return;
    }
    if (action === 'backup') guildSettings.autoBackupOnRisk = value === 'on';
    if (action === 'dry-run') guildSettings.dryRun = value === 'on';
    saveSettings();
    await sendCommandResponse(message, 
      (action === 'backup' ? 'Risk backups' : 'Dry run mode') +
        ' ' +
        (value === 'on' ? 'enabled.' : 'disabled.'),
    );
    return;
  }

  await sendCommandResponse(message, 
    'Use >config show, >config threshold, >config window, >config backup, or >config dry-run.',
  );
}

async function handleAuditCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await sendCommandResponse(message, 'Administrator permission required.');
    return;
  }

  try {
    await sendCommandResponse(message, { embeds: [await auditEmbed(message.guild, args.shift())] });
  } catch (error) {
    console.error('Could not read recent audit activity:', error.message);
    await sendCommandResponse(message, 'Could not read the audit log. Check the bot View Audit Log permission.');
  }
}

function readServerBackup(guildId, fileName) {
  const backupPath = getBackupPath(guildId, fileName);
  if (!backupPath) return null;
  try {
    return { fileName, filePath: backupPath, backup: JSON.parse(fs.readFileSync(backupPath, 'utf8')) };
  } catch (error) {
    console.error('Could not read backup ' + fileName + ':', error.message);
    return null;
  }
}

function resolveBackupFileName(guildId, args) {
  const firstArg = args.shift();
  if (String(firstArg || '').toLowerCase() === 'latest') return listServerBackups(guildId)[0];
  return [firstArg, ...args].filter(Boolean).join(' ');
}

function backupDiffSummary(guild, backup) {
  const snapshotRoles = new Map((Array.isArray(backup.roles) ? backup.roles : []).filter((role) => role && role.id).map((role) => [role.id, role]));
  const liveRoles = [...guild.roles.cache.values()];
  const liveRoleIds = new Set(liveRoles.map((role) => role.id));
  const addedRoles = liveRoles.filter((role) => !snapshotRoles.has(role.id));
  const removedRoles = [...snapshotRoles.values()].filter((role) => !liveRoleIds.has(role.id));
  const changedRoles = liveRoles.filter((role) => {
    const saved = snapshotRoles.get(role.id);
    return saved && (saved.name !== role.name || String(saved.permissions) !== role.permissions.bitfield.toString() || Boolean(saved.mentionable) !== Boolean(role.mentionable));
  });

  const snapshotChannels = new Map((Array.isArray(backup.channels) ? backup.channels : []).filter((channel) => channel && channel.id).map((channel) => [channel.id, channel]));
  const liveChannels = [...guild.channels.cache.values()];
  const liveChannelIds = new Set(liveChannels.map((channel) => channel.id));
  const addedChannels = liveChannels.filter((channel) => !snapshotChannels.has(channel.id));
  const removedChannels = [...snapshotChannels.values()].filter((channel) => !liveChannelIds.has(channel.id));
  const changedChannels = liveChannels.filter((channel) => {
    const saved = snapshotChannels.get(channel.id);
    return saved && (saved.name !== channel.name || saved.type !== channel.type || saved.parentId !== channel.parentId || (saved.topic || null) !== (channel.topic || null) || Number(saved.rateLimitPerUser || 0) !== Number(channel.rateLimitPerUser || 0));
  });
  const names = (items) => items.slice(0, 5).map((item) => item.name || item.id).join(', ') || 'none';
  return [
    'Roles: +' + addedRoles.length + ' added, -' + removedRoles.length + ' removed, ' + changedRoles.length + ' changed',
    'Channels: +' + addedChannels.length + ' added, -' + removedChannels.length + ' removed, ' + changedChannels.length + ' changed',
    'Added roles: ' + names(addedRoles),
    'Removed roles: ' + names(removedRoles),
    'Added channels: ' + names(addedChannels),
    'Removed channels: ' + names(removedChannels),
  ].join('\n');
}

function backupSummary(fileName, backup, index) {
  const roles = Array.isArray(backup.roles) ? backup.roles.length : 0;
  const channels = Array.isArray(backup.channels) ? backup.channels.length : 0;
  const parsedDate = backup.createdAt ? Date.parse(backup.createdAt) : Number.NaN;
  const createdAt = Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : 'unknown date';
  return (index === undefined ? '' : (index + 1) + '. ') + fileName + '\n   ' + createdAt + ' | ' + roles + ' roles | ' + channels + ' channels';
}

function validateBackupSnapshot(backup, guildId) {
  const errors = [];
  const guild = backup && backup.guild;
  if (!backup || typeof backup !== 'object') errors.push('snapshot is not an object');
  if (!guild || guild.id !== guildId) errors.push('guild id does not match this server');
  for (const pair of [['roles', backup && backup.roles], ['channels', backup && backup.channels]]) {
    const label = pair[0];
    const items = pair[1];
    if (!Array.isArray(items)) {
      errors.push(label + ' list is missing');
      continue;
    }
    const ids = items.map((item) => item && item.id).filter(Boolean);
    if (ids.length !== items.length) errors.push(label + ' contains entries without ids');
    if (ids.length !== new Set(ids).size) errors.push(label + ' contains duplicate ids');
  }
  return errors;
}

function backupStorageStats(guildId) {
  const files = listServerBackups(guildId);
  let bytes = 0;
  for (const fileName of files) {
    const filePath = getBackupPath(guildId, fileName);
    if (filePath) bytes += fs.statSync(filePath).size;
  }
  return { count: files.length, bytes, newest: files[0] || null, oldest: files[files.length - 1] || null };
}

async function handleBackupCommand(message, args) {
  if (!isAdministrator(message.member)) {
    await sendCommandResponse(message, 'Administrator permission required.');
    return;
  }

  const action = (args.shift() || 'list').toLowerCase();
  if (action === 'create') {
    const reason = args.join(' ').trim().slice(0, 200) || 'Manual backup';
    try {
      const backup = await createServerBackup(message.guild, reason);
      await sendCommandResponse(message, 'Backup created\nFile: ' + backup.fileName + '\nReason: ' + reason + '\nRoles: ' + backup.roles + '\nChannels: ' + backup.channels + '\nUse ' + config.prefix + 'backup inspect ' + backup.fileName + ' to inspect it.');
    } catch (error) {
      console.error('Could not create manual backup:', error.message);
      await sendCommandResponse(message, 'Backup creation failed: ' + error.message);
    }
    return;
  }

  if (action === 'list') {
    const requestedLimit = Number.parseInt(args.shift() || '10', 10);
    const limit = Math.min(Math.max(Number.isInteger(requestedLimit) ? requestedLimit : 10, 1), 15);
    const allBackups = listServerBackups(message.guild.id);
    const backups = allBackups.slice(0, limit);
    const summaries = backups.map((fileName, index) => {
      const entry = readServerBackup(message.guild.id, fileName);
      return entry ? backupSummary(fileName, entry.backup, index) : (index + 1) + '. ' + fileName + '\n   unreadable backup file';
    });
    await sendCommandResponse(message, summaries.length
      ? 'Server backups (' + summaries.length + '/' + allBackups.length + ')\n' + summaries.join('\n') + '\nUse ' + config.prefix + 'backup latest or ' + config.prefix + 'backup inspect <file>.'
      : 'No backups found. Create one with ' + config.prefix + 'backup create [reason].');
    return;
  }

  if (action === 'latest') {
    const fileName = listServerBackups(message.guild.id)[0];
    const entry = fileName && readServerBackup(message.guild.id, fileName);
    await sendCommandResponse(message, entry
      ? 'Latest backup\n' + backupSummary(entry.fileName, entry.backup)
      : 'No backups found. Create one with ' + config.prefix + 'backup create [reason].');
    return;
  }

  if (action === 'verify' || action === 'validate' || action === 'check') {
    const requestedFile = resolveBackupFileName(message.guild.id, args);
    const entry = requestedFile && readServerBackup(message.guild.id, requestedFile);
    if (!entry) {
      await sendCommandResponse(message, 'Backup file not found or unreadable. Use ' + config.prefix + 'backup list first.');
      return;
    }
    const errors = validateBackupSnapshot(entry.backup, message.guild.id);
    await sendCommandResponse(message, errors.length
      ? 'Backup verification failed\nFile: ' + entry.fileName + '\n- ' + errors.join('\n- ')
      : 'Backup verified\nFile: ' + entry.fileName + '\nSnapshot structure and ids are valid.');
    return;
  }

  if (action === 'stats' || action === 'storage') {
    const stats = backupStorageStats(message.guild.id);
    await sendCommandResponse(message, stats.count
      ? 'Backup storage\nSnapshots: ' + stats.count + '\nTotal size: ' + stats.bytes.toLocaleString() + ' bytes\nNewest: ' + stats.newest + '\nOldest: ' + stats.oldest
      : 'No backups found. Create one with ' + config.prefix + 'backup create.');
    return;
  }

  if (action === 'diff' || action === 'compare') {
    const requestedFile = resolveBackupFileName(message.guild.id, args);
    const entry = requestedFile && readServerBackup(message.guild.id, requestedFile);
    if (!entry) {
      await sendCommandResponse(message, 'Backup file not found or unreadable. Use ' + config.prefix + 'backup list first.');
      return;
    }
    await sendCommandResponse(message, 'Backup comparison\n' + backupSummary(entry.fileName, entry.backup) + '\n' + backupDiffSummary(message.guild, entry.backup));
    return;
  }

  if (action === 'export' || action === 'download') {
    const requestedFile = resolveBackupFileName(message.guild.id, args);
    const entry = requestedFile && readServerBackup(message.guild.id, requestedFile);
    if (!entry) {
      await sendCommandResponse(message, 'Backup file not found or unreadable. Use ' + config.prefix + 'backup list first.');
      return;
    }
    try {
      const response = await message.channel.send({
        content: 'Backup export: ' + entry.fileName,
        files: [{ attachment: entry.filePath, name: entry.fileName }],
      });
      scheduleMessageDeletion(message);
      scheduleMessageDeletion(response);
    } catch (error) {
      await sendCommandResponse(message, 'Could not export backup: ' + error.message);
    }
    return;
  }

  if (action === 'inspect' || action === 'info') {
    const requestedFile = resolveBackupFileName(message.guild.id, args);
    const entry = requestedFile && readServerBackup(message.guild.id, requestedFile);
    if (!entry) {
      await sendCommandResponse(message, 'Backup file not found or unreadable. Use ' + config.prefix + 'backup list first.');
      return;
    }
    const backup = entry.backup;
    await sendCommandResponse(message, 'Backup details\n' + backupSummary(entry.fileName, backup) + '\nSchema: ' + (backup.schemaVersion || 'legacy') + '\nReason: ' + (backup.reason || 'not recorded') + '\nGuild: ' + (backup.guild?.name || message.guild.name) + ' (' + message.guild.id + ')');
    return;
  }

  if (action === 'delete' || action === 'remove') {
    if (!isGuildOwner(message)) {
      await sendCommandResponse(message, 'Only the server owner can delete backups.');
      return;
    }
    const fileName = args.shift();
    const backupPath = fileName && getBackupPath(message.guild.id, fileName);
    if (!backupPath) {
      await sendCommandResponse(message, 'Backup file not found. Use ' + config.prefix + 'backup list first.');
      return;
    }
    fs.unlinkSync(backupPath);
    await sendCommandResponse(message, 'Deleted backup: ' + fileName);
    return;
  }

  await sendCommandResponse(message, 'Use ' + config.prefix + 'backup create [reason], ' + config.prefix + 'backup list [count], ' + config.prefix + 'backup latest, ' + config.prefix + 'backup inspect <file>, ' + config.prefix + 'backup diff <file>, ' + config.prefix + 'backup verify <file>, ' + config.prefix + 'backup stats, ' + config.prefix + 'backup export <file>, or ' + config.prefix + 'backup delete <file>.');
}

let dashboardPublicUrl = null;

const dashboardDependencies = {
  client,
  config,
  settings,
  getGuildSettings,
  saveSettings,
  resetGuildState,
  createServerBackup,
  listServerBackups,
  getBackupPath,
  backupDirectory,
  dashboardActivity,
  setDashboardUrl: (url) => {
    dashboardPublicUrl = String(url || '').trim() || null;
  },
};

function startOwnerDashboard() {
  try {
    startDashboardServer(dashboardDependencies);
  } catch (error) {
    console.error('Could not start owner dashboard:', error.message);
  }
}

startOwnerDashboard();

client.once('ready', async () => {
  console.log('Bot logged in as ' + client.user.tag);
  client.user.setPresence({ activities: [], status: botPresenceStatus });
  await startMediaRotation('avatar');
  await startMediaRotation('banner');
});

function formatDeletedMessage(message) {
  const channelName = message.channel?.name || message.channelId || 'unknown channel';
  const authorName = message.author?.tag || message.author?.username || message.author?.id || 'unknown user';
  const content = sanitizeLogText(message.content || '[no text content]');
  const attachmentLines = [...(message.attachments?.values() || [])].map((attachment) => {
    const type = attachment.contentType || 'attachment';
    const voiceLabel = type.startsWith('audio/') ? 'voice/audio' : type;
    return (attachment.name || 'unnamed file') + ' · ' + voiceLabel + ' · ' + attachment.url;
  });
  const stickerLines = [...(message.stickers?.values() || [])].map(
    (sticker) => 'sticker: ' + sticker.name + ' (' + sticker.id + ')',
  );
  const media = [...attachmentLines, ...stickerLines];
  const embed = new DiscordEmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Message deleted')
    .setDescription('A message was deleted from **#' + truncateLogField(sanitizeLogText(channelName), 80) + '**.')
    .addFields(
      { name: 'author', value: truncateLogField(sanitizeLogText(authorName)), inline: true },
      { name: 'channel', value: truncateLogField('#' + sanitizeLogText(channelName)), inline: true },
      { name: 'message id', value: message.id, inline: true },
      { name: 'content', value: truncateLogField(content) },
    )
    .setFooter({ text: truncateLogField(sanitizeLogText(message.guild.name), 2048) })
    .setTimestamp(message.createdAt || new Date());
  if (media.length) embed.addFields({ name: 'media', value: truncateLogField(media.join('\n')) });
  return { embeds: [embed] };
}

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  await sendOwnerMessage(message.guild, formatDeletedMessage(message));
});

client.on('messageDeleteBulk', async (messages, channel) => {
  if (!channel.guild) return;
  const deleted = [...messages.values()].filter((message) => !message.author?.bot);
  if (!deleted.length) return;
  const summary = deleted.map((message, index) => {
    const author = message.author?.tag || message.author?.username || message.author?.id || 'unknown user';
    const content = sanitizeLogText(message.content || '[no text content]').replace(/\s+/g, ' ');
    return (index + 1) + '. ' + truncateLogField(sanitizeLogText(author), 80) + ' · ' + truncateLogField(content, 180);
  }).join('\n');
  const embed = new DiscordEmbedBuilder()
    .setColor(0xed4245)
    .setTitle('Messages deleted in bulk')
    .setDescription('**' + deleted.length + '** messages were removed from **#' + truncateLogField(sanitizeLogText(channel.name || channel.id), 80) + '**.')
    .addFields({ name: 'deleted messages', value: truncateLogField(summary) })
    .setFooter({ text: truncateLogField(sanitizeLogText(channel.guild.name), 2048) })
    .setTimestamp();
  await sendOwnerMessage(channel.guild, { embeds: [embed] });
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

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!newMember.guild || !oldMember.roles?.cache || !newMember.roles?.cache) return;
  const addedDangerousRoles = newMember.roles.cache.filter(
    (role) => !oldMember.roles.cache.has(role.id) && isDangerousRole(role, newMember.guild),
  );
  if (!addedDangerousRoles.size) return;

  const executor = await findExecutor(
    newMember.guild,
    AuditLogEvent.MemberRoleUpdate,
    newMember.id,
  );
  if (executor?.bot) return;
  if (executor && await isWhitelisted(newMember.guild, executor.id, null, 'role_update')) return;

  const roleDetails = [...addedDangerousRoles.values()]
    .map((role) => role.name + ' (' + dangerousRolePermissions(role).join(', ') + ')')
    .join('; ');
  const reason =
    'Risky permission role granted to <@' +
    newMember.id +
    '>: ' +
    roleDetails +
    '.';
  addDashboardActivity(newMember.guild, 'Risky permission role granted', reason, 'critical');
  await logAction(
    newMember.guild,
    'Risky permission role granted',
    reason + '\nBy: ' + (executor ? '<@' + executor.id + '>' : 'Unknown executor'),
    0xff0000,
  );
  await notifyAdmins(newMember.guild, reason, executor?.id || 'Unknown', null);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.inGuild() || !interaction.isButton()) return;
    if (!interaction.customId.startsWith('help:page:')) return;
    const page = interaction.customId.endsWith(':2') ? 2 : 1;
    const nextPagePayload = plainCommandPayload(helpCommandPayload(null, page));
    await interaction.update(nextPagePayload);
  } catch (error) {
    console.error('Interaction handling error:', error.message);
    if (interaction.deferred || interaction.replied) return;
    await interaction.reply({ content: 'The help action could not be completed.', ephemeral: true }).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) {
      await handleDirectMessageCommand(message);
    return;
  }

  const guildSettingsForMessage = getGuildSettings(message.guild.id);
  if (guildSettingsForMessage.autoDeleteUserIds.includes(message.author.id)) {
    void message.delete().catch(() => {});
    return;
  }
  if (!message.content.startsWith(config.prefix)) return;

  const commandText = message.content.slice(config.prefix.length).trim();
  if (!commandText) return;
  const args = commandText.split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'autodelete') {
    await handleGuildAutoDeleteCommand(message, args);
  } else if (command === 'prefix') {
    if (!isGuildOwner(message)) {
      await sendCommandResponse(message, 'Only the server owner can change the command prefix.');
      return;
    }
    const requestedPrefix = args.shift();
    const nextPrefix = requestedPrefix?.toLowerCase() === 'reset'
      ? '>'
      : normalizeCommandPrefix(requestedPrefix);
    if (!nextPrefix || args.length) {
      await sendCommandResponse(message, 'Use ' + config.prefix + 'prefix <new-prefix>, or ' + config.prefix + 'prefix reset.');
      return;
    }
    config.prefix = nextPrefix;
    settings.__commandPrefix = nextPrefix;
    saveSettings();
    await sendCommandResponse(message, 'Command prefix changed to ' + nextPrefix + '. Use ' + nextPrefix + 'help to see every command.');
  } else if (command === 'link') {
    await sendDashboardLink(message);
  } else if (command === 'next') {
    const mediaKind = args.shift()?.toLowerCase();
    if (mediaKind === 'pfp' || mediaKind === 'avatar') await advanceRotatingMedia(message, 'avatar');
    else if (mediaKind === 'banner') await advanceRotatingMedia(message, 'banner');
    else await sendCommandResponse(message, 'use >next pfp or >next banner.');
  } else if (command === 'help') {
    const section = args.shift()?.toLowerCase();
    await sendCommandResponse(message, helpCommandPayload(section, 1));
  } else if (command === 'setup') {
    if (!isAdministrator(message.member)) {
      await sendCommandResponse(message, 'Administrator permission required.');
      return;
    }
    const guildSettings = getGuildSettings(message.guild.id);
    guildSettings.logChannelId = message.channel.id;
    saveSettings();
    await sendCommandResponse(message, 'Security log channel saved for this server.');
  } else if (command === 'status' || command === 'antinuke') {
    const subcommand = command === 'status' ? 'status' : args.shift()?.toLowerCase();
    const guildSettings = getGuildSettings(message.guild.id);
    if (subcommand === 'status' || !subcommand) {
      await sendCommandResponse(message, { embeds: [statusEmbed(message.guild)] });
    } else if (subcommand === 'enable' || subcommand === 'disable') {
      if (!isAdministrator(message.member)) {
        await sendCommandResponse(message, 'Administrator permission required.');
        return;
      }
      guildSettings.enabled = subcommand === 'enable';
      saveSettings();
      await sendCommandResponse(message, 'Automatic anti-nuke mitigation ' + (guildSettings.enabled ? 'enabled.' : 'disabled.'));
    } else if (subcommand === 'dry-run') {
      if (!isAdministrator(message.member)) {
        await sendCommandResponse(message, 'Administrator permission required.');
        return;
      }
      const value = args.shift()?.toLowerCase();
      if (!['on', 'off'].includes(value)) {
        await sendCommandResponse(message, 'Use >antinuke dry-run on or >antinuke dry-run off.');
        return;
      }
      guildSettings.dryRun = value === 'on';
      saveSettings();
      await sendCommandResponse(message, 'Dry run mode ' + (guildSettings.dryRun ? 'enabled.' : 'disabled.'));
    } else if (subcommand === 'reset') {
      if (!isAdministrator(message.member)) {
        await sendCommandResponse(message, 'Administrator permission required.');
        return;
      }
      resetGuildState(message.guild.id);
      await sendCommandResponse(message, 'Current activity counters and pending mitigations were reset.');
    } else {
      await sendCommandResponse(message, 
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
  } else {
    await sendCommandResponse(message, 'Unknown command. Use >help.');
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
  console.error('Missing DISCORD_TOKEN. Add it to Railway Variables or to a local .env file before starting the bot.');
  process.exitCode = 1;
} else {
  client.login(config.token).catch((error) => {
    console.error('Could not log in to Discord:', error.message);
    process.exitCode = 1;
  });
}