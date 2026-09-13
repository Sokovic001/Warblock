// Lancer : node api/test.js — aucune dépendance, aucune base, aucun compte.
// La base et la vérification du jeton sont remplacées par des doublures, ce qui laisse le routeur
// entièrement couvert : authentification, validation, unicité du pseudo, limitation de débit, CORS.
'use strict';
const assert = require('assert');
const crypto = require('node:crypto');
const { createApp, checkProfile, checkMatch, makeLimiter, MATCH_MARGE_S } = require('./app');
const { parseApiKey, base58Encode, base58Decode, jwksUri } = require('./crossmint-key');
const { identityFromClaims } = require('./auth-crossmint');
const C = require('./core');
// Le bloc de simulation du jeu, chargé par le serveur depuis index.html. Il est requis ICI, en tête
// de fichier, parce que depuis le module 7 les tests de la route de résultat doivent JOUER de
// vraies parties : le serveur ne croit plus aucun fait déclaré, donc un rapport écrit à la main ne
// prouve plus rien de ce qu'il prétendait prouver.
const SIM = require('./sim');

let passed = 0;
function test(nom, fn) {
  const fini = () => { passed++; console.log('  ✓', nom); };
  const rate = e => { console.log('  ✗', nom, '\n    ', e && e.message || e); process.exitCode = 1; };
  // L'appel est dans le try : un test synchrone qui échoue doit être signalé comme les autres, pas
  // faire tomber tout le harnais avant d'avoir lancé les suivants.
  let r;
  try { r = fn(); } catch (e) { rate(e); return; }
  return (r && typeof r.then === 'function') ? r.then(fini, rate) : fini();
}

// ---------- doublures ----------
// Les colonnes `integer` de `matches`, et la largeur qu'elles ont vraiment. La doublure était un
// tableau JS sans types : elle avalait n'importe quelle magnitude, si bien qu'aucun test ne pouvait
// voir un rapport qui fait déborder Postgres — lequel lève `22003`, rend un 500 et laisse la ligne
// `open`, enfermant le joueur dans un billet mort. Elle refuse maintenant ce que la base refuserait.
const PG_INT4_MAX = 2147483647, PG_INT4_MIN = -2147483648;
const COLONNES_INT4 = ['stake_cents', 'seats', 'team_size', 'gross_cents', 'fee_cents', 'net_cents',
                       'purse_cents', 'declared_net_cents', 'ecart_cents',
                       'seconds', 'kills', 'deaths', 'rank', 'cubes', 'damage',
                       'sim_version', 'seq', 'steps',
                       // Phase 02b. `replay_digest` n'est PAS ici : c'est un `bigint`, comme la
                       // graine publique et pour la même raison — un entier 32 bits non signé ne
                       // tient pas dans l'`integer` signé de Postgres.
                       'trace_steps', 'divergence_step', 'replay_ms'];
// Les colonnes de TEXTE et la largeur que le schéma leur donne. Une colonne `text` sans contrainte
// avale n'importe quoi, mais celles-ci en portent une — `seed_secret` doit être 128 bits en
// hexadécimal, `data` tient sous la borne du corps — et la doublure doit refuser ce que la base
// refuserait, sinon aucun test ne peut voir la panne.
const COLONNES_TEXTE = {
  seed_secret: v => /^[0-9a-f]{32}$/.test(v),
  data: v => typeof v === 'string' && v.length >= 1 && v.length <= 65536,
};
function verifierColonnes(valeurs) {
  for (const c of COLONNES_INT4) {
    const v = valeurs[c];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v > PG_INT4_MAX || v < PG_INT4_MIN) {
      const e = new Error(`value "${v}" is out of range for type integer`);
      e.code = '22003';
      throw e;
    }
  }
  for (const [c, ok] of Object.entries(COLONNES_TEXTE)) {
    const v = valeurs[c];
    if (v === undefined || v === null) continue;
    if (!ok(v)) {
      const e = new Error(`new row for relation violates check constraint on ${c}`);
      e.code = '23514';
      throw e;
    }
  }
}
function fakeDb(seed = []) {
  const users = seed.map(u => ({ ...u }));
  const matches = [];
  // `match_traces`, EN INSERTION SEULE : la doublure n'expose aucun moyen de modifier ni de
  // supprimer une ligne, exactement comme db-pg.js n'écrit aucun `update` ni `delete` sur elle.
  const traces = [];
  let next = users.length + 1, nextMatch = 1;
  // Les statistiques sont la SOMME des parties réglées, exactement comme l'agrégat SQL de
  // db-pg.js. Aucun compteur n'existe nulle part : il n'y a rien à incrémenter, donc rien qu'un
  // double envoi puisse fausser. Une partie refusée, périmée ou encore ouverte ne compte pour
  // rien, et `wins` retient la victoire comme l'encaissement — le jeu compte les deux.
  //
  // Depuis la phase 02b, les quatre premiers chiffres ne comptent que les parties dont le REJEU A
  // CONVERGÉ, exactement comme le `filter (where digest_match)` de db-pg.js : le grand livre de la
  // phase 03 ne lira jamais que celles-là. Le cinquième dit combien ce filtre en écarte.
  const statsOf = id => {
    const reglees = matches.filter(m => m.user_id === id && m.status === 'settled');
    const convergees = reglees.filter(m => m.digest_match === true);
    return {
      matches: convergees.length,
      wins: convergees.filter(m => m.issue === 'victoire' || m.issue === 'encaissement').length,
      kills: convergees.reduce((s, m) => s + (m.kills || 0), 0),
      best: convergees.reduce((b, m) => Math.max(b, m.net_cents || 0), 0),
      divergences: reglees.length - convergees.length,
    };
  };
  return {
    users,
    matches,
    traces,
    // La doublure imite les deux CONTRAINTES de la base, dans l'ordre exact de db-pg.js. Elle ne
    // regarde jamais si un billet existe avant de décider d'en créer un : elle rejoue ce que la
    // base répondrait à une insertion refusée. C'est aussi la limite connue de cet exercice — rien
    // ici ne prouve que Postgres se comporte comme ce code-là.
    async createMatch(m) {
      const rejeu = matches.find(x => x.user_id === m.userId && x.client_key === m.clientKey);
      if (rejeu) return { match: rejeu, repris: true };
      let ouvert = matches.find(x => x.user_id === m.userId && x.status === 'open');
      if (ouvert) {
        const vivant = new Date(ouvert.expires_at) > m.openedAt;
        // UN BILLET NE SERT QU'UNE TENTATIVE. Périmé, ou déjà joué, il est clos sans montant et la
        // place se libère : le joueur reçoit un billet neuf, donc une graine neuve, donc un autre
        // monde. Sans cela, bloquer l'envoi de sa trace suffisait à se faire resservir le même.
        if (!vivant || ouvert.first_result_at) {
          ouvert.status = vivant ? 'abandoned' : 'expired';
          ouvert = null;
        }
      }
      if (ouvert) return { match: ouvert, repris: true };
      const ligne = {
        id: nextMatch++, user_id: m.userId, mode: m.mode, stake_cents: m.stakeCents, seats: m.seats,
        team_size: m.teamSize,
        brawler: m.brawler, seed_public: m.seedPublic, seed_secret: m.seedSecret,
        sim_version: m.simVersion,
        client_key: m.clientKey, status: 'open', first_result_at: null,
        opened_at: m.openedAt, expires_at: m.expiresAt,
      };
      verifierColonnes(ligne);
      matches.push(ligne);
      return { match: ligne, repris: false };
    },
    async findMatch({ matchId, userId }) {
      // `user_id` fait partie de la recherche, pas d'une vérification après coup : un identifiant
      // deviné ne doit rien apprendre sur la partie de quelqu'un d'autre.
      return matches.find(x => String(x.id) === String(matchId) && x.user_id === userId) || null;
    },
    // La marque « une partie a été jouée sur ce billet » : une écriture de STATUT, jamais de
    // montant, et sa clause imite celle du vrai pilote — `status = 'open' and first_result_at is
    // null`. Elle ne se pose donc qu'une fois, et un résultat renvoyé ne modifie pas la ligne.
    async markPlayed({ matchId, userId, at }) {
      const m = matches.find(x => String(x.id) === String(matchId) && x.user_id === userId
                                  && x.status === 'open' && !x.first_result_at);
      if (!m) return { marque: false };
      m.first_result_at = at;
      return { marque: true };
    },
    async settleMatch(r) {
      const m = matches.find(x => String(x.id) === String(r.matchId) && x.user_id === r.userId);
      if (!m) return { match: null, deja: true };
      // La doublure imite la clause `where` de db-pg.js, et rien d'autre : `status = 'open' and
      // net_cents is null`. Un second règlement ne touche donc aucune ligne, et on rend celle qui
      // a été écrite la première fois.
      if (m.status !== 'open' || (m.net_cents !== undefined && m.net_cents !== null))
        return { match: m, deja: true };
      const ecriture = {
        status: r.status, settled_at: r.settledAt, issue: r.issue, controle: r.controle, motif: r.motif,
        gross_cents: r.grossCents, fee_cents: r.feeCents, net_cents: r.netCents, purse_cents: r.purseCents,
        declared_net_cents: r.declaredNetCents, ecart_cents: r.ecartCents,
        seconds: r.seconds, kills: r.kills, deaths: r.deaths, rank: r.rank,
        cubes: r.cubes, damage: r.damage, cashed_out: r.cashedOut,
        trace_steps: r.traceSteps, replay_digest: r.replayDigest, digest_match: r.digestMatch,
        divergence_step: r.divergenceStep, replay_ms: r.replayMs,
      };
      // Vérifié AVANT d'écrire : une ligne à demi réglée par une écriture qui échoue en plein
      // milieu serait pire que la panne qu'on cherche à reproduire.
      verifierColonnes(ecriture);
      Object.assign(m, ecriture);
      return { match: m, deja: false };
    },
    // La trace. La doublure imite la clé primaire (match_id, seq) et `on conflict do nothing` : le
    // PREMIER écrit gagne, un second segment de même rang ne remplace rien, et il n'existe aucun
    // chemin qui modifie ou supprime une ligne déjà posée.
    async addTrace({ matchId, seq, simVersion, steps, data, maxSteps }) {
      const miennes = traces.filter(t => String(t.match_id) === String(matchId));
      const meme = miennes.find(t => t.seq === seq);
      const avant = miennes.reduce((s, t) => s + t.steps, 0);
      // Le premier écrit gagne, mais il le DIT : un rang déjà posé dont les données diffèrent est
      // refusé, sans quoi deux tentatives se cousent bout à bout en une partie que personne n'a
      // jouée. Un renvoi à l'identique reste parfaitement idempotent.
      if (meme && meme.data !== data)
        return { refuse: 'divergente', segments: miennes.length, totalSteps: avant };
      const deja = !!meme;
      if (!deja && avant + steps > maxSteps)
        return { refuse: 'trop_de_pas', segments: miennes.length, totalSteps: avant };
      if (!deja) {
        const ligne = { match_id: matchId, seq, sim_version: simVersion, steps, data,
                        created_at: '2026-01-01T00:00:00Z' };
        verifierColonnes(ligne);
        traces.push(ligne);
      }
      const apres = traces.filter(t => String(t.match_id) === String(matchId));
      return { segments: apres.length, totalSteps: apres.reduce((s, t) => s + t.steps, 0) };
    },
    // La trace relue pour le rejeu, dans l'ordre des rangs. Lecture seule : rien ici ne peut
    // modifier une ligne, comme db-pg.js n'écrit aucun `update` sur cette table.
    async listTraces({ matchId }) {
      return traces.filter(t => String(t.match_id) === String(matchId))
                   .slice().sort((a, b) => a.seq - b.seq)
                   .map(t => ({ seq: t.seq, sim_version: t.sim_version, steps: t.steps, data: t.data }));
    },
    async expireMatches({ avant }) {
      let closes = 0;
      for (const m of matches)
        if (m.status === 'open' && new Date(m.expires_at) <= avant) { m.status = 'expired'; closes++; }
      return { closes };
    },
    async findOrCreate({ authId, email, name, nameKey }) {
      let u = users.find(x => x.auth_id === authId);
      if (!u) {
        let base = name, cle = nameKey(base), n = 1;
        while (users.some(x => x.name_key === cle)) {
          n += 1; const s = String(n);
          base = name.slice(0, 14 - s.length) + s; cle = nameKey(base);
        }
        u = { id: next++, auth_id: authId, email, name: base, name_key: cle, avatar: '', country: null,
              created_at: '2026-01-01T00:00:00Z' };
        users.push(u);
      }
      return { user: u, stats: statsOf(u.id) };
    },
    async updateProfile(authId, champs) {
      const u = users.find(x => x.auth_id === authId);
      if (!u) return { user: null };
      if (champs.name_key && users.some(x => x !== u && x.name_key === champs.name_key)) return { conflit: true };
      Object.assign(u, champs);
      return { user: u, stats: statsOf(u.id) };
    },
  };
}

const ORIGINE = 'https://warblock.example';
function appel(app, { method = 'GET', path = '/api/me', token, body, origin = ORIGINE } = {}) {
  const req = new (require('node:stream').Readable)({ read() {} });
  req.method = method; req.url = path;
  req.headers = { origin, ...(token ? { authorization: 'Bearer ' + token } : {}) };
  if (body !== undefined) { req.push(typeof body === 'string' ? body : JSON.stringify(body)); }
  req.push(null);
  return new Promise(resolve => {
    const res = {
      writeHead(code, head) { this.code = code; this.head = head || {}; },
      end(texte) { resolve({ code: this.code, head: this.head, corps: texte ? JSON.parse(texte) : null }); },
    };
    app(req, res);
  });
}

// un vérificateur qui accepte « ok:<id> » et refuse tout le reste
const verifOk = async jeton => {
  if (!jeton.startsWith('ok:')) throw new Error('refusé');
  const [, id, nom] = jeton.split(':');
  return { authId: id, email: `${id}@exemple.test`, name: nom || 'Joueur' };
};
const appDe = (db, extra = {}) => createApp({ db, verifyToken: verifOk, origins: [ORIGINE], ...extra });

// ---------- de quoi observer le billet ----------
// Une horloge et une source de graines qui n'ont rien d'aléatoire : les deux sont injectées, donc
// tout ce que le serveur en tire est comparable à une valeur écrite dans le test. La source lance
// quand elle est épuisée, ce qui fixe au passage le nombre de tirages : deux par billet, ni plus.
const GRAINES = Array.from({ length: 40 }, (_, i) => (i + 1) * 101010101);
// La graine secrète a SA source depuis qu'elle fait 128 bits : elle n'est plus dans le domaine de
// `makeRng`, donc elle ne peut plus sortir du même robinet sans mentir sur ce qu'elle vaut. Ces
// valeurs-là n'ont rien d'aléatoire non plus : ce qu'on veut observer, c'est qu'elles ne fuient
// jamais et qu'elles viennent bien du serveur.
const SECRETS = Array.from({ length: 40 }, (_, i) => 'a' + String(i + 1).padStart(3, '0') + 'f'.repeat(28));
const T0 = Date.parse('2026-01-01T12:00:00Z');
const BRAWLER = Object.keys(C.BRAWLERS)[0];
const DEMANDE = { mode: 'solo', stake: 0.5, brawler: BRAWLER, clientKey: 'cle-1' };
// Combien de pas le compte à rebours d'intro consomme sans faire avancer `G.pas`. Il est posé par
// `WBSim.newMatch` — c'est une règle de simulation, et c'est ce qui permet au rejeu du serveur de
// le reposer sans que l'API n'en sache rien. On le MESURE plutôt que de le recopier : un test qui
// écrirait 240 cesserait de dire la vérité le jour où la valeur bouge.
const PAS_INTRO = (() => {
  const G = SIM.newMatch(1, C.MODES.solo, 50, C.BRAWLERS[BRAWLER]);
  let n = 0;
  while (G.intro > 0 && n < 10000) { SIM.step(G, {}); n++; }
  return n;
})();

function bancDeBillet(extra = {}) {
  const db = fakeDb();
  const horloge = { t: T0 };
  let tire = 0, tireSecret = 0;
  const app = appDe(db, {
    randomSeed: () => {
      if (tire >= GRAINES.length) throw new Error('la source de graines est épuisée : trop de tirages');
      return GRAINES[tire++];
    },
    randomSecret: () => {
      if (tireSecret >= SECRETS.length) throw new Error('la source de secrets est épuisée : trop de tirages');
      return SECRETS[tireSecret++];
    },
    now: () => horloge.t,
    // LE CHRONOMÈTRE DU REJEU EST FIGÉ PAR DÉFAUT, et ce n'est pas de la paresse : une durée
    // mesurée sur la vraie horloge n'est pas la même d'une exécution à l'autre, et deux lignes
    // « strictement identiques » cesseraient de l'être pour la seule raison que la machine était
    // occupée. Les deux tests qui s'intéressent VRAIMENT au temps — le budget, et le coût réel
    // d'un rejeu — se donnent leur propre horloge.
    chrono: () => 0,
    ...extra,
  });
  return { db, app, horloge, tires: () => tire, tiresSecret: () => tireSecret };
}
const demander = (app, corps = DEMANDE, opts = {}) =>
  appel(app, { method: 'POST', path: '/api/match', token: 'ok:u1:Loic', body: corps, ...opts });

// Une autorité de signature de clés d'API, fabriquée sur place. Les vraies clés publiques de
// Crossmint vivent dans crossmint-key.js et ne servent qu'à vérifier ; pour éprouver aussi le cas
// où la signature est bonne, il faut pouvoir signer, donc une paire à nous. C'est à cela — et à
// rien d'autre — que sert le paramètre `signers` de parseApiKey.
function autorite() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const brut = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const b58 = base58Encode(brut);
  return { privateKey, signers: { development: b58, staging: b58, production: b58 } };
}

// Reproduit le format exact d'une clé Crossmint : <préfixe>_base58("<projet>.<suite>:<signature>"),
// la signature portant sur « <préfixe>.<projet>.<suite> ».
function fabriqueCle(a, { prefix = 'sk_production', projectId = 'proj_warblock', suite = 'aa11bb22' } = {}) {
  const donnees = `${projectId}.${suite}`;
  const signature = crypto.sign(null, Buffer.from(`${prefix}.${donnees}`, 'utf8'), a.privateKey);
  return `${prefix}_${base58Encode(Buffer.from(`${donnees}:${base58Encode(signature)}`, 'utf8'))}`;
}

const PROJET = 'proj_warblock';
const revendications = (extra = {}) => ({
  sub: 'user_1', aud: PROJET, exp: 4102444800, iat: 1700000000, email: 'joueur@exemple.test', ...extra,
});

(async () => {
console.log('Validation du profil');
test('un pseudo trop court est refusé avec un message qui dit quoi faire', () => {
  const { erreurs } = checkProfile({ name: 'a' });
  assert.strictEqual(erreurs.length, 1);
  assert.ok(erreurs[0].includes(String(C.NAME.min)) && erreurs[0].includes(String(C.NAME.max)), erreurs[0]);
});
test('un pseudo valide ressort nettoyé, avec sa clé d\'unicité', () => {
  const { champs, erreurs } = checkProfile({ name: '  Loïc  ' });
  assert.deepStrictEqual(erreurs, []);
  assert.strictEqual(champs.name, 'Loïc');
  assert.strictEqual(champs.name_key, C.nameKey('Loïc'));
});
test('un avatar inventé est refusé, un vrai passe', () => {
  assert.ok(checkProfile({ avatar: 'bolt:pirate' }).erreurs.length);
  const vrai = C.avatarList(Object.keys(C.BRAWLERS))[0].id;
  assert.deepStrictEqual(checkProfile({ avatar: vrai }).erreurs, []);
});
test('le pays est normalisé en deux lettres majuscules', () => {
  assert.strictEqual(checkProfile({ country: 'ca' }).champs.country, 'CA');
  assert.ok(checkProfile({ country: 'Canada' }).erreurs.length);
});
test('une requête qui ne demande rien est refusée', () => {
  assert.ok(checkProfile({}).erreurs.length);
});
test('un champ inconnu est ignoré, il ne peut pas se faufiler jusqu\'à la base', () => {
  const { champs } = checkProfile({ name: 'Zoe', id: 999, email: 'pirate@x', stats: { kills: 9999 } });
  assert.deepStrictEqual(Object.keys(champs).sort(), ['name', 'name_key']);
});

console.log('Authentification');
await test('sans jeton, rien ne passe', async () => {
  const r = await appel(appDe(fakeDb()), { token: undefined });
  assert.strictEqual(r.code, 401);
});
await test('un jeton refusé donne le même message qu\'un jeton expiré', async () => {
  const a = await appel(appDe(fakeDb()), { token: 'forge' });
  const b = await appel(appDe(fakeDb()), { token: 'expire' });
  assert.strictEqual(a.code, 401);
  assert.deepStrictEqual(a.corps, b.corps, 'la réponse ne doit pas dire pourquoi');
});
await test('la première connexion crée le compte, la seconde le retrouve', async () => {
  const db = fakeDb(), app = appDe(db);
  const un = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(un.code, 200);
  assert.strictEqual(db.users.length, 1);
  const deux = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(deux.corps.id, un.corps.id);
  assert.strictEqual(db.users.length, 1, 'une seconde visite ne doit pas créer un second compte');
});
await test('deux joueurs qui arrivent avec le même pseudo obtiennent deux comptes distincts', async () => {
  const db = fakeDb(), app = appDe(db);
  const a = await appel(app, { token: 'ok:u1:Loic' });
  const b = await appel(app, { token: 'ok:u2:Loic' });
  assert.notStrictEqual(a.corps.id, b.corps.id);
  assert.notStrictEqual(a.corps.name, b.corps.name, 'le second doit recevoir un pseudo libre');
  assert.strictEqual(db.users.length, 2);
});

console.log('Ce que le client reçoit');
await test('la réponse ne contient que les champs prévus, jamais la colonne d\'identité', async () => {
  const r = await appel(appDe(fakeDb()), { token: 'ok:u1:Loic' });
  assert.deepStrictEqual(Object.keys(r.corps).sort(),
    ['avatar', 'country', 'createdAt', 'email', 'id', 'name', 'stats'].sort());
  assert.ok(!('auth_id' in r.corps) && !('name_key' in r.corps));
});
await test('les statistiques sont lues, jamais écrites par le client', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { stats: { kills: 9999 }, name: 'Zoe' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.stats.kills, 0, 'le client a tenté d\'écrire ses kills');
});

console.log('Modification du profil');
await test('changer de pseudo met à jour le nom et sa clé', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'René' } });
  assert.strictEqual(r.corps.name, 'René');
  assert.strictEqual(db.users[0].name_key, C.nameKey('Rene'));
});
await test('un pseudo déjà pris par un autre est refusé en 409', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  await appel(app, { token: 'ok:u2:Zoe' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u2:Zoe', body: { name: 'LOIC' } });
  assert.strictEqual(r.code, 409, 'les accents et la casse ne doivent pas ouvrir une porte');
});
await test('reprendre son propre pseudo n\'est pas un conflit', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'loic' } });
  assert.strictEqual(r.code, 200);
});
await test('un corps illisible ou trop gros ne fait pas tomber le serveur', async () => {
  const app = appDe(fakeDb());
  await appel(app, { token: 'ok:u1:Loic' });
  const a = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: '{ pas du json' });
  assert.strictEqual(a.code, 400);
  const b = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'x'.repeat(10_000) } });
  assert.ok(b.code === 400, `attendu 400, recu ${b.code}`);
});
await test('une méthode non prévue est refusée', async () => {
  const r = await appel(appDe(fakeDb()), { method: 'DELETE', token: 'ok:u1:Loic' });
  assert.strictEqual(r.code, 405);
});
await test('une route inconnue ne révèle rien', async () => {
  const r = await appel(appDe(fakeDb()), { path: '/api/admin', token: 'ok:u1:Loic' });
  assert.strictEqual(r.code, 404);
});

console.log('Limitation de débit');
await test('le martèlement d\'un pseudo est freiné', async () => {
  const app = appDe(fakeDb(), { limiter: makeLimiter({ max: 3, windowMs: 60_000 }) });
  await appel(app, { token: 'ok:u1:Loic' });
  const codes = [];
  for (let i = 0; i < 5; i++)
    codes.push((await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'Nom' + i } })).code);
  assert.strictEqual(codes.filter(c => c === 429).length, 2, codes.join(','));
});
await test('le seau se vide avec le temps', () => {
  let t = 0;
  const allow = makeLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.ok(allow('a') && allow('a') && !allow('a'));
  t = 1500;
  assert.ok(allow('a'), 'après la fenêtre, on doit pouvoir réessayer');
});
await test('le seau d\'un joueur ne freine pas celui d\'un autre', () => {
  const allow = makeLimiter({ max: 1, windowMs: 1000 });
  assert.ok(allow('a')); assert.ok(!allow('a')); assert.ok(allow('b'));
});

