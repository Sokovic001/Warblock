// L'adaptateur Postgres. Le seul fichier qui parle à la base ; le routeur ne connaît que ces deux
// méthodes, ce qui permet de le tester avec une base factice.
'use strict';
const { Pool } = require('pg');

const COLS = 'id, auth_id, email, name, name_key, avatar, country, created_at';
// La graine secrète est LUE ici — c'est la seule colonne de cette liste qui ne doit jamais
// traverser le réseau. C'est `app.js` qui la retire, par sa liste blanche `billet()`.
const MATCH_COLS = 'id, user_id, mode, stake_cents, seats, team_size, brawler, seed_public, seed_secret, ' +
                   'sim_version, client_key, status, first_result_at, opened_at, expires_at, ' +
                   // le règlement : NULL tant que la partie est ouverte, écrit une seule fois
                   'settled_at, issue, controle, motif, gross_cents, fee_cents, net_cents, ' +
                   'purse_cents, declared_net_cents, ecart_cents, ' +
                   'seconds, kills, deaths, rank, cubes, damage, cashed_out, ' +
                   // le rejeu : ce qu'il a coûté, et s'il a convergé avec l'empreinte du client
                   'trace_steps, replay_digest, digest_match, divergence_step, replay_ms';

// Le pilote Postgres rend les colonnes `bigint` sous forme de CHAÎNE — il ne peut pas garantir
// qu'elles tiennent dans un nombre JavaScript. La graine PUBLIQUE, elle, tient d'office : son
// domaine est celui des entiers 32 bits non signés, et c'est en nombre que WBCore l'attend. Une
// graine en chaîne serait refusée par `seedFor`, qui repartirait sur la graine locale : le joueur
// verrait une autre carte que celle de son billet, sans le moindre message.
// `id` et `user_id` restent des chaînes, on ne fait que les recopier. La graine SECRÈTE aussi,
// depuis qu'elle fait 128 bits : c'est du texte hexadécimal, et rien ne la lit comme un nombre.
function ligneMatch(r) {
  if (!r) return r;
  // `replay_digest` est un `bigint` pour la même raison que la graine — c'est un entier 32 bits NON
  // signé — donc le pilote le rend en CHAÎNE, et il repartirait tel quel au client. `null` reste
  // `null` : une partie non rejouée n'a pas d'empreinte, et zéro n'est pas la même chose.
  return { ...r, seed_public: Number(r.seed_public),
           replay_digest: r.replay_digest === null || r.replay_digest === undefined
             ? r.replay_digest : Number(r.replay_digest) };
}

// ---------------------------------------------------------------------------------------------
// LE GRAND LIVRE. Trois fonctions, et elles prennent toutes un CLIENT DÉJÀ EN TRANSACTION plutôt
// que d'aller en chercher un dans le bassin : une écriture du livre n'a de sens qu'avec ce qu'elle
// accompagne — la mise avec son billet, le gain avec son règlement — et les deux doivent échouer ou
// réussir ensemble. Une méthode qui ouvrirait sa propre connexion rendrait cette atomicité
// impossible à obtenir, et personne ne s'en apercevrait avant le premier billet à demi écrit.
//
// IL N'Y A QU'UN ÉCRIVAIN, `ledgerWrite`, et une garde textuelle d'`api/test.js` vérifie qu'il
// n'est appelé que depuis des méthodes NOMMÉES de ce fichier. C'est le patron déjà en place pour
// `match_traces` et pour les tables annexes du bloc `Game` : un écrivain d'argent doit être nommé,
// pas silencieux.
const LEDGER_COLS = 'id, motif, reference, compte_debit, compte_credit, montant_cents, cree_le';

