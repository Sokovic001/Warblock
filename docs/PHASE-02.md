# Phase 02a — le serveur possède l'identité de la partie

État : **en cours**. Spécification écrite avant le premier module, pour que chacun sache ce qu'il
construit et, surtout, ce qu'il n'a pas le droit de casser.

---

## D'abord, l'aveu

`CLAUDE.md` annonce « phase 02 — le serveur devient l'autorité du jeu ». **Cette phase ne le fait
pas, et il faut le dire au lieu de l'enrober.**

Une autorité temps réel demande de sortir le mouvement, les tirs, les bots et les collisions du
script `Game` vers des règles pures et déterministes, sans Three.js. C'est la réécriture du jeu, et
elle casse la promesse du fichier unique — on ouvre `index.html`, on joue. Ce qui se livre ici est
plus petit et vérifiable :

- le serveur **émet le billet** d'une partie : identifiant, mode, mise en centimes entiers, graines,
  heure d'ouverture, heure d'expiration ;
- le serveur **juge** le rapport qu'on lui rend et **recalcule lui-même** tout montant.

La frontière se déplace : le client garde la boucle image par image, le serveur possède l'identité
de la partie, son horloge et son arithmétique. C'est réel, c'est testable, et ce n'est pas
l'autorité sur le jeu.

La phase 02 est donc **scindée**, et les deux documents qui font foi le disent :

| | Ce que c'est | État |
|---|---|---|
| **02a** | Billet, verdict, parties immuables, statistiques par agrégat | en cours (ce document) |
| **02b** | Le serveur simule la partie : mouvement, tirs, dégâts, gaz | pas commencée |

**Tant que 02b n'est pas faite, la phase 02 n'est pas faite, et aucun euro n'entre.** L'ordre des
sept phases reste non négociable ; c'est la phase 02 qui se révèle être deux phases. Sans cette
ligne écrite noir sur blanc, la phase 03 démarrerait sur la croyance que 02 est finie, ce qui est
exactement l'accident que l'ordre « non négociable » existe pour empêcher.

---

## Ce que la phase fait

1. **Une couche monétaire en centimes entiers dans `WBCore`.** Un seul point de conversion, testé de
   0 à 1 000 000 de centimes. La commission ne peut plus tomber à zéro sur un brut non nul.
2. **Le plan de zone descend dans `WBCore`** et devient une fonction pure de la graine. Le gaz
   cessait d'être reproductible parce qu'il tirait ses centres sur `Math.random()`.
3. **`POST /api/match`** — le serveur émet un billet, tire les graines lui-même, et n'accepte du
   client ni graine, ni sièges, ni montant.
4. **`POST /api/match/:id/result`** — le serveur juge le rapport rendu, refuse l'impossible,
   recalcule tous les montants depuis le billet et clôt la ligne.
5. **`matches` devient la source de vérité des statistiques.** `user_stats` disparaît : plus aucun
   compteur qu'on incrémente, une somme sur des lignes immuables.
6. **Le jeu prend son billet quand il peut, et se débrouille seul sinon.** Sans compte, sans
   serveur, sans réseau, le comportement est exactement celui d'aujourd'hui, graine comprise.

Aucun argent ne bouge. Le portefeuille de démonstration reste une variable du navigateur, il n'y a
toujours aucune colonne solde, et les chiffres enregistrés ne valent rien. C'est volontaire : la
phase 02a est la **répétition générale** du grand livre de la phase 03, faite sur des chiffres sans
valeur, au dernier moment où le schéma peut encore changer sans migration.

## Ce que la phase ne fait pas

- Pas de simulation autoritaire, pas de netcode, pas de rejeu des entrées côté serveur. C'est 02b.
- Pas de vrais adversaires, pas de vrai appariement, pas de vraie file d'attente. La population, le
  sas d'attente et le bandeau des gains restent simulés.
- Pas de grand livre, pas de solde, pas de dépôt, pas de retrait. Phases 03 à 06, dans cet ordre.
- Pas de portefeuille Crossmint : rien ne se branche tant que le grand livre n'a pas où écrire.
- Pas de journal d'audit, pas de suppression de compte, pas de limitation de débit en magasin
  partagé. Limites connues de la phase 01, toujours ouvertes, **aggravées** ici puisque la
  limitation couvre désormais une route qui écrit en base.
