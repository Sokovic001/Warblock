// Lecture d'une clé d'API Crossmint. Aucune dépendance : tout est dans node:crypto.
//
// Une clé Crossmint n'est pas un secret opaque. Elle porte, en clair pour qui sait la lire, son
// origine (client ou serveur), son environnement, l'identifiant du projet, et une signature ed25519
// de Crossmint sur le tout. On la lit au démarrage pour trois raisons :
//
//   1. Refuser tout de suite une clé tronquée, recopiée à moitié ou d'un mauvais environnement,
//      plutôt qu'à la première connexion d'un joueur, un dimanche soir.
//   2. En tirer l'identifiant de projet. C'est lui qu'on exigera ensuite dans la revendication
//      `aud` des jetons. Sans ce contrôle, un jeton émis pour n'importe quel autre projet
//      Crossmint — signé par la même autorité, donc parfaitement valide — ouvrirait un compte chez
//      nous. Le SDK du fournisseur ne fait pas cette vérification ; c'est à nous de la faire.
//   3. Choisir l'URL du trousseau public. Staging et production n'ont ni les mêmes clés de
//      signature ni les mêmes comptes : accepter les deux reviendrait à laisser l'environnement de
//      test ouvrir des comptes en production.
//
// Format : `<ck|sk>_<environnement>_<base58>`, où le base58 décodé vaut « <données>:<signature> »,
// où les données commencent par l'identifiant du projet, et où la signature porte sur la chaîne
// « <préfixe>.<données> ».
'use strict';
const crypto = require('node:crypto');

// L'alphabet base58 de Bitcoin : ni 0, ni O, ni I, ni l — les caractères qu'on confond en les
// recopiant à la main.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Les clés publiques ed25519 avec lesquelles Crossmint signe ses clés d'API. Elles sont publiques
// par nature — elles ne servent qu'à vérifier — et figurent telles quelles dans le SDK du
// fournisseur. Development et staging partagent la même.
const SIGNERS = {
  development: '3hSfN4dWSwgCg1uf2yytBtK6KxK3ySFKasd2h9J2vSK5',
  staging: '3hSfN4dWSwgCg1uf2yytBtK6KxK3ySFKasd2h9J2vSK5',
  production: '8erZh8YApGck3iUSUHqATBxqMTM1Ukp9mHmvGgUWHtkK',
};

const BASE_URL = {
  development: 'http://localhost:3000',
  staging: 'https://staging.crossmint.com',
  production: 'https://www.crossmint.com',
};

const ORIGINES = { ck: 'client', sk: 'server' };
const ENVIRONNEMENTS = ['development', 'staging', 'production'];

// ---------- base58 ----------
// Écrit ici plutôt qu'installé : dix lignes, et une dépendance de moins dans le chemin qui garde
// l'argent des joueurs. Le test fait l'aller-retour sur des octets tirés au hasard, zéros de tête
// compris — c'est là que les implémentations naïves se trompent.

function base58Encode(octets) {
  const buf = Buffer.from(octets);
  let n = 0n;
  for (const o of buf) n = n * 256n + BigInt(o);
  let sortie = '';
  while (n > 0n) { sortie = BASE58[Number(n % 58n)] + sortie; n /= 58n; }
  // Un octet nul de tête ne pèse rien dans le nombre : il disparaîtrait. Chacun s'écrit « 1 ».
  for (let i = 0; i < buf.length && buf[i] === 0; i++) sortie = '1' + sortie;
  return sortie;
}

function base58Decode(texte) {
  if (typeof texte !== 'string') throw new Error('base58 : chaîne attendue.');
  let n = 0n;
  for (const c of texte) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error(`base58 : caractère invalide « ${c} ».`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const corps = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  while (zeros < texte.length && texte[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), corps]);
}

// ---------- vérification ----------

function cleEd25519(base58) {
  const brut = base58Decode(base58);
  if (brut.length !== 32) throw new Error('clé ed25519 de taille inattendue.');
  // Node construit une clé publique ed25519 à partir d'un JWK sans qu'on ait à fabriquer
  // l'enveloppe DER à la main.
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: brut.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Lit une clé d'API Crossmint et vérifie sa signature.
 *
 * Ne lance jamais : rend `{ ok: false, message }` avec un message qui dit quoi corriger, ou
 * `{ ok: true, usageOrigin, environment, prefix, projectId }`.
 *
 * `attendu.usageOrigin` et `attendu.environment` permettent d'exiger une clé serveur, ou un
 * environnement précis. `attendu.signers` n'existe que pour les tests, qui signent avec une paire
 * qu'ils fabriquent eux-mêmes : en production, les clés ci-dessus font foi.
 */
function parseApiKey(apiKey, attendu = {}) {
  const echec = message => ({ ok: false, message });

  if (typeof apiKey !== 'string' || !apiKey) return echec('clé absente.');
  if (apiKey.startsWith('sk_live') || apiKey.startsWith('sk_test'))
    return echec('ancien format de clé Crossmint. Génère une nouvelle clé dans la console.');

  const marque = apiKey.slice(0, 2);
  const usageOrigin = ORIGINES[marque];
  if (!usageOrigin || apiKey[2] !== '_')
    return echec('clé malformée : elle doit commencer par « ck_ » ou « sk_ ».');

  const reste = apiKey.slice(3);
  const environment = ENVIRONNEMENTS.find(e => reste.startsWith(e + '_'));
  if (!environment)
    return echec(`clé malformée : l'environnement doit être ${ENVIRONNEMENTS.join(', ')}.`);

  if (attendu.usageOrigin && usageOrigin !== attendu.usageOrigin) {
    return echec(`c'est une clé ${usageOrigin}, or une clé ${attendu.usageOrigin} est exigée ici.`
      + (attendu.usageOrigin === 'server'
        ? ' La clé « ck_ » est celle du jeu ; le serveur veut la « sk_ », qui ne quitte jamais le serveur.'
        : ''));
  }
  if (attendu.environment && environment !== attendu.environment)
    return echec(`c'est une clé ${environment}, or ${attendu.environment} est exigé ici.`);

  const prefix = `${marque}_${environment}`;
  let donnees, signature;
  try {
    const morceaux = base58Decode(apiKey.slice(prefix.length + 1)).toString('utf8').split(':');
    if (morceaux.length !== 2 || !morceaux[0] || !morceaux[1]) throw new Error('corps inattendu');
    [donnees, signature] = morceaux;
  } catch {
    return echec('clé illisible : le corps base58 est tronqué ou abîmé.');
  }

  let valide = false;
  try {
    valide = crypto.verify(
      null,
      Buffer.from(`${prefix}.${donnees}`, 'utf8'),
      cleEd25519((attendu.signers || SIGNERS)[environment]),
      base58Decode(signature),
    );
  } catch { valide = false; }
  if (!valide)
    return echec('signature invalide : la clé est tronquée, recopiée à moitié, ou fabriquée.');

  const projectId = donnees.split('.')[0];
  if (!projectId) return echec('clé sans identifiant de projet.');

  return { ok: true, usageOrigin, environment, prefix, projectId };
}

const crossmintBaseUrl = environment => BASE_URL[environment] || null;

// Le trousseau public de Crossmint : les clés avec lesquelles les jetons de session sont signés.
// C'est le seul appel réseau que fait l'authentification, et il est mis en cache par jose.
const jwksUri = environment => {
  const base = crossmintBaseUrl(environment);
  return base ? `${base}/.well-known/jwks.json` : null;
};

module.exports = { parseApiKey, base58Encode, base58Decode, crossmintBaseUrl, jwksUri, SIGNERS, BASE_URL };
