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

`index.html` contient quatre parties, dans cet ordre :

1. `<style>` — lobby, HUD, sas d'attente, écrans de fin.
2. `<script>` **`WBCore`** — les règles pures, entre les marqueurs `/*CORE-START*/` et
   `/*CORE-END*/`. Aucun état, aucun accès au DOM ni à Three.js.
3. `<script>` **`WBSim`** — l'**état** d'une partie et ce qui le fait avancer, entre
   `/*SIM-START*/` et `/*SIM-END*/`. Même discipline que `WBCore` : ni DOM, ni Three.js, ni
   horloge, ni `Math.random`. L'état d'une partie n'y est jamais une fermeture lexicale, c'est
   toujours un **paramètre explicite**, le premier, nommé `G`. Depuis la phase 02b y vit **toute la
   simulation** : la grille, le mouvement, la ligne de vue, les points de départ, l'état d'une
   entité, les tirs, les dégâts, la mort, le butin, l'encaissement, le fumigène, les bots, le
   joueur et le gaz. Il ne sonne pas et n'écrit pas à l'écran : il rend une **liste d'événements**
   horodatés en pas, que `Game` traduit. Son contrat public tient en quatre noms —
   `newMatch(graine, mode, miseCents, brawler)`, `step(G, entrees)`, `empreinte(G)` et
   `SIM_VERSION` — plus `rejouer(G, items)`, qui rejoue une trace d'entrées déjà relue. C'est par eux
   que `node test.js` joue des parties entières sans navigateur, et que `api/sim.js` refait la même
   partie côté serveur.
4. `<script>` **Game** — rendu Three.js, entrées clavier/tactile, audio, HUD. Il reprend les noms de
   `WBSim` en une seule ligne de déstructuration, garde tout ce qu'il dessine dans **trois tables
   annexes** — `MESHES` (corps des brawlers, par `eid`), `VIS` (projectiles, caisses, butin, zones,
   tourelles, grenades, nuages) et `LABELS` (étiquettes du DOM) — chacune avec un **unique**
   lecteur : `syncMeshes()`, `syncMonde()` et `hudFast()`, tous appelés une fois par image. Son pas
   de simulation ne fait plus que trois choses : **lire** les commandes (`lireEntrees()`), appeler
   `WBSim.step`, et **traduire** les événements rendus.

Les blocs 2 et 3 sont les deux parties testées. Plus la logique y descend, mieux le projet se
porte : le reste a besoin d'un navigateur pour tourner.

## Règles de travail

- **Toute logique de règle va dans `WBCore`**, avec un test dans `test.js`. Le reste du fichier
  n'est pas testable automatiquement (il lui faut un navigateur), donc plus la logique y descend,
  mieux le projet se porte.
- **Lancer `npm test` après chaque modification.** 358 tests sur le jeu (`node test.js`) et
  119 sur l'API (`node api/test.js`), aucune dépendance ni base de données pour les uns comme
  pour les autres. `api/test.js` en ajoute neuf, de bout en bout avec de la vraie cryptographie,
  quand `jose` est installé — l'intégration continue le lance deux fois, avant et après
  installation, pour que les deux promesses tiennent.
- **La syntaxe des blocs `<script>` est vérifiée par `npm test`** : un test extrait les trois blocs
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
  parser par `vm.Script`. Ils sont exactement **trois**, tous **internes** : aucun `src=` ne pointe
  vers un fichier local, sans quoi le fichier unique ne serait plus unique.
- Le bloc **SIM ne dépend d'aucun environnement** : il se charge et il **tourne** avec `document`,
  `window`, `THREE`, `Math.random`, `Date.now` et `performance` indéfinis — la même garde que
  `WBCore` — et une garde textuelle permanente interdit à `mesh`, `THREE`, `document`, `$(`,
  `snd(`, `floatText(`, `feed(` et à toute horloge de franchir ses marqueurs.
- **Un seul écrivain par table annexe** dans le bloc `Game` : `syncMeshes()` pour les corps de
  brawlers, `syncMonde()` pour les projectiles, caisses, butin, zones, tourelles, grenades et
  nuages, `hudFast()` pour les étiquettes du DOM. Trois tables, trois lecteurs uniques, la boucle
  d'image pour seul appelant. Garde textuelle : aucune fonction de simulation ne touche plus à
  `.mesh`, `.lbl`, `world.` ni `discard(` — c'est le patron du `respawn()` défini deux fois,
  transposé.
- **La simulation raconte, le rendu traduit.** `step()` rend une liste d'**événements** horodatés
  en pas — quatorze noms fermés, de `tir` à `soin` — et c'est le bloc `Game`, et lui seul, qui en
  fait des sons, des nombres flottants et des lignes de kill feed. Deux tests l'encadrent : aucun
  type inconnu n'est produit, et le lecteur les traduit tous. La garde textuelle du bloc SIM interdit
  `snd(`, `floatText(`, `feed(`, `endMatch(`, `botSay(`, `sendEmote(`, `deathSting(` et `critFx(`.
- **Une partie entière se joue sans navigateur.** `node test.js` en joue **cinquante** — dix graines
  × cinq modes — du coup d'envoi à la dernière phase du gaz, en une vingtaine de secondes. Chacune
  s'arrête sur un état **terminal**, une seule équipe en jeu ou la fin du plan de zone, jamais sur un
  compteur d'essais épuisé ; personne n'y finit coincé contre un mur ; le chien de garde `stuckT` des
  bots est **compté**, pas supposé. Même graine et même trace d'entrées rendent le même état final et
  la même **empreinte** — deux fois dans le processus, une fois dans un processus fils — et changer
  un seul pas de la trace change l'empreinte. Un **plancher de performance** garde le tout : une
  partie solo complète, 9 240 pas à vingt brawlers, doit tenir sous trois secondes.
