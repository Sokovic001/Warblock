// L'adaptateur Postgres. Le seul fichier qui parle à la base ; le routeur ne connaît que ces deux
// méthodes, ce qui permet de le tester avec une base factice.
'use strict';
const { Pool } = require('pg');

const COLS = 'id, auth_id, email, name, name_key, avatar, country, created_at';

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

    close: () => pool.end(),
  };
}

module.exports = { pgDb };