// L'ÉCRIVAIN UNIQUE. Aucun `on conflict do nothing` ici, et c'est une décision : sur
// `match_traces`, avaler le doublon est le bon comportement — le premier écrit gagne et le segment
// renvoyé est identique. Sur le grand livre, un doublon veut dire qu'on est en train de payer deux
// fois, et l'appelant DOIT l'apprendre. La violation de `ledger_entries_mouvement_uniq` remonte donc
// telle quelle (`23505`), la transaction entière est annulée, et un mouvement rejoué en bloc n'écrit
// rien. C'est l'insertion refusée qui apprend ce qui existait déjà, jamais un `select` préalable.
async function ledgerWrite(client, transferts) {
  const lignes = transferts || [];
  // Un mouvement n'est jamais vide. Écrire zéro ligne en croyant en écrire trois est exactement le
  // genre de succès silencieux qui ne se voit qu'au moment de payer quelqu'un.
  if (!Array.isArray(lignes) || lignes.length === 0) {
    throw new Error('grand livre : rien à écrire — un mouvement porte au moins un transfert');
  }
  for (const t of lignes) {
    await client.query(
      `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
       values ($1,$2,$3,$4,$5)`,
      [t.motif, t.reference, t.compteDebit, t.compteCredit, t.montantCents]);
  }
  return { ecrites: lignes.length };
}

// LE SOLDE D'UN COMPTE : la somme de ses crédits moins la somme de ses débits. C'est ce qui remplace
// la case qu'on ne crée pas — un compteur qu'on incrémente est une case qu'on écrase, et un double
// envoi la fausse pour toujours.
//
// LE PIÈGE DU PILOTE, ET IL EST SILENCIEUX : `sum()` rend un `bigint`, donc une CHAÎNE. Sans la
// conversion, un solde partirait en texte, `solde >= montant` comparerait deux chaînes caractère par
// caractère — « 9 » y est plus grand que « 10 » — et le refus de découvert laisserait passer
// exactement ce qu'il existe pour arrêter. Même piège que les graines et que les statistiques, avec
// un prix plus élevé.
async function ledgerSolde(client, compte) {
  const r = await client.query(
    `select coalesce(sum(montant_cents) filter (where compte_credit = $1), 0)
          - coalesce(sum(montant_cents) filter (where compte_debit  = $1), 0) as total
       from ledger_entries
      where compte_debit = $1 or compte_credit = $1`, [compte]);
  return Number((r.rows[0] || {}).total) || 0;
}

// LA RELECTURE D'UN MOUVEMENT, par sa référence. Elle sert à réconcilier et à constater, jamais à
// décider avant d'écrire : demander « existe-t-il déjà ? » puis insérer laisse une fenêtre entre les
// deux, et ici cette fenêtre vaut un crédit en double. C'est la clé unique qui arbitre.
async function ledgerDe(client, { reference }) {
  const r = await client.query(
    `select ${LEDGER_COLS} from ledger_entries where reference = $1 order by id`, [reference]);
  // `id` est un `bigserial`, donc une chaîne, et on ne fait que la recopier — comme `matches.id`.
  // `montant_cents` est un `integer` : le pilote le rend en nombre, et `Number` le couvre quand
  // même, pour la raison écrite partout ailleurs — une panne silencieuse coûte deux conversions.
  return r.rows.map(l => ({ ...l, id: String(l.id), montant_cents: Number(l.montant_cents) }));
}