- **L'enveloppe de `matchVerdict` est confrontée au code du jeu**, et plus à l'intuition : les
  chiffres des cinquante parties jouées par la machine — kills, durée, rang, cubes, sacoche — passent
  tous le verdict. Le rang y frôle sa borne, et c'est exactement celle que la 02a avait dû élargir.
- **L'argent se conserve à chaque pas de la vraie simulation** : sacoches + sacoches tombées au sol
  + encaissé = mise × sièges, sur les quatre tables et les cinq modes, sur un banc qui appelle les
  fonctions de `WBSim` telles quelles. C'est cette conservation qui fonde `purseBound`, donc le
  seul plafond de paiement qui existe. Les trois chemins de la sacoche sont testés un par un : un
  kill la transfère entière, une mort par le gaz la lâche au sol, un encaissement la met à zéro et
  la compte dans `G.encaisse`.
- **Les tirs ne traversent plus rien** : la collision d'un projectile se teste sur le **segment**
  parcouru dans le pas, par `WBCore.segmentHitsDisc`, corps, caisses, tourelles et murs compris.
  Éprouvée jusqu'à 300 blocs par seconde, avec l'ancien test ponctuel reconstruit dans `test.js`
  pour prouver qu'il manquait bien le cas choisi.
- **L'ordre de résolution est figé** : dans le bloc SIM, aucun `.sort(`, aucun `for..in`, aucun
  `Object.keys/values/entries`, et les `Set` (`p.hit`, `e.dashHit`) ne connaissent que `has` et
  `add`. Les touches d'un même pas se départagent par une clé totale — distance le long du segment,
  puis rang d'insertion.
- **Le code a bougé sans changer** : un corpus gelé, capturé sur le code d'avant le déplacement,
  rejoue cent pas de `moveEntity`, les requêtes de grille, la ligne de vue et `spawnPoints` sur
  huit graines, et compare **exactement**. `corpus-grille.json` est une donnée, pas un test : il ne
  se régénère pas, sinon il ne prouverait plus rien.
- Les points d'apparition placent un **corps entier** : `spawnPoints` balaie sur `free()` et jamais
  sur `isWall()`, vérifié sur deux cents graines et les cinq modes.
- **La trace des entrées du joueur fait l'aller-retour sans perte.** Elle est **quantifiée à la
  source** — `lireEntrees()` rend la valeur quantifiée et le jeu joue celle-là — puis compressée par
  plages, découpée en un à trois segments et envoyée à la fin de la partie. Enregistrée, encodée,
  décodée, elle rejoue **à l'identique** : même état final, même empreinte, comparés sans tolérance.
  Les gestes ponctuels — tir bref, super, fumigène, encaissement, abandon — y sont des jetons à part,
  avec leur propre visée, et cinq passerelles du bloc `Game` sont les **seuls** appelants des
  fonctions de SIM correspondantes. L'enregistrement ne coûte jamais une image : un pas identique au
  précédent n'alloue rien.
- **Le serveur charge la simulation du jeu, il ne la recopie pas.** `api/sim.js` extrait le bloc
  `WBSim` d'`index.html` exactement comme `api/core.js` extrait `WBCore`, garde bruyante au démarrage
  comprise. Un test charge le bloc **une seconde fois** à la façon du navigateur et vérifie que les
  deux rejouent la même trace jusqu'à la même empreinte — c'est le même code, chargé deux fois. Ce
  qui n'est pas prouvé, et n'est pas promis : l'égalité entre deux **moteurs** JavaScript.
- **`sim_version` est figée à l'ouverture du billet**, écrite par le serveur et jamais par le client :
  un correctif déployé pendant qu'un joueur joue rejouerait une autre partie que la sienne. Même
  patron que `seats` et `team_size`, et même test — un corps qui la porte écrit une ligne strictement
  identique à celle d'un corps minimal.
- **`match_traces` est en insertion seule** : clé primaire `(match_id, seq)`, `on conflict do
  nothing`, premier écrit gagne, aucun `update`, aucun `delete`. `MAX_BODY` reste à 4 Ko sur toutes
  les routes ; la borne large, `MAX_TRACE_BODY`, ne vaut que sur la route de trace, qui n'écrit
  jamais dans `matches` — c'est ce qui rend structurellement impossible qu'une trace refusée laisse
  un billet bloqué.

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
    la spécification est écrite (`docs/PHASE-02B.md`), les modules 1 à 5 sont livrés — pas fixe,
    arrêt sur image sorti des règles, hasard de la simulation semé par flux nommés, géométrie de
    la graine sans transcendantes, le bloc SIM qui existe désormais, les tirs, les dégâts, la mort
    et le butin qui y sont descendus avec leur flux d'événements, et enfin les bots, le joueur et
    le gaz, si bien qu'une **partie entière se joue désormais sans navigateur** dans `node test.js`.
    Le module 6 a livré le transport : `api/sim.js`, `sim_version` figée sur le billet, la trace des
    entrées du joueur enregistrée par le jeu et reçue par une route en insertion seule. **Reste le
    dernier module, celui qui décide** : le rejeu qui recalcule les faits. `net_cents` vient donc
    toujours d'une sacoche déclarée par le client.
    Ce n'est pas une autorité temps réel : les dix-neuf adversaires sont des bots, il n'y a rien à
    arbitrer en direct.
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
