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
// `EXPOSITION_FENETRE_SQL` et `fenetreDepuis` : la requête RÉELLE du plafond, celle que
// `createMatch` exécute sous son verrou. On l'explique telle quelle — un harnais qui recopie ce
// qu'il vérifie ne vérifie rien, et le dossier l'a déjà payé une fois.
const { pgDb, ledgerWrite, ledgerSolde, ledgerDe,
        EXPOSITION_FENETRE_SQL, fenetreDepuis } = require('./db-pg');

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

// Le fabricant ne pose QUE la ligne d'`users` : c'est un décor. Un cas qui a besoin d'argent écrit
// sa propre dotation par `mouvementDotation`, parce que le montant fait souvent partie de ce que le
// cas démontre — `ledgerSolde` en éprouve un de 1234 pour prouver que le pilote rend un nombre, et
// une dotation posée d'office ici fausserait son assertion. Deux cas l'avaient oubliée, et la règle
// du découvert les a refusés : « joueur:N porte 0 et ce mouvement lui demande 50 ».
async function creerJoueur(client, nom) {
  const r = await client.query(
    `insert into users (auth_id, email, name, name_key)
     values ($1,$2,$3,$4) returning id`,
    [`auth-${nom}`, `${nom}@exemple.test`, nom, C.nameKey(nom)]);
  return r.rows[0].id;
}

