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
                       'seconds', 'kills', 'deaths', 'rank', 'cubes', 'damage'];
function verifierInt4(valeurs) {
  for (const c of COLONNES_INT4) {
    const v = valeurs[c];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v > PG_INT4_MAX || v < PG_INT4_MIN) {
      const e = new Error(`value "${v}" is out of range for type integer`);
      e.code = '22003';
      throw e;
    }
  }
}
function fakeDb(seed = []) {
  const users = seed.map(u => ({ ...u }));
  const matches = [];
  let next = users.length + 1, nextMatch = 1;
  // Les statistiques sont la SOMME des parties réglées, exactement comme l'agrégat SQL de
  // db-pg.js. Aucun compteur n'existe nulle part : il n'y a rien à incrémenter, donc rien qu'un
  // double envoi puisse fausser. Une partie refusée, périmée ou encore ouverte ne compte pour
  // rien, et `wins` retient la victoire comme l'encaissement — le jeu compte les deux.
  const statsOf = id => {
    const reglees = matches.filter(m => m.user_id === id && m.status === 'settled');
    return {
      matches: reglees.length,
      wins: reglees.filter(m => m.issue === 'victoire' || m.issue === 'encaissement').length,
      kills: reglees.reduce((s, m) => s + (m.kills || 0), 0),
      best: reglees.reduce((b, m) => Math.max(b, m.net_cents || 0), 0),
    };
  };
  return {
    users,
    matches,
    // La doublure imite les deux CONTRAINTES de la base, dans l'ordre exact de db-pg.js. Elle ne
    // regarde jamais si un billet existe avant de décider d'en créer un : elle rejoue ce que la
    // base répondrait à une insertion refusée. C'est aussi la limite connue de cet exercice — rien
    // ici ne prouve que Postgres se comporte comme ce code-là.
    async createMatch(m) {
      const rejeu = matches.find(x => x.user_id === m.userId && x.client_key === m.clientKey);
      if (rejeu) return { match: rejeu, repris: true };
      let ouvert = matches.find(x => x.user_id === m.userId && x.status === 'open');
      if (ouvert && !(new Date(ouvert.expires_at) > m.openedAt)) { ouvert.status = 'expired'; ouvert = null; }
      if (ouvert) return { match: ouvert, repris: true };
      const ligne = {
        id: nextMatch++, user_id: m.userId, mode: m.mode, stake_cents: m.stakeCents, seats: m.seats,
        team_size: m.teamSize,
        brawler: m.brawler, seed_public: m.seedPublic, seed_secret: m.seedSecret,
        client_key: m.clientKey, status: 'open', opened_at: m.openedAt, expires_at: m.expiresAt,
      };
      verifierInt4(ligne);
      matches.push(ligne);
      return { match: ligne, repris: false };
    },
    async findMatch({ matchId, userId }) {
      // `user_id` fait partie de la recherche, pas d'une vérification après coup : un identifiant
      // deviné ne doit rien apprendre sur la partie de quelqu'un d'autre.
      return matches.find(x => String(x.id) === String(matchId) && x.user_id === userId) || null;
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
      };
      // Vérifié AVANT d'écrire : une ligne à demi réglée par une écriture qui échoue en plein
      // milieu serait pire que la panne qu'on cherche à reproduire.
      verifierInt4(ecriture);
      Object.assign(m, ecriture);
      return { match: m, deja: false };
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
const T0 = Date.parse('2026-01-01T12:00:00Z');
const BRAWLER = Object.keys(C.BRAWLERS)[0];
const DEMANDE = { mode: 'solo', stake: 0.5, brawler: BRAWLER, clientKey: 'cle-1' };

function bancDeBillet(extra = {}) {
  const db = fakeDb();
  const horloge = { t: T0 };
  let tire = 0;
  const app = appDe(db, {
    randomSeed: () => {
      if (tire >= GRAINES.length) throw new Error('la source de graines est épuisée : trop de tirages');
      return GRAINES[tire++];
    },
    now: () => horloge.t,
    ...extra,
  });
  return { db, app, horloge, tires: () => tire };
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
  const { db, app, tires } = bancDeBillet();
  const r = await demander(app);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.seed, GRAINES[0]);
  assert.strictEqual(db.matches[0].seed_public, GRAINES[0]);
  assert.strictEqual(db.matches[0].seed_secret, GRAINES[1]);
  assert.strictEqual(tires(), 2, 'deux graines par billet, et deux seulement');
  const texte = JSON.stringify(r.corps);
  assert.ok(!texte.includes(String(GRAINES[1])), 'la graine secrète a fui : ' + texte);
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
                        'netCents', 'purseCents', 'declaredNetCents', 'ecartCents', 'settledAt'];

await test('le résultat ferme la ligne et rend un net ENCADRÉ, jamais celui du client', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  // Sacoche de toute la table, et un net annoncé délirant : le serveur paie la sacoche bornée,
  // jamais le nombre annoncé. Le plafond atteint est exactement celui que le lobby affiche.
  const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
  const r = RAPPORT({ seconds: 154, rank: 1, kills: 19, purseCents: max, declaredNetCents: 9_999_999 });
  horloge.t = ARRIVEE(r);
  const rep = await rendre(app, b.corps.id, r);
  assert.strictEqual(rep.code, 200);
  assert.strictEqual(rep.corps.status, 'settled');
  assert.strictEqual(rep.corps.issue, 'victoire');
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(max).netCents);
  assert.strictEqual(rep.corps.netCents, C.payoutCents(50, C.MODES.solo).winnerCents,
    'le forfait du lobby reste le plafond, et il est atteint exactement');
  assert.ok(rep.corps.feeCents > 0, 'la commission ne tombe jamais à zéro');
  assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents);
  assert.strictEqual(rep.corps.declaredNetCents, 9_999_999);
  assert.strictEqual(rep.corps.ecartCents, 9_999_999 - rep.corps.netCents,
    'l\'écart est mesuré et stocké, jamais payé');
  assert.deepStrictEqual(Object.keys(rep.corps).sort(), CLES_REGLEMENT.slice().sort());
  // La ligne est close, la mise et les graines n'ont pas bougé, et rien n'a été inséré à côté.
  assert.strictEqual(db.matches.length, 1);
  assert.strictEqual(db.matches[0].stake_cents, 50);
  assert.strictEqual(db.matches[0].seed_public, GRAINES[0]);
  assert.ok(!JSON.stringify(rep.corps).includes(String(GRAINES[1])), 'la graine secrète a fui');
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
  const r = RAPPORT({ seconds: 60, rank: 1 });
  horloge.t = ARRIVEE(r);
  await rendre(app, b.corps.id, r);
  const regle = JSON.stringify(db.matches[0]);
  const second = await db.settleMatch({
    matchId: b.corps.id, userId: db.users[0].id, status: 'settled', settledAt: new Date(0),
    issue: 'victoire', controle: null, motif: null,
    grossCents: 999_999, feeCents: 0, netCents: 999_999, purseCents: 999_999,
    declaredNetCents: 999_999, ecartCents: 0,
    seconds: 1, kills: 1, deaths: 0, rank: 1, cubes: 0, damage: 0, cashedOut: false,
  });
  assert.strictEqual(second.deja, true, 'un second règlement doit être reconnu comme un rejeu');
  assert.strictEqual(JSON.stringify(db.matches[0]), regle, 'un montant déjà écrit a été réécrit');
});
await test('un résultat qui arrive en retard, mais avant expiration, est accepté', async () => {
  // Si couper le wifi effaçait une partie perdue, ce serait la meilleure stratégie du jeu.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const r = RAPPORT({ seconds: 154, rank: 1, purseCents: 250 });
  horloge.t = Date.parse(b.corps.expiresAt) - 1000;
  const rep = await rendre(app, b.corps.id, r);
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
await test('une partie refusée est close avec son motif, et ne compte dans aucune statistique', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const r = RAPPORT({ seconds: 60, rank: 1, kills: 999, declaredNetCents: 1000 });
  horloge.t = ARRIVEE(r);
  const rep = await rendre(app, b.corps.id, r);
  assert.strictEqual(rep.corps.status, 'rejected');
  assert.strictEqual(rep.corps.issue, 'refus');
  assert.strictEqual(rep.corps.controle, 'kills');
  assert.ok(rep.corps.motif && rep.corps.motif.length > 10, 'un refus doit dire pourquoi');
  assert.strictEqual(rep.corps.netCents, 0);
  // La mesure survit au refus : c'est elle qui fixera un seuil en phase 06.
  assert.strictEqual(rep.corps.ecartCents, 1000);
  assert.strictEqual(db.matches[0].status, 'rejected');
  // Et une partie refusée n'est ni réglée ni ouverte : aucune somme sur `status = 'settled'` ne la
  // verra jamais.
  assert.strictEqual(db.matches.filter(m => m.status === 'settled').length, 0);
});
await test('en Resurgence le montant est encadré, pas recalculé — et l\'énorme est refusé', async () => {
  const { app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
  const juste = RAPPORT({ seconds: 40, kills: 5, cashedOut: true, purseCents: max });
  horloge.t = ARRIVEE(juste);
  const ok = await rendre(app, b.corps.id, juste);
  assert.strictEqual(ok.corps.issue, 'encaissement');
  assert.strictEqual(ok.corps.netCents, C.cashoutCents(max).netCents);
  assert.strictEqual(ok.corps.purseCents, max);
  // Le même appel avec une sacoche impossible : refusé, et le montant retenu reste la borne.
  const autre = bancDeBillet();
  const b2 = await demander(autre.app, { ...DEMANDE, mode: 'resurgence' });
  const trop = RAPPORT({ seconds: 40, kills: 5, cashedOut: true, purseCents: 99_999_999 });
  autre.horloge.t = ARRIVEE(trop);
  const ko = await rendre(autre.app, b2.corps.id, trop);
  assert.strictEqual(ko.corps.controle, 'sacoche');
  assert.strictEqual(ko.corps.netCents, 0);
  assert.strictEqual(ko.corps.purseCents, C.purseBound(b2.corps.stakeCents, b2.corps.seats).maxCents,
    'la sacoche retenue est ramenée à la borne, même sur un refus');
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
    const r = { ...RAPPORT({ seconds: 60, rank: 1, purseCents: 300 }), [champ]: 3_000_000_000 };
    horloge.t = ARRIVEE(r);
    const ko = await rendre(app, b.corps.id, r);
    assert.strictEqual(ko.code, 400, `${champ} : attendu un refus motivé, pas un 500 muet`);
    assert.ok(ko.corps.erreurs.some(e => e.code === 'borne' && e.field === champ),
      `${champ} : ${JSON.stringify(ko.corps.erreurs)}`);
    assert.strictEqual(db.matches[0].status, 'open', `${champ} : la ligne a été close par un refus d'analyse`);

    const bon = RAPPORT({ seconds: 60, rank: 1, purseCents: 300 });
    horloge.t = ARRIVEE(bon);
    const ok = await rendre(app, b.corps.id, bon);
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
  return Promise.all([['duo', 1], ['trio', 1], ['solo', 10], ['resurgence', 5]].map(async ([cle, stake]) => {
    const { db, app, horloge } = bancDeBillet();
    const mode = C.MODES[cle];
    const b = await demander(app, { ...DEMANDE, mode: cle, stake });
    const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
    const r = RAPPORT({ seconds: 154, rank: 1, kills: 3, cashedOut: !!mode.cashout, purseCents: max });
    horloge.t = ARRIVEE(r);
    const rep = await rendre(app, b.corps.id, r);
    assert.strictEqual(rep.corps.status, 'settled', `${cle} : ${rep.corps.motif}`);
    assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents, cle);
    assert.strictEqual(rep.corps.grossCents, max, `${cle} : le brut est la sacoche`);
    // Et le plafond reste celui que le lobby promet, jamais dépassé.
    assert.strictEqual(rep.corps.netCents, C.payoutCents(b.corps.stakeCents, mode).winnerCents, cle);
    const ligne = db.matches[0];
    assert.strictEqual(ligne.fee_cents + ligne.net_cents, ligne.gross_cents, `${cle} : la ligne ne s'équilibre pas`);
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
  const r = RAPPORT({ seconds: 60, rank: 3 });
  horloge.t = ARRIVEE(r);
  await appel(app, { method: 'POST', path: `/api/match/${regle.corps.id}/result`, token: 'ok:u2:Zoe', body: r });
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
  const r = RAPPORT({ seconds: 60, rank: 3 });
  horloge.t = ARRIVEE(r);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await rendre(app, b.corps.id, r)).code);
  assert.deepStrictEqual(codes, [200, 200, 429], codes.join(','));
  // Le seau du billet, lui, n'a servi qu'une fois : demander une partie reste possible.
  assert.strictEqual((await demander(app, { ...DEMANDE, clientKey: 'cle-2' })).code, 200);
});

console.log('Les statistiques sont la somme des parties');
// Une partie entière, du billet au règlement, avec une horloge qui avance comme celle d'un joueur
// honnête. Chaque partie ouvre SON billet : un joueur n'en a qu'un ouvert à la fois, et c'est le
// règlement qui libère la place — donc enchaîner des parties éprouve aussi cela.
const jouer = async (app, horloge, cle, rapport, demande = DEMANDE) => {
  const b = await demander(app, { ...demande, clientKey: cle });
  horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + rapport.seconds + 3) * 1000;
  return rendre(app, b.corps.id, rapport);
};
const mesStats = async app => (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;

await test('les statistiques rendues sont exactement la somme des parties réglées', async () => {
  const { db, app, horloge } = bancDeBillet();
  assert.deepStrictEqual(await mesStats(app), { matches: 0, wins: 0, kills: 0, best: 0 },
    'un compte neuf n\'a rien à initialiser : la somme d\'un ensemble vide vaut zéro');

  const gagnee = await jouer(app, horloge, 'p1', RAPPORT({ seconds: 154, rank: 1, kills: 7, purseCents: 400 }));
  assert.strictEqual(gagnee.corps.status, 'settled');
  const perdue = await jouer(app, horloge, 'p2', RAPPORT({ seconds: 60, rank: 5, kills: 2 }));
  assert.strictEqual(perdue.corps.issue, 'defaite');

  const s = await mesStats(app);
  assert.deepStrictEqual(s, {
    matches: 2, wins: 1, kills: 9,
    best: C.cashoutCents(400).netCents,
  });
  // Et rien nulle part ne ressemble à un compteur : la somme se refait à l'identique depuis les
  // lignes, ce qui est précisément la propriété qu'un double envoi ne peut pas casser.
  const reglees = db.matches.filter(m => m.status === 'settled');
  assert.strictEqual(s.matches, reglees.length);
  assert.strictEqual(s.kills, reglees.reduce((t, m) => t + m.kills, 0));
});
await test('une partie refusée ou restée ouverte ne compte pour rien', async () => {
  const { db, app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1', RAPPORT({ seconds: 154, rank: 1, kills: 3 }));
  const avant = await mesStats(app);

  // Refusée : la ligne est close avec son motif, et aucune somme ne la verra jamais.
  const refus = await jouer(app, horloge, 'p2', RAPPORT({ seconds: 60, rank: 2, kills: 999 }));
  assert.strictEqual(refus.corps.status, 'rejected');
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
  // Le prix est la sacoche emportée : une rafle complète sur la table SHARK contre une victoire
  // les poches à peine remplies sur la table STREET.
  const grosse = C.cashoutCents(C.toCents(10) * 20).netCents;
  const petite = C.cashoutCents(100).netCents;
  assert.ok(grosse > petite);

  await jouer(app, horloge, 'p1', RAPPORT({ seconds: 154, rank: 1, purseCents: C.toCents(10) * 20 }), { ...DEMANDE, stake: 10 });
  assert.strictEqual((await mesStats(app)).best, grosse);
  // Une victoire plus modeste ensuite ne doit RIEN changer : c'est un maximum, pas un dernier
  // résultat, et surtout pas un cumul.
  await jouer(app, horloge, 'p2', RAPPORT({ seconds: 154, rank: 1, purseCents: 100 }), { ...DEMANDE, stake: 0.5 });
  const s = await mesStats(app);
  assert.strictEqual(s.best, grosse);
  assert.notStrictEqual(s.best, grosse + petite);
  // En centimes ENTIERS jusqu'au bout du réseau. La conversion en dollars n'a lieu qu'une fois,
  // côté jeu, dans `applyAccount` — que l'on vérifie ici brancher sur la même valeur.
  assert.ok(Number.isInteger(s.best));
  assert.strictEqual(C.applyAccount(null, { stats: s }, []).stats.best, C.fromCents(grosse));
});
await test('un encaissement Resurgence compte comme une sortie gagnante, comme dans le jeu', async () => {
  // `endMatch` incrémente `wins` dès que `won` est vrai, encaissement compris. Si le serveur
  // comptait autrement, se connecter ferait BAISSER le compteur d'un joueur de Resurgence.
  const { app, horloge } = bancDeBillet();
  const demande = { ...DEMANDE, mode: 'resurgence' };
  const b = await demander(app, { ...demande, clientKey: 'p0' });
  const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
  const r = RAPPORT({ seconds: 40, kills: 5, cashedOut: true, purseCents: max });
  horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + r.seconds + 3) * 1000;
  const rep = await rendre(app, b.corps.id, r);
  assert.strictEqual(rep.corps.issue, 'encaissement');
  assert.deepStrictEqual(await mesStats(app),
    { matches: 1, wins: 1, kills: 5, best: C.cashoutCents(max).netCents });
});
await test('les parties d\'un joueur ne comptent que pour lui', async () => {
  const { app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1', RAPPORT({ seconds: 154, rank: 1, kills: 4 }));
  const voisin = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u2:Zoe',
                                    body: { ...DEMANDE, clientKey: 'z-1' } });
  const r = RAPPORT({ seconds: 154, rank: 1, kills: 11 });
  horloge.t = Date.parse(voisin.corps.openedAt) + (C.LOBBY.wait + r.seconds + 3) * 1000;
  await appel(app, { method: 'POST', path: `/api/match/${voisin.corps.id}/result`,
                     token: 'ok:u2:Zoe', body: r });
  const a = await mesStats(app);
  const z = (await appel(app, { token: 'ok:u2:Zoe' })).corps.stats;
  assert.strictEqual(a.kills, 4);
  assert.strictEqual(z.kills, 11);
  assert.strictEqual(a.matches, 1);
  assert.strictEqual(z.matches, 1);
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
    stats: { matches: '2', wins: '1', kills: '9', best: '160' },
  });
  const r = await appel(appDe(db), { token: 'ok:u1:Loic' });
  for (const [k, v] of Object.entries(r.corps.stats)) assert.strictEqual(typeof v, 'number', k);
  assert.deepStrictEqual(r.corps.stats, { matches: 2, wins: 1, kills: 9, best: 160 });
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
    'order', 'by', 'limit', 'count', 'sum', 'max', 'coalesce', 'filter', 'as', 'now']);
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
    ['create table if not exists matches', 'create table if not exists users']);
  // « Une partie refusée ou restée ouverte ne compte pour rien » se prouve plus haut contre la
  // doublure ; la vraie requête, elle, n'est jamais exécutée par un test. On relit donc son texte.
  // Les commentaires sont retirés d'abord : ils citent `count()` et `sum()` entre accents graves,
  // et une garde qui prend un commentaire pour une requête ne garde rien. C'est arrivé en
  // écrivant ce test, exactement comme au module précédent.
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const agregat = (pg.match(/`[^`]*`/g) || []).filter(q => /\bcount\s*\(/i.test(q));
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
