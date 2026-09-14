# Phase 03 — le grand livre en partie double, éprouvé en crédits fictifs

Le solde cesse d'être une variable du navigateur, et il ne devient pas pour autant une colonne. Il
est la **somme d'écritures immuables en centimes entiers**, et il n'existe nulle part de case à
écraser. C'est la phrase que `api/schema.sql`, `api/README.md` et `docs/HISTORIQUE.md` répètent
depuis trois phases ; cette phase-ci l'exécute.

**Aucun euro n'entre.** Les comptes sont en crédits fictifs, dotés par la maison, et rien de ce qui
suit ne doit se lire comme le contraire. Ce que la phase change, c'est **qui** décide du solde : le
serveur, sur des lignes qu'on ne modifie jamais, au lieu d'une variable JavaScript que la console
du navigateur réécrit en un mot.

---

## D'abord, ce que les phases précédentes ont laissé sur la table

Quatre dettes sont explicitement renvoyées ici, par écrit, dans trois documents. Cette phase les
prend toutes les quatre, et deux d'entre elles ne sont pas des détails de confort.

1. **Aucune base n'a jamais tourné.** `name_key`, l'index partiel « un seul billet ouvert »,
   `on conflict do nothing` sur `(match_id, seq)` et la clause `where status = 'open' and net_cents
   is null` n'ont été éprouvés que contre la doublure de `api/test.js`, qui **imite** les contraintes
   au lieu de les subir. « Un test qui passe contre la doublure prouve la doublure » est écrit trois
   fois dans le dossier, et c'est devenu un **prérequis de cette phase**. Elle ajoute deux
   contraintes de plus, dont un paiement dépend.
2. **`match_traces` n'a aucune politique de conservation.** Combien de temps garde-t-on la pièce qui
   prouve une partie, et qui a le droit de la relire : renvoyé ici.
3. **La maison est la contrepartie de chaque pot.** Décision d'exploitation à trancher avant la
   phase 04. Cette phase ne la tranche pas ; elle la **mesure**, pour la première fois, partie par
   partie.
4. **Le rendement du filtre de divergence est inconnu en argent.** `stats.divergences` compte des
   lignes. Le grand livre doit le compter en **centimes**, sans quoi la phase 06 héritera d'un
   filtre dont personne ne connaît le prix.

Et une dette qui n'est renvoyée nulle part mais qui pèse ici plus qu'ailleurs : **la session de jeu
réelle due depuis le module 1 de la phase 02b n'a toujours pas eu lieu.** Cette phase fait
apparaître **deux économies sur le même écran** — le portefeuille de démonstration hors ligne, le
solde du serveur en ligne — et `node test.js` ne peut structurellement pas voir un bug d'écran.

---

## Ce que la phase fait

- **Une table `ledger_entries`, en insertion seule, en LIGNES-TRANSFERT.** Une ligne porte un
  montant strictement positif, un compte débité et un compte crédité, différents l'un de l'autre.
  La partie double devient **structurelle** — une contrainte de colonne — au lieu d'être assertée
  en JavaScript avant l'insertion.
- **Un fichier `api/ledger.js`** qui détient la grammaire des comptes, la liste fermée des motifs,
  et une fonction pure par mouvement. L'API ne fait que persister ce que ce fichier a construit,
  et les montants continuent de sortir de `WBCore.cashoutCents`.
- **Un compte de SÉQUESTRE par partie, `enjeu:<match_id>`.** La mise y va à l'ouverture du billet ;
  le règlement le vide vers la commission, le joueur et la contrepartie de la maison.
- **La mise est débitée à l'OUVERTURE du billet**, dans la même transaction que l'insertion du
  billet, sous un verrou de ligne. Pas de billet sans son écriture, pas d'écriture sans son billet.
- **Le règlement crédite une fois**, et le gain d'une ligne dont le rejeu a **divergé** va sur un
  compte de **quarantaine** : mesuré, jamais refusé, jamais dépensable.
- **Une fenêtre de renoncement**, bornée par l'horloge du serveur et calée sur le **coup d'envoi le
  plus précoce possible**, pas sur la fin du sas. Passé cette fenêtre, plus rien ne rend la mise.
- **Une dotation à la création du compte et une recharge périodique**, toutes deux écrites par le
  serveur, idempotentes, sans aucune route que le client puisse appeler.
- **`api/db-check.js`** : un script à part qui applique le schéma à une **vraie Postgres** et
  éprouve contre elle les contraintes que la doublure se contente d'imiter, transactions
  **concurrentes** comprises. Plus le job d'intégration continue qui le lance.
- **Une politique de conservation pour `match_traces`**, avec sa constante, sa raison écrite, et une
  purge à quatre conditions.
- **Le jeu lit son solde du serveur** quand il est connecté, et le bouton de recharge disparaît.
  Hors ligne, absolument rien ne change.

## Ce que la phase ne fait pas

- **Les dépôts et les retraits, et le portefeuille Crossmint** : phases 04 et 05. Cette phase
  n'ouvre aucune entrée ni aucune sortie d'argent réel.
- **Le seuil sur `ecart_cents`, et le sort de la quarantaine** : phase 06. Cette phase produit les
  deux données qui les fixeront — des écarts observés, et un **rendement de quarantaine en
  centimes** — elle ne fixe ni l'un ni l'autre. Elle n'ajoute pas non plus de motif de libération :
  un membre de liste fermée que personne n'écrit est une case en attente d'être créée de travers.
  Ce que la phase 06 paiera pour l'ajouter est écrit à la fin de ce document.
- **La décision d'exploitation « la maison est la contrepartie de chaque pot ».** Cette phase la
  MESURE sur `maison:contrepartie`. Les trois issues de `docs/HISTORIQUE.md` ne bougent pas.
- **La chaîne de hachage des écritures**, et tout ce qui protège le livre contre quelqu'un qui a la
  main sur la base. Le modèle de menace de cette phase est le **client** : il contrôle son
  navigateur, pas le serveur. Ajouter une chaîne aujourd'hui coûterait un mécanisme de plus contre
  une menace qui n'est pas celle du jour ; le dire est plus utile que le faire à moitié.
- **Le journal d'audit et les rôles d'administration.** Une contre-passation est le seul chemin de
  correction, et personne n'a encore écrit qui a le droit de l'emprunter. À nommer avant la phase
  04, avec la suppression de compte et le changement de pseudo tracés.
- **Le magasin partagé pour la limitation de débit.** Elle est en mémoire, elle protège désormais
  des routes qui écrivent de l'argent, et deux instances valent deux compteurs. Limite écrite depuis
  la phase 01, plus chère ici, et ce n'est pas le bon endroit pour la résoudre.