console.log('CORS');
await test('une origine inconnue ne reçoit aucun en-tête d\'autorisation', async () => {
  const r = await appel(appDe(fakeDb()), { token: 'ok:u1:Loic', origin: 'https://pirate.example' });
  assert.strictEqual(r.head['access-control-allow-origin'], undefined);
});
await test('l\'origine du jeu est autorisée nommément, jamais par une étoile', async () => {
  const r = await appel(appDe(fakeDb()), { token: 'ok:u1:Loic' });
  assert.strictEqual(r.head['access-control-allow-origin'], ORIGINE);
  assert.strictEqual(r.head['vary'], 'Origin');
});
await test('le pré-vol répond sans exposer la route aux inconnus', async () => {
  const app = appDe(fakeDb());
  const ok = await appel(app, { method: 'OPTIONS' });
  assert.strictEqual(ok.code, 204);
  assert.strictEqual(ok.head['access-control-allow-origin'], ORIGINE);
  const non = await appel(app, { method: 'OPTIONS', origin: 'https://pirate.example' });
  assert.strictEqual(non.head['access-control-allow-origin'], undefined);
});

console.log('Le billet de partie');
test('un mode inconnu est refusé, et le message dit lesquels existent', () => {
  const { erreurs, champs } = checkMatch({ ...DEMANDE, mode: 'battleroyale' });
  assert.strictEqual(champs, null);
  assert.ok(erreurs.some(e => e.includes('Mode inconnu') && e.includes('resurgence')), erreurs.join(' | '));
});
test('un mode hérité du prototype ne passe pas pour un mode connu', () => {
  // `MODES['constructor']` rend une fonction, donc une valeur vraie : c'est le genre de mode
  // inventé qu'une lecture directe laisserait entrer.
  for (const faux of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.ok(checkMatch({ ...DEMANDE, mode: faux }).erreurs.length, faux);
});
test('une mise absente des tables est refusée, avec les mises possibles', () => {
  for (const mise of [0.51, 0, -1, 100, 'gratuit', null, undefined, NaN, Infinity]) {
    const { erreurs } = checkMatch({ ...DEMANDE, stake: mise });
    assert.ok(erreurs.some(e => e.includes('Mise inconnue')), `${mise} : ${erreurs.join(' | ')}`);
  }
  assert.deepStrictEqual(checkMatch({ ...DEMANDE, stake: 10 }).erreurs, []);
});
test('checkMatch délègue la recherche de table à WBCore.tierFor', () => {
  // L'API recopiait le corps de `tierFor` — `TIERS.find(t => t.stake === mise)`. Comparer le
  // résultat à `C.TIERS` ne prouverait rien : c'est la FONCTION qu'on ne veut pas voir recopiée,
  // parce que le jour où la recherche de table change, le lobby affichera une table que le serveur
  // refusera, sans un mot au joueur.
  for (const mise of [...C.TIERS.map(t => t.stake), 0, 7, -1, NaN, '10', 'abc', Infinity, null])
    assert.strictEqual(
      checkMatch({ ...DEMANDE, stake: mise }).erreurs.some(e => e.includes('Mise inconnue')),
      C.tierFor(Number(mise)) === null,
      String(mise));
});
test('un brawler inconnu est refusé', () => {
  assert.ok(checkMatch({ ...DEMANDE, brawler: 'godzilla' }).erreurs.some(e => e.includes('Brawler inconnu')));
  assert.deepStrictEqual(checkMatch({ ...DEMANDE, brawler: 'bolt' }).erreurs, []);
});
test('sans clé d\'idempotence, la demande est refusée', () => {
  for (const cle of [undefined, '', '   ', 42, {}, 'x'.repeat(65)])
    assert.ok(checkMatch({ ...DEMANDE, clientKey: cle }).erreurs.some(e => e.includes('clientKey')), String(cle));
});
test('une demande valide ressort en centimes entiers, avec les sièges de WBCore', () => {
  const { champs, erreurs } = checkMatch(DEMANDE);
  assert.deepStrictEqual(erreurs, []);
  assert.strictEqual(champs.stakeCents, 50);
  assert.ok(Number.isInteger(champs.stakeCents));
  assert.strictEqual(champs.seats, C.seatsOf(C.MODES.solo));
  assert.strictEqual(champs.mode.id, 'solo');
});

await test('sans jeton, rien n\'est écrit : le refus vient avant la base', async () => {
  const { db, app, tires } = bancDeBillet();
  const r = await demander(app, DEMANDE, { token: undefined });
  assert.strictEqual(r.code, 401);
  assert.strictEqual(db.matches.length, 0, 'un inconnu ne doit pas ouvrir de billet');
  assert.strictEqual(tires(), 0, 'ni faire tirer une graine');
});
await test('le billet livre la graine publique, jamais la secrète', async () => {
  const { db, app, tires, tiresSecret } = bancDeBillet();
  const r = await demander(app);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.seed, GRAINES[0]);
  assert.strictEqual(db.matches[0].seed_public, GRAINES[0]);
  // 128 BITS, EN HEXADÉCIMAL. `between 0 and 4294967295` rendait une graine « secrète » trouvable
  // par force brute hors ligne, et une colonne qui porte un nom qui ment est pire que pas de
  // colonne. Elle ne protège toujours rien dans cette phase — la simulation ne l'utilise pas — mais
  // elle ne prétend plus le contraire.
  assert.strictEqual(db.matches[0].seed_secret, SECRETS[0]);
  assert.match(db.matches[0].seed_secret, /^[0-9a-f]{32}$/);
  assert.strictEqual(tires(), 1, 'une graine publique par billet, et une seule');
  assert.strictEqual(tiresSecret(), 1, 'un secret par billet, et un seul');
  const texte = JSON.stringify(r.corps);
  assert.ok(!texte.includes(SECRETS[0]), 'la graine secrète a fui : ' + texte);
  assert.ok(!/secret/i.test(texte), texte);
  assert.deepStrictEqual(Object.keys(r.corps).sort(),
    ['brawler', 'expiresAt', 'id', 'mode', 'openedAt', 'seats', 'teamSize', 'seed', 'stakeCents', 'status'].sort());
});
await test('une graine, des sièges, un montant envoyés par le client sont sans effet', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, {
    ...DEMANDE, seed: 7, seats: 999, stakeCents: 1, stake_cents: 1, payout_cents: 999999,
    user_id: 42, status: 'settled',
  });
  assert.strictEqual(r.corps.seed, GRAINES[0], 'la graine vient de la source du serveur');
  assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES.solo));
  const ligne = db.matches[0];
  assert.strictEqual(ligne.seed_public, GRAINES[0]);
  assert.strictEqual(ligne.seats, C.seatsOf(C.MODES.solo));
  assert.strictEqual(ligne.stake_cents, 50);
  assert.strictEqual(ligne.status, 'open');
  assert.strictEqual(ligne.user_id, db.users[0].id, 'l\'utilisateur vient du jeton, pas du corps');
});
await test('un corps chargé écrit exactement la même ligne qu\'un corps minimal', async () => {
  // Le patron déjà éprouvé sur PATCH /api/me : c'est la formulation mécanique de « aucun montant,
  // aucune graine, aucun statut ne vient du client ». Deux bancs, mêmes horloge et mêmes graines,
  // même clé du client : les deux lignes doivent être indiscernables.
  const nu = bancDeBillet(), charge = bancDeBillet();
  const a = await demander(nu.app, DEMANDE);
  const b = await demander(charge.app, {
    ...DEMANDE, seed: 1, seed_public: 2, seed_secret: 3, seats: 999, stake: 0.5, stake_cents: 999,
    payout_cents: 999, user_id: 999, status: 'settled', opened_at: 0, expires_at: '2099-01-01T00:00:00Z',
    id: 999,
  });
  assert.deepStrictEqual(charge.db.matches, nu.db.matches);
  assert.deepStrictEqual(b.corps, a.corps);
});
await test('deux demandes d\'affilée rendent le même billet', async () => {
  const { db, app } = bancDeBillet();
  const un = await demander(app);
  const deux = await demander(app, { ...DEMANDE, clientKey: 'cle-2', mode: 'trio', stake: 10 });
  assert.strictEqual(deux.code, 200, 'un billet déjà ouvert n\'est pas une erreur, sinon un onglet fermé enferme le joueur');
  assert.deepStrictEqual(deux.corps, un.corps, 'le billet ouvert est rendu tel quel, mode et mise compris');
  assert.strictEqual(db.matches.length, 1);
});
await test('la même clé rejouée rend la même réponse et n\'écrit pas de seconde ligne', async () => {
  const { db, app } = bancDeBillet();
  const un = await demander(app);
  const rejeu = await demander(app);
  assert.deepStrictEqual(rejeu.corps, un.corps);
  assert.strictEqual(db.matches.length, 1);
});
await test('après expiration, une nouvelle demande rend un nouveau billet et une autre graine', async () => {
  const { db, app, horloge } = bancDeBillet();
  const un = await demander(app);
  horloge.t = Date.parse(un.corps.expiresAt) + 1;
  const deux = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.notStrictEqual(deux.corps.id, un.corps.id);
  assert.notStrictEqual(deux.corps.seed, un.corps.seed);
  assert.strictEqual(db.matches.length, 2);
  assert.strictEqual(db.matches[0].status, 'expired', 'le billet périmé libère la place');
  // En revanche la clé du premier appel, elle, rend toujours ce qu'elle a rendu la première fois :
  // une demande rejouée à l'identique doit toujours donner la même réponse. Une nouvelle tentative
  // tire une nouvelle clé, c'est ce qui les distingue.
  const vieux = await demander(app);
  assert.strictEqual(vieux.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 2);
});
await test('une clé absorbée par un billet ouvert n\'écrit rien, et rouvre après expiration', async () => {
  // La limite connue de ce montage, écrite comme un test plutôt que passée sous silence. Une clé
  // qui arrive pendant qu'un billet est déjà ouvert ne laisse aucune ligne : elle reçoit le billet
  // en cours. Rejouée APRÈS l'expiration de celui-ci, elle en ouvre donc un nouveau. L'idempotence
  // est totale tant que le billet est ouvert — c'est-à-dire pendant toute la fenêtre où une réponse
  // perdue peut être rejouée — et pas au-delà.
  const { db, app, horloge } = bancDeBillet();
  const un = await demander(app, { ...DEMANDE, clientKey: 'cle-1' });
  const absorbee = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.strictEqual(absorbee.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 1, 'la clé absorbée ne laisse aucune ligne');
  horloge.t = Date.parse(un.corps.expiresAt) + 1;
  const apres = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.notStrictEqual(apres.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 2);
});
await test('la mise d\'une table à 0,50 $ est stockée 50, en entier', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, { ...DEMANDE, stake: 0.5 });
  assert.strictEqual(db.matches[0].stake_cents, 50);
  assert.strictEqual(r.corps.stakeCents, 50);
  for (const t of C.TIERS) {
    const banc = bancDeBillet();
    const x = await demander(banc.app, { ...DEMANDE, stake: t.stake });
    assert.strictEqual(x.corps.stakeCents, C.toCents(t.stake), String(t.stake));
    assert.ok(Number.isInteger(x.corps.stakeCents));
  }
});
await test('les sièges du billet sont ceux de WBCore, mode par mode', async () => {
  for (const id of Object.keys(C.MODES)) {
    const { db, app } = bancDeBillet();
    const r = await demander(app, { ...DEMANDE, mode: id });
    assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES[id]), id);
    assert.strictEqual(db.matches[0].seats, C.seatsOf(C.MODES[id]), id);
    assert.strictEqual(db.matches[0].mode, id);
  }
});
await test('l\'expiration part avec le billet, et couvre le sas et tout le plan de zone', async () => {
  const { app } = bancDeBillet();
  const r = await demander(app);
  const gaz = C.zoneTotalS(C.zonePlan(GRAINES[0], C.MODES.solo));
  assert.strictEqual(Date.parse(r.corps.openedAt), T0);
  assert.strictEqual(Date.parse(r.corps.expiresAt) - T0, (C.LOBBY.wait + gaz + MATCH_MARGE_S) * 1000);
  assert.ok(Date.parse(r.corps.expiresAt) - T0 > (C.LOBBY.wait + gaz) * 1000,
    'une partie que personne ne gagne doit tenir dans le billet');
  // Elle est calculée sur le plan de ce mode-là, pas sur un délai rond : le gaz rapide de
  // Resurgence raccourcit le billet d'autant.
  const rapide = bancDeBillet();
  const q = await demander(rapide.app, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(
    (Date.parse(r.corps.expiresAt) - Date.parse(q.corps.expiresAt)) / 1000,
    gaz - C.zoneTotalS(C.zonePlan(GRAINES[0], C.MODES.resurgence)));
});
await test('la limitation de débit couvre la route qui écrit, sans bloquer le profil', async () => {
  const { db, app } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await demander(app, { ...DEMANDE, clientKey: 'cle-' + i })).code);
  assert.deepStrictEqual(codes, [200, 200, 429, 429], codes.join(','));
  assert.strictEqual(db.matches.length, 1);
  // Deux seaux distincts : renommer son personnage ne doit pas empêcher de jouer.
  const p = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'Zoe' } });
  assert.strictEqual(p.code, 200);
});
await test('le pré-vol annonce désormais POST', async () => {
  const { app } = bancDeBillet();
  const r = await appel(app, { method: 'OPTIONS' });
  const methodes = String(r.head['access-control-allow-methods']).split(',');
  assert.ok(methodes.includes('POST'), r.head['access-control-allow-methods']);
  for (const m of ['GET', 'PATCH', 'OPTIONS']) assert.ok(methodes.includes(m), m);
});
await test('la route du billet n\'accepte que POST', async () => {
  const { app } = bancDeBillet();
  for (const m of ['GET', 'PATCH', 'DELETE']) {
    const r = await appel(app, { method: m, path: '/api/match', token: 'ok:u1:Loic' });
    assert.strictEqual(r.code, 405, m);
  }
});
await test('une graine rendue en chaîne par la base ressort en nombre', async () => {
  // Le pilote Postgres rend les colonnes `bigint` sous forme de CHAÎNE. Une graine en chaîne est
  // refusée par `seedFor`, qui repartirait sur la graine locale : le joueur verrait une autre
  // carte que celle de son billet, sans le moindre message. La doublure imite donc ici le pilote,
  // et pas l'idée qu'on s'en fait.
  const db = fakeDb();
  const brute = db.createMatch;
  db.createMatch = async m => {
    const { match, repris } = await brute(m);
    return { match: { ...match, id: String(match.id), seed_public: String(match.seed_public) }, repris };
  };
  const app = appDe(db, { randomSeed: () => GRAINES[0], now: () => T0 });
  const r = await demander(app);
  assert.strictEqual(typeof r.corps.seed, 'number');
  assert.strictEqual(r.corps.seed, GRAINES[0]);
  assert.strictEqual(C.seedFor(r.corps, 'graine de secours'), GRAINES[0]);
});
await test('sans source injectée, la graine tirée par défaut est acceptée par le jeu', async () => {
  // La source par défaut est celle du système, et elle n'est pas couverte par les tests qui
  // l'injectent. Le contrat qu'elle doit tenir est celui de `WBCore.seedFor` : hors du domaine des
  // entiers 32 bits non signés, le jeu repartirait sur sa propre graine sans rien dire.
  const db = fakeDb();
  const app = createApp({ db, verifyToken: verifOk, origins: [ORIGINE] });
  const r = await demander(app);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(C.seedFor(r.corps, 'graine de secours'), r.corps.seed);
});
await test('une source de graines hors du domaine de makeRng fait échouer, elle n\'écrit pas', async () => {
  // Une graine flottante, négative ou au-delà de 32 bits serait refusée par `seedFor` côté client :
  // le jeu repartirait sur sa propre graine sans que personne ne le remarque, et la ligne en base
  // décrirait une partie que le joueur n'a pas jouée. Mieux vaut un 500 bruyant.
  for (const mauvaise of [0.5, -1, 2 ** 32, NaN, '7', null]) {
    const { db, app } = bancDeBillet({ randomSeed: () => mauvaise });
    const r = await demander(app);
    assert.strictEqual(r.code, 500, String(mauvaise));
    assert.strictEqual(db.matches.length, 0, String(mauvaise));
  }
});
await test('un corps illisible sur le billet ne fait pas tomber le serveur', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, '{ pas du json');
  assert.strictEqual(r.code, 400);
  assert.strictEqual(db.matches.length, 0);
});
test('aucune colonne solde, et aucun montant déjà écrit n\'est mis à jour', () => {
  // Garde textuelle : la doublure de test ne peut pas prouver ce que fait Postgres, mais elle peut
  // prouver ce qu'on lui a écrit. Les commentaires sont retirés d'abord — ils parlent justement de
  // l'absence de colonne solde.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  // Les commentaires de `db-pg.js` citent eux aussi des morceaux de requête entre accents graves :
  // sans les retirer, la garde finirait par prendre un commentaire pour une écriture — et un
  // commentaire est toujours d'accord avec ce qu'on veut lui faire dire.
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.ok(!/\b(solde|balance|wallet)\b/i.test(sql), 'une colonne de solde est apparue dans le schéma');
  // Chaque requête est UN littéral entre accents graves : on découpe là-dessus plutôt que de
  // balayer le fichier au jugé. Une plage qui court d'une requête à la suivante avale les
  // commentaires qui les séparent, et un commentaire citant la bonne clause suffit alors à faire
  // passer une requête qui ne la porte plus. C'est exactement ce qui est arrivé en écrivant ce
  // test : la garde disait vert sur une écriture de montant sans aucune protection.
  const requetes = (pg.match(/`[^`]*`/g) || []).filter(q => /update\s+matches\s+set/i.test(q));
  assert.ok(requetes.length >= 2, `seulement ${requetes.length} écritures retrouvées dans db-pg.js`);
  for (const u of requetes) {
    // Aucune écriture de cette table ne touche une ligne déjà close : `status = 'open'` figure
    // dans toutes les clauses, y compris celles du veilleur, sans exception.
    assert.match(u, /status\s*=\s*'open'/, 'une écriture peut toucher une ligne close : ' + u);
    if (!/_cents/.test(u)) continue;
    // Et un `update` qui écrit un MONTANT est autorisé à une condition de plus : qu'il ne puisse
    // écrire que sur une ligne qui n'en porte aucun. C'est ce qui fait de `matches` une table en
    // insertion puis règlement unique — un montant déjà écrit n'est jamais réécrit.
    assert.match(u, /net_cents\s+is\s+null/, 'un montant est écrit sans exiger une ligne vierge : ' + u);
  }
});
test('les colonnes en centimes sont entières et positives, sauf l\'écart qui est une mesure', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const colonnes = sql.match(/^[ \t]*\w*_cents\b.*$/gm) || [];
  assert.ok(colonnes.length >= 6, `le schéma ne porte que ${colonnes.length} colonnes en centimes`);
  for (const c of colonnes) {
    assert.match(c, /\binteger\b/, c);
    // `ecart_cents` est la seule exception, et elle est nommée plutôt que tolérée par un motif
    // large : ce n'est pas de l'argent dû, c'est la différence entre ce que le client annonce et
    // ce que le serveur compte. Elle peut être négative, et cette mesure-là compte autant.
    if (/^\s*ecart_cents\b/.test(c)) { assert.ok(!/check/.test(c), c); continue; }
    assert.match(c, /check\s*\(\s*\w+_cents\s*>=?\s*0\s*\)/, c);
  }
});

console.log('Le verdict rendu par la route');
// Un rapport de fin de partie complet. `reportFrom` est la seule porte côté client : l'écrire à la
// main ici ferait deux idées du contrat, et c'est toujours la deuxième qui ment.
const RAPPORT = (extra = {}) => C.reportFrom({
  seconds: 60, kills: 0, deaths: 1, rank: 5, cubes: 0, damage: 0,
  cashedOut: false, purseCents: 0, declaredNetCents: 0, ...extra,
});
// L'instant auquel un rapport HONNÊTE arrive : le sas, la partie, et trois secondes de réseau.
const ARRIVEE = r => T0 + (C.LOBBY.wait + r.seconds + 3) * 1000;
const rendre = (app, id, rapport, opts = {}) =>
  appel(app, { method: 'POST', path: `/api/match/${id}/result`, token: 'ok:u1:Loic', body: rapport, ...opts });
const CLES_REGLEMENT = ['matchId', 'status', 'issue', 'controle', 'motif', 'grossCents', 'feeCents',
                        'netCents', 'purseCents', 'declaredNetCents', 'ecartCents', 'settledAt',
                        'traceSteps', 'digestMatch', 'divergenceStep', 'replayMs'];

// ---------- DE QUOI JOUER UNE VRAIE PARTIE, ET LA FAIRE JUGER ----------
// Depuis le module 7 la route ne croit plus aucun fait déclaré : elle rejoue. Un rapport écrit à la
// main ne prouve donc plus rien de ce qu'il prétendait prouver, et ces tests doivent JOUER — avec le
// même bloc `WBSim` que le serveur rejouera — puis envoyer la trace de ce qu'ils ont joué.
//
// Le pilote est une conduite de JOUEUR et rien d'autre : il ne décide d'aucune règle, il produit les
// six nombres et les deux booléens que `lireEntrees` lit sur la souris et les sticks.
function pilote(G) {
  const p = G.player, portee = p.brawler.attack.range;
  if (!p.alive) return { mx: 0, mz: 0, ax: p.ax, az: p.az, aimDist: portee, feu: false, sup: false };
  let cible = null, bd = 1e9;
  for (const e of G.ents) {
    if (e === p || !e.alive || e.team === p.team) continue;
    const d = C.dist(e.x - p.x, e.z - p.z);
    if (d < bd && SIM.canSee(G, p, e)) { bd = d; cible = e; }
  }
  let ax = p.ax, az = p.az, mx = 0, mz = 0, feu = false, sup = false, aimDist = portee;
  if (cible) {
    ax = (cible.x - p.x) / bd; az = (cible.z - p.z) / bd;
    aimDist = Math.min(bd, portee);
    feu = bd < portee;
    sup = p.super >= p.brawler.super.cost;
    if (bd > portee * 0.6) { mx = ax; mz = az; } else { mx = -az; mz = ax; }
  } else {
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    if (d > 2) { mx = dx / d; mz = dz / d; ax = mx; az = mz; }
  }
  if (!SIM.inZone(G, p.x, p.z, 1.5)) {
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    mx = dx / d; mz = dz / d;
  }
  if ((mx || mz) && !SIM.free(G, p.x + mx * 0.9, p.z + mz * 0.9)) {
    const s = (p.eid % 2) ? 1 : -1;
    if (SIM.free(G, p.x - mz * s * 0.9, p.z + mx * s * 0.9)) { const t = mx; mx = -mz * s; mz = t * s; }
    else { const t = mx; mx = mz * s; mz = -t * s; }
  }
  return { mx, mz, ax, az, aimDist, feu, sup };
}
// Une partie entière, jouée exactement comme le jeu la joue : l'entrée est QUANTIFIÉE À LA SOURCE
// (`traceQuant`), le jeu joue celle-là, et la trace porte le même entier — c'est ce qui rend le
// rejeu exact par construction et non par tolérance. Les actions ponctuelles — le super,
// l'encaissement — partent entre deux pas, comme dans le jeu, et sont notées comme des jetons.
//
// `encaisser` pose le jeton d'encaissement au pas demandé. C'est la seule sortie GAGNANTE qu'un
// pilote de test puisse produire à coup sûr : gagner une partie contre dix-neuf bots ne se commande
// pas, et un test qui dépendrait de cette chance-là finirait par tomber tout seul.
const PARTIES = new Map();
function jouerPartie(o) {
  const cle = JSON.stringify(o);
  if (PARTIES.has(cle)) return PARTIES.get(cle);
  const { graine, mode = 'solo', miseCents = 50, brawler = BRAWLER, encaisser = -1, pasMax = 0,
          rallonge = 0, encaisserSiRiche = false } = o;
  const cfg = C.MODES[mode];
  const maxPas = C.traceMaxSteps(C.zonePlan(graine, cfg));
  const demande = rallonge ? encaisser + rallonge : pasMax;
  // `encaisser`, `pasMax` et `rallonge` se comptent en pas de SIMULATION — ceux que `G.pas` mesure
  // — et pas en tours de boucle : le compte à rebours d'intro, posé par `newMatch`, consomme ses
  // pas sans rien faire avancer, exactement comme dans le navigateur. Les compter dans ces bornes
  // décalerait tous les tests de deux cent quarante pas sans que personne ne le voie.
  const borne = (demande > 0 ? Math.min(demande + PAS_INTRO, maxPas) : maxPas);
  const rec = C.traceEnregistreur(maxPas);
  const G = SIM.newMatch(graine, cfg, miseCents, C.BRAWLERS[brawler]);
  let pas = 0;
  while (pas < borne && !G.fin) {
    // `rallonge` note le jeton d'encaissement dans la trace SANS sortir de la partie, et continue
    // de jouer. C'est la trace d'un client qui rallonge la sienne après avoir encaissé : le serveur
    // doit s'arrêter au jeton, pas au bout du fichier.
    if (G.pas === encaisser) {
      rec.acte(C.TRACE.ENC, 0);
      if (!rallonge) { SIM.doCashOut(G); if (G.fin) break; }
    }
    // ENCAISSER DÈS QU'ON EST PLUS RICHE QUE SA MISE, et pas à un pas fixe. Le pas fixe tombait
    // avant l'expiration de `CASHOUT.lock` dès que le joueur avait pris un coup, si bien que la
    // seule sortie gagnante du fichier partait avec exactement sa propre mise en poche — rien ne
    // distinguait alors « la sacoche que le rejeu trouve » de « la mise inscrite sur le billet ».
    if (encaisserSiRiche && G.player.alive && G.player.pouch > C.fromCents(miseCents)
        && C.cashoutReady(G.player.cashLock || 0)) {
      rec.acte(C.TRACE.ENC, 0);
      SIM.doCashOut(G);
      if (G.fin) break;
    }
    const brut = pilote(G);
    if (brut.sup && G.player.alive) {
      const mots = C.traceViseeMots(brut.ax, brut.az, brut.aimDist), v = C.traceVisee(mots);
      rec.acte(C.TRACE.SUP, mots);
      // La visée se repose sur le brawler avant l'action, exactement comme `appliquerActe` la
      // repose au rejeu : sans cela l'action partirait dans la direction du pas précédent.
      G.player.ax = v.ax; G.player.az = v.az;
      SIM.useSuper(G, G.player, v.dist);
    }
    rec.ajouter(C.traceMots(brut));
    SIM.step(G, C.traceQuant(brut));
    pas++;
  }
  // Le rapport, construit exactement comme `endMatch` le construit : les faits viennent de SIM, le
  // net annoncé et les condensés viennent du côté qui les a vus.
  const gagne = !!(G.fin && G.fin.gagne);
  const r = {
    G, pas, segments: rec.segments(), terminal: SIM.terminal(G),
    rapport: C.reportFrom({
      ...SIM.faits(G),
      declaredNetCents: gagne ? C.toCents(C.cashoutPayout(G.player.pouch).net) : 0,
      digests: C.digestsEncode(G.empreintes),
    }),
  };
  PARTIES.set(cle, r);
  return r;
}
// La partie que DÉCRIT un billet : sa graine, son mode, sa mise, son brawler. Rien n'est choisi ici,
// tout vient de la ligne que le serveur a écrite.
const partieDe = (b, opts = {}) => jouerPartie({
  graine: b.corps.seed, mode: b.corps.mode, miseCents: b.corps.stakeCents,
  brawler: b.corps.brawler,
  ...(opts.encaisser === undefined ? {} : { encaisser: opts.encaisser }),
  ...(opts.pasMax === undefined ? {} : { pasMax: opts.pasMax }),
  ...(opts.rallonge === undefined ? {} : { rallonge: opts.rallonge }),
  // Le cache `PARTIES` est clé sur les options : une option oubliée ici rendrait la partie d'une
  // AUTRE configuration, en silence.
  ...(opts.encaisserSiRiche === undefined ? {} : { encaisserSiRiche: opts.encaisserSiRiche }),
});
const poserTrace = async (app, id, segments, token = 'ok:u1:Loic') => {
  for (let i = 0; i < segments.length; i++) {
    const r = await appel(app, { method: 'POST', path: `/api/match/${id}/trace`, token,
                                 body: { seq: i, simVersion: SIM.SIM_VERSION, data: segments[i] } });
    assert.strictEqual(r.code, 200, 'la trace du test a été refusée : ' + JSON.stringify(r.corps));
  }
};
// Le chemin complet d'un joueur : un billet, une vraie partie, sa trace, puis son résultat. Les
// tests qui suivent partent tous de là — c'est le seul chemin qui existe encore.
async function jouerEtRendre(app, horloge, b, opts = {}) {
  const p = partieDe(b, opts);
  const token = opts.token || 'ok:u1:Loic';
  if (!opts.sansTrace) await poserTrace(app, b.corps.id, p.segments, token);
  horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000;
  const rep = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                 token, body: opts.corps || p.rapport });
  return { partie: p, rep };
}

await test('LE SERVEUR NE CROIT PLUS AUCUN FAIT DÉCLARÉ : un corps gonflé écrit la même ligne qu\'un corps sincère', async () => {
  // LE TEST CENTRAL DU MODULE, et c'est le patron de la 02a — « un corps portant une graine écrit
  // une ligne identique à celle d'un corps vide » — étendu des PARAMÈTRES aux FAITS. Deux bancs,
  // mêmes graines, même horloge, même trace : d'un côté le rapport que le jeu rendrait, de l'autre
  // le même rapport avec tous ses faits gonflés au maximum plausible. Les deux lignes doivent être
  // indiscernables, parce qu'aucune des deux n'est lue : la ligne vient du rejeu.
  const sincere = bancDeBillet(), menteur = bancDeBillet();
  const a = await demander(sincere.app);
  const b = await demander(menteur.app);
  const p = partieDe(a);
  assert.ok(p.terminal, 'la partie du test doit atteindre un état terminal');

  const gonfle = { ...p.rapport, seconds: 900, kills: 57, deaths: 3, rank: 1, cubes: C.CUBE.max,
                   damage: 999_999, cashedOut: false,
                   purseCents: C.purseBound(a.corps.stakeCents, a.corps.seats).maxCents };
  // Le corps gonflé passe l'analyse et l'enveloppe : ce n'est pas un rapport absurde, c'est un
  // rapport que la 02a aurait accepté mot pour mot — et payé.
  assert.deepStrictEqual(C.checkReport(gonfle).erreurs, []);

  const un = await jouerEtRendre(sincere.app, sincere.horloge, a);
  const deux = await jouerEtRendre(menteur.app, menteur.horloge, b, { corps: gonfle });
  assert.strictEqual(un.rep.code, 200, JSON.stringify(un.rep.corps));
  assert.strictEqual(deux.rep.code, 200, JSON.stringify(deux.rep.corps));
  assert.deepStrictEqual(deux.rep.corps, un.rep.corps, 'le corps gonflé a changé la réponse');
  assert.deepStrictEqual(menteur.db.matches, sincere.db.matches, 'le corps gonflé a changé la ligne');

  // Et ce que la ligne porte est bien ce que le REJEU a trouvé, pas ce que le corps annonçait.
  const ligne = sincere.db.matches[0];
  assert.strictEqual(ligne.kills, p.rapport.kills);
  assert.strictEqual(ligne.rank, p.rapport.rank);
  assert.strictEqual(ligne.purse_cents, p.rapport.purseCents);
  assert.notStrictEqual(ligne.kills, gonfle.kills);
  assert.notStrictEqual(ligne.seconds, gonfle.seconds);
  assert.strictEqual(ligne.trace_steps, p.pas, 'la durée se compte en pas, et le serveur les compte');
  assert.strictEqual(ligne.digest_match, true, 'le rejeu du serveur n\'a pas convergé avec le jeu');
  assert.strictEqual(ligne.divergence_step, null);
  assert.deepStrictEqual(Object.keys(un.rep.corps).sort(), CLES_REGLEMENT.slice().sort());
  assert.ok(!JSON.stringify(un.rep.corps).includes(String(SECRETS[0])), 'la graine secrète a fui');
});
await test('LE DÉCOMPTE D\'INTRO EST REJOUÉ AUSSI : sans lui, digest_match serait faux sur TOUTE partie', async () => {
  // LE DÉFAUT. Le compte à rebours ne vivait que dans le bloc `Game` : `startMatch` posait
  // `G.intro = 3.999` APRÈS `newMatch`, qui rendait `intro: 0`. La trace, elle, enregistre ces pas.
  // Le serveur repartait donc d'un décompte à zéro et rejouait en pas RÉELS les deux cent quarante
  // pas passés à décompter : il jugeait une AUTRE partie. Conséquences pour un joueur honnête et
  // connecté : `digest_match` faux sur toutes ses parties — donc zéro ligne lisible par le grand
  // livre de la phase 03 et cinq agrégats à zéro — et, quand le rejeu n'atteignait pas de terminal,
  // un 409 `non_terminal` et une partie jamais enregistrée. Aucun test ne le voyait : ni celui du
  // jeu ni celui-ci ne posaient jamais `G.intro`, qui vivait hors du bloc SIM.
  assert.ok(SIM.newMatch(4242, C.MODES.solo, 50, C.BRAWLERS[BRAWLER]).intro > 0,
    'newMatch ne pose plus le décompte : le rejeu du serveur rejouerait une autre partie');
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  // La trace porte les pas du décompte, et le serveur les compte comme tels : `trace_steps` les
  // inclut, la durée non — c'est exactement la différence que le décompte fait.
  assert.strictEqual(partie.pas, partie.G.pas + PAS_INTRO, 'la partie du test n\'a pas eu de décompte');
  assert.strictEqual(rep.corps.traceSteps, partie.pas);
  assert.strictEqual(db.matches[0].seconds, partie.rapport.seconds);
  // ET LE REJEU A CONVERGÉ, du premier condensé au dernier. C'est le seul chiffre qui dit que le
  // serveur a rejoué la partie qui s'est affichée, et pas une partie voisine.
  assert.strictEqual(rep.corps.digestMatch, true, 'le rejeu du serveur diverge de la partie du joueur');
  assert.strictEqual(rep.corps.divergenceStep, null);
  assert.strictEqual(db.matches[0].replay_digest, SIM.empreinte(partie.G));
  const siens = C.digestsDecode(partie.rapport.digests);
  assert.ok(siens && siens.length > 3, 'trop peu de condensés pour que la convergence prouve quelque chose');
  assert.strictEqual(C.digestsDiff(partie.G.empreintes, siens), -1);
  // Et la ligne compte, elle : c'est la conséquence directe de la convergence.
  const s = (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;
  assert.strictEqual(s.matches, 1, 'une partie convergée n\'entre pas dans les agrégats');
  assert.strictEqual(s.divergences, 0);
});
await test('L\'EXPLOIT NOMMÉ : prendre un billet, ne jamais jouer, rendre une victoire — vaut ZÉRO', async () => {
  // LE CORPS EXACT QUE LA SPÉCIFICATION NOMME, et il passait mot pour mot en 02a : `RESPAWN` donne
  // un plancher de dix secondes, `LOBBY.wait` plus la marge de victoire rendent cinq secondes
  // d'horloge suffisantes, et mille centimes de sacoche valaient huit cents payés sur une table à
  // 0,50 $. Il n'y a aucune partie derrière : aucune trace n'est arrivée.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
  assert.strictEqual(max, 1000);
  assert.strictEqual(C.cashoutCents(max).netCents, 800, 'ce que cet exploit rapportait hier');

  const exploit = C.reportFrom({ seconds: 10, kills: 0, deaths: 0, rank: 1, cubes: 0, damage: 0,
                                 cashedOut: false, purseCents: max, declaredNetCents: 800, digests: '' });
  // L'enveloppe de la 02a l'accepte toujours : c'est bien elle qui ne suffisait pas.
  const enveloppe = C.matchVerdict({ mode: 'solo', stakeCents: 50, seats: 20, teamSize: 1,
                                     seed: b.corps.seed, openedAt: b.corps.openedAt,
                                     expiresAt: b.corps.expiresAt },
                                   exploit, T0 + (C.LOBBY.wait + 5) * 1000);
  assert.strictEqual(enveloppe.netCents, 800, 'l\'enveloppe seule paierait encore cet exploit');

  horloge.t = T0 + (C.LOBBY.wait + 5) * 1000;
  const rep = await rendre(app, b.corps.id, exploit);
  assert.strictEqual(rep.code, 409, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.code, 'trace_absente');
  // Aucun montant, nulle part, et la ligne reste ouverte pour le veilleur : ni argent, ni joueur
  // enfermé dans un billet mort.
  for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
    assert.strictEqual(db.matches[0][col], undefined, `l'exploit a écrit ${col}`);
  assert.strictEqual(db.matches[0].status, 'open');
});
await test('UN BILLET NE SERT QU\'UNE TENTATIVE : après un résultat refusé, la graine suivante est AUTRE', async () => {
  // LE DÉFAUT. Depuis que toute la partie est une fonction pure de la graine publique, un billet
  // resservi est le même monde : mêmes caisses, mêmes vingt bots, même plan de gaz. Un joueur qui
  // bloque simplement l'envoi de sa trace obtenait un 409, gardait son billet OUVERT, recliquait
  // sur la table, recevait le MÊME billet — donc la même graine — et rejouait en connaissance de
  // cause le monde qu'il venait d'explorer, autant de fois que la vie du billet le permettait,
  // jusqu'à faire régler sa meilleure tentative. Ce n'est pas l'ESP structurel déjà consigné :
  // c'est une répétition générale gratuite de la partie qu'il va faire payer.
  const { db, app, horloge } = bancDeBillet();
  const TABLE = { ...DEMANDE, mode: 'resurgence', stake: 10 };
  const b1 = await demander(app, { ...TABLE, clientKey: 'cle-A' });
  const p1 = partieDe(b1, { encaisser: 300 });
  horloge.t = Date.parse(b1.corps.openedAt) + (C.LOBBY.wait + p1.rapport.seconds + 3) * 1000;
  const r1 = await appel(app, { method: 'POST', path: `/api/match/${b1.corps.id}/result`,
                                token: 'ok:u1:Loic', body: p1.rapport });
  assert.strictEqual(r1.code, 409, JSON.stringify(r1.corps));
  assert.strictEqual(r1.corps.code, 'trace_absente');
  // La ligne reste ouverte — c'est voulu, la trace peut encore arriver — mais elle est MARQUÉE.
  assert.strictEqual(db.matches[0].status, 'open');
  assert.ok(db.matches[0].first_result_at, 'le billet n\'est pas marqué comme joué');

  // Il reclique sur la même table, avec une clé d'idempotence NEUVE : c'est une nouvelle demande,
  // pas le rejeu d'une ancienne.
  const b2 = await demander(app, { ...TABLE, clientKey: 'cle-B' });
  assert.strictEqual(b2.code, 200, JSON.stringify(b2.corps));
  assert.notStrictEqual(b2.corps.id, b1.corps.id, 'le serveur a resservi le même billet');
  assert.notStrictEqual(b2.corps.seed, b1.corps.seed, 'le serveur a resservi la MÊME graine, donc le même monde');
  // L'ancien est clos SANS MONTANT, comme le veilleur le ferait : on ferme une porte, on n'écrit
  // pas d'argent.
  assert.strictEqual(db.matches[0].status, 'abandoned');
  for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
    assert.strictEqual(db.matches[0][col], undefined, `la clôture a écrit ${col}`);
  assert.strictEqual(db.matches.length, 2);
  // Et le monde n'est vraiment pas le même : deux graines, deux parties.
  const A = SIM.newMatch(b1.corps.seed, C.MODES.resurgence, b1.corps.stakeCents, C.BRAWLERS[BRAWLER]);
  const B = SIM.newMatch(b2.corps.seed, C.MODES.resurgence, b2.corps.stakeCents, C.BRAWLERS[BRAWLER]);
  assert.notStrictEqual(SIM.condenseEtat(A), SIM.condenseEtat(B), 'les deux billets posent le même monde');
  assert.notDeepStrictEqual(A.boxes.map(x => [x.x, x.z]), B.boxes.map(x => [x.x, x.z]),
    'les caisses sont aux mêmes endroits : c\'est le monde qu\'il vient d\'explorer');
});
await test('… et le joueur dont la trace s\'est perdue peut toujours la renvoyer sur le MÊME billet', async () => {
  // La contrepartie, et elle compte autant : la marque ne ferme rien. Un joueur honnête dont le
  // réseau a lâché au mauvais moment renvoie sa trace puis son résultat sur le même `match_id`, et
  // il est réglé. Fermer ici ferait un second endroit qui clôt une ligne, et punirait la panne.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  horloge.t = ARRIVEE(p.rapport);
  const rate = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                  token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(rate.corps.code, 'trace_absente');
  const marque = db.matches[0].first_result_at;
  await poserTrace(app, b.corps.id, p.segments);
  const bon = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                 token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(bon.code, 200, JSON.stringify(bon.corps));
  assert.strictEqual(bon.corps.status, 'settled');
  assert.ok(bon.corps.netCents > 0);
  // La marque ne se repose pas : elle vaut « la première fois », et un résultat renvoyé ne modifie
  // donc jamais la ligne. C'est ce qui garde l'idempotence de cette route totale.
  assert.strictEqual(db.matches[0].first_result_at, marque);
});
await test('LE PAIEMENT SORT DE LA PARTIE REJOUÉE : un encaissement Resurgence, joué pour de bon', async () => {
  // Le seul chemin par lequel un net non nul entre encore en base : une partie réellement jouée qui
  // se termine sur un encaissement. Rien ici n'est déclaré — la sacoche est celle que le rejeu
  // trouve dans la poche du joueur au moment où il sort.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(partie.terminal, 'encaissement');
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'settled');
  assert.strictEqual(rep.corps.issue, 'encaissement');
  // Personne n'est mort de sa main et il n'a rien ramassé : il sort avec exactement sa propre mise.
  // C'est un fait de la partie, pas un nombre choisi par le test.
  assert.strictEqual(rep.corps.purseCents, b.corps.stakeCents);
  assert.strictEqual(rep.corps.grossCents, b.corps.stakeCents);
  assert.ok(rep.corps.netCents > 0);
  assert.ok(rep.corps.feeCents > 0, 'la commission ne tombe jamais à zéro');
  assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents);
  // L'API ne recalcule jamais la commission elle-même : le net sort des fonctions de paiement.
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(rep.corps.purseCents).netCents);
  assert.strictEqual(db.matches[0].net_cents, rep.corps.netCents);
  assert.strictEqual(db.matches[0].cashed_out, true);
});
await test('LA SACOCHE PAYÉE N\'EST PAS LA MISE : un encaissement qui sort avec plus qu\'il n\'a engagé', async () => {
  // LE TROU QUE CE TEST BOUCHE. Le seul règlement payant du fichier avait une sacoche exactement
  // égale à la mise : rien n'y distinguait « la sacoche que le rejeu trouve dans la poche » de
  // « la mise inscrite sur le billet ». Plafonner tout paiement à une mise — `min(purse, stake)` —
  // ne cassait aucun test, alors que c'est précisément le premier des deux « contrôles évidents et
  // faux » que `api/README.md` refuse d'écrire, et que LA promesse de la phase est que le montant
  // sorte de la partie rejouée.
  //
  // La graine est forcée pour que la partie soit celle-là et pas une autre ; elle n'a rien de
  // magique — c'est l'assertion `purseCents > stakeCents` qui porte la garantie, et c'est elle qui
  // fera tomber le test avec un message clair le jour où un correctif de simulation changera la
  // partie, au lieu de le laisser redevenir aveugle en silence.
  const { db, app, horloge } = bancDeBillet({ randomSeed: () => 4 });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisserSiRiche: true });
  assert.strictEqual(partie.terminal, 'encaissement');
  assert.ok(partie.rapport.purseCents > b.corps.stakeCents,
    `la partie de ce test sort avec ${partie.rapport.purseCents} centimes pour ${b.corps.stakeCents} engagés : `
    + 'le test ne distingue plus la sacoche de la mise, il faut lui retrouver une partie qui le fasse');

  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.issue, 'encaissement');
  // LA ROUTE PAIE LA SACOCHE QUE LE REJEU A TROUVÉE, pas la mise inscrite sur le billet.
  assert.strictEqual(rep.corps.purseCents, partie.rapport.purseCents);
  assert.notStrictEqual(rep.corps.purseCents, b.corps.stakeCents);
  assert.strictEqual(rep.corps.grossCents, rep.corps.purseCents);
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(rep.corps.purseCents).netCents);
  assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents);
  // Et la ligne qui tue explicitement le plafonnement à une mise : payer `min(sacoche, mise)`
  // rendrait exactement le net d'une mise, et ce test-là serait le seul à le voir.
  assert.ok(rep.corps.netCents > C.cashoutCents(b.corps.stakeCents).netCents,
    'le paiement ne dépasse pas une mise : la sacoche du rejeu n\'est pas ce qui décide');
  assert.strictEqual(db.matches[0].net_cents, rep.corps.netCents);
  assert.strictEqual(db.matches[0].purse_cents, partie.rapport.purseCents);
  // La sacoche reste sous le plafond démontré par la conservation de l'argent : ce n'est pas parce
  // qu'elle n'est plus la mise qu'elle n'est plus bornée.
  assert.ok(rep.corps.purseCents <= C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents);
});
await test('le même billet réglé deux fois rend le PREMIER verdict, sans rien modifier', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const r = RAPPORT({ seconds: 154, rank: 1 });
  horloge.t = ARRIVEE(r);
  const un = await rendre(app, b.corps.id, r);
  const apres = JSON.stringify(db.matches);
  // Le second envoi ment sur tout : autre durée, autre rang, autre net annoncé. Il doit rendre
  // exactement ce que le premier a écrit, et ne rien réécrire.
  horloge.t += 60_000;
  const deux = await rendre(app, b.corps.id, RAPPORT({ seconds: 3, rank: 7, declaredNetCents: 424242 }));
  assert.deepStrictEqual(deux.corps, un.corps);
  assert.strictEqual(JSON.stringify(db.matches), apres, 'la ligne a été réécrite');
  assert.strictEqual(db.matches.length, 1);
});
await test('la base refuse elle-même un second règlement, sans compter sur la route', async () => {
  // Deux gardes empêchent une ligne d'être réglée deux fois : la route court-circuite dès qu'elle
  // voit une ligne close, et la clause `where status = 'open' and net_cents is null` de l'écriture
  // tranche pour de bon. Chacune masque l'autre, donc aucune des deux n'est prouvée en passant par
  // la route : celle-ci est donc appelée directement. C'est la seule qui compte en production,
  // l'autre n'est qu'une économie de calcul. La doublure imite la clause, elle ne la subit pas :
  // c'est la limite connue de tout ce dossier, écrite dans le README.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  await jouerEtRendre(app, horloge, b);
  const regle = JSON.stringify(db.matches[0]);
  const second = await db.settleMatch({
    matchId: b.corps.id, userId: db.users[0].id, status: 'settled', settledAt: new Date(0),
    issue: 'victoire', controle: null, motif: null,
    grossCents: 999_999, feeCents: 0, netCents: 999_999, purseCents: 999_999,
    declaredNetCents: 999_999, ecartCents: 0,
    seconds: 1, kills: 1, deaths: 0, rank: 1, cubes: 0, damage: 0, cashedOut: false,
    traceSteps: 1, replayDigest: 1, digestMatch: true, divergenceStep: null, replayMs: 1,
  });
  assert.strictEqual(second.deja, true, 'un second règlement doit être reconnu comme un rejeu');
  assert.strictEqual(JSON.stringify(db.matches[0]), regle, 'un montant déjà écrit a été réécrit');
});
await test('un résultat qui arrive en retard, mais avant expiration, est accepté', async () => {
  // Si couper le wifi effaçait une partie perdue, ce serait la meilleure stratégie du jeu.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = Date.parse(b.corps.expiresAt) - 1000;
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.corps.status, 'settled', rep.corps.motif);
  assert.ok(rep.corps.netCents > 0);
  assert.strictEqual(db.matches[0].status, 'settled');
});
await test('après expiration, le résultat ne se règle plus et la ligne est close en expired', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  const rep = await rendre(app, b.corps.id, RAPPORT({ seconds: 154, rank: 1 }));
  assert.strictEqual(rep.code, 200);
  assert.strictEqual(rep.corps.status, 'expired');
  assert.strictEqual(rep.corps.controle, 'expire');
  assert.strictEqual(rep.corps.netCents, 0);
  assert.strictEqual(db.matches[0].status, 'expired');
  // Et rejouer ne ressuscite rien.
  const encore = await rendre(app, b.corps.id, RAPPORT({ seconds: 154, rank: 1 }));
  assert.deepStrictEqual(encore.corps, rep.corps);
});
await test('checkReport refuse un champ inconnu, avec un code, et rien n\'est écrit', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = T0 + 200_000;
  const rep = await rendre(app, b.corps.id, { ...RAPPORT({ seconds: 60, rank: 1 }), netCents: 9999 });
  assert.strictEqual(rep.code, 400);
  assert.ok(rep.corps.erreurs.some(e => e.code === 'inconnu' && e.field === 'netCents'),
    JSON.stringify(rep.corps.erreurs));
  assert.strictEqual(db.matches[0].status, 'open', 'un rapport refusé à l\'analyse ne clôt rien');
  // Un rapport incomplet est refusé de la même façon, avec le code qui dit quoi corriger.
  const nu = await rendre(app, b.corps.id, { seconds: 10 });
  assert.strictEqual(nu.code, 400);
  assert.ok(nu.corps.erreurs.every(e => ['manquant', 'inconnu'].includes(e.code)));
});
await test('L\'ENVELOPPE RESTE, ET ELLE MORD SUR LES FAITS REJOUÉS : un résultat rendu trop tôt est refusé', async () => {
  // `matchVerdict` NE DISPARAÎT PAS avec le rejeu, et voici pourquoi elle vaut encore quelque
  // chose : le chronomètre du serveur compare la durée RECALCULÉE au temps réellement écoulé
  // depuis l'ouverture du billet. Une partie de cent quatre secondes rendue à l'instant même où le
  // billet s'ouvre n'a pas pu avoir lieu, quelle que soit la qualité de la trace qui l'accompagne.
  // Si le rejeu se trompait, ce contrôle-là serait le dernier à regarder le montant.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const p = partieDe(b);
  assert.ok(p.rapport.seconds > C.ENVELOPPE.margeHorlogeS - C.LOBBY.wait,
    `la partie du test (${p.rapport.seconds} s) est trop courte pour éprouver le chronomètre`);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = T0;
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.corps.status, 'rejected');
  assert.strictEqual(rep.corps.issue, 'refus');
  assert.strictEqual(rep.corps.controle, 'chronometre');
  assert.ok(rep.corps.motif && rep.corps.motif.length > 10, 'un refus doit dire pourquoi');
  assert.strictEqual(rep.corps.netCents, 0);
  // La mesure survit au refus : c'est elle qui fixera un seuil en phase 06.
  assert.strictEqual(rep.corps.ecartCents, p.rapport.declaredNetCents);
  assert.strictEqual(db.matches[0].status, 'rejected');
  // Et une partie refusée n'est ni réglée ni ouverte : aucune somme sur `status = 'settled'` ne la
  // verra jamais.
  assert.strictEqual(db.matches.filter(m => m.status === 'settled').length, 0);
});
await test('un rapport hors du domaine d\'un integer est refusé en 400, et le billet reste réglable', async () => {
  // LA PANNE, DE BOUT EN BOUT. `deaths`, `damage` et `declaredNetCents` n'avaient aucune borne
  // haute : un rapport parfaitement « valide » traversait toute la validation jusqu'à des colonnes
  // `integer`, Postgres levait `22003`, la route rendait 500 — et la ligne restait `open`. Comme un
  // joueur n'a qu'un billet ouvert à la fois, il était enfermé dans un billet mort pendant les
  // treize minutes de l'expiration, et sa partie n'était jamais enregistrée.
  //
  // Ce n'est pas le 400 qui compte dans ce test, c'est la SECONDE moitié : la ligne n'est pas
  // piégée, et un rapport honnête la règle juste après.
  for (const champ of ['deaths', 'damage', 'declaredNetCents']) {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app);
    const p = partieDe(b);
    const r = { ...p.rapport, [champ]: 3_000_000_000 };
    horloge.t = ARRIVEE(r);
    const ko = await rendre(app, b.corps.id, r);
    assert.strictEqual(ko.code, 400, `${champ} : attendu un refus motivé, pas un 500 muet`);
    assert.ok(ko.corps.erreurs.some(e => e.code === 'borne' && e.field === champ),
      `${champ} : ${JSON.stringify(ko.corps.erreurs)}`);
    assert.strictEqual(db.matches[0].status, 'open', `${champ} : la ligne a été close par un refus d'analyse`);

    const ok = (await jouerEtRendre(app, horloge, b)).rep;
    assert.strictEqual(ok.code, 200, `${champ} : le billet est resté piégé`);
    assert.strictEqual(ok.corps.status, 'settled', `${champ} : ${ok.corps.motif}`);
  }
});
await test('la doublure refuse désormais ce que Postgres refuserait', async () => {
  // Sans cette garde, la doublure était plus permissive que la base, et aucun test ne pouvait voir
  // la classe de bug ci-dessus. On l'éprouve directement : c'est la seule façon de prouver que la
  // doublure ment comme il faut.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  await assert.rejects(() => db.settleMatch({
    matchId: b.corps.id, userId: db.users[0].id, status: 'settled', settledAt: new Date(T0),
    issue: 'defaite', controle: null, motif: null,
    grossCents: 0, feeCents: 0, netCents: 0, purseCents: 0,
    declaredNetCents: 3_000_000_000, ecartCents: 3_000_000_000,
    seconds: 60, kills: 0, deaths: 0, rank: 5, cubes: 0, damage: 0, cashedOut: false,
    traceSteps: 1, replayDigest: 1, digestMatch: true, divergenceStep: null, replayMs: 1,
  }), e => e.code === '22003');
  assert.strictEqual(db.matches[0].status, 'open', 'une écriture refusée ne doit rien laisser derrière');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
