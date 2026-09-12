// Lancer : node api/test.js — aucune dépendance, aucune base, aucun compte.
// La base et la vérification du jeton sont remplacées par des doublures, ce qui laisse le routeur
// entièrement couvert : authentification, validation, unicité du pseudo, limitation de débit, CORS.
'use strict';
const assert = require('assert');
const crypto = require('node:crypto');
const { createApp, checkProfile, makeLimiter } = require('./app');
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
function fakeDb(seed = []) {
  const users = seed.map(u => ({ ...u }));
  let next = users.length + 1;
  const statsOf = id => ({ matches: 0, wins: 0, kills: 0, best: 0, ...(users.find(u => u.id === id) || {}).stats });
  return {
    users,
    async findOrCreate({ authId, email, name, nameKey }) {
      let u = users.find(x => x.auth_id === authId);
      if (!u) {
        let base = name, cle = nameKey(base), n = 1;
        while (users.some(x => x.name_key === cle)) {
          n += 1; const s = String(n);
          base = name.slice(0, 14 - s.length) + s; cle = nameKey(base);
        }
        u = { id: next++, auth_id: authId, email, name: base, name_key: cle, avatar: '', country: null,
              created_at: '2026-01-01T00:00:00Z', stats: { matches: 0, wins: 0, kills: 0, best: 0 } };
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

console.log('Le serveur partage les règles du jeu');
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
