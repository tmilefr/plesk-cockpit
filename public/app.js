'use strict';

const list = document.getElementById('list');
const summary = document.getElementById('summary');
const banner = document.getElementById('banner');
const refreshBtn = document.getElementById('refresh');

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/* ---------- Utilitaires ---------- */

// Construit un élément DOM sans jamais interpréter de HTML (le contenu vient de projects.json).
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === false || v === null || v === undefined) return;
    el.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return el;
}

function ago(ts) {
  const s = Math.round((new Date(ts).getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 60) return 'à l\'instant';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 60) return rtf.format(Math.round(s / 86400), 'day');
  return rtf.format(Math.round(s / (86400 * 30)), 'month');
}

function host(url) {
  try { return new URL(url).host; } catch (_) { return url || ''; }
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch (_) {
    return null;
  }
}

/* ---------- États ---------- */

function tickClass(c, slowMs) {
  if (!c.ok) return 'down';
  return c.ms > slowMs ? 'warn' : 'ok';
}

function projectState(p, slowMs) {
  if (!p.monitored) return { cls: '', text: 'Non surveillé' };
  if (!p.last) return { cls: '', text: 'Pas encore vérifié' };
  if (!p.last.ok) {
    const why = p.last.code ? 'erreur ' + p.last.code : p.last.error || 'ne répond pas';
    return { cls: 'down', text: 'Hors ligne : ' + why };
  }
  if (p.last.ms > slowMs) return { cls: 'warn', text: 'En ligne, lent' };
  return { cls: 'ok', text: 'En ligne' };
}

/* ---------- Rendu ---------- */

function beatStrip(p, data) {
  const bars = [];
  const missing = Math.max(0, data.stripLength - p.strip.length);
  for (let i = 0; i < missing; i++) bars.push(h('i'));
  p.strip.forEach((c) => {
    const when = dateFmt.format(new Date(c.t));
    const label = c.ok ? c.ms + ' ms' : (c.code ? 'erreur ' + c.code : 'injoignable');
    bars.push(h('i', { class: tickClass(c, data.slowMs), title: when + ' : ' + label }));
  });
  return h('div', {
    class: 'beat',
    role: 'img',
    'aria-label': p.strip.length
      ? 'Historique des ' + p.strip.length + ' dernières vérifications'
      : 'Aucune vérification pour le moment',
  }, bars);
}

function latencyMetric(p, data) {
  if (!p.last) return h('div', { class: 'metric' }, h('b', {}, '—'), h('small', {}, 'réponse'));
  const cls = !p.last.ok ? 'down' : p.last.ms > data.slowMs ? 'warn' : '';
  return h('div', { class: 'metric ' + cls },
    h('b', {}, p.last.ok ? p.last.ms + ' ms' : '—'),
    h('small', {}, p.uptime !== null ? p.uptime + ' % sur ' + p.checks + ' vérif.' : 'réponse'));
}

function sslMetric(p) {
  const d = p.last && p.last.sslDays;
  if (d === null || d === undefined) {
    return h('div', { class: 'metric' }, h('b', {}, '—'), h('small', {}, 'certificat'));
  }
  const cls = d < 7 ? 'down' : d < 21 ? 'warn' : '';
  return h('div', { class: 'metric ' + cls },
    h('b', {}, d < 0 ? 'Expiré' : d + ' j'),
    h('small', {}, 'certificat'));
}

function deployLine(p) {
  if (!p.git) return null;
  if (p.git.source === 'git') {
    return h('div', {},
      h('h2', {}, 'Dernier déploiement connu'),
      h('p', {}, p.git.subject),
      h('p', { class: 'muted' },
        p.git.hash + ' · ' + p.git.author + ' · ' + dateFmt.format(new Date(p.git.date)) + ' (' + ago(p.git.date) + ')'));
  }
  return h('div', {},
    h('h2', {}, 'Dernier déploiement connu'),
    h('p', {}, 'Fichiers modifiés le ' + dateFmt.format(new Date(p.git.date)) + ' (' + ago(p.git.date) + ')'),
    h('p', { class: 'muted' }, 'Aucun dépôt git lisible : date déduite des fichiers du site.'));
}

function dbEnvText(d) {
  if (d.error) return 'lecture du .env impossible : ' + d.error;
  const target = (d.host || 'localhost') + (d.port ? ':' + d.port : '');
  return [
    d.driver,
    target,
    d.database ? 'base ' + d.database : null,
    d.user ? 'utilisateur ' + d.user : null,
    d.reachable === true ? 'serveur joignable' : d.reachable === false ? 'serveur injoignable' : null,
  ].filter(Boolean).join(' · ');
}

