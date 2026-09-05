# Contexte pour Claude Code

## Ce qu'est ce dépôt

Un jeu HTML5 complet dans **un seul fichier**, `index.html` : styles, règles et rendu.
Pas de build, pas de bundler, pas de `node_modules`. Three.js r128 est chargé depuis un CDN.

## Architecture

`index.html` contient trois parties, dans cet ordre :

1. `<style>` — lobby, HUD, sas d'attente, écrans de fin.
2. `<script>` **`WBCore`** — les règles pures, entre les marqueurs `/*CORE-START*/` et
   `/*CORE-END*/`. Aucun accès au DOM ni à Three.js. C'est la seule partie testée.
3. `<script>` **Game** — rendu Three.js, entrées clavier/tactile, IA des bots, audio, HUD.

## Règles de travail

- **Toute logique de règle va dans `WBCore`**, avec un test dans `test.js`. Le reste du fichier
  n'est pas testable automatiquement (il lui faut un navigateur), donc plus la logique y descend,
  mieux le projet se porte.
- **Lancer `node test.js` après chaque modification.** 121 tests, aucune dépendance.
- **Vérifier la syntaxe des blocs `<script>`** après une édition automatisée : une regex qui
  extrait les blocs puis `node --check` attrape les erreurs avant d'ouvrir le navigateur.
- **Ne jamais mettre un commentaire `//` en fin d'une ligne existante** lors d'une édition par
  remplacement de texte : si du code suit sur la même ligne, il est avalé silencieusement. Ce
  piège a cassé le jeu deux fois. Un commentaire va sur sa propre ligne.
- **Attention aux plages de remplacement.** Remplacer tout ce qui se trouve entre deux repères
  a déjà supprimé la caméra et l'éclairage par accident. Vérifier ce que contient la plage.
- **L'argent se calcule au centime** via `cents()`. Les mises descendent à $0,50 : un arrondi à
  l'entier efface la commission.

## Invariants tenus par les tests

- Le pot se partage sans reste en Duo et en Trio, sur les quatre tables.
- Aucun brawler n'en domine un autre à la fois en PV, portée et vitesse.
- La carte est **entièrement** connexe : aucune case praticable n'est coupée du centre, sur
  aucune graine. Le seuil de 97 % qui figurait ici tolérait une pièce scellée de 23×23, et
  n'était de toute façon testé que sur la graine 9. Une passe de réparation, à la fin de
  `generateMap()`, libère les props qui emmurent puis tunnelle les poches fermées par les murs.
- La vitesse d'un brawler est toujours celle que donne `derivedSpeed()`, jamais une valeur écrite
  à la main.
- Les montants du bandeau « live wins » sont produits par les vraies fonctions de paiement.

## Historique

`docs/HISTORIQUE.md` retrace les décisions prises, les pistes abandonnées et les bugs déjà
rencontrés avec leur cause réelle. À lire avant de relancer un chantier (notamment le lobby
mobile, tenté trois fois et abandonné) ou avant de rouvrir une décision d'équilibrage.

## Ce qui n'est pas réel

Population en ligne, files d'attente, gains affichés, adversaires : **tout est simulé**. Le jour
où un backend existera, ces fonctions doivent être remplacées par les compteurs du serveur, pas
conservées.