test('tout champ du rapport qui finit dans une colonne integer porte sa borne', () => {
  // La garde qui attrape la PROCHAINE colonne ajoutée sans borne. Elle relie les deux moitiés du
  // dossier : le schéma déclare la largeur, WBCore la fait respecter, et rien entre les deux ne
  // permet d'oublier l'un des deux côtés.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const serpent = n => n.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  let vus = 0;
  for (const [nom, regle] of Object.entries(C.REPORT_FIELDS)) {
    if (regle.kind !== 'entier') continue;
    const col = serpent(nom);
    const decl = (sql.match(new RegExp('^[ \\t]*' + col + '\\b.*$', 'm')) || [])[0];
    assert.ok(decl, `« ${nom} » part en base mais la colonne ${col} n'existe pas`);
    assert.match(decl, /\binteger\b/, decl);
    assert.ok(Number.isInteger(regle.max) && regle.max <= 2147483647,
      `« ${nom} » écrit dans un integer sans borne haute : max = ${regle.max}`);
    vus++;
  }
  assert.ok(vus >= 8, `seulement ${vus} champs entiers vérifiés`);
});
await test('en Duo comme en Trio la ligne s\'équilibre : fee + net = brut, au périmètre du joueur', () => {
  // `gross_cents` et `fee_cents` décrivaient la TABLE — le pot, la commission de la maison — quand
  // `net_cents` décrivait le JOUEUR : en Duo la ligne stockée disait 2000 − 400 = 800, et il
  // manquait 800 c que personne n'écrivait nulle part. Qui réconcilie ces lignes lisait une
  // commission de 60 %. Depuis que le prix est la sacoche emportée, les trois montants sont au même
  // périmètre et la ligne se referme sur elle-même, dans les cinq modes.
  return Promise.all([['duo', 1], ['trio', 1], ['solo', 10], ['resurgence', 5], ['resurgenceDuo', 0.5]]
    .map(async ([cle, stake]) => {
      const { db, app, horloge } = bancDeBillet();
      const mode = C.MODES[cle];
      const b = await demander(app, { ...DEMANDE, mode: cle, stake });
      const { partie, rep } = await jouerEtRendre(app, horloge, b,
        mode.cashout ? { encaisser: 300 } : {});
      assert.strictEqual(rep.corps.status, 'settled', `${cle} : ${rep.corps.motif}`);
      assert.ok(partie.terminal, `${cle} : la partie rejouée n'atteint pas d'état terminal`);
      assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents, cle);
      // Le brut EST la sacoche que le rejeu a trouvée, jamais un forfait ni un nombre annoncé.
      assert.strictEqual(rep.corps.grossCents, rep.corps.purseCents, `${cle} : le brut n'est pas la sacoche`);
      // Et le plafond du lobby n'est jamais dépassé : la conservation de l'argent le garantit, elle
      // est assertée au règlement, et cette ligne-ci le constate de l'extérieur.
      assert.ok(rep.corps.netCents <= C.payoutCents(b.corps.stakeCents, mode).winnerCents, cle);
      assert.ok(rep.corps.purseCents <= C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents, cle);
      const ligne = db.matches[0];
      assert.strictEqual(ligne.fee_cents + ligne.net_cents, ligne.gross_cents, `${cle} : la ligne ne s'équilibre pas`);
      assert.strictEqual(ligne.digest_match, true, `${cle} : le rejeu n'a pas convergé`);
    }));
});
await test('la table du billet est FIGÉE : seats et teamSize sont recopiés dans la ligne', async () => {
  // Un résultat est accepté jusqu'à l'expiration du billet. Un serveur redémarré entre-temps avec
  // un `teams` corrigé jugerait la partie contre une table que personne n'a achetée : c'est la
  // seule raison d'être de ces deux colonnes, et `teamSize` manquait alors que le verdict borne
  // les kills et le rang avec lui.
  for (const cle of Object.keys(C.MODES)) {
    const { db, app } = bancDeBillet();
    const r = await demander(app, { ...DEMANDE, mode: cle });
    assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES[cle]), cle);
    assert.strictEqual(r.corps.teamSize, C.MODES[cle].teamSize, cle);
    assert.strictEqual(db.matches[0].seats, C.seatsOf(C.MODES[cle]), cle);
    assert.strictEqual(db.matches[0].team_size, C.MODES[cle].teamSize, cle);
  }
});
await test('le billet d\'un autre joueur est introuvable, et un billet inconnu aussi', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = T0 + 200_000;
  const voisin = await appel(app, {
    method: 'POST', path: `/api/match/${b.corps.id}/result`, token: 'ok:u2:Zoe',
    body: RAPPORT({ seconds: 60, rank: 1 }),
  });
  assert.strictEqual(voisin.code, 404, 'un identifiant deviné ne doit rien apprendre');
  assert.strictEqual(db.matches[0].status, 'open');
  const fantome = await rendre(app, '999999', RAPPORT({ seconds: 60, rank: 1 }));
  assert.strictEqual(fantome.code, 404);
});
await test('la route du résultat n\'accepte que POST, et son chemin n\'est pas un passe-partout', async () => {
  const { app } = bancDeBillet();
  for (const m of ['GET', 'PATCH', 'DELETE'])
    assert.strictEqual((await appel(app, { method: m, path: '/api/match/1/result', token: 'ok:u1:Loic' })).code, 405, m);
  for (const chemin of ['/api/match//result', '/api/match/abc/result', '/api/match/1/result/x', '/api/match/1'])
    assert.strictEqual((await appel(app, { method: 'POST', path: chemin, token: 'ok:u1:Loic' })).code, 404, chemin);
  // Sans jeton, rien ne passe : le refus vient avant la lecture du corps.
  const nu = await appel(app, { method: 'POST', path: '/api/match/1/result' });
  assert.strictEqual(nu.code, 401);
});
await test('le pré-vol annonce toujours les méthodes des deux routes de partie', async () => {
  const { app } = bancDeBillet();
  const r = await appel(app, { method: 'OPTIONS' });
  const methodes = String(r.head['access-control-allow-methods']).split(',');
  for (const m of ['GET', 'PATCH', 'POST', 'OPTIONS']) assert.ok(methodes.includes(m), m);
});
await test('le veilleur clôt les billets expirés, et seulement eux', async () => {
  const { db, app, horloge } = bancDeBillet();
  // Trois billets pour trois joueurs : l'un sera réglé, l'un périmera, l'un sera encore valable.
  const a = await demander(app);
  const regle = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u2:Zoe',
                                   body: { ...DEMANDE, clientKey: 'z-1' } });
  await jouerEtRendre(app, horloge, regle, { token: 'ok:u2:Zoe' });
  assert.strictEqual(db.matches[1].status, 'settled');

  // Personne ne clôt rien tant que rien n'a expiré : le veilleur passe à vide.
  assert.deepStrictEqual(await app.veiller(), { closes: 0 });
  assert.strictEqual(db.matches[0].status, 'open');

  const tard = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u3:Max',
                                  body: { ...DEMANDE, clientKey: 'm-1' } });
  // On avance jusqu'après l'expiration du premier billet, mais pas de celui qu'on vient d'ouvrir.
  horloge.t = Date.parse(a.corps.expiresAt) + 1;
  assert.ok(horloge.t < Date.parse(tard.corps.expiresAt));
  assert.deepStrictEqual(await app.veiller(), { closes: 1 });
  assert.strictEqual(db.matches[0].status, 'expired', 'le billet que personne n\'a terminé');
  assert.strictEqual(db.matches[1].status, 'settled', 'une partie réglée n\'est jamais rouverte ni reclose');
  assert.strictEqual(db.matches[2].status, 'open', 'un billet encore valable n\'est pas balayé');
  // Repassé deux fois, il ne clôt plus rien : il ferme une porte, il ne la claque pas en boucle.
  assert.deepStrictEqual(await app.veiller(), { closes: 0 });
});
await test('le veilleur n\'écrit aucun montant : il ferme une porte, il ne règle rien', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  await app.veiller();
  const ligne = db.matches[0];
  for (const col of ['net_cents', 'fee_cents', 'gross_cents', 'purse_cents', 'ecart_cents'])
    assert.strictEqual(ligne[col], undefined, `le veilleur a écrit ${col}`);
  assert.strictEqual(ligne.settled_at, undefined);
});
await test('chaque requête rejouée deux fois : mêmes lignes, mêmes réponses', async () => {
  // Le patron, appliqué à toutes les routes qui écrivent. Ce qui compte n'est pas qu'elles
  // répondent 200 deux fois, c'est que la seconde réponse soit la première, au caractère près, et
  // que la table n'ait pas bougé entre les deux.
  const { db, app, horloge } = bancDeBillet();
  const rejeux = [];
  const deuxFois = async (nom, envoi) => {
    const un = await envoi();
    const lignes = JSON.stringify(db.matches);
    const deux = await envoi();
    assert.deepStrictEqual(deux.corps, un.corps, nom);
    assert.strictEqual(JSON.stringify(db.matches), lignes, nom + ' : la table a bougé au rejeu');
    rejeux.push(nom);
  };
  await deuxFois('POST /api/match', () => demander(app));
  const b = await demander(app);
  const r = RAPPORT({ seconds: 154, rank: 1 });
  horloge.t = ARRIVEE(r);
  await deuxFois('POST /api/match/:id/result', () => rendre(app, b.corps.id, r));
  await deuxFois('POST /api/match/:id/result (refusé)', () => rendre(app, b.corps.id, r));
  assert.strictEqual(rejeux.length, 3);
  assert.strictEqual(db.matches.length, 1);
});
await test('la limitation de débit du résultat a son propre seau', async () => {
  const { app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await rendre(app, b.corps.id, p.rapport)).code);
  assert.deepStrictEqual(codes, [200, 200, 429], codes.join(','));
  // Le seau du billet, lui, n'a servi qu'une fois : demander une partie reste possible.
  assert.strictEqual((await demander(app, { ...DEMANDE, clientKey: 'cle-2' })).code, 200);
});

