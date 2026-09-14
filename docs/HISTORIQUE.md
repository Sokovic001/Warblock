# Journal de développement

Reconstitué à partir des sessions du 28 août au 4 septembre 2026. Ce document existe pour
qu'on ne refasse pas les erreurs déjà faites et qu'on ne revienne pas sur des pistes déjà
essayées et abandonnées.

---

## Comment le projet est né

La demande initiale : un battle royale en pixel/voxel avec des mises réelles — tuer les 19 autres
joueurs, le survivant emporte le pot. Les premières versions étaient injouables (« je me fais tuer
direct », « pas assez fluide »). La bascule décisive est venue au 4ᵉ tour : **prendre le gameplay
de Brawl Stars comme référence**, vue de dessus, tir automatique, brawlers à identité forte. Tout
ce qui a suivi découle de ce choix.

---

## Les décisions structurantes

| Décision | Pourquoi |
|---|---|
| **Vue de dessus type Brawl Stars** | Les premières itérations en vue subjective étaient illisibles et frustrantes. |
| **20 % de commission sur *tout* paiement** | Demandé explicitement, y compris pour un cash out sans aucun kill, et dans les deux jeux. Pas d'exception « zéro kill ». |
| **Deux jeux, pas deux modes** | MAXWIN (le pot au dernier debout) et RESURGENCE (bucket encaissable à tout moment) sont des économies différentes, pas des variantes. |
| **Tables à $0,50 / $1 / $5 / $10** | Remplacent des montants plus élevés testés au départ. Le sous-dollar force à calculer en centimes. |
| **Vitesse dérivée, jamais écrite à la main** | Un brawler avec beaucoup de PV, de la portée *et* de la vitesse serait dominant. `derivedSpeed()` calcule la vitesse à partir des PV, de la portée et d'un décalage d'agilité ; un test vérifie qu'aucun brawler n'en domine un autre. |
| **Un seul biome (FARM)** | Trois biomes cousus sur une même carte se lisaient mal et rendaient la minimap illisible. VOLCANO et SNOW restent définis, `BIOME_COUNT = 1` les réactive. |
| **3 vies (2 en Resurgence)** | Avec une seule vie, le dernier survivant était désigné vers 54 s alors que le gaz met 154 s à se refermer. Mesuré, pas supposé. |
| **Sas d'attente de 25 s** | Demandé pour simuler l'arrivée d'autres joueurs. Décompte 3-2-1 ensuite, sans bouton « prêt » : le joueur a déjà cliqué pour entrer. |
| **L'ordre des sept phases de l'argent n'est pas négociable** | Le serveur doit posséder l'état du jeu avant qu'un euro n'entre. Tant que `wallet` est une variable du navigateur, tout solde est modifiable depuis la console. |
| **Aucune colonne « solde » en base tant que le grand livre n'existe pas** | Un solde qu'on écrase est exactement ce qu'il faudrait supprimer en phase 03. Mieux vaut ne pas créer la case que d'avoir à en sortir de l'argent. |
| **Crossmint plutôt que Clerk** | Même fournisseur pour la connexion par email et pour le portefeuille : le portefeuille de la phase 04 naît du compte de la phase 01, sans second fournisseur à réconcilier. |
| **Le jeu reste jouable sans compte** | La promesse du fichier unique tient : on l'ouvre et on joue. Se connecter ajoute un profil qui suit le joueur d'une machine à l'autre, ça n'ouvre pas la porte. |
| **Connexion par code email, pas par le composant React de Crossmint** | Leur interface demande un bundler, que ce dépôt n'a pas et ne veut pas. Leurs routes de connexion sont du HTTP ordinaire : quatre appels, la clé `ck_` en en-tête, et `index.html` reste un seul fichier. |
| **La phase 02 est scindée en 02a et 02b, et les deux moitiés sont nommées** | « Le serveur devient l'autorité du jeu » recouvrait deux chantiers de tailles incomparables : posséder l'**identité** d'une partie tient en quelques centaines de lignes, la **simuler** est la réécriture du jeu. Sans deux noms, une 02a livrée se serait lue comme une phase 02 finie, et la phase 03 aurait démarré sur cette croyance — exactement l'accident que l'ordre « non négociable » existe pour empêcher. |
| **La couche monétaire en centimes entiers vient AVANT la première écriture en base** | `cashoutPayout(0.01)` rendait une commission nulle sur un brut non nul, contre la règle « 20 % de tout paiement, sans exception ». Un suffixe `Cents` sur un nom de variable n'attrape pas ça ; un test exhaustif de 0 à 1 000 000 si. Une couture se construit avant qu'il y ait des données à migrer, pas après. |
| **La commission s'arrondit vers le haut** | C'est ce qui garantit qu'elle est strictement positive dès que le brut l'est. Sur les montants réellement atteignables — la sacoche est un multiple de la mise, et les mises valent 50, 100, 500 ou 1000 centimes — arrondi haut et arrondi au plus proche coïncident, donc le choix ne coûte rien au joueur. |
| **Le plan de zone descend dans `WBCore` et sort de la seule graine** | Une règle qui décide de la fin d'une partie était écrite après `/*CORE-END*/`, donc jamais testée, et tirait ses centres sur `Math.random()`. La raison insuffisante, à écrire aussi : il reste une trentaine d'appels à `Math.random()` dans le bloc `Game`, donc **le gaz devient reproductible, pas la partie**. Le prétendre serait un mensonge dont la phase 03 hériterait. |
| **Deux graines, et la secrète ne sort jamais** | Elle ne sert à rien en 02a puisque rien n'est simulé, et c'est exactement pourquoi elle est créée maintenant : le jour où le serveur décidera du contenu des caisses, il faudra que le client ne l'ait jamais reçue. Une colonne ajoutée avant qu'une base ne tourne coûte zéro migration. |
| **L'idempotence est arbitrée par la base, jamais par un `select` préalable** | Même doctrine que `name_key` : demander « est-ce libre ? » puis insérer laisse une fenêtre entre les deux. Trois clés nommées — `(user_id, client_key)`, l'index partiel « un seul billet ouvert », `(match_id)` pour le règlement. La clé fournie par le client n'est pas un détail : sans elle, un `POST` dont la réponse se perd est indistinguable d'un `POST` jamais arrivé. |
| **Un rapport de partie refuse les champs inconnus ; un profil les ignore** | `PATCH /api/me` peut ignorer le superflu sans conséquence. Sur un corps qui décide d'un montant, le silence est la mauvaise valeur par défaut : tout champ inconnu vaut un refus, avec un code. La même indulgence aux deux endroits aurait été une règle uniforme et fausse. |
| **Le rendu lit l'état, il ne le produit plus — et il n'a qu'un seul écrivain** | Le module 3 de la phase 02b a sorti la grille, le mouvement et la vue du bloc `Game`. Un troisième `<script>` est une **frontière de portée dure** : le `G` de portée lexicale disparaît et devient un paramètre explicite, ce qui est le coût réel du déplacement. Le reste est une discipline : les corps des entités vivent dans une table annexe du bloc `Game`, indexée par un identifiant d'insertion, et un **unique** `syncMeshes()` les recopie depuis l'état, une fois par image. Laisser la simulation porter un pointeur vers la scène « le temps de la transition » aurait été le patron du `respawn()` défini deux fois : la copie vivante finit du côté que rien n'exécute, et la panne est muette. |
| **La simulation raconte, elle ne sonne plus** | Le module 4 de la phase 02b a descendu les tirs, les dégâts, la mort et le butin dans `WBSim`. Ces fonctions-là appelaient le synthétiseur, posaient des nombres flottants à l'écran et, pour `kill`, ouvraient directement l'écran de fin. Tant qu'une seule de ces attaches subsiste, le bloc cesse de tourner dans Node — et **rien ne casse dans le navigateur**, donc personne ne s'en aperçoit. Elles rendent désormais une liste d'**événements** horodatés en pas, aux douze noms fermés, que le bloc `Game` traduit. Le corollaire coûte une ligne mais il vaut d'être écrit : le jour où il manquera un bruitage, le premier réflexe sera de rappeler `snd()` depuis SIM, et c'est ce jour-là que la garde tombe. D'où une garde textuelle **permanente**, commentaires compris. |
| **L'argent qui sort d'une partie doit avoir un compteur** | Un bot qui encaisse voyait sa sacoche remise à zéro, et l'argent disparaissait purement et simplement de la partie. Aucun test ne pouvait le voir : la conservation n'était vérifiée que sur un **modèle** des transferts écrit dans `test.js`, et un modèle est d'accord avec lui-même par construction. Le module 4 a fait tourner la vraie simulation et la conservation a demandé un `G.encaisse` pour tomber juste. C'est la même leçon que le pot forfaitaire ressuscité : **une propriété se vérifie contre le code qui décide, jamais contre une paraphrase de ce code.** |
| **Un test qui regarde le jeu TOURNER trouve ce qu'aucun invariant ne cherche** | Le module 5 de la phase 02b a descendu les bots, le joueur et le gaz dans `WBSim`, et fait jouer cinquante parties complètes dans `node test.js`. La première volée a échoué sur une assertion qui semblait de pure forme — « personne ne finit coincé contre un mur » — et elle avait raison : `respawn` tire quarante points, ne garde que ceux où un corps tient, et **retombe sur le centre du cercle sans le vérifier** quand les quarante échouent. Ce qui n'arrive que lorsque le dernier cercle s'est refermé sur une poche de murs, c'est-à-dire à la toute fin d'une partie que personne n'avait jamais simulée. Le brawler réapparaissait dans la pierre, immobile et **intuable**. C'est mot pour mot le bug de `spawnPoints` réparé au module 3. La leçon n'est pas « il fallait relire `respawn` » : c'est qu'un chemin qui ne se prend qu'à la 9 000ᵉ image d'une partie ne se trouve pas en relisant, il se trouve en jouant. |
| **Une empreinte doit voir tout ce qui décide de la suite, pas seulement ce qui se voit** | Le condensé d'état du module 5 ne portait d'abord que la position. Le test de sensibilité — « changer un seul pas de la trace change l'empreinte » — échouait, et pas parce que l'empreinte était fausse : un brawler poussé contre un mur ne bouge pas d'un pouce quelles que soient ses commandes, donc deux rejeux réellement différents rendaient le même nombre. La **vitesse** a rejoint l'empreinte. Un condensé qui n'observe que ce qu'on voit à l'écran laisse passer exactement les divergences qui n'ont pas encore eu de conséquence visible — c'est-à-dire les seules qu'on ait une chance de localiser. |
| **Un déplacement de code se prouve par un corpus gelé, jamais par ses invariants** | Les tests d'invariants diraient la même chose d'un code qui aurait changé en restant juste. La seule preuve qu'un code a bougé **sans changer** est une capture faite **avant** le déplacement, comparée exactement après. `corpus-grille.json` est donc une **donnée**, pas un test : le régénérer le viderait de tout sens. Il dit aussi ce qu'il ne couvre pas — rien du combat, rien des bots, rien de ce que le joueur voit. |
| **Le chemin de secours du client se teste comme un cas normal, et s'écrit en premier** | `seedFor`, `matchFlow`, `reportFrom` et `checkReport` ont été livrées avant les routes, précisément pour geler le contrat que le serveur devrait servir. Le module qui branche le jeu est le dernier et porte tout le risque : s'il glissait, trois modules de serveur restaient du code mort que personne n'aurait vu tourner. |

