# Mettre WARBLOCK V1 en ligne

Le jeu est **un seul fichier statique**. Aucun serveur, aucune base, aucune compilation :
n'importe quel hébergeur de fichiers statiques suffit, et les options ci-dessous sont gratuites.

Contenu du dossier :

```
index.html              le jeu entier
manifest.webmanifest    permet « Ajouter à l'écran d'accueil » en plein écran
icon-192.png            icône
icon-512.png            icône (grande + aperçu de lien)
icon-180.png            icône iOS
```

---

## Option 1 — Netlify Drop (le plus rapide, ~1 minute)

1. Va sur **https://app.netlify.com/drop**
2. Glisse-dépose **le dossier entier** (pas seulement `index.html`) dans la page.
3. Tu obtiens aussitôt une adresse du type `https://sparkly-cat-1a2b3c.netlify.app`.
4. Crée un compte gratuit pour garder l'adresse et pouvoir la renommer
   (*Site settings → Change site name* → `warblock`).

Pour publier une nouvelle version : reglisse le dossier, l'adresse ne change pas.

## Option 2 — GitHub Pages (adresse durable, historique des versions)

1. Crée un dépôt **public** nommé `warblock` sur github.com.
2. Téléverse les 5 fichiers à la racine (bouton *Add file → Upload files*).
3. *Settings → Pages → Source: Deploy from a branch → Branch: `main` / `root` → Save*.
4. Une minute plus tard : `https://TONPSEUDO.github.io/warblock/`

Avantage : chaque mise à jour est versionnée, tu peux revenir en arrière.

## Option 3 — Cloudflare Pages (le plus rapide à l'étranger)

1. **https://pages.cloudflare.com** → *Create a project* → *Direct Upload*.
2. Glisse le dossier, valide.
3. Adresse en `https://warblock.pages.dev`.

Réseau mondial : utile si tes testeurs ne sont pas tous en Europe.

## Option 4 — itch.io (fait pour les playtests)

1. **https://itch.io/game/new**, *Kind of project* → **HTML**.
2. Zippe le dossier et téléverse le `.zip`, coche *This file will be played in the browser*.
3. Viewport : **1280 × 720**, coche *Fullscreen button* et *Mobile friendly*.
4. Visibilité **Restricted** avec un mot de passe si tu veux limiter l'accès à tes amis.

Avantage : commentaires et statistiques intégrés, et le lien ne fuite pas.

---

## Une fois en ligne

- **Sur téléphone**, dis à tes testeurs d'ouvrir le lien puis *Partager → Ajouter à l'écran d'accueil*.
  Le jeu passe alors en plein écran paysage sans barre de navigateur.
- **Le lien partagé affiche un aperçu** (titre, description, icône) dans WhatsApp, iMessage ou Discord.
- **La mention « V1 · demo credits only »** est affichée en bas du lobby : quand un testeur te
  remonte un bug, tu sauras de quelle version il parle. Incrémente-la à chaque build.

## Ce qu'il faut demander aux testeurs

Trois questions valent mieux qu'un formulaire long :

1. Sur quel appareil et quel navigateur ? Les FPS affichés dans le menu pause (Échap ou ▐▐).
2. Qu'est-ce qui n'était pas clair dans les 30 premières secondes ?
3. À quel moment as-tu eu envie de relancer une partie — ou d'arrêter ?

## Avant d'aller plus loin qu'un test entre amis

Cette V1 tourne **en local, avec des crédits fictifs** : chaque adversaire est un bot, la
population affichée est simulée, et rien n'est enregistré côté serveur. C'est exactement ce
qu'il faut pour tester des sensations de jeu.

Deux points à traiter **avant** d'envisager de l'argent réel :

- **Serveur autoritaire.** Toute la logique tourne aujourd'hui dans le navigateur du joueur.
  N'importe qui peut modifier son solde ou ses dégâts depuis la console. Il faudra déplacer
  mouvement, tirs, butin et paiements côté serveur, le client ne faisant plus qu'afficher.
- **Cadre légal.** Miser de l'argent réel sur ce type de jeu relève du droit des jeux d'argent
  dans la plupart des juridictions — licence, vérification d'âge, lutte anti-blanchiment,
  et des règles qui diffèrent d'un pays à l'autre. Je ne suis pas juriste : c'est la question
  à faire trancher par un avocat spécialisé avant de brancher le moindre paiement.

Tant que les crédits restent fictifs et non rechargeables contre de l'argent, tu es sur le
terrain de la démo de jeu, et le partage à des amis ne pose pas de difficulté.
