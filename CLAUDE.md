# Contexte pour Claude Code

## Ce qu'est ce dépôt

Un jeu HTML5 complet dans **un seul fichier**, `index.html` : styles, règles et rendu.
Pas de build, pas de bundler, pas de `node_modules`. Three.js r128 est chargé depuis un CDN.

À côté, depuis la phase 01 du chantier « argent réel », un dossier `api/` : un petit serveur Node
qui détient les comptes et les profils. **Le jeu reste un seul fichier statique** ; il appelle
l'API par HTTPS. L'API ne recopie aucune règle : `api/core.js` charge le bloc `WBCore` depuis
`index.html`, celui-là même que le navigateur exécute.

L'identité vient de **Crossmint** : connexion par email, et le portefeuille dont la phase 04 aura
besoin naîtra du même compte. Le serveur ne dépend que de `jose` pour la cryptographie, et décide
lui-même de ce qu'il accepte d'un jeton — le SDK du fournisseur ne vérifie pas `aud`, donc il ne
peut pas tenir ce rôle seul. Détails et raisons dans `api/README.md`.

## Architecture

`index.html` contient trois parties, dans cet ordre :

1. `<style>` — lobby, HUD, sas d'attente, écrans de fin.
2. `<script>` **`WBCore`** — les règles pures, entre les marqueurs `/*CORE-START*/` et
   `/*CORE-END*/`. Aucun accès au DOM ni à Three.js. C'est la seule partie testée.
3. `<script>` **Game** — rendu Three.js, entrées clavier/tactile, IA des bots, audio, HUD.

## Règles de travail

- **Toute logique de règle va dans `WBCore`**, avec un test dans `test.js`. Le reste du fichier
  n'est pas testable automatiquement (il lui faut un navigateur), donc plus la logique y descend,
  mieux le projet se porte.
- **Lancer `npm test` après chaque modification.** 313 tests sur le jeu (`node test.js`) et
  104 sur l'API (`node api/test.js`), aucune dépendance ni base de données pour les uns comme
  pour les autres. `api/test.js` en ajoute neuf, de bout en bout avec de la vraie cryptographie,
  quand `jose` est installé — l'intégration continue le lance deux fois, avant et après
  installation, pour que les deux promesses tiennent.
- **La syntaxe des blocs `<script>` est vérifiée par `npm test`** : un test extrait les deux blocs
  d'`index.html` et les fait parser par `vm.Script`. Une erreur de syntaxe dans le bloc `Game` — le
  mode de défaillance le plus fréquent de ce dépôt — tombe donc avant d'ouvrir le navigateur, et
  avant que le workflow de publication ne serve le fichier. Le faire à la main reste utile en cours
  d'édition, ce n'est plus la seule protection.
- **Ne jamais mettre un commentaire `//` en fin d'une ligne existante** lors d'une édition par
  remplacement de texte : si du code suit sur la même ligne, il est avalé silencieusement. Ce
  piège a cassé le jeu deux fois. Un commentaire va sur sa propre ligne.
- **Attention aux plages de remplacement.** Remplacer tout ce qui se trouve entre deux repères
  a déjà supprimé la caméra et l'éclairage par accident. Vérifier ce que contient la plage.
- **L'argent se calcule au centime** via `cents()`. Les mises descendent à $0,50 : un arrondi à
  l'entier efface la commission.

## Invariants tenus par les tests

- Le pot se partage sans reste en Duo et en Trio, sur les quatre tables.
- Aucun brawler n'en domine un autre à la fois en PV, portée et vitesse.
- La carte est **entièrement** connexe : aucune case praticable n'est coupée du centre, sur
  aucune graine. Le seuil de 97 % qui figurait ici tolérait une pièce scellée de 23×23, et
  n'était de toute façon testé que sur la graine 9. Une passe de réparation, à la fin de
  `generateMap()`, libère les props qui emmurent puis tunnelle les poches fermées par les murs.
