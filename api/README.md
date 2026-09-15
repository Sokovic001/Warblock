# API Warblock — comptes et profils (phase 01), billet de partie (phase 02a), rejeu de partie (phase 02b), grand livre (phase 03), bord de l'argent réel (phase 04a)

Le jeu reste ce qu'il est : un seul fichier `index.html`, servi en statique, sans build. Ce dossier
ajoute à côté un petit serveur qui détient les profils, et depuis la phase 02a l'**identité des
parties**. Les deux communiquent par HTTPS, et le jeu ne devient dépendant du serveur que pour le
profil : sans compte, sans réseau et sans billet, il se lance et se joue exactement comme avant.

**Aucun argent ne circule dans cette phase.** Il n'y a pas de colonne « solde », volontairement :
en phase 03 le solde sera la somme d'écritures immuables, et une case qu'on écrase serait
exactement ce qu'il faudrait supprimer. Mieux vaut ne pas la créer.

## Ce que le serveur fait

| Route | Ce qu'elle fait |
|---|---|
| `GET /api/health` | Répond `{ ok: true }`. Pour la surveillance. |
| `GET /api/me` | Rend le profil du joueur connecté, **statistiques agrégées** et **deux montants du grand livre** compris. La première connexion crée le compte, le **dote**, et le **recharge** s'il est sous le plancher. |
| `PATCH /api/me` | Change le pseudo, l'avatar ou le pays. Rien d'autre n'est modifiable. |
| `POST /api/match` | Émet le **billet** d'une partie — graines, mise en centimes, sièges, version de simulation, expiration — **et débite la mise**, dans la même transaction. |
| `POST /api/match/:id/trace` | Reçoit la **trace des entrées du joueur**, en segments, en insertion seule. |
| `POST /api/match/:id/result` | **Rejoue la partie**, recalcule les faits, juge, **clôt** la ligne et **écrit le gain**, dans la même transaction. |
| `POST /api/match/:id/renounce` | **Rend la mise** et clôt le billet en `'renounced'` — uniquement pendant la **fenêtre de renoncement**, à l'horloge du serveur. La seule route du dépôt qui rende une mise. |

Tout le reste répond 404. Toutes exigent un jeton de session valide, sauf `/api/health`.

## `POST /api/match` — le billet d'une partie

Le serveur possède l'identité de la partie ; le client ne fait que la demander. Il choisit sa table,
son mode et son brawler, **et rien d'autre**.

```
POST /api/match      { mode, stake, brawler, clientKey }
→ 200                { id, mode, stakeCents, seats, teamSize, brawler, seed, status, openedAt, expiresAt,
                       repris, balanceCents, quarantineCents }
→ 409                { erreur, code: 'fonds', balanceCents, quarantineCents, requiredCents }
→ 409                { erreur, code: 'renonce_recent', windowSeconds }
→ 409                { erreur, code: 'plafond', portee, expositionCents, plafondCents, fenetreHeures,
                       aucuneTableMoinsChere }
```

- `mode` est une clé de `WBCore.MODES`, `stake` la mise **en dollars telle qu'elle est affichée** et
  qui doit figurer dans `WBCore.TIERS`, `brawler` une clé de `WBCore.BRAWLERS`. Un mode inconnu, une
  mise absente des tables ou un brawler inventé donnent un `400` dont le message dit quoi corriger.
- `clientKey` est tirée par le client. Sans elle, un `POST` dont la réponse se perd est
  indistinguable d'un `POST` jamais arrivé.
- Le corps **ne peut pas** porter de graine, de sièges, de montant, de statut ni d'identifiant
  d'utilisateur. Ces champs ne sont pas refusés, ils sont sans effet : un corps qui les porte tous
  écrit exactement la même ligne qu'un corps minimal, et un test le vérifie ligne à ligne.
- La mise est convertie par `WBCore.toCents()` à partir de la table retrouvée, jamais à partir du
  nombre reçu : une table à 0,50 $ s'enregistre `50`, entier.

**Deux graines, et une seule sort.** La publique — 32 bits, le domaine de `makeRng` — détermine la
carte, le gaz, les caisses et les vingt bots, et part au client sous le nom `seed`, celui que
`WBCore.seedFor` lit dans le billet. Elle reste 32 bits parce que tout le contrat client de la 02a en
dépend, et parce que son entropie est publique par construction.

La **secrète** ne quitte jamais le serveur, et depuis la phase 02b le commentaire du schéma dit la
vérité sur elle : **dans une architecture de rejeu, elle ne protège rien et la simulation ne
l'utilise pas.** Le client possède tout ce qu'il dessine — il dessine les caisses, donc il en connaît
le contenu dès la première seconde. Elle reste pour le jour où le serveur décidera de quelque chose
que le client n'a pas à savoir. Elle est passée de 32 bits à **128, en hexadécimal** :
`between 0 and 4294967295` la rendait trouvable par force brute hors ligne, et une colonne qui porte
un nom qui ment est pire que pas de colonne. Aucune base n'ayant jamais tourné, l'élargir coûte
encore zéro migration.

Les deux sortent de sources **injectées** dans `createApp` — `randomSeed` et `randomSecret`, deux
robinets depuis qu'elles n'ont plus le même domaine — comme la base et la vérification du jeton, ce
qui les rend observables en test ; par défaut, le générateur du système.

**`sim_version` est figée à l'ouverture, et le client ne peut pas l'écrire.** Elle est lue sur le
bloc `WBSim` que le serveur a chargé au démarrage, jamais dans le corps de la requête, et elle ne
part pas au client. Un correctif de simulation déployé pendant qu'un joueur joue rejouerait une AUTRE
partie que la sienne et paierait autre chose que ce qu'il a vu : c'est la raison exacte pour laquelle
`seats` et `team_size` sont déjà figés ici. Corollaire d'exploitation, à ranger avec les décisions
hors phases : **un déploiement se draine, il n'écrase pas les billets ouverts** — au plus une
quinzaine de minutes.

**`paid_seats` est figée de la même façon, et elle est DORMANTE — assumé.** Elle dit combien de
sièges de la table un humain a payés. `integer not null`, borne
`check (paid_seats between 1 and seats)`, écrite par le serveur, jamais lue dans le corps de la
requête, et le chemin `repris` ne la réécrit pas. Elle vaut **1** sur toutes les lignes : un billet
**est** une table tant qu'il n'existe pas d'identifiant de table partagée — renvoyé à la phase 05 —
donc le seul humain assis est celui qui ouvre le billet, et les autres sièges sont des bots, qui ne
misent rien. **Rien ne la lit, et il ne faut pas lui inventer un lecteur** : un montant *notionnel*
`stake_cents × paid_seats` posé à côté du montant *réalisé* du grand livre serait la paire qu'on
finit par confondre. La raison de l'écrire quand même est celle qui fige `seats` : après coup, rien
ne permet de retrouver le chiffre, et l'exposition de la maison cesse d'être attribuable dès le
premier remplissage partiel. La justification complète est au-dessus de la colonne, dans
`schema.sql`, et une garde textuelle vérifie qu'elle y reste. Sa borne regarde **deux** colonnes :
la doublure d'`api/test.js` l'imite, seul `api/db-check.js` la fait subir.

**L'expiration part avec le billet, pas après.** Elle vaut `LOBBY.wait` + la durée complète du plan de
zone de ce mode — la borne haute d'une partie que personne ne gagne — + dix minutes de marge. Elle
est donc plus courte en Resurgence, dont le gaz est rapide. La marge est un compromis assumé : trop
courte, elle périme la partie d'un joueur dont l'onglet est passé en arrière-plan ; trop longue, elle
enferme dans un billet mort celui qui a fermé le sien, puisqu'un joueur n'a qu'un billet ouvert à la
fois. Aucun argent n'est en jeu en 02a : on préfère perdre une ligne de statistique que bloquer un
joueur.

**L'idempotence est arbitrée par la base, jamais par un `select` préalable** — même doctrine que
`name_key`. Deux index : `(user_id, client_key)` et un index **partiel** sur `(user_id)
where status='open'`. On insère, et c'est l'insertion refusée qui apprend ce qui existait déjà.
Conséquences, toutes testées :

- un second appel rend le billet ouvert existant, avec un `200` et jamais une erreur — **à
  condition qu'aucune partie n'ait encore été rendue dessus** ;
- la clé qui a **créé** un billet rend toujours ce billet, même une fois périmé : la ligne porte la
  clé, donc la réponse ne change plus ;
- un billet périmé est clos (`status = 'expired'`) au moment où l'insertion bute dessus, ce qui
  libère la place. Le seul `update` de cette table, et il ne touche qu'un statut, jamais un montant.

**`repris` est le SEUL champ par lequel un rejeu se distingue du premier appel**, et c'est une
exception écrite à la doctrine ci-dessus. Ce que l'idempotence promet reste entier : même
identifiant, même graine, même mise, aucune écriture de plus. Ce booléen ne décrit pas le **billet**,
il décrit le **chemin** qui l'a servi, et il part au client pour une raison d'argent : un billet
repris porte l'heure d'ouverture d'un sas **précédent**, donc le bouton QUITTER du jeu ne peut pas
déduire son âge de son propre chronomètre. Le taire faisait promettre à l'écran un remboursement que
la route de renoncement refusait ensuite, sans un mot, pour une mise entière. `createMatch` le
calculait déjà sur ses trois chemins ; il ne manquait que le passage au client.

**Les trois routes à identifiant refusent un zéro de tête.** `([1-9][0-9]{0,18})`, et pas
`([0-9]{1,19})` : un `bigserial` n'en produit jamais, mais Postgres convertit « 007 » en `bigint` 7
et retrouve donc la ligne — si bien qu'un paramètre brut pouvait servir à nommer un compte du grand
livre, où « 007 » est refusé à juste titre, et où le refus sortait en **500** sur la seule route qui
rende une mise. Le chemin est désormais un 404 « Route inconnue » avant d'atteindre quoi que ce soit.
C'est la ceinture ; les bretelles sont dans `db-pg.js`, où un compte ne se nomme **jamais** avec le
paramètre reçu mais toujours avec l'`id` de la ligne relue.

**UN BILLET NE SERT QU'UNE TENTATIVE, ET C'EST UNE RÈGLE D'ARGENT.** Depuis que le serveur rejoue,
toute la partie est une fonction pure de `seed_public` : la carte, les caisses, les vingt bots et le
plan de gaz. Un billet resservi est donc le **même monde**. Sans cette règle, il suffisait de bloquer
l'envoi de sa trace — un bloqueur, un wifi coupé deux secondes — pour recevoir un 409, garder son
billet ouvert, recliquer sur la table, retrouver la même graine, et rejouer en connaissance de cause
le monde qu'on venait d'explorer, autant de fois que la vie du billet le permet, jusqu'à faire régler
sa meilleure tentative. Ce n'est pas l'ESP structurel déjà consigné — le client connaît le butin de
la partie qu'il joue — c'est une répétition générale gratuite de la partie qu'il va faire payer.

La colonne `first_result_at` est donc posée par `POST /api/match/:id/result` dès qu'un résultat
arrive, **quelle qu'en soit l'issue**, et une seule fois : la clause porte `status = 'open' and
first_result_at is null`, si bien qu'un résultat renvoyé ne modifie pas la ligne et que
l'idempotence de la route reste totale. `createMatch` ne rend alors plus ce billet — il le clôt sans
montant (`status = 'abandoned'`, comme le veilleur) et en ouvre un neuf, donc une graine neuve. Ce
qui reste ouvert, et qui est tout l'équilibre : renvoyer une trace perdue puis son résultat sur le
**même** `match_id` marche toujours. On ferme la porte d'un second monde identique, pas celle du
joueur dont le réseau a lâché.

Une limite connue, écrite plutôt que passée sous silence : une clé arrivée **pendant** qu'un billet
était déjà ouvert n'écrit aucune ligne — elle reçoit ce billet-là. Rejouée après l'expiration de
celui-ci, elle en ouvrira donc un nouveau. L'idempotence est totale tant que le billet est ouvert,
c'est-à-dire pendant toute la fenêtre où une réponse perdue peut être rejouée, et pas au-delà.
L'étendre demanderait une table d'alias, pour un cas que le client ne produit pas : chaque tentative
tire une clé neuve. Un test porte ce comportement, pour qu'il soit constaté et non découvert.

Le code de réponse est `200` même à la création, et non `201` : un code différent selon que le billet
vient d'être créé ou qu'il existait déjà rendrait le rejeu distinguable du premier appel.

**Un piège du pilote, à connaître avant d'écrire la route suivante.** `pg` rend les colonnes
`bigint` sous forme de **chaîne** — il ne peut pas garantir qu'elles tiennent dans un nombre
JavaScript. Une graine en chaîne est refusée par `seedFor`, qui repartirait sur la graine locale :
le joueur verrait une autre carte que celle de son billet, sans le moindre message. Les deux graines
sont donc converties en nombre dans `db-pg.js`, et une seconde fois dans la liste blanche de
`app.js` — deux lignes, parce que la panne est silencieuse. `id` et `user_id` restent des chaînes,
volontairement : on ne fait que les recopier.

**Aucune colonne solde, ici comme ailleurs.** `stake_cents` est une mise engagée, pas de l'argent
détenu. La ligne s'insère puis se règle **une fois**, par la route ci-dessous.

**Depuis la phase 03, cette route DÉBITE.** Le détail est plus bas, avec le verrou, le refus
`409 fonds` et les deux montants rendus avec le billet.

## `POST /api/match/:id/trace` — la trace des entrées du joueur

```
POST /api/match/12/trace   { seq, simVersion, data }
→ 200                      { matchId, seq, segments, totalSteps }
```

Le serveur rejouera la partie depuis la graine publique du billet ; elle lui donne la carte, le gaz,
les caisses et les vingt bots. **Il ne lui manque que ce que le joueur a fait**, et c'est tout ce que
cette route transporte. Enregistrer les positions des bots ferait du client l'auteur de ses propres
adversaires — la triche la plus simple qu'on puisse offrir — et multiplierait la taille par vingt.

**La trace est quantifiée à la source**, et c'est ce qui rend le rejeu exact plutôt qu'approximatif :
`lireEntrees()` rend la valeur **quantifiée**, le jeu joue celle-là, et la trace porte le même
entier. Sans cela, le serveur rejouerait une partie légèrement différente de celle qui s'est affichée
et l'écart n'aurait aucune borne connue. Le prix est une visée arrondie au 1024e de tour — 0,35
degré, six centimètres à dix cases, la même table `C.UNIT` que la géométrie de la graine — une portée
de visée au huitième de case et un déplacement au quinzième de course. Rien de percevable.

Le format vit dans `WBCore` (`traceMots`, `traceEnregistreur`, `traceDecode`) parce que le jeu et le
serveur le lisent tous les deux : cinq caractères base64url par pas distinct, plus un jeton de
répétition pour les plages identiques, plus un jeton d'**action ponctuelle** — tir bref, super,
fumigène, encaissement, abandon — car celles-là partent d'un événement d'entrée, entre deux pas, et
non du pas lui-même. Sans ces jetons, une partie rejouée n'aurait ni super ni fumigène.

**L'envoi se fait à la fin de la partie, jamais pendant** : enregistrer une trace ne coûte jamais une
image — un pas identique au précédent n'alloue rien, il incrémente un compteur — et l'envoyer non
plus. Il part avant le rapport, parce que le rejeu en aura besoin au moment du règlement. **Sans
billet, aucune trace n'est enregistrée ni envoyée**, et le jeu se comporte exactement comme avant la
phase : c'est la promesse du fichier unique, et les quatre cas nommés de la 02a restent testés comme
des cas normaux.

**La table `match_traces` est en insertion seule.** Clé primaire `(match_id, seq)`,
`on conflict do nothing`, **premier écrit gagne**, aucun `update`, aucun `delete` : c'est la doctrine
d'idempotence déjà arbitrée par la base en 02a, poussée jusqu'au bout. Un segment renvoyé n'écrit pas
de seconde ligne et ne réécrit pas la première — sinon un client pourrait réécrire sa trace après
coup, ce qui la viderait de toute valeur de preuve. Un renvoi **à l'identique** rend donc exactement
la même réponse que le premier appel : elle dit l'état de la trace, jamais si la ligne vient d'être
écrite.

**Mais un rang déjà posé dont les données DIFFÈRENT est refusé, en 409 `trace_divergente`.** Avalé en
silence, il permettait de **coudre deux parties bout à bout** : le segment 0 d'une tentative et les
segments suivants d'une autre se recollaient en une partie que personne n'a jouée, et le serveur
écrivait un montant dessus. Le premier écrit gagne toujours — la ligne posée ne bouge pas d'un
caractère — mais le client apprend enfin que son segment n'a pas été pris, et son envoi s'arrête là.

**Un segment qui ne porte que des jetons d'acte est ACCEPTÉ, et sa colonne `steps` vaut zéro.** Le
découpage coupe au **jeton**, et un jeton d'action ponctuelle ne compte aucun pas : quand la
frontière des 24 000 caractères tombe juste avant le dernier geste, le segment de queue ne porte que
l'abandon ou l'encaissement. Le refuser sur un décompte de pas nul coupait l'envoi juste avant la fin
de la partie, le rejeu s'arrêtait avant l'acte terminal, et le règlement sortait en `non_terminal`
sans écrire un centime — sur une partie parfaitement honnête. Ce qui reste refusé, c'est le segment
**sans contenu**, avec le détail `vide`.

**Trois bornes, et chacune dit ce qu'elle borne.**

- `MAX_TRACE_BODY` (32 Ko) vaut **sur cette route et sur elle seule**. `MAX_BODY` ne bouge pas :
  relever la borne de la route qui décide d'un règlement ferait de la route de l'argent la surface
  d'attaque la plus large de l'API, et « la raison est écrite » n'est pas une protection. `lireCorps`
  prend donc sa borne en argument, et un seul appel la relève.
- `traceMaxSteps(plan)` borne le nombre de **pas**, et il se déduit du plan de zone du billet — la
  durée maximale d'une partie que personne ne gagne, plus la protection d'apparition, plus le compte
  à rebours d'intro qui consomme des pas sans faire avancer `G.pas`. Il suit donc le mode : le gaz
  rapide de Resurgence donne une borne plus courte.
- Le nombre de pas d'un segment est **compté** par le serveur en relisant la grammaire, jamais
  annoncé par le client. Un nombre déclaré aurait été un nombre de plus à ne pas croire.

**Une trace refusée sort en 400 ou 409, jamais en 500, et ne laisse jamais la ligne `matches`
bloquée.** C'est la leçon du `22003` : un joueur n'a qu'un billet ouvert à la fois, donc un 500 qui
laisse la ligne `open` l'enferme jusqu'à l'expiration. Ici la garantie est **structurelle** — cette
route n'écrit jamais dans `matches`, pas même pour clore une ligne périmée, que le veilleur de la 02a
ramasse déjà. Huit codes nommés, chacun testé : `corps`, `seq`, `sim_version`, `donnees`,
`trop_de_pas`, `trace_divergente`, `billet_clos`, `expire`, plus un `404` pour un billet inconnu ou
qui n'est pas le sien.

**La dette, nommée plutôt que tue** : `match_traces` n'a **aucune politique de conservation**, et
elle est renvoyée à la phase 03. Et comme partout ailleurs dans ce dossier, aucune base n'a jamais
tourné : la clé primaire `(match_id, seq)` et le premier-écrit-gagne n'ont été éprouvés que contre
une doublure, et **un test qui passe contre la doublure prouve la doublure**.

