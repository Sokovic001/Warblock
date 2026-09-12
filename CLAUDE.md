# Contexte pour Claude Code

## Ce qu'est ce dépôt

Un jeu HTML5 complet dans **un seul fichier**, `index.html` : styles, règles et rendu.
Pas de build, pas de bundler, pas de `node_modules`. Three.js r128 est chargé depuis un CDN.

À côté, depuis la phase 01 du chantier « argent réel », un dossier `api/` : un petit serveur Node
qui détient les comptes et les profils. **Le jeu reste un seul fichier statique** ; il appelle
l'API par HTTPS. L'API ne recopie aucune règle : `api/core.js` charge le bloc `WBCore` depuis
`index.html`, celui-là même que le navigateur exécute.

L'identité vient de **Crossmint** : connexion par email, et le portefeuille dont la phase 04 aura
besoin naîtra du même compte. Le serveur ne dépend que de `jose` pour la cryptographie, et décide
lui-même de ce qu'il accepte d'un jeton — le SDK du fournisseur ne vérifie pas `aud`, donc il ne
peut pas tenir ce rôle seul. Détails et raisons dans `api/README.md`.

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
- **Lancer `npm test` après chaque modification.** 213 tests sur le jeu (`node test.js`) et
  57 sur l'API (`node api/test.js`), aucune dépendance ni base de données pour les uns comme
  pour les autres. `api/test.js` en ajoute neuf, de bout en bout avec de la vraie cryptographie,
  quand `jose` est installé — l'intégration continue le lance deux fois, avant et après
  installation, pour que les deux promesses tiennent.
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
- Les trois parts de `BOX_DROP` font toujours 1, et le cube reste le drop le plus courant.
- Les fumigènes restent rares : rien ne se recharge avec le temps, et tout le stock de caisses
  d'un mode donne moins d'une grenade par joueur — vérifié sur les cinq modes.
- La fuite est garantie : un fumigène lâché à ses pieds cache le lanceur de tout adversaire situé
  au-delà de deux blocs, sous n'importe quel angle et à n'importe quelle distance.
- Le sens unique de la fumée est borné : la fenêtre appartient à l'équipe qui a lancé et se ferme
  avant que le nuage ne commence à se dissiper. Passé la fenêtre, le nuage aveugle les deux côtés.
- La fumée n'arrête jamais un projectile, et ne cache jamais quelqu'un collé à soi.

## Argent des joueurs

Le plan complet est en sept phases, et **l'ordre n'est pas négociable** : le serveur doit posséder
l'état du jeu avant qu'un euro n'entre. Aujourd'hui `wallet` est une variable du navigateur, donc
tout solde y est modifiable depuis la console.

- Phase 01 — comptes et profils. **Faite** : `api/` côté serveur, et l'écran de connexion dans le
  jeu, par les routes de code email de Crossmint. Pas de React, pas de bundler : `index.html` reste
  un seul fichier, et reste jouable sans compte. Une ligne à remplir, `ACCOUNT.api`, le jour où le
  serveur tournera quelque part.
- Phase 02 — le serveur devient l'autorité du jeu. `WBCore` tourne déjà dans Node, c'est le socle.
- Phase 03 — grand livre en partie double, éprouvé en crédits fictifs. Entiers en centimes, jamais
  de flottant, jamais d'écrasement de solde.
- Phases 04 à 06 — dépôts, retraits, exploitation. **Rien de réel avant que 01 à 03 soient finies.**

Règles qui tiennent dès maintenant : aucune colonne « solde » en base tant que le grand livre
n'existe pas ; le client ne peut écrire que son pseudo, son avatar et son pays ; aucun secret dans
le dépôt, `.env` est ignoré.

## Historique

`docs/HISTORIQUE.md` retrace les décisions prises, les pistes abandonnées et les bugs déjà
rencontrés avec leur cause réelle. À lire avant de relancer un chantier (notamment le lobby
mobile, tenté trois fois et abandonné) ou avant de rouvrir une décision d'équilibrage.

## Ce qui n'est pas réel

Population en ligne, files d'attente, gains affichés, adversaires : **tout est simulé**. Le jour
où un backend existera, ces fonctions doivent être remplacées par les compteurs du serveur, pas
conservées.