- **L'anti-triche de précision.** L'aimbot survit entier, l'ESP est structurel. Cette phase rend le
  **solde** inviolable ; elle ne rend pas la **partie** honnête. Confondre les deux serait l'erreur
  la plus coûteuse du dossier.
- **Les instantanés de solde.** L'échappatoire de performance est nommée pour ne pas être inventée
  dans l'urgence : un instantané est une case, donc il ne s'écrit qu'avec la règle qui permet de le
  refaire à l'identique.
- **Le lobby mobile et l'icône définitive.** Rien à voir, et le lobby mobile ne se relance pas sans
  maquette validée d'abord.

---

## Les décisions, et pourquoi

### Le solde est une SOMME, jamais une colonne

C'est la règle écrite dans `schema.sql`, `api/README.md` et `docs/HISTORIQUE.md` depuis trois
phases : « un compteur qu'on incrémente est une case qu'on écrase, et un double envoi la fausse pour
toujours ». Le revirement de `user_stats` en 02a a servi de répétition générale sur des chiffres qui
ne valaient rien ; ici les chiffres valent quelque chose. **Une somme fausse se refait, une case
fausse ne se répare pas.**

Écarté : une colonne `balance_cents` mise à jour dans la même transaction que l'écriture. C'est plus
rapide à lire, et c'est exactement la case que trois documents interdisent. Écarté aussi le
compromis « colonne + écritures » : deux vérités qui finiront par différer, et personne ne saura
laquelle croire.

Ce que ça coûte, et qui est assumé : la somme est sur le chemin d'une requête que le joueur attend.
Voir les risques.

### La LIGNE-TRANSFERT : la partie double est structurelle, pas assertée

Une écriture n'est pas une jambe signée, c'est un **transfert** :

```
montant_cents  integer  not null check (montant_cents > 0)
compte_debit   text     not null   -- d'où l'argent part
compte_credit  text     not null   -- où il arrive
check (compte_debit <> compte_credit)
```

Un mouvement est un **ensemble de transferts partageant `(motif, reference)`**. La somme globale du
livre, tous comptes confondus, est alors nulle **par construction** : chaque ligne pose exactement
`+m` quelque part et `−m` ailleurs. Il n'y a rien à asserter.

C'est la correction du défaut que les deux autres conceptions partageaient sans le dire. Appeler
`equilibre(ecritures)` en JavaScript avant l'insertion protège **le chemin qui l'appelle**, et le
jour où quelqu'un ajoutera un second chemin d'écriture, le livre deviendra faux en silence. Une
contrainte suit la donnée ; une fonction suit le code. C'est le même raisonnement que
`(motif, reference)` ci-dessous, et que la clé primaire de `match_traces`.

La greffe a un coût qu'il faut nommer, parce que c'est là qu'une erreur se cacherait : **la
direction du reliquat doit être décidée dans la fonction pure**, pas au point d'insertion. Un
règlement où le brut dépasse la mise se décompose en `contrepartie → enjeu` du reliquat, puis
`enjeu → commission` et `enjeu → joueur` ; un règlement où le brut est inférieur à la mise se
décompose dans l'autre sens, avec `enjeu → contrepartie` en dernier. Une jambe de montant nul
n'est pas représentable, donc elle est **omise** : un brut nul ne produit qu'un seul transfert,
`enjeu → contrepartie` de toute la mise.

### Le plan de comptes est une GRAMMAIRE, pas une liste fermée

Trois des six comptes sont des **familles paramétrées**, et l'écrire « liste fermée » aurait produit
un `check (compte in (...))` que Postgres refuse au premier joueur.

| Compte | Ce qu'il porte |
|---|---|
| `joueur:<user_id>:disponible` | le solde dépensable, celui que `GET /api/me` rend |
| `joueur:<user_id>:quarantaine` | ce qui vient d'une ligne divergente : visible, chiffré, jamais dépensable |
| `enjeu:<match_id>` | le séquestre d'une partie : la mise pendant qu'elle est jouée |
| `maison:dotation` | le compte d'émission des crédits fictifs |
| `maison:commission` | les 20 % de tout paiement |
| `maison:contrepartie` | ce que la maison paie parce que dix-neuf adversaires ne misent rien |

La validation est donc une **expression**, exportée par `api/ledger.js`, et la contrainte de colonne
est **la même expression, caractère pour caractère**. Un test la compare au texte de `schema.sql` :
ce qu'il compare n'est pas une énumération, c'est une grammaire, et c'est pour cela qu'il peut être
exact. Une liste qui diverge du code est le patron du `respawn()` défini deux fois.

Les **motifs**, eux, sont une vraie liste fermée et énumérable : `dotation`, `recharge`, `mise`,
`gain`, `remboursement`, `contrepassation`. Six. Un motif hors liste **lance** dans `ledger.js` et
est refusé par la contrainte en base.

### Le découvert est une règle uniforme, et deux comptes seulement en sont exemptés

**Aucun compte ne passe en négatif**, sauf `maison:dotation` et `maison:contrepartie`, qui sont un
compte d'émission et un compte de contrepartie : leur solde négatif **est** la mesure qu'on cherche.
La règle est vérifiée pour chaque compte débité, dans la transaction, après un verrou.

Cette uniformité vaut mieux qu'un contrôle spécial sur le compte du joueur, parce qu'elle referme
gratuitement un trou qu'une clé d'idempotence ne peut pas fermer seule : **un second gain sur un
même billet devrait débiter un séquestre déjà vide, et se fait donc refuser**. L'invariant « un
billet a au plus un gain » ne repose alors pas uniquement sur un index.

### Le verrou porte sur une ligne qui EXISTE

Il n'y a pas de table des comptes — c'est tout l'intérêt. On ne peut donc pas verrouiller « la ligne
du compte ». Le verrou porte sur la seule ligne qui existe par joueur et par partie :

- avant tout débit d'un compte `joueur:<id>:*` — `select id from users where id = $1 for update` ;
- avant tout débit d'un séquestre — `select id from matches where id = $1 for update`.

Pris **en tête de transaction, avant que la somme ne soit calculée**. C'est la seule primitive qui
sérialise sans inventer de case : deux onglets qui ouvrent un billet en même temps lisent tous deux
un solde de 50 et débitent tous deux 50, et aucun `check` de colonne ne peut voir une somme d'autres
lignes.

Écarté : laisser Postgres refuser sur une contrainte et traduire l'exception — il n'existe aucune
contrainte déclarative qui exprime « la somme des lignes de ce compte reste positive », et l'écrire
en déclencheur ferait entrer un mécanisme que ce dépôt n'a nulle part. Écarté aussi le verrou
consultatif applicatif : il ne survit pas à deux instances.

Le refus est un **`409` nommé `fonds`**, qui n'écrit ni billet ni écriture. Pas un `402` : `CLAUDE.md`
et `api/README.md` documentent huit refus nommés, « tous en 400 ou 409, aucun en 500 », et un `402`
ouvrirait une neuvième famille pour rien — il parle par ailleurs de payer l'API, pas la table.

