const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const REDIRECT = 'http://localhost:8765/callback';
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = {
  groupId: '', pdfName: '', time: '23:00', geminiKey: '',
  ttClientId: '', ttClientSecret: '', ttToken: '', projectName: 'School Books',
  done: [], groqKey: '', ollamaModel: ''
};
const loadSettings = () => {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { ...defaults }; }
};
const saveSettings = (s) => fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));

let readyFired = false;
let win, tray, wa, task, quitting = false, running = false;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const log = (msg, type = 'info') => send('log', { msg, type, t: new Date().toLocaleTimeString() });

/* ---------------- WhatsApp ---------------- */
function startWA() {
  wa = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(app.getPath('userData'), 'wa') }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });
  wa.on('qr', async (qr) => { send('wa-state', { state: 'qr', qr: await QRCode.toDataURL(qr, { width: 260, margin: 1 }) }); });
  wa.on('authenticated', () => { send('wa-state', { state: 'loading' }); setTimeout(() => { if (!readyFired) loadGroups(); }, 30000); });
  wa.on('ready', async () => { readyFired = true; send('wa-state', { state: 'ready' }); log('WhatsApp connected, loading groups...', 'ok'); await new Promise((r) => setTimeout(r, 6000)); await loadGroups(); });
  wa.on('disconnected', (r) => { send('wa-state', { state: 'off' }); log('WhatsApp disconnected: ' + r, 'err'); });
  wa.initialize().catch((e) => log('WhatsApp error: ' + e.message, 'err'));
}
async function loadGroups(attempt = 1) {
  try {
    let list = [];
    try {
      list = await wa.pupPage.evaluate(() => {
        const S = window.Store;
        const chats = S.Chat.getModelsArray ? S.Chat.getModelsArray() : S.Chat.models;
        const out = new Map();
        for (const c of chats) {
          const id = c.id._serialized;
          if (!id.endsWith('@g.us')) continue;
          let m = c.groupMetadata || {};
          try { if (S.GroupMetadata && S.GroupMetadata.get) m = S.GroupMetadata.get(c.id) || m; } catch (e) {}
          const p = m.parentGroup || m.parentGroupId || null;
          out.set(id, {
            id,
            name: c.formattedTitle || c.name || m.subject || 'Group',
            isCommunity: !!(m.isParentGroup || m.isCommunity),
            isAnnounce: !!(m.defaultSubgroup || m.isDefaultSubgroup),
            parent: p ? (p._serialized || String(p)) : null
          });
        }
        return [...out.values()];
      });
    } catch (e) {
      log('Backup method used: ' + e.message, 'err');
      const chats = await wa.getChats();
      list = chats.filter((c) => c.isGroup).map((c) => {
        const m = c.groupMetadata || {};
        const p = m.parentGroup || null;
        return { id: c.id._serialized, name: c.name, isCommunity: !!(m.isParentGroup || m.isCommunity),
          isAnnounce: !!m.defaultSubgroup, parent: p ? (p._serialized || String(p)) : null };
      });
    }
    if (!list.length && attempt < 6) {
      log(`No groups yet, trying again (${attempt}/5)...`);
      await new Promise((r) => setTimeout(r, 8000));
      return loadGroups(attempt + 1);
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    const comms = list.filter((g) => g.isCommunity).sort(byName);
    const used = new Set(comms.map((c) => c.id));
    const communities = comms.map((c) => {
      const items = [];
      const ann = list.find((g) => g.isAnnounce && g.parent === c.id);
      if (ann) { items.push({ id: ann.id, name: '📢 Announcements' }); used.add(ann.id); }
      items.push({ id: c.id, name: '🏘 Community main chat' });
      list.filter((g) => g.parent === c.id && !g.isAnnounce && g.id !== c.id).sort(byName)
        .forEach((g) => { items.push({ id: g.id, name: g.name }); used.add(g.id); });
      return { id: c.id, name: c.name, items };
    });
    const others = list.filter((g) => !used.has(g.id) && !g.parent).sort(byName);
    send('groups', { communities, others });
    if (list.length) { readyFired = true; send('wa-state', { state: 'ready' }); }
    log(`Found ${communities.length} community(ies) and ${others.length} other group(s)`, list.length ? 'ok' : 'err');
  } catch (e) { log('Could not load groups: ' + e.message, 'err'); }
}

/* ---------------- AI (Groq / Gemini / local) - see ai.js ---------------- */
const { createAI } = require('./ai');
const AI = createAI({ loadSettings, patchSettings: (p) => saveSettings({ ...loadSettings(), ...p }), log });

/* ---------------- TickTick ---------------- */
const tt = async (s, method, url, body) => {
  const res = await fetch('https://api.ticktick.com/open/v1' + url, {
    method,
    headers: { Authorization: 'Bearer ' + s.ttToken, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error('TickTick login expired - press "Connect TickTick" again');
  if (!res.ok) throw new Error('TickTick ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const t = await res.text();
  return t ? JSON.parse(t) : {};
};
async function ensureProject(s) {
  const list = await tt(s, 'GET', '/project');
  const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const found = list.find((p) => norm(p.name) === norm(s.projectName));
  return found ? found.id : (await tt(s, 'POST', '/project', { name: s.projectName })).id;
}
async function addTasks(s, items) {
  const projectId = s.projectId || (await ensureProject(s));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date().toISOString().slice(0, 10);
  for (const it of items) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : today;
    await tt(s, 'POST', '/task', {
      title: it.title || 'School',
      projectId,
      kind: 'CHECKLIST',
      content: (it.notes || '').slice(0, 500),
      isAllDay: true,
      timeZone,
      dueDate: `${date}T00:00:00+0000`,
      startDate: `${date}T00:00:00+0000`,
      items: (it.books || []).map((b, n) => ({ title: String(b).slice(0, 200), status: 0, sortOrder: n }))
    });
  }
}
function connectTickTick() {
  const s = loadSettings();
  if (!s.ttClientId || !s.ttClientSecret) return log('Enter TickTick Client ID and Secret first', 'err');
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost:8765');
    if (u.pathname !== '/callback') return res.end();
    const code = u.searchParams.get('code');
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Connected! You can close this tab.</h2></body></html>');
    server.close();
    try {
      const r = await fetch('https://ticktick.com/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(s.ttClientId + ':' + s.ttClientSecret).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', scope: 'tasks:write tasks:read', redirect_uri: REDIRECT })
      });
      const j = await r.json();
      if (!j.access_token) throw new Error(JSON.stringify(j));
      const cur = loadSettings(); cur.ttToken = j.access_token; saveSettings(cur);
      send('tt-state', true); log('TickTick connected', 'ok');
    } catch (e) { log('TickTick auth failed: ' + e.message, 'err'); }
  });
  server.on('error', (e) => log('Port 8765 busy: ' + e.message, 'err'));
  server.listen(8765, () => {
    shell.openExternal('https://ticktick.com/oauth/authorize?' + new URLSearchParams({
      scope: 'tasks:write tasks:read', client_id: s.ttClientId, state: 'x', redirect_uri: REDIRECT, response_type: 'code'
    }));
  });
}

