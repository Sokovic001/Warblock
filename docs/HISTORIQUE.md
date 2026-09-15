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

*Ce que la recette a trouvé ensuite, et pourquoi le raisonnement ci-dessus était juste et la mise en
œuvre fausse.* « Le client est toujours en avance » était affirmé sur un chronomètre qui ne mesure
pas le temps : `W.t` avance par tics de `setInterval(waitTick, 100)`, et les navigateurs brident ces
tics à 1 Hz dans un onglet caché. Vingt secondes réelles n'y faisaient avancer `W.t` que de deux, le
bouton promettait « LEAVE · REFUND STAKE », le serveur refusait en `409 fenetre_close`, et le jeu
avalait ce refus en silence. La promesse se lit désormais sur `performance.now() − W.clic` — une
horloge monotone, parce qu'un changement d'heure système n'a pas à décider d'un remboursement — et
`W.t` reste ce qu'il est, le chronomètre de la **mise en scène** : le passer en temps réel ferait
démarrer la partie sans le joueur au retour d'un onglet caché.

Deux autres termes manquaient à l'argument, et chacun coûte la même mise. **La latence ne joue pas
que dans un sens** : le vol aller de la demande de billet nous avantage, le vol retour du
renoncement nous désavantage, puisque le serveur date la fenêtre à sa réception. L'écran ferme donc
sa promesse une marge nommée avant le serveur, `RENONCE_MARGE_ECRAN_MS`, et la propriété tient tant
que ce vol retour reste sous la marge — écrit, plutôt qu'affirmé sans réserve. Et **un billet REPRIS
porte l'heure d'ouverture d'un sas précédent** : partir hors fenêtre garde le billet en main, un
second clic sur la table le fait resservir tel quel, le nouveau sas repart de zéro, et aucune
horloge de ce sas-là ne mesure l'âge du billet. Le serveur connaissait déjà la réponse — il calculait
`repris` sur ses trois chemins — il ne la disait pas au client.

Le test qui prétendait tenir la propriété était **vrai par construction** : il n'injectait qu'un
`openedAt` décalé vers l'avant, c'est-à-dire le seul des deux vols qui joue dans le bon sens, et le
banc du libellé fabriquait un `W` de deux champs où le temps réel valait le chronomètre par
définition. Aucune valeur de latence ne pouvait le faire échouer, pas même 10⁹. C'est le patron du
harnais qui recopiait les expressions de `faits`, et le journal l'a maintenant payé deux fois.

### Le compte des tests a décroché une SECONDE fois, et la règle de relecture n'a pas suffi — phase 03, recette

La recette de la 02b avait trouvé un seul écart entre ce que le dépôt dit et ce qu'il est : un
nombre de tests faux dans `README.md`. Elle en avait tiré une règle de relecture — « après une
phase, on relit les **quatre** endroits, pas les trois qu'on a touchés » — et écarté la correction
structurelle au motif que centraliser le compte demanderait de le générer, pour un nombre qui ne
décide de rien.

Une phase plus tard, **trois des quatre endroits sont faux**, et le quatrième est faux d'une autre
façon. `README.md`, `api/README.md` et la section « État après la phase 03 » de ce journal
annonçaient encore les chiffres de la 02b — 395 et 204 — alors que les suites en comptent 405 et
201. `CLAUDE.md`, lui, portait un chiffre juste attribué à la mauvaise colonne : il annonçait
« 210 sur l'API, aucune dépendance », puis « neuf de plus avec `jose` », ce qui promettait 219. La
réalité est 201 sans `jose` et 210 avec. Une erreur qu'aucune relecture attentive n'attrape, parce
que le nombre écrit **existe** — il est simplement du mauvais côté de l'installation.

Ce que la seconde occurrence apprend et que la première ne disait pas : la règle de relecture est
une discipline, et une discipline n'est pas un test. Le nombre ne décide toujours de rien, et c'est
précisément pour cela qu'il dérive sans que rien ne casse — la première page que lit un arrivant est
la seule du dépôt que rien ne vérifie. La correction structurelle reste écartée pour la même raison
qu'en 02b, mais l'arbitrage est désormais **écrit avec son prix** : on accepte que ce chiffre soit
faux entre deux recettes, et la recette est le seul moment où il redevient vrai. Si une troisième
phase le retrouve faux, c'est que le prix est trop élevé, et il faudra le générer.

### Ce que la recette de la 03 a laissé passer, sciemment : le crédit de l'écran de FIN

La recette a corrigé le crédit de sortie du **sas**, qui lisait `Auth.online()` au lieu de
`W.enLigne`, l'économie figée à l'entrée : un jeton mort au milieu du sas faisait rendre au
portefeuille de démonstration une mise que le séquestre du serveur détenait. Elle a écrit dans le
même geste, dans le banc de test, que `demoCredit` « a un second appelant légitime, l'écran de fin
de partie, qui doit continuer de le consulter » — **et cette phrase est une décision affirmée sans
raison écrite**.

Le scénario symétrique existe, et il est plus cher que celui qu'on a fermé : connecté au coup
d'envoi, le serveur a débité la mise au séquestre ; le jeton meurt **pendant la partie** ; le joueur
gagne ; `Auth.online()` répond désormais faux, donc `demoCredit(take.net)` crédite au portefeuille de
démonstration un gain que le grand livre n'a pas accordé — et ne l'accordera pas, puisque le rapport
ne partira jamais. En Resurgence à 10 $ ce gain vaut quarante fois la mise, là où le sas n'en valait
qu'une.

Ce qui retient la main, et pourquoi ce n'est **pas** réparé ici : hors ligne, le portefeuille de
démonstration est une variable que le bouton de recharge remet à `START_WALLET` en un clic, donc un
gain indu n'y vaut rien ; et ne pas créditer laisserait l'écran de fin annoncer « +6,40 CARRIED OUT »
au-dessus d'un solde qui ne bouge pas. Les deux options mentent, à des endroits différents. C'est un
arbitrage de conception, pas une réparation évidente, et une recette ne renverse pas une décision
écrite sur son seul jugement. Ce qui est **fautif**, en revanche, et ce qui reste à corriger : la
décision n'a ni raison écrite ni test, alors que sa jumelle en a deux. Il n'existe aucun `G.enLigne`
— l'économie figée au coup d'envoi — à côté du `W.enLigne` qui existe pour le sas, et
`startMatch` a pourtant un appelant unique.

### La référence d'une écriture est du TEXTE, et un gain contre-passé doit rester visible — phase 04a, module 1

Le module qui rend l'exposition de la maison calculable tenait en cinq constantes et trois fonctions
évidentes. La quatrième ne l'était pas, et c'est la seule qui méritait d'être écrite ici.

`ledger_entries.reference` est une colonne de **texte**. Toutes les écritures qui parlent d'un billet
n'y portent pourtant pas le même contenu : `mise`, `gain` et `remboursement` y écrivent
l'identifiant nu — `42` — mais `mouvementContrepassation` y écrit `<motifOrigine>:<refOrigine>`,
donc `gain:42`. Ce choix de la phase 03 est bon, et sa raison est écrite à côté de lui : on lit dans
le livre **ce qui** a été contre-passé sans faire une jointure.

Le piège est que la lecture évidente de l'exposition est une jointure `ledger → matches` par
`reference::bigint`. Sur les lignes de contre-passation, elle lève `22P02`. La correction évidente
de ce `22P02` est d'ajouter un filtre qui ne garde que les références numériques — et ce filtre
**ignore** exactement les lignes qui annulent un gain. Un gain contre-passé continuerait alors de
compter dans l'exposition d'un joueur, sur un chiffre que personne n'aurait de raison de soupçonner.

