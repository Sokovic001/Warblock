// L'adaptateur Postgres. Le seul fichier qui parle à la base ; le routeur ne connaît que ces deux
// méthodes, ce qui permet de le tester avec une base factice.
'use strict';
const { Pool } = require('pg');
// Le grand livre. `api/ledger.js` est PUR — il ne charge rien, il ne pose rien — et c'est ce
// fichier-ci qui persiste ce qu'il construit. Les montants, eux, ne sortent que de
// `WBCore.cashoutCents`, écrits sur la ligne `matches` par le routeur : rien ici ne recalcule une
// commission, et rien ici n'invente un montant.
const L = require('./ledger');

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
  // LE DÉCOUVERT, VÉRIFIÉ ICI ET POUR TOUT LE MONDE. Il n'existe aucune contrainte déclarative qui
  // exprime « la somme des lignes de ce compte reste positive » : la règle est donc applicative, et
  // elle est posée à l'endroit qui la rend impossible à contourner — l'écrivain unique, dans la
  // transaction, après le verrou que l'appelant a pris. La poser chez l'appelant aurait protégé le
  // chemin qui l'appelle, pas la donnée, et le second chemin d'écriture ne l'aurait pas suivie.
  //
  // On regarde l'effet NET du mouvement sur chaque compte, pas jambe par jambe : un règlement
  // crédite le séquestre du reliquat avant de le vider, et l'ordre des lignes à l'intérieur d'une
  // transaction ne veut rien dire. Deux comptes seulement sont exemptés — un compte d'émission et
  // un compte de contrepartie, dont le solde négatif EST la mesure qu'on cherche.
  //
  // Ce que cette règle referme, et qu'une clé d'idempotence ne peut pas fermer seule : un second
  // gain sur un même billet devrait débiter un séquestre déjà vide, et se fait donc refuser.
  const effet = new Map();
  for (const t of lignes) {
    effet.set(t.compteDebit, (effet.get(t.compteDebit) || 0) - t.montantCents);
    effet.set(t.compteCredit, (effet.get(t.compteCredit) || 0) + t.montantCents);
  }
  for (const [compte, delta] of effet) {
    // Un compte hors grammaire n'est pas notre affaire ici : c'est le `check` de la colonne qui le
    // refusera, et il le nommera mieux que nous.
    if (delta >= 0 || !L.compteValide(compte) || L.decouvertAutorise(compte)) continue;
    const solde = await ledgerSolde(client, compte);
    if (solde + delta < 0) {
      const e = new Error(`grand livre : ${compte} porte ${solde} et ce mouvement lui demande ${-delta}`);
      e.code = 'decouvert';
      e.compte = compte; e.solde = solde; e.requis = -delta;
      throw e;
    }
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

// LES DEUX SEULS ÉCHECS DU GRAND LIVRE QUE L'APPELANT A LE DROIT DE TRADUIRE EN REFUS NOMMÉ, et
// pas en 500. `23505` est la clé d'idempotence qui refuse une jambe déjà posée — l'écrivain n'a
// AUCUN `on conflict do nothing`, et c'est voulu : un doublon veut dire qu'on paie deux fois, donc
// l'appelant doit l'apprendre. `decouvert` est la règle uniforme du découvert. Les deux disent la
// même chose à la route : cette écriture-là ne se fera pas, rien n'a été posé, et la ligne repart
// comme si l'appel n'avait pas eu lieu. Tout le reste est une vraie panne et remonte telle quelle.
function refusDuLivre(e) {
  return !!e && (e.code === '23505' || e.code === 'decouvert');
}

// LE JOUR D'UNE RECHARGE, en UTC et pas dans le fuseau de la machine. Deux instances déployées dans
// deux régions changeraient sinon de jour à deux heures différentes, et la recharge « une par jour »
// deviendrait « une ou deux par jour selon le serveur qui répond ». L'heure vient de l'appelant —
// c'est l'horloge injectée dans `createApp` — pour que la règle se teste sans attendre minuit.
function jourDe(at) {
  const d = at instanceof Date ? at : new Date(at === undefined || at === null ? Date.now() : at);
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new Error('grand livre : la recharge a besoin d\'une heure lisible');
  return d.toISOString().slice(0, 10);
}

// LE RÈGLEMENT D'UN SÉQUESTRE, ET IL N'Y EN A QU'UN. Vider le séquestre d'un billet que personne
// n'a terminé et régler celui d'un joueur qui vient de perdre sont la MÊME opération comptable :
// une partie qui n'a rien rapporté. `api/ledger.js` l'écrit une fois pour toutes — pas de
// `mouvementExpiration`, un `mouvementGain` de brut nul — et il n'y a donc ici qu'une fonction, pas
// deux qui ne se seraient distinguées que par le chemin qui les appelle.
//
// DEUX DÉCISIONS À LIRE ENSEMBLE :
//
// 1. LA FRONTIÈRE AVEC LA 02a SE CONSTATE ICI. Un séquestre vide veut dire que le grand livre n'a
//    jamais engagé cette partie — une ligne de la phase 02a, écrite avant que le livre n'existe. On
//    n'écrit alors RIEN : une ligne sans écriture de mise n'a jamais d'écriture de gain, et
//    inventer un gain sur elle ferait payer la maison pour une partie qu'elle n'a jamais encaissée.
// 2. LA MISE PASSÉE AU MOUVEMENT EST CE QUE LE SÉQUESTRE PORTE, pas ce que la ligne `matches`
//    annonce. Le mouvement est ainsi garanti de le vider jusqu'au dernier centime, quoi qu'il
//    arrive. Confronter les deux nombres est le travail de `ledgerReconcile`, appelé à la fin de
//    chaque scénario : un règlement qui laisserait un séquestre à moitié habité serait une panne
//    silencieuse, et le rôle de cette fonction est de n'en produire aucune.
async function reglerSequestre(client, ligne) {
  const engage = await ledgerSolde(client, L.compteEnjeu(ligne.id));
  if (engage <= 0) return { ecrites: 0 };
  return ledgerWrite(client, L.mouvementGain({
    userId: ligne.user_id,
    matchId: ligne.id,
    miseCents: engage,
    // Les trois montants viennent de la ligne, donc de `WBCore.cashoutCents` par `matchVerdict`.
    // L'API ne recalcule JAMAIS la commission, pas même « juste pour vérifier ». Un billet clos
    // sans règlement les a tous les trois à NULL : c'est zéro, et un seul transfert en sort.
    grossCents: ligne.gross_cents || 0,
    feeCents: ligne.fee_cents || 0,
    netCents: ligne.net_cents || 0,
    // LA DIVERGENCE ENVOIE LE GAIN EN QUARANTAINE : visible, chiffré, jamais dépensable. Seul
    // `digest_match === true` est une convergence — `null` veut dire « pas rejoué », et une ligne
    // qui n'a pas été rejouée n'a jamais de net à créditer.
    convergee: ligne.digest_match === true,
  }));
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
    // LA CONNEXION, ET LES DEUX SEULS MOUVEMENTS QUE LE SERVEUR S'ÉCRIT À LUI-MÊME. Il n'existe
    // AUCUNE route `POST /api/credits` : une route de frappe de monnaie appelable par le client est
    // exactement ce qu'on refuse. La dotation et la recharge naissent donc ici, dans la transaction
    // qui crée ou retrouve le compte, et le client ne peut que se connecter.
    async findOrCreate({ authId, email, name, nameKey, at }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        let user = null;
        const trouve = await client.query(`select ${COLS} from users where auth_id = $1`, [authId]);
        if (trouve.rows[0]) {
          user = trouve.rows[0];
        } else {
          // Première connexion : on crée le compte. Le pseudo proposé par le fournisseur peut déjà
          // être pris — on ajoute un suffixe jusqu'à trouver libre, plutôt que d'échouer au nez du
          // joueur le jour de son inscription. Il pourra le changer ensuite.
          let base = name, cle = nameKey(base), n = 1;
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
          // LA DOTATION, DANS LA MÊME TRANSACTION QUE LA CRÉATION DU COMPTE. Les deux échouent ou
          // réussissent ensemble : un compte sans dotation serait un joueur qui ne peut rien faire
          // et que rien ne réparerait, puisqu'il ne sera plus jamais créé. Elle est idempotente sur
          // `(dotation, <user_id>)`, et c'est la clé unique du livre qui l'arbitre — mais elle
          // n'est même pas sollicitée : la ligne `users` vient d'être insérée, donc personne
          // d'autre n'a pu écrire cette référence.
          await ledgerWrite(client, L.mouvementDotation({
            userId: user.id, montantCents: L.DOTATION_CENTS }));
        }

        // LE VERROU, ET IL EST OBLIGATOIRE ICI AUSSI. La recharge se décide sur une SOMME — « le
        // solde dépensable est-il au-dessous du plancher ? » — et aucune contrainte déclarative ne
        // sait exprimer cela. Lire puis écrire sans verrou laisserait deux onglets écrire deux
        // recharges ; avec lui, la lecture préalable est exacte au lieu d'être une fenêtre.
        await client.query('select id from users where id = $1 for update', [user.id]);
        const dispo = L.compteJoueur(user.id);
        if (await ledgerSolde(client, dispo) < L.PLANCHER_CENTS) {
          const jour = jourDe(at);
          // Une par joueur et par jour : c'est la référence qui le dit, et la clé unique du livre
          // qui le tient. On relit quand même, parce qu'un doublon annulerait TOUTE la transaction
          // de connexion — le livre refuse un doublon au lieu de l'avaler, et c'est voulu — alors
          // qu'un joueur qui redescend sous le plancher le même jour est un cas parfaitement normal.
          const deja = await ledgerDe(client, { reference: `${user.id}:${jour}` });
          if (!deja.length) {
            await ledgerWrite(client, L.mouvementRecharge({
              userId: user.id, jour, montantCents: L.RECHARGE_CENTS }));
          }
        }

        // Les deux montants sont LUS PAR SOMME, jamais dans une colonne. Le relire après la
        // recharge plutôt que d'ajouter le montant à ce qu'on avait lu n'est pas de la coquetterie :
        // c'est la seule façon de rendre ce que le livre dit, et pas ce que le code croit.
        const balanceCents = await ledgerSolde(client, dispo);
        const quarantineCents = await ledgerSolde(client, L.compteQuarantaine(user.id));
        // Les statistiques n'ont rien à initialiser : un compte neuf n'a aucune partie réglée, et la
        // somme d'un ensemble vide vaut zéro.
        const s = await stats(client, user.id);
        await client.query('commit');
        return { user, stats: s, balanceCents, quarantineCents };
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
        // Les deux montants repartent avec le profil pour que `GET /api/me` et `PATCH /api/me`
        // rendent EXACTEMENT la même forme. Une réponse dont la forme dépend du verbe est une
        // réponse que le client finit par lire de deux façons.
        return { user, stats: await stats(client, user.id),
                 balanceCents: await ledgerSolde(client, L.compteJoueur(user.id)),
                 quarantineCents: await ledgerSolde(client, L.compteQuarantaine(user.id)) };
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

    // L'OUVERTURE D'UN BILLET, ET SON DÉBIT, DANS UNE SEULE TRANSACTION. Ce n'est plus la boucle en
    // validation automatique de la 02a : le seul instant que le serveur observe sans dépendre du
    // client est celui où il émet le billet, donc c'est là que la mise est débitée. Pas de billet
    // sans son écriture, pas d'écriture sans son billet — les deux échouent ou réussissent
    // ensemble. Débiter au coup d'envoi laisserait jouer gratuitement qui ne l'annonce jamais ;
    // compenser à la fin laisserait jouer gratuitement qui ne rend jamais de résultat.
    //
    // Rien n'est vérifié avant d'insérer : ce sont les deux index uniques qui arbitrent, et
    // l'insertion refusée qui nous apprend ce qui existait déjà. Un `select` préalable laisserait
    // une fenêtre entre le « a-t-il déjà un billet ? » et l'écriture — la même fenêtre que celle
    // qu'on refuse pour name_key.
    async createMatch(m) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // LE VERROU, PRIS EN TÊTE DE TRANSACTION ET AVANT QUE LA SOMME NE SOIT CALCULÉE. Il n'y a
        // pas de table des comptes — c'est tout l'intérêt du grand livre — donc on ne peut pas
        // verrouiller « la ligne du compte » : on verrouille la seule ligne qui existe par joueur.
        // Sans lui, deux onglets qui ouvrent un billet en même temps lisent tous deux un solde de
        // 50, débitent tous deux 50, et AUCUN `check` de colonne ne peut voir une somme d'autres
        // lignes. C'est le premier verrou explicite du dépôt, et la doublure d'`api/test.js` ne
        // peut pas le prouver : un mono-fil JavaScript sérialise gratuitement ce que Postgres ne
        // sérialise que si on le lui demande bien. Seul `api/db-check.js` l'éprouve.
        await client.query('select id from users where id = $1 for update', [m.userId]);
        const dispo = L.compteJoueur(m.userId);
        const quarantaine = L.compteQuarantaine(m.userId);
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
          if (ins.rows[0]) {
            const solde = await ledgerSolde(client, dispo);
            const enQuarantaine = await ledgerSolde(client, quarantaine);
            // LE SOLDE INSUFFISANT NE LAISSE NI BILLET NI ÉCRITURE. L'annulation rend la ligne
            // qu'on venait d'insérer à l'inexistence : c'est la leçon du `22003`, transposée sur le
            // chemin de l'argent. Un joueur n'a qu'un billet ouvert à la fois, donc une route qui
            // échoue en laissant une ligne à demi écrite l'enferme jusqu'à l'expiration, mise
            // débitée. Il redemande une partie juste après, et il obtient le même refus nommé.
            if (solde < m.stakeCents) {
              await client.query('rollback');
              return { match: null, refus: 'fonds', balanceCents: solde,
                       quarantineCents: enQuarantaine, requisCents: m.stakeCents };
            }
            try {
              await ledgerWrite(client, L.mouvementMise({
                userId: m.userId, matchId: ins.rows[0].id, miseCents: m.stakeCents }));
            } catch (e) {
              if (!refusDuLivre(e)) throw e;
              await client.query('rollback');
              return { match: null, refus: 'livre', detail: e.code };
            }
            const apres = await ledgerSolde(client, dispo);
            await client.query('commit');
            return { match: ligneMatch(ins.rows[0]), repris: false,
                     balanceCents: apres, quarantineCents: enQuarantaine };
          }

          // L'insertion a buté sur l'une des deux contraintes. La clé du client d'abord : la même
          // demande rejouée doit rendre exactement la même réponse, quel que soit l'état du billet.
          //
          // LE CHEMIN `repris` N'ÉCRIT JAMAIS UNE SECONDE MISE, et c'est le vol le plus facile de
          // la phase : un `POST` rejoué qui débite deux fois. Il n'y a pas d'écriture ici, et il ne
          // doit jamais y en avoir — la clé unique du livre le refuserait, mais un refus annulerait
          // la transaction et rendrait un 500 sur une requête parfaitement honnête.
          const rejeu = await client.query(
            `select ${MATCH_COLS} from matches where user_id = $1 and client_key = $2`,
            [m.userId, m.clientKey]);
          if (rejeu.rows[0]) {
            const r = { match: ligneMatch(rejeu.rows[0]), repris: true,
                        balanceCents: await ledgerSolde(client, dispo),
                        quarantineCents: await ledgerSolde(client, quarantaine) };
            await client.query('commit');
            return r;
          }

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
          if (vivant && !ouvert.rows[0].first_result_at) {
            const r = { match: ligneMatch(ouvert.rows[0]), repris: true,
                        balanceCents: await ledgerSolde(client, dispo),
                        quarantineCents: await ledgerSolde(client, quarantaine) };
            await client.query('commit');
            return r;
          }

          // Périmé, ou déjà joué : on le clôt, et la place se libère pour le billet suivant. Cet
          // `update` ne touche qu'un statut — jamais un montant.
          await client.query(
            `update matches set status = $2 where id = $1 and status = 'open'`,
            [ouvert.rows[0].id, vivant ? 'abandoned' : 'expired']);
          // ET SON SÉQUESTRE SE VIDE, DANS LA MÊME TRANSACTION. Une ligne close dont le séquestre
          // reste habité est de l'argent que plus rien ne soldera : l'invariant
          // `solde(enjeu:<match>) = 0 sur toute ligne close` tomberait ici, sur le chemin le plus
          // banal de l'API. Le joueur n'est pas remboursé — c'est la règle de la phase — la mise
          // rentre chez la maison.
          await reglerSequestre(client, ouvert.rows[0]);
        }
        // Deux tours et toujours pas de place : quelqu'un d'autre écrit en même temps. On rend la
        // main, et le `catch` annule tout — y compris la clôture du billet périmé, qui sera refaite
        // à la tentative suivante. Aucune écriture ne survit à cet échec.
        throw new Error('impossible d\'ouvrir un billet : la place ne se libère pas');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
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
    //
    // DEPUIS LA PHASE 03, LE RÈGLEMENT DE LA LIGNE ET LES TRANSFERTS DU GAIN SONT UNE SEULE
    // TRANSACTION. Un règlement interrompu au milieu ne laisse donc aucune écriture partielle, et
    // régler deux fois crédite une fois : la clause `where` arbitre la ligne, la clé unique du
    // grand livre arbitre les écritures, et le séquestre vidé les refuserait de toute façon. Trois
    // protections qui se recouvrent, et c'est voulu — la première qui tombe n'ouvre rien.
    async settleMatch(r) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // LE VERROU, sur la seule ligne qui existe par partie. C'est le séquestre de CETTE partie
        // qu'on s'apprête à débiter, et il n'y a pas de table des comptes à verrouiller.
        await client.query('select id from matches where id = $1 for update', [r.matchId]);
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
        if (maj.rows[0]) {
          // LES MONTANTS VIENNENT DE LA LIGNE QU'ON VIENT D'ÉCRIRE, pas des arguments : ce qui est
          // crédité est exactement le `net_cents` que la base porte, et il ne vient de nulle part
          // ailleurs. C'est aussi ce qui rend le règlement relisible six mois plus tard.
          try {
            await reglerSequestre(client, maj.rows[0]);
          } catch (e) {
            if (!refusDuLivre(e)) throw e;
            // TOUT EST ANNULÉ, Y COMPRIS LE RÈGLEMENT DE LA LIGNE. Un règlement interrompu au
            // milieu ne laisse aucune écriture partielle : la ligne repart `open`, sans montant,
            // et le joueur peut renvoyer son résultat sur le MÊME billet tant qu'il vit. C'est la
            // leçon du `22003` — un 500 qui laisse une ligne à demi écrite enferme le joueur.
            await client.query('rollback');
            return { match: null, refus: 'livre', detail: e.code };
          }
          await client.query('commit');
          return { match: ligneMatch(maj.rows[0]), deja: false };
        }
        // Déjà réglée : on relit la ligne telle qu'elle a été close la première fois, et ON N'ÉCRIT
        // RIEN. Régler deux fois crédite une fois.
        const deja = await client.query(
          `select ${MATCH_COLS} from matches where id = $1 and user_id = $2`, [r.matchId, r.userId]);
        await client.query('commit');
        return { match: ligneMatch(deja.rows[0]) || null, deja: true };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
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
module.exports = { pgDb, ledgerWrite, ledgerSolde, ledgerDe, reglerSequestre, jourDe };