/* ---------------- Main job ---------------- */
async function runCheck() {
  if (running) return;
  running = true; send('running', true);
  let failed = false;
  try {
    const s = loadSettings();
    if (!wa || !(await wa.getState().catch(() => null))) throw new Error('WhatsApp is not connected');
    if (!s.groupId) throw new Error('Select a group first');
    if (!s.geminiKey && !s.groqKey) throw new Error('Add a Groq or Gemini key (Setup > AI)');
    if (!s.ttToken) throw new Error('Connect TickTick first');
    log('Checking group for new PDFs...'); send('progress', { step: 'start' });
    const chat = await wa.getChatById(s.groupId);
    const msgs = await chat.fetchMessages({ limit: 100 });
    const cutoff = Date.now() / 1000 - 26 * 3600;
    let count = 0;
    for (const m of msgs) {
      const id = m.id._serialized;
      if (!m.hasMedia || m.timestamp < cutoff || s.done.includes(id)) continue;
      if (m.type && m.type !== 'document') continue;
      const info = m._data || {};
      if (info.mimetype && !String(info.mimetype).includes('pdf')) continue;
      if (s.pdfName && info.filename && !String(info.filename).toLowerCase().includes(s.pdfName.toLowerCase())) continue;
      const media = await m.downloadMedia().catch(() => null);
      if (!media || media.mimetype !== 'application/pdf') continue;
      const name = media.filename || m.body || '';
      if (s.pdfName && !name.toLowerCase().includes(s.pdfName.toLowerCase())) continue;
      const dir = path.join(app.getPath('documents'), 'SchoolSync');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name || id + '.pdf'), Buffer.from(media.data, 'base64'));
      log('Downloaded ' + (name || 'PDF') + ', reading it...');
      send('progress', { step: 'read' });
      const items = await AI.analyzePdf(media.data);
      send('progress', { step: 'tasks' });
      await addTasks(s, items);
      s.done.push(id); saveSettings(s); count++;
      log(`Added ${items.length} task(s) to TickTick`, 'ok');
    }
    if (count) send('progress', { step: 'done', count }); else { log('No new matching PDF found'); send('progress', { step: 'none' }); }
  } catch (e) { log(e.message, 'err'); send('progress', { step: 'error' }); failed = true; }
  running = false; send('running', false);
  return failed ? 'error' : 'ok';
}
function schedule() {
  if (task) task.stop();
  const [h, m] = loadSettings().time.split(':').map(Number);
  task = cron.schedule(`${m} ${h} * * *`, async () => {
    for (let i = 0; i < 4; i++) {
      const r = await runCheck();
      if (r !== 'error') break;
      log('Run failed - trying again in 10 minutes', 'err');
      await new Promise((res) => setTimeout(res, 10 * 60 * 1000));
    }
  });
}