*Ajout du module 3 : il y a un DIXIÈME refus, et il n'était pas nommé ici.* L'écrivain du grand livre
n'a volontairement aucun `on conflict do nothing` — un doublon veut dire qu'on paie deux fois, donc
l'appelant doit l'apprendre — et le module 2 a explicitement renvoyé au module 3 la traduction de ce
`23505`. Laisser remonter l'exception aurait fait un 500 sur la route de l'argent, c'est-à-dire
exactement ce que ce document interdit trois fois. Le refus s'appelle donc **`livre`**, il est en
`409` comme les autres, il couvre aussi le découvert refusé, et il garantit la même chose que
`fonds` : la transaction est annulée en entier, rien n'a été écrit, et la ligne repart dans l'état
où elle était.

Et la leçon du `22003` vaut ici plus qu'ailleurs : un joueur n'a qu'un billet ouvert à la fois, donc
un 500 qui laisse une ligne à demi écrite l'enferme jusqu'à l'expiration, mise débitée.

### Le grand livre vit dans `api/ledger.js`, pas dans `WBCore`

C'est un arbitrage, et il mérite ses deux côtés.

Pour `WBCore` : la règle du dépôt dit « toute logique de règle va dans `WBCore` avec un test dans
`test.js` », et le précédent existe — `matchVerdict`, `checkReport` et `PG_INT4_MAX` y vivent déjà
et ne servent qu'au serveur.

Contre, et c'est ce qui l'emporte : ces trois-là jugent **une partie**, avec les constantes du jeu —
modes, sièges, vies, plan de zone. Le plan de comptes n'est pas une règle du jeu. Rien dans le jeu
ne sait ce qu'est `maison:contrepartie`, et rien dans le navigateur n'exécutera jamais une ligne de
comptabilité. `index.html` fait 465 Ko et il est téléchargé par chaque joueur ; `api/core.js` existe
pour empêcher l'API de **recopier une règle du jeu**, pas pour faire du fichier unique le domicile
de la comptabilité. La garde textuelle qui interdit `RAKE`, `0.2`, `Math.ceil`, `/ 100` et `toFixed`
est en plus infiniment plus sûre sur un fichier dédié que sur une plage de marqueurs dans un fichier
de six mille lignes.

Ce qui reste dans `WBCore`, et pour une raison précise : **`renonciationOuverte(billet, maintenant)`
et la constante de sa fenêtre**, parce qu'elles sont réellement partagées avec le sas d'attente —
l'écran doit dire au joueur ce que partir va lui coûter, et le serveur doit l'arbitrer. Deux
définitions de cette fenêtre seraient la troisième copie du patron déjà condamné pour `terminal`,
`faits` et `argentCents`. Elle est donc dans `WBCore`, avec ses tests dans `test.js`, et
`api/core.js` l'ajoute à sa liste `ATTENDUS` — faute de quoi le serveur casse au démarrage, ce
qu'un test d'`api/test.js` vérifie déjà en comparant la liste au texte d'`app.js`.

Les montants, eux, ne bougent pas : ils sortent de `WBCore.cashoutCents`, et de nulle part ailleurs.
`api/ledger.js` reçoit `{ grossCents, feeCents, netCents }` et n'a pas le droit de les recalculer.

### Un séquestre par partie, et ce qu'il mesure

L'arithmétique boucle par construction, puisque `fee + net = brut` :

```
mise         :  joueur:<id>:disponible  →  enjeu:<match>            (mise)
règlement    :  maison:contrepartie     →  enjeu:<match>            (brut − mise, si positif)
                enjeu:<match>           →  maison:commission        (fee)
                enjeu:<match>           →  joueur:<id>:disponible   (net)
                enjeu:<match>           →  maison:contrepartie      (mise − brut, si positif)
```

Le joueur qui perd fait entrer sa mise dans `maison:contrepartie`. Le joueur qui rafle la table lui
fait payer toutes les autres. C'est la seule façon d'obtenir un invariant **fort et local** —
`solde(enjeu:<match>) = mise` sur une ligne ouverte, `0` sur toute ligne close — et c'est surtout
l'instrument qui **mesure** la décision d'exploitation que `docs/HISTORIQUE.md` exige de trancher
avant la phase 04. Elle cesse d'être une note dans un journal, elle devient un solde qu'on lit.

Écarté : créditer le gagnant directement depuis un compte maison, sans séquestre. Le livre boucle
quand même, mais rien ne dit plus, partie par partie, ce que le pot a coûté. Écarté aussi le
séquestre unique et global : il boucle, il ne prouve rien sur une partie donnée.

Le chiffre que cet instrument va faire apparaître est **beaucoup plus gros qu'il n'y paraît**, et il
faut l'écrire avant qu'il ne surprenne quelqu'un — voir les risques.

### La mise est débitée à l'OUVERTURE, et `createMatch` devient une vraie transaction

Le voleur : si le débit arrive au coup d'envoi, il suffit de ne jamais l'annoncer pour jouer
gratuitement ; s'il arrive à la fin, par compensation du net, il suffit de ne jamais rendre de
résultat. **Le seul instant que le serveur observe sans dépendre du client est celui où il émet le
billet.** Le débit y est atomique avec le billet : les deux échouent ou réussissent ensemble.

Écarté : débiter au premier segment de trace (le client décide s'il l'envoie), compenser à la fin
(jouer sans jamais payer), ou écrire d'abord et insérer le billet ensuite (une écriture orpheline
si l'insertion bute sur l'index « un seul billet ouvert »).

**Ce que cela coûte n'est pas un ajout, c'est une réécriture, et il faut le dire.** `db-pg.js`
`createMatch` n'a aujourd'hui **aucun `begin`/`commit`** : c'est une boucle de deux tours, avec une
insertion `on conflict do nothing`, puis deux `select`, puis un `update` de statut, le tout en
validation automatique. La boucle entière passe dans une transaction, verrou en tête, chemin
`repris` et libération du billet périmé compris. Le chemin `repris` ne doit **jamais** écrire une
seconde mise : c'est le vol le plus facile de la phase, un `POST` rejoué qui débite deux fois.

### Un mouvement porte une clé d'idempotence, et on écrit ce qu'elle prouve

L'index est unique sur `(motif, reference, compte_debit, compte_credit)`. Le nom de la clé est le
couple `(motif, reference)` — le **mouvement** — mais un mouvement a plusieurs jambes, et une clé
unique sur le seul couple refuserait la deuxième. Les paires de comptes d'un même mouvement sont
distinctes deux à deux, donc la clé identifie exactement une jambe, et un mouvement rejoué en bloc
n'écrit rien.

