# API Warblock — comptes et profils (phase 01), billet de partie (phase 02a)

Le jeu reste ce qu'il est : un seul fichier `index.html`, servi en statique, sans build. Ce dossier
ajoute à côté un petit serveur qui détient les profils, et depuis la phase 02a l'**identité des
parties**. Les deux communiquent par HTTPS, et le jeu ne devient dépendant du serveur que pour le
profil : sans compte, sans réseau et sans billet, il se lance et se joue exactement comme avant.

**Aucun argent ne circule dans cette phase.** Il n'y a pas de colonne « solde », volontairement :
en phase 03 le solde sera la somme d'écritures immuables, et une case qu'on écrase serait
exactement ce qu'il faudrait supprimer. Mieux vaut ne pas la créer.

## Ce que le serveur fait

| Route | Ce qu'elle fait |
|---|---|
| `GET /api/health` | Répond `{ ok: true }`. Pour la surveillance. |
| `GET /api/me` | Rend le profil du joueur connecté, **statistiques agrégées** comprises. La première connexion crée le compte. |
| `PATCH /api/me` | Change le pseudo, l'avatar ou le pays. Rien d'autre n'est modifiable. |
| `POST /api/match` | Émet le **billet** d'une partie : graines, mise en centimes, sièges, expiration. |
| `POST /api/match/:id/result` | Juge le rapport rendu, recalcule les montants et **clôt** la ligne. |

Tout le reste répond 404. Toutes exigent un jeton de session valide, sauf `/api/health`.

## `POST /api/match` — le billet d'une partie

Le serveur possède l'identité de la partie ; le client ne fait que la demander. Il choisit sa table,
son mode et son brawler, **et rien d'autre**.

```
POST /api/match      { mode, stake, brawler, clientKey }
→ 200                { id, mode, stakeCents, seats, brawler, seed, status, openedAt, expiresAt }
```

- `mode` est une clé de `WBCore.MODES`, `stake` la mise **en dollars telle qu'elle est affichée** et
  qui doit figurer dans `WBCore.TIERS`, `brawler` une clé de `WBCore.BRAWLERS`. Un mode inconnu, une
  mise absente des tables ou un brawler inventé donnent un `400` dont le message dit quoi corriger.
- `clientKey` est tirée par le client. Sans elle, un `POST` dont la réponse se perd est
  indistinguable d'un `POST` jamais arrivé.
- Le corps **ne peut pas** porter de graine, de sièges, de montant, de statut ni d'identifiant
  d'utilisateur. Ces champs ne sont pas refusés, ils sont sans effet : un corps qui les porte tous
  écrit exactement la même ligne qu'un corps minimal, et un test le vérifie ligne à ligne.
- La mise est convertie par `WBCore.toCents()` à partir de la table retrouvée, jamais à partir du
  nombre reçu : une table à 0,50 $ s'enregistre `50`, entier.

**Deux graines, et une seule sort.** La publique détermine la carte et le gaz, part au client sous le
nom `seed` — celui que `WBCore.seedFor` lit dans le billet. La **secrète** ne quitte jamais le
serveur. Elle ne sert à rien aujourd'hui puisque rien n'est simulé, et c'est exactement pourquoi elle
est créée maintenant : le jour où le serveur décidera du contenu des caisses, il faudra que le client
ne l'ait jamais reçue, et une colonne ajoutée aujourd'hui coûte zéro migration. Les deux sont tirées
par une source **injectée** dans `createApp`, comme la base et la vérification du jeton, ce qui les
rend observables en test ; par défaut, le générateur du système.

**L'expiration part avec le billet, pas après.** Elle vaut `LOBBY.wait` + la durée complète du plan de
zone de ce mode — la borne haute d'une partie que personne ne gagne — + dix minutes de marge. Elle
est donc plus courte en Resurgence, dont le gaz est rapide. La marge est un compromis assumé : trop
courte, elle périme la partie d'un joueur dont l'onglet est passé en arrière-plan ; trop longue, elle
enferme dans un billet mort celui qui a fermé le sien, puisqu'un joueur n'a qu'un billet ouvert à la
fois. Aucun argent n'est en jeu en 02a : on préfère perdre une ligne de statistique que bloquer un
joueur.