- La vitesse d'un brawler est toujours celle que donne `derivedSpeed()`, jamais une valeur écrite
  à la main.
- Les montants du bandeau « live wins » sont produits par les vraies fonctions de paiement.
- Les trois parts de `BOX_DROP` font toujours 1, et le cube reste le drop le plus courant.
- Les fumigènes restent rares : rien ne se recharge avec le temps, et tout le stock de caisses
  d'un mode donne moins d'une grenade par joueur — vérifié sur les cinq modes.
- La fuite est garantie : un fumigène lâché à ses pieds cache le lanceur de tout adversaire situé
  au-delà de deux blocs, sous n'importe quel angle et à n'importe quelle distance.
- Le sens unique de la fumée est borné : la fenêtre appartient à l'équipe qui a lancé et se ferme
  avant que le nuage ne commence à se dissiper. Passé la fenêtre, le nuage aveugle les deux côtés.
- La fumée n'arrête jamais un projectile, et ne cache jamais quelqu'un collé à soi.
- La commission n'est jamais nulle sur un paiement non nul : sur 0 à 1 000 000 centimes,
  `fee + net = brut` et `fee > 0` dès que le brut l'est.
- `toCents` et `fromCents` sont le **seul** passage entre dollars et centimes, et une garde
  textuelle vérifie que rien d'autre dans le bloc `CORE` ne change d'unité.
- Même graine, même plan de zone — deux fois de suite et dans deux processus. `zonePlan` tourne
  avec `Math.random` remplacé par une fonction qui lance.
- Le plan de zone n'a qu'un seul lecteur, `zoneAt` : une garde interdit la réapparition d'un
  second décompte à côté, exactement le patron du `respawn()` défini deux fois.
- La simulation avance à **pas fixe** : `WBCore.simSteps` convertit le temps du navigateur en un
  nombre entier de pas de `SIM.stepS`, et aucune fonction de simulation ne reçoit plus le `dt`
  d'une image. La durée d'une partie se compte donc en pas, jamais sur l'horloge du navigateur, et
  elle est toujours inférieure ou égale à la durée réelle. Une garde textuelle interdit à la boucle
  d'image de rappeler une fonction de simulation, et à l'arrêt sur image du coup critique de
  redevenir un multiplicateur de `dt`.
- Tout le hasard de la **simulation** descend de la graine publique, par des **flux nommés par
  usage** — `bots/identite`, `bots/visee`, `bots/objectif`, `bots/encaissement`, `apparition`,
  `butin/contenu`, `butin/position`, `tir/dispersion`. Ajouter un tirage dans l'un ne déplace rien
  dans les autres, et un test le prouve. Deux listes nommées dans `test.js` gardent la frontière :
  les fonctions où `Math.random(` est **interdit**, et celles où il est **attendu** — le cosmétique,
  plus la graine locale de secours, qui doit précisément ne pas être reproductible.
- La géométrie tirée de la **seule** graine — `generateMap`, `generateBiomes`, `zonePlan`, `zoneAt`,
  `spawnPoints` — n'appelle aucune fonction transcendante : les angles viennent d'une table
  `C.UNIT` de 1024 directions écrites en littéraux de source, et `dist()` de `Math.sqrt`. Garde
  textuelle plus bac à sable où `Math.cos`, `Math.sin`, `Math.hypot`, `Math.pow`, `Math.atan2` et
  `Math.exp` **lancent**. L'interdiction s'arrête là : la visée, les lobs et le dash gardent leurs
  angles, et la doctrine pour le reste est la divergence mesurée, jamais punie.
- Le jeu se joue à l'identique sans compte et sans serveur, graine comprise : quatre cas nommés
  (`ACCOUNT.api` vide, pas de session, serveur muet, réponse illisible) sont testés comme des cas
  normaux, et un billet qui tarde ne retarde jamais le coup d'envoi.
