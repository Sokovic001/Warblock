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
- **Lancer `npm test` après chaque modification.** 395 tests sur le jeu (`node test.js`) et
  204 sur l'API (`node api/test.js`), aucune dépendance ni base de données pour les uns comme
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
  normaux, et un billet qui tarde ne retarde jamais le coup d'envoi. Depuis la phase 03 les quatre
  vérifient en plus que le **portefeuille de démonstration** fonctionne comme avant : il prend la
  mise à l'entrée du sas et la rend au départ.
- **Deux économies vivent sur le même écran, et elles ne se mélangent pas.** Connecté, `wallet` est
  le solde du grand livre : il arrive en centimes, il ne redevient des dollars qu'**une fois**, dans
  `applyAccount`, et **rien** d'autre ne l'écrit — `demoDebit` et `demoCredit` sont les deux seules
  fonctions qui le mutent, elles ne font rien en ligne, et une garde textuelle interdit tout autre
  `wallet -=`, `wallet +=` ou écriture venue d'une réponse serveur. Le bouton de recharge disparaît
  en ligne, et le geste est refusé en plus d'être caché. Un montant **absent** rend `null` et ne
  s'écrit pas : lire un règlement comme un compte ne remet aucun solde à zéro.
- **Un refus NOMMÉ arrête le sas ; une panne SILENCIEUSE ne l'arrête pas.** `fonds`, `livre` et
  `renonce_recent` — liste fermée dans `WBCore.REFUS_SAS`, confrontée par `api/test.js` aux codes que
  l'API émet vraiment — ferment le sas, affichent un message et ne lancent aucune partie, sans
  laisser le lobby mort. Tout le reste, y compris un 500 et un 429, retombe dans le repli hors ligne.
- **Le bouton QUITTER du sas dit ce que partir coûte**, en appelant `WBCore.renonciationOuverte` avec
  le chronomètre du **sas**. Ce chronomètre est en avance sur celui du serveur, donc l'écran ferme la
  promesse un peu avant : il ne promet jamais un remboursement que le serveur refusera. Confronté au
  dixième de seconde sur toute la durée d'un sas, et sur toute la plage de latences plausibles.
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
  parties de bout en bout vérifient la somme globale à **chaque étape**. Le verrou, lui, n'est
  prouvé nulle part dans `npm test` : une doublure mono-fil sérialise gratuitement, et seul
  `api/db-check.js` peut l'éprouver.
- **Une divergence est mesurée, jamais punie.** La ligne est réglée et payée, marquée
  `digest_match = false`, avec `divergence_step` et `replay_ms`. Le grand livre de la phase 03 ne
  lira que des lignes convergées, et le **taux de divergence** est un agrégat exposé pour que ce
  filtre n'ait pas un rendement inconnu.
- **Le rejeu a un budget**, `REPLAY_BUDGET_MS`, éprouvé avec une horloge injectée : `createApp`
  reçoit `chrono` (une durée) en plus de `now` (une date). Treize refus nommés — les huit du rejeu,
  plus `fonds` et `livre` arrivés avec le grand livre, plus `fenetre_close`, `billet_clos` et
  `renonce_recent` arrivés avec la fenêtre de renoncement — tous en 400 ou 409, aucun en 500, aucun
  ne laissant un joueur enfermé dans un billet mort.
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
  `docs/PHASE-03.md` — **avec une réserve écrite et non levée : le job Postgres n'a jamais été
  vert.** Ce qu'elle décide, pour qu'on ne le redécouvre pas en cours de route : le solde est la
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
