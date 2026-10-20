'use strict';

/*
 * Cockpit : tableau de bord pour suivre des projets hébergés sur des sous-domaines.
 * Aucune dépendance externe (Node.js 18+).
 *
 * Variables d'environnement :
 *   ADMIN_USER, ADMIN_PASS      obligatoires (authentification HTTP Basic)
 *   CHECK_INTERVAL_SECONDS      intervalle entre deux vérifications (défaut 300, min 60)
 *   PORT                        port d'écoute (défaut 3000, géré par Plesk/Passenger)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PROJECTS_FILE = path.join(ROOT, 'projects.json');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = process.env.PORT || 3000;
const INTERVAL_MS = Math.max(60, Number(process.env.CHECK_INTERVAL_SECONDS) || 300) * 1000;
const TIMEOUT_MS = 8000;
const MAX_HISTORY = 288; // 24 h à 5 min d'intervalle
const STRIP_LENGTH = 60; // nombre de barres affichées par projet
const SLOW_MS = 2000;

const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('ADMIN_USER et ADMIN_PASS doivent être définis (voir README.md).');
  process.exit(1);
}

/* ---------- Projets ---------- */

// Champs transmis à l'interface (les chemins serveur restent côté serveur).
const PUBLIC_FIELDS = [
  'id', 'name', 'url', 'description', 'stack', 'node', 'port',
  'db', 'repo', 'branch', 'deploy', 'notes', 'pleskUrl',
];

function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function loadProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.projects;
    if (!Array.isArray(list)) throw new Error('projects.json doit contenir une liste de projets');
    return { projects: list.map((p) => ({ ...p, id: p.id || slug(p.name || p.url || 'projet') })), error: null };
  } catch (e) {
    return { projects: [], error: e.message };
  }
}

/* ---------- Historique ---------- */

let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch (_) {
  history = {};
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error('Impossible d\'écrire l\'historique :', e.message);
  }
}

/* ---------- Vérification HTTP / SSL ---------- */

function checkUrl(urlStr) {
  return new Promise((resolve) => {
    const t = Date.now();
    let u;
    try {
      u = new URL(urlStr);
    } catch (_) {
      return resolve({ t, ok: false, code: 0, ms: 0, error: 'URL invalide' });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ t, ok: false, code: 0, ms: 0, error: 'Protocole non pris en charge' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'cockpit/1.0' },
    }, (res) => {
      const ms = Date.now() - t;
      let sslDays = null;
      if (u.protocol === 'https:' && res.socket && typeof res.socket.getPeerCertificate === 'function') {
        const cert = res.socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          sslDays = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
        }
      }
      res.resume();
      // Un 401/403/404 prouve que le serveur répond ; seules les erreurs 5xx comptent comme panne.
      resolve({ t, ok: res.statusCode < 500, code: res.statusCode, ms, sslDays });
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé (' + TIMEOUT_MS / 1000 + ' s)')));
    req.on('error', (e) => resolve({ t, ok: false, code: 0, ms: Date.now() - t, error: e.message }));
    req.end();
  });
}

let running = null;

function runChecks() {
  if (running) return running;
  running = (async () => {
    const { projects } = loadProjects();
    const targets = projects.filter((p) => p.checkUrl || p.url);
    const results = await Promise.all(targets.map((p) => checkUrl(p.checkUrl || p.url)));
    targets.forEach((p, i) => {
      const list = history[p.id] || [];
      list.push(results[i]);
      history[p.id] = list.slice(-MAX_HISTORY);
    });
    // Nettoie l'historique des projets supprimés de projects.json.
    const ids = new Set(projects.map((p) => p.id));
    Object.keys(history).forEach((id) => { if (!ids.has(id)) delete history[id]; });
    saveHistory();
  })().finally(() => { running = null; });
  return running;
}

/* ---------- Infos git / fichiers ---------- */

const gitCache = new Map();
const MARKERS = ['package.json', 'index.html', 'index.php', 'public/index.html'];

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

async function readGit(p) {
  const base = p.gitDir ? ['--git-dir', p.gitDir] : p.path ? ['-C', p.path] : null;
  if (base) {
    const out = await git(base.concat(['log', '-1', '--format=%h%x09%cI%x09%an%x09%s']));
    if (out) {
      const [hash, date, author, subject] = out.split('\t');
      return { source: 'git', hash, date, author, subject };
    }
  }
  if (p.path) {
    let newest = 0;
    for (const f of MARKERS) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(p.path, f)).mtimeMs);
      } catch (_) { /* fichier absent */ }
    }
    if (newest) return { source: 'files', date: new Date(newest).toISOString() };
  }
  return null;
}

async function gitInfo(p) {
  if (!p.path && !p.gitDir) return null;
  const hit = gitCache.get(p.id);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const value = await readGit(p);
  gitCache.set(p.id, { at: Date.now(), value });
  return value;
}

/* ---------- API ---------- */

async function buildStatus() {
  const { projects, error } = loadProjects();
  const out = await Promise.all(projects.map(async (p) => {
    const list = history[p.id] || [];
    const last = list[list.length - 1] || null;
    const okCount = list.filter((c) => c.ok).length;
    const pub = {};
    PUBLIC_FIELDS.forEach((k) => { if (p[k] !== undefined && p[k] !== '') pub[k] = p[k]; });
    return {
      ...pub,
      monitored: Boolean(p.checkUrl || p.url),
      last,
      uptime: list.length ? Math.round((okCount / list.length) * 1000) / 10 : null,
      checks: list.length,
      strip: list.slice(-STRIP_LENGTH).map((c) => ({ t: c.t, ok: c.ok, ms: c.ms, code: c.code })),
      git: await gitInfo(p),
    };
  }));
  return {
    generatedAt: Date.now(),
    intervalSeconds: INTERVAL_MS / 1000,
    slowMs: SLOW_MS,
    stripLength: STRIP_LENGTH,
    configError: error,
    projects: out,
  };
}

/* ---------- Authentification et serveur ---------- */

function sha(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function authorized(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const userOk = crypto.timingSafeEqual(sha(decoded.slice(0, i)), sha(ADMIN_USER));
  const passOk = crypto.timingSafeEqual(sha(decoded.slice(i + 1)), sha(ADMIN_PASS));
  return userOk && passOk;
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cockpit", charset="UTF-8"');
    return send(res, 401, 'Authentification requise', 'text/plain; charset=utf-8');
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), type);
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, JSON.stringify(await buildStatus()), 'application/json; charset=utf-8');
    }
    if (req.method === 'POST' && pathname === '/api/check') {
      await runChecks();
      return send(res, 200, JSON.stringify(await buildStatus()), 'application/json; charset=utf-8');
    }
    return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    return send(res, 500, 'Erreur interne', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, () => {
  console.log('Cockpit en écoute sur le port ' + PORT);
  runChecks();
  setInterval(runChecks, INTERVAL_MS).unref();
});