## `POST /api/match/:id/result` — le rejeu, puis le verdict

```
POST /api/match/12/result   le rapport, tel que WBCore.reportFrom() le produit
→ 200                       { matchId, status, issue, controle, motif,
                              grossCents, feeCents, netCents, purseCents,
                              declaredNetCents, ecartCents, settledAt,
                              traceSteps, digestMatch, divergenceStep, replayMs }
```

Le corps **est** le rapport, sans enveloppe : `seconds`, `kills`, `deaths`, `rank`, `cubes`,
`damage`, `cashedOut`, `purseCents`, `declaredNetCents`, `digests`. `WBCore.checkReport()` le lit et
**refuse tout champ inconnu, avec un code** (`inconnu`, `manquant`, `type`, `borne`, `corps`). Chaque
entier y porte aussi une **borne haute**, et elle vient du schéma et non du jeu : ces champs
finissent dans des colonnes `integer`, qui s'arrêtent à 2 147 483 647. Sans elle, un rapport
« valide » à 3 000 000 000 faisait lever `22003` à Postgres, répondre 500 à la route, et **laissait la
ligne ouverte** — le joueur enfermé dans un billet mort jusqu'à l'expiration, puisqu'il n'en a qu'un
à la fois. Un refus motivé en 400 vaut mieux qu'un 500 muet : `PATCH
/api/me` ignore les champs en trop et c'est bien pour un profil, mais sur un rapport qui décide
d'un montant le silence est la mauvaise valeur par défaut.

### Le serveur REJOUE la partie, et ne croit plus aucun fait déclaré

**La forme de la route n'a pas changé d'une virgule**, et c'était la promesse écrite en 02a : « on
remplace le corps de `matchVerdict` par une vraie simulation sans changer une seule route ». Ce qui a
changé est ce qu'elle fait de ce qu'on lui envoie.

Le serveur prend la **graine publique** du billet — elle lui donne la carte, le gaz, les caisses et
les vingt bots — et la **trace** lue dans `match_traces` — elle lui donne ce que le joueur a fait —
puis il refait la partie avec le bloc `WBSim`, le même que le navigateur exécute. Il n'y a rien
d'autre dans une partie. De cette partie rejouée il tire la **durée** (en pas × `SIM.stepS`, jamais
sur une horloge), les **kills**, les **morts**, le **rang**, les **cubes**, les **dégâts** et la
**sacoche**. Ces faits-là, et eux seuls, vont à `matchVerdict` puis en base.

Deux champs du corps survivent, et aucun ne décide d'un montant :

- `declaredNetCents`, ce que le client **croit** avoir gagné. Il garde exactement son rôle de la
  02a : `ecart_cents` mesure la différence avec ce que le serveur compte. Une **observation, jamais
  une punition, jamais un paiement** — c'est sur ces écarts que la phase 06 fixera un seuil, et les
  jeter maintenant perdrait les données qui le fixeront.
- `digests`, la suite des **condensés d'état** du client, un par `WBSim.EMPREINTE_PAS` pas simulés.
  Elle ne sert qu'à dire si le rejeu a convergé, et à partir de quel pas il s'en est écarté.

Un test porte cette phrase entière : **un corps dont les kills, la sacoche et la durée sont gonflés
écrit une ligne strictement identique à celle d'un corps sincère.** C'est le patron de la 02a — « un
corps portant une graine écrit une ligne identique à celle d'un corps vide » — étendu des
*paramètres* aux *faits*.

Et l'exemple canonique, celui que la spécification nomme : **prendre un billet, ne jamais jouer,
attendre cinq secondes, rendre `{rank:1, seconds:10, purseCents: mise × sièges}`**. Ce corps passait
mot pour mot en 02a et valait 800 centimes sur une table à 0,50 $. Il vaut désormais **zéro** :
aucune trace n'est arrivée, donc il n'y a pas de partie à juger.

### Une ligne ne se clôt QUE sur un état terminal

C'est le vrai trou d'un rejeu différé, et il s'ouvre le jour où un euro entre : **tronquer une trace
ne doit jamais rien payer.** Sans cette règle, couper le réseau juste après un gros kill deviendrait
la meilleure stratégie du jeu — la partie resterait à jamais dans son meilleur instant.

Le rejeu doit donc atteindre une **fin** — un vainqueur, un encaissement du joueur, sa mort
définitive, ou la fin du plan de zone — pour que la route écrive un montant. Sinon elle n'écrit
**aucun** montant, nomme ce qui lui manque, et laisse le billet au **veilleur** de la 02a, qui le clôt
sans montant. C'est le seul endroit du dossier qui refuse sans clore, et c'est délibéré : clore ici
ferait un second endroit qui ferme une ligne, et un joueur dont la trace s'est perdue en route mérite
de pouvoir la renvoyer tant que son billet vit.

Trois règles de simulation vivent dans le jeu pour que cette phrase tienne, et deux y sont
descendues tard : le **compte à rebours d'intro**, posé par `newMatch` — écrit dans le seul bloc
`Game`, le serveur rejouait en pas RÉELS les deux cent quarante pas passés à décompter et jugeait
une autre partie que celle qui s'était affichée — et `WBSim.abandon`, parce que QUITTER se presse
aussi pendant les cinq secondes de réapparition, où `kill` sort sur `!alive` : la partie n'atteignait
alors jamais d'état terminal, et le joueur ne voyait jamais la sienne enregistrée.

La règle qui décide, `WBSim.terminal`, vit dans le **jeu** et pas dans l'API : le serveur et le
navigateur doivent en avoir exactement une idée. Idem pour les faits eux-mêmes — `WBSim.faits` est la
seule définition de ce qu'est la durée, le rang ou la sacoche d'une partie finie, et `endMatch`, le
harnais de `test.js` et cette route la lisent tous les trois. Trois copies d'une même définition
auraient fini par juger une autre partie que celle que l'écran du joueur venait d'afficher.

Le corollaire se teste entièrement hors ligne, et il l'est : pour une trace terminale et chacun de
ses préfixes, `net(préfixe) ≤ net(complète)`, et `net = 0` sans état terminal.

### La conservation de l'argent est assertée au moment du règlement

Sur la partie **réellement rejouée** : sacoches + butin au sol + encaissé = `mise × sièges`. Elle ne
coûte rien là, et c'est elle qui fonde `purseBound`, donc le seul plafond de paiement qui existe. Si
elle est fausse, ce n'est pas le joueur qui triche, c'est le serveur qui se trompe — et un serveur qui
se trompe n'écrit surtout pas de montant : la ligne part au veilleur avec le code `conservation`.

### Une divergence est MESURÉE, jamais punie

`Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp près par ECMAScript. Une
divergence entre le rejeu du serveur et l'empreinte du client peut donc ne prouver qu'une chose : les
deux n'ont pas la même bibliothèque mathématique. Refuser ce joueur serait le **quatrième contrôle
« évident » et faux** de ce dossier.

La ligne est donc **réglée et payée**, marquée `digest_match = false`, avec `divergence_step` — le
premier pas où les deux empreintes s'écartent, au pas d'empreinte près — et `replay_ms`. Et la
garantie, écrite noir sur blanc, est celle dont la phase 03 a besoin : **le grand livre ne lira jamais
que des lignes dont le rejeu a convergé.**

Reste le défaut de ce choix, qu'il faut traiter et pas seulement avouer : une liste d'exclusion qui
grandit en silence laisserait la phase 03 hériter d'un filtre dont personne ne connaît le rendement.
Les statistiques exposent donc le **taux de divergence** comme un agrégat de plus, `stats.divergences`
à côté de `stats.matches` — deux entiers, pas un flottant, et le taux se déduit des deux. Un test
vérifie qu'**aucun** des quatre autres agrégats ne compte une ligne divergente.

Un client qui n'envoie pas de condensés n'est pas un tricheur : il ne prouve simplement aucune
convergence. Sa ligne est réglée, payée, et comptée comme divergente. La valeur par défaut sûre est
« non convergé », jamais l'inverse.

### Le budget de calcul

Un rejeu tourne **dans le fil de la requête**, et une trace adversariale peut chercher à en maximiser
le coût : c'est la surface d'attaque que cette phase ajoute. `REPLAY_BUDGET_MS` (2 000 ms) la borne.
Une partie solo complète — neuf mille pas, vingt brawlers — coûte environ trois cents millisecondes
sur la machine de développement, donc six fois la marge. Le dépassement est un **code nommé**, jamais
une exception, et il s'éprouve avec une **horloge injectée**, donc sans attendre : `createApp` reçoit
`chrono` en plus de `now`. Les deux ne mesurent pas la même chose — `now` donne une **date** et décide
si un billet a expiré, `chrono` mesure une **durée**. Les confondre rendait le budget intestable.

### Les refus du rejeu : six codes nommés, plus deux gardes

| Code | HTTP | Ce qu'il dit |
|---|---|---|
| `trop_de_pas` | 400 | la trace dépasse à elle seule la durée maximale d'une partie de ce mode |
| `donnees` | 400 | trace illisible, ou segments qui ne se recollent pas (un rang manquant) |
| `trace_absente` | 409 | aucune trace n'est arrivée : il n'y a pas de partie à juger |
| `non_terminal` | 409 | la trace s'arrête avant la fin de la partie |
| `sim_version` | 409 | le billet a été ouvert sous une autre version de la simulation |
| `budget` | 409 | le rejeu a dépassé `REPLAY_BUDGET_MS` |
| `billet` | 409 | garde : le billet désigne un mode ou un brawler que le jeu ne connaît plus |
| `conservation` | 409 | garde : l'argent ne se conserve pas dans la partie rejouée |

**Aucun n'est un 500, et aucun ne laisse la ligne sans issue.** C'est la leçon du `22003` : un joueur
n'a qu'un billet ouvert à la fois, donc une route qui échoue en laissant la ligne `open` l'enferme
jusqu'à l'expiration. Ici la ligne reste ouverte **volontairement**, sans le moindre montant, et un
test vérifie pour chacun des huit codes que le veilleur la ramasse ensuite.

Un **billet périmé** ne se rejoue pas du tout : la partie qu'il désigne ne se règle plus, quoi qu'ait
fait le joueur, et deux secondes de fil pour arriver au même refus seraient deux secondes perdues. La
ligne passe en `expired`, comme en 02a, avec des faits **mis à zéro** plutôt que recopiés du corps :
même sur un refus, aucun fait déclaré n'entre en base.

### Le verdict reste une **enveloppe de plausibilité**, et c'est maintenant la seconde protection

`WBCore.matchVerdict()` est une fonction pure qui reçoit le billet, le rapport et **une horloge en
argument**. Le billet porte `seats` **et** `team_size`, figés à l'ouverture : un résultat est
accepté jusqu'à l'expiration, et un serveur redémarré entre-temps avec un mode rééquilibré jugerait
la partie contre une table que personne n'a achetée.

**Elle ne disparaît pas avec le rejeu, et c'est le point.** Elle reçoit désormais des faits
**recalculés** au lieu de faits déclarés, et elle reste pour la raison exacte qui la rendait
insuffisante hier : si le rejeu se trompe, plus rien ne regarderait le montant avant de l'écrire.
L'enveloppe cesse d'être la seule protection, elle devient la seconde. Elle mord encore, et sur des
faits que le client ne choisit plus : une partie de cent quatre secondes rendue à l'instant où le
billet s'ouvre est refusée par le contrôle `chronometre`, quelle que soit la qualité de la trace qui
l'accompagne.

Elle refuse ce qui est **impossible**, et rien d'autre. La liste des contrôles vit dans la constante `ENVELOPPE`,
à côté de la fonction : plus de kills que adversaires × vies, une partie plus longue que tout le
plan de zone, une durée que son propre chronomètre n'a pas eu le temps de contenir, un règlement qui
**paie** annoncé avant que l'horloge n'ait eu la place de contenir le sas puis la partie, une victoire
annoncée avant que son horloge ne l'autorise, un encaissement Resurgence avant la fin du verrou de
`CASHOUT.lock`, plus de cubes que `CUBE.max`, un rang hors de la table, plus de morts que de vies, une sacoche au-delà de
`mise × sièges`, un billet expiré. La borne de sacoche joue depuis peu un second rôle, écrit dans
`ENVELOPPE.controles` pour que la table ne mente pas sur elle-même : elle **plafonne le paiement**,
puisque c'est la sacoche qui décide du net.

**Deux contrôles « évidents » sont faux et ne sont pas écrits.** « La sacoche vaut exactement la
mise quand on n'a tué personne » : non, une mort par gaz lâche la sacoche au sol et n'importe qui
la ramasse sans avoir tué qui que ce soit, tandis que mourir la remet à zéro — seule la borne
subsiste. « Plus de kills que d'adversaires » : non, chacun a trois vies, deux en Resurgence.

Les tolérances d'horloge sont **volontairement larges** : un onglet en arrière-plan, un téléphone
endormi et une horloge locale fausse sont beaucoup plus fréquents qu'un tricheur. Accepter une partie
douteuse coûte une ligne de statistique, refuser une partie honnête coûte un joueur.

### Le **plancher d'horloge**, et il ne s'arme que là où de l'argent sort (phase 04a)

La 02a avait écrit la date de péremption de ces tolérances — « elles se resserreront quand elles
protégeront de l'argent » — et elle est échue. Le contrôle `chronometre` est une borne **haute** : la
partie annoncée doit tenir dans le temps écoulé. Lue dans l'autre sens, la même inéquation est un
**plancher** : `ecoulé >= LOBBY.wait + secondes − marge`. Avec `margeHorlogeS = 120` pour un sas de
25 secondes, ce plancher n'exigeait **rien** : un encaissement Resurgence annoncé à 30 secondes
simulées le franchissait dès l'instant où le billet s'ouvrait, et le seul autre plancher d'horloge
de la fonction ne s'armait que sur la branche `victoire`.

Ce n'était donc pas une inéquation nouvelle qu'il fallait écrire, c'était la **marge** qu'il fallait
resserrer là où elle protège de l'argent. `WBCore.horlogePlancher(billet, rapport, maintenant)` est
la jumelle exacte du contrôle existant, pure et **recevant** son horloge comme
`renonciationOuverte` ; sa marge est nommée à part, `ENVELOPPE.margePlancherS = 30`, du même ordre
que `margeVictoireS` et pour la même raison — elle doit couvrir tout le sas, parce qu'un billet
demandé à la fin du sas donne un coup d'envoi plus tôt que `openedAt + LOBBY.wait`.

Le refus s'appelle `plancher`. Il est armé **une seule fois**, après le calcul du montant et sous la
condition `netCents > 0`, ce qui le pose sur l'encaissement **et** sur la victoire sans le dupliquer :
la branche `victoire` garde ses deux contrôles à elle — `(vies − 1) × RESPAWN` puis `margeVictoireS`
— qui mordent plus tôt et sous leur propre motif. Un règlement qui ne sort **rien** de la caisse —
une défaite, une victoire les poches vides, une sacoche d'un centime que la commission absorbe — n'est
jamais refusé par lui : `margeHorlogeS` et ses 120 secondes continuent seules de le regarder.

**Ce que cela ne fait pas, écrit sans l'embellir.** La partie est une fonction pure de `seed_public`,
que le client reçoit avec son billet, et `REPLAY_BUDGET_MS` prouve qu'elle se rejoue en quelques
centaines de millisecondes : chercher hors ligne la trace qui maximise l'argent emporté ne demande
aucun talent et se parallélise. C'est l'attaque la moins chère du dossier, plus forte que l'aimbot et
l'ESP, et c'est elle qui dimensionne le plafond de la 04a. Ce plancher ne la ferme pas — il la ramène
au **rythme d'un joueur**. C'est un renchérissement, pas une défense anti-triche.

### L'aveu de la 02a est levé : le net sort de la partie rejouée

La 02a écrivait ceci, et c'était le seul point ouvert que la phase 02b existait pour fermer :

> Le net vaut `cashoutCents(sacoche)` dans les cinq modes. La sacoche est précisément le nombre que
> le serveur ne sait pas refaire.

**Il sait, désormais.** La sacoche est celle que le rejeu trouve dans la poche du joueur au moment où
il sort, et elle est conservée : sacoches + butin au sol + encaissé = `mise × sièges`, asserté sur la
partie rejouée. `payoutCents` reste ce qu'il est partout ailleurs dans le jeu — le **plafond « WIN UP
TO » du lobby, jamais un versement** — et il n'est plus dépassable pour une raison démontrable et non
plus par décret.

Ce qui n'a pas changé : l'API **ne recalcule jamais la commission elle-même**. Le net ne sort que des
fonctions de paiement de `WBCore`.

Pourquoi le serveur recalculait un pot MAXWIN, et pourquoi il ne le fait plus : le jeu a cessé de
verser un forfait au dernier survivant il y a longtemps — **le prix est la sacoche qu'on emporte**,
c'est ce que `endMatch` crédite (`cashoutPayout(pouch).net`), ce que l'écran affiche
(« CARRIED OUT »), ce que `docs/GAME-DESIGN.md` documente et ce que `test.js` verrouille
(« the prize is what you carry out »). Le verdict, écrit six commits plus tard, a ressuscité le
forfait. Sur une table à 0,50 $, une victoire parfaitement honnête faisait donc créditer $2,80 au
joueur et écrire `net_cents = 800` en base : un `ecart_cents` de −520 centimes qui ne mesurait
aucun mensonge, et un `best` affiché quatre fois trop grand au lobby. `payoutCents()` redevient ce
qu'il est partout ailleurs — **le plafond « WIN UP TO », jamais un versement**. Il reste exact :
`cashoutCents(mise × sièges)` retombe au centime sur `payoutCents(...).winnerCents`.

Les trois montants d'une ligne réglée sont donc au **périmètre du joueur**, dans les cinq modes, et
`fee_cents + net_cents = gross_cents` sans exception — la ligne se réconcilie seule. Ce que
l'**équipe** emporte n'est écrit nulle part, volontairement : c'est la somme des sacoches de ses
membres, et le serveur ne la connaît pas.

**`declaredNetCents` n'est jamais payé ni cru.** Le verdict calcule l'**écart** entre ce que le
client annonce et ce qu'il compte, et le stocke dans `ecart_cents` — la seule colonne en centimes
qui peut être négative, parce qu'un client peut aussi annoncer moins. On mesure, on ne punit pas :
le seuil est une affaire de phase 06, et il se fixera sur des écarts réellement observés.

### Ce que la route écrit, une fois

Un verdict de refus **clôt la ligne lui aussi** (`status = 'rejected'`), avec son motif : cette
partie-là ne comptera dans aucune statistique, et on veut pouvoir dire pourquoi sans relancer le
calcul six mois plus tard. Une partie réglée passe en `settled`, un billet périmé en `expired`.

L'idempotence est la troisième clé annoncée par la spécification, celle sur `(match_id)`, et elle
est arbitrée par la clause `where status = 'open' and net_cents is null` : un second envoi ne
touche aucune ligne, et la réponse est **relue depuis la ligne**, jamais reconstruite depuis le
verdict. Le même billet réglé deux fois rend donc le premier verdict au caractère près, même si le
second rapport ment sur tout. Une garde textuelle vérifie que toute écriture de `matches` porte
`status = 'open'`, et toute écriture d'un montant `net_cents is null` en plus.

