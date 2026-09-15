# TODOS

Constats reportés, avec assez de contexte pour être repris dans trois mois sans relire
toute la session qui les a produits.

---

## Cycle économie — l'annoncé et le payé ne coïncident pas

Neuf constats issus de la revue d'architecture du 2026-09-15 (branche `ben`). Ils forment
**un seul chantier** : pris séparément ils se contredisent, pris ensemble ils décrivent une
économie cohérente. À traiter dans l'ordre ci-dessous.

### E1 — Le partage du pot est affiché mais n'existe pas

**Quoi.** Le lobby affiche « YOUR SHARE $80 » sur la tuile Duo (`index.html:1560`, via
`teamPayout().split`) et `MODES.duo.desc` promet « Winners split the pot » (`index.html:943`).
Aucun chemin de paiement ne calcule jamais un partage.

**Pourquoi.** Le seul paiement réel est `cashoutPayout(p.pouch)` (`index.html:3896`), pour les
deux jeux. Chaque survivant repart avec 80 % de **sa propre** sacoche. `payout` et `teamPayout`
n'apparaissent que dans des chaînes d'interface : lignes 1553, 1573, 3543, 3700, 3774.

**Conséquence visible.** La même table Duo annonce deux plafonds différents pour la même mise :
« YOUR SHARE $80 » dans le lobby (l.1560, lit `split`) et « BANK UP TO $160 » dans le HUD en
match (l.3543, lit `winner`).

**Deux sorties possibles, à trancher :** implémenter un vrai partage à la fin du match, ou
corriger les libellés pour décrire ce qui est réellement versé. La seconde est beaucoup moins
chère et sans doute la bonne — mais c'est une décision de game design, pas d'ingénierie.

**Dépend de :** rien. **Bloque :** E2, E3, E9.

### E2 — Un vainqueur MAXWIN mort une fois peut repartir avec $0

**Quoi.** `kill()` met `victim.pouch = 0` (`index.html:2814`) et transfère à l'assassin
(l.2803). `respawn()` restitue les PV, les munitions, le super et le gadget — jamais la mise.

**Conséquence.** Avec `LIVES = 3`, mourir au moins une fois est le chemin normal. Survivre
jusqu'au bout depuis là sans avoir tué personne donne `cashoutPayout(0).net = 0` : l'écran de
fin affiche « VICTORY! » puis « +$0 » (l.3896-3904), après un lobby qui promettait
« WIN UP TO $160 ».

**À noter.** Le bandeau « live wins » ne peut pas montrer ce cas : `winAmount` force
`kills = 1 + …` (l.1113). La distribution affichée est tronquée par le bas exactement là où la
vraie est la plus mauvaise.

