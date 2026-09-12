// Le routeur de l'API. Aucune dépendance hors du cœur de Node : la base, la vérification du jeton,
// la source de hasard et l'horloge lui sont injectées. C'est ce qui permet de le tester entièrement
// sans Postgres ni compte Crossmint — les deux adaptateurs réels vivent dans db-pg.js et
// auth-crossmint.js, et sont les seuls morceaux qui touchent l'extérieur.
'use strict';
const crypto = require('node:crypto');
const C = require('./core');

const MAX_BODY = 4 * 1024;          // un profil tient largement dedans ; au-delà, on coupe
const AVATARS = new Set(C.avatarList(Object.keys(C.BRAWLERS)).map(a => a.id));

// Les routes et les méthodes qu'elles acceptent. Une table plutôt qu'une cascade de `if` : le 405,
// le 404 et la liste annoncée au pré-vol se déduisent d'un seul endroit, donc ils ne peuvent pas
// diverger le jour où une route s'ajoute.
const METHODES = new Map([
  ['/api/me', ['GET', 'PATCH']],
  ['/api/match', ['POST']],
]);
const METHODES_CORS = [...new Set([].concat(...METHODES.values())), 'OPTIONS'].join(',');

// Combien de temps un billet reste ouvert : l'attente du sas, toute la durée du plan de zone — la
// borne haute d'une partie que personne ne gagne — et dix minutes de marge. La marge est le
// compromis assumé : trop courte, elle périme la partie d'un joueur dont l'onglet est passé en
// arrière-plan (le navigateur y gèle la boucle de rendu) ; trop longue, elle enferme dans un billet
// mort celui qui a fermé son onglet, puisqu'un seul billet peut être ouvert à la fois. Aucun argent
// n'est en jeu en 02a : on préfère perdre une ligne de statistique que bloquer un joueur.
const MATCH_MARGE_S = 600;

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

// Ce que le client a le droit de demander pour un billet : une table, un mode, un brawler, et la
// clé qui rend sa demande rejouable. Rien d'autre. Un corps qui porterait une graine, des sièges,
// un montant, un statut ou un identifiant d'utilisateur n'est pas refusé — il est sans effet, ces
// valeurs-là venant du serveur ou de WBCore. C'est le même parti pris que `checkProfile`, pour la
// même raison : une liste blanche ne laisse rien passer par inadvertance.
//
// Ce qui est validé ici ne sert jamais de valeur : on écrit le mode, la mise et le brawler
// RETROUVÉS dans WBCore, jamais les nombres reçus.
function checkMatch(corps) {
  const erreurs = [];
  // `hasOwnProperty` et pas une simple lecture : `MODES['constructor']` rend une fonction, donc une
  // valeur vraie, et un mode inventé passerait pour connu.
  const connu = (table, cle) => typeof cle === 'string' && Object.prototype.hasOwnProperty.call(table, cle);

  const mode = connu(C.MODES, corps.mode) ? C.MODES[corps.mode] : null;
  if (!mode) erreurs.push(`Mode inconnu. Modes possibles : ${Object.keys(C.MODES).join(', ')}.`);

  // La mise arrive telle qu'elle est affichée, en dollars. On ne la convertit pas : on cherche la
  // table qui porte exactement ce montant, et c'est SA mise qui sera convertie en centimes.
  const mise = Number(corps.stake);
  const table = Number.isFinite(mise) ? C.TIERS.find(t => t.stake === mise) : null;
  if (!table) erreurs.push(`Mise inconnue. Mises possibles : ${C.TIERS.map(t => t.stake).join(', ')}.`);

  const brawler = connu(C.BRAWLERS, corps.brawler) ? corps.brawler : null;
  if (!brawler) erreurs.push(`Brawler inconnu. Brawlers possibles : ${Object.keys(C.BRAWLERS).join(', ')}.`);

  // Sans cette clé, un POST dont la réponse se perd est indistinguable d'un POST jamais arrivé, et
  // le client ne peut pas réessayer sans risquer d'ouvrir deux parties.
  const clientKey = typeof corps.clientKey === 'string' ? corps.clientKey.trim() : '';
  if (!clientKey || clientKey.length > 64)
    erreurs.push('Il faut une clé d\'idempotence « clientKey » : de 1 à 64 caractères, tirée par le client et rejouée à l\'identique si la réponse se perd.');

  if (erreurs.length) return { champs: null, erreurs };
  return {
    champs: { mode, stakeCents: C.toCents(table.stake), seats: C.seatsOf(mode), brawler, clientKey },
    erreurs,
  };
}