**Un résultat en retard est accepté tant que le billet n'a pas expiré.** Si couper le wifi
effaçait une partie perdue, ce serait la meilleure stratégie du jeu.

**Depuis la phase 03, la même transaction écrit le GAIN.** La ligne et ses transferts naissent
ensemble ou pas du tout, sous verrou de la ligne `matches`. Trois protections se recouvrent sur
l'unicité du crédit, et c'est voulu — la première qui tombe n'ouvre rien : la clause `where`
ci-dessus, la clé unique du grand livre, et le séquestre vidé qu'un second gain devrait débiter.
Détail complet plus bas, avec la quarantaine et le refus `409 livre`.

### Ce qu'il faut écrire sans l'enrober

- **Aucun euro n'entre au bout de cette phase.** Le vol de *temps* devient impossible, le vol de
  *précision* reste entier.
- **Un rejeu n'est opposable que sur le MÊME runtime.** Ce que les tests prouvent : l'égalité entre
  deux processus Node. Ce qu'ils ne prouvent pas : l'égalité entre deux **moteurs** JavaScript.
- **Aucune base n'a toujours jamais tourné**, et cette phase ajoute des colonnes et une table dont un
  **paiement** dépend. Faire tourner une vraie Postgres au moins une fois devient un **prérequis de la
  phase 03**, à écrire comme tel — et c'est écrit comme tel.
- **`match_traces` n'a aucune politique de conservation** : renvoyé à la phase 03.
- **Un déploiement se DRAINE, il n'écrase pas les billets ouverts** — au plus une quinzaine de
  minutes. C'est une décision d'exploitation, à ranger à côté de « la maison est la contrepartie de
  chaque pot », et le refus `sim_version` est ce qui arrive quand on ne la prend pas.

### Le veilleur

Les billets que personne ne termine — onglet fermé, navigateur tué, joueur parti — resteraient
ouverts pour toujours, et un joueur n'a qu'un billet ouvert à la fois. `app.veiller()` les clôt, et
**eux seuls** : sa clause porte `status = 'open'` et l'expiration, et il prend son heure du même
endroit que le reste du routeur. `main.js` l'appelle chaque minute. C'est du code qui manipule de
l'argent et que personne ne regarde tourner : il se teste comme le reste, horloge injectée, sans
attendre.

**REVIREMENT DE LA PHASE 03, ET IL EST ÉCRIT PLUTÔT QUE LAISSÉ À SE DÉCOUVRIR.** Ce paragraphe disait
« il n'écrit aucun montant — il ne fait que fermer une porte », et `api/app.js` et `api/db-pg.js` le
disaient aussi. **C'est faux depuis le module 4** : à l'expiration d'un billet, le séquestre est vidé
vers `maison:contrepartie`, sans quoi l'invariant « aucun séquestre ne reste habité » tombe et de
l'argent dort dans un compte que plus rien ne solde. Les trois commentaires sont réécrits ; laisser un
commentaire contredire le code est ce qui se découvre six mois plus tard, par quelqu'un qui relit le
commentaire.

Ce qui n'a pas changé : **il ne rembourse rien**. Passé la fenêtre de renoncement, plus rien ne rend
la mise — c'est exactement le vol que la phase ferme. Et il n'écrit aucun montant sur la **ligne** :
`net_cents`, `fee_cents` et les autres restent nuls, un billet périmé n'a pas de verdict.

Deux conséquences de forme, toutes deux visibles dans `expireMatches` :

- **une boucle de transactions bornées, une par billet**, et plus un `update` de 500 lignes. Un
  mouvement du grand livre ne se pose pas en masse, et un échec sur une ligne — un doublon, un
  découvert — ne doit pas annuler les autres. Le billet qui échoue est **nommé** dans `echecs`, et le
  tour suivant le reprendra ; un balayage qui avalerait ses échecs laisserait un séquestre habité
  sans que personne ne le sache ;
- **le veilleur est nommé dans la liste des appelants autorisés** de l'écrivain du grand livre. La
  garde textuelle s'étend d'ailleurs de `ledgerWrite` à `reglerSequestre` : le veilleur n'appelle pas
  l'écrivain directement, donc une garde posée sur le seul écrivain direct l'aurait laissé entrer
  sans que personne n'ait à l'écrire. Un écrivain d'argent de plus se nomme, il ne se glisse pas.

## Les statistiques sont la somme des parties, pas des compteurs

`GET /api/me` rend `matches`, `wins`, `kills`, `best` et `divergences`. Aucun de ces cinq nombres
n'est stocké : ils sont lus par **agrégat** sur la table `matches`, et seules les parties `settled` y
entrent. Une partie refusée, périmée ou encore ouverte ne compte pour rien — elle n'a pas de résultat
opposable.

Depuis la phase 02b, les quatre premiers ne comptent en plus que les parties dont le **rejeu a
convergé** : c'est la garantie écrite dont la phase 03 a besoin, et elle s'applique dès ici pour
qu'aucun agrégat n'ait à la redécouvrir. Le cinquième dit combien ce filtre en écarte — sans lui, la
liste d'exclusion grandirait en silence.

```sql
count(*) filter (where digest_match) · … filter (where digest_match and issue in (…))
sum(kills) filter (where digest_match) · max(net_cents) filter (where digest_match)
count(*) filter (where digest_match is not true)
where user_id = $1 and status = 'settled'
```

`digest_match` vaut `NULL` sur une ligne qui n'a pas été rejouée ; en SQL, `where digest_match`
l'écarte comme il écarte `false`, et c'est exactement ce qu'on veut : on ne compte que ce qu'on a pu
vérifier.

C'est exactement le raisonnement de l'absence de colonne solde : **un compteur qu'on incrémente est
une case qu'on écrase, et un double envoi la fausse pour toujours.** Ici, un double envoi ne peut
rien fausser puisqu'il n'y a rien à écrire — la ligne de partie s'insère puis se règle une fois, et
la somme se refait à l'identique. La phase 02a met donc en place, sur des chiffres qui ne valent
rien, la mécanique que le grand livre de la phase 03 exigera.

C'est un **revirement** sur une décision écrite et livrée en phase 01, qui avait créé une table de
quatre compteurs. Aucune base n'ayant jamais tourné, c'était le dernier moment gratuit pour corriger
le schéma sans migration. La décision renversée et sa raison sont dans `docs/HISTORIQUE.md`.

Deux points de détail qui coûteraient cher plus tard :

- `wins` retient la **victoire et l'encaissement**. Sortir de Resurgence avec sa sacoche est une
  sortie gagnante, et `endMatch` la compte déjà comme telle côté jeu : compter autrement ferait
  *baisser* le compteur d'un joueur le jour où il se connecte.
- `best` est un **maximum, en centimes entiers**, et il le reste jusqu'au bout du réseau. Il ne
  redevient des dollars qu'une seule fois, dans `applyAccount` côté jeu. Convertir ici ferait un
  second point de conversion, ce que la couche monétaire existe précisément pour empêcher.

Un piège du pilote, le même que pour les graines et en pire : `count()` et `sum()` rendent un
`bigint`, donc une **chaîne**. Sans conversion, `kills` traverserait le réseau en texte — une graine
en chaîne fait au moins repartir le jeu sur la sienne, une statistique en chaîne ne se voit qu'à
l'écran, des semaines plus tard. La conversion est donc écrite **deux fois**, dans `db-pg.js` et
dans la liste blanche de `app.js`, exactement comme pour les graines ; un test fait mentir la
doublure comme le vrai pilote, ce que `db-pg.js` seul ne permettrait pas — il n'est jamais exécuté.

### Ce que les gardes textuelles prouvent, et ce qu'elles ne prouvent pas

Faute de base qui tourne, deux tests lisent le **texte** de `schema.sql` et de `db-pg.js` : toute
colonne dont le pilote parle existe dans le schéma, les colonnes d'argent sont entières et
contraintes positives, aucune ne s'appelle solde, et aucun `update` ne vise un montant de `matches`.
Elles attrapent la dérive la plus probable — une requête restée en arrière après la disparition
d'une table.

**Elles vérifient du texte, et rien d'autre.** L'index unique partiel « un seul billet ouvert »,
comme la contrainte `name_key` de la phase 01 et comme la clause `where status = 'open' and
net_cents is null` qui arbitre l'unicité du règlement, n'a jamais été éprouvé contre une vraie base.
Un test qui passe contre la doublure prouve la doublure, pas Postgres. C'est la dette la plus
silencieuse de la phase, et elle se solde le jour où une base tournera — pas avant.

Depuis la phase 03 elle a une **recette** : `api/db-check.js` et son job d'intégration continue,
décrits plus bas. Une recette n'est pas un plat : tant que ce job n'a pas été vert une fois, la
phrase ci-dessus reste vraie mot pour mot.

## `ledger.js` — le grand livre, et rien d'autre

Phase 03, module 1. Un fichier **entièrement pur** : la grammaire des comptes, la liste fermée des
motifs, une fonction par mouvement, `soldeDe` et `ledgerReconcile`. Aucune base, aucun réseau,
aucune route, aucune dépendance — pas même `core.js`. **À ce stade le grand livre existe entièrement
et personne ne l'a encore écrit sur un disque** ; c'est ce qui rend les modules suivants ennuyeux.

**Une écriture est un TRANSFERT, pas une jambe signée** : `{ motif, reference, compteDebit,
compteCredit, montantCents }`, montant strictement positif, comptes différents. La somme du livre est
donc nulle **par construction**, et il n'y a rien à asserter. Il n'existe volontairement aucune
fonction `equilibre()` à appeler avant l'insertion : elle protégerait le chemin qui l'appelle, pas la
donnée, et le jour où quelqu'un ouvrira un second chemin d'écriture, la contrainte de colonne le
suivra là où la fonction ne l'aurait pas suivi. Un mouvement est un **ensemble de transferts
partageant `(motif, reference)`**, et les paires de comptes d'un mouvement sont distinctes deux à
deux — c'est ce qui permet à la clé d'idempotence `(motif, reference, compte_debit, compte_credit)`
d'identifier exactement une jambe.

**Le plan de comptes est une GRAMMAIRE, pas une liste fermée.** Trois des six comptes sont des
familles paramétrées, et l'écrire en énumération aurait produit un `check (compte in (...))` que
Postgres refuse au premier joueur inscrit. `COMPTE_RE_SQL` est exportée **en chaîne source**, pour
être recopiée caractère pour caractère dans la contrainte de `schema.sql` ; le `RegExp` en dérive. Un
compte ou un motif hors grammaire **lance** — une écriture boiteuse s'insérerait et bouclerait, et le
solde qu'elle fausse ne se verrait qu'au moment de payer quelqu'un. Les identifiants sont refusés
avec un zéro de tête : `joueur:007:disponible` et `joueur:7:disponible` seraient deux comptes pour un
seul joueur, et le solde du second ne verrait jamais l'argent du premier.

**Les motifs sont six** : `dotation`, `recharge`, `mise`, `gain`, `remboursement`, `contrepassation`.
Pas sept. Le motif de libération de quarantaine est explicitement renvoyé à la phase 06 : un membre
de liste fermée que personne n'écrit est une case en attente d'être créée de travers.

**La direction du reliquat se décide dans la fonction pure, jamais au point d'insertion** — c'est le
coût nommé de la ligne-transfert, et c'est là qu'une erreur se cacherait. `mouvementGain` décompose :
`contrepartie → enjeu` du reliquat si le brut dépasse la mise, puis `enjeu → commission`, puis
`enjeu → joueur` (ou `enjeu → quarantaine` si le rejeu a divergé), puis `enjeu → contrepartie` du
reste si le brut est inférieur à la mise. **Une jambe de montant nul n'est pas représentable, donc
elle est omise** : un brut nul ne produit qu'un seul transfert, `enjeu → contrepartie` de toute la
mise. Il n'y a **pas** de `mouvementExpiration` : vider un séquestre à l'expiration est le RÈGLEMENT
d'une partie qui n'a rien rapporté, donc `mouvementGain` avec un brut nul, qui produit exactement le
même mouvement que le règlement d'un joueur qui perd. C'est la vérité comptable — les deux billets
ont rapporté zéro. `remboursement` aurait menti, `contrepassation` aussi, et un septième motif aurait
rouvert la liste fermée pour rien.

**Aucun montant ne se recalcule ici.** `grossCents`, `feeCents` et `netCents` viennent de
`WBCore.cashoutCents` et de nulle part ailleurs ; `ledger.js` les reçoit, vérifie qu'ils tiennent
ensemble et les répartit. Une garde textuelle interdit à son texte de contenir `RAKE`, `0.2`,
`Math.ceil`, `/ 100`, `toFixed` ou le moindre `require`.

**Trois montants y vivent aussi**, et ils y sont pour la même raison que les motifs : ce ne sont pas
des règles du **jeu**, mais ce sont bien des règles du grand livre. `DOTATION_CENTS` (5 000),
`PLANCHER_CENTS` (500) et `RECHARGE_CENTS` (1 000) — leur raison est écrite plus bas, avec la route
qui les dépense.

**Le découvert est une règle uniforme**, et deux comptes seulement en sont exemptés :
`COMPTES_EMETTEURS` = `maison:dotation` et `maison:contrepartie`, dont le solde négatif **est** la
mesure qu'on cherche. Les séquestres n'en font pas partie, et c'est tout l'intérêt : un second gain
sur un même billet devrait débiter un séquestre déjà vide, donc « un billet a au plus un gain » ne
repose pas uniquement sur un index.

**`ledgerReconcile(ligneMatch, transferts)`** rend une liste de griefs — vide quand tout s'apparie. Le
zéro global ne dit rien de l'appariement : il reste vrai quand un montant **juste** est posé sur le
**mauvais** compte. Elle attrape exactement cela, plus le billet sans engagement, l'engagement sans
billet et le séquestre non vidé sur une ligne close. **Sur une ligne close SANS règlement — `expired`,
`abandoned`, `rejected`, `renounced` — elle regarde aussi OÙ le séquestre est parti**, et pas
seulement qu'il est vide : le statut suffit à le dire, puisque `renounced` ne vient que de
`renounceMatch` et rend la mise au joueur, quand les trois autres viennent de `reglerSequestre` et la
versent à `maison:contrepartie`. Sans ce contrôle, « ouvrir un billet, laisser expirer, se faire
rembourser » — très exactement le vol que la fenêtre de renoncement ferme — se réconciliait en
**vert**. Le **remboursement mal dirigé** est attrapé au même titre que le gain mal dirigé : un
`remboursement` crédité à la maison ou à un autre joueur boucle le livre et vide le séquestre, et
seule la comparaison au `user_id` de la ligne peut le voir. Elle accepte une ligne ou une liste de lignes ;
avec une liste elle voit tous les billets, ce qui est la seule façon de tenir « aucun engagement sans
son billet ». Les modules suivants l'appelleront à la fin de **chaque** scénario d'`api/test.js`.

**La mesure que `docs/HISTORIQUE.md` réclame avant la phase 04 tombe déjà ici**, avant qu'une base ne
la calcule : sur une table à 10 $ en resurgence, un joueur qui rafle les cinquante sièges fait verser
49 000 centimes à `maison:contrepartie` pendant que la maison en encaisse 10 000, soit **390 $ de
coût net sur une seule partie**. Ce chiffre existait déjà ; il n'était écrit nulle part. Le risque
n'est pas le chiffre, c'est de le voir apparaître un jour et de le prendre pour un bug.

Ce qui n'est pas ici et qui est dans `WBCore` : **`renonciationOuverte` et `renonceFenetreS`**, la
seule règle du grand livre réellement partagée avec le sas d'attente — l'écran doit dire au joueur ce
que partir va lui coûter, le serveur doit l'arbitrer, et deux définitions seraient la troisième copie
du patron déjà condamné pour `terminal`, `faits` et `argentCents`. La fenêtre vaut **dix secondes** :
`plancher(LOBBY.wait / LOBBY.pressureMax + LOBBY.dropIn) − 3`, c'est-à-dire le coup d'envoi le plus
**précoce** possible moins une marge de latence, et pas `LOBBY.wait`. `pressureMax` est le plafond
2,4 jusqu'ici écrit en littéral dans `joinRate` : il a reçu un nom pour que la fenêtre en dérive au
lieu de le recopier. La marge existe parce que l'erreur va dans le mauvais sens — `opened_at` est
postérieur au `t = 0` du client, donc `maintenant − opened_at` **sous-estime** le temps passé au sas.
La fonction est pure : elle ne lit aucune horloge, elle la reçoit. Le test qui la tient ne compare
pas deux constantes, il **confronte** la fenêtre au vrai code du lobby — `joinRate`, `seatsAt` et la
règle de `waitTick` — sur les cinq modes, les quatre tables, toute la plage de files d'attente et les
vingt-quatre heures d'`onlineTotal` : le coup d'envoi le plus précoce y vaut 13,42 s.

**Il y a DEUX marges, et la seconde est arrivée après coup.** `RENONCE_MARGE_S` couvre le vol
**aller** de la demande de billet, qui joue dans le bon sens. `RENONCE_MARGE_ECRAN_MS` couvre le vol
**retour** — le `POST .../renounce` met lui aussi du temps à arriver, et le serveur date la fenêtre à
SA réception — donc l'écran ferme sa promesse une seconde et demie avant le serveur. La propriété
« l'écran ne promet jamais un remboursement que le serveur refusera » **tient tant que ce vol retour
reste sous cette marge**, et c'est écrit ici parce qu'elle était affirmée sans réserve. Elle suppose
en outre que l'écran lise une **horloge** et non un compteur de tics : `sasRemboursable` lit
`performance.now() − W.clic`, jamais `W.t`, qui retarde dès qu'un onglet passe en arrière-plan. Et
elle ne promet **rien** sur un billet **repris**, dont l'heure d'ouverture est celle d'un sas
précédent — c'est pour cela que `POST /api/match` rend `repris` avec le billet.

## L'exposition de la maison — calculable, puis branchée

Phase 04a, module 1. Le grand livre **mesurait** l'exposition depuis la phase 03 : le solde négatif
de `maison:contrepartie` **est** ce que coûtent dix-neuf adversaires qui ne misent rien. Il ne la
**bornait** pas. Ce module la rend calculable — cinq constantes entières et quatre fonctions pures
dans `api/ledger.js` — sans aucun appelant : c'est « le contrat avant le brancheur », déjà employé
en 02a pour `seedFor` et `matchFlow`. **Le module 4 les branche**, et c'est décrit plus bas, sous
« Le plafond refuse à l'ouverture ».

**L'exposition est une SOMME d'écritures, jamais une colonne.** `expositionDe(transferts,
references)` la lit sur les **deux** comptes de maison — `maison:contrepartie` et
`maison:commission` — restreinte aux écritures qui parlent des billets demandés, et rend
`−(solde(contrepartie) + solde(commission))`. C'est la doctrine de la table de compteurs supprimée en
02a, appliquée une fois de plus : un compteur qu'on incrémente est une case qu'on écrase. Le
corollaire est écrit comme test —
**on franchit le plafond en posant des écritures, jamais en touchant un compteur, et relire redonne
le même chiffre**. `maison:dotation` n'y entre **jamais** : émettre des crédits fictifs n'est pas
s'exposer, et l'y laisser ferait de la première connexion de chaque joueur 5 000 centimes
d'exposition. Le résultat est un entier **signé** : positif quand la maison a versé, négatif
d'exactement la mise sur un billet perdu — les billets perdus s'imputent sur les gagnés, l'exposition
est **nette**.

