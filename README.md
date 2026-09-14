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
npm test        # 410 tests sur le jeu + 215 sur l'API, sans dépendance
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
                        grand livre en partie double (phase 03)
manifest.webmanifest    « Ajouter à l'écran d'accueil » en plein écran
icon-*.png              icônes
docs/GAME-DESIGN.md     toutes les règles et les choix d'équilibrage
docs/HISTORIQUE.md      journal de développement : décisions, pistes abandonnées, bugs
docs/PHASE-02.md        la phase 02a : billet, verdict, statistiques par agrégat
docs/PHASE-02B.md       la phase 02b : pas fixe, bloc SIM, trace des entrées, rejeu serveur
docs/PHASE-03.md        la phase 03 : le grand livre en partie double, en crédits fictifs
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

1. **Le grand livre existe, et il n'a jamais vu une base.** Depuis la phase 03, le solde d'un
   joueur connecté est la **somme d'écritures immuables en centimes entiers** tenue par le serveur :
   dotation à la création du compte, mise débitée à l'ouverture du billet, gain écrit au règlement,
   quarantaine pour une partie dont le rejeu a divergé. Le jeu lit ce solde et ne l'écrit plus ; hors
   ligne, le portefeuille de démonstration reste une variable du navigateur, et il le dit à l'écran.
   Ce qui reste ouvert, et qui n'est pas un détail : **aucune vraie Postgres n'a jamais tourné.**
   `api/db-check.js` et son job d'intégration continue sont écrits, jamais verts — un test qui passe
   contre la doublure prouve la doublure, et le verrou de ligne qui empêche deux onglets de dépenser
   le même solde n'est éprouvé nulle part ailleurs. Reste aussi le vol de *précision* — aimbot et
   ESP, entiers et structurels. **Aucun euro n'entre** : les crédits sont fictifs, dotés par la
   maison.
2. **Cadre légal.** Miser de l'argent réel sur ce type de jeu relève du droit des jeux d'argent
   dans la plupart des juridictions. À faire trancher par un avocat spécialisé avant tout
   branchement de paiement.

## Licence

Tous droits réservés — voir [LICENSE](LICENSE).