// `paid_seats` n'a pas de valeur par défaut en base : elle est ÉCRITE par le serveur, comme
// `seats` et `sim_version`. Le décor l'écrit donc aussi, et il écrit la même chose que la
// production — un siège payé sur les vingt de la table.
async function ouvrirBillet(client, userId, extra = {}) {
  const r = await client.query(
    `insert into matches (user_id, mode, stake_cents, seats, team_size, paid_seats, brawler,
                          seed_public, seed_secret, sim_version, client_key, status, opened_at,
                          expires_at)
     values ($1,'solo',50,20,1,$2,'bolt',12345,$3,1,$4,$5,$6,$7) returning id`,
    [userId, extra.paidSeats === undefined ? 1 : extra.paidSeats, SECRETE,
     extra.clientKey || `cle-${Math.random()}`, extra.status || 'open',
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
    await cas('DEUX COMPTES CRÉÉS D\'AFFILÉE : le second obtient un pseudo libre ET sa dotation', async () => {
      // LE SEUL HARNAIS QUI PUISSE VOIR CE DÉFAUT-LÀ. Le scénario n'a rien d'exotique : c'est le
      // second joueur qui s'inscrit. `identityFromClaims` rend toujours `name: ''` — Crossmint ne
      // transporte pas de pseudo — donc `C.nameOr('', NAME.fallback)` rend « Player » pour TOUT
      // nouveau compte, et `nameKey` rend « player » pour tous. Le second heurte donc `name_key` à
      // coup sûr.
      //
      // Ce que la doublure d'`api/test.js` ne peut pas reproduire : elle résout la collision par un
      // `while (users.some(...))` en mémoire, donc elle ne SUBIT jamais un refus d'insertion. Or
      // dans un bloc transactionnel, une erreur avorte tout ce qui suit — la commande d'après sort
      // en `25P02` et jamais en `23505` — si bien que le réessai de pseudo sortait en panne non
      // nommée, donc en 500, sans compte et sans dotation. Le `savepoint` de `db-pg.js` est la
      // réponse, et c'est ici, et seulement ici, qu'elle se vérifie.
      //
      // `db-check.js` éprouvait jusqu'ici la CONTRAINTE `name_key` sans jamais faire tourner la
      // fonction qui la heurte. C'est la réserve écrite de la phase 03, appliquée à elle-même.
      const base = pgDb(URL_BASE);
      const repli = C.nameOr('', C.NAME.fallback);
      try {
        const un = await base.findOrCreate({ authId: 'sans-pseudo-1', email: 'p1@x.test',
                                             name: repli, nameKey: C.nameKey, at: MAINTENANT });
        const deux = await base.findOrCreate({ authId: 'sans-pseudo-2', email: 'p2@x.test',
                                               name: repli, nameKey: C.nameKey, at: MAINTENANT });
        if (un.user.name !== repli) throw new Error(`le premier s'appelle ${un.user.name}`);
        if (deux.user.name !== repli + '2') {
          throw new Error(`le second s'appelle ${deux.user.name} au lieu de ${repli}2`);
        }
        if (deux.user.id === un.user.id) throw new Error('les deux comptes n\'en font qu\'un');
        // ET SA DOTATION : un compte sans dotation est un joueur qui ne peut rien faire et que rien
        // ne réparerait, puisqu'il ne sera plus jamais créé.
        for (const [quoi, r] of [['premier', un], ['second', deux]]) {
          if (r.balanceCents !== L.DOTATION_CENTS) {
            throw new Error(`le ${quoi} compte porte ${r.balanceCents} au lieu de ${L.DOTATION_CENTS}`);
          }
        }
        // Et un TROISIÈME, pour que le suffixe ne soit pas une coïncidence à deux.
        const trois = await base.findOrCreate({ authId: 'sans-pseudo-3', email: 'p3@x.test',
                                                name: repli, nameKey: C.nameKey, at: MAINTENANT });
        if (trois.user.name !== repli + '3') {
          throw new Error(`le troisième s'appelle ${trois.user.name} au lieu de ${repli}3`);
        }
        // Une reconnexion ne crée rien et ne redote rien : elle retrouve le même compte.
        const encore = await base.findOrCreate({ authId: 'sans-pseudo-2', email: 'p2@x.test',
                                                 name: repli, nameKey: C.nameKey, at: MAINTENANT });
        if (encore.user.id !== deux.user.id) throw new Error('une reconnexion a créé un second compte');
        const dots = await client.query(
          `select count(*) as n from ledger_entries where motif = 'dotation'`);
        if (Number(dots.rows[0].n) !== 3) {
          throw new Error(`${dots.rows[0].n} dotations écrites au lieu de trois`);
        }
      } finally {
        await base.close().catch(() => {});
        await client.query(
          `delete from ledger_entries where reference in (select id::text from users where auth_id like 'sans-pseudo-%')`);
        await client.query(`delete from users where auth_id like 'sans-pseudo-%'`);
      }
    });

    // ---------------------------------------------------------------------------------------
    await cas('un seul billet ouvert : l\'index PARTIEL refuse le second, et libère la place au premier clos', async () => {
      await client.query('begin');
      const u = await creerJoueur(client, 'Ouvert');
      const premier = await ouvrirBillet(client, u);
      await refuse(client, '23505', 'matches_un_seul_ouvert',
        `insert into matches (user_id, mode, stake_cents, seats, team_size, paid_seats, brawler,
                              seed_public, seed_secret, sim_version, client_key, status, opened_at,
                              expires_at)
         values ($1,'solo',50,20,1,1,'bolt',999,$2,1,'autre','open',$3,$4)`,
        [u, SECRETE, MAINTENANT, DANS_UNE_HEURE]);
      // L'index est PARTIEL : une fois la partie close, la place se libère d'elle-même. C'est
      // exactement ce que la doublure imite, et qui n'avait jamais été vu tourner.
      await client.query(`update matches set status = 'expired' where id = $1`, [premier]);
      await ouvrirBillet(client, u, { clientKey: 'apres' });
      await client.query('rollback');
    });

    // ---------------------------------------------------------------------------------------
    await cas('paid_seats : la borne `between 1 and seats` REFUSE zéro et refuse plus de sièges qu\'il n\'y en a', async () => {
      // LA SEULE PREUVE QUE L'INTÉGRATION CONTINUE PUISSE DONNER SUR CETTE COLONNE. La doublure
      // d'`api/test.js` imite cette contrainte ; elle ne la SUBIT pas, et un test qui passe contre
      // la doublure prouve la doublure. Ici, c'est Postgres qui refuse.
      //
      // La contrainte regarde DEUX colonnes — c'est pour cela qu'elle est une contrainte de table —
      // et c'est justement le genre qu'une doublure sans schéma oublie : rien, dans un objet
      // JavaScript, ne relie `paid_seats` à `seats`.
      await client.query('begin');
      const u = await creerJoueur(client, 'Sieges');
      const poser = n => [
        `insert into matches (user_id, mode, stake_cents, seats, team_size, paid_seats, brawler,
                              seed_public, seed_secret, sim_version, client_key, status, opened_at,
                              expires_at)
         values ($1,'solo',50,20,1,$2,'bolt',12345,$3,1,$4,'open',$5,$6)`,
        [u, n, SECRETE, `sieges-${n}`, MAINTENANT, DANS_UNE_HEURE]];
      // Zéro siège payé : un billet sans humain n'existe pas. Négatif encore moins. Et vingt et un
      // sièges payés sur une table qui n'en porte que vingt est le cas que seule cette contrainte
      // peut voir, puisqu'il faut lire les DEUX colonnes.
      for (const n of [0, -1, 21, 999]) {
        await refuse(client, '23514', 'matches_paid_seats_borne', ...poser(n));
      }
      // Et les deux bords légitimes passent : un aujourd'hui, `seats` le jour d'une table pleine
      // d'humains. Chacun sur son propre essai, l'index partiel n'autorisant qu'un billet ouvert.
      for (const n of [1, 20]) {
        await client.query('savepoint bord');
        await client.query(...poser(n));
        await client.query('rollback to savepoint bord');
      }
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
      await ledgerWrite(client, L.mouvementDotation({ userId: u, montantCents: 5000 }));
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
      // Ce cas monte PLUSIEURS billets, chacun avec sa mise : la dotation doit couvrir toutes les
      // mises que `monter` va débiter, sinon c'est la règle du découvert qui refuse et le cas
      // accuse la purge de ce que le montage n'a pas payé.
      await ledgerWrite(client, L.mouvementDotation({ userId: u, montantCents: 5000 }));
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

    // ---------------------------------------------------------------------------------------
    await cas('DEUX OUVERTURES SIMULTANÉES NE FRANCHISSENT PAS LE PLAFOND À DEUX', async () => {
      // LA PROPRIÉTÉ QU'UNE DOUBLURE MONO-FIL SÉRIALISE GRATUITEMENT. Le plafond par joueur est
      // EXACT parce qu'il se lit dans la transaction du billet, APRÈS `select id from users where
      // id = $1 for update` : deux onglets du même joueur sont donc sérialisés, et le second voit ce
      // que le premier a écrit. En JavaScript mono-fil, cette propriété est vraie sans qu'on ait
      // rien fait — c'est très exactement le patron du harnais qui recopiait ce qu'il vérifiait.
      //
      // Ce que ce cas éprouve en même temps, et qui ne s'éprouve nulle part ailleurs : la REQUÊTE de
      // fenêtre elle-même. Elle joint `ledger_entries` à `matches` par l'expression exportée de
      // `api/ledger.js`, sans aucun `cast` sur la référence, avec deux tableaux en paramètres. Une
      // faute de syntaxe ou un `42702` — « column reference motif is ambiguous », `matches` portant
      // elle aussi un `motif` — sortirait ici, et nulle part dans `npm test`.
      const base = pgDb(URL_BASE);
      const semer = await pool.connect();
      let u;
      try {
        await semer.query('begin');
        u = await creerJoueur(semer, 'Plafond');
        // De quoi payer plusieurs mises : la dotation de production ne suffirait pas, et c'est le
        // plafond qu'on éprouve ici, pas le découvert.
        await ledgerWrite(semer, L.mouvementDotation({ userId: u, montantCents: 500000 }));
        await semer.query('commit');
      } finally { semer.release(); }

      const MISE = 1000, SIEGES = 50;
      const p = C.cashoutCents(C.purseBound(MISE, SIEGES).maxCents);
      const pireCas = L.expositionBilletMaxCents(p.netCents, MISE);
      const demande = cle => base.createMatch({
        userId: u, mode: 'resurgence', stakeCents: MISE, seats: SIEGES, teamSize: 1, paidSeats: 1,
        netMaxCents: p.netCents, brawler: 'bolt', seedPublic: 12345, seedSecret: SECRETE,
        simVersion: 1, clientKey: cle, openedAt: MAINTENANT, expiresAt: DANS_UNE_HEURE });
      try {
        // DEUX OUVERTURES EN MÊME TEMPS, deux clés de client différentes, deux connexions réelles.
        const [a, b] = await Promise.all([demande('course-a'), demande('course-b')]);
        const ouverts = [a, b].filter(r => r.match);
        if (ouverts.length !== 2) throw new Error('une ouverture a échoué : ' + JSON.stringify([a, b]));
        if (String(a.match.id) !== String(b.match.id)) {
          throw new Error(`deux billets ouverts à la fois (${a.match.id}, ${b.match.id}) : un seul pire cas doit être en vol`);
        }
        if ([a, b].filter(r => r.repris).length !== 1) {
          throw new Error('les deux ouvertures se croient neuves, ou les deux se croient reprises');
        }
        // ET UNE SEULE MISE : le chemin `repris` n'écrit jamais une seconde écriture. C'est cela qui
        // fait que « exposition réalisée + UN pire cas » est exact.
        const compte = await pool.connect();
        try {
          const r = await compte.query(
            `select count(*) as n from ledger_entries where motif = 'mise' and reference = $1`,
            [String(a.match.id)]);
          if (Number(r.rows[0].n) !== 1) throw new Error(`${r.rows[0].n} mises écrites au lieu d'une`);
          // LE PLAFOND, MAINTENANT. On sème assez d'exposition RÉALISÉE pour que le billet suivant
          // le franchisse — en POSANT DES ÉCRITURES, jamais en touchant un compteur.
          await compte.query('begin');
          await compte.query(
            `update matches set status = 'settled', settled_at = now(), issue = 'encaissement',
                                gross_cents = 0, fee_cents = 0, net_cents = 0
               where id = $1 and status = 'open' and net_cents is null`, [a.match.id]);
          await ledgerWrite(compte, L.mouvementGain({ userId: u, matchId: a.match.id,
            miseCents: MISE, grossCents: 0, feeCents: 0, netCents: 0, convergee: true }));
          const combien = Math.ceil(L.PLAFOND_JOUEUR_CENTS / pireCas) + 1;
          for (let i = 0; i < combien; i++) {
            const m = await compte.query(
              `insert into matches (user_id, mode, stake_cents, seats, team_size, paid_seats,
                                    brawler, seed_public, seed_secret, sim_version, client_key,
                                    status, opened_at, expires_at, settled_at, issue,
                                    gross_cents, fee_cents, net_cents)
               values ($1,'resurgence',$2,$3,1,1,'bolt',12345,$4,1,$5,'settled',$6,$7,$6,
                       'encaissement',$8,$9,$10) returning id`,
              [u, MISE, SIEGES, SECRETE, `semee-${i}`, MAINTENANT, DANS_UNE_HEURE,
               p.grossCents, p.feeCents, p.netCents]);
            const id = m.rows[0].id;
            await ledgerWrite(compte, L.mouvementMise({ userId: u, matchId: id, miseCents: MISE }));
            await ledgerWrite(compte, L.mouvementGain({ userId: u, matchId: id, miseCents: MISE,
              grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
          }
          await compte.query('commit');
        } finally { compte.release(); }

        // LA VRAIE REQUÊTE, CONTRE LA VRAIE BASE : elle doit retrouver le chiffre qu'on vient de
        // poser. C'est ici, et seulement ici, que l'expression `REFERENCE_BILLET_SQL` est exécutée
        // par Postgres, avec une contre-passation possible dans la colonne.
        const refus = await demande('apres-plafond');
        if (refus.refus !== 'plafond') {
          throw new Error(`le billet suivant n'a pas été refusé (${JSON.stringify(refus).slice(0, 200)})`);
        }
        if (refus.portee !== 'joueur') throw new Error(`portée ${refus.portee}`);
        if (refus.plafondCents !== L.PLAFOND_JOUEUR_CENTS) {
          throw new Error(`plafond ${refus.plafondCents}`);
        }
        // ET LE REFUS N'A RIEN LAISSÉ : pas de ligne `open`, pas d'écriture de plus.
        const reste = await pool.connect();
        try {
          const ouvert = await reste.query(
            `select count(*) as n from matches where user_id = $1 and status = 'open'`, [u]);
          if (Number(ouvert.rows[0].n) !== 0) {
            throw new Error(`${ouvert.rows[0].n} billets ouverts après un refus de plafond`);
          }
        } finally { reste.release(); }
      } finally {
        await base.close().catch(() => {});
        const net = await pool.connect();
        try {
          await net.query(
            `delete from ledger_entries where reference in (select id::text from matches where user_id = $1)
                                           or reference = $2`, [u, String(u)]);
          await net.query('delete from matches where user_id = $1', [u]);
          await net.query('delete from users where id = $1', [u]);
        } finally { net.release(); }
      }
    });

    // ---------------------------------------------------------------------------------------
    await cas('LA REQUÊTE DE FENÊTRE NE BALAIE PAS LE GRAND LIVRE : aucun `Seq Scan` sur ledger_entries', async () => {
      // LA SEULE FAÇON DE PROUVER QUE LES DEUX INDEX SERVENT, et personne ne peut la donner sur la
      // machine de travail. Les index de lecture du livre portaient `(compte_debit)` et
      // `(compte_credit)` seuls ; le plafond lit une FENÊTRE, donc sa clause porte un compte ET une
      // date, et sur un index qui ne connaît que le compte, Postgres remonte toutes les écritures de
      // `maison:contrepartie` depuis le premier jour pour n'en garder qu'une journée. La requête
      // vit sur le chemin le plus disputé du système : elle s'exécute à chaque ouverture de billet.
      //
      // IL FAUT DES LIGNES POUR QUE LA QUESTION AIT UN SENS. Sur une table de trois lignes, Postgres
      // balaie — et il a raison. On pose donc du LEST : des dizaines de milliers d'écritures qui ne
      // touchent AUCUN compte de maison, pour que le filtre soit sélectif, et quelques centaines qui
      // en touchent. Ces lignes-là ne sont pas une comptabilité, c'est un banc : la base est jetable,
      // et tout est annulé à la fin.
      await client.query('begin');
      const u = await creerJoueur(client, 'Explain');
      const autre = await creerJoueur(client, 'Lest');
      const p = C.cashoutCents(C.purseBound(1000, 50).maxCents);
      // Quatre cents billets réglés, et les quatre jambes de chacun : mise, contrepartie, commission,
      // joueur. Deux de ces jambes touchent un compte de maison, et ce sont elles que l'index doit
      // retrouver.
      await client.query(
        `insert into matches (user_id, mode, stake_cents, seats, team_size, paid_seats, brawler,
                              seed_public, seed_secret, sim_version, client_key, status, opened_at,
                              expires_at, settled_at, issue, gross_cents, fee_cents, net_cents)
         select $1,'resurgence',1000,50,1,1,'bolt',12345,$2,1,'explain-'||g,'settled',$3,$4,$3,
                'encaissement',$5,$6,$7
           from generate_series(1, 400) g`,
        [u, SECRETE, MAINTENANT, DANS_UNE_HEURE, p.grossCents, p.feeCents, p.netCents]);
      await client.query(
        `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents, cree_le)
         select 'mise', m.id::text, 'joueur:'||$1||':disponible', 'enjeu:'||m.id, 1000,
                now() - ((m.id % 20) || ' hours')::interval
           from matches m where m.user_id = $1
         union all
         select 'gain', m.id::text, 'maison:contrepartie', 'enjeu:'||m.id, $2,
                now() - ((m.id % 20) || ' hours')::interval
           from matches m where m.user_id = $1
         union all
         select 'gain', m.id::text, 'enjeu:'||m.id, 'maison:commission', $3,
                now() - ((m.id % 20) || ' hours')::interval
           from matches m where m.user_id = $1
         union all
         select 'gain', m.id::text, 'enjeu:'||m.id, 'joueur:'||$1||':disponible', $4,
                now() - ((m.id % 20) || ' hours')::interval
           from matches m where m.user_id = $1`,
        [u, p.grossCents - 1000, p.feeCents, p.netCents]);
      // LE LEST : des mises qui ne touchent aucun compte de maison. C'est ce qui rend le filtre
      // sélectif, donc l'index utile — sans elles, « aucun Seq Scan » serait une question vide.
      await client.query(
        `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents, cree_le)
         select 'mise', (1000000 + g)::text, 'joueur:'||$1||':disponible', 'enjeu:'||(1000000 + g), 50,
                now() - ((g % 200) || ' minutes')::interval
           from generate_series(1, 40000) g`, [autre]);
      await client.query('analyze ledger_entries');
      await client.query('analyze matches');

      const plan = await client.query(
        { text: 'explain (format json) ' + EXPOSITION_FENETRE_SQL,
          values: [u, fenetreDepuis(new Date()), L.COMPTES_EXPOSITION, L.MOTIFS_EXPOSITION] });
      const racine = plan.rows[0]['QUERY PLAN'];
      const noeuds = [];
      (function parcourir(n) {
        if (Array.isArray(n)) { n.forEach(parcourir); return; }
        if (!n || typeof n !== 'object') return;
        if (n['Node Type']) noeuds.push(n);
        for (const v of Object.values(n)) if (v && typeof v === 'object') parcourir(v);
      })(racine);
      const balayages = noeuds.filter(n => n['Node Type'] === 'Seq Scan'
                                        && n['Relation Name'] === 'ledger_entries');
      if (balayages.length) {
        throw new Error('la requête de fenêtre BALAIE ledger_entries : '
          + JSON.stringify(racine).slice(0, 600));
      }
      // Et elle passe bien par les index NOMMÉS : un plan sans `Seq Scan` mais qui n'aurait pas
      // regardé cette table ne prouverait rien.
      const index = noeuds.filter(n => /Index|Bitmap/.test(n['Node Type'] || ''))
                          .map(n => n['Index Name']).filter(Boolean);
      if (!index.some(i => /ledger_entries_(debit|credit)_fenetre_idx/.test(i))) {
        throw new Error('aucun des deux index de fenêtre ne sert : ' + index.join(', '));
      }
      // Enfin, la requête RÉPOND, et elle répond juste : quatre cents victoires maximales.
      const total = await client.query(
        { text: EXPOSITION_FENETRE_SQL,
          values: [u, fenetreDepuis(new Date()), L.COMPTES_EXPOSITION, L.MOTIFS_EXPOSITION] });
      const attendu = 400 * L.expositionBilletMaxCents(p.netCents, 1000);
      if (Number(total.rows[0].total) !== attendu) {
        throw new Error(`l'exposition vaut ${total.rows[0].total} au lieu de ${attendu}`);
      }
      await client.query('rollback');
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