function pgDb(connectionString) {
  const pool = new Pool({
    connectionString,
    // Une connexion à la base d'un jeu d'argent ne se fait pas en clair, y compris sur un réseau
    // qu'on croit privé.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString || '') ? false : { rejectUnauthorized: true },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Les statistiques sont la SOMME des parties réglées, jamais un compteur qu'on incrémente. La
  // table de compteurs de la phase 01 a disparu pour cette raison : un compteur est une case qu'on
  // écrase, et un double envoi la fausse pour toujours — exactement ce qu'on refuse déjà pour un
  // solde. Ici, un double envoi ne peut rien fausser puisqu'il n'y a rien à écrire.
  //
  // Seul `status = 'settled'` compte. Une partie refusée ('rejected'), périmée ('expired') ou
  // encore ouverte ne compte pour rien : elle n'a pas de résultat opposable.
  //
  // `wins` retient la victoire ET l'encaissement, parce que le jeu lui-même compte les deux —
  // sortir de Resurgence avec sa sacoche est une sortie gagnante, et le compteur ne doit pas
  // baisser le jour où le joueur se connecte.
  //
  // Depuis la phase 02b, LES QUATRE PREMIERS CHIFFRES NE COMPTENT QUE LES PARTIES DONT LE REJEU A
  // CONVERGÉ (`digest_match`). C'est la garantie écrite dont la phase 03 a besoin, et elle
  // s'applique déjà ici pour qu'aucun agrégat n'ait à la redécouvrir. `digest_match` vaut NULL sur
  // une ligne qui n'a pas été rejouée : en SQL, `where digest_match` écarte NULL comme il écarte
  // faux, et c'est bien ce qu'on veut — on ne compte que ce qu'on a pu vérifier.
  //
  // Le cinquième, `divergences`, compte celles que ce filtre écarte. Une liste d'exclusion qui
  // grandit en silence laisserait la phase 03 hériter d'un filtre dont personne ne connaît le
  // rendement : le taux de divergence est donc un chiffre exposé, pas un pressentiment.
  async function stats(client, userId) {
    const r = await client.query(`
      select count(*) filter (where digest_match)                          as parties,
             count(*) filter (where digest_match
                                and issue in ('victoire', 'encaissement')) as gagnees,
             coalesce(sum(kills) filter (where digest_match), 0)           as tues,
             coalesce(max(net_cents) filter (where digest_match), 0)       as meilleur,
             count(*) filter (where digest_match is not true)              as divergentes
        from matches
       where user_id = $1 and status = 'settled'`, [userId]);
    const l = r.rows[0] || {};
    // Le même piège de pilote que les graines, et il mord plus fort ici : `count()` et `sum()`
    // rendent un `bigint`, donc une CHAÎNE. Sans cette conversion, `kills` partirait au client
    // sous forme de texte et `applyAccount` en ferait ce qu'il pourrait — silencieusement.
    const n = v => (Number(v) || 0);
    return { matches: n(l.parties), wins: n(l.gagnees), kills: n(l.tues), best: n(l.meilleur),
             divergences: n(l.divergentes) };
  }

  return {
    async findOrCreate({ authId, email, name, nameKey }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const trouve = await client.query(`select ${COLS} from users where auth_id = $1`, [authId]);
        if (trouve.rows[0]) {
          const user = trouve.rows[0];
          const s = await stats(client, user.id);
          await client.query('commit');
          return { user, stats: s };
        }

        // Première connexion : on crée le compte. Le pseudo proposé par le fournisseur peut déjà
        // être pris — on ajoute un suffixe jusqu'à trouver libre, plutôt que d'échouer au nez du
        // joueur le jour de son inscription. Il pourra le changer ensuite.
        let base = name, cle = nameKey(base), n = 1, user = null;
        while (!user) {
          try {
            const ins = await client.query(
              `insert into users (auth_id, email, name, name_key) values ($1,$2,$3,$4) returning ${COLS}`,
              [authId, email, base, cle]);
            user = ins.rows[0];
          } catch (e) {
            if (e && e.code === '23505' && String(e.constraint || '').includes('name_key')) {
              n += 1;
              const suffixe = String(n);
              base = (name.slice(0, 14 - suffixe.length) + suffixe);
              cle = nameKey(base);
              if (n > 50) throw new Error('impossible de trouver un pseudo libre');
              continue;
            }
            throw e;
          }
        }
        // Rien à initialiser : un compte neuf n'a aucune partie réglée, et la somme d'un ensemble
        // vide vaut zéro. C'est une ligne de moins à écrire, et surtout une ligne de moins à
        // réconcilier le jour où deux écritures se croiseraient.
        const s = await stats(client, user.id);
        await client.query('commit');
        return { user, stats: s };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async updateProfile(authId, champs) {
      const colonnes = Object.keys(champs);
      if (!colonnes.length) return { user: null };
      const set = colonnes.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const valeurs = colonnes.map(c => champs[c]);
      const client = await pool.connect();
      try {
        const r = await client.query(
          `update users set ${set}, updated_at = now() where auth_id = $1 returning ${COLS}`,
          [authId, ...valeurs]);
        const user = r.rows[0];
        if (!user) return { user: null };
        return { user, stats: await stats(client, user.id) };
      } catch (e) {
        // Course entre deux joueurs qui visent le même pseudo : la contrainte unique tranche, et
        // c'est bien elle qu'on veut comme arbitre, pas une vérification préalable qui laisserait
        // une fenêtre entre le « libre ? » et le « pris ».
        if (e && e.code === '23505') return { conflit: true };
        throw e;
      } finally {
        client.release();
      }
    },

    // L'ouverture d'un billet. Rien n'est vérifié avant d'insérer : ce sont les deux index uniques
    // qui arbitrent, et l'insertion refusée qui nous apprend ce qui existait déjà. Un `select`
    // préalable laisserait une fenêtre entre le « a-t-il déjà un billet ? » et l'écriture — la
    // même fenêtre que celle qu'on refuse pour name_key.
    async createMatch(m) {
      const client = await pool.connect();
      try {
        // Deux tours au plus : le premier peut buter sur un billet périmé, qu'on clôt ; le second
        // insère alors. Au-delà, quelqu'un d'autre écrit en même temps, et on rend la main.
        for (let tour = 0; tour < 2; tour++) {
          const ins = await client.query(
            `insert into matches
               (user_id, mode, stake_cents, seats, team_size, brawler, seed_public, seed_secret,
                sim_version, client_key, status, opened_at, expires_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12)
             on conflict do nothing
             returning ${MATCH_COLS}`,
            [m.userId, m.mode, m.stakeCents, m.seats, m.teamSize, m.brawler, m.seedPublic,
             m.seedSecret, m.simVersion, m.clientKey, m.openedAt, m.expiresAt]);
          if (ins.rows[0]) return { match: ligneMatch(ins.rows[0]), repris: false };

          // L'insertion a buté sur l'une des deux contraintes. La clé du client d'abord : la même
          // demande rejouée doit rendre exactement la même réponse, quel que soit l'état du billet.
          const rejeu = await client.query(
            `select ${MATCH_COLS} from matches where user_id = $1 and client_key = $2`,
            [m.userId, m.clientKey]);
          if (rejeu.rows[0]) return { match: ligneMatch(rejeu.rows[0]), repris: true };

          // Sinon c'est un billet déjà ouvert. Encore valable ET JAMAIS JOUÉ, on le rend : une
          // déconnexion ou un onglet rouvert ne doit pas produire une seconde partie. La clé du
          // client n'est alors écrite nulle part — c'est la limite connue, décrite dans le README :
          // rejouée après l'expiration de ce billet-là, elle en ouvrira un nouveau.
          const ouvert = await client.query(
            `select ${MATCH_COLS} from matches where user_id = $1 and status = 'open'`, [m.userId]);
          if (!ouvert.rows[0]) continue;
          const vivant = new Date(ouvert.rows[0].expires_at) > m.openedAt;
          // UN BILLET NE SERT QU'UNE TENTATIVE. Toute la partie est une fonction pure de
          // `seed_public` : le resservir, c'est resservir le même monde à quelqu'un qui vient de
          // l'explorer. Dès qu'un résultat a été rendu dessus — réglé ou refusé — il est clos sans
          // montant et le joueur en reçoit un neuf, donc une graine neuve.
          if (vivant && !ouvert.rows[0].first_result_at)
            return { match: ligneMatch(ouvert.rows[0]), repris: true };

          // Périmé, ou déjà joué : on le clôt, et la place se libère pour le billet suivant. Ces
          // `update` ne touchent qu'un statut — jamais un montant.
          await client.query(
            `update matches set status = $2 where id = $1 and status = 'open'`,
            [ouvert.rows[0].id, vivant ? 'abandoned' : 'expired']);
        }
        throw new Error('impossible d\'ouvrir un billet : la place ne se libère pas');
      } finally {
        client.release();
      }
    },

    // Le billet d'un joueur, et de lui seul : `user_id` est dans la clause, pas vérifié après
    // coup. Un identifiant deviné ne doit rien apprendre sur la partie de quelqu'un d'autre.
    async findMatch({ matchId, userId }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `select ${MATCH_COLS} from matches where id = $1 and user_id = $2`, [matchId, userId]);
        return ligneMatch(r.rows[0]) || null;
      } finally {
        client.release();
      }
    },

    // MARQUER QU'UNE PARTIE A ÉTÉ JOUÉE SUR CE BILLET. Écriture de STATUT, jamais de montant : la
    // clause porte `status = 'open'` comme toutes les autres écritures de cette table, plus
    // `first_result_at is null` — la marque se pose UNE fois, donc un résultat renvoyé ne modifie
    // pas la ligne et l'idempotence de la route reste totale. C'est elle qui interdit qu'un billet
    // — donc une graine, donc un monde entier — resserve à une SECONDE partie.
    async markPlayed({ matchId, userId, at }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `update matches set first_result_at = $3
             where id = $1 and user_id = $2 and status = 'open' and first_result_at is null
           returning first_result_at`,
          [matchId, userId, at]);
        return { marque: !!r.rows[0] };
      } finally {
        client.release();
      }
    },

    // Le règlement, écrit UNE FOIS. L'idempotence est arbitrée par la clause `where`, jamais par
    // un `select` préalable : `status = 'open' and net_cents is null` fait que le second appel ne
    // touche aucune ligne, et on rend alors la ligne telle qu'elle a été close la première fois.
    // C'est la troisième clé d'idempotence annoncée par la spécification, celle sur (match_id).
    //
    // C'est le seul endroit du dossier où un montant entre en base, et il n'est jamais mis à
    // jour : les colonnes valent NULL avant, et cette phrase-là après.
    async settleMatch(r) {
      const client = await pool.connect();
      try {
        const maj = await client.query(
          `update matches set
             status = $3, settled_at = $4, issue = $5, controle = $6, motif = $7,
             gross_cents = $8, fee_cents = $9, net_cents = $10, purse_cents = $11,
             declared_net_cents = $12, ecart_cents = $13,
             seconds = $14, kills = $15, deaths = $16, rank = $17, cubes = $18, damage = $19,
             cashed_out = $20,
             trace_steps = $21, replay_digest = $22, digest_match = $23,
             divergence_step = $24, replay_ms = $25
           where id = $1 and user_id = $2 and status = 'open' and net_cents is null
           returning ${MATCH_COLS}`,
          [r.matchId, r.userId, r.status, r.settledAt, r.issue, r.controle, r.motif,
           r.grossCents, r.feeCents, r.netCents, r.purseCents, r.declaredNetCents, r.ecartCents,
           r.seconds, r.kills, r.deaths, r.rank, r.cubes, r.damage, r.cashedOut,
           r.traceSteps, r.replayDigest, r.digestMatch, r.divergenceStep, r.replayMs]);
        if (maj.rows[0]) return { match: ligneMatch(maj.rows[0]), deja: false };
        const deja = await client.query(
          `select ${MATCH_COLS} from matches where id = $1 and user_id = $2`, [r.matchId, r.userId]);
        return { match: ligneMatch(deja.rows[0]) || null, deja: true };
      } finally {
        client.release();
      }
    },

    // LA TRACE, EN INSERTION SEULE. Aucun `update`, aucun `delete`, premier écrit gagne : c'est la
    // clé primaire (match_id, seq) et `on conflict do nothing` qui arbitrent, jamais un `select`
    // préalable — même doctrine que `name_key` et que l'index partiel des billets ouverts. Un
    // segment renvoyé n'écrit donc pas de seconde ligne et ne réécrit pas la première, même s'il
    // porte d'autres données.
    //
    // La seule lecture préalable est celle de la BORNE : combien de pas ce billet a déjà reçus. Ce
    // n'est pas de l'idempotence, c'est un garde-fou de volume, et il n'a pas besoin d'être
    // atomique — deux segments concurrents pourraient la dépasser d'un segment, et le rejeu du
    // module 7 porte de toute façon sa propre borne dure. Écrit ici pour ne pas être découvert.
    //
    // Cette méthode ne touche JAMAIS la table `matches` : une trace refusée ne peut donc pas
    // laisser un billet bloqué, quoi qu'il arrive.
    async addTrace({ matchId, seq, simVersion, steps, data, maxSteps }) {
      const client = await pool.connect();
      try {
        const vus = await client.query(
          'select seq, steps, data from match_traces where match_id = $1', [matchId]);
        const meme = vus.rows.find(r => Number(r.seq) === seq);
        const avant = vus.rows.reduce((s, r) => s + Number(r.steps), 0);
        // UN RANG DÉJÀ POSÉ DONT LES DONNÉES DIFFÈRENT EST REFUSÉ, ET NOMMÉ. Le premier écrit gagne
        // — c'est la doctrine de cette table et elle ne bouge pas — mais l'avaler en silence
        // permettait de COUDRE deux parties bout à bout : le segment 0 d'une tentative et les
        // segments suivants d'une autre se recollaient en une partie que personne n'a jouée. Un
        // renvoi à l'identique, lui, reste parfaitement idempotent.
        if (meme && meme.data !== data)
          return { refuse: 'divergente', segments: vus.rows.length, totalSteps: avant };
        const deja = !!meme;
        if (!deja && avant + steps > maxSteps)
          return { refuse: 'trop_de_pas', segments: vus.rows.length, totalSteps: avant };
        await client.query(
          `insert into match_traces (match_id, seq, sim_version, steps, data)
           values ($1,$2,$3,$4,$5)
           on conflict do nothing`,
          [matchId, seq, simVersion, steps, data]);
        const apres = await client.query(
          `select count(*) as n, coalesce(sum(steps), 0) as total
             from match_traces where match_id = $1`, [matchId]);
        const l = apres.rows[0] || {};
        // Le même piège de pilote que les statistiques : `count()` et `sum()` rendent un `bigint`,
        // donc une CHAÎNE. Une borne comparée à du texte comparerait n'importe quoi.
        return { segments: Number(l.n) || 0, totalSteps: Number(l.total) || 0 };
      } finally {
        client.release();
      }
    },

    // LA TRACE, RELUE POUR LE REJEU. En lecture seule, dans l'ordre des rangs, et sans le moindre
    // `update` : c'est la même table en insertion seule, vue de l'autre côté. Le routeur recolle
    // les segments lui-même et refuse un rang manquant — un trou recollé en silence ferait rejouer
    // une partie qui n'a jamais eu lieu.
    async listTraces({ matchId }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          'select seq, sim_version, steps, data from match_traces where match_id = $1 order by seq',
          [matchId]);
        // `seq` et `steps` sont des `integer`, donc le pilote les rend en nombres ; `Number` les
        // couvre quand même, pour la raison écrite partout ailleurs — une panne silencieuse coûte
        // plus cher que deux conversions.
        return r.rows.map(t => ({ ...t, seq: Number(t.seq), steps: Number(t.steps),
                                  sim_version: Number(t.sim_version) }));
      } finally {
        client.release();
      }
    },

    // Le veilleur. Il clôt les billets que personne n'a terminés, et EUX SEULS : la clause porte
    // `status = 'open'` et l'expiration, aucun montant n'est écrit, aucune partie réglée n'est
    // touchée. L'heure lui est passée, elle n'est pas lue ici — c'est ce qui permet de le tester
    // sans attendre.
    async expireMatches({ avant, max = 500 }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `update matches set status = 'expired'
             where id in (select id from matches
                           where status = 'open' and expires_at <= $1
                           order by expires_at limit $2)
           returning id`, [avant, max]);
        return { closes: r.rows.length };
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}

// `ledgerWrite`, `ledgerSolde` et `ledgerDe` sont exportées à part parce qu'elles prennent un client
// en transaction : ce ne sont pas des méthodes du `db` injecté dans `createApp()`, et le routeur ne
// les voit jamais. Ce qui les appelle, ce sont les méthodes nommées de `pgDb` — et `api/db-check.js`,
// qui les éprouve contre une VRAIE Postgres, ce qu'aucun test sans base ne peut faire.
module.exports = { pgDb, ledgerWrite, ledgerSolde, ledgerDe };