/* ---------------- Window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 900, minWidth: 560, show: false, backgroundColor: '#070b1f', title: 'School Sync', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { win.setFullScreen(loadSettings().startFullscreen !== false); win.show(); });
  win.on('enter-full-screen', () => send('fs-state', true));
  win.on('leave-full-screen', () => send('fs-state', false));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}
app.whenReady().then(() => {
  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-256.png')).resize({ width: 18, height: 18 }));
  tray.setToolTip('School Sync');
  tray.on('click', () => win.show());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => win.show() },
    { label: 'Run now', click: runCheck },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  app.setLoginItemSettings({ openAtLogin: loadSettings().openAtLogin !== false });
  schedule();
  win.webContents.once('did-finish-load', () => { send('tt-state', !!loadSettings().ttToken); startWA(); });
});
app.on('before-quit', () => { quitting = true; });

ipcMain.handle('set-login', (_, v) => { const s = loadSettings(); s.openAtLogin = !!v; saveSettings(s); app.setLoginItemSettings({ openAtLogin: !!v }); });
ipcMain.handle('toggle-fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, patch) => { saveSettings({ ...loadSettings(), ...patch }); schedule(); return true; });
ipcMain.handle('tt-projects', async () => {
  const s = loadSettings(); if (!s.ttToken) return [];
  try { return (await tt(s, 'GET', '/project')).filter((p) => !p.closed).map((p) => ({ id: p.id, name: p.name })); }
  catch (e) { log(e.message, 'err'); return []; }
});
ipcMain.handle('reset-done', () => { const s = loadSettings(); s.done = []; saveSettings(s); log('Forgot processed PDFs - next run reads them again', 'ok'); });
ipcMain.handle('import-pdf', async (_, files) => {
  if (running) { log('Busy - wait for the current run to finish', 'err'); return; }
  running = true; send('running', true);
  try {
    const s = loadSettings();
    if (!s.geminiKey && !s.groqKey) throw new Error('Add a Groq or Gemini key first (Setup > AI)');
    if (!s.ttToken) throw new Error('Connect TickTick first (Setup > TickTick)');
    let count = 0;
    for (const f of files) {
      send('progress', { step: 'start', text: 'Opening ' + f.name + '...' });
      const dir = path.join(app.getPath('documents'), 'SchoolSync');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(f.name).replace(/[<>:"/\\|?*]/g, '_')), Buffer.from(f.data, 'base64'));
      log('Opened ' + f.name + ', reading it...');
      send('progress', { step: 'read' });
      const items = await AI.analyzePdf(f.data);
      if (!items.length) { log('The AI found no tasks in ' + f.name, 'err'); continue; }
      send('progress', { step: 'tasks' });
      await addTasks(s, items);
      log(`Added ${items.length} task(s) to TickTick`, 'ok');
      count++;
    }
    send('progress', count ? { step: 'done', count } : { step: 'empty' });
  } catch (e) { log(e.message, 'err'); send('progress', { step: 'error' }); }
  running = false; send('running', false);
});

/* ---------------- Sync AI (v6): streaming chat, uses the same Gemini key ---------------- */
const aiAbort = new Map();
ipcMain.handle('ai-stream', async (_, { id, contents, system }) => {
  const ctl = new AbortController();
  aiAbort.set(id, ctl);
  let any = false;
  try {
    const r = await AI.chat({ contents, system, outer: ctl.signal, onText: (t) => { any = true; send('ai-chunk', { id, text: t }); } });
    if (r.ok) { send('ai-done', { id }); return true; }
    if (any) { send('ai-done', { id }); return true; } // answered partly, then the connection dropped
    send('ai-err', { id, msg: r.err });
  } catch (e) {
    if (ctl.signal.aborted) send('ai-done', { id, stopped: true });
    else send('ai-err', { id, msg: String(e.message || e) });
  } finally { aiAbort.delete(id); }
  return false;
});
ipcMain.handle('ai-warm', () => AI.warm());
ipcMain.handle('ai-stop', (_, id) => { const c = aiAbort.get(id); if (c) c.abort(); });
ipcMain.handle('run-now', () => runCheck());
ipcMain.handle('tt-connect', () => connectTickTick());
ipcMain.handle('refresh-groups', () => loadGroups());

