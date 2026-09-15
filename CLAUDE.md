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
- **Lancer `npm test` après chaque modification.** 413 tests sur le jeu (`node test.js`) et
  255 sur l'API (`node api/test.js`), aucune dépendance ni base de données pour les uns comme
  pour les autres. `api/test.js` en ajoute neuf — 264 en tout — de bout en bout avec de la vraie
  cryptographie, quand `jose` est installé ; l'intégration continue le lance deux fois, avant et
  après installation, pour que les deux promesses tiennent. Ce compte est écrit à **quatre**
  endroits — ici, `README.md`, `api/README.md` et `docs/HISTORIQUE.md` — et il a décroché à la
  recette de la 02b puis à celle de la 03 : on relit les quatre, pas les trois qu'on a touchés.
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
  normaux, et un billet qui tarde ne retarde jamais le coup d'envoi. Depuis la phase 03 les quatre
  vérifient en plus que le **portefeuille de démonstration** fonctionne comme avant : il prend la
  mise à l'entrée du sas et la rend au départ.
- **Deux économies vivent sur le même écran, et elles ne se mélangent pas.** Connecté, `wallet` est
  le solde du grand livre : il arrive en centimes, il ne redevient des dollars qu'**une fois**, dans
  `applyAccount`, et **rien** d'autre ne l'écrit — `demoDebit` et `demoCredit` sont les deux seules
  fonctions qui le mutent, elles ne font rien en ligne, et une garde textuelle interdit tout autre
  `wallet -=`, `wallet +=` ou écriture venue d'une réponse serveur. Le bouton de recharge disparaît
  en ligne, et le geste est refusé en plus d'être caché. Un montant **absent** rend `null` et ne
  s'écrit pas : lire un règlement comme un compte ne remet aucun solde à zéro. Les montants arrivent
  de `GET /api/me` **et de `POST /api/match`**, qui les rend avec le billet après le débit — et du
  corps du `409 fonds`, qui porte le solde réel et doit éteindre la table au lieu de laisser le
  joueur recliquer. Ces deux-là passent par `adopterMontants`, et non par `adopter` : un billet n'a
  pas de statistiques, et `applyAccount` les remet à zéro sur un objet qui n'en porte pas. Cinq
  points d'écriture de `wallet`, tous nommés par la garde textuelle. Enfin, le crédit de sortie du
  sas lit `W.enLigne`, l'économie **figée à l'entrée**, et jamais `Auth.online()` : un jeton qui
  meurt au milieu du sas ferait sinon encaisser au portefeuille de démonstration une mise que le
  séquestre du serveur détient.
- **Un refus NOMMÉ arrête le sas ; une panne SILENCIEUSE ne l'arrête pas.** `fonds`, `livre`,
  `renonce_recent` et `plafond` — liste fermée dans `WBCore.REFUS_SAS`, confrontée par `api/test.js`
  aux codes que l'API émet vraiment — ferment le sas, affichent un message et ne lancent aucune
  partie, sans laisser le lobby mort. Tout le reste, y compris un 500 et un 429, retombe dans le
  repli hors ligne. **`plafond` porte UN code, DEUX portées et UN drapeau, et c'est `refusMessage` qui
  les lit** : portée `joueur`, une table moins chère marchera ; portée `maison`, le fusible global a
  sauté et aucune table moins chère n'aidera ; portée **absente ou illisible**, on rend celle de la
  maison — promettre une table moins chère quand aucune ne marchera est pire que dire « plus tard » à
  quelqu'un qu'une table moins chère aurait dépanné. **Le drapeau `aucuneTableMoinsChere` existe parce
  que la portée `joueur` mentait dans la bande haute** : le pire cas d'un billet est strictement
  positif sur les vingt combinaisons mode × palier, donc dès que l'exposition réalisée d'un joueur
  arrive à moins d'un pire cas MINIMAL du plafond, plus AUCUNE table ne passe — état atteint
  exactement après les quatre tables maximales que `PLAFOND_TABLES_PAR_JOUR` existe pour laisser
  gagner, et le joueur essayait les vingt tables jusqu'à un 429 qui n'est pas dans `REFUS_SAS`. Le
  seuil est `plafond − pire cas minimal du lobby`, jamais `plafond` ; il se calcule dans `api/app.js`,
  où `WBCore` est chargé, et se dérive de `MODES × TIERS` comme `PLAFOND_JOUEUR_CENTS` — le jeu ne
  fait que LIRE le booléen, le grand livre n'est pas une règle du jeu.
