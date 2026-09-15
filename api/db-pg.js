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
const MATCH_COLS = 'id, user_id, mode, stake_cents, seats, team_size, paid_seats, brawler, seed_public, seed_secret, ' +
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

// LE SOLDE D'UN COMPTE, ÉCRIT UNE SEULE FOIS ET INTERPOLÉ DEUX. Il sert à `ledgerSolde` ci-dessous,
// et à la troisième condition de la purge des traces — « rien n'est en attente : le séquestre de
// cette partie est à zéro ». Deux écritures de « un solde est cette somme-là » finiraient par
// différer, et celle qui différerait serait justement celle qui autorise un EFFACEMENT.
//
// Ce que la fonction reçoit est une EXPRESSION SQL et jamais une valeur : `$1` d'un côté, une
// concaténation sur `matches.id` de l'autre. Rien de ce qui entre ici ne vient d'une requête HTTP.
function soldeExpr(compte) {
  return `coalesce(sum(montant_cents) filter (where compte_credit = ${compte}), 0)
        - coalesce(sum(montant_cents) filter (where compte_debit  = ${compte}), 0)`;
}

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
  // ON INSÈRE D'ABORD, ON VÉRIFIE LE DÉCOUVERT ENSUITE — dans la même transaction, donc un découvert
  // annule toujours tout, et rien n'est jamais écrit à moitié. L'ordre inverse paraissait le plus
  // prudent et il donnait la mauvaise réponse : au REJEU d'une contre-passation déjà posée, le
  // découvert parlait le premier, précisément parce que le compte de commission avait été vidé par
  // la contre-passation d'origine. L'opérateur lisait « maison:commission porte 0 » là où la vérité
  // est « c'était déjà fait », et la raison du refus dépendait du solde d'un compte au lieu du fait,
  // pourtant certain, que l'écriture existait déjà. Le job `db` l'a vu ; aucune doublure ne le
  // pouvait, puisqu'elle n'a pas de clé d'unicité à faire parler.
  //
  // Une clé d'idempotence est un FAIT, un solde est un ÉTAT. Quand les deux refusent, c'est le fait
  // qui doit nommer le refus : `ledger_entries_mouvement_uniq` lève son `23505` avant qu'un solde
  // ne soit seulement lu, et l'appelant le traduit en « déjà fait ».
  for (const t of lignes) {
    await client.query(
      `insert into ledger_entries (motif, reference, compte_debit, compte_credit, montant_cents)
       values ($1,$2,$3,$4,$5)`,
      [t.motif, t.reference, t.compteDebit, t.compteCredit, t.montantCents]);
  }
  for (const [compte, delta] of effet) {
    // Un compte hors grammaire n'est pas notre affaire ici : c'est le `check` de la colonne qui le
    // refusera, et il le nommera mieux que nous.
    if (delta >= 0 || !L.compteValide(compte) || L.decouvertAutorise(compte)) continue;
    // Le solde est lu APRÈS les insertions, donc il les porte déjà : la question n'est plus « ce
    // mouvement tiendrait-il ? » mais « le compte est-il resté positif ? ». C'est la même règle, et
    // elle n'a plus à simuler ce que la base vient d'écrire. Le message, lui, continue de dire le
    // solde d'AVANT, qui est ce que l'appelant comprend.
    const solde = await ledgerSolde(client, compte);
    if (solde < 0) {
      const avant = solde - delta;
      const e = new Error(`grand livre : ${compte} porte ${avant} et ce mouvement lui demande ${-delta}`);
      e.code = 'decouvert';
      e.compte = compte; e.solde = avant; e.requis = -delta;
      throw e;
    }
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
    `select ${soldeExpr('$1')} as total
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

// ---------------------------------------------------------------------------------------------
// LE JOURNAL DES GESTES D'OPÉRATION, ET IL PREND LE MÊME CLIENT EN TRANSACTION QUE L'ÉCRIVAIN
// D'ARGENT. C'est toute la raison d'être de cette fonction : l'écriture et sa justification doivent
// échouer ou réussir ENSEMBLE. Une raison consignée après coup peut ne jamais l'être, et une
// contre-passation sans raison est indistinguable d'une erreur de manipulation.
//
// `ledger_audit` est en INSERTION SEULE comme `ledger_entries` : il n'existe ici ni `update`, ni
// `delete`, ni `on conflict`. Une trace qu'on peut réécrire ne trace rien.
//
// Le nom de la liste de colonnes n'est PAS `LEDGER_AUDIT_COLS`, et ce n'est pas un caprice : une
// garde d'`api/test.js` relit toute constante nommée `LEDGER_*` comme une liste de colonnes du
// GRAND LIVRE, et exigerait de `geste` ou de `raison` qu'elles soient des colonnes de
// `ledger_entries`.
const AUDIT_COLS = 'id, geste, operateur, raison, user_id, motif_origine, reference_origine, ' +
                   'reference_posee, jambes, montant_cents, cree_le';

// Un geste qui ne porte sur AUCUN mouvement d'argent — l'anonymisation d'un compte — laisse les cinq
// colonnes d'argent à NULL, et la contrainte `ledger_audit_anonymisation_complete` l'exige. `Number`
// appliqué sans réfléchir rendrait `0`, c'est-à-dire un montant nul là où il n'y a PAS de montant :
// le même piège de frontière que partout ailleurs dans ce fichier, à l'envers.
function ligneAudit(l) {
  const ou = (v, f) => (v === null || v === undefined ? null : f(v));
  return { ...l, id: String(l.id), user_id: ou(l.user_id, String),
           jambes: ou(l.jambes, Number), montant_cents: ou(l.montant_cents, Number) };
}

// LE JOURNAL SE RELIT, ET C'EST AUSSI IMPORTANT QUE DE L'ÉCRIRE. Un audit que seul `psql` sait lire
// est une invitation à ouvrir `psql` — c'est-à-dire ce que ce module existe pour éviter. Il se relit
// par le mouvement qu'il corrige, parce que c'est ce dont l'opérateur part.
async function ledgerAuditDe(client, { motif, reference }) {
  const r = await client.query(
    `select ${AUDIT_COLS} from ledger_audit
      where motif_origine = $1 and reference_origine = $2 order by id`, [motif, reference]);
  return r.rows.map(ligneAudit);
}

// ET IL SE RELIT AUSSI PAR LE COMPTE, depuis le module 6 : l'anonymisation ne porte sur aucun
// mouvement, donc la lecture ci-dessus ne la retrouverait jamais. Une trace qu'on ne sait pas relire
// par le chemin dont on part ne trace rien d'utile.
async function ledgerAuditDeJoueur(client, { userId }) {
  const r = await client.query(
    `select ${AUDIT_COLS} from ledger_audit where user_id = $1 order by id`, [userId]);
  return r.rows.map(ligneAudit);
}

async function ledgerAuditWrite(client, plan) {
  await client.query(
    `insert into ledger_audit
       (geste, operateur, raison, user_id, motif_origine, reference_origine, reference_posee,
        jambes, montant_cents)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [plan.geste, plan.par, plan.raison, plan.userId === undefined ? null : plan.userId,
     plan.motifOrigine, plan.referenceOrigine,
     plan.referencePosee, plan.jambes, plan.montantCents]);
  return { ecrites: 1 };
}