**`referenceBillet(motif, reference)` est le cœur du module, pas un utilitaire — et c'est le piège
de la phase, celui qui naît vert si on ne le nomme pas.** `ledger_entries.reference` est du **texte**,
et `mouvementContrepassation` y écrit `<motifOrigine>:<refOrigine>` : donc `gain:42`, et pas `42`. La
raison est bonne — on lit dans le livre **ce qui** a été contre-passé sans faire de jointure. Mais une
jointure `ledger → matches` par `reference::bigint` lèverait `22P02` sur ces lignes-là, et une
jointure qui les **filtre** les ignore : un gain contre-passé continuerait de compter dans
l'exposition. Le module qui écrit la requête n'est pas celui qui crée les lignes qui la cassent, donc
le défaut se révélerait une phase plus tard sur un chiffre qu'on croirait juste. La fonction est
**exhaustive sur la liste fermée `MOTIFS`** : `mise`, `gain` et `remboursement` rendent la référence
elle-même si elle a la forme `[1-9][0-9]*` ; `dotation` (référence = `user_id`) et `recharge`
(référence = `<user_id>:<AAAA-MM-JJ>`) rendent `null`, ce ne sont pas des billets ;
`contrepassation` rend l'identifiant extrait de son préfixe. Un septième motif ne tombe pas dans un
`else` silencieux, il **lance**. Elle rend une **chaîne** de chiffres, jamais un nombre : c'est du
texte qu'on comparera à `matches.id::text`, sans aucun `cast` — un `bigint` ne tient pas toujours
dans un `Number`.

**`REFERENCE_BILLET_SQL` est la même règle en SQL, et il n'en existe qu'une écriture.** Exportée en
chaîne comme `COMPTE_RE_SQL`, **construite à partir des mêmes listes et des mêmes expressions** que
la fonction, pour que le schéma la recopie et qu'une garde textuelle compare les deux. Le groupe des
motifs y est **non capturant** : `substring(texte from motif)` rend la première parenthèse
**capturante**, et capturer le motif rendrait « gain » là où on attend « 42 » — une lecture vide au
lieu d'une lecture fausse, donc silencieuse.

**Une limite, nommée plutôt que découverte** : contre-passer une contre-passation produit
`contrepassation:gain:42`, que la règle ne ramène à **aucun** billet. Le double geste n'a pas
d'appelant — l'outil de la phase corrige un mouvement d'origine — et l'élargir demanderait
d'élargir `REFERENCE_BILLET_SQL` du même coup. C'est consigné dans `docs/PHASE-04A.md` plutôt que
laissé à découvrir.

**Le pire cas d'un billet est calculé par le JEU, pas ici.**
`expositionBilletMaxCents(netMaxCents, miseCents)` **reçoit** le net maximal et rend
`max(0, netMaxCents − miseCents)` : même discipline que `mouvementGain`, qui reçoit brut, commission
et net sans les recalculer, et c'est la garde textuelle « aucune arithmétique de commission » qui la
tient. L'appelant demandera le chiffre à `WBCore.cashoutCents(WBCore.purseBound(mise, sièges).maxCents)`.
Le **clamp à zéro** n'est pas une précaution de style : une table dont le net maximal est sous la mise
n'expose la maison à rien, et reporter un nombre négatif ferait qu'ouvrir une petite table achèterait
de la marge sur une grande. La propriété qui compte n'est pas la formule mais sa **confrontation** :
sur les quatre paliers × cinq modes, le chiffre annoncé égale **au centime** la somme nette des
jambes de maison que `mouvementGain` produit réellement à brut maximal. Jamais asserté depuis une
formule recopiée — c'est la leçon du pot forfaitaire ressuscité, qui a coûté un `ecart_cents` de −520.

**Les cinq constantes, et les deux ancrages qui tiennent le plafond.**

```
PLAFOND_FENETRE_H       =      24   heures, fenêtre GLISSANTE (une journée calendaire se
                                    réinitialise à une heure connue : attendre minuit deviendrait
                                    une stratégie)
PLAFOND_TABLES_PAR_JOUR =       4   tables maximales par joueur et par fenêtre
PLAFOND_JOUEUR_CENTS    = 156 000   centimes  (= 4 × 39 000)
PLAFOND_MAISON_CENTS    = 2 000 000 centimes — le fusible global
FUSIBLE_RAFRAICHI_S     =      60   secondes
```

Le pire cas maximal du domaine est la **Resurgence à 10 $** : cinquante sièges, brut maximal 50 000,
commission 10 000, net 40 000, donc **39 000 centimes d'exposition pour 1 000 misés**. Ce nombre est
**recalculé par le test depuis `WBCore`**, jamais écrit à la main, et le test tombe si un palier ou un
mode bouge — pour que quelqu'un **re-décide** au lieu de laisser un nombre survivre à la table qui
l'a justifié. **Premier ancrage, le plancher** : sous 39 000, la Resurgence à 10 $ devient impossible
à ouvrir pour tout le monde et tout le temps, et la panne se lirait comme un bug du lobby — un
plafond décide donc quelles tables **existent**. **Second ancrage** : sous 78 000, une seule victoire
maximale ferme la table pour vingt-quatre heures, puisque le billet suivant en pèse autant ; le
premier gros gagnant **légitime** lirait `plafond` sur un lobby qui a l'air cassé. D'où la question
retenue — combien de tables maximales laisse-t-on ouvertes après une grosse sortie ? — et la réponse,
quatre.

**Le plafond par joueur est EXACT ; le fusible global est APPROCHÉ.** Le premier se lira dans la
transaction d'ouverture, **après** le verrou `select id from users where id = $1 for update`, parce
que deux onglets du même joueur doivent être sérialisés et que son agrégat est borné par les billets
d'un seul joueur sur vingt-quatre heures. Le second est un **interrupteur**, pas un invariant : le
lire sous ce verrou ferait de chaque ouverture un agrégat non borné sur la table qui grossit le plus
vite du dépôt, et le dépôt a déjà payé ce genre de chose une fois — `GET /api/me` retenait un client
du bassin assez longtemps pour mettre en file le renoncement d'un **autre** joueur au-delà de sa
fenêtre de dix secondes. Le fusible se relit donc au plus une fois toutes les `FUSIBLE_RAFRAICHI_S`
secondes, hors transaction, et **il a le droit d'être en retard d'une minute sur ce que le livre
porte**. Ce n'est pas la même chose que « une minute d'ouvertures », comme il était écrit ici : voir
plus bas, la limite est plus grande d'un ordre de grandeur et elle est chiffrée.

**`plafondVerdict({ expositionRealiseeCents, expositionBilletCents, plafondCents })`** rend
`{ franchi, expositionCents, plafondCents }`, gelé. `expositionCents = max(0, réalisée) + billet`, et
`franchi` est **strictement supérieur** : il faut que le **quatrième** billet maximal passe, sans quoi
`PLAFOND_TABLES_PAR_JOUR` en vaudrait trois. Le **clamp à zéro avant comparaison** est une décision :
l'exposition est nette, mais une exposition négative reportée serait un compte d'épargne à moissonner
— perdre cent parties achèterait le droit d'en gagner une très grosse. Le verdict est **monotone**,
et un test le balaie : croître l'exposition ne fait jamais repasser au vert.

**Ce que ces nombres coûtent, sans enjoliver.** Un compte vaut au plus 1 560 $ de contrepartie par
jour ; le fusible vaut 20 000 $ — mais c'est un budget d'exposition **NETTE** sur la fenêtre, tous
joueurs confondus, et cela change ce que le chiffre veut dire. Le vrai plafond de la maison **est le
fusible global** ; le plafond par joueur ne sert qu'à empêcher un seul compte de l'épuiser à lui seul.
Le remède à la flotte de comptes est une vérification d'identité, pas une règle de jeu : elle est en
04b, et en attendant le déclenchement du fusible refuse **tout le monde** — c'est une alerte, pas un
réglage.

**« Environ treize comptes saturés » n'est vrai que sur un livre à l'équilibre par ailleurs**, et la
phrase a d'abord été écrite comme une propriété. L'espérance par billet est négative pour le joueur —
sur une table solo à $0,50, `mouvementGain` expose +750 c sur le gagnant et −50 c sur chacun des
dix-neuf perdants — donc la marge quotidienne de la maison **relève** le seuil réel. Le seuil qu'une
flotte doit franchir est `PLAFOND_MAISON_CENTS + marge nette de la fenêtre`, et il croît avec le
trafic : de l'ordre de 13, 14, 19, 26 et 39 comptes saturés à 0, 20 000, 100 000, 200 000 et 400 000
billets réglés par jour. **Ce fusible protège la caisse de la maison, il ne compte pas les comptes** —
il est de moins en moins un rempart contre une flotte à mesure que le site grossit, ce qui avance
l'échéance du KYC de la 04b au lieu de la reculer. Lire une somme d'expositions **positives** n'est
pas l'échappatoire : à 200 000 billets par jour les seuls gagnants légitimes pèsent quelque
7 500 000 c, et le fusible sauterait tous les jours. Un test constate la limite plutôt que de la
taire.

**`decouvertAutorise` a enfin été confrontée à l'espace des comptes**, et pas seulement aux deux
littéraux de `COMPTES_EMETTEURS` : pour **toute** forme que la grammaire engendre — les trois familles
paramétrées sur toutes les magnitudes qu'un `bigserial` produit, plus les trois comptes de maison —
le découvert est faux hors de `maison:dotation` et `maison:contrepartie`. C'est la garde qui
empêchera un futur `maison:reserve` d'hériter du découvert par distraction.

## Le plafond refuse à l'ouverture, et le sas le dit

Phase 04a, module 4. La mesure devient une **borne** : `POST /api/match` refuse en `409 plafond`.

```
POST /api/match      { mode, stake, brawler, clientKey }
→ 409                { erreur, code: 'plafond', portee: 'joueur' | 'maison',
                       expositionCents, plafondCents, fenetreHeures,
                       aucuneTableMoinsChere }
```

**Le pire cas d'un billet est calculé par le JEU, et passé en paramètre.** `api/ledger.js` porte deux
gardes textuelles — aucun `require`, aucune arithmétique de commission — donc le net maximal ne peut
venir que de `WBCore.cashoutCents(WBCore.purseBound(mise, sièges).maxCents)`. `api/app.js` le calcule
**une fois**, le donne au fusible puis à `db.createMatch`, et personne ne le recalcule : même
discipline que `mouvementGain`. `cashoutCents` et `purseBound` sont entrés dans la liste `ATTENDUS`
d'`api/core.js` — ils sont désormais sur le chemin d'un refus, donc leur disparition casse au
démarrage du serveur et pas au premier `POST` d'un joueur.

**Le plafond par joueur est EXACT et se décide dans la transaction.** Il est lu dans `createMatch`,
**après** `select id from users where id = $1 for update` et avant la moindre écriture : c'est ce
verrou qui sérialise deux onglets du même joueur, et c'est pour cela que ce contrôle-là est dedans.
Son agrégat est borné par les billets d'un seul joueur sur vingt-quatre heures. Un refus n'a laissé
**ni ligne, ni écriture, ni séquestre** — l'annulation rend la ligne qu'on venait d'insérer à
l'inexistence, comme sur `fonds` — et il n'enferme personne : la table moins chère s'ouvre dans la
foulée, ce qu'un test vérifie au lieu de le promettre.

**Et cette borne-là a failli n'être qu'une phrase.** La requête ne restreignait au joueur qu'**après**
la jointure : ses trois clauses — fenêtre, motifs, comptes de maison — ne mentionnaient pas le joueur,
et le `join` porte sur une **expression** `case` qu'aucun index ne couvrait, donc le planificateur ne
pouvait rien descendre et matérialisait toutes les écritures de maison de la fenêtre, tous joueurs
confondus, pour en jeter 99,8 % — c'est-à-dire O(trafic du site) pendant que la transaction tient le
verrou de ligne. Deux choses la tiennent maintenant : la sous-requête porte elle-même
`REFERENCE_BILLET_SQL in (select id::text from matches where user_id = $1)` — la MÊME expression que
la jointure, jamais `reference` brute, sans quoi une contre-passation `gain:42` sortirait du filtre —
et `schema.sql` porte `ledger_entries_billet_fenetre_idx`, un index d'expression sur cette référence
et `cree_le`, qui ouvre la boucle imbriquée depuis `matches`. La preuve n'est pas dans `npm test` :
`api/db-check.js` mesure désormais les lignes **réellement lues** par `explain (analyze)`, avec un
lest de jambes de maison appartenant à d'autres joueurs — la seule dimension qui grossit en
production, et celle qui manquait au banc. « Aucun `Seq Scan` » ne distinguait pas un parcours
d'index borné d'un parcours d'index complet.

**Le verdict ne s'applique qu'à un billet NEUF.** Le chemin `repris` — rejeu de la clé du client, ou
billet déjà ouvert rendu tel quel — ne passe pas par lui. Refuser un billet que le joueur **détient**,
mise débitée, l'enfermerait dedans jusqu'à l'expiration, puisqu'il n'en a qu'un à la fois. C'est la
leçon du `22003`, et c'est la règle écrite de la phase : **un billet déjà ouvert n'est jamais cassé
rétroactivement**, et **aucun chemin de règlement ne peut produire le code `plafond`** — garde
textuelle, parce que refuser au règlement serait voler une partie gagnée et que c'est irréparable.

**Le fusible global est APPROCHÉ, et il ne tourne pas sous le verrou.** C'est un interrupteur, pas un
invariant : son agrégat porte sur toutes les écritures de tous les joueurs, et le lire sous le verrou
ferait de chaque ouverture de billet un balayage de la table qui grossit le plus vite du dépôt, sur
le chemin le plus disputé du système. Le dépôt a déjà payé ce genre de chose une fois — `GET /api/me`
retenait un client du bassin assez longtemps pour mettre en file le renoncement d'un **autre** joueur
au-delà de sa fenêtre de dix secondes. Il est donc lu **hors transaction**, au plus une fois toutes
les `FUSIBLE_RAFRAICHI_S` secondes, la valeur gardée **en mémoire du processus** entre deux lectures,
sur l'horloge **injectée** — donc sa cadence se teste sans attendre, et elle se lit dans les **deux
sens** : `now` vaut `Date.now`, donc une horloge murale qui recule figerait sinon le cache pour toute
la durée du recul, et un âge négatif vaut péremption.

Il a le droit d'être en retard d'une minute **sur ce que le livre porte**, et c'est tout ce que cette
cadence borne. Il était écrit ici que ce retard « vaut au plus ce qu'une minute d'ouvertures peut
engager » : **c'est faux d'un ordre de grandeur.** Le fusible ne voit que des écritures **réglées** —
les jambes de maison naissent du motif `gain`, posé au règlement — donc un billet **ouvert** y pèse
zéro pendant toute sa vie, `LOBBY.wait + zoneTotalS + MATCH_MARGE_S`. Le verdict n'ajoute qu'un seul
pire cas, celui du billet qu'on ouvre, et `matches_un_seul_ouvert` est un index **partiel** sur
`user_id` : il tient pour le plafond par joueur, il ne dit rien du nombre de billets ouverts tous
joueurs confondus, que rien ne borne. L'erreur réelle vaut donc le pire cas cumulé de **tous les
billets en vol**. Cent comptes qui ouvrent une Resurgence à 10 $ dans la même minute passent tous et
posent 3 900 000 c quatre minutes plus tard, sans qu'un refus ait été prononcé. Limite connue,
constatée par un test. Le nombre de billets **ouverts** est borné par la concurrence et non par
l'historique : l'argument de coût qui justifie l'amortissement ne s'y applique pas, et cet agrégat-là
pourrait entrer dans la même lecture amortie le jour où l'on voudra la borne et pas seulement l'aveu.

**La requête de fenêtre ne fait AUCUN cast sur la référence.** `ledger_entries.reference` est du
texte, et une contre-passation y porte `gain:42` : `reference::bigint` lèverait `22P02`, et une
jointure qui filtre ces lignes laisserait un gain **annulé** peser dans l'exposition — donc refuserait
un joueur pour de l'argent qu'il n'a jamais reçu. La requête **interpole** `REFERENCE_BILLET_SQL` et
compare à `matches.id::text` ; les comptes (`COMPTES_EXPOSITION`) et les motifs (`MOTIFS_EXPOSITION`)
lui arrivent en **paramètres**, depuis les mêmes listes que lit `expositionDe` — il n'existe jamais
deux écritures de la même règle, et deux gardes textuelles le vérifient. `maison:dotation` n'entre
jamais dans l'exposition. Un détail écrit dans le code plutôt que découvert en production :
l'expression est calculée dans une **sous-requête sur `ledger_entries` seule**, parce qu'elle nomme
`motif` sans le qualifier et que `matches` porte elle aussi un `motif` — dans le `join`, elle sortait
en `42702`.

**Les deux index de lecture du livre portent maintenant deux colonnes**, `(compte_debit, cree_le)` et
`(compte_credit, cree_le)`, sous de nouveaux noms et avec le `drop index if exists` des anciens. Une
fenêtre glissante porte un compte **et** une date. Que ces index **servent** n'a de preuve qu'en
intégration continue : `api/db-check.js` pose un `explain (format json)` sur la requête réelle et
refuse tout `Seq Scan` sur `ledger_entries`.

**Un seul code, deux portées, et le message LIT la portée.** `plafond` entre dans la liste fermée
`WBCore.REFUS_SAS`, qui passe de trois à quatre membres : le sas s'arrête, affiche, et ne lance
aucune partie — le laisser retomber hors ligne ferait jouer gratuitement celui qu'on vient de borner.
Un seul code, parce que le sas n'a qu'un comportement à tenir ; mais une seule phrase mentirait dans
un cas sur deux, donc la réponse porte `portee`. Portée `joueur` : une table moins chère marchera.
Portée `maison` : aucune table moins chère n'aidera, rien n'a été débité, réessayer plus tard.
**Portée absente ou illisible : on rend le message de la maison**, délibérément.

**Et une TROISIÈME situation, qui est celle que le plafond est calibré pour produire.** Le pire cas
d'un billet est strictement positif sur les vingt combinaisons mode × palier — 750 centimes pour solo
à $0,50, 39 000 pour la Resurgence à 10 $ — donc dès que l'exposition réalisée d'un joueur arrive à
moins d'un pire cas **minimal** du plafond, `plafondVerdict` rend `franchi` pour **toute** table,
portée `joueur`. L'état n'est pas un cas limite : les quatre victoires maximales que
`PLAFOND_TABLES_PAR_JOUR` existe pour laisser gagner y mènent exactement. Le joueur lisait alors
« pick a smaller buy-in » sur les vingt tables du lobby, prenait vingt fois le même refus, épuisait
son seau de débit et finissait sur un **429**, qui n'est pas dans `REFUS_SAS` et le renvoie jouer
hors ligne. La réponse porte donc, **en plus** de la portée, un booléen `aucuneTableMoinsChere`, et
`WBCore.refusMessage` ne fait que le **lire** : le seuil juste est `plafond − pire cas minimal du
lobby`, jamais `plafond`. Ce nombre se dérive de `MODES × TIERS` dans `api/app.js` — 750 centimes
aujourd'hui, `PIRE_CAS_MIN_CENTS`, calculé une fois au chargement — et jamais d'un littéral : même
discipline que `PLAFOND_JOUEUR_CENTS`, qu'un test recalcule. La portée reste `joueur` : la faire
mentir sur QUEL plafond a refusé aurait déplacé le défaut au lieu de le fermer, et descendre le
calcul dans `WBCore` aurait fait voyager le pire cas minimal du lobby dans les 465 Ko que chaque
joueur télécharge.

