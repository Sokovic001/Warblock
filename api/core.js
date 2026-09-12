// Le serveur ne redéfinit jamais une règle du jeu : il charge le même bloc WBCore que le navigateur,
// depuis le même index.html. Une règle corrigée dans le jeu l'est du même coup ici, et les 198 tests
// de test.js couvrent les deux côtés à la fois. C'est ce qui rend la phase 02 possible sans réécrire
// quoi que ce soit : le jour où le serveur simulera les parties, il aura déjà les vraies règles.
'use strict';
const fs = require('fs'), path = require('path');

const GAME = process.env.WARBLOCK_FILE || path.join(__dirname, '..', 'index.html');
const START = '/*CORE-START*/', END = '/*CORE-END*/';

const html = fs.readFileSync(GAME, 'utf8');
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0 || b <= a) {
  throw new Error(`Bloc WBCore introuvable dans ${GAME} : les marqueurs ${START} / ${END} ont bougé.`);
}

const mod = { exports: {} };
new Function('module', 'exports', html.slice(a, b))(mod, mod.exports);

// Une garde volontairement bruyante : si le cœur change de forme, on veut casser au démarrage du
// serveur, pas à la première requête d'un joueur.
for (const nom of ['sanitizeName', 'validName', 'nameKey', 'NAME']) {
  if (mod.exports[nom] === undefined) throw new Error(`WBCore n'exporte plus ${nom}.`);
}

module.exports = mod.exports;
