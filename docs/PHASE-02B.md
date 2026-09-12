# Phase 02b — le serveur rejoue la partie

État : **en cours**. Spécification écrite avant le premier module, comme pour la 02a, pour que
chacun sache ce qu'il construit et surtout ce qu'il n'a pas le droit de casser.

**La phase 02 n'est pas faite tant que celle-ci ne l'est pas, et aucun euro n'entre avant.** Même
finie, cette phase n'ouvre aucune table en argent réel : elle ferme le trou que la 02a avait écrit
noir sur blanc, elle n'en ferme pas d'autre.

---

## D'abord, ce que la 02a a avoué

`docs/PHASE-02.md` contient une section intitulée « Le montant est ENCADRÉ, jamais recalculé ». Elle
dit ceci, et c'est le seul point ouvert que cette phase existe pour fermer :

> Le net vaut `cashoutCents(sacoche)` dans les cinq modes. La sacoche est précisément le nombre que
> le serveur ne sait pas refaire.

Le serveur possède l'identité d'une partie — billet, graines, mode, mise, horloge — et rien de son
déroulement. Il applique une fonction juste à un nombre que le client a inventé. Toute la sécurité
de la 02a tient dans une borne, `[0, mise × sièges]`, et une borne n'est pas une vérification.

Pour que le serveur sache refaire la sacoche, il faut qu'il sache refaire la partie. C'est le seul
contenu de cette phase.

---

## Ce que la phase fait

**Le serveur rejoue la partie après coup**, depuis la graine publique de son billet et la trace des
seules entrées du joueur, et juge des faits qu'il a **recalculés** au lieu de faits déclarés.

1. **La simulation avance à pas fixe**, et l'arrêt sur image cesse d'être une règle du jeu.
2. **Tout le hasard de la simulation descend de la graine publique**, par des flux nommés par usage.
   La géométrie tirée de la seule graine — carte, biomes, plan de zone, points d'apparition — cesse
   d'appeler des fonctions transcendantes.
3. **Un bloc `/*SIM-START*/ … /*SIM-END*/`** apparaît dans `index.html`, troisième `<script>`
   interne, sans DOM, sans Three.js, sans horloge et sans `Math.random`. L'état, la grille, le
   combat, le butin et les bots y descendent, subsystème par subsystème, `npm test` vert entre
   chaque.
4. **`step()` rend un flux d'événements** horodatés en pas — tir, dégât, mort, ramassage, nuage —
   que le bloc `Game` traduit en sons, en nombres flottants et en lignes de kill feed. Aucune
   référence de rendu ne franchit les marqueurs.
5. **`node test.js` fait jouer des parties entières**, sans navigateur, du coup d'envoi à la
   dernière phase du gaz, et en tire une empreinte. C'est le trou le plus ancien du dossier —
   « aucun test ne regarde le jeu tourner » — et il se referme avant que le serveur n'ait besoin de
   quoi que ce soit.
6. **`api/sim.js` charge le bloc SIM depuis `index.html`**, exactement comme `api/core.js` charge
   `WBCore`, garde bruyante au démarrage comprise.
7. **Le jeu enregistre la trace de ses entrées** et l'envoie, en insertion seule, sur une route
   séparée de celle qui règle l'argent.
8. **`POST /api/match/:id/result` rejoue** et recalcule durée, kills, morts, rang, cubes et sacoche.
   `net_cents` sort de la partie rejouée ; `declared_net_cents` et `ecart_cents` gardent leur rôle
   d'observation. La route ne change pas de forme — c'était la promesse écrite en 02a : « on remplace
   le corps de `matchVerdict` par une vraie simulation sans changer une seule route ».

Aucun argent ne bouge toujours. Le portefeuille reste une variable du navigateur, il n'y a toujours
aucune colonne solde, et les chiffres écrits ne valent toujours rien. Ce qui change, c'est **qui les
produit**.

## Ce que la phase ne fait pas

- **Pas de netcode, pas d'autorité temps réel, pas d'appariement.** Le serveur rejoue après coup ;
  il ne fait pas tourner la partie. La population, le sas d'attente et le bandeau des gains restent
  simulés.
- **Pas de refonte du rendu.** Le HUD, la caméra, l'audio et les entrées restent dans `Game` et ne
  changent que là où ils lisent désormais un état ou un événement au lieu de le produire.
- **Aucune détection de visée automatique ni de macro.** Le vol de temps devient impossible, le vol
  de précision reste entier. C'est écrit dans `api/README.md`, ce n'est pas dilué.
- **Pas de déterminisme bit-à-bit entre moteurs.** Remplacer toute la trigonométrie du jeu par de la
  virgule fixe est un chantier à part, à chiffrer avant d'être promis. Cette phase ne le promet pas.
- **Pas de grand livre, pas de solde, pas de dépôt, pas de retrait.** Phases 03 à 06, dans cet ordre.
- **Pas de choix d'hébergeur, pas de base créée, pas de déploiement.** Tout se vérifie hors ligne ;
  `ACCOUNT.api` reste une ligne à remplir.
- **Pas de conversion de tout le jeu en centimes entiers.** `cents()` reste appelé partout dans le
  rendu et le HUD ; les deux unités continuent de coexister, avec le point de conversion unique pour
  seule protection.
- **Pas de lobby mobile** — refait trois fois, abandonné, ne pas rouvrir sans maquette validée.
- **Pas de harnais navigateur.** Le harnais de partie du module 5 couvre la simulation, pas l'écran.
  Deux bugs du journal n'ont été trouvés que par un navigateur et ce harnais-là ne les aurait pas
  attrapés.

---

## Les décisions, et pourquoi

### Un rejeu après coup, pas une autorité temps réel

Les dix-neuf adversaires sont des bots. Il n'y a **aucun conflit à arbitrer en direct**, donc rien à
faire tenir dans un budget de latence. Un serveur qui rejoue la partie depuis (graine publique, trace
des entrées du joueur) obtient exactement la même autorité sur les faits — durée, kills, morts,
cubes, sacoche — sans netcode, sans boucle serveur, sans hébergement, et sans toucher à la boucle
d'image du jeu.

Écarté : un serveur autoritaire à 20 ou 32 Hz avec prédiction et réconciliation. C'est la réécriture
du jeu, ça casse la promesse du fichier unique, ça exige un hébergement qui tourne pour être éprouvé,
et ça résout un problème que le jeu n'a pas encore — départager deux joueurs réels. Le journal écrit
déjà que « simuler est la réécriture du jeu » ; empiler le netcode par-dessus cette réécriture serait
refaire dans une seule phase ce que la scission 02a/02b existe pour éviter.

### Le pas de temps devient FIXE, et c'est le premier module

Un rejeu a besoin d'une horloge que le client n'écrit pas. Enregistrer le `dt` de chaque image ferait
du joueur l'auteur de son propre temps, et un flottant rejoué est la source de divergence la plus
sûre qui soit.

Mais la raison suffisante n'a rien à voir avec l'argent : `Math.min(1,dt*13)` sur la vitesse,
`Math.random()<dt*0.25` sur l'encaissement des bots, `b.aim-=dt` — **le jeu ne se comporte pas pareil
à 30 et à 144 images par seconde.** On répare un défaut d'équité entre appareils, et le rejeu devient
possible par surcroît. Si toute la suite glissait, ce module vaudrait encore d'avoir été fait.

