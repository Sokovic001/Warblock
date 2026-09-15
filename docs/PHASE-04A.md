# Phase 04a — le bord de l'argent réel

## Pourquoi cette phase s'appelle 04a et pas 04

La phase 04 du plan en sept phases s'appelle « dépôts ». Celle-ci n'en contient aucun : pas de
compte fournisseur de paiement, pas de webhook, pas d'idempotence sur un événement PSP, pas de KYC,
pas de cadre légal. Elle livre les **prérequis** que `CLAUDE.md` et `docs/HISTORIQUE.md` déclarent
eux-mêmes bloquants de la 04 — un plafond, le compte des sièges payés, qui a le droit de
contre-passer — plus une cascade de schéma que personne n'avait regardée.

Le dépôt a déjà écrit le précédent, et il est dans `docs/HISTORIQUE.md` : « La phase 02 est scindée
en 02a et 02b, et les deux moitiés sont nommées. » La raison y est écrite aussi : sans deux noms,
une moitié livrée se lit comme une phase finie, et la suivante démarre sur cette croyance. Une
« phase 04 » qui n'ouvre aucun dépôt se relirait dans six mois comme une 04 faite, pendant que
`CLAUDE.md` continuerait d'annoncer « Phases 04 à 06 — dépôts ».

Donc : **04a, le bord de l'argent réel** ; **04b, le dépôt lui-même**. La 04b garde son nom et son
contenu.

---

## Ce que la phase fait

Cinq blocages, et rien d'autre.

1. **L'exposition de la maison devient calculable**, par des fonctions pures dans `api/ledger.js`,
   avant que quoi que ce soit ne s'en serve.
2. **La marge d'horloge se resserre là où elle protège de l'argent.** La 02a avait écrit ses
   tolérances larges avec sa raison — « aucun argent n'est en jeu » — et sa date de péremption :
   « elles se resserreront quand elles protégeront de l'argent ». C'est aujourd'hui.
3. **`matches` enregistre combien de sièges un humain a payés**, avant que le remplissage partiel ne
   rende la donnée irrécupérable.
4. **Le plafond refuse à l'ouverture du billet**, dans la transaction et sous le verrou qui existent
   déjà, et le sas le dit au lieu d'offrir une partie gratuite.
5. **La contre-passation reçoit son unique appelant, un verbe de lecture, et sa trace** — sous forme
   d'outil en ligne de commande, jamais de route HTTP. Et **un compte cesse de pouvoir emporter ses
   pièces justificatives en s'effaçant.**

Le levier qui rend tout cela petit est un invariant déjà acquis : l'index partiel
`matches_un_seul_ouvert` garantit qu'**un joueur n'a qu'un billet ouvert à la fois**. La somme
« exposition réalisée + un seul pire cas » est donc exacte, et il n'y a rien à réserver ni à
libérer.

Rien de cette phase ne demande une base qui tourne pour être livré vert sur la machine de travail —
mais trois de ses propriétés n'ont de **preuve** qu'en intégration continue, et c'est écrit plus bas
sans être enjolivé. Rien ne touche la simulation : `SIM_VERSION` ne bouge pas. Le jeu ne reçoit que
deux touches : un membre de plus dans la liste fermée `WBCore.REFUS_SAS`, et une fonction pure de
plus dans `WBCore`.

## Ce que la phase ne fait pas

- **Le dépôt.** Compte fournisseur, webhook d'encaissement, idempotence sur l'événement PSP, KYC,
  cadre légal. Rien ne s'en vérifie sans hébergement, et le dépôt n'a de sens qu'une fois le premier
  euro bornable. Le concevoir ici produirait une spécification qu'aucun test ne peut toucher, ce que
  la 03 a payé cher avec un job Postgres jamais vert.
- **Aucun motif `depot` n'entre dans la liste fermée du grand livre.** Le dossier a déjà tranché ce
  cas et écrit la raison : le motif de libération de quarantaine a été refusé parce qu'« un membre de
  liste fermée que personne n'écrit est une case en attente d'être créée de travers ». Son ajout est
  chiffré : un motif, un `alter table`, un test.
- **Aucun drapeau d'éligibilité aux tables réelles**, et c'est la même règle. `paid_seats` est admise
  dormante parce qu'elle **mesure un fait qui varie et se perd** ; un drapeau d'éligibilité est une
  **décision qui n'existe pas encore**, donc une case vide. Sa place, le jour venu, est sur `users` à
  côté de la vérification d'identité, pas sur `matches`.
- **Le retrait**, et la question qui va avec : le solde jouable et le solde retirable sont-ils le
  même nombre ? Tant que la maison dote en crédits fictifs, la question n'a pas de sens.
- **L'identifiant de table partagée**, celui qui rendra `paid_seats` réellement attributif. Cette
  phase enregistre le chiffre, elle ne construit pas le remplissage multi-joueurs.
- **Le relevé d'exploitation** — exposition par jour, par joueur, par mode. La phase rend l'agrégat
  calculable et le refus bavard ; elle n'ajoute ni écran ni tableau de bord.
- **Le drainage d'un déploiement**, la quarantaine et le seuil sur `ecart_cents`, la session de jeu
  réelle, le lobby mobile : inchangés, et renvoyés là où ils sont déjà rangés.
- **Elle ne rend pas la partie honnête.** Le vol de précision reste entier. Voir les risques : ce
  n'est pas une réserve de forme, c'est ce qui dimensionne les nombres de cette phase.

---

## Les décisions, et leur raison

### 1. L'exposition est une SOMME d'écritures, jamais une colonne

Elle se lit sur les deux comptes de maison — `maison:contrepartie` et `maison:commission` —
restreinte aux références des billets d'un joueur. `maison:dotation` n'y entre **jamais** : émettre
des crédits fictifs n'est pas s'exposer.

C'est la doctrine de `user_stats` appliquée une fois de plus : un compteur qu'on incrémente est une
case qu'on écrase, une somme sur des lignes immuables ne peut pas être fausse. Le corollaire est
testable et il est écrit comme test : **on franchit le plafond en posant des écritures, jamais en
touchant un compteur, et relire redonne le même chiffre.**

### 2. L'exposition est NETTE, mais ramenée à zéro avant comparaison

Les billets perdus s'imputent sur les gagnés : la maison n'est exposée que du net, et c'est
précisément ce que mesure la somme des deux comptes de maison. Mais une exposition négative qu'on
reporterait serait un compte d'épargne à moissonner — perdre cent parties achèterait le droit d'en
gagner une très grosse.