console.log('Les statistiques sont la somme des parties');
// Une partie entière, du billet au règlement, avec une horloge qui avance comme celle d'un joueur
// honnête. Chaque partie ouvre SON billet : un joueur n'en a qu'un ouvert à la fois, et c'est le
// règlement qui libère la place — donc enchaîner des parties éprouve aussi cela.
// Elle JOUE, désormais : le serveur ne croit plus aucun fait déclaré, donc une statistique ne peut
// plus se fabriquer avec un rapport écrit à la main. `encaisser` fait sortir le joueur avec sa
// sacoche — la seule sortie gagnante qu'un test puisse commander.
const jouer = async (app, horloge, cle, opts = {}, demande = DEMANDE) => {
  const b = await demander(app, { ...demande, clientKey: cle });
  return (await jouerEtRendre(app, horloge, b, opts)).rep;
};
const mesStats = async app => (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;

await test('les statistiques rendues sont exactement la somme des parties réglées', async () => {
  const { db, app, horloge } = bancDeBillet();
  assert.deepStrictEqual(await mesStats(app), { matches: 0, wins: 0, kills: 0, best: 0, divergences: 0 },
    'un compte neuf n\'a rien à initialiser : la somme d\'un ensemble vide vaut zéro');

  const gagnee = await jouer(app, horloge, 'p1', { encaisser: 300 }, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(gagnee.corps.status, 'settled');
  assert.strictEqual(gagnee.corps.issue, 'encaissement');
  const perdue = await jouer(app, horloge, 'p2');
  assert.strictEqual(perdue.corps.issue, 'defaite');

  // Les chiffres attendus ne sont PAS écrits à la main : ils sont ceux des parties réellement
  // jouées. Les écrire à la main reviendrait à décider du résultat d'une simulation.
  const reglees = db.matches.filter(m => m.status === 'settled');
  const s = await mesStats(app);
  assert.deepStrictEqual(s, {
    matches: 2, wins: 1,
    kills: reglees.reduce((t, m) => t + m.kills, 0),
    best: gagnee.corps.netCents,
    divergences: 0,
  });
  assert.ok(s.best > 0, 'aucune des deux parties n\'a rien rapporté : le test ne prouve plus rien');
  // Et rien nulle part ne ressemble à un compteur : la somme se refait à l'identique depuis les
  // lignes, ce qui est précisément la propriété qu'un double envoi ne peut pas casser.
  assert.strictEqual(s.matches, reglees.length);
});
await test('une partie refusée ou restée ouverte ne compte pour rien', async () => {
  const { db, app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1');
  const avant = await mesStats(app);

  // Refusée : la ligne est close avec son motif, et aucune somme ne la verra jamais. Le refus vient
  // du chronomètre du serveur, sur la durée RECALCULÉE — le rapport est sincère, c'est l'horloge
  // qui n'a pas eu le temps de contenir la partie.
  const b2 = await demander(app, { ...DEMANDE, clientKey: 'p2' });
  const p2 = partieDe(b2);
  await poserTrace(app, b2.corps.id, p2.segments);
  // Une seconde AVANT que l'horloge du serveur ne puisse contenir cette partie-là : c'est le bord
  // exact du contrôle, et il tient quelle que soit la durée que le rejeu a trouvée.
  horloge.t = Date.parse(b2.corps.openedAt)
            + (C.LOBBY.wait + p2.rapport.seconds - C.ENVELOPPE.margeHorlogeS - 1) * 1000;
  const refus = await rendre(app, b2.corps.id, p2.rapport);
  assert.strictEqual(refus.corps.status, 'rejected', JSON.stringify(refus.corps));
  assert.strictEqual(refus.corps.controle, 'chronometre');
  assert.deepStrictEqual(await mesStats(app), avant, 'une partie refusée a compté');

  // Restée ouverte : le billet est pris, la partie n'est jamais rendue. Elle ne vaut rien non plus,
  // sinon demander un billet suffirait à gonfler son compteur de parties.
  const ouvert = await demander(app, { ...DEMANDE, clientKey: 'p3' });
  assert.strictEqual(ouvert.code, 200);
  assert.deepStrictEqual(await mesStats(app), avant, 'un billet ouvert a compté');

  // Et périmée, pas davantage : le veilleur ferme une porte, il ne règle rien.
  horloge.t = Date.parse(ouvert.corps.expiresAt) + 1;
  assert.deepStrictEqual(await app.veiller(), { closes: 1 });
  assert.deepStrictEqual(await mesStats(app), avant, 'une partie périmée a compté');
  assert.strictEqual(db.matches.length, 3);
});
await test('best est le plus grand net en centimes, jamais le dernier ni une somme', async () => {
  const { app, horloge } = bancDeBillet();
  // Deux sorties gagnantes réellement jouées, sur deux tables : la grosse d'abord, la petite
  // ensuite. Les montants sortent des parties, pas du test.
  const grosse = (await jouer(app, horloge, 'p1', { encaisser: 300 },
                              { ...DEMANDE, mode: 'resurgence', stake: 10 })).corps.netCents;
  const petite0 = (await jouer(app, horloge, 'p2', { encaisser: 300 },
                               { ...DEMANDE, mode: 'resurgence', stake: 0.5 })).corps.netCents;
  assert.ok(grosse > petite0 && petite0 > 0, `${grosse} / ${petite0}`);
  // La plus modeste, jouée EN SECOND, ne doit RIEN changer : c'est un maximum, pas un dernier
  // résultat, et surtout pas un cumul.
  const s = await mesStats(app);
  assert.strictEqual(s.best, grosse);
  assert.notStrictEqual(s.best, grosse + petite0);
  // En centimes ENTIERS jusqu'au bout du réseau. La conversion en dollars n'a lieu qu'une fois,
  // côté jeu, dans `applyAccount` — que l'on vérifie ici brancher sur la même valeur.
  assert.ok(Number.isInteger(s.best));
  assert.strictEqual(C.applyAccount(null, { stats: s }, []).stats.best, C.fromCents(grosse));
});
await test('un encaissement Resurgence compte comme une sortie gagnante, comme dans le jeu', async () => {
  // `endMatch` incrémente `wins` dès que `won` est vrai, encaissement compris. Si le serveur
  // comptait autrement, se connecter ferait BAISSER le compteur d'un joueur de Resurgence.
  const { app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence', clientKey: 'p0' });
  const { rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(rep.corps.issue, 'encaissement');
  const s = await mesStats(app);
  assert.strictEqual(s.matches, 1);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.best, rep.corps.netCents);
});
await test('les parties d\'un joueur ne comptent que pour lui', async () => {
  const { db, app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1');
  const voisin = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u2:Zoe',
                                    body: { ...DEMANDE, clientKey: 'z-1' } });
  await jouerEtRendre(app, horloge, voisin, { token: 'ok:u2:Zoe' });
  const a = await mesStats(app);
  const z = (await appel(app, { token: 'ok:u2:Zoe' })).corps.stats;
  assert.strictEqual(a.matches, 1);
  assert.strictEqual(z.matches, 1);
  // Les deux parties ont des graines différentes, donc des comptes différents : ce qui se vérifie
  // ici est que chacun ne voit QUE sa ligne.
  assert.strictEqual(a.kills, db.matches[0].kills);
  assert.strictEqual(z.kills, db.matches[1].kills);
});
await test('des statistiques rendues en chaînes par la base ressortent en nombres', async () => {
  // `count()` et `sum()` rendent un `bigint`, que le pilote Postgres livre sous forme de CHAÎNE —
  // le même piège que les graines, en pire : une graine en chaîne fait repartir le jeu sur la
  // sienne, une statistique en chaîne ne se voit qu'à l'écran, des semaines plus tard. La doublure
  // ment donc ici comme le vrai pilote, plutôt que comme l'idée qu'on s'en fait.
  const db = fakeDb();
  const brute = db.findOrCreate;
  db.findOrCreate = async a => ({
    user: (await brute(a)).user,
    stats: { matches: '2', wins: '1', kills: '9', best: '160', divergences: '0' },
  });
  const r = await appel(appDe(db), { token: 'ok:u1:Loic' });
  for (const [k, v] of Object.entries(r.corps.stats)) assert.strictEqual(typeof v, 'number', k);
  assert.deepStrictEqual(r.corps.stats, { matches: 2, wins: 1, kills: 9, best: 160, divergences: 0 });
  assert.strictEqual(C.applyAccount(null, r.corps, []).stats.best, C.fromCents(160));
});
test('toute colonne dont db-pg.js parle existe encore dans le schéma', () => {
  // Première des deux gardes AU NIVEAU DU TEXTE. Aucune base ne tourne : elle attrape la dérive
  // entre la doublure et Postgres là où elle est la plus probable aujourd'hui — une requête restée
  // en arrière après la disparition d'une table, qui ne planterait qu'au premier déploiement.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const mots = t => new Set(t.match(/\b[a-z_][a-z0-9_]*\b/g) || []);
  const schema = mots(sql);
  // Les requêtes, c'est-à-dire les littéraux entre accents graves plus les listes de colonnes
  // qu'ils interpolent. On retire les interpolations (du code, pas des colonnes — les deux listes
  // sont relues à part), les alias (`as parties`) et les chaînes ('settled').
  const listes = (pg.match(/^const \w+ =[^;]*;/gm) || []).join(' ').replace(/'/g, ' ');
  const corps = (pg.match(/`[^`]*`/g) || []).join(' ')
    .replace(/\$\{[^}]*\}/g, ' ').replace(/'[^']*'/g, ' ');
  const SQL = new Set(['const', 'select', 'from', 'where', 'and', 'or', 'in', 'is', 'not', 'null',
    'insert', 'into', 'values', 'on', 'conflict', 'do', 'nothing', 'returning', 'update', 'set',
    'order', 'by', 'limit', 'count', 'sum', 'max', 'coalesce', 'filter', 'as', 'now',
    'true', 'false']);
  const utilises = mots((listes + ' ' + corps).replace(/\bas\s+\w+/g, ' '));
  assert.ok(utilises.size > 20, `seulement ${utilises.size} identifiants retrouvés dans db-pg.js`);
  for (const mot of utilises)
    if (!SQL.has(mot)) assert.ok(schema.has(mot), `db-pg.js parle de « ${mot} », absent de schema.sql`);
});
test('aucun compteur nulle part, et l\'agrégat ne lit que les parties réglées', () => {
  // Le revirement se vérifie, il ne se raconte pas : un compteur qu'on incrémente est une case
  // qu'on écrase, et un double envoi la fausse pour toujours. La raison est dans
  // docs/HISTORIQUE.md, à sa place — une décision renversée, pas une ligne de module.
  const fs = require('node:fs'), path = require('node:path');
  for (const f of ['schema.sql', 'db-pg.js', 'app.js', 'README.md'])
    assert.ok(!/user_stats/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')),
      `${f} parle encore d'une table de compteurs`);
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.deepStrictEqual((sql.match(/create table if not exists (\w+)/g) || []).sort(),
    ['create table if not exists match_traces', 'create table if not exists matches',
     'create table if not exists users']);
  // « Une partie refusée ou restée ouverte ne compte pour rien » se prouve plus haut contre la
  // doublure ; la vraie requête, elle, n'est jamais exécutée par un test. On relit donc son texte.
  // Les commentaires sont retirés d'abord : ils citent `count()` et `sum()` entre accents graves,
  // et une garde qui prend un commentaire pour une requête ne garde rien. C'est arrivé en
  // écrivant ce test, exactement comme au module précédent.
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  // La trace compte elle aussi ses lignes, et c'est un garde-fou de volume, pas une statistique de
  // joueur : on ne retient donc que ce qui agrège la table `matches`.
  const agregat = (pg.match(/`[^`]*`/g) || [])
    .filter(q => /\bcount\s*\(/i.test(q) && /from\s+matches\b/.test(q));
  assert.strictEqual(agregat.length, 1, 'une seule requête doit agréger les statistiques');
  assert.match(agregat[0], /from\s+matches/);
  assert.match(agregat[0], /status\s*=\s*'settled'/, 'l\'agrégat compterait des parties non réglées');
});

console.log('Le serveur partage les règles du jeu');
test('la garde de démarrage couvre TOUS les noms de WBCore qu\'app.js appelle', () => {
  // La garde ne listait que les quatre noms de la phase 01. La disparition de `zonePlan` ou de
  // `matchVerdict` — appelés seulement dans les gestionnaires — ne cassait donc plus au démarrage
  // mais à la première requête d'un joueur, en 500 : très exactement la panne que cette garde
  // existe pour empêcher. Même doctrine que les gardes textuelles sur schema.sql et db-pg.js, et
  // même mode de défaillance qu'elles attrapent — la dérive par oubli.
  const fs = require('node:fs'), path = require('node:path');
  const lire = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const app = lire('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const noyau = lire('core.js');
  const liste = noyau.slice(noyau.indexOf('const ATTENDUS'), noyau.indexOf('for (const nom of ATTENDUS)'));
  assert.ok(liste.length > 100, 'la liste de la garde n\'a pas été retrouvée dans core.js');
  const utilises = [...new Set((app.match(/\bC\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(2)))];
  assert.ok(utilises.length >= 12, `seulement ${utilises.length} noms de WBCore retrouvés dans app.js`);
  for (const nom of utilises)
    assert.ok(liste.includes(`'${nom}'`), `app.js appelle C.${nom}, que la garde de core.js ne couvre pas`);
});
test('WBCore est chargé depuis index.html, pas recopié', () => {
  assert.strictEqual(typeof C.nameKey, 'function');
  assert.strictEqual(C.nameKey('Loïc'), C.nameKey('LOIC'));
  assert.ok(C.BRAWLERS.bolt, 'les brawlers du jeu sont visibles côté serveur');
});
test('le jeu et le serveur désignent le même Crossmint, environnement par environnement', () => {
  // Deux adresses écrites à deux endroits finissent toujours par diverger. Le jeu déduit la sienne
  // du préfixe de sa clé « ck_ », le serveur de sa clé « sk_ » : ce test est le seul garde-fou.
  const { crossmintBaseUrl } = require('./crossmint-key');
  for (const env of ['development', 'staging', 'production'])
    assert.strictEqual(C.crossmintApi(`ck_${env}_abc`), crossmintBaseUrl(env), env);
});
test('le serveur exige le destinataire que le jeu ne peut pas choisir', () => {
  // Le jeu ne fabrique jamais de jeton : il reçoit celui de Crossmint et le transmet. L'identifiant
  // de projet qui sert de destinataire vient de la clé serveur, hors de portée du navigateur.
  const a = autorite();
  const cle = parseApiKey(fabriqueCle(a, { projectId: PROJET }), { usageOrigin: 'server', signers: a.signers });
  assert.strictEqual(cle.projectId, PROJET);
  assert.throws(() => identityFromClaims(revendications({ aud: 'un_projet_choisi_par_le_client' }),
    { projectId: cle.projectId }));
});

console.log('Le serveur charge la simulation du jeu, il ne la recopie pas');
// Le bloc SIM, chargé UNE SECONDE FOIS et à la façon du navigateur : son propre WBCore, extrait du
// même index.html, et le bloc évalué par-dessus. Ce n'est pas une doublure — c'est le même texte,
// dans un module qui ne partage rien avec `api/sim.js`. C'est ce qui permet de dire, et pas
// seulement d'affirmer, que le serveur et le jeu exécutent le même code.
const NAVIGATEUR = (() => {
  const fs = require('node:fs'), path = require('node:path');
  const f = process.env.WARBLOCK_FILE || path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(f, 'utf8');
  const noyau = html.slice(html.indexOf('/*CORE-START*/'), html.indexOf('/*CORE-END*/'));
  const bloc = html.slice(html.indexOf('/*SIM-START*/'), html.indexOf('/*SIM-END*/'));
  const mc = { exports: {} }; new Function('module', 'exports', noyau)(mc, mc.exports);
  const ms = { exports: {} }; new Function('module', 'exports', 'WBCore', bloc)(ms, ms.exports, mc.exports);
  return { C: mc.exports, S: ms.exports, html };
})();

// Une trace fabriquée par le codec de WBCore, jamais écrite à la main : c'est la seule porte, et
// l'écrire à la main ferait deux idées du format — c'est toujours la seconde qui ment.
function traceDe(C, pas, options = {}) {
  const rec = C.traceEnregistreur(options.max || 400000);
  const rng = C.makeRng(options.graine || 4242);
  for (let i = 0; i < pas; i++) {
    if (options.actes && i && i % options.actes === 0)
      rec.acte(C.TRACE.SUP, C.traceViseeMots(Math.cos(i), Math.sin(i), 4));
    const a = options.fixe ? 1 : rng() * Math.PI * 2;
    rec.ajouter(C.traceMots({ mx: Math.cos(a), mz: Math.sin(a), ax: Math.cos(a), az: Math.sin(a),
                              aimDist: options.fixe ? 4 : 3 + rng() * 4,
                              feu: options.fixe ? true : rng() < 0.7 }));
  }
  return rec;
}
// La même partie, rejouée par un couple (WBCore, WBSim) donné. Rien d'autre que la graine publique
// du billet et la trace des entrées du joueur n'entre ici : c'est exactement ce que le module
// suivant aura sous la main au moment de juger.
function empreinteDe(coeur, simu, texte) {
  const G = simu.newMatch(31337, coeur.MODES.solo, 50, coeur.BRAWLERS.bolt);
  const depart = { x: G.player.x, z: G.player.z };
  const lu = coeur.traceDecode(texte);
  assert.strictEqual(lu.erreur, null, 'la trace ne se relit pas : ' + lu.erreur);
  simu.rejouer(G, lu.items);
  return { empreinte: simu.empreinte(G), pas: G.pas,
           // De quoi dire que la partie a VÉCU, et pas seulement qu'elle a tourné : le brawler a
           // bougé, il a tiré, et le gaz s'est refermé sur lui.
           parcouru: Math.round(coeur.dist(G.player.x - depart.x, G.player.z - depart.z) * 100),
           morts: G.ents.filter(e => !e.alive).length,
           cercle: Math.round(G.zone.r * 100) };
}

test('api/sim.js charge le MÊME bloc que le navigateur, et il n\'en existe pas de seconde copie', () => {
  assert.strictEqual(typeof SIM.step, 'function');
  assert.strictEqual(SIM.SIM_VERSION, NAVIGATEUR.S.SIM_VERSION);
  // Le serveur ne redéfinit rien : le fichier n'est qu'un chargeur, calqué sur api/core.js. S'il
  // contenait une règle, elle serait la seconde copie — le patron du `respawn()` défini deux fois.
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'sim.js'), 'utf8');
  assert.match(src, /SIM-START/);
  assert.match(src, /new Function\('module', 'exports', 'WBCore'/);
  assert.ok(!/function (step|newMatch|moveEntity|attack|rejouer)\s*\(/.test(src),
    'api/sim.js redéfinit une fonction de simulation au lieu de charger le bloc');
});
test('LE REJEU DU SERVEUR ET CELUI DU JEU RENDENT LA MÊME EMPREINTE — c\'est le même bloc, chargé deux fois', () => {
  // L'invariant central de la phase, et la raison est dans le titre : il n'y a pas deux
  // simulations à réconcilier, il y a un bloc de texte dans index.html que deux chargeurs évaluent.
  // Ce que ce test prouve, c'est que le chargeur du serveur n'a rien perdu en route — pas que deux
  // MOTEURS JavaScript s'accordent, ce que rien ici ne peut montrer et que la spécification se
  // garde bien de promettre.
  const texte = traceDe(C, 4000, { actes: 137 }).texte();
  const serveur = empreinteDe(C, SIM, texte);
  const navigateur = empreinteDe(NAVIGATEUR.C, NAVIGATEUR.S, texte);
  // Le compte à rebours d'intro est posé par `newMatch` des DEUX côtés, et il consomme ses pas sans
  // faire avancer `G.pas` : c'est exactement ce que le serveur doit reposer, sinon il rejouerait
  // ces pas-là pour de vrai et jugerait une autre partie que celle qui s'est affichée.
  assert.strictEqual(serveur.pas, 4000 - PAS_INTRO);
  assert.ok(PAS_INTRO > 0, 'le décompte d\'intro a disparu de newMatch : le rejeu du serveur dérive');
  assert.deepStrictEqual(serveur, navigateur, 'les deux chargements ne rejouent pas la même partie');
  // Et la partie rejouée a VÉCU : sans ces bornes, deux parties vides rendraient aussi la même
  // empreinte, et le test passerait sur un bloc à moitié chargé.
  assert.ok(serveur.parcouru > 100, 'le brawler du rejeu n\'a pas bougé d\'une case');
  assert.ok(serveur.morts > 0, 'personne n\'est mort en 4000 pas : la simulation ne tourne pas');
  // La trace est bien le chaînon manquant : la même graine, sans elle, ne rejoue pas la même partie.
  const immobile = SIM.newMatch(31337, C.MODES.solo, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < 4000; i++) SIM.step(immobile, {});
  assert.notStrictEqual(SIM.empreinte(immobile), serveur.empreinte,
    'un joueur immobile rend la même partie qu\'un joueur qui joue : la trace ne sert à rien');
});
test('la garde de démarrage d\'api/sim.js casse BRUYAMMENT si un nom exporté disparaît', () => {
  // La même garde que celle de core.js, et pour la même raison : si le bloc change de forme, on veut
  // casser au démarrage du serveur, pas à la première requête d'un joueur un dimanche soir. On le
  // vérifie en amputant vraiment le bloc, pas en relisant la liste — une liste est toujours
  // d'accord avec ce qu'on veut lui faire dire.
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const ampute = NAVIGATEUR.html.replace('newMatch, step, drainer,', 'step, drainer,');
  assert.notStrictEqual(ampute, NAVIGATEUR.html, 'la ligne d\'export du bloc SIM n\'a pas été retrouvée');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'warblock-'));
  const tmp = path.join(dossier, 'index.html');
  fs.writeFileSync(tmp, ampute);
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', 'require("./sim.js")'],
    { env: { ...process.env, WARBLOCK_FILE: tmp }, cwd: __dirname, encoding: 'utf8' });
  fs.rmSync(dossier, { recursive: true, force: true });
  assert.notStrictEqual(r.status, 0, 'un export disparu doit faire échouer le chargement');
  assert.match(r.stderr, /WBSim n'exporte plus newMatch/, r.stderr);
});
test('la garde d\'api/sim.js couvre TOUS les noms de WBSim qu\'app.js appelle', () => {
  // Le patron déjà en place pour core.js : une garde qui ne couvre pas ce que les gestionnaires
  // consomment déplace la panne du démarrage vers la première requête d'un joueur.
  const fs = require('node:fs'), path = require('node:path');
  const lire = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const app = lire('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const src = lire('sim.js');
  const liste = src.slice(src.indexOf('const ATTENDUS'), src.indexOf('for (const nom of ATTENDUS)'));
  assert.ok(liste.length > 40, 'la liste de la garde n\'a pas été retrouvée dans sim.js');
  const utilises = [...new Set((app.match(/\bS\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(2)))];
  assert.ok(utilises.length >= 1, 'app.js n\'appelle aucun nom de WBSim : la garde ne garde rien');
  for (const nom of utilises)
    assert.ok(liste.includes(`'${nom}'`), `app.js appelle S.${nom}, que la garde de sim.js ne couvre pas`);
  // Et le contrat public du bloc y figure en entier : c'est lui que le module du rejeu consommera.
  for (const nom of ['SIM_VERSION', 'newMatch', 'step', 'empreinte', 'rejouer', 'appliquerActe'])
    assert.ok(liste.includes(`'${nom}'`), `le contrat public de WBSim ne couvre pas ${nom}`);
});

console.log('sim_version, figée à l\'ouverture du billet');
await test('sim_version est écrite par le SERVEUR, et un corps qui la porte n\'y change rien', async () => {
  // Le patron déjà éprouvé sur les graines et les sièges : deux bancs, mêmes horloge et mêmes
  // sources, et deux lignes qui doivent être indiscernables. La raison est celle de `seats` et de
  // `team_size` : un correctif de simulation déployé pendant qu'un joueur joue rejouerait une AUTRE
  // partie que la sienne, et paierait autre chose que ce qu'il a vu.
  const nu = bancDeBillet(), charge = bancDeBillet();
  const a = await demander(nu.app, DEMANDE);
  const b = await demander(charge.app, { ...DEMANDE, simVersion: 999, sim_version: 999, simversion: 999 });
  assert.strictEqual(nu.db.matches[0].sim_version, SIM.SIM_VERSION);
  assert.deepStrictEqual(charge.db.matches, nu.db.matches, 'le client a écrit la version de simulation');
  assert.deepStrictEqual(b.corps, a.corps);
  // Elle ne part PAS au client : il n'en a rien à faire, et la lui donner l'inviterait à la renvoyer
  // telle quelle au lieu de dire celle sous laquelle il a réellement joué.
  assert.ok(!('simVersion' in a.corps), JSON.stringify(a.corps));
  assert.ok(Number.isInteger(SIM.SIM_VERSION) && SIM.SIM_VERSION >= 1);
});

console.log('La trace, en insertion seule');
const MAX_PAS = C.traceMaxSteps(C.zonePlan(GRAINES[0], C.MODES.solo));
const TEXTE = traceDe(C, 400).texte();
const envoyerTrace = (app, id, corps, opts = {}) =>
  appel(app, { method: 'POST', path: `/api/match/${id}/trace`, token: 'ok:u1:Loic', body: corps, ...opts });
const SEGMENT = (extra = {}) => ({ seq: 0, simVersion: SIM.SIM_VERSION, data: TEXTE, ...extra });

await test('un segment est accepté, et le serveur COMPTE ses pas au lieu de les croire', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  // Un nombre de pas annoncé n'a aucun effet : il n'est même pas lu. Le serveur relit la grammaire,
  // ce qui valide le segment et en donne la longueur du même coup — un nombre déclaré aurait été un
  // nombre de plus à ne pas croire.
  const r = await envoyerTrace(app, b.corps.id, SEGMENT({ steps: 999999, totalSteps: 1 }));
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.deepStrictEqual(r.corps, { matchId: b.corps.id, seq: 0, segments: 1, totalSteps: 400 });
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].steps, 400);
  assert.strictEqual(db.traces[0].sim_version, SIM.SIM_VERSION);
  assert.strictEqual(db.traces[0].data, TEXTE);
  // Et la ligne du billet n'a pas bougé d'un octet : cette route n'écrit jamais dans `matches`.
  assert.strictEqual(db.matches[0].status, 'open');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
await test('IDEMPOTENCE : le même segment deux fois n\'écrit qu\'une ligne, et le PREMIER écrit gagne', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const un = await envoyerTrace(app, b.corps.id, SEGMENT());
  const lignes = JSON.stringify(db.traces);
  const deux = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.deepStrictEqual(deux.corps, un.corps, 'un rejeu doit rendre exactement la première réponse');
  assert.strictEqual(JSON.stringify(db.traces), lignes, 'la table a bougé au rejeu');
  // Et un segment DIFFÉRENT sous le même rang ne remplace rien : premier écrit gagne. Sans cela, un
  // client pourrait réécrire sa trace après coup, ce qui la viderait de toute valeur de preuve.
  //
  // IL EST DÉSORMAIS REFUSÉ, ET NOMMÉ, au lieu d'être avalé en silence. Avalé, il permettait de
  // COUDRE deux parties bout à bout : le segment 0 d'une tentative et les segments suivants d'une
  // autre se recollaient en une partie que personne n'a jouée, et le serveur écrivait un montant
  // dessus. Le premier écrit gagne toujours — la ligne posée ne bouge pas d'un caractère — mais le
  // client apprend enfin que son segment n'a pas été pris.
  const menteur = await envoyerTrace(app, b.corps.id, SEGMENT({ data: traceDe(C, 120, { graine: 9 }).texte() }));
  assert.strictEqual(menteur.code, 409, JSON.stringify(menteur.corps));
  assert.strictEqual(menteur.corps.code, 'trace_divergente');
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].data, TEXTE, 'la première trace a été réécrite');
  assert.strictEqual(db.traces[0].steps, 400);
});
await test('UN SEGMENT D\'ACTES SEULS EST ACCEPTÉ : sans lui, l\'acte terminal n\'arrive jamais', async () => {
  // LE DÉFAUT. La route refusait tout segment dont le décompte de pas était nul (`!lu.pas`). Or le
  // découpage coupe au JETON, et un jeton d'action ponctuelle ne compte aucun pas : quand la
  // frontière des 24 000 caractères tombe juste avant le dernier geste, le segment de queue ne
  // porte que l'abandon ou l'encaissement. L'envoi s'arrêtant au premier refus, l'acte terminal
  // n'arrivait jamais, le rejeu s'arrêtait avant la fin et la route répondait `non_terminal` :
  // aucun montant, billet laissé au veilleur, sur une partie parfaitement honnête.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  // Une vraie partie qui se termine par un encaissement, découpée À LA MAIN sur la frontière : le
  // dernier jeton part seul, exactement comme `segments()` le ferait si la coupe tombait là.
  const p = partieDe(b, { encaisser: 300 });
  const texte = p.segments.join('');
  const coupe = texte.lastIndexOf('!');
  assert.ok(coupe > 0, 'la partie du test ne finit pas sur un jeton d\'acte');
  const plein = texte.slice(0, coupe), queue = texte.slice(coupe);
  assert.strictEqual(C.traceDecode(queue).pas, 0, 'le segment de queue porte des pas : le cas n\'est pas celui-là');

  const un = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: plein });
  assert.strictEqual(un.code, 200, JSON.stringify(un.corps));
  const deux = await envoyerTrace(app, b.corps.id, { seq: 1, simVersion: SIM.SIM_VERSION, data: queue });
  assert.strictEqual(deux.code, 200, JSON.stringify(deux.corps));
  assert.strictEqual(db.traces[1].steps, 0, 'la ligne doit s\'écrire avec zéro pas, et la colonne l\'accepter');
  assert.strictEqual(deux.corps.totalSteps, p.pas);

  // ET LE RÈGLEMENT ATTEINT BIEN UN ÉTAT TERMINAL. C'est la conséquence, et c'est elle qui compte :
  // sans le second segment, le rejeu s'arrêtait avant l'encaissement et refusait en `non_terminal`.
  horloge.t = ARRIVEE(p.rapport);
  const r = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                               token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.issue, 'encaissement');
  assert.ok(r.corps.netCents > 0, 'la partie n\'a rien payé');
  // La contre-épreuve : le même dossier SANS la queue ne se règle pas, et le refus se nomme.
  const sans = bancDeBillet();
  const b2 = await demander(sans.app, { ...DEMANDE, mode: 'resurgence' });
  await envoyerTrace(sans.app, b2.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: plein });
  sans.horloge.t = Date.parse(b2.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000;
  const rr = await appel(sans.app, { method: 'POST', path: `/api/match/${b2.corps.id}/result`,
                                     token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(rr.code, 409, JSON.stringify(rr.corps));
  assert.strictEqual(rr.corps.code, 'non_terminal');
});
await test('DEUX TENTATIVES NE SE COUSENT PAS : un rang déjà posé qui change de données est refusé', async () => {
  // La seconde moitié du même défaut, et la plus vicieuse parce qu'elle arrive sans mauvaise
  // volonté : le premier segment passe, le second échoue, la tentative suivante renvoie son seq 0
  // que `on conflict do nothing` avalait en silence, et ses segments 1..n s'ajoutaient derrière le
  // segment 0 de la tentative précédente. Le serveur rejouait alors une partie RECOLLÉE de deux
  // parties différentes — soit `non_terminal` pour toujours, soit un montant écrit sur une partie
  // que personne n'a jouée.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const A = [traceDe(C, 400).texte(), traceDe(C, 300, { graine: 11 }).texte()];
  const B = [traceDe(C, 400, { graine: 22 }).texte(), traceDe(C, 300, { graine: 33 }).texte()];
  assert.notStrictEqual(A[0], B[0]);
  assert.strictEqual((await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: A[0] })).code, 200);
  // La tentative suivante repart de son propre seq 0 : c'est là que la couture se ferait.
  const collision = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: B[0] });
  assert.strictEqual(collision.code, 409, JSON.stringify(collision.corps));
  assert.strictEqual(collision.corps.code, 'trace_divergente');
  // Le premier écrit gagne toujours — la ligne posée n'a pas bougé d'un caractère — mais le client
  // l'apprend, et son envoi s'arrête là au lieu de coudre la suite derrière.
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].data, A[0]);
  // Renvoyer le MÊME segment reste parfaitement idempotent : c'est la même tentative.
  assert.strictEqual((await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: A[0] })).code, 200);
  assert.strictEqual(db.traces.length, 1);
  // Et la trace refusée n'a rien touché du billet : cette route n'écrit jamais dans `matches`.
  assert.strictEqual(db.matches[0].status, 'open');
});
await test('une partie complète tient en UN À TROIS segments, qui se recollent et s\'additionnent', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const rec = traceDe(C, 9000, { actes: 500 });
  const segs = rec.segments();
  assert.ok(segs.length >= 1 && segs.length <= 3, `${segs.length} segments pour une partie complète`);
  let dernier = null;
  for (let i = 0; i < segs.length; i++) {
    dernier = await envoyerTrace(app, b.corps.id, { seq: i, simVersion: SIM.SIM_VERSION, data: segs[i] });
    assert.strictEqual(dernier.code, 200, JSON.stringify(dernier.corps));
  }
  assert.strictEqual(dernier.corps.segments, segs.length);
  assert.strictEqual(dernier.corps.totalSteps, 9000);
  // Recollés dans l'ordre des rangs, ils rendent la trace entière — celle que le rejeu relira.
  const recolle = db.traces.slice().sort((x, y) => x.seq - y.seq).map(t => t.data).join('');
  assert.strictEqual(recolle, rec.texte());
  assert.strictEqual(C.traceDecode(recolle).pas, 9000);
});
await test('chaque refus a un CODE NOMMÉ, sort en 400 ou 409, et ne laisse jamais la ligne bloquée', async () => {
  // La leçon du `22003`, transposée à la trace : un joueur n'a qu'un billet ouvert à la fois, donc
  // un 500 qui laisse la ligne `open` l'enferme jusqu'à l'expiration. Ici c'est structurel — cette
  // route n'écrit jamais dans `matches` — et chaque refus se nomme.
  // Un seau large : ce test envoie une vingtaine de requêtes, et ce n'est pas la limitation de
  // débit qu'il éprouve — elle a le sien, juste en dessous.
  const { db, app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 100, windowMs: 60_000 }) });
  const b = await demander(app);
  const cas = [
    ['corps',       '{ pas du json',                                   400],
    ['corps',       { ...SEGMENT(), data: 'A'.repeat(40 * 1024) },     400],
    ['seq',         SEGMENT({ seq: -1 }),                              400],
    ['seq',         SEGMENT({ seq: C.TRACE.MAX_SEG }),                 400],
    ['seq',         SEGMENT({ seq: 1.5 }),                             400],
    ['seq',         SEGMENT({ seq: '0' }),                             400],
    ['sim_version', SEGMENT({ simVersion: SIM.SIM_VERSION + 1 }),      409],
    ['sim_version', SEGMENT({ simVersion: undefined }),                409],
    ['donnees',     SEGMENT({ data: 'pas une trace du tout' }),        400],
    ['donnees',     SEGMENT({ data: '' }),                             400],
    ['donnees',     SEGMENT({ data: 42 }),                             400],
    ['trop_de_pas', SEGMENT({ data: traceDe(C, 40).texte() + '~___' }), 400],
  ];
  for (const [code, corps, attendu] of cas) {
    const r = await envoyerTrace(app, b.corps.id, corps);
    assert.strictEqual(r.code, attendu, `${code} : reçu ${r.code} — ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, code, JSON.stringify(r.corps));
    assert.ok(r.corps.erreur && r.corps.erreur.length > 8, `${code} : un refus doit dire pourquoi`);
    assert.strictEqual(db.traces.length, 0, `${code} : une trace refusée a été écrite`);
    assert.strictEqual(db.matches[0].status, 'open', `${code} : la ligne du billet a été touchée`);
  }
  // Un billet qui n'est pas le sien, ou qui n'existe pas : 404, et rien n'est appris de personne.
  const voisin = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/trace`,
                                    token: 'ok:u2:Zoe', body: SEGMENT() });
  assert.strictEqual(voisin.code, 404);
  assert.strictEqual((await envoyerTrace(app, '999999', SEGMENT())).code, 404);
  // Un billet déjà réglé n'accepte plus rien : la partie a son verdict, une trace n'y changerait
  // rien. Il faut donc le régler pour de bon, c'est-à-dire jouer — et la trace de CETTE partie-là
  // est retirée avant de vérifier qu'un segment de plus ne s'écrit pas.
  await jouerEtRendre(app, horloge, b);
  db.traces.length = 0;
  const clos = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.strictEqual(clos.code, 409);
  assert.strictEqual(clos.corps.code, 'billet_clos');
  assert.strictEqual(db.traces.length, 0);
  // Et un billet périmé non plus — sans être clos par cette route, qui ne touche pas `matches` : le
  // veilleur de la 02a fait déjà ce travail, et un second endroit qui clôt une ligne serait un
  // second endroit à surveiller.
  const suite = bancDeBillet();
  const c = await demander(suite.app, { ...DEMANDE, clientKey: 'cle-x' });
  suite.horloge.t = Date.parse(c.corps.expiresAt) + 1;
  const perime = await envoyerTrace(suite.app, c.corps.id, SEGMENT());
  assert.strictEqual(perime.code, 409);
  assert.strictEqual(perime.corps.code, 'expire');
  assert.strictEqual(suite.db.matches[0].status, 'open', 'la route de trace a écrit dans matches');
});
await test('la borne de pas vient du PLAN DE ZONE du billet, et le total la respecte', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  // Une trace longue mais compressible — un joueur qui ne change pas de geste — pour éprouver la
  // borne de PAS et non celle du corps : les deux existent, elles ne disent pas la même chose.
  const gros = traceDe(C, MAX_PAS - 10, { fixe: true });
  const un = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: gros.texte() });
  assert.strictEqual(un.code, 200, JSON.stringify(un.corps));
  assert.strictEqual(un.corps.totalSteps, MAX_PAS - 10);
  const trop = await envoyerTrace(app, b.corps.id,
    { seq: 1, simVersion: SIM.SIM_VERSION, data: traceDe(C, 100, { graine: 3 }).texte() });
  assert.strictEqual(trop.code, 400);
  assert.strictEqual(trop.corps.code, 'trop_de_pas');
  assert.strictEqual(db.traces.length, 1, 'le segment de trop a été écrit quand même');
  assert.strictEqual(db.matches[0].status, 'open');
  // Le rejeu d'un segment DÉJÀ écrit reste accepté même à la borne : sinon une réponse perdue
  // enfermerait le joueur, ce que toute cette route existe pour éviter.
  const rejeu = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: gros.texte() });
  assert.deepStrictEqual(rejeu.corps, un.corps);
  assert.strictEqual(db.traces.length, 1);
});
await test('MAX_BODY vaut toujours 4 Ko partout, et la borne large ne vaut QUE sur la trace', async () => {
  // La route qui décide d'un règlement garde sa borne. Relever celle de tout le monde ferait de la
  // route de l'argent la surface d'attaque la plus large de l'API, et « la raison est écrite » n'est
  // pas une protection. La garde est double : le chiffre, et un gros corps qui passe sur la trace
  // et sur elle seule.
  const { MAX_BODY, MAX_TRACE_BODY } = require('./app');
  assert.strictEqual(MAX_BODY, 4 * 1024);
  assert.ok(MAX_TRACE_BODY > MAX_BODY);
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.match(src, /const MAX_BODY = 4 \* 1024;/);
  // `lireCorps` prend sa borne en ARGUMENT, et un seul appel la relève : celui de la trace.
  const larges = (src.match(/lireCorps\(req[^)]*\)/g) || []).filter(a => a.includes('MAX_TRACE_BODY'));
  assert.strictEqual(larges.length, 1, 'plus d\'une route lit un corps large : ' + larges.join(' | '));
  const { app } = bancDeBillet();
  const b = await demander(app);
  // Le même corps de huit kilo-octets : refusé sur le profil, LU sur la trace — où il est refusé sur
  // le fond et non sur la taille, ce qui prouve qu'il est bien arrivé jusqu'à la lecture.
  const bourre = 'x'.repeat(8 * 1024);
  const profil = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: bourre } });
  assert.strictEqual(profil.code, 400);
  const trace = await envoyerTrace(app, b.corps.id, SEGMENT({ data: bourre }));
  assert.strictEqual(trace.corps.code, 'donnees', 'un corps de 8 Ko doit atteindre la route de trace');
});
test('match_traces est en INSERTION SEULE : aucun update, aucun delete, nulle part', () => {
  // Garde textuelle, et elle porte sur les deux côtés : le schéma et le pilote. Aucune base ne
  // tourne, donc c'est tout ce qu'on peut prouver — et il faut le dire : un test qui passe contre la
  // doublure prouve la doublure, pas Postgres.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.match(sql, /create table if not exists match_traces/);
  assert.match(sql, /primary key \(match_id, seq\)/, 'la clé qui arbitre le premier-écrit-gagne a disparu');
  for (const q of (pg.match(/`[^`]*`/g) || [])) {
    if (!/match_traces/.test(q)) continue;
    assert.ok(!/\bupdate\s+match_traces\b/i.test(q), 'un update vise match_traces : ' + q);
    assert.ok(!/\bdelete\s+from\s+match_traces\b/i.test(q), 'un delete vise match_traces : ' + q);
  }
  // L'insertion, elle, porte `on conflict do nothing` : c'est la BASE qui arbitre l'idempotence,
  // jamais un `select` préalable — même doctrine que `name_key`.
  const inserts = (pg.match(/`[^`]*`/g) || []).filter(q => /insert into match_traces/i.test(q));
  assert.strictEqual(inserts.length, 1, 'une seule insertion de trace');
  assert.match(inserts[0], /on conflict do nothing/);
  // Et la route de trace n'écrit JAMAIS dans `matches` : c'est ce qui fait qu'une trace refusée ne
  // peut pas laisser un billet bloqué, quoi qu'il arrive.
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const route = app.slice(app.indexOf('async function recevoirTrace'), app.indexOf('async function rendreResultat'));
  assert.ok(route.length > 800, 'la route de trace n\'a pas été retrouvée');
  for (const ecriture of ['db.settleMatch', 'db.createMatch', 'db.expireMatches'])
    assert.ok(!route.includes(ecriture), `la route de trace appelle ${ecriture}`);
});
await test('des totaux rendus en chaînes par la base ressortent en nombres', async () => {
  // Le même piège de pilote que les graines et les statistiques : `count()` et `sum()` rendent un
  // `bigint`, donc une CHAÎNE. Un total parti en texte ne se verrait qu'à l'écran, longtemps après.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const brute = db.addTrace;
  db.addTrace = async a => {
    const r = await brute(a);
    return { ...r, segments: String(r.segments), totalSteps: String(r.totalSteps) };
  };
  const r = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.strictEqual(typeof r.corps.segments, 'number');
  assert.strictEqual(typeof r.corps.totalSteps, 'number');
  assert.strictEqual(r.corps.totalSteps, 400);
});
await test('la doublure refuse ce que la colonne de trace refuserait', async () => {
  // La doublure ment comme le vrai pilote, ici comme ailleurs : `seq` et `steps` sont des `integer`,
  // `data` porte une borne de longueur. Sans cela, aucun test ne pourrait voir la classe de panne du
  // `22003` sur cette table-là.
  const { db } = bancDeBillet();
  await assert.rejects(() => db.addTrace({ matchId: '1', seq: 0, simVersion: 1,
    steps: 3_000_000_000, data: 'AAAAA', maxSteps: 1e12 }), e => e.code === '22003');
  await assert.rejects(() => db.addTrace({ matchId: '1', seq: 0, simVersion: 1,
    steps: 1, data: 'A'.repeat(70000), maxSteps: 1e12 }), e => e.code === '23514');
  assert.strictEqual(db.traces.length, 0, 'une écriture refusée ne doit rien laisser derrière');
});
await test('la trace a son propre seau de débit, son propre pré-vol, et sa seule méthode', async () => {
  const { app } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const b = await demander(app);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await envoyerTrace(app, b.corps.id, SEGMENT({ seq: i }))).code);
  assert.deepStrictEqual(codes, [200, 200, 429], codes.join(','));
  // Marteler la trace ne doit pas empêcher de rendre son résultat : les seaux sont séparés.
  const r = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                               token: 'ok:u1:Loic', body: {} });
  assert.notStrictEqual(r.code, 429);
  for (const m of ['GET', 'PATCH', 'DELETE'])
    assert.strictEqual((await appel(app, { method: m, path: '/api/match/1/trace', token: 'ok:u1:Loic' })).code, 405, m);
  for (const chemin of ['/api/match//trace', '/api/match/abc/trace', '/api/match/1/trace/x'])
    assert.strictEqual((await appel(app, { method: 'POST', path: chemin, token: 'ok:u1:Loic' })).code, 404, chemin);
  // Sans jeton, rien ne passe : le refus vient avant la lecture du corps.
  assert.strictEqual((await appel(app, { method: 'POST', path: '/api/match/1/trace' })).code, 401);
  // Et le pré-vol annonce la route sans que personne ait eu à réécrire la liste des méthodes.
  const pre = await appel(app, { method: 'OPTIONS' });
  assert.ok(String(pre.head['access-control-allow-methods']).split(',').includes('POST'));
});

console.log('Le rejeu décide : le serveur recalcule les faits');
// Poser une trace DIRECTEMENT dans la table, sans passer par la route qui la borne. C'est le seul
// moyen d'éprouver les refus du rejeu qui, en pratique, ne devraient jamais lui parvenir : la route
// de trace en arrête déjà une partie. Un serveur qui compterait sur elle pour être protégé
// dépendrait d'une garde qui vit ailleurs, et c'est exactement ce qu'on refuse.
const poserBrut = (db, matchId, data, seq = 0) =>
  db.traces.push({ match_id: matchId, seq, sim_version: SIM.SIM_VERSION,
                   steps: 1, data, created_at: '2026-01-01T00:00:00Z' });

await test('SIX CODES NOMMÉS, chacun en 400 ou 409, jamais en 500, et jamais un billet sans issue', async () => {
  // La leçon du `22003`, appliquée à la route qui décide de l'argent : un joueur n'a qu'un billet
  // ouvert à la fois, donc un 500 qui laisse la ligne `open` l'enferme jusqu'à l'expiration. Ici
  // chaque refus se nomme, sort en 400 ou 409, n'écrit AUCUN montant, et laisse la ligne au
  // veilleur de la 02a — le seul endroit du dossier qui clôt sans montant.
  const cas = [
    ['trace_absente', 409, async () => {}],
    ['donnees', 400, async (db, b) => { poserBrut(db, b.corps.id, 'pas une trace du tout'); }],
    ['donnees', 400, async (db, b) => { poserBrut(db, b.corps.id, traceDe(C, 40).texte(), 1); }],
    ['trop_de_pas', 400, async (db, b) => {
      poserBrut(db, b.corps.id, traceDe(C, 40).texte() + '~___'); }],
    ['non_terminal', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b, { pasMax: 400 }).segments); }],
    ['sim_version', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      // Un serveur redéployé pendant qu'un joueur joue : le billet garde la version sous laquelle
      // il a été ouvert, et le rejeu refuse de juger une partie qu'il ne saurait pas refaire.
      db.matches[0].sim_version = SIM.SIM_VERSION + 1; }],
    ['billet', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      db.matches[0].mode = 'bataille-navale'; }],
    ['conservation', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      // On fait MENTIR la simulation sur l'argent en jeu : si le rejeu se trompe, le serveur
      // n'écrit surtout pas de montant. C'est une garde contre lui-même, pas contre le joueur.
      SIM.argentCents = () => 1; }],
  ];
  for (const [code, attendu, preparer] of cas) {
    const vrai = SIM.argentCents;
    const { db, app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 100, windowMs: 60_000 }) });
    let panne = null;
    app.onError = e => { panne = e; };
    const b = await demander(app);
    await preparer(db, b, app);
    horloge.t = T0 + 200_000;
    const r = await rendre(app, b.corps.id, partieDe(b).rapport);
    SIM.argentCents = vrai;
    assert.strictEqual(panne, null, `${code} : une exception est remontée jusqu'au 500`);
    assert.strictEqual(r.code, attendu, `${code} : reçu ${r.code} — ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, code, JSON.stringify(r.corps));
    assert.ok(r.corps.erreur && r.corps.erreur.length > 20, `${code} : un refus doit dire pourquoi`);
    assert.strictEqual(db.matches[0].status, 'open', `${code} : la ligne n'est plus au veilleur`);
    for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
      assert.strictEqual(db.matches[0][col], undefined, `${code} : ${col} a été écrit sur un refus`);
    // Et le veilleur la ramasse : le joueur n'est enfermé que jusqu'à l'expiration de son billet,
    // pas au-delà, et il peut renvoyer sa trace entre-temps.
    horloge.t = Date.parse(b.corps.expiresAt) + 1;
    assert.deepStrictEqual(await app.veiller(), { closes: 1 }, code);
  }
  // Les six codes de la trace sont bien ceux que la spécification nomme, plus deux gardes internes.
  const { REJEU_CODES } = require('./app');
  for (const code of ['trop_de_pas', 'donnees', 'trace_absente', 'non_terminal', 'sim_version', 'budget'])
    assert.ok([400, 409].includes(REJEU_CODES[code]), code);
});
await test('LE BUDGET DE CALCUL EST ÉPROUVÉ SANS ATTENDRE : une horloge injectée, pas une trace lente', async () => {
  // Un rejeu tourne dans le fil de la requête, et une trace adversariale peut chercher à en
  // maximiser le coût. Le dépassement est un code nommé — jamais une exception, jamais un fil tenu
  // une minute — et il s'éprouve avec une horloge qui avance d'elle-même : attendre deux secondes
  // dans un test serait payer le prix qu'on cherche justement à borner.
  const { REPLAY_BUDGET_MS } = require('./app');
  let t = 0;
  const { db, app, horloge } = bancDeBillet({ chrono: () => (t += REPLAY_BUDGET_MS) });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'budget');
  assert.ok(r.corps.replayMs > REPLAY_BUDGET_MS);
  assert.strictEqual(db.matches[0].status, 'open', 'un rejeu abandonné a quand même écrit');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
await test('LE REJEU D\'UNE PARTIE HONNÊTE TIENT LARGEMENT SOUS SON BUDGET, sur la vraie horloge', async () => {
  // Le pendant du précédent, et le plancher de performance de la route : la seule mesure de ce
  // dossier qui se prenne sur une vraie horloge, parce que c'est la seule question à laquelle une
  // horloge figée ne peut pas répondre.
  const { REPLAY_BUDGET_MS } = require('./app');
  const { db, app, horloge } = bancDeBillet({ chrono: Date.now });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.ok(Number.isInteger(r.corps.replayMs) && r.corps.replayMs >= 0, String(r.corps.replayMs));
  assert.ok(r.corps.replayMs * 3 < REPLAY_BUDGET_MS,
    `un rejeu honnête de ${p.pas} pas coûte ${r.corps.replayMs} ms pour un budget de ${REPLAY_BUDGET_MS} ms`);
  assert.strictEqual(db.matches[0].replay_ms, r.corps.replayMs);
});
await test('TRONQUER UNE TRACE NE PAIE JAMAIS RIEN : net(préfixe) ≤ net(complète), et zéro sans fin', async () => {
  // LE VRAI TROU D'UN REJEU DIFFÉRÉ, et il s'ouvre le jour où un euro entre : sans état terminal
  // obligatoire, couper le réseau juste après un gros kill deviendrait la meilleure stratégie du
  // jeu — la partie resterait à jamais dans son meilleur instant.
  const complet = async (mode, opts) => {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app, { ...DEMANDE, mode });
    const { rep } = await jouerEtRendre(app, horloge, b, opts);
    return { rep, ligne: db.matches[0] };
  };
  // Une partie qui PAIE, et la même tronquée à tous les stades avant sa fin.
  const entiere = await complet('resurgence', { encaisser: 300 });
  assert.strictEqual(entiere.rep.corps.status, 'settled');
  assert.ok(entiere.rep.corps.netCents > 0, 'la partie de référence ne paie rien : le test est vide');

  for (const pasMax of [60, 120, 240, 299]) {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
    const p = partieDe(b, { encaisser: 300, pasMax });
    assert.strictEqual(p.terminal, null, `${pasMax} pas : le préfixe est déjà terminal`);
    await poserTrace(app, b.corps.id, p.segments);
    horloge.t = ARRIVEE(p.rapport);
    const r = await rendre(app, b.corps.id, p.rapport);
    assert.strictEqual(r.code, 409, `${pasMax} : ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, 'non_terminal');
    // AUCUN MONTANT : c'est zéro, et zéro est bien inférieur à ce que la partie complète a payé.
    assert.strictEqual(db.matches[0].net_cents, undefined, `${pasMax} : un montant a été écrit`);
    assert.ok(0 <= entiere.rep.corps.netCents);
  }
  // Et la même chose sur une partie PERDUE : tronquée ou entière, elle ne paie rien non plus, mais
  // seule l'entière se règle. Une défaite tronquée n'efface pas la défaite, elle reste ouverte.
  const perdue = await complet('solo', {});
  assert.strictEqual(perdue.rep.corps.status, 'settled');
  assert.strictEqual(perdue.rep.corps.netCents, 0);
  assert.strictEqual(perdue.ligne.digest_match, true);
});
await test('RALLONGER SA TRACE APRÈS L\'ENCAISSEMENT N\'AJOUTE PAS UN CENTIME', async () => {
  // Le pendant exact de la troncature, et personne ne l'avait nommé : le jeu coupe sa boucle sur
  // l'événement de fin, un serveur qui continuerait à simuler au-delà jugerait une partie que
  // personne n'a jouée. Le joueur qui encaisse puis colle mille deux cents pas de plus au bout de
  // sa trace verrait sa sacoche continuer de grossir APRÈS être sorti avec l'argent.
  //
  // Deux bancs, mêmes graines, même horloge : le premier envoie la trace qui s'arrête au jeton
  // d'encaissement, le second la même trace RALLONGÉE. Les deux lignes doivent être indiscernables.
  const droit = bancDeBillet(), rallonge = bancDeBillet();
  const a = await demander(droit.app, { ...DEMANDE, mode: 'resurgence' });
  const b = await demander(rallonge.app, { ...DEMANDE, mode: 'resurgence' });
  const honnete = partieDe(a, { encaisser: 300 });
  const longue = partieDe(b, { encaisser: 300, rallonge: 1200 });
  assert.ok(longue.pas > honnete.pas + 1000, 'la trace rallongée ne l\'est pas');

  const un = await jouerEtRendre(droit.app, droit.horloge, a, { encaisser: 300 });
  await poserTrace(rallonge.app, b.corps.id, longue.segments);
  rallonge.horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + honnete.rapport.seconds + 3) * 1000;
  // Le rapport est celui de la partie HONNÊTE : ce qui change entre les deux appels est la trace,
  // et elle seule.
  const deux = await rendre(rallonge.app, b.corps.id, honnete.rapport);

  assert.strictEqual(deux.code, 200, JSON.stringify(deux.corps));
  assert.deepStrictEqual(deux.corps, un.rep.corps, 'la rallonge a changé le règlement');
  assert.deepStrictEqual(rallonge.db.matches, droit.db.matches, 'la rallonge a changé la ligne');
  // Et le serveur s'est bien arrêté au jeton, pas au bout du fichier.
  assert.strictEqual(deux.corps.traceSteps, honnete.pas);
  assert.strictEqual(deux.corps.digestMatch, true);
});
await test('UNE DIVERGENCE EST MESURÉE, JAMAIS PUNIE — et aucun agrégat ne compte la ligne', async () => {
  // `Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp près par ECMAScript : un
  // désaccord entre le rejeu du serveur et l'empreinte du client peut ne prouver qu'une chose, que
  // les deux n'ont pas la même bibliothèque mathématique. Refuser ce joueur serait le QUATRIÈME
  // contrôle « évident » et faux de ce dossier. La ligne est donc RÉGLÉE, marquée, et la garantie
  // écrite noir sur blanc est celle dont la phase 03 a besoin : elle ne lira que ce qui a convergé.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  const siens = C.digestsDecode(p.rapport.digests);
  assert.ok(siens && siens.length > 3, 'la partie du test ne porte pas assez de condensés');
  const faux = siens.slice(); faux[2] = (faux[2] ^ 1) >>> 0;
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, { ...p.rapport, digests: C.digestsEncode(faux) });

  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.status, 'settled', 'une divergence a été PUNIE');
  assert.ok(r.corps.netCents > 0, 'le joueur divergent doit être payé comme les autres');
  assert.strictEqual(r.corps.digestMatch, false);
  // Le premier pas où les deux s'écartent, au pas d'empreinte près. Sans ce chiffre, la liste
  // d'exclusion grandirait en silence et la phase 03 hériterait d'un filtre au rendement inconnu.
  assert.strictEqual(r.corps.divergenceStep, 3 * SIM.EMPREINTE_PAS);
  assert.strictEqual(db.matches[0].digest_match, false);
  assert.strictEqual(db.matches[0].replay_digest, SIM.empreinte(p.G));

  // ET LA GARDE QUI COMPTE : aucun agrégat ne voit cette ligne. Elle est réglée, elle est payée,
  // et le grand livre de la phase 03 ne la lira jamais.
  const s = (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;
  assert.strictEqual(s.matches, 0, 'une ligne divergente a été comptée');
  assert.strictEqual(s.wins, 0);
  assert.strictEqual(s.kills, 0);
  assert.strictEqual(s.best, 0);
  assert.strictEqual(s.divergences, 1, 'le taux de divergence n\'est pas exposé');
});
await test('un client sans condensés est réglé aussi, et compté comme divergent — pas comme convergé', async () => {
  // Un client qui n'envoie pas ses condensés n'est pas un tricheur : il ne prouve simplement
  // aucune convergence. La valeur par défaut sûre est donc « non convergé », jamais l'inverse.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, { ...p.rapport, digests: '' });
  assert.strictEqual(r.corps.status, 'settled');
  assert.strictEqual(r.corps.digestMatch, false);
  assert.strictEqual(r.corps.divergenceStep, 0, 'zéro veut dire « aucun condensé comparable »');
  assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).corps.stats.divergences, 1);
  assert.strictEqual(db.matches[0].digest_match, false);
});
test('LA ROUTE DU RÉSULTAT NE LIT PLUS AUCUN FAIT DU CORPS : garde textuelle', () => {
  // La garde qui attrape le PROCHAIN champ qu'on relira du corps par inadvertance. Deux seulement
  // ont le droit d'en sortir : ce que le client croit avoir gagné, et ses condensés — ni l'un ni
  // l'autre ne décide d'un montant.
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const route = src.slice(src.indexOf('function rejouerPartie'), src.indexOf('async function veiller'));
  assert.ok(route.length > 2000, 'la route du résultat n\'a pas été retrouvée');
  const lus = [...new Set((route.match(/\brapport\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(8)))];
  assert.deepStrictEqual(lus.sort(), ['declaredNetCents', 'digests'],
    'la route lit un fait déclaré : ' + lus.join(', '));
  // Et les faits écrits viennent tous de la partie rejouée.
  for (const champ of ['seconds', 'kills', 'deaths', 'rank', 'cubes', 'damage', 'cashedOut'])
    assert.ok(route.includes(`faits.${champ}`) || route.includes(`vide.${champ}`), champ);
});

// ------------------------------------------------------------------------------------------------
// LE GRAND LIVRE (phase 03, module 1). Il est testé ICI et pas dans `test.js` parce qu'il est du
// SERVEUR : le plan de comptes n'est pas une règle du jeu, et rien dans le navigateur n'exécutera
// jamais une ligne de comptabilité. Ce qui est réellement partagé avec le sas — la fenêtre de
// renoncement — vit dans `WBCore` et se teste dans `test.js`.
//
// À ce stade rien n'est écrit sur un disque : `api/ledger.js` est entièrement pur.
console.log('Le grand livre : la grammaire, les transferts, les mouvements');
const L = require('./ledger');
// Les cinq modes avec leurs VRAIS sièges, et les quatre tables. Aucun échantillon : le domaine.
const MODES_LEDGER = Object.keys(C.MODES).map(id => ({ id, seats: C.seatsOf(C.MODES[id]) }));
const MISES_LEDGER = C.TIERS.map(t => C.toCents(t.stake));

// Le contrôle que tout mouvement doit passer, et qui n'est PAS une fonction d'équilibre appelée
// avant l'insertion : la partie double est structurelle, on ne fait ici que constater qu'elle l'est
// bien restée sur chaque ligne produite.
function verifierMouvement(transferts, quoi) {
  assert.ok(Array.isArray(transferts) && transferts.length > 0, `${quoi} : mouvement vide`);
  let signe = 0;
  for (const t of transferts) {
    assert.ok(Number.isSafeInteger(t.montantCents) && t.montantCents > 0,
      `${quoi} : montant ${t.montantCents} — un transfert porte un entier de centimes strictement positif`);
    assert.notStrictEqual(t.compteDebit, t.compteCredit, `${quoi} : un transfert vers soi-même`);
    assert.ok(L.compteValide(t.compteDebit), `${quoi} : ${t.compteDebit} hors grammaire`);
    assert.ok(L.compteValide(t.compteCredit), `${quoi} : ${t.compteCredit} hors grammaire`);
    assert.ok(L.MOTIFS.includes(t.motif), `${quoi} : motif ${t.motif} hors liste`);
    assert.strictEqual(t.motif, transferts[0].motif, `${quoi} : deux motifs dans un mouvement`);
    assert.strictEqual(t.reference, transferts[0].reference, `${quoi} : deux références dans un mouvement`);
    // La somme signée : `+m` quelque part, `−m` ailleurs, donc zéro. C'est vrai PAR CONSTRUCTION,
    // et c'est très exactement pour cela que le test peut l'affirmer sans rien avoir à corriger.
    signe += t.montantCents - t.montantCents;
  }
  const comptes = new Set();
  for (const t of transferts) { comptes.add(t.compteDebit); comptes.add(t.compteCredit); }
  let total = 0;
  for (const c of comptes) total += L.soldeDe(transferts, c);
  assert.strictEqual(total, 0, `${quoi} : la somme du mouvement n'est pas nulle`);
  assert.strictEqual(signe, 0);
  // Les paires de comptes d'un même mouvement sont distinctes deux à deux : c'est ce qui rend la
  // clé d'idempotence `(motif, reference, compte_debit, compte_credit)` capable d'identifier UNE
  // jambe. Deux jambes identiques et la seconde serait refusée par la base.
  const paires = new Set(transferts.map(t => `${t.compteDebit}>${t.compteCredit}`));
  assert.strictEqual(paires.size, transferts.length, `${quoi} : deux jambes de même paire de comptes`);
}

test('EXHAUSTIVEMENT : sur les cinq modes, les quatre tables et TOUTE sacoche, un mouvement est un ensemble de transferts positifs qui boucle', () => {
  // Pas un échantillon : toute sacoche de 0 à `mise × sièges`, la borne que `purseBound` démontre.
  // 280 500 règlements, chacun confronté à la grammaire, aux entiers et à la partie double.
  let regles = 0;
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const max = C.purseBound(miseCents, seats).maxCents;
    const mise = L.mouvementMise({ userId: 1, matchId: 42, miseCents });
    verifierMouvement(mise, `${id} $${miseCents / 100} mise`);
    for (let sacoche = 0; sacoche <= max; sacoche++) {
      // Le brut, la commission et le net viennent de `WBCore.cashoutCents` et de NULLE PART
      // ailleurs. `api/ledger.js` les reçoit et les répartit ; il n'a pas le droit de les calculer,
      // et une garde textuelle plus bas le vérifie sur son texte.
      const p = C.cashoutCents(sacoche);
      const gain = L.mouvementGain({ userId: 1, matchId: 42, miseCents,
                                     grossCents: p.grossCents, feeCents: p.feeCents,
                                     netCents: p.netCents, convergee: true });
      verifierMouvement(gain, `${id} $${miseCents / 100} sacoche ${sacoche}`);
      // Le séquestre est habité par la mise, puis vidé par le règlement. Exactement, au centime :
      // c'est l'invariant fort et local que le séquestre par partie existe pour donner.
      const livre = mise.concat(gain);
      assert.strictEqual(L.soldeDe(mise, L.compteEnjeu(42)), miseCents);
      assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(42)), 0,
        `${id} $${miseCents / 100} sacoche ${sacoche} : séquestre non vidé`);
      regles++;
    }
  }
  assert.strictEqual(regles, MODES_LEDGER.reduce((a, m) =>
    a + MISES_LEDGER.reduce((b, s) => b + s * m.seats + 1, 0), 0));
  assert.ok(regles > 280000, `le domaine balayé est trop maigre : ${regles} règlements`);
});

