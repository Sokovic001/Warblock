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

## Ce qui reste ouvert

- **Lobby mobile** : la version actuelle est une adaptation du desktop, pas une conception propre.
- **Serveur autoritaire** : tout tourne dans le navigateur, le solde est modifiable depuis la console.
- **Cadre légal** avant tout argent réel.
- **Icône définitive** : plusieurs directions explorées, décision non figée.