- **Le bouton QUITTER du sas dit ce que partir coûte**, en appelant `WBCore.renonciationOuverte` avec
  une **horloge monotone** posée au clic — `performance.now() − W.clic` — et jamais avec `W.t`, qui
  compte des tics de `setInterval` et retarde dès qu'un onglet passe en arrière-plan, c'est-à-dire
  dans le sens qui fait promettre un remboursement refusé. Il ne promet jamais un remboursement que
  le serveur refusera, et la propriété repose sur **trois** choses, pas sur la seule latence : cette
  horloge ; une marge nommée, `RENONCE_MARGE_ECRAN_MS`, qui couvre le vol **retour** du renoncement,
  celui qui joue contre nous — la promesse tient tant que ce vol reste sous la marge ; et le fait
  qu'on ne promette **rien** sur un billet **repris**, dont l'heure d'ouverture est celle d'un sas
  précédent. Confronté au dixième de seconde sur toute la durée d'un sas, sur trois régimes de
  minuteur bridé, et sur les deux vols séparément. Un renoncement refusé n'est plus avalé : le solde
  se redemande dans les deux cas, et le joueur lit ce qu'est devenue sa mise.
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
- **Un règlement qui PAIE exige un plancher d'horloge, et lui seul.** Le contrôle `chronometre` est
  une borne haute ; lue à l'envers, la même inéquation est un plancher, et à 120 s de marge pour un
  sas de 25 il n'exigeait **rien** — un encaissement Resurgence annoncé à 30 s simulées passait dès
  l'instant zéro, sur le chemin qui porte le plus gros paiement du dossier. `WBCore.horlogePlancher`
  est la jumelle pure du contrôle existant : elle ne lit aucune horloge, elle la **reçoit**, comme
  `renonciationOuverte`. Sa marge est nommée à part — `ENVELOPPE.margePlancherS = 30`, du même ordre
  que `margeVictoireS` et pour la même raison : elle doit couvrir tout le sas. Le refus `plancher`
  est armé **une seule fois**, après le calcul du montant et sous `netCents > 0` : il couvre donc
  l'encaissement **et** la victoire sans dupliquer les deux planchers propres à la branche
  `victoire`, et il ne touche **jamais** un règlement qui ne sort rien de la caisse — défaite,
  victoire les poches vides, sacoche d'un centime absorbée par la commission — que `margeHorlogeS`
  et ses 120 s continuent seules de regarder. **Ce n'est pas de l'anti-triche** : la partie est une
  fonction pure de `seed_public` et se rejoue en quelques centaines de millisecondes, donc un
  solveur hors ligne reste possible ; il doit désormais attendre pour encaisser, ce qui le ramène au
  rythme d'un joueur. Un renchérissement, pas une fermeture.
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
- **`matches` enregistre combien de sièges un humain a payés, et personne ne le lit.** `paid_seats`
  est écrite par le serveur et figée à l'ouverture, comme `seats`, `team_size` et `sim_version` :
  un corps portant `paidSeats: 7` écrit une ligne strictement identique à celle d'un corps minimal,
  et le chemin `repris` ne la réécrit jamais. Elle vaut **1** partout — un billet **est** une table
  tant qu'il n'existe pas d'identifiant de table partagée — et elle est **dormante, assumée telle**.
  On ne lui invente pas de lecteur : un montant *notionnel* `stake_cents × paid_seats` posé à côté
  du montant *réalisé* du grand livre est la paire qu'on finirait par confondre. La raison de
  l'écrire maintenant est celle qui fige `seats` : après coup le chiffre est irrécupérable, et
  l'exposition de la maison cesse d'être attribuable. Sa borne
  `check (paid_seats between 1 and seats)` regarde **deux** colonnes — la doublure l'imite, seul
  `api/db-check.js` la fait subir.
- **`match_traces` est en insertion seule, à UNE exception nommée** : clé primaire `(match_id, seq)`,
  `on conflict do nothing`, premier écrit gagne, aucun `update` — mais un rang déjà posé dont les
  données diffèrent est **refusé et nommé**, jamais avalé. Un segment ne portant que des jetons
  d'acte est **accepté** (`steps >= 0`) : le découpage coupe au jeton, et un acte ne compte aucun
  pas — le refuser coupait l'envoi juste avant la fin de la partie. `MAX_BODY` reste à 4 Ko sur toutes
  les routes ; la borne large, `MAX_TRACE_BODY`, ne vaut que sur la route de trace, qui n'écrit
  jamais dans `matches` — c'est ce qui rend structurellement impossible qu'une trace refusée laisse
  un billet bloqué. **L'unique exception à « aucun `delete` » est la purge nommée de la phase 03**,
  et la garde qui interdisait tout effacement a donc été affaiblie **sciemment** : elle dit désormais
  « le seul `delete` de cette table est la purge nommée, et sa clause porte les quatre conditions ».
  La trace est la pièce justificative d'un mouvement d'argent : elle ne part que si la ligne est
  réglée définitivement, que le grand livre a posé son écriture, que le séquestre est vide et que la
  rétention est écoulée — les quatre éprouvées **une par une**. La trace d'un billet dont le résultat
  n'est jamais arrivé n'est **jamais** effacée.
- **Le serveur ne croit plus aucun fait déclaré : il rejoue.** `POST /api/match/:id/result` refait la
  partie depuis `seed_public` et la trace lue en base, et recalcule durée, kills, morts, rang, cubes
  et sacoche. Un corps dont les faits sont gonflés écrit une ligne **strictement identique** à celle
  d'un corps sincère — le patron de la 02a étendu des paramètres aux faits. Seuls
  `declaredNetCents` et `digests` survivent au corps, et ni l'un ni l'autre ne décide d'un montant.
- **Une ligne ne se clôt QUE sur un état terminal** — un vainqueur, un encaissement, la mort
  définitive du joueur, ou la fin du plan de zone. Sinon aucun montant n'est écrit et le billet part
  au veilleur. Testé sur une trace terminale et chacun de ses préfixes : `net(préfixe) ≤
  net(complète)`, et `net = 0` sans fin. Sans cette règle, couper le réseau après un gros kill
  serait la meilleure stratégie du jeu.
