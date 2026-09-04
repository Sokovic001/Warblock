# Journal de développement

Reconstitué à partir des sessions du 28 août au 4 septembre 2026. Ce document existe pour
qu'on ne refasse pas les erreurs déjà faites et qu'on ne revienne pas sur des pistes déjà
essayées et abandonnées.

---

## Comment le projet est né

La demande initiale : un battle royale en pixel/voxel avec des mises réelles — tuer les 19 autres
joueurs, le survivant emporte le pot. Les premières versions étaient injouables (« je me fais tuer
direct », « pas assez fluide »). La bascule décisive est venue au 4ᵉ tour : **prendre le gameplay
de Brawl Stars comme référence**, vue de dessus, tir automatique, brawlers à identité forte. Tout
ce qui a suivi découle de ce choix.

---

## Les décisions structurantes

| Décision | Pourquoi |
|---|---|
| **Vue de dessus type Brawl Stars** | Les premières itérations en vue subjective étaient illisibles et frustrantes. |
| **20 % de commission sur *tout* paiement** | Demandé explicitement, y compris pour un cash out sans aucun kill, et dans les deux jeux. Pas d'exception « zéro kill ». |
| **Deux jeux, pas deux modes** | MAXWIN (le pot au dernier debout) et RESURGENCE (bucket encaissable à tout moment) sont des économies différentes, pas des variantes. |
| **Tables à $0,50 / $1 / $5 / $10** | Remplacent des montants plus élevés testés au départ. Le sous-dollar force à calculer en centimes. |
| **Vitesse dérivée, jamais écrite à la main** | Un brawler avec beaucoup de PV, de la portée *et* de la vitesse serait dominant. `derivedSpeed()` calcule la vitesse à partir des PV, de la portée et d'un décalage d'agilité ; un test vérifie qu'aucun brawler n'en domine un autre. |
| **Un seul biome (FARM)** | Trois biomes cousus sur une même carte se lisaient mal et rendaient la minimap illisible. VOLCANO et SNOW restent définis, `BIOME_COUNT = 1` les réactive. |
| **3 vies (2 en Resurgence)** | Avec une seule vie, le dernier survivant était désigné vers 54 s alors que le gaz met 154 s à se refermer. Mesuré, pas supposé. |
| **Sas d'attente de 25 s** | Demandé pour simuler l'arrivée d'autres joueurs. Décompte 3-2-1 ensuite, sans bouton « prêt » : le joueur a déjà cliqué pour entrer. |

---

## Pistes essayées puis abandonnées

- **Lobby mobile refait de zéro, façon Brawl Stars** (personnage au centre, onglets latéraux) :
  trois tentatives, toutes rejetées pour superposition d'éléments. Retour à une version adaptée du
  lobby desktop. **Ne pas relancer ce chantier sans maquette validée d'abord.**
- **Buissons en sphères** : lus comme des cailloux. Puis en cônes pointus : lus comme des piques,
  « on n'ose pas rentrer dedans ». La forme qui fonctionne est le **cône tronqué**, large et bas.
- **Damier au sol** : lisait comme un plateau d'échecs vu de haut. Remplacé par des taches
  organiques au bruit.
- **Estimation pessimiste de la qualité graphique** : partir bas et remonter donnait une première
  partie laide sur un téléphone capable. On part maintenant optimiste et on corrige à la baisse.

---

## Bugs marquants et leur cause réelle

Ces cinq-là ont tous la même origine : une **édition automatisée par remplacement de texte**.

1. **Écran noir, « Script error » en boucle.** Un remplacement délimité par deux repères a effacé
   la scène, la caméra et l'éclairage, qui se trouvaient entre les deux. → *Vérifier le contenu
   d'une plage avant de la remplacer.*

2. **Dégâts invisibles, barres de vie figées.** Un commentaire `//` ajouté en fin d'une ligne
   existante a avalé la mise à jour de la barre de vie et des cubes, qui suivaient sur la même
   ligne. → *Un commentaire va sur sa propre ligne. Toujours.*

3. **Ombres de butin qui s'accumulent sur la carte.** Deux remplacements se chevauchaient : le
   premier créait l'ombre, le second devait la rattacher au butin mais son motif n'existait plus.
   L'ombre était donc créée sans jamais être supprimée.

4. **Pas de réapparition malgré les 3 vies.** `respawn()` s'est retrouvée **définie deux fois** ;
   la seconde, obsolète, exigeait un coéquipier vivant comme ancrage — inexistant en Solo.

5. **`rng is not a function`.** Un appel passait `chatRng()` (le nombre tiré) au lieu de
   `chatRng` (le générateur).

**Leçon transversale :** après toute édition automatisée, extraire les blocs `<script>` et lancer
`node --check` dessus, puis `node test.js`. Les trois quarts de ces bugs auraient été attrapés.

---

## Bugs de conception, plus intéressants que les bugs de code

- **Le compteur « 20 ALIVE » figé.** Avec 3 vies, un joueur tué reste en lice : le compteur ne
  bougeait qu'à la troisième mort. Corrigé en séparant **ALIVE** (debout maintenant) et **LEFT**
  (encore en lice).
- **Les cœurs qui donnaient des cubes.** L'apparence du cube de pouvoir avait été changée en cœur
  sans changer son effet. L'icône mentait. Les deux objets sont maintenant distincts : ⬢ cube
  (progression) et ♥ cœur (soin instantané).
- **Un clic qui coûtait deux munitions.** Le verrou de gâchette dure 0,63 s pour BOLT, or un clic
  humain « appuyé » dépasse cette durée. L'arme est devenue semi-automatique : le tir part sur
  l'événement d'appui, le tir continu ne démarre qu'après 0,35 s de maintien.
- **Le chat qui bloquait les commandes.** Le code se fiait à un drapeau interne au lieu du focus
  réel du champ. Cliquer ailleurs ne le remettait pas à zéro.
- **Icône illisible en petit.** Plusieurs propositions superbes en 512 px devenaient une tache à
  32 px. Toute icône se juge réduite, dans une grille, jamais isolée.

---

## Ce que l'utilisateur valide et rejette

- **Retour visuel immédiat par capture d'écran.** Les corrections passent par des captures
  annotées ; les rejets sont courts et directs (« ça ne va pas », « toujours trop gros »).
- **Compact et lisible avant tout.** Le HUD a été resserré plusieurs fois : trois panneaux empilés
  en haut à gauche masquaient précisément la zone d'où arrivent les adversaires.
- **Rien ne doit obstruer le jeu.** C'est le critère qui a tranché le placement du chat, des
  emotes, de la minimap et du compteur.
- **Esthétique cartoon assumée**, contours noirs épais, couleurs saturées, ombres portées.

---

## État à la V1

- 10 brawlers, 2 jeux, 5 modes, 4 tables, carte 152×152, un seul biome.
- 3 vies (2 en Resurgence), gaz en 4 phases, cubes de pouvoir et cœurs de soin.
- Profil avec pseudo et 20 avatars, chat texte avec réponses des bots, 8 emotes.
- Audio entièrement synthétisé : lobby, sas, partie, alarmes de zone, impacts.
- Qualité graphique adaptative à quatre niveaux, corrigée par les FPS mesurés.
- **117 tests**, sans dépendance.

## Ce qui reste ouvert

- **Lobby mobile** : la version actuelle est une adaptation du desktop, pas une conception propre.
- **Serveur autoritaire** : tout tourne dans le navigateur, le solde est modifiable depuis la console.
- **Cadre légal** avant tout argent réel.
- **Icône définitive** : plusieurs directions explorées, décision non figée.