Écarté : l'exposition brute, qui punit le joueur régulier ; l'exposition accumulable, qui transforme
la fenêtre en réserve.

Le prix est écrit : un joueur qui perd beaucoup puis gagne beaucoup passe le plafond, et la fenêtre
glissante reste manipulable en étalant les gains sur deux jours.

### 3. Le pire cas d'un billet vaut `net(mise × sièges) − mise`, et il est CALCULÉ PAR LE JEU

`api/ledger.js` porte deux gardes textuelles : il ne `require` rien, et il ne contient aucune
arithmétique de commission. Elles restent vertes. Le chiffre est donc produit par
`WBCore.cashoutCents(WBCore.purseBound(mise, sièges).maxCents)` dans `api/app.js`, puis **passé en
paramètre** à la base et au grand livre — exactement le contrat de `mouvementGain`, qui reçoit brut,
commission et net sans les recalculer.

Écarté : écrire la formule dans `api/ledger.js`, qui casse les deux gardes ; la descendre dans
`WBCore`, alors qu'une comptabilité n'est pas une règle du **jeu** et voyagerait dans les 465 Ko que
chaque joueur télécharge.

La propriété qui compte n'est pas la formule, c'est sa **confrontation** : sur les quatre paliers ×
cinq modes, `expositionBilletMaxCents` doit égaler au centime la somme nette des jambes de maison
que `mouvementGain` produit réellement à brut maximal. Jamais assertée depuis une formule recopiée —
c'est la leçon du pot forfaitaire ressuscité, et elle a déjà coûté un `ecart_cents` de −520.

### 4. La référence d'une écriture est du TEXTE, et elle se ramène à un billet par une FONCTION PURE

C'est le piège de cette phase, et il naît vert si on ne le nomme pas.

`ledger_entries.reference` est du texte. Une contre-passation porte `gain:<id>`, pas `<id>` — c'est
`mouvementContrepassation` qui le décide, et pour une bonne raison : on lit dans le livre **ce qui**
a été contre-passé sans faire une jointure. Une jointure `ledger → matches` par `reference::bigint`
lèverait donc `22P02` sur ces lignes-là ; une jointure qui les filtre les **ignore**, donc un gain
contre-passé continuerait de compter dans l'exposition. Le module qui écrit la requête n'est pas
celui qui crée les lignes qui la cassent : le défaut naîtrait vert et se révélerait une phase plus
tard.

La règle : **`api/ledger.js` exporte `referenceBillet(motif, reference)`**, pure, qui rend
l'identifiant de billet sous forme de chaîne de chiffres, ou `null` quand l'écriture ne parle
d'aucun billet. Elle est **exhaustive sur la liste fermée des motifs**, contre-passations comprises,
et un test la confronte aux références que les six fonctions de mouvement produisent réellement.
Elle exporte aussi sa **traduction SQL**, `REFERENCE_BILLET_SQL`, et une garde textuelle compare
l'expression du schéma à cette chaîne — même patron que `COMPTE_RE_SQL`. Aucun `cast`, aucune
conversion : on compare du texte à `matches.id::text`.

**Deux points relevés à la livraison du module 1, et consignés ici pour ne pas les redécouvrir.**

Le premier est une contrainte d'écriture de la traduction SQL : le groupe des motifs doit être **non
capturant**. `substring(texte from motif)` rend la première parenthèse **capturante** de
l'expression ; capturer le motif d'origine rendrait « gain » là où on attend « 42 », c'est-à-dire une
lecture **vide** plutôt que fausse, donc silencieuse. Le groupe capturant est celui des chiffres, et
la même source sert au `RegExp` de JavaScript et à l'expression SQL.

Le second est une **limite assumée** de la règle telle qu'elle est écrite : contre-passer une
contre-passation produit `contrepassation:gain:42`, que l'expression ne ramène à **aucun** billet, et
cette écriture-là ne compterait donc pas dans l'exposition. Le double geste n'a pas d'appelant — le
verbe `contrepasser` du module 5 corrige un **mouvement d'origine** — et l'élargir demanderait
d'élargir `REFERENCE_BILLET_SQL` du même coup, donc de re-décider des deux côtés ensemble. Chiffré,
le jour où quelqu'un ouvrira ce chemin : un préfixe `(?:contrepassation:)*` dans une expression, des
deux côtés, et un test. Écrit ici plutôt que laissé à découvrir sur un plafond qu'on croirait tenir.

**Tranché à la livraison du module 5 : on FERME le chemin plutôt que d'élargir la règle.**
`planCorrection` refuse un mouvement de motif `contrepassation`, sous le code nommé
`double_contrepassation`, et un test vérifie que `REFERENCE_BILLET_SQL` n'a pas été élargie d'un seul
côté. La raison du choix : le double geste n'a **aucun usage** — une correction fautive se corrige sur
le mouvement d'origine, et la clé d'idempotence refuserait de toute façon la seconde pose du même
mouvement inverse. Élargir aurait ajouté une règle vivante des deux côtés d'un réseau pour un chemin
que personne n'emprunte. Le chiffrage ci-dessus reste valable le jour où quelqu'un aura un vrai
besoin : il lira le refus et son prix.

### 5. Le plafond se décide à l'OUVERTURE du billet, et rien n'est réservé

Sur l'exposition réalisée d'une fenêtre glissante **plus** le pire cas du billet qu'on ouvre. Rien
n'est réservé, rien n'est libéré.

L'index partiel `matches_un_seul_ouvert` garantit qu'un joueur n'a jamais plus d'un pire cas en vol.
La somme « réalisé + un pire cas » est donc exacte, et elle tient en deux lectures dans la
transaction qui existe déjà.

Écarté : un système de réservation — un compte d'engagement crédité à l'ouverture, libéré au
règlement — qui doublerait le nombre d'écritures et ajouterait une jambe à solder sur chacune des
six issues d'un billet.

Deux corollaires, tous deux gardés par un test :

- **Aucun chemin de règlement ne peut produire le code `plafond`.** Refuser au règlement serait
  voler une partie gagnée, et c'est irréparable. C'est très exactement le genre de `if` qu'on ajoute
  un dimanche soir : il lui faut une garde, pas seulement une phrase de conception.
- **Un billet déjà ouvert n'est jamais cassé rétroactivement.** Franchir le plafond pendant qu'il
  vit ne change rien à son règlement.