Ce qui rend le défaut coûteux n'est pas sa difficulté, c'est son **calendrier** : le module qui écrit
la requête n'est pas celui qui crée les lignes qui la cassent. Il naîtrait **vert**, et se révélerait
une phase plus tard, sur un plafond qu'on croirait tenir. C'est pour cela que la règle est une
fonction pure, `referenceBillet(motif, reference)`, **exhaustive sur la liste fermée des motifs** —
un septième motif la fait lancer au lieu de tomber dans un `else` — livrée avec sa traduction SQL
`REFERENCE_BILLET_SQL` **construite à partir des mêmes listes**, et testée contre les références que
les six mouvements produisent réellement, contre-passations comprises.

Deux détails ont failli passer, et ils sont notés pour la prochaine fois qu'on écrira une règle des
deux côtés à la fois. Le premier : la fonction rend une **chaîne** de chiffres, jamais un nombre. On
comparera du texte à `matches.id::text`, sans aucun `cast` ; un `bigint` ne tient pas toujours dans
un `Number`, et la conversion serait un arrondi silencieux sur la clé d'une pièce comptable. Le
second : dans l'expression SQL, le groupe des motifs doit être **non capturant**, parce que
`substring(texte from motif)` rend la première parenthèse **capturante** — capturer le motif rendrait
« gain » là où on attend « 42 », c'est-à-dire une lecture **vide** plutôt que fausse, donc
silencieuse.

**Ce que la règle ne couvre pas, écrit ici plutôt que laissé à découvrir** : contre-passer une
contre-passation produit `contrepassation:gain:42`, qui ne se ramène à aucun billet. Le double geste
n'a pas d'appelant — l'outil de la 04a corrige un mouvement d'origine — et l'élargir demanderait
d'élargir `REFERENCE_BILLET_SQL` du même coup, donc de re-décider des deux côtés ensemble. C'est un
préfixe à ajouter à une expression régulière le jour où quelqu'un ouvrira ce chemin, pas une reprise.

Le module se livre par ailleurs **sans un seul appelant**, et c'est la doctrine « le contrat avant le
brancheur », déjà employée en 02a pour `seedFor` et `matchFlow`. Son prix est le même et il est écrit
dans `docs/PHASE-04A.md` : si le module qui branche glissait, cinq constantes et quatre fonctions
resteraient du code que personne n'aurait vu tourner ailleurs que dans `api/test.js`. À ce stade,
**405 tests sur le jeu et 213 sur l'API** sans rien installer, 222 avec `jose`.

### L'attente réelle exigée d'un encaissement était NULLE — phase 04a, module 2

La 02a avait écrit ses tolérances larges avec leur raison — « aucun argent n'est en jeu, accepter une
partie douteuse coûte une ligne de statistique, refuser une partie honnête coûte un joueur » — et
avec leur date de péremption, dans le code : « elles se resserreront quand elles protégeront de
l'argent ». Ce module est cette date.