// ---------------------------------------------------------------------------------------------
// L'EXPOSITION RÉALISÉE, ET LA REQUÊTE QUI NE FAIT AUCUN CAST SUR LA RÉFÉRENCE.
//
// `ledger_entries.reference` est du TEXTE, et `mouvementContrepassation` y écrit `gain:42` et non
// `42`. Une jointure `ledger → matches` par `reference::bigint` lèverait donc `22P02` sur ces
// lignes-là ; une jointure qui les FILTRE les ignore, c'est-à-dire qu'un gain contre-passé
// continuerait de peser dans l'exposition. C'est le piège de la phase, et il naît vert : le module
// qui écrit la requête n'est pas celui qui crée les lignes qui la cassent.
//
// La règle qui ramène une écriture à un billet vit dans `api/ledger.js`, elle est pure, elle est
// exhaustive sur la liste fermée des motifs, et elle exporte SA TRADUCTION SQL. On l'INTERPOLE ici
// plutôt que de la réécrire : deux écritures de la même règle finissent par différer, et celle qui
// différerait vivrait dans un littéral SQL que personne ne relit. Même patron que `COMPTE_RE_SQL`
// dans `schema.sql`, et une garde textuelle d'`api/test.js` confronte les deux.
//
// L'EXPRESSION EST CALCULÉE DANS UNE SOUS-REQUÊTE SUR `ledger_entries` SEULE, et ce n'est pas du
// style : elle nomme `motif` et `reference` sans les qualifier, et `matches` porte elle aussi une
// colonne `motif`. Écrite directement dans le `join`, elle sortirait en `42702` — « column
// reference motif is ambiguous » — sur le chemin de l'ouverture d'un billet.
//
// LES COMPTES ET LES MOTIFS SONT DES PARAMÈTRES, pas des littéraux : ils viennent de
// `L.COMPTES_EXPOSITION` et de `L.MOTIFS_EXPOSITION`, les mêmes listes que lit `expositionDe`.
// `maison:dotation` n'y entre jamais — émettre des crédits fictifs n'est pas s'exposer.
//
// L'exposition est `débits − crédits` sur les comptes de maison, c'est-à-dire l'OPPOSÉ de leur
// solde : exactement ce que `expositionDe` calcule côté JavaScript, sur les mêmes lignes.
//
// LA SOUS-REQUÊTE EST BORNÉE PAR LE JOUEUR, ET C'EST TOUT L'INTÉRÊT DE CETTE REQUÊTE-LÀ. Sans le
// dernier prédicat, ses trois clauses — la fenêtre, les motifs, les comptes de maison — ne
// mentionnaient PAS le joueur : `m.user_id = $1` ne s'appliquait qu'APRÈS la jointure, et Postgres
// ne pouvait pas le descendre, puisque le `join` porte sur une expression `case` qu'aucun index ne
// couvre. L'agrégat valait donc O(trafic du SITE) et non O(billets du joueur), sur le chemin le plus
// disputé du système et PENDANT que la transaction tient `select id from users where id = $1 for
// update` — c'est-à-dire l'incident `GET /api/me` que la décision 6 cite pour justifier de sortir le
// fusible de la transaction, reproduit à l'endroit exact qu'elle prétend protéger. La propriété
// « son agrégat est borné par les billets d'un seul joueur » est écrite dans cinq documents : elle
// est tenue ici, ou elle n'est tenue nulle part.
//
// LA RESTRICTION PORTE SUR LE BILLET CALCULÉ, JAMAIS SUR `reference` BRUTE. C'est le piège nommé de
// la phase, et l'écrire sur `reference` le rouvrirait entièrement : une contre-passation porte
// `gain:42` et non `42`, donc elle sortirait du filtre et un gain annulé recommencerait à peser dans
// l'exposition. On réutilise donc `REFERENCE_BILLET_SQL`, la MÊME expression que celle qui sert au
// `join` — il n'existe jamais deux écritures de la même règle.
//
// Le prédicat est logiquement REDONDANT avec la jointure : il ne change aucun résultat, il ne fait
// que dire au planificateur ce que la jointure implique déjà. C'est ce qui le rend sûr à poser.
//
// LA BORNE HAUTE, `cree_le <= $5`, EXISTE POUR QUE LE CHIFFRE SOIT REJOUABLE. Au point qui DÉCIDE
// elle vaut l'heure d'ouverture du billet, et n'en retire rien : à cet instant, aucune écriture
// postérieure n'existe pour ce joueur, que le verrou de ligne sérialise. Elle sert à `api/operateur.js`,
// qui doit pouvoir REJOUER le verdict tel qu'il s'est prononcé, des mois après, sans que les jambes
// écrites depuis — à commencer par celles du billet lui-même — ne viennent fausser la réponse à
// « pourquoi ce billet a-t-il été refusé ». Ce n'est pas la même requête qui fonde la propriété,
// ce sont les mêmes PARAMÈTRES : l'ancre, la borne haute et le pire cas du billet.
const EXPOSITION_FENETRE_SQL = `
    select coalesce(sum(e.montant_cents) filter (where e.compte_debit  = any($3::text[])), 0)
         - coalesce(sum(e.montant_cents) filter (where e.compte_credit = any($3::text[])), 0) as total
      from (select montant_cents, compte_debit, compte_credit,
                   ${L.REFERENCE_BILLET_SQL} as billet
              from ledger_entries
             where cree_le >= $2
               and cree_le <= $5
               and motif = any($4::text[])
               and (compte_debit = any($3::text[]) or compte_credit = any($3::text[]))
               and ${L.REFERENCE_BILLET_SQL} in (select id::text from matches where user_id = $1::bigint)) e
      join matches m on m.id::text = e.billet
     where m.user_id = $1::bigint`;