Même doctrine que `name_key`, que l'index partiel « un seul billet ouvert » et que la clé primaire
`(match_id, seq)` : demander « existe-t-il déjà ? » puis insérer laisse une fenêtre entre les deux,
et deux onglets rapides passent tous les deux. Ici la fenêtre vaut un crédit en double. **C'est
l'insertion refusée qui apprend ce qui existait déjà**, jamais un `select` préalable.

Ce qu'elle ne prouve pas, écrit plutôt que tu : elle n'interdit pas deux **décompositions
différentes** sur la même référence. Ce trou-là est refermé par autre chose — le séquestre ne peut
pas passer en négatif, et le règlement de `matches` reste arbitré par sa clause `where status =
'open' and net_cents is null`. Trois protections qui se recouvrent, et c'est voulu : la première
qui tombe n'ouvre rien.

Écarté : se reposer sur la seule clause du règlement, qui est déjà idempotente. Elle protège la
ligne `matches`, pas la table du grand livre. Le jour où quelqu'un ajoutera un second chemin
d'écriture, la protection ne le suivra pas.

### Le gain d'une ligne divergente va en QUARANTAINE

Deux phrases écrites plusieurs fois doivent tenir ensemble : « une divergence est mesurée, jamais
punie » et « le grand livre ne lira que des lignes convergées ».

Ne rien créditer serait le **quatrième contrôle « évident » et faux** du dossier : un joueur dont le
moteur JavaScript n'a pas la même bibliothèque mathématique que le serveur n'est pas un tricheur.
Créditer le solde dépensable romprait une garantie écrite quatre fois. Ne rien écrire du tout
laisserait `net_cents` sans contrepartie, et le livre ne bouclerait plus — la seule chose qu'un
grand livre promet.

La quarantaine tient les trois : le mouvement existe, le livre boucle, et **la divergence est
chiffrée en centimes** et plus seulement en nombre de lignes. La phase 06 tranchera sur un rendement
connu. En crédits fictifs, retenir ne coûte rien à personne.

`GET /api/me` rend les deux montants **séparément**, et aucun agrégat convergé n'en compte un
centime.

*Précision apportée par le module 3, parce que deux phrases de ce document ne disaient pas tout à
fait la même chose.* Le règlement envoie le net en quarantaine dès que `digest_match` n'est pas
**vrai** — donc faux **ou nul** — tandis que `ledgerReconcile` ne tient pour divergente qu'une ligne
à `digest_match === false`. Les deux ne peuvent pas se contredire, et il faut écrire pourquoi plutôt
que de compter dessus : `digest_match` ne vaut `NULL` que sur une ligne close **sans rejeu** — un
billet périmé jugé sans être rejoué — et une telle ligne a toujours un net **nul**, donc aucune jambe
ne touche un compte de joueur. Le jour où un chemin produirait un net non nul sans rejeu, ce serait
ce chemin-là qu'il faudrait corriger, pas l'un des deux prédicats : payer sans avoir rejoué est
précisément ce que la 02b existe pour interdire.

### Aucune correction par `update` ni par `delete` : la contre-passation

C'est la règle « une ligne s'insère puis se règle une fois » poussée jusqu'au bout, et c'est déjà ce
que fait `match_traces`. Une écriture modifiée est une **preuve détruite** : on ne peut plus dire ce
qui a été payé ni quand. Une écriture fausse se corrige par un mouvement **inverse**, daté, motivé
`contrepassation`, qui laisse les deux visibles.

Écarté : autoriser une correction administrative « en cas de besoin réel ». Le besoin réel arrive
toujours, un dimanche soir, et c'est ce jour-là que la garde tombe. Le coût de la contre-passation
est deux lignes de plus ; le coût de l'autre choix est un livre auquel personne ne peut plus se
fier.

Une garde textuelle, du même patron que celles qui existent, vérifie qu'aucun `update` ni `delete`
de `db-pg.js` ne vise `ledger_entries`. Et une seconde vérifie que **l'écrivain du grand livre n'est
appelé que depuis les méthodes nommées de `db-pg.js`** — c'est le patron déjà en place pour
`match_traces` et pour le lecteur unique des tables annexes du bloc `Game`. Sans elle, le veilleur
deviendrait un écrivain d'argent silencieux, ce qui est précisément ce qui arrive plus bas.

Ce que cette règle ne dit pas, et qui est un risque écrit : **personne n'est habilité à
contre-passer.** Voir les risques.

### La dotation, et le compte qui ne meurt pas

La dotation initiale est un mouvement `maison:dotation → joueur:<id>:disponible`, écrit **une fois**
par le serveur à la création du compte, idempotent sur `(dotation, <user_id>)`.

Mais une dotation unique laisse un cul-de-sac que la conception initiale ne nommait pas : un joueur
connecté qui épuise ses crédits ne peut **plus jamais jouer**, à vie, puisque le bouton de recharge
disparaît en ligne. Ce n'est pas un détail de confort, c'est la fin de la boucle de jeu, et cela
arrive après cent parties à 0,50 $.

Une **recharge périodique** referme cela sans créer la route de crédit gratuit qu'on refuse par
ailleurs : elle est idempotente sur `(recharge, <user_id>:<date du jour>)`, elle part du même compte
d'émission, et elle est **écrite par le serveur** — au moment où le joueur se connecte, dans la même
transaction que `findOrCreate` — et jamais par un `POST /api/credits` que le client pourrait
marteler. Elle ne s'écrit que si le solde dépensable est **au-dessous d'un plancher** nommé : ce
n'est pas un revenu, c'est un plancher de jeu en crédits fictifs.

### La fenêtre de renoncement n'est PAS le sas, et c'est le cœur de la phase

Le vol que le débit à l'ouverture ouvre, et il faut le nommer : **ouvrir un billet, jouer, perdre,
n'envoyer ni trace ni résultat, laisser expirer, et se faire rembourser.** Le joueur ne perd alors
jamais. Toute condition de remboursement fondée sur « aucune trace n'est arrivée » est contrôlée par
le client, donc sans valeur. La seule chose que le serveur observe sans lui est **son propre
chronomètre**.

La borne évidente est fausse. `LOBBY.wait` vaut 25 secondes, mais le jeu **décolle plus tôt** :
`waitTick` pose `W.drop = min(W.drop, W.t + LOBBY.dropIn)` dès que la salle est pleine. La salle est
pleine à `t = LOBBY.wait / pression`, et `joinRate` plafonne la pression à 2,4 — donc le coup
d'envoi peut tomber dès **13,4 secondes**. Une fenêtre de 25 secondes rembourserait une partie
commencée depuis une douzaine de secondes de jeu réel : le vol qu'on se donne le mal de fermer se
rouvrirait par la porte d'à côté, et le test nommé d'après le vol ne le verrait pas.

