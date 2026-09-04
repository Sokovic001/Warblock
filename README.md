# WARBLOCK

Battle royale en vue de dessus, avec mises. Deux jeux, dix brawlers, deux mille huit cents lignes
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
npm test        # 121 tests, sans dépendance
```

Les règles du jeu vivent dans un bloc pur (`WBCore`) à l'intérieur de `index.html`, sans DOM ni
WebGL. `test.js` extrait ce bloc et l'exécute dans Node : économie, paiements, génération de
carte, équilibrage des brawlers, files d'attente, chat, qualité graphique. Le rendu, lui, n'est
pas couvert — il demande un navigateur.

## Structure

```
index.html              le jeu entier
  ├── <style>           lobby, HUD, écrans
  ├── <script> WBCore   règles pures, testables      ← la partie couverte par les tests
  └── <script> Game     rendu Three.js, entrées, IA, audio
test.js                 harnais Node
manifest.webmanifest    « Ajouter à l'écran d'accueil » en plein écran
icon-*.png              icônes
docs/GAME-DESIGN.md     toutes les règles et les choix d'équilibrage
docs/HISTORIQUE.md      journal de développement : décisions, pistes abandonnées, bugs
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
| Gain | le pot au dernier debout | ton bucket, encaissable à tout moment |
| Rythme | ~2 min 30 | ~1 min 20 |

Commission de la maison : **20 % de tout paiement**, dans les deux jeux.
Tables : $0,50 · $1 · $5 · $10.

## Avant d'aller plus loin qu'un playtest

Deux chantiers avant d'envisager de l'argent réel, détaillés dans
[docs/DEPLOY.md](docs/DEPLOY.md) :

1. **Serveur autoritaire.** Toute la logique tourne dans le navigateur du joueur ; n'importe qui
   peut modifier son solde depuis la console. Mouvement, tirs, butin et paiements devront passer
   côté serveur.
2. **Cadre légal.** Miser de l'argent réel sur ce type de jeu relève du droit des jeux d'argent
   dans la plupart des juridictions. À faire trancher par un avocat spécialisé avant tout
   branchement de paiement.

## Licence

Tous droits réservés — voir [LICENSE](LICENSE).
