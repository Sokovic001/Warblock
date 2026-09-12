// Le routeur de l'API. Aucune dépendance hors du cœur de Node : la base, la vérification du jeton,
// la source de hasard et l'horloge lui sont injectées. C'est ce qui permet de le tester entièrement
// sans Postgres ni compte Crossmint — les deux adaptateurs réels vivent dans db-pg.js et
// auth-crossmint.js, et sont les seuls morceaux qui touchent l'extérieur.
'use strict';
const crypto = require('node:crypto');
const C = require('./core');
const S = require('./sim');

const MAX_BODY = 4 * 1024;          // un profil tient largement dedans ; au-delà, on coupe
// LA BORNE DE LA TRACE, ET D'ELLE SEULE. `MAX_BODY` ne bouge pas : relever la borne de la route qui
// décide d'un règlement ferait de la route de l'argent la surface d'attaque la plus large de l'API,
// et « la raison est écrite » n'est pas une protection. La trace, elle, est volumineuse par nature
// — cinq caractères par pas distinct, jusqu'à neuf mille pas — et vit sur sa propre route, en
// insertion seule, où le pire cas est une ligne de plus dans une table qui n'a aucun montant.
// Trente-deux kilo-octets font tenir une partie complète en un à trois envois, jamais vingt.
const MAX_TRACE_BODY = 32 * 1024;
const AVATARS = new Set(C.avatarList(Object.keys(C.BRAWLERS)).map(a => a.id));

// Les routes et les méthodes qu'elles acceptent. Une table plutôt qu'une cascade de `if` : le 405,
// le 404 et la liste annoncée au pré-vol se déduisent d'un seul endroit, donc ils ne peuvent pas
// diverger le jour où une route s'ajoute.
const METHODES = new Map([
  ['/api/me', ['GET', 'PATCH']],
  ['/api/match', ['POST']],
]);
// La seule route qui porte un identifiant dans son chemin. Elle ne tient pas dans la table
// ci-dessus, mais elle en suit la règle : une liste de méthodes, donc un 405 et un pré-vol qui ne
// peuvent pas diverger. L'identifiant est laissé en CHAÎNE — `id` est un `bigserial`, et le
// convertir en nombre perdrait des parties au-delà de 2^53.
const RESULTAT = /^\/api\/match\/([0-9]{1,19})\/result$/;
const RESULTAT_METHODES = ['POST'];
// La trace a SA route, séparée de celle qui règle l'argent. C'est ce qui permet de lui donner une
// borne de corps plus large sans toucher à celle du règlement, et c'est aussi ce qui la rend
// inoffensive : elle n'écrit que dans `match_traces`, en insertion seule, et jamais dans `matches`.
const TRACE = /^\/api\/match\/([0-9]{1,19})\/trace$/;
const TRACE_METHODES = ['POST'];
const METHODES_CORS = [...new Set([].concat(...METHODES.values(), RESULTAT_METHODES, TRACE_METHODES)), 'OPTIONS'].join(',');

// Combien de temps un billet reste ouvert : l'attente du sas, toute la durée du plan de zone — la
// borne haute d'une partie que personne ne gagne — et dix minutes de marge. La marge est le
// compromis assumé : trop courte, elle périme la partie d'un joueur dont l'onglet est passé en
// arrière-plan (le navigateur y gèle la boucle de rendu) ; trop longue, elle enferme dans un billet
// mort celui qui a fermé son onglet, puisqu'un seul billet peut être ouvert à la fois. Aucun argent
// n'est en jeu en 02a : on préfère perdre une ligne de statistique que bloquer un joueur.
const MATCH_MARGE_S = 600;

// LE BUDGET DE CALCUL D'UN REJEU. Il tourne dans le fil de la requête, et une trace adversariale
// peut chercher à en maximiser le coût : c'est la surface d'attaque que la phase 02b ajoute, et
// elle se borne ici. Une partie solo complète — neuf mille pas, vingt brawlers — coûte environ
// trois cents millisecondes sur la machine de développement ; deux secondes laissent donc six fois
// la marge, tout en refusant de tenir un fil une minute entière. Le dépassement est un code NOMMÉ,
// jamais une exception, et il s'éprouve avec une horloge injectée, donc sans attendre.
const REPLAY_BUDGET_MS = 2000;