**Deux corrections apportées à la livraison du module 4, écrites ici plutôt que découvertes.**

La première annule une phrase de cette spécification. Elle écrivait qu'un refus `plafond` ne consomme
« pas même une graine », et c'était **faux pour la portée `joueur`** : ce verdict-là se décide dans la
transaction, donc **après** les deux tirages de `api/app.js`, comme le refus `fonds` depuis la phase
03. Les deux exigences — « sous le verrou » et « aucune graine » — étaient en tension, et c'est « sous
le verrou » qui gagne, parce que c'est elle qui rend le plafond **exact**. Le prix est nul : le joueur
n'obtient aucun billet, donc aucune carte, et la source de graines est un générateur, pas une suite
finie. La portée `maison`, elle, refuse bien avant les tirages. Le test l'**asserte** au lieu de le
taire.

La seconde est une **limite** du corollaire ci-dessus. Le verdict par joueur ne s'applique qu'à
l'ouverture d'un billet **neuf** — le chemin `repris` n'est jamais refusé, sans quoi un joueur dont la
réponse s'est perdue se retrouverait enfermé dans un billet qu'il détient déjà, mise débitée. Le
**fusible global**, lui, est lu avant de savoir si la demande est un rejeu : quand il saute, il refuse
donc aussi la récupération d'un billet ouvert. C'est cohérent avec ce qu'il est — une alerte qui
refuse tout le monde — mais pendant un déclenchement, une mise au séquestre n'est plus récupérable
par cette route avant l'expiration.

### 6. Le plafond par joueur est EXACT et sous le verrou ; le fusible global est APPROCHÉ et hors transaction

Les deux nombres n'ont pas la même nature, et les traiter pareil coûtait la section critique la plus
disputée du système.

