# Modèles de brawlers (.glb)

Un brawler peut être dessiné à partir d'un modèle 3D au lieu des cubes procéduraux de
`makeBrawlerMesh()`. C'est **entièrement optionnel** : sans fichier, le jeu tourne exactement
comme avant, sur les cubes.

Il n'y a **pas d'étape de build**. Les `.glb` sont préparés une fois à la main, commités, et
`index.html` les charge au démarrage. On ouvre toujours `index.html` et on joue.

## Fabriquer un modèle

1. **Générer** le personnage. Tripo (`tripo3d.ai`) produit un `.glb` ou un `.fbx` à partir d'un
   prompt ou d'une image de référence.
2. **Rigger et animer**, si tu veux autre chose qu'une pose fixe : Mixamo, en téléversant le
   modèle *With Skin*. Sans rig, le modèle reste en T-pose — c'est suffisant pour juger du look,
   pas pour jouer.
3. **Optimiser**, une seule commande, aucune dépendance à installer dans le dépôt :

   ```bash
   npx --yes @gltf-transform/cli@4 optimize brut.glb assets/brawlers/<id>.glb \
     --compress quantize --texture-compress webp --texture-size 512
   ```

   `quantize` et WebP sont tous deux lus par le GLTFLoader de r128. **Ne pas utiliser
   `--compress draco` ni `meshopt`** : ils réclament un décodeur séparé, une dépendance de plus
   au chargement.

   Ordre de grandeur mesuré sur un humanoïde texturé : **428 Ko → 151 Ko (−65 %)**.

4. **Déclarer** le modèle dans `index.html`, dans `BRAWLER_MODELS` :

   ```js
   const BRAWLER_MODELS = {
     bolt: 'assets/brawlers/bolt.glb',
   };
   ```

   La clé est l'`id` du brawler (`bolt`, `shell`, `brick`, `hex`, `pyro`, `medic`, `volt`,
   `ghost`, `rush`, `ward`).

5. **Vérifier** : `node test.js` (les 191 tests ne touchent pas au rendu, ils doivent rester
   verts), puis `npm start` et regarder la carte du brawler dans le lobby.

## Ce que le code fait pour toi

- **La mise à l'échelle est mesurée, pas configurée.** `fitBrawlerModel()` prend la boîte
  englobante, met le modèle à la hauteur d'un brawler cube (`BRAWLER_MODEL_HEIGHT`, 2.3),
  pose ses pieds au sol et le centre sur l'origine. Tripo, Mixamo et Blender sortent trois
  échelles et trois origines différentes : aucune n'a besoin d'être corrigée à la main.
- **Les matériaux sont aplatis.** `flattenMaterial()` remplace le PBR du `.glb`
  (`MeshStandardMaterial`) par du `MeshLambertMaterial`, couleur et texture conservées. Le monde
  est éclairé pour du Lambert — une hémisphérique et une directionnelle faible — et une surface
  metalness/roughness y ressort presque noire. C'est aussi ce qui garde le rendu à plat du jeu.
- **Les cubes ne sont pas supprimés, ils sont masqués.** Le code d'animation lit
  `mesh.children[0]` (flash de dégâts), `[3]` et `[4]` (jambes). Les indices restent valides,
  donc ce code n'a aucune connaissance du modèle.
- **Tout échoue proprement.** Fichier absent, fetch en erreur, `GLTFLoader` non chargé : un
  `console.warn` et on reste sur les cubes.

## Limites connues

- **Pas d'animation.** Les clips du `.glb` ne sont pas joués. Le modèle glisse au lieu de
  marcher, et le balancement des jambes s'applique à des cubes invisibles.
- **Le flash de dégâts ne se voit pas.** Il écrit `children[0].material.emissive`, c'est-à-dire
  le torse cube masqué. Le modèle ne clignote pas quand il est touché.
- **Les contours noirs disparaissent.** Les `outlineMat` appartiennent aux cubes. Un modèle n'a
  pas de contour, et c'est une bonne partie de la lisibilité en vue de dessus.

Ces trois points sont à traiter avant qu'un modèle remplace un brawler pour de bon. Ils ne
bloquent pas un test de direction artistique.