---

## Décisions renversées

### `user_stats` : la table de compteurs livrée en phase 01, supprimée en phase 02a

La phase 01 a écrit et livré une table `user_stats` — quatre colonnes, `matches`, `wins`, `kills`,
`best` — qu'on incrémentait à la fin de chaque partie. La phase 02a la **supprime**, et les quatre
chiffres sont désormais lus par agrégat sur les parties réglées de la table `matches`.

La raison est celle qui avait déjà interdit la colonne « solde », et on ne l'avait pas appliquée
jusqu'au bout : **un compteur qu'on incrémente est une case qu'on écrase.** Un double envoi, une
reprise après coupure, un règlement rejoué, et la case est fausse pour toujours — sans qu'aucune
trace ne permette de la recalculer. Une somme sur des lignes immuables ne peut pas être fausse : on
la refait, elle redonne la même chose. Les parties, elles, s'insèrent puis se règlent une fois.

Pourquoi maintenant, et pourquoi ce n'est pas un détail de module : **aucune base n'a jamais
tourné.** C'était le dernier moment où le schéma pouvait changer sans migration, donc gratuitement.
Le même revirement fait six mois plus tard aurait coûté une reprise de données, et personne ne
l'aurait entrepris pour des statistiques d'affichage — on aurait gardé les compteurs, et la phase 03
aurait hérité du patron qu'elle existe pour interdire. La phase 02a sert précisément à répéter, sur
des chiffres qui ne valent rien, la mécanique que le grand livre exigera.

Ce qui se perd, et qui est assumé : une somme coûte plus cher à lire qu'une case, et le jour où un
joueur aura des milliers de parties, il faudra un index — il existe déjà — ou une vue matérialisée.
C'est un problème de performance, qui se répare ; une case fausse ne se répare pas.

---

### La trace est quantifiée À LA SOURCE, pas à l'enregistrement — phase 02b, module 6

Un rejeu ne vaut que s'il refait **exactement** la partie qui s'est affichée. La trace des entrées du
joueur doit tenir dans quelques dizaines de kilo-octets, donc elle est quantifiée : la visée au
1024e de tour, la portée de visée au huitième de case, le déplacement au quinzième de course.

La question qui décide de tout est *où* : quantifier au moment d'**écrire** la trace, ou au moment de
**lire** l'entrée. Le premier choix est le réflexe et il est faux. Le jeu jouerait une valeur, la
trace en porterait une autre, et le rejeu du serveur produirait une partie *voisine* de celle que le
joueur a vue — avec un écart qui grandit à chaque pas et qu'aucune borne ne décrit. C'est
`lireEntrees()` qui quantifie donc, et le jeu joue la valeur quantifiée. Le rejeu est alors exact
**par construction**, et le test qui le prouve compare l'état final sans la moindre tolérance.

Le corollaire coûte une phrase et il compte : **on quantifie avec ou sans billet.** Ne quantifier
qu'en ligne aurait fait deux jeux, un en ligne et un hors ligne, pour un écart que personne ne peut
sentir. La même règle vaut pour les gestes ponctuels — super, fumigène, tir bref : la visée est
quantifiée avant d'être jouée, et c'est celle-là qui part dans la trace.

### Une action ponctuelle n'est pas un champ d'entrée, c'est un jeton — phase 02b, module 6

Le super, le fumigène, le tir d'une pression brève, l'encaissement et l'abandon partent d'un
**événement** d'entrée, entre deux pas, et pas du pas lui-même. Le module 5 ne l'a pas changé pour ne
pas déplacer la latence ressentie, ce qui laissait une dette : une partie rejouée n'aurait eu ni
super ni fumigène.