Pire, **la borne exacte n'est pas calculable côté serveur** : la pression vient de `queueFor`, qui
lit `onlineTotal()`, qui lit `d.getHours()` — le fuseau horaire du **client**.

Le seul bord sûr est donc le **coup d'envoi le plus précoce possible**, moins une marge :

```
fenêtre = plancher(LOBBY.wait / LOBBY.pressureMax + LOBBY.dropIn) − marge
        = plancher(25 / 2,4 + 3) − 3
        = 10 secondes
```

`LOBBY.pressureMax` est le plafond 2,4 aujourd'hui écrit en littéral dans `joinRate` : il reçoit un
nom pour que la fenêtre en **dérive** au lieu de le recopier. La marge de trois secondes couvre la
latence : `opened_at` est postérieur au `t = 0` du client, donc `maintenant − opened_at`
**sous-estime** le temps écoulé au sas — l'erreur va dans le mauvais sens, et il faut la payer.

Le test qui tient cette phrase ne compare pas deux constantes : il **confronte la fenêtre au vrai
code du lobby** — `joinRate`, `seatsAt` et la règle de `waitTick` — sur tout le domaine, cinq modes
× quatre tables × toute la plage de files d'attente × les vingt-quatre heures d'`onlineTotal`. La
fenêtre doit être strictement inférieure au coup d'envoi le plus précoce trouvé, sur **chaque**
combinaison. C'est la leçon du pot forfaitaire ressuscité : deux règles qui décident du même nombre
se confrontent sur tout leur domaine.

Passé la fenêtre, **rien ne rend la mise** : un billet que personne ne termine est clos par le
veilleur **sans remboursement**.

Écarté : rembourser tout billet expiré sans résultat (le vol ci-dessus, gratuit et répétable) ; ne
jamais rembourser (punit celui qui ferme son onglet dans le lobby, alors que le jeu lui rend déjà sa
mise à l'écran) ; un remboursement au prorata (un barème arbitraire à défendre, pour un cas que la
fenêtre règle sans arbitraire).

Ce que cette fenêtre fait payer, et qui n'est pas rien : **le joueur honnête dont l'onglet meurt à
la onzième seconde perd sa mise.** Voir les risques.

### Le chercheur de graine paie un cycle complet, et pas un aller-retour HTTP

Renoncer à la première seconde clôt le billet, libère l'index partiel, et `createMatch` en délivre
un neuf **immédiatement**, avec une graine neuve. La carte étant une fonction pure de `seed_public`,
que le client reçoit **avec** le billet, le coût d'un nouveau tirage serait un aller-retour HTTP.
C'est une surface que cette phase ouvre elle-même, et « un cycle de sas complet » aurait été une
phrase rassurante et fausse.

Une **temporisation** la referme : après un remboursement, `POST /api/match` refuse en `409
renonce_recent` tant que `opened_at + fenêtre` du billet renoncé n'est pas passé. Un nouveau tirage
coûte donc bien la fenêtre entière, et pas une requête. Ce qui reste — un tirage toutes les dix
secondes, pour un avantage nul contre des bots — est acceptable et il est écrit.

### Le billet renoncé a son propre statut

`matches.status` n'accepte que cinq valeurs. Une renonciation clôt le billet, et aucune des cinq ne
convient : `'abandoned'` porte déjà un sens précis — « un résultat a été rendu, on ouvre un billet
neuf ». Une **sixième** valeur, `'renounced'`, entre dans la contrainte `check`, et `schema.sql`
figure donc dans les fichiers du module concerné. Une valeur de statut qui ment est du même genre
qu'une colonne qui ment.

### Le veilleur devient un écrivain d'argent, et c'est un revirement écrit

Aujourd'hui `api/app.js` et `api/db-pg.js` portent la même phrase sur le veilleur : « Il n'écrit
AUCUN montant — il ne fait que fermer une porte. » Cette phase la **contredit** : à l'expiration
d'un billet, le séquestre doit être vidé vers `maison:contrepartie`, sans quoi l'invariant « aucun
séquestre ne reste habité » est faux et de l'argent reste dans un compte que rien ne solde.

Le revirement est assumé et les deux commentaires sont **réécrits**, pas laissés à contredire le
code. Ce serait sinon découvert six mois plus tard par quelqu'un qui relit un commentaire.

Deux conséquences de forme :

- `expireMatches` clôt aujourd'hui jusqu'à 500 lignes en **une** instruction. Elle devient une
  boucle de transactions bornées, **une par billet** : un mouvement du grand livre ne se pose pas en
  masse, et un échec sur une ligne ne doit pas annuler les autres.
- Le veilleur rejoint la liste des **appelants autorisés** de l'écrivain du grand livre, dans la
  garde textuelle. Un écrivain d'argent de plus doit être nommé, pas silencieux.

### `match_traces` reçoit une politique de conservation, et la purge a quatre conditions

La trace est la **pièce justificative d'un mouvement d'argent**. Elle se garde au moins aussi
longtemps que la fenêtre pendant laquelle un joueur peut contester, que la phase 06 fixera. La
constante `TRACE_RETENTION_JOURS` est donc conservatrice par défaut, avec sa raison écrite à côté,
et elle n'est pas une décision juridique.

La purge n'efface une trace que si **les quatre conditions** sont réunies :

1. la ligne `matches` est **réglée définitivement** — `status in ('settled', 'rejected')` ;
2. le grand livre a **posé son écriture** sur cette partie — il existe un mouvement de règlement ou
   de remboursement portant ce `match_id` ;
3. **rien n'est en attente** — `solde(enjeu:<match_id>) = 0` ;
4. **le délai est écoulé** — `settled_at` est plus vieux que la rétention.

Les quatre se recouvrent en marche nominale, et c'est voulu : chacune est éprouvée par un test qui
la **retire seule**, sur un cas dégénéré construit exprès. C'est le premier `delete` du dépôt sur la
pièce qui prouve un paiement ; on ne le teste pas en bloc.

Conséquence directe : **la trace d'un billet dont le résultat n'est jamais arrivé n'est jamais
effacée**, puisque sa ligne n'est ni `settled` ni `rejected`. C'est exactement la pièce qu'on voudra
relire. La table ne descend donc pas à zéro, et c'est le bon défaut.

Écarté : tout garder pour toujours (une table qui grandit sans borne finit par être vidée à la main,
un soir, sans règle) ; purger sur l'âge de la ligne `matches` (efface la pièce d'un litige ouvert) ;
purger la trace au règlement (le rejeu ne serait plus reproductible le lendemain, et c'est tout ce
que la 02b a construit).

