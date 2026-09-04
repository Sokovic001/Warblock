# WARBLOCK — Showdown avec mises

Réécriture du concept sur la boucle de **Brawl Stars Showdown** : vue de dessus 3/4, visée à la souris, brawlers avec attaque + super, munitions qui se rechargent, buissons, murs, caisses → cubes de pouvoir, gaz qui se referme. Plus l'économie : chaque joueur porte sa mise, tu la ramasses en le tuant, le pot vaut 20 × la mise et le dernier debout en empoche **16 ×**, la maison prélevant 20 %.

Un seul fichier HTML (Three.js r128 via CDN). `node test.js` → 121 tests sur les règles pures.

## Lancer

Ouvre `index.html` dans Chrome. Choisis un brawler, une table, clique pour partir. Pas de pointer lock nécessaire : la souris vise librement, donc ça marche aussi dans l'aperçu Claude.

## Contrôles

**Desktop** : WASD déplacer · souris viser · clic gauche attaquer (maintenir = tir continu) · clic droit ou Espace super · Q tir auto-visé · Échap pause.

**Mobile / tablette** (détection automatique, comme Brawl Stars) :
- **Pouce gauche** — joystick flottant : apparaît là où tu poses le doigt, déplace le brawler.
- **Pouce droit** — *tap* = tir rapide auto-visé sur l'ennemi visible le plus proche · *glisser* = viser (le guide s'affiche, la distance du drag règle la portée des bombes de VOLT et de la flaque de PYRO) puis *relâcher* = tirer.
- **Bouton SUPER** orange — tap = super dans la direction courante · glisser dessus = viser le super puis relâcher.
- Bouton ▐▐ en haut pour la pause. L'interface se compacte sur petit écran, le rendu baisse à 1,15× le pixel ratio pour tenir 60 fps.

## Brawlers (10)

| | Rôle | PV | Attaque | Super |
|---|---|---|---|---|
| **BOLT** | Sharpshooter | 110 | rafale de 6 balles, portée 11 | 12 balles perforantes |
| **SHELL** | Brawler | 140 | 5 plombs en éventail, portée 7,5 | 9 plombs perforants + recul |
| **BRICK** | Tank | 200 | 3 coups courts, portée 4,6 | onde de choc 80 dmg, rayon 3,2, projection |
| **HEX** | Sniper | 85 | 1 balle, 30 → 84 dmg selon la distance, portée 15 | tir perforant 130 |
| **PYRO** | Flamethrower | 145 | cône de 5 flammes, portée 5,5 | flaque de feu 4 s, 45 dmg/s, rayon 3 |
| **MEDIC** | Support | 120 | vague large perforante, portée 8 | soin instantané 70 % PV |
| **VOLT** | Demolition | 100 | bombe lobée **par-dessus les murs**, 60 dmg en zone (vise la distance du curseur) | grosse bombe 150 dmg, rayon 2,6 |
| **GHOST** | Assassin | 95 | 4 lames, portée 6 — le plus rapide | invisibilité 5 s (attaquer la casse) |
| **RUSH** | Melee | 170 | 2 coups lourds, portée 3 | dash de 7 blocs, 90 dmg à tout ce qu'il traverse |
| **WARD** | Engineer | 130 | 1 gros carreau 58 dmg, portée 8,5 | tourelle 140 PV, 15 s, tire toute seule |

3 munitions rechargées une par une. Le super se charge en infligeant des dégâts (≈ 3–4 attaques complètes) — Espace, clic droit ou le gros bouton orange. Hors combat 3 s → régénération 7,5 % PV/s. Les bots choisissent un brawler au hasard et utilisent leur super selon sa nature (MEDIC se soigne quand il est bas, GHOST disparaît pour fuir ou engager, WARD pose sa tourelle dès qu'il voit quelqu'un…).

## Vitesse de déplacement

La vitesse n'est plus écrite à la main : elle est **dérivée des PV et de la portée** par `derivedSpeed()`, avec un petit décalage d'agilité par rôle. Un brawler qui tape fort de près avec une grosse réserve de vie ne peut pas courir aussi vite qu'un fragile à longue portée.