- Pas de choix d'hébergeur, pas de création de base, pas de déploiement. Tout se vérifie hors ligne ;
  `ACCOUNT.api` reste une ligne à remplir.
- Pas de lobby mobile — refait trois fois, abandonné, ne pas rouvrir sans maquette validée.
- Pas de conversion de tout le jeu en centimes entiers : `cents()` est appelé partout dans le rendu
  et le HUD, et ce chantier n'a rien à voir avec l'autorité du serveur.

---

## Les décisions, et pourquoi

### Le serveur possède le billet et le verdict, pas la boucle de jeu

Le billet et le verdict se livrent en quelques centaines de lignes et déplacent déjà la frontière.
La même `WBCore` tourne des deux côtés : le jour venu, on remplace le corps de `matchVerdict` par
une vraie simulation **sans changer une seule route**.

### La couche monétaire en centimes entiers vient en premier, avant toute écriture

`cents()` rend des dollars flottants arrondis au centime. La frontière fuit déjà :
`cashoutPayout(0.01)` rend `{gross:0.01, fee:0, net:0.01}` — **commission nulle sur un brut non
nul**, alors que la règle du dépôt est « 20 % de tout paiement, sans exception ». Un suffixe `Cents`
sur un nom de variable n'attrape pas ça ; un test exhaustif si. La couture se construit avant la
première écriture en base, pas après.

Le taux s'applique en arithmétique entière (`RAKE_NUM/RAKE_DEN`), et la commission s'arrondit **vers
le haut** : c'est ce qui garantit qu'elle est strictement positive dès que le brut l'est. Sur tous
les montants réellement atteignables — la sacoche est toujours un multiple de la mise, et les mises
valent 50, 100, 500 ou 1000 centimes — arrondi haut et arrondi au plus proche coïncident, ce qu'un
test de couture vérifie table par table.

### Le plan de zone entre dans `WBCore`, complet et tiré de la seule graine

`ZONE_PHASES`, `ZONE_PHASES_FAST` et `ZONE_START_R` sont écrits **après** `/*CORE-END*/`, donc
jamais testés, et le resserrement tire ses centres sur `Math.random()`. Une règle qui décide de la
fin d'une partie vivait hors de la partie testée : c'est la raison suffisante de ce module.

**La raison insuffisante, qu'il faut écrire aussi :** le rejeu intégral dont ce plan est le prérequis
appartient à la phase 02b. Après ce module il restera une trentaine d'appels à `Math.random()` dans
le bloc `Game` — points de réapparition, décision d'encaissement des bots, identifiants d'entités.
Deux exécutions d'une même graine ne donneront **toujours pas** la même partie. Le module rend le
gaz reproductible et descend une règle dans la partie testée ; il ne rend pas la partie
reproductible. Le prétendre serait un mensonge dont la phase 03 hériterait.

### La graine vient du serveur quand il existe, du navigateur sinon

C'est la promesse du fichier unique. `ACCOUNT.api` vide, pas de session, serveur muet, réponse
illisible : dans les quatre cas le jeu tire sa graine comme aujourd'hui et lance la partie. **Un
billet qui tarde ne retarde jamais le coup d'envoi.** Ce chemin de secours se teste comme un cas
normal, pas comme une exception, et ses tests s'écrivent avant le reste.

### Deux graines, publique et secrète

La publique détermine la carte et le gaz, et part au client. La secrète ne quitte jamais le serveur.
En 02a elle ne sert à rien puisque rien n'est simulé — et c'est précisément pourquoi on la crée
maintenant : le jour où le serveur décidera du contenu des caisses, le client ne doit pas l'avoir
reçu, et une colonne ajoutée aujourd'hui coûte zéro migration.

### Le verdict est une **enveloppe de plausibilité**, nommée comme telle dans le code

Le serveur ne peut pas refaire la partie. Il peut refuser ce qui est impossible : plus de kills que
d'adversaires × vies, durée hors du plan de zone, victoire annoncée avant que son propre chronomètre
ne la permette, encaissement Resurgence avant `CASHOUT.lock`, cubes au-delà de `CUBE.max`, sacoche
hors des bornes que la conservation de l'argent autorise.

Deux contrôles « évidents » sont **faux** et refuseraient des joueurs honnêtes :

