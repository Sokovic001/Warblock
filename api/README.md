# API Warblock — comptes et profils (phase 01), billet de partie (phase 02a), rejeu de partie (phase 02b), grand livre (phase 03, en cours)

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
| `GET /api/me` | Rend le profil du joueur connecté, **statistiques agrégées** comprises. La première connexion crée le compte. |
| `PATCH /api/me` | Change le pseudo, l'avatar ou le pays. Rien d'autre n'est modifiable. |
| `POST /api/match` | Émet le **billet** d'une partie : graines, mise en centimes, sièges, version de simulation, expiration. |
| `POST /api/match/:id/trace` | Reçoit la **trace des entrées du joueur**, en segments, en insertion seule. |
| `POST /api/match/:id/result` | **Rejoue la partie**, recalcule les faits, juge, et **clôt** la ligne. |

Tout le reste répond 404. Toutes exigent un jeton de session valide, sauf `/api/health`.

## `POST /api/match` — le billet d'une partie

Le serveur possède l'identité de la partie ; le client ne fait que la demander. Il choisit sa table,
son mode et son brawler, **et rien d'autre**.

```
POST /api/match      { mode, stake, brawler, clientKey }
→ 200                { id, mode, stakeCents, seats, teamSize, brawler, seed, status, openedAt, expiresAt }
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
plan de zone, une durée que son propre chronomètre n'a pas eu le temps de contenir, une victoire
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
**eux seuls** : sa clause porte `status = 'open'` et l'expiration, il n'écrit aucun montant, et il
prend son heure du même endroit que le reste du routeur. `main.js` l'appelle chaque minute. C'est
du code qui manipulera de l'argent et que personne ne regarde tourner : il se teste comme le
reste, horloge injectée, sans attendre.

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

**Le découvert est une règle uniforme**, et deux comptes seulement en sont exemptés :
`COMPTES_EMETTEURS` = `maison:dotation` et `maison:contrepartie`, dont le solde négatif **est** la
mesure qu'on cherche. Les séquestres n'en font pas partie, et c'est tout l'intérêt : un second gain
sur un même billet devrait débiter un séquestre déjà vide, donc « un billet a au plus un gain » ne
repose pas uniquement sur un index.

**`ledgerReconcile(ligneMatch, transferts)`** rend une liste de griefs — vide quand tout s'apparie. Le
zéro global ne dit rien de l'appariement : il reste vrai quand un montant **juste** est posé sur le
**mauvais** compte. Elle attrape exactement cela, plus le billet sans engagement, l'engagement sans
billet et le séquestre non vidé sur une ligne close. Elle accepte une ligne ou une liste de lignes ;
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

Deux index de lecture, `(compte_debit)` et `(compte_credit)` : le solde est une **somme** sur ces
lignes, et c'est cette somme qui remplace la case qu'on ne crée pas. L'échappatoire nommée, le jour
où elle coûtera trop cher, est l'instantané de clôture — jamais une colonne mise à jour.

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
- Ce qu'il éprouve, nommément : `name_key` ; l'index **partiel** « un seul billet ouvert », et la
  place qui se libère au billet clos ; `on conflict do nothing` sur `(match_id, seq)` ; la clause
  `where status = 'open' and net_cents is null` ; la clé du grand livre, **refusée et non avalée** ;
  la grammaire des comptes, les comptes distincts, le montant strictement positif, la liste fermée
  des motifs ; les largeurs `integer` (un entier « valide » à 3 000 000 000 lève bien `22003`) ; la
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
ledger.js           le grand livre : grammaire, motifs, mouvements. PUR, aucune dépendance.
crossmint-key.js    lit une clé d'API Crossmint et vérifie sa signature — sans dépendance
auth-crossmint.js   vérifie les jetons de session                  ← touche le réseau
db-pg.js            Postgres                                       ← touche la base
db-check.js         éprouve le schéma contre une VRAIE Postgres    ← hors de npm test
main.js             assemble les trois et écoute
schema.sql          users, matches, match_traces, ledger_entries. Aucune colonne « solde ».
test.js             164 tests sans rien installer, 173 avec jose
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
node api/test.js          # 164 tests, aucune dépendance, aucune base
cd api && npm install && node test.js   # 173 : les 164, plus la chaîne complète de vérification

DATABASE_URL=postgres://… node api/db-check.js   # à part, et sort 0 sans DATABASE_URL
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

**Le portefeuille de démonstration reste dans le navigateur.** La phase 02a enregistre des parties,
pas de l'argent : aucun solde ne part au serveur, aucun n'en revient, et `wallet` est toujours une
variable modifiable depuis la console. C'est la phase 03 qui changera cela, pas celle-ci.

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
  demander une partie, et l'inverse non plus.
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
  *Où en est cette dette au module 2 de la phase 03* : elle a maintenant une **recette** —
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
- **`match_traces` n'a AUCUNE politique de conservation.** Combien de temps garde-t-on la pièce qui
  prouve une partie, et qui a le droit de la relire : renvoyé à la phase 03.
- **Pas encore de journal d'audit.** Chaque changement de pseudo devra être tracé avant que des
  comptes ne valent de l'argent.
- **Pas de suppression de compte.** À ajouter, avec ce que la juridiction retenue impose de
  conserver malgré la suppression.
- **Le portefeuille n'existe pas encore.** Crossmint sait en créer un à l'inscription, mais rien ne
  doit être branché avant la phase 03 : tant que le grand livre n'existe pas, un solde n'aurait nulle
  part où être écrit correctement.
- **Les conditions de garde restent à lire.** Qui détient les clés, ce que Crossmint peut geler, ce
  qui se passe si le compte du projet est suspendu — à trancher avec la juridiction retenue, avant
  qu'un euro n'entre.
