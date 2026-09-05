# Mettre le dépôt sur GitHub

## Avec Claude Code (tu viens d'installer l'app GitHub)

Place ces fichiers dans un dossier, ouvre-le dans ton terminal, puis :

```bash
git init
git add .
git commit -m "WARBLOCK V1"
git branch -M main

gh repo create warblock --public --source=. --push
```

Si tu préfères créer le dépôt à la main sur github.com, remplace la dernière ligne par :

```bash
git remote add origin https://github.com/TONPSEUDO/warblock.git
git push -u origin main
```

## Activer la publication

*Settings → Pages → Build and deployment → Source : **GitHub Actions*** — et c'est tout.
Le workflow `.github/workflows/pages.yml` est déjà dans le dépôt : à chaque push sur `main`,
il lance les tests, et ne publie **que s'ils passent**.

Adresse finale : `https://TONPSEUDO.github.io/warblock/`

## Publier une mise à jour

```bash
git add .
git commit -m "ce que j'ai changé"
git push
```

Une minute plus tard, le site est à jour. L'onglet *Actions* montre le détail si quelque chose échoue.

## Travailler avec Claude Code sur ce dépôt

Le fichier `CLAUDE.md` à la racine donne à Claude le contexte du projet : l'architecture en trois
blocs, l'obligation de faire passer les tests, et surtout les pièges d'édition qui ont déjà cassé
le jeu. Il est lu automatiquement.

Quelques demandes qui fonctionnent bien :

```
Ajoute un onzième brawler, un tank à courte portée. Respecte derivedSpeed()
et vérifie qu'aucun brawler n'en domine un autre. Lance les tests.

Le gaz fait trop mal en phase 3. Baisse-le et ajuste le test de rythme.

Extrais la logique de réapparition dans WBCore et écris-lui des tests.
```

Une fois l'app GitHub installée sur le dépôt, tu peux aussi ouvrir une issue et mentionner
`@claude` dedans pour qu'il propose un correctif en pull request.

## Le versionnage du build

Le lobby affiche `V1 · demo credits only` en bas. Quand tu publies une nouvelle version,
change cette chaîne dans `index.html` (cherche `id="build"`) : quand un testeur te remonte un
bug, tu sauras de quelle version il parle.
