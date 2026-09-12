// Le routeur de l'API. Aucune dépendance : la base et la vérification du jeton lui sont injectées.
// C'est ce qui permet de le tester entièrement sans Postgres ni compte Clerk — les deux adaptateurs
// réels vivent dans db-pg.js et auth-clerk.js, et sont les seuls morceaux qui touchent l'extérieur.
'use strict';
const C = require('./core');

const MAX_BODY = 4 * 1024;          // un profil tient largement dedans ; au-delà, on coupe
const AVATARS = new Set(C.avatarList(Object.keys(C.BRAWLERS)).map(a => a.id));

// ---------- limitation de débit ----------
// Un seau par utilisateur, en mémoire. Volontairement simple : il freine le martèlement d'un pseudo
// convoité, il ne prétend pas résister à une attaque distribuée. Le jour où l'API tournera sur
// plusieurs instances, ce compteur devra passer en Redis — c'est noté dans le README.
function makeLimiter({ max = 12, windowMs = 60_000, now = Date.now } = {}) {
  const seen = new Map();
  return function allow(key) {
    const t = now();
    const hits = (seen.get(key) || []).filter(x => t - x < windowMs);
    if (hits.length >= max) { seen.set(key, hits); return false; }
    hits.push(t); seen.set(key, hits);
    if (seen.size > 10_000) for (const [k, v] of seen) if (!v.some(x => t - x < windowMs)) seen.delete(k);
    return true;
  };
}

// ---------- validation ----------
// Rendue séparément pour être testable seule, et pour que le message dise quoi corriger.
function checkProfile(patch) {
  const out = {}, erreurs = [];
  if (patch.name !== undefined) {
    const name = C.sanitizeName(patch.name);
    if (!C.validName(name)) {
      erreurs.push(`Le pseudo doit faire entre ${C.NAME.min} et ${C.NAME.max} caractères, lettres et chiffres.`);
    } else {
      out.name = name;
      out.name_key = C.nameKey(name);
    }
  }
  if (patch.avatar !== undefined) {
    if (!AVATARS.has(patch.avatar)) erreurs.push('Cet avatar n\'existe pas.');
    else out.avatar = patch.avatar;
  }
  if (patch.country !== undefined) {
    const p = String(patch.country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(p)) erreurs.push('Le pays doit être un code à deux lettres.');
    else out.country = p;
  }
  if (!Object.keys(out).length && !erreurs.length) erreurs.push('Rien à modifier.');
  return { champs: out, erreurs };
}

// ---------- ce qu'on rend au client ----------
// Liste blanche explicite. Un `select *` renvoyé tel quel finit toujours par exposer une colonne
// ajoutée plus tard sans y penser.
const moi = (u, s) => ({
  id: String(u.id),
  name: u.name,
  avatar: u.avatar,
  country: u.country || null,
  email: u.email,
  createdAt: u.created_at,
  stats: { matches: s.matches, wins: s.wins, kills: s.kills, best: s.best },
});

function createApp({ db, verifyToken, origins = [], limiter = makeLimiter() }) {
  if (!db || !verifyToken) throw new Error('createApp a besoin de db et verifyToken.');
  const autorises = new Set(origins);

  function envoyer(res, code, corps, origin) {
    const texte = JSON.stringify(corps);
    const head = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(texte),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    // Jamais d'origine « * » avec des identifiants : on ne renvoie que l'origine demandée si elle
    // figure dans la liste blanche, sinon aucun en-tête et le navigateur refuse de lui-même.
    if (origin && autorises.has(origin)) {
      head['access-control-allow-origin'] = origin;
      head['access-control-allow-credentials'] = 'true';
      head['vary'] = 'Origin';
    }
    res.writeHead(code, head);
    res.end(texte);
  }

  function lireCorps(req) {
    return new Promise((resolve, reject) => {
      let taille = 0; const morceaux = [];
      req.on('data', d => {
        taille += d.length;
        if (taille > MAX_BODY) { reject(new Error('corps trop long')); req.destroy(); return; }
        morceaux.push(d);
      });
      req.on('end', () => {
        if (!morceaux.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(morceaux).toString('utf8'))); }
        catch { reject(new Error('json invalide')); }
      });
      req.on('error', reject);
    });
  }

  return async function handler(req, res) {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://interne');
    const route = url.pathname;

    if (req.method === 'OPTIONS') {
      const head = { 'content-length': '0' };
      if (origin && autorises.has(origin)) Object.assign(head, {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET,PATCH,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-max-age': '600',
        'vary': 'Origin',
      });
      res.writeHead(204, head); res.end(); return;
    }

    if (route === '/api/health') return envoyer(res, 200, { ok: true }, origin);

    if (route !== '/api/me') return envoyer(res, 404, { erreur: 'Route inconnue.' }, origin);
    if (req.method !== 'GET' && req.method !== 'PATCH')
      return envoyer(res, 405, { erreur: 'Méthode non autorisée.' }, origin);

    // ---------- authentification ----------
    const entete = req.headers.authorization || '';
    const jeton = entete.startsWith('Bearer ') ? entete.slice(7).trim() : '';
    if (!jeton) return envoyer(res, 401, { erreur: 'Connexion requise.' }, origin);

    let identite;
    try {
      identite = await verifyToken(jeton);
    } catch {
      // On ne dit jamais pourquoi le jeton est refusé : expiré, mal signé ou forgé, c'est la même
      // réponse. Le détail n'aide que celui qui cherche à en fabriquer un.
      return envoyer(res, 401, { erreur: 'Session invalide ou expirée.' }, origin);
    }
    if (!identite || !identite.authId) return envoyer(res, 401, { erreur: 'Session invalide ou expirée.' }, origin);

    try {
      // ---------- lecture ----------
      if (req.method === 'GET') {
        // La première connexion crée le compte. C'est le seul endroit où un compte naît, et il naît
        // d'un jeton vérifié, jamais d'un appel du client.
        const { user, stats } = await db.findOrCreate({
          authId: identite.authId,
          email: identite.email || '',
          name: C.nameOr(identite.name, C.NAME.fallback),
          nameKey: C.nameKey,
        });
        return envoyer(res, 200, moi(user, stats), origin);
      }

      // ---------- modification ----------
      if (!limiter(identite.authId))
        return envoyer(res, 429, { erreur: 'Trop de modifications d\'affilée. Réessaie dans une minute.' }, origin);

      let patch;
      try { patch = await lireCorps(req); }
      catch { return envoyer(res, 400, { erreur: 'Requête illisible.' }, origin); }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        return envoyer(res, 400, { erreur: 'Requête illisible.' }, origin);

      const { champs, erreurs } = checkProfile(patch);
      if (erreurs.length) return envoyer(res, 400, { erreur: erreurs[0], erreurs }, origin);

      const r = await db.updateProfile(identite.authId, champs);
      if (r.conflit) return envoyer(res, 409, { erreur: 'Ce pseudo est déjà pris.' }, origin);
      if (!r.user) return envoyer(res, 404, { erreur: 'Compte introuvable.' }, origin);
      return envoyer(res, 200, moi(r.user, r.stats), origin);

    } catch (e) {
      // Le détail part dans les journaux du serveur, jamais dans la réponse.
      if (handler.onError) handler.onError(e, route);
      return envoyer(res, 500, { erreur: 'Erreur interne.' }, origin);
    }
  };
}

module.exports = { createApp, checkProfile, makeLimiter, AVATARS, MAX_BODY };
