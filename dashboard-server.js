const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const thresholdKeys = [
  'channel_create',
  'channel_delete',
  'role_create',
  'role_delete',
  'kick',
  'ban',
];

const whitelistKeys = ['users', 'roles', 'channels', 'categories'];
const punishmentKeys = ['role_remove', 'kick', 'ban', 'none'];
const snowflakePattern = /^\d{15,20}$/;

let dashboardServer = null;

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(request) {
  return String(request.headers.cookie || '')
    .split(';')
    .map((value) => value.trim().split('='))
    .filter(([name, value]) => name && value)
    .reduce((cookies, [name, ...value]) => {
      cookies[name] = value.join('=');
      return cookies;
    }, {});
}

function isAuthorized(request, dashboardToken, url) {
  const cookieToken = parseCookies(request).dashboard_access;
  const queryToken = url.searchParams.get('access');
  return cookieToken === dashboardToken || queryToken === dashboardToken;
}

function safeNumber(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function readBackup(backupPath, fileName, guildId, guildName) {
  try {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    return {
      id: guildId + ':' + fileName,
      guildId,
      guildName,
      fileName,
      createdAt: backup.createdAt || null,
      reason: backup.reason || 'Manual backup',
      roles: Array.isArray(backup.roles) ? backup.roles.length : 0,
      channels: Array.isArray(backup.channels) ? backup.channels.length : 0,
    };
  } catch {
    return null;
  }
}

function buildWhitelistOptions(guild) {
  const users = [...guild.members.cache.values()]
    .filter((member) => !member.user?.bot)
    .map((member) => ({ id: member.id, label: member.user?.tag || member.displayName || member.id }))
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 500);
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id && !role.managed)
    .map((role) => ({ id: role.id, label: '@' + role.name }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type !== 4)
    .map((channel) => ({ id: channel.id, label: '#' + channel.name }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const categories = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === 4)
    .map((channel) => ({ id: channel.id, label: channel.name }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return { users, roles, channels, categories };
}

function buildState(deps) {
  const guilds = [...deps.client.guilds.cache.values()].map((guild) => {
    const settings = deps.getGuildSettings(guild.id);
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128 }) || null,
      memberCount: guild.memberCount,
      settings: {
        enabled: settings.enabled,
        dryRun: settings.dryRun,
        lockdown: settings.lockdown,
        windowSeconds: Math.round(settings.windowMs / 1000),
        autoBackupOnRisk: settings.autoBackupOnRisk,
        thresholds: thresholdKeys.reduce((result, key) => {
          result[key] = settings.thresholds[key];
          return result;
        }, {}),
        punishments: thresholdKeys.reduce((result, key) => {
          result[key] = settings.punishments[key];
          return result;
        }, {}),
        whitelist: whitelistKeys.reduce((result, key) => {
          result[key] = [...settings.whitelist[key]];
          return result;
        }, {}),
        whitelistCounts: {
          users: settings.whitelist.users.length,
          roles: settings.whitelist.roles.length,
          channels: settings.whitelist.channels.length,
          categories: settings.whitelist.categories.length,
        },
        logChannelId: settings.logChannelId,
      },
      whitelistOptions: buildWhitelistOptions(guild),
    };
  });

  const backups = guilds.flatMap((guild) =>
    deps.listServerBackups(guild.id)
      .map((fileName) => readBackup(
        deps.getBackupPath(guild.id, fileName),
        fileName,
        guild.id,
        guild.name,
      ))
      .filter(Boolean),
  );

  return {
    owner: {
      id: deps.config.ownerUserId || null,
      tag: deps.config.ownerUserId ? 'Configured owner' : 'Server owners',
    },
    bot: {
      tag: deps.client.user ? deps.client.user.tag : null,
      online: deps.client.isReady(),
    },
    guilds,
    recentActivity: deps.dashboardActivity.slice(0, 50),
    backups: backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
  };
}

async function applyLockdown(guild, locked) {
  let updated = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites || !channel.isTextBased?.()) continue;
    await channel.permissionOverwrites
      .edit(guild.roles.everyone, { SendMessages: locked ? false : null }, {
        reason: 'Anti-nuke web dashboard lockdown ' + (locked ? 'enabled' : 'disabled'),
      })
      .then(() => { updated += 1; })
      .catch(() => {});
  }
  return updated;
}