- **`terminal`, `faits`, `argentCents`, `abandon` et le compte à rebours d'intro vivent dans
  `WBSim`**, pas dans le bloc `Game` ni dans l'API : le jeu, le harnais de test et le serveur
  doivent avoir exactement une idée de ce qu'est une partie finie et de ce qu'elle rend. Le
  décompte, lui, décide du **coup d'envoi** : il est posé par `newMatch`, et le bloc `Game` ne fait
  plus que le lire pour la bannière. Écrit d'un seul côté, le serveur rejouait en pas RÉELS les
  240 pas que le navigateur avait passés à décompter, et `digest_match` était faux sur toute partie
  réellement jouée. `abandon(G)` existe pour la même raison : QUITTER se presse aussi pendant la
  réapparition, et `kill` sort sur `!alive` — la partie n'atteignait alors aucun état terminal.
- **Le harnais de `test.js` est une SECONDE OPINION, pas une récitation.** Ses faits se dérivent du
  flux d'événements et de l'état, jamais des expressions de `WBSim.faits` : la comparaison sur les
  cinquante parties était vraie par construction tant qu'elle recopiait `G.survivedT||G.time` et
  `f.rang`. Une exception écrite : `damage` est plafonné à la vie restante de la cible, que
  l'événement ne porte pas — le test compare alors ce qu'il peut, et le dit.
- **Un billet ne sert qu'UNE tentative.** La partie est une fonction pure de la graine publique,
  donc un billet resservi est le même monde ; bloquer l'envoi de sa trace suffisait à se le faire
  resservir et à répéter la partie payante. `first_result_at` est posée au premier résultat, quelle
  qu'en soit l'issue, et `POST /api/match` clôt alors le billet sans montant (`abandoned`) plutôt
  que de le rendre. Renvoyer une trace perdue puis son résultat sur le **même** `match_id` reste
  possible : c'est le but. Et deux tentatives ne se cousent pas — un `seq` déjà posé dont les
  données diffèrent sort en 409 `trace_divergente` au lieu d'être avalé en silence.
- **`ledger_entries` est en insertion seule et en LIGNES-TRANSFERT** : montant strictement positif,
  compte débité différent du compte crédité, donc la partie double est structurelle et la somme du
  livre est nulle par construction. Aucun `update`, aucun `delete` : une correction est une
  **contre-passation**. Les comptes portent une **grammaire** — trois des six sont des familles
  paramétrées — recopiée caractère pour caractère depuis `api/ledger.js`, et les motifs une liste
  fermée de six ; deux gardes comparent le schéma au code. La clé
  `(motif, reference, compte_debit, compte_credit)` prouve qu'une jambe s'écrit au plus une fois,
  et ne prouve **pas** l'unicité d'une décomposition — ce trou-là est refermé par l'interdiction du
  découvert sur le séquestre et par la clause du règlement.
- **L'exposition de la maison est une SOMME d'écritures, et elle est CALCULABLE sans être branchée.**
  Elle se lit sur les deux comptes `maison:contrepartie` et `maison:commission` ; `maison:dotation`
  n'y entre **jamais** — émettre des crédits fictifs n'est pas s'exposer. Elle est **nette** et
  **signée**, et c'est `plafondVerdict` qui la ramène à zéro avant de comparer : une exposition
  négative reportée serait un compte d'épargne à moissonner. Le pire cas d'un billet est **reçu**,
  jamais calculé dans `api/ledger.js`, et confronté au centime aux jambes de maison que
  `mouvementGain` produit réellement — 39 000 centimes au maximum du domaine, la Resurgence à 10 $,
  d'où `PLAFOND_JOUEUR_CENTS = 4 × 39 000`, **recalculé** par le test depuis `WBCore` pour qu'un
  palier ou un mode qui change fasse re-décider. Une écriture se ramène à un billet par une fonction
  pure **exhaustive sur la liste fermée des motifs**, `referenceBillet`, parce que
  `ledger_entries.reference` est du **texte** et qu'une contre-passation y porte `gain:42` : une
  jointure par `reference::bigint` lèverait `22P02`, et une jointure qui filtre ces lignes laisserait
  un gain contre-passé compter dans l'exposition. Sa traduction SQL, `REFERENCE_BILLET_SQL`, est
  construite depuis les mêmes listes — il n'existe jamais deux écritures de la même règle.