La solution qui paraît naturelle — ajouter des booléens à l'objet d'entrée et différer l'action au
prochain pas — déplace la latence d'une demi-image en moyenne, sur le geste le plus important du jeu.
La trace porte donc ces actions comme des **jetons à part**, dans l'ordre où elles sont arrivées, avec
leur propre direction et leur propre portée : un super lancé au stick ne vise pas comme le pas qui
l'entoure. Le rejeu les applique avant le pas qui suit, ce qui reproduit exactement l'ordre d'origine.

### Une empreinte finale ne dit pas OÙ deux rejeux s'écartent — phase 02b, module 7

`empreinte(G)` accumule un condensé d'état tous les soixante pas et referme l'accumulation à la fin.
C'est exactement ce qu'il faut pour répondre « d'accord » ou « pas d'accord », et exactement ce qu'il
ne faut pas pour répondre « à partir de quel pas ». Un pli n'a pas d'inverse : on ne peut pas
bissecter une accumulation.

Or la phase 02b promet de **mesurer** la divergence et pas seulement de la constater — sans quoi la
phase 03 hériterait d'une liste d'exclusion dont personne ne connaît le rendement. Le client envoie
donc la **suite entière** de ses condensés, pas leur pli : six caractères base64url chacun, cent
soixante-sept au pire, un millier de caractères pour une partie complète. Cela tient sous les quatre
kilo-octets de `MAX_BODY`, qui n'a pas bougé — c'était la condition, la route du règlement ne devient
pas la surface d'attaque la plus large de l'API pour un confort de diagnostic.

Corollaire écrit une fois : `divergence_step` est au **pas d'empreinte près**, soixante pas, une
seconde simulée. Ce n'est pas le premier pas où les deux parties diffèrent, c'est le premier condensé
qui les sépare.

### `terminal` et `faits` appartiennent au JEU, pas au serveur — phase 02b, module 7

Le rejeu du serveur a besoin de deux réponses : « cette partie est-elle finie ? » et « qu'est-ce
qu'elle rend comme durée, kills, rang et sacoche ? ». Les écrire dans `api/app.js` aurait été la
chose évidente, et la troisième copie : `endMatch` les calculait déjà, le harnais de `test.js` les
recopiait, et le serveur allait recommencer. Trois copies d'une même définition, dont deux auraient
fini par mentir — et alors le serveur aurait jugé une **autre partie** que celle que l'écran du joueur
venait d'afficher, sans que rien ne casse.

`WBSim.terminal(G)`, `WBSim.faits(G)` et `WBSim.argentCents(G)` sont donc descendus dans le bloc de
simulation, comme tout le reste, et `endMatch` les lit. Le harnais garde ses propres formules,
délibérément : c'est une seconde opinion, et un test compare les deux sur les cinquante parties. Même
patron que le `free()` réécrit exprès dans `test.js` au module 3.

*Ce qui a été écrit là et qui était faux, corrigé depuis — voir « Une règle laissée dans le bloc
`Game` » plus bas.* Le harnais ne gardait pas ses propres formules : il recopiait celles de `faits`,
expression pour expression. La comparaison était donc vraie par construction, et le serait restée le
jour où `rank` aurait rendu le rang de l'équipe au lieu de celui du joueur.

Le fait de fin a dû descendre **sur l'état** pour cela : `G.fin` retient le premier événement `fin`,
parce qu'un événement se draine — le bloc `Game` le lit une fois puis il n'existe plus — alors que
« cette partie a une fin, et laquelle » est un fait de la partie.

### Une règle laissée dans le bloc `Game` est une règle que le serveur ne rejouera pas — phase 02b, reprise

Le compte à rebours de trois secondes vivait dans `startMatch` : `WBSim.newMatch` rendait `intro: 0`
et le bloc `Game` posait `G.intro = 3.999` juste après. Rien ne cassait — dans le navigateur.
Ailleurs, tout : la trace enregistre ces deux cent quarante pas (c'est écrit dans le commentaire de
`TRACE.INTRO_S` depuis le module 6), et le rejeu du serveur, qui repart d'un `newMatch` neuf, les
consommait comme de **vrais** pas de simulation. Il jugeait donc une autre partie que celle qui
s'était affichée, sur **toute** partie réellement jouée dans un navigateur : `digest_match` faux
partout, donc zéro ligne lisible par le grand livre de la phase 03 et cinq agrégats bloqués à zéro,
et, quand le rejeu n'atteignait pas d'état terminal, un 409 et une partie jamais enregistrée.

Aucun test ne pouvait le voir, et c'est le vrai enseignement : `test.js` comme `api/test.js`
construisent leurs parties par `newMatch` et ne posaient donc **jamais** `G.intro`, qui vivait hors
du bloc SIM. Un test ne couvre que ce que le code lui laisse atteindre. Le décompte décide du coup
d'envoi : c'est une règle de simulation, elle est descendue à côté de `terminal`, `faits` et
`argentCents`, et le bloc `Game` ne fait plus que la lire pour afficher la bannière.

Deux corollaires du même passage. `WBSim.abandon` existe pour la raison jumelle : QUITTER se presse
aussi pendant les cinq secondes de réapparition, et `kill` sort tout de suite sur `!victim.alive` —
l'interface appelait donc `endMatch` directement, sans jeton dans la trace et sans événement de fin,
et le rejeu n'atteignait jamais de terminal. Et le harnais de `test.js`, qui prétendait donner « une
seconde opinion » sur les faits, en **recopiait les expressions mot pour mot** : la comparaison sur
cinquante parties était vraie par construction, exactement le patron que ce journal condamne à
propos de la conservation de l'argent. Il dérive maintenant ses chiffres du flux d'événements.

### Un billet resservi est le même monde — phase 02b, reprise

Tant que rien n'était simulé, rendre le billet ouvert existant était une pure commodité
d'idempotence. Depuis que le serveur rejoue, la partie entière est une **fonction pure de la graine
publique** : même carte, mêmes caisses, mêmes vingt bots, même plan de gaz. Le même billet resservi
est donc le même monde, et il suffisait de bloquer l'envoi de sa trace — un bloqueur de requêtes,
deux secondes de wifi coupé — pour obtenir un 409, garder son billet, recliquer sur la table et
rejouer en connaissance de cause le monde qu'on venait d'explorer, jusqu'à faire régler sa meilleure
tentative.

La leçon est de conception, pas de code : **une propriété d'idempotence écrite avant que quelque
chose n'ait de valeur cesse d'être neutre le jour où cette valeur arrive.** Un billet ne sert
désormais qu'une tentative — `first_result_at`, posée au premier résultat quelle qu'en soit l'issue —
et la porte qui reste ouverte est nommée : renvoyer une trace perdue puis son résultat sur le même
`match_id`. La variante involontaire du même défaut est réparée du même coup : deux tentatives ne se
cousent plus, un `seq` déjà posé dont les données diffèrent sort en 409 nommé au lieu d'être avalé.

### Le compte des tests vit à quatre endroits, et le quatrième a décroché — phase 02b, recette

La recette de fin de phase n'a trouvé qu'un seul écart entre ce que le dépôt dit et ce qu'il est, et
il est instructif par sa banalité : `README.md` annonçait « 365 tests sur le jeu + 128 sur l'API »
alors que les suites en comptaient 369 et 134. `CLAUDE.md`, `api/README.md` et la section « État
après la phase 02b » de ce journal, eux, étaient justes. Le chiffre est écrit à **quatre** endroits,
les sept modules en ont rafraîchi trois, et celui qui reste est précisément la première page que
lit quelqu'un qui arrive.