// LES REFUS DU REJEU, ET LEUR CODE HTTP. Six codes pour la trace — trop longue, malformée,
// absente, non terminale, produite sous une autre version, trop chère à rejouer — plus deux gardes
// qu'aucun client honnête ne peut déclencher : un billet dont le mode a disparu du jeu, et une
// partie rejouée où l'argent ne se conserve pas, qui serait un défaut du serveur et non du joueur.
//
// AUCUN N'EST UN 500, ET AUCUN NE LAISSE LA LIGNE SANS ISSUE. C'est la leçon du `22003` : un
// joueur n'a qu'un billet ouvert à la fois, donc une route qui échoue en laissant la ligne `open`
// l'enferme jusqu'à l'expiration. Ici la ligne reste ouverte volontairement, sans le moindre
// montant, et c'est le veilleur de la 02a qui la clôt — un seul endroit clôt sans montant.
const REJEU_CODES = {
  trop_de_pas:   400,
  donnees:       400,
  trace_absente: 409,
  non_terminal:  409,
  sim_version:   409,
  budget:        409,
  billet:        409,
  conservation:  409,
};

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
  // La recherche de table est une RÈGLE DU JEU : elle vit dans WBCore, l'API l'appelle. La
  // recopier ici — `TIERS.find(...)`, c'est-à-dire le corps même de `tierFor` — rouvrait la
  // divergence silencieuse que `api/core.js` existe pour fermer : le jour où le jeu accepte une
  // table de plus, le lobby l'affiche et le serveur répond « Mise inconnue ».
  const mise = Number(corps.stake);
  const table = C.tierFor(mise);
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
    // `seats` ET `teamSize` sont recopiés dans la ligne pour la même raison : un mode rééquilibré
    // demain ne doit pas réécrire le passé d'une partie déjà jouée, et le résultat d'une partie
    // est accepté jusqu'à l'expiration de son billet.
    champs: { mode, stakeCents: C.toCents(table.stake), seats: C.seatsOf(mode),
              teamSize: mode.teamSize, brawler, clientKey },
    erreurs,
  };
}

// La graine PUBLIQUE d'une partie. Le domaine est celui des entiers 32 bits non signés parce que
// c'est celui de `makeRng`, et donc celui que `seedFor` accepte côté client : une graine hors de ce
// domaine serait rejetée par le jeu, qui repartirait sur la sienne sans que personne ne le sache.
// Une source détraquée fait donc échouer bruyamment plutôt que d'écrire une graine inutilisable.
function graine32(source) {
  const s = source();
  if (!Number.isInteger(s) || s < 0 || s > 0xFFFFFFFF)
    throw new Error('randomSeed doit rendre un entier 32 bits non signé.');
  return s;
}
// La graine SECRÈTE, 128 bits en hexadécimal. Elle ne partage plus la source de la publique, et pour
// une raison qui tient en une phrase : elles n'ont plus le même domaine. `between 0 and 4294967295`
// rendait une graine « secrète » trouvable par force brute hors ligne — deux milliards d'essais
// tiennent dans une soirée — et une colonne qui porte un nom qui ment est pire que pas de colonne.
//
// Ce qu'elle protège dans CETTE phase : rien, et la simulation ne l'utilise pas. Dans une
// architecture de rejeu, le client possède tout ce qu'il dessine ; il dessine les caisses, donc il
// en connaît le contenu dès la première seconde. Elle existe pour le jour où le serveur décidera de
// quelque chose que le client n'a pas à savoir.
function graine128(source) {
  const s = source();
  if (typeof s !== 'string' || !/^[0-9a-f]{32}$/.test(s))
    throw new Error('randomSecret doit rendre 32 caractères hexadécimaux minuscules — 128 bits.');
  return s;
}

// ---------- ce qu'on rend au client ----------
// Le pilote Postgres rend les `bigint` — et donc tout ce que `count()` et `sum()` produisent — sous
// forme de CHAÎNE. Ce qui traverse le réseau doit être un nombre.
const nombre = v => (Number(v) || 0);
// Liste blanche explicite. Un `select *` renvoyé tel quel finit toujours par exposer une colonne
// ajoutée plus tard sans y penser.
const moi = (u, s) => ({
  id: String(u.id),
  name: u.name,
  avatar: u.avatar,
  country: u.country || null,
  email: u.email,
  createdAt: u.created_at,
  // Les statistiques sont un AGRÉGAT sur les parties réglées, jamais des compteurs : il n'existe
  // aucune case à incrémenter, donc aucune à écraser ni à réparer. `best` reste en CENTIMES
  // entiers jusqu'au bout du réseau ; il ne redevient des dollars qu'une fois, dans
  // `applyAccount`, côté jeu. Convertir ici ferait un second point de conversion, et c'est
  // exactement ce que la couche monétaire existe pour empêcher.
  //
  // `Number` une seconde fois, comme pour les graines et pour la même raison : `count()` et
  // `sum()` rendent un `bigint`, que le pilote Postgres livre en CHAÎNE. Une statistique partie en
  // texte ne se voit qu'à l'écran, longtemps après, et deux lignes coûtent moins qu'une panne
  // silencieuse.
  // `divergences` EST UN AGRÉGAT, PAS UN AVERTISSEMENT. Les quatre premiers chiffres ne comptent
  // que les parties dont le rejeu a CONVERGÉ — c'est la garantie écrite dont la phase 03 a besoin,
  // et un filtre dont personne ne connaît le rendement serait pire que pas de filtre. Le cinquième
  // dit donc combien de parties réglées ce filtre écarte. Un chiffre, pas un pressentiment. Le
  // taux se déduit des deux : ce dépôt ne transporte pas de flottant qu'il peut éviter.
  stats: { matches: nombre(s.matches), wins: nombre(s.wins), kills: nombre(s.kills), best: nombre(s.best),
           divergences: nombre(s.divergences) },
});