**Trois limites, écrites plutôt que découvertes.** (1) Le refus par joueur **consomme une graine** :
il se décide dans la transaction, donc après les deux tirages, exactement comme `fonds`. Le prix est
nul — le joueur n'obtient aucun billet, donc aucune carte, et la source est un générateur. (2) Quand
le fusible saute, il refuse **aussi** un joueur qui redemandait simplement son billet déjà ouvert
après une réponse perdue : le fusible est lu avant de savoir si la demande est un rejeu. Pendant un
déclenchement, un billet ouvert n'est donc pas récupérable par cette route, et sa mise reste au
séquestre jusqu'à l'expiration. (3) Le fusible vit **en mémoire du processus**, comme la limitation
de débit : perdu au redémarrage, non partagé entre instances, donc un déploiement à deux processus
double de fait le fusible.

## `ledger_entries` — la table, et ce que sa clé prouve

Phase 03, module 2. Le grand livre cesse d'être un objet en mémoire : il a une table, et rien de ce
qu'`api/ledger.js` construit ne s'écrit ailleurs.

**Insertion seule, et sans exception.** Aucun `update`, aucun `delete`, nulle part, jamais. Une
écriture modifiée est une **preuve détruite** : on ne peut plus dire ce qui a été payé ni quand. Une
écriture fausse se corrige par une **contre-passation** — un mouvement inverse, daté, motivé, qui
laisse les deux visibles. Deux gardes textuelles le tiennent : aucun `update` ni `delete` de
`db-pg.js` ne vise cette table, et la doublure d'`api/test.js` n'expose aucun chemin de modification
(les lignes qu'elle pose sont gelées).

**Une ligne est un TRANSFERT** : `montant_cents integer not null check (montant_cents > 0)`,
`compte_debit`, `compte_credit`, et `check (compte_debit <> compte_credit)`. La somme du livre est
donc nulle **par construction**, et la partie double est structurelle plutôt qu'assertée avant
l'insertion. Strictement positif, pas « positif ou nul » : c'est cette contrainte-là qui oblige
`api/ledger.js` à **omettre** une jambe nulle au lieu de la poser.

**Les comptes portent une GRAMMAIRE, pas une liste fermée.** Trois des six comptes sont des familles
paramétrées, et un `check (compte in (...))` aurait été refusé au premier joueur inscrit. Les deux
colonnes portent donc `check (compte ~ '…')`, où l'expression est celle qu'exporte `api/ledger.js`
sous le nom `COMPTE_RE_SQL`, **recopiée caractère pour caractère**. Un test compare les deux textes ;
une expression qui diverge du code est le patron du `respawn()` défini deux fois. Les **motifs**,
eux, sont une vraie liste fermée : un `check (motif in (…))` à six valeurs, comparé lui aussi à
`MOTIFS`.

**La clé d'idempotence est `(motif, reference, compte_debit, compte_credit)`**, et il faut dire les
deux moitiés :

- **Ce qu'elle prouve** : une jambe s'écrit au plus une fois, donc un mouvement rejoué en bloc
  n'écrit rien — les paires de comptes d'un même mouvement sont distinctes deux à deux, garanti et
  testé dans `api/ledger.js`, donc la clé identifie exactement une jambe. C'est l'insertion
  **refusée** qui apprend ce qui existait déjà, jamais un `select` préalable : la fenêtre entre le
  « existe-t-il ? » et l'écriture vaut ici un crédit en double. Et l'écrivain ne porte **pas** de
  `on conflict do nothing` : sur `match_traces` avaler le doublon est le bon comportement, ici un
  doublon veut dire qu'on paie deux fois et l'appelant doit l'apprendre.
- **Ce qu'elle ne prouve pas** : elle n'interdit pas deux **décompositions différentes** sur la même
  référence. Ce trou-là est refermé ailleurs — l'interdiction du découvert sur le séquestre (un
  second gain devrait débiter un séquestre déjà vide) et la clause `where status = 'open' and
  net_cents is null` du règlement de `matches`. Trois protections qui se recouvrent, et c'est voulu.

Deux index de lecture, `(compte_debit)` et `(compte_credit)` — **passés à `(compte, cree_le)` au
module 4 de la phase 04a**, quand le plafond a commencé à lire une fenêtre glissante : le solde est
une **somme** sur ces lignes, et c'est cette somme qui remplace la case qu'on ne crée pas.
L'échappatoire nommée, le jour où elle coûtera trop cher, est l'instantané de clôture — jamais une
colonne mise à jour.

`matches.status` reçoit au passage sa **sixième** valeur, `'renounced'`. Elle entre ici et pas au
module qui l'écrira, parce que `ledgerReconcile` la connaît déjà : un statut que le code reconnaît
et que la base refuse ne se verrait qu'au premier renoncement réel, en 500, mise débitée. Un test
compare la liste du `check` à `ledger.STATUTS_CLOS`.

Côté pilote, trois fonctions dans `db-pg.js`, et elles prennent toutes un **client déjà en
transaction** : `ledgerWrite`, l'écrivain **unique** ; `ledgerSolde`, la somme des crédits moins la
somme des débits ; `ledgerDe`, la relecture par référence. Ce ne sont pas des méthodes du `db` injecté
dans `createApp()` — le routeur ne les voit jamais. Une écriture du livre n'a de sens qu'avec ce
qu'elle accompagne, et les deux doivent échouer ou réussir ensemble ; une méthode qui ouvrirait sa
propre connexion rendrait cette atomicité impossible. `ledgerSolde` **convertit** ce que `sum()` rend :
c'est un `bigint`, donc une chaîne, et un solde parti en texte ferait comparer « 9 » et « 10 »
caractère par caractère — le refus de découvert laisserait passer exactement ce qu'il existe pour
arrêter.

## Le grand livre en ligne — dotation, débit, règlement, quarantaine

Phase 03, module 3. Le livre cesse d'être une table que personne n'écrit : les routes l'écrivent.
Trois moments, trois mouvements, et **aucun d'eux n'est déclenchable par le client**.

### La dotation et la recharge, écrites par le serveur

Un compte neuf reçoit `DOTATION_CENTS` — **5 000 centimes**, c'est-à-dire exactement le portefeuille
de démonstration hors ligne, `WBCore.START_WALLET`. Cette phase fait apparaître **deux économies sur
le même écran**, et les faire partir de deux nombres différents ferait prendre la première connexion
pour un bug. `api/ledger.js` doit rester pur, donc il ne charge pas `WBCore` : le nombre y est écrit,
et un test **confronte** les deux écritures au lieu de les faire se croire.

Le mouvement est `maison:dotation → joueur:<id>:disponible`, idempotent sur `(dotation, <user_id>)`,
écrit **dans la même transaction que la création du compte**. Les deux réussissent ou échouent
ensemble : un compte sans dotation serait un joueur qui ne peut rien faire, et que rien ne
réparerait puisqu'il ne sera plus jamais créé.

**Une dotation unique laissait un cul-de-sac que la conception initiale ne nommait pas.** Le bouton
« + reload demo credits » disparaît en ligne : un joueur qui épuise ses crédits ne peut donc **plus
jamais jouer**, à vie, après une centaine de parties à 0,50 $. Ce n'est pas un détail de confort,
c'est la fin de la boucle de jeu. La **recharge** referme cela sans créer la route de crédit gratuit
qu'on refuse par ailleurs :

- elle est idempotente sur `(recharge, <user_id>:<AAAA-MM-JJ>)` — une par joueur et par jour ;
- le jour se compte **en UTC**, parce que deux instances déployées dans deux régions basculeraient
  sinon à deux heures différentes, et « une par jour » deviendrait « une ou deux selon le serveur
  qui répond ». L'heure vient de l'horloge **injectée** dans `createApp()`, donc la règle se teste
  sans attendre minuit ;
- elle ne s'écrit **que si le solde dépensable est au-dessous** de `PLANCHER_CENTS` (500 c, dix
  parties de la table la moins chère). « Au-dessous », pas « au plus » : un test le tient ;
- elle vaut `RECHARGE_CENTS` (1 000 c, vingt parties de cette même table). Assez pour que la boucle
  ne se ferme jamais, trop peu pour être un revenu qu'on récolte ;
- elle est écrite **au moment de la connexion**, par `findOrCreate`, et par personne d'autre.

**Il n'existe aucune route `POST /api/credits`.** Une route de frappe de monnaie appelable par le
client est exactement ce qu'on refuse, et une garde textuelle vérifie qu'aucune n'est apparue.

Le contrôle « suis-je sous le plancher ? » est une **somme**, qu'aucune contrainte déclarative ne
sait exprimer : `findOrCreate` prend donc le même verrou de ligne que l'ouverture d'un billet avant
de lire puis d'écrire. Sans lui, deux onglets écriraient deux recharges. Avec lui, la relecture
préalable est exacte au lieu d'être une fenêtre — et elle est nécessaire, parce que l'écrivain du
livre **refuse** un doublon au lieu de l'avaler : un joueur qui repasse sous le plancher le même jour
est un cas normal, et il ne doit pas faire échouer sa propre connexion.

### La mise est débitée à l'OUVERTURE, sous verrou, dans une seule transaction

Le seul instant que le serveur observe **sans dépendre du client** est celui où il émet le billet.
Débiter au coup d'envoi laisserait jouer gratuitement qui ne l'annonce jamais ; compenser à la fin
laisserait jouer gratuitement qui ne rend jamais de résultat. `createMatch` n'est donc plus la boucle
en validation automatique de la 02a : **toute** la boucle est dans une transaction, chemin `repris`
et libération du billet périmé compris.

**Le verrou est pris en tête de transaction, avant que la somme ne soit calculée** :

```sql
select id from users where id = $1 for update
```

Il n'y a pas de table des comptes — c'est tout l'intérêt du grand livre — donc on ne peut pas
verrouiller « la ligne du compte » : on verrouille la seule ligne qui existe par joueur. Sans lui,
deux onglets qui ouvrent un billet en même temps lisent tous deux un solde de 50, débitent tous deux
50, et **aucun `check` de colonne ne peut voir une somme d'autres lignes**.

**C'est le premier verrou explicite du dépôt, et la doublure d'`api/test.js` ne peut pas le
prouver.** Un mono-fil JavaScript sérialise gratuitement ce que Postgres ne sérialise que si on le
lui demande bien : un verrou éprouvé en série ne prouve rien. Seul `api/db-check.js` l'éprouve, avec
deux connexions réelles, en **observant l'attente** et avec un contrôle sur un autre joueur.

Trois conséquences, toutes testées :

- **Le chemin `repris` n'écrit jamais une seconde mise.** C'est le vol le plus facile de la phase —
  un `POST` rejoué qui débite deux fois — et il vaut pour les deux formes de reprise : la même
  `clientKey`, et une clé différente sur un billet déjà ouvert (l'index partiel refuse l'insertion).
- **Un solde insuffisant sort en `409` avec le code nommé `fonds`**, et il ne laisse **ni billet ni
  écriture** : la transaction est annulée, y compris la clôture du billet périmé qu'elle avait
  entamée. Pas un `402` — la doctrine du dossier est « des refus nommés, tous en 400 ou 409, aucun
  en 500 », et un `402` parle de payer l'API, pas la table. Le joueur peut redemander une partie
  juste après : rien ne l'enferme, et c'est la leçon du `22003` transposée sur le chemin de l'argent.
- **Un billet clos par `createMatch` vide son séquestre** vers `maison:contrepartie`, dans la même
  transaction. Sans cela, l'invariant « `solde(enjeu:<match>) = 0` sur toute ligne close » tomberait
  sur le chemin le plus banal de l'API. Le joueur n'est pas remboursé : la mise rentre chez la
  maison. *Ce que ce module ne fait pas : le veilleur, qui clôt les billets que personne ne termine,
  n'écrit toujours aucun montant — c'est le revirement du module 4.*

### Le règlement écrit la ligne et le gain dans la même transaction

`settleMatch` prend le verrou sur la ligne de la partie — `select id from matches where id = $1 for
update` — puis écrit le règlement, puis les transferts. Les montants viennent de **la ligne qu'on
vient d'écrire**, donc de `WBCore.cashoutCents` par `matchVerdict` : l'API ne recalcule jamais la
commission, pas même « juste pour vérifier », et ce qui est crédité est exactement le `net_cents`
que la base porte.

Le mouvement est celui de `ledger.js`, reliquat compris, et le gain part sur
`joueur:<id>:quarantaine` **si le rejeu a divergé** — seul `digest_match === true` est une
convergence. Une ligne **refusée** ou **périmée** ne crédite rien et vide **quand même** son
séquestre : c'est `mouvementGain` avec un brut nul, un seul transfert. Aucun séquestre ne reste
habité.

**Vider et régler sont la même opération comptable**, donc une seule fonction, `reglerSequestre`, et
une seule entrée dans la liste des appelants autorisés de l'écrivain du livre. Elle passe au
mouvement **ce que le séquestre porte**, pas ce que la ligne annonce : le mouvement est ainsi garanti
de le vider jusqu'au dernier centime, et confronter les deux nombres est le travail de
`ledgerReconcile`.

**La frontière avec la 02a se constate ici, et elle n'est pas une phrase.** Un séquestre vide veut
dire que le livre n'a jamais engagé cette partie — une ligne écrite avant qu'il n'existe. On n'écrit
alors **rien** : une ligne sans écriture de mise n'a jamais d'écriture de gain. Un test sème une
ligne 02a dans la doublure et prouve qu'aucune écriture ne la touche, ni au règlement ni à la
clôture.

### Le découvert, et les deux refus que le livre peut opposer

**Aucun compte ne passe en négatif**, sauf `maison:dotation` et `maison:contrepartie`. La règle est
vérifiée dans `ledgerWrite` — l'écrivain unique, dans la transaction, après le verrou — sur l'**effet
net** du mouvement compte par compte, et pas jambe par jambe : un règlement crédite le séquestre du
reliquat avant de le vider, et l'ordre des lignes à l'intérieur d'une transaction ne veut rien dire.
La poser chez l'appelant aurait protégé le chemin qui l'appelle, pas la donnée.

Deux échecs du livre sont donc possibles, et **ni l'un ni l'autre ne sort en 500** :

| Cause | Ce que la route rend |
|---|---|
| solde du joueur insuffisant, constaté avant d'écrire | `409` `fonds`, avec `balanceCents` et `requiredCents` |
| `23505` (une jambe déjà posée) ou découvert refusé par l'écrivain | `409` `livre` |

