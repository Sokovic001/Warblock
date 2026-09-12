# API Warblock — phase 01 : comptes et profils

Le jeu reste ce qu'il est : un seul fichier `index.html`, servi en statique, sans build. Ce dossier
ajoute à côté un petit serveur qui détient les profils. Les deux communiquent par HTTPS, et le jeu
ne devient dépendant du serveur que pour le profil.

**Aucun argent ne circule dans cette phase.** Il n'y a pas de colonne « solde », volontairement :
en phase 03 le solde sera la somme d'écritures immuables, et une case qu'on écrase serait
exactement ce qu'il faudrait supprimer. Mieux vaut ne pas la créer.

## Ce que le serveur fait

| Route | Ce qu'elle fait |
|---|---|
| `GET /api/health` | Répond `{ ok: true }`. Pour la surveillance. |
| `GET /api/me` | Rend le profil du joueur connecté. **La première connexion crée le compte.** |
| `PATCH /api/me` | Change le pseudo, l'avatar ou le pays. Rien d'autre n'est modifiable. |

Tout le reste répond 404. `GET` et `PATCH` exigent un jeton de session valide.

## Les fichiers

```
app.js              le routeur. Aucune dépendance, tout lui est injecté.
core.js             charge WBCore depuis index.html
crossmint-key.js    lit une clé d'API Crossmint et vérifie sa signature — sans dépendance
auth-crossmint.js   vérifie les jetons de session                  ← touche le réseau
db-pg.js            Postgres                                       ← touche la base
main.js             assemble les trois et écoute
schema.sql          le schéma. Aucune colonne « solde », volontairement.
test.js             46 tests sans rien installer, 55 avec jose
```

## Les règles ne sont pas recopiées

`api/core.js` charge le bloc `WBCore` **depuis `index.html`**, le même que le navigateur exécute.
Le pseudo est validé côté serveur par `sanitizeName()` et `validName()`, les mêmes fonctions qui
tournent dans le jeu, et l'unicité s'appuie sur `nameKey()`.

C'est ce qui rendra la phase 02 possible sans réécriture : le jour où le serveur simulera les
parties, il aura déjà les vraies règles, avec les tests qui vont avec.

## L'identité : Crossmint

Crossmint fournit la connexion par email **et** le portefeuille. C'est ce qui a fait pencher la
balance : le portefeuille dont le joueur aura besoin en phase 04 naîtra du même compte que sa
session, sans second fournisseur à réconcilier.

Une clé d'API Crossmint n'est pas un secret opaque : elle porte, lisible par qui sait la lire, son
origine (`ck_` pour le jeu, `sk_` pour le serveur), son environnement, l'identifiant du projet, et
une signature ed25519 de Crossmint sur le tout. `crossmint-key.js` la lit **au démarrage** : une clé
tronquée, recopiée à moitié, ou d'un mauvais environnement fait échouer le lancement avec un message
qui dit quoi corriger — pas la première connexion d'un joueur, un dimanche soir.

De cette lecture sortent deux choses : l'identifiant du projet, et l'URL du trousseau public.

### Ce que chaque jeton doit prouver

| Contrôle | Pourquoi |
|---|---|
| signature contre le trousseau public de Crossmint | c'est bien Crossmint qui l'a émis |
| algorithme dans une liste fermée | interdit la confusion d'algorithme, et le `none` |
| expiration, 5 s de tolérance d'horloge | une session volée finit par mourir |
| `exp` **présent** | un jeton sans expiration est un jeton éternel |
| `aud` = notre identifiant de projet | il a été émis pour **nous** |
| `sub` présent et non vide | il désigne quelqu'un |

Le quatrième et le cinquième sont à nous, et le cinquième mérite un mot. J'ai lu le code de
`@crossmint/server-sdk` : `verifyCrossmintJwt` vérifie la signature et l'expiration, **et rien
d'autre**. Il ne regarde pas `aud`. Or `aud` porte l'identifiant du projet : sans ce contrôle, un
jeton émis pour n'importe quel autre projet Crossmint — signé par la même autorité, donc valide de
bout en bout — ouvrirait un compte chez nous. Le contrôle était à ajouter de toute façon.

### Pourquoi `jose` et pas le SDK du fournisseur

Puisqu'il fallait ajouter un contrôle par-dessus le SDK, restait à savoir ce que coûtait le SDK.
`@crossmint/server-sdk` tire `@crossmint/common-sdk-base`, qui tire `@solana/web3.js` et `viem` :
quelques centaines de paquets pour vérifier un jeton. Tout ça est du code qui s'exécutera un jour
sur le chemin de l'argent des joueurs.

`jose` est exactement la bibliothèque que le SDK utilise à l'intérieur. Elle n'a aucune dépendance,
elle est maintenue et largement auditée, et elle gère ce qu'on écrirait mal en le réécrivant : le
cache du trousseau, sa rotation, le refus de marteler le fournisseur. Le reste — les six lignes du
tableau ci-dessus — tient dans `identityFromClaims()`, qui ne demande ni réseau ni dépendance et que
les tests couvrent entièrement.

Nous sommes donc plus stricts que le SDK, avec deux cent cinquante paquets de moins.

Version 5 et pas 6 : la 6 est ESM seulement, et l'API est écrite en CommonJS.

## Trois choses que je ne peux pas faire à ta place

1. **Créer le projet Crossmint.** Tu obtiendras deux clés : `ck_…`, publique, qui ira dans le jeu,
   et `sk_…`, qui ne quitte jamais le serveur. Déclare aussi les origines autorisées dans la console
   Crossmint : ce sont celles du jeu, les mêmes que `APP_ORIGINS`.