| Vitesse | Brawler | PV | Portée | Rôle |
|---|---|---|---|---|
| **5,65** | BRICK | 200 | 4,6 | Tank |
| **6,25** | RUSH | 170 | 3 | Melee |
| 6,45 | PYRO | 145 | 5,5 | Flamethrower |
| 6,70 | SHELL | 140 | 7,5 | Brawler |
| 6,80 | WARD | 130 | 8,5 | Engineer |
| 7,00 | MEDIC | 120 | 8 | Support |
| 7,30 | BOLT | 110 | 11 | Sharpshooter |
| 7,35 | VOLT | 100 | 9 | Demolition |
| 7,50 | HEX | 85 | 15 | Sniper |
| **8,10** | GHOST | 95 | 6 | Assassin |

Écart de 2,45 contre 1,4 avant : la différence se sent. Les décalages d'agilité sont volontaires et limités — GHOST +0,95 (un assassin doit pouvoir rattraper un sniper), HEX −0,55, RUSH +0,35 (assez pour engager, jamais assez pour fuir), BOLT et WARD −0,10.

Huit tests verrouillent la relation : aucune vitesse écrite à la main ne doit subsister dans le littéral, la table dérivée est épinglée valeur par valeur, la corrélation PV/vitesse doit rester négative, plus de portée à PV égaux doit aller plus vite, les deux lourds de mêlée doivent fermer la marche, à fragilité égale le courte-portée doit être le plus rapide, l'écart doit dépasser 2, et **aucun brawler ne doit dominer un autre à la fois en PV, portée et vitesse**. Ce dernier test a révélé deux vrais déséquilibres au passage (BOLT dominait WARD, SHELL dominait PYRO) : PYRO passe à 145 PV et WARD à 130 PV / portée 8,5, chacun payant en lenteur. La vitesse s'affiche sur les cartes du lobby (`SPD`).

## Silhouettes

Chaque brawler a sa propre carrure, arme et accessoires — reconnaissable d'un coup d'œil de haut :

| | Silhouette |
|---|---|
| **BOLT** | fin, long fusil à lunette, casquette à l'envers, pochette de munitions |
| **SHELL** | trapu, fusil à double canon, bandana noué, épaulières |
| **BRICK** | énorme, sans arme — poings sphériques, blocs d'épaules, masque soudé |
| **HEX** | grand et maigre, canon très long avec bipied, chapeau à large bord, cape |
| **PYRO** | deux bouteilles de gaz dans le dos, lance avec flamme pilote, crête de feu |
| **MEDIC** | blouse blanche à croix rouge, sacoche, casque à croix |
| **VOLT** | bombe à mèche en main, bandoulière de grenades, casque à antenne |
| **GHOST** | fine, capuche, longue cape, deux lames, visière cyan lumineuse |
| **RUSH** | gants surdimensionnés, pauldrons à pics, crête de trois pics |
| **WARD** | sac à dos avec tuyaux, cloueuse, ceinture à outils, casque de chantier |

## Aperçus