// LE FUSIBLE GLOBAL, ET IL NE FAIT AUCUNE JOINTURE. Ce n'est pas un oubli : c'est un INTERRUPTEUR,
// pas un invariant. Le rattacher à `matches` en ferait un agrégat non borné sur DEUX tables, et il
// est déjà non borné sur une. Les quatre motifs suffisent à écarter la dotation et la recharge ; ce
// qu'une jointure ajouterait — écarter une écriture dont la référence ne désigne aucune ligne — vaut
// zéro centime sur un seuil de deux millions, et se paierait à chaque rafraîchissement.
const EXPOSITION_MAISON_SQL = `
    select coalesce(sum(montant_cents) filter (where compte_debit  = any($2::text[])), 0)
         - coalesce(sum(montant_cents) filter (where compte_credit = any($2::text[])), 0) as total
      from ledger_entries
     where cree_le >= $1
       and motif = any($3::text[])
       and (compte_debit = any($2::text[]) or compte_credit = any($2::text[]))`;

// LE DÉBUT DE LA FENÊTRE GLISSANTE. Glissante, et pas une journée calendaire : une journée
// calendaire se réinitialise à une heure connue de tous, et attendre minuit deviendrait une
// stratégie. L'heure vient de l'appelant — c'est l'horloge injectée dans `createApp` — donc la
// fenêtre se fait glisser dans un test sans attendre vingt-quatre heures.
function fenetreDepuis(maintenant) {
  const t = maintenant instanceof Date ? maintenant.getTime() : Number(maintenant);
  if (!Number.isFinite(t)) throw new Error('plafond : heure illisible');
  return new Date(t - L.PLAFOND_FENETRE_H * 3600 * 1000);
}