**Un test existant change de forme, et il faut le dire** : `api/test.js` interdit aujourd'hui tout
`delete from match_traces` dans `db-pg.js`, et il **passe**. Il devient « le seul `delete` de cette
table est la purge nommée, et sa clause porte les quatre conditions ». Une garde qu'on affaiblit
sans le dire est très exactement l'écart que la recette de la 02b a trouvé.

### Le prédicat de réconciliation, à la fin de chaque scénario

`ledgerReconcile(ligneMatch, transferts)` est une fonction pure d'`api/ledger.js`, appelée à la **fin de
chaque scénario** d'`api/test.js`. Elle vérifie l'appariement ligne à ligne avec `matches` :

- aucun billet sans son engagement, aucun engagement sans son billet ;
- `solde(enjeu:<match_id>)` vaut la mise sur une ligne ouverte, zéro sur une ligne close ;
- les montants du grand livre reproduisent ceux de la ligne `matches` **au centime** —
  `fee_cents` sur `maison:commission`, `net_cents` sur le compte du joueur.

Le zéro global ne dit rien sur cet appariement : il est vrai même si un montant juste est posé sur
le mauvais compte. La réconciliation ne coûte presque rien et attrape exactement cela.

*Précision apportée par le module 1, parce qu'une des trois promesses ci-dessus ne tenait pas avec la
signature écrite.* « Aucun engagement sans son billet » n'est pas décidable sur **une** ligne : un
séquestre habité par une partie que `matches` ne connaît pas ne se voit qu'en regardant tous les
billets à la fois. `ledgerReconcile` accepte donc **une ligne ou une liste de lignes**, et ne rend ce
grief-là que dans le second cas. Elle rend une liste de griefs en français, vide quand tout
s'apparie — un prédicat qui rendrait `false` ne dirait pas lequel des quatre contrôles a cédé.

### La vraie Postgres : ce qui est livré est la RECETTE

Il faut être honnête sur ce que ce module peut faire. **Livrer un script n'est pas l'avoir lancé**,
et rien ne garantit qu'une Postgres existe là où ce plan s'exécute. Écrire « la dette la plus
silencieuse du dossier est soldée » serait exactement le genre de phrase qu'on relit six mois plus
tard comme une vérité.

Ce qui est livré :

- `api/db-check.js` applique `schema.sql` puis éprouve les contraintes contre la base réelle. **Sans
  `DATABASE_URL`, il sort 0 en le disant** — l'intégration continue existante ne change pas d'une
  ligne, et personne n'est bloqué.
- Il **n'entre pas** dans `npm test`, qui continue de tourner sans base et sans réseau. C'est une
  règle non négociable : tout est injecté dans `createApp()`.
- Sa liste de scénarios **cite nommément** chaque contrainte que la doublure se contente d'imiter :
  `name_key`, l'index partiel des billets ouverts, `on conflict do nothing` sur `(match_id, seq)`,
  la clause `where status = 'open' and net_cents is null`, la clé du grand livre, et les largeurs
  `integer`.
- Un job `services: postgres` est ajouté à `.github/workflows/test.yml` et le lance, **pendant que
  `npm test` reste sans base et sans réseau**. C'est la seule façon de solder la dette au lieu de la
  promettre : sinon le module se clôt sur une intention.
- Le seul test qui **ne peut exister nulle part ailleurs** : deux transactions **concurrentes** qui
  débitent le même compte se sérialisent au lieu de se croiser. Une doublure JavaScript mono-fil
  sérialise gratuitement ce que Postgres ne sérialise que si on le lui demande correctement. Un
  verrou éprouvé en série ne prouve rien — c'est le patron du harnais de `test.js` qui recopiait les
  expressions de `faits`, et le journal l'a déjà payé une fois.

Tant que ce job n'a pas été vert une fois, la phrase du dossier reste vraie et reste écrite : **un
test qui passe contre la doublure prouve la doublure.**

### Le jeu lit son solde du serveur, et le bouton de recharge disparaît

Connecté, `wallet` vient de `GET /api/me`, converti par `fromCents` en **un seul point de
conversion**, celui d'`applyAccount`. Le bouton « + reload demo credits » disparaît : connecté,
c'est littéralement une route de crédit gratuit servie par le client, et c'est exactement le
mécanisme qu'il faudrait supprimer en phase 04.

Hors ligne, **absolument rien ne change**. Le portefeuille de démonstration reste une variable du
navigateur, il le dit à l'écran, et les quatre cas de repli nommés depuis la 02a — pas de compte,
`ACCOUNT.api` vide, serveur muet, réponse illisible — restent testés comme des cas normaux.

Trois conséquences précises, parce que **deux économies vivent sur le même écran** :

- `enterWaiting` fait aujourd'hui `wallet -= stake` et `wLeave` fait `wallet += W.stake`. En ligne,
  **ni l'un ni l'autre** : le débit a eu lieu côté serveur, et le solde est celui que le serveur
  rend. `POST /api/match` renvoie donc `balanceCents` et `quarantineCents` avec le billet — un
  aller-retour de moins, et c'est la parole du serveur. Une garde textuelle interdit tout
  `wallet -=`, `wallet +=` et toute écriture de `wallet` depuis une réponse serveur en dehors
  d'`applyAccount`.
- Le bouton QUITTER du sas dit ce que partir coûte, en lisant `WBCore.renonciationOuverte` avec le
  chronomètre du sas. Le chronomètre du client est **en avance** sur celui du serveur (la latence
  joue dans ce sens), donc l'écran ferme la promesse un peu **avant** que le serveur ne la ferme :
  il ne promet jamais un remboursement que le serveur refusera.
- Un refus `fonds` **arrête le sas**, affiche un message, et ne lance **aucune** partie. C'est une
  distinction à écrire, parce qu'elle contredit à moitié une règle de la 02a : une panne
  **silencieuse** (réseau, réponse illisible) laisse le jeu partir hors ligne comme avant — « un
  billet qui tarde ne retarde jamais le coup d'envoi » — mais un **refus explicite et nommé** n'est
  pas une panne, et jouer quand même ferait de la partie payante une partie gratuite.

Le test d'accessibilité d'une table au lobby redevient ce qu'il est — une **indication**. C'est le
`409 fonds` du serveur qui tranche.