- Chaque bloc `<script>` d'`index.html` est du JavaScript valide — un test l'extrait et le fait
  parser par `vm.Script`.

## Argent des joueurs

Le plan complet est en sept phases, et **l'ordre n'est pas négociable** : le serveur doit posséder
l'état du jeu avant qu'un euro n'entre. Aujourd'hui `wallet` est une variable du navigateur, donc
tout solde y est modifiable depuis la console.

- Phase 01 — comptes et profils. **Faite** : `api/` côté serveur, et l'écran de connexion dans le
  jeu, par les routes de code email de Crossmint. Pas de React, pas de bundler : `index.html` reste
  un seul fichier, et reste jouable sans compte. Une ligne à remplir, `ACCOUNT.api`, le jour où le
  serveur tournera quelque part.
- Phase 02 — le serveur devient l'autorité du jeu. `WBCore` tourne déjà dans Node, c'est le socle.
  Le chantier s'est révélé être deux chantiers, et les deux moitiés sont nommées pour qu'on ne
  croie jamais la phase finie alors qu'elle ne l'est qu'à moitié :
  - Phase 02a — le serveur possède l'**identité** de la partie : il émet le billet (graines, mode,
    mise en centimes entiers, heure d'ouverture, expiration), il juge le rapport rendu et recalcule
    lui-même tout montant. **Faite**, jeu branché compris : `index.html` demande son billet quand il
    a un compte et une adresse de serveur, tire sa graine de `seedFor`, rend son rapport à la fin, et
    se comporte exactement comme avant dès qu'il manque l'un des deux. Spécification :
    `docs/PHASE-02.md`.
  - Phase 02b — le serveur **rejoue** la partie : pas de temps fixe, hasard tiré de la graine,
    simulation sortie du rendu dans un bloc `/*SIM-START*/` … `/*SIM-END*/`, et un serveur qui
    refait la partie depuis la graine publique et la trace des entrées du joueur. **EN COURS** :
    la spécification est écrite (`docs/PHASE-02B.md`), les modules 1 et 2 sont livrés — pas fixe,
    arrêt sur image sorti des règles, hasard de la simulation semé par flux nommés et géométrie de
    la graine sans transcendantes — et les cinq autres restent à faire. Le mouvement, les
    tirs et les bots vivent toujours dans le script `Game`, hors de toute partie testée, et
    `net_cents` vient toujours d'une sacoche déclarée par le client. Ce n'est pas une autorité
    temps réel : les dix-neuf adversaires sont des bots, il n'y a rien à arbitrer en direct.
  Tant que 02b n'est pas faite, **la phase 02 n'est pas faite et aucun euro n'entre** : le verdict de
  02a est une enveloppe de plausibilité, pas de l'anti-triche, et il n'arrête presque rien en
  pratique. Une phase 02a « faite » ne doit jamais se lire comme une phase 02 finie.
- Phase 03 — grand livre en partie double, éprouvé en crédits fictifs. Entiers en centimes, jamais
  de flottant, jamais d'écrasement de solde.
- Phases 04 à 06 — dépôts, retraits, exploitation. **Rien de réel avant que 01 à 03 soient finies.**

Règles qui tiennent dès maintenant : aucune colonne « solde » en base tant que le grand livre
n'existe pas ; le client ne peut écrire que son pseudo, son avatar et son pays ; aucun secret dans
le dépôt, `.env` est ignoré.

## Historique

`docs/HISTORIQUE.md` retrace les décisions prises, les pistes abandonnées et les bugs déjà
rencontrés avec leur cause réelle. À lire avant de relancer un chantier (notamment le lobby
mobile, tenté trois fois et abandonné) ou avant de rouvrir une décision d'équilibrage.

## Ce qui n'est pas réel

Population en ligne, files d'attente, gains affichés, adversaires : **tout est simulé**. Le jour
où un backend existera, ces fonctions doivent être remplacées par les compteurs du serveur, pas
conservées.