Ce qui a été trouvé, et il n'y avait rien à deviner, seulement à relire une inéquation dans l'autre
sens. `matchVerdict` portait déjà un contrôle nommé `chronometre` : `r.seconds > ecouleS −
LOBBY.wait + ENVELOPPE.margeHorlogeS`. C'est une borne **haute** — la partie annoncée ne peut pas
être plus longue que le temps écoulé. Retournée, c'est exactement un **plancher** : `ecouleS >=
LOBBY.wait + r.seconds − marge`. Or la marge valait 120 et le sas 25 : un encaissement Resurgence
annoncé à 30 secondes simulées satisfaisait `30 <= ecouleS − 25 + 120` **dès `ecouleS = 0`**.
L'attente réelle exigée était donc nulle, et le seul autre plancher d'horloge de la fonction ne
s'armait que dans la branche `victoire` — tout le chemin d'encaissement, celui qui porte le pire cas
de 39 000 centimes d'exposition, n'en avait aucun.

**Ce n'était donc pas une inéquation nouvelle à écrire, c'était une marge à resserrer là où elle
protège de l'argent**, et c'est ce qui rend ce module si petit. `WBCore.horlogePlancher(billet,
rapport, maintenant)` est la jumelle exacte du contrôle existant : pure, elle ne lit aucune horloge,
elle la **reçoit**, comme `renonciationOuverte`. Sa marge est nommée à part,
`ENVELOPPE.margePlancherS = 30`, et pas confondue avec la large : `margeDureeS` et `margeHorlogeS`
restent à 120 pour les chemins qui ne paient rien, parce qu'un joueur qui perd n'a rien à gagner à
mentir sur son horloge et qu'un onglet en arrière-plan reste beaucoup plus fréquent qu'un tricheur.

Deux décisions d'écriture méritent d'être retenues, parce qu'elles ont chacune failli devenir une
seconde règle. La première : le refus est armé **une seule fois**, après le calcul du montant et sous
la condition `netCents > 0`. Cela le pose sur l'encaissement **et** sur la victoire sans le dupliquer
— la branche `victoire` garde ses deux planchers à elle, `(vies − 1) × RESPAWN` puis `margeVictoireS`,
qui mordent plus tôt et sous leur propre motif — et cela le retire de tout règlement qui ne sort rien
de la caisse. Un test tient le fil du rasoir : une sacoche d'un centime paie zéro après commission et
n'est pas regardée, deux centimes en paient un et arment le plancher. La seconde : `Number(null)` vaut
zéro, donc un rapport absent serait devenu une partie de zéro seconde, c'est-à-dire un plancher que
tout franchit. Un rapport illisible rend `false`, comme un billet sans heure d'ouverture.

**Ce que ce module ne fait pas, et il faut le lire comme tel.** Il ne rend pas la partie honnête. La
partie est une fonction **pure** de `seed_public`, que le client reçoit avec son billet, et
`REPLAY_BUDGET_MS = 2000` prouve qu'elle se rejoue en quelques centaines de millisecondes : chercher
hors ligne la trace qui maximise l'argent emporté ne demande aucun talent et se parallélise. C'est
l'attaque la moins chère du dossier — plus forte que l'aimbot et l'ESP nommés depuis la 02b — et
c'est elle qui dimensionne le plafond de la 04a. Le plancher la ramène au **rythme d'un joueur** ; il
ne la ferme pas. La doctrine qui la fermerait — on ne refuse pas la triche, on la joue bornée des
deux côtés, puisque le serveur exécute le même bloc — reste renvoyée hors phases.

Rien de tout cela ne touche la simulation : `SIM_VERSION` ne bouge pas, le sas ne reçoit pas un
octet, et `api/app.js` n'a pas changé d'une virgule — un refus de verdict clôt déjà la ligne en
`rejected` et rend le règlement relu depuis la ligne, jamais un 500, et le billet suivant s'ouvre
dans la foulée. `api/core.js` n'a pas bougé non plus : `horlogePlancher` est appelée par
`matchVerdict`, pas par `app.js`, donc elle n'a rien à faire dans la liste `ATTENDUS`, qui ne garde
que les noms qu'`app.js` consomme lui-même. Aucune clause SQL n'a été touchée, donc le job `db` n'est
pas concerné par ce module. À ce stade, **410 tests sur le jeu et 215 sur l'API** sans rien
installer, 224 avec `jose`.

### Une colonne DORMANTE, et c'est exactement pourquoi elle est créée maintenant — phase 04a, module 3

`matches` enregistre désormais `paid_seats` : combien de sièges de la table un humain a payés.
`integer not null`, borne `check (paid_seats between 1 and seats)`, écrite par le serveur et figée à
l'ouverture du billet — le même patron que `seats`, `team_size` et `sim_version`, et le même test :
un corps portant `paidSeats: 7` écrit une ligne **strictement identique** à celle d'un corps
minimal. Le chemin `repris` ne la réécrit jamais, comme il n'écrit jamais une seconde mise.

**Elle vaut 1 sur toutes les lignes, et rien ne la lit.** Un billet **est** une table tant qu'il
n'existe pas d'identifiant de table partagée : le seul humain assis est celui qui ouvre le billet,
les dix-neuf autres sièges sont des bots, qui ne misent rien. Aucun chemin de production n'écrira
autre chose que 1 avant la phase 05.

La raison d'écrire quand même est celle qui fige `seats`, et elle tient en une phrase :
**après coup, rien ne permet de retrouver le chiffre.** L'exposition de la maison est la différence
entre ce qui sort de la caisse et ce qui a réellement été misé — c'est l'arbitrage écrit dans « La
maison est la contrepartie de chaque pot » — et sans ce compte elle cesse d'être **attribuable** dès
le premier remplissage partiel. Une colonne créée aujourd'hui coûte une ligne de schéma sur une base
qui n'a jamais tourné ; créée après, elle coûte une reprise de données et un trou définitif dans
l'historique.

**Le piège de ce module était de lui inventer un lecteur pour qu'elle ait l'air exercée**, et il est
consigné parce qu'il est séduisant : un agrégat qui tirerait de `stake_cents × paid_seats` un montant
**notionnel**, posé à côté du montant **réalisé** qu'on lit sur le grand livre. Ce sont très
exactement les deux nombres qu'on finit par confondre, et un seul des deux est de l'argent. Le
dossier avait déjà tranché le même cas à propos de `seed_secret` — « elle ne sert à rien en 02a, et
c'est exactement pourquoi elle est créée maintenant » — et le refus du motif `depot` dit la même
chose dans l'autre sens : on enregistre un **fait qui varie et se perd**, on ne crée pas la case
vide d'une **décision qui n'existe pas encore**. C'est aussi pour cela que `matches` ne reçoit aucun
drapeau d'éligibilité aux tables réelles : sa place, le jour venu, est sur `users`, à côté de la
vérification d'identité. La justification est écrite **au-dessus de la colonne**, dans
`api/schema.sql`, et une garde textuelle vérifie qu'elle y reste.

**Ce qui n'a de preuve qu'en intégration continue, et c'est nommé plutôt qu'enjolivé.** La borne
regarde **deux** colonnes ; rien, dans un objet JavaScript, ne relie `paid_seats` à `seats`. La
doublure d'`api/test.js` l'**imite** — elle lève un `23514` nommé, comme elle imite déjà les largeurs
`integer` et la grammaire des comptes — mais elle ne la **subit** pas, et un test qui passe contre la
doublure prouve la doublure. C'est `api/db-check.js` qui éprouve le refus réel : zéro siège payé,
un négatif, vingt et un sièges sur une table qui n'en porte que vingt, tous refusés par
`matches_paid_seats_borne` ; un et vingt acceptés. **Ce module touche une clause SQL, donc le job
`db` le concerne**, et il n'a pas pu être lancé sur la machine de travail — aucune Postgres n'y
tourne. Le dernier passage vert connu reste celui du 2026-09-15 (run 34894629071), et il est
antérieur à cette colonne.

Les cinquante parties de bout en bout la portent toutes à 1, sur les cinq modes, les quatre tables
et les cinq issues, et `ledgerReconcile` reste sans grief à chaque étape. Le jeu n'a pas changé d'un
octet : `index.html` n'est pas touché, la colonne ne part pas au client, et il n'y a pas de
dépendance nouvelle. À ce stade, **410 tests sur le jeu et 217 sur l'API** sans rien installer,
226 avec `jose`.

### La mesure devient une borne, et le sas dit laquelle — phase 04a, module 4

Le grand livre **mesurait** l'exposition de la maison depuis la phase 03 ; le module 1 de cette
phase l'a rendue **calculable**, sans appelant. Ce module la **branche** : `POST /api/match` refuse
désormais en `409 plafond`, et la partie ne part pas hors ligne.

**Le pire cas d'un billet est calculé par le JEU et passé en paramètre.** `api/ledger.js` porte deux
gardes textuelles — aucun `require`, aucune arithmétique de commission — donc le net maximal ne peut
venir que de `WBCore.cashoutCents(WBCore.purseBound(mise, sièges).maxCents)`. `api/app.js` le calcule
une fois, le donne au fusible et à `db.createMatch`, et personne ne le recalcule : même discipline
que `mouvementGain`, qui reçoit brut, commission et net sans les refaire. `cashoutCents` et
`purseBound` entrent du même coup dans la liste `ATTENDUS` d'`api/core.js` — ils sont désormais sur
le chemin d'un **refus**, donc leur disparition doit casser au démarrage du serveur et pas au premier
`POST` d'un joueur.

**Les deux nombres n'ont pas la même nature, et les traiter pareil coûtait la section critique la
plus disputée du système.** Le **plafond par joueur** est EXACT : il se lit dans la transaction
d'ouverture, **après** le verrou `select id from users where id = $1 for update`, parce que c'est ce
verrou qui sérialise deux onglets du même joueur, et parce que son agrégat est borné par les billets
d'un seul joueur sur vingt-quatre heures — ce que la requête a mis un module de plus à devenir
vraiment : elle ne restreignait au joueur qu'APRÈS la jointure, sur une expression qu'aucun index ne
couvrait, donc elle balayait les écritures de maison de TOUS les joueurs de la fenêtre. Il a fallu
poser le prédicat dans la sous-requête et un index d'expression, `ledger_entries_billet_fenetre_idx`,
et faire mesurer à `api/db-check.js` les lignes réellement lues au lieu de refuser un `Seq Scan` —
un bitmap sur cent mille lignes n'en est pas un, et passait. Le **fusible global** est APPROCHÉ : c'est un
interrupteur, pas un invariant, et le lire sous ce verrou ferait de chaque ouverture de billet un
agrégat **non borné** sur la table qui grossit le plus vite du dépôt. Le dépôt a déjà payé ce genre
de chose une fois — `GET /api/me` retenait un client du bassin assez longtemps pour mettre en file le
renoncement d'un **autre** joueur au-delà de sa fenêtre de dix secondes. Il est donc lu **hors
transaction**, au plus une fois toutes les `FUSIBLE_RAFRAICHI_S` secondes, la valeur gardée en
mémoire du processus entre deux lectures, sur l'**horloge injectée** — donc sa cadence se teste sans
attendre. Il a le droit d'être en retard d'une minute, et ce retard vaut au plus ce qu'une minute
d'ouvertures peut engager.

**La requête de fenêtre ne fait aucun `cast` sur la référence, et c'est le piège de la phase.**
`ledger_entries.reference` est du **texte**, et une contre-passation y porte `gain:42` : une jointure
par `reference::bigint` lèverait `22P02` sur ces lignes-là, une jointure qui les **filtre** les
ignore — c'est-à-dire qu'un gain annulé continuerait de peser dans l'exposition et refuserait un
joueur pour de l'argent qu'il n'a jamais reçu. La requête **interpole** `REFERENCE_BILLET_SQL`,
exportée par `api/ledger.js`, et compare à `matches.id::text` ; les comptes et les motifs lui
arrivent en **paramètres**, depuis les mêmes listes que lit `expositionDe`. Deux gardes textuelles le
tiennent : l'interpolation est bien celle-là, et aucune seconde écriture de la règle n'est apparue à
côté. Un détail qui ne se serait vu qu'en production est écrit dans le code : l'expression est
calculée dans une **sous-requête sur `ledger_entries` seule**, parce qu'elle nomme `motif` sans le
qualifier et que `matches` porte elle aussi un `motif` — écrite dans le `join`, elle sortait en
`42702`.

**Les deux index de lecture du livre passent à deux colonnes** — `(compte_debit, cree_le)` et
`(compte_credit, cree_le)` — sous de nouveaux noms, avec le `drop index if exists` des anciens. Une
fenêtre glissante lue à chaque ouverture de billet porte un compte **et** une date ; sur un index qui
ne connaît que le compte, Postgres remonte toutes les écritures de `maison:contrepartie` depuis le
premier jour pour n'en garder qu'une journée. Aucune base de production n'existe, donc ce renommage
coûte zéro aujourd'hui et une reprise de données après le premier euro — la même fenêtre que celle de
`seed_secret` passée à 128 bits.

**Un seul code de refus, deux portées, et c'est le MESSAGE qui lit la portée.** `plafond` entre dans
la liste fermée `WBCore.REFUS_SAS`, qui passe de trois à quatre membres : le serveur a instruit la
demande et l'a rejetée, rien n'a été débité, donc le sas s'arrête au lieu de laisser partir une
partie gratuite — laisser filer ferait jouer gratuitement celui qu'on vient de borner. Un seul code,
parce que le sas n'a qu'un comportement à tenir. Mais **une seule phrase mentirait dans un cas sur
deux** : « prends une table moins chère » est faux quand c'est le fusible global qui a sauté. La
réponse porte donc `portee`, plus `expositionCents`, `plafondCents` et `fenetreHeures`, en 409 comme
tous les refus nommés de cette API. **Portée absente ou illisible : on rend le message de la
maison**, délibérément — promettre une table moins chère quand aucune ne marchera renvoie le joueur
cliquer en boucle sur un lobby qui a l'air cassé ; dire « plus tard » à quelqu'un qu'une table moins
chère aurait dépanné lui coûte quelques minutes.

**Deux décisions d'écriture prises dans ce module, et elles méritent d'être relues.**

La première : **le verdict ne s'applique qu'à l'ouverture d'un billet NEUF.** Le chemin `repris` —
rejeu de la clé du client, ou billet déjà ouvert rendu tel quel — ne passe pas par lui. Refuser un
billet que le joueur **détient**, mise débitée, l'enfermerait dedans jusqu'à l'expiration, puisqu'il
n'en a qu'un à la fois : c'est la leçon du `22003`, et c'est aussi la règle écrite de la phase — un
billet déjà ouvert n'est jamais cassé rétroactivement. Le corollaire est gardé par un test négatif :
**aucun chemin de règlement ne peut produire le code `plafond`**, garde textuelle sur `app.js` et sur
`db-pg.js`, plus un parcours des routes qui closent une ligne. Refuser au règlement serait voler une
partie gagnée, et c'est irréparable.

La seconde, et c'est une **limite**, pas une propriété : le fusible global, lui, est lu **avant** de
savoir si la demande sera un rejeu. Quand il saute, il refuse donc aussi un joueur qui redemandait
simplement son billet déjà ouvert après une réponse perdue. C'est cohérent avec ce qu'il est — une
alerte qui refuse tout le monde — mais il faut le savoir : pendant un déclenchement, un billet ouvert
n'est pas récupérable par cette route, et sa mise reste au séquestre jusqu'à l'expiration.

**Ce que la spécification annonçait et qui était faux, corrigé plutôt que contourné.** Elle écrivait
qu'un refus `plafond` ne consomme « pas même une graine ». C'est vrai de la portée `maison`, refusée
avant les deux tirages — ce n'est **pas** vrai de la portée `joueur`, qui se décide dans la
transaction, donc après. Les deux exigences étaient en tension, et c'est « sous le verrou » qui
gagne, parce que c'est elle qui rend le plafond exact. Le prix est nul : un joueur refusé n'obtient
**aucun** billet, donc aucune carte, et la source de graines est un générateur, pas une suite finie.
Le refus `fonds` fait exactement pareil depuis la phase 03. Le test l'**asserte** au lieu de le taire.

**Ce qui n'a de preuve qu'en intégration continue.** Deux cas nouveaux dans `api/db-check.js` :
**deux ouvertures simultanées qui ne franchissent pas le plafond à deux** — la propriété qu'une
doublure mono-fil sérialise gratuitement, et qui éprouve au passage la requête réelle contre
Postgres, `42702` compris — et un **`explain (format json)` qui refuse tout `Seq Scan` sur
`ledger_entries`**, sur quarante mille lignes de lest, seule façon de prouver que les deux index
**servent**. **Ce module touche des clauses SQL, donc le job `db` le concerne**, et il n'a pas pu
être lancé sur la machine de travail : ni Postgres, ni docker, ni `psql`, ni `gh`. Le dernier passage
vert connu reste celui du 2026-09-15 (run 34894629071), antérieur à `paid_seats` comme à ces deux
index. À ce stade, **412 tests sur le jeu et 227 sur l'API** sans rien installer, 236 avec `jose`.

### La contre-passation reçoit son unique appelant, et il n'est pas une route — phase 04a, module 5

`mouvementContrepassation` existait depuis la phase 03 et n'avait **aucun appelant**. Cette entrée
ferme le point ouvert qui portait son nom : « personne n'a écrit qui peut l'emprunter : ni journal
d'audit, ni rôle d'administration. Le premier incident réel se réglera à la main dans `psql`, un
dimanche soir, et c'est ce jour-là que la règle "aucun `update`" tombe. »

**La correction est un OUTIL, `api/operateur.js`, en ligne de commande.** Une route d'administration
est une surface d'attaque **permanente** pour un geste qui arrive deux fois par an, et elle
demanderait une authentification de second ordre — un rôle dans `users`, un second facteur — que rien
d'autre du dossier ne justifie. L'opérateur détient déjà les identifiants de la base : on ne lui
accorde rien qu'il n'ait pas. C'est le même patron que « il n'existe aucune route
`POST /api/credits` », et la même garde textuelle le tient : `api/app.js` ne charge jamais l'outil, ne
nomme ni `contrepass`, ni `ledger_audit`, ni `/api/admin`, et sa table de routes vaut toujours
exactement `/api/match` et `/api/me`. Écarté : `POST /api/admin/contrepassation` avec un rôle en
base ; et le statu quo, c'est-à-dire le `psql` du dimanche soir.

**L'outil sait LIRE avant de savoir écrire, et `montrer` arrive en premier.** Ce n'est pas un ordre de
présentation, c'est la raison d'être du module : le premier geste d'un incident réel n'est pas de
corriger, c'est de regarder. Trois lectures — les jambes d'un mouvement par `(motif, reference)`, un
billet avec ses écritures et son séquestre, l'exposition d'un joueur sur la fenêtre — et elles
n'écrivent **rien**, pas même une trace. Un outil qui n'aurait que des verbes d'écriture renverrait
l'opérateur dans `psql` exactement le soir qu'on cherche à éviter.

C'est `montrer exposition` qui répond à « pourquoi ce joueur a-t-il été refusé en `plafond` », et
**pas** `montrer billet` : un refus `plafond` ne laisse aucune ligne dans `matches` et le corps du 409
ne porte aucun identifiant, donc il n'y a pas de billet à relire. Le diagnostic part du joueur. Cette
phrase-là a d'abord été écrite à l'envers, dans trois fichiers à la fois, et `montrer billet <id>`
répondait « aucun billet <id> » sur le seul cas qu'on lui avait assigné. `montrer billet` dit la
**marge que le joueur avait à l'ouverture de ce billet** — et il la disait fausse pour une raison qui
mérite d'être retenue : la requête était bien celle qui refuse, mais ce ne sont pas la même *requête*
mais les mêmes **paramètres** qui font un chiffre. Elle était ancrée sur l'horloge courante quand
`createMatch` décide sur `opened_at`, donc un gain posé avant l'ouverture pesait dans la fenêtre du
refus et zéro dans celle de l'outil dès le lendemain.

**L'argent et sa justification vivent ou meurent ensemble.** `ledger_audit` — quand, par qui,
pourquoi, le `(motif, reference)` d'origine, la référence posée, les jambes, le montant — est en
insertion seule et partage la **transaction** de l'écriture. Une raison consignée après coup peut ne
jamais l'être : le shell se ferme, la connexion tombe, l'opérateur est appelé ailleurs — et une
contre-passation sans raison est indistinguable d'une erreur de manipulation. Un fichier de journal
ou une sortie de terminal ne partagent aucune transaction : écartés pour cela. La table porte un
**`geste`** plutôt que d'être une table `contrepassations`, parce que le module 6 y écrira
l'anonymisation d'un compte — même registre, geste manuel et rare fait par qui détient les
identifiants. Mais sa liste de gestes est **fermée à un membre aujourd'hui** : l'y ajouter d'avance
serait une case en attente d'être créée de travers, ce que le dossier refuse depuis le motif de
libération de quarantaine. Coût chiffré de l'ajout au module 6 : une valeur dans le `check`, une dans
`AUDIT_GESTES`, un test.

**La partie qui décide est PURE, et elle ne vit pas dans le pilote.**
`planCorrection(transferts, { par, raison, billet })` est dans `api/ledger.js`, donc entièrement
testable sans base. Elle **rend** un refus nommé plutôt que de lancer : un opérateur qui lit une pile
d'appels un dimanche soir n'apprend rien, et ces refus sont des cas normaux — un couple qui ne
désigne rien, une option oubliée. Les blancs ne comptent pas dans la raison : sinon « pourquoi »
deviendrait une case à cocher, et une espace suffirait à la cocher.

**Un mouvement portant sur un billet encore `open` n'est pas contre-passable**, et le refus s'appelle
`billet_ouvert`. C'est le seul cas qui laisserait un séquestre incohérent avec son statut : sur une
ligne `open`, `solde(enjeu:<id>)` doit valoir la mise, et contre-passer la mise le viderait quand
contre-passer un gain le remplirait. `ledgerReconcile` produirait alors un grief sur une ligne que
personne n'a touchée. **Le cas où l'incident EST un billet ouvert coincé se traite par la clôture
normale — le veilleur — et c'est écrit dans l'aide de l'outil** pour que personne ne le cherche du
côté de la correction du livre. Ne pas relire la ligne n'est pas une façon de contourner le
contrôle : sans elle, on refuse (`billet_inconnu`), on ne suppose pas.

**Une dette du module 1 est soldée en FERMANT le chemin, pas en élargissant la règle.** Contre-passer
une contre-passation produit la référence `contrepassation:gain:42`, que `referenceBillet` et sa
traduction SQL ne ramènent à **aucun** billet : l'écriture cesserait de compter dans l'exposition, et
le plafond serait faux sans que rien ne le dise. `docs/PHASE-04A.md` chiffrait les deux réponses — un
préfixe `(?:contrepassation:)*` des deux côtés plus un test, ou la fermeture. On ferme, parce que le
geste n'a aucun usage : une correction fautive se corrige sur le **mouvement d'origine**. Le refus
s'appelle `double_contrepassation`, et un test vérifie que la règle SQL n'a pas été élargie d'un seul
côté.

**Rejouer l'outil ne pose rien, et il le DIT.** La clé `(motif, reference, compte_debit,
compte_credit)` refuse la seconde pose ; ce `23505` devient « DÉJÀ POSÉE ». Sortir en erreur sur un
geste idempotent est très exactement ce qui fait rouvrir `psql` pour « vérifier ».

**Un grief LÉGITIME reste après une contre-passation de gain, et il est nommé plutôt que tu.**
Contre-passer le gain d'une ligne réglée **réhabite** son séquestre : `ledgerReconcile` dit alors « le
séquestre n'est pas vidé », et il a raison. L'outil corrige le livre, il ne décide pas de la suite —
c'est à l'opérateur de poser le mouvement juste, ou de faire clore la ligne. Le test l'asserte au lieu
de le taire. Ce qui retombe en revanche **exactement** : les quatre comptes touchés, au centime, le
zéro global du livre, et l'exposition — un gain contre-passé ne compte plus.

**Ce qui n'a de preuve qu'en intégration continue, et c'est le cœur du module.** « L'audit qui échoue
ne laisse aucune contre-passation » est vrai dans `api/test.js` parce qu'un mono-fil JavaScript décide
de l'ordre de ses `await` et défait ce qu'il vient de poser — c'est très exactement le genre de
propriété qu'une doublure flatte, et la phase 03 a payé cette leçon une fois. `api/db-check.js`
reçoit donc deux cas : l'audit qu'on fait échouer sur une **vraie** contrainte, avec Postgres pour
seul arbitre du `rollback`, et la clé unique qui refuse **réellement** la seconde pose ; plus cinq
refus de `ledger_audit` nommés par leur contrainte. **Ce module touche des clauses SQL, donc le job
`db` le concerne, et il n'a pas pu être lancé sur la machine de travail** : ni Postgres, ni docker, ni
`psql`, ni `gh`, vérifié une fois de plus. Le dernier passage vert connu reste celui du 2026-09-15
(run 34894629071), antérieur à `paid_seats`, aux deux index de fenêtre et à `ledger_audit`. À ce
stade, **412 tests sur le jeu et 237 sur l'API** sans rien installer, 246 avec `jose`.

### Un compte ne s'efface pas, il s'anonymise — phase 04a, module 6

Deux lignes de `schema.sql` dataient de la phase 01 et personne ne les avait relues depuis :
`matches.user_id … on delete cascade` et `match_traces.match_id … on delete cascade`. Écrites, elles
étaient justes : `matches` ne portait alors aucun montant, et effacer un joueur emportait des lignes
de statistique. La phase 03 les a rendues fausses **sans les toucher** — c'est la forme de défaut la
plus silencieuse du dossier, et c'est la seconde fois qu'elle se présente.

Depuis le grand livre, ces lignes sont **les pièces justificatives de mouvements d'argent qui, eux,
restent**. `ledger_entries` est en insertion seule et nomme ses comptes avec `users.id` et
`matches.id` : `joueur:<id>:disponible`, `enjeu:<match_id>`. Un `delete from users` détruisait donc
la pièce en laissant l'écriture — immortelle, incorrigible autrement que par contre-passation —
pointer sur une ligne morte. Les deux cascades sont passées en `restrict` : la suppression **échoue**
au lieu de se propager. Écarté : l'effacement réel avec purge des écritures, qui détruit la partie
double ; et « ne jamais supprimer de compte », qui est une règle qu'aucun code ne tient, donc pas une
règle.

**Ce qui remplace la suppression est une RÉÉCRITURE SOUS CONTRAINTES, et c'est le point où ce module
se serait trompé.** « Anonymiser » se lit comme « effacer des colonnes », et aucune colonne de `users`
ne peut partir : `auth_id text not null unique`, `email not null`, `name not null`, `name_key text
not null unique`, plus `check (char_length(name) between 2 and 14)` et
`check (char_length(name_key) between 1 and 14)`. On écrit donc à la place des valeurs qui ne
désignent plus personne et satisfont quand même la colonne : `anonyme:<id>`, `anonyme+<id>@invalid`
— `.invalid` est un domaine de premier niveau **réservé**, donc jamais routable — `x<id en base 36>`,
et la clé dérivée du nom par `WBCore.nameKey`, jamais écrite à côté. `avatar` redevient `''`,
`country` redevient `null`.

**`users.id` SURVIT, et c'est tout le module.** Le déplacer ferait de `joueur:<id>` et
`enjeu:<match_id>` des comptes désignant des lignes qui n'existent plus, sur un livre qu'on ne peut
pas corriger. Un test le vérifie sur un identifiant de dix-neuf chiffres, et `ledgerReconcile` ne
produit aucun grief avant comme après.

**La base 36 n'est pas une coquetterie, et le `BigInt` non plus.** Un `bigserial` monte à
9 223 372 036 854 775 807, soit treize chiffres en base 36 : `x` plus treize tient **exactement** dans
les quatorze caractères de la colonne, là où la base 10 en aurait demandé vingt. Et l'identifiant se
convertit en `BigInt` et jamais en `Number` : au-delà de 2^53, `Number` arrondit en silence, deux
comptes voisins recevraient le même nom, donc la même `name_key`, donc une collision que rien
n'explique. Le pilote Postgres rend les `bigint` en **chaîne** précisément pour cela ; on ne défait
pas sa précaution. Le test l'éprouve sur le maximum, et compare au résultat que `Number` aurait rendu.

**Le nom est calculé en JavaScript, pas en SQL**, et c'est le seul endroit où `WBCore.nameKey` et la
contrainte de quatorze caractères se lisent ensemble. `planAnonymisation` est pure et vit dans
`api/ledger.js`, comme `planCorrection` ; `nameKey` lui est **injectée**, parce que ce fichier porte
une garde qui lui interdit tout `require`. C'est `api/operateur.js` qui charge `WBCore` et la lui
passe : il n'existe jamais deux écritures de « quelle est la clé de ce pseudo ».

**Une collision sur `name_key` est DITE, et l'outil s'arrête.** Quelqu'un peut porter le pseudo `x1`.
`findOrCreate` réessaie avec un suffixe à l'inscription, et c'est le bon geste **à cet endroit-là** —
il arrange un joueur qui ne remarquera rien. Ici, ce serait décider à la place d'un opérateur, sur un
geste rare, manuel et qui ne se défait pas : l'`auth_id` d'origine n'est écrit nulle part ailleurs.

**L'ancien pseudo redevient disponible, et c'est voulu.** Corollaire à connaître : l'historique d'un
joueur se lit alors sur son `id` et jamais sur son nom. Toute requête qui afficherait un pseudo depuis
une jointure confondrait deux personnes — un test le montre en faisant reprendre le pseudo libéré par
un compte neuf, et en vérifiant que le billet de l'ancien reste attaché à son identifiant.

**La trace partage la transaction, et elle ne garde PAS ce qu'elle efface.** `ledger_audit` reçoit un
`user_id`, clé étrangère `restrict` vers `users`, et `AUDIT_GESTES` passe à deux membres — le second
entre le jour où quelque chose l'écrit, pas avant, exactement comme le module 5 l'avait chiffré : une
valeur dans le `check`, une dans la liste, un test. Une contrainte jumelle de celle des
contre-passations, `ledger_audit_anonymisation_complete`, **exige** le compte et **interdit** les cinq
colonnes d'argent : une anonymisation ne bouge pas un centime, et une ligne qui porterait les deux
moitiés se lirait comme une correction du livre. Les cinq colonnes sont `null` et non zéro — `null` se
lit « pas de montant », `0` se lirait « un montant nul ». Ce que la trace ne garde pas : l'ancien
email, l'ancien `auth_id`, l'ancien pseudo. Un journal qui les conserverait n'anonymiserait rien.
L'opérateur, lui, les a vus : l'outil montre avant d'écrire, et la sortie de terminal ne va nulle part
en base.

**LA SURFACE DE RÉGRESSION DE CE MODULE EST VIDE, et il fallait le dire plutôt que prétendre l'avoir
prouvé.** Il n'existe aujourd'hui aucune route ni aucune méthode qui supprime un compte : le seul
`delete` du pilote reste la purge nommée de `match_traces`. Le passage en `restrict` ne peut donc rien
casser — mais « aujourd'hui » est une date, pas une propriété, et c'est un **test** qui l'affirme, pas
une lecture. Son unique effet observable est un refus, et un refus de contrainte ne se constate que
contre une vraie base.

**Le trou qui reste, nommé et chiffré.** `findOrCreate` cherche par `auth_id`. Un joueur anonymisé qui
se reconnecte avec le même email obtient une ligne **neuve** — son `auth_id` Crossmint n'est plus dans
la base — et une nouvelle `DOTATION_CENTS` de 5 000 centimes. C'est un **robinet à crédits**, dans la
phase qui existe pour borner ce que la maison émet. Ce qui le tient aujourd'hui : **il n'existe aucune
route qui demande l'anonymisation**, donc le robinet exige que l'opérateur l'ouvre lui-même, un compte
à la fois. Le jour où une route de suppression existera — le jour où une juridiction l'imposera —
elle devra porter une **empreinte de l'`auth_id`** dans une table en **insertion seule**, lue par
`findOrCreate` avant de doter. Chiffré : une table, un index unique, une lecture, un test.

**Ce que seule l'intégration continue peut montrer, et c'est la quatrième propriété de la phase dans
ce cas.** `api/db-check.js` reçoit trois cas neufs : un `delete from users` refusé par
`matches_user_id_fkey` tant qu'un billet référence la ligne, un `delete from matches` refusé par
`match_traces_match_id_fkey`, et l'anonymisation de bout en bout — l'audit qu'on fait échouer sur une
vraie contrainte, la ligne `users` restée intacte, puis le cas nominal, le rejeu refusé et la
collision de `name_key` **subie** au lieu d'être imitée. Une doublure ne peut pas subir une
contrainte. **Le job `db` n'a pas pu être lancé sur la machine de travail** : ni Postgres, ni
`docker`, ni `podman`, ni `psql`, ni `initdb`, ni `pg_ctl`, ni `gh`, vérifié une fois de plus. Le
dernier passage vert connu reste celui du 2026-09-15 (run 34894629071), antérieur à `paid_seats`, aux
deux index de fenêtre, à `ledger_audit` et aux deux cascades renversées. À ce stade, **412 tests sur
le jeu et 248 sur l'API** sans rien installer, 257 avec `jose`.

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

#### TRANCHÉ le 2026-09-15 : la deuxième issue, et les bots sont un bouchon

**Le pot affiché est tenu, et la maison paie la différence.** Les bots ne sont pas un modèle
économique : ils sont un bouchon qui remplit les sièges vides tant que la population ne suffit pas.
L'objectif est une table pleine de joueurs réels à chaque partie, et la contrepartie de la maison
est donc un coût de démarrage destiné à décroître, pas une ligne de revenu.

Ce que cela veut dire, écrit sans enjoliver : la commission de 20 % porte sur un pot notionnel, et
sur une table à $0,50 où un seul siège est payé, 20 % de ce qui entre vraiment vaut $0,10 — pas $2.
Quand le joueur emporte toute la table, la maison verse $7,50 d'argent réel pour une mise de $0,50,
et jusqu'à $390 sur la Resurgence à $10. `mouvementGain` l'écrit déjà, et le faisait avant que la
décision ne soit prise : `maison:contrepartie → enjeu` de la différence entre le brut et la mise.

**Le solde négatif de `maison:contrepartie` EST l'exposition**, partie par partie et en cumul. Le
grand livre la mesure ; il ne la borne pas. Deux choses restent donc ouvertes, et elles ne sont pas
de la même nature que celle qu'on vient de fermer :

- **Un plafond.** Rien n'empêche aujourd'hui un joueur fort de moissonner la contrepartie sur des
  tables remplies de bots qui ne rivalisent pas avec lui. Mesurable n'est pas borné, et un chiffre
  qu'on lit après coup n'a jamais arrêté personne. À trancher avant que le premier euro n'entre.
- **Le compte des sièges réellement payés.** `matches` fige `seats` — le nombre notionnel du mode —
  mais rien ne dit combien de sièges un humain a payés. Aujourd'hui la réponse est toujours « un »,
  donc personne n'en a eu besoin. Le jour du remplissage partiel, elle variera d'une partie à
  l'autre, et sans elle l'exposition ne sera plus attribuable après coup : on saura ce que la maison
  a versé, jamais pour combien de sièges vides. La colonne doit exister **avant** le remplissage,
  pas après, pour la même raison que `seats` et `team_size` sont figés sur le billet.
  *Fermé par le module 3 de la phase 04a* : `matches.paid_seats` existe, et elle est dormante —
  voir « Une colonne DORMANTE, et c'est exactement pourquoi elle est créée maintenant ».

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
plus fréquents qu'un tricheur. (Elles les valent **toujours**, mais plus partout : le module 2 de la
04a leur a ajouté un plancher plus serré sur les seuls règlements qui paient — voir « L'attente
réelle exigée d'un encaissement était NULLE ».)

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

## Quatre phrases sur le dépôt, consignées par la 04a pour la 04b

Elles ne sont **pas construites** ici : la phase 04a n'ouvre aucun dépôt, et un membre de liste fermée
que personne n'écrit est une case en attente d'être créée de travers. Mais chacune est la
transposition exacte d'une doctrine que le dépôt tient déjà, et les écrire maintenant coûte un
paragraphe quand les redécouvrir coûtera un crédit en double.

1. **Un seul écrivain, et ce n'est pas le webhook.** Le webhook **réveille** ; il ne décide pas.
   C'est le patron de `first_result_at` et du veilleur : l'événement extérieur déclenche, le serveur
   arbitre.
2. **Le montant vient d'une RELECTURE chez le prestataire, jamais du corps signé.** C'est
   « le serveur ne croit plus aucun fait déclaré : il rejoue », transposé de la partie au paiement.
   Un corps signé prouve qui parle, pas ce qui a été payé.
3. **La référence d'idempotence nomme L'ARGENT — l'identifiant de paiement — et non le MESSAGE.**
   Deux messages peuvent décrire le même paiement ; c'est le paiement qui ne doit être crédité
   qu'une fois. La clé `(motif, reference, compte_debit, compte_credit)` du grand livre l'arbitrera,
   comme elle arbitre déjà la dotation et la contre-passation.
4. **Aucune colonne de statut.** Un dépôt est payé **si et seulement si** le livre porte son
   mouvement. Un statut qu'on écrit est une case qu'on écrase — la doctrine de `user_stats`, du
   solde, et de tout ce que ce journal a déjà tranché deux fois.

## Deux migrations gratuites aujourd'hui, chères après le premier euro

Elles n'ont **aucun appelant**, et la 04a en avait déjà un sans elles. Mais leur fenêtre se referme au
premier euro, et c'est exactement la leçon de `user_stats` et de `seed_secret` passée à 128 bits :
tant qu'aucune base de production n'existe, renommer ne coûte rien ; après, il faut une reprise de
données et une fenêtre de maintenance.

**Échéance nommée : avant la première écriture de production**, c'est-à-dire avant le premier module
de la 04b qui touche une base qui garde ses données.

**(a) La devise en premier segment du nom de compte.** `fictif:joueur:7:disponible`, `reel:enjeu:12`,
avec une contrainte « les deux comptes d'une ligne portent le même segment ». Le croisement de
monnaies devient alors **structurellement impossible** au lieu d'être asserté, et `reel:maison:dotation`
cesse d'être **engendrable** : la maison ne peut pas frapper d'argent réel, tenu par une expression
régulière et non par un `if`. C'est la même nature de garantie que « une écriture est une
ligne-transfert », qui rend la partie double structurelle.

**(b) Le séquestre portant le pot notionnel entier `mise × sièges` dès l'ouverture.** La solvabilité
du règlement devient une **conséquence** de la conservation déjà assertée plutôt qu'une espérance, et
`mouvementGain` perd une branche. Après le premier euro, cela demande de rejouer l'historique des
séquestres ; aujourd'hui, c'est une fonction et un test.

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
- **405 tests sur le jeu, 201 sur l'API** sans rien installer, 210 avec `jose`. Aucune base, aucun
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

## État après la phase 04a

- Le jeu n'a toujours pas changé de nature : un seul `index.html`, sans build, sans bundler, sans
  React, **jouable sans compte ni serveur, graine comprise**. Trois blocs `<script>`, tous internes.
  La phase ne lui a rien ajouté d'autre que deux fonctions pures et un membre de plus dans une liste
  fermée : `WBCore.horlogePlancher`, `ENVELOPPE.margePlancherS`, et `plafond` dans `REFUS_SAS`.
  **`SIM_VERSION` n'a pas bougé.**
- **L'exposition de la maison est bornée, et la borne REFUSE.** `409 plafond` à l'ouverture du billet,
  jamais au règlement — une garde textuelle et un parcours de tous les chemins de clôture le tiennent,
  parce que refuser une partie gagnée serait irréparable. Le **plafond par joueur** est exact, lu dans
  la transaction et sous le verrou de ligne qui existait déjà ; le **fusible global** est approché, lu
  hors transaction et amorti à soixante secondes sur l'horloge injectée. Les cinq nombres sont des
  entiers, et `PLAFOND_JOUEUR_CENTS` est **dérivé** du pire cas de la table la plus chère, recalculé
  par le test depuis `WBCore`.
- **Un règlement qui PAIE exige une attente réelle.** Elle était **nulle** sur le chemin
  d'encaissement Resurgence, celui qui porte le plus gros paiement du dossier. Le refus `plancher`
  est armé sur tout règlement dont le net est positif, et sur lui seul.
- **`matches` enregistre combien de sièges un humain a payés.** `paid_seats`, écrite par le serveur,
  figée à l'ouverture, bornée par `between 1 and seats`, valant 1 partout — **dormante et assumée
  telle**, sans lecteur, parce qu'après coup le chiffre serait irrécupérable.
- **La correction du grand livre a un appelant, et ce n'est pas une route.** `api/operateur.js`, en
  ligne de commande, avec `montrer` avant `contrepasser` et `anonymiser`. `ledger_audit` est en
  insertion seule et partage la **transaction** de ce qu'elle justifie. Aucune route d'administration
  n'existe, et une garde textuelle le vérifie.
- **Un compte ne s'efface plus, il s'anonymise.** Les deux cascades de la phase 01 sont en
  `restrict` ; `users.id` survit toujours, sans quoi `joueur:<id>` et `enjeu:<match_id>`
  désigneraient des lignes mortes.
- **413 tests sur le jeu, 255 sur l'API** sans rien installer, 264 avec `jose`. Aucune base, aucun
  réseau, aucun navigateur : tout est injecté.
- **QUATRE PROPRIÉTÉS DE CETTE PHASE N'ONT DE PREUVE QU'EN INTÉGRATION CONTINUE**, et le job `db` n'a
  pas pu être lancé une seule fois pendant les six modules : deux ouvertures simultanées qui ne
  franchissent pas le plafond à deux, la requête de fenêtre qui ne balaie pas `ledger_entries`,
  l'audit dont le `rollback` est arbitré par Postgres, et le `delete from users` refusé. Le dernier
  passage vert connu est celui du 2026-09-15 (run 34894629071), **antérieur à tout ce que la phase a
  écrit en SQL**. Le premier push de la branche déclenche le job, et c'est LE moment de le regarder.
- **Toujours aucun euro.** La phase borne le **bord** de l'argent réel ; elle n'ouvre aucun dépôt, et
  elle ne rend pas la partie honnête — le vol de précision reste entier, et c'est lui qui dimensionne
  le plafond.

### La recette de la 04a, et les six choses qu'elle a trouvées

Une relecture adversariale des six modules, faite après leur livraison. Ce qu'elle a trouvé n'est pas
une liste de bogues : c'est **cinq phrases fausses et un nettoyage**, et leur point commun mérite
d'être retenu — **chacune naissait verte.** Un test qui relit un texte trouve le texte qu'il cherche ;
un banc dont l'horloge est figée ne peut pas voir un défaut d'horloge ; un `explain` qui refuse un
`Seq Scan` ne distingue pas un parcours d'index borné d'un parcours complet.

1. **Le nettoyage de `api/db-check.js` n'avait pas suivi le passage des cascades en `restrict`.** Le
   cas de la purge validait sa transaction de montage puis faisait `delete from users` en laissant
   cinq billets et quatre traces derrière lui : `23503`, cas rouge, et — parce que le `commit` avait
   eu lieu — **pollution permanente**, si bien qu'au lancement suivant `creerJoueur` butait sur
   l'index unique d'`auth_id` et que le cas ne pouvait plus jamais repasser sans `psql`. Le
   commentaire disait encore « `cascade` emporte les traces et les billets ». Le test censé couvrir le
   module se contentait de chercher la chaîne `delete from users` dans le fichier : il prenait la
   ligne cassée pour la preuve que rien n'était cassé. La garde qui le remplace regarde chaque cas qui
   ouvre un billet et exige qu'il descende l'arbre, dans l'ordre des clés étrangères.
2. **Le message de la portée `joueur` promettait une table moins chère dans l'état exact que le
   plafond est calibré pour produire.** Quatre victoires maximales laissent l'exposition réalisée à
   `PLAFOND_JOUEUR_CENTS` tout rond, et plus aucune des vingt tables ne passe. Le seuil juste est
   `plafond − pire cas minimal du lobby`, jamais `plafond` ; le serveur pose `aucuneTableMoinsChere`,
   le jeu le lit. Voir décision 8.
3. **Le cache du fusible se figeait indéfiniment sur une horloge qui recule.** `now` vaut `Date.now`,
   donc une horloge murale : un pas NTP d'une heure rendait `t − luA` négatif, donc toujours inférieur
   à la cadence. Aucun test n'avait jamais injecté une horloge qui recule. La borne se lit maintenant
   dans les deux sens, comme `WBCore.simSteps` refuse déjà un delta négatif.
4. **La requête « par joueur » balayait la fenêtre de TOUS les joueurs.** Elle ne restreignait au
   joueur qu'après la jointure, sur une expression qu'aucun index ne couvrait — donc O(trafic du site)
   sous le verrou de ligne, exactement l'incident `GET /api/me` que la décision 6 cite pour justifier
   de sortir le fusible de la transaction. Corrigé des deux côtés : le prédicat descend dans la
   sous-requête, sur le billet CALCULÉ et jamais sur `reference` brute, et `schema.sql` reçoit
   `ledger_entries_billet_fenetre_idx`.
5. **Deux phrases sur le fusible étaient fausses, et elles servaient à accepter des approximations.**
   « Le retard vaut au plus ce qu'une minute d'ouvertures peut engager » : faux d'un ordre de
   grandeur, le fusible ne voit que des écritures réglées et rien ne borne le nombre de billets en
   vol tous joueurs confondus. « Environ treize comptes saturés » : vrai seulement sur un livre à
   l'équilibre, puisque la lecture est nette et que la marge du jour relève le seuil. Les deux sont
   désormais écrites telles qu'elles sont, et **deux tests les constatent** plutôt que de les taire —
   c'est la doctrine des limites connues du dépôt, pas une rustine.
6. **`montrer billet` ne montrait pas le chiffre qui avait décidé**, parce que sa fenêtre était ancrée
   sur l'horloge courante et non sur `opened_at`. Le banc figeait les deux à la même valeur : la
   coïncidence rendait le défaut invisible. Et l'aide assignait à ce verbe une question qu'aucun verbe
   ne peut rendre — un refus `plafond` ne laisse aucune ligne dans `matches`.

La leçon commune, pour la recette suivante : **ce n'est pas la même requête qui fonde une propriété,
ce sont les mêmes paramètres** ; et un contrôle doit mesurer le travail réellement fait, pas
l'absence d'un symptôme.

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
  *Partiellement fermé par le module 5 de la phase 04a :* le journal d'audit existe (`ledger_audit`)
  et l'outil d'opération aussi, mais ni l'un ni l'autre ne parle de `match_traces` — relire une trace
  reste un `select` à la main, non tracé. Ce que le module a tranché et qui vaut ici : ce sera un
  verbe de `api/operateur.js`, jamais une route, et il écrira son `geste` dans `ledger_audit`.
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
- ~~**L'écran de FIN crédite le portefeuille de démonstration sur l'économie de l'instant, pas sur
  celle du coup d'envoi.**~~ **FERMÉ, et ce journal était en retard, pas le code.** Le correctif date
  du commit `8f0a63f`, « L'economie de la fin de partie est celle du coup d'envoi » : `startMatch`
  reçoit désormais l'économie du sas et la fige dans `matchEnLigne` (`index.html` lignes 4124 et
  6702), et l'écran de fin lit `if(!matchEnLigne) demoCredit(take.net);` (ligne 6902) au lieu
  d'interroger `Auth.online()`. Un test de `test.js` (ligne 3340) tient les trois moitiés : la
  signature qui transporte l'économie, le gel au coup d'envoi, et l'absence de tout `demoCredit`
  non gardé dans l'écran de fin. La **décision écrite** qui manquait est donc prise : les deux bouts
  d'une partie nomment la même économie, celle du coup d'envoi, exactement comme le sas nomme celle
  de son entrée. Ce qui reste derrière, et qui n'est pas la même chose : **personne n'a encore VU les
  deux écrans dans un navigateur avec un vrai serveur** — c'est la session de jeu réelle, ci-dessous.
  *Relevé à la clôture de la phase 04a : cette entrée annonçait un défaut refermé depuis quatre
  commits, et rien ne l'avait signalé. Un point ouvert qui décrit du code est un point ouvert qui
  périme.*
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
- ~~**Qui a le droit de contre-passer.**~~ **Refermé par le module 5 de la phase 04a** — voir « La
  contre-passation reçoit son unique appelant, et il n'est pas une route ». `api/operateur.js` est
  cet appelant, en ligne de commande et jamais en HTTP ; `ledger_audit` est le journal, en insertion
  seule, et il partage la **transaction** de l'écriture d'argent ; `planCorrection` est la partie
  pure qui décide, et elle refuse un mouvement portant sur un billet encore `open`. Ce qui restait
  ouvert derrière — **la suppression de compte** — est fermé par le module 6 : les cascades sont en
  `restrict`, le verbe `anonymiser` existe, et son `geste` est consigné dans la même table. Ce qui
  reste encore : **le changement de pseudo n'est pas tracé.** `PATCH /api/me` écrit `name` et
  `name_key` sans rien consigner, et ce n'est pas un oubli — c'est une route du client, donc un geste
  fréquent, donc une décision de volume et de rétention que rien n'a prise. Et **la route de
  suppression de compte n'existe pas** : le jour où une juridiction l'imposera, elle devra porter une
  empreinte d'`auth_id` en table d'insertion seule, lue par `findOrCreate` avant de doter — sans quoi
  un compte anonymisé qui se reconnecte se fait doter une seconde fois.
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