- **Le plafond REFUSE à l'ouverture du billet, et il refuse en 409.** Deux nombres, deux natures. Le
  **plafond par joueur** est EXACT : il se lit dans la transaction de `createMatch`, **après** le
  verrou de ligne — c'est ce verrou qui sérialise deux onglets — et son agrégat est borné par les
  billets d'un joueur sur vingt-quatre heures. Le **fusible global** est APPROCHÉ : c'est un
  interrupteur, pas un invariant, il est lu **hors transaction**, au plus une fois toutes les
  `FUSIBLE_RAFRAICHI_S` secondes, valeur gardée en mémoire du processus, sur l'horloge **injectée** —
  et la cadence se lit dans les **deux sens** : `now` vaut `Date.now`, donc une horloge murale qui
  recule figerait sinon le cache pour toute la durée du recul, et un âge négatif vaut péremption.
  Le lire sous le verrou ferait de chaque ouverture un agrégat non borné sur la table qui grossit le
  plus vite du dépôt, et le dépôt a déjà payé cela une fois. **Ce que cette cadence borne est le
  retard sur le LIVRE, et rien de plus** : le fusible ne voit que des écritures réglées — les jambes
  de maison naissent du motif `gain` — donc un billet ouvert y pèse zéro pendant toute sa vie, et
  `matches_un_seul_ouvert` est PARTIEL sur `user_id` : il borne « un pire cas en vol » par JOUEUR et
  ne dit rien du nombre de billets ouverts tous joueurs confondus. L'erreur du fusible vaut donc le
  pire cas cumulé de tous les billets en vol, pas « une minute d'ouvertures ». Limite connue,
  chiffrée dans `api/app.js` et constatée par un test.
  La requête de fenêtre par joueur, elle, est bornée par le joueur **dans sa sous-requête** et sur le
  billet CALCULÉ — jamais sur `reference` brute, qui laisserait sortir une contre-passation — et
  `schema.sql` porte l'index d'expression `ledger_entries_billet_fenetre_idx` qui ouvre la boucle
  imbriquée depuis `matches`. Sans les deux, l'agrégat « par joueur » balayait la fenêtre entière de
  tous les joueurs, sous le verrou. Le pire cas d'un billet est calculé par
  le **jeu** — `cashoutCents(purseBound(mise, sièges).maxCents)` — et **passé en paramètre** : il
  n'est recalculé nulle part. La requête de fenêtre **interpole** `REFERENCE_BILLET_SQL` et compare à
  `matches.id::text`, sans aucun `cast` ; les comptes et les motifs lui arrivent en paramètres,
  depuis les mêmes listes que lit `expositionDe`. Un refus ne laisse **ni ligne, ni écriture, ni
  séquestre** et n'enferme personne — la table moins chère s'ouvre dans la foulée — mais il consomme
  une graine, comme `fonds`, parce qu'il se décide dans la transaction. Le verdict ne s'applique
  qu'à un billet **neuf** : le chemin `repris` n'est jamais refusé, et **aucun chemin de règlement ne
  peut produire le code `plafond`** — garde textuelle, parce que refuser au règlement serait voler
  une partie gagnée. Les deux index de lecture du livre portent désormais `(compte, cree_le)` ; que
  ces index **servent** n'a de preuve qu'en intégration continue, par un `explain` dans
  `api/db-check.js`.
- **La contre-passation a UN appelant, et c'est un OUTIL, jamais une route.** `api/operateur.js`, en
  ligne de commande : une route d'administration est une surface d'attaque **permanente** pour un
  geste qui arrive deux fois par an, et l'opérateur détient déjà les identifiants de la base. Même
  garde que « il n'existe aucune route `POST /api/credits` » — `app.js` ne charge jamais l'outil et
  ne nomme aucune route d'administration. **L'outil sait LIRE avant d'écrire, et `montrer` arrive en
  premier** : trois lectures qui n'écrivent rien, dont `montrer exposition <userId>`, qui répond à
  « pourquoi ce joueur a-t-il été refusé en `plafond` » — **pas** `montrer billet`, puisqu'un refus
  `plafond` ne laisse aucune ligne dans `matches` et que le 409 ne porte aucun identifiant : il n'y a
  pas de billet à relire, le diagnostic part du joueur. `montrer billet` dit la **marge à l'ouverture
  de ce billet**, avec **la requête qui refuse** et, ce qui manquait, avec ses **paramètres** : la
  même requête ancrée sur l'horloge courante au lieu d'`opened_at` rendait un autre chiffre que celui
  qui a décidé dès le lendemain du refus. `contrepasser`
  montre, exige une raison écrite, un nom et `--confirme`, puis pose l'écriture **et sa raison dans la
  même transaction** : une raison consignée après coup peut ne jamais l'être, et une contre-passation
  sans raison est indistinguable d'une erreur de manipulation. `ledger_audit` est en insertion seule
  et porte un **`geste`**, dont la liste est fermée et compte **deux** membres : un membre n'y entre
  que le jour où quelque chose l'écrit. La partie qui décide est **pure** :
  `WBCore` n'en sait rien, `planCorrection` vit dans `api/ledger.js` et rend un refus **nommé** plutôt
  que de lancer. **Un mouvement portant sur un billet encore `open` est refusé** (`billet_ouvert`) :
  c'est le seul cas qui laisserait un séquestre incohérent avec son statut, et un billet ouvert coincé
  se clôt par le veilleur — l'aide de l'outil le dit. **Contre-passer une contre-passation est refusé**
  aussi : la référence `contrepassation:gain:42` ne se ramène à aucun billet, donc l'exposition
  cesserait de la voir. Rejouer l'outil ne pose rien et **le dit**, et un gain contre-passé rend les
  quatre comptes touchés au centime — mais **réhabite le séquestre** de sa ligne, grief légitime que
  `ledgerReconcile` prononce et qu'un test asserte au lieu de le taire.