// Le billet, tel qu'il part au client. Même liste blanche explicite que `moi`, et une raison de
// plus ici : la ligne porte une colonne `seed_secret` qui ne doit JAMAIS traverser le réseau. Un
// `select *` rendu tel quel la publierait le jour où quelqu'un ajoute une colonne sans y penser.
const billet = m => ({
  id: String(m.id),
  mode: m.mode,
  stakeCents: m.stake_cents,
  seats: m.seats,
  teamSize: m.team_size,
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

// Le règlement, tel qu'il part au client. Même liste blanche, et une raison de plus : cette
// réponse est RELUE depuis la ligne, jamais reconstruite depuis le verdict. C'est ce qui fait que
// le même billet réglé deux fois rend exactement la même réponse — le second appel ne recalcule
// rien, il relit ce que le premier a écrit.
const ouNul = v => (v === undefined ? null : v);
const reglement = m => ({
  matchId: String(m.id),
  status: m.status,
  issue: ouNul(m.issue),
  // CE QUE LE REJEU A COÛTÉ ET CE QU'IL A TROUVÉ. On le dit au client pour la même raison qu'on
  // lui dit le motif d'un refus : une divergence qu'il ne peut pas voir est un bug qu'on ne saura
  // jamais reproduire. Aucun de ces quatre nombres ne décide d'un montant — `digestMatch` décide
  // seulement de ce que la phase 03 aura le droit de lire.
  traceSteps: ouNul(m.trace_steps),
  digestMatch: m.digest_match === undefined ? null : m.digest_match,
  divergenceStep: ouNul(m.divergence_step),
  replayMs: ouNul(m.replay_ms),
  // Le motif d'un refus, et le contrôle d'ENVELOPPE qui l'a prononcé. On le dit au client : une
  // partie refusée sans explication est un bug qu'on ne saura jamais reproduire.
  controle: ouNul(m.controle),
  motif: ouNul(m.motif),
  grossCents: ouNul(m.gross_cents),
  feeCents: ouNul(m.fee_cents),
  netCents: ouNul(m.net_cents),
  purseCents: ouNul(m.purse_cents),
  declaredNetCents: ouNul(m.declared_net_cents),
  ecartCents: ouNul(m.ecart_cents),
  settledAt: ouNul(m.settled_at),
});

function createApp({
  db, verifyToken, origins = [], limiter = makeLimiter(),
  // La source de hasard est injectée comme la base et la vérification du jeton : c'est ce qui rend
  // les graines observables dans les tests. Par défaut, le générateur du système — une graine tirée
  // sur `Math.random` serait devinable, et l'une des deux ne doit jamais l'être.
  randomSeed = () => crypto.randomInt(0, 2 ** 32),
  // La graine secrète a sa propre source depuis qu'elle fait 128 bits : elle ne vit plus dans le
  // domaine de `makeRng`, donc elle ne peut plus sortir du même robinet sans mentir sur ce qu'elle
  // vaut. Par défaut, le générateur du système.
  randomSecret = () => crypto.randomBytes(16).toString('hex'),
  // L'horloge aussi : l'expiration d'un billet se teste en avançant le temps, pas en attendant.
  now = Date.now,
  // ET UNE SECONDE HORLOGE, qui n'est pas la même chose. `now` donne une DATE — elle décide si un
  // billet a expiré, et les tests la figent. `chrono` mesure une DURÉE, celle du rejeu, et c'est
  // elle que `REPLAY_BUDGET_MS` borne. Les confondre rendait le budget intestable : une horloge
  // figée à midi ne dépasse jamais deux secondes, et une horloge qui avance ferait expirer des
  // billets à chaque pas de simulation. Deux rôles, deux robinets.
  chrono = Date.now,
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

  // La borne du corps est un ARGUMENT, et sa valeur par défaut reste `MAX_BODY`. C'est ce qui permet
  // à la route de trace d'en avoir une plus large sans que celle du règlement bouge d'un octet : une
  // borne relevée « pour tout le monde » aurait été relevée pour la route de l'argent aussi.
  function lireCorps(req, max) {
    const borne = max || MAX_BODY;
    return new Promise((resolve, reject) => {
      let taille = 0; const morceaux = [];
      req.on('data', d => {
        taille += d.length;
        if (taille > borne) { reject(new Error('corps trop long')); req.destroy(); return; }
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
    const seedSecret = graine128(randomSecret);

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
      teamSize: champs.teamSize,
      brawler: champs.brawler,
      seedPublic, seedSecret,
      // FIGÉE ICI, ET NULLE PART AILLEURS. Le client n'a aucun moyen de l'écrire : elle est lue sur
      // le bloc de simulation que le serveur a chargé au démarrage. Un correctif déployé pendant
      // qu'un joueur joue rejouerait une AUTRE partie que la sienne et paierait autre chose que ce
      // qu'il a vu — exactement la raison pour laquelle `seats` et `teamSize` sont déjà figés.
      simVersion: S.SIM_VERSION,
      clientKey: champs.clientKey,
      openedAt, expiresAt,
    });
    // 200 et jamais 201, y compris à la création : un code différent selon que le billet vient
    // d'être créé ou qu'il existait déjà rendrait le rejeu distinguable du premier appel, ce qui
    // est précisément ce que l'idempotence promet d'effacer.
    return envoyer(res, 200, billet(match), origin);
  }

  // ---------- POST /api/match/:id/trace ----------
  // La trace des entrées du joueur, en segments, EN INSERTION SEULE. Cette route ne décide d'aucun
  // montant et n'écrit jamais dans `matches` : c'est le module suivant qui rejouera, et c'est
  // délibérément séparé pour que le risque reste là-bas.
  //
  // TROIS PROMESSES, ET CHACUNE A SON TEST. (1) Elle ne sort jamais en 500 : trop gros, malformé,
  // hors bornes, billet inconnu ou déjà réglé, version différente — chacun est un code NOMMÉ, en
  // 400 ou 409. (2) Elle ne laisse jamais la ligne `matches` bloquée, et c'est structurel : elle ne
  // l'écrit pas. C'est la leçon du `22003`, où un joueur restait enfermé dans un billet mort
  // jusqu'à l'expiration puisqu'il n'en a qu'un à la fois. (3) Elle est idempotente, et c'est la
  // BASE qui l'arbitre : `(match_id, seq)` unique, `on conflict do nothing`, premier écrit gagne.
  async function recevoirTrace(req, res, identite, origin, matchId) {
    if (!limiter('trace:' + identite.authId))
      return envoyer(res, 429, { erreur: 'Trop de traces envoyées d\'affilée. Réessaie dans une minute.' }, origin);

    // La borne LARGE, sur cette route et sur elle seule. `MAX_BODY` ne bouge pas ailleurs.
    let corps;
    try { corps = await lireCorps(req, MAX_TRACE_BODY); }
    catch { return envoyer(res, 400, { erreur: 'Trace illisible ou trop longue.', code: 'corps' }, origin); }
    if (!corps || typeof corps !== 'object' || Array.isArray(corps))
      return envoyer(res, 400, { erreur: 'Trace illisible.', code: 'corps' }, origin);

    const { user } = await db.findOrCreate({
      authId: identite.authId,
      email: identite.email || '',
      name: C.nameOr(identite.name, C.NAME.fallback),
      nameKey: C.nameKey,
    });

    // `user_id` fait partie de la recherche, comme pour le résultat : un identifiant deviné ne doit
    // rien apprendre sur la partie de quelqu'un d'autre, pas même qu'elle existe.
    const ligne = await db.findMatch({ matchId, userId: user.id });
    if (!ligne) return envoyer(res, 404, { erreur: 'Billet introuvable.', code: 'billet' }, origin);
    // Une trace n'a de sens que sur un billet qu'on est encore en train de jouer. Réglé, refusé ou
    // périmé, la partie a déjà son verdict et une trace n'y changerait rien : on refuse, on n'écrit
    // pas, et surtout on ne touche pas à la ligne.
    if (ligne.status !== 'open')
      return envoyer(res, 409, { erreur: 'Ce billet est déjà clos.', code: 'billet_clos' }, origin);
    // `new Date(...)` et pas `Date.parse(...)` : le pilote rend un objet `Date`, la doublure aussi,
    // et `Date.parse` d'un objet passe par sa représentation textuelle — qui perd les millisecondes.
    if (new Date(ligne.expires_at).getTime() <= now())
      return envoyer(res, 409, { erreur: 'Ce billet a expiré.', code: 'expire' }, origin);

    // La version du bloc de simulation. Elle est figée sur le billet à son ouverture ; une trace
    // produite sous une autre version décrit une AUTRE partie que celle que le serveur saurait
    // rejouer, et la stocker ne ferait que remplir la table de pièces illisibles.
    if (corps.simVersion !== ligne.sim_version)
      return envoyer(res, 409, {
        erreur: `Cette trace a été produite par une autre version de la simulation (${corps.simVersion}) que celle du billet (${ligne.sim_version}).`,
        code: 'sim_version',
      }, origin);

    const seq = corps.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq >= C.TRACE.MAX_SEG)
      return envoyer(res, 400, { erreur: `« seq » doit être un entier de 0 à ${C.TRACE.MAX_SEG - 1}.`, code: 'seq' }, origin);

    // LE NOMBRE DE PAS EST COMPTÉ, JAMAIS DÉCLARÉ. On relit la grammaire — la même que celle du
    // rejeu, lue une seule fois dans le dépôt — ce qui valide le segment et en donne la longueur
    // du même coup. Un nombre annoncé aurait été un nombre de plus à ne pas croire.
    const maxPas = C.traceMaxSteps(C.zonePlan(ligne.seed_public, C.MODES[ligne.mode]));
    const lu = C.traceDecode(corps.data, maxPas, true);
    if (lu.erreur === 'trop_de_pas')
      return envoyer(res, 400, { erreur: `Cette trace dépasse à elle seule les ${maxPas} pas qu'une partie de ce mode peut durer.`, code: 'trop_de_pas' }, origin);
    // UN SEGMENT SANS PAS N'EST PAS UN SEGMENT VIDE. Le découpage coupe au JETON, et un jeton
    // d'action ponctuelle — abandon, encaissement — ne compte aucun pas : quand la frontière des
    // 24 000 caractères tombe juste avant le dernier geste, le segment de queue ne porte que lui.
    // Le refuser sur `!lu.pas` coupait l'envoi juste avant la fin de la partie, et le règlement
    // sortait alors en `non_terminal` sans écrire un centime, sur une partie honnête. Ce qui reste
    // refusé, c'est le segment sans contenu du tout.
    if (lu.erreur || typeof corps.data !== 'string' || !corps.data.length)
      return envoyer(res, 400, { erreur: 'Trace malformée.', code: 'donnees', detail: lu.erreur || 'vide' }, origin);

    const r = await db.addTrace({
      matchId, seq, simVersion: ligne.sim_version, steps: lu.pas, data: corps.data, maxSteps: maxPas,
    });
    if (r.refuse === 'trop_de_pas')
      return envoyer(res, 400, { erreur: `Cette partie a déjà rendu ${nombre(r.totalSteps)} pas sur les ${maxPas} qu'elle peut durer.`, code: 'trop_de_pas' }, origin);
    // Le premier écrit gagne, mais il le dit. Sans ce refus, le segment 0 d'une tentative et les
    // segments suivants d'une autre se recollaient en une partie que personne n'a jouée.
    if (r.refuse === 'divergente')
      return envoyer(res, 409, { erreur: `Le segment ${seq} de cette partie a déjà été reçu, et il ne portait pas les mêmes données. Une trace ne se réécrit pas.`, code: 'trace_divergente' }, origin);

    // La réponse ne dit PAS si la ligne a été écrite ou si elle existait déjà : elle rend l'état de
    // la trace. Un rejeu à l'identique rend donc exactement la même réponse, comme pour le billet —
    // un rejeu distinguable du premier appel n'est pas un rejeu.
    return envoyer(res, 200, {
      matchId: String(ligne.id), seq,
      segments: nombre(r.segments), totalSteps: nombre(r.totalSteps),
    }, origin);
  }

  // ---------- LE REJEU : le serveur refait la partie, il ne croit plus aucun fait déclaré ----------
  // C'est le seul aveu de la 02a que cette phase existe pour lever : « le net vaut
  // `cashoutCents(sacoche)` dans les cinq modes, et la sacoche est précisément le nombre que le
  // serveur ne sait pas refaire ». Il sait, désormais : la graine publique du billet lui donne la
  // carte, le gaz, les caisses et les vingt bots ; la trace lui donne ce que le joueur a fait ; et
  // le bloc `WBSim` — le MÊME que le navigateur exécute, chargé depuis `index.html` — lui donne
  // les règles. Il n'y a rien d'autre dans une partie.
  //
  // Ce que cette fonction rend : soit un refus NOMMÉ, et alors aucun montant n'est écrit nulle
  // part, soit les faits recalculés, que `matchVerdict` jugera ensuite. Elle ne lance jamais.
  function rejouerPartie(ligne, segments, rapport) {
    const debut = chrono();
    // Entier et borné par la CAPACITÉ de sa colonne, pas par ce qu'on croit d'une horloge : ce
    // nombre part dans un `integer`, et une horloge détraquée ne doit pas faire lever `22003` sur
    // la route qui décide d'un montant. C'est la leçon de la 02a, appliquée d'avance.
    const ecoule = () => Math.max(0, Math.min(C.PG_INT4_MAX, Math.round(chrono() - debut)));
    const refus = (code, message, detail) => ({ code, message, detail: detail || null, replayMs: ecoule() });

    // LA VERSION D'ABORD. Une trace produite sous une autre version de la simulation décrit une
    // AUTRE partie que celle que ce serveur saurait refaire : la juger paierait autre chose que ce
    // que le joueur a vu. La colonne est figée à l'ouverture du billet, précisément pour que ce
    // contrôle-là soit possible après un redéploiement.
    if (ligne.sim_version !== S.SIM_VERSION)
      return refus('sim_version', `Ce billet a été ouvert sous la version ${ligne.sim_version} de la simulation, et ce serveur exécute la ${S.SIM_VERSION} : il rejouerait une autre partie que la vôtre.`);

    const connu = (table, cle) => (typeof cle === 'string' && Object.prototype.hasOwnProperty.call(table, cle));
    const mode = connu(C.MODES, ligne.mode) ? C.MODES[ligne.mode] : null;
    const brawler = connu(C.BRAWLERS, ligne.brawler) ? C.BRAWLERS[ligne.brawler] : null;
    if (!mode || !brawler)
      return refus('billet', 'Ce billet désigne un mode ou un brawler que le jeu ne connaît plus : sa partie n\'est plus rejouable.');

    // LA TRACE ABSENTE N'EST PAS UNE PARTIE PERDUE, C'EST UNE PARTIE QU'ON NE PEUT PAS JUGER. Sans
    // elle le serveur n'écrit aucun montant, et surtout il n'en invente pas un depuis le rapport.
    if (!segments.length)
      return refus('trace_absente', 'Aucune trace n\'est arrivée pour cette partie : sans la pièce qui la prouve, le serveur n\'écrit aucun montant.');
    // Les rangs doivent former 0…n−1 sans trou : un segment manquant recollerait deux morceaux qui
    // ne se suivent pas, et le rejeu partirait dans une partie qui n'a jamais eu lieu — en silence.
    const tries = segments.slice().sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < tries.length; i++)
      if (tries[i].seq !== i)
        return refus('donnees', `Il manque le segment ${i} de la trace : les morceaux reçus ne se recollent pas.`, 'segments');

    const maxPas = C.traceMaxSteps(C.zonePlan(ligne.seed_public, mode));
    const lu = C.traceDecode(tries.map(t => t.data).join(''), maxPas);
    if (lu.erreur === 'trop_de_pas')
      return refus('trop_de_pas', `Cette trace dépasse les ${maxPas} pas qu'une partie de ce mode peut durer.`);
    if (lu.erreur || !lu.pas)
      return refus('donnees', 'Trace illisible : le serveur ne sait pas ce qu\'elle décrit.', lu.erreur || 'vide');

    // LA PARTIE, REFAITE. Le nom du joueur n'entre pas : il ne décide de rien dans la simulation,
    // et le faire entrer donnerait au client une prise de plus sur le rejeu pour rien.
    const G = S.newMatch(ligne.seed_public, mode, ligne.stake_cents, brawler);
    const trop = () => ecoule() > REPLAY_BUDGET_MS;
    const abandon = () => refus('budget', `Le rejeu de cette partie a dépassé les ${REPLAY_BUDGET_MS} ms accordées : le serveur ne peut pas la juger.`);
    let pas = 0;
    // LE REJEU S'ARRÊTE À LA FIN, exactement où le jeu s'arrête. `endMatch` coupe la boucle du
    // navigateur sur l'événement de fin ; un serveur qui continuerait à simuler au-delà jugerait
    // une partie que personne n'a jouée — et pire, un joueur qui encaisse puis rallonge sa trace
    // verrait sa sacoche continuer de grossir APRÈS l'encaissement. La condition se lit en tête de
    // boucle et pas seulement après un pas : une fin peut arriver d'une action ponctuelle.
    for (const it of lu.items) {
      if (G.fin) break;
      // Le budget se lit à chaque pas ET à chaque action. Neuf mille lectures d'horloge ne coûtent
      // rien à côté de neuf mille pas de simulation, et c'est ce qui rend le dépassement exact sous
      // une horloge injectée plutôt qu'approché à deux cent cinquante-six pas près. Les actions
      // comptent aussi : leur nombre n'est borné que par la taille du corps, pas par le nombre de
      // pas, donc une trace d'actions pures échapperait à une borne posée sur les seuls pas.
      if (trop()) return abandon();
      if (it.t === 'a') { S.appliquerActe(G, it); continue; }
      for (let k = (it.n | 0); k > 0; k--) {
        S.step(G, it);
        pas++;
        if (G.fin) break;
        if (trop()) return abandon();
      }
    }

    // L'ÉTAT TERMINAL EST OBLIGATOIRE, ET C'EST LA RÈGLE QUI TIENT L'ARGENT. Sans elle, couper le
    // réseau juste après un gros kill deviendrait la meilleure stratégie du jeu le jour où un euro
    // entre : la partie resterait à jamais dans son meilleur instant. Le serveur nomme donc ce qui
    // lui manque, n'écrit aucun montant, et laisse le billet au veilleur.
    if (!S.terminal(G))
      return refus('non_terminal', `Cette trace s'arrête au pas ${pas} sans que la partie soit finie : ni vainqueur, ni encaissement, ni élimination, ni fin du plan de zone. Aucun montant n'est écrit.`);

    // LA CONSERVATION DE L'ARGENT, ASSERTÉE AU MOMENT DU RÈGLEMENT ET SUR LA PARTIE RÉELLEMENT
    // REJOUÉE : sacoches + butin au sol + encaissé = mise × sièges. Elle ne coûte rien ici, et
    // c'est elle qui fonde `purseBound`, donc le seul plafond de paiement qui existe. Si elle est
    // fausse, ce n'est pas le joueur qui triche, c'est le serveur qui se trompe — et un serveur qui
    // se trompe n'écrit surtout pas de montant.
    const attendu = ligne.stake_cents * ligne.seats;
    const enJeu = S.argentCents(G);
    if (enJeu !== attendu)
      return refus('conservation', `La partie rejouée porte ${enJeu} centimes pour ${attendu} engagés : le serveur refuse d'écrire un montant sur une partie où l'argent ne se conserve pas.`);

    // LA DIVERGENCE SE MESURE, ELLE NE SE PUNIT PAS. `Math.sin`, `Math.cos` et `Math.exp` ne sont
    // pas spécifiées à l'ulp près par ECMAScript : un désaccord entre le rejeu du serveur et
    // l'empreinte du client peut ne prouver qu'une chose, que les deux n'ont pas la même
    // bibliothèque mathématique. Refuser ce joueur serait le QUATRIÈME contrôle « évident » et faux
    // de ce dossier. La ligne est donc réglée, marquée, et c'est la phase 03 qui n'ira pas la lire.
    const siens = C.digestsDecode(rapport.digests);
    const rang = siens ? C.digestsDiff(G.empreintes, siens) : 0;
    const digestMatch = siens !== null && rang === -1;
    return {
      code: null,
      // Les faits, et EUX SEULS, sont donnés au verdict. `declaredNetCents` reste ce que le client
      // croit avoir gagné : une observation, jamais un paiement.
      faits: C.reportFrom({ ...S.faits(G), declaredNetCents: rapport.declaredNetCents, digests: rapport.digests }),
      traceSteps: pas,
      replayDigest: S.empreinte(G),
      digestMatch,
      // Le premier pas où les deux empreintes s'écartent, au pas d'empreinte près — le condensé se
      // prend tous les `EMPREINTE_PAS` pas simulés, pas à chaque pas. Zéro veut dire « aucun
      // condensé comparable » : un client qui n'en envoie pas ne prouve aucune convergence.
      divergenceStep: digestMatch ? null : (siens === null ? 0 : (rang + 1) * S.EMPREINTE_PAS),
      replayMs: ecoule(),
    };
  }

  // ---------- POST /api/match/:id/result ----------
  // LE SERVEUR REJOUE LA PARTIE, PUIS IL LA JUGE, ET IL CLÔT LA LIGNE. La forme de la route n'a pas
  // changé d'une virgule depuis la 02a — c'était la promesse écrite là-bas : « on remplace le corps
  // de `matchVerdict` par une vraie simulation sans changer une seule route ». Ce qui a changé est
  // ce qu'elle fait de ce qu'on lui envoie : les faits sont RECALCULÉS, plus jamais lus.
  //
  // Quatre choses ne changent pas :
  // — `checkReport` passe avant tout, et refuse tout champ inconnu avec un code ;
  // — `matchVerdict` reçoit une horloge INJECTÉE, jamais `Date.now()`, et elle reste ;
  // — aucun montant ne sort d'ailleurs que des fonctions de paiement de WBCore. L'API ne
  //   recalcule jamais la commission elle-même, pas même « juste pour vérifier » ;
  // — `MAX_BODY` reste à 4 Ko : la trace arrive par la route du module 6, jamais dans ce corps.
  async function rendreResultat(req, res, identite, origin, matchId) {
    if (!limiter('result:' + identite.authId))
      return envoyer(res, 429, { erreur: 'Trop de résultats envoyés d\'affilée. Réessaie dans une minute.' }, origin);

    let corps;
    try { corps = await lireCorps(req); }
    catch { return envoyer(res, 400, { erreur: 'Requête illisible.' }, origin); }

    // Le rapport est le corps, sans enveloppe : un champ de plus est un refus, pas un silence.
    const { rapport, erreurs } = C.checkReport(corps);
    if (erreurs.length)
      return envoyer(res, 400, { erreur: erreurs[0].message, erreurs }, origin);

    const { user } = await db.findOrCreate({
      authId: identite.authId,
      email: identite.email || '',
      name: C.nameOr(identite.name, C.NAME.fallback),
      nameKey: C.nameKey,
    });

    // `user_id` fait partie de la recherche, il n'est pas vérifié après coup : un identifiant
    // deviné ne doit rien apprendre sur la partie de quelqu'un d'autre, pas même qu'elle existe.
    const ligne = await db.findMatch({ matchId, userId: user.id });
    if (!ligne) return envoyer(res, 404, { erreur: 'Billet introuvable.' }, origin);
    // Déjà close : on rend le PREMIER verdict, tel qu'il a été écrit, sans rien recalculer ni
    // réécrire. C'est la clé d'idempotence sur (match_id).
    if (ligne.status !== 'open') return envoyer(res, 200, reglement(ligne), origin);

    const dossier = {
      mode: ligne.mode,
      stakeCents: ligne.stake_cents,
      seats: ligne.seats,
      teamSize: ligne.team_size,
      seed: ligne.seed_public,
      openedAt: ligne.opened_at,
      expiresAt: ligne.expires_at,
    };

    // UN BILLET PÉRIMÉ SE CLÔT SANS REJOUER. Ce n'est pas une économie de calcul, c'est la
    // 02a inchangée : la partie qu'il désigne ne se règle plus, quoi qu'ait fait le joueur, et
    // rejouer coûterait deux secondes de fil pour arriver au même refus. Les faits envoyés au
    // verdict sont MIS À ZÉRO plutôt que recopiés du corps : même sur un refus, aucun fait déclaré
    // n'entre en base.
    const expireMs = new Date(ligne.expires_at).getTime();
    if (Number.isFinite(expireMs) && now() > expireMs) {
      const vide = C.reportFrom({ seconds: 0, kills: 0, deaths: 0, rank: 1, cubes: 0, damage: 0,
                                  cashedOut: false, purseCents: 0,
                                  declaredNetCents: rapport.declaredNetCents, digests: rapport.digests });
      const p = C.matchVerdict(dossier, vide, now());
      const { match } = await db.settleMatch({
        matchId, userId: user.id,
        status: p.statut, settledAt: new Date(now()),
        issue: p.issue, controle: p.controle, motif: p.motif,
        grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents,
        purseCents: p.sacocheCents, declaredNetCents: p.declaredNetCents, ecartCents: p.ecartCents,
        seconds: vide.seconds, kills: vide.kills, deaths: vide.deaths,
        rank: vide.rank, cubes: vide.cubes, damage: vide.damage, cashedOut: vide.cashedOut,
        traceSteps: null, replayDigest: null, digestMatch: null, divergenceStep: null, replayMs: null,
      });
      if (!match) return envoyer(res, 404, { erreur: 'Billet introuvable.' }, origin);
      return envoyer(res, 200, reglement(match), origin);
    }

    // LE BILLET EST MARQUÉ JOUÉ AVANT MÊME D'ÊTRE JUGÉ, et c'est délibéré. Toute la partie est
    // une fonction pure de `seed_public` : si un billet dont le résultat vient d'être refusé
    // repartait à une seconde partie, le joueur rejouerait le monde qu'il vient d'explorer — mêmes
    // caisses, mêmes bots, même gaz — et pourrait répéter la partie payante jusqu'à faire régler sa
    // meilleure tentative. Bloquer l'envoi de la trace suffisait à déclencher exactement ça.
    // La marque ne ferme rien ici : la ligne reste ouverte, la trace peut encore arriver et le
    // résultat être renvoyé sur le MÊME `match_id` — elle ne se pose qu'une fois, donc un renvoi ne
    // modifie pas la ligne. Ce qu'elle interdit, c'est un second monde identique : `createMatch`
    // clôt alors le billet sans montant et en ouvre un neuf, avec une graine neuve.
    await db.markPlayed({ matchId, userId: user.id, at: new Date(now()) });

    // LE REJEU DÉCIDE. Tout ce que le corps annonçait — durée, kills, morts, rang, cubes, dégâts,
    // sacoche — est jeté et refait depuis la graine publique du billet et la trace lue en base.
    // Seul `declaredNetCents` survit au rapport, et seulement pour être comparé.
    const rj = rejouerPartie(ligne, await db.listTraces({ matchId }), rapport);
    if (rj.code) {
      // AUCUN MONTANT, AUCUNE ÉCRITURE, ET LA LIGNE RESTE OUVERTE POUR LE VEILLEUR. C'est le seul
      // endroit du dossier qui refuse sans clore, et c'est délibéré : clore ici ferait un second
      // endroit qui ferme une ligne, et un joueur dont la trace s'est perdue en route mérite de
      // pouvoir la renvoyer tant que son billet vit.
      return envoyer(res, REJEU_CODES[rj.code] || 409,
        { erreur: rj.message, code: rj.code, detail: rj.detail, replayMs: rj.replayMs }, origin);
    }
    const faits = rj.faits;

    const v = C.matchVerdict(dossier, faits, now());

    // Un refus clôt la ligne lui aussi, avec son motif : cette partie-là ne comptera dans aucune
    // statistique, et on veut pouvoir dire pourquoi sans relancer le calcul six mois plus tard.
    //
    // `matchVerdict` NE DISPARAÎT PAS AVEC LE REJEU, et c'est le point. Elle reçoit désormais des
    // faits RECALCULÉS au lieu de faits déclarés, et elle reste pour la raison exacte qui la rendait
    // insuffisante hier : si le rejeu se trompe, plus rien ne regarderait le montant avant de
    // l'écrire. L'enveloppe cesse d'être la seule protection, elle devient la seconde.
    const { match } = await db.settleMatch({
      matchId, userId: user.id,
      status: v.statut, settledAt: new Date(now()),
      issue: v.issue, controle: v.controle, motif: v.motif,
      grossCents: v.grossCents, feeCents: v.feeCents, netCents: v.netCents,
      purseCents: v.sacocheCents, declaredNetCents: v.declaredNetCents, ecartCents: v.ecartCents,
      // Les faits de la partie REJOUÉE. Plus rien ici ne vient du corps de la requête : un corps
      // gonflé écrit exactement la même ligne qu'un corps sincère.
      seconds: faits.seconds, kills: faits.kills, deaths: faits.deaths,
      rank: faits.rank, cubes: faits.cubes, damage: faits.damage,
      cashedOut: faits.cashedOut,
      // Ce que le rejeu a coûté et ce qu'il a trouvé.
      traceSteps: rj.traceSteps, replayDigest: rj.replayDigest,
      digestMatch: rj.digestMatch, divergenceStep: rj.divergenceStep, replayMs: rj.replayMs,
    });
    if (!match) return envoyer(res, 404, { erreur: 'Billet introuvable.' }, origin);
    return envoyer(res, 200, reglement(match), origin);
  }

  // ---------- le veilleur ----------
  // Les billets que personne ne termine — onglet fermé, navigateur tué, joueur parti — restent
  // ouverts pour toujours, et un joueur n'a qu'un billet ouvert à la fois : sans ce balayage, une
  // partie abandonnée enferme son joueur jusqu'à ce qu'il retente après l'expiration, et la table
  // garde des lignes que rien ne clôt. C'est du code qui manipulera de l'argent et que personne ne
  // regarde tourner : il prend son heure en argument, comme tout le reste, et se teste sans
  // attendre. Il n'écrit AUCUN montant — il ne fait que fermer une porte.
  async function veiller() {
    const { closes } = await db.expireMatches({ avant: new Date(now()) });
    return { closes };
  }

  const handler = async function handler(req, res) {
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

    const resultat = RESULTAT.exec(route);
    const trace = TRACE.exec(route);
    const methodes = resultat ? RESULTAT_METHODES : trace ? TRACE_METHODES : METHODES.get(route);
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
      // ---------- le billet d'une partie, puis son verdict ----------
      if (route === '/api/match') return await ouvrirBillet(req, res, identite, origin);
      if (trace) return await recevoirTrace(req, res, identite, origin, trace[1]);
      if (resultat) return await rendreResultat(req, res, identite, origin, resultat[1]);

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

  // Le veilleur voyage avec le routeur, comme `onError` : il partage son horloge et sa base, et
  // celui qui écoute décide quand l'appeler. Le brancher ici plutôt que dans `main.js` évite qu'il
  // existe deux idées de l'heure dans le même processus.
  handler.veiller = veiller;
  return handler;
}

module.exports = { createApp, checkProfile, checkMatch, makeLimiter, AVATARS, MAX_BODY,
                   MAX_TRACE_BODY, MATCH_MARGE_S, REPLAY_BUDGET_MS, REJEU_CODES, RESULTAT, TRACE };