2. **Créer la base Postgres**, puis appliquer `schema.sql` :
   `psql "$DATABASE_URL" -f api/schema.sql`
3. **Renseigner `api/.env`** à partir de `.env.example`.

Ne me colle jamais une clé secrète dans la conversation, et ne me demande pas d'aller la chercher :
je tourne dans un conteneur distant, je n'ai accès ni à ton Mac, ni à tes notes, ni à ton
gestionnaire de mots de passe — et si je l'avais, une clé recopiée dans une conversation serait à
considérer comme brûlée. Mets-la dans `api/.env` en local, et dans le magasin de secrets de
l'hébergeur en production.

Le serveur n'a pas besoin que je voie la clé pour la vérifier : au démarrage, il te dira lui-même
si elle est lisible, de quel environnement elle vient, et quel projet elle désigne.

## Lancer

```bash
cd api
npm install
cp .env.example .env      # puis remplir
psql "$DATABASE_URL" -f schema.sql
npm start
```

## Tests

```bash
node api/test.js          # 46 tests, aucune dépendance, aucune base
cd api && npm install && node test.js   # 55 : les 46, plus la chaîne complète de vérification
```

La base et la vérification du jeton sont injectées dans `createApp()`. Les tests les remplacent par
des doublures, ce qui couvre sans rien installer l'authentification, la validation, l'unicité du
pseudo, la limitation de débit, le CORS, la lecture des clés d'API et chaque refus de jeton.

Les neuf tests supplémentaires font tourner la vraie cryptographie : ils génèrent une paire de clés,
servent un trousseau public en local, et éprouvent ce qu'on ne peut pas demander à un fournisseur —
un jeton signé par la mauvaise clé, un jeton expiré, un jeton d'un autre projet, la clé publique
utilisée comme secret partagé, un jeton sans signature du tout. Aucun appel à Crossmint, aucun
secret. L'intégration continue lance le fichier deux fois, avant et après installation, pour que les
deux promesses tiennent.

Seuls `db-pg.js` et `auth-crossmint.js` touchent l'extérieur.

## Choix retenus, et pourquoi

**Node simple, pas de cadre applicatif.** Le serveur tourne sur n'importe quel hébergeur Node, et
`WBCore` y tourne déjà tel quel. On choisira l'hébergeur au déploiement, pas maintenant.

**La cryptographie est déléguée, les décisions ne le sont pas.** Signature, trousseau et rotation
sont l'affaire de `jose` ; ce qu'on accepte d'un jeton est écrit en clair dans
`identityFromClaims()`, sans réseau ni dépendance, et testé ligne à ligne. La règle qui vaut pour le
jeu vaut ici : ce qui décide doit être pur, et ce qui est pur doit être testé.

**L'identité, c'est `sub`, jamais l'email.** Un joueur change d'email, il ne change pas
d'identifiant. La colonne `auth_id` fait foi, `email` n'est qu'un champ d'affichage — c'est aussi
pourquoi un email absent du jeton n'empêche jamais de se connecter.

**La contrainte unique arbitre les pseudos, pas une vérification préalable.** Demander « ce pseudo
est-il libre ? » puis l'insérer laisse une fenêtre entre les deux, et deux joueurs rapides passent
tous les deux. La base tranche, le serveur traduit en `409`.

**Les statistiques sont en lecture seule pour le client.** `PATCH /api/me` n'accepte que trois
champs ; tout le reste du corps est ignoré, y compris `stats` et `id`.

## Ce qu'il reste à brancher côté jeu

Le serveur attend un jeton ; personne ne le lui donne encore. C'est le morceau suivant, et il pose
une vraie question : l'interface de connexion de Crossmint est un composant React, et Warblock est
un fichier HTML sans build. Les deux ne vont pas ensemble, et il n'est pas question d'installer un
bundler pour un écran de connexion.

Il y a une porte de sortie, et elle est meilleure que le composant : la connexion par code email de
Crossmint est une API HTTP ordinaire, que le jeu peut appeler avec deux `fetch` et sa clé `ck_`.

```
POST /api/2024-09-26/session/sdk/auth/otps/send          { email }
POST /api/2024-09-26/session/sdk/auth/authenticate?…     → jeton + jeton de rafraîchissement
```

Le joueur saisit son email, reçoit un code, le saisit. Pas de React, pas de bundler, pas de
redirection : le fichier unique reste un fichier unique. Le jeton se range en mémoire, se
rafraîchit avant d'expirer, et accompagne chaque appel à `/api/me`.

À faire dans l'ordre, le jour où on s'y met : l'écran de connexion, le rafraîchissement, puis le
profil qui remplace l'objet local du navigateur.

## Limites connues, à traiter avant la production

- **La limitation de débit est en mémoire.** Elle freine un joueur sur une instance. Dès qu'il y en
  aura deux, elle devra passer en magasin partagé.
- **Pas encore de journal d'audit.** Chaque changement de pseudo devra être tracé avant que des
  comptes ne valent de l'argent.
- **Pas de suppression de compte.** À ajouter, avec ce que la juridiction retenue impose de
  conserver malgré la suppression.
- **Le portefeuille n'existe pas encore.** Crossmint sait en créer un à l'inscription, mais rien ne
  doit être branché avant la phase 03 : tant que le grand livre n'existe pas, un solde n'aurait nulle
  part où être écrit correctement.
- **Les conditions de garde restent à lire.** Qui détient les clés, ce que Crossmint peut geler, ce
  qui se passe si le compte du projet est suspendu — à trancher avec la juridiction retenue, avant
  qu'un euro n'entre.