test('fee + net = brut sur chaque règlement, et les trois montants viennent de cashoutCents', () => {
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    for (let sacoche = 0; sacoche <= C.purseBound(miseCents, seats).maxCents; sacoche++) {
      const p = C.cashoutCents(sacoche);
      assert.strictEqual(p.feeCents + p.netCents, p.grossCents);
      // Et le grand livre REFUSE un triplet qui ne vient manifestement pas de là. Sans ce refus, le
      // séquestre ne bouclerait plus et le trou n'apparaîtrait qu'au règlement suivant.
      assert.throws(() => L.mouvementGain({ userId: 1, matchId: 3, miseCents,
        grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents + 1, convergee: true }),
        /cashoutCents/);
    }
  }
});

test('GARDE TEXTUELLE : api/ledger.js ne contient AUCUNE arithmétique de commission', () => {
  // Elle est infiniment plus sûre sur un fichier dédié que sur une plage de marqueurs dans un
  // fichier de six mille lignes, et c'est l'une des raisons pour lesquelles le grand livre vit dans
  // `api/ledger.js` plutôt que dans `WBCore`.
  const fs = require('node:fs'), path = require('node:path');
  const brut = fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');
  const src = brut.replace(/^[ \t]*\/\/[^\n]*/gm, '');
  for (const interdit of ['RAKE', '0.2', 'Math.ceil', '/ 100', 'toFixed'])
    assert.ok(!src.includes(interdit), `api/ledger.js recalcule un montant : ${interdit}`);
  // Et il ne recopie pas non plus une règle du jeu par la porte de derrière : il ne charge PAS
  // WBCore. Il reçoit des montants déjà décidés, il ne va pas les chercher.
  assert.ok(!src.includes('require('), 'api/ledger.js dépend de quelque chose : il doit rester pur');
  assert.ok(src.includes('cashoutCents'), 'la raison de la garde doit rester écrite dans le fichier');
});