**L'idempotence est arbitrée par la base, jamais par un `select` préalable** — même doctrine que
`name_key`. Deux index : `(user_id, client_key)` et un index **partiel** sur `(user_id)
where status='open'`. On insère, et c'est l'insertion refusée qui apprend ce qui existait déjà.
Conséquences, toutes testées :

- un second appel rend le billet ouvert existant, avec un `200` et jamais une erreur ;
- la clé qui a **créé** un billet rend toujours ce billet, même une fois périmé : la ligne porte la
  clé, donc la réponse ne change plus ;
- un billet périmé est clos (`status = 'expired'`) au moment où l'insertion bute dessus, ce qui
  libère la place. Le seul `update` de cette table, et il ne touche qu'un statut, jamais un montant.

Une limite connue, écrite plutôt que passée sous silence : une clé arrivée **pendant** qu'un billet
était déjà ouvert n'écrit aucune ligne — elle reçoit ce billet-là. Rejouée après l'expiration de
celui-ci, elle en ouvrira donc un nouveau. L'idempotence est totale tant que le billet est ouvert,
c'est-à-dire pendant toute la fenêtre où une réponse perdue peut être rejouée, et pas au-delà.
L'étendre demanderait une table d'alias, pour un cas que le client ne produit pas : chaque tentative
tire une clé neuve. Un test porte ce comportement, pour qu'il soit constaté et non découvert.

Le code de réponse est `200` même à la création, et non `201` : un code différent selon que le billet
vient d'être créé ou qu'il existait déjà rendrait le rejeu distinguable du premier appel.

**Un piège du pilote, à connaître avant d'écrire la route suivante.** `pg` rend les colonnes
`bigint` sous forme de **chaîne** — il ne peut pas garantir qu'elles tiennent dans un nombre
JavaScript. Une graine en chaîne est refusée par `seedFor`, qui repartirait sur la graine locale :
le joueur verrait une autre carte que celle de son billet, sans le moindre message. Les deux graines
sont donc converties en nombre dans `db-pg.js`, et une seconde fois dans la liste blanche de
`app.js` — deux lignes, parce que la panne est silencieuse. `id` et `user_id` restent des chaînes,
volontairement : on ne fait que les recopier.

**Aucune colonne solde, ici comme ailleurs.** `stake_cents` est une mise engagée, pas de l'argent
détenu. La ligne s'insère puis se règle **une fois**, par la route ci-dessous.

## `POST /api/match/:id/result` — le verdict

```
POST /api/match/12/result   le rapport, tel que WBCore.reportFrom() le produit
→ 200                       { matchId, status, issue, controle, motif,
                              grossCents, feeCents, netCents, purseCents,
                              declaredNetCents, ecartCents, settledAt }
```

Le corps **est** le rapport, sans enveloppe : `seconds`, `kills`, `deaths`, `rank`, `cubes`,
`damage`, `cashedOut`, `purseCents`, `declaredNetCents`. `WBCore.checkReport()` le lit et **refuse
tout champ inconnu, avec un code** (`inconnu`, `manquant`, `type`, `borne`, `corps`) : `PATCH
/api/me` ignore les champs en trop et c'est bien pour un profil, mais sur un rapport qui décide
d'un montant le silence est la mauvaise valeur par défaut.

### Le verdict est une **enveloppe de plausibilité**, pas de l'anti-triche

`WBCore.matchVerdict()` est une fonction pure qui reçoit le billet, le rapport et **une horloge en
argument**. Le serveur ne rejoue pas la partie — il ne le fera pas avant la phase 02b. Il refuse ce
qui est **impossible**, et rien d'autre. La liste des contrôles vit dans la constante `ENVELOPPE`,
à côté de la fonction : plus de kills que adversaires × vies, une partie plus longue que tout le
plan de zone, une durée que son propre chronomètre n'a pas eu le temps de contenir, une victoire
annoncée avant que son horloge ne l'autorise, un encaissement Resurgence avant la fin du verrou de
`CASHOUT.lock`, plus de cubes que `CUBE.max`, un rang hors de la table, une sacoche au-delà de
`mise × sièges`, un billet expiré.