- *« la sacoche vaut exactement la mise à zéro kill »* — une mort par gaz lâche la sacoche au sol, et
  n'importe qui la ramasse sans aucun kill ; inversement, une mort remet la sacoche à zéro. Zéro kill
  avec 12 $ et zéro kill avec 0 $ sont tous deux légitimes. Seule la borne subsiste.
- *« plus de kills que d'adversaires »* — il y a trois vies (deux en Resurgence). Le plafond est
  adversaires × vies.

Le nom « enveloppe de plausibilité » doit figurer dans le commentaire d'en-tête de la fonction, dans
le nom de la constante qui liste les contrôles et dans le nom des tests. Écrit seulement dans le
README, il serait oublié exactement au moment où il protégerait de l'argent. **Ce n'est pas de
l'anti-triche.** Un client modifié ment à l'intérieur de l'enveloppe sans être inquiété, et avec des
tolérances d'horloge volontairement larges, l'enveloppe arrête peu de choses en pratique. Sa valeur
réelle en phase 02a est la répétition générale du schéma du grand livre.

### Aucun montant n'est lu dans le rapport — mais l'invariant se scinde en deux

- **MAXWIN : le montant est recalculé.** Le billet porte la mise et le mode, `payoutCents()` fait le
  reste. Le client n'a aucune voix.
- **Resurgence : le montant est encadré, pas recalculé.** Le net d'un encaissement est
  `cashoutCents(sacoche)`, et la sacoche est précisément le nombre que le serveur ne sait pas
  refaire. Il applique donc une fonction à un nombre **déclaré par le client**, borné à
  `[0, mise × sièges]` — un intervalle de 0 à 50 mises en Resurgence. C'est faible, c'est honnête, et
  c'est une raison de plus pour qu'aucun euro n'entre avant 02b.

La borne n'est pas un décret : elle vient de la conservation de l'argent, vraie dans le code actuel —
la sacoche naît à la mise, se transfère entière au tueur, tombe au sol sinon, et l'encaissement la
met à zéro. Somme des sacoches vivantes + butin au sol + encaissé = mise × sièges, à tout instant.
Cette conservation se teste dans `test.js` sur un modèle pur des transferts.

### L'API ne recalcule jamais la commission elle-même

Le net ne sort que des fonctions de paiement de `WBCore`. C'est la formulation la plus nette de
« aucune règle n'est recopiée » : `api/core.js` charge le bloc depuis `index.html`, et une règle
corrigée dans le jeu l'est du même coup côté serveur.

### L'écart est mesuré, jamais puni, jamais payé

Le rapport porte le net que le client croit avoir gagné. Le serveur ne le paie pas et ne le croit
pas — il enregistre la **différence** avec son propre calcul, en centimes, dans une colonne
d'observation. Jeter la mesure perdrait les données sur lesquelles la phase 06 fixera un seuil.

### Les statistiques sont la somme de parties immuables ; `user_stats` disparaît

Même raisonnement que l'absence de colonne solde : un compteur qu'on incrémente est une case qu'on
écrase, et un double envoi la fausse pour toujours. Les parties sont insérées puis réglées **une
fois**, et `matches`/`wins`/`kills`/`best` se lisent par agrégat sur les parties réglées.

C'est un **revirement** sur une décision écrite en phase 01 : `user_stats` figure dans `schema.sql`
et dans `api/README.md`. Aucune base n'a jamais tourné, c'est le dernier moment gratuit, et le
revirement doit apparaître comme tel dans `docs/HISTORIQUE.md`.

### Un seul billet ouvert par joueur, arbitré par une contrainte de base

C'est la doctrine déjà écrite à propos de `name_key` : la contrainte tranche, jamais une vérification
préalable qui laisse une fenêtre entre le « est-il libre ? » et l'insertion. Un index unique partiel
sur les billets ouverts. Un second appel rend le billet existant plutôt qu'une erreur, sinon un
onglet fermé enferme le joueur.

Trois clés d'idempotence, nommées :

| Clé | Ce qu'elle rend idempotent |
|---|---|
| `(user_id, client_key)` | la création du billet |
| index partiel sur `(user_id) where status='open'` | l'unicité du billet ouvert |
| `(match_id)` | le règlement |

La clé fournie par le client à la création n'est pas un détail : sans elle, un `POST` dont la réponse
se perd est indistinguable d'un `POST` jamais arrivé.