test('chaque montant est un entier SÛR : aucun flottant n\'entre', () => {
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const max = C.purseBound(miseCents, seats).maxCents;
    for (let sacoche = 0; sacoche <= max; sacoche++) {
      const p = C.cashoutCents(sacoche);
      for (const t of L.mouvementGain({ userId: 9, matchId: 9, miseCents, grossCents: p.grossCents,
                                        feeCents: p.feeCents, netCents: p.netCents, convergee: false }))
        assert.ok(Number.isSafeInteger(t.montantCents), `${t.montantCents}`);
    }
  }
  // Et ce qui n'est pas un entier sûr est REFUSÉ, jamais arrondi en silence : un centime perdu à
  // l'arrondi est un livre qui ne boucle plus.
  for (const mauvais of [0, -1, 1.5, NaN, Infinity, '100', null, undefined, 2 ** 53])
    assert.throws(() => L.mouvementMise({ userId: 1, matchId: 1, miseCents: mauvais }), /montant invalide/,
      `${String(mauvais)} a été accepté comme montant`);
});

test('un compte hors grammaire LANCE, au lieu de rendre une écriture boiteuse', () => {
  // Une écriture boiteuse s'insérerait, et elle BOUCLERAIT — un transfert boucle toujours. Le solde
  // qu'elle fausse ne se verrait qu'au moment de payer quelqu'un.
  for (const bon of ['joueur:1:disponible', 'joueur:987654321:quarantaine', 'enjeu:7',
                     L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.ok(L.compteValide(bon), bon);
  for (const mauvais of ['joueur:1', 'joueur:1:autre', 'joueur:0:disponible', 'joueur:01:disponible',
                         'joueur:-1:disponible', 'joueur:a:disponible', 'enjeu:', 'enjeu:0',
                         'maison', 'maison:autre', 'maison:dotation:1', '', ' enjeu:1',
                         'enjeu:1\nmaison:dotation', 42, null, undefined]) {
    assert.ok(!L.compteValide(mauvais), `${String(mauvais)} est passé pour un compte`);
    assert.throws(() => L.exigeCompte(mauvais), /hors grammaire/, String(mauvais));
    assert.throws(() => L.soldeDe([], mauvais), /hors grammaire/, String(mauvais));
  }
  // Les zéros de tête sont refusés PAR LES FABRICANTS aussi : `joueur:007:disponible` et
  // `joueur:7:disponible` seraient deux comptes pour un seul joueur, et le solde du second ne
  // verrait jamais l'argent du premier.
  for (const mauvais of ['007', '0', -3, 1.5, '', 'sept', null, NaN])
    for (const fab of [L.compteJoueur, L.compteQuarantaine, L.compteEnjeu])
      assert.throws(() => fab(mauvais), /identifiant/, `${fab.name}(${String(mauvais)})`);
  // Les trois formes qu'un pilote Postgres peut rendre pour un `bigserial` donnent le MÊME compte.
  assert.strictEqual(L.compteJoueur(12), 'joueur:12:disponible');
  assert.strictEqual(L.compteJoueur('12'), 'joueur:12:disponible');
  assert.strictEqual(L.compteJoueur(12n), 'joueur:12:disponible');
  // Un transfert d'un compte vers lui-même n'est pas représentable non plus.
  assert.throws(() => L.transfert('mise', '1', 'enjeu:1', 'enjeu:1', 10), /vers lui-même/);
});

test('un motif hors liste LANCE, et la liste est fermée à SIX', () => {
  assert.deepStrictEqual(L.MOTIFS.slice(),
    ['dotation', 'recharge', 'mise', 'gain', 'remboursement', 'contrepassation']);
  // Six, et pas sept : la spécification renvoie explicitement à la phase 06 le motif de libération
  // de quarantaine, parce qu'un membre de liste fermée que personne n'écrit est une case en attente
  // d'être créée de travers. Le test tombera le jour où quelqu'un l'ajoutera sans lire la raison.
  for (const absent of ['liberation', 'quarantaine', 'depot', 'retrait', 'ajustement', 'correction'])
    assert.ok(!L.MOTIFS.includes(absent), `${absent} est entré dans la liste des motifs`);
  for (const mauvais of ['', 'MISE', 'gains', 'transfert', null, undefined, 0])
    assert.throws(() => L.exigeMotif(mauvais), /motif hors liste/, String(mauvais));
  for (const mauvais of ['', 'MISE', 'transfert', null])
    assert.throws(() => L.transfert(mauvais, '1', 'enjeu:1', L.MAISON_COMMISSION, 10), /motif hors liste/);
});

test('la grammaire est une EXPRESSION, exportée en source pour que le schéma la recopie', () => {
  // Ne jamais l'écrire « liste fermée » : trois des six comptes sont des familles paramétrées, et
  // un `check (compte in (...))` serait refusé au premier joueur inscrit. Le module suivant recopie
  // `COMPTE_RE_SQL` caractère pour caractère dans `api/schema.sql`, et un test l'y comparera.
  assert.strictEqual(typeof L.COMPTE_RE_SQL, 'string');
  assert.ok(L.COMPTE_RE_SQL.startsWith('^') && L.COMPTE_RE_SQL.endsWith('$'),
    'la contrainte doit être ancrée des deux côtés, sinon elle laisse passer n\'importe quel préfixe');
  assert.ok(!L.COMPTE_RE_SQL.includes("'"), 'une apostrophe casserait le littéral SQL du schéma');
  // Le RegExp en DÉRIVE : il n'existe pas deux écritures de la même règle.
  assert.strictEqual(L.COMPTE_RE.source, L.COMPTE_RE_SQL);
  for (const c of ['joueur:1:disponible', 'joueur:1:quarantaine', 'enjeu:1',
                   L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.ok(new RegExp(L.COMPTE_RE_SQL).test(c), c);
});

test('SEULS le compte d\'émission et la contrepartie ont le droit de passer en négatif', () => {
  assert.deepStrictEqual(L.COMPTES_EMETTEURS.slice(), [L.MAISON_DOTATION, L.MAISON_CONTREPARTIE]);
  assert.ok(L.decouvertAutorise(L.MAISON_DOTATION));
  assert.ok(L.decouvertAutorise(L.MAISON_CONTREPARTIE));
  // La commission n'est pas un compte d'émission : elle encaisse, elle n'avance rien.
  assert.ok(!L.decouvertAutorise(L.MAISON_COMMISSION));
  assert.ok(!L.decouvertAutorise(L.compteJoueur(1)));
  assert.ok(!L.decouvertAutorise(L.compteQuarantaine(1)));
  // ET SURTOUT PAS LES SÉQUESTRES, et c'est tout l'intérêt de l'uniformité de la règle : un second
  // gain sur un même billet devrait débiter un séquestre déjà vide, et se fait donc refuser.
  // « Un billet a au plus un gain » ne repose alors pas uniquement sur un index.
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    assert.ok(!L.decouvertAutorise(L.compteEnjeu(seats * miseCents)));
  }
  assert.throws(() => L.decouvertAutorise('maison:tresorerie'), /hors grammaire/);
});

test('LA MESURE QUE docs/HISTORIQUE.md RÉCLAME AVANT LA PHASE 04 : ce que la maison paie, au centime', () => {
  // Ce chiffre existait déjà ; il n'était écrit nulle part, et le risque n'est pas le chiffre —
  // c'est de le voir apparaître un jour et de le prendre pour un bug. Il tombe ici, avant qu'une
  // base ne le calcule.
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const mise = L.mouvementMise({ userId: 4, matchId: 4, miseCents });

    // 1. LE JOUEUR QUI PERD : sa sacoche est vide, le séquestre part entier chez la contrepartie.
    //    Un seul transfert, parce qu'une jambe nulle n'est pas représentable.
    const perdu = C.cashoutCents(0);
    const perte = L.mouvementGain({ userId: 4, matchId: 4, miseCents, grossCents: perdu.grossCents,
                                    feeCents: perdu.feeCents, netCents: perdu.netCents, convergee: true });
    assert.strictEqual(perte.length, 1, `${id} : un brut nul doit produire UN seul transfert`);
    assert.deepStrictEqual({ ...perte[0] }, { motif: 'gain', reference: '4', compteDebit: 'enjeu:4',
                                              compteCredit: L.MAISON_CONTREPARTIE, montantCents: miseCents });
    let livre = mise.concat(perte);
    assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(4)), 0);
    assert.strictEqual(L.soldeDe(livre, L.MAISON_CONTREPARTIE), miseCents, 'enjeu −mise, contrepartie +mise');
    assert.strictEqual(L.soldeDe(livre, L.MAISON_COMMISSION), 0, 'un brut nul ne rapporte aucune commission');
    assert.strictEqual(L.soldeDe(livre, L.compteJoueur(4)), -miseCents);

    // 2. LE JOUEUR QUI RAFLE LA TABLE : la maison paie les mises que personne n'a versées.
    const rafle = C.cashoutCents(miseCents * seats);
    const gain = L.mouvementGain({ userId: 4, matchId: 4, miseCents, grossCents: rafle.grossCents,
                                   feeCents: rafle.feeCents, netCents: rafle.netCents, convergee: true });
    livre = mise.concat(gain);
    assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(4)), 0, 'le séquestre doit être vidé');
    // La contrepartie verse `(sièges − 1)` mises en BRUT — le pot moins la seule mise réelle.
    const verse = -L.soldeDe(livre, L.MAISON_CONTREPARTIE);
    assert.strictEqual(verse, miseCents * (seats - 1), `${id} $${miseCents / 100} : brut versé`);
    // Et le COÛT NET de la maison est ce versement moins ce que la commission rattrape :
    // `brut − fee − mise`. C'est le chiffre qu'il fallait écrire avant qu'il ne surprenne quelqu'un.
    const encaisse = L.soldeDe(livre, L.MAISON_COMMISSION);
    assert.strictEqual(encaisse, rafle.feeCents);
    assert.strictEqual(verse - encaisse, rafle.grossCents - rafle.feeCents - miseCents,
      `${id} $${miseCents / 100} : coût net de la maison`);
    assert.strictEqual(L.soldeDe(livre, L.compteJoueur(4)), rafle.netCents - miseCents);
  }
  // Et le cas nommé dans la spécification, en chiffres : une table à 10 $ en resurgence.
  const mise = 1000, seats = C.seatsOf(C.MODES.resurgence);
  assert.strictEqual(seats, 50);
  const p = C.cashoutCents(mise * seats);
  assert.deepStrictEqual(p, { grossCents: 50000, feeCents: 10000, netCents: 40000 });
  const livre = L.mouvementMise({ userId: 4, matchId: 4, miseCents: mise })
    .concat(L.mouvementGain({ userId: 4, matchId: 4, miseCents: mise, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  assert.strictEqual(-L.soldeDe(livre, L.MAISON_CONTREPARTIE), 49000, 'la contrepartie verse 49 000 centimes');
  assert.strictEqual(L.soldeDe(livre, L.MAISON_COMMISSION), 10000, 'la maison encaisse 10 000 centimes');
  assert.strictEqual(-L.soldeDe(livre, L.MAISON_CONTREPARTIE) - L.soldeDe(livre, L.MAISON_COMMISSION),
    39000, '390 $ de coût net sur UNE partie');
});

test('le gain d\'une ligne DIVERGENTE va en quarantaine, et le solde dépensable n\'en voit pas un centime', () => {
  const p = C.cashoutCents(2500);
  const commun = { userId: 8, matchId: 8, miseCents: 100, grossCents: p.grossCents,
                   feeCents: p.feeCents, netCents: p.netCents };
  const droit = L.mouvementGain({ ...commun, convergee: true });
  const retenu = L.mouvementGain({ ...commun, convergee: false });
  assert.strictEqual(L.soldeDe(droit, L.compteJoueur(8)), p.netCents);
  assert.strictEqual(L.soldeDe(droit, L.compteQuarantaine(8)), 0);
  assert.strictEqual(L.soldeDe(retenu, L.compteQuarantaine(8)), p.netCents);
  assert.strictEqual(L.soldeDe(retenu, L.compteJoueur(8)), 0);
  // Le livre boucle dans les deux cas : c'est tout l'intérêt de la quarantaine face aux trois
  // autres réponses possibles — ne rien créditer punirait un joueur qui n'a rien fait, créditer le
  // dépensable romprait une garantie écrite quatre fois, et ne rien écrire laisserait `net_cents`
  // sans contrepartie.
  for (const m of [droit, retenu]) verifierMouvement(m, 'gain');
  // Un `convergee` oublié enverrait silencieusement le gain en quarantaine. Il est donc exigé.
  assert.throws(() => L.mouvementGain({ ...commun }), /convergee/);
  assert.throws(() => L.mouvementGain({ ...commun, convergee: 'oui' }), /convergee/);
  // Sauf quand le net est nul : aucune jambe ne touche alors un compte de joueur, et le veilleur,
  // qui ne connaît que le billet, n'a rien à en dire.
  assert.doesNotThrow(() => L.mouvementGain({ matchId: 8, miseCents: 100, grossCents: 0, feeCents: 0, netCents: 0 }));
});

test('LE VIDAGE D\'UN SÉQUESTRE À L\'EXPIRATION est un règlement à net nul, pas un motif de plus', () => {
  // `remboursement` mentirait — personne n'est remboursé. `contrepassation` mentirait aussi — on ne
  // corrige aucune écriture fausse, le débit de la mise était juste. Un septième motif rouvrirait la
  // liste fermée pour rien. Le vidage EST le règlement d'une partie qui n'a rien rapporté, donc
  // motif `gain`, net nul — c'est-à-dire `mouvementGain` avec un brut nul, et pas une fonction de
  // plus dont la seule différence aurait été le chemin qui l'appelle.
  assert.strictEqual(L.mouvementExpiration, undefined,
    'une fonction d\'expiration a été ajoutée : le vidage se lit comme un règlement à net nul');
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const vidage = L.mouvementGain({ matchId: 5, miseCents, grossCents: 0, feeCents: 0, netCents: 0 });
    assert.strictEqual(vidage.length, 1);
    assert.deepStrictEqual({ ...vidage[0] }, { motif: 'gain', reference: '5', compteDebit: 'enjeu:5',
                                               compteCredit: L.MAISON_CONTREPARTIE, montantCents: miseCents });
    // Et il produit EXACTEMENT le même mouvement que le règlement d'un joueur qui perd. C'est la
    // vérité comptable : les deux billets ont rapporté zéro.
    const perdu = C.cashoutCents(0);
    assert.deepStrictEqual(vidage.map(t => ({ ...t })),
      L.mouvementGain({ userId: 6, matchId: 5, miseCents, grossCents: perdu.grossCents,
                        feeCents: perdu.feeCents, netCents: perdu.netCents, convergee: true })
        .map(t => ({ ...t })));
    assert.strictEqual(L.soldeDe(L.mouvementMise({ userId: 6, matchId: 5, miseCents }).concat(vidage),
                                 L.compteEnjeu(5)), 0, 'aucun séquestre ne reste habité');
    assert.ok(seats > 0);
  }
});