**Deux contrôles « évidents » sont faux et ne sont pas écrits.** « La sacoche vaut exactement la
mise quand on n'a tué personne » : non, une mort par gaz lâche la sacoche au sol et n'importe qui
la ramasse sans avoir tué qui que ce soit, tandis que mourir la remet à zéro — seule la borne
subsiste. « Plus de kills que d'adversaires » : non, chacun a trois vies, deux en Resurgence.

Les tolérances d'horloge sont **volontairement larges** : un onglet en arrière-plan, un téléphone
endormi et une horloge locale fausse sont beaucoup plus fréquents qu'un tricheur. Aucun argent
n'est en jeu en 02a, donc accepter une partie douteuse coûte une ligne de statistique qui ne vaut
rien, tandis que refuser une partie honnête coûte un joueur.

### L'invariant « aucun montant ne vient du client » se scinde en deux

- **MAXWIN : le net est recalculé.** Le billet porte la mise et le mode, `payoutCents()` fait le
  reste. Le client n'a aucune voix, et un rapport qui n'annonce aucun montant se règle quand même.
- **Resurgence : le net est encadré, pas recalculé.** Le net d'un encaissement est
  `cashoutCents(sacoche)`, et la sacoche est précisément le nombre que le serveur ne sait pas
  refaire. Il applique donc une fonction à un montant **déclaré par le client**, borné à
  `[0, mise × sièges]` — un intervalle de 0 à 50 mises. C'est faible, c'est honnête, et c'est une
  raison de plus pour qu'aucun euro n'entre avant la phase 02b.

Dans les deux cas, l'API **ne recalcule jamais la commission elle-même** : le net ne sort que des
fonctions de paiement de `WBCore`.

**`declaredNetCents` n'est jamais payé ni cru.** Le verdict calcule l'**écart** entre ce que le
client annonce et ce qu'il compte, et le stocke dans `ecart_cents` — la seule colonne en centimes
qui peut être négative, parce qu'un client peut aussi annoncer moins. On mesure, on ne punit pas :
le seuil est une affaire de phase 06, et il se fixera sur des écarts réellement observés.

### Ce que la route écrit, une fois

Un verdict de refus **clôt la ligne lui aussi** (`status = 'rejected'`), avec son motif : cette
partie-là ne comptera dans aucune statistique, et on veut pouvoir dire pourquoi sans relancer le
calcul six mois plus tard. Une partie réglée passe en `settled`, un billet périmé en `expired`.

L'idempotence est la troisième clé annoncée par la spécification, celle sur `(match_id)`, et elle
est arbitrée par la clause `where status = 'open' and net_cents is null` : un second envoi ne
touche aucune ligne, et la réponse est **relue depuis la ligne**, jamais reconstruite depuis le
verdict. Le même billet réglé deux fois rend donc le premier verdict au caractère près, même si le
second rapport ment sur tout. Une garde textuelle vérifie que toute écriture de `matches` porte
`status = 'open'`, et toute écriture d'un montant `net_cents is null` en plus.

**Un résultat en retard est accepté tant que le billet n'a pas expiré.** Si couper le wifi
effaçait une partie perdue, ce serait la meilleure stratégie du jeu.

### Le veilleur

Les billets que personne ne termine — onglet fermé, navigateur tué, joueur parti — resteraient
ouverts pour toujours, et un joueur n'a qu'un billet ouvert à la fois. `app.veiller()` les clôt, et
**eux seuls** : sa clause porte `status = 'open'` et l'expiration, il n'écrit aucun montant, et il
prend son heure du même endroit que le reste du routeur. `main.js` l'appelle chaque minute. C'est
du code qui manipulera de l'argent et que personne ne regarde tourner : il se teste comme le
reste, horloge injectée, sans attendre.

## Les statistiques sont la somme des parties, pas des compteurs

`GET /api/me` rend `matches`, `wins`, `kills` et `best`. Aucun de ces quatre nombres n'est stocké :
ils sont lus par **agrégat** sur la table `matches`, et seules les parties `settled` y entrent. Une
partie refusée, périmée ou encore ouverte ne compte pour rien — elle n'a pas de résultat opposable.

