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

## Les règles ne sont pas recopiées

`api/core.js` charge le bloc `WBCore` **depuis `index.html`**, le même que le navigateur exécute.
Le pseudo est validé côté serveur par `sanitizeName()` et `validName()`, les mêmes fonctions qui
tournent dans le jeu, et l'unicité s'appuie sur `nameKey()`.

C'est ce qui rendra la phase 02 possible sans réécriture : le jour où le serveur simulera les
parties, il aura déjà les vraies règles, avec les tests qui vont avec.

## Trois choses que je ne peux pas faire à ta place

1. **Créer l'application chez le fournisseur d'identité.** Tu obtiendras deux clés : une publiable,
   qui ira dans le jeu, et une secrète, qui reste sur le serveur.
2. **Créer la base Postgres**, puis appliquer `schema.sql` :
   `psql "$DATABASE_URL" -f api/schema.sql`
3. **Renseigner `api/.env`** à partir de `.env.example`.

Ne me colle jamais une clé secrète dans la conversation. Mets-la dans `api/.env` en local, et dans
le magasin de secrets de l'hébergeur en production. Un secret passé dans un message doit être
considéré comme brûlé et remplacé.

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
node api/test.js          # 25 tests, aucune dépendance, aucune base
```

La base et la vérification du jeton sont injectées dans `createApp()`. Les tests les remplacent par
des doublures, ce qui couvre l'authentification, la validation, l'unicité du pseudo, la limitation
de débit et le CORS sans rien installer. Seuls `db-pg.js` et `auth-clerk.js` touchent l'extérieur.

## Choix retenus, et pourquoi

**Node simple, pas de cadre applicatif.** Le serveur tourne sur n'importe quel hébergeur Node, et
`WBCore` y tourne déjà tel quel. On choisira l'hébergeur au déploiement, pas maintenant.

**La vérification du jeton est déléguée au SDK du fournisseur.** Node saurait vérifier une signature
RS256 en trente lignes, mais c'est le contrôle qui gardera l'argent des joueurs, et les détails qui
le rendent sûr — émetteur accepté, tolérance d'horloge, partie autorisée, rotation des clés — sont
ceux qu'on oublie en les réécrivant.

**La contrainte unique arbitre les pseudos, pas une vérification préalable.** Demander « ce pseudo
est-il libre ? » puis l'insérer laisse une fenêtre entre les deux, et deux joueurs rapides passent
tous les deux. La base tranche, le serveur traduit en `409`.

**Les statistiques sont en lecture seule pour le client.** `PATCH /api/me` n'accepte que trois
champs ; tout le reste du corps est ignoré, y compris `stats` et `id`.

## Limites connues, à traiter avant la production

- **La limitation de débit est en mémoire.** Elle freine un joueur sur une instance. Dès qu'il y en
  aura deux, elle devra passer en magasin partagé.
- **Pas encore de journal d'audit.** Chaque changement de pseudo devra être tracé avant que des
  comptes ne valent de l'argent.
- **Pas de suppression de compte.** À ajouter, avec ce que la juridiction retenue impose de
  conserver malgré la suppression.
