'use strict';

/**
 * Channel layout snapshots + automatic channel restore.
 *
 * The bot keeps a live snapshot of every guild's channel tree on disk. When a
 * nuke is detected, the snapshot is replayed: missing channels are recreated in
 * their original order and category, channels that still exist are left alone
 * (never duplicated), and the snapshot itself is rewritten afterwards so the
 * stored list always matches reality.
 */

const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const CATEGORY = ChannelType.GuildCategory;
const LAYOUT_SCHEMA_VERSION = 2;

// Discord tolerates bursts of channel creation poorly; this keeps us inside the
// bucket while still rebuilding a nuked server in seconds rather than minutes.
const CREATE_DELAY_MS = 300;
const MAX_CREATES_PER_RUN = 120;

// Channel kinds we can recreate from a snapshot.
const RESTORABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  CATEGORY,
]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function serializeOverwrites(channel) {
  if (!channel.permissionOverwrites || !channel.permissionOverwrites.cache) return [];
  return [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    position: typeof channel.rawPosition === 'number' ? channel.rawPosition : 0,
    topic: channel.topic || null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser || 0,
    bitrate: channel.bitrate || null,
    userLimit: channel.userLimit || null,
    permissionOverwrites: serializeOverwrites(channel),
  };
}

/**
 * Removes duplicate entries from a stored layout. Duplicates appear when a
 * channel is recreated with a new id while the old entry is still on file, so a
 * later entry with the same name + parent + type always wins.
 */
function dedupeLayoutChannels(channels, liveIds) {
  const seen = new Map();
  const ordered = [];

  for (const entry of channels) {
    if (!entry || !RESTORABLE_TYPES.has(entry.type)) continue;
    const key = entry.type + '|' + (entry.parentId || 'root') + '|' + normalizeName(entry.name);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entry);
      ordered.push(entry);
      continue;
    }
    // Prefer the entry whose channel still exists in the guild.
    const existingLives = liveIds ? liveIds.has(existing.id) : false;
    const candidateLives = liveIds ? liveIds.has(entry.id) : false;
    if (candidateLives && !existingLives) {
      ordered[ordered.indexOf(existing)] = entry;
      seen.set(key, entry);
    }
  }

  return ordered.sort((first, second) => (first.position || 0) - (second.position || 0));
}