```sql
count(*) · count(*) filter (where issue in ('victoire','encaissement')) · sum(kills) · max(net_cents)
where user_id = $1 and status = 'settled'
```

C'est exactement le raisonnement de l'absence de colonne solde : **un compteur qu'on incrémente est
une case qu'on écrase, et un double envoi la fausse pour toujours.** Ici, un double envoi ne peut
rien fausser puisqu'il n'y a rien à écrire — la ligne de partie s'insère puis se règle une fois, et
la somme se refait à l'identique. La phase 02a met donc en place, sur des chiffres qui ne valent
rien, la mécanique que le grand livre de la phase 03 exigera.

C'est un **revirement** sur une décision écrite et livrée en phase 01, qui avait créé une table de
quatre compteurs. Aucune base n'ayant jamais tourné, c'était le dernier moment gratuit pour corriger
le schéma sans migration. La décision renversée et sa raison sont dans `docs/HISTORIQUE.md`.

Deux points de détail qui coûteraient cher plus tard :

- `wins` retient la **victoire et l'encaissement**. Sortir de Resurgence avec sa sacoche est une
  sortie gagnante, et `endMatch` la compte déjà comme telle côté jeu : compter autrement ferait
  *baisser* le compteur d'un joueur le jour où il se connecte.
- `best` est un **maximum, en centimes entiers**, et il le reste jusqu'au bout du réseau. Il ne
  redevient des dollars qu'une seule fois, dans `applyAccount` côté jeu. Convertir ici ferait un
  second point de conversion, ce que la couche monétaire existe précisément pour empêcher.

Un piège du pilote, le même que pour les graines et en pire : `count()` et `sum()` rendent un
`bigint`, donc une **chaîne**. Sans conversion, `kills` traverserait le réseau en texte — une graine
en chaîne fait au moins repartir le jeu sur la sienne, une statistique en chaîne ne se voit qu'à
l'écran, des semaines plus tard. La conversion est donc écrite **deux fois**, dans `db-pg.js` et
dans la liste blanche de `app.js`, exactement comme pour les graines ; un test fait mentir la
doublure comme le vrai pilote, ce que `db-pg.js` seul ne permettrait pas — il n'est jamais exécuté.

### Ce que les gardes textuelles prouvent, et ce qu'elles ne prouvent pas

Faute de base qui tourne, deux tests lisent le **texte** de `schema.sql` et de `db-pg.js` : toute
colonne dont le pilote parle existe dans le schéma, les colonnes d'argent sont entières et
contraintes positives, aucune ne s'appelle solde, et aucun `update` ne vise un montant de `matches`.
Elles attrapent la dérive la plus probable — une requête restée en arrière après la disparition
d'une table.

**Elles vérifient du texte, et rien d'autre.** L'index unique partiel « un seul billet ouvert »,
comme la contrainte `name_key` de la phase 01 et comme la clause `where status = 'open' and
net_cents is null` qui arbitre l'unicité du règlement, n'a jamais été éprouvé contre une vraie base.
Un test qui passe contre la doublure prouve la doublure, pas Postgres. C'est la dette la plus
silencieuse de la phase, et elle se solde le jour où une base tournera — pas avant.

## Les fichiers

```
app.js              le routeur. Rien hors du cœur de Node, tout le reste lui est injecté.
core.js             charge WBCore depuis index.html
crossmint-key.js    lit une clé d'API Crossmint et vérifie sa signature — sans dépendance
auth-crossmint.js   vérifie les jetons de session                  ← touche le réseau
db-pg.js            Postgres                                       ← touche la base
main.js             assemble les trois et écoute
schema.sql          le schéma : users, matches. Deux tables, et aucune colonne « solde ».
test.js             97 tests sans rien installer, 106 avec jose
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
node api/test.js          # 97 tests, aucune dépendance, aucune base
cd api && npm install && node test.js   # 106 : les 97, plus la chaîne complète de vérification
```