// L'exposition d'UN joueur, dans la transaction de son billet et sous le verrou que l'appelant a
// pris. `sum()` rend un `bigint`, donc une CHAÎNE : la conversion est ici pour la même raison que
// dans `ledgerSolde`, et avec le même prix si on l'oublie — « 9 » y serait plus grand que « 10 ».
// `jusqua` est OBLIGATOIRE et jamais implicite : c'est l'ancre du chiffre. Au point qui décide elle
// vaut l'heure d'ouverture du billet, dans l'outil d'opération l'heure d'ouverture de la ligne qu'on
// relit. Une valeur par défaut « maintenant » ferait dire à l'outil un autre nombre que celui qui a
// refusé, et c'est précisément le défaut qu'elle existe pour fermer.
async function expositionJoueur(client, userId, depuis, jusqua) {
  const r = await client.query(EXPOSITION_FENETRE_SQL,
    [userId, depuis, L.COMPTES_EXPOSITION, L.MOTIFS_EXPOSITION, jusqua]);
  return Number((r.rows[0] || {}).total) || 0;
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
            // UN POINT DE REPRISE AUTOUR DE L'INSERTION, ET IL EST LA CONDITION DU RÉESSAI. Dans un
            // bloc transactionnel, une erreur avorte TOUT ce qui suit : la commande d'après sort en
            // `25P02` (« current transaction is aborted ») et jamais en `23505`. Le test de code
            // ci-dessous était donc faux au second tour, le `throw` repartait, la transaction était
            // annulée et la route rendait 500 — sans compte et sans dotation. Et ce n'était pas un
            // cas rare : Crossmint ne transporte pas de pseudo, donc TOUT nouveau compte se présente
            // avec « Player », donc tout second compte créé heurtait `name_key`. Même geste que le
            // `savepoint essai` d'`api/db-check.js` : ici on a besoin de connaître la contrainte qui
            // refuse, c'est donc un point de reprise et pas un `on conflict do nothing`.
            await client.query('savepoint pseudo');
            try {
              const ins = await client.query(
                `insert into users (auth_id, email, name, name_key) values ($1,$2,$3,$4) returning ${COLS}`,
                [authId, email, base, cle]);
              user = ins.rows[0];
              await client.query('release savepoint pseudo');
            } catch (e) {
              await client.query('rollback to savepoint pseudo');
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
        // LE PLAFOND PAR JOUEUR : LU ICI, SOUS LE VERROU, ET AVANT LA MOINDRE ÉCRITURE. C'est ce qui
        // le rend EXACT plutôt qu'approché — deux onglets du même joueur sont sérialisés par ce
        // verrou-là, et le second lit donc ce que le premier a écrit. Son agrégat est borné par les
        // billets d'un seul joueur sur vingt-quatre heures : quelques dizaines de lignes, sur un
        // index qui les porte. Le FUSIBLE GLOBAL, lui, n'est pas ici : il est lu hors de cette
        // transaction et amorti, parce qu'un agrégat non borné sur la table qui grossit le plus vite
        // du dépôt n'a rien à faire dans la section critique la plus disputée du système.
        //
        // LE PIRE CAS DU BILLET EST REÇU, JAMAIS CALCULÉ ICI. `api/ledger.js` porte deux gardes
        // textuelles — aucun `require`, aucune arithmétique de commission — donc le net maximal vient
        // de `WBCore.cashoutCents(WBCore.purseBound(mise, sièges).maxCents)`, dans `api/app.js`, et
        // il traverse en paramètre. Même discipline que `mouvementGain`, qui reçoit brut, commission
        // et net sans les recalculer.
        //
        // LA RÉALISÉE EST GARDÉE À PART, et elle remonte avec le refus. `plafondVerdict` ne rend que
        // la SOMME « réalisée clampée + ce billet-ci » : `api/app.js` ne pouvait donc pas savoir s'il
        // reste au joueur la place d'une table moins chère, et le sas lui en promettait une même
        // quand aucune des vingt ne passait. Le terme voyage plutôt que d'être redevine par une
        // soustraction chez l'appelant — un nombre reconstruit est un nombre qui diverge.
        const realiseeCents = await expositionJoueur(client, m.userId,
                                                     fenetreDepuis(m.openedAt), m.openedAt);
        const plafond = L.plafondVerdict({
          expositionRealiseeCents: realiseeCents,
          expositionBilletCents: L.expositionBilletMaxCents(m.netMaxCents, m.stakeCents),
          plafondCents: L.PLAFOND_JOUEUR_CENTS,
        });
        // Deux tours au plus : le premier peut buter sur un billet périmé, qu'on clôt ; le second
        // insère alors. Au-delà, quelqu'un d'autre écrit en même temps, et on rend la main.
        for (let tour = 0; tour < 2; tour++) {
          const ins = await client.query(
            `insert into matches
               (user_id, mode, stake_cents, seats, team_size, paid_seats, brawler, seed_public,
                seed_secret, sim_version, client_key, status, opened_at, expires_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13)
             on conflict do nothing
             returning ${MATCH_COLS}`,
            [m.userId, m.mode, m.stakeCents, m.seats, m.teamSize, m.paidSeats, m.brawler,
             m.seedPublic, m.seedSecret, m.simVersion, m.clientKey, m.openedAt, m.expiresAt]);
          if (ins.rows[0]) {
            // LE VERDICT NE S'APPLIQUE QU'À L'OUVERTURE D'UN BILLET NEUF, ET C'EST DÉLIBÉRÉ. Le
            // chemin `repris` — rejeu de la clé du client, ou billet déjà ouvert qu'on rend tel quel
            // — ne passe jamais par ici : refuser un billet que le joueur DÉTIENT déjà, mise
            // débitée, l'enfermerait dedans jusqu'à l'expiration, puisqu'il n'en a qu'un à la fois.
            // C'est la leçon du `22003`, et c'est aussi la règle écrite de la phase : un billet déjà
            // ouvert n'est jamais cassé rétroactivement.
            //
            // L'annulation rend la ligne qu'on vient d'insérer à l'inexistence, exactement comme sur
            // le refus `fonds` : ni billet, ni écriture, ni séquestre, ni clôture du billet périmé
            // que le tour précédent avait entamée.
            if (plafond.franchi) {
              await client.query('rollback');
              return { match: null, refus: 'plafond', portee: 'joueur',
                       expositionCents: plafond.expositionCents,
                       expositionRealiseeCents: realiseeCents,
                       plafondCents: plafond.plafondCents };
            }
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

    // LE FUSIBLE GLOBAL, ET IL OUVRE SA PROPRE CONNEXION. C'est la moitié importante : il est lu
    // HORS de la transaction du billet, donc il ne rallonge pas la section critique que le verrou de
    // ligne tient. Le dépôt a déjà payé ce genre de chose une fois — `GET /api/me` retenait un client
    // du bassin assez longtemps pour mettre en file le renoncement d'un AUTRE joueur au-delà de sa
    // fenêtre de dix secondes.
    //
    // Il a le droit d'être EN RETARD, et c'est `api/app.js` qui borne ce retard à
    // `FUSIBLE_RAFRAICHI_S`. Être exact au billet près sur un interrupteur de deux millions de
    // centimes ne veut rien dire ; payer un agrégat non borné à chaque ouverture pour l'obtenir est
    // la mauvaise moitié du marché.
    async expositionMaison({ depuis }) {
      const client = await pool.connect();
      try {
        const r = await client.query(EXPOSITION_MAISON_SQL,
          [depuis, L.COMPTES_EXPOSITION, L.MOTIFS_EXPOSITION]);
        return Number((r.rows[0] || {}).total) || 0;
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

    // LE VEILLEUR, ET IL ÉCRIT DE L'ARGENT DEPUIS LA PHASE 03. Ce commentaire disait jusqu'ici
    // « il n'écrit AUCUN montant — il ne fait que fermer une porte », et c'était vrai tant qu'aucun
    // séquestre n'existait. Ce n'est plus vrai, et le revirement est écrit plutôt que laissé à se
    // découvrir six mois plus tard : à l'expiration d'un billet, LE SÉQUESTRE DOIT ÊTRE VIDÉ vers
    // `maison:contrepartie`, sans quoi l'invariant « aucun séquestre ne reste habité » est faux et
    // de l'argent dort dans un compte que plus rien ne solde.
    //
    // PASSÉ LA FENÊTRE DE RENONCEMENT, RIEN NE REND LA MISE. Le veilleur clôt SANS remboursement :
    // c'est très exactement le vol que la phase ferme — jouer, perdre, n'envoyer ni trace ni
    // résultat, laisser expirer et se faire rembourser. Le seul chemin qui rende une mise est
    // `renounceMatch`, et il est borné par l'horloge du SERVEUR.
    //
    // UNE BOUCLE DE TRANSACTIONS BORNÉES, UNE PAR BILLET, et plus un `update` de 500 lignes. Un
    // mouvement du grand livre ne se pose pas en masse, et un échec sur une ligne — un doublon, un
    // découvert — ne doit pas annuler les autres : chaque billet a sa transaction, et celui qui
    // échoue est NOMMÉ dans `echecs` au lieu d'emporter le balayage avec lui.
    //
    // La clause ne clôt que ce que personne n'a terminé : `status = 'open'` et l'expiration.
    // L'heure lui est passée, elle n'est pas lue ici — c'est ce qui permet de le tester sans
    // attendre.
    async expireMatches({ avant, max = 500 }) {
      // Les candidats sont lus hors transaction, et c'est sans conséquence : chaque clôture
      // revérifie `status = 'open'` sous son propre verrou. Un billet réglé entre la lecture et la
      // clôture est simplement sauté.
      const lecture = await pool.connect();
      let ids;
      try {
        const r = await lecture.query(
          `select id from matches
             where status = 'open' and expires_at <= $1
             order by expires_at limit $2`, [avant, max]);
        ids = r.rows.map(l => l.id);
      } finally {
        lecture.release();
      }

      let closes = 0;
      const echecs = [];
      for (const id of ids) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          // LE VERROU, sur la seule ligne qui existe par partie : c'est le séquestre de CELLE-CI
          // qu'on s'apprête à débiter.
          await client.query('select id from matches where id = $1 for update', [id]);
          const maj = await client.query(
            `update matches set status = 'expired'
               where id = $1 and status = 'open' and expires_at <= $2
             returning ${MATCH_COLS}`, [id, avant]);
          if (!maj.rows[0]) { await client.query('rollback'); continue; }
          // Le séquestre part chez la maison, dans la MÊME transaction que la clôture. Un billet
          // sans écriture de mise — une ligne de la phase 02a — n'en a pas, et rien n'est écrit.
          await reglerSequestre(client, maj.rows[0]);
          await client.query('commit');
          closes++;
        } catch (e) {
          await client.query('rollback').catch(() => {});
          // ON N'AVALE QUE CE QUE LE GRAND LIVRE A LE DROIT DE REFUSER — un doublon, un découvert —
          // et rien d'autre. C'est la règle de tous les autres appelants de l'écrivain dans ce
          // fichier, et elle vaut ici plus qu'ailleurs : un `catch` qui ramasse tout ferait d'une
          // base injoignable ou d'une faute de programmation un balayage qui rend paisiblement
          // « zéro clôture », que personne ne regarde et que `main.js` ne journaliserait même pas.
          // Une panne silencieuse sur le chemin de l'argent est précisément ce que ce dossier
          // refuse. Le billet en échec est NOMMÉ, et le tour suivant le reprendra ; sa ligne n'est
          // pas close et son séquestre n'a pas bougé, ce qui est le seul état acceptable.
          if (!refusDuLivre(e)) throw e;
          echecs.push({ id: String(id), code: e.code });
        } finally {
          client.release();
        }
      }
      return { closes, echecs };
    },

    // LA RENONCIATION, ET LE SEUL CHEMIN DU DÉPÔT QUI RENDE UNE MISE. La fenêtre est arbitrée par
    // `app.js`, qui appelle `WBCore.renonciationOuverte` avec l'horloge du serveur : rien ici ne
    // recalcule une borne. Ce que cette méthode garantit, c'est que la clôture du billet et le
    // remboursement sont UNE SEULE transaction — un billet renoncé sans son remboursement serait
    // une mise perdue sans recours, et un remboursement sans clôture serait un billet gratuit.
    //
    // LE MONTANT RENDU EST CE QUE LE SÉQUESTRE PORTE, pas `stake_cents`. Même raisonnement que
    // `reglerSequestre` : le mouvement est ainsi garanti de le vider jusqu'au dernier centime, et
    // confronter les deux nombres est le travail de `ledgerReconcile`. Un séquestre vide veut dire
    // que le livre n'a jamais engagé cette partie — une ligne de la phase 02a — et on n'écrit alors
    // rien du tout : la frontière avec la 02a se constate ici comme ailleurs.
    async renounceMatch({ matchId, userId, at }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select id from matches where id = $1 for update', [matchId]);
        const maj = await client.query(
          `update matches set status = 'renounced', settled_at = $3
             where id = $1 and user_id = $2 and status = 'open' and net_cents is null
           returning ${MATCH_COLS}`, [matchId, userId, at]);
        if (!maj.rows[0]) {
          // Rien à clore : le billet n'existe pas, n'est pas le sien, ou il est déjà clos. On relit
          // pour que la route puisse nommer le refus au lieu de rendre un 500.
          const deja = await client.query(
            `select ${MATCH_COLS} from matches where id = $1 and user_id = $2`, [matchId, userId]);
          await client.query('commit');
          return { match: null, deja: ligneMatch(deja.rows[0]) || null };
        }
        // UN COMPTE SE NOMME AVEC L'ID DE LA LIGNE, JAMAIS AVEC LE PARAMÈTRE D'URL. Postgres
        // compare deux `bigint`, donc `/api/match/007/renounce` retrouve bien la ligne 7 ; mais
        // « 007 » n'est pas un identifiant du grand livre, et `compteEnjeu` le refuse à juste titre
        // — un identifiant de ligne est un entier positif sans zéro de tête. Nommer le séquestre
        // avec le paramètre faisait donc LEVER `identifiant()` sur la seule route qui rende une
        // mise, et le refus sortait en 500, ce que le chemin de l'argent s'interdit. La ligne
        // relue est la seule source d'identifiant, exactement comme dans `reglerSequestre`.
        const ligne = maj.rows[0];
        const engage = await ledgerSolde(client, L.compteEnjeu(ligne.id));
        if (engage > 0) {
          try {
            await ledgerWrite(client, L.mouvementRemboursement({
              userId: ligne.user_id, matchId: ligne.id, miseCents: engage }));
          } catch (e) {
            if (!refusDuLivre(e)) throw e;
            // Tout est annulé, y compris la clôture : le billet repart `open`, le joueur peut
            // réessayer tant que la fenêtre dure, et rien ne sort en 500.
            await client.query('rollback');
            return { match: null, refus: 'livre', detail: e.code };
          }
        }
        const balanceCents = await ledgerSolde(client, L.compteJoueur(ligne.user_id));
        const quarantineCents = await ledgerSolde(client, L.compteQuarantaine(ligne.user_id));
        await client.query('commit');
        return { match: ligneMatch(ligne), rembourseCents: engage > 0 ? engage : 0,
                 balanceCents, quarantineCents };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    // LE DERNIER BILLET RENONCÉ D'UN JOUEUR, et à quoi il sert. Renoncer à la première seconde clôt
    // le billet, libère l'index partiel, et `createMatch` en délivrerait un neuf IMMÉDIATEMENT, avec
    // une graine neuve : la carte étant une fonction pure de `seed_public`, que le client reçoit
    // AVEC le billet, le coût d'un nouveau tirage serait un aller-retour HTTP. C'est `app.js` qui
    // ferme cela, en interrogeant `WBCore.renonciationOuverte` sur CETTE ligne-ci : tant que sa
    // fenêtre n'est pas passée, aucun billet neuf. Un tirage coûte alors la fenêtre entière.
    //
    // Le coût de cette lecture est une requête indexée de plus sur chaque ouverture de billet
    // (`matches_user_status_idx` porte `(user_id, status)`). C'est écrit plutôt que découvert.
    async lastRenounced({ userId }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `select ${MATCH_COLS} from matches
             where user_id = $1 and status = 'renounced'
             order by opened_at desc limit 1`, [userId]);
        return ligneMatch(r.rows[0]) || null;
      } finally {
        client.release();
      }
    },

    // LA PURGE DES TRACES, ET C'EST LE PREMIER `delete` DU DÉPÔT SUR LA PIÈCE QUI PROUVE UN
    // PAIEMENT. Elle n'efface une trace que si LES QUATRE CONDITIONS sont réunies, et les quatre
    // sont dans la clause du `delete` lui-même — pas dans le code qui la choisit. Une condition
    // vérifiée avant l'instruction laisse une fenêtre ; ici il n'y en a pas, et un test relit le
    // texte de cette clause.
    //
    //   (a) la ligne `matches` est réglée DÉFINITIVEMENT — `status in ('settled', 'rejected')` ;
    //   (b) le grand livre a POSÉ SON ÉCRITURE — un mouvement `gain` ou `remboursement` porte ce
    //       `match_id`. La liste est écrite en clair dans la clause pour qu'une garde puisse la
    //       LIRE, et un test la confronte à `L.MOTIFS_REGLEMENT` : c'est le patron déjà employé
    //       pour l'expression des comptes de `schema.sql`, deux écritures qui se confrontent plutôt
    //       que de se faire confiance. Et LE MOTIF COMPTE AUTANT QUE LA RÉFÉRENCE : une dotation
    //       porte `<user_id>` là où un gain porte `<match_id>`, les deux vivent dans le même espace
    //       de noms, et sans ce filtre la dotation du joueur 1 ferait purger la partie 1 ;
    //   (c) RIEN N'EST EN ATTENTE — le séquestre de cette partie est à zéro ;
    //   (d) LE DÉLAI EST ÉCOULÉ — `settled_at` est plus vieux que `TRACE_RETENTION_JOURS`.
    //
    // ELLE NE TOUCHE JAMAIS UNE LIGNE `matches`, JAMAIS UNE ÉCRITURE DU GRAND LIVRE : elle les LIT.
    // `ledger_entries` reste en insertion seule, sans exception.
    //
    // Conséquence directe et voulue : la trace d'un billet dont le résultat n'est JAMAIS arrivé
    // n'est jamais effacée, puisque sa ligne n'est ni `settled` ni `rejected`. C'est exactement la
    // pièce qu'on voudra relire, et la table ne descend donc pas à zéro.
    //
    // L'heure vient de l'appelant, comme partout ailleurs : c'est l'horloge injectée dans
    // `createApp`, et c'est ce qui permet de faire vieillir une trace sans attendre quatre cents
    // jours.
    async purgeTraces({ maintenant, max = 500 }) {
      const t = maintenant instanceof Date ? maintenant.getTime() : Number(maintenant);
      if (!Number.isFinite(t)) throw new Error('purge des traces : heure illisible');
      const avant = new Date(t - L.TRACE_RETENTION_JOURS * 24 * 3600 * 1000);
      // Le compte du séquestre de la partie, en SQL. Il est nommé ici plutôt qu'écrit deux fois dans
      // la clause, et `soldeExpr` en tire la somme — la même que celle de `ledgerSolde`.
      const enjeu = "'enjeu:' || matches.id";
      const client = await pool.connect();
      try {
        const r = await client.query(
          `delete from match_traces
            where match_id in (
              select id from matches
               where status in ('settled', 'rejected')
                 and settled_at is not null
                 and settled_at < $1
                 and exists (select 1 from ledger_entries
                              where ledger_entries.reference = matches.id::text
                                and ledger_entries.motif in ('gain', 'remboursement'))
                 and (select ${soldeExpr(enjeu)}
                        from ledger_entries
                       where compte_debit = ${enjeu} or compte_credit = ${enjeu}) = 0
               order by settled_at limit $2)
          returning match_id`,
          [avant, max]);
        // Le nombre de LIGNES effacées, et le nombre de PARTIES : une partie a un à trois segments,
        // et c'est la seconde qui dit ce que la purge a réellement soldé.
        return { effacees: r.rows.length,
                 parties: new Set(r.rows.map(l => String(l.match_id))).size,
                 avant };
      } finally {
        client.release();
      }
    },

    // ---------------------------------------------------------------------------------------
    // CE QUI SUIT N'EXISTE QUE POUR `api/operateur.js`, L'OUTIL EN LIGNE DE COMMANDE.
    //
    // Aucune route ne les appelle, `api/app.js` ne les connaît pas, et une garde textuelle vérifie
    // qu'il ne charge jamais l'outil. Une route d'administration serait une surface d'attaque
    // permanente pour un geste qui arrive deux fois par an, et elle demanderait une authentification
    // de second ordre que rien d'autre du dossier ne justifie. L'opérateur, lui, détient déjà les
    // identifiants de la base : c'est le même patron que « il n'existe aucune route
    // `POST /api/credits` », et la même garde.
    //
    // TROIS LECTURES AVANT UNE ÉCRITURE, ET C'EST L'ORDRE QUI COMPTE. Le premier geste d'un incident
    // réel n'est pas de corriger, c'est de regarder ; un outil qui n'aurait que des verbes
    // d'écriture renverrait l'opérateur dans `psql` un dimanche soir, c'est-à-dire très exactement le
    // geste et le jour que ce module existe pour empêcher.

    // Les jambes d'UN mouvement, c'est-à-dire d'un couple `(motif, reference)`. `ledgerDe` relit par
    // la seule référence, ce qui ramène la mise ET le gain d'un même billet : ici on veut le
    // mouvement, parce que c'est lui qu'on contre-passe.
    async lireMouvement({ motif, reference }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `select ${LEDGER_COLS} from ledger_entries
            where motif = $1 and reference = $2 order by id`, [motif, reference]);
        return r.rows.map(l => ({ ...l, id: String(l.id), montant_cents: Number(l.montant_cents) }));
      } finally {
        client.release();
      }
    },

    // Les écritures qui portent une référence, et le solde d'un compte. Ce sont les deux lectures
    // que `ledgerDe` et `ledgerSolde` savent déjà faire ; elles prennent un client EN TRANSACTION
    // parce que leurs appelants en ont un, et l'outil n'en a pas. On leur ouvre donc une connexion,
    // et rien de plus : aucune règle n'est réécrite ici. La doublure d'`api/test.js` porte les deux
    // mêmes noms depuis la phase 03, ce qui permet à l'outil de tourner contre elle.
    async ledgerDe({ reference }) {
      const client = await pool.connect();
      try {
        return await ledgerDe(client, { reference });
      } finally {
        client.release();
      }
    },
    async ledgerSolde(compte) {
      const client = await pool.connect();
      try {
        return await ledgerSolde(client, compte);
      } finally {
        client.release();
      }
    },

    // Les gestes d'opération déjà consignés sur ce mouvement. Un journal qu'on ne peut relire qu'en
    // ouvrant `psql` est une invitation à ouvrir `psql`.
    async lireAudit({ motif, reference }) {
      const client = await pool.connect();
      try {
        return await ledgerAuditDe(client, { motif, reference });
      } finally {
        client.release();
      }
    },

    // Les gestes consignés sur un COMPTE, et pas sur un mouvement. L'anonymisation ne porte sur
    // aucune écriture du livre : sans cette seconde lecture, sa trace n'aurait aucun chemin de
    // relecture par l'outil, donc un seul chemin — `psql`.
    async lireAuditJoueur({ userId }) {
      const client = await pool.connect();
      try {
        return await ledgerAuditDeJoueur(client, { userId });
      } finally {
        client.release();
      }
    },

    // Le compte lui-même, tel qu'il est. C'est la lecture dont `anonymiser` part : le plan a besoin
    // de l'`auth_id` pour savoir si le geste a déjà été fait, et l'outil MONTRE ce qui va disparaître
    // avant de le faire disparaître.
    async lireUtilisateur({ userId }) {
      const client = await pool.connect();
      try {
        const r = await client.query(`select ${COLS} from users where id = $1`, [userId]);
        return r.rows[0] || null;
      } finally {
        client.release();
      }
    },

    // Le billet, SANS `user_id` dans la clause — et c'est la seule lecture du dépôt qui se le
    // permette. `findMatch` met le joueur dans la recherche parce qu'un identifiant deviné ne doit
    // rien apprendre sur la partie de quelqu'un d'autre ; ici il n'y a personne à protéger de
    // l'opérateur, qui lit déjà la base entière, et il ne CONNAÎT pas le joueur : il part d'une
    // écriture du livre, dont la référence ne porte que le billet.
    async lireBillet({ matchId }) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `select ${MATCH_COLS} from matches where id = $1`, [matchId]);
        return ligneMatch(r.rows[0]) || null;
      } finally {
        client.release();
      }
    },

    // L'exposition d'un joueur sur la fenêtre, hors de toute transaction : c'est une LECTURE, elle
    // ne décide de rien. La requête est celle de `createMatch`, et pas une requête réécrite pour
    // l'occasion — si l'outil montrait un autre chiffre que celui qui refuse, il ne servirait à rien.
    //
    // MAIS LA MÊME REQUÊTE NE SUFFIT PAS : ce sont les mêmes PARAMÈTRES qui font le chiffre. `jusqua`
    // est la borne haute, donc l'ancre ; l'appelant la pose sur `opened_at` quand il rejoue le
    // verdict d'un billet, et elle retombe sur `maintenant` quand il demande simplement où en est un
    // joueur aujourd'hui.
    async expositionJoueurCents({ userId, maintenant, jusqua }) {
      const client = await pool.connect();
      try {
        return await expositionJoueur(client, userId, fenetreDepuis(maintenant),
                                      jusqua === undefined ? maintenant : jusqua);
      } finally {
        client.release();
      }
    },

    // LA CONTRE-PASSATION ET SA RAISON, DANS LA MÊME TRANSACTION. C'est la propriété entière du
    // module, et c'est aussi celle qu'une doublure mono-fil flatte : seul `api/db-check.js`, contre
    // une vraie base, peut la faire arbitrer par Postgres plutôt que par l'ordre des `await`.
    //
    // REJOUER L'OUTIL NE POSE RIEN, ET IL LE DIT. La clé `(motif, reference, compte_debit,
    // compte_credit)` refuse la seconde pose ; on traduit ce refus-là en réponse, pas en panne. Un
    // opérateur qui relance sa commande parce que sa connexion a lâché doit lire « c'était déjà
    // fait » et non une pile d'appels — c'est exactement ce genre de nuit qui fait ouvrir `psql`.
    async contrepasser(plan) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await ledgerWrite(client, plan.contrepassation);
        await ledgerAuditWrite(client, plan);
        await client.query('commit');
        return { pose: true, jambes: plan.jambes, montantCents: plan.montantCents };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e && e.code === '23505') return { pose: false, deja: true };
        // LE DÉCOUVERT EST UN REFUS, PAS UNE PANNE, ET IL ARRIVE VRAIMENT ICI : contre-passer une
        // dotation que le joueur a déjà dépensée, ou un gain qu'il a rejoué, demande à son compte
        // plus qu'il ne porte. La règle uniforme du découvert l'arrête — c'est ce qu'on veut — et
        // l'opérateur doit lire une phrase, pas une pile d'appels.
        if (e && e.code === 'decouvert') {
          return { pose: false, refus: 'decouvert', message: e.message,
                   compte: e.compte, solde: e.solde, requis: e.requis };
        }
        throw e;
      } finally {
        client.release();
      }
    },

    // L'ANONYMISATION ET SA RAISON, DANS LA MÊME TRANSACTION, pour la même raison que la
    // contre-passation : un compte réécrit sans qu'on sache pourquoi est indistinguable d'une erreur
    // de manipulation, et ce geste-là ne se défait pas — l'`auth_id` d'origine n'est écrit nulle
    // part ailleurs.
    //
    // `users.id` N'EST PAS DANS LE `set`, ET C'EST TOUT LE MODULE. Le grand livre nomme ses comptes
    // avec lui — `joueur:<id>:disponible`, `enjeu:<match_id>` — et il est en insertion seule :
    // déplacer l'identifiant ferait pointer des écritures immortelles sur une ligne qui n'existe
    // plus. C'est aussi pourquoi les deux cascades du schéma sont devenues `restrict`.
    //
    // UNE COLLISION SUR `name_key` SORT EN `23505`, ET ON LA REND PLUTÔT QUE DE LA DEVINER. Le nom
    // anonyme est `x<id en base 36>` : quelqu'un peut parfaitement porter ce pseudo-là. Réessayer
    // avec un suffixe — ce que fait `findOrCreate` à l'inscription — serait le mauvais geste ici :
    // à l'inscription on arrange un joueur qui ne remarquera rien, ici on prendrait une décision à
    // la place d'un opérateur, sur un geste rare et manuel qui ne se défait pas.
    async anonymiser(plan) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const r = await client.query(
          `update users set auth_id = $2, email = $3, name = $4, name_key = $5,
                            avatar = '', country = null, updated_at = now()
            where id = $1 returning id`,
          [plan.userId, plan.apres.authId, plan.apres.email, plan.apres.name, plan.apres.nameKey]);
        if (r.rowCount === 0) {
          await client.query('rollback');
          return { pose: false, absent: true };
        }
        await ledgerAuditWrite(client, plan);
        await client.query('commit');
        return { pose: true };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e && e.code === '23505') {
          return { pose: false, collision: true, contrainte: e.constraint || '', message: e.message };
        }
        throw e;
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
// `EXPOSITION_FENETRE_SQL` et `fenetreDepuis` sortent d'ici pour une seule raison : `api/db-check.js`
// pose un `explain (format json)` sur LA REQUÊTE RÉELLE, et pas sur une requête réécrite pour
// l'occasion. Un harnais qui recopie ce qu'il vérifie ne vérifie rien — le dossier l'a déjà payé une
// fois — et c'est le seul contrôle qui puisse dire qu'un index SERT.
module.exports = { pgDb, ledgerWrite, ledgerSolde, ledgerDe, ledgerAuditWrite, ledgerAuditDe,
                   ledgerAuditDeJoueur,
                   reglerSequestre, jourDe, EXPOSITION_FENETRE_SQL, fenetreDepuis, AUDIT_COLS };