function mo(v) {
  return v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' Go' : String(v).replace('.', ',') + ' Mo';
}

function configRows(p) {
  const rows = [
    ['Sous-domaine', host(p.url)],
    ['Stack', p.stack],
    ['Node.js', p.node],
    ['Port', p.port],
    ['Base de données', p.dbEnv ? dbEnvText(p.dbEnv) : p.db],
    ['Dépôt', p.repo],
    ['Branche', p.branch],
    ['Déploiement', p.deploy],
    ['Espace disque (Plesk)', p.diskMb !== undefined ? mo(p.diskMb) : undefined],
    ['Trafic mensuel (Plesk)', p.trafficMb !== undefined ? mo(p.trafficMb) + '/mois' : undefined],
  ].filter(([, v]) => v !== undefined && v !== '');
  return rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)));
}

function renderProject(p, data, isOpen) {
  const st = projectState(p, data.slowMs);
  const siteHref = safeHref(p.url);
  const pleskHref = safeHref(p.pleskUrl);

  const summaryEl = h('summary', {},
    h('div', { class: 'ident' },
      h('span', { class: 'dot ' + st.cls, 'aria-hidden': 'true' }),
      h('div', {},
        h('span', { class: 'title' }, p.name),
        h('span', { class: 'host' }, host(p.url)),
        p.dbEnv || p.db ? h('span', { class: 'host' }, 'Base : ' + (p.dbEnv ? dbEnvText(p.dbEnv) : p.db)) : null,
        h('span', { class: 'state ' + st.cls }, st.text))),
    beatStrip(p, data),
    latencyMetric(p, data),
    sslMetric(p));

  const rows = configRows(p);
  const detail = h('div', { class: 'detail' },
    h('div', {},
      h('h2', {}, 'Configuration'),
      p.description ? h('p', {}, p.description) : null,
      rows.length ? h('dl', {}, rows) : h('p', { class: 'muted' }, 'Aucun détail renseigné dans projects.json.'),
      h('div', { class: 'links' },
        siteHref ? h('a', { href: siteHref, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir le site') : null,
        pleskHref ? h('a', { href: pleskHref, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir dans Plesk') : null)),
    h('div', {},
      deployLine(p),
      p.notes ? h('div', {}, h('h2', {}, 'Notes'), h('p', {}, p.notes)) : null));

  const el = h('details', { class: 'project', 'data-id': p.id }, summaryEl, detail);
  if (isOpen) el.open = true;
  return el;
}

function render(data) {
  const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.id));

  banner.hidden = !data.configError;
  banner.textContent = data.configError ? 'projects.json est illisible : ' + data.configError : '';

  list.replaceChildren();
  if (!data.projects.length) {
    list.append(h('p', { class: 'empty' }, 'Aucun projet. Ajoutez-en dans projects.json puis redémarrez l\'application.'));
  } else {
    data.projects.forEach((p) => list.append(renderProject(p, data, open.has(p.id))));
  }

  const monitored = data.projects.filter((p) => p.monitored);
  const down = monitored.filter((p) => p.last && !p.last.ok).length;
  const slow = monitored.filter((p) => p.last && p.last.ok && p.last.ms > data.slowMs).length;
  const unknown = monitored.filter((p) => !p.last).length;
  const parts = [h('strong', {}, data.projects.length + (data.projects.length > 1 ? ' projets' : ' projet'))];
  if (monitored.length && !unknown) {
    parts.push(down ? ', ' + down + ' hors ligne' : ', tous en ligne');
    if (slow) parts.push(', ' + slow + ' lent' + (slow > 1 ? 's' : ''));
  } else if (unknown) {
    parts.push(', première vérification en cours');
  }
  parts.push('. Vérification toutes les ' + Math.round(data.intervalSeconds / 60) + ' min, actualisé ' + ago(data.generatedAt) + '.');
  summary.replaceChildren(...parts.map((x) => (typeof x === 'string' ? document.createTextNode(x) : x)));
}

/* ---------- Chargement ---------- */

async function load(force) {
  refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/' + (force ? 'check' : 'status'), { method: force ? 'POST' : 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
  } catch (e) {
    banner.hidden = false;
    banner.textContent = 'Impossible de joindre le serveur (' + e.message + '). Nouvelle tentative dans 30 s.';
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', () => load(true));
load(false);
setInterval(() => load(false), 30000);