*Précisions apportées par le module 5, parce que ce document a été écrit avant que les modules 3 et 4
n'ajoutent leurs refus.* (1) Ce ne sont pas un mais **trois** refus qui arrêtent le sas : `fonds`,
plus `livre` (le grand livre a refusé l'écriture, module 3) et `renonce_recent` (la temporisation du
chercheur de graine, module 4). Les trois disent la même chose — le serveur a instruit la demande et
l'a rejetée — et les traiter différemment n'aurait aucun sens. La liste est **fermée**, elle vit dans
`WBCore.REFUS_SAS`, et un test d'`api/test.js` la confronte aux codes que l'API émet vraiment ; un
429 et un 500 n'y sont volontairement pas, ils ne nomment rien et retombent donc dans le repli hors
ligne. (2) Un trou que ce document ne nommait pas, et qui coûte une mise entière : **le joueur peut
quitter le sas pendant que la demande de billet est encore en vol.** Le serveur ouvre alors le billet
et débite ; personne ne renonce pour lui, et la mise reste au séquestre jusqu'à l'expiration. Le jeu
renonce donc au billet qui arrive en retard, sur la génération de requête qui l'attendait. (3) Quitter
le sas **hors** fenêtre ne réclame rien du tout : le billet reste ouvert et jouable côté serveur, et
appeler la route pour se faire refuser coûterait au joueur la temporisation `renonce_recent`. Le jeu
le lâche seulement de sa main, pour que le sas suivant en demande un neuf.

### La frontière avec la 02a est un test, pas une phrase

Le grand livre ne lit **aucune** ligne dont les faits ont été déclarés par le client. La frontière
se **constate** au lieu de se supposer : une ligne 02a — `trace_steps` nul — est semée dans la
doublure, et le test prouve qu'aucune écriture du livre ne la touche jamais. Une ligne sans écriture
de mise n'a jamais d'écriture de gain.

---

## Les invariants, et comment chacun se teste

| Invariant | Comment il se tient, et comment il se teste |
|---|---|
| La somme de **toutes** les écritures, tous comptes confondus, est zéro à tout instant. | Par **construction** : une ligne est un transfert, donc `+m` et `−m`. Testé quand même — une requête d'une ligne dans `db-check.js`, et à chaque étape des cinquante parties simulées d'`api/test.js`. |
| Aucun mouvement déséquilibré n'est **représentable**. | `montant_cents > 0` et `compte_debit <> compte_credit`, contraintes de colonne. Éprouvées contre Postgres dans `db-check.js`. |
| `ledger_entries` est en **insertion seule**. | Garde textuelle : aucun `update`, aucun `delete` de `db-pg.js` ne vise cette table, et la doublure d'`api/test.js` n'expose aucun chemin de modification. Une correction est une contre-passation, testée comme telle. |
| Un solde est une **somme**, jamais une colonne. | La garde existante — aucune colonne nommée solde, balance ou wallet — s'étend au nouveau schéma et ne perd rien. |
| Tout montant est un **entier de centimes**, et la commission ne se recalcule jamais. | Garde textuelle sur `api/ledger.js` : ni `RAKE`, ni `0.2`, ni `Math.ceil`, ni `/ 100`, ni `toFixed`. `gross`, `fee` et `net` viennent tous les trois de `cashoutCents` et de nulle part ailleurs. `fee + net = brut` sur chaque règlement, exhaustivement, sur les cinq modes et les quatre tables. |
| Chaque jambe est un entier **sûr**. | Test : aucun flottant n'entre, sur toute sacoche de 0 à `mise × sièges`, cinq modes, quatre tables — le domaine entier, pas un échantillon. |
| Un compte ou un motif hors grammaire **lance**. | Test unitaire sur `api/ledger.js`, plus la comparaison **caractère pour caractère** entre l'expression exportée et la contrainte du texte de `schema.sql`. |
| Un mouvement porte une clé unique. | Index `(motif, reference, compte_debit, compte_credit)`. Dans `db-check.js` : la seconde insertion est **refusée**, pas avalée. |
| **Aucun montant** du grand livre ne vient du corps d'une requête. | Un corps portant `balanceCents`, une dotation ou un net dix fois trop gros écrit **exactement** les mêmes lignes et les mêmes écritures qu'un corps minimal. Le patron de la 02a, étendu des paramètres aux faits en 02b, étendu ici aux écritures. |
| Un billet et sa mise naissent ensemble ou pas du tout ; un règlement et son gain aussi. | Test : un règlement interrompu au milieu ne laisse **aucune** écriture partielle. Aucun échec ne sort en 500. |
| Un solde de joueur ne devient **jamais** négatif. | Verrou de ligne, somme, refus `409 fonds` sans billet ni écriture. Concurrence éprouvée dans `db-check.js`, et là seulement. |
| Le solde **dépensable** ne compte que des lignes convergées. | Une ligne divergente crédite la quarantaine ; `GET /api/me` rend les deux séparément ; aucun agrégat convergé n'en compte un centime. |
| `solde(enjeu:<match_id>)` vaut la mise sur une ligne ouverte et **zéro** sur toute ligne close — réglée, refusée, périmée, abandonnée, renoncée. | `ledgerReconcile` à la fin de **chaque** scénario, et sur les cinq issues. Aucun séquestre ne reste habité. |
| Aucun billet sans son engagement, aucun engagement sans son billet, et les montants de `matches` reproduits au centime. | `ledgerReconcile`, à la fin de chaque scénario. |
| Le grand livre ne lit **aucune** ligne de la 02a. | Une ligne à `trace_steps` nul semée dans la doublure : aucune écriture ne la touche. Une ligne sans mise n'a jamais de gain. |
| Le jeu reste jouable **sans compte et sans serveur**, graine comprise. | Les quatre cas de repli nommés depuis la 02a restent testés comme des cas normaux. Le portefeuille de démonstration reste une variable du navigateur qui le dit. |
| Le solde ne se convertit qu'**une fois**. | Garde textuelle, exactement celle qui protège déjà `best` : un second point de conversion est interdit. |
| Les tests tournent **sans base et sans réseau**. | `npm test` ne connaît ni l'un ni l'autre. `db-check.js` est un script à part, il sort 0 sans `DATABASE_URL`, et un job d'intégration continue distinct le lance. |
| Les blocs `<script>` d'`index.html` parsent, et `npm test` est vert des deux côtés. | Le test existant, plus la recette de fin de phase. |

---

## Les risques, assumés

**Le verrou de compte n'a jamais été éprouvé sous concurrence réelle.** C'est la dette « la doublure
prouve la doublure » déplacée sur le chemin de l'argent. Une doublure JavaScript mono-fil sérialise
gratuitement ce que Postgres ne sérialise que si on le lui demande bien. Tant que le job Postgres
n'a pas été vert une fois, le test le plus important de la phase est **vrai par construction** — et
les modules qui en dépendent se closent verts sur une propriété non éprouvée.

**Le coût de la maison devient visible, et il est bien plus gros que « dix-neuf mises ».** Ce chiffre
vaut pour le solo, qui a vingt sièges. `resurgence` et `resurgenceDuo` en ont **cinquante**. Sur une
table à 10 $, une sortie parfaite en resurgence donne un brut de 50 000 centimes,
`cashoutCents` en tire 40 000 de net et 10 000 de commission, et le séquestre ne contenait que
1 000 : `maison:contrepartie` verse **49 000 centimes** et la maison encaisse 10 000, soit un coût
net de **390 $ sur une seule partie**. Ce chiffre existait déjà ; il n'était écrit nulle part. Le
grand livre le mesure, il ne le résout pas. **Le risque n'est pas le chiffre, c'est de le voir
apparaître et de le prendre pour un bug.**

