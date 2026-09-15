# WARBLOCK

Battle royale en vue de dessus, avec mises. Deux jeux, dix brawlers, sept mille lignes
dans **un seul fichier HTML**. Aucune dépendance à installer, aucun serveur : on ouvre
`index.html` et on joue.

> **Crédits fictifs uniquement.** Tous les adversaires sont des bots, la population affichée
> est simulée, rien n'est enregistré côté serveur. C'est une démo de sensations de jeu.

## Jouer

```bash
# ouvrir directement
open index.html          # macOS
xdg-open index.html      # Linux

# ou servir en local, pour tester depuis un téléphone du même réseau
npm start                # http://localhost:8080
```

En ligne : voir [docs/DEPLOY.md](docs/DEPLOY.md). Le dépôt se publie tout seul sur GitHub Pages
à chaque push sur `main`.

## Tests

```bash
npm test        # 413 tests sur le jeu + 255 sur l'API, sans dépendance
```

Les règles du jeu vivent dans deux blocs purs à l'intérieur de `index.html`, sans DOM ni WebGL :
`WBCore` pour les règles sans état, `WBSim` pour l'état d'une partie et ce qui le fait avancer.
`test.js` les extrait et les exécute dans Node : économie, paiements, génération de carte,
équilibrage des brawlers, files d'attente, chat, qualité graphique, grenade fumigène, connexion au
compte, puis la grille, le mouvement, la ligne de vue, les points de départ, le combat, les bots —
et **cinquante parties complètes**, jouées du coup d'envoi à la dernière phase du gaz sans
navigateur. Le rendu, lui, n'est pas couvert : il demande un navigateur.

## Structure

```
index.html              le jeu entier
  ├── <style>           lobby, HUD, écrans
  ├── <script> WBCore   règles pures, sans état      ← couvert par les tests
  ├── <script> WBSim    toute la simulation d'une partie          ← couvert par les tests
  └── <script> Game     rendu Three.js, entrées, IA, audio
test.js                 harnais Node du jeu
corpus-grille.json      corpus gelé : la preuve que le code a bougé sans changer
api/                    serveur Node, testable sans base : comptes et profils (phase 01),
                        billet de partie (phase 02a), rejeu de la partie (phase 02b),
                        grand livre en partie double (phase 03), plafond d'exposition,
                        plancher d'horloge et outil d'opérateur (phase 04a)
manifest.webmanifest    « Ajouter à l'écran d'accueil » en plein écran
icon-*.png              icônes
docs/GAME-DESIGN.md     toutes les règles et les choix d'équilibrage
docs/HISTORIQUE.md      journal de développement : décisions, pistes abandonnées, bugs
docs/PHASE-02.md        la phase 02a : billet, verdict, statistiques par agrégat
docs/PHASE-02B.md       la phase 02b : pas fixe, bloc SIM, trace des entrées, rejeu serveur
docs/PHASE-03.md        la phase 03 : le grand livre en partie double, en crédits fictifs
docs/PHASE-04A.md       la phase 04a : le bord de l'argent réel — plafond, sièges payés,
                        contre-passation, anonymisation
docs/DEMANDES.md        les demandes d'origine, dans l'ordre
docs/DEPLOY.md          mise en ligne
docs/ICONS-PROMPTS.md   prompts de génération d'icônes
```

## Les deux jeux

| | MAXWIN | RESURGENCE |
|---|---|---|
| Joueurs | 20 à 30 | 50 |
| Modes | Solo · Duo · Trio | Solo · Duo |
| Vies | 3 | 2 |
| Gain | la sacoche que tu emportes en sortant | ton bucket, encaissable à tout moment |
| Rythme | ~2 min 30 | ~1 min 20 |

Commission de la maison : **20 % de tout paiement**, dans les deux jeux.
Tables : $0,50 · $1 · $5 · $10.

## Avant d'aller plus loin qu'un playtest

Deux chantiers avant d'envisager de l'argent réel, détaillés dans
[docs/DEPLOY.md](docs/DEPLOY.md) :

1. **Le grand livre existe, et sa recette contre une vraie base est en retard sur le code.** Depuis la phase 03, le solde d'un
   joueur connecté est la **somme d'écritures immuables en centimes entiers** tenue par le serveur :
   dotation à la création du compte, mise débitée à l'ouverture du billet, gain écrit au règlement,
   quarantaine pour une partie dont le rejeu a divergé. Le jeu lit ce solde et ne l'écrit plus ; hors
   ligne, le portefeuille de démonstration reste une variable du navigateur, et il le dit à l'écran.
   Ce qui reste ouvert, et qui n'est pas un détail : **le job Postgres est vert une fois — le
   2026-09-15, run 34894629071 — et ce passage est ANTÉRIEUR à tout ce que la phase 04a a écrit en
   SQL.** Les quatre clauses ajoutées depuis — `paid_seats`, les deux index du plafond, `ledger_audit`,
   les deux clés étrangères passées en `restrict` — n'ont donc été subies par rien d'autre qu'une
   doublure, et un test qui passe contre la doublure prouve la doublure. Quatre propriétés n'ont de
   preuve que là : deux ouvertures simultanées sous le plafond, la requête de fenêtre qui ne balaie
   pas le livre, l'audit dont l'annulation est arbitrée par Postgres, et le `delete from users`
   refusé. Reste aussi le vol de *précision* — aimbot et ESP, entiers et structurels. **Aucun euro
   n'entre** : les crédits sont fictifs, dotés par la maison.
2. **Cadre légal.** Miser de l'argent réel sur ce type de jeu relève du droit des jeux d'argent
   dans la plupart des juridictions. À faire trancher par un avocat spécialisé avant tout
   branchement de paiement.

## Licence

Tous droits réservés — voir [LICENSE](LICENSE).