Le pas est `SIM.stepS = 1/60`, écrit dans `WBCore`. `simSteps(reste, dt)` est une fonction pure qui
rend `{ pas, reste }`, bornée par `SIM.maxRattrapage` pour qu'un onglet réveillé après quarante
secondes ne gèle pas la page. Le rendu garde son `dt` variable.

### L'arrêt sur image sort des règles, et c'est gratuit

`loop()` fait `if(critHold>0){ critHold-=dt; dt*=0.12; }` : aujourd'hui, l'arrêt sur image du coup
critique **ralentit toute la simulation**, gaz compris. C'est le second endroit — avec la boucle
elle-même — où le `dt` d'image entre dans les règles, et l'invariant « aucune fonction de simulation
ne reçoit jamais un `dt` d'image » ne peut pas tenir sans lui.

Le pas fixe le résout sans rien coûter au ressenti : `critHold` devient un **facteur d'échelle sur ce
qu'on verse dans l'accumulateur**, pas sur la simulation. La simulation, elle, ne sait pas que ça
existe : même suite de pas, mêmes résultats, livrés plus tard sur l'horloge murale.

*Corrigé au module 1.* Cette section disait « au ralenti pendant 0,09 seconde **de temps de jeu**,
simplement il consomme plus de temps réel ». C'était une erreur, et elle contredisait la phrase qui
la précède : `critHold` se décompte aujourd'hui sur le temps réel, donc l'arrêt dure 0,09 seconde
d'horloge et ne fait avancer le monde que d'environ 0,011 seconde simulée. Le décompter sur le temps
de jeu ferait durer l'effet 0,75 seconde à l'écran — huit fois plus qu'aujourd'hui. Ce serait un
changement de ressenti, pas sa conservation, et cette phase a déjà trois changements de ressenti que
rien ne peut tester. `critHold` reste donc décompté sur le `dt` d'image, et seul ce qu'on verse dans
l'accumulateur est mis à l'échelle.

Un effet de bord, assumé et voulu : le `dt` ralenti s'appliquait aussi au rendu, si bien que la
caméra, les particules et la mesure de FPS se figeaient pendant l'arrêt. Le rendu garde désormais son
`dt` entier. L'arrêt sur image se voit donc sur le monde et non plus sur l'écran.

Conséquence à écrire une fois, parce qu'elle touche le verdict : **la durée d'une partie se compte
désormais en pas**, `pas × SIM.stepS`, et non plus sur l'horloge du navigateur. La durée simulée est
donc toujours inférieure ou égale à la durée réelle. Les tolérances d'horloge de `matchVerdict`
restent larges pour la même raison qu'en 02a, et le rejeu, lui, ne regarde que les pas.

### Tout le hasard de la simulation descend de la graine, par des flux NOMMÉS

`G.rng = makeRng(graine)` unique aurait suffi au rejeu, et c'est un piège connu : ajouter un tirage
quelque part décale toute la suite ailleurs, donc **toute la partie**. On tire chaque usage d'un flux
nommé — `bots/identite`, `bots/visee`, `bots/objectif`, `bots/encaissement`, `apparition`,
`butin/contenu`, `butin/position` — chacun semé par un mélange entier de la graine publique et d'un
sel constant propre au nom. Ajouter un tirage dans la visée des bots ne déplace alors plus les
caisses.

*Complété au module 2.* Un **huitième** flux existe, `tir/dispersion` : `fireSpec` ajoute
`(Math.random()-0.5)*0.02` à l'angle de chaque projectile, joueur compris. Ce grain de sable décide
de ce qui touche, donc c'est un fait de partie et non du cosmétique ; il n'apparaissait pas dans la
liste ci-dessus parce que la liste avait été écrite en relisant les bots, pas les armes. La liste des
noms est **fermée** : demander un flux absent lance, pour qu'une faute de frappe ne crée pas une
suite neuve en silence.

*Ajouté au module 2, et à connaître avant d'écrire le rejeu :* `WBCore.melangeSeme` remplace les
`sort(() => rng() - 0.5)` du chemin de simulation. Le **nombre de comparaisons** qu'un moteur
effectue pour trier n'est spécifié nulle part, donc le nombre de tirages consommés non plus : deux
moteurs ne consomment pas la même longueur du flux, et tout ce qui tire ensuite dans ce flux se
décale. Fisher-Yates consomme exactement `n - 1` sorties, quoi qu'il arrive.

*Et le défaut qui était déjà là, trouvé en écrivant ce module :* `G.rng` servait à la fois au décor
et aux règles. `buildWorld` le consommait d'abord pour le feuillage des buissons — dont le nombre
vient du **palier de qualité**, donc de la machine — puis la simulation y puisait la position des
caisses, les points de départ, le brawler et la précision de chaque bot. Sur la **même graine**, deux
appareils ne jouaient donc pas la même partie. Le générateur du décor ne quitte plus `buildWorld`.
Consigné dans `docs/HISTORIQUE.md`.

Ce qui reste à `Math.random` : le **cosmétique**, et lui seul — le décalage horizontal d'un nombre
flottant, le nom d'un bot au lobby, une particule. Un test nomme la liste des fonctions du chemin de
simulation où `Math.random(` est interdit, et une seconde liste nomme celles où il est **attendu**,
pour que personne ne « corrige » plus tard une frontière qui est un choix.

Les sels diffèrent de `ZONE_SALT`, sans quoi le gaz et les bots partageraient une suite.

### Ce qu'on fait de la graine secrète, écrit une fois pour toutes

Dans une architecture de rejeu, **le client doit posséder tout ce qu'il dessine**. Il dessine les
caisses, donc il connaît leur contenu dès la première seconde. La connaissance de tout le butin de la
carte devient **structurelle**, pas incidente : un ESP est gratuit et le restera tant que le client
simulera sa propre partie. Ce n'est pas un oubli de cette phase, c'est son prix, et il s'écrit à côté
de la limite d'aimbot dans `api/README.md`.

Conséquence : `seed_secret` ne protège rien dans cette phase et **la simulation ne l'utilise pas**.
Elle reste une colonne, parce qu'elle servira le jour où le serveur décidera de quelque chose que le
client n'a pas à savoir, et parce qu'aucune base n'a jamais tourné — donc l'élargir coûte encore zéro
migration. Elle passe de 32 bits à 128, écrits en hexadécimal : `between 0 and 4294967295` rend une
graine « secrète » **trouvable par force brute hors ligne**, et une colonne qui porte un nom qui ment
est pire que pas de colonne.

`seed_public`, elle, reste 32 bits : `seedFor`, `checkReport` et tout le contrat client de la 02a en
dépendent, et son entropie est publique par construction. Les flux nommés en dérivent un état plus
large ; ils ne créent pas d'entropie qui n'existe pas, et le document ne prétend pas le contraire.

### `makeRng` est un LCG 32 bits, et on le dit

`makeRng` fait `s=(s*1664525+1013904223)>>>0; return s/4294967296` : **une seule sortie rend l'état
exact et tout l'avenir du flux.** Ce n'est pas un défaut dans un rejeu — tout est public de toute
façon — mais ça interdit d'appuyer quoi que ce soit sur sa non-prédictibilité, aujourd'hui ou plus
tard. Écrit ici pour que personne ne le redécouvre en phase 04.

