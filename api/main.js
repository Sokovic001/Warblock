// Le point d'entrée : il assemble les adaptateurs réels et écoute. Tout ce qui est vérifiable sans
// base ni compte se trouve dans app.js, et est couvert par api/test.js.
'use strict';
const http = require('node:http');
const { createApp } = require('./app');

// On refuse de démarrer plutôt que de tourner à moitié configuré. Un serveur qui démarre sans savoir
// quelles origines il autorise est un serveur qui les autorise toutes.
function requis(nom) {
  const v = process.env[nom];
  if (!v) { console.error(`Variable ${nom} manquante. Voir api/.env.example.`); process.exit(1); }
  return v;
}

const origins = requis('APP_ORIGINS').split(',').map(s => s.trim()).filter(Boolean);
const databaseUrl = requis('DATABASE_URL');
const apiKey = requis('CROSSMINT_SERVER_API_KEY');
const port = Number(process.env.PORT || 8787);

const { pgDb } = require('./db-pg');
const { crossmintVerifier } = require('./auth-crossmint');

// Une clé d'API illisible, d'un mauvais environnement ou tronquée fait échouer le démarrage ici,
// avec un message qui dit quoi corriger. Jamais à la première connexion d'un joueur.
let verifyToken;
try {
  verifyToken = crossmintVerifier({ apiKey, jwksUrl: process.env.CROSSMINT_JWKS_URL });
} catch (e) {
  console.error(e && e.message || e);
  process.exit(1);
}

const db = pgDb(databaseUrl);
const app = createApp({ db, verifyToken, origins });

// Les erreurs internes partent dans les journaux, jamais dans la réponse du joueur.
app.onError = (e, route) => console.error(`[${new Date().toISOString()}] ${route} :`, e && e.stack || e);

// Le veilleur : il clôt les billets que personne n'a terminés. Une minute d'intervalle, parce que
// rien ne presse — un billet reste ouvert de deux à quatre minutes selon le mode, et le balayage
// ne fait que libérer la place d'un joueur parti. Une erreur de base ne doit pas tuer le serveur :
// elle se journalise, et le tour suivant réessaiera.
const VEILLE_MS = 60_000;
const veille = setInterval(() => {
  app.veiller().catch(e => console.error(`[${new Date().toISOString()}] veilleur :`, e && e.stack || e));
}, VEILLE_MS);
// Sans `unref`, ce minuteur empêcherait le processus de s'arrêter tout seul.
veille.unref();

// LA PURGE DES TRACES, ET ELLE A SON PROPRE MINUTEUR. Une heure, et pas une minute : elle efface la
// pièce qui prouve un paiement, et il n'y a aucune raison de faire passer ce `delete`-là dans le
// même tour d'horloge qu'une clôture de routine. Rien ne presse non plus — la rétention se compte en
// centaines de jours, donc une heure de retard sur un effacement n'a aucun effet observable.
// Une erreur de base se journalise et le tour suivant réessaiera : la purge est bornée et
// idempotente par nature, une trace déjà effacée ne se réefface pas.
const PURGE_MS = 3600_000;
const purge = setInterval(() => {
  app.purger().catch(e => console.error(`[${new Date().toISOString()}] purge des traces :`, e && e.stack || e));
}, PURGE_MS);
purge.unref();

const server = http.createServer((req, res) => { app(req, res); });
server.listen(port, () => {
  console.log(`API Warblock sur le port ${port}, origines : ${origins.join(', ')}`);
  // Ni l'un ni l'autre n'est un secret : l'identifiant de projet voyage dans chaque jeton, et
  // l'environnement se lit dans le préfixe de la clé. Les afficher évite de découvrir trois jours
  // plus tard qu'on tourne en staging.
  console.log(`Crossmint : ${verifyToken.environment}, projet ${verifyToken.projectId}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(veille);
    clearInterval(purge);
    server.close(() => db.close().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