La base, la vérification du jeton, la source de graines et l'horloge sont injectées dans
`createApp()`. Les tests les remplacent par des doublures, ce qui couvre sans rien installer
l'authentification, la validation, l'unicité du pseudo, la limitation de débit, le CORS, la lecture
des clés d'API, chaque refus de jeton, et tout le billet de partie — graines, idempotence,
expiration comprises. Une horloge injectée fait vieillir un billet sans attendre, et c'est elle qui
permet d'éprouver le verdict et le veilleur : un mensonge par test, chacun nommé d'après le
mensonge qu'il arrête. Les statistiques s'éprouvent de la même façon, et de la seule qui vaille :
en **jouant** des parties entières contre la doublure, du billet au règlement, puis en comparant ce
que `GET /api/me` rend à la somme des lignes.

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

**Les statistiques sont en lecture seule pour le client** — et, depuis la phase 02a, pour le serveur
lui-même : personne ne les écrit, elles sont une somme. `PATCH /api/me` n'accepte que trois champs ;
tout le reste du corps est ignoré, y compris `stats` et `id`.

## Le côté jeu

L'écran de connexion est dans `index.html`, et le fichier est resté un seul fichier. L'interface de
Crossmint est un composant React, incompatible avec une page sans build ; leur connexion par code
email, elle, est une API HTTP ordinaire. On appelle donc les routes directement, avec la clé `ck_`
en en-tête :

```
POST …/session/sdk/auth/otps/send        { email }              → un état de session
POST …/session/sdk/auth/authenticate?…   code à six chiffres    → un secret à usage unique
POST …/session/sdk/auth/refresh          { refresh: <secret> }  → { jwt, refresh, user }
POST …/session/sdk/auth/logout           { refresh }
```

Le joueur saisit son adresse, reçoit un code, le saisit. Pas de React, pas de bundler, pas de
redirection. Le jeton se range dans le navigateur, se rafraîchit deux minutes avant d'expirer, et
reprend tout seul au rechargement suivant.

**Le jeu reste jouable sans compte.** C'est la promesse du fichier unique : on l'ouvre et on joue.
Se connecter ajoute un profil qui suit le joueur d'une machine à l'autre.

Les décisions de cet écran sont dans `WBCore`, avec leurs tests : ce que vaut une adresse, ce que
vaut un code, l'enchaînement des écrans, quand rafraîchir, ce qu'on montre quand ça rate. Le reste
n'est que DOM et réseau.

Une ligne reste à remplir, `ACCOUNT.api` dans `index.html` : l'adresse de ce serveur, le jour où il
tournera quelque part. Vide, la connexion fonctionne et le profil reste local.

### Le billet, côté jeu

Depuis la phase 02a, le jeu prend son billet et rend son rapport. Tout tient dans un module `Match`
d'une centaine de lignes, à côté d'`Auth`, et il ne décide de rien : l'enchaînement vient de
`WBCore.matchFlow`, la graine de `seedFor`, le billet utilisable de `ticketFor`, le rapport de
`reportFrom`. Trois points de contact seulement — le sas d'attente demande, le coup d'envoi choisit
la graine, la fin de partie rend le rapport.

**Ce qui compte ici est le chemin de secours, pas le chemin nominal.** Pas de compte, `ACCOUNT.api`
vide, serveur muet, réponse illisible, billet refusé, ou billet qui décrit une autre table : dans
tous ces cas le jeu tire sa graine lui-même et se comporte exactement comme avant la phase. Et le
sas d'attente ne regarde jamais le réseau pour lancer la partie — **un billet qui tarde ne retarde
jamais le coup d'envoi**, c'est son chronomètre qui tranche, et une réponse arrivée trop tard est
jetée au lieu de réveiller une partie déjà commencée.

Un cas que seul le branchement a fait apparaître : le serveur n'ouvre qu'un billet à la fois et rend
le billet déjà ouvert quelle que soit la table redemandée ensuite. Quitter le sas puis revenir sur
une autre table laisse donc en main un billet qui parle d'ailleurs. `WBCore.ticketFor` compare le
mode et la mise avant de s'en servir ; s'ils ne concordent pas, la partie se joue hors ligne et le
billet reste ouvert pour la table qu'il décrit.