test('la dotation, la recharge et le remboursement portent la référence qui les rend idempotents', () => {
  const d = L.mouvementDotation({ userId: 3, montantCents: 5000 });
  verifierMouvement(d, 'dotation');
  assert.deepStrictEqual({ ...d[0] }, { motif: 'dotation', reference: '3',
    compteDebit: L.MAISON_DOTATION, compteCredit: 'joueur:3:disponible', montantCents: 5000 });
  // La recharge est idempotente PAR JOUR : une par joueur et par jour, écrite par le serveur à la
  // connexion, jamais par une route de crédit gratuit que le client pourrait marteler.
  const r = L.mouvementRecharge({ userId: 3, jour: '2026-09-14', montantCents: 500 });
  verifierMouvement(r, 'recharge');
  assert.strictEqual(r[0].reference, '3:2026-09-14');
  assert.strictEqual(r[0].compteDebit, L.MAISON_DOTATION);
  assert.notStrictEqual(r[0].reference, d[0].reference, 'dotation et recharge se distingueraient mal');
  for (const mauvais of ['14/09/2026', '2026-9-14', '', '2026-09-14T00:00:00Z', null, 20260914])
    assert.throws(() => L.mouvementRecharge({ userId: 3, jour: mauvais, montantCents: 500 }),
      /jour de recharge/, String(mauvais));
  // Le remboursement rend la mise et vide le séquestre : le seul chemin qui rende une mise.
  const mise = L.mouvementMise({ userId: 3, matchId: 11, miseCents: 100 });
  const rb = L.mouvementRemboursement({ userId: 3, matchId: 11, miseCents: 100 });
  verifierMouvement(rb, 'remboursement');
  assert.strictEqual(rb[0].reference, '11');
  assert.strictEqual(L.soldeDe(mise.concat(rb), L.compteEnjeu(11)), 0);
  assert.strictEqual(L.soldeDe(mise.concat(rb), L.compteJoueur(3)), 0, 'le joueur retrouve sa mise');
});