Aucune correction structurelle à en tirer : centraliser le compte demanderait de le générer, donc
un script de plus pour un nombre qui ne décide de rien. Ce qui se retient est la règle de relecture,
et elle est déjà dans la procédure de recette : après une phase, on relit les **quatre** endroits,
pas les trois qu'on a touchés. Le même journal a d'ailleurs sous-compté les colonnes ajoutées par la
phase — cinq écrites, sept posées, parce que `sim_version` et `first_result_at` sont arrivées après
la rédaction de la phrase. Corrigé ici.

### Le veilleur devient un écrivain d'argent — phase 03, module 4

`api/app.js` et `api/db-pg.js` ont porté pendant deux phases la même phrase sur le veilleur : « Il
n'écrit AUCUN montant — il ne fait que fermer une porte. » Elle était juste tant qu'aucun montant
n'était engagé nulle part. Depuis que la mise est débitée à l'**ouverture** du billet, un billet que
personne ne termine laisse un séquestre **habité** : de l'argent posé sur `enjeu:<match_id>` que
plus rien ne solde, et l'invariant « aucun séquestre ne reste habité » devient faux sur le chemin le
plus fréquent de tous — l'onglet qu'on ferme.

Le veilleur vide donc chaque séquestre vers `maison:contrepartie`, et **il ne rembourse jamais** :
passé la fenêtre de renoncement, rien ne rend la mise, sans quoi le vol que la phase existe pour
fermer se rouvrirait par la porte d'à côté. Deux conséquences de forme, et la première a coûté une
réécriture : `expireMatches` closait jusqu'à cinq cents lignes en **une** instruction, elle devient
une boucle de transactions bornées, **une par billet** — un mouvement du grand livre ne se pose pas
en masse, et un échec sur une ligne ne doit pas annuler les autres. La seconde : le veilleur rejoint
la liste nommée des appelants autorisés de l'écrivain du grand livre.

Ce qui se retient : **les deux commentaires ont été RÉÉCRITS, pas laissés à contredire le code.**
Une phrase d'architecture qui survit à la décision qu'elle décrivait est découverte six mois plus
tard par quelqu'un qui la relit et la croit.

### La garde « aucun `delete from match_traces` » a été AFFAIBLIE, sciemment — phase 03, module 4

`api/test.js` interdisait tout `delete` sur `match_traces`, et il **passait**. La phase 03 devait
donner à cette table sa politique de conservation, donc écrire le premier `delete` du dépôt sur la
pièce qui prouve un paiement. Une garde qu'on retire pour faire passer le code qu'on vient d'écrire
est exactement l'écart que la recette de la 02b a trouvé ailleurs.

Elle n'a donc pas été retirée, elle a **changé de forme** : « le seul `delete` de cette table est la
purge nommée, et sa clause porte les quatre conditions ». Les quatre — ligne réglée définitivement,
écriture du grand livre posée, séquestre vide, délai de rétention écoulé — sont éprouvées **une par
une**, en retirant chacune seule sur un cas dégénéré construit exprès. La conséquence à connaître,
et c'est le bon défaut : **la trace d'un billet dont le résultat n'est jamais arrivé n'est jamais
effacée**, puisque sa ligne n'est ni `settled` ni `rejected`. C'est précisément la pièce qu'on
voudra relire.

### « Un billet qui tarde ne retarde jamais le coup d'envoi » ne vaut plus pour un REFUS — phase 03, module 5

La règle de la 02a est écrite dans quatre documents et tenue par quatre tests : une demande de
billet qui échoue laisse la partie partir **hors ligne**, sur la graine du navigateur. Elle a été
écrite quand un billet n'était qu'une identité de partie ; elle est **fausse à moitié** depuis que le
billet porte un débit.

La coupure est là : une **panne** — réseau coupé, serveur muet, réponse illisible, 500 — ne dit rien
de ce que le joueur a le droit de faire, et lui refuser sa partie pour un wifi qui tousse serait un
mauvais échange. Un **refus explicite et nommé** dit précisément le contraire : le serveur a
instruit la demande et l'a rejetée. Jouer quand même ferait de la partie payante une partie
gratuite — sans mise au séquestre, donc une partie qui ne pourrait rien payer à personne.

Trois codes seulement arrêtent le sas — `fonds`, `livre`, `renonce_recent` — et la liste est
**fermée**, dans `WBCore.REFUS_SAS`, confrontée par un test d'`api/test.js` aux codes que l'API émet
vraiment. Un 429 et un 500 n'y sont pas, et c'est délibéré : ils ne nomment rien. Effet de bord
assumé et écrit : le test d'accessibilité d'une table au lobby redevient ce qu'il est, une
**indication** — c'est le `409 fonds` du serveur qui tranche.

### Le portefeuille de démonstration ne disparaît pas, il se dédouble — phase 03, module 5

La tentation était de faire de `wallet` le solde du serveur, point. C'aurait cassé la promesse la
plus ancienne du dépôt : on ouvre `index.html` et on joue, sans compte et sans serveur. Il y a donc
maintenant **deux économies sur le même écran**, et le choix qui les tient est de les nommer à
l'écran plutôt que de les unifier dans le code : hors ligne le bandeau dit « Demo wallet » et garde
son bouton de recharge, connecté il dit « Credits », perd le bouton et affiche la quarantaine.

Deux détails ont failli passer, et ils sont l'essentiel :

- **Un montant absent n'est pas un montant nul.** `applyAccount` rend `null` quand la réponse ne
  porte pas de solde, et l'appelant ne l'écrit alors pas. Sans cela, lire un règlement comme un
  compte — le piège nommé de la 02a, qui coûtait quatre compteurs de statistiques — aurait vidé le
  portefeuille à l'écran. Les statistiques, elles, tombent volontairement à zéro sur un objet qui
  n'en porte pas : la règle n'est pas la même parce que le coût n'est pas le même, et c'est écrit à
  côté des deux.
- **Le bouton de recharge caché reste cliquable depuis la console.** `hidden` est une décision
  d'affichage, pas une garde. Le geste est donc refusé en plus d'être caché.

### Le chronomètre du client doit MENTIR DANS LE BON SENS — phase 03, module 5

Le bouton QUITTER du sas annonce ce que partir coûte, et c'est le **serveur** qui arbitrera. Deux
horloges, donc, et la question n'est pas « laquelle est juste » mais « de quel côté se trompe-t-on ».
Le chronomètre du sas part du clic ; le serveur ne date le billet qu'à réception de la requête. Le
client est donc toujours **en avance**, et l'écran ferme la promesse un peu **avant** le serveur : il
ne promet jamais un remboursement qui sera refusé. Une seule règle, `WBCore.renonciationOuverte`,
appelée par les deux avec leur propre horloge — la fonction ne lit aucune horloge, elle la reçoit,
et c'est ce qui permet cet arrangement sans deux définitions de la fenêtre.

Un trou trouvé en écrivant le branchement, et qui coûtait une mise entière : le joueur peut quitter
le sas **pendant que la demande de billet est encore en vol**. Le serveur ouvre alors le billet et
débite ; personne ne renonce pour lui, et la mise reste au séquestre jusqu'à l'expiration. Le module
renonce donc au billet qui arrive en retard, sur sa propre génération de requête.

## Trois choses consignées avant le premier euro

Aucune des trois n'est de l'architecture, aucune n'apparaît dans le plan en sept phases, et toutes
arrivent **avant** que le premier euro n'entre. Elles sont écrites ici parce qu'écrites ailleurs
elles seraient oubliées exactement le jour où elles compteraient.

### La maison est la contrepartie de chaque pot