### La géométrie tirée de la seule graine perd ses transcendantes — et elle seule

`generateMap` appelle `Math.hypot` et `Math.cos`/`Math.sin`, `zonePlan` et `zoneAt` aussi,
`spawnPoints` également. ECMAScript laisse ces fonctions « implementation-approximated » : deux
moteurs peuvent différer du dernier bit. Or la carte et le plan de zone sont le **préfixe commun de
toute la partie** — s'ils divergent, tout ce qui suit diverge, et l'invariant « même graine, même
plan de zone » ne prouve aujourd'hui que l'égalité entre deux processus Node.

Ces quatre fonctions ne prennent leurs angles **que de la graine**, jamais d'une souris ni d'un
stick. On peut donc les quantifier sans qu'aucun joueur ne le sente : une table `C.UNIT` de vecteurs
unitaires en littéraux de source, échantillonnée à pas fixe et documentée comme telle, et `dist()`
sur `Math.sqrt`, qui lui est exactement spécifié par IEEE 754. Aucune base n'ayant jamais tourné,
changer la carte et les centres de gaz de toutes les graines coûte **zéro migration** : c'est le
dernier moment.

*Fait au module 2, avec le détail qui compte.* `C.UNIT` tient 1024 directions, pas de 2π/1024 ≈
0,00614 radian. Le pas se choisit sur le plus grand cercle que la carte parcourt — la route
circulaire de `generateMap` à MAP×0,34 ≈ 51,7 cases — où il vaut 0,32 case : le cercle reste continu
sur une grille de maille 1, et le code d'origine balayait par pas de 0,006 radian, donc rien de
visible ne change. Ce qui est écrit en littéraux est le **premier quadrant des cosinus**, 257
valeurs ; les trois autres quadrants s'en déduisent par échange d'axes et changement de signe, deux
opérations exactes en IEEE 754. Les quatre cardinales sont exactes, là où `Math.cos(Math.PI/2)` rend
6,12e-17. Les décalages d'angle de `spawnPoints` se comptent désormais en **indices** et non plus en
radians, pour que l'arithmétique reste entière de bout en bout.

**L'interdiction s'arrête là**, et c'est délibéré. La visée vient d'une souris, le spread vaut 0,32
ou 0,55 selon les armes, les lobs et le dash ont leurs arcs, `findTarget` et `botUpdate` raisonnent en
angles : quantifier tout ça serait une refonte de la façon dont le jeu exprime une direction, une
réécriture des mathématiques du jeu sous couvert de module de déterminisme. Pour le reste de la
simulation, la doctrine est celle de la divergence mesurée, ci-dessous.

### Un bloc SIM distinct, avec son propre chargeur

C'est déjà la décision écrite en fin de `docs/PHASE-02.md`, et elle reste juste : la valeur de
`WBCore` est d'être petit et entièrement testé. La simulation fait plusieurs fois sa taille ; l'y
noyer diluerait la seule partie du dépôt dont on peut dire qu'elle est couverte. Sortir la simulation
dans un fichier `.js` séparé casserait le fichier unique, qui est la promesse du projet. Donc un
**troisième `<script>` interne**, entre `/*SIM-START*/` et `/*SIM-END*/`, et `api/sim.js` calqué ligne
pour ligne sur `api/core.js`, garde bruyante comprise, pour que « l'API ne recopie jamais une règle du
jeu » vaille aussi pour la simulation.

### « Le code bouge, il ne se réécrit pas » est FAUX, et le chiffrage en dépend

Il faut le dire avant de commencer, parce que c'est le seul endroit où cette phase peut se mentir à
elle-même sur son coût.

Le bloc `Game` est une IIFE : `(function(){ 'use strict'; const C=WBCore, N=C.MAP, B=C.BRAWLERS;` …
`let G=null`. Un troisième `<script>` est une **frontière de portée dure**. Chaque fonction déplacée
perd sa fermeture sur `C`, `N`, `B`, `G`, `R`, `free`, `isWall`, `cellAt` ; et chaque site d'appel
resté dans `Game` doit être préfixé. Ce ne sont pas des déplacements, ce sont des **centaines de
petits remplacements de texte**, dans le bloc exact auquel `docs/HISTORIQUE.md` impute ses cinq bugs
marquants, tous causés par une édition par remplacement de texte.

La forme retenue, qui limite le nombre de ces remplacements :

- le bloc SIM est une IIFE qui publie `window.WBSim`, et qui reçoit `WBCore` de la même façon que
  `Game` : `const C = WBCore` en tête de bloc. Les noms de `WBCore` ne changent donc pas de forme
  dans le code déplacé ;
- l'état d'une partie n'est plus un `G` de portée lexicale mais un **paramètre explicite** passé aux
  fonctions déplacées, ou porté par l'objet que `newMatch` rend. C'est le remplacement le plus
  nombreux et il n'y a pas de raccourci ;
- côté `Game`, les noms déplacés sont récupérés en une seule ligne de déstructuration en tête de
  bloc (`const { isWall, free, tryMove, moveEntity, canSee, … } = WBSim;`), pour que les sites
  d'appel restants n'aient **pas** à être préfixés un par un. C'est la seule économie réelle, et elle
  vaut d'être écrite ici plutôt que redécouverte au troisième module.

*Mesuré au module 3, pour que le chiffrage des modules 4 et 5 ne reparte pas de l'intuition.* Le
premier découpage a coûté **une cinquantaine** de sites d'appel à reprendre, pas des centaines : la
ligne de déstructuration tient sa promesse, et ce qui reste — ajouter `G` en premier argument — est
mécanique mais individuel. Deux choses ont coûté plus cher que le déplacement lui-même, et elles
reviendront : trouver les **écritures de rendu cachées au milieu d'une ligne de simulation**
(`e.mesh.visible=false` au milieu de `kill`, `e.lastOp=-1` au milieu de `respawn` et de `useSuper`),
et décider ce qui, dans une fonction, est un **fait** et ce qui n'en est qu'une lecture — `e.flash`
se décompte dans la simulation, sa couleur se déduit au rendu.

Conséquence sur le découpage : les modules qui vident `Game` sont trois, pas un. `npm test` est vert
entre chaque, et le corpus gelé du module 3 puis le harnais de partie du module 5 servent de filet
pendant que les suivants se font.

### Le rendu devient lecteur d'un flux d'événements ; aucun `mesh` ne survit dans SIM

`moveEntity` écrit `e.mesh.position`. `damage` appelle `floatText` et `snd`. `hurtBox` appelle
`world.remove`. Tant qu'une seule de ces attaches subsiste, le bloc ne tourne pas dans Node et la
phase est perdue **en silence**, sans que rien ne casse.

`step()` rend donc une liste d'événements horodatés en pas — `tir`, `degat`, `mort`, `ramassage`,
`nuage` — que `Game` traduit en sons, en nombres flottants et en lignes de kill feed. Les meshes
vivent dans une table annexe de `Game`, indexée par identifiant d'entité, et un **unique**
`syncMeshes()` recopie l'état vers la scène.

Écarté : laisser SIM porter un pointeur de mesh « le temps de la transition ». C'est exactement le
patron du `respawn()` défini deux fois — la copie vivante finit du côté que rien n'exécute. La garde
est textuelle et permanente, comme celle qui interdit un second lecteur du plan de zone : entre les
marqueurs, ni `mesh`, ni `THREE`, ni `document`, ni `$(`, ni `snd(`, ni `floatText(`, ni `feed(`.

