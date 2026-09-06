const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, Collection } = require('discord.js');
const dotenv = require('dotenv');

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const config = {
  token: process.env.DISCORD_TOKEN,
  prefix: '!',
  logChannelId: process.env.LOG_CHANNEL_ID,
};

const suspiciousActivity = new Collection();

function logAction(guild, title, description, color = 0xFF0000) {
  const logChannel = client.channels.cache.get(config.logChannelId);
  if (!logChannel) return;
  const embed = new EmbedBuilder()
    .setTitle(`🛡️ ${title}`)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: `Guild: ${guild.name}` });
  logChannel.send({ embeds: [embed] }).catch(console.error);
}

function trackActivity(userId, guildId, type) {
  const key = `${guildId}-${userId}`;
  if (!suspiciousActivity.has(key)) {
    suspiciousActivity.set(key, { count: 0, timestamp: Date.now() });
  }
  const activity = suspiciousActivity.get(key);
  activity.count++;
  if (Date.now() - activity.timestamp > 30000) {
    suspiciousActivity.delete(key);
  }
  return activity.count;
}

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  client.user.setActivity('for nukes 🛡️', { type: 'WATCHING' });
});

client.on('messageDeleteBulk', (messages, channel) => {
  const guild = channel.guild;
  if (messages.size > 10) {
    logAction(guild, 'Bulk Delete', `${messages.size} messages deleted in <#${channel.id}>`, 0xFFFF00);
  }
});

client.on('channelDelete', (channel) => {
  const guild = channel.guild;
  const userId = channel.deletedBy?.id;
  if (!userId) return;
  const count = trackActivity(userId, guild.id, 'channel_delete');
  logAction(guild, 'Channel Deleted', `**Channel:** ${channel.name}\n**By:** <@${userId}>\n**Count:** ${count}/5`, 0xFF6600);
  if (count >= 5) handleSuspiciousUser(guild, userId, 'mass channel deletion');
});

client.on('channelCreate', (channel) => {
  const guild = channel.guild;
  const userId = channel.createdBy?.id;
  if (!userId) return;
  const count = trackActivity(userId, guild.id, 'channel_create');
  if (count >= 5) {
    logAction(guild, 'Channel Spam', `User <@${userId}> created ${count} channels`, 0xFF0000);
    handleSuspiciousUser(guild, userId, 'mass channel creation');
  }
});

client.on('roleDelete', (role) => {
  const guild = role.guild;
  const userId = role.deletedBy?.id;
  if (!userId) return;
  const count = trackActivity(userId, guild.id, 'role_delete');
  logAction(guild, 'Role Deleted', `**Role:** ${role.name}\n**By:** <@${userId}>`, 0xFF6600);
  if (count >= 5) handleSuspiciousUser(guild, userId, 'mass role deletion');
});

client.on('roleCreate', (role) => {
  const guild = role.guild;
  const userId = role.createdBy?.id;
  if (!userId) return;
  const count = trackActivity(userId, guild.id, 'role_create');
  if (count >= 5) {
    logAction(guild, 'Role Spam', `User <@${userId}> created ${count} roles`, 0xFF0000);
    handleSuspiciousUser(guild, userId, 'mass role creation');
  }
});

client.on('guildBanAdd', (ban) => {
  const guild = ban.guild;
  guild.fetchAuditLogs({ type: 'MemberBanAdd', limit: 1 }).then((logs) => {
    const log = logs.entries.first();
    if (log) {
      const count = trackActivity(log.executor.id, guild.id, 'ban');
      if (count >= 10) handleSuspiciousUser(guild, log.executor.id, 'mass bans');
    }
  });
});

async function handleSuspiciousUser(guild, userId, reason) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const roles = member.roles.cache.filter((r) =>
      r.permissions.has([
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
      ])
    );
    for (const role of roles.values()) {
      await member.roles.remove(role).catch(console.error);
    }
    logAction(guild, '🚨 SUSPICIOUS USER', `<@${userId}> - ${reason} - Roles removed`, 0xFF0000);
  } catch (error) {
    console.error('Error:', error);
  }
}

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(config.prefix) || message.author.bot) return;
  if (!message.guild) return;
  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  if (cmd === 'status') {
    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🛡️ Bot Status')
          .setDescription('Bot is online!')
          .setColor(0x00FF00),
      ],
    });
  } else if (cmd === 'setup') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ Admin only');
    }
    config.logChannelId = message.channel.id;
    message.reply('✅ Log channel set!');
  } else if (cmd === 'help') {
    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🛡️ Commands')
          .addFields(
            { name: '!setup', value: 'Set log channel' },
            { name: '!status', value: 'Check status' },
            { name: '!help', value: 'Show this message' }
          )
          .setColor(0x0099FF),
      ],
    });
  }
});

client.login(config.token);