// Les deux graines d'une partie. Le domaine est celui des entiers 32 bits non signés parce que
// c'est celui de `makeRng`, et donc celui que `seedFor` accepte côté client : une graine hors de ce
// domaine serait rejetée par le jeu, qui repartirait sur la sienne sans que personne ne le sache.
// Une source détraquée fait donc échouer bruyamment plutôt que d'écrire une graine inutilisable.
function graine32(source) {
  const s = source();
  if (!Number.isInteger(s) || s < 0 || s > 0xFFFFFFFF)
    throw new Error('randomSeed doit rendre un entier 32 bits non signé.');
  return s;
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

// Le billet, tel qu'il part au client. Même liste blanche explicite que `moi`, et une raison de
// plus ici : la ligne porte une colonne `seed_secret` qui ne doit JAMAIS traverser le réseau. Un
// `select *` rendu tel quel la publierait le jour où quelqu'un ajoute une colonne sans y penser.
const billet = m => ({
  id: String(m.id),
  mode: m.mode,
  stakeCents: m.stake_cents,
  seats: m.seats,
  brawler: m.brawler,
  // `seed` tout court : c'est le nom que `WBCore.seedFor` lit dans le billet. Et `Number`, parce
  // que le pilote Postgres rend les colonnes `bigint` sous forme de CHAÎNE : une graine en chaîne
  // est refusée par `seedFor`, qui repartirait sur la graine locale sans que personne ne le voie.
  // C'est une panne silencieuse, donc elle se corrige ici en plus de l'adaptateur.
  seed: Number(m.seed_public),
  status: m.status,
  openedAt: m.opened_at,
  expiresAt: m.expires_at,
});

function createApp({
  db, verifyToken, origins = [], limiter = makeLimiter(),
  // La source de hasard est injectée comme la base et la vérification du jeton : c'est ce qui rend
  // les graines observables dans les tests. Par défaut, le générateur du système — une graine tirée
  // sur `Math.random` serait devinable, et l'une des deux ne doit jamais l'être.
  randomSeed = () => crypto.randomInt(0, 2 ** 32),
  // L'horloge aussi : l'expiration d'un billet se teste en avançant le temps, pas en attendant.
  now = Date.now,
}) {
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

  // ---------- POST /api/match ----------
  // Le serveur possède l'identité de la partie ; le client ne fait que la demander. Il choisit sa
  // table, son mode et son brawler, et rien de plus : les graines, les sièges, la mise en centimes,
  // l'heure d'ouverture et l'expiration sortent d'ici ou de WBCore.
  async function ouvrirBillet(req, res, identite, origin) {
    // La limitation de débit a son propre seau : renommer son personnage douze fois ne doit pas
    // empêcher de jouer, et inversement. C'est la première route qui ÉCRIT en base, d'où la
    // limite connue du README qui devient plus coûteuse ici — le compteur est en mémoire.
    if (!limiter('match:' + identite.authId))
      return envoyer(res, 429, { erreur: 'Trop de parties demandées d\'affilée. Réessaie dans une minute.' }, origin);

    let corps;
    try { corps = await lireCorps(req); }
    catch { return envoyer(res, 400, { erreur: 'Requête illisible.' }, origin); }
    if (!corps || typeof corps !== 'object' || Array.isArray(corps))
      return envoyer(res, 400, { erreur: 'Requête illisible.' }, origin);

    const { champs, erreurs } = checkMatch(corps);
    if (erreurs.length) return envoyer(res, 400, { erreur: erreurs[0], erreurs }, origin);

    // Un billet appartient à quelqu'un. Le compte naît ici comme il naît sur `GET /api/me`, et pour
    // la même raison : d'un jeton vérifié, jamais d'un appel du client.
    const { user } = await db.findOrCreate({
      authId: identite.authId,
      email: identite.email || '',
      name: C.nameOr(identite.name, C.NAME.fallback),
      nameKey: C.nameKey,
    });

    // Deux tirages, deux usages. La publique décide de la carte et du gaz, et part au client. La
    // secrète ne quitte jamais le serveur : elle ne sert à rien tant que rien n'est simulé, et
    // c'est exactement pourquoi elle est créée maintenant — le jour où le serveur décidera du
    // contenu des caisses, il faudra que le client ne l'ait jamais reçue, sans migration.
    const seedPublic = graine32(randomSeed);
    const seedSecret = graine32(randomSeed);

    // L'expiration se livre AVEC le billet. Elle se déduit du plan de zone, donc de la vraie durée
    // maximale d'une partie de ce mode, et non d'un délai rond choisi au hasard.
    const t = now();
    const dureeS = C.LOBBY.wait + C.zoneTotalS(C.zonePlan(seedPublic, champs.mode)) + MATCH_MARGE_S;
    const openedAt = new Date(t);
    const expiresAt = new Date(t + dureeS * 1000);

    // Aucun `select` préalable : ce sont les contraintes de la base qui arbitrent l'idempotence,
    // comme pour `name_key`. Une vérification préalable laisserait une fenêtre entre le « a-t-il
    // déjà un billet ? » et l'insertion, et deux onglets rapides passeraient tous les deux.
    const { match } = await db.createMatch({
      userId: user.id,
      mode: champs.mode.id,
      stakeCents: champs.stakeCents,
      seats: champs.seats,
      brawler: champs.brawler,
      seedPublic, seedSecret,
      clientKey: champs.clientKey,
      openedAt, expiresAt,
    });
    // 200 et jamais 201, y compris à la création : un code différent selon que le billet vient
    // d'être créé ou qu'il existait déjà rendrait le rejeu distinguable du premier appel, ce qui
    // est précisément ce que l'idempotence promet d'effacer.
    return envoyer(res, 200, billet(match), origin);
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
        'access-control-allow-methods': METHODES_CORS,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-max-age': '600',
        'vary': 'Origin',
      });
      res.writeHead(204, head); res.end(); return;
    }

    if (route === '/api/health') return envoyer(res, 200, { ok: true }, origin);

    const methodes = METHODES.get(route);
    if (!methodes) return envoyer(res, 404, { erreur: 'Route inconnue.' }, origin);
    if (!methodes.includes(req.method))
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
      // ---------- le billet d'une partie ----------
      if (route === '/api/match') return await ouvrirBillet(req, res, identite, origin);

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

module.exports = { createApp, checkProfile, checkMatch, makeLimiter, AVATARS, MAX_BODY, MATCH_MARGE_S };