Tant que les dix-neuf adversaires sont des bots, **leurs mises ne sont payées par personne.** Le jeu
affiche « $0,50 × 20 sièges = $10 dans le pot » et promet jusqu'à $8 au survivant — mais un seul
joueur a misé $0,50. Les $9,50 restants sont une écriture, pas de l'argent. Le survivant ne touche
d'ailleurs ce plafond que s'il a ramassé toute la table : le prix est la sacoche qu'on emporte, pas
un forfait. Le jour où les mises seront réelles, chaque partie gagnée coûtera donc à la maison la
différence entre ce qui sort de la caisse et ce qui a réellement été misé, commission comprise.

Trois issues, toutes légitimes, aucune choisie : payer un pot calculé sur les seuls joueurs réels
(ce qui change l'affichage, donc la promesse) ; garder le pot affiché et le traiter comme un coût
d'acquisition, borné et budgété ; ou n'ouvrir les tables en argent réel qu'une fois vingt joueurs
réunis, ce qui suppose une population que la phase 01 simule encore entièrement.

Ce n'est ni un bug ni une dette technique : c'est une décision d'exploitation. Elle doit être prise
**avant** la phase 04, pas découverte au premier relevé. Elle ne figure nulle part dans les sept
phases parce que les sept phases décrivent la mécanique de l'argent, jamais son économie.

### Le rejeu ne sera opposable que sur le même runtime

La phase 02b promettra un rejeu : mêmes graines, mêmes entrées, même partie. Cette promesse a une
limite qu'il faut écrire **avant** que quelqu'un ne parle de « preuve de partie » devant un joueur
mécontent. `Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp près par ECMAScript :
la norme les laisse « implementation-approximated ». Deux moteurs, deux versions du même moteur, ou
deux architectures peuvent rendre des résultats qui diffèrent du dernier bit — et une trajectoire
intégrée image par image amplifie cet écart jusqu'à changer qui touche qui.

Conséquence pratique : un rejeu ne prouve quelque chose que s'il tourne sur **le même runtime** que
la partie d'origine. Un rejeu serveur qui contredit un client n'est donc pas une preuve que le client
a triché ; il peut n'être qu'une preuve que les deux n'ont pas la même bibliothèque mathématique. Si
un jour un rejeu doit être opposable, il faudra soit figer le runtime des deux côtés, soit remplacer
ces trois fonctions par des implémentations déterministes écrites à la main — ce qui est un chantier
en soi, à chiffrer avant de le promettre.

*Ce que la phase 02b en a fait, module 7.* Rien de cette limite n'a été levé, et rien n'a été promis
au-delà. La divergence est **mesurée et jamais punie** : la ligne est réglée, payée, et marquée
`digest_match = false` avec le pas où les empreintes se séparent. La seule garantie donnée est
négative et elle suffit : **le grand livre de la phase 03 ne lira que des lignes dont le rejeu a
convergé.** Refuser le joueur divergent aurait été le quatrième contrôle « évident » et faux de ce
dossier.

### Le verdict de la phase 02a n'arrête presque rien, et c'est assumé

`matchVerdict` porte le nom de ce qu'elle est : une **enveloppe de plausibilité**. Elle refuse
l'impossible — plus de kills que adversaires × vies, une partie plus longue que tout le plan de zone,
une sacoche au-delà de la table — et rien d'autre. Les tolérances d'horloge valent deux minutes,
parce qu'un onglet en arrière-plan, un téléphone endormi et une horloge locale fausse sont beaucoup
plus fréquents qu'un tricheur.

Le choix est écrit pour qu'on ne le prenne pas pour un oubli : **tant qu'aucun argent n'est en jeu,
accepter une partie douteuse coûte une ligne de statistique qui ne vaut rien, et refuser une partie
honnête coûte un joueur.** À l'intérieur de l'enveloppe, un client modifié ment sur tout — durée,
kills, cubes, dégâts, rang — sans être inquiété. Il ne peut pas choisir son montant en MAXWIN, que le
serveur recalcule ; il peut annoncer en Resurgence n'importe quelle sacoche entre zéro et cinquante
mises.

Le branchement du jeu a d'ailleurs montré qu'un contrôle « évident » de plus était trop serré : le
rang rendu est celui du joueur, pas celui de son équipe, et un joueur de Duo éliminé pendant que son
coéquipier se bat encore annonce le nombre d'équipes **plus un**. La borne a été élargie plutôt que
le joueur refusé. C'est le troisième contrôle qui s'avère faux à l'usage, après les deux que la
spécification avait déjà écartés — la leçon se répète : une règle de plausibilité se vérifie contre
le code du jeu, jamais contre l'intuition.

---

## Pistes essayées puis abandonnées

- **Lobby mobile refait de zéro, façon Brawl Stars** (personnage au centre, onglets latéraux) :
  trois tentatives, toutes rejetées pour superposition d'éléments. Retour à une version adaptée du
  lobby desktop. **Ne pas relancer ce chantier sans maquette validée d'abord.**
- **Buissons en sphères** : lus comme des cailloux. Puis en cônes pointus : lus comme des piques,
  « on n'ose pas rentrer dedans ». La forme qui fonctionne est le **cône tronqué**, large et bas.
- **Damier au sol** : lisait comme un plateau d'échecs vu de haut. Remplacé par des taches
  organiques au bruit.
- **Estimation pessimiste de la qualité graphique** : partir bas et remonter donnait une première
  partie laide sur un téléphone capable. On part maintenant optimiste et on corrige à la baisse.
- **Clerk comme fournisseur d'identité** : écrit, testé, puis abandonné avant d'avoir servi. Il
  fallait de toute façon un second fournisseur pour le portefeuille ; Crossmint fait les deux. Le
  changement n'a coûté qu'un fichier : la vérification du jeton est injectée dans `createApp()`, et
  aucun des tests du routeur n'a bougé. C'est l'argument pour l'injection, en une ligne.
- **`@crossmint/server-sdk` pour vérifier les jetons** : son `verifyCrossmintJwt` ne regarde pas la
  revendication `aud`, donc un jeton émis pour un autre projet Crossmint — signé par la même
  autorité, parfaitement valide — aurait ouvert un compte chez nous. Le contrôle était à ajouter par
  nos soins de toute façon, et le SDK tire `@solana/web3.js` et `viem` pour vérifier un jeton. On
  utilise `jose` directement : c'est ce que le SDK utilise à l'intérieur, sans dépendance, avec plus
  de contrôles que lui.

---

## Bugs marquants et leur cause réelle

Ces cinq-là ont tous la même origine : une **édition automatisée par remplacement de texte**.

1. **Écran noir, « Script error » en boucle.** Un remplacement délimité par deux repères a effacé
   la scène, la caméra et l'éclairage, qui se trouvaient entre les deux. → *Vérifier le contenu
   d'une plage avant de la remplacer.*

2. **Dégâts invisibles, barres de vie figées.** Un commentaire `//` ajouté en fin d'une ligne
   existante a avalé la mise à jour de la barre de vie et des cubes, qui suivaient sur la même
   ligne. → *Un commentaire va sur sa propre ligne. Toujours.*

3. **Ombres de butin qui s'accumulent sur la carte.** Deux remplacements se chevauchaient : le
   premier créait l'ombre, le second devait la rattacher au butin mais son motif n'existait plus.
   L'ombre était donc créée sans jamais être supprimée.

4. **Pas de réapparition malgré les 3 vies.** `respawn()` s'est retrouvée **définie deux fois** ;
   la seconde, obsolète, exigeait un coéquipier vivant comme ancrage — inexistant en Solo.

5. **`rng is not a function`.** Un appel passait `chatRng()` (le nombre tiré) au lieu de
   `chatRng` (le générateur).

**Leçon transversale :** après toute édition automatisée, extraire les blocs `<script>` et lancer
`node --check` dessus, puis `node test.js`. Les trois quarts de ces bugs auraient été attrapés.

Cette leçon n'était tenue que par la discipline de celui qui édite : ni `npm test` ni l'intégration
continue ne regardaient le bloc `Game`, et le workflow qui **publie** le fichier ne lançait qu'un
`node test.js` qui ne charge que `WBCore`. Un test le fait désormais — il extrait les blocs et les
passe à `vm.Script`, qui parse sans exécuter. Le corollaire vaut aussi : un bloc que rien n'exécute
finit par contenir une seconde copie d'une règle testée ailleurs. `zoneUpdate` refaisait ainsi
l'interpolation du gaz à la main pendant que `zoneAt`, testée par quinze assertions, n'avait aucun
appelant — le patron du `respawn()` défini deux fois, avec la copie vivante du côté non testé.

---

## Bugs de conception, plus intéressants que les bugs de code

- **Le pot forfaitaire ressuscité par la couche monétaire.** MAXWIN a cessé de verser un forfait au
  dernier survivant quand le prix est devenu « la sacoche qu'on emporte » : `endMatch` crédite
  `cashoutPayout(pouch).net`, l'écran affiche « CARRIED OUT », et un test verrouille la règle. Six
  commits plus tard, `matchVerdict` a recalculé le pot entier par `payoutCents()` — la vieille règle,
  réécrite de bonne foi par quelqu'un qui lisait la fonction de paiement et non le jeu. Résultat :
  sur une table à 0,50 $, une victoire parfaitement honnête créditait $2,80 au joueur et écrivait
  `net_cents = 800` en base, donc un `ecart_cents` de −520 centimes, et un BEST affiché quatre fois
  trop grand au lobby. **Aucun test ne les a mis face à face parce que les tests n'exerçaient que la
  rafle complète — le seul point où les deux formules coïncident**, puisque c'est précisément ce qui
  fait du pot un plafond exact. La leçon n'est pas « écrire plus de tests » : c'est que deux règles
  qui décident du même nombre doivent être confrontées SUR TOUT LEUR DOMAINE, ou réduites à une
  seule. Ici, l'une des deux a été supprimée.
- **La qualité graphique décidait de la position des caisses.** `buildWorld` rendait son générateur
  semé dans `G.rng`, et la simulation y puisait ensuite : position des caisses, points de départ des
  vingt équipes, brawler de chaque bot, précision de chaque bot. Or ce générateur est d'abord
  consommé, dans `buildWorld` même, par le feuillage des buissons — et le nombre de feuilles par
  buisson vient du palier de qualité, c'est-à-dire de la machine. Sur la **même graine**, un
  téléphone en qualité basse et un ordinateur en qualité haute ne posaient donc pas les caisses au
  même endroit et ne jouaient pas contre les mêmes bots. Personne ne pouvait le voir : il n'existait
  aucune partie où deux appareils étaient censés voir le même monde, et l'invariant « même graine,
  même plan de zone » ne parlait que du gaz. Trouvé en écrivant les flux nommés du module 2 de la
  phase 02b, pas en jouant. La leçon est la même que pour les compteurs : **un générateur partagé
  entre le décor et les règles est une case qu'on écrase** — le nombre de tirages consommés par
  l'affichage est une dépendance invisible de la simulation. Le décor garde son générateur, il ne
  quitte plus `buildWorld`, et tout ce qui décide d'un fait tire dans un flux nommé.
- **Le compteur « 20 ALIVE » figé.** Avec 3 vies, un joueur tué reste en lice : le compteur ne
  bougeait qu'à la troisième mort. Corrigé en séparant **ALIVE** (debout maintenant) et **LEFT**
  (encore en lice).
- **Les cœurs qui donnaient des cubes.** L'apparence du cube de pouvoir avait été changée en cœur
  sans changer son effet. L'icône mentait. Les deux objets sont maintenant distincts : ⬢ cube
  (progression) et ♥ cœur (soin instantané).
- **Un clic qui coûtait deux munitions.** Le verrou de gâchette dure 0,63 s pour BOLT, or un clic
  humain « appuyé » dépasse cette durée. L'arme est devenue semi-automatique : le tir part sur
  l'événement d'appui, le tir continu ne démarre qu'après 0,35 s de maintien.
- **Le chat qui bloquait les commandes.** Le code se fiait à un drapeau interne au lieu du focus
  réel du champ. Cliquer ailleurs ne le remettait pas à zéro.
- **Icône illisible en petit.** Plusieurs propositions superbes en 512 px devenaient une tache à
  32 px. Toute icône se juge réduite, dans une grille, jamais isolée.
- **Le `maxlength` qui mangeait le code de connexion.** Le champ du code à six chiffres était borné
  à six caractères. Un code recopié depuis un mail arrive avec des espaces : le navigateur coupait
  avant que le nettoyage ne voie les derniers chiffres, et le bouton restait éteint sans rien dire.
  C'est la fonction qui isole les chiffres qui doit couper, pas le navigateur. Trouvé par le test
  navigateur, jamais par un test unitaire.
- **Le rafraîchissement en boucle.** Le jeton se rafraîchit deux minutes avant d'expirer. Si le
  fournisseur rendait un jeton déjà périmé, le délai suivant valait zéro et le jeu le martelait
  aussi vite que le réseau le permettait. Un plancher casse la boucle. Même origine : le test
  navigateur, en simulant une réponse qu'on ne peut pas demander à un vrai fournisseur.

---

## Bugs de frontière : ce qu'un pilote rend, et ce qu'une colonne accepte

Ceux-là n'existent qu'entre deux couches, et aucun des deux côtés n'a tort tout seul. Ils sont
séparés des précédents parce qu'ils ne se trouvent ni en relisant le code, ni en jouant.

- **`pg` rend les `bigint` sous forme de chaîne.** Il ne peut pas garantir qu'ils tiennent dans un
  nombre JavaScript, donc il n'essaie pas. Une graine rendue en chaîne est refusée par `seedFor`,
  qui repart alors sur la graine locale : **le joueur voit une autre carte que celle de son billet,
  sans le moindre message**. La conversion est écrite deux fois, dans `db-pg.js` et dans la liste
  blanche d'`app.js`, parce que la panne est silencieuse. `count()` et `sum()` ont le même
  comportement et c'est pire : une graine en chaîne fait au moins diverger la partie, une
  statistique en chaîne ne se voit qu'à l'écran, des semaines plus tard. Et `db-pg.js` n'étant
  jamais exécuté par les tests, c'est la **doublure** qui doit mentir comme le vrai pilote — sans
  quoi le test ne prouve rien.
- **Un entier « valide » qui ne tient pas dans sa colonne laissait la ligne ouverte.** Un rapport à
  3 000 000 000 passait la validation, puis faisait lever `22003` à Postgres : la route répondait
  500 et le billet restait `open`. Le joueur se retrouvait enfermé dans un billet mort jusqu'à
  l'expiration, puisqu'il n'en a qu'un à la fois. La borne haute de chaque entier vient donc du
  **schéma** (2 147 483 647) et non du jeu, et une garde relie chaque champ à sa colonne. Leçon :
  une validation qui ignore la largeur de la destination n'est pas une validation.
- **Le rang rendu est celui du joueur, pas celui de son équipe.** Le contrôle « rang ≤ nombre
  d'équipes » paraissait évident ; un joueur de Duo éliminé pendant que son coéquipier se bat
  encore annonce le nombre d'équipes **plus un**. La borne a été élargie plutôt que le joueur
  refusé. C'est le troisième contrôle de plausibilité faux à l'usage, après les deux que la
  spécification avait déjà écartés : **une règle de plausibilité se vérifie contre le code du jeu,
  jamais contre l'intuition.**

- **Une colonne « secrète » de 32 bits n'est pas un secret.** `seed_secret` portait
  `check (seed_secret between 0 and 4294967295)` : deux milliards d'essais tiennent dans une soirée,
  hors ligne, sans rien demander à personne. Elle est passée à **128 bits en hexadécimal** au module
  6 de la phase 02b, et son commentaire dit désormais la vérité — dans une architecture de rejeu, le
  client possède tout ce qu'il dessine, donc elle ne protège rien aujourd'hui et la simulation ne
  l'utilise pas. Elle reste pour le jour où le serveur décidera de quelque chose que le client n'a
  pas à savoir. Leçon : **une colonne qui porte un nom qui ment est pire que pas de colonne**, et le
  moment de la corriger est celui où aucune base n'a encore tourné.

Ces quatre-là partagent une cause : ce qui a été supposé d'un composant qu'on ne fait pas tourner.
Aucune base n'a jamais tourné ici, et c'est la dette la plus silencieuse du dossier — l'index unique
partiel, `name_key`, la clause `where status = 'open' and net_cents is null` et, depuis la phase
02b, la clé primaire `(match_id, seq)` qui arbitre le premier-écrit-gagne de `match_traces` n'ont été
éprouvés que contre une doublure qui **imite** les contraintes au lieu de les subir. Un test qui
passe contre la doublure prouve la doublure.

---

## Ce que l'utilisateur valide et rejette

- **Retour visuel immédiat par capture d'écran.** Les corrections passent par des captures
  annotées ; les rejets sont courts et directs (« ça ne va pas », « toujours trop gros »).
- **Compact et lisible avant tout.** Le HUD a été resserré plusieurs fois : trois panneaux empilés
  en haut à gauche masquaient précisément la zone d'où arrivent les adversaires.
- **Rien ne doit obstruer le jeu.** C'est le critère qui a tranché le placement du chat, des
  emotes, de la minimap et du compteur.
- **Esthétique cartoon assumée**, contours noirs épais, couleurs saturées, ombres portées.

---

## État à la V1

- 10 brawlers, 2 jeux, 5 modes, 4 tables, carte 152×152, un seul biome.
- 3 vies (2 en Resurgence), gaz en 4 phases, cubes de pouvoir et cœurs de soin.
- Profil avec pseudo et 20 avatars, chat texte avec réponses des bots, 8 emotes.
- Audio entièrement synthétisé : lobby, sas, partie, alarmes de zone, impacts.
- Qualité graphique adaptative à quatre niveaux, corrigée par les FPS mesurés.
- **117 tests**, sans dépendance.

## État après la phase 02a

- Le jeu n'a pas changé de nature : toujours un seul `index.html`, toujours jouable sans compte,
  sans serveur et sans réseau — graine comprise.
- `api/` détient les comptes, les profils, et depuis cette phase l'**identité** des parties :
  billet, verdict, statistiques par agrégat sur des lignes immuables. Aucune colonne solde.
- **290 tests sur le jeu, 104 sur l'API** sans rien installer, 113 avec `jose`. Aucune base, aucun
  réseau : tout est injecté dans `createApp()`.
- Toujours aucun euro, et le portefeuille reste une variable du navigateur.

## État après la phase 02b

- Le jeu n'a toujours pas changé de nature : un seul `index.html`, sans build, jouable sans compte
  ni serveur, graine comprise. Il contient désormais **trois** blocs `<script>` — `WBCore`, `WBSim`,
  `Game` — et les deux premiers sont testés dans Node, sans navigateur.
- **Le serveur rejoue la partie.** `POST /api/match/:id/result` refait la partie depuis la graine
  publique du billet et la trace des entrées du joueur, avec le même bloc `WBSim` que le navigateur
  exécute, et recalcule durée, kills, morts, rang, cubes et sacoche. `net_cents` sort de la partie
  rejouée ; `declared_net_cents` et `ecart_cents` restent une observation. **La forme de la route
  n'a pas changé d'une virgule**, comme la 02a l'avait promis.
- **Une ligne ne se clôt que sur un état terminal**, la conservation de l'argent est assertée au
  moment du règlement, un budget de calcul borne le rejeu, et huit refus nommés sortent en 400 ou
  409 sans jamais laisser un joueur enfermé dans un billet mort.
- **La divergence est mesurée, jamais punie** : la ligne est réglée et payée, marquée
  `digest_match = false`, et le taux de divergence est un agrégat exposé. Le grand livre de la phase
  03 ne lira que ce qui a convergé.
- **369 tests sur le jeu, 134 sur l'API** sans rien installer, 143 avec `jose`. Aucune base, aucun
  réseau, aucun navigateur : tout est injecté.
- **Toujours aucun euro, et cette phase n'ouvre aucune table en argent réel.** Le vol de temps
  devient impossible ; le vol de précision — aimbot, ESP — reste entier, et il est structurel.

## État après la phase 03

- Le jeu n'a toujours pas changé de nature : un seul `index.html`, sans build, sans bundler, sans
  React, **jouable sans compte ni serveur, graine comprise**. Trois blocs `<script>`, tous internes.
- **Le solde d'un joueur connecté est une SOMME d'écritures immuables en centimes entiers**, et il
  n'existe nulle part de colonne à écraser. Une écriture est une **ligne-transfert** — montant
  strictement positif, compte débité différent du compte crédité — donc la partie double est
  structurelle et la somme du livre est nulle par construction. Une correction est une
  **contre-passation** : aucun `update`, aucun `delete` sur `ledger_entries`.
- **La mise est débitée à l'ouverture du billet**, dans la même transaction que lui et sous verrou
  de ligne ; le règlement écrit la ligne et le gain ensemble ; un billet clos vide son séquestre. Le
  gain d'une ligne dont le rejeu a **divergé** va en quarantaine : visible, chiffré, jamais
  dépensable.
- **Une mise ne se rend que pendant la fenêtre de renoncement**, dix secondes à l'horloge du serveur,
  arbitrées par `WBCore.renonciationOuverte` et par elle seule. Passé cette fenêtre, le veilleur clôt
  sans rembourser et vide le séquestre vers `maison:contrepartie`. Le prix est écrit : le joueur
  honnête dont l'onglet meurt à la onzième seconde perd sa mise.
- **Le jeu lit son solde du serveur et ne l'écrit plus.** Deux économies vivent sur le même écran, et
  l'écran dit laquelle il montre : « Demo wallet » et son bouton de recharge hors ligne,
  « Credits » sans bouton en ligne. Treize refus nommés, tous en 400 ou 409, dont trois arrêtent le
  sas au lieu de laisser partir une partie gratuite.
- **395 tests sur le jeu, 204 sur l'API** sans rien installer, 213 avec `jose`. Aucune base, aucun
  réseau, aucun navigateur : tout est injecté.
- **LA DETTE LA PLUS SILENCIEUSE DU DOSSIER N'EST PAS SOLDÉE.** `api/db-check.js` et son job
  `services: postgres` existent ; le job n'a **jamais été vert**. La phase a livré la recette, pas le
  plat, et elle a en plus ajouté par-dessus les deux propriétés les plus difficiles à prouver du
  dépôt — le verrou de ligne qui sérialise deux onglets, et une clause de purge qui croise trois
  tables. **Un test qui passe contre la doublure prouve la doublure**, et cette phrase reste vraie
  au bout de la phase 03 comme elle l'était au bout de la 02b.
- **Toujours aucun euro.** Les comptes sont en crédits fictifs, dotés par la maison. La phase rend le
  **solde** inviolable ; elle ne rend pas la **partie** honnête — le vol de précision, aimbot et ESP,
  reste entier et structurel.

## Ce qui reste ouvert

- **Lobby mobile** : la version actuelle est une adaptation du desktop, pas une conception propre.
- ~~**Serveur autoritaire**~~ **Refermé par la phase 02b, les sept modules livrés.** Le serveur
  rejoue la partie et `net_cents` en sort. Ce qui reste ouvert derrière, et qui n'est pas la même
  chose : **le vol de précision.** L'aimbot survit entier — la trace porte une direction de visée par
  pas, et une visée parfaite ne se distingue pas d'un très bon joueur — et l'ESP est devenu
  **structurel** : dans une architecture de rejeu, le client possède tout ce qu'il dessine, donc il
  connaît le contenu de tout le butin de la carte dès la première seconde. Tant que les dix-neuf
  adversaires sont des bots, la seule victime en est la maison, à chaque partie. **Le solde, lui, a
  cessé d'être une variable du navigateur à la phase 03** — connecté, il est la somme des écritures
  du grand livre, et le jeu ne fait plus que la lire.
- **Aucune base n'a jamais tourné. C'était un PRÉREQUIS de la phase 03, et il n'a pas été tenu.**
  La phase a livré la RECETTE — `api/db-check.js`, un job `services: postgres` dans l'intégration
  continue — et le plat n'a jamais été servi : la machine de travail n'avait ni Postgres, ni Docker,
  et le job n'a jamais été vert. Pire, la phase a empilé par-dessus les deux propriétés les plus
  difficiles à prouver du dossier : le **verrou de ligne** `select id from users where id = $1 for
  update`, qu'une doublure mono-fil sérialise gratuitement, et la clause de la purge des traces, qui
  croise trois tables et recalcule un solde en SQL. **Un test qui passe contre la doublure prouve la
  doublure**, et cette phrase est plus chère aujourd'hui qu'elle ne l'était hier. Le premier qui
  pousse sur GitHub doit REGARDER le job `db` et rapporter ce qu'il dit.
- ~~**`match_traces` n'a aucune politique de conservation.**~~ **Refermé par la phase 03, module 4 :**
  `TRACE_RETENTION_JOURS` vaut 400, et la purge n'efface une trace que si les **quatre** conditions
  sont réunies — ligne réglée définitivement, écriture du grand livre posée, séquestre vide, délai
  écoulé — chacune éprouvée en la retirant seule. Ce qui reste ouvert derrière, et qui n'est pas la
  même chose : **qui a le droit de relire une trace.** Il n'existe ni rôle d'administration, ni
  journal d'audit ; à nommer avant la phase 04, avec « qui a le droit de contre-passer ».
- **Un déploiement se draine, il n'écrase pas les billets ouverts.** Décision d'exploitation, à
  ranger à côté de « la maison est la contrepartie de chaque pot ». Ce qui arrive quand on ne la
  prend pas est désormais visible : le rejeu refuse en `sim_version` et la partie n'est jamais
  enregistrée.
- ~~**Aucun test ne regarde le jeu tourner.**~~ **Refermé au module 5 de la phase 02b :** `node
  test.js` joue cinquante parties complètes — dix graines × cinq modes — du coup d'envoi à la
  dernière phase du gaz, sans navigateur. Ce qui reste ouvert derrière, et qui n'est pas la même
  chose : **aucun test ne regarde le jeu se VOIR.** Le HUD, la caméra, le fondu d'un buisson, un
  bouton qui répond au doigt — deux bugs de ce journal n'ont été trouvés que par un navigateur, et
  le harnais de partie ne les aurait pas attrapés. Le texte d'origine est conservé ci-dessous pour
  ce qu'il dit encore de vrai.
- **Aucun test ne regarde le jeu tourner.** Deux bugs de ce journal n'ont été trouvés que par un
  test navigateur, et il n'en existe pas de harnais. Depuis le module 3 de la phase 02b, `node
  test.js` fait bouger de vraies entités sur une vraie carte — mais des entités synthétiques, sur
  des directions scriptées : c'est la couche mouvement qui est couverte, pas une partie. Depuis le
  module 4, un **banc** fait aussi tirer, mourir, lâcher et ramasser vingt brawlers avec le vrai
  code, sur les quatre tables et les cinq modes : c'est l'arithmétique de la partie qui est
  couverte, pas sa dramaturgie — les bots y sont remplacés par une conduite de quelques lignes. Le
  trou se referme au module 5, pas avant. La seule preuve que le gaz déterministe n'a pas rendu les parties
  ennuyeuses reste un humain qui joue une partie entière.
- **La session de jeu réelle due après le module 1 de la 02b n'a toujours pas eu lieu**, et la phase
  03 est finie sans elle non plus. Elle a maintenant un **cinquième** point à juger, arrivé avec le
  module 5 de la phase 03 : **deux économies sur le même écran**, connecté et hors ligne. Ce que
  `node test.js` peut faire, il le fait — les deux fonctions du portefeuille sont exécutées, le
  module du billet est exécuté, le libellé du bouton QUITTER est exécuté au dixième de seconde sur
  toute la durée d'un sas — mais **il ne peut structurellement pas voir un bug d'écran**. Le lobby a
  été ouvert dans un navigateur, hors ligne et en ligne, jusqu'à une partie qui tourne et un écran
  de fin ; ce qui n'a pas été vu, faute de serveur déployé, c'est un vrai aller-retour avec une vraie
  API. Les **quatre** changements de ressenti de la 02b, eux, restent à juger : le pas fixe (module 1), la
  personnalité des bots qui a changé d'un coup (module 2), la portée réelle des tirs — la collision
  balayée fait toucher des tirs qui frôlaient, surtout de près et surtout avec les armes rapides
  (module 4) — et la quantification des entrées du joueur, visée au 1024e de tour (module 6). Les
  modules 3, 5 et 7 n'en ajoutent pas : ce sont des déplacements et des décisions de serveur. Aucun
  test ne peut départager les quatre, et le seul juge est un humain qui joue une partie entière, sur
  téléphone comme sur ordinateur. **C'est la dette la plus ancienne du dossier et elle est encore
  là.**
- **Qui a le droit de contre-passer.** Une contre-passation est le seul chemin de correction du
  grand livre, et personne n'a écrit qui peut l'emprunter : ni journal d'audit, ni rôle
  d'administration. Le premier incident réel se réglera à la main dans `psql`, un dimanche soir, et
  c'est ce jour-là que la règle « aucun `update` » tombe. À nommer avant la phase 04, avec la
  suppression de compte et le changement de pseudo tracés.
- **Le sort de la quarantaine**, et le seuil sur `ecart_cents` : renvoyés à la phase 06, sur des
  données réelles. La phase 03 produit ce qui manquait pour trancher — un rendement de quarantaine
  **en centimes** et non plus en nombre de lignes — et n'ajoute délibérément aucun motif de
  libération : un membre de liste fermée que personne n'écrit est une case en attente d'être créée de
  travers.
- **Le coût de la maison est désormais chiffrable, et il est plus gros qu'il n'y paraît.**
  `maison:contrepartie` le mesure partie par partie. Le risque n'est pas le chiffre, c'est de le
  voir apparaître et de le prendre pour un bug : sur une table à 10 $ en resurgence, cinquante
  sièges, une sortie parfaite fait verser 49 000 centimes à la maison pour 10 000 encaissés.
- **Cadre légal** avant tout argent réel, et la décision d'exploitation ci-dessus — la maison est
  la contrepartie de chaque pot — à trancher avant la phase 04.
- **Icône définitive** : plusieurs directions explorées, décision non figée.