Dans les deux cas la transaction est annulée en entier : **un règlement interrompu au milieu ne
laisse aucune écriture partielle**, la ligne repart `open` sans montant, et le joueur peut renvoyer
son résultat sur le **même** billet tant qu'il vit. L'écrivain n'a volontairement aucun `on conflict
do nothing` — un doublon veut dire qu'on paie deux fois, et l'appelant doit l'apprendre — donc c'est
bien à l'appelant de le traduire en refus nommé.

### Les deux montants rendus, et pourquoi ils sont séparés

`GET /api/me` et `PATCH /api/me` rendent la **même** forme, et `POST /api/match` rend les deux
montants **avec le billet, après le débit** : un aller-retour de moins pour le jeu, et surtout la
parole du serveur plutôt qu'une soustraction faite dans le navigateur.

- `balanceCents` — le solde **dépensable**, `solde(joueur:<id>:disponible)` ;
- `quarantineCents` — ce qui vient d'une ligne dont le rejeu a **divergé** : visible, chiffré,
  jamais dépensable.

Les deux sont **lus par somme**, jamais dans une colonne : il n'existe nulle part de case à écraser.
Ils restent en **centimes entiers** jusqu'au bout du réseau — c'est `applyAccount`, côté jeu, qui les
repasse en dollars, en un seul point de conversion. Les additionner ferait de la quarantaine un
solde, c'est-à-dire exactement ce qu'elle n'est pas ; les taire ferait disparaître de l'argent aux
yeux du joueur. Aucun agrégat convergé n'en compte un centime, et un test le vérifie sur une ligne
divergente réglée et payée.

### Ce que les tests prouvent ici, et ce qu'ils ne prouvent pas

Ils prouvent, contre la doublure : la dotation écrite une fois sur vingt connexions ; la recharge au
plus une par jour et jamais au-dessus du plancher ; le `POST` rejoué qui ne débite pas deux fois ; le
refus `fonds` qui ne laisse rien et n'enferme personne ; le solde **resommé depuis les écritures**
égal à ce que `GET /api/me` rend ; un corps chargé de montants qui écrit exactement les mêmes
écritures qu'un corps minimal ; le règlement rejoué qui crédite une fois ; le net crédité égal au
`net_cents` de la ligne ; la quarantaine d'une ligne divergente ; le règlement interrompu qui ne
laisse aucune écriture partielle ; la frontière avec la 02a. Plus **cinquante parties de bout en
bout** — cinq modes, quatre tables, cinq statuts — où la somme globale du livre est vérifiée à
**chaque étape** et où `ledgerReconcile` est appelé à la **fin de chaque scénario** : le zéro global
reste vrai quand un montant juste est posé sur le mauvais compte, et c'est exactement ce que la
réconciliation attrape.

Ils **ne prouvent pas** le verrou. Ils ne peuvent pas : seul `api/db-check.js` le peut, et il n'a
jamais tourné contre une base. **Un test qui passe contre la doublure prouve la doublure.**

## Le billet que personne ne termine — renoncement, temporisation, conservation

Phase 03, module 4. Trois choses qui se tiennent : ce qu'un joueur peut récupérer, ce qu'il ne peut
plus récupérer, et combien de temps on garde la pièce qui le prouve.

### Le vol que ce module ferme, et il faut le nommer

**Ouvrir un billet, jouer, perdre, n'envoyer NI trace NI résultat, laisser expirer, et se faire
rembourser.** Le joueur ne perdrait alors jamais. Toute condition de remboursement fondée sur « aucune
trace n'est arrivée » est contrôlée par le **client**, donc sans valeur : la seule chose que le
serveur observe sans lui est **son propre chronomètre**. Un test porte le nom du vol, joue une vraie
partie perdue, n'envoie rien, laisse expirer, et vérifie que le solde vaut `dotation − mise` et
**jamais** `dotation`.

### `POST /api/match/:id/renounce`

La seule route du dépôt qui **rende une mise**. Elle est acceptée **uniquement pendant la fenêtre de
`WBCore.renonciationOuverte`**, à l'horloge du serveur — la même fonction que le sas d'attente appelle
pour dire au joueur ce que partir va lui coûter. La borne n'est **pas recalculée ici** : deux
définitions seraient la troisième copie du patron déjà condamné pour `terminal`, `faits` et
`argentCents`.

**La fenêtre vaut dix secondes, et pas les vingt-cinq de `LOBBY.wait`.** Le jeu décolle plus tôt :
`waitTick` pose `W.drop = min(W.drop, W.t + LOBBY.dropIn)` dès que la salle est pleine, et `joinRate`
plafonne la pression à 2,4 — le coup d'envoi peut donc tomber à 13,4 s. Une fenêtre de 25 s
rembourserait une partie commencée depuis une douzaine de secondes de jeu réel, et le vol qu'on se
donne le mal de fermer se rouvrirait par la porte d'à côté.

Elle clôt le billet en `'renounced'` et rembourse **ce que le séquestre porte** — pas `stake_cents` :
le mouvement est ainsi garanti de le vider jusqu'au dernier centime, et confronter les deux nombres
est le travail de `ledgerReconcile`. Les deux écritures, clôture et remboursement, sont **une seule
transaction**, sous verrou de la ligne `matches`. Un séquestre vide veut dire que le livre n'a jamais
engagé cette partie — une ligne de la 02a — et on n'écrit alors rien.

| Refus | Code | Ce qu'il laisse |
|---|---|---|
| billet inconnu, ou qui n'est pas le sien | `404` | rien |
| billet déjà clos | `409 billet_clos` | rien ; la place est libre, le joueur redemande un billet |
| fenêtre passée | `409 fenetre_close` | rien ; le billet reste **jouable** |
| le grand livre refuse | `409 livre` | rien ; la transaction est annulée en entier |

Aucun n'est un 500, et aucun n'enferme le joueur. Les deux bornes exactes sont éprouvées au
millième : `renonciationOuverte` est un `<=`, donc le dernier instant ouvert est la fenêtre
elle-même, et la milliseconde suivante refuse.

**Un résultat rendu après un remboursement ne paie rien.** La ligne est close : la route du résultat
relit son état, comme sur tout billet clos, et n'écrit aucun montant. Et si la clause `where` du
règlement glissait un jour, le séquestre **vide** refuserait le gain de toute façon — un gain devrait
le débiter, et le découvert n'y est pas autorisé. Trois protections qui se recouvrent, une fois de
plus.

Ce que la fenêtre fait payer, et qui n'est pas rien : **le joueur honnête dont l'onglet meurt à la
onzième seconde perd sa mise.** La phase nomme le vol qu'elle ferme ; elle doit nommer le prix
qu'elle fait payer.

### La temporisation du chercheur de graine — `409 renonce_recent`

Renoncer à la première seconde clôt le billet, libère l'index partiel, et `createMatch` en délivrerait
un neuf **immédiatement**, avec une graine neuve. La carte étant une fonction pure de `seed_public`,
que le client reçoit **avec** le billet, le coût d'un nouveau tirage serait un aller-retour HTTP.
C'est une surface que cette phase ouvre elle-même.

`POST /api/match` refuse donc en **`409 renonce_recent`** tant que la fenêtre du **dernier billet
renoncé** n'est pas passée — même fonction, même borne. Le refus est posé avant les deux tirages de
graines et avant toute écriture : ni billet, ni écriture, ni graine consommée.

**Ce qui reste acceptable, et il est écrit plutôt que tu** : un tirage toutes les dix secondes, pour
un avantage nul contre vingt bots dont aucun ne connaît la carte. Le jour où les adversaires seront
humains, ce chiffre-là devra être relu.

**Ce que ce contrôle ne fait pas** : il n'est pas atomique. Deux requêtes simultanées peuvent le
franchir toutes les deux. Ce qui les rattrape ensuite est l'index partiel « un seul billet ouvert » —
la seconde reprend le billet de la première au lieu d'en ouvrir un second — donc le pire cas reste
**un** billet, pas deux.

### La conservation de `match_traces` — la dette de la 02b, soldée

La trace est la **pièce justificative d'un mouvement d'argent** : c'est elle, et elle seule, qui
permet de refaire la partie qui a produit un `net_cents`. `TRACE_RETENTION_JOURS` vit dans
`api/ledger.js`, avec sa raison écrite à côté d'elle — la tension est réelle et elle est écrite : ce
fichier dit « le grand livre, et rien d'autre », mais deux des quatre conditions de la purge sont des
conditions du livre, et `db-pg.js` charge `pg`, donc `api/test.js` ne peut pas le lire. La valeur est
**conservatrice**, quatre cents jours, et **ce n'est pas une décision juridique** : la vraie fenêtre
de contestation est une affaire de phase 06.

La purge est **bornée** et n'efface une trace que si **les quatre conditions** sont réunies — et les
quatre sont dans la clause du `delete` lui-même, pas dans le code qui la choisit :

1. la ligne `matches` est **réglée définitivement** — `status in ('settled', 'rejected')` ;
2. le grand livre a **posé son écriture** — un mouvement `gain` ou `remboursement` porte ce
   `match_id`. Le **motif** compte autant que la référence : une dotation porte `<user_id>` et un gain
   porte `<match_id>`, les deux vivent dans le même espace de noms, et sans le filtre la dotation du
   joueur 1 ferait purger la trace de la partie 1 ;
3. **rien n'est en attente** — `solde(enjeu:<match_id>) = 0`. La somme n'est pas recopiée : elle sort
   de la même expression que `ledgerSolde`, parce que deux écritures de « un solde est cette
   somme-là » finiraient par différer et que celle qui différerait serait justement celle qui autorise
   un effacement ;
4. **le délai est écoulé** — `settled_at` plus vieux que la rétention.

Elle ne touche **jamais** une ligne `matches`, **jamais** une écriture du grand livre : elle les
**lit**. `ledger_entries` reste en insertion seule, sans exception.

**Conséquence directe, et c'est le bon défaut** : la trace d'un billet dont le résultat n'est jamais
arrivé n'est **jamais** effacée, puisque sa ligne n'est ni `settled` ni `rejected`. C'est exactement
la pièce qu'on voudra relire, et la table ne descend donc pas à zéro. Un test l'éprouve à quatre
cents jours **et à mille ans**.

**UNE GARDE A CHANGÉ DE FORME, ET IL FAUT LE DIRE.** `api/test.js` interdisait tout
`delete from match_traces` dans `db-pg.js`, et il **passait**. Il dit maintenant « le seul `delete` de
cette table est la purge nommée, et sa clause porte les quatre conditions » — c'est plus étroit sur ce
qui reste gardé, et c'est plus faible sur l'interdiction elle-même. Une garde qu'on affaiblit sans le
dire est très exactement l'écart que la recette de la 02b a trouvé. Les quatre conditions sont en plus
éprouvées **une par une**, sur un cas dégénéré construit exprès : quatre tests, pas un. C'est le
premier `delete` du dépôt sur la pièce qui prouve un paiement ; on ne le teste pas en bloc.

`main.js` appelle `app.purger()` **une fois par heure**, et sur son propre minuteur : il n'y a aucune
raison de faire passer ce `delete`-là dans le même tour d'horloge qu'une clôture de routine, et la
rétention se comptant en centaines de jours, une heure de retard n'a aucun effet observable.

### Ce que les tests du module 4 prouvent, et ce qu'ils ne prouvent pas

Contre la doublure, horloge injectée, sans base ni réseau : le vol nommé ; les deux bornes exactes de
la fenêtre ; les quatre refus, tous nommés, aucun en 500, aucun qui enferme ; le veilleur passé **cent
fois** qui ne rembourse jamais, ne vide jamais deux fois, et envoie chaque séquestre chez la maison ;
le résultat tardif qui n'écrit aucun second mouvement ; la temporisation qui refuse puis accepte, sans
consommer une graine ; la **sixième issue** sur les cinq modes et les quatre tables, avec
`ledgerReconcile` et le zéro global à chaque scénario ; la purge, condition par condition.

Ils **ne prouvent toujours pas** ce que Postgres fait de la clause de la purge — un `::text`, une
concaténation qui construit un nom de compte, un solde recalculé en SQL sur trois tables. C'est
`api/db-check.js` qui l'éprouve, et il n'a **jamais** tourné contre une base.

## `operateur.js` — qui a le droit de contre-passer

Phase 04a, module 5. Le grand livre n'a qu'un chemin de correction, la contre-passation, et
`mouvementContrepassation` existait depuis la phase 03 **sans un seul appelant** : personne n'avait
écrit qui pouvait l'emprunter. `docs/HISTORIQUE.md` le disait sans détour — « le premier incident réel
se réglera à la main dans `psql`, un dimanche soir, et c'est ce jour-là que la règle "aucun `update`"
tombe ». Ce module est l'appelant qui manquait, et la trace qui va avec.

**C'est un OUTIL EN LIGNE DE COMMANDE, jamais une route.** Une route d'administration est une surface
d'attaque **permanente** pour un geste qui arrive deux fois par an, et elle demanderait une
authentification de second ordre — un rôle dans `users`, un second facteur — que rien d'autre du
dossier ne justifie. L'opérateur détient déjà les identifiants de la base : il n'y a rien à lui
accorder qu'il n'ait pas. Même patron et même garde que « il n'existe aucune route
`POST /api/credits` » : un test vérifie qu'`api/app.js` ne charge jamais `api/operateur.js`, ne nomme
ni `contrepass`, ni `ledger_audit`, ni `/api/admin`, et que la table des routes vaut toujours
exactement `/api/match` et `/api/me`. L'outil, de son côté, ne parle pas HTTP et ne s'écoute nulle
part.

**Il sait LIRE avant de savoir écrire, et `montrer` arrive en premier.** Le premier geste d'un
incident réel n'est pas de corriger, c'est de regarder. Trois lectures, qui n'écrivent **rien** et
n'exigent aucune confirmation :

```
montrer mouvement <motif> <reference>   les jambes, le total, le billet désigné
montrer billet <id>                     la ligne, ses écritures, son séquestre, la marge à l'ouverture
montrer exposition <userId>             l'exposition réalisée sur la fenêtre, et la marge restante
```

**C'est `montrer exposition` qui répond à « pourquoi ce joueur a-t-il été refusé en `plafond` », et
pas `montrer billet`.** Un refus `plafond` ne laisse **aucune** ligne dans `matches` — c'est la règle
« ni ligne, ni écriture, ni séquestre » — et le corps du 409 ne porte aucun identifiant : il n'existe
donc aucun billet à relire, et `montrer billet <id>` répondrait « aucun billet <id> » sur le cas même
qu'on lui avait assigné. Le diagnostic part du **joueur**, jamais du billet.

`montrer billet` dit autre chose, et c'est ce qui l'avait fait mentir : **la marge de plafond que le
joueur avait à l'ouverture de CE billet**. La requête est bien celle qui refuse —
`expositionJoueurCents` passe par `EXPOSITION_FENETRE_SQL`, jamais par une requête réécrite pour
l'occasion — mais cela ne suffisait pas : ce ne sont pas la même *requête* mais les mêmes
**paramètres** qui font le chiffre. L'outil l'ancrait sur l'horloge **courante** quand `createMatch`
décide sur `opened_at`, donc une jambe de gain posée deux heures avant l'ouverture pesait 39 000 dans
la fenêtre du refus et zéro dans celle de l'outil dès le lendemain. Les trois paramètres viennent
maintenant de la ligne : l'ancre, la borne haute `cree_le <= opened_at`, et le pire cas de la table,
dérivé de `WBCore` et jamais écrit à la main.

Un test vérifie que les trois verbes ne laissent **aucune** ligne dans `ledger_entries` ni dans
`ledger_audit`, et ne touchent pas `matches`.

**`contrepasser` montre, puis exige trois choses.** Une raison écrite, un nom d'opérateur, et
`--confirme`. Sans `--confirme`, la commande affiche ce qu'elle poserait et **n'écrit rien**. Avec, la
contre-passation et sa raison partent **dans la même transaction**.

```
contrepasser <motif> <reference> --par "<qui>" --raison "<pourquoi>" [--confirme]
```

**La partie qui décide est PURE**, et elle vit dans `api/ledger.js` :
`planCorrection(transferts, { par, raison, billet })`. Elle rend un plan gelé ou un **refus nommé**,
jamais une exception — un opérateur qui lit une pile d'appels un dimanche soir n'apprend rien, et ces
refus sont des cas normaux. Les codes : `mouvement_vide`, `operateur_vide`, `raison_vide` (les blancs
ne comptent pas : sinon « pourquoi » serait une case à cocher), `mouvement_heterogene`,
`double_contrepassation`, `billet_inconnu`, `billet_etranger`, `billet_statut_inconnu`, et
`billet_ouvert`. Un dixième refus vient du **livre** et non du plan : contre-passer une dotation que
le joueur a déjà dépensée demande à son compte plus qu'il ne porte, et la règle uniforme du découvert
l'arrête. C'est un refus, pas une panne — l'opérateur lit une phrase, et **aucun compte ne passe en
négatif, pas même par une correction**.

**`billet_ouvert` est le seul refus qui regarde ailleurs que dans le livre, et c'est le seul cas qui
laisserait un séquestre incohérent avec son statut.** Sur une ligne `open`, `solde(enjeu:<id>)` doit
valoir la mise : contre-passer la mise le viderait, contre-passer un gain le remplirait, et
`ledgerReconcile` produirait un grief sur une ligne que personne n'a touchée. **Un billet ouvert
coincé se règle par la clôture normale — le veilleur — jamais par une correction du livre**, et c'est
écrit dans l'aide de l'outil pour que personne ne le cherche là.

**Contre-passer une contre-passation est REFUSÉ**, et cela solde une dette nommée au module 1. Le
double geste produit la référence `contrepassation:gain:42`, que `referenceBillet` et sa traduction
SQL ne ramènent à **aucun** billet : l'écriture cesserait de compter dans l'exposition, et le plafond
serait faux sans que rien ne le dise. `docs/PHASE-04A.md` chiffrait les deux réponses possibles —
élargir la règle des deux côtés, ou fermer le chemin. On ferme : le geste n'a pas d'usage, et une
correction fautive se corrige sur le **mouvement d'origine**.

**`ledger_audit`, en insertion seule, partage la transaction de l'écriture d'argent.** Quand, par
qui, pourquoi, le `(motif, reference)` d'origine, la référence posée, le nombre de jambes et le
montant total. C'est toute sa raison d'être : une raison consignée **après coup** peut ne jamais
l'être — le shell se ferme, la connexion tombe — et une contre-passation sans raison est
indistinguable d'une erreur de manipulation. Un fichier de journal ou une sortie de terminal ne
partagent aucune transaction : ils ont été écartés pour cela. La table porte un **`geste`** plutôt que
d'être une table `contrepassations` : le module 6 y écrira l'anonymisation d'un compte, qui ne touche
pas un centime mais relève du même registre. La liste des gestes est **fermée à un membre
aujourd'hui** — l'y ajouter d'avance serait une case en attente d'être créée de travers, exactement ce
que le dossier refuse depuis le motif de libération de quarantaine.

**Rejouer l'outil ne pose rien, et il LE DIT.** La clé `(motif, reference, compte_debit,
compte_credit)` refuse la seconde pose ; ce `23505` devient « DÉJÀ POSÉE », pas une pile d'appels. Un
opérateur qui relance sa commande parce que sa connexion a lâché doit lire que c'était déjà fait :
sortir en erreur sur un geste idempotent est très exactement ce qui fait ouvrir `psql` pour
« vérifier ».

**Aucune dépendance nouvelle, aucun secret.** Les identifiants de base viennent de `DATABASE_URL`,
comme `api/main.js`. Sans elle, l'outil affiche son aide et sort 0 ; un verbe qui a besoin de la base
le dit et sort 2. Le contrôle est **avant** le `require('./db-pg')`, donc avant `pg` : l'intégration
continue lance `node api/test.js` avant `npm install`, et ce fichier y est chargé pour ses fonctions
pures. Un test le **lance** pour de bon plutôt que de relire son texte.

**Ce que les tests prouvent ici, et ce qu'ils ne prouvent pas.** Contre la doublure : les refus de
`planCorrection` un par un, l'audit qui échoue et ne laisse aucune contre-passation, le rejeu qui ne
pose rien, le retour **au centime** des quatre comptes touchés par un gain contre-passé, le zéro
global, et l'exposition qui retombe avec eux. Un grief **légitime** reste, et il est nommé plutôt que
tu : contre-passer le gain d'une ligne réglée **réhabite** son séquestre, et `ledgerReconcile` a
raison de le dire — l'outil corrige le livre, il ne décide pas de la suite. Ce qu'ils **ne prouvent
pas** : que la transaction est arbitrée par Postgres plutôt que par l'ordre des `await` d'un mono-fil.
C'est `api/db-check.js` qui l'éprouve, en faisant échouer l'audit sur une **vraie** contrainte.

## Un compte ne s'efface pas, il s'anonymise

Phase 04a, module 6. `schema.sql` portait depuis la phase 01 deux cascades que personne n'avait
regardées : `matches` sur `users`, `match_traces` sur `matches`. Depuis la phase 03, ces lignes sont
**les pièces justificatives de mouvements d'argent qui, eux, restent** — `ledger_entries` est en
insertion seule et nomme ses comptes avec `users.id` et `matches.id`, `joueur:<id>:disponible` et
`enjeu:<match_id>`. Un `delete from users` détruisait donc les billets et les traces en laissant
derrière lui des écritures immortelles qui pointent sur des lignes mortes.

**Les deux cascades sont en `restrict`.** La suppression échoue au lieu de se propager. Écarté :
l'effacement réel avec purge des écritures, qui détruit la partie double ; et « ne jamais supprimer
de compte », qui est une règle qu'aucun code ne tient, donc pas une règle.

**Le geste qui remplace la suppression est `anonymiser`, second verbe d'écriture de l'outil.**

```
anonymiser <userId> --par "<qui>" --raison "<pourquoi>" [--confirme]
```

**C'est une RÉÉCRITURE SOUS CONTRAINTES, pas une suppression de colonnes**, et l'écrire autrement
serait faux : `users` porte `auth_id text not null unique`, `email not null`, `name not null`,
`name_key text not null unique`, plus deux `check` de longueur. Aucun de ces champs ne peut
« partir ». Ce qui est écrit à la place :

| colonne    | après                    | pourquoi |
|---|---|---|
| `id`       | **inchangé**             | `joueur:<id>` et `enjeu:<match_id>` doivent rester des comptes valides |
| `auth_id`  | `anonyme:<id>`           | unique par construction, et l'identifiant du fournisseur ne survit pas |
| `email`    | `anonyme+<id>@invalid`   | `.invalid` est un TLD **réservé**, donc jamais routable |
| `name`     | `x<base36(id)>`          | quatorze caractères au plus : un `bigserial` tient sur treize chiffres en base 36 |
| `name_key` | `WBCore.nameKey(name)`   | la clé se dérive du nom, jamais écrite à côté |
| `avatar`   | `''`                     | la valeur par défaut de la colonne |
| `country`  | `null`                   | la colonne l'autorise |

**Le nom est calculé en JavaScript, pas en SQL**, et c'est le seul endroit où `WBCore.nameKey` et la
contrainte de quatorze caractères se lisent ensemble. `planAnonymisation` est pure et vit dans
`api/ledger.js` comme `planCorrection` ; `nameKey` lui est **injectée**, parce que ce fichier-là ne
`require` rien. L'identifiant est converti en `BigInt` et jamais en `Number` : au-delà de 2^53 un
`Number` arrondit en silence, deux comptes voisins recevraient le même nom, donc la même `name_key`,
donc une collision que rien n'explique — le pilote rend les `bigint` en chaîne précisément pour cela,
et un test l'éprouve sur 9 223 372 036 854 775 807.

**Une collision sur `name_key` sort en `23505`, et l'outil LE DIT puis s'arrête.** Quelqu'un peut
porter le pseudo `x1`. `findOrCreate` réessaie avec un suffixe à l'inscription, et c'est le bon geste
**à cet endroit-là** — il arrange un joueur qui ne remarquera rien ; ici, ce serait décider à la place
d'un opérateur, sur un geste rare, manuel et irréversible. Les refus de `planAnonymisation` :
`compte_inconnu`, `operateur_vide`, `operateur_trop_long`, `raison_vide`, `raison_trop_longue`,
`deja_anonymise`, `cle_indisponible`, `cle_hors_bornes`, `nom_hors_bornes`.

**La ligne d'audit est écrite dans la MÊME transaction**, et le geste est **refusé sans raison
écrite** — même exigence que la contre-passation, et pour la même raison : un compte réécrit sans
qu'on sache pourquoi est indistinguable d'une erreur de manipulation, et celui-ci ne se défait pas.
`ledger_audit` reçoit une colonne `user_id`, clé étrangère `restrict` vers `users`, et une contrainte
jumelle de celle des contre-passations : `ledger_audit_anonymisation_complete` **exige** le compte et
**interdit** les cinq colonnes d'argent, parce qu'une anonymisation ne bouge pas un centime. La liste
`AUDIT_GESTES` passe donc à deux membres, et pas un de plus. La trace ne conserve **pas** l'ancienne
identité : un journal qui garderait l'ancien email n'anonymiserait rien. Elle se relit par le compte,
`montrer exposition <userId>`, puisque le geste ne porte sur aucune écriture du livre.

**L'ancien pseudo redevient disponible, et c'est voulu.** Le corollaire est à connaître :
l'historique d'un joueur se lit alors sur son `id` et jamais sur son nom. Tout écran ou toute requête
qui afficherait un pseudo depuis une jointure devra le savoir, sinon deux personnes différentes
apparaîtront comme une seule.

**La surface de régression de ce module est VIDE, et c'est un test qui le dit, pas une lecture.** Il
n'existe aucune route ni aucune méthode qui supprime un compte : le seul `delete` du pilote reste la
purge nommée de `match_traces`. Le passage en `restrict` ne peut donc rien casser aujourd'hui — mais
« aujourd'hui » est une date, pas une propriété, et son unique effet observable est un **refus** que
seule l'intégration continue peut montrer. `api/db-check.js` fait subir les deux : un `delete from
users` refusé par `matches_user_id_fkey` tant qu'un billet référence la ligne, et un `delete from
matches` refusé par `match_traces_match_id_fkey`.

### Le trou qui reste, nommé et chiffré

`findOrCreate` cherche par `auth_id`. **Un joueur anonymisé qui se reconnecte avec le même email
obtient une ligne NEUVE** — son `auth_id` Crossmint n'est plus dans la base — **et une nouvelle
`DOTATION_CENTS` de 5 000 centimes.** C'est un **robinet à crédits**, dans la phase qui existe pour
borner ce que la maison émet.

Ce qui le tient aujourd'hui : **il n'existe aucune route qui demande l'anonymisation.** Le robinet
exige que l'opérateur l'ouvre lui-même, un compte à la fois, en ligne de commande. Un test le vérifie
des deux côtés — `app.js` ne nomme pas le geste, et l'outil est le seul à le porter.

Le jour où une route de suppression de compte existera — c'est-à-dire le jour où une juridiction
l'imposera — elle devra porter une **empreinte de l'`auth_id`** dans une table en **insertion seule**,
lue par `findOrCreate` **avant** de doter. Chiffré : une table, un index unique, une lecture, un test.
C'est écrit ici plutôt que laissé à découvrir sur un plafond qu'on croirait tenir.

## `db-check.js` — la vraie Postgres, et ce qui est livré est la RECETTE

**Livrer un script n'est pas l'avoir lancé.** Ce qui est livré ici, c'est la recette : un script, un
job d'intégration continue, et une liste de scénarios qui citent nommément les contraintes que la
doublure se contente d'imiter.

- **Sans `DATABASE_URL`, `node api/db-check.js` sort 0 en le disant.** Le contrôle est avant tout
  `require('pg')`, pour que le script n'échoue pas non plus sur une machine sans dépendances.
- **Il n'entre pas dans `npm test`**, qui continue de tourner sans base et sans réseau — règle non
  négociable du dépôt, tout est injecté dans `createApp()`. Un test le lance avec un environnement
  vidé pour le vérifier, et un autre vérifie que le job existant n'a reçu ni service ni base.
- Il **écrit et efface** dans la base qu'on lui donne : une base jetable, celle du service du job.
- **Il fait tourner `findOrCreate` DEUX FOIS DE SUITE**, avec le pseudo de repli — celui que tout
  nouveau compte reçoit, puisque Crossmint ne transporte pas de pseudo — et vérifie que le second
  obtient « Player2 » **et sa dotation**. Ce scénario n'a rien d'exotique : c'est le deuxième joueur
  qui s'inscrit. Il est ici parce qu'il ne peut être nulle part ailleurs — la doublure d'`api/test.js`
  résout la collision de pseudo en mémoire, donc elle ne **subit** jamais un refus d'insertion, et
  dans un bloc transactionnel une erreur avorte tout ce qui suit (`25P02`), si bien que le réessai
  sortait en 500 sans compte et sans dotation. Le script éprouvait jusque-là la **contrainte**
  `name_key` sans jamais appeler la fonction qui la heurte : la réserve de la phase 03 appliquée à
  elle-même.
- Ce qu'il éprouve, nommément : `name_key` ; l'index **partiel** « un seul billet ouvert », et la
  place qui se libère au billet clos ; `on conflict do nothing` sur `(match_id, seq)` ; la clause
  `where status = 'open' and net_cents is null` ; la clé du grand livre, **refusée et non avalée** ;
  la grammaire des comptes, les comptes distincts, le montant strictement positif, la liste fermée
  des motifs ; la borne `paid_seats between 1 and seats`, qui regarde **deux** colonnes et que rien
  ne relie dans un objet JavaScript — zéro, un négatif et vingt et un sièges sur vingt refusés par
  `matches_paid_seats_borne`, un et vingt acceptés ; les largeurs `integer` (un entier
  « valide » à 3 000 000 000 lève bien `22003`) ; la
  somme globale du livre à zéro ; le fait que `ledgerSolde` rende un **nombre** ; et que l'expression
  des comptes se comporte pareil dans le moteur POSIX de Postgres et dans celui de JavaScript — deux
  textes identiques ne sont pas deux moteurs d'accord.
- **Le seul test qui ne peut exister nulle part ailleurs** : deux transactions **concurrentes** qui
  débitent le même compte se sérialisent. Deux connexions réelles, `select id from users where id =
  $1 for update` dans les deux, et on **observe l'attente** — avec un contrôle sur un autre joueur,
  sans lequel une connexion morte se lirait comme un verrou qui marche. Puis deux débits simultanés
  du même solde : un seul aboutit, l'autre est refusé, et le solde ne passe jamais en négatif. Un
  verrou éprouvé en série ne prouve rien : une doublure JavaScript mono-fil sérialise gratuitement
  ce que Postgres ne sérialise que si on le lui demande correctement.
- **Depuis la phase 04a, deux cas de plus, et ils sont de la même famille.** (1) **Deux ouvertures
  simultanées ne franchissent pas le plafond à deux** : deux `createMatch` réels en parallèle rendent
  un seul billet, une seule mise, l'un des deux marqué `repris` — puis, l'exposition posée par des
  écritures, le billet suivant est refusé en `plafond`, portée `joueur`, sans laisser de ligne
  ouverte. Ce cas exécute au passage la **vraie requête de fenêtre** contre Postgres : c'est le seul
  endroit où `REFERENCE_BILLET_SQL` est interprétée par le moteur, et où un `42702` sur `motif`
  ambigu se verrait. (2) **La requête de fenêtre ne balaie pas le grand livre** : quarante mille
  lignes de lest, un `analyze`, puis un `explain (format json)` sur la requête réelle, qui refuse tout
  `Seq Scan` sur `ledger_entries` et exige que l'un des deux index `(compte, cree_le)` serve. C'est
  la seule façon de prouver qu'un index **sert**, et personne ne peut la donner sur la machine de
  travail.
- **Et depuis le module 5, deux de plus encore.** (1) **La contre-passation et son audit partagent la
  transaction, arbitrée par Postgres** : on fait échouer l'insertion de l'audit sur une **vraie**
  contrainte — la raison vidée, refusée par `check (char_length(raison) between 3 and 500)` — et on
  constate qu'aucune jambe de contre-passation n'a survécu, puis que le cas nominal les pose toutes
  les deux ensemble, puis que **la clé unique refuse réellement la seconde pose** et que l'outil
  traduit ce `23505` en « déjà posée » au lieu d'une panne. Une doublure mono-fil décide de l'ordre de
  ses `await` ; ici c'est la base qui annule. (2) **`ledger_audit` refuse** une raison vide, une raison
  de deux blancs, un nom d'opérateur vide, un geste hors liste et une contre-passation amputée de ses
  colonnes — cinq refus nommés par leur contrainte, qu'une doublure ne peut qu'imiter.

Le job `db` de `.github/workflows/test.yml` monte un service `postgres:16` et le lance. Le job
existant ne change pas d'une ligne, et un test compare ses étapes une à une.

**Tant que ce job n'a pas été vert une fois, un test qui passe contre la doublure prouve la
doublure.** Cette phrase reste vraie et reste écrite. Rien de ce module ne permet d'écrire que la
dette est soldée : il permet d'écrire qu'elle a maintenant une recette.

## Les fichiers

```
app.js              le routeur. Rien hors du cœur de Node, tout le reste lui est injecté.
core.js             charge WBCore depuis index.html
sim.js              charge WBSim depuis index.html — même chargeur, même garde bruyante
ledger.js           le grand livre : grammaire, motifs, mouvements, montants, et l'exposition de
                    la maison. PUR, sans dépendance.