**La quarantaine est un mécanisme qui retient de l'argent.** En crédits fictifs elle ne coûte rien à
personne. En argent réel elle devient un litige avec un joueur qui n'a rien fait de mal — son
navigateur n'a pas la même bibliothèque mathématique que le serveur. Son rendement doit être chiffré
**ici**, en centimes et pas seulement en nombre de lignes : c'est mot pour mot la raison d'être de
`stats.divergences`, poussée d'un cran.

**Le rejeu tourne dans le fil de la requête et décide maintenant d'un mouvement d'argent.** Un budget
dépassé laisse la ligne ouverte, donc la mise débitée et rien de rendu jusqu'à l'expiration. La
fenêtre est bornée par la vie du billet, elle n'est pas nulle, et une trace adversariale cherche
précisément à la maximiser. `REPLAY_BUDGET_MS` cesse d'être une protection de charge pour devenir
une protection de trésorerie.

**Un billet joué et jamais réglé coûte la mise au joueur, et le chemin de correction n'est pas
construit ici.** La fenêtre de renoncement rend ce coût **plus grand** : elle fait aussi payer sa
mise au joueur honnête dont l'onglet meurt à la onzième seconde. La phase nomme le vol qu'elle
ferme ; elle doit nommer le prix qu'elle fait payer.

**Une contre-passation est le seul chemin de correction, et personne n'a écrit qui a le droit de
l'emprunter.** Pas de journal d'audit, pas de rôle d'administration : le premier incident réel se
réglera à la main dans `psql`, un dimanche soir, et c'est ce jour-là que la règle « aucun `update` »
tombe. Le nommer ne le règle pas, mais un risque écrit se voit venir.

**La somme coûte plus cher que la case**, et cette fois elle est sur le chemin d'une requête que le
joueur attend. C'est le compromis déjà assumé pour les statistiques en 02a, avec un enjeu plus
élevé. Un index par compte suffit longtemps ; l'instantané de clôture existe comme échappatoire
nommée. Aggravation propre à ce dessin : **un séquestre par partie fait croître le nombre de comptes
comme le nombre de parties.** Un problème de performance se répare ; une case fausse ne se répare
pas.

**Le vol de précision reste entier.** Le grand livre paiera fidèlement une partie gagnée à l'aimbot,
et l'ESP est structurel — le client dessine les caisses, donc il en connaît le contenu. Cette phase
rend le **solde** inviolable ; elle ne rend pas la **partie** honnête.

**Sybil** : une dotation par compte, une recharge par compte et par jour, et un compte coûte un
email. En crédits fictifs c'est sans conséquence, et c'est une mesure gratuite de ce que la fraude
d'inscription rapportera. Aucun contrôle d'identité ne peut vivre à cette couche ; c'est un
prérequis de la phase 04.

**Le chercheur de graine est borné, pas éliminé.** La temporisation lui coûte la fenêtre entière par
tirage, plus les deux règles anciennes — un seul billet ouvert à la fois, une graine par billet.
À surveiller le jour où les adversaires seront humains, pas avant.

**Deux économies sur le même écran, et aucun test ne regarde le jeu se voir.** `node test.js`
n'attrape pas un bug d'écran, et la session de jeu réelle due depuis la 02b n'a toujours pas eu
lieu. Le dernier module porte tout ce risque, comme en 02a.

---

## Le découpage, et pourquoi cet ordre

**Cinq modules, pas six.** La version initiale du plan séparait le débit et le crédit. Elle laissait
le dépôt dans un état vert aux tests et intenable en vrai : des mises débitées, des séquestres
habités, et aucun chemin qui les vide — l'invariant `solde(enjeu:<match>) = 0 sur toute ligne close`
aurait été **faux entre les deux modules**. Chaque module doit être livrable seul ; celui-là ne
l'était pas. Le débit et le crédit sont donc un seul module.

1. **`api/ledger.js` : la grammaire, les transferts, et la fenêtre de renoncement.** Tout ce qui est
   pur, testable sans rien installer. À la fin de ce module le grand livre existe entièrement et
   personne ne l'a encore écrit sur un disque. C'est ce qui rend les quatre modules suivants
   ennuyeux, et c'est le but.
2. **Le schéma, et la vraie Postgres.** `ledger_entries`, les gardes textuelles, `api/db-check.js`
   et le job d'intégration continue. Il vient tôt parce que le module 3 s'appuie sur ses
   contraintes, et parce que le seul test qui prouve le verrou vit ici.
3. **La partie complète en ligne** : dotation, recharge, débit à l'ouverture sous transaction et
   verrou, règlement, quarantaine, `GET /api/me`, `ledgerReconcile`.
4. **Ce que devient un billet que personne ne termine** : la fenêtre de renoncement, la
   temporisation, le veilleur écrivain d'argent, et la conservation des traces.
5. **Le jeu.** Il est dernier et il porte tout le risque, comme en 02a : s'il glissait, quatre
   modules de serveur resteraient du code que personne n'aurait vu tourner.

---

## Ce qui est renvoyé aux phases suivantes

- **La décision d'exploitation « la maison est la contrepartie de chaque pot ».** Elle est
  désormais chiffrable, partie par partie, sur `maison:contrepartie`. À trancher **avant la phase
  04**, et les trois issues de `docs/HISTORIQUE.md` ne bougent pas.
- **Le sort de la quarantaine, et le seuil sur `ecart_cents`** : phase 06, sur des données réelles.
  Ce que coûtera la sortie de quarantaine est chiffré ici pour ne pas être découvert : un motif de
  plus dans `api/ledger.js`, un `alter table … drop constraint / add constraint` sur le `check` des
  motifs, et un test. C'est peu, et c'est moins cher qu'un membre de liste fermée que personne
  n'écrit aujourd'hui.
- **Qui a le droit de contre-passer.** Journal d'audit et rôles d'administration, à nommer avant la
  phase 04, avec la suppression de compte et le changement de pseudo tracés.
- **Le magasin partagé pour la limitation de débit**, avant la production.
- **Les instantanés de solde**, le jour où la somme coûtera trop cher — et jamais sans la règle qui
  permet de refaire l'instantané à l'identique.
- **La chaîne de hachage des écritures**, le jour où le modèle de menace inclura quelqu'un qui a la
  main sur la base.
- **La session de jeu réelle due depuis le module 1 de la phase 02b.** Elle a maintenant un
  cinquième point à juger : deux économies sur le même écran, connecté et hors ligne.
- **Le cadre légal**, avant tout argent réel.
