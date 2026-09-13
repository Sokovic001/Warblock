// Lancer : DATABASE_URL=postgres://… node api/db-check.js
//
// CE QUE CE SCRIPT EST, ET CE QU'IL N'EST PAS.
//
// Depuis la phase 01, le dossier répète une phrase : « un test qui passe contre la doublure prouve
// la doublure ». `api/test.js` tourne sans base et sans réseau — c'est une règle non négociable, et
// elle ne bouge pas — mais sa doublure IMITE les contraintes de Postgres au lieu de les subir.
// `name_key`, l'index partiel « un seul billet ouvert », `on conflict do nothing` sur
// `(match_id, seq)` et la clause `where status = 'open' and net_cents is null` n'ont donc jamais été
// éprouvés contre une vraie base. La phase 03 en ajoute deux de plus, et un paiement en dépend.
//
// Ce script applique `schema.sql` à une VRAIE Postgres et éprouve contre elle, en les citant
// nommément, chacune de ces contraintes. Il contient aussi le SEUL test qui ne peut exister nulle
// part ailleurs : deux transactions CONCURRENTES qui débitent le même compte se sérialisent au lieu
// de se croiser. Une doublure JavaScript mono-fil sérialise gratuitement ce que Postgres ne
// sérialise que si on le lui demande correctement — un verrou éprouvé en série ne prouve rien, et le
// journal a déjà payé une fois pour un harnais qui recopiait ce qu'il devait vérifier.
//
// IL N'ENTRE PAS DANS `npm test`. Sans `DATABASE_URL` il sort 0 en le disant, personne n'est bloqué,
// et l'intégration continue existante ne change pas d'une ligne. Un job séparé, avec un service
// `postgres`, le lance — voir `.github/workflows/test.yml`.
//
// ET IL EST HONNÊTE SUR CE QU'IL VAUT : livrer un script n'est pas l'avoir lancé. Tant que le job
// n'a pas été vert une fois, la phrase du dossier reste vraie.
//
// AVERTISSEMENT : il ÉCRIT et il EFFACE dans la base qu'on lui donne. Donnez-lui une base jetable —
// celle du service d'intégration continue, ou une locale créée pour l'occasion.
'use strict';