crossmint-key.js    lit une clé d'API Crossmint et vérifie sa signature — sans dépendance
auth-crossmint.js   vérifie les jetons de session                  ← touche le réseau
db-pg.js            Postgres                                       ← touche la base
db-check.js         éprouve le schéma contre une VRAIE Postgres    ← hors de npm test
operateur.js        l'outil d'opération : corriger le grand livre, anonymiser un compte. En LIGNE
                    DE COMMANDE, jamais une route, et `app.js` ne le charge pas — une garde
                    textuelle le vérifie.
main.js             assemble les trois et écoute
schema.sql          users, matches, match_traces, ledger_entries, ledger_audit.
                    Aucune colonne « solde ».
test.js             255 tests sans rien installer, 264 avec jose
```

## Les règles ne sont pas recopiées

`api/core.js` charge le bloc `WBCore` **depuis `index.html`**, le même que le navigateur exécute, et
`api/sim.js` fait exactement pareil avec le bloc `WBSim` — même découpage par marqueurs, même
`new Function`, même garde bruyante au démarrage sur la liste des noms exportés. Il n'y a donc pas
deux simulations à réconcilier : il y a un bloc de texte que deux chargeurs évaluent, et un test le
montre en le chargeant **une seconde fois** à la façon du navigateur puis en comparant l'empreinte
d'une même trace rejouée des deux côtés.
Le pseudo est validé côté serveur par `sanitizeName()` et `validName()`, les mêmes fonctions qui
tournent dans le jeu, l'unicité s'appuie sur `nameKey()`, et la recherche de table sur `tierFor()` —
l'API ne refait pas le `TIERS.find` elle-même, sans quoi une table ajoutée au jeu s'afficherait au
lobby et se ferait refuser par le serveur.

La garde de chargement liste **tous** les noms qu'`app.js` appelle, pas seulement ceux de la phase
01 : `zonePlan`, `matchVerdict` ou `toCents` ne vivent que dans les gestionnaires, et une garde qui
ne les couvre pas déplace la panne du démarrage vers la première requête d'un joueur — exactement ce
qu'elle existe pour empêcher. Un test compare la liste au texte d'`app.js`.

C'est ce qui rendra la phase 02 possible sans réécriture : le jour où le serveur simulera les
parties, il aura déjà les vraies règles, avec les tests qui vont avec.

## L'identité : Crossmint

Crossmint fournit la connexion par email **et** le portefeuille. C'est ce qui a fait pencher la
balance : le portefeuille dont le joueur aura besoin en phase 04 naîtra du même compte que sa
session, sans second fournisseur à réconcilier.

Une clé d'API Crossmint n'est pas un secret opaque : elle porte, lisible par qui sait la lire, son
origine (`ck_` pour le jeu, `sk_` pour le serveur), son environnement, l'identifiant du projet, et
une signature ed25519 de Crossmint sur le tout. `crossmint-key.js` la lit **au démarrage** : une clé
tronquée, recopiée à moitié, ou d'un mauvais environnement fait échouer le lancement avec un message
qui dit quoi corriger — pas la première connexion d'un joueur, un dimanche soir.

De cette lecture sortent deux choses : l'identifiant du projet, et l'URL du trousseau public.

### Ce que chaque jeton doit prouver

| Contrôle | Pourquoi |
|---|---|
| signature contre le trousseau public de Crossmint | c'est bien Crossmint qui l'a émis |
| algorithme dans une liste fermée | interdit la confusion d'algorithme, et le `none` |
| expiration, 5 s de tolérance d'horloge | une session volée finit par mourir |
| `exp` **présent** | un jeton sans expiration est un jeton éternel |
| `aud` = notre identifiant de projet | il a été émis pour **nous** |
| `sub` présent et non vide | il désigne quelqu'un |

Le quatrième et le cinquième sont à nous, et le cinquième mérite un mot. J'ai lu le code de
`@crossmint/server-sdk` : `verifyCrossmintJwt` vérifie la signature et l'expiration, **et rien
d'autre**. Il ne regarde pas `aud`. Or `aud` porte l'identifiant du projet : sans ce contrôle, un
jeton émis pour n'importe quel autre projet Crossmint — signé par la même autorité, donc valide de
bout en bout — ouvrirait un compte chez nous. Le contrôle était à ajouter de toute façon.

### Pourquoi `jose` et pas le SDK du fournisseur

Puisqu'il fallait ajouter un contrôle par-dessus le SDK, restait à savoir ce que coûtait le SDK.
`@crossmint/server-sdk` tire `@crossmint/common-sdk-base`, qui tire `@solana/web3.js` et `viem` :
quelques centaines de paquets pour vérifier un jeton. Tout ça est du code qui s'exécutera un jour
sur le chemin de l'argent des joueurs.

`jose` est exactement la bibliothèque que le SDK utilise à l'intérieur. Elle n'a aucune dépendance,
elle est maintenue et largement auditée, et elle gère ce qu'on écrirait mal en le réécrivant : le
cache du trousseau, sa rotation, le refus de marteler le fournisseur. Le reste — les six lignes du
tableau ci-dessus — tient dans `identityFromClaims()`, qui ne demande ni réseau ni dépendance et que
les tests couvrent entièrement.

Nous sommes donc plus stricts que le SDK, avec deux cent cinquante paquets de moins.

Version 5 et pas 6 : la 6 est ESM seulement, et l'API est écrite en CommonJS.

## Trois choses que je ne peux pas faire à ta place

1. **Créer le projet Crossmint.** Tu obtiendras deux clés : `ck_…`, publique, qui ira dans le jeu,
   et `sk_…`, qui ne quitte jamais le serveur. Déclare aussi les origines autorisées dans la console
   Crossmint : ce sont celles du jeu, les mêmes que `APP_ORIGINS`.
2. **Créer la base Postgres**, puis appliquer `schema.sql` :
   `psql "$DATABASE_URL" -f api/schema.sql`
3. **Renseigner `api/.env`** à partir de `.env.example`.

Ne me colle jamais une clé secrète dans la conversation, et ne me demande pas d'aller la chercher :
je tourne dans un conteneur distant, je n'ai accès ni à ton Mac, ni à tes notes, ni à ton
gestionnaire de mots de passe — et si je l'avais, une clé recopiée dans une conversation serait à
considérer comme brûlée. Mets-la dans `api/.env` en local, et dans le magasin de secrets de
l'hébergeur en production.

Le serveur n'a pas besoin que je voie la clé pour la vérifier : au démarrage, il te dira lui-même
si elle est lisible, de quel environnement elle vient, et quel projet elle désigne.

## Lancer

```bash
cd api
npm install
cp .env.example .env      # puis remplir
psql "$DATABASE_URL" -f schema.sql
npm start
```

## Tests

```bash
node api/test.js          # 255 tests, aucune dépendance, aucune base
cd api && npm install && node test.js   # 264 : les 255, plus la chaîne complète de vérification

