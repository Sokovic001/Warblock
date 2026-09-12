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
const secretKey = requis('CLERK_SECRET_KEY');
const port = Number(process.env.PORT || 8787);

const { pgDb } = require('./db-pg');
const { clerkVerifier } = require('./auth-clerk');

const db = pgDb(databaseUrl);
const app = createApp({
  db,
  verifyToken: clerkVerifier({ secretKey, authorizedParties: origins }),
  origins,
});

// Les erreurs internes partent dans les journaux, jamais dans la réponse du joueur.
app.onError = (e, route) => console.error(`[${new Date().toISOString()}] ${route} :`, e && e.stack || e);

const server = http.createServer((req, res) => { app(req, res); });
server.listen(port, () => console.log(`API Warblock sur le port ${port}, origines : ${origins.join(', ')}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => db.close().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