function createRestoreManager({ dataDirectory, logger = console }) {
  const layoutDirectory = path.join(dataDirectory, 'layouts');
  const snapshotTimers = new Map();
  const restoring = new Set();
  const lastRestoreAt = new Map();

  function layoutPath(guildId) {
    return path.join(layoutDirectory, guildId + '.json');
  }

  function readLayout(guildId) {
    try {
      const raw = fs.readFileSync(layoutPath(guildId), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.channels)) return null;
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Could not read channel layout for ' + guildId + ':', error.message);
      }
      return null;
    }
  }

  function writeLayout(guildId, channels) {
    fs.mkdirSync(layoutDirectory, { recursive: true });
    const payload = {
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      guildId,
      updatedAt: new Date().toISOString(),
      channels,
    };
    fs.writeFileSync(layoutPath(guildId), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    return payload;
  }

  /** Captures the guild's current channel tree, deduplicated and ordered. */
  function snapshotGuild(guild) {
    if (!guild) return null;
    const channels = [...guild.channels.cache.values()]
      .filter((channel) => RESTORABLE_TYPES.has(channel.type))
      .sort((first, second) => (first.rawPosition || 0) - (second.rawPosition || 0))
      .map(serializeChannel);
    const liveIds = new Set(channels.map((entry) => entry.id));
    return writeLayout(guild.id, dedupeLayoutChannels(channels, liveIds));
  }

  /**
   * Debounced snapshot. Never snapshots while a restore is running, and never
   * right after a mass deletion, so a nuke cannot overwrite the good layout.
   */
  function scheduleSnapshot(guild, delayMs = 15_000) {
    if (!guild || restoring.has(guild.id)) return;
    const pending = snapshotTimers.get(guild.id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      snapshotTimers.delete(guild.id);
      if (restoring.has(guild.id)) return;
      try {
        snapshotGuild(guild);
      } catch (error) {
        logger.error('Could not snapshot channels for ' + guild.id + ':', error.message);
      }
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    snapshotTimers.set(guild.id, timer);
  }

  function buildOverwrites(guild, entry) {
    const overwrites = [];
    for (const overwrite of entry.permissionOverwrites || []) {
      // Drop overwrites for roles/members that no longer exist, otherwise the
      // create call fails and takes the whole channel with it.
      const isRole = guild.roles.cache.has(overwrite.id);
      const isMember = guild.members.cache.has(overwrite.id);
      if (!isRole && !isMember) continue;
      try {
        overwrites.push({
          id: overwrite.id,
          allow: BigInt(overwrite.allow || '0'),
          deny: BigInt(overwrite.deny || '0'),
        });
      } catch {
        /* malformed bitfield — skip this overwrite */
      }
    }
    return overwrites;
  }

  function findMatchingChannel(guild, entry, parentId) {
    const wantedName = normalizeName(entry.name);
    return guild.channels.cache.find((channel) => {
      if (channel.type !== entry.type) return false;
      if (normalizeName(channel.name) !== wantedName) return false;
      if (entry.type === CATEGORY) return true;
      return (channel.parentId || null) === (parentId || null);
    });
  }

  async function createFromEntry(guild, entry, parentId, reason) {
    const payload = {
      name: entry.name,
      type: entry.type,
      reason,
      permissionOverwrites: buildOverwrites(guild, entry),
    };
    if (entry.type !== CATEGORY && parentId) payload.parent = parentId;
    if (entry.topic) payload.topic = entry.topic;
    if (entry.nsfw) payload.nsfw = true;
    if (entry.rateLimitPerUser) payload.rateLimitPerUser = entry.rateLimitPerUser;
    if (entry.bitrate && (entry.type === ChannelType.GuildVoice || entry.type === ChannelType.GuildStageVoice)) {
      payload.bitrate = entry.bitrate;
    }
    if (entry.userLimit && entry.type === ChannelType.GuildVoice) payload.userLimit = entry.userLimit;
    return guild.channels.create(payload);
  }

  /**
   * Rebuilds every channel in the layout that is missing from the guild.
   *
   * - A channel that still exists (same id, or same name in the same category)
   *   is left completely untouched.
   * - Categories are rebuilt first so channels land in the right place.
   * - Afterwards the whole tree is reordered to match the snapshot and the
   *   snapshot is rewritten with the new ids, so nothing is ever duplicated on
   *   a second run.
   */
  async function restoreGuild(guild, { reason = 'Automatic channel restore', layout = null } = {}) {
    if (!guild) return { skipped: 'no guild' };
    if (restoring.has(guild.id)) return { skipped: 'already running' };

    const source = layout || readLayout(guild.id);
    if (!source || !source.channels || !source.channels.length) {
      return { skipped: 'no layout snapshot available' };
    }

    restoring.add(guild.id);
    lastRestoreAt.set(guild.id, Date.now());

    const result = { created: 0, kept: 0, failed: 0, reordered: false, errors: [] };

    try {
      try {
        await guild.channels.fetch();
      } catch (error) {
        logger.error('Could not refresh channel cache before restore:', error.message);
      }

      const liveIds = new Set(guild.channels.cache.keys());
      const entries = dedupeLayoutChannels(source.channels, liveIds);
      const idMap = new Map();
      const finalOrder = [];

      const categories = entries.filter((entry) => entry.type === CATEGORY);
      const others = entries.filter((entry) => entry.type !== CATEGORY);

      for (const group of [categories, others]) {
        for (const entry of group) {
          const parentId = entry.parentId ? idMap.get(entry.parentId) || null : null;

          const byId = guild.channels.cache.get(entry.id);
          if (byId && byId.type === entry.type) {
            idMap.set(entry.id, byId.id);
            finalOrder.push(byId.id);
            result.kept += 1;
            continue;
          }

          const byName = findMatchingChannel(guild, entry, parentId);
          if (byName) {
            // Channel is still there under a new id — adopt it instead of
            // creating a duplicate.
            idMap.set(entry.id, byName.id);
            finalOrder.push(byName.id);
            result.kept += 1;
            continue;
          }

          if (result.created >= MAX_CREATES_PER_RUN) {
            result.errors.push('Stopped after ' + MAX_CREATES_PER_RUN + ' channels to stay inside Discord rate limits.');
            break;
          }

          try {
            const created = await createFromEntry(guild, entry, parentId, reason);
            idMap.set(entry.id, created.id);
            finalOrder.push(created.id);
            result.created += 1;
          } catch (error) {
            result.failed += 1;
            if (result.errors.length < 5) {
              result.errors.push('#' + entry.name + ': ' + error.message);
            }
          }
          await wait(CREATE_DELAY_MS);
        }
      }

      if (result.created > 0) {
        try {
          const positions = finalOrder
            .map((channelId, index) => ({ channel: channelId, position: index }))
            .filter((item) => guild.channels.cache.has(item.channel));
          if (positions.length) {
            await guild.channels.setPositions(positions);
            result.reordered = true;
          }
        } catch (error) {
          result.errors.push('Could not reorder channels: ' + error.message);
        }
      }

      // Rewrite the snapshot so stored ids match the live server. This is what
      // keeps the list free of duplicates across repeated nukes.
      try {
        snapshotGuild(guild);
      } catch (error) {
        logger.error('Could not refresh layout after restore:', error.message);
      }

      return result;
    } finally {
      restoring.delete(guild.id);
    }
  }

  function isRestoring(guildId) {
    return restoring.has(guildId);
  }

  function layoutSummary(guildId) {
    const layout = readLayout(guildId);
    if (!layout) return null;
    const categories = layout.channels.filter((entry) => entry.type === CATEGORY).length;
    return {
      updatedAt: layout.updatedAt,
      total: layout.channels.length,
      categories,
      channels: layout.channels.length - categories,
      filePath: layoutPath(guildId),
      fileName: guildId + '-layout.json',
    };
  }

  return {
    snapshotGuild,
    scheduleSnapshot,
    restoreGuild,
    readLayout,
    layoutSummary,
    layoutPath,
    isRestoring,
    lastRestoreAt,
    serializeChannel,
    dedupeLayoutChannels,
  };
}

module.exports = { createRestoreManager, RESTORABLE_TYPES, LAYOUT_SCHEMA_VERSION };