test('la contre-passation est l\'inverse EXACT, et laisse les deux mouvements visibles', () => {
  // Une écriture modifiée est une preuve détruite : on ne peut plus dire ce qui a été payé ni
  // quand. Le seul chemin de correction est un mouvement inverse, daté et motivé.
  const p = C.cashoutCents(3000);
  const gain = L.mouvementGain({ userId: 2, matchId: 77, miseCents: 500, grossCents: p.grossCents,
                                 feeCents: p.feeCents, netCents: p.netCents, convergee: true });
  const contre = L.mouvementContrepassation({ transferts: gain });
  verifierMouvement(contre, 'contrepassation');
  assert.strictEqual(contre.length, gain.length);
  for (let i = 0; i < gain.length; i++) {
    assert.strictEqual(contre[i].compteDebit, gain[i].compteCredit);
    assert.strictEqual(contre[i].compteCredit, gain[i].compteDebit);
    assert.strictEqual(contre[i].montantCents, gain[i].montantCents);
    assert.strictEqual(contre[i].motif, 'contrepassation');
  }
  // La référence dit CE QUI a été contre-passé, sans jointure, et reste distincte de l'original :
  // la clé d'idempotence `(motif, reference, débit, crédit)` ne collisionne donc jamais.
  assert.strictEqual(contre[0].reference, 'gain:77');
  // Et le livre revient exactement à ce qu'il était avant le mouvement corrigé.
  const tout = gain.concat(contre);
  for (const c of ['enjeu:77', 'joueur:2:disponible', L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.strictEqual(L.soldeDe(tout, c), 0, c);
  // Un paquet hétéroclite n'est pas un mouvement : son inverse ne correspondrait à rien de nommable.
  assert.throws(() => L.mouvementContrepassation({
    transferts: gain.concat(L.mouvementMise({ userId: 2, matchId: 77, miseCents: 500 })) }),
    /même mouvement/);
  assert.throws(() => L.mouvementContrepassation({ transferts: [] }), /non vide/);
});

test('soldeDe rend ZÉRO sur une liste vide, et un ENTIER partout', () => {
  // Jamais `null`, jamais `undefined` : un solde absent qui se propage en `NaN` dans une somme est
  // exactement le genre de panne qu'on découvre au moment de payer quelqu'un.
  for (const c of [L.compteJoueur(1), L.compteQuarantaine(1), L.compteEnjeu(1),
                   L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE]) {
    assert.strictEqual(L.soldeDe([], c), 0);
    assert.ok(Number.isInteger(L.soldeDe([], c)));
    assert.strictEqual(L.soldeDe(undefined, c), 0);
  }
  const livre = L.mouvementDotation({ userId: 1, montantCents: 5000 })
    .concat(L.mouvementMise({ userId: 1, matchId: 1, miseCents: 50 }));
  assert.strictEqual(L.soldeDe(livre, L.compteJoueur(1)), 4950);
  assert.strictEqual(L.soldeDe(livre, L.MAISON_DOTATION), -5000);
  assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(1)), 50);
  // Un compte que le livre n'a jamais touché vaut zéro, il n'est pas « inconnu ».
  assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(999)), 0);
});

console.log('Le grand livre : la réconciliation');
// Un scénario minimal : un billet réglé, sa mise et son gain. C'est cette forme-là que
// `ledgerReconcile` devra retrouver à la fin de chaque scénario d'`api/test.js` dans les modules
// suivants.
function scenarioRegle({ id = 1, userId = 1, miseCents = 100, sacoche = 400, digest_match = true } = {}) {
  const p = C.cashoutCents(sacoche);
  const ligne = { id, user_id: userId, status: 'settled', stake_cents: miseCents,
                  gross_cents: p.grossCents, fee_cents: p.feeCents, net_cents: p.netCents, digest_match };
  const livre = L.mouvementMise({ userId, matchId: id, miseCents })
    .concat(L.mouvementGain({ userId, matchId: id, miseCents, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: digest_match }));
  return { ligne, livre };
}

test('ledgerReconcile ne se plaint de rien quand tout s\'apparie, sur les cinq issues', () => {
  const { ligne, livre } = scenarioRegle();
  assert.deepStrictEqual(L.ledgerReconcile(ligne, livre), []);
  assert.deepStrictEqual(L.ledgerReconcile([ligne], livre), []);
  // Une ligne OUVERTE : le séquestre porte la mise, et rien d'autre.
  const ouvert = { id: 2, user_id: 1, status: 'open', stake_cents: 50, net_cents: null };
  assert.deepStrictEqual(L.ledgerReconcile(ouvert, L.mouvementMise({ userId: 1, matchId: 2, miseCents: 50 })), []);
  // Les quatre autres clôtures, séquestre vidé et aucun montant à retrouver.
  for (const status of ['expired', 'rejected', 'abandoned', 'renounced']) {
    const clos = { id: 3, user_id: 1, status, stake_cents: 50, net_cents: null };
    const vide = L.mouvementMise({ userId: 1, matchId: 3, miseCents: 50 })
      .concat(L.mouvementGain({ matchId: 3, miseCents: 50, grossCents: 0, feeCents: 0, netCents: 0 }));
    assert.deepStrictEqual(L.ledgerReconcile(clos, vide), [], status);
  }
  // Une ligne renoncée dont la mise est rendue boucle aussi.
  const rendu = { id: 4, user_id: 1, status: 'renounced', stake_cents: 50, net_cents: null };
  assert.deepStrictEqual(L.ledgerReconcile(rendu,
    L.mouvementMise({ userId: 1, matchId: 4, miseCents: 50 })
      .concat(L.mouvementRemboursement({ userId: 1, matchId: 4, miseCents: 50 }))), []);
  // Une ligne DIVERGENTE : le net est en quarantaine, et c'est là qu'il doit être retrouvé.
  const d = scenarioRegle({ id: 5, digest_match: false });
  assert.deepStrictEqual(L.ledgerReconcile(d.ligne, d.livre), []);
});

test('ledgerReconcile attrape un montant JUSTE posé sur le MAUVAIS compte', () => {
  // Le zéro global ne dit RIEN sur cet appariement : il est vrai même si un montant juste est posé
  // sur le mauvais compte. C'est exactement, et seulement, ce que ce prédicat existe pour attraper.
  const { ligne, livre } = scenarioRegle();
  const totalDe = l => { const s = new Set(); for (const t of l) { s.add(t.compteDebit); s.add(t.compteCredit); }
                         let n = 0; for (const c of s) n += L.soldeDe(l, c); return n; };

  // 1. Le net d'une ligne CONVERGÉE posé en quarantaine : le livre boucle, le joueur est volé.
  const egare = livre.map(t => t.compteCredit === L.compteJoueur(1)
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.compteQuarantaine(1), t.montantCents) : t);
  assert.strictEqual(totalDe(egare), 0, 'le livre boucle quand même : c\'est le piège');
  const g1 = L.ledgerReconcile(ligne, egare);
  assert.ok(g1.some(x => /joueur:1:disponible/.test(x)), g1.join(' | '));
  assert.ok(g1.some(x => /quarantaine/.test(x)), g1.join(' | '));

  // 2. Le net d'une ligne DIVERGENTE posé sur le solde dépensable : la garantie « le solde
  //    dépensable ne compte que des lignes convergées » tombe, et rien d'autre ne le verrait.
  const d = scenarioRegle({ id: 6, digest_match: false });
  const dépensé = d.livre.map(t => t.compteCredit === L.compteQuarantaine(1)
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.compteJoueur(1), t.montantCents) : t);
  assert.strictEqual(totalDe(dépensé), 0);
  assert.ok(L.ledgerReconcile(d.ligne, dépensé).length > 0);

  // 3. La commission versée à la contrepartie : boucle encore, et fausse la mesure de la phase.
  const detourne = livre.map(t => t.compteCredit === L.MAISON_COMMISSION
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.MAISON_CONTREPARTIE, t.montantCents) : t);
  assert.strictEqual(totalDe(detourne), 0);
  const g3 = L.ledgerReconcile(ligne, detourne);
  assert.ok(g3.some(x => /maison:commission/.test(x)), g3.join(' | '));

  // 4. Le bon compte, le mauvais montant : le net d'une AUTRE partie.
  const faux = { ...ligne, net_cents: ligne.net_cents + 1, fee_cents: ligne.fee_cents - 1 };
  assert.strictEqual(L.ledgerReconcile(faux, livre).length, 2);
});

test('ledgerReconcile attrape un billet sans engagement et un engagement sans billet', () => {
  const { ligne, livre } = scenarioRegle();
  // Un billet sans son engagement : c'est aussi la frontière avec la 02a, qu'un module suivant
  // constatera sur une ligne à `trace_steps` nul — une ligne sans mise n'a jamais de gain.
  const sansMise = livre.filter(t => t.motif !== 'mise');
  const g1 = L.ledgerReconcile(ligne, sansMise);
  assert.ok(g1.some(x => /aucun engagement/.test(x)), g1.join(' | '));

  // Un engagement sans son billet : un séquestre habité par une partie que `matches` ne connaît
  // pas, donc de l'argent que rien ne soldera jamais.
  const intrus = livre.concat(L.mouvementMise({ userId: 1, matchId: 4242, miseCents: 100 }));
  const g2 = L.ledgerReconcile(ligne, intrus);
  assert.ok(g2.some(x => /enjeu:4242.*sans billet/.test(x)), g2.join(' | '));
  // Et il disparaît dès que le billet correspondant est présenté, séquestre vidé.
  const autre = scenarioRegle({ id: 4242 });
  assert.deepStrictEqual(L.ledgerReconcile([ligne, autre.ligne], livre.concat(autre.livre)), []);

  // Une mise écrite DEUX FOIS sur le même billet — le POST rejoué qui débite deux fois, le vol le
  // plus facile de la phase.
  const double = livre.concat(L.mouvementMise({ userId: 1, matchId: 1, miseCents: 100 }));
  const g3 = L.ledgerReconcile(ligne, double);
  assert.ok(g3.some(x => /2 écritures de mise/.test(x)), g3.join(' | '));
  // Et une mise du mauvais montant.
  const g4 = L.ledgerReconcile({ ...ligne, stake_cents: 999 }, livre);
  assert.ok(g4.some(x => /mise engagée/.test(x)), g4.join(' | '));
});

test('ledgerReconcile attrape un séquestre NON VIDÉ sur une ligne close', () => {
  // « Aucun séquestre ne reste habité » est l'invariant que le veilleur devenu écrivain d'argent
  // doit tenir. Sans lui, de l'argent reste dans un compte que rien ne solde.
  for (const status of ['settled', 'expired', 'rejected', 'abandoned', 'renounced']) {
    const clos = { id: 9, user_id: 1, status, stake_cents: 75, net_cents: null };
    const habite = L.mouvementMise({ userId: 1, matchId: 9, miseCents: 75 });
    const g = L.ledgerReconcile(clos, habite);
    assert.ok(g.some(x => /séquestre n'est pas vidé.*75/.test(x)), `${status} : ${g.join(' | ')}`);
  }
  // Et l'inverse : une ligne OUVERTE dont le séquestre a déjà été vidé, ou n'a jamais été rempli.
  const ouvert = { id: 9, user_id: 1, status: 'open', stake_cents: 75, net_cents: null };
  const vide = L.mouvementMise({ userId: 1, matchId: 9, miseCents: 75 })
    .concat(L.mouvementGain({ matchId: 9, miseCents: 75, grossCents: 0, feeCents: 0, netCents: 0 }));
  const g = L.ledgerReconcile(ouvert, vide);
  assert.ok(g.some(x => /ouvert.*séquestre porte 0/.test(x)), g.join(' | '));
  // Un statut que le grand livre ne connaît pas ne passe pas en silence.
  assert.ok(L.ledgerReconcile({ id: 9, user_id: 1, status: 'zombie', stake_cents: 75 }, vide)
    .some(x => /statut inconnu/.test(x)));
});

console.log('Lecture de la clé d\'API Crossmint');
test('le base58 fait l\'aller-retour, zéros de tête compris', () => {
  for (let essai = 0; essai < 200; essai++) {
    const n = 1 + Math.floor(Math.random() * 40);
    const octets = crypto.randomBytes(n);
    // Les zéros de tête sont là où les implémentations naïves perdent des octets : on en force.
    for (let i = 0; i < essai % 4 && i < n; i++) octets[i] = 0;
    assert.deepStrictEqual(base58Decode(base58Encode(octets)), octets);
  }
  assert.deepStrictEqual(base58Decode(base58Encode(Buffer.alloc(0))), Buffer.alloc(0));
});
test('un caractère hors alphabet est refusé, pas interprété', () => {
  // « 0 », « O », « I » et « l » n'existent pas en base58 : ce sont ceux qu'on confond en recopiant.
  for (const c of ['0', 'O', 'I', 'l', '+', '/', '=']) assert.throws(() => base58Decode('ab' + c));
});
test('une vraie clé signée est acceptée, et livre son identifiant de projet', () => {
  const a = autorite();
  const r = parseApiKey(fabriqueCle(a, { prefix: 'sk_production', projectId: 'proj_warblock' }),
    { usageOrigin: 'server', signers: a.signers });
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.projectId, 'proj_warblock');
  assert.strictEqual(r.environment, 'production');
  assert.strictEqual(r.usageOrigin, 'server');
});
test('une clé dont on a changé un caractère est refusée', () => {
  const a = autorite();
  const cle = fabriqueCle(a);
  const abime = cle.slice(0, -2) + (cle.endsWith('z') ? 'a' : 'z');
  const r = parseApiKey(abime, { usageOrigin: 'server', signers: a.signers });
  assert.ok(!r.ok, 'une clé abîmée ne doit jamais passer');
});
test('une clé fabriquée par quelqu\'un d\'autre est refusée', () => {
  // Le pirate connaît le format, l'identifiant de projet, tout — sauf la clé privée de Crossmint.
  const vrai = autorite(), pirate = autorite();
  const r = parseApiKey(fabriqueCle(pirate, { projectId: 'proj_warblock' }),
    { usageOrigin: 'server', signers: vrai.signers });
  assert.ok(!r.ok);
  assert.match(r.message, /[Ss]ignature/);
});
test('la clé du jeu ne peut pas servir de clé serveur', () => {
  const a = autorite();
  const r = parseApiKey(fabriqueCle(a, { prefix: 'ck_production' }), { usageOrigin: 'server', signers: a.signers });
  assert.ok(!r.ok);
  assert.match(r.message, /ck_/, 'le message doit dire laquelle des deux clés on attend');
});
test('une clé staging ne passe pas là où la production est exigée', () => {
  const a = autorite();
  const cle = fabriqueCle(a, { prefix: 'sk_staging' });
  assert.ok(parseApiKey(cle, { usageOrigin: 'server', signers: a.signers }).ok);
  assert.ok(!parseApiKey(cle, { usageOrigin: 'server', environment: 'production', signers: a.signers }).ok);
});
test('une clé signée pour staging ne devient pas une clé de production en changeant l\'étiquette', () => {
  // La signature porte sur « préfixe.données » : renommer le préfixe la casse.
  const a = autorite();
  const staging = fabriqueCle(a, { prefix: 'sk_staging' });
  const maquille = 'sk_production_' + staging.slice('sk_staging_'.length);
  assert.ok(!parseApiKey(maquille, { usageOrigin: 'server', signers: a.signers }).ok);
});
test('l\'ancien format de clé est nommé, pas seulement refusé', () => {
  assert.match(parseApiKey('sk_live_abcdef').message, /console/);
  assert.match(parseApiKey('sk_test_abcdef').message, /console/);
});
test('une clé absente, vide ou malformée ne fait pas tomber la lecture', () => {
  for (const mauvaise of [undefined, null, '', 42, {}, 'bonjour', 'sk_', 'sk_prod_x', 'sk_production_', 'sk_production_!!']) {
    const r = parseApiKey(mauvaise);
    assert.strictEqual(r.ok, false, String(mauvaise));
    assert.ok(r.message, 'un refus doit toujours dire pourquoi');
  }
});
test('l\'environnement décide du trousseau public, et staging n\'est pas production', () => {
  assert.strictEqual(jwksUri('production'), 'https://www.crossmint.com/.well-known/jwks.json');
  assert.strictEqual(jwksUri('staging'), 'https://staging.crossmint.com/.well-known/jwks.json');
  assert.notStrictEqual(jwksUri('staging'), jwksUri('production'));
  assert.strictEqual(jwksUri('lune'), null);
});

console.log('Ce qu\'un jeton Crossmint doit prouver');
test('un jeton du bon projet donne l\'identité', () => {
  const id = identityFromClaims(revendications(), { projectId: PROJET });
  assert.strictEqual(id.authId, 'user_1');
  assert.strictEqual(id.email, 'joueur@exemple.test');
});
test('un jeton émis pour un autre projet est refusé', () => {
  // C'est le contrôle que le SDK du fournisseur ne fait pas : le jeton est signé par la bonne
  // autorité et parfaitement valide, il appartient simplement à quelqu'un d'autre.
  assert.throws(() => identityFromClaims(revendications({ aud: 'proj_voisin' }), { projectId: PROJET }),
    /autre projet/);
});
test('un jeton sans destinataire est refusé', () => {
  assert.throws(() => identityFromClaims(revendications({ aud: undefined }), { projectId: PROJET }),
    /autre projet/);
});
test('un destinataire en liste est accepté s\'il nous contient, refusé sinon', () => {
  assert.ok(identityFromClaims(revendications({ aud: ['autre', PROJET] }), { projectId: PROJET }).authId);
  assert.throws(() => identityFromClaims(revendications({ aud: ['autre', 'encore'] }), { projectId: PROJET }));
});
test('un jeton sans expiration est refusé', () => {
  // Sans `exp`, jose n'a rien à comparer : le jeton serait éternel, et un vol de session aussi.
  assert.throws(() => identityFromClaims(revendications({ exp: undefined }), { projectId: PROJET }), /expiration/);
  assert.throws(() => identityFromClaims(revendications({ exp: 'bientôt' }), { projectId: PROJET }), /expiration/);
});
test('un jeton sans sujet est refusé', () => {
  for (const sub of [undefined, '', '   ', 42, null])
    assert.throws(() => identityFromClaims(revendications({ sub }), { projectId: PROJET }), /sujet/);
});
test('sans identifiant de projet à comparer, rien ne passe', () => {
  assert.throws(() => identityFromClaims(revendications(), {}), /projet/);
  assert.throws(() => identityFromClaims(revendications(), { projectId: '' }), /projet/);
});
test('un jeton vide ou d\'un type inattendu est refusé sans casser', () => {
  for (const p of [undefined, null, 'abc', 42, []])
    assert.throws(() => identityFromClaims(p, { projectId: PROJET }));
});
test('l\'email manquant n\'empêche pas la connexion', () => {
  // Crossmint ne met pas toujours l'email dans le jeton. L'identité, c'est `sub` ; l'email est une
  // commodité, et le serveur ira le chercher séparément.
  const id = identityFromClaims(revendications({ email: undefined }), { projectId: PROJET });
  assert.strictEqual(id.email, '');
  assert.strictEqual(id.authId, 'user_1');
});
test('le compte naît sans pseudo : c\'est le joueur qui le choisira', () => {
  const id = identityFromClaims(revendications(), { projectId: PROJET });
  assert.strictEqual(id.name, '');
  assert.ok(C.validName(C.nameOr(id.name, C.NAME.fallback)), 'le repli doit être un pseudo valide');
});

// ---------- de bout en bout, avec de la vraie cryptographie ----------
// Ce bloc est le seul qui demande une dépendance. Il ne s'exécute que si jose est installé, pour que
// `node api/test.js` reste lançable sans rien installer ; l'intégration continue, elle, installe les
// dépendances de l'API et l'exécute vraiment. Il n'appelle jamais Crossmint : le trousseau public
// est servi par un serveur local, ce qui permet d'éprouver aussi les cas qu'on ne peut pas demander
// à un fournisseur — un jeton signé par la mauvaise clé, un jeton expiré, une confusion
// d'algorithme.
let jose = null;
try { jose = require('jose'); } catch { /* pas installé : bloc sauté */ }

if (!jose) {
  console.log('Chaîne complète de vérification (sautée : jose n\'est pas installé — cd api && npm install)');
} else {
  console.log('Chaîne complète de vérification');
  const http = require('node:http');

  const paire = await jose.generateKeyPair('ES256', { extractable: true });
  const pirate = await jose.generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(paire.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

  const trousseau = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(r => trousseau.listen(0, '127.0.0.1', r));
  const jwksUrl = `http://127.0.0.1:${trousseau.address().port}/.well-known/jwks.json`;

  const a = autorite();
  const verifie = require('./auth-crossmint').crossmintVerifier({
    apiKey: fabriqueCle(a, { prefix: 'sk_production', projectId: PROJET }),
    jwksUrl, signers: a.signers,
    // Pas d'email à aller chercher : ce test ne parle à personne d'autre qu'à lui-même.
    lookupEmail: false,
  });

  const jeton = ({ cle = paire.privateKey, alg = 'ES256', aud = PROJET, sub = 'user_1', exp = '2h', ...reste } = {}) => {
    let s = new jose.SignJWT({ email: 'joueur@exemple.test', ...reste })
      .setProtectedHeader({ alg, kid: 'k1' })
      .setIssuedAt()
      .setSubject(sub)
      .setExpirationTime(exp);
    if (aud !== undefined) s = s.setAudience(aud);
    return s.sign(cle);
  };

  await test('un jeton signé par Crossmint, pour notre projet, ouvre la session', async () => {
    const id = await verifie(await jeton());
    assert.strictEqual(id.authId, 'user_1');
    assert.strictEqual(id.email, 'joueur@exemple.test');
  });
  await test('un jeton signé par une autre clé est refusé', async () => {
    await assert.rejects(verifie(await jeton({ cle: pirate.privateKey })));
  });
  await test('un jeton expiré est refusé', async () => {
    await assert.rejects(verifie(await jeton({ exp: Math.floor(Date.now() / 1000) - 3600 })));
  });
  await test('un jeton pour un autre projet est refusé par la signature comme par le contenu', async () => {
    await assert.rejects(verifie(await jeton({ aud: 'proj_voisin' })));
  });
  await test('la clé publique ne peut pas servir de secret partagé', async () => {
    // L'attaque classique : signer en HS256 avec le matériau public, en pariant que le serveur
    // choisisse l'algorithme d'après l'en-tête du jeton. La liste fermée d'algorithmes l'interdit.
    const faux = await new jose.SignJWT({ sub: 'pirate' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt().setSubject('pirate').setAudience(PROJET).setExpirationTime('2h')
      .sign(new TextEncoder().encode(JSON.stringify(jwk)));
    await assert.rejects(verifie(faux));
  });
  await test('un jeton sans signature du tout est refusé', async () => {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const nu = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ sub: 'pirate', aud: PROJET, exp: 4102444800 })}.`;
    await assert.rejects(verifie(nu));
  });
  await test('un jeton du bon émetteur mais sans expiration est refusé', async () => {
    // jose laisse passer un jeton sans `exp` : c'est notre contrôle à nous qui l'arrête.
    const eternel = await new jose.SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuedAt().setSubject('user_1').setAudience(PROJET)
      .sign(paire.privateKey);
    await assert.rejects(verifie(eternel), /expiration/);
  });
  await test('la clé serveur décide du projet : une clé d\'un autre projet ne voit pas nos jetons', async () => {
    const voisin = require('./auth-crossmint').crossmintVerifier({
      apiKey: fabriqueCle(a, { prefix: 'sk_production', projectId: 'proj_voisin' }),
      jwksUrl, signers: a.signers, lookupEmail: false,
    });
    await assert.rejects(voisin(await jeton()), 'un jeton Warblock ne doit pas ouvrir une session ailleurs');
  });
  await test('une clé serveur illisible fait échouer la construction, pas la première connexion', () => {
    assert.throws(() => require('./auth-crossmint').crossmintVerifier({ apiKey: 'sk_production_nimportequoi' }),
      /CROSSMINT_SERVER_API_KEY/);
  });

  trousseau.close();
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
