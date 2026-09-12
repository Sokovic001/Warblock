// L'adaptateur Postgres. Le seul fichier qui parle à la base ; le routeur ne connaît que ces deux
// méthodes, ce qui permet de le tester avec une base factice.
'use strict';
const { Pool } = require('pg');

const COLS = 'id, auth_id, email, name, name_key, avatar, country, created_at';
// La graine secrète est LUE ici — c'est la seule colonne de cette liste qui ne doit jamais
// traverser le réseau. C'est `app.js` qui la retire, par sa liste blanche `billet()`.
const MATCH_COLS = 'id, user_id, mode, stake_cents, seats, brawler, seed_public, seed_secret, ' +
                   'client_key, status, opened_at, expires_at, ' +
                   // le règlement : NULL tant que la partie est ouverte, écrit une seule fois
                   'settled_at, issue, controle, motif, gross_cents, fee_cents, net_cents, ' +
                   'purse_cents, declared_net_cents, ecart_cents, ' +
                   'seconds, kills, deaths, rank, cubes, damage, cashed_out';

// Le pilote Postgres rend les colonnes `bigint` sous forme de CHAÎNE — il ne peut pas garantir
// qu'elles tiennent dans un nombre JavaScript. Les deux graines, elles, tiennent d'office : leur
// domaine est celui des entiers 32 bits non signés, et c'est en nombre que WBCore les attend.
// `id` et `user_id` restent des chaînes, on ne fait que les recopier.
function ligneMatch(r) {
  if (!r) return r;
  return { ...r, seed_public: Number(r.seed_public), seed_secret: Number(r.seed_secret) };
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

  async function stats(client, userId) {
    const r = await client.query('select matches, wins, kills, best from user_stats where user_id = $1', [userId]);
    return r.rows[0] || { matches: 0, wins: 0, kills: 0, best: 0 };
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
        await client.query('insert into user_stats (user_id) values ($1) on conflict do nothing', [user.id]);
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
               (user_id, mode, stake_cents, seats, brawler, seed_public, seed_secret,
                client_key, status, opened_at, expires_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)
             on conflict do nothing
             returning ${MATCH_COLS}`,
            [m.userId, m.mode, m.stakeCents, m.seats, m.brawler, m.seedPublic, m.seedSecret,
             m.clientKey, m.openedAt, m.expiresAt]);
          if (ins.rows[0]) return { match: ligneMatch(ins.rows[0]), repris: false };

          // L'insertion a buté sur l'une des deux contraintes. La clé du client d'abord : la même
          // demande rejouée doit rendre exactement la même réponse, quel que soit l'état du billet.
          const rejeu = await client.query(
            `select ${MATCH_COLS} from matches where user_id = $1 and client_key = $2`,
            [m.userId, m.clientKey]);
          if (rejeu.rows[0]) return { match: ligneMatch(rejeu.rows[0]), repris: true };

          // Sinon c'est un billet déjà ouvert. Encore valable, on le rend : une déconnexion ou un
          // onglet rouvert ne doit pas produire une seconde partie. La clé du client n'est alors
          // écrite nulle part — c'est la limite connue, décrite dans le README : rejouée après
          // l'expiration de ce billet-là, elle en ouvrira un nouveau.
          const ouvert = await client.query(
            `select ${MATCH_COLS} from matches where user_id = $1 and status = 'open'`, [m.userId]);
          if (!ouvert.rows[0]) continue;
          if (new Date(ouvert.rows[0].expires_at) > m.openedAt)
            return { match: ligneMatch(ouvert.rows[0]), repris: true };

          // Périmé : on le clôt, et la place se libère pour le billet suivant. Le seul `update` de
          // cette table, et il ne touche qu'un statut — jamais un montant.
          await client.query(
            `update matches set status = 'expired' where id = $1 and status = 'open'`,
            [ouvert.rows[0].id]);
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
             cashed_out = $20
           where id = $1 and user_id = $2 and status = 'open' and net_cents is null
           returning ${MATCH_COLS}`,
          [r.matchId, r.userId, r.status, r.settledAt, r.issue, r.controle, r.motif,
           r.grossCents, r.feeCents, r.netCents, r.purseCents, r.declaredNetCents, r.ecartCents,
           r.seconds, r.kills, r.deaths, r.rank, r.cubes, r.damage, r.cashedOut]);
        if (maj.rows[0]) return { match: ligneMatch(maj.rows[0]), deja: false };
        const deja = await client.query(
          `select ${MATCH_COLS} from matches where id = $1 and user_id = $2`, [r.matchId, r.userId]);
        return { match: ligneMatch(deja.rows[0]) || null, deja: true };
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

module.exports = { pgDb };