**Le plafond par joueur** doit être exact, parce que deux onglets du même joueur doivent être
sérialisés — c'est exactement la propriété que le verrou `select id from users where id = $1 for
update` existe pour tenir. Il est donc lu **dans la transaction d'ouverture, après ce verrou**. Son
agrégat est borné par les billets d'un seul joueur sur vingt-quatre heures : quelques dizaines de
lignes, sur un index qui les porte.

**Le fusible global**, lui, est un interrupteur, pas un invariant. Le lire sous le verrou ferait de
chaque ouverture de billet un agrégat non borné sur la table qui grossit le plus vite du dépôt. Le
dépôt a déjà payé ce genre de chose une fois : `GET /api/me` retenait un client du bassin assez
longtemps pour mettre en file le renoncement d'un **autre** joueur au-delà de sa fenêtre de dix
secondes. Le fusible est donc lu **hors de la transaction du billet, au plus une fois toutes les
`FUSIBLE_RAFRAICHI_S` secondes**, et sa valeur est gardée en mémoire du processus entre deux
lectures.

Être exact sur un seuil de deux millions de centimes, au billet près, ne veut rien dire ; payer un
agrégat non borné sur chaque ouverture pour l'obtenir est la mauvaise moitié du marché. La
péremption est donc écrite avec son chiffre : **le fusible peut être en retard de soixante secondes,
et ce retard vaut au plus ce qu'une minute d'ouvertures peut engager.** L'horloge est injectée
(`now`), donc la cadence de rafraîchissement est testable sans attendre.

Cette mémoire de processus rejoint la limitation de débit dans les **limites connues** : deux états
en mémoire, perdus au redémarrage, non partagés entre plusieurs instances. Écrit ici plutôt que
découvert au premier déploiement à deux processus.

### 7. Les nombres, et les deux ancrages qui les tiennent

```
PLAFOND_FENETRE_H       =      24   heures, fenêtre glissante
PLAFOND_TABLES_PAR_JOUR =       4   tables maximales par joueur et par fenêtre
PLAFOND_JOUEUR_CENTS    = 156 000   centimes  (= 4 × 39 000)
PLAFOND_MAISON_CENTS    = 2 000 000 centimes
FUSIBLE_RAFRAICHI_S     =      60   secondes
```

**Le pire cas d'un billet, table par table.** Il vaut `net(mise × sièges) − mise`. Le maximum du
domaine est la Resurgence à 10 $ : cinquante sièges, brut maximal 50 000, commission 10 000, net
40 000, donc **39 000 centimes d'exposition** pour 1 000 misés. Ce nombre est calculé par le test,
jamais écrit à la main.

**Premier ancrage, le plancher.** En dessous de 39 000, la Resurgence à 10 $ devient impossible à
ouvrir pour tout le monde et tout le temps, et la panne se lirait comme un bug du lobby. Un nombre
rond « raisonnable » — 10 000, 20 000 — ferme silencieusement les deux tables les plus chères. Le
plafond décide donc quelles tables **existent**, et il doit être posé par rapport au pire cas.

**Second ancrage, et c'est celui qui manquait.** Juste au-dessus du plancher, une seule victoire
maximale ferme la table pour vingt-quatre heures : un joueur qui a consommé 39 000 voit son billet
suivant peser 39 000 de plus, donc 78 000. À 50 000 de plafond, le premier gros gagnant **légitime**
lit `plafond` et voit un lobby cassé — et comme l'exposition est nette et qu'un billet perdu ne vaut
que −1 000, il lui faudrait trente-neuf défaites pour effacer sa victoire. Le second ancrage est
donc : **combien de tables maximales veut-on laisser ouvertes après une grosse sortie ?** La réponse
retenue est quatre, d'où 4 × 39 000 = 156 000.

Un test tient la dérivation : `PLAFOND_JOUEUR_CENTS === PLAFOND_TABLES_PAR_JOUR × pire cas maximal`,
le pire cas étant recalculé depuis `WBCore` sur les quatre paliers et les cinq modes. Un palier ou un
mode qui change fait tomber le test, et quelqu'un doit re-décider. C'est la seule protection contre
un nombre qui survit à la table qui l'a justifié.

**Ce que ces nombres coûtent, écrit sans enjoliver.** Un compte vaut au plus 156 000 centimes de
contrepartie par jour, soit 1 560 $. Le fusible global vaut 2 000 000, soit 20 000 $, c'est-à-dire
**environ treize comptes saturés dans la même journée**. `findOrCreate` crée un compte par `auth_id`
Crossmint, donc par adresse email, et le serveur dote 5 000 centimes à la connexion plus 1 000 par
jour : treize adresses email jetables suffisent donc à faire sauter le fusible. Le vrai plafond de
la maison **est le fusible global** ; le plafond par joueur ne sert qu'à empêcher un seul compte de
l'épuiser à lui seul.

Le remède à la flotte de comptes est une **vérification d'identité**, pas une règle de jeu. Elle
n'est pas dans cette phase, elle est dans la 04b avec le KYC. En attendant, le fusible est la seule
borne réelle, et son déclenchement refuse **tout le monde** : c'est une alerte, pas un réglage.

### 8. Un seul code de refus, deux portées, et le message LIT la portée

`plafond` entre dans la liste fermée `WBCore.REFUS_SAS`, qui passe de trois à quatre membres. Un
seul code, parce que le sas n'a qu'un comportement à tenir et que faire diverger la liste pour une
nuance que le joueur ne peut pas actionner serait une complication gratuite.

Mais **une seule phrase mentirait dans un cas sur deux** : « choisis une table moins chère » est
faux quand c'est le fusible global qui a sauté — aucune table moins chère n'aidera. La réponse porte
donc `portee: 'joueur' | 'maison'`, et `WBCore.refusMessage` la lit :

- portée `joueur` : ce joueur a beaucoup gagné sur les dernières vingt-quatre heures, une table
  moins chère marchera.
- portée `maison` : la maison n'ouvre pas de nouvelle table pour l'instant, rien n'a été débité,
  réessayer plus tard.
- portée absente ou illisible : **on rend le message de la maison**, délibérément. Promettre une
  table moins chère quand aucune ne marchera est pire que dire « plus tard » à quelqu'un qu'une
  table moins chère aurait dépanné.

La réponse porte aussi `expositionCents`, `plafondCents` et `fenetreHeures`, en 409 comme tous les
refus nommés de cette API — jamais en 500, et sans enfermer personne.

### 9. `plafond` est un refus NOMMÉ : il arrête le sas

La doctrine de la 03 est écrite : un refus nommé arrête le sas, une panne silencieuse le laisse
retomber hors ligne. `plafond` est un refus nommé — le serveur a instruit la demande et l'a rejetée,
rien n'a été débité, et l'action est claire. Le laisser retomber hors ligne ferait jouer gratuitement
celui qu'on vient tout juste de borner.

La frontière ne bouge pas pour autant : les quatre cas nommés de panne silencieuse — `ACCOUNT.api`
vide, pas de session, serveur muet, réponse illisible — plus un 500 et un 429 retombent toujours
hors ligne, portefeuille de démonstration inchangé.

### 10. La marge d'horloge se resserre là où elle protège de l'argent

C'est la seule chose de cette phase qui réduise réellement ce que le plafond doit absorber, et elle
ne coûte presque rien.

`matchVerdict` contient déjà le contrôle `chronometre` : `r.seconds > ecouleS - LOBBY.wait +
ENVELOPPE.margeHorlogeS` refuse une partie plus longue que le temps réellement écoulé. Lue dans
l'autre sens, c'est exactement un **plancher** : `ecouleS >= LOBBY.wait + r.seconds -
margeHorlogeS`. Ce n'est donc pas une inéquation nouvelle qu'il faut, c'est la **marge** qu'il faut
resserrer là où elle protège de l'argent.

Or `margeHorlogeS` vaut 120 et `LOBBY.wait` vaut 25. Un encaissement Resurgence annoncé à 30 s
simulées satisfait `30 <= ecouleS - 25 + 120` dès `ecouleS = 0` : **l'attente réelle exigée est
nulle.** Le plancher armé à la ligne du `victoire` ne couvre que la branche victoire ; tout le chemin
d'encaissement Resurgence — celui qui porte le pire cas de 39 000 — n'a aujourd'hui aucun plancher.

`WBCore.horlogePlancher(billet, rapport, tMs)` est donc une fonction pure de plus, jumelle exacte du
contrôle existant, armée sur **tout chemin de règlement qui paie** — encaissement comme victoire —
avec une marge nommée à part, `ENVELOPPE.margePlancherS = 30`, du même ordre que la
`margeVictoireS` qui existe déjà. `margeHorlogeS` reste à 120 pour les chemins qui ne paient rien :
un joueur qui perd n'a pas à être refusé pour une horloge.

Le refus s'appelle `plancher`, il rejoint la table des motifs d'`ENVELOPPE`, il clôt la ligne en
`rejected` comme les autres refus de verdict. Aucun changement de simulation, aucune montée de
`SIM_VERSION`, aucun octet de plus dans le sas, aucune dépendance réseau.

**Ce que cela ne fait pas** : rendre la partie honnête. Un solveur hors ligne qui cherche la
meilleure trace reste possible ; il doit désormais attendre pour l'encaisser, ce qui le ramène au
rythme d'un joueur. C'est un renchérissement, pas une fermeture. La doctrine qui fermerait
réellement la porte — **on ne refuse pas la triche, on la joue bornée, des deux côtés, puisque le
serveur exécute le même bloc** — est la phrase qui devrait ouvrir la phase suivante ; elle n'est pas
ici.

### 11. `paid_seats` est écrite maintenant, et elle est DORMANTE — assumé

`matches` reçoit `paid_seats`, écrite par le serveur, figée à l'ouverture, contrainte `between 1 and
seats`, et valant **1 sur toutes les lignes** aujourd'hui.

La raison est celle qui fige `seats`, `team_size` et `sim_version` : après coup, rien ne permet de
retrouver combien de sièges un humain avait payés, et l'exposition cesse d'être attribuable. La
colonne doit exister **avant** le premier remplissage partiel.

Et elle est admise **dormante**, sans lui inventer de lecteur. Le dossier a déjà tranché l'inverse et
écrit pourquoi, à propos de `seed_secret` : « Elle ne sert à rien en 02a, et c'est exactement
pourquoi elle est créée maintenant. » Lui fabriquer un consommateur — une fonction qui calculerait
un montant **notionnel** `mise × sièges payés` à côté du montant **réalisé** qu'on lit sur le livre —
poserait dans le même fichier la paire exacte qu'on finira par confondre. L'argument de fond suffit ;
l'habillage « exercée dès le premier jour » ne tenait pas, puisqu'aucun chemin de production
n'écrira jamais autre chose que 1 avant qu'un identifiant de table partagée n'existe.

### 12. La correction du grand livre est un OUTIL, jamais une route

`api/operateur.js`, en ligne de commande. Une garde textuelle vérifie qu'`api/app.js` ne le charge
pas et ne porte aucune route d'administration — même patron et même garde que « il n'existe aucune
route `POST /api/credits` ».

Une route d'administration est une surface d'attaque permanente pour un geste qui arrive deux fois
par an, et elle demanderait une authentification de second ordre que rien d'autre du dossier ne
justifie. L'opérateur est déjà celui qui détient les identifiants de la base.

Écarté : `POST /api/admin/contrepassation` avec un rôle dans `users` ; et le statu quo, c'est-à-dire
un `psql` à la main un dimanche soir, qui est le jour où la règle « aucun `update` » tombe.

**L'outil sait LIRE avant de savoir écrire.** Le premier geste d'un incident réel n'est pas de
corriger, c'est de regarder : l'exposition d'un joueur sur la fenêtre, les jambes d'un mouvement,
pourquoi ce billet a été refusé en `plafond`. Un outil qui n'aurait que des verbes d'écriture
enverrait l'opérateur dans `psql` un dimanche soir — précisément le geste et le jour que ce module
existe pour empêcher. Le verbe `montrer` arrive donc en premier, et il n'écrit rien.

### 13. La contre-passation et sa raison partagent la transaction

Une table `ledger_audit`, en insertion seule : quand, par qui, pourquoi, le mouvement d'origine, la
référence de la contre-passation, le nombre de jambes, le montant. Elle partage la transaction de
l'écriture d'argent, donc l'argent et sa justification vivent ou meurent ensemble.

Une contre-passation sans raison écrite est indistinguable d'une erreur de manipulation, et une
raison consignée après coup peut ne jamais l'être. Écarté : un fichier de journal ou une sortie de
terminal, qui ne partagent pas la transaction et disparaissent avec le shell.

**Un mouvement portant sur un billet encore `open` n'est pas contre-passable**, et le refus est
nommé : c'est le seul cas qui laisserait un séquestre incohérent avec son statut. Le cas où
l'incident **est** un billet ouvert coincé se traite par la clôture normale — le veilleur — pas par
une contre-passation ; c'est écrit dans l'aide de l'outil pour que personne ne le cherche.

La partie qui décide est pure : `planCorrection(transferts, { par, raison })`, donc entièrement
testable sans base.

**Trois précisions apportées à la livraison du module 5, écrites ici plutôt que découvertes.**

La première corrige la signature ci-dessus : c'est `planCorrection(transferts, { par, raison,
billet })`. Le refus « un billet encore `open` n'est pas contre-passable » a besoin de la ligne
`matches`, et une fonction pure ne va pas la chercher. Conséquence directe et voulue : **ne pas
relire le billet n'est pas une façon de contourner le contrôle** — sans la ligne, on refuse
(`billet_inconnu`), on ne suppose pas. Une écriture qui ne désigne aucun billet, dotation ou recharge,
n'en demande aucun : `referenceBillet` rend `null` et la question ne se pose pas.

La deuxième est un **grief légitime** que la contre-passation d'un gain laisse derrière elle, et qui
n'était écrit nulle part : contre-passer le gain d'une ligne réglée **réhabite** son séquestre, donc
`ledgerReconcile` dit « le séquestre n'est pas vidé ». Il a raison. L'outil corrige le livre, il ne
décide pas de la suite — c'est à l'opérateur de poser le mouvement juste, ou de faire clore la ligne.
Le test l'asserte au lieu de le taire. Ce qui retombe en revanche **exactement** : les quatre comptes
touchés au centime, le zéro global, et l'exposition.

La troisième est la **liste des gestes de `ledger_audit`, fermée à UN membre**. La table porte bien un
`geste` plutôt que d'être une table `contrepassations`, comme la décision 14 le demande — mais
`anonymisation` n'y entre **pas** d'avance : ce serait la case en attente d'être créée de travers que
le dossier refuse depuis le motif de libération de quarantaine. Chiffré pour le module 6 : une valeur
dans le `check`, une dans `AUDIT_GESTES`, un test.

### 14. Un compte ne s'efface pas, il s'anonymise

`schema.sql` porte depuis la phase 01 deux cascades que personne n'avait regardées : `matches`
cascade sur `users`, `match_traces` cascade sur `matches`. Or `ledger_entries` est en insertion
seule et nomme ses comptes avec `users.id` et `matches.id`. Effacer un joueur détruit donc
aujourd'hui ses billets et ses traces — c'est-à-dire **les pièces justificatives de mouvements
d'argent qui, eux, restent** — et laisse `joueur:<id>` et `enjeu:<match_id>` désigner des lignes
mortes.

Les deux cascades deviennent `restrict`. Un second verbe d'`api/operateur.js` anonymise.

Écarté : l'effacement réel avec purge des écritures, qui détruit la partie double ; et « ne jamais
supprimer de compte », qui est une règle qu'aucun code ne tient, donc pas une règle.

**L'anonymisation est une RÉÉCRITURE SOUS CONTRAINTES, pas une suppression de colonnes**, et
l'écrire autrement serait faux. `users` porte `auth_id text not null unique`, `email not null`,
`name not null`, `name_key text not null unique` et `check (char_length(name_key) between 1 and 14)`.
Aucun de ces champs ne peut « partir ». Ce qui est écrit à la place :

| colonne    | valeur après anonymisation            | pourquoi |
|---|---|---|
| `id`       | inchangé                               | `joueur:<id>` et `enjeu:<match_id>` doivent rester des comptes valides |
| `auth_id`  | `anonyme:<id>`                         | unique par construction, et l'identifiant du fournisseur ne survit pas |
| `email`    | `anonyme+<id>@invalid`                 | `.invalid` est réservé, donc jamais routable |
| `name`     | `x<base36(id)>`                        | 14 caractères au plus : un `bigserial` tient sur 13 chiffres en base 36 |
| `name_key` | `WBCore.nameKey(name)`                 | la clé se dérive du nom, jamais écrite à côté |
| `avatar`   | `''`                                   | valeur par défaut de la colonne |
| `country`  | `null`                                 | la colonne l'autorise |

Le nom est calculé **en JavaScript par l'outil**, pas en SQL : c'est là que `WBCore.nameKey` et la
contrainte de quatorze caractères se lisent ensemble. Une collision sur `name_key` — quelqu'un
porterait déjà ce pseudo — sort en `23505`, et l'outil **le dit et s'arrête** : deviner à la place de
l'opérateur, sur un geste rare et manuel, serait pire que s'arrêter.

**L'ancien pseudo redevient disponible**, et c'est voulu. Le corollaire est à connaître :
l'historique d'un joueur se lit alors sur son `id` et jamais sur son nom. Tout écran ou toute requête
qui affiche un pseudo depuis une jointure devra le savoir, sinon deux personnes différentes
apparaîtront comme une seule.

**Le trou qui reste, nommé et chiffré.** `findOrCreate` cherche par `auth_id`. Un joueur anonymisé
qui se reconnecte avec le même email obtient une ligne neuve et une nouvelle `DOTATION_CENTS` de
5 000 centimes — un robinet à crédits, dans la phase qui existe pour borner ce que la maison émet. Ce
qui le tient aujourd'hui : **il n'existe aucune route qui demande l'anonymisation.** Le robinet exige
que l'opérateur l'ouvre lui-même, un compte à la fois. Le jour où une route de suppression de compte
existera — c'est-à-dire le jour où une juridiction l'imposera — elle devra porter une empreinte de
l'`auth_id` en table d'insertion seule, lue par `findOrCreate` avant de doter. Chiffré : une table,
un index unique, une lecture, un test.

### 15. Deux migrations sont gratuites aujourd'hui et chères après le premier euro

Elles ne sont pas construites ici — elles n'ont pas d'appelant et cette phase en a déjà un sans — mais
elles sont **datées**, avec leur échéance, parce que la fenêtre où elles coûtent zéro se referme au
premier euro. C'est mot pour mot la leçon de `user_stats` et de `seed_secret` passée à 128 bits.

**(a) La devise en premier segment du nom de compte.** `fictif:joueur:7:disponible`,
`reel:enjeu:12`, avec une contrainte « les deux comptes d'une ligne portent le même segment ». Le
croisement de monnaies devient **structurellement impossible** au lieu d'asserté, et
`reel:maison:dotation` cesse d'être engendrable — la maison ne peut alors pas frapper d'argent réel,
tenu par une expression régulière et pas par un `if`.

**(b) Le séquestre portant le pot notionnel entier `mise × sièges` dès l'ouverture.** La solvabilité
du règlement devient une conséquence de la conservation déjà assertée plutôt qu'une espérance, et
`mouvementGain` perd une branche.

**Échéance : avant la première écriture de production**, c'est-à-dire avant le premier module de la
04b qui touche une base qui garde ses données. Après, elles coûtent une reprise de données, et
personne ne renommera plus une grammaire à six comptes.

### 16. La doctrine de dépôt, consignée pour la 04b et pas construite ici

Quatre phrases, transposition exacte de doctrines que le dépôt tient déjà. Les écrire maintenant
coûte un paragraphe ; les redécouvrir coûtera un crédit en double.

1. **Un seul écrivain, et ce n'est pas le webhook.** Le webhook réveille ; il ne décide pas.
2. **Le montant vient d'une RELECTURE chez le prestataire**, jamais du corps signé. C'est le serveur
   qui rejoue au lieu de croire, comme pour la partie.
3. **La référence d'idempotence nomme L'ARGENT** — l'identifiant de paiement — et non le MESSAGE.
4. **Aucune colonne de statut.** Un dépôt est payé si et seulement si le livre porte son mouvement.
   Un statut qu'on écrit est une case qu'on écrase.

Elles vont dans `docs/HISTORIQUE.md`, à côté des trois choses consignées avant le premier euro.

---

## Les invariants, et comment chacun se teste

| Invariant | Comment il se prouve |
|---|---|
| L'exposition est une somme sur `maison:contrepartie` et `maison:commission` ; `maison:dotation` n'y entre jamais | Un livre où la dotation et la recharge dominent rend la même exposition qu'un livre sans elles |
| On franchit le plafond en posant des écritures, jamais en touchant un compteur | On pose des écritures, on relit, on retrouve le même chiffre ; aucune colonne n'existe à lire |
| `api/ledger.js` reste PUR : aucun `require`, aucune arithmétique de commission | Les deux gardes textuelles existantes, inchangées et toujours vertes après l'ajout |
| Le pire cas d'un billet est confronté aux écritures réelles | Quatre paliers × cinq modes : `expositionBilletMaxCents` égale la somme nette des jambes de maison de `mouvementGain` à brut maximal |
| `PLAFOND_JOUEUR_CENTS` est dérivé du pire cas de la table la plus chère | `PLAFOND_JOUEUR_CENTS === PLAFOND_TABLES_PAR_JOUR × pire cas maximal`, pire cas recalculé depuis `WBCore` |
| `plafondVerdict` est monotone et ramène l'exposition réalisée à zéro | Accumuler des pertes n'achète aucune marge ; croître l'exposition ne fait jamais repasser le verdict au vert |
| `referenceBillet` est exhaustive sur la liste fermée des motifs | Les six mouvements et leurs contre-passations : chaque référence produite se ramène au bon billet, ou à `null` quand elle n'en désigne aucun |
| `decouvertAutorise` est faux hors des familles nommées | Balayage de toute forme de compte que la grammaire engendre, pas seulement des deux littéraux de `COMPTES_EMETTEURS` |
| Le plafond par joueur est décidé DANS la transaction du billet et sous le verrou de ligne | Lecture du texte de `db-pg.js` ; et, contre une vraie base, deux ouvertures simultanées qui ne franchissent pas le plafond à deux |
| Le fusible global ne tourne pas sous le verrou et ne se relit qu'à la cadence nommée | Horloge injectée : deux ouvertures dans la même minute ne produisent qu'une lecture |
| Un refus `plafond` ne laisse rien derrière lui | Aucune ligne dans `matches`, aucune écriture dans `ledger_entries`, aucun séquestre habité, `ledgerReconcile` sans grief — et la table moins chère s'ouvre dans la foulée. La portée `joueur` consomme **une graine**, comme `fonds` : voir la correction sous la décision 5 |
| Aucun chemin de règlement ne produit `plafond` | Garde textuelle et parcours des codes que les routes de règlement peuvent émettre |
| Un billet déjà ouvert n'est jamais cassé rétroactivement | On franchit le plafond pendant qu'il vit, on le règle, rien ne change |
| `plafond` est un refus nommé qui arrête le sas | `WBCore.REFUS_SAS` vaut quatre codes, confrontée aux codes que l'API émet vraiment ; le sas s'arrête, affiche, ne lance rien |
| Les pannes silencieuses retombent toujours hors ligne | Les quatre cas nommés, plus un 500 et un 429, portefeuille de démonstration inchangé |
| Le message de refus lit la portée | Deux portées, deux phrases ; portée absente, on rend celle de la maison |
| Un montant absent rend `null` et ne remet aucun solde à zéro | Un refus `plafond` n'écrit aucun montant dans le jeu |
| Un règlement qui paie exige un plancher d'horloge | Encaissement Resurgence annoncé à 30 s zéro seconde après l'ouverture : refusé `plancher` ; le même après une attente réelle : accepté ; les cinquante parties de bout en bout passent toujours |
| `paid_seats` est écrite par le serveur et figée à l'ouverture | Un corps portant `paidSeats: 7` écrit une ligne strictement identique à celle d'un corps minimal ; le chemin `repris` ne la réécrit pas |
| La contrainte de `paid_seats` est `between 1 and seats` | Garde textuelle sur le texte de `schema.sql`, comme la grammaire des comptes et la liste des motifs |
| Le grand livre reste en insertion seule | Aucun `update`, aucun `delete` sur `ledger_entries` ; la seule correction est une contre-passation et elle n'a qu'un écrivain |
| `ledger_audit` est en insertion seule | Garde textuelle sur le schéma et sur `db-pg.js` |
| L'écriture d'argent et sa raison partagent la transaction | Une doublure qui échoue sur l'audit ne laisse aucune contre-passation |
| Rejouer l'outil ne pose rien, et il le DIT | La clé `(motif, reference, compte_debit, compte_credit)` refuse la seconde ; l'outil sort proprement, pas en erreur |
| Une contre-passation restitue exactement | Après contre-passation d'un gain, `soldeDe` retombe là où il était sur les quatre comptes touchés, et le zéro global tient |
| Il n'existe aucune route d'administration | Garde textuelle sur `api/app.js`, qui ne charge jamais `api/operateur.js` |
| Aucune ligne de `matches` ni de `match_traces` ne disparaît avec un compte | Garde textuelle : plus une seule cascade de `users` vers `matches` ni de `matches` vers `match_traces` ; et, contre une vraie base, un `delete from users` refusé tant qu'un billet référence la ligne |
| `users.id` survit à l'anonymisation | `joueur:<id>` et `enjeu:<match_id>` restent des comptes valides, `ledgerReconcile` sans grief avant comme après |
| L'anonymisation est tracée, dans la même transaction, et refusée sans raison écrite | `ledger_audit` porte la ligne ; sans raison, rien n'est écrit |
| L'argent se compte en centimes entiers | Les cinq nouvelles constantes sont des entiers de centimes ou d'heures |
| `index.html` reste un seul fichier statique, jouable sans compte ni serveur | Les blocs `<script>` restent trois et internes ; les seules touches sont un membre de `REFUS_SAS`, sa phrase, et une fonction pure de `WBCore` |
| `npm test` est vert à la fin de CHAQUE module | Sans base et sans réseau, tout injecté dans `createApp()` |

---

## Ce qui n'a de preuve qu'en intégration continue

C'est la partie de cette phase qu'il ne faut pas se raconter. **Quatre** propriétés nouvelles sont
exactement du genre qu'une doublure mono-fil flatte, et la phase 03 a payé cette leçon une fois :
« un test qui passe contre la doublure prouve la doublure. » Le job `services: postgres` n'est vert
que depuis le 2026-09-15 (run 34894629071), et il faut désormais le **regarder** à chaque module, pas
seulement le lancer.

Dans `api/db-check.js`, contre une vraie base :

1. **Deux ouvertures simultanées ne franchissent pas le plafond à deux.** C'est le verrou de ligne,
   et c'est la propriété que la doublure sérialise gratuitement.
2. **La requête de fenêtre ne fait pas de `Seq Scan` sur `ledger_entries`.** Un `explain (format
   json)` sur la requête réelle, et un refus si le plan balaie la table. C'est la seule façon de
   prouver que les index ajoutés servent réellement, et personne ne peut la donner sur la machine de
   travail.
3. **La contre-passation et son audit partagent la transaction**, arbitrée par Postgres et non par
   une doublure qui décide de l'ordre des `await`.
4. **Un `delete from users` est REFUSÉ** tant qu'un billet référence la ligne. Une doublure ne peut
   pas subir une contrainte : elle l'imite.

Le module 6 en particulier — les cascades en `restrict` — a une surface de régression **vide**
aujourd'hui : `api/README.md` dit « Pas de suppression de compte », donc il n'existe aucun chemin
qu'on puisse casser. C'est du travail défensif juste, et il doit être présenté comme tel : un module
dont l'unique effet observable est un refus, et qu'on ne saura vert qu'en intégration continue.

---

## Les risques

**Le solveur hors ligne, et c'est lui qui dimensionne le plafond.** L'attaque qui saturera le
plafond n'est ni l'aimbot ni l'ESP — ce que le dossier répète depuis la 02b — c'est le solveur.
Vérifié au caractère près : le client reçoit `seed_public` avec son billet, la partie entière est une
**fonction pure** de cette graine et de la trace, `REPLAY_BUDGET_MS = 2000` prouve qu'elle se rejoue
en quelques centaines de millisecondes, et chercher hors ligne la trace qui maximise `argentCents` ne
demande aucun talent et se parallélise. Sans le module 2 de cette phase, l'attente réelle exigée
d'un encaissement Resurgence est **nulle** : `ENVELOPPE.margeHorlogeS` vaut 120, `LOBBY.wait` vaut
25, et le plancher d'horloge existant ne s'arme que sur la branche `victoire`. Un solveur atteint
donc le pire cas de 39 000 à chaque partie. Le plancher le ramène au rythme d'un joueur ; il ne le
ferme pas. Un plafond dont la contrainte active est une triche non fermée est un plafond dimensionné
pour le tricheur, et c'est ce qu'il faut savoir en lisant les 156 000.

**Le plafond décide quelles tables existent.** Sous 39 000, la Resurgence à 10 $ devient impossible à
ouvrir pour tout le monde et tout le temps, et la panne se lira comme un bug du lobby. Le nombre doit
être relu chaque fois qu'un mode ou un palier change ; un test le rattache explicitement au pire cas
de la table la plus chère, et il tombe si ce pire cas bouge.

**Et il décide aussi combien de tables restent ouvertes après une victoire.** La panne symétrique est
certaine et se lit exactement pareil : un gagnant maximal consomme 39 000, son billet suivant sur la
même table en pèse autant, et sous 78 000 de plafond il lit `plafond` sur un lobby qui a l'air cassé.
C'est le second ancrage, et il est aussi important que le plancher.

**Un plafond par joueur ne borne pas une flotte de comptes.** Crossmint donne une identité par
adresse email, et rien n'empêche cinquante adresses. Le fusible global est la seule réponse de cette
phase, il vaut environ treize comptes saturés, et quand il saute il refuse tout le monde. Ce n'est
pas un invariant, c'est un aveu daté : le remède est une vérification d'identité, en 04b.

**Le fusible global est un point de panne unique.** Mal réglé, il transforme un pic de gains
légitimes en panne totale du lobby pour tous les joueurs connectés. Il doit être assez haut pour ne
jamais se déclencher en jeu normal, et son déclenchement doit se lire comme une alerte. Cette phase
ne livre **aucune alerte** : le seul signal est le refus lui-même, lu dans les logs. C'est une limite
connue, pas une fonctionnalité omise par distraction.

**L'exposition nette est un choix.** Un joueur qui perd beaucoup puis gagne beaucoup passe le
plafond. Le clamp à zéro empêche d'accumuler de la marge, mais la fenêtre glissante reste
manipulable en étalant les gains sur deux jours.

**La requête de fenêtre allonge le chemin le plus disputé du système.** Elle est bornée par joueur
et servie par deux index nouveaux, et le fusible global en est sorti — mais les deux index sont
posés sans qu'aucune donnée réelle n'existe pour les valider, et le seul contrôle qui les regarde
travailler est un `explain` en intégration continue. Le coût réel se mesurera sur une base qui a
vécu, pas ici.

**Deux états vivent en mémoire du processus** : la limitation de débit, qui couvre désormais des
routes qui écrivent, et le fusible global. Ils sont perdus au redémarrage et non partagés entre
instances. Un déploiement à deux processus double donc de fait le fusible.

**`paid_seats` est un enregistrement, pas un levier.** Tant qu'un billet EST une table, elle vaut
toujours 1. Le risque est de croire la mesure attributive avant qu'un identifiant de table partagée
n'existe, et de tirer des conclusions d'un agrégat qui n'a qu'un seul groupe.

**L'anonymisation libère `name_key`.** L'historique se lit alors sur l'`id` et jamais sur le nom.

**Le passage des cascades en `restrict` peut faire échouer des suppressions** que du code existant
tenait pour acquises. La surface est vide aujourd'hui — mais c'est vrai **aujourd'hui seulement**, et
c'est un test qui doit le dire, pas une lecture.

**Le module 1 se livre sans un seul appelant**, et ce choix coûte un module non exercé. C'est la
doctrine « le contrat avant le brancheur », déjà employée en 02a pour `seedFor` et `matchFlow`, et
elle a le même prix : si le module qui branche glissait, trois fonctions et cinq constantes
resteraient du code mort que personne n'aurait vu tourner.

---

## Ce qui est renvoyé aux phases suivantes

- **04b — le dépôt.** Compte fournisseur, webhook, idempotence sur l'événement de paiement, KYC,
  cadre légal. Le motif `depot` du grand livre s'ouvre là et pas avant. La doctrine en quatre phrases
  est consignée dans `docs/HISTORIQUE.md`.
- **04b — la vérification d'identité**, seul remède réel à la flotte de comptes.
- **Avant la première écriture de production** : la devise en premier segment du nom de compte, et
  le séquestre portant le pot notionnel entier. Gratuites aujourd'hui, une reprise de données après.
- **05 — le retrait**, et la question du solde jouable contre le solde retirable.
- **05 — l'identifiant de table partagée**, qui rendra `paid_seats` attributif.
- **06 — le sort de la quarantaine** et le seuil sur `ecart_cents`, sur données réelles.
- **06 — le relevé d'exploitation** : exposition par jour, par joueur, par mode, et une vraie alerte
  sur le fusible.
- **Hors phases** : le drainage d'un déploiement ; la session de jeu réelle, la plus vieille dette du
  dossier ; le lobby mobile ; et la doctrine du clamp — on ne refuse pas la triche, on la joue
  bornée des deux côtés — qui est la seule réponse du lot rendant une triche impossible plutôt que
  coûteuse.

---

## Les six modules

Chaque module laisse `npm test` vert, sans base et sans réseau. Chacun relit les **quatre** endroits
où vit le compte des tests — `CLAUDE.md`, `README.md`, `api/README.md`, `docs/HISTORIQUE.md` — parce
qu'il a déjà décroché deux fois. Chacun, s'il touche une clause SQL, regarde le job `db` et rapporte
ce qu'il dit.

1. **L'exposition se nomme, se chiffre, et n'est appelée par personne.** `api/ledger.js` : cinq
   constantes entières, `expositionBilletMaxCents`, `referenceBillet` et sa traduction SQL,
   `expositionDe`, `plafondVerdict`. Aucun appelant, aucune route, aucune colonne.
2. **La marge se resserre là où elle protège de l'argent.** `WBCore.horlogePlancher`,
   `ENVELOPPE.margePlancherS`, le refus `plancher` armé sur tout règlement qui paie. Pur, sans
   réseau, sans base, sans montée de `SIM_VERSION`.
3. **Combien de sièges un humain a payés.** `matches.paid_seats`, écrite par le serveur, figée,
   contrainte, dormante et assumée telle.
4. **Le plafond refuse à l'ouverture, et le sas le dit.** Le branchement : `api/app.js`,
   `api/db-pg.js`, les deux index, le fusible amorti, `WBCore.REFUS_SAS` à quatre membres et son
   message qui lit la portée.
5. **Qui a le droit de contre-passer.** `ledger_audit`, `api/operateur.js` et ses verbes `montrer` et
   `contrepasser`, `planCorrection` pure, la garde « aucune route d'administration ».
6. **Un compte ne s'efface pas, il s'anonymise.** Les cascades en `restrict`, le verbe `anonymiser`,
   et la clôture de la phase : les quatre endroits du compte des tests relus ensemble, et
   `docs/HISTORIQUE.md` qui corrige au passage son entrée périmée sur l'écran de fin, fermée depuis
   le commit 8f0a63f.