DATABASE_URL=postgres://… node api/db-check.js   # à part, et sort 0 sans DATABASE_URL
DATABASE_URL=postgres://… node api/operateur.js  # l'outil d'opération, hors de npm test aussi
```

La base, la vérification du jeton, la source de graines et l'horloge sont injectées dans
`createApp()`. Les tests les remplacent par des doublures, ce qui couvre sans rien installer
l'authentification, la validation, l'unicité du pseudo, la limitation de débit, le CORS, la lecture
des clés d'API, chaque refus de jeton, et tout le billet de partie — graines, idempotence,
expiration comprises. Une horloge injectée fait vieillir un billet sans attendre, et c'est elle qui
permet d'éprouver le verdict et le veilleur : un mensonge par test, chacun nommé d'après le
mensonge qu'il arrête. Les statistiques s'éprouvent de la même façon, et de la seule qui vaille :
en **jouant** des parties entières contre la doublure, du billet au règlement, puis en comparant ce
que `GET /api/me` rend à la somme des lignes.

Les neuf tests supplémentaires font tourner la vraie cryptographie : ils génèrent une paire de clés,
servent un trousseau public en local, et éprouvent ce qu'on ne peut pas demander à un fournisseur —
un jeton signé par la mauvaise clé, un jeton expiré, un jeton d'un autre projet, la clé publique
utilisée comme secret partagé, un jeton sans signature du tout. Aucun appel à Crossmint, aucun
secret. L'intégration continue lance le fichier deux fois, avant et après installation, pour que les
deux promesses tiennent.

Seuls `db-pg.js` et `auth-crossmint.js` touchent l'extérieur.

## Choix retenus, et pourquoi

**Node simple, pas de cadre applicatif.** Le serveur tourne sur n'importe quel hébergeur Node, et
`WBCore` y tourne déjà tel quel. On choisira l'hébergeur au déploiement, pas maintenant.

**La cryptographie est déléguée, les décisions ne le sont pas.** Signature, trousseau et rotation
sont l'affaire de `jose` ; ce qu'on accepte d'un jeton est écrit en clair dans
`identityFromClaims()`, sans réseau ni dépendance, et testé ligne à ligne. La règle qui vaut pour le
jeu vaut ici : ce qui décide doit être pur, et ce qui est pur doit être testé.

**L'identité, c'est `sub`, jamais l'email.** Un joueur change d'email, il ne change pas
d'identifiant. La colonne `auth_id` fait foi, `email` n'est qu'un champ d'affichage — c'est aussi
pourquoi un email absent du jeton n'empêche jamais de se connecter.

**La contrainte unique arbitre les pseudos, pas une vérification préalable.** Demander « ce pseudo
est-il libre ? » puis l'insérer laisse une fenêtre entre les deux, et deux joueurs rapides passent
tous les deux. La base tranche, le serveur traduit en `409`.

**Les statistiques sont en lecture seule pour le client** — et, depuis la phase 02a, pour le serveur
lui-même : personne ne les écrit, elles sont une somme. `PATCH /api/me` n'accepte que trois champs ;
tout le reste du corps est ignoré, y compris `stats` et `id`.

## Le côté jeu

L'écran de connexion est dans `index.html`, et le fichier est resté un seul fichier. L'interface de
Crossmint est un composant React, incompatible avec une page sans build ; leur connexion par code
email, elle, est une API HTTP ordinaire. On appelle donc les routes directement, avec la clé `ck_`
en en-tête :

```
POST …/session/sdk/auth/otps/send        { email }              → un état de session
POST …/session/sdk/auth/authenticate?…   code à six chiffres    → un secret à usage unique
POST …/session/sdk/auth/refresh          { refresh: <secret> }  → { jwt, refresh, user }
POST …/session/sdk/auth/logout           { refresh }
```

Le joueur saisit son adresse, reçoit un code, le saisit. Pas de React, pas de bundler, pas de
redirection. Le jeton se range dans le navigateur, se rafraîchit deux minutes avant d'expirer, et
reprend tout seul au rechargement suivant.

**Le jeu reste jouable sans compte.** C'est la promesse du fichier unique : on l'ouvre et on joue.
Se connecter ajoute un profil qui suit le joueur d'une machine à l'autre.

Les décisions de cet écran sont dans `WBCore`, avec leurs tests : ce que vaut une adresse, ce que
vaut un code, l'enchaînement des écrans, quand rafraîchir, ce qu'on montre quand ça rate. Le reste
n'est que DOM et réseau.

Une ligne reste à remplir, `ACCOUNT.api` dans `index.html` : l'adresse de ce serveur, le jour où il
tournera quelque part. Vide, la connexion fonctionne et le profil reste local.

### Le billet, côté jeu

Depuis la phase 02a, le jeu prend son billet et rend son rapport. Tout tient dans un module `Match`
d'une centaine de lignes, à côté d'`Auth`, et il ne décide de rien : l'enchaînement vient de
`WBCore.matchFlow`, la graine de `seedFor`, le billet utilisable de `ticketFor`, le rapport de
`reportFrom`. Trois points de contact seulement — le sas d'attente demande, le coup d'envoi choisit
la graine, la fin de partie rend le rapport.

**Ce qui compte ici est le chemin de secours, pas le chemin nominal.** Pas de compte, `ACCOUNT.api`
vide, serveur muet, réponse illisible, billet refusé, ou billet qui décrit une autre table : dans
tous ces cas le jeu tire sa graine lui-même et se comporte exactement comme avant la phase. Et le
sas d'attente ne regarde jamais le réseau pour lancer la partie — **un billet qui tarde ne retarde
jamais le coup d'envoi**, c'est son chronomètre qui tranche, et une réponse arrivée trop tard est
jetée au lieu de réveiller une partie déjà commencée.

Un cas que seul le branchement a fait apparaître : le serveur n'ouvre qu'un billet à la fois et rend
le billet déjà ouvert quelle que soit la table redemandée ensuite. Quitter le sas puis revenir sur
une autre table laisse donc en main un billet qui parle d'ailleurs. `WBCore.ticketFor` compare le
mode et la mise avant de s'en servir ; s'ils ne concordent pas, la partie se joue hors ligne et le
billet reste ouvert pour la table qu'il décrit.

**Les statistiques sont adoptées, jamais recopiées.** Le règlement rendu par la route ne porte aucune
statistique — il porte le verdict d'une partie. Le jeu redemande donc `GET /api/me` après un
règlement, et c'est `applyAccount` qui arbitre : centimes vers dollars, avatar inconnu conservé,
réponse tronquée sans effet sur le pseudo. Lire un règlement comme un compte remettrait les quatre
compteurs à zéro ; un test nommé porte ce piège.

### Le solde, côté jeu — deux économies sur le même écran (phase 03)

La phrase de la 02a — « le portefeuille reste dans le navigateur » — n'est plus vraie qu'à moitié, et
c'est le module 5 de la phase 03 qui l'a coupée en deux. **Il y a désormais deux économies, et
l'écran dit laquelle il montre.**

**Hors ligne, absolument rien n'a changé.** `wallet` est une variable du navigateur, le bandeau dit
« Demo wallet », le bouton « + reload demo credits » est là, et les quatre cas de repli nommés depuis
la 02a — pas de compte, `ACCOUNT.api` vide, serveur muet, réponse illisible — rendent une partie
**identique à celle d'hier, graine comprise**. Ils restent testés comme des cas normaux.

**En ligne, le solde est celui du grand livre.** Il arrive en **centimes entiers** dans
`balanceCents` et `quarantineCents`, et il ne redevient des dollars qu'**une fois**, dans
`WBCore.applyAccount`, exactement comme `best` — une garde textuelle interdit un second point de
conversion. Trois conséquences, chacune avec son test :

- **Le bouton de recharge disparaît.** Connecté, c'est littéralement une route de crédit gratuit
  servie par le client. Le geste est refusé en plus d'être caché : un bouton `hidden` reste cliquable
  depuis la console.
- **Ni la mise ni le gain ne touchent `wallet`.** Le débit a eu lieu côté serveur, à l'ouverture du
  billet ; le gain est écrit au règlement. Deux fonctions de trois lignes, `demoDebit` et
  `demoCredit`, sont les **seules** à muter le portefeuille, et elles ne font rien en ligne. Une
  garde textuelle interdit tout autre `wallet -=`, `wallet +=`, et toute écriture de `wallet` venue
  d'une réponse serveur en dehors d'`applyAccount`.
- **Un montant ABSENT n'est pas un montant NUL.** `applyAccount` rend `null` quand la réponse ne
  porte pas de solde, et le jeu ne l'écrit alors pas. C'est le piège nommé de la 02a — lire un
  règlement comme un compte — transposé à l'argent, où il coûte le portefeuille entier à l'écran. Le
  jeu ne lit jamais un solde dans une réponse de règlement ou de renoncement : il redemande
  `GET /api/me`.

**Le bouton QUITTER du sas dit ce que partir coûte.** Il appelle `WBCore.renonciationOuverte` avec le
chronomètre du **sas**, jamais avec une horloge lue sur place. Ce chronomètre part du clic, le
serveur ne date le billet qu'à réception de la requête : il est donc **en avance**, et l'écran ferme
la promesse un peu **avant** que le serveur ne la ferme. Il ne promet jamais un remboursement qui
sera refusé. Dans la fenêtre, quitter appelle `POST /api/match/:id/renounce` puis redemande
`GET /api/me` ; hors fenêtre, il ne réclame rien — le billet reste jouable, et le réclamer pour rien
coûterait au joueur la temporisation `renonce_recent`. Quitter pendant que la demande de billet est
encore **en vol** renonce au billet qui arrive : sinon personne ne le renoncerait, et la mise
resterait au séquestre jusqu'à l'expiration.

**Un refus NOMMÉ arrête le sas ; une panne SILENCIEUSE ne l'arrête pas.** C'est la nuance la plus
coûteuse de la phase, et elle corrige à moitié une règle de la 02a. Réseau coupé, serveur muet,
réponse illisible, 500, 429 : la partie part hors ligne comme avant — « un billet qui tarde ne
retarde jamais le coup d'envoi ». Mais `409 fonds`, `409 livre` et `409 renonce_recent` disent que le
serveur a **instruit** la demande et l'a rejetée : le sas s'arrête, un message paraît sous le bouton
de la table, aucune partie ne démarre, et le lobby n'est pas laissé mort — on peut retenter dans la
seconde. La liste des trois codes est **fermée**, elle vit dans `WBCore.REFUS_SAS`, et un test
d'`api/test.js` la confronte aux codes que l'API émet vraiment. Le test d'accessibilité d'une table
au lobby redevient ce qu'il est : une **indication**. C'est le `409 fonds` du serveur qui tranche.

**Ce qui n'a pas pu être vérifié.** Le format exact des échanges avec Crossmint vient de la lecture
de leur SDK, pas d'un appel réel : le conteneur où ce code a été écrit n'a pas accès à leur domaine.
La première vraie connexion est donc le moment de vérité. Si une réponse ne ressemble pas à ce qui
est écrit ici, tout est au même endroit — `Auth` dans `index.html`, quatre fonctions d'une ligne.

## Limites connues, à traiter avant la production

- **AUCUN EURO N'ENTRE AU BOUT DE CETTE PHASE.** Le rejeu rend le vol de *temps* impossible ; le vol
  de *précision* reste entier. La phase 02 est faite, elle n'ouvre aucune table en argent réel, et
  rien de ce qui suit ne doit se lire comme le contraire.
- **UN REJEU N'EST OPPOSABLE QUE SUR LE MÊME RUNTIME.** `Math.sin`, `Math.cos`, `Math.atan2`,
  `Math.hypot` et `Math.pow` sont partout dans le mouvement, la visée et le gaz, et ECMAScript les
  laisse « implementation-approximated ». Ce que les tests prouvent : l'égalité entre **deux
  processus Node**. Ce qu'ils ne prouvent pas, et ce que la spécification se garde de promettre :
  l'égalité entre deux **moteurs**. C'est la raison d'être de `digest_match` : on mesure la
  divergence, on ne la punit pas, et le grand livre ne lira que ce qui a convergé.
- **Les lignes de la 02a — faits DÉCLARÉS par le client — ne seront JAMAIS lues par le grand livre
  de la phase 03.** Borner n'est pas vérifier. Depuis la 02b, les lignes neuves portent des faits
  **rejoués** et `digest_match` dit lesquelles ont convergé ; il faudra quand même une frontière
  explicite entre l'avant et l'après — une date de bascule, ou le simple fait que `trace_steps` soit
  `NULL` sur les anciennes — et non un `select` sur `matches` qui ramasserait tout. Sans cette phrase
  écrite noir sur blanc, on paiera un jour des chiffres que personne n'a contrôlés.
- **La limitation de débit est en mémoire, et elle couvre désormais DES ROUTES QUI ÉCRIVENT EN
  BASE.** Elle freine un joueur sur une instance ; dès qu'il y en aura deux, chaque instance aura
  son propre compteur et la limite vaudra le double, puis le triple. C'était déjà vrai en phase 01,
  où le pire cas était un pseudo martelé ; depuis `POST /api/match` le pire cas est une table
  `matches` remplie par quelqu'un qui répartit ses appels, et depuis `POST /api/match/:id/result`
  c'est en plus un règlement écrit sur chacune. Elle doit passer en magasin partagé avant la
  production. Les seaux sont séparés par route : renommer son personnage ne consomme pas le droit de
  demander une partie, et l'inverse non plus. **`GET /api/me` a désormais le sien, PARCE QU'ELLE
  ÉCRIT** : cette énumération l'omettait, et c'est ce qui en faisait le meilleur levier d'épuisement
  du bassin. Elle ne coûte au client qu'un GET sans corps, mais depuis la phase 03 `findOrCreate`
  ouvre une transaction d'écriture — verrou `for update` sur la ligne `users`, deux soldes et trois
  agrégats, du `begin` au `commit` — et retient tout ce temps un client du bassin de dix connexions.
  Un seul onglet qui la martelait pouvait mettre en file le `POST .../renounce` d'un **autre** joueur
  au-delà de sa fenêtre de dix secondes : sa mise restait au séquestre. **Un SECOND état vit
  désormais en mémoire du processus, et c'est le fusible global de la phase 04a.** Même famille, même
  limite : perdu au redémarrage, non partagé entre instances, donc un déploiement à deux processus
  **double de fait le fusible**. C'est un choix, pas un oubli — le lire sous le verrou d'ouverture
  d'un billet ferait très exactement la panne décrite au paragraphe précédent, en pire. Son seau est **séparé** et
  plus large (soixante par minute contre douze), parce que le jeu la lit à la connexion, à la reprise
  de session, après chaque renoncement et après chaque règlement. Deux dettes restent, et elles sont
  hors de ce correctif : le seau est en mémoire, donc il ne borne un martèlement que **par instance**,
  et `connectionTimeoutMillis: 5_000` fait qu'un bassin saturé plus de cinq secondes rend un 500 avant
  même le contrôle de fenêtre. Le jeu, lui, n'a aucune reprise sur un renoncement perdu — il le **dit**
  désormais au joueur, il ne le rejoue pas.
- **Aucune base n'a jamais tourné.** L'index unique partiel sur les billets ouverts, la contrainte
  `name_key`, le comportement de `insert … on conflict do nothing`, la clause `where status =
  'open' and net_cents is null` qui arbitre l'unicité du règlement et, depuis la phase 02b, la clé
  primaire `(match_id, seq)` qui arbitre le premier-écrit-gagne de `match_traces` n'ont été éprouvés
  que contre la doublure de `api/test.js`, qui imite les contraintes au lieu de les subir. Si Postgres se
  comporte autrement, rien ne le signalera avant le premier déploiement. C'est la dette la plus
  silencieuse du dossier, et elle grandit : cette phase ajoute cinq colonnes et une table dont un
  **paiement** dépend. **Faire tourner une vraie Postgres au moins une fois — ne serait-ce qu'à la
  main, `psql -f schema.sql` puis une partie de bout en bout — est désormais un PRÉREQUIS de la
  phase 03**, et c'est écrit comme tel ici et dans `docs/PHASE-02B.md`.
  *Où en est cette dette au module 3 de la phase 03* : inchangée, et elle porte désormais un
  **verrou de ligne** dont dépend le fait qu'un joueur ne puisse pas dépenser deux fois le même
  solde. C'est la seule propriété du module 3 que `npm test` ne peut structurellement pas éprouver.
  *Où en était-elle au module 2* : elle a une **recette** —
  `api/db-check.js`, qui applique le schéma à une vraie base et éprouve nommément chacune de ces
  contraintes, plus le job `db` de `.github/workflows/test.yml` qui le lance sur un service
  `postgres:16`. **Ce job n'a jamais été vert**, et la machine où le module a été écrit n'avait ni
  Postgres ni Docker : le script n'a donc **jamais tourné contre une base**. Livrer un script n'est
  pas l'avoir lancé, et la dette n'est pas soldée — elle est outillée.
- **Un déploiement se DRAINE, il n'écrase pas les billets ouverts** — au plus une quinzaine de
  minutes, la durée de vie d'un billet. Ce n'est pas de l'architecture, c'est une décision
  d'exploitation, à ranger à côté de « la maison est la contrepartie de chaque pot ». Ce qui arrive
  quand on ne la prend pas est visible : le rejeu refuse en `sim_version`, la ligne part au veilleur,
  et le joueur ne voit jamais sa partie enregistrée.
- **L'AIMBOT SURVIT ENTIER, ET L'ESP DEVIENT STRUCTUREL.** La trace porte une direction de visée par
  pas, et une visée parfaite ne se distingue pas d'un très bon joueur : le rejeu rend le vol de
  *temps* impossible, il ne touche pas au vol de *précision*. Pire, dans une architecture de rejeu le
  client doit posséder tout ce qu'il dessine — il dessine les caisses, donc il connaît le contenu de
  tout le butin de la carte dès la première seconde. Ce n'est pas un oubli, c'est le prix de
  l'architecture, et il est payé les yeux ouverts : avec des adversaires tous robots, la seule
  victime en est la maison, à chaque partie. **À ne jamais diluer.**
- **`match_traces` a désormais une politique de conservation, mais PAS de règle d'accès.**
  `TRACE_RETENTION_JOURS` dit combien de temps on garde la pièce qui prouve une partie ; **qui a le
  droit de la relire** n'est écrit nulle part, et il n'existe ni journal d'audit ni rôle
  d'administration. À nommer avant la phase 04, avec la contre-passation. La rétention elle-même est
  conservatrice par défaut et **n'est pas une décision juridique** : la vraie fenêtre de contestation
  est une affaire de phase 06, et la constante devra être relue à ce moment-là.
- **LE PREMIER `delete` DU DÉPÔT SUR LA PIÈCE QUI PROUVE UN PAIEMENT EXISTE MAINTENANT.** Il est
  borné par quatre conditions, chacune éprouvée en la retirant seule, et la garde qui interdisait
  tout `delete from match_traces` a donc été **affaiblie sciemment** — c'est écrit ici, dans le
  message de commit et dans le test lui-même. Ce que personne n'a encore vu : ce que Postgres fait de
  cette clause-là. Elle croise trois tables et recalcule un solde de séquestre en SQL, et
  `api/db-check.js` n'a jamais tourné.
- **La fenêtre de renoncement fait payer sa mise au joueur honnête dont l'onglet meurt à la onzième
  seconde.** C'est le prix de la fermeture du vol « jouer, perdre, ne rien envoyer, laisser expirer,
  se faire rembourser ». Le chemin de correction existe depuis le module 5 de la phase 04a — la
  contre-passation, par `api/operateur.js` — mais rien dans l'API ne l'expose, et c'est délibéré :
  rendre sa mise à un joueur honnête reste un geste d'opérateur, un compte à la fois, avec sa raison
  écrite.
- **La temporisation `renonce_recent` n'est pas atomique.** Elle lit le dernier billet renoncé puis
  ouvre le nouveau : deux requêtes simultanées peuvent la franchir toutes les deux. L'index partiel
  « un seul billet ouvert » les rattrape — le pire cas reste un billet — mais la propriété n'est pas
  tenue par une contrainte, et elle est donc à relire le jour où les adversaires seront humains.
- ~~**Personne n'est habilité à contre-passer.**~~ **Fermé par le module 5 de la phase 04a :**
  `api/operateur.js` est l'appelant, en ligne de commande et jamais en HTTP, et `ledger_audit` est le
  journal qui partage la transaction de l'écriture. Ce qui reste derrière, et qui n'est pas la même
  chose : **le dimanche soir existe toujours**, mais il se passe désormais dans un outil dont chaque
  geste laisse une raison écrite, et non dans `psql`.
- **Le journal d'audit existe, et il ne trace que DEUX gestes.** `ledger_audit` porte la
  contre-passation et l'anonymisation. **Un changement de pseudo n'y est toujours pas tracé**, et il
  devra l'être avant que des comptes ne vaillent de l'argent : `PATCH /api/me` écrit `name` et
  `name_key` sans rien consigner. Ce n'est pas un oubli du module 6 — c'est une route du client, donc
  un geste fréquent, donc une décision de volume et de rétention que rien n'a encore prise.
- **La suppression de compte est REFUSÉE, et le geste disponible est l'anonymisation.** Les deux
  cascades du schéma sont en `restrict` depuis le module 6 de la phase 04a : un `delete from users`
  échoue tant qu'un billet référence la ligne, parce que ce billet est la pièce justificative d'un
  mouvement d'argent qui, lui, reste. Ce qui reste ouvert derrière : **ce que la juridiction retenue
  impose de conserver malgré une demande de suppression**, et la **route** qui portera cette demande —
  avec elle viendra l'empreinte d'`auth_id` en table d'insertion seule, sans quoi un compte anonymisé
  qui se reconnecte se fait doter une seconde fois (voir « Le trou qui reste, nommé et chiffré »).
- **Le portefeuille n'existe pas encore.** Crossmint sait en créer un à l'inscription, mais rien ne
  doit être branché avant la phase 03 : tant que le grand livre n'existe pas, un solde n'aurait nulle
  part où être écrit correctement.
- **Les conditions de garde restent à lire.** Qui détient les clés, ce que Crossmint peut geler, ce
  qui se passe si le compte du projet est suspendu — à trancher avec la juridiction retenue, avant
  qu'un euro n'entre.