- **Un compte ne s'efface pas, il s'anonymise, et son `id` SURVIT.** Les deux cascades écrites à la
  phase 01 — `matches` sur `users`, `match_traces` sur `matches` — sont devenues **fausses sans être
  touchées** le jour où le grand livre est arrivé : ces lignes sont les **pièces justificatives** de
  mouvements d'argent qui, eux, restent, et `ledger_entries` nomme ses comptes avec `users.id` et
  `matches.id`. Elles sont en `restrict` : la suppression **échoue**. Le geste qui la remplace est le
  second verbe d'`api/operateur.js`, et c'est une **réécriture sous contraintes**, pas une
  suppression de colonnes — `auth_id`, `email`, `name` et `name_key` sont `not null`, deux sont
  uniques, deux `check` bornent les longueurs. On écrit `anonyme:<id>`, `anonyme+<id>@invalid`
  (`.invalid` est réservé, donc jamais routable), `x<id en base 36>` — quatorze caractères au plus,
  un `bigserial` tenant sur treize chiffres en base 36 — et la clé **dérivée** du nom par
  `WBCore.nameKey`, jamais écrite à côté. L'identifiant se convertit en `BigInt` et **jamais** en
  `Number` : au-delà de 2^53 deux comptes voisins recevraient le même nom. Une collision sur
  `name_key` est **dite** et arrête l'outil — deviner à la place de l'opérateur, sur un geste rare et
  irréversible, serait pire. La trace partage la transaction, ne garde **pas** l'ancienne identité, et
  se relit par le compte. **La surface de régression est vide, et c'est un test qui le dit** : aucune
  route ne supprime un compte, donc le seul effet observable est un refus que seule l'intégration
  continue peut montrer. Le trou qui reste est **nommé et chiffré** : `findOrCreate` cherche par
  `auth_id`, donc un compte anonymisé qui se reconnecte est doté une seconde fois — une route de
  suppression devra porter une empreinte d'`auth_id` en table d'insertion seule, soit une table, un
  index unique, une lecture, un test.
- **La conservation de l'argent est assertée au règlement**, sur la partie réellement rejouée ; si
  elle est fausse, c'est le serveur qui se trompe, et il n'écrit aucun montant.
- **Le solde est une SOMME d'écritures, et les routes l'écrivent.** La dotation et la recharge sont
  écrites par le **serveur** à la connexion — il n'existe aucune route `POST /api/credits`, et une
  garde le vérifie. La mise est débitée à l'**ouverture** du billet, sous verrou de ligne
  (`select id from users where id = $1 for update`, pris en tête de transaction) et dans la même
  transaction que lui : pas de billet sans son écriture, pas d'écriture sans son billet. Le chemin
  `repris` n'écrit **jamais** une seconde mise. Le règlement écrit la ligne et le gain ensemble. Un
  billet clos vide son séquestre : `solde(enjeu:<match>)` vaut la mise sur une ligne ouverte et zéro
  sur toute ligne close. `ledgerReconcile` est appelé à la fin de **chaque** scénario, et cinquante
  parties de bout en bout vérifient la somme globale à **chaque étape**. Sur une ligne close **sans
  règlement**, il ne se contente pas de constater que le séquestre est vide : il regarde **où** il
  est parti — le statut suffit à le dire — et il traite le motif `remboursement` indépendamment de
  `net_cents`. Sans ces deux règles, « ouvrir un billet, laisser expirer, se faire rembourser » se
  réconciliait en vert, c'est-à-dire très exactement le vol que la phase existe pour fermer. Le
  verrou, lui, n'est prouvé nulle part dans `npm test` : une doublure mono-fil sérialise
  gratuitement, et seul `api/db-check.js` peut l'éprouver — comme le réessai de pseudo de
  `findOrCreate`, dont le point de reprise ne se vérifie que contre une vraie base.
- **Une divergence est mesurée, jamais punie.** La ligne est réglée et payée, marquée
  `digest_match = false`, avec `divergence_step` et `replay_ms`. Le grand livre de la phase 03 ne
  lira que des lignes convergées, et le **taux de divergence** est un agrégat exposé pour que ce
  filtre n'ait pas un rendement inconnu.
- **Le rejeu a un budget**, `REPLAY_BUDGET_MS`, éprouvé avec une horloge injectée : `createApp`
  reçoit `chrono` (une durée) en plus de `now` (une date). Treize refus nommés — les huit du rejeu,
  plus `fonds` et `livre` arrivés avec le grand livre, plus `fenetre_close`, `billet_clos` et
  `renonce_recent` arrivés avec la fenêtre de renoncement — tous en 400 ou 409, aucun en 500, aucun
  ne laissant un joueur enfermé dans un billet mort. **Un compte se nomme avec l'`id` de la ligne
  relue, jamais avec le paramètre d'URL** : Postgres retrouve la ligne 7 à partir de « 007 », mais le
  grand livre refuse « 007 » à juste titre, et la seule route qui rende une mise sortait alors en
  500. Les trois motifs de route refusent désormais un zéro de tête, et un `bigserial` n'en produit
  jamais. **`GET /api/me` a son propre seau de débit, plus large, parce qu'elle ÉCRIT** — une
  transaction, un verrou de ligne et trois agrégats — et qu'elle était la seule route sans compteur.
