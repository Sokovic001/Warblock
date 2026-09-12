// Le serveur ne redéfinit jamais la simulation du jeu : il charge le même bloc `WBSim` que le
// navigateur, depuis le même index.html, et il lui donne le même `WBCore` — celui que `api/core.js`
// a déjà extrait du même fichier. Calqué ligne pour ligne sur `api/core.js`, garde bruyante
// comprise : c'est ce qui fait que « l'API ne recopie jamais une règle du jeu » vaut aussi pour la
// simulation, et pas seulement pour les règles pures.
//
// Le bloc est une IIFE qui publie `WBSim` et se termine par un `module.exports` conditionnel : la
// même ligne sert au navigateur, à `test.js` et ici. Il reçoit `WBCore` en paramètre, exactement
// comme le navigateur le lui donne en variable globale.
'use strict';
const fs = require('fs'), path = require('path');
const C = require('./core');

const GAME = process.env.WARBLOCK_FILE || path.join(__dirname, '..', 'index.html');
const START = '/*SIM-START*/', END = '/*SIM-END*/';

const html = fs.readFileSync(GAME, 'utf8');
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0 || b <= a) {
  throw new Error(`Bloc WBSim introuvable dans ${GAME} : les marqueurs ${START} / ${END} ont bougé.`);
}

const mod = { exports: {} };
new Function('module', 'exports', 'WBCore', html.slice(a, b))(mod, mod.exports, C);

// Une garde volontairement bruyante, pour la même raison que celle de `api/core.js` : si le bloc
// change de forme, on veut casser au démarrage du serveur, pas à la première requête d'un joueur
// un dimanche soir.
//
// LA LISTE EST LE CONTRAT PUBLIC DU BLOC, plus tout ce qu'`api/app.js` consomme réellement. Un test
// d'`api/test.js` compare les deux : toute route qui appellera un nouveau nom de `WBSim` l'ajoute
// ici, sans quoi la panne se déplace du démarrage vers le premier joueur.
const ATTENDUS = ['SIM_VERSION', 'EMPREINTE_PAS', 'newMatch', 'step', 'drainer', 'condenseEtat',
                  'empreinte', 'appliquerActe', 'rejouer'];
for (const nom of ATTENDUS) {
  if (mod.exports[nom] === undefined) throw new Error(`WBSim n'exporte plus ${nom}.`);
}
// `SIM_VERSION` est écrite sur chaque billet à son ouverture : si elle cessait d'être un entier
// positif, la colonne l'accepterait sans un mot et le rejeu du module 7 comparerait des `NaN`.
if (!Number.isInteger(mod.exports.SIM_VERSION) || mod.exports.SIM_VERSION < 1) {
  throw new Error(`WBSim.SIM_VERSION doit être un entier positif, reçu ${mod.exports.SIM_VERSION}.`);
}

module.exports = mod.exports;
