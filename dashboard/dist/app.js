(function () {
  'use strict';
  var root = document.getElementById('root');
  var state = { data: null, guildId: null, whitelist: null, options: null, tab: 'users', query: '', notice: '' };
  var labels = { users: 'Users', roles: 'Roles', channels: 'Channels', categories: 'Categories' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function guild() { return state.data && state.data.guilds.find(function (item) { return item.id === state.guildId; }); }
  function api(path, options) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || 'Request failed.');
        return body;
      });
    });
  }
  function show(message) {
    state.notice = message;
    var node = document.getElementById('notice');
    if (node) { node.textContent = message || ''; node.classList.toggle('visible', Boolean(message)); }
    clearTimeout(show.timer);
    if (message) show.timer = setTimeout(function () { show(''); }, 3000);
  }
  function loadWhitelist() {
    return api('/dashboard/api/guilds/' + state.guildId + '/whitelist').then(function (payload) {
      state.whitelist = payload.whitelist || {};
      state.options = payload.options || {};
      render();
    });
  }
  function loadState() {
    return api('/dashboard/api/state').then(function (payload) {
      state.data = payload;
      if (!state.guildId || !payload.guilds.some(function (item) { return item.id === state.guildId; })) state.guildId = payload.guilds[0] && payload.guilds[0].id;
      return state.guildId ? loadWhitelist() : render();
    });
  }
  function optionsHtml() {
    var type = state.tab, all = (state.options && state.options[type]) || [], chosen = (state.whitelist && state.whitelist[type]) || [], query = state.query.trim().toLowerCase();
    var matches = all.filter(function (item) { return !query || item.label.toLowerCase().indexOf(query) !== -1 || item.id.indexOf(query) !== -1; });
    var html = '<div class="result-meta">' + matches.length + ' ' + labels[type].toLowerCase() + (matches.length > 50 ? ' · showing 50' : '') + '</div>';
    if (!matches.length) return html + '<p class="muted">No matches.</p>';
    return html + '<div class="option-list">' + matches.slice(0, 50).map(function (item) {
      var added = chosen.indexOf(item.id) !== -1;
      return '<div class="option-row"><div><strong>' + esc(item.label) + '</strong><small>' + esc(item.id) + '</small></div>' + (added ? '<span class="added">Added</span>' : '<button class="button small" data-add-type="' + type + '" data-add-id="' + item.id + '">Add</button>') + '</div>';
    }).join('') + '</div>';
  }
  function entriesHtml() {
    var type = state.tab, chosen = (state.whitelist && state.whitelist[type]) || [], all = (state.options && state.options[type]) || [], names = {};
    all.forEach(function (item) { names[item.id] = item.label; });
    if (!chosen.length) return '<p class="muted">Nothing whitelisted.</p>';
    return '<div class="entry-list">' + chosen.map(function (id) { return '<div class="entry-row"><span>' + esc(names[id] || id) + '</span><button class="remove" data-remove-type="' + type + '" data-remove-id="' + id + '" title="Remove">×</button></div>'; }).join('') + '</div>';
  }
  function whitelistHtml() {
    if (!state.options) return '<section class="card"><p class="muted">Loading server options…</p></section>';
    return '<section class="card"><div class="section-title"><div><span class="eyebrow">Access control</span><h2>Whitelist</h2></div><span class="muted">Click to add</span></div>' +
      '<div class="tabs">' + Object.keys(labels).map(function (key) { return '<button class="tab ' + (state.tab === key ? 'active' : '') + '" data-tab="' + key + '">' + labels[key] + '</button>'; }).join('') + '</div>' +
      '<input class="search" data-search placeholder="Search ' + labels[state.tab].toLowerCase() + ' by name or ID" value="' + esc(state.query) + '">' +
      '<div id="results">' + optionsHtml() + '</div><div class="selected"><div class="eyebrow">Current ' + labels[state.tab].toLowerCase() + '</div>' + entriesHtml() + '</div></section>';
  }
  function settingsHtml(g) {
    var s = g.settings;
    var thresholds = Object.keys(s.thresholds || {}).map(function (key) { return '<label class="number"><span>' + key.replace(/_/g, ' ') + '</span><input type="number" min="1" max="100" data-threshold="' + key + '" value="' + s.thresholds[key] + '"></label>'; }).join('');
    function toggle(key, text) { return '<label class="toggle"><input type="checkbox" data-setting="' + key + '" ' + (s[key] ? 'checked' : '') + '><span>' + text + '</span></label>'; }
    return '<section class="card"><div class="section-title"><div><span class="eyebrow">Protection</span><h2>Server settings</h2></div></div><div class="toggle-grid">' + toggle('enabled', 'Automatic mitigation') + toggle('dryRun', 'Dry run mode') + toggle('autoBackupOnRisk', 'Backup on risk') + toggle('lockdown', 'Lockdown') + '</div><div class="settings-grid"><label class="number"><span>Activity window (seconds)</span><input type="number" min="5" max="3600" data-setting="windowSeconds" value="' + s.windowSeconds + '"></label>' + thresholds + '</div></section>';
  }
  function render() {
    var g = guild();
    if (!state.data) { root.innerHTML = '<main class="loading">Loading JIN…</main>'; return; }
    if (!g) { root.innerHTML = '<main class="loading">No Discord servers are available.</main>'; return; }
    var choices = state.data.guilds.map(function (item) { return '<option value="' + item.id + '" ' + (item.id === g.id ? 'selected' : '') + '>' + esc(item.name) + '</option>'; }).join('');
    var activity = (state.data.recentActivity || []).filter(function (item) { return item.guildId === g.id; }).slice(0, 8);
    var backups = (state.data.backups || []).filter(function (item) { return item.guildId === g.id; }).slice(0, 5);
    root.innerHTML = '<div class="shell"><aside class="side"><div class="brand">JIN</div><span class="eyebrow">Server</span><select class="guild" data-guild>' + choices + '</select><div class="rule"></div><p class="side-note">Anti-nuke control<br>Owner access only</p></aside><main class="content"><div class="topline"><div><span class="eyebrow">Control panel</span><h1>' + esc(g.name) + '</h1><p class="muted">' + g.memberCount + ' members · ' + (g.settings.enabled ? 'protection active' : 'protection paused') + '</p></div><button class="button" data-refresh>Refresh</button></div><div id="notice" class="notice"></div>' + settingsHtml(g) + whitelistHtml() + '<div class="two-col"><section class="card"><div class="section-title"><div><span class="eyebrow">Recovery</span><h2>Backups</h2></div><button class="button small" data-backup>Create backup</button></div>' + (backups.length ? '<div class="compact-list">' + backups.map(function (item) { return '<div><strong>' + esc(item.fileName) + '</strong><span>' + item.roles + ' roles · ' + item.channels + ' channels</span></div>'; }).join('') + '</div>' : '<p class="muted">No backups yet.</p>') + '</section><section class="card"><div class="section-title"><div><span class="eyebrow">Maintenance</span><h2>Activity</h2></div><button class="button small" data-reset>Reset counters</button></div>' + (activity.length ? '<div class="compact-list">' + activity.map(function (item) { return '<div><strong>' + esc(item.action) + '</strong><span>' + esc(item.createdAt ? new Date(item.createdAt).toLocaleString() : '') + '</span></div>'; }).join('') + '</div>' : '<p class="muted">No recent activity.</p>') + '</section></div><p class="footer-note">JIN · simple controls for a safer server</p></main></div>';
    show(state.notice);
  }
  function replaceGuild(updated) { var i = state.data.guilds.findIndex(function (item) { return item.id === updated.id; }); if (i !== -1) state.data.guilds[i] = updated; }
  root.addEventListener('change', function (event) {
    var target = event.target;
    if (target.matches('[data-guild]')) { state.guildId = target.value; state.query = ''; state.options = null; state.whitelist = null; render(); loadWhitelist().catch(function (error) { show(error.message); }); return; }
    if (!target.matches('[data-setting], [data-threshold]')) return;
    var patch = {};
    if (target.dataset.threshold) { patch.thresholds = {}; patch.thresholds[target.dataset.threshold] = Number(target.value); }
    else patch[target.dataset.setting] = target.type === 'checkbox' ? target.checked : Number(target.value);
    api('/dashboard/api/guilds/' + state.guildId + '/settings', { method: 'PATCH', body: JSON.stringify(patch) }).then(function (updated) { replaceGuild(updated); show('Saved.'); render(); }).catch(function (error) { show(error.message); });
  });
  root.addEventListener('input', function (event) { if (event.target.matches('[data-search]')) { state.query = event.target.value; var result = document.getElementById('results'); if (result) result.innerHTML = optionsHtml(); } });
  root.addEventListener('click', function (event) {
    var button = event.target.closest('button'); if (!button) return;
    if (button.dataset.tab) { state.tab = button.dataset.tab; state.query = ''; render(); return; }
    if (button.dataset.addType) { button.disabled = true; api('/dashboard/api/guilds/' + state.guildId + '/whitelist', { method: 'POST', body: JSON.stringify({ type: button.dataset.addType, id: button.dataset.addId }) }).then(function (body) { state.whitelist[button.dataset.addType] = body.whitelist; show('Added to whitelist.'); render(); }).catch(function (error) { button.disabled = false; show(error.message); }); return; }
    if (button.dataset.removeType) { api('/dashboard/api/guilds/' + state.guildId + '/whitelist/' + button.dataset.removeType + '/' + button.dataset.removeId, { method: 'DELETE' }).then(function (body) { state.whitelist[button.dataset.removeType] = body.whitelist; show('Removed from whitelist.'); render(); }).catch(function (error) { show(error.message); }); return; }
    if (button.dataset.refresh) { loadState().then(function () { show('Refreshed.'); }).catch(function (error) { show(error.message); }); return; }
    if (button.dataset.backup) { button.disabled = true; api('/dashboard/api/guilds/' + state.guildId + '/backups', { method: 'POST' }).then(loadState).then(function () { show('Backup created.'); }).catch(function (error) { button.disabled = false; show(error.message); }); return; }
    if (button.dataset.reset) { api('/dashboard/api/guilds/' + state.guildId + '/reset', { method: 'POST' }).then(loadState).then(function () { show('Counters reset.'); }).catch(function (error) { show(error.message); }); }
  });
  loadState().catch(function (error) { root.innerHTML = '<main class="loading"><strong>Could not load JIN.</strong><p>' + esc(error.message) + '</p><button class="button" onclick="location.reload()">Try again</button></main>'; });
})();