// Le contrôle de `DATABASE_URL` est AVANT tout `require` de `pg` : `api/test.js` lance ce script
// avec un environnement vidé pour vérifier qu'il sort 0, et il le fait aussi dans l'intégration
// continue AVANT `npm install`. Un `require('pg')` en tête de fichier ferait échouer ce lancement-là
// avec un « module introuvable », c'est-à-dire un code de sortie 1 sur une machine parfaitement
// saine.
const URL_BASE = process.env.DATABASE_URL;
if (!URL_BASE) {
  console.log('db-check : DATABASE_URL n\'est pas définie — aucune base à éprouver, on sort 0.');
  console.log('           Ce script ne fait PAS partie de `npm test`, qui tourne sans base et sans');
  console.log('           réseau. Tant que son job d\'intégration continue n\'a pas été vert une');
  console.log('           fois, un test qui passe contre la doublure prouve la doublure.');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const C = require('./core');
const L = require('./ledger');
const { pgDb, ledgerWrite, ledgerSolde, ledgerDe } = require('./db-pg');

// La même règle que `db-pg.js` : une connexion à la base d'un jeu d'argent ne se fait pas en clair,
// sauf en local — et le service de l'intégration continue EST en local, sur 127.0.0.1.
const pool = new Pool({
  connectionString: URL_BASE,
  ssl: /localhost|127\.0\.0\.1/.test(URL_BASE) ? false : { rejectUnauthorized: true },
  max: 6,
  connectionTimeoutMillis: 10_000,
});

let reussis = 0, echoues = 0;
// La connexion que les scénarios se partagent. Elle est ici pour qu'un scénario qui échoue AVANT son
// `rollback` ne laisse pas la transaction en échec : sans cela, la première panne ferait tomber tous
// les scénarios suivants, et on ne saurait plus lequel a réellement cédé.
let partage = null;
async function cas(nom, fn) {
  try {
    await fn();
    reussis++;
    console.log('  ✓', nom);
  } catch (e) {
    echoues++;
    console.log('  ✗', nom, '\n     ', (e && e.message) || e);
  } finally {
    if (partage) await partage.query('rollback').catch(() => {});
  }
}

// Un raccourci pour « cette requête doit être REFUSÉE, et par cette contrainte-là ». Un test qui se
// contente de « ça a levé » passerait sur une faute de frappe dans un nom de colonne.
async function refuse(client, code, motifAttendu, requete, valeurs) {
  // Chaque tentative refusée vit dans son propre point de reprise : sans cela la transaction
  // entière part en échec et les vérifications suivantes ne mesurent plus rien.
  await client.query('savepoint essai');
  try {
    await client.query(requete, valeurs);
  } catch (e) {
    await client.query('rollback to savepoint essai');
    if (e.code !== code) throw new Error(`code ${e.code} au lieu de ${code} (${e.message})`);
    const dit = `${e.constraint || ''} ${e.message || ''}`;
    if (!dit.includes(motifAttendu)) {
      throw new Error(`refusé, mais pas par « ${motifAttendu} » : ${dit}`);
    }
    return e;
  }
  await client.query('rollback to savepoint essai');
  throw new Error('la base a ACCEPTÉ ce qu\'elle devait refuser');
}

const pause = ms => new Promise(r => setTimeout(r, ms));

// ---------- de quoi peupler ----------
const DANS_UNE_HEURE = new Date(Date.now() + 3600_000);
const MAINTENANT = new Date();
const SECRETE = 'a'.repeat(32);

async function creerJoueur(client, nom) {
  const r = await client.query(
    `insert into users (auth_id, email, name, name_key)
     values ($1,$2,$3,$4) returning id`,
    [`auth-${nom}`, `${nom}@exemple.test`, nom, C.nameKey(nom)]);
  return r.rows[0].id;
}

async function ouvrirBillet(client, userId, extra = {}) {
  const r = await client.query(
    `insert into matches (user_id, mode, stake_cents, seats, team_size, brawler, seed_public,
                          seed_secret, sim_version, client_key, status, opened_at, expires_at)
     values ($1,'solo',50,20,1,'bolt',12345,$2,1,$3,$4,$5,$6) returning id`,
    [userId, SECRETE, extra.clientKey || `cle-${Math.random()}`, extra.status || 'open',
     MAINTENANT, extra.expiresAt || DANS_UNE_HEURE]);
  return r.rows[0].id;
}

async function main() {
  console.log('db-check : la vraie Postgres, et les contraintes que la doublure se contente d\'imiter\n');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  partage = client;
  try {
    await client.query(schema);
    console.log('  · schema.sql appliqué');
    // Une base jetable, et on le dit. L'ordre suit les dépendances ; `cascade` couvre le reste.
    await client.query('truncate ledger_entries, match_traces, matches, users restart identity cascade');

    // ---------------------------------------------------------------------------------------
    await cas('name_key : deux pseudos qui se replient sur la même clé, le second REFUSÉ', async () => {
      await client.query('begin');
      const un = C.nameKey('Loïc'), deux = C.nameKey('LOIC');
      if (un !== deux) throw new Error('WBCore.nameKey ne replie plus ces deux pseudos');
      await client.query(
        `insert into users (auth_id, email, name, name_key) values ('a1','a@x.test','Loïc',$1)`, [un]);
      await refuse(client, '23505', 'name_key',
        `insert into users (auth_id, email, name, name_key) values ('a2','b@x.test','LOIC',$1)`, [deux]);
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('un seul billet ouvert : l\'index PARTIEL refuse le second, et libère la place au premier clos', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Ouvert');
      const premier = await ouvrirBillet(client, u);
      await refuse(client, '23505', 'matches_un_seul_ouvert',
        `insert into matches (user_id, mode, stake_cents, seats, team_size, brawler, seed_public,
                              seed_secret, sim_version, client_key, status, opened_at, expires_at)
         values ($1,'solo',50,20,1,'bolt',999,$2,1,'autre','open',$3,$4)`,
        [u, SECRETE, MAINTENANT, DANS_UNE_HEURE]);
      // L'index est PARTIEL : une fois la partie close, la place se libère d'elle-même. C'est
      // exactement ce que la doublure imite, et qui n'avait jamais été vu tourner.
      await client.query(`update matches set status = 'expired' where id = $1`, [premier]);
      await ouvrirBillet(client, u, { clientKey: 'apres' });
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('match_traces : `on conflict do nothing` sur (match_id, seq) n\'écrit rien et ne lève pas', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Trace');
      const m = await ouvrirBillet(client, u);
      const poser = data => client.query(
        `insert into match_traces (match_id, seq, sim_version, steps, data)
         values ($1,0,1,10,$2) on conflict do nothing`, [m, data]);
      await poser('PREMIER');
      // Le second ne lève pas — c'est tout l'intérêt du `do nothing` — et il n'écrit rien : le
      // PREMIER écrit gagne, y compris quand les données diffèrent.
      await poser('SECOND');
      const r = await client.query('select data from match_traces where match_id = $1', [m]);
      if (r.rows.length !== 1) throw new Error(`${r.rows.length} lignes de trace au lieu d'une`);
      if (r.rows[0].data !== 'PREMIER') throw new Error('le second envoi a réécrit la première ligne');
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('le règlement : `where status = \'open\' and net_cents is null` ne touche aucune ligne la seconde fois', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Regle');
      const m = await ouvrirBillet(client, u);
      const regler = net => client.query(
        `update matches set status = 'settled', settled_at = now(), issue = 'defaite',
                            gross_cents = 0, fee_cents = 0, net_cents = $2
           where id = $1 and status = 'open' and net_cents is null`, [m, net]);
      const un = await regler(0);
      if (un.rowCount !== 1) throw new Error('le premier règlement n\'a pas écrit');
      const deux = await regler(999);
      if (deux.rowCount !== 0) throw new Error('un second règlement a touché une ligne déjà close');
      const r = await client.query('select net_cents from matches where id = $1', [m]);
      if (r.rows[0].net_cents !== 0) throw new Error('le montant a été réécrit');
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('le grand livre : la clé (motif, reference, compte_debit, compte_credit) REFUSE la seconde, elle ne l\'avale pas', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Cle');
      const m = await ouvrirBillet(client, u);
      const mise = L.mouvementMise({ userId: u, matchId: m, miseCents: 50 });
      // L'écrivain du pilote, tel quel : c'est lui qu'on éprouve, pas une requête réécrite pour
      // l'occasion. Un harnais qui recopie ce qu'il vérifie ne vérifie rien.
      await ledgerWrite(client, mise);
      await refuse(client, '23505', 'ledger_entries_mouvement_uniq',
        `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
         values ($1,$2,$3,$4,$5)`,
        [mise[0].motif, mise[0].reference, mise[0].compteDebit, mise[0].compteCredit,
         mise[0].montantCents]);
      const relu = await ledgerDe(client, { reference: mise[0].reference });
      if (relu.length !== 1) throw new Error(`${relu.length} lignes au lieu d'une`);
      if (typeof relu[0].montant_cents !== 'number') throw new Error('un montant relu en chaîne');
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('le grand livre : la grammaire, les comptes distincts et le montant strictement positif', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Gram');
      const bon = L.compteJoueur(u);
      const poser = (debit, credit, montant) => [
        `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
         values ('dotation','g',$1,$2,$3)`, [debit, credit, montant]];
      // Un compte hors grammaire, un zéro de tête compris : `joueur:007:disponible` et
      // `joueur:7:disponible` seraient deux comptes pour un seul joueur.
      for (const mauvais of ['joueur:1', 'joueur:007:disponible', 'maison:tresorerie', 'enjeu:0', '']) {
        await refuse(client, '23514', 'ledger_compte_credit_grammaire',
          ...poser(L.MAISON_DOTATION, mauvais, 10));
      }
      // Les deux colonnes portent la contrainte, pas seulement celle qu'on regarde d'habitude.
      await refuse(client, '23514', 'ledger_compte_debit_grammaire',
        ...poser('joueur:0:disponible', bon, 10));
      await refuse(client, '23514', 'ledger_comptes_distincts', ...poser(bon, bon, 10));
      for (const montant of [0, -10]) {
        await refuse(client, '23514', 'ledger_entries_montant_cents_check',
          ...poser(L.MAISON_DOTATION, bon, montant));
      }
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('la grammaire des comptes se comporte PAREIL dans Postgres et dans JavaScript', async () => {
      // `api/test.js` compare les deux TEXTES, caractère pour caractère ; il ne peut pas comparer
      // les deux MOTEURS. Postgres applique une expression POSIX, JavaScript la sienne : deux
      // dialectes qui s'accordent ici, et rien ne le disait. Un désaccord ferait passer en base un
      // compte que le code refuse, ou l'inverse — et c'est le second cas qui coûte cher, puisqu'il
      // ne se verrait qu'au premier joueur d'un certain identifiant.
      const echantillon = [
        'joueur:1:disponible', 'joueur:1:quarantaine', 'joueur:987654321:disponible', 'enjeu:7',
        L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE,
        'joueur:1', 'joueur:1:autre', 'joueur:0:disponible', 'joueur:01:disponible',
        'joueur:-1:disponible', 'joueur:a:disponible', 'enjeu:', 'enjeu:0', 'maison',
        'maison:autre', 'maison:dotation:1', '', ' enjeu:1', 'enjeu:1\nmaison:dotation',
      ];
      for (const c of echantillon) {
        const r = await client.query('select $1::text ~ $2::text as ok', [c, L.COMPTE_RE_SQL]);
        const attendu = L.COMPTE_RE.test(c);
        if (r.rows[0].ok !== attendu) {
          throw new Error(`« ${c} » : Postgres dit ${r.rows[0].ok}, JavaScript dit ${attendu}`);
        }
      }
    });

    // ---------------------------------------------------------------------------------------
    await cas('le grand livre : la liste des motifs est fermée à SIX, et la base tient la même', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Motif');
      const bon = L.compteJoueur(u);
      for (const motif of L.MOTIFS) {
        await client.query(
          `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
           values ($1,'m',$2,$3,7)`, [motif, L.MAISON_DOTATION, bon]);
      }
      // Le septième, celui que la phase 06 ajoutera un jour avec son `alter table` : aujourd'hui la
      // base le refuse, et c'est ce qui garantit que la liste du code et celle du schéma sont la
      // même liste.
      for (const absent of ['liberation', 'ajustement', 'MISE', '']) {
        await refuse(client, '23514', 'ledger_entries_motif_check',
          `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
           values ($1,'m7',$2,$3,7)`, [absent, L.MAISON_DOTATION, bon]);
      }
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('les largeurs `integer` : 3 000 000 000 lève bien 22003, sur matches ET sur le grand livre', async () => {
      // LE BUG DÉJÀ PAYÉ UNE FOIS : un entier parfaitement « valide » côté JavaScript déborde
      // l'`integer` signé de Postgres, la route rend 500, et la ligne reste ouverte — le joueur est
      // enfermé dans un billet mort, mise débitée. La doublure d'`api/test.js` refuse ce que la base
      // refuserait ; ici on vérifie que c'est bien ce que la base fait.
      await client.query('begin');
      const u = await creerJoueur(client, 'Large');
      const m = await ouvrirBillet(client, u);
      await refuse(client, '22003', 'out of range',
        `update matches set status = 'settled', settled_at = now(), kills = 3000000000
           where id = $1 and status = 'open' and net_cents is null`, [m]);
      await refuse(client, '22003', 'out of range',
        `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
         values ('dotation','trop',$1,$2,3000000000)`, [L.MAISON_DOTATION, L.compteJoueur(u)]);
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('la somme globale du livre est ZÉRO, par construction : chaque ligne pose +m et −m', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Zero');
      const m = await ouvrirBillet(client, u);
      const p = C.cashoutCents(400);
      await ledgerWrite(client, L.mouvementDotation({ userId: u, montantCents: 5000 }));
      await ledgerWrite(client, L.mouvementMise({ userId: u, matchId: m, miseCents: 50 }));
      await ledgerWrite(client, L.mouvementGain({ userId: u, matchId: m, miseCents: 50,
        grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
      // La somme des SOLDES de tous les comptes, pas la somme des montants : une ligne est un
      // transfert, donc elle compte `+m` sur un compte et `−m` sur l'autre. C'est cette somme-là qui
      // est nulle, et elle l'est sans qu'on ait rien à asserter en JavaScript.
      const r = await client.query(`
        select coalesce(sum(solde), 0) as total from (
          select compte, sum(signe) as solde from (
            select compte_credit as compte,  montant_cents as signe from ledger_entries
            union all
            select compte_debit  as compte, -montant_cents as signe from ledger_entries
          ) jambes group by compte
        ) soldes`);
      if (Number(r.rows[0].total) !== 0) throw new Error(`le livre ne boucle pas : ${r.rows[0].total}`);
      // Et le séquestre est vidé au centime — l'invariant fort et local que le séquestre par partie
      // existe pour donner.
      const enjeu = await ledgerSolde(client, L.compteEnjeu(m));
      if (enjeu !== 0) throw new Error(`le séquestre porte encore ${enjeu}`);
      const dispo = await ledgerSolde(client, L.compteJoueur(u));
      if (dispo !== 5000 - 50 + p.netCents) throw new Error(`solde dépensable ${dispo}`);
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('ledgerSolde rend un NOMBRE, pas la chaîne que `sum()` renvoie', async () => {
      // Le piège du pilote, et il est silencieux : `sum()` est un `bigint`, donc une CHAÎNE. Un
      // solde parti en texte ferait comparer « 9 » et « 10 » caractère par caractère, et le refus de
      // découvert laisserait passer exactement ce qu'il existe pour arrêter. Aucun test sans base ne
      // peut voir cela : c'est le pilote qui convertit, et le pilote n'y est jamais exécuté.
      await client.query('begin');
      const u = await creerJoueur(client, 'Type');
      await ledgerWrite(client, L.mouvementDotation({ userId: u, montantCents: 1234 }));
      const solde = await ledgerSolde(client, L.compteJoueur(u));
      if (typeof solde !== 'number') throw new Error(`solde rendu en ${typeof solde}`);
      if (solde !== 1234) throw new Error(`solde ${solde}`);
      // Un compte que le livre n'a jamais touché vaut ZÉRO, pas `null` : un solde absent qui se
      // propage en `NaN` est exactement la panne qu'on découvre au moment de payer quelqu'un.
      const vide = await ledgerSolde(client, L.compteQuarantaine(u));
      if (vide !== 0) throw new Error(`un compte jamais touché rend ${vide}`);
      // Le compte d'émission est NÉGATIF, et c'est la mesure qu'on cherche, pas un incident.
      const emis = await ledgerSolde(client, L.MAISON_DOTATION);
      if (emis !== -1234) throw new Error(`le compte d'émission rend ${emis}`);
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    // LE SEUL TEST QUI NE PEUT EXISTER NULLE PART AILLEURS.
    await cas('DEUX TRANSACTIONS CONCURRENTES : la seconde ATTEND le verrou de ligne, elle ne le croise pas', async () => {
      // Une doublure JavaScript mono-fil sérialise GRATUITEMENT ce que Postgres ne sérialise que si
      // on le lui demande correctement. Un verrou éprouvé en série ne prouve donc rien — c'est le
      // patron du harnais de `test.js` qui recopiait les expressions de `faits`, et le journal l'a
      // déjà payé une fois. Il faut deux connexions RÉELLES, et il faut observer l'attente.
      const un = await pool.connect(), deux = await pool.connect();
      try {
        const u = await (async () => {
          await un.query('begin');
          const id = await creerJoueur(un, 'Course');
          const autre = await creerJoueur(un, 'Voisin');
          await un.query('commit');
          return { id, autre };
        })();

        await un.query('begin');
        await un.query('select id from users where id = $1 for update', [u.id]);

        await deux.query('begin');
        let pris = false, casse = null;
        // Le `catch` n'est pas de la politesse : cette promesse reste en vol si une vérification
        // échoue avant qu'elle n'aboutisse, et un rejet non traité fait tomber le processus entier
        // depuis Node 15 — le script rendrait alors 1 sans dire lequel de ses contrôles a cédé.
        const attente = deux.query('select id from users where id = $1 for update', [u.id])
          .then(() => { pris = true; }, e => { casse = e; });

        // LE CONTRÔLE, sans lequel la mesure ne vaut rien : sur un AUTRE joueur, le même verrou est
        // pris tout de suite. Si celui-ci bloquait aussi, on ne mesurerait qu'une connexion morte.
        const trois = await pool.connect();
        try {
          await trois.query('begin');
          await trois.query('select id from users where id = $1 for update', [u.autre]);
          await trois.query('rollback');
        } finally { trois.release(); }

        await pause(400);
        if (pris) throw new Error('la seconde transaction n\'a PAS attendu : le verrou ne sérialise rien');
        await un.query('commit');
        await Promise.race([attente, pause(5000).then(() => {
          throw new Error('la seconde transaction n\'a jamais obtenu le verrou');
        })]);
        if (casse) throw casse;
        if (!pris) throw new Error('la seconde transaction n\'a jamais obtenu le verrou');
        await deux.query('rollback');
        await un.query(`delete from users where id in ($1,$2)`, [u.id, u.autre]);
      } finally {
        await un.query('rollback').catch(() => {});
        await deux.query('rollback').catch(() => {});
        un.release(); deux.release();
      }
    });

    // ---------------------------------------------------------------------------------------
    await cas('DEUX DÉBITS CONCURRENTS du même compte : un seul passe, le solde ne devient jamais négatif', async () => {
      // Le vol que le verrou ferme : deux onglets qui ouvrent un billet en même temps lisent tous
      // les deux un solde de 50 et débitent tous les deux 50. Aucun `check` de colonne ne peut voir
      // une somme d'AUTRES lignes — c'est pour cela que le verrou porte sur la ligne `users`, la
      // seule qui existe par joueur, et qu'il se prend AVANT que la somme ne soit calculée.
      const semer = await pool.connect();
      let u;
      try {
        await semer.query('begin');
        u = await creerJoueur(semer, 'Fonds');
        await ledgerWrite(semer, L.mouvementDotation({ userId: u, montantCents: 50 }));
        await semer.query('commit');
      } finally { semer.release(); }

      // Deux « ouvertures de billet » simultanées, chacune sur sa propre connexion, chacune écrivant
      // la mise sur SON séquestre : les paires de comptes diffèrent, donc la clé d'idempotence ne
      // peut rien arbitrer ici. Seul le verrou peut.
      const tenter = async matchId => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query('select id from users where id = $1 for update', [u]);
          const solde = await ledgerSolde(c, L.compteJoueur(u));
          if (solde < 50) { await c.query('rollback'); return 'fonds'; }
          await ledgerWrite(c, L.mouvementMise({ userId: u, matchId, miseCents: 50 }));
          await c.query('commit');
          return 'ok';
        } catch (e) {
          await c.query('rollback').catch(() => {});
          throw e;
        } finally { c.release(); }
      };

      // Deux séquestres bidon : la table `matches` n'est pas touchée, on éprouve le verrou et la
      // somme, pas l'insertion du billet.
      const [a, b] = await Promise.all([tenter(910001), tenter(910002)]);
      const passes = [a, b].filter(x => x === 'ok').length;
      if (passes !== 1) throw new Error(`${passes} débits ont abouti au lieu d'un (${a}, ${b})`);
      const lecteur = await pool.connect();
      try {
        const reste = await ledgerSolde(lecteur, L.compteJoueur(u));
        if (reste !== 0) throw new Error(`le solde vaut ${reste} au lieu de 0`);
        if (reste < 0) throw new Error('le solde d\'un joueur est passé en négatif');
        await lecteur.query('delete from ledger_entries where reference in ($1,$2,$3)',
          [String(u), '910001', '910002']);
        await lecteur.query('delete from users where id = $1', [u]);
      } finally { lecteur.release(); }
    });

    // ---------------------------------------------------------------------------------------
    await cas('la doublure et la base tombent d\'accord sur `renounced`', async () => {
      // `ledgerReconcile` reconnaît six statuts clos, dont `renounced`. Une valeur que le code
      // connaît et que la contrainte refuse serait découverte au premier renoncement réel.
      await client.query('begin');
      const u = await creerJoueur(client, 'Renonce');
      const m = await ouvrirBillet(client, u);
      await client.query(`update matches set status = 'renounced' where id = $1`, [m]);
      await refuse(client, '23514', 'matches_status_check',
        `update matches set status = 'inconnu' where id = $1`, [m]);
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('LA PURGE DES TRACES, CONDITION PAR CONDITION, CONTRE LA VRAIE BASE', async () => {
      // C'est le PREMIER `delete` du dépôt sur la pièce qui prouve un paiement, et sa clause fait
      // quelque chose qu'aucune autre requête du dossier ne fait : elle CROISE trois tables et
      // recalcule un solde de séquestre en SQL. Une doublure JavaScript qui filtre un tableau ne
      // prouve rien de ce que Postgres fait de cette clause-là — en particulier du `::text` et de la
      // concaténation `'enjeu:' || matches.id`, qui construisent un nom de compte côté base.
      //
      // On monte le cas nominal, on vérifie qu'il purge, puis on retire chaque condition SEULE.
      await client.query('begin');
      const base = pgDb(URL_BASE);
      const u = await creerJoueur(client, 'Purge');
      const vieux = new Date(Date.now() - (L.TRACE_RETENTION_JOURS + 1) * 24 * 3600 * 1000);
      const recent = new Date(Date.now() - 3600_000);
      // Un billet réglé, sa trace, sa mise et son gain : les quatre conditions réunies.
      const monter = async (statut, quand, avecGain, viderTout) => {
        const m = await ouvrirBillet(client, u, { status: 'open' });
        await client.query(
          `update matches set status = $2, settled_at = $3, gross_cents = 0, fee_cents = 0,
                              net_cents = 0
             where id = $1`, [m, statut, quand]);
        await client.query(
          `insert into match_traces (match_id, seq, sim_version, steps, data) values ($1,0,1,10,'X')`,
          [m]);
        await ledgerWrite(client, L.mouvementMise({ userId: u, matchId: m, miseCents: 50 }));
        if (avecGain) {
          await ledgerWrite(client, L.mouvementGain({ matchId: m, miseCents: viderTout ? 50 : 30,
                                                      grossCents: 0, feeCents: 0, netCents: 0 }));
        }
        // Chaque billet doit être clos pour que le suivant puisse s'ouvrir : l'index est partiel.
        return m;
      };
      const reste = async m => {
        const r = await client.query('select count(*) as n from match_traces where match_id = $1', [m]);
        return Number(r.rows[0].n);
      };
      const nominal = await monter('settled', vieux, true, true);
      const pasDefinitif = await monter('expired', vieux, true, true);
      const sansGain = await monter('settled', vieux, false, true);
      const sequestreHabite = await monter('settled', vieux, true, false);
      const tropRecent = await monter('settled', recent, true, true);
      // La purge tourne sur SA propre connexion, hors de la transaction partagée : elle ouvre la
      // sienne. On valide donc d'abord ce qu'on vient de monter.
      await client.query('commit');
      try {
        const r = await base.purgeTraces({ maintenant: new Date() });
        if (r.effacees !== 1) throw new Error(`${r.effacees} traces effacées au lieu d'une seule`);
        if (await reste(nominal) !== 0) throw new Error('le cas nominal n\'a pas été purgé');
        for (const [quoi, m] of [['statut non définitif', pasDefinitif], ['aucune écriture du livre', sansGain],
                                 ['séquestre habité', sequestreHabite], ['délai non écoulé', tropRecent]]) {
          if (await reste(m) !== 1) throw new Error(`la purge a effacé malgré « ${quoi} »`);
        }
        // Et elle n'a touché ni une ligne `matches`, ni une écriture du grand livre.
        const lignes = await client.query('select count(*) as n from matches where user_id = $1', [u]);
        if (Number(lignes.rows[0].n) !== 5) throw new Error('la purge a effacé une ligne matches');
        const ecritures = await client.query(
          `select count(*) as n from ledger_entries where compte_debit like 'joueur:' || $1 || ':%'
                                                      or compte_credit like 'joueur:' || $1 || ':%'`,
          [String(u)]);
        if (Number(ecritures.rows[0].n) === 0) throw new Error('la purge a effacé les écritures du joueur');
      } finally {
        await base.close().catch(() => {});
        // On nettoie à la main : la transaction partagée a été validée, il n'y a plus de `rollback`
        // qui rende la main. `cascade` emporte les traces et les billets.
        await client.query('delete from ledger_entries where reference in (select id::text from matches where user_id = $1)', [u]);
        await client.query('delete from users where id = $1', [u]);
      }
    });
  } finally {
    partage = null;
    client.release();
  }

  console.log(`\n${reussis} vérifications passées${echoues ? `, ${echoues} ÉCHOUÉES` : ''}`);
  if (echoues) process.exitCode = 1;
}

main()
  .catch(e => { console.error('db-check : ' + ((e && e.stack) || e)); process.exitCode = 1; })
  .finally(() => pool.end());