*Fait au module 4, et c'est le contrat à ne pas laisser s'effriter.* `step()` ne sonne plus et
n'écrit plus à l'écran : il remplit une liste d'événements horodatés **en pas**, que le bloc `Game`
traduit. Les douze noms sont **fermés** — `tir`, `degat`, `mort`, `ramassage`, `nuage`, `explosion`,
`super`, `gadget`, `detruit`, `encaissement`, `reapparition`, `fin` — et un test vérifie à la fois
qu'aucun type inconnu n'est produit et que le lecteur les traduit tous : un événement émis que
personne ne lit serait un son qui disparaît sans que rien ne casse. La garde textuelle du bloc
s'étend à `endMatch(`, `botSay(`, `sendEmote(`, `deathSting(` et `critFx(` en plus des trois noms
d'origine, parce que ce sont ceux-là que `kill` appelait. Deux conséquences à connaître : les
vannes des bots se tirent désormais **du côté qui les prononce**, dans le lecteur d'événements, et
`G.encaisse` est né — l'argent d'un bot qui encaisse quitte la partie, et sans un compteur pour le
recevoir la conservation serait fausse dès le premier encaissement.

Les corps des projectiles, des caisses, du butin, des zones, des tourelles, des grenades et des
nuages ont rejoint le patron de la table annexe, dans `VIS`, balayée une fois par image par un
unique `syncMonde()`. La table est indexée par **l'objet de simulation lui-même** : ces objets-là
n'ont pas d'identifiant, ils vivent quelques secondes, et une clé inventée pour l'occasion aurait
été une occasion de plus de se tromper de correspondance. Enfin `e.lbl` — le nœud DOM de
l'étiquette au-dessus des têtes, dernier pointeur de rendu posé sur un fait de partie, signalé
comme dette au module 3 — vit dans une troisième table, `LABELS`, dont `hudFast` est l'unique
lecteur.

*Fait au module 3, pour les entités, avec la précision qui manquait.* La table annexe est indexée
par `eid`, un **compteur d'insertion neuf**, et non par `id`. C'est important et ce n'était écrit
nulle part : `id` n'est pas un identifiant, c'est la **personnalité** d'un bot — un nombre tiré du
flux `bots/identite`, dont `botUpdate` sort la nervosité et la distance préférée. Deux bots peuvent
la partager ; un rendu indexé dessus aurait mélangé leurs corps, sans rien casser. `syncMeshes()`
tourne **une fois par image**, pas une fois par pas : un pas que personne ne verra n'a aucune raison
de toucher à la scène. Les corps des projectiles, des caisses, du butin et du gaz, eux, restent
écrits là où ils le sont — ils descendront avec leurs subsystèmes, aux modules 4 et 5.

### La collision de projectile devient BALAYÉE

Le test actuel est ponctuel : `Math.hypot(e.x-p.x,e.z-p.z)<0.62` par pas, et `isWall(p.x,p.z)` pour
les murs. Les projectiles rapides tunnellent déjà — le super de HEX avance de plus d'un bloc par pas à
30 Hz contre un corps de rayon 0,62 — et **le pas fixe rend ce bug déterministe, il ne le supprime
pas.** `WBCore.segmentHitsDisc` existe, est déjà testée et sert déjà à la fumée : le tir se teste sur
le **segment** parcouru dans le pas, corps comme murs.

C'est une correction, pas un supplément, et elle change le jeu : des tirs qui traversaient vont
toucher. Elle arrive dans le module du combat, nommée, pour qu'on sache à quoi imputer un changement
de ressenti.

*Fait au module 4, avec la mesure qui manquait et qui nuance la phrase ci-dessus.* Le pas est
désormais fixe à 1/60 : le projectile le plus rapide du jeu, le super de HEX à 36 blocs par seconde,
avance de **0,6 bloc par pas**, pas de 1,2. Une balle ne peut donc plus traverser de part en part un
corps de 0,62 de rayon aux vitesses embarquées aujourd'hui — le module 1 a déjà fermé ce cas-là. Ce
que le balayage corrige réellement, et qui reste entier sans lui : (1) le **frôlement** — un brawler
posté à 0,58 bloc du trajet est à plus de 0,62 des deux instantanés qui l'encadrent, donc le test
ponctuel le manquait alors que le segment passe à travers lui ; (2) le **mur pris en écharpe**, que
deux échantillons distants de 0,6 pouvaient enjamber par un coin ; (3) le **dernier pas**, qui
mourait de portée avant de tester quoi que ce soit et ne blessait donc jamais personne. S'y ajoute
la seule chose qui compte pour la suite : la collision ne dépend plus du pas, donc plus de
`SIM.stepS`. Les tests l'éprouvent jusqu'à 300 blocs par seconde, bien au-delà de tout ce que le jeu
embarque, et ils reconstruisent l'ancien test ponctuel pour vérifier qu'il manquait bien le cas
choisi — sans quoi un test qui touche ne prouverait rien.

### Ce que la première partie entière a appris — module 5

**Le harnais a trouvé un vrai bug avant même d'avoir servi à autre chose.** `respawn` tire quarante
points au hasard dans le cercle, ne retient que ceux où un corps tient, et retombe sur le **centre du
cercle** quand les quarante échouent — sans jamais vérifier qu'un corps y tient. Or les quarante
échouent quand le cercle final s'est refermé sur une poche de murs, c'est-à-dire à la toute fin d'une
partie que personne n'avait jamais simulée. Le brawler réapparaissait alors **dans un mur** :
`tryMove` refuse les deux axes, il ne bouge plus, et il ne peut même pas être tué puisque les balles
meurent sur le mur qu'il chevauche. C'est mot pour mot le bug de `spawnPoints` réparé au module 3, au
même endroit du même problème. Le repli balaie désormais en anneaux jusqu'à trouver du sol libre, et
il ne consomme **aucun tirage** : rien ne se décale dans le flux `apparition`.

**La position des caisses change sur toutes les graines, et c'est la purge du module 2 qui se
termine.** `startMatch` plaçait ses caisses avec `Math.hypot`, que ECMAScript laisse
« implementation-approximated ». Cette géométrie-là ne prend pourtant ses valeurs **que de la
graine** : elle appartenait à la liste du module 2, qui l'avait manquée parce qu'elle vivait dans
`startMatch` et non dans une des cinq fonctions nommées. En descendant dans `newMatch`, elle passe à
`C.dist`. Aucune base n'a jamais tourné, donc ça coûte encore zéro migration ; et la garde textuelle
des transcendantes couvre désormais `newMatch`.

**Deux noms d'événements de plus, et ils portent le compte à quatorze** : `zone` — le gaz avance, il
se pose, il prévient trois secondes avant — et `soin`, le cumul de régénération du joueur, qui posait
un nombre à l'écran depuis le milieu d'une règle. Les dégâts du gaz, eux, réutilisent `degat` avec
`sur:'gaz'` : le rendu leur garde une branche à part, parce qu'une brûlure continue ne fait pas
clignoter l'écran en rouge comme un coup encaissé.