**Dépend de :** E1 (la règle de paiement doit être fixée d'abord).

### E3 — Le hold réel dépasse structurellement les 20 % annoncés

**Quoi.** `RAKE = 0.20` est appliqué au paiement (l.1133-1136), mais tout dollar qu'un survivant
ne rapporte pas reste à la maison : sacs de gaz ou d'abandon non ramassés (l.2806), argent qui
meurt avec un éliminé tué par un joueur lui-même déjà mort.

**Statut.** La direction est certaine par lecture du code ; **l'ampleur n'a pas été simulée**.
Premier pas : instrumenter une simulation de 10 000 matchs et mesurer le hold effectif.

**Pourquoi ça compte.** C'est le chiffre qu'on inscrit sur un dossier de licence dans toute
juridiction régulée. Le seul test de rake aujourd'hui (`test.js:14`) vérifie 20 % d'un pot qui
n'est jamais versé.

**Dépend de :** E1.

### E4 — `cents()` est contourné sur chaque ligne qui déplace vraiment de l'argent

**Quoi.** `CLAUDE.md` pose « L'argent se calcule au centime via `cents()` ». Les quatre
mutations qui bougent l'argent du joueur ne l'utilisent pas : `wallet-=stake` (l.3671),
`wallet+=W.stake` (l.3704), `wallet+=take.net` (l.3897), `e.pouch+=pk.amount` (l.2779).

**Mesuré.** 200 matchs STREET enchaînés : le solde atterrit sur `109.99999999999943` au lieu de
110. Écart −5,7 × 10⁻¹³.

**Pourquoi ce n'est pas urgent.** Les mises 0,50 / 1 / 5 / 10 sont exactes en binaire et
`money()` arrondit à l'affichage. **Pourquoi c'est à faire quand même :** l'invariant documenté
est faux, et il est faux au seul endroit qui compte.

**Dépend de :** rien. Le moins cher des neuf.

### E5 — L'invariant n°1 de CLAUDE.md garde du code mort

**Quoi.** « Le pot se partage sans reste en Duo et en Trio, sur les quatre tables » est le
premier invariant listé, et `test.js:159` le vérifie sur `teamPayout().split` — un champ que le
chemin de paiement ne lit jamais.

**Pourquoi ça compte.** C'est un test vert qui ne protège rien. Il donne confiance dans une
propriété que le jeu ne tient pas. À réaligner sur le vrai chemin de paiement une fois E1 tranché.

**Dépend de :** E1.

### E6 — Le solde est un `let` modifiable depuis la console

**Quoi.** `let wallet = C.START_WALLET` (`index.html:1513`). N'importe qui peut l'écraser depuis
la console du navigateur.

**Statut.** `docs/HISTORIQUE.md` le signale déjà dans « Ce qui reste ouvert ». Ce n'est pas un
bug tant que les crédits sont fictifs — c'est la démonstration que **l'économie est côté client**,
et donc que tout durcissement de surface reste cosmétique tant qu'un serveur ne détient pas le
solde. À garder en tête avant d'investir dans la sécurité client.

**Dépend de :** rien. **Ne se corrige pas** sans backend : à traiter comme une contrainte, pas
comme une tâche.

### E7 — `docs/GAME-DESIGN.md` contredit le code sur trois points

- `GAME-DESIGN.md:152` : « Un gain Maxwin est exactement `teamPayout().split` ». Faux —
  `winAmount` (l.1107-1115) passe par `cashoutPayout` pour les deux jeux.
- `GAME-DESIGN.md:237` : « ta mise et tes cubes tombent au sol à chaque mort ». Faux — la
  sacoche va directement à l'assassin (l.2801-2805) ; seule une mort par gaz ou abandon lâche
  un sac.
- `GAME-DESIGN.md:237-238` : « Les vainqueurs se partagent le pot à parts égales » / « ta part
  = pot ÷ 3 ». Aucun partage n'existe.

**Dépend de :** E1 (inutile de réécrire la doc avant que la règle soit fixée).

### E8 — `docs/HISTORIQUE.md` annonce 117 tests, il y en a 191

Correction d'une ligne. Aucune dépendance.

### E9 — Le bandeau « live wins » ne peut pas afficher les mauvais résultats

**Quoi.** `winAmount` force `kills = 1 + …` (l.1113), donc aucun gain annoncé n'est jamais
inférieur à 1,6 × la mise.

**Pourquoi ça compte.** Le bandeau se présente comme un flux de résultats réels — le commentaire
du code le dit : « Amounts are computed from the real payout maths, never invented ». La borne
basse est pourtant retirée. Sous argent réel, un bandeau qui ne montre que les bons résultats
n'est plus de la décoration.

**Dépend de :** E1, E2.

---

## Perf — reporté du cycle en cours

### P1 — Profiler `hudFast()` sur un téléphone réel

Les gardes de changement ajoutées au cycle en cours (deux `box-shadow`, l'`innerHTML` des badges
l.3439) reposent sur un raisonnement de coût, pas sur un profil. Mesuré sur desktop : 120 FPS en
ULTRA, donc rien à voir ici. La cible est le mobile bas de gamme, en Resurgence à 50 joueurs.
Un profil donnerait une ligne de base chiffrée au lieu d'arbitrer au jugé.

**Dépend de :** les correctifs perf du cycle en cours.

---

## Tests — reporté du cycle en cours

### T1 — Test de démarrage headless

Le contrôle de syntaxe ajouté à `npm test` attrape un bloc `<script>` qui ne compile pas. Il
n'attrape pas un bloc qui compile et plante à l'exécution : contexte WebGL indisponible, CDN
injoignable, erreur au premier rendu. Un test Playwright qui ouvre `index.html`, attend le
lobby et échoue sur toute erreur console fermerait cette classe.

**Le coût réel n'est pas le temps de développement** mais `node_modules` et un navigateur à
installer, ce qui contredit frontalement la promesse « aucune dépendance à installer » du README.
À trancher comme un arbitrage d'identité du projet, pas comme une tâche technique.

**Dépend de :** le contrôle de syntaxe du cycle en cours.