**Les statistiques sont adoptées, jamais recopiées.** Le règlement rendu par la route ne porte aucune
statistique — il porte le verdict d'une partie. Le jeu redemande donc `GET /api/me` après un
règlement, et c'est `applyAccount` qui arbitre : centimes vers dollars, avatar inconnu conservé,
réponse tronquée sans effet sur le pseudo. Lire un règlement comme un compte remettrait les quatre
compteurs à zéro ; un test nommé porte ce piège.

**Le portefeuille de démonstration reste dans le navigateur.** La phase 02a enregistre des parties,
pas de l'argent : aucun solde ne part au serveur, aucun n'en revient, et `wallet` est toujours une
variable modifiable depuis la console. C'est la phase 03 qui changera cela, pas celle-ci.

**Ce qui n'a pas pu être vérifié.** Le format exact des échanges avec Crossmint vient de la lecture
de leur SDK, pas d'un appel réel : le conteneur où ce code a été écrit n'a pas accès à leur domaine.
La première vraie connexion est donc le moment de vérité. Si une réponse ne ressemble pas à ce qui
est écrit ici, tout est au même endroit — `Auth` dans `index.html`, quatre fonctions d'une ligne.

## Limites connues, à traiter avant la production

- **Le verdict est une ENVELOPPE DE PLAUSIBILITÉ, PAS DE L'ANTI-TRICHE, et il n'arrête presque
  rien.** Une enveloppe volontairement large, des tolérances d'horloge généreuses, et le parti pris
  de ne jamais refuser à tort : un client modifié ment à l'intérieur de l'enveloppe sans être
  inquiété. Il ne peut pas se faire payer un montant MAXWIN de son choix, il peut annoncer une
  sacoche Resurgence quelconque entre zéro et cinquante mises, et il peut mentir sur tous les faits
  — durée, kills, cubes, dégâts, rang. Ce n'est pas un premier étage d'anti-triche et il ne faut
  jamais le présenter comme tel : c'est une borne sur l'impossible, rien de plus. C'est précisément
  pour cela qu'**aucun euro n'entre avant que le serveur ne simule** (phase 02b). La valeur réelle
  de ce module en phase 02a est la répétition générale du grand livre.
- **La table `matches` se remplit de faits DÉCLARÉS par le client, et ces lignes-là ne seront
  JAMAIS lues par le grand livre de la phase 03.** Borner n'est pas vérifier. La phase 03 attend
  des lignes produites par simulation serveur ; celles-ci ne valent que pour des statistiques
  d'affichage et pour mesurer des écarts. Le jour où le grand livre existera, il faudra une
  frontière explicite — une colonne d'origine, une autre table, une date de bascule — et non un
  `select` sur `matches` qui ramasserait tout. Sans cette phrase écrite noir sur blanc, on paiera un
  jour des chiffres que personne n'a contrôlés.
- **La limitation de débit est en mémoire, et elle couvre désormais DES ROUTES QUI ÉCRIVENT EN
  BASE.** Elle freine un joueur sur une instance ; dès qu'il y en aura deux, chaque instance aura
  son propre compteur et la limite vaudra le double, puis le triple. C'était déjà vrai en phase 01,
  où le pire cas était un pseudo martelé ; depuis `POST /api/match` le pire cas est une table
  `matches` remplie par quelqu'un qui répartit ses appels, et depuis `POST /api/match/:id/result`
  c'est en plus un règlement écrit sur chacune. Elle doit passer en magasin partagé avant la
  production. Les seaux sont séparés par route : renommer son personnage ne consomme pas le droit de
  demander une partie, et l'inverse non plus.
- **Aucune base n'a jamais tourné.** L'index unique partiel sur les billets ouverts, la contrainte
  `name_key`, le comportement de `insert … on conflict do nothing` et la clause `where status =
  'open' and net_cents is null` qui arbitre l'unicité du règlement n'ont été éprouvés que contre la
  doublure de `api/test.js`, qui imite les contraintes au lieu de les subir. Si Postgres se
  comporte autrement, rien ne le signalera avant le premier déploiement. C'est la dette la plus
  silencieuse du dossier, et elle grandit : c'est maintenant un montant qu'une clause non éprouvée
  protège.
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