function updateSettings(deps, guildId, input) {
  const guild = deps.client.guilds.cache.get(guildId);
  if (!guild) return { error: 'Guild not found.' };
  const settings = deps.getGuildSettings(guildId);

  if (input.enabled !== undefined) settings.enabled = Boolean(input.enabled);
  if (input.dryRun !== undefined) settings.dryRun = Boolean(input.dryRun);
  if (input.autoBackupOnRisk !== undefined) settings.autoBackupOnRisk = Boolean(input.autoBackupOnRisk);

  if (input.windowSeconds !== undefined) {
    const seconds = safeNumber(input.windowSeconds, 5, 3600);
    if (seconds === null) return { error: 'The activity window must be between 5 and 3600 seconds.' };
    settings.windowMs = seconds * 1000;
  }

  if (input.thresholds && typeof input.thresholds === 'object') {
    for (const key of thresholdKeys) {
      if (input.thresholds[key] === undefined) continue;
      const threshold = safeNumber(input.thresholds[key], 1, 100);
      if (threshold === null) return { error: 'Thresholds must be whole numbers from 1 to 100.' };
      settings.thresholds[key] = threshold;
    }
  }

  if (input.punishments && typeof input.punishments === 'object') {
    for (const key of thresholdKeys) {
      if (input.punishments[key] === undefined) continue;
      if (!punishmentKeys.includes(input.punishments[key])) {
        return { error: 'Punishments must be role removal, kick, ban, or log only.' };
      }
      settings.punishments[key] = input.punishments[key];
    }
  }

  let lockdownChanged = false;
  if (input.lockdown !== undefined && Boolean(input.lockdown) !== settings.lockdown) {
    settings.lockdown = Boolean(input.lockdown);
    lockdownChanged = true;
  }

  deps.saveSettings();
  return { guild, settings, lockdownChanged };
}

function updateWhitelist(deps, guildId, type, entryId, operation) {
  const guild = deps.client.guilds.cache.get(guildId);
  if (!guild) return { error: 'Guild not found.' };
  if (!whitelistKeys.includes(type)) return { error: 'Whitelist type must be user, role, channel, or category.' };
  if (!snowflakePattern.test(String(entryId || ''))) return { error: 'Provide a valid Discord ID.' };

  const list = deps.getGuildSettings(guildId).whitelist[type];
  if (operation === 'add') {
    if (!list.includes(entryId)) list.push(entryId);
  } else if (operation === 'remove') {
    const index = list.indexOf(entryId);
    if (index !== -1) list.splice(index, 1);
  } else {
    return { error: 'Unsupported whitelist operation.' };
  }
  deps.saveSettings();
  return { guild, values: [...list] };
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function serveDashboardFile(request, response, dashboardRoot, dashboardToken) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (!isAuthorized(request, dashboardToken, url)) {
    response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Owner access required</title><body style="font-family:system-ui;padding:40px;background:#0e0c10;color:#f5f1f3"><h1>Owner access required</h1><p>Open the private dashboard link printed by the bot when it starts.</p></body>');
    return;
  }

  const requested = url.pathname.replace(/^\/dashboard\/?/, '') || 'index.html';
  const relativePath = requested.includes('..') ? 'index.html' : requested;
  const filePath = path.resolve(dashboardRoot, relativePath);
  const rootPath = path.resolve(dashboardRoot);
  const finalPath = filePath.startsWith(rootPath + path.sep) ? filePath : path.join(rootPath, 'index.html');
  if (!fs.existsSync(finalPath)) {
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Dashboard not built</title><body style="font-family:system-ui;padding:40px"><h1>Dashboard not built</h1><p>Run <code>npm run dashboard:build</code>, then restart the bot.</p></body>');
    return;
  }

  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
  };
  const extension = path.extname(finalPath);
  response.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    ...(url.searchParams.get('access') === dashboardToken
      ? { 'Set-Cookie': 'dashboard_access=' + dashboardToken + '; HttpOnly; SameSite=Lax; Path=/dashboard' }
      : {}),
  });
  response.end(fs.readFileSync(finalPath));
}

function buildDashboardUrl(baseUrl, dashboardToken, dashboardPort) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return null;

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : 'http://' + rawValue;

  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;

    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') {
      url.pathname = '/dashboard/';
    } else if (pathname === '/dashboard') {
      url.pathname = '/dashboard/';
    }
    url.searchParams.set('access', dashboardToken);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function buildDashboardHostUrl(hostValue, dashboardToken, dashboardPort) {
  const rawValue = String(hostValue || '').trim();
  if (!rawValue) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : 'http://' + rawValue;

  try {
    const url = new URL(candidate);
    if (!url.hostname) return null;
    if (!url.port) url.port = String(dashboardPort);
    return buildDashboardUrl(url.toString(), dashboardToken, dashboardPort);
  } catch {
    return null;
  }
}