**L'entrée du joueur est un objet, et c'est la forme que la trace du module 6 aura.** La souris, les
deux sticks et les touches deviennent `{mx, mz, ax, az, aimDist, feu}`, lus par `lireEntrees()` dans
le bloc `Game` et appliqués par `joueurUpdate` dans SIM. `HOLD_REPEAT` descend dans `WBCore` : le
temps de maintien de la détente décide du nombre de projectiles qu'une entrée produit, donc c'est une
règle. Ce qui **ne passe pas encore** par cet objet est nommé plus bas, dans les risques.

**Ce que le harnais ne couvre pas : l'écran.** Il prouve que la partie se JOUE, pas qu'elle se VOIT.
Deux des bugs marquants de `docs/HISTORIQUE.md` n'ont été trouvés que par un navigateur, et ce
harnais ne les aurait pas attrapés.

### `CRIT_TEST` meurt

`const CRIT_TEST = false` existe ligne 3957, consommé dans le chemin critique, avec un commentaire
« à retirer ». **Dégonflons-le tout de suite : c'est du code mort, pas une triche vivante.** Mais
descendre le critique dans SIM en le laissant y installerait une seconde règle de critique à côté de
`critShot`, dans le module même qui le rend possible — le patron du `respawn()` défini deux fois. Il
est supprimé, et une garde textuelle interdit sa réapparition.

### Le serveur RECALCULE la sacoche ; le nombre déclaré ne sert plus qu'à mesurer l'écart

C'est le seul aveu de la 02a qu'elle ne pouvait pas lever. Après le rejeu, `net_cents` vient de la
partie rejouée. `declared_net_cents` et `ecart_cents` gardent exactement leur rôle : une observation,
jamais une punition, jamais un paiement. Jeter la mesure perdrait les données sur lesquelles la phase
06 fixera un seuil.

`matchVerdict` **ne disparaît pas**. Elle reçoit désormais des faits recalculés au lieu de faits
déclarés, et c'est précisément pour cela qu'elle doit rester : si le rejeu se trompe, plus rien ne
regarderait le montant avant de l'écrire. L'enveloppe cesse d'être la seule protection et devient la
seconde. En plus, au moment du règlement et sur la partie réellement rejouée, la **conservation de
l'argent est assertée** — somme des sacoches + butin + encaissé = mise × sièges — parce qu'elle ne
coûte rien là et que c'est elle qui fonde le seul plafond de paiement qui existe.

### Une ligne ne se clôt QUE sur un état terminal

C'est le vrai trou d'un rejeu différé, et il s'ouvre le jour où un euro entre : **tronquer une trace
ne doit jamais rien payer.** Sans cette règle, couper le réseau après un gros kill devient la
meilleure stratégie du jeu.

Le rejeu doit atteindre un **état terminal** — un vainqueur, un encaissement du joueur, la mort
définitive du joueur, ou la fin du plan de zone — pour que la route écrive un montant. Sinon elle
n'écrit **aucun** montant, nomme ce qui lui manque, et laisse le billet se faire clore par le veilleur
de la 02a, sans montant. Cette règle se teste entièrement hors ligne : pour chaque trace terminale et
chacun de ses préfixes, `net(préfixe) ≤ net(complète)`, et `net = 0` sans état terminal.

### La trace ne porte que le joueur ; les bots sont rejoués

Leur personnalité, leurs tirages de visée, leurs objectifs et leurs réapparitions sortent tous de la
graine après le module 2. Le serveur les refait donc à l'identique. Enregistrer les positions des bots
ferait du client l'auteur de ses propres adversaires, ce qui est la triche la plus simple qu'on puisse
offrir — et multiplierait la taille de la trace par vingt.

### La trace s'envoie sur sa propre route, en insertion seule

La route qui décide d'un règlement garde `MAX_BODY = 4 Ko`. Relever cette borne sur elle ferait de la
route de l'argent la surface d'attaque la plus large de l'API, et « la raison est écrite » n'est pas
une protection.

`POST /api/match/:id/trace` reçoit la trace en segments, chacun sous sa propre borne
`MAX_TRACE_BODY`, nommée et justifiée sur cette route et sur elle seule. La table `match_traces` est
en **insertion seule**, clé `(match_id, seq)` unique, `on conflict do nothing`, premier écrit gagne,
aucun `update`, aucun `delete` : c'est la doctrine d'idempotence déjà arbitrée par la base en 02a.
L'envoi se fait à la fin de la partie, jamais pendant : enregistrer une trace ne coûte jamais une
image.

Le compromis est écrit : la trace d'une partie complète tient en un à trois segments, pas vingt. On ne
paie pas une sémantique d'ordre et de reprise pour une robustesse que la 02a possède déjà — un
résultat en retard est accepté jusqu'à l'expiration.

Ce qu'on hérite en échange, et qui est une vraie dette : `match_traces` grandit sans aucune politique
de conservation. Elle est nommée ici et renvoyée à la phase 03, qui décidera de ce qu'un grand livre
a besoin de garder.

### `sim_version` est figée à l'ouverture du billet

Un correctif de simulation déployé pendant qu'un joueur joue rejoue **une autre partie que la
sienne**, et paie autre chose que ce qu'il a vu. La 02a fige déjà `seats` et `team_size` pour cette
raison exacte. `SIM_VERSION` est une constante du bloc SIM, écrite sur le billet à son ouverture, et
le rejeu **refuse de juger** une trace produite sous une autre version : la ligne se clôt sans montant,
avec un motif nommé.

Corollaire d'exploitation, qui n'est pas de l'architecture : **un déploiement se draine**, il
n'écrase pas les billets ouverts — au plus une quinzaine de minutes. À ranger à côté de « la maison
est la contrepartie de chaque pot », dans les décisions à prendre hors des sept phases.

### Une divergence est MESURÉE, jamais punie, et exclut la ligne du grand livre

`Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp près par ECMAScript ; c'est déjà
consigné dans `docs/HISTORIQUE.md`. Une divergence entre le rejeu du serveur et l'empreinte du client
peut donc ne prouver qu'une chose : les deux n'ont pas la même bibliothèque mathématique. Refuser ce
joueur serait le **quatrième contrôle « évident » et faux** de ce dossier.

La ligne est donc réglée, marquée `digest_match = false`, et la garantie écrite noir sur blanc est
celle dont la phase 03 a besoin : **le grand livre ne lira jamais que des lignes dont le rejeu a
convergé.**

Reste le défaut de ce choix, qu'il faut traiter et pas seulement avouer : une liste d'exclusion qui
grandit en silence laisse la phase 03 hériter d'un filtre dont personne ne connaît le rendement. Donc
la divergence se **mesure** : `divergence_step` enregistre le premier pas où les empreintes
s'écartent, `replay_ms` le coût du rejeu, et les statistiques exposent le **taux de divergence**, au
même titre que les autres agrégats. Un chiffre, pas un pressentiment.

### Le rejeu a un budget, et le dépôt a un plancher de performance

Un rejeu tourne dans le fil de la requête. Une trace adversariale peut chercher à maximiser son coût.
`REPLAY_BUDGET_MS` borne le temps de calcul, l'abandon est un code nommé, et il s'éprouve avec une
**horloge injectée**, donc sans attendre.

En regard, un **plancher de performance** dans `npm test` : N pas en moins de X millisecondes. Sans
lui, une régression d'un ordre de grandeur se découvre chez le premier joueur au lieu de tomber en
intégration continue.

### Une trace refusée sort en 400, jamais en 500, et ne laisse jamais la ligne `open`

C'est la leçon du `22003` : un entier valide qui ne tenait pas dans sa colonne répondait 500 et
laissait le joueur **enfermé dans un billet mort** jusqu'à l'expiration, puisqu'il n'en a qu'un à la
fois. Trace trop longue, malformée, absente, non terminale, produite sous une autre `sim_version`,
rejeu trop long : chacun est un code nommé, un 400 ou un 409, et un chemin de sortie propre.

### Un test par vol, nommé d'après le vol qu'il arrête

Discipline de nommage, et elle a un exemple canonique qui dit mieux que toute formulation abstraite
ce que la phase vaut : **prendre un billet, ne jamais jouer, attendre cinq secondes, rendre
`{rank:1, seconds:10, purseCents: mise × sièges}`**. C'est exact contre les constantes actuelles —
`RESPAWN=5` donne un plancher de dix secondes, `LOBBY.wait=25` et la marge de victoire rendent cinq
secondes d'horloge suffisantes, et 1000 centimes de sacoche valent 800 payés sur une table à 0,50 $.
Aujourd'hui ce corps passe. Après le dernier module, il vaut zéro.

---

## Les invariants, et comment chacun se teste

| Invariant | Comment il se teste |
|---|---|
| `index.html` reste un seul fichier statique, sans build, sans bundler, sans React | rien à installer pour ouvrir le fichier ; le bloc SIM est un troisième `<script>` **interne**, et `npm test` extrait les **trois** blocs et les fait parser par `vm.Script` |
| Le jeu reste jouable sans compte et sans serveur, graine comprise | les quatre cas nommés de la 02a — `ACCOUNT.api` vide, pas de session, serveur muet, réponse illisible — restent testés **comme des cas normaux** ; sans billet, aucune trace n'est envoyée et le comportement est celui d'aujourd'hui |
| Le bloc SIM ne dépend d'aucun environnement | bac à sable permanent : le bloc s'exécute avec `document`, `window`, `THREE`, `Math.random`, `Date.now` et `performance` **indéfinis** — la même garde que `WBCore` — plus une garde textuelle sur le contenu du bloc (`mesh`, `THREE`, `document`, `$(`, `snd(`, `floatText(`, `feed(`) |
| La simulation avance à pas fixe ; aucune fonction de simulation ne reçoit jamais un `dt` d'image | `simSteps` conserve le temps sur dix mille images de `dt` bruité, sans dérive ; le nombre de pas d'une image est borné par `SIM.maxRattrapage` ; `dt` nul, négatif, NaN ou infini ne rend jamais un nombre de pas négatif ni NaN ; garde textuelle sur `loop()` et sur `critHold` |
| Tout le hasard de la simulation descend de la graine, et de rien d'autre | garde textuelle : aucun `Math.random(` dans la liste **nommée** des fonctions du chemin de simulation ; seconde liste nommée de ce qui garde `Math.random`, pour que la frontière ne se déplace pas par inadvertance ; les sels des flux diffèrent entre eux et de `ZONE_SALT` |
| Ajouter un tirage à un endroit ne déplace rien ailleurs | un flux par usage : tirer N fois de plus dans `bots/visee` ne change pas la suite rendue par `butin/contenu` |
| La géométrie tirée de la seule graine n'appelle aucune transcendante | garde textuelle sur `generateMap`, `generateBiomes`, `zonePlan`, `zoneAt`, `spawnPoints` : aucun `Math.cos`, `Math.sin`, `Math.hypot`, `Math.pow`, `Math.atan2`, `Math.exp` ; bac à sable où ces fonctions **lancent** |
| Même graine et même trace donnent le même état final et la même empreinte | deux fois dans le processus et une fois dans un processus fils — le patron déjà employé pour `zonePlan` ; et changer **un seul** pas de la trace change l'empreinte, sans quoi elle ne prouve rien |
| L'ordre de résolution est figé | `G.ents` garde un ordre d'insertion stable ; aucune itération de `Set`, de `Map` ou de clés d'objet ne décide d'un ordre de résolution ; aucun tri instable ; garde textuelle sur les sites concernés. *Livré au module 4 : dans le bloc SIM, zéro `.sort(`, zéro `for..in`, zéro `Object.keys/values/entries`, et `p.hit` comme `e.dashHit` ne connaissent que `has` et `add`. Les touches d'un même pas se résolvent par une clé **totale** — distance le long du segment, puis rang d'insertion — extraite par minimum successif plutôt que par un tri* |
| Le code a bougé sans changer | corpus **gelé avant le déplacement** : les requêtes de grille et `moveEntity` rendent exactement les mêmes positions qu'avant, sur une trace capturée et figée dans `corpus-grille.json`, lue par `test.js`. *Livré au module 3 : huit graines, cent pas de `moveEntity` sur douze entités synthétiques, le glissement le long des murs, la ligne de vue de près comme de loin, et `spawnPoints` sur les cinq modes — comparés **exactement**, sans tolérance. Un second test vérifie que le corpus contient les deux réponses de chaque règle, sans quoi il passerait sur n'importe quel code* |
| Une seule copie de chaque règle | `critShot`, `hexDamage`, `dmgMult`, `boxDrop`, `bucketAfterKill`, `cashoutPayout`, `segmentHitsDisc` restent **appelées** depuis `WBCore` ; garde textuelle contre une seconde règle de critique et contre le retour de `CRIT_TEST` ; `api/sim.js` charge le bloc depuis `index.html`, garde bruyante au démarrage |
| Un seul écrivain de mesh dans `Game` | garde textuelle : un seul `syncMeshes()` pour les corps de brawlers, un seul `syncMonde()` pour tout le reste, un seul `hudFast()` pour les étiquettes du DOM — trois tables annexes, trois lecteurs uniques, tous appelés depuis la boucle d'image et de nulle part ailleurs |
| Le jeu tourne | sur dix graines et les cinq modes, une partie complète atteint une fin en moins de `zoneTotalS + GRACE`, personne ne termine coincé contre un mur, et le chien de garde `stuckT` est exercé pour de vrai. *Livré au module 5 : cinquante parties complètes jouées dans `node test.js`, chacune arrêtée sur un état terminal — une seule équipe en jeu, ou la fin du plan — jamais sur un compteur d'essais. Le chien de garde est compté, pas seulement supposé : plus de deux cents interventions sur les cinquante parties. Et il a trouvé un vrai bug, décrit ci-dessous* |
| L'empreinte est un entier, prise à intervalle fixe de pas | `EMPREINTE_PAS = 60`, un condensé par seconde simulée, accumulé ; `empreinte(G)` referme l'accumulation sur le nombre de pas et sur `SIM_VERSION`. Elle voit la position **et la vitesse** : sans la vitesse, un brawler poussé contre un mur rendait le même condensé quelles que soient ses commandes |
| Les tirs ne traversent plus les corps ni les murs | collision **balayée** par `WBCore.segmentHitsDisc` sur le segment d'un pas, corps comme murs. *Livré au module 4 : éprouvée jusqu'à 300 blocs par seconde, avec l'ancien test ponctuel reconstruit dans `test.js` pour prouver qu'il manquait bien le cas choisi, et la mort de la balle **au** mur vérifiée à un quart de case près* |
| Les points d'apparition placent un corps entier | `spawnPoints` place chaque brawler là où son corps de 0,42 tient, sur deux cents graines et les cinq modes. **Le bug est déjà corrigé dans le code** ; ce qui manque est le test de non-régression, et le module le livre comme tel. *Fait au module 3 : `spawnPoints` étant descendue dans SIM, le test l'appelle telle quelle au lieu d'en extraire la source, et vérifie le placement avec un `free()` réécrit exprès — une seconde opinion, pas la même* |
| Le contrat public de SIM tient dans quatre noms | `newMatch(graine, mode, miseCents, brawler)`, `step(G, entrees)`, `empreinte(G)`, `SIM_VERSION` — plus `drainer` et `condenseEtat`. Le bloc `Game` n'appelle plus une seule fonction de simulation depuis sa boucle : il LIT les commandes, fait tiquer son HUD et TRADUIT les événements. Garde textuelle sur les deux côtés à la fois : ce que `step` doit contenir, ce que `loop` n'a pas le droit de contenir |
| La conservation de l'argent est vraie à chaque pas de la **vraie** simulation | à chaque pas, sacoches + sacoches au sol + encaissé = mise × sièges, sur les quatre tables et les cinq modes ; et **assertée une fois de plus au moment du règlement**, sur la partie réellement rejouée. *Livré au module 4 sur un banc qui appelle les vraies fonctions de SIM — vingt combinaisons, mille cinq cents pas chacune, moitié au coup d'envoi et moitié dans un gaz déjà refermé. Ce n'est pas encore une partie entière : les bots descendent au module 5* |
| Les trois chemins de la sacoche tiennent | un kill la transfère entière, une mort par gaz la lâche au sol, un encaissement la met à zéro |
| Aucun montant ne vient du client | `net_cents` sort de la partie rejouée ; un corps dont les kills, la sacoche et la durée sont gonflés écrit une ligne **strictement identique** à celle d'un corps sincère — patron de la 02a étendu des paramètres aux faits |
| Le rejeu du serveur et celui du jeu rendent la même empreinte | même trace, même empreinte, et le test dit **pourquoi** : c'est le même bloc de code, chargé deux fois |
| Tronquer une trace ne paie jamais rien | pour chaque trace terminale et chacun de ses préfixes, `net(préfixe) ≤ net(complète)` ; `net = 0` et aucun montant écrit sans état terminal |
| Une trace invalide sort en 400, jamais en 500, et ne laisse jamais la ligne `open` | trop longue, malformée, absente, non terminale, `sim_version` différente, rejeu trop long : six codes nommés, chacun testé, et la ligne clôse ou laissée au veilleur, jamais bloquée |
| Le rejeu tient un budget | `REPLAY_BUDGET_MS` éprouvé avec une **horloge injectée**, donc sans attendre ; plancher de performance dans `npm test` : N pas en moins de X ms |
| Une divergence se mesure et ne se punit pas | ligne réglée, `digest_match = false`, `divergence_step` renseigné ; garde qu'aucun agrégat de statistiques ne compte une ligne divergente ; le taux de divergence est un chiffre exposé |
| Aucune colonne solde ; `matches` s'insère puis se règle une fois | garde textuelle sur `api/schema.sql` et `api/db-pg.js` ; `match_traces` en insertion seule, aucun `update`, aucun `delete` |
| Aucune dépendance nouvelle | `api/package.json` inchangé hors `jose` et `pg` ; le jeu n'en a aucune ; `node test.js` et `node api/test.js` tournent sans rien installer |
| `npm test` vert après chaque module | intégration continue : `node test.js`, `node api/test.js` sans dépendance puis avec ; après **toute** édition d'`index.html`, extraction des blocs `<script>` et `node --check` avant toute autre chose |

---

## Les risques, assumés

- **Le déplacement du code touche précisément la zone qui a cassé le jeu cinq fois**, et toutes les
  fois par une édition par remplacement de texte. Un marqueur par édition, jamais une plage entre
  deux repères éloignés, jamais un `//` en fin d'une ligne existante, `node --check` sur les blocs
  extraits après chaque édition, le corpus gelé dès le module 3 et le harnais de partie entière dès
  le module 5. **C'est le risque le plus élevé de la phase**, et le découpage en trois modules de
  vidage est ce qui le réduit — pas une promesse.
- **La frontière de portée a été sous-estimée par la proposition retenue.** « Déplacés verbatim » est
  faux : chaque fonction perd sa fermeture. Les modules 3, 4 et 5 sont plus lourds que la formule ne
  le laissait croire, et le chiffrage à retenir est celui de la section correspondante ci-dessus.
- **Le déterminisme n'est pas bit-à-bit entre runtimes.** `Math.sin`, `Math.cos`, `Math.atan2`,
  `Math.hypot` et `Math.pow` sont partout dans le mouvement, la visée et le gaz. Un rejeu n'est donc
  opposable que sur le **même runtime**. Ce que les tests prouvent : l'égalité entre deux processus
  Node, et l'absence de transcendantes dans la géométrie de la graine. Ce qu'ils ne prouvent pas :
  l'égalité entre deux moteurs. L'invariant est formulé pour ne pas promettre plus.
- **Tout ce qui change le ressenti arrive dans cette phase et rien ne peut le tester** : le pas fixe
  déplace des constantes réglées pour un écran à 60 images par seconde (`Math.min(1,dt*13)`,
  `Math.pow(0.02,dt)`, les rythmes de louvoiement des bots) ; la collision balayée fait toucher des
  tirs qui frôlaient ; les bots changent de source de hasard, donc de personnalité, tous d'un coup.
  Les trois sont justes séparément. Le jour où le jeu se jouera mal, **rien ne dira lequel en est la
  cause**, et le seul juge est un humain qui joue une partie entière, sur téléphone comme sur
  ordinateur. Ce n'est pas budgétable, donc c'est écrit : une session de jeu réelle après le module 1
  et après le module 4, avec ce qu'il faut regarder noté d'avance. *Le module 2 a livré le troisième
  de ces changements — les bots ont tous changé de personnalité d'un coup, puisque leur `id` ne vient
  plus de `Math.random()` : nervosité, distance préférée, rythme d'esquive, et la moitié qui décroche
  contre la moitié qui reste. La session due après le module 1 n'a toujours pas eu lieu et elle a
  maintenant deux changements à juger, pas un.* *Le module 4 a livré le deuxième : la collision balayée
  fait toucher des tirs qui passaient à côté, surtout de près et surtout avec les armes rapides, et
  les bots en profitent autant que le joueur. La session due a maintenant **trois** changements à
  juger — pas fixe, personnalité des bots, portée réelle des tirs — et elle est due **avant le
  module 5**, comme cette section l'exige depuis le début.* *Le module 5 n'ajoute pas de quatrième
  changement de ressenti : les bots, le joueur et le gaz ont été déplacés, pas réécrits. Il déplace en
  revanche le MONDE — les caisses de toutes les graines changent de place, pour la raison du module 2
  et au même coût, zéro. La session de jeu réelle n'a toujours pas eu lieu.*
- **Toutes les commandes du joueur ne passent pas encore par `entrees`, et le module 6 doit le
  savoir.** Le super (barre d'espace, clic droit, stick), le fumigène, la visée automatique (`Q`, tap
  tactile) et le tir d'une pression brève partent d'un **événement d'entrée**, entre deux pas, pas du
  pas lui-même — c'est ce que le jeu a toujours fait et le module 5 ne l'a pas changé pour ne pas
  déplacer la latence ressentie. La trace devra donc porter ces actions ponctuelles **horodatées en
  pas** en plus des six nombres continus, sans quoi une partie rejouée n'aura ni super ni fumigène.
  Le harnais de `test.js` les joue déjà exactement comme le jeu les joue — entre deux `step` — et les
  enregistre dans sa trace : la forme est éprouvée, il reste à la transporter.
- **`respawn` ne remet pas `knockx`/`knockz` à zéro.** Un brawler qui réapparaît à l'autre bout de la
  carte garde la poussée de l'explosion qui l'a tué. Trouvé en lisant l'état d'une entité coincée,
  laissé tel quel : c'est un changement de ressenti que rien ne peut juger, et cette phase en a déjà
  trois.
- **La trace est une surface d'attaque nouvelle** : corps volumineux, trace adversariale qui maximise
  le coût du rejeu, joueur qui rejoue en boucle. D'où une borne dure sur le nombre de pas, un budget
  de temps de calcul, une route séparée de celle qui règle l'argent, et la limitation de débit
  existante — qui ne tient toujours que sur une instance.
- **L'aimbot survit entier, et l'ESP devient structurel.** La trace porte une direction de visée par
  pas, et une visée parfaite ne se distingue pas d'un bon joueur ; le client qui dessine sa partie
  connaît tout le butin de la carte. Avec des adversaires tous robots, la seule victime en est la
  maison, à chaque partie. À écrire dans `api/README.md`, jamais à diluer.
- **Aucune base n'a toujours jamais tourné**, et cette phase ajoute six colonnes, une table et un
  index unique dont un **paiement** dépend. C'est la dette la plus silencieuse du dossier et elle
  s'aggrave ici. Un test qui passe contre la doublure prouve la doublure. Faire tourner une vraie
  Postgres une fois, ne serait-ce qu'à la main, devient un **prérequis de la phase 03**, et c'est
  écrit comme tel.
- **`match_traces` n'a aucune politique de conservation.** Nommé, renvoyé à la phase 03.
- **Le dernier module concentre le risque restant**, comme le branchement du jeu en 02a. S'il glisse,
  les modules 1 à 6 gardent leur valeur propre : le jeu devient déterministe, le pas fixe le rend
  équitable entre appareils, les tirs cessent de traverser, et le dépôt obtient son premier test qui
  regarde une partie se jouer. C'est le découpage qui protège.

---

## Le découpage, et pourquoi cet ordre

1. **Le pas fixe et l'arrêt sur image.** Deux préconditions, livrées seules, justifiées seules.
2. **Le hasard semé et la géométrie sans transcendantes.** La seconde précondition, et la seule
   correction qui soit encore gratuite.
3. **L'état et la grille descendent dans SIM.** Naissance du bloc, et corpus gelé de non-régression.
   **Fait.** `WBSim` existe, troisième `<script>` interne : la grille (`cellAt`, `isWall`, `inBush`,
   `free`, `tryMove`, `moveEntity`, `losClear`, `inZone`), la vue (`canSee`, `obscured`, les deux
   ponts vers `smokeSightBlocked`), `spawnPoints` et l'état d'une entité y vivent, l'état de partie
   passé en premier argument. Le corpus gelé — `corpus-grille.json`, capturé sur le code d'avant le
   déplacement — est une **donnée**, pas un test : il ne se régénère pas, sinon il ne prouve plus
   rien. Ce qu'il couvre est écrit à côté de lui dans `test.js`, ce qu'il ne couvre pas aussi.
4. **Les faits : projectiles balayés, dégâts, mort, butin, flux d'événements. Fait.** Dix-huit
   fonctions sont descendues dans SIM — `attack`, `fireSpec`, `spawnProjectile`, `projUpdate`,
   `explode`, `useSuper`, `dashUpdate`, `zonesUpdate`, `damage`, `kill`, `hurtBox`, `spawnPickup`,
   `collect`, `respawn`, `botCashOut`, `hurtTurret`, `checkTeams`, `doCashOut` — plus le fumigène
   entier. La conservation de l'argent se vérifie désormais **à chaque pas du vrai code**, sur les
   quatre tables et les cinq modes, et plus sur un modèle. La collision est balayée.
5. **Les bots, et une partie entière sans navigateur. Fait.** `findCover`, `findTarget`, `pickGoal`,
   `botUpdate`, le joueur (`joueurUpdate`), `commonUpdate` et `zoneUpdate` sont descendus dans SIM,
   qui expose désormais son **contrat public** : `newMatch(graine, mode, miseCents, brawler)`,
   `step(G, entrees)` qui rend la liste d'événements du pas, `empreinte(G)`, et `SIM_VERSION`.
   `node test.js` joue **cinquante parties complètes** — dix graines × cinq modes — du coup d'envoi
   à la dernière phase du gaz. Le trou le plus ancien du dossier se referme **avant** que le serveur
   n'ait besoin de quoi que ce soit.
6. **La trace : `api/sim.js`, `sim_version`, enregistrement et route d'insertion seule.** Aucune
   décision d'argent ne change encore.
7. **Le rejeu décide.** La route recalcule les faits, l'état terminal devient obligatoire, la
   divergence se mesure, la documentation rattrape.

L'ordre suit la doctrine du dépôt : le dernier module porte le risque, et les précédents gardent leur
valeur s'il glisse. Le module 5 est le critère de sortie qui compte — une partie entière se joue sans
navigateur — et il arrive **avant** les deux modules qui touchent l'argent, pas après.

---

## Ce qui est renvoyé aux phases suivantes

- **Phase 03 — grand livre en partie double.** Il ne lira que des lignes dont le rejeu a convergé,
  jamais les lignes de la 02a. Prérequis explicite désormais : **faire tourner une vraie base au
  moins une fois**, parce que l'index unique de `match_traces`, la clause « seulement si le billet est
  ouvert » et l'arbitrage du premier écrit n'auront été éprouvés que contre une doublure.
- **La politique de conservation de `match_traces`** — combien de temps garde-t-on la pièce qui prouve
  une partie, et qui a le droit de la relire.
- **Le déterminisme bit-à-bit entre moteurs** : remplacer la trigonométrie du mouvement, de la visée
  et du gaz par de la virgule fixe. Chantier à chiffrer avant d'être promis, et à ne pas confondre
  avec la purge bornée du module 2.
- **La triche restante** : aimbot et ESP, entiers, structurels, avec la maison pour seule victime tant
  que les adversaires sont des bots. Arbitrage d'exploitation, pas d'architecture.
- **Trois décisions hors des sept phases**, à prendre avant le premier euro : « la maison est la
  contrepartie de chaque pot », « un déploiement se draine plutôt qu'il n'écrase les billets
  ouverts », et la limitation de débit en magasin partagé.
- **Le harnais navigateur.** Deux bugs du journal n'ont été trouvés que par là, et le harnais de
  partie du module 5 ne les aurait pas attrapés.
- **Phases 04 à 06** — portefeuille, dépôts, retraits, exploitation. Rien de réel avant que 01 à 03
  soient finies.
