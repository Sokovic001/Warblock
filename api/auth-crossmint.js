// La vérification du jeton de session Crossmint.
//
// Pourquoi jose plutôt que @crossmint/server-sdk : le SDK du fournisseur vérifie la signature et
// l'expiration, et rien d'autre. Il ne regarde pas la revendication `aud` — j'ai lu son code. Or
// `aud` porte l'identifiant du projet, et sans ce contrôle un jeton émis pour un autre projet
// Crossmint, signé par la même autorité et donc valide de bout en bout, ouvrirait un compte chez
// nous. Il faut donc ajouter le contrôle de toute façon. Et pour l'ajouter au-dessus du SDK, il
// faudrait installer @solana/web3.js et viem — quelques centaines de paquets — pour vérifier un
// jeton. On prend jose directement : c'est exactement la bibliothèque que le SDK utilise à
// l'intérieur, elle n'a aucune dépendance, et on y met plus de contrôles que lui.
//
// Ce qui est vérifié, dans l'ordre :
//   signature contre le trousseau public de Crossmint (rotation et cache gérés par jose)
//   algorithme dans une liste fermée
//   expiration, avec cinq secondes de tolérance d'horloge
//   `aud` = l'identifiant de notre projet, celui que porte notre propre clé d'API
//   `sub` présent et non vide : c'est l'identité, et elle ne se devine pas
//   `exp` présent : un jeton sans expiration est un jeton éternel, on n'en veut pas
'use strict';
const { parseApiKey, jwksUri, crossmintBaseUrl } = require('./crossmint-key');

// jose refuse déjà « none » et les algorithmes symétriques quand la clé vient d'un JWKS. L'écrire
// noir sur blanc évite qu'une rotation surprise chez le fournisseur n'élargisse en silence ce que
// nous acceptons.
const ALGOS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

// Les horloges de deux machines ne sont jamais tout à fait d'accord. Cinq secondes couvrent la
// dérive ordinaire sans rendre un jeton expiré utilisable de façon intéressante.
const CLOCK_TOLERANCE = 5;

const RESEAU_MS = 5000;

/**
 * Traduit les revendications d'un jeton vérifié en identité, et refuse ce qui ne va pas.
 *
 * Séparée du reste pour une raison précise : cette fonction ne demande ni réseau ni dépendance, donc
 * `api/test.js` la couvre entièrement sans rien installer. Tout ce que ce fichier décide se décide
 * ici ; jose ne fait que la cryptographie.
 *
 * Le contrôle de `aud` est fait ici *et* passé à jose. C'est volontairement redondant : le jour où
 * quelqu'un touchera aux options de jose, le test d'ici tombera.
 */
function identityFromClaims(payload, { projectId } = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('jeton sans contenu.');
  if (!projectId) throw new Error('identifiant de projet inconnu.');

  const sub = payload.sub;
  if (typeof sub !== 'string' || !sub.trim()) throw new Error('jeton sans sujet.');

  // `aud` vaut une chaîne ou une liste, selon l'émetteur. Les deux formes sont légales.
  const aud = Array.isArray(payload.aud) ? payload.aud : (payload.aud === undefined ? [] : [payload.aud]);
  if (!aud.includes(projectId))
    throw new Error('jeton émis pour un autre projet.');

  if (typeof payload.exp !== 'number' || !isFinite(payload.exp))
    throw new Error('jeton sans expiration.');

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';

  return {
    authId: sub.trim(),
    email,
    // Crossmint ne transporte pas de pseudo : il n'en demande pas à l'inscription. Le compte naîtra
    // donc avec le pseudo de repli, et le joueur le changera dans son profil. Rien ne casse.
    name: '',
  };
}

/**
 * Va chercher l'email d'un joueur chez Crossmint quand le jeton ne le porte pas.
 *
 * Appelée au plus une fois par joueur en pratique : seule la création du compte a besoin de
 * l'email, et `GET /api/me` ne la rappelle que si la revendication manque. Un échec n'est jamais
 * fatal — l'email est une commodité d'affichage à ce stade, pas une identité : l'identité, c'est
 * `sub`. Le jour où l'email servira à autre chose (phase 04, les retraits), ce sera une vérification
 * en bonne et due forme, pas un champ d'affichage.
 */
async function fetchEmail({ apiKey, environment }, authId) {
  const base = crossmintBaseUrl(environment);
  if (!base) return '';
  const url = `${base}/api/2024-09-26/sdk/auth/user/${encodeURIComponent(authId)}`;
  const r = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(RESEAU_MS),
  });
  if (!r.ok) return '';
  const u = await r.json();
  return u && typeof u.email === 'string' ? u.email : '';
}

/**
 * Fabrique la fonction que `createApp` appelle sur chaque requête authentifiée.
 *
 * `apiKey` doit être la clé **serveur** (`sk_`). La clé `ck_` est celle du jeu, et elle est publique :
 * la passer ici serait accepter des jetons sur la foi d'une valeur que n'importe qui peut lire dans
 * le code de la page.
 */
function crossmintVerifier({ apiKey, jwksUrl, lookupEmail = true, signers } = {}) {
  // Chargé ici et pas en tête de fichier : `api/test.js` doit pouvoir exiger ce module sans qu'une
  // seule dépendance soit installée. Ici, en revanche, l'absence de jose doit faire échouer le
  // démarrage tout de suite, pas la première connexion d'un joueur.
  const jose = require('jose');

  // `signers` n'existe que pour le test de bout en bout, qui fabrique sa propre autorité faute de
  // pouvoir forger une vraie clé Crossmint. En production, les clés publiques de crossmint-key.js
  // font foi.
  const cle = parseApiKey(apiKey, { usageOrigin: 'server', signers });
  if (!cle.ok) throw new Error(`CROSSMINT_SERVER_API_KEY : ${cle.message}`);

  const uri = jwksUrl || jwksUri(cle.environment);
  if (!uri) throw new Error(`Aucun trousseau connu pour l'environnement ${cle.environment}.`);

  // jose garde le trousseau en mémoire, le recharge quand un identifiant de clé inconnu apparaît,
  // et refuse de marteler le fournisseur entre deux rechargements. C'est précisément la mécanique
  // qu'on écrirait mal en la réécrivant.
  const trousseau = jose.createRemoteJWKSet(new URL(uri), {
    timeoutDuration: RESEAU_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  const verifier = async function (jeton) {
    const { payload } = await jose.jwtVerify(jeton, trousseau, {
      audience: cle.projectId,
      algorithms: ALGOS,
      clockTolerance: CLOCK_TOLERANCE,
    });
    const identite = identityFromClaims(payload, { projectId: cle.projectId });
    if (!identite.email && lookupEmail) {
      identite.email = await fetchEmail({ apiKey, environment: cle.environment }, identite.authId)
        .catch(() => '');
    }
    return identite;
  };

  // De quoi écrire une ligne de démarrage utile. Ni l'un ni l'autre n'est un secret : l'identifiant
  // de projet voyage dans chaque jeton, et l'environnement se lit dans le préfixe de la clé.
  verifier.projectId = cle.projectId;
  verifier.environment = cle.environment;
  verifier.jwksUri = uri;
  return verifier;
}

module.exports = { crossmintVerifier, identityFromClaims, fetchEmail, ALGOS, CLOCK_TOLERANCE };