### Une déconnexion n'annule rien, et l'expiration se livre avec le billet

Si couper le wifi effaçait une partie perdue, ce serait la meilleure stratégie du jeu. Un résultat
qui arrive en retard, mais avant expiration, est accepté. Un billet que personne ne termine est clos
par un veilleur à horloge injectée — du code qui manipulera de l'argent et que personne ne regarde
tourner ; il se teste comme le reste, sans attendre.

### Tolérance d'horloge généreuse, et refus de refuser à tort

Onglet en arrière-plan, téléphone qui s'endort, horloge locale fausse : les écarts honnêtes sont
nombreux. En 02a aucun argent n'est en jeu, donc accepter une partie douteuse coûte une ligne de
statistique, tandis que refuser une partie honnête coûte un joueur. Les seuils se resserreront quand
ils protégeront de l'argent.

### L'analyseur refuse les champs inconnus

`PATCH /api/me` ignore les champs en trop, et c'est bien pour un profil. Sur un rapport de partie qui
décidera d'un montant, le silence est la mauvaise valeur par défaut : tout champ inconnu vaut un
refus, avec un code.

### Aucune dépendance nouvelle, aucune base pour tester

`jose` et `pg` restent les seules, le jeu n'en a aucune. Les nouvelles routes se testent avec la
doublure de base déjà présente dans `api/test.js` ; le plan de zone, la couche monétaire et le
verdict sont purs. Tout se vérifie sur un portable hors ligne.

---

## Les invariants, et comment chacun se teste

| Invariant | Comment il se teste |
|---|---|
| `index.html` reste un seul fichier statique, sans build, sans bundler, sans React | rien à installer pour ouvrir le fichier ; extraction des blocs `<script>` puis `node --check` après chaque édition |
| Le jeu reste jouable sans compte et sans serveur, graine comprise | quatre cas nommés — `ACCOUNT.api` vide, pas de session, serveur muet, réponse illisible — testés comme cas normaux sur `seedFor` et `matchFlow` |
| Un billet qui tarde ne retarde jamais le coup d'envoi | le chemin de secours a son propre test, écrit avant le reste du module |
| Aucune règle n'est recopiée côté serveur | `api/core.js` charge `WBCore` depuis `index.html` ; `zonePlan`, `matchVerdict` et la couche monétaire y vivent ; garde bruyante au démarrage sur les noms exportés |
| Aucun montant MAXWIN ne vient du client | patron déjà éprouvé sur `PATCH /api/me` : un corps portant `seed`, `stake_cents`, `payout_cents`, `user_id`, `status` écrit une ligne **identique** à celle d'un corps vide |
| En Resurgence le montant est encadré, pas recalculé | test nommé qui le dit, et borne `[0, mise × sièges]` prouvée par la conservation de l'argent |
| La commission n'est jamais nulle sur un paiement non nul | `fee + net = brut` et `fee > 0` sur 0..1 000 000 centimes, et nommément sur 1, 2, 3 et 4 centimes |
| Tout argent qui traverse le réseau ou entre en base est en centimes entiers | `Number.isInteger` partout dans la couche monétaire ; un seul point de conversion ; tout identifiant en centimes porte le suffixe `Cents` |
| Aucune colonne solde ; `matches` est en insertion puis règlement unique | garde textuelle : lecture de `api/schema.sql` et de `api/db-pg.js`, aucune colonne nommée solde ou balance, colonnes d'argent entières et contraintes positives, aucun `update` visant un montant de `matches` |
| Les statistiques sont une somme, jamais un compteur | statistiques rendues = somme des parties réglées ; une partie refusée ou restée ouverte ne compte pour rien |
| Même graine, même **plan de zone** | même plan deux fois et dans deux processus ; `zonePlan` tourne avec `Math.random` remplacé par une fonction qui lance |
| `WBCore` ne dépend d'aucun environnement | bac à sable permanent : le bloc s'exécute avec `document`, `window`, `THREE`, `Math.random`, `Date.now` et `performance` indéfinis |
| Aucune dépendance nouvelle | `api/package.json` inchangé hors `jose` et `pg` ; `node test.js` et `node api/test.js` tournent sans rien installer |
| `npm test` vert après chaque module | intégration continue : `node test.js`, `node api/test.js` sans dépendances puis avec |