/* ---- TickTick tab (live task manager) ---- */
const ttSafe = async (fn) => { try { return await fn(); } catch (e) { log(e.message, 'err'); return { error: e.message }; } };
ipcMain.handle('tt-data', () => ttSafe(async () => {
  const s = loadSettings(); if (!s.ttToken) return { error: 'not-connected' };
  const projects = (await tt(s, 'GET', '/project')).filter((p) => !p.closed);
  const tasks = []; let i = 0;
  const worker = async () => {
    while (i < projects.length) {
      const p = projects[i++];
      try { const d = await tt(s, 'GET', `/project/${p.id}/data`); (d.tasks || []).forEach((t) => tasks.push({ ...t, projectId: p.id })); }
      catch (e) { if (/expired/.test(e.message)) throw e; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { projects: projects.map((p) => ({ id: p.id, name: p.name, color: p.color || null, sortOrder: p.sortOrder || 0, kind: p.kind })), tasks };
}));
ipcMain.handle('tt-create', (_, b) => ttSafe(() => tt(loadSettings(), 'POST', '/task', b)));
ipcMain.handle('tt-update', (_, b) => ttSafe(() => tt(loadSettings(), 'POST', '/task/' + b.id, b)));
ipcMain.handle('tt-complete', (_, b) => ttSafe(async () => { await tt(loadSettings(), 'POST', `/project/${b.projectId}/task/${b.id}/complete`); return { ok: true }; }));
ipcMain.handle('tt-delete', (_, b) => ttSafe(async () => { await tt(loadSettings(), 'DELETE', `/project/${b.projectId}/task/${b.id}`); return { ok: true }; }));