- **Une mise ne se rend QUE pendant la fenêtre de renoncement**, dix secondes à l'horloge du
  **serveur**, arbitrée par `WBCore.renonciationOuverte` et par elle seule. Passé cette fenêtre, rien
  ne rend la mise : le veilleur clôt sans rembourser, et vide le séquestre vers
  `maison:contrepartie`. C'est ce qui ferme le vol « jouer, perdre, n'envoyer ni trace ni résultat,
  laisser expirer, et se faire rembourser » — toute condition fondée sur « aucune trace n'est
  arrivée » est contrôlée par le client, donc sans valeur. Le prix est écrit aussi : le joueur
  honnête dont l'onglet meurt à la onzième seconde perd sa mise.

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
  - Phase 02b — le serveur **rejoue** la partie. **Faite**, les sept modules livrés : pas de temps
    fixe et arrêt sur image sorti des règles, hasard de la simulation semé par flux nommés et
    géométrie de la graine sans transcendantes, le bloc `/*SIM-START*/` … `/*SIM-END*/` qui contient
    désormais toute la simulation avec son flux d'événements, une **partie entière jouée sans
    navigateur** dans `node test.js`, `api/sim.js` qui charge ce bloc côté serveur, `sim_version`
    figée sur le billet et la trace des entrées du joueur reçue en insertion seule — et enfin le
    module qui décide : `POST /api/match/:id/result` **rejoue** la partie depuis la graine publique
    et la trace, recalcule durée, kills, morts, rang, cubes et sacoche, et ne donne que ces faits-là
    à `matchVerdict`. **`net_cents` sort de la partie rejouée.** La route n'a pas changé de forme.
    Spécification : `docs/PHASE-02B.md`.
    Ce n'est pas une autorité temps réel : les dix-neuf adversaires sont des bots, il n'y a rien à
    arbitrer en direct.
  **La phase 02 est donc faite — et elle n'ouvre AUCUNE table en argent réel.** Le vol de *temps*
  devient impossible ; le vol de *précision* reste entier et il est structurel : la trace porte une
  direction de visée par pas, et le client qui dessine sa partie connaît tout le butin de la carte.
  Un rejeu n'est par ailleurs opposable que sur le **même runtime** — les tests prouvent l'égalité
  entre deux processus Node, jamais entre deux moteurs. Aucun euro n'entre avant que le grand livre
  de la phase 03 n'existe, et il ne lira que des lignes dont le rejeu a **convergé**.
- Phase 03 — grand livre en partie double, éprouvé en crédits fictifs. Entiers en centimes, jamais
  de flottant, jamais d'écrasement de solde. **Faite, les cinq modules livrés** —
  `docs/PHASE-03.md` — **et la réserve est LEVÉE depuis le 2026-09-15 : le job Postgres est vert,
  seize vérifications passées contre une vraie base** (run 34894629071). Ce qu'il a fallu pour y
  arriver mérite d'être su : le workflow ne se déclenchait que sur `main`, donc le job n'avait
  jamais tourné une seule fois ; et à son premier passage il a refusé deux cas parce que le HARNAIS
  ouvrait des billets sans avoir doté ses joueurs — la règle du découvert a fonctionné du premier
  coup, sur le seul chemin où personne ne l'avait encore vue travailler. Ce qu'elle décide, pour qu'on ne le redécouvre pas en cours de route : le solde est la
  **somme** d'écritures immuables et jamais une colonne ; une écriture est une **ligne-transfert**
  (montant strictement positif, compte débité différent du compte crédité), si bien que la partie
  double est structurelle et non assertée ; la grammaire des comptes et les motifs vivent dans
  `api/ledger.js` et non dans `WBCore`, parce qu'une comptabilité n'est pas une règle du **jeu** et
  n'a rien à faire dans les 465 Ko que chaque joueur télécharge — seul `renonciationOuverte`,
  réellement partagé avec le sas, y descend ; la mise est débitée à l'**ouverture** du billet, dans
  la même transaction, sous verrou de ligne ; le gain d'une ligne divergente va en **quarantaine**,
  mesuré et jamais dépensable.
  *Module 1* : `api/ledger.js`, entièrement pur — grammaire, motifs, mouvements, `soldeDe`,
  `ledgerReconcile` — et `WBCore` reçoit la seule règle réellement partagée avec le sas,
  `renonciationOuverte` et sa fenêtre de dix secondes.
  *Module 2* : la table `ledger_entries` en insertion seule et en lignes-transfert, l'écrivain unique
  `ledgerWrite` de `db-pg.js`, les gardes textuelles qui comparent l'expression des comptes et la
  liste des motifs au texte du schéma, `api/db-check.js` et son job d'intégration continue.
  *Module 3* : les routes écrivent — dotation et recharge à la connexion, mise débitée à l'ouverture
  sous verrou, règlement et gain dans la même transaction, quarantaine pour les lignes divergentes,
  `balanceCents` et `quarantineCents` rendus par somme.
  *Module 4* : ce que devient un billet que personne ne termine. `POST /api/match/:id/renounce` rend
  la mise pendant la fenêtre de `WBCore.renonciationOuverte` et pas une milliseconde de plus ;
  `POST /api/match` refuse en `409 renonce_recent` tant que la fenêtre du dernier billet renoncé
  n'est pas passée, si bien qu'un tirage de graine coûte la fenêtre entière et pas un aller-retour
  HTTP ; le veilleur devient un **écrivain d'argent** — il vide chaque séquestre vers
  `maison:contrepartie`, en une boucle de transactions bornées, une par billet, et il ne rembourse
  rien ; `match_traces` reçoit sa politique de conservation, `TRACE_RETENTION_JOURS` et une purge à
  quatre conditions dont chacune est éprouvée en la retirant seule.
  *Module 5* : **le jeu lit son solde du serveur.** Connecté, `wallet` vient de `GET /api/me` et de
  `POST /api/match`, en centimes jusqu'au bout du réseau, converti une seule fois dans
  `applyAccount` ; le bouton de recharge disparaît ; ni la mise ni le gain ne touchent `wallet` ; le
  bouton QUITTER du sas dit ce que partir coûte en lisant `renonciationOuverte` avec le chronomètre
  du sas ; un refus **nommé** (`fonds`, `livre`, `renonce_recent`) arrête le sas quand une panne
  **silencieuse** laisse toujours partir la partie hors ligne. Hors ligne, rien n'a changé : le
  portefeuille de démonstration reste une variable du navigateur, et il le dit à l'écran.
  **CE QUI N'EST PAS FAIT, et qu'il ne faut pas déclarer fait : le job `services: postgres` n'a
  jamais tourné.** La recette existe — `api/db-check.js`, le job d'intégration continue — le plat
  non. Jusqu'à ce qu'il soit vert une fois, **un test qui passe contre la doublure prouve la
  doublure**, et le verrou de ligne qui empêche deux onglets de dépenser le même solde n'est éprouvé
  nulle part. **Aucun euro n'entre** : les comptes sont en crédits fictifs, dotés par la maison.