---

## Les risques, assumés

- **Le verdict n'arrête presque rien.** Enveloppe large + tolérance d'horloge généreuse + refus de
  refuser à tort. À écrire dans `api/README.md` à côté des autres limites connues, jamais à présenter
  comme un premier étage d'anti-triche.
- **La table `matches` sera remplie de faits déclarés par le client.** Borner n'est pas vérifier. Il
  faut écrire noir sur blanc que **ces lignes-là ne seront jamais lues par le grand livre** : la
  phase 03 attend des lignes produites par simulation serveur. Sans cette phrase, on paiera un jour
  des chiffres que personne n'a contrôlés.
- **Aucune base ne tourne.** La doublure de `api/test.js` peut diverger de Postgres sans que rien ne
  le signale, et l'index unique partiel comme la contrainte `name_key` n'ont jamais été éprouvés
  contre une vraie base. Les gardes textuelles atténuent, elles ne suppriment pas. C'est la dette la
  plus silencieuse de la phase.
- **L'édition de la zone dans `index.html`** touche des plages qui ont déjà cassé le jeu deux fois :
  un repère par édition, jamais une plage entre deux repères éloignés, jamais un `//` en fin d'une
  ligne existante.
- **Aucun test ne regarde le jeu tourner.** `node test.js` ne couvre que `WBCore`, l'intégration
  continue ne lance rien d'autre, et il n'existe aucun harnais navigateur — alors que deux bugs de
  l'historique n'ont été trouvés que par un test navigateur. La seule preuve que le gaz déterministe
  n'a pas rendu les parties ennuyeuses est **un humain qui joue une partie entière**.
- **Deux unités monétaires coexistent** : dollars flottants dans le jeu, centimes entiers sur le
  réseau. La confusion se produira à la frontière ; le point de conversion unique et testé est la
  protection, le suffixe `Cents` n'en est que le rappel.
- **La limitation de débit en mémoire** couvre maintenant une route qui écrit en base. Elle tient sur
  une instance, pas deux.
- **Le module qui branche le jeu est le dernier et porte tout le risque restant.** S'il glisse, trois
  modules de serveur restent du code mort que personne n'aura vu tourner. C'est pourquoi les
  fonctions pures du client — `seedFor`, `matchFlow`, `reportFrom`, `checkReport` — se livrent
  **avant** les routes : elles gèlent le contrat que le serveur doit servir.

---

## Ce qui est renvoyé aux phases suivantes

- **Phase 02b** — la simulation autoritaire : mouvement, tirs, dégâts, bots, collisions sortis de
  `Game` vers des règles pures. Le jour où ce code grossira, il aura son propre bloc marqué
  (`/*SIM-START*/` … `/*SIM-END*/`) et son propre chargeur calqué sur `api/core.js`, plutôt que de
  noyer `WBCore`, dont la valeur est justement d'être petit et entièrement testé. À ce moment-là
  seulement, le rejeu d'une partie a un sens — et il faudra avoir consigné que `Math.sin`, `Math.cos`
  et `Math.exp` ne sont pas spécifiées à l'ulp près entre moteurs : un rejeu n'est opposable que sur
  le même runtime.
- **Phase 03** — grand livre en partie double. Il lira des lignes produites par simulation serveur,
  jamais les lignes de 02a.
- **Phases 04 à 06** — portefeuille, dépôts, retraits, exploitation.
- **Une décision d'exploitation, à prendre avant le premier euro :** tant que les dix-neuf
  adversaires sont des bots, **la maison est la contrepartie de chaque pot**. Les mises des bots ne
  sont payées par personne. Ce n'est pas de l'architecture, ça n'apparaît nulle part dans le plan en
  sept phases, et ça arrive avant la phase 06. À consigner dans `docs/HISTORIQUE.md` maintenant.
- **La triche restante après 02b** : le vol de temps deviendra impossible, le vol de précision — un
  aimbot dans le champ de vision — restera entier. Avec des adversaires tous robots, la seule victime
  en est la maison, à chaque partie. Arbitrage à écrire dans `api/README.md`, pas à diluer.
- Limites de la phase 01 toujours ouvertes : journal d'audit, suppression de compte, limitation de
  débit en magasin partagé, conditions de garde du portefeuille.