Chaque carte du lobby affiche le **modèle 3D réel** du brawler (couleur, chapeau, arme) rendu en portrait ; le brawler sélectionné tourne sur lui-même en continu, façon podium. Rendu par un second contexte WebGL transparent de 220 px, coût nul en jeu (la boucle s'arrête dès que le lobby se ferme).

## La map

**152 × 152 blocs** — deux fois plus grande par côté (quatre fois la surface) que la version précédente, pour que 50 joueurs aient de la place. Toujours générée à chaque partie, et **entièrement** connexe : zéro case praticable coupée du centre, sur les 2000 graines balayées. La couronne de spawn, la croix centrale et les deux routes circulaires taillées à la main n'y suffisaient pas — au-delà de la couronne, la bande extérieure n'avait aucune voie propre, et la croix la découpait en quadrants. La graine 267 tombait ainsi à 95,26 %, avec le coin nord-ouest entier scellé, soit 877 cases. Une passe de réparation ferme désormais la question à la fin de `generateMap()` : elle libère les props qui emmurent, puis relie par le tunnel le plus court les poches fermées par les murs.

### Lire le terrain d'un coup d'œil

Murs et buissons sont construits avec des **formes différentes**, pas seulement des couleurs :

- **Murs (infranchissables)** — barres de 2 blocs minimum, corps sombre surmonté d'un chapeau clair légèrement débordant et cerné de noir, avec une tuile d'ombre au sol.
- **Props (couverture basse)** — une caisse sur deux, un tonneau sur deux. Ils bloquent déplacements et tirs comme un mur, et ne sont posés que sur une case dont les quatre voisines sont dégagées. Cette garde empêche deux props de se toucher, mais elle ne suffit pas à garder la map ouverte : quatre props posés sur les diagonales d'une même case l'emmurent quand même — tous légaux puisque jamais orthogonalement adjacents — et un seul prop peut boucher un couloir d'une case de large. C'est la passe de réparation qui tient l'invariant, pas la garde de placement.
- **Buissons (cachette)** — touffes de feuilles à bouts arrondis sur un tapis sombre, environ 10 % de la map (8,7 à 11,4 % selon la graine) en massifs de 6 cases en médiane.
- **Sol** — grandes plages de couleur avec taches organiques au bruit, bordure sombre encadrant l'arène.

### Une seule scène : la ferme

Le jeu tourne désormais sur **un seul biome, FARM**. Les définitions VOLCANO et SNOW restent dans le code et un simple `BIOME_COUNT = 1` les réactive — mais une arène cohérente se lit bien mieux que trois biomes cousus sur la même map, et la minimap devient lisible.

### HUD compact

Tout ce qui empiétait sur la vue a été resserré :

- **Une seule barre fine en haut à gauche** : argent, cubes ◆, kills ☠ et le pot, au lieu de trois panneaux empilés. Le coin haut-gauche est précisément là où arrivent les joueurs.
- **Pastille centrale** réduite : joueurs restants et compte à rebours du gaz sur une seule ligne.
- **Minimap** ramenée de 170 à 124 px (88 px sur mobile).
- Le panneau « POWER CUBES » du bas et le nom du biome sont supprimés — l'information est dans la barre du haut.

### Minimap lisible

Elle affichait les 90 caisses en pointillés, ce qui la transformait en bruit. Elle ne montre plus que ce sur quoi on peut agir : **la zone hors gaz est assombrie en vert**, le cercle sûr est tracé net, le prochain cercle en pointillés blancs, les **sacs d'or** en pastilles dorées, les **coéquipiers** en cyan, et toi en flèche blanche orientée. Le fond de carte est en teintes douces et sans contraste inutile.

## Direction artistique — plus proche de Brawl Stars

- **Ombres portées** sous les brawlers, les caisses, les tonneaux et les objets au sol. C'est le détail qui change le plus : sans elles, tout semble collé sur le décor au lieu d'y être posé.
- **Sol sans damier** : de grandes plages de couleur cassées par des taches organiques générées au bruit, plus de petites touffes sombres, et une **bordure plus foncée qui encadre l'arène**. Le damier lisait comme un plateau d'échecs vu de haut.
- **Murs en barres** : corps sombre surmonté d'un **chapeau clair légèrement débordant**, cerné de noir — la silhouette moulée des murs de Brawl plutôt qu'une pile de cubes.
- **Tonneaux** : une couverture basse sur deux est désormais un tonneau cylindrique à cerclages, l'autre une caisse. Les silhouettes cassent la grille.
- **Feuillage à bouts arrondis** : les feuilles sont des cônes tronqués, pas pointus — un sommet aplati lit comme une touffe, une pointe lit comme une épine.
- **Palettes plus saturées** et éclairage retravaillé : lumière frontale douce, contre-jour bleuté léger, murs rose-corail en forêt comme dans la référence.

## Ancienne direction artistique

Façon Brawl Stars : personnages ronds à grosse tête et contour noir, chapeau distinctif par brawler, sol vert vif en damier, murs sable, buissons translucides, UI jaune/orange épaisse avec ombres dures, barre de vie + munitions au-dessus de la tête, gros bouton SUPER rond en bas à droite, dégâts flottants.

## Lobby mobile

Le lobby tactile reprend la mise en page du bureau, adaptée au doigt :

- **Sélection en deux temps.** Toucher une table la **sélectionne** (contour jaune) ; c'est un bouton de validation qui lance la partie. Sur un écran tactile, un effleurement ne doit jamais pouvoir engager une mise sans confirmation.
- **Barre de validation fixe en bas de l'écran**, toujours accessible sans remonter : elle rappelle le brawler et le mode choisis et affiche la mise et le pot du choix courant. Elle respecte les encoches (`env(safe-area-inset-bottom)`) et prend le rouge Resurgence quand ce jeu est sélectionné.
- **Rail de brawlers défilant horizontalement** avec accroche magnétique, au lieu d'une grille de dix cartes. Le brawler sélectionné est recentré automatiquement ; les descriptions sont masquées, l'aperçu 3D et les stats restent.
- **Cartes de jeu et de mode compactées**, les quatre tables sur une ligne, bandeau des gains réduit.
- **Paysage téléphone** (`max-height:520px`) : tout se resserre encore d'un cran.

La détection du tactile passe par `matchMedia('(pointer: coarse)')` et non `'ontouchstart' in window`, qui est vrai sur beaucoup de Chrome de bureau et basculait à tort tout un ordinateur en mise en page téléphone.

## Sas d'attente avant le drop

Cliquer une table n'envoie plus directement sur la map : on passe d'abord par une **salle d'attente** façon Fortnite / Warzone. **Une partie lancée est scellée — personne ne peut y tomber en cours de route**, donc la salle doit se remplir avant le départ.

- **25 secondes maximum.** Dès que les sièges sont tous pris, le compte à rebours se réduit à 3 s (« Room full — dropping in ») : on n'attend jamais pour rien.
- **Les joueurs arrivent progressivement**, à une cadence dérivée de la profondeur de file de cette table. Une table $0,50 bondée se remplit en ~10 s, une $10 en Trio à 9 h du matin prend les 25 s complètes.
- **Le pot monte en direct** à mesure que les sièges se prennent, et la barre affiche « 13 / 20 brawlers seated » avec un fil des arrivées.
- **Ton brawler tourne sur un podium** pendant l'attente (même rendu que les aperçus du lobby).
- **La mise est prélevée à l'entrée** dans la salle, et **intégralement remboursée** si tu pars avant le drop (bouton « LEAVE · REFUND STAKE »).
- **Aucune confirmation à l'arrivée.** Le drop enchaîne directement sur un **décompte 3 · 2 · 1 · GO!** avec le monde figé, puis la partie démarre. Tu as validé ton entrée dans le sas, on ne te redemande pas si tu es prêt.
- Le sas prend le thème du jeu choisi : bandeau doré en Maxwin, orange/rouge en Resurgence.

## Bandeau des gains en direct (simulé)

En haut du lobby, un bandeau « LIVE WINS » façon casino fait défiler les paiements récents : pastille de couleur du brawler, pseudo, **mode complet — MAXWIN SOLO / DUO / TRIO ou RESURGENCE SOLO / DUO**, table, nombre de kills, et le montant en or. Le bandeau **défile en continu** vers la gauche avec un fondu au bord droit, une nouvelle entrée apparaissant toutes les 1,4 à 3,6 secondes ; les cartes Resurgence sont rouges, les Maxwin bleues. Il s'amorce dès le chargement du script et tient sa propre horloge, indépendamment de l'ordre de rendu du lobby, et se réalimente automatiquement dès que la bande n'est plus pleine.

Les pseudos sont inventés, **mais aucun montant ne l'est** : chaque gain est recalculé par les fonctions de paiement du jeu lui-même. Un gain Maxwin est exactement `teamPayout().split` pour ce mode et cette table ; un gain Resurgence est `cashoutPayout()` sur un bucket égal à sa propre mise plus celles de ses victimes. Six tests le vérifient sur des centaines d'événements, dont un qui garantit que la fréquence des tables reste décroissante, de $0,50 vers $10.

La fréquence des tables suit la même répartition que les files d'attente — on voit beaucoup de gains à $0,50 et rarement à $10.

## Compteur de joueurs (simulé)

Le lobby affiche une population en ligne, une répartition par jeu et une file d'attente par table. **Rien de tout ça n'est réel** : il n'y a pas encore de matchmaking, tous les adversaires sont des bots. Le compteur est piloté par `onlineTotal()` pour bouger de façon crédible plutôt qu'au hasard :

- courbe jour/nuit en cosinus, pic à 21 h locale, creux vers 9 h (base 14 200 ± 55 %, soit ≈ 6 400 contre ≈ 22 000) ;
- bonus week-end de 18 % ;
- dérive déterministe à la minute : la même minute donne toujours le même nombre, donc l'affichage ne clignote pas entre deux rafraîchissements ;
- plancher à 120 joueurs — la nuit est calme, jamais morte.

Les files par table dérivent du total via des parts fixes (Maxwin 56 % / Resurgence 44 %, puis par mode, puis par mise : la table $0,50 concentre 52 % du monde, la $10 seulement 5 %). L'écran « READY » annonce le nombre d'adversaires trouvés et la profondeur de file correspondante.

Le badge porte un `title` explicite (« Simulated population — every opponent in this build is a bot »). **Quand un vrai backend arrivera, ces fonctions doivent être remplacées par les compteurs du serveur, pas gardées en production** : afficher une population inventée à des joueurs qui misent de l'argent réel serait trompeur, et selon les juridictions, illégal.

## Jeux

Le lobby propose deux jeux distincts, chacun avec son thème visuel.

### MAXWIN (bleu) — le mode d'origine
Survivre jusqu'au bout. Le pot va au dernier debout, en Solo, Duo ou Trio (voir ci-dessous).

### RESURGENCE (rouge) — le mode rapide

Deux variantes, **50 joueurs sur la map dans les deux cas** :
- **SOLO** — 50 joueurs, chacun pour soi.
- **DUO** — 25 équipes de 2. **Respawn tant que ton partenaire est en vie** (le nom du mode, littéralement), pas de tir allié, mais **chacun encaisse son propre bucket** : si ton partenaire banque et part, tu continues seul et tu ne respawnes plus.

Règles communes aux deux :
- **50 joueurs**, gaz qui se referme presque deux fois plus vite (match ≈ 1 min 20) et 150 caisses au lieu de 90.
- **Transfert instantané** : tuer quelqu'un verse *immédiatement* tout son bucket dans le tien — sa mise plus tout ce qu'il avait lui-même récupéré. Rien ne tombe par terre, personne ne peut te le voler entre-temps.
- **Cash out quand tu veux** : bouton vert au centre (touche `C` au clavier, tap sur mobile). Tu quittes la partie avec exactement le contenu de ton bucket, crédité au wallet.
- **Verrou de 10 s** : le bouton se bloque et passe au gris avec un compte à rebours dès que tu prends **un dégât** (tir, gaz, explosion) **ou** que tu viens de **tuer quelqu'un**. Impossible de frapper puis de fuir dans la seconde.
- Mourir = tout perdre, bucket compris. Les bots encaissent aussi quand ils sont assez riches, ce qui vide la table progressivement.
- Toute la table passe en rouge : lobby, HUD, écrans de pause et de fin.

L'économie est conservative : la somme des buckets encaissés et des buckets encore en jeu égale toujours le total des mises entrées (vérifié par simulation).

## Commission de la plateforme

**La maison prélève 20 % de tout paiement, dans les deux jeux** (`RAKE` dans le core) :

- **MAXWIN** — sur le pot avant partage. Table $5 en Trio : pot $150 → maison $30 → gagnants $120 → **$40 chacun**.
- **RESURGENCE** — sur le bucket à chaque cash out, quel qu'il soit. Bucket $2 (une mise à $0,50 plus trois kills) → maison $0,40 → **tu reçois $1,60**.

Les montants affichés en jeu sont toujours le **net** : le bouton de cash out annonce ce que tu touches réellement, jamais le brut. L'écran de fin détaille la ligne « House cut (20%) ». Toute la chaîne de paiement travaille **au centime** (`cents()`), pour que les mises sous le dollar ne soient pas arrondies au passage. Les tables sont calibrées pour que le partage après commission tombe juste en Duo et en Trio — aucun arrondi ne mange un centime (vérifié par test sur les 4 tables × 5 modes).

## Vies

Chaque joueur dispose de **3 vies** en Maxwin, **2 en Resurgence** (un mode sprint). Une mort n'élimine plus : elle coûte une vie, et on revient **5 secondes** plus tard, avec **3 secondes d'invulnérabilité** signalées par un clignotement.

Le problème que ça règle : avec une seule vie, la carte se vidait bien avant que le gaz n'ait fini de se refermer. Simulation sur une partie Solo à 20 joueurs — le gaz met 154 s à boucler ses quatre phases, or le dernier survivant était désigné vers **54 s**. Il ne restait qu'un joueur dans une arène immense pendant deux minutes. Avec 3 vies, la partie tient **~170 s** et il reste encore 5 joueurs quand le cercle final se referme.

Détails :
- **Tout tombe à chaque mort** — mise, gains accumulés et cubes de pouvoir. Une vie supplémentaire ne protège pas le magot : elle donne juste une nouvelle chance de le reprendre.
- **Le retour se fait loin des tirs** : parmi 40 positions tirées dans le cercle, le jeu retient celle qui maximise la distance à l'ennemi le plus proche.
- **Le fil distingue les deux cas** : « X a mis à terre Y · 2 vies restantes » ou « X a éliminé Y ».
- **Les cœurs sont affichés** dans la barre du haut, et au-dessus de la tête de tout brawler qui a déjà perdu une vie — on repère celui qui est à sa dernière.
- Le compteur du haut indique les joueurs **encore en lice**, pas ceux debout à l'instant T.

## Modes MAXWIN

- **SOLO** — 20 joueurs, chacun pour soi. Le dernier debout prend tout le pot.
- **DUO** — 10 équipes de 2 (toi + 1 coéquipier IA). **Respawn en 5 s tant que ton partenaire est en vie** (tu observes en attendant) ; ta mise et tes cubes tombent au sol à chaque mort, récupérables par n'importe qui. Les vainqueurs se partagent le pot à parts égales.
- **TRIO** — 10 équipes de 3, donc 30 mises dans le pot. Même règles ; ta part = pot ÷ 3.

Pas de tir allié (balles, supers, flaques, tourelles, dash — rien ne touche ton équipe). Les coéquipiers IA restent groupés avec toi et défendent. Barres de vie alliées en cyan, ennemies en rouge. Le compteur en haut affiche les **équipes restantes** en Duo/Trio.

## Règles Showdown

- **Caisses** (90 par map, 90 PV) : casser → **65 % un cube de pouvoir ⬢**, **35 % un cœur ♥**. Le cube donne +10 % PV max et +10 % dégâts (max 10) ; le cœur rend **40 % des PV max instantanément**, soit environ 5 secondes de régénération économisées. Un cœur laissé au sol si on est déjà au maximum.
- **Régénération** : hors combat depuis 3 s, 7,5 % des PV max par seconde — un BOLT tombé à 30 PV revient au plein en 12,7 s. Les gains s'affichent en vert au-dessus de la tête, par paliers, pour qu'on voie que ça monte.
- **Buissons** : invisible dedans sauf à moins de 2,5 blocs (ou ligne de vue directe). Les murs bloquent les tirs et les déplacements.
- **Kill** : la victime lâche un **sac d'or** (toute sa mise + ce qu'elle avait ramassé) et **tous ses cubes**. Ramassage automatique en marchant dessus — n'importe qui peut voler.
- **Gaz** : 4 phases (25 s d'attente → 34 s de fermeture, puis 18+26, 12+18, 8+13 — 154 s en tout), dégâts en % des PV max (4 → 16 %/s). Match < 2 min 30 après la protection de 8 s.
- **Tables** : $0,50 STREET · $1 PRO · $5 ELITE · $10 SHARK. Le matchmaking ne mélange jamais les mises. La qualité de visée des bots monte avec la table (erreur angulaire max 13,2° à STREET → 4,3° à SHARK, soit un cône de 26,5° puis 8,7°), avec 0,55 s de réaction et une cadence 1,35× plus lente que la tienne.

## Réglages

Tout est dans `WBCore` en tête de fichier (bloc testé) : `TIERS`, `BRAWLERS`, `CUBE`, `BOX_HP`, `HEAL`, `BOT`, `GRACE`, `RAKE`, `START_WALLET`, `MAP`, `BOXES`. Les phases de gaz sont `ZONE_PHASES` juste en dessous.

## Architecture

```
index.html
├─ WBCore   règles pures : économie, brawlers, cubes, génération de map (bruit + anneau de spawn + croix centrale)
└─ Game     rendu (InstancedMesh sol/murs, buissons translucides), caméra qui suit + anticipe le curseur,
            projectiles réels (collision murs / entités / caisses, perforation, recul), IA bots
            (caisses → chasse → kite quand bas → fuite du gaz, évitement des murs), gaz, HUD projeté
            (barres de vie au-dessus des têtes, dégâts flottants), minimap, audio WebAudio
test.js     harnais Node
```

## Vers la version réelle

Identique au prototype précédent : serveur autoritaire (Colyseus / WebSocket), matchmaking par table, ledger transactionnel, puis paiements / KYC / licence de jeux d'argent — ou monnaie virtuelle non retirable. Le modèle de projectiles est déjà déterministe (positions, vitesses, rayons), ce qui se porte directement côté serveur.