- Phase 04 — l'argent réel. Comme la 02, elle s'est révélée être deux chantiers, et les deux moitiés
  sont nommées pour qu'on ne croie jamais la phase finie alors qu'elle ne l'est qu'à moitié :
  - Phase 04a — le **bord** de l'argent réel. **FAITE, les six modules livrés** — spécification :
    `docs/PHASE-04A.md`. Ce qu'elle a tranché : le plafond d'exposition **refuse** à l'ouverture du
    billet, exact par joueur sous le verrou et approché pour la maison hors transaction ; un
    règlement qui **paie** exige une attente réelle, qui était nulle sur le chemin d'encaissement le
    plus cher ; `matches` enregistre les sièges payés, dormante et assumée telle ; la
    contre-passation a un appelant, et c'est un **outil** en ligne de commande, jamais une route ;
    un compte ne s'efface plus, il s'**anonymise**, et `users.id` survit. **Réserve, et elle est
    entière : le job `db` n'a pas tourné une seule fois pendant les six modules.** Quatre propriétés
    nouvelles n'ont de preuve que là — deux ouvertures simultanées sous le plafond, la requête de
    fenêtre qui ne balaie pas le livre, l'audit dont le `rollback` est arbitré par Postgres, et le
    `delete from users` refusé — et le dernier passage vert connu (run 34894629071, 2026-09-15) est
    **antérieur à tout ce que la phase a écrit en SQL**.
    Elle ne contient aucun dépôt : elle livre les prérequis que ce fichier et
    `docs/HISTORIQUE.md` déclarent eux-mêmes bloquants — un **plafond d'exposition** décidé à
    l'ouverture du billet, le **compte des sièges payés** que `matches` n'enregistrait pas, et **qui
    a le droit de contre-passer** — plus deux cascades de schéma qui détruisaient les pièces
    justificatives d'un compte effacé, et un **plancher d'horloge** sur les règlements qui paient.
    Six modules. Rien n'y ouvre de table en argent réel, `SIM_VERSION` ne bouge pas, et le jeu ne
    reçoit qu'un membre de plus dans `WBCore.REFUS_SAS` et une fonction pure de plus dans `WBCore`.
    *Module 1* : **livré**. `api/ledger.js` reçoit les cinq constantes du plafond,
    `expositionBilletMaxCents`, `referenceBillet` et sa traduction SQL, `expositionDe` et
    `plafondVerdict`, plus l'épreuve exhaustive de `decouvertAutorise` sur l'espace des comptes.
    **Aucun appelant, aucune route, aucune colonne** : le dépôt ne change pas de comportement d'un
    octet, et la borne n'existe pas encore.
    *Module 2* : **livré**. La marge d'horloge se resserre là où elle protège de l'argent —
    `WBCore.horlogePlancher`, `ENVELOPPE.margePlancherS = 30`, le refus `plancher` armé sur tout
    règlement qui paie, encaissement compris. `SIM_VERSION` ne bouge pas, le sas ne reçoit rien, et
    `api/app.js` n'a pas changé d'une virgule : un refus de verdict clôt déjà la ligne en `rejected`
    et rend le règlement, jamais un 500.
    *Module 3* : **livré**. `matches.paid_seats`, écrite par le serveur, figée à l'ouverture, bornée
    par `between 1 and seats`, valant 1 partout — **dormante et assumée telle**, sans lecteur.
    Premier module de la phase à toucher une clause SQL : le job `db` le concerne, et il n'a pas pu
    être lancé sur la machine de travail.
    *Module 4* : **livré**. Le plafond refuse à l'ouverture, en `409 plafond`, et le sas le dit.
    Plafond par joueur EXACT sous le verrou de `createMatch`, fusible global APPROCHÉ hors
    transaction et amorti à `FUSIBLE_RAFRAICHI_S`, requête de fenêtre sans aucun `cast` —
    `REFERENCE_BILLET_SQL` interpolée, comparée à `matches.id::text` — deux index de lecture passés à
    `(compte, cree_le)`, et `WBCore.REFUS_SAS` à quatre membres avec un message qui lit la portée.
    Second module de la phase à toucher des clauses SQL : le job `db` le concerne, et il n'a pas pu
    être lancé sur la machine de travail.
    *Module 5* : **livré**. Qui a le droit de contre-passer — `ledger_audit` en insertion seule et
    dans la MÊME transaction que l'écriture d'argent, `api/operateur.js` en ligne de commande avec
    `montrer` d'abord et `contrepasser` ensuite, `planCorrection` pure dans `api/ledger.js`, le refus
    nommé `billet_ouvert`, et la garde « aucune route d'administration ». `mouvementContrepassation`
    cesse d'être du code mort. Troisième module de la phase à toucher des clauses SQL : le job `db` le
    concerne, et il n'a pas pu être lancé sur la machine de travail.
    *Module 6* : **livré**, et il ferme la phase. Les deux cascades de la phase 01 passent en
    `restrict` ; `api/operateur.js` reçoit `anonymiser`, une **réécriture sous contraintes** où
    `users.id` survit toujours ; `ledger_audit` reçoit un `user_id` et un second geste ;
    `docs/HISTORIQUE.md` reçoit l'état après la phase, la doctrine de dépôt en quatre phrases, les
    deux migrations gratuites avec leur échéance, et corrige son entrée périmée sur l'écran de fin.
    Quatrième module à toucher des clauses SQL, et le seul dont la **surface de régression est
    vide** : un test le dit plutôt qu'une lecture. Le job `db` le concerne, et il n'a pas pu être
    lancé sur la machine de travail.
  - Phase 04b — le **dépôt** lui-même : compte fournisseur de paiement, webhook d'encaissement,
    idempotence sur l'événement PSP, vérification d'identité, cadre légal. Le motif `depot` du grand
    livre s'ouvre là et pas avant. Rien ne s'en vérifie sans hébergement.
