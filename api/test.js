// Lancer : node api/test.js — aucune dépendance, aucune base, aucun compte.
// La base et la vérification du jeton sont remplacées par des doublures, ce qui laisse le routeur
// entièrement couvert : authentification, validation, unicité du pseudo, limitation de débit, CORS.
'use strict';
const assert = require('assert');
const { createApp, checkProfile, makeLimiter } = require('./app');
const C = require('./core');

let passed = 0;
function test(nom, fn) {
  const r = fn();
  const fini = () => { passed++; console.log('  ✓', nom); };
  const rate = e => { console.log('  ✗', nom, '\n    ', e && e.message || e); process.exitCode = 1; };
  return (r && typeof r.then === 'function') ? r.then(fini, rate) : (() => { try { fini(); } catch (e) { rate(e); } })();
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