function startDashboardServer(deps) {
  if (dashboardServer) return dashboardServer;

  const dashboardToken = process.env.DASHBOARD_TOKEN || crypto.randomBytes(24).toString('hex');
  const dashboardPort = safeNumber(process.env.DASHBOARD_PORT || process.env.PORT || 3000, 1, 65535) || 3000;
  const dashboardRoot = path.join(__dirname, 'dashboard', 'dist');
  const configuredUrl = process.env.DASHBOARD_PUBLIC_URL || process.env.PUBLIC_URL || process.env.EXTERNAL_URL || process.env.BOT_HOSTING_PUBLIC_URL;
  const configuredHost = process.env.DASHBOARD_PUBLIC_HOST || process.env.PUBLIC_HOST || process.env.EXTERNAL_HOST || process.env.BOT_HOSTING_PUBLIC_HOST || process.env.BOT_HOSTING_PUBLIC_IP || process.env.BOT_HOSTING_IP || process.env.SERVER_IP;
  const publicUrl = buildDashboardUrl(configuredUrl, dashboardToken, dashboardPort)
    || buildDashboardHostUrl(configuredHost, dashboardToken, dashboardPort)
    || buildDashboardUrl('http://127.0.0.1:' + dashboardPort, dashboardToken, dashboardPort);
  const hasRemoteUrl = Boolean(buildDashboardUrl(configuredUrl, dashboardToken, dashboardPort) || buildDashboardHostUrl(configuredHost, dashboardToken, dashboardPort));

  dashboardServer = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const apiPrefix = '/dashboard/api';

    if (url.pathname.startsWith(apiPrefix)) {
      if (!isAuthorized(request, dashboardToken, url)) {
        json(response, 401, { error: 'Owner access required.' });
        return;
      }

      try {
        if (request.method === 'GET' && url.pathname === apiPrefix + '/state') {
          json(response, 200, buildState(deps));
          return;
        }

        const whitelistMatch = url.pathname.match(/^\/dashboard\/api\/guilds\/(\d+)\/whitelist(?:\/([a-z]+)\/(\d+))?$/);
        if (whitelistMatch) {
          const guildId = whitelistMatch[1];
          const guild = deps.client.guilds.cache.get(guildId);
          if (!guild) {
            json(response, 404, { error: 'Guild not found.' });
            return;
          }
          if (request.method === 'GET' && !whitelistMatch[2]) {
            const settings = deps.getGuildSettings(guildId);
            json(response, 200, {
              whitelist: whitelistKeys.reduce((result, key) => {
                result[key] = [...settings.whitelist[key]];
                return result;
              }, {}),
              options: buildWhitelistOptions(guild),
            });
            return;
          }
          if (request.method === 'POST' && !whitelistMatch[2]) {
            const input = await collectBody(request);
            const type = String(input.type || '');
            const update = updateWhitelist(deps, guildId, type, String(input.id || ''), 'add');
            if (update.error) {
              json(response, 400, { error: update.error });
              return;
            }
            json(response, 200, { whitelist: update.values });
            return;
          }
          if (request.method === 'DELETE' && whitelistMatch[2]) {
            const update = updateWhitelist(deps, guildId, whitelistMatch[2], whitelistMatch[3], 'remove');
            if (update.error) {
              json(response, 400, { error: update.error });
              return;
            }
            json(response, 200, { whitelist: update.values });
            return;
          }
          json(response, 405, { error: 'Method not allowed.' });
          return;
        }

        const guildMatch = url.pathname.match(/^\/dashboard\/api\/guilds\/(\d+)\/(settings|reset|backups)$/);
        if (!guildMatch) {
          json(response, 404, { error: 'Dashboard endpoint not found.' });
          return;
        }
        const guildId = guildMatch[1];
        const action = guildMatch[2];
        const guild = deps.client.guilds.cache.get(guildId);
        if (!guild) {
          json(response, 404, { error: 'Guild not found.' });
          return;
        }

        if (request.method === 'PATCH' && action === 'settings') {
          const update = updateSettings(deps, guildId, await collectBody(request));
          if (update.error) {
            json(response, 400, { error: update.error });
            return;
          }
          if (update.lockdownChanged) await applyLockdown(guild, update.settings.lockdown);
          json(response, 200, buildState(deps).guilds.find((item) => item.id === guildId));
          return;
        }

        if (request.method === 'POST' && action === 'reset') {
          deps.resetGuildState(guildId);
          json(response, 200, { ok: true });
          return;
        }

        if (request.method === 'POST' && action === 'backups') {
          const backup = await deps.createServerBackup(guild, 'Manual backup from the web dashboard');
          json(response, 201, {
            id: guildId + ':' + backup.fileName,
            guildId,
            guildName: guild.name,
            fileName: backup.fileName,
            createdAt: new Date().toISOString(),
            reason: 'Manual backup from the web dashboard',
            roles: backup.roles,
            channels: backup.channels,
          });
          return;
        }

        json(response, 405, { error: 'Method not allowed.' });
      } catch (error) {
        json(response, 500, { error: error.message || 'Dashboard request failed.' });
      }
      return;
    }

    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      serveDashboardFile(request, response, dashboardRoot, dashboardToken);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  dashboardServer.listen(dashboardPort, '0.0.0.0', () => {
    console.log('Owner dashboard: ' + publicUrl);
    if (!hasRemoteUrl) {
      console.warn('Dashboard is reachable only locally until DASHBOARD_PUBLIC_URL or DASHBOARD_PUBLIC_HOST is configured and port ' + dashboardPort + ' is exposed by the host.');
    }
  });
  return dashboardServer;
}

module.exports = { startDashboardServer };