- Phases 05 et 06 — retraits, exploitation. **Rien de réel avant que 01 à 04 soient finies.**

**L'économie, tranchée le 2026-09-15.** Les bots sont un **bouchon** qui remplit les sièges vides
tant que la population ne suffit pas, jamais un modèle économique : l'objectif est une table pleine
de joueurs réels. Le pot affiché est donc tenu tel quel, et **la maison paie la différence entre ce
qui sort de la caisse et ce qui a réellement été misé**. `mouvementGain` l'écrit — `maison:contrepartie
→ enjeu` du brut moins la mise — et le solde négatif de ce compte EST l'exposition de la maison.
La commission de 20 % porte sur un pot notionnel : sur une table à $0,50 dont un seul siège est payé,
elle vaut $0,10 de réel, pas $2, et un joueur qui emporte toute la table coûte $7,50 à la maison.

Deux choses restaient ouvertes et bloquaient la phase 04 : **un plafond** — le grand livre mesure
l'exposition, il ne la borne pas, et rien n'empêche un joueur fort de la moissonner sur des tables
remplies de bots ; et **le compte des sièges réellement payés**, que `matches` n'enregistrait pas.
La seconde est réglée depuis le module 3 de la 04a : `matches.paid_seats` existe, écrite par le
serveur et figée à l'ouverture. Aujourd'hui la réponse est toujours « un », donc **rien ne la lit, et
c'est exactement pourquoi elle est créée maintenant** — au premier remplissage partiel elle variera,
et après coup le chiffre serait irrécupérable, l'exposition cessant d'être attribuable. Détail et
raisons dans `docs/HISTORIQUE.md`, « La maison est la contrepartie de chaque pot ». **La première
l'est depuis le module 4 de la 04a : le plafond REFUSE**, en 409, à l'ouverture du billet — exact par
joueur sous le verrou, approché pour la maison et hors transaction. Ce qu'il ne borne pas est écrit
avec lui : un plafond par joueur ne borne pas une **flotte de comptes**, le fusible global vaut
environ treize comptes saturés **sur un livre par ailleurs à l'équilibre**, et le seul remède réel est
une vérification d'identité, en 04b. Ce chiffre-là n'est pas une propriété : le fusible lit une
exposition **nette**, donc la marge du jour relève son seuil réel — `PLAFOND_MAISON_CENTS + marge
nette de la fenêtre` — et le nombre de comptes nécessaires croît avec le trafic (13, 14, 19, 26, 39 à
0, 20 000, 100 000, 200 000, 400 000 billets réglés par jour). Il protège la **caisse**, il ne compte
pas les comptes, et il est de moins en moins un rempart contre une flotte à mesure que le site
grossit : cela **avance** l'échéance du KYC au lieu de la reculer.

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
