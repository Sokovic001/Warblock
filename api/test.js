// Lancer : node api/test.js — aucune dépendance, aucune base, aucun compte.
// La base et la vérification du jeton sont remplacées par des doublures, ce qui laisse le routeur
// entièrement couvert : authentification, validation, unicité du pseudo, limitation de débit, CORS.
'use strict';
const assert = require('assert');
const crypto = require('node:crypto');
const { createApp, checkProfile, checkMatch, makeLimiter, MATCH_MARGE_S } = require('./app');
const { parseApiKey, base58Encode, base58Decode, jwksUri } = require('./crossmint-key');
const { identityFromClaims } = require('./auth-crossmint');
const C = require('./core');
// Le grand livre. Il est requis ICI, en tête, parce que la DOUBLURE de base s'en sert : elle imite
// les contraintes de `ledger_entries`, et la grammaire des comptes comme la liste des motifs n'ont
// qu'une source. Une doublure qui recopierait ces deux listes serait le patron du `respawn()` défini
// deux fois, et elle mentirait dans le mauvais sens — en acceptant ce que la base refuse.
const L = require('./ledger');
// L'OUTIL D'OPÉRATION. Il est requis ICI, en tête, et cela n'exige RIEN : il ne charge `./db-pg` —
// donc `pg` — qu'à l'intérieur de son pilote, après avoir constaté `DATABASE_URL`. L'intégration
// continue lance ce fichier AVANT `npm install` ; un `require('./db-pg')` en tête de `operateur.js`
// ferait échouer tout `node api/test.js` par « module introuvable ». Un test le lance pour de bon.
const OP = require('./operateur');
// Le bloc de simulation du jeu, chargé par le serveur depuis index.html. Il est requis ICI, en tête
// de fichier, parce que depuis le module 7 les tests de la route de résultat doivent JOUER de
// vraies parties : le serveur ne croit plus aucun fait déclaré, donc un rapport écrit à la main ne
// prouve plus rien de ce qu'il prétendait prouver.
const SIM = require('./sim');

let passed = 0;
function test(nom, fn) {
  const fini = () => { passed++; console.log('  ✓', nom); };
  const rate = e => { console.log('  ✗', nom, '\n    ', e && e.message || e); process.exitCode = 1; };
  // L'appel est dans le try : un test synchrone qui échoue doit être signalé comme les autres, pas
  // faire tomber tout le harnais avant d'avoir lancé les suivants.
  let r;
  try { r = fn(); } catch (e) { rate(e); return; }
  return (r && typeof r.then === 'function') ? r.then(fini, rate) : fini();
}

// ---------- doublures ----------
// Les colonnes `integer` de `matches`, et la largeur qu'elles ont vraiment. La doublure était un
// tableau JS sans types : elle avalait n'importe quelle magnitude, si bien qu'aucun test ne pouvait
// voir un rapport qui fait déborder Postgres — lequel lève `22003`, rend un 500 et laisse la ligne
// `open`, enfermant le joueur dans un billet mort. Elle refuse maintenant ce que la base refuserait.
const PG_INT4_MAX = 2147483647, PG_INT4_MIN = -2147483648;
const COLONNES_INT4 = ['stake_cents', 'seats', 'team_size', 'paid_seats',
                       'gross_cents', 'fee_cents', 'net_cents',
                       'purse_cents', 'declared_net_cents', 'ecart_cents',
                       'seconds', 'kills', 'deaths', 'rank', 'cubes', 'damage',
                       'sim_version', 'seq', 'steps',
                       // Phase 03 : le montant d'une écriture du grand livre est un `integer`
                       // comme tous les autres montants, et il porte la même leçon — un entier
                       // « valide » à 3 000 000 000 lève `22003`.
                       'montant_cents',
                       // Phase 02b. `replay_digest` n'est PAS ici : c'est un `bigint`, comme la
                       // graine publique et pour la même raison — un entier 32 bits non signé ne
                       // tient pas dans l'`integer` signé de Postgres.
                       'trace_steps', 'divergence_step', 'replay_ms'];
// Les colonnes de TEXTE et la largeur que le schéma leur donne. Une colonne `text` sans contrainte
// avale n'importe quoi, mais celles-ci en portent une — `seed_secret` doit être 128 bits en
// hexadécimal, `data` tient sous la borne du corps — et la doublure doit refuser ce que la base
// refuserait, sinon aucun test ne peut voir la panne.
const COLONNES_TEXTE = {
  seed_secret: v => /^[0-9a-f]{32}$/.test(v),
  data: v => typeof v === 'string' && v.length >= 1 && v.length <= 65536,
};
// `paid_seats` porte une contrainte qui regarde UNE AUTRE COLONNE — `between 1 and seats` — donc
// elle ne se vérifie qu'en voyant les deux ensemble, et pas colonne par colonne comme les largeurs.
// La doublure l'IMITE, comme elle imite le reste ; ce qu'elle ne peut pas faire, c'est la SUBIR, et
// c'est `api/db-check.js` qui s'en charge contre une vraie base. Elle est ici pour qu'un module
// futur qui écrirait zéro siège payé le voie tomber sur la machine de travail, et pas seulement en
// intégration continue.
function verifierPaidSeats(v) {
  if (v.paid_seats === undefined || v.paid_seats === null) return;
  if (!Number.isInteger(v.paid_seats) || v.paid_seats < 1 || v.paid_seats > v.seats) {
    const e = new Error('new row for relation "matches" violates check constraint "matches_paid_seats_borne"');
    e.code = '23514'; e.constraint = 'matches_paid_seats_borne';
    throw e;
  }
}
function verifierColonnes(valeurs) {
  verifierPaidSeats(valeurs);
  for (const c of COLONNES_INT4) {
    const v = valeurs[c];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v > PG_INT4_MAX || v < PG_INT4_MIN) {
      const e = new Error(`value "${v}" is out of range for type integer`);
      e.code = '22003';
      throw e;
    }
  }
  for (const [c, ok] of Object.entries(COLONNES_TEXTE)) {
    const v = valeurs[c];
    if (v === undefined || v === null) continue;
    if (!ok(v)) {
      const e = new Error(`new row for relation violates check constraint on ${c}`);
      e.code = '23514';
      throw e;
    }
  }
}
// L'HORLOGE DE LA DOUBLURE, ET POURQUOI ELLE ARRIVE MAINTENANT. `cree_le` était une date fixe, ce
// qui suffisait tant que personne ne lisait le livre par tranche de temps. Le plafond, lui, se
// décide sur une FENÊTRE GLISSANTE : une doublure qui date toutes ses écritures du même instant ne
// peut pas montrer une écriture qui SORT de la fenêtre, donc elle ne pourrait pas faire tomber un
// plafond qui aurait oublié le `cree_le >= $2` de sa clause. L'horloge est celle qu'on injecte déjà
// dans `createApp`, donc la fenêtre se fait glisser sans attendre vingt-quatre heures.
function fakeDb(seed = [], horloge = null) {
  const users = seed.map(u => ({ ...u }));
  const matches = [];
  // `match_traces`, EN INSERTION SEULE : la doublure n'expose aucun moyen de modifier ni de
  // supprimer une ligne, exactement comme db-pg.js n'écrit aucun `update` ni `delete` sur elle.
  const traces = [];
  // `ledger_entries`, EN INSERTION SEULE ELLE AUSSI, et plus strictement encore : aucune méthode de
  // cette doublure ne modifie ni ne supprime une écriture, et les lignes posées sont GELÉES — la
  // règle « aucun `update`, aucun `delete` » commence par l'objet en mémoire. Le seul chemin de
  // correction est une contre-passation, c'est-à-dire une insertion de plus.
  const ledger = [];
  // `ledger_audit`, EN INSERTION SEULE ELLE AUSSI, et pour une raison de plus : une trace qu'on peut
  // réécrire ne trace rien. Elle PARTAGE LA TRANSACTION de l'écriture d'argent — c'est toute sa
  // raison d'être, et c'est la propriété que `contrepasser` ci-dessous imite ligne à ligne.
  const audit = [];
  let next = users.length + 1, nextMatch = 1, nextEcriture = 1, nextAudit = 1;
  // Les contraintes de `ledger_entries`, imitées une par une pour que la doublure MENTE COMME LE
  // VRAI PILOTE. Sans elles un test verrait passer ce que Postgres refuse, et la classe de panne la
  // plus coûteuse du dossier — une écriture d'argent qui échoue en plein milieu — resterait
  // invisible. La grammaire et la liste des motifs ne sont pas recopiées ici : elles viennent de
  // `api/ledger.js`, qui est aussi ce que `schema.sql` recopie.
  // La clé d'idempotence, telle que l'index unique la définit : quatre colonnes, dans cet ordre.
  const cleLedger = l => [l.motif, l.reference, l.compte_debit, l.compte_credit].join(' | ');
  const refuseLedger = (code, contrainte) => {
    const e = new Error(`new row for relation "ledger_entries" violates constraint "${contrainte}"`);
    e.code = code; e.constraint = contrainte;
    return e;
  };
  // Le solde d'un compte : la somme de ses crédits moins celle de ses débits, comme l'agrégat SQL
  // de db-pg.js. Il n'y a nulle part de case à lire, ici pas plus qu'en base.
  // `audit` rejoint `ledger` dans les pannes provoquées, et c'est ce crochet-là qui rend testable la
  // seule propriété du module : l'écriture d'argent et sa justification vivent ou meurent ensemble.
  const panne = { ledger: null, audit: null };
  // Les deux seuls échecs du livre que l'appelant traduit en refus nommé, jamais en 500 : le miroir
  // de `refusDuLivre` de db-pg.js.
  const refusDuLivre = e => !!e && (e.code === '23505' || e.code === 'decouvert');
  // COMPARER LES IDENTIFIANTS COMME LA BASE LES COMPARE, c'est-à-dire en `bigint` et pas en texte.
  // `String(x.id) === String(matchId)` rendait `'007' !== '7'`, donc la doublure répondait 404 là où
  // Postgres retrouve la ligne 7 — et elle masquait ainsi le seul défaut que ce chemin portait : le
  // paramètre brut servait à nommer un compte du grand livre, qui le refuse, et la route de
  // renoncement sortait en 500. Une doublure qui ne subit pas ce que la base fait prouve la
  // doublure. Un identifiant illisible n'apparie rien, comme un `where id = $1` illisible.
  const memeId = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
  const soldeDe = compte => ledger.reduce(
    (s, l) => s + (l.compte_credit === compte ? l.montant_cents : 0)
                - (l.compte_debit === compte ? l.montant_cents : 0), 0);
  // L'ÉCRIVAIN, imité jusqu'à ses refus. Tout est validé AVANT que la première ligne ne soit posée :
  // la vraie écriture est dans une transaction, donc un mouvement s'écrit en entier ou pas du tout.
  // Une doublure qui laisserait deux jambes sur trois raconterait une histoire que la base ne peut
  // pas produire, et le test d'atomicité passerait sur une doublure complaisante.
  function ecrireLedger(transferts) {
    if (!Array.isArray(transferts) || transferts.length === 0) {
      throw new Error('grand livre : rien à écrire — un mouvement porte au moins un transfert');
    }
    // LA PANNE PROVOQUÉE. Une écriture d'argent qui échoue EN PLEIN MILIEU est la classe de panne la
    // plus coûteuse du dossier, et aucun test ne peut la voir si la doublure réussit toujours. Ce
    // crochet la produit à la demande, sur le mouvement que le test désigne, avec le code que la
    // base lèverait. Il n'existe que dans la doublure, et rien du serveur ne le connaît.
    if (panne.ledger && panne.ledger(transferts)) {
      throw refuseLedger('23505', 'ledger_entries_mouvement_uniq');
    }
    const nouvelles = [];
    for (const t of transferts) {
      if (!L.compteValide(t.compteDebit)) throw refuseLedger('23514', 'ledger_compte_debit_grammaire');
      if (!L.compteValide(t.compteCredit)) throw refuseLedger('23514', 'ledger_compte_credit_grammaire');
      if (t.compteDebit === t.compteCredit) throw refuseLedger('23514', 'ledger_comptes_distincts');
      if (!L.MOTIFS.includes(t.motif)) throw refuseLedger('23514', 'ledger_entries_motif_check');
      if (typeof t.reference !== 'string' || t.reference.length < 1 || t.reference.length > 128) {
        throw refuseLedger('23514', 'ledger_entries_reference_check');
      }
      if (!Number.isInteger(t.montantCents) || t.montantCents <= 0) {
        throw refuseLedger('23514', 'ledger_entries_montant_cents_check');
      }
      // La largeur de la colonne, la même que partout ailleurs : `22003` et pas un arrondi.
      verifierColonnes({ montant_cents: t.montantCents });
      const cle = cleLedger({ motif: t.motif, reference: t.reference,
                              compte_debit: t.compteDebit, compte_credit: t.compteCredit });
      // LA CLÉ D'IDEMPOTENCE, ET ELLE REFUSE — elle n'avale pas. Sur `match_traces`, `on conflict
      // do nothing` est le bon comportement ; ici, un doublon veut dire qu'on paie deux fois, et
      // l'appelant doit l'apprendre.
      if (ledger.some(l => cleLedger(l) === cle) || nouvelles.some(l => cleLedger(l) === cle)) {
        throw refuseLedger('23505', 'ledger_entries_mouvement_uniq');
      }
      // La ligne posée est GELÉE : la règle « aucun `update`, aucun `delete` » commence par
      // l'objet en mémoire, et `db.ledger` est exposé aux tests pour être observé, pas retouché.
      nouvelles.push(Object.freeze({
        id: String(nextEcriture++), motif: t.motif, reference: t.reference,
        compte_debit: t.compteDebit, compte_credit: t.compteCredit,
        montant_cents: t.montantCents,
        cree_le: horloge ? new Date(horloge()).toISOString() : '2026-01-01T00:00:00Z' }));
    }
    // LE DÉCOUVERT, sur l'effet NET du mouvement et compte par compte, exactement comme db-pg.js.
    // Deux comptes seulement en sont exemptés — un compte d'émission et un compte de contrepartie —
    // et les séquestres n'en font PAS partie : c'est ce qui referme le trou du second gain sur un
    // même billet, qu'aucune clé d'idempotence ne peut fermer seule.
    const effet = new Map();
    for (const t of transferts) {
      effet.set(t.compteDebit, (effet.get(t.compteDebit) || 0) - t.montantCents);
      effet.set(t.compteCredit, (effet.get(t.compteCredit) || 0) + t.montantCents);
    }
    for (const [compte, delta] of effet) {
      if (delta >= 0 || L.decouvertAutorise(compte)) continue;
      const solde = soldeDe(compte);
      if (solde + delta < 0) {
        const e = new Error(`grand livre : ${compte} porte ${solde} et ce mouvement lui demande ${-delta}`);
        e.code = 'decouvert'; e.compte = compte; e.solde = solde; e.requis = -delta;
        throw e;
      }
    }
    for (const n of nouvelles) ledger.push(n);
    return { ecrites: nouvelles.length };
  }
  // L'ÉCRIVAIN DU JOURNAL D'OPÉRATION, et ses contraintes imitées une par une comme celles du grand
  // livre. Les bornes ne sont pas recopiées : elles viennent d'`api/ledger.js`, qui est aussi ce que
  // `schema.sql` recopie — une doublure qui écrirait ses propres bornes mentirait dans le mauvais
  // sens, en acceptant une raison vide que la colonne refuse.
  const refuseAudit = contrainte => {
    const e = new Error(`new row for relation "ledger_audit" violates constraint "${contrainte}"`);
    e.code = '23514'; e.constraint = contrainte;
    return e;
  };
  function ecrireAudit(plan) {
    // LA PANNE PROVOQUÉE SUR L'AUDIT. Sans elle, « l'écriture et sa raison partagent la transaction »
    // ne serait qu'une phrase : il faut pouvoir faire échouer la SECONDE moitié pour constater que
    // la première n'a rien laissé.
    if (panne.audit && panne.audit(plan)) throw refuseAudit('ledger_audit_raison_check');
    if (!L.AUDIT_GESTES.includes(plan.geste)) throw refuseAudit('ledger_audit_geste_check');
    if (typeof plan.par !== 'string' || plan.par.length < 1 || plan.par.length > L.AUDIT_OPERATEUR_MAX) {
      throw refuseAudit('ledger_audit_operateur_check');
    }
    if (typeof plan.raison !== 'string' || plan.raison.length < L.AUDIT_RAISON_MIN
        || plan.raison.length > L.AUDIT_RAISON_MAX) {
      throw refuseAudit('ledger_audit_raison_check');
    }
    // Une contre-passation porte ses cinq colonnes, ou elle n'est pas une contre-passation.
    const ARGENT = [plan.motifOrigine, plan.referenceOrigine, plan.referencePosee,
                    plan.jambes, plan.montantCents];
    const absent = v => v === null || v === undefined;
    if (plan.geste === 'contrepassation' && ARGENT.some(absent)) {
      throw refuseAudit('ledger_audit_contrepassation_complete');
    }
    // Et une anonymisation porte son compte, et AUCUN centime : la contrainte jumelle, écrite dans
    // les deux sens. Une ligne qui porterait les deux moitiés se lirait comme une correction du
    // livre, alors qu'aucun argent n'a bougé.
    if (plan.geste === 'anonymisation' && (absent(plan.userId) || !ARGENT.every(absent))) {
      throw refuseAudit('ledger_audit_anonymisation_complete');
    }
    verifierColonnes({ montant_cents: plan.montantCents });
    audit.push(Object.freeze({
      id: String(nextAudit++), geste: plan.geste, operateur: plan.par, raison: plan.raison,
      user_id: absent(plan.userId) ? null : String(plan.userId),
      motif_origine: plan.motifOrigine, reference_origine: plan.referenceOrigine,
      reference_posee: plan.referencePosee, jambes: plan.jambes,
      montant_cents: plan.montantCents,
      cree_le: horloge ? new Date(horloge()).toISOString() : '2026-01-01T00:00:00Z' }));
    return { ecrites: 1 };
  }
  // L'EXPOSITION, ET ELLE PASSE PAR LES FONCTIONS PURES DU GRAND LIVRE. La doublure ne réécrit ni la
  // règle qui ramène une écriture à un billet, ni la liste des comptes de maison, ni celle des
  // motifs : elle lit `expositionDe`, `COMPTES_EXPOSITION` et `MOTIFS_EXPOSITION`, exactement comme
  // la requête SQL de `db-pg.js` les reçoit en paramètres. Une doublure qui recopierait ces listes
  // mentirait dans le mauvais sens — en acceptant ce que la base compte, ou l'inverse.
  const transfertsDuLivre = filtre => ledger.filter(filtre).map(l => ({
    motif: l.motif, reference: l.reference, compteDebit: l.compte_debit,
    compteCredit: l.compte_credit, montantCents: l.montant_cents }));
  const fenetreDepuis = maintenant =>
    new Date((maintenant instanceof Date ? maintenant.getTime() : Number(maintenant))
             - L.PLAFOND_FENETRE_H * 3600 * 1000);
  // Les billets d'UN joueur, sur la fenêtre : le miroir de la jointure `m.user_id = $1` et des DEUX
  // bornes de la requête réelle, `cree_le >= $2` et `cree_le <= $5`. La borne haute est l'ancre du
  // chiffre : au point qui décide elle vaut l'heure d'ouverture du billet, et l'outil d'opération
  // s'en sert pour rejouer un verdict des mois après sans que les jambes écrites depuis ne le
  // faussent.
  const expositionFenetre = (userId, depuis, jusqua) => L.expositionDe(
    transfertsDuLivre(l => new Date(l.cree_le) >= depuis && new Date(l.cree_le) <= jusqua),
    matches.filter(x => x.user_id === userId).map(x => String(x.id)));
  // LE FUSIBLE GLOBAL : le cumul de TOUS les joueurs, et SANS jointure — comme la requête réelle, et
  // pour la même raison. C'est un interrupteur, pas un invariant : les quatre motifs suffisent à
  // écarter la dotation et la recharge, et ce qu'une jointure ajouterait vaut zéro centime sur un
  // seuil de deux millions.
  const expositionMaisonDe = depuis => {
    const dans = transfertsDuLivre(
      l => new Date(l.cree_le) >= depuis && L.MOTIFS_EXPOSITION.includes(l.motif));
    return 0 - L.COMPTES_EXPOSITION.reduce((s, compte) => s + L.soldeDe(dans, compte), 0);
  };
  // Le règlement d'un séquestre, et il n'y en a qu'un : vider celui d'un billet clos sans montant
  // et régler celui d'un joueur qui vient de perdre sont la MÊME opération comptable. Le miroir
  // exact de `reglerSequestre` de db-pg.js, frontière avec la 02a comprise — un séquestre vide veut
  // dire que le livre n'a jamais engagé cette partie, et on n'écrit alors RIEN.
  function reglerSequestreDe(ligne) {
    const engage = soldeDe(L.compteEnjeu(ligne.id));
    if (engage <= 0) return { ecrites: 0 };
    return ecrireLedger(L.mouvementGain({
      userId: ligne.user_id, matchId: ligne.id, miseCents: engage,
      grossCents: ligne.gross_cents || 0, feeCents: ligne.fee_cents || 0,
      netCents: ligne.net_cents || 0,
      convergee: ligne.digest_match === true,
    }));
  }
  // Le JOUR d'une recharge, en UTC comme dans db-pg.js. Un jour calculé dans le fuseau de la
  // machine ferait basculer deux instances à deux heures différentes, et « une recharge par jour »
  // deviendrait « une ou deux selon le serveur qui répond ».
  const jourDe = at => new Date(at === undefined || at === null ? Date.now() : at)
    .toISOString().slice(0, 10);
  // Les statistiques sont la SOMME des parties réglées, exactement comme l'agrégat SQL de
  // db-pg.js. Aucun compteur n'existe nulle part : il n'y a rien à incrémenter, donc rien qu'un
  // double envoi puisse fausser. Une partie refusée, périmée ou encore ouverte ne compte pour
  // rien, et `wins` retient la victoire comme l'encaissement — le jeu compte les deux.
  //
  // Depuis la phase 02b, les quatre premiers chiffres ne comptent que les parties dont le REJEU A
  // CONVERGÉ, exactement comme le `filter (where digest_match)` de db-pg.js : le grand livre de la
  // phase 03 ne lira jamais que celles-là. Le cinquième dit combien ce filtre en écarte.
  const statsOf = id => {
    const reglees = matches.filter(m => m.user_id === id && m.status === 'settled');
    const convergees = reglees.filter(m => m.digest_match === true);
    return {
      matches: convergees.length,
      wins: convergees.filter(m => m.issue === 'victoire' || m.issue === 'encaissement').length,
      kills: convergees.reduce((s, m) => s + (m.kills || 0), 0),
      best: convergees.reduce((b, m) => Math.max(b, m.net_cents || 0), 0),
      divergences: reglees.length - convergees.length,
    };
  };
  return {
    users,
    matches,
    traces,
    panne,
    // La doublure imite les deux CONTRAINTES de la base, dans l'ordre exact de db-pg.js. Elle ne
    // regarde jamais si un billet existe avant de décider d'en créer un : elle rejoue ce que la
    // base répondrait à une insertion refusée. C'est aussi la limite connue de cet exercice — rien
    // ici ne prouve que Postgres se comporte comme ce code-là.
    async createMatch(m) {
      const dispo = L.compteJoueur(m.userId), quar = L.compteQuarantaine(m.userId);
      const argent = () => ({ balanceCents: soldeDe(dispo), quarantineCents: soldeDe(quar) });
      // LE PLAFOND PAR JOUEUR, LU AVANT TOUT LE RESTE — dans db-pg.js, c'est après le verrou de
      // ligne, et c'est ce verrou qui le rend EXACT. La doublure n'a pas de verrou : un mono-fil
      // JavaScript sérialise gratuitement ce que Postgres ne sérialise que si on le lui demande
      // bien, et c'est `api/db-check.js` qui éprouve deux ouvertures simultanées.
      //
      // Le PIRE CAS est REÇU, jamais calculé ici : `netMaxCents` vient de `WBCore` par `app.js`.
      //
      // L'ANCRE EST L'HEURE D'OUVERTURE, DES DEUX CÔTÉS DE LA FENÊTRE — `fenetreDepuis(openedAt)` en
      // bas, `openedAt` en haut — comme la requête réelle. Rien de postérieur n'existe à cet instant,
      // donc la borne haute ne retire rien ici ; elle rend le chiffre REJOUABLE par l'outil
      // d'opération, des mois après.
      const realiseeCents = expositionFenetre(m.userId, fenetreDepuis(m.openedAt), m.openedAt);
      const plafond = L.plafondVerdict({
        expositionRealiseeCents: realiseeCents,
        expositionBilletCents: L.expositionBilletMaxCents(m.netMaxCents, m.stakeCents),
        plafondCents: L.PLAFOND_JOUEUR_CENTS,
      });
      // LE CHEMIN `repris` N'ÉCRIT JAMAIS UNE SECONDE MISE. C'est le vol le plus facile de la
      // phase — un `POST` rejoué qui débite deux fois — et il se referme en ne posant rien ici.
      const rejeu = matches.find(x => x.user_id === m.userId && x.client_key === m.clientKey);
      if (rejeu) return { match: rejeu, repris: true, ...argent() };
      const ouvert = matches.find(x => x.user_id === m.userId && x.status === 'open');
      const vivant = ouvert && new Date(ouvert.expires_at) > m.openedAt;
      if (ouvert && vivant && !ouvert.first_result_at)
        return { match: ouvert, repris: true, ...argent() };

      // LE SOLDE EST REGARDÉ AVANT QUE QUOI QUE CE SOIT NE BOUGE, et l'ordre n'est pas le même que
      // dans db-pg.js : là-bas l'insertion précède le contrôle et c'est l'annulation de la
      // transaction qui rend la ligne à l'inexistence, ce qu'une doublure sans transaction ne peut
      // pas imiter. Ce qui doit être identique, et l'est, c'est ce qu'on OBSERVE après un refus :
      // aucun billet, aucune écriture, et pas même la clôture du billet périmé.
      // LE PLAFOND NE S'APPLIQUE QU'À L'OUVERTURE D'UN BILLET NEUF : les deux chemins `repris`
      // ci-dessus sont déjà passés, et c'est voulu. Refuser un billet que le joueur DÉTIENT, mise
      // débitée, l'enfermerait dedans jusqu'à l'expiration — il n'en a qu'un à la fois. Il vient
      // AVANT le contrôle des fonds, comme dans db-pg.js, parce que c'est la maison qui ne veut pas
      // de ce billet-là, et cela ne dépend pas de ce que le joueur a en poche.
      if (plafond.franchi)
        return { match: null, refus: 'plafond', portee: 'joueur',
                 expositionCents: plafond.expositionCents,
                 // LA RÉALISÉE REMONTE À PART, comme dans db-pg.js : `plafondVerdict` ne rend que la
                 // somme, et `app.js` en a besoin seule pour savoir s'il reste au joueur la place
                 // d'une table moins chère.
                 expositionRealiseeCents: realiseeCents,
                 plafondCents: plafond.plafondCents };

      const solde = soldeDe(dispo);
      if (solde < m.stakeCents)
        return { match: null, refus: 'fonds', balanceCents: solde,
                 quarantineCents: soldeDe(quar), requisCents: m.stakeCents };

      // UN BILLET NE SERT QU'UNE TENTATIVE. Périmé, ou déjà joué, il est clos sans montant et la
      // place se libère : le joueur reçoit un billet neuf, donc une graine neuve, donc un autre
      // monde. Sans cela, bloquer l'envoi de sa trace suffisait à se faire resservir le même.
      // Son séquestre se vide DANS LA FOULÉE, sans quoi de l'argent resterait dans un compte que
      // plus rien ne solde. Le joueur n'est pas remboursé : la mise rentre chez la maison.
      if (ouvert) {
        ouvert.status = vivant ? 'abandoned' : 'expired';
        reglerSequestreDe(ouvert);
      }
      const ligne = {
        id: nextMatch++, user_id: m.userId, mode: m.mode, stake_cents: m.stakeCents, seats: m.seats,
        team_size: m.teamSize,
        // Écrite par le SERVEUR et figée, comme `seats`, `team_size` et `sim_version`. La doublure
        // doit la porter, sans quoi le test qui prouve que le client ne peut pas l'écrire ne
        // regarderait qu'une colonne absente des deux côtés.
        paid_seats: m.paidSeats,
        brawler: m.brawler, seed_public: m.seedPublic, seed_secret: m.seedSecret,
        sim_version: m.simVersion,
        client_key: m.clientKey, status: 'open', first_result_at: null,
        opened_at: m.openedAt, expires_at: m.expiresAt,
      };
      verifierColonnes(ligne);
      // LA MISE, DÉBITÉE À L'OUVERTURE ET DANS LE MÊME SOUFFLE QUE LE BILLET. Pas de billet sans
      // son écriture, pas d'écriture sans son billet : on écrit le livre AVANT de poser la ligne,
      // parce qu'une doublure sans transaction n'a que cet ordre-là pour imiter une annulation.
      try {
        ecrireLedger(L.mouvementMise({ userId: m.userId, matchId: ligne.id, miseCents: m.stakeCents }));
      } catch (e) {
        if (!refusDuLivre(e)) throw e;
        return { match: null, refus: 'livre', detail: e.code };
      }
      matches.push(ligne);
      return { match: ligne, repris: false, ...argent() };
    },
    async findMatch({ matchId, userId }) {
      // `user_id` fait partie de la recherche, pas d'une vérification après coup : un identifiant
      // deviné ne doit rien apprendre sur la partie de quelqu'un d'autre.
      return matches.find(x => memeId(x.id, matchId) && x.user_id === userId) || null;
    },
    // La marque « une partie a été jouée sur ce billet » : une écriture de STATUT, jamais de
    // montant, et sa clause imite celle du vrai pilote — `status = 'open' and first_result_at is
    // null`. Elle ne se pose donc qu'une fois, et un résultat renvoyé ne modifie pas la ligne.
    async markPlayed({ matchId, userId, at }) {
      const m = matches.find(x => memeId(x.id, matchId) && x.user_id === userId
                                  && x.status === 'open' && !x.first_result_at);
      if (!m) return { marque: false };
      m.first_result_at = at;
      return { marque: true };
    },
    async settleMatch(r) {
      const m = matches.find(x => memeId(x.id, r.matchId) && x.user_id === r.userId);
      if (!m) return { match: null, deja: true };
      // La doublure imite la clause `where` de db-pg.js, et rien d'autre : `status = 'open' and
      // net_cents is null`. Un second règlement ne touche donc aucune ligne, et on rend celle qui
      // a été écrite la première fois.
      if (m.status !== 'open' || (m.net_cents !== undefined && m.net_cents !== null))
        return { match: m, deja: true };
      const ecriture = {
        status: r.status, settled_at: r.settledAt, issue: r.issue, controle: r.controle, motif: r.motif,
        gross_cents: r.grossCents, fee_cents: r.feeCents, net_cents: r.netCents, purse_cents: r.purseCents,
        declared_net_cents: r.declaredNetCents, ecart_cents: r.ecartCents,
        seconds: r.seconds, kills: r.kills, deaths: r.deaths, rank: r.rank,
        cubes: r.cubes, damage: r.damage, cashed_out: r.cashedOut,
        trace_steps: r.traceSteps, replay_digest: r.replayDigest, digest_match: r.digestMatch,
        divergence_step: r.divergenceStep, replay_ms: r.replayMs,
      };
      // Vérifié AVANT d'écrire : une ligne à demi réglée par une écriture qui échoue en plein
      // milieu serait pire que la panne qu'on cherche à reproduire.
      verifierColonnes(ecriture);
      // LE RÈGLEMENT DE LA LIGNE ET LES TRANSFERTS DU GAIN SONT UNE SEULE TRANSACTION en base. La
      // doublure n'en a pas, alors elle règle le séquestre D'ABORD, sur la ligne telle qu'elle
      // SERA : si le livre refuse, la ligne `matches` n'a pas bougé d'un octet, et on observe
      // exactement ce qu'une transaction annulée aurait laissé — rien.
      try {
        reglerSequestreDe({ ...m, ...ecriture });
      } catch (e) {
        if (!refusDuLivre(e)) throw e;
        return { match: null, refus: 'livre', detail: e.code };
      }
      Object.assign(m, ecriture);
      return { match: m, deja: false };
    },
    // La trace. La doublure imite la clé primaire (match_id, seq) et `on conflict do nothing` : le
    // PREMIER écrit gagne, un second segment de même rang ne remplace rien, et il n'existe aucun
    // chemin qui modifie ou supprime une ligne déjà posée.
    async addTrace({ matchId, seq, simVersion, steps, data, maxSteps }) {
      const miennes = traces.filter(t => String(t.match_id) === String(matchId));
      const meme = miennes.find(t => t.seq === seq);
      const avant = miennes.reduce((s, t) => s + t.steps, 0);
      // Le premier écrit gagne, mais il le DIT : un rang déjà posé dont les données diffèrent est
      // refusé, sans quoi deux tentatives se cousent bout à bout en une partie que personne n'a
      // jouée. Un renvoi à l'identique reste parfaitement idempotent.
      if (meme && meme.data !== data)
        return { refuse: 'divergente', segments: miennes.length, totalSteps: avant };
      const deja = !!meme;
      if (!deja && avant + steps > maxSteps)
        return { refuse: 'trop_de_pas', segments: miennes.length, totalSteps: avant };
      if (!deja) {
        const ligne = { match_id: matchId, seq, sim_version: simVersion, steps, data,
                        created_at: '2026-01-01T00:00:00Z' };
        verifierColonnes(ligne);
        traces.push(ligne);
      }
      const apres = traces.filter(t => String(t.match_id) === String(matchId));
      return { segments: apres.length, totalSteps: apres.reduce((s, t) => s + t.steps, 0) };
    },
    // La trace relue pour le rejeu, dans l'ordre des rangs. Lecture seule : rien ici ne peut
    // modifier une ligne, comme db-pg.js n'écrit aucun `update` sur cette table.
    async listTraces({ matchId }) {
      return traces.filter(t => String(t.match_id) === String(matchId))
                   .slice().sort((a, b) => a.seq - b.seq)
                   .map(t => ({ seq: t.seq, sim_version: t.sim_version, steps: t.steps, data: t.data }));
    },
    // LE VEILLEUR, ÉCRIVAIN D'ARGENT DEPUIS LA PHASE 03. Il clôt les billets que personne n'a
    // terminés ET IL VIDE LEUR SÉQUESTRE vers `maison:contrepartie` : une ligne close dont le
    // séquestre reste habité est de l'argent que plus rien ne solde. Il NE REMBOURSE PAS — passé la
    // fenêtre de renoncement, rien ne rend la mise, et c'est très exactement le vol que la phase
    // ferme.
    //
    // Une transaction par billet, comme le vrai pilote : un échec sur l'une n'annule pas les autres,
    // et le billet qui échoue est NOMMÉ. La doublure n'a pas de transaction, alors elle écrit le
    // livre AVANT de changer le statut — le même ordre qu'ailleurs, et pour la même raison : c'est
    // le seul moyen d'imiter une annulation.
    async expireMatches({ avant, max = 500 }) {
      const candidats = matches
        .filter(m => m.status === 'open' && new Date(m.expires_at) <= avant)
        .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))
        .slice(0, max);
      let closes = 0;
      const echecs = [];
      for (const m of candidats) {
        try {
          reglerSequestreDe({ ...m, status: 'expired' });
        } catch (e) {
          if (!refusDuLivre(e)) throw e;
          echecs.push({ id: String(m.id), code: e.code });
          continue;
        }
        m.status = 'expired';
        closes++;
      }
      return { closes, echecs };
    },
    // LA RENONCIATION, LE SEUL CHEMIN QUI RENDE UNE MISE. La fenêtre est arbitrée par `app.js` avec
    // `WBCore.renonciationOuverte` : rien ici ne la recalcule. Ce que la doublure imite, c'est la
    // clause du vrai `update` — `status = 'open' and net_cents is null` — et le fait que la clôture
    // et le remboursement soient indissociables. Le montant rendu est ce que le SÉQUESTRE porte, pas
    // `stake_cents` : un séquestre vide veut dire que le livre n'a jamais engagé cette partie (une
    // ligne de la phase 02a), et on n'écrit alors rien.
    async renounceMatch({ matchId, userId, at }) {
      const m = matches.find(x => memeId(x.id, matchId) && x.user_id === userId);
      if (!m || m.status !== 'open' || (m.net_cents !== undefined && m.net_cents !== null))
        return { match: null, deja: m || null };
      const engage = soldeDe(L.compteEnjeu(m.id));
      if (engage > 0) {
        try {
          ecrireLedger(L.mouvementRemboursement({ userId, matchId: m.id, miseCents: engage }));
        } catch (e) {
          if (!refusDuLivre(e)) throw e;
          return { match: null, refus: 'livre', detail: e.code };
        }
      }
      m.status = 'renounced';
      m.settled_at = at;
      return { match: m, rembourseCents: engage > 0 ? engage : 0,
               balanceCents: soldeDe(L.compteJoueur(userId)),
               quarantineCents: soldeDe(L.compteQuarantaine(userId)) };
    },
    // Le dernier billet renoncé, celui sur lequel la TEMPORISATION se décide. `order by opened_at
    // desc limit 1` du vrai pilote, imité tel quel.
    async lastRenounced({ userId }) {
      return matches.filter(x => x.user_id === userId && x.status === 'renounced')
                    .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at))[0] || null;
    },
    // LA PURGE DES TRACES, MIROIR DE LA CLAUSE DU `delete` DE db-pg.js, condition par condition et
    // dans le même ordre. C'est le premier effacement du dépôt sur la pièce qui prouve un paiement :
    // les quatre conditions sont écrites ici comme là-bas, et un test les retire UNE PAR UNE.
    //
    // Elle ne touche ni `matches` ni `ledger` : elle les lit. La rétention vient d'`api/ledger.js`,
    // l'heure de l'appelant — c'est ce qui permet de faire vieillir une trace sans attendre quatre
    // cents jours.
    async purgeTraces({ maintenant, max = 500 }) {
      const t = maintenant instanceof Date ? maintenant.getTime() : Number(maintenant);
      if (!Number.isFinite(t)) throw new Error('purge des traces : heure illisible');
      const avant = new Date(t - L.TRACE_RETENTION_JOURS * 24 * 3600 * 1000);
      const purgeables = matches.filter(m =>
        // (a) réglée DÉFINITIVEMENT
        ['settled', 'rejected'].includes(m.status)
        // (d) le délai est écoulé
        && m.settled_at !== undefined && m.settled_at !== null
        && new Date(m.settled_at) < avant
        // (b) le grand livre a posé son écriture sur cette partie
        && ledger.some(l => l.reference === String(m.id) && L.MOTIFS_REGLEMENT.includes(l.motif))
        // (c) rien n'est en attente : le séquestre est vide
        && soldeDe(L.compteEnjeu(m.id)) === 0)
        .sort((a, b) => new Date(a.settled_at) - new Date(b.settled_at))
        .slice(0, max);
      const vises = new Set(purgeables.map(m => String(m.id)));
      // `parties` compte les parties dont une trace a RÉELLEMENT été effacée, pas les candidates :
      // c'est ce que le `returning match_id` du vrai `delete` rend, et une partie sans trace ne rend
      // rien du tout.
      const touchees = new Set();
      let effacees = 0;
      for (let i = traces.length - 1; i >= 0; i--) {
        if (!vises.has(String(traces[i].match_id))) continue;
        touchees.add(String(traces[i].match_id));
        traces.splice(i, 1);
        effacees++;
      }
      return { effacees, parties: touchees.size, avant };
    },
    // ---- LE GRAND LIVRE. Trois méthodes, une seule écrit, et il n'en existe pas de quatrième.
    //
    // Ce que cette doublure NE PROUVE PAS, et qu'il faut dire : le vrai écrivain prend un client
    // déjà en transaction, celui-ci n'en a pas — un mono-fil JavaScript sérialise gratuitement ce
    // que Postgres ne sérialise que si on le lui demande bien. La concurrence et l'atomicité
    // s'éprouvent dans `api/db-check.js`, contre une vraie base, et là seulement.
    ledger,
    async ledgerWrite(transferts) {
      return ecrireLedger(transferts);
    },
    // La somme des crédits moins la somme des débits, et un NOMBRE : le vrai pilote convertit ce que
    // `sum()` lui rend en chaîne, la doublure rend donc ce qu'il rend une fois converti.
    async ledgerSolde(compte) {
      L.exigeCompte(compte);
      return soldeDe(compte);
    },
    // LE FUSIBLE GLOBAL. Il est une méthode du `db` injecté — pas une des trois fonctions à client
    // transactionnel — précisément parce qu'il est lu HORS de la transaction du billet : le routeur
    // doit pouvoir le demander sans rien tenir.
    async expositionMaison({ depuis }) {
      return expositionMaisonDe(depuis);
    },
    async ledgerDe({ reference }) {
      return ledger.filter(l => l.reference === reference)
                   .map(l => ({ id: l.id, motif: l.motif, reference: l.reference,
                                compte_debit: l.compte_debit, compte_credit: l.compte_credit,
                                montant_cents: l.montant_cents, cree_le: l.cree_le }));
    },
    // ---- CE QUE `api/operateur.js` DEMANDE, ET RIEN D'AUTRE NE L'APPELLE. Aucune route ne les
    // connaît : l'outil est en ligne de commande, jamais en HTTP, et une garde textuelle vérifie
    // qu'`api/app.js` ne charge pas l'outil et ne porte aucune route d'administration.
    //
    // `ledger_audit` est exposée comme `ledger` et pour la même raison : pour être OBSERVÉE par les
    // tests. Ses lignes sont gelées elles aussi.
    ledgerAudit: audit,
    // Les jambes d'UN mouvement, c'est-à-dire d'un couple `(motif, reference)` — et pas de la seule
    // référence, qui ramènerait la mise ET le gain d'un même billet.
    async lireMouvement({ motif, reference }) {
      return ledger.filter(l => l.motif === motif && l.reference === reference)
                   .map(l => ({ ...l }));
    },
    // Les gestes déjà consignés sur ce mouvement. Un journal qu'on ne peut relire qu'en ouvrant
    // `psql` est une invitation à ouvrir `psql`.
    async lireAudit({ motif, reference }) {
      return audit.filter(l => l.motif_origine === motif && l.reference_origine === reference)
                  .map(l => ({ ...l }));
    },
    // Les gestes consignés sur un COMPTE. L'anonymisation ne porte sur aucune écriture du livre :
    // sans cette seconde lecture, sa trace n'aurait aucun chemin de relecture par l'outil.
    async lireAuditJoueur({ userId }) {
      return audit.filter(l => l.user_id !== null && memeId(l.user_id, userId))
                  .map(l => ({ ...l }));
    },
    // Le billet SANS `user_id` dans la clause : l'outil part d'une écriture du livre, dont la
    // référence ne porte que le billet, et il n'y a personne à protéger de l'opérateur.
    async lireBillet({ matchId }) {
      return matches.find(x => memeId(x.id, matchId)) || null;
    },
    async lireUtilisateur({ userId }) {
      return users.find(x => memeId(x.id, userId)) || null;
    },
    async expositionJoueurCents({ userId, maintenant, jusqua }) {
      return expositionFenetre(userId, fenetreDepuis(maintenant),
                               jusqua === undefined ? maintenant : jusqua);
    },
    // LA CONTRE-PASSATION ET SA RAISON, DANS LA MÊME TRANSACTION — imitée, et il faut dire comment.
    // La doublure n'a pas de transaction : elle pose le livre d'abord, comme le vrai pilote, puis
    // l'audit, et elle DÉFAIT ce qu'elle vient de poser si l'audit échoue. C'est le seul endroit du
    // fichier qui raccourcisse `ledger`, et c'est un `rollback`, pas une modification : la règle
    // « aucun update, aucun delete » parle de lignes COMMISES.
    //
    // CE QUE CELA NE PROUVE PAS : que Postgres se comporte ainsi. Un mono-fil JavaScript décide de
    // l'ordre de ses `await` ; seul `api/db-check.js`, contre une vraie base, fait arbitrer
    // l'atomicité par la base elle-même, et c'est écrit dans `docs/PHASE-04A.md`.
    async contrepasser(plan) {
      const avant = ledger.length;
      try {
        ecrireLedger(plan.contrepassation);
        ecrireAudit(plan);
      } catch (e) {
        ledger.length = avant;
        // LA CLÉ D'IDEMPOTENCE A REFUSÉ LA SECONDE POSE, ET CE N'EST PAS UNE PANNE : l'outil le dit
        // au lieu de sortir en erreur. Le découvert non plus n'est pas une panne — contre-passer une
        // dotation déjà dépensée demande au compte plus qu'il ne porte, et la règle uniforme
        // l'arrête. Le miroir exact de `contrepasser` de db-pg.js.
        if (e && e.code === '23505') return { pose: false, deja: true };
        if (e && e.code === 'decouvert') {
          return { pose: false, refus: 'decouvert', message: e.message,
                   compte: e.compte, solde: e.solde, requis: e.requis };
        }
        throw e;
      }
      return { pose: true, jambes: plan.jambes, montantCents: plan.montantCents };
    },
    // L'ANONYMISATION ET SA RAISON, DANS LA MÊME TRANSACTION — imitée comme la contre-passation, et
    // avec le même aveu : la doublure réécrit la ligne d'abord, consigne ensuite, et REMET la ligne
    // d'origine si l'audit échoue. C'est un `rollback` décidé par l'ordre des `await`, pas par
    // Postgres ; seul `api/db-check.js` fait arbitrer l'atomicité par la base.
    //
    // ELLE IMITE AUSSI LES CONTRAINTES DE `users`, une par une et par leur nom, parce que c'est très
    // exactement ce que ce module peut se raconter à tort : « la valeur écrite à la place satisfait
    // la colonne ». `not null` sur quatre colonnes, deux `check` de longueur, deux index uniques.
    async anonymiser(plan) {
      const u = users.find(x => memeId(x.id, plan.userId));
      if (!u) return { pose: false, absent: true };
      const refuse = (code, contrainte, message) => {
        const e = new Error(message); e.code = code; e.constraint = contrainte; return e;
      };
      const avant = { ...u };
      try {
        const a = plan.apres;
        for (const [col, v] of [['auth_id', a.authId], ['email', a.email], ['name', a.name],
                                ['name_key', a.nameKey]]) {
          if (typeof v !== 'string' || v.length === 0) {
            throw refuse('23502', `users_${col}_not_null`, `null value in column "${col}"`);
          }
        }
        if (a.name.length < L.USERS_NOM_MIN || a.name.length > L.USERS_NOM_MAX) {
          throw refuse('23514', 'users_name_len', `new row for relation "users" violates constraint "users_name_len"`);
        }
        if (a.nameKey.length < L.USERS_CLE_MIN || a.nameKey.length > L.USERS_CLE_MAX) {
          throw refuse('23514', 'users_name_key_len', `new row for relation "users" violates constraint "users_name_key_len"`);
        }
        if (users.some(x => x !== u && x.auth_id === a.authId)) {
          throw refuse('23505', 'users_auth_id_key', 'duplicate key value violates unique constraint "users_auth_id_key"');
        }
        if (users.some(x => x !== u && x.name_key === a.nameKey)) {
          throw refuse('23505', 'users_name_key_key', 'duplicate key value violates unique constraint "users_name_key_key"');
        }
        // `id` n'est PAS dans cette liste, et c'est tout le module : le grand livre nomme ses comptes
        // avec lui, et il est en insertion seule.
        Object.assign(u, { auth_id: a.authId, email: a.email, name: a.name, name_key: a.nameKey,
                           avatar: a.avatar, country: a.country });
        ecrireAudit(plan);
      } catch (e) {
        Object.assign(u, avant);
        if (e && e.code === '23505') {
          return { pose: false, collision: true, contrainte: e.constraint || '', message: e.message };
        }
        throw e;
      }
      return { pose: true };
    },
    // LA DOTATION ET LA RECHARGE SONT ÉCRITES ICI, PAR LE SERVEUR, et il n'existe aucune route que
    // le client puisse appeler pour en déclencher une. Le miroir exact de `findOrCreate` de
    // db-pg.js : dotation dans le même souffle que la création du compte, recharge à chaque
    // connexion mais SEULEMENT au-dessous du plancher, et une seule par joueur et par jour.
    async findOrCreate({ authId, email, name, nameKey, at }) {
      let u = users.find(x => x.auth_id === authId);
      if (!u) {
        let base = name, cle = nameKey(base), n = 1;
        while (users.some(x => x.name_key === cle)) {
          n += 1; const s = String(n);
          base = name.slice(0, 14 - s.length) + s; cle = nameKey(base);
        }
        u = { id: next++, auth_id: authId, email, name: base, name_key: cle, avatar: '', country: null,
              created_at: '2026-01-01T00:00:00Z' };
        users.push(u);
        ecrireLedger(L.mouvementDotation({ userId: u.id, montantCents: L.DOTATION_CENTS }));
      }
      const dispo = L.compteJoueur(u.id);
      if (soldeDe(dispo) < L.PLANCHER_CENTS) {
        const jour = jourDe(at);
        // On relit avant d'écrire, comme le vrai pilote et pour la même raison : le livre REFUSE un
        // doublon au lieu de l'avaler, et un refus annulerait toute la transaction de connexion
        // alors qu'un joueur qui repasse sous le plancher le même jour est un cas normal.
        if (!ledger.some(l => l.motif === 'recharge' && l.reference === `${u.id}:${jour}`))
          ecrireLedger(L.mouvementRecharge({ userId: u.id, jour, montantCents: L.RECHARGE_CENTS }));
      }
      return { user: u, stats: statsOf(u.id), balanceCents: soldeDe(dispo),
               quarantineCents: soldeDe(L.compteQuarantaine(u.id)) };
    },
    async updateProfile(authId, champs) {
      const u = users.find(x => x.auth_id === authId);
      if (!u) return { user: null };
      if (champs.name_key && users.some(x => x !== u && x.name_key === champs.name_key)) return { conflit: true };
      Object.assign(u, champs);
      return { user: u, stats: statsOf(u.id), balanceCents: soldeDe(L.compteJoueur(u.id)),
               quarantineCents: soldeDe(L.compteQuarantaine(u.id)) };
    },
  };
}

const ORIGINE = 'https://warblock.example';
function appel(app, { method = 'GET', path = '/api/me', token, body, origin = ORIGINE } = {}) {
  const req = new (require('node:stream').Readable)({ read() {} });
  req.method = method; req.url = path;
  req.headers = { origin, ...(token ? { authorization: 'Bearer ' + token } : {}) };
  if (body !== undefined) { req.push(typeof body === 'string' ? body : JSON.stringify(body)); }
  req.push(null);
  return new Promise(resolve => {
    const res = {
      writeHead(code, head) { this.code = code; this.head = head || {}; },
      end(texte) { resolve({ code: this.code, head: this.head, corps: texte ? JSON.parse(texte) : null }); },
    };
    app(req, res);
  });
}

// un vérificateur qui accepte « ok:<id> » et refuse tout le reste
const verifOk = async jeton => {
  if (!jeton.startsWith('ok:')) throw new Error('refusé');
  const [, id, nom] = jeton.split(':');
  return { authId: id, email: `${id}@exemple.test`, name: nom || 'Joueur' };
};
const appDe = (db, extra = {}) => createApp({ db, verifyToken: verifOk, origins: [ORIGINE], ...extra });

// ---------- de quoi observer le billet ----------
// Une horloge et une source de graines qui n'ont rien d'aléatoire : les deux sont injectées, donc
// tout ce que le serveur en tire est comparable à une valeur écrite dans le test. La source lance
// quand elle est épuisée, ce qui fixe au passage le nombre de tirages : deux par billet, ni plus.
const GRAINES = Array.from({ length: 40 }, (_, i) => (i + 1) * 101010101);
// La graine secrète a SA source depuis qu'elle fait 128 bits : elle n'est plus dans le domaine de
// `makeRng`, donc elle ne peut plus sortir du même robinet sans mentir sur ce qu'elle vaut. Ces
// valeurs-là n'ont rien d'aléatoire non plus : ce qu'on veut observer, c'est qu'elles ne fuient
// jamais et qu'elles viennent bien du serveur.
const SECRETS = Array.from({ length: 40 }, (_, i) => 'a' + String(i + 1).padStart(3, '0') + 'f'.repeat(28));
const T0 = Date.parse('2026-01-01T12:00:00Z');
const BRAWLER = Object.keys(C.BRAWLERS)[0];
const DEMANDE = { mode: 'solo', stake: 0.5, brawler: BRAWLER, clientKey: 'cle-1' };
// Combien de pas le compte à rebours d'intro consomme sans faire avancer `G.pas`. Il est posé par
// `WBSim.newMatch` — c'est une règle de simulation, et c'est ce qui permet au rejeu du serveur de
// le reposer sans que l'API n'en sache rien. On le MESURE plutôt que de le recopier : un test qui
// écrirait 240 cesserait de dire la vérité le jour où la valeur bouge.
const PAS_INTRO = (() => {
  const G = SIM.newMatch(1, C.MODES.solo, 50, C.BRAWLERS[BRAWLER]);
  let n = 0;
  while (G.intro > 0 && n < 10000) { SIM.step(G, {}); n++; }
  return n;
})();

function bancDeBillet(extra = {}) {
  const horloge = { t: T0 };
  // La doublure date ses écritures sur LA MÊME horloge que le routeur : c'est ce qui permet de faire
  // sortir une écriture de la fenêtre glissante du plafond en avançant `horloge.t`.
  const db = fakeDb([], () => horloge.t);
  let tire = 0, tireSecret = 0;
  const app = appDe(db, {
    randomSeed: () => {
      if (tire >= GRAINES.length) throw new Error('la source de graines est épuisée : trop de tirages');
      return GRAINES[tire++];
    },
    randomSecret: () => {
      if (tireSecret >= SECRETS.length) throw new Error('la source de secrets est épuisée : trop de tirages');
      return SECRETS[tireSecret++];
    },
    now: () => horloge.t,
    // LE CHRONOMÈTRE DU REJEU EST FIGÉ PAR DÉFAUT, et ce n'est pas de la paresse : une durée
    // mesurée sur la vraie horloge n'est pas la même d'une exécution à l'autre, et deux lignes
    // « strictement identiques » cesseraient de l'être pour la seule raison que la machine était
    // occupée. Les deux tests qui s'intéressent VRAIMENT au temps — le budget, et le coût réel
    // d'un rejeu — se donnent leur propre horloge.
    chrono: () => 0,
    ...extra,
  });
  return { db, app, horloge, tires: () => tire, tiresSecret: () => tireSecret };
}
const demander = (app, corps = DEMANDE, opts = {}) =>
  appel(app, { method: 'POST', path: '/api/match', token: 'ok:u1:Loic', body: corps, ...opts });

// Une autorité de signature de clés d'API, fabriquée sur place. Les vraies clés publiques de
// Crossmint vivent dans crossmint-key.js et ne servent qu'à vérifier ; pour éprouver aussi le cas
// où la signature est bonne, il faut pouvoir signer, donc une paire à nous. C'est à cela — et à
// rien d'autre — que sert le paramètre `signers` de parseApiKey.
function autorite() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const brut = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const b58 = base58Encode(brut);
  return { privateKey, signers: { development: b58, staging: b58, production: b58 } };
}

// Reproduit le format exact d'une clé Crossmint : <préfixe>_base58("<projet>.<suite>:<signature>"),
// la signature portant sur « <préfixe>.<projet>.<suite> ».
function fabriqueCle(a, { prefix = 'sk_production', projectId = 'proj_warblock', suite = 'aa11bb22' } = {}) {
  const donnees = `${projectId}.${suite}`;
  const signature = crypto.sign(null, Buffer.from(`${prefix}.${donnees}`, 'utf8'), a.privateKey);
  return `${prefix}_${base58Encode(Buffer.from(`${donnees}:${base58Encode(signature)}`, 'utf8'))}`;
}

const PROJET = 'proj_warblock';
const revendications = (extra = {}) => ({
  sub: 'user_1', aud: PROJET, exp: 4102444800, iat: 1700000000, email: 'joueur@exemple.test', ...extra,
});

(async () => {
console.log('Validation du profil');
test('un pseudo trop court est refusé avec un message qui dit quoi faire', () => {
  const { erreurs } = checkProfile({ name: 'a' });
  assert.strictEqual(erreurs.length, 1);
  assert.ok(erreurs[0].includes(String(C.NAME.min)) && erreurs[0].includes(String(C.NAME.max)), erreurs[0]);
});
test('un pseudo valide ressort nettoyé, avec sa clé d\'unicité', () => {
  const { champs, erreurs } = checkProfile({ name: '  Loïc  ' });
  assert.deepStrictEqual(erreurs, []);
  assert.strictEqual(champs.name, 'Loïc');
  assert.strictEqual(champs.name_key, C.nameKey('Loïc'));
});
test('un avatar inventé est refusé, un vrai passe', () => {
  assert.ok(checkProfile({ avatar: 'bolt:pirate' }).erreurs.length);
  const vrai = C.avatarList(Object.keys(C.BRAWLERS))[0].id;
  assert.deepStrictEqual(checkProfile({ avatar: vrai }).erreurs, []);
});
test('le pays est normalisé en deux lettres majuscules', () => {
  assert.strictEqual(checkProfile({ country: 'ca' }).champs.country, 'CA');
  assert.ok(checkProfile({ country: 'Canada' }).erreurs.length);
});
test('une requête qui ne demande rien est refusée', () => {
  assert.ok(checkProfile({}).erreurs.length);
});
test('un champ inconnu est ignoré, il ne peut pas se faufiler jusqu\'à la base', () => {
  const { champs } = checkProfile({ name: 'Zoe', id: 999, email: 'pirate@x', stats: { kills: 9999 } });
  assert.deepStrictEqual(Object.keys(champs).sort(), ['name', 'name_key']);
});

console.log('Authentification');
await test('sans jeton, rien ne passe', async () => {
  const r = await appel(appDe(fakeDb()), { token: undefined });
  assert.strictEqual(r.code, 401);
});
await test('un jeton refusé donne le même message qu\'un jeton expiré', async () => {
  const a = await appel(appDe(fakeDb()), { token: 'forge' });
  const b = await appel(appDe(fakeDb()), { token: 'expire' });
  assert.strictEqual(a.code, 401);
  assert.deepStrictEqual(a.corps, b.corps, 'la réponse ne doit pas dire pourquoi');
});
await test('la première connexion crée le compte, la seconde le retrouve', async () => {
  const db = fakeDb(), app = appDe(db);
  const un = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(un.code, 200);
  assert.strictEqual(db.users.length, 1);
  const deux = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(deux.corps.id, un.corps.id);
  assert.strictEqual(db.users.length, 1, 'une seconde visite ne doit pas créer un second compte');
});
await test('deux joueurs qui arrivent avec le même pseudo obtiennent deux comptes distincts', async () => {
  const db = fakeDb(), app = appDe(db);
  const a = await appel(app, { token: 'ok:u1:Loic' });
  const b = await appel(app, { token: 'ok:u2:Loic' });
  assert.notStrictEqual(a.corps.id, b.corps.id);
  assert.notStrictEqual(a.corps.name, b.corps.name, 'le second doit recevoir un pseudo libre');
  assert.strictEqual(db.users.length, 2);
});

console.log('Ce que le client reçoit');
await test('la réponse ne contient que les champs prévus, jamais la colonne d\'identité', async () => {
  const app = appDe(fakeDb());
  const r = await appel(app, { token: 'ok:u1:Loic' });
  assert.deepStrictEqual(Object.keys(r.corps).sort(),
    ['avatar', 'balanceCents', 'country', 'createdAt', 'email', 'id', 'name',
     'quarantineCents', 'stats'].sort());
  assert.ok(!('auth_id' in r.corps) && !('name_key' in r.corps));
  // Les deux montants du grand livre, SÉPARÉS et en centimes entiers. Les additionner ferait de la
  // quarantaine un solde, c'est-à-dire exactement ce qu'elle n'est pas.
  assert.strictEqual(r.corps.balanceCents, L.DOTATION_CENTS);
  assert.strictEqual(r.corps.quarantineCents, 0);
  // Et `PATCH /api/me` rend la MÊME forme : une réponse dont la forme dépend du verbe est une
  // réponse que le client finit par lire de deux façons.
  const p = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { country: 'ca' } });
  assert.deepStrictEqual(Object.keys(p.corps).sort(), Object.keys(r.corps).sort());
});
await test('les statistiques sont lues, jamais écrites par le client', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { stats: { kills: 9999 }, name: 'Zoe' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.stats.kills, 0, 'le client a tenté d\'écrire ses kills');
});

console.log('Modification du profil');
await test('changer de pseudo met à jour le nom et sa clé', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'René' } });
  assert.strictEqual(r.corps.name, 'René');
  assert.strictEqual(db.users[0].name_key, C.nameKey('Rene'));
});
await test('un pseudo déjà pris par un autre est refusé en 409', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  await appel(app, { token: 'ok:u2:Zoe' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u2:Zoe', body: { name: 'LOIC' } });
  assert.strictEqual(r.code, 409, 'les accents et la casse ne doivent pas ouvrir une porte');
});
await test('reprendre son propre pseudo n\'est pas un conflit', async () => {
  const db = fakeDb(), app = appDe(db);
  await appel(app, { token: 'ok:u1:Loic' });
  const r = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'loic' } });
  assert.strictEqual(r.code, 200);
});
await test('un corps illisible ou trop gros ne fait pas tomber le serveur', async () => {
  const app = appDe(fakeDb());
  await appel(app, { token: 'ok:u1:Loic' });
  const a = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: '{ pas du json' });
  assert.strictEqual(a.code, 400);
  const b = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'x'.repeat(10_000) } });
  assert.ok(b.code === 400, `attendu 400, recu ${b.code}`);
});
await test('une méthode non prévue est refusée', async () => {
  const r = await appel(appDe(fakeDb()), { method: 'DELETE', token: 'ok:u1:Loic' });
  assert.strictEqual(r.code, 405);
});
await test('une route inconnue ne révèle rien', async () => {
  const r = await appel(appDe(fakeDb()), { path: '/api/admin', token: 'ok:u1:Loic' });
  assert.strictEqual(r.code, 404);
});

console.log('Limitation de débit');
await test('le martèlement d\'un pseudo est freiné', async () => {
  const app = appDe(fakeDb(), { limiter: makeLimiter({ max: 3, windowMs: 60_000 }) });
  await appel(app, { token: 'ok:u1:Loic' });
  const codes = [];
  for (let i = 0; i < 5; i++)
    codes.push((await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'Nom' + i } })).code);
  assert.strictEqual(codes.filter(c => c === 429).length, 2, codes.join(','));
});
await test('GET /api/me A SON PROPRE SEAU, PARCE QU\'ELLE ÉCRIT', async () => {
  // La route la plus chère à servir était la seule sans compteur : le contrôle de débit était placé
  // APRÈS la branche `GET`, si bien que seuls PATCH et les quatre routes de partie en avaient un.
  // Or `findOrCreate` ouvre une transaction d'ÉCRITURE — verrou `for update` sur la ligne `users`,
  // deux soldes et trois agrégats, du `begin` au `commit` — et elle retient tout ce temps un client
  // du bassin de dix connexions. Un seul onglet qui martèle un GET sans corps pouvait donc mettre en
  // file le `POST .../renounce` d'un AUTRE joueur au-delà de sa fenêtre de dix secondes : sa mise
  // restait au séquestre, et le jeu lui avait déjà affiché « LEAVE · REFUND STAKE ».
  const app = appDe(fakeDb(), { limiterMe: makeLimiter({ max: 3, windowMs: 60_000 }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await appel(app, { token: 'ok:u1:Loic' })).code);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429], codes.join(','));
  // ET LES SEAUX NE SE MANGENT PAS L'UN L'AUTRE, exactement comme `match:`, `trace:` et `result:`.
  // Le seau des écritures de profil est intact : lire son profil ne doit pas empêcher de le
  // changer, ni l'inverse.
  const patch = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'Neuf' } });
  assert.strictEqual(patch.code, 200, JSON.stringify(patch.corps));
  // Et celui d'un AUTRE joueur non plus : la clé porte son `authId`.
  assert.strictEqual((await appel(app, { token: 'ok:u2:Autre' })).code, 200);
});
await test('le seau de lecture est SÉPARÉ de celui des écritures, et il est plus large', async () => {
  // Deux seaux, deux compteurs. Le jeu appelle `Auth.sync()` à la connexion, à la reprise de
  // session, après chaque renoncement et après chaque règlement : douze par minute serait jouable
  // mais serré, et refuser une lecture de profil légitime coûte un écran de solde faux.
  const db = fakeDb();
  const app = appDe(db, { limiter: makeLimiter({ max: 1, windowMs: 60_000 }),
                          limiterMe: makeLimiter({ max: 4, windowMs: 60_000 }) });
  for (let i = 0; i < 4; i++)
    assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).code, 200, 'lecture ' + i);
  assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).code, 429);
  // Le seau d'écriture n'a servi à rien pendant ces cinq lectures : il lui reste son unique jeton.
  assert.strictEqual((await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { country: 'FR' } })).code, 200);
  assert.strictEqual((await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { country: 'BE' } })).code, 429);
  // Le seau par défaut du routeur est plus large que celui des écritures : c'est écrit dans
  // `createApp`, et ce test le CONSTATE plutôt que de faire confiance au commentaire.
  const large = appDe(fakeDb());
  const codes = [];
  for (let i = 0; i < 13; i++) codes.push((await appel(large, { token: 'ok:u1:Loic' })).code);
  assert.ok(!codes.includes(429), 'douze lectures de profil d\'affilée doivent passer : ' + codes.join(','));
});
await test('le seau se vide avec le temps', () => {
  let t = 0;
  const allow = makeLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.ok(allow('a') && allow('a') && !allow('a'));
  t = 1500;
  assert.ok(allow('a'), 'après la fenêtre, on doit pouvoir réessayer');
});
await test('le seau d\'un joueur ne freine pas celui d\'un autre', () => {
  const allow = makeLimiter({ max: 1, windowMs: 1000 });
  assert.ok(allow('a')); assert.ok(!allow('a')); assert.ok(allow('b'));
});

console.log('CORS');
await test('une origine inconnue ne reçoit aucun en-tête d\'autorisation', async () => {
  const r = await appel(appDe(fakeDb()), { token: 'ok:u1:Loic', origin: 'https://pirate.example' });
  assert.strictEqual(r.head['access-control-allow-origin'], undefined);
});
await test('l\'origine du jeu est autorisée nommément, jamais par une étoile', async () => {
  const r = await appel(appDe(fakeDb()), { token: 'ok:u1:Loic' });
  assert.strictEqual(r.head['access-control-allow-origin'], ORIGINE);
  assert.strictEqual(r.head['vary'], 'Origin');
});
await test('le pré-vol répond sans exposer la route aux inconnus', async () => {
  const app = appDe(fakeDb());
  const ok = await appel(app, { method: 'OPTIONS' });
  assert.strictEqual(ok.code, 204);
  assert.strictEqual(ok.head['access-control-allow-origin'], ORIGINE);
  const non = await appel(app, { method: 'OPTIONS', origin: 'https://pirate.example' });
  assert.strictEqual(non.head['access-control-allow-origin'], undefined);
});

console.log('Le billet de partie');
test('un mode inconnu est refusé, et le message dit lesquels existent', () => {
  const { erreurs, champs } = checkMatch({ ...DEMANDE, mode: 'battleroyale' });
  assert.strictEqual(champs, null);
  assert.ok(erreurs.some(e => e.includes('Mode inconnu') && e.includes('resurgence')), erreurs.join(' | '));
});
test('un mode hérité du prototype ne passe pas pour un mode connu', () => {
  // `MODES['constructor']` rend une fonction, donc une valeur vraie : c'est le genre de mode
  // inventé qu'une lecture directe laisserait entrer.
  for (const faux of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.ok(checkMatch({ ...DEMANDE, mode: faux }).erreurs.length, faux);
});
test('une mise absente des tables est refusée, avec les mises possibles', () => {
  for (const mise of [0.51, 0, -1, 100, 'gratuit', null, undefined, NaN, Infinity]) {
    const { erreurs } = checkMatch({ ...DEMANDE, stake: mise });
    assert.ok(erreurs.some(e => e.includes('Mise inconnue')), `${mise} : ${erreurs.join(' | ')}`);
  }
  assert.deepStrictEqual(checkMatch({ ...DEMANDE, stake: 10 }).erreurs, []);
});
test('checkMatch délègue la recherche de table à WBCore.tierFor', () => {
  // L'API recopiait le corps de `tierFor` — `TIERS.find(t => t.stake === mise)`. Comparer le
  // résultat à `C.TIERS` ne prouverait rien : c'est la FONCTION qu'on ne veut pas voir recopiée,
  // parce que le jour où la recherche de table change, le lobby affichera une table que le serveur
  // refusera, sans un mot au joueur.
  for (const mise of [...C.TIERS.map(t => t.stake), 0, 7, -1, NaN, '10', 'abc', Infinity, null])
    assert.strictEqual(
      checkMatch({ ...DEMANDE, stake: mise }).erreurs.some(e => e.includes('Mise inconnue')),
      C.tierFor(Number(mise)) === null,
      String(mise));
});
test('un brawler inconnu est refusé', () => {
  assert.ok(checkMatch({ ...DEMANDE, brawler: 'godzilla' }).erreurs.some(e => e.includes('Brawler inconnu')));
  assert.deepStrictEqual(checkMatch({ ...DEMANDE, brawler: 'bolt' }).erreurs, []);
});
test('sans clé d\'idempotence, la demande est refusée', () => {
  for (const cle of [undefined, '', '   ', 42, {}, 'x'.repeat(65)])
    assert.ok(checkMatch({ ...DEMANDE, clientKey: cle }).erreurs.some(e => e.includes('clientKey')), String(cle));
});
test('une demande valide ressort en centimes entiers, avec les sièges de WBCore', () => {
  const { champs, erreurs } = checkMatch(DEMANDE);
  assert.deepStrictEqual(erreurs, []);
  assert.strictEqual(champs.stakeCents, 50);
  assert.ok(Number.isInteger(champs.stakeCents));
  assert.strictEqual(champs.seats, C.seatsOf(C.MODES.solo));
  assert.strictEqual(champs.mode.id, 'solo');
});

await test('sans jeton, rien n\'est écrit : le refus vient avant la base', async () => {
  const { db, app, tires } = bancDeBillet();
  const r = await demander(app, DEMANDE, { token: undefined });
  assert.strictEqual(r.code, 401);
  assert.strictEqual(db.matches.length, 0, 'un inconnu ne doit pas ouvrir de billet');
  assert.strictEqual(tires(), 0, 'ni faire tirer une graine');
});
await test('le billet livre la graine publique, jamais la secrète', async () => {
  const { db, app, tires, tiresSecret } = bancDeBillet();
  const r = await demander(app);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.seed, GRAINES[0]);
  assert.strictEqual(db.matches[0].seed_public, GRAINES[0]);
  // 128 BITS, EN HEXADÉCIMAL. `between 0 and 4294967295` rendait une graine « secrète » trouvable
  // par force brute hors ligne, et une colonne qui porte un nom qui ment est pire que pas de
  // colonne. Elle ne protège toujours rien dans cette phase — la simulation ne l'utilise pas — mais
  // elle ne prétend plus le contraire.
  assert.strictEqual(db.matches[0].seed_secret, SECRETS[0]);
  assert.match(db.matches[0].seed_secret, /^[0-9a-f]{32}$/);
  assert.strictEqual(tires(), 1, 'une graine publique par billet, et une seule');
  assert.strictEqual(tiresSecret(), 1, 'un secret par billet, et un seul');
  const texte = JSON.stringify(r.corps);
  assert.ok(!texte.includes(SECRETS[0]), 'la graine secrète a fui : ' + texte);
  assert.ok(!/secret/i.test(texte), texte);
  assert.deepStrictEqual(Object.keys(r.corps).sort(),
    ['balanceCents', 'brawler', 'expiresAt', 'id', 'mode', 'openedAt', 'quarantineCents', 'repris',
     'seats', 'teamSize', 'seed', 'stakeCents', 'status'].sort());
  // `repris` PART AVEC LE BILLET, ET IL EST FAUX À L'OUVERTURE. Le jeu ne peut pas le déduire : un
  // billet repris porte l'heure d'ouverture d'un sas précédent, donc le bouton QUITTER promettrait
  // sur un chronomètre qui ne mesure pas l'âge de ce billet-là. Le serveur, lui, le sait déjà.
  assert.strictEqual(r.corps.repris, false);
  // LES DEUX MONTANTS PARTENT AVEC LE BILLET, APRÈS LE DÉBIT : un aller-retour de moins pour le
  // jeu, et c'est la parole du serveur plutôt qu'une soustraction faite dans le navigateur.
  assert.strictEqual(r.corps.balanceCents, L.DOTATION_CENTS - r.corps.stakeCents);
  assert.strictEqual(r.corps.quarantineCents, 0);
});
await test('une graine, des sièges, un montant envoyés par le client sont sans effet', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, {
    ...DEMANDE, seed: 7, seats: 999, stakeCents: 1, stake_cents: 1, payout_cents: 999999,
    user_id: 42, status: 'settled',
  });
  assert.strictEqual(r.corps.seed, GRAINES[0], 'la graine vient de la source du serveur');
  assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES.solo));
  const ligne = db.matches[0];
  assert.strictEqual(ligne.seed_public, GRAINES[0]);
  assert.strictEqual(ligne.seats, C.seatsOf(C.MODES.solo));
  assert.strictEqual(ligne.stake_cents, 50);
  assert.strictEqual(ligne.status, 'open');
  assert.strictEqual(ligne.user_id, db.users[0].id, 'l\'utilisateur vient du jeton, pas du corps');
});
await test('un corps chargé écrit exactement la même ligne qu\'un corps minimal', async () => {
  // Le patron déjà éprouvé sur PATCH /api/me : c'est la formulation mécanique de « aucun montant,
  // aucune graine, aucun statut ne vient du client ». Deux bancs, mêmes horloge et mêmes graines,
  // même clé du client : les deux lignes doivent être indiscernables.
  const nu = bancDeBillet(), charge = bancDeBillet();
  const a = await demander(nu.app, DEMANDE);
  const b = await demander(charge.app, {
    ...DEMANDE, seed: 1, seed_public: 2, seed_secret: 3, seats: 999, stake: 0.5, stake_cents: 999,
    payout_cents: 999, user_id: 999, status: 'settled', opened_at: 0, expires_at: '2099-01-01T00:00:00Z',
    id: 999,
    // `paid_seats` rejoint la liste : c'est le même patron, étendu d'une colonne. Écrite par le
    // serveur, figée à l'ouverture, et un corps qui annonce sept sièges payés laisse la ligne
    // strictement identique à celle d'un corps minimal.
    paidSeats: 7, paid_seats: 7, paidseats: 7,
  });
  assert.deepStrictEqual(charge.db.matches, nu.db.matches);
  assert.deepStrictEqual(b.corps, a.corps);
  // Et la valeur écrite est UN, pas la moyenne de ce que le client proposait : un billet EST une
  // table tant qu'il n'existe pas d'identifiant de table partagée.
  assert.strictEqual(nu.db.matches[0].paid_seats, 1);
  // Elle ne part pas au client non plus. Il n'en a rien à faire, et la lui donner l'inviterait à la
  // renvoyer — exactement ce qu'on refuse à `sim_version`.
  assert.ok(!/paidSeats|paid_seats/i.test(JSON.stringify(a.corps)), JSON.stringify(a.corps));
});
// `repris` est le SEUL champ par lequel un rejeu se distingue du premier appel, et c'est une
// exception écrite : il ne décrit pas le billet mais le CHEMIN qui l'a servi, et le jeu en a besoin
// pour savoir que l'heure d'ouverture qu'il tient est celle d'un sas PRÉCÉDENT. Tout le reste de la
// réponse doit rester indiscernable, et c'est ce que ce raccourci compare.
const sansRepris = corps => { const { repris, ...reste } = corps; return reste; };
await test('deux demandes d\'affilée rendent le même billet', async () => {
  const { db, app } = bancDeBillet();
  const un = await demander(app);
  const deux = await demander(app, { ...DEMANDE, clientKey: 'cle-2', mode: 'trio', stake: 10 });
  assert.strictEqual(deux.code, 200, 'un billet déjà ouvert n\'est pas une erreur, sinon un onglet fermé enferme le joueur');
  assert.deepStrictEqual(sansRepris(deux.corps), sansRepris(un.corps),
    'le billet ouvert est rendu tel quel, mode et mise compris');
  assert.strictEqual(un.corps.repris, false, 'le premier appel ouvre : il ne reprend rien');
  assert.strictEqual(deux.corps.repris, true, 'le second REPREND, et le jeu doit l\'apprendre');
  assert.strictEqual(db.matches.length, 1);
});
await test('la même clé rejouée rend la même réponse et n\'écrit pas de seconde ligne', async () => {
  const { db, app } = bancDeBillet();
  const un = await demander(app);
  const rejeu = await demander(app);
  assert.deepStrictEqual(sansRepris(rejeu.corps), sansRepris(un.corps));
  assert.strictEqual(rejeu.corps.repris, true, 'un rejeu de clé reprend le billet déjà ouvert');
  assert.strictEqual(db.matches.length, 1);
});
await test('après expiration, une nouvelle demande rend un nouveau billet et une autre graine', async () => {
  const { db, app, horloge } = bancDeBillet();
  const un = await demander(app);
  horloge.t = Date.parse(un.corps.expiresAt) + 1;
  const deux = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.notStrictEqual(deux.corps.id, un.corps.id);
  assert.notStrictEqual(deux.corps.seed, un.corps.seed);
  assert.strictEqual(db.matches.length, 2);
  assert.strictEqual(db.matches[0].status, 'expired', 'le billet périmé libère la place');
  // En revanche la clé du premier appel, elle, rend toujours ce qu'elle a rendu la première fois :
  // une demande rejouée à l'identique doit toujours donner la même réponse. Une nouvelle tentative
  // tire une nouvelle clé, c'est ce qui les distingue.
  const vieux = await demander(app);
  assert.strictEqual(vieux.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 2);
});
await test('une clé absorbée par un billet ouvert n\'écrit rien, et rouvre après expiration', async () => {
  // La limite connue de ce montage, écrite comme un test plutôt que passée sous silence. Une clé
  // qui arrive pendant qu'un billet est déjà ouvert ne laisse aucune ligne : elle reçoit le billet
  // en cours. Rejouée APRÈS l'expiration de celui-ci, elle en ouvre donc un nouveau. L'idempotence
  // est totale tant que le billet est ouvert — c'est-à-dire pendant toute la fenêtre où une réponse
  // perdue peut être rejouée — et pas au-delà.
  const { db, app, horloge } = bancDeBillet();
  const un = await demander(app, { ...DEMANDE, clientKey: 'cle-1' });
  const absorbee = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.strictEqual(absorbee.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 1, 'la clé absorbée ne laisse aucune ligne');
  horloge.t = Date.parse(un.corps.expiresAt) + 1;
  const apres = await demander(app, { ...DEMANDE, clientKey: 'cle-2' });
  assert.notStrictEqual(apres.corps.id, un.corps.id);
  assert.strictEqual(db.matches.length, 2);
});
await test('la mise d\'une table à 0,50 $ est stockée 50, en entier', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, { ...DEMANDE, stake: 0.5 });
  assert.strictEqual(db.matches[0].stake_cents, 50);
  assert.strictEqual(r.corps.stakeCents, 50);
  for (const t of C.TIERS) {
    const banc = bancDeBillet();
    const x = await demander(banc.app, { ...DEMANDE, stake: t.stake });
    assert.strictEqual(x.corps.stakeCents, C.toCents(t.stake), String(t.stake));
    assert.ok(Number.isInteger(x.corps.stakeCents));
  }
});
await test('les sièges du billet sont ceux de WBCore, mode par mode', async () => {
  for (const id of Object.keys(C.MODES)) {
    const { db, app } = bancDeBillet();
    const r = await demander(app, { ...DEMANDE, mode: id });
    assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES[id]), id);
    assert.strictEqual(db.matches[0].seats, C.seatsOf(C.MODES[id]), id);
    assert.strictEqual(db.matches[0].mode, id);
  }
});
await test('l\'expiration part avec le billet, et couvre le sas et tout le plan de zone', async () => {
  const { app } = bancDeBillet();
  const r = await demander(app);
  const gaz = C.zoneTotalS(C.zonePlan(GRAINES[0], C.MODES.solo));
  assert.strictEqual(Date.parse(r.corps.openedAt), T0);
  assert.strictEqual(Date.parse(r.corps.expiresAt) - T0, (C.LOBBY.wait + gaz + MATCH_MARGE_S) * 1000);
  assert.ok(Date.parse(r.corps.expiresAt) - T0 > (C.LOBBY.wait + gaz) * 1000,
    'une partie que personne ne gagne doit tenir dans le billet');
  // Elle est calculée sur le plan de ce mode-là, pas sur un délai rond : le gaz rapide de
  // Resurgence raccourcit le billet d'autant.
  const rapide = bancDeBillet();
  const q = await demander(rapide.app, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(
    (Date.parse(r.corps.expiresAt) - Date.parse(q.corps.expiresAt)) / 1000,
    gaz - C.zoneTotalS(C.zonePlan(GRAINES[0], C.MODES.resurgence)));
});
await test('la limitation de débit couvre la route qui écrit, sans bloquer le profil', async () => {
  const { db, app } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await demander(app, { ...DEMANDE, clientKey: 'cle-' + i })).code);
  assert.deepStrictEqual(codes, [200, 200, 429, 429], codes.join(','));
  assert.strictEqual(db.matches.length, 1);
  // Deux seaux distincts : renommer son personnage ne doit pas empêcher de jouer.
  const p = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: 'Zoe' } });
  assert.strictEqual(p.code, 200);
});
await test('le pré-vol annonce désormais POST', async () => {
  const { app } = bancDeBillet();
  const r = await appel(app, { method: 'OPTIONS' });
  const methodes = String(r.head['access-control-allow-methods']).split(',');
  assert.ok(methodes.includes('POST'), r.head['access-control-allow-methods']);
  for (const m of ['GET', 'PATCH', 'OPTIONS']) assert.ok(methodes.includes(m), m);
});
await test('la route du billet n\'accepte que POST', async () => {
  const { app } = bancDeBillet();
  for (const m of ['GET', 'PATCH', 'DELETE']) {
    const r = await appel(app, { method: m, path: '/api/match', token: 'ok:u1:Loic' });
    assert.strictEqual(r.code, 405, m);
  }
});
await test('une graine rendue en chaîne par la base ressort en nombre', async () => {
  // Le pilote Postgres rend les colonnes `bigint` sous forme de CHAÎNE. Une graine en chaîne est
  // refusée par `seedFor`, qui repartirait sur la graine locale : le joueur verrait une autre
  // carte que celle de son billet, sans le moindre message. La doublure imite donc ici le pilote,
  // et pas l'idée qu'on s'en fait.
  const db = fakeDb();
  const brute = db.createMatch;
  db.createMatch = async m => {
    const { match, repris } = await brute(m);
    return { match: { ...match, id: String(match.id), seed_public: String(match.seed_public) }, repris };
  };
  const app = appDe(db, { randomSeed: () => GRAINES[0], now: () => T0 });
  const r = await demander(app);
  assert.strictEqual(typeof r.corps.seed, 'number');
  assert.strictEqual(r.corps.seed, GRAINES[0]);
  assert.strictEqual(C.seedFor(r.corps, 'graine de secours'), GRAINES[0]);
});
await test('sans source injectée, la graine tirée par défaut est acceptée par le jeu', async () => {
  // La source par défaut est celle du système, et elle n'est pas couverte par les tests qui
  // l'injectent. Le contrat qu'elle doit tenir est celui de `WBCore.seedFor` : hors du domaine des
  // entiers 32 bits non signés, le jeu repartirait sur sa propre graine sans rien dire.
  const db = fakeDb();
  const app = createApp({ db, verifyToken: verifOk, origins: [ORIGINE] });
  const r = await demander(app);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(C.seedFor(r.corps, 'graine de secours'), r.corps.seed);
});
await test('une source de graines hors du domaine de makeRng fait échouer, elle n\'écrit pas', async () => {
  // Une graine flottante, négative ou au-delà de 32 bits serait refusée par `seedFor` côté client :
  // le jeu repartirait sur sa propre graine sans que personne ne le remarque, et la ligne en base
  // décrirait une partie que le joueur n'a pas jouée. Mieux vaut un 500 bruyant.
  for (const mauvaise of [0.5, -1, 2 ** 32, NaN, '7', null]) {
    const { db, app } = bancDeBillet({ randomSeed: () => mauvaise });
    const r = await demander(app);
    assert.strictEqual(r.code, 500, String(mauvaise));
    assert.strictEqual(db.matches.length, 0, String(mauvaise));
  }
});
await test('un corps illisible sur le billet ne fait pas tomber le serveur', async () => {
  const { db, app } = bancDeBillet();
  const r = await demander(app, '{ pas du json');
  assert.strictEqual(r.code, 400);
  assert.strictEqual(db.matches.length, 0);
});
test('aucune colonne solde, et aucun montant déjà écrit n\'est mis à jour', () => {
  // Garde textuelle : la doublure de test ne peut pas prouver ce que fait Postgres, mais elle peut
  // prouver ce qu'on lui a écrit. Les commentaires sont retirés d'abord — ils parlent justement de
  // l'absence de colonne solde.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  // Les commentaires de `db-pg.js` citent eux aussi des morceaux de requête entre accents graves :
  // sans les retirer, la garde finirait par prendre un commentaire pour une écriture — et un
  // commentaire est toujours d'accord avec ce qu'on veut lui faire dire.
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.ok(!/\b(solde|balance|wallet)\b/i.test(sql), 'une colonne de solde est apparue dans le schéma');
  // Chaque requête est UN littéral entre accents graves : on découpe là-dessus plutôt que de
  // balayer le fichier au jugé. Une plage qui court d'une requête à la suivante avale les
  // commentaires qui les séparent, et un commentaire citant la bonne clause suffit alors à faire
  // passer une requête qui ne la porte plus. C'est exactement ce qui est arrivé en écrivant ce
  // test : la garde disait vert sur une écriture de montant sans aucune protection.
  const requetes = (pg.match(/`[^`]*`/g) || []).filter(q => /update\s+matches\s+set/i.test(q));
  assert.ok(requetes.length >= 2, `seulement ${requetes.length} écritures retrouvées dans db-pg.js`);
  for (const u of requetes) {
    // Aucune écriture de cette table ne touche une ligne déjà close : `status = 'open'` figure
    // dans toutes les clauses, y compris celles du veilleur, sans exception.
    assert.match(u, /status\s*=\s*'open'/, 'une écriture peut toucher une ligne close : ' + u);
    if (!/_cents/.test(u)) continue;
    // Et un `update` qui écrit un MONTANT est autorisé à une condition de plus : qu'il ne puisse
    // écrire que sur une ligne qui n'en porte aucun. C'est ce qui fait de `matches` une table en
    // insertion puis règlement unique — un montant déjà écrit n'est jamais réécrit.
    assert.match(u, /net_cents\s+is\s+null/, 'un montant est écrit sans exiger une ligne vierge : ' + u);
  }
});
test('les colonnes en centimes sont entières et positives, sauf l\'écart qui est une mesure', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const colonnes = sql.match(/^[ \t]*\w*_cents\b.*$/gm) || [];
  assert.ok(colonnes.length >= 6, `le schéma ne porte que ${colonnes.length} colonnes en centimes`);
  for (const c of colonnes) {
    assert.match(c, /\binteger\b/, c);
    // `ecart_cents` est la seule exception, et elle est nommée plutôt que tolérée par un motif
    // large : ce n'est pas de l'argent dû, c'est la différence entre ce que le client annonce et
    // ce que le serveur compte. Elle peut être négative, et cette mesure-là compte autant.
    if (/^\s*ecart_cents\b/.test(c)) { assert.ok(!/check/.test(c), c); continue; }
    assert.match(c, /check\s*\(\s*\w+_cents\s*>=?\s*0\s*\)/, c);
  }
});

console.log('Le verdict rendu par la route');
// Un rapport de fin de partie complet. `reportFrom` est la seule porte côté client : l'écrire à la
// main ici ferait deux idées du contrat, et c'est toujours la deuxième qui ment.
const RAPPORT = (extra = {}) => C.reportFrom({
  seconds: 60, kills: 0, deaths: 1, rank: 5, cubes: 0, damage: 0,
  cashedOut: false, purseCents: 0, declaredNetCents: 0, ...extra,
});
// L'instant auquel un rapport HONNÊTE arrive : le sas, la partie, et trois secondes de réseau.
const ARRIVEE = r => T0 + (C.LOBBY.wait + r.seconds + 3) * 1000;
// Le solde d'un compte, lu sur les écritures et jamais sur une colonne. `soldeDe` et `reconcilier`
// vivent plus bas dans ce fichier, avec le grand livre ; ces tests-ci en ont besoin plus tôt, et
// une somme sur des lignes-transfert tient en une ligne.
const soldeLu = (db, compte) => db.ledger.reduce((n, l) =>
  n + (l.compte_credit === compte ? l.montant_cents : 0)
    - (l.compte_debit === compte ? l.montant_cents : 0), 0);
const rendre = (app, id, rapport, opts = {}) =>
  appel(app, { method: 'POST', path: `/api/match/${id}/result`, token: 'ok:u1:Loic', body: rapport, ...opts });
const CLES_REGLEMENT = ['matchId', 'status', 'issue', 'controle', 'motif', 'grossCents', 'feeCents',
                        'netCents', 'purseCents', 'declaredNetCents', 'ecartCents', 'settledAt',
                        'traceSteps', 'digestMatch', 'divergenceStep', 'replayMs'];

// ---------- DE QUOI JOUER UNE VRAIE PARTIE, ET LA FAIRE JUGER ----------
// Depuis le module 7 la route ne croit plus aucun fait déclaré : elle rejoue. Un rapport écrit à la
// main ne prouve donc plus rien de ce qu'il prétendait prouver, et ces tests doivent JOUER — avec le
// même bloc `WBSim` que le serveur rejouera — puis envoyer la trace de ce qu'ils ont joué.
//
// Le pilote est une conduite de JOUEUR et rien d'autre : il ne décide d'aucune règle, il produit les
// six nombres et les deux booléens que `lireEntrees` lit sur la souris et les sticks.
function pilote(G) {
  const p = G.player, portee = p.brawler.attack.range;
  if (!p.alive) return { mx: 0, mz: 0, ax: p.ax, az: p.az, aimDist: portee, feu: false, sup: false };
  let cible = null, bd = 1e9;
  for (const e of G.ents) {
    if (e === p || !e.alive || e.team === p.team) continue;
    const d = C.dist(e.x - p.x, e.z - p.z);
    if (d < bd && SIM.canSee(G, p, e)) { bd = d; cible = e; }
  }
  let ax = p.ax, az = p.az, mx = 0, mz = 0, feu = false, sup = false, aimDist = portee;
  if (cible) {
    ax = (cible.x - p.x) / bd; az = (cible.z - p.z) / bd;
    aimDist = Math.min(bd, portee);
    feu = bd < portee;
    sup = p.super >= p.brawler.super.cost;
    if (bd > portee * 0.6) { mx = ax; mz = az; } else { mx = -az; mz = ax; }
  } else {
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    if (d > 2) { mx = dx / d; mz = dz / d; ax = mx; az = mz; }
  }
  if (!SIM.inZone(G, p.x, p.z, 1.5)) {
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    mx = dx / d; mz = dz / d;
  }
  if ((mx || mz) && !SIM.free(G, p.x + mx * 0.9, p.z + mz * 0.9)) {
    const s = (p.eid % 2) ? 1 : -1;
    if (SIM.free(G, p.x - mz * s * 0.9, p.z + mx * s * 0.9)) { const t = mx; mx = -mz * s; mz = t * s; }
    else { const t = mx; mx = mz * s; mz = -t * s; }
  }
  return { mx, mz, ax, az, aimDist, feu, sup };
}
// Une partie entière, jouée exactement comme le jeu la joue : l'entrée est QUANTIFIÉE À LA SOURCE
// (`traceQuant`), le jeu joue celle-là, et la trace porte le même entier — c'est ce qui rend le
// rejeu exact par construction et non par tolérance. Les actions ponctuelles — le super,
// l'encaissement — partent entre deux pas, comme dans le jeu, et sont notées comme des jetons.
//
// `encaisser` pose le jeton d'encaissement au pas demandé. C'est la seule sortie GAGNANTE qu'un
// pilote de test puisse produire à coup sûr : gagner une partie contre dix-neuf bots ne se commande
// pas, et un test qui dépendrait de cette chance-là finirait par tomber tout seul.
const PARTIES = new Map();
function jouerPartie(o) {
  const cle = JSON.stringify(o);
  if (PARTIES.has(cle)) return PARTIES.get(cle);
  const { graine, mode = 'solo', miseCents = 50, brawler = BRAWLER, encaisser = -1, pasMax = 0,
          rallonge = 0, encaisserSiRiche = false } = o;
  const cfg = C.MODES[mode];
  const maxPas = C.traceMaxSteps(C.zonePlan(graine, cfg));
  const demande = rallonge ? encaisser + rallonge : pasMax;
  // `encaisser`, `pasMax` et `rallonge` se comptent en pas de SIMULATION — ceux que `G.pas` mesure
  // — et pas en tours de boucle : le compte à rebours d'intro, posé par `newMatch`, consomme ses
  // pas sans rien faire avancer, exactement comme dans le navigateur. Les compter dans ces bornes
  // décalerait tous les tests de deux cent quarante pas sans que personne ne le voie.
  const borne = (demande > 0 ? Math.min(demande + PAS_INTRO, maxPas) : maxPas);
  const rec = C.traceEnregistreur(maxPas);
  const G = SIM.newMatch(graine, cfg, miseCents, C.BRAWLERS[brawler]);
  let pas = 0;
  while (pas < borne && !G.fin) {
    // `rallonge` note le jeton d'encaissement dans la trace SANS sortir de la partie, et continue
    // de jouer. C'est la trace d'un client qui rallonge la sienne après avoir encaissé : le serveur
    // doit s'arrêter au jeton, pas au bout du fichier.
    if (G.pas === encaisser) {
      rec.acte(C.TRACE.ENC, 0);
      if (!rallonge) { SIM.doCashOut(G); if (G.fin) break; }
    }
    // ENCAISSER DÈS QU'ON EST PLUS RICHE QUE SA MISE, et pas à un pas fixe. Le pas fixe tombait
    // avant l'expiration de `CASHOUT.lock` dès que le joueur avait pris un coup, si bien que la
    // seule sortie gagnante du fichier partait avec exactement sa propre mise en poche — rien ne
    // distinguait alors « la sacoche que le rejeu trouve » de « la mise inscrite sur le billet ».
    if (encaisserSiRiche && G.player.alive && G.player.pouch > C.fromCents(miseCents)
        && C.cashoutReady(G.player.cashLock || 0)) {
      rec.acte(C.TRACE.ENC, 0);
      SIM.doCashOut(G);
      if (G.fin) break;
    }
    const brut = pilote(G);
    if (brut.sup && G.player.alive) {
      const mots = C.traceViseeMots(brut.ax, brut.az, brut.aimDist), v = C.traceVisee(mots);
      rec.acte(C.TRACE.SUP, mots);
      // La visée se repose sur le brawler avant l'action, exactement comme `appliquerActe` la
      // repose au rejeu : sans cela l'action partirait dans la direction du pas précédent.
      G.player.ax = v.ax; G.player.az = v.az;
      SIM.useSuper(G, G.player, v.dist);
    }
    rec.ajouter(C.traceMots(brut));
    SIM.step(G, C.traceQuant(brut));
    pas++;
  }
  // Le rapport, construit exactement comme `endMatch` le construit : les faits viennent de SIM, le
  // net annoncé et les condensés viennent du côté qui les a vus.
  const gagne = !!(G.fin && G.fin.gagne);
  const r = {
    G, pas, segments: rec.segments(), terminal: SIM.terminal(G),
    rapport: C.reportFrom({
      ...SIM.faits(G),
      declaredNetCents: gagne ? C.toCents(C.cashoutPayout(G.player.pouch).net) : 0,
      digests: C.digestsEncode(G.empreintes),
    }),
  };
  PARTIES.set(cle, r);
  return r;
}
// La partie que DÉCRIT un billet : sa graine, son mode, sa mise, son brawler. Rien n'est choisi ici,
// tout vient de la ligne que le serveur a écrite.
const partieDe = (b, opts = {}) => jouerPartie({
  graine: b.corps.seed, mode: b.corps.mode, miseCents: b.corps.stakeCents,
  brawler: b.corps.brawler,
  ...(opts.encaisser === undefined ? {} : { encaisser: opts.encaisser }),
  ...(opts.pasMax === undefined ? {} : { pasMax: opts.pasMax }),
  ...(opts.rallonge === undefined ? {} : { rallonge: opts.rallonge }),
  // Le cache `PARTIES` est clé sur les options : une option oubliée ici rendrait la partie d'une
  // AUTRE configuration, en silence.
  ...(opts.encaisserSiRiche === undefined ? {} : { encaisserSiRiche: opts.encaisserSiRiche }),
});
const poserTrace = async (app, id, segments, token = 'ok:u1:Loic') => {
  for (let i = 0; i < segments.length; i++) {
    const r = await appel(app, { method: 'POST', path: `/api/match/${id}/trace`, token,
                                 body: { seq: i, simVersion: SIM.SIM_VERSION, data: segments[i] } });
    assert.strictEqual(r.code, 200, 'la trace du test a été refusée : ' + JSON.stringify(r.corps));
  }
};
// Le chemin complet d'un joueur : un billet, une vraie partie, sa trace, puis son résultat. Les
// tests qui suivent partent tous de là — c'est le seul chemin qui existe encore.
async function jouerEtRendre(app, horloge, b, opts = {}) {
  const p = partieDe(b, opts);
  const token = opts.token || 'ok:u1:Loic';
  if (!opts.sansTrace) await poserTrace(app, b.corps.id, p.segments, token);
  horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000;
  const rep = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                 token, body: opts.corps || p.rapport });
  return { partie: p, rep };
}

await test('LE SERVEUR NE CROIT PLUS AUCUN FAIT DÉCLARÉ : un corps gonflé écrit la même ligne qu\'un corps sincère', async () => {
  // LE TEST CENTRAL DU MODULE, et c'est le patron de la 02a — « un corps portant une graine écrit
  // une ligne identique à celle d'un corps vide » — étendu des PARAMÈTRES aux FAITS. Deux bancs,
  // mêmes graines, même horloge, même trace : d'un côté le rapport que le jeu rendrait, de l'autre
  // le même rapport avec tous ses faits gonflés au maximum plausible. Les deux lignes doivent être
  // indiscernables, parce qu'aucune des deux n'est lue : la ligne vient du rejeu.
  const sincere = bancDeBillet(), menteur = bancDeBillet();
  const a = await demander(sincere.app);
  const b = await demander(menteur.app);
  const p = partieDe(a);
  assert.ok(p.terminal, 'la partie du test doit atteindre un état terminal');

  const gonfle = { ...p.rapport, seconds: 900, kills: 57, deaths: 3, rank: 1, cubes: C.CUBE.max,
                   damage: 999_999, cashedOut: false,
                   purseCents: C.purseBound(a.corps.stakeCents, a.corps.seats).maxCents };
  // Le corps gonflé passe l'analyse et l'enveloppe : ce n'est pas un rapport absurde, c'est un
  // rapport que la 02a aurait accepté mot pour mot — et payé.
  assert.deepStrictEqual(C.checkReport(gonfle).erreurs, []);

  const un = await jouerEtRendre(sincere.app, sincere.horloge, a);
  const deux = await jouerEtRendre(menteur.app, menteur.horloge, b, { corps: gonfle });
  assert.strictEqual(un.rep.code, 200, JSON.stringify(un.rep.corps));
  assert.strictEqual(deux.rep.code, 200, JSON.stringify(deux.rep.corps));
  assert.deepStrictEqual(deux.rep.corps, un.rep.corps, 'le corps gonflé a changé la réponse');
  assert.deepStrictEqual(menteur.db.matches, sincere.db.matches, 'le corps gonflé a changé la ligne');

  // Et ce que la ligne porte est bien ce que le REJEU a trouvé, pas ce que le corps annonçait.
  const ligne = sincere.db.matches[0];
  assert.strictEqual(ligne.kills, p.rapport.kills);
  assert.strictEqual(ligne.rank, p.rapport.rank);
  assert.strictEqual(ligne.purse_cents, p.rapport.purseCents);
  assert.notStrictEqual(ligne.kills, gonfle.kills);
  assert.notStrictEqual(ligne.seconds, gonfle.seconds);
  assert.strictEqual(ligne.trace_steps, p.pas, 'la durée se compte en pas, et le serveur les compte');
  assert.strictEqual(ligne.digest_match, true, 'le rejeu du serveur n\'a pas convergé avec le jeu');
  assert.strictEqual(ligne.divergence_step, null);
  assert.deepStrictEqual(Object.keys(un.rep.corps).sort(), CLES_REGLEMENT.slice().sort());
  assert.ok(!JSON.stringify(un.rep.corps).includes(String(SECRETS[0])), 'la graine secrète a fui');
});
await test('LE DÉCOMPTE D\'INTRO EST REJOUÉ AUSSI : sans lui, digest_match serait faux sur TOUTE partie', async () => {
  // LE DÉFAUT. Le compte à rebours ne vivait que dans le bloc `Game` : `startMatch` posait
  // `G.intro = 3.999` APRÈS `newMatch`, qui rendait `intro: 0`. La trace, elle, enregistre ces pas.
  // Le serveur repartait donc d'un décompte à zéro et rejouait en pas RÉELS les deux cent quarante
  // pas passés à décompter : il jugeait une AUTRE partie. Conséquences pour un joueur honnête et
  // connecté : `digest_match` faux sur toutes ses parties — donc zéro ligne lisible par le grand
  // livre de la phase 03 et cinq agrégats à zéro — et, quand le rejeu n'atteignait pas de terminal,
  // un 409 `non_terminal` et une partie jamais enregistrée. Aucun test ne le voyait : ni celui du
  // jeu ni celui-ci ne posaient jamais `G.intro`, qui vivait hors du bloc SIM.
  assert.ok(SIM.newMatch(4242, C.MODES.solo, 50, C.BRAWLERS[BRAWLER]).intro > 0,
    'newMatch ne pose plus le décompte : le rejeu du serveur rejouerait une autre partie');
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  // La trace porte les pas du décompte, et le serveur les compte comme tels : `trace_steps` les
  // inclut, la durée non — c'est exactement la différence que le décompte fait.
  assert.strictEqual(partie.pas, partie.G.pas + PAS_INTRO, 'la partie du test n\'a pas eu de décompte');
  assert.strictEqual(rep.corps.traceSteps, partie.pas);
  assert.strictEqual(db.matches[0].seconds, partie.rapport.seconds);
  // ET LE REJEU A CONVERGÉ, du premier condensé au dernier. C'est le seul chiffre qui dit que le
  // serveur a rejoué la partie qui s'est affichée, et pas une partie voisine.
  assert.strictEqual(rep.corps.digestMatch, true, 'le rejeu du serveur diverge de la partie du joueur');
  assert.strictEqual(rep.corps.divergenceStep, null);
  assert.strictEqual(db.matches[0].replay_digest, SIM.empreinte(partie.G));
  const siens = C.digestsDecode(partie.rapport.digests);
  assert.ok(siens && siens.length > 3, 'trop peu de condensés pour que la convergence prouve quelque chose');
  assert.strictEqual(C.digestsDiff(partie.G.empreintes, siens), -1);
  // Et la ligne compte, elle : c'est la conséquence directe de la convergence.
  const s = (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;
  assert.strictEqual(s.matches, 1, 'une partie convergée n\'entre pas dans les agrégats');
  assert.strictEqual(s.divergences, 0);
});
await test('L\'EXPLOIT NOMMÉ : prendre un billet, ne jamais jouer, rendre une victoire — vaut ZÉRO', async () => {
  // LE CORPS EXACT QUE LA SPÉCIFICATION NOMME, et il passait mot pour mot en 02a : `RESPAWN` donne
  // un plancher de dix secondes, `LOBBY.wait` plus la marge de victoire rendent cinq secondes
  // d'horloge suffisantes, et mille centimes de sacoche valaient huit cents payés sur une table à
  // 0,50 $. Il n'y a aucune partie derrière : aucune trace n'est arrivée.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const max = C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents;
  assert.strictEqual(max, 1000);
  assert.strictEqual(C.cashoutCents(max).netCents, 800, 'ce que cet exploit rapportait hier');

  const exploit = C.reportFrom({ seconds: 10, kills: 0, deaths: 0, rank: 1, cubes: 0, damage: 0,
                                 cashedOut: false, purseCents: max, declaredNetCents: 800, digests: '' });
  // L'enveloppe de la 02a l'accepte toujours : c'est bien elle qui ne suffisait pas.
  const enveloppe = C.matchVerdict({ mode: 'solo', stakeCents: 50, seats: 20, teamSize: 1,
                                     seed: b.corps.seed, openedAt: b.corps.openedAt,
                                     expiresAt: b.corps.expiresAt },
                                   exploit, T0 + (C.LOBBY.wait + 5) * 1000);
  assert.strictEqual(enveloppe.netCents, 800, 'l\'enveloppe seule paierait encore cet exploit');

  horloge.t = T0 + (C.LOBBY.wait + 5) * 1000;
  const rep = await rendre(app, b.corps.id, exploit);
  assert.strictEqual(rep.code, 409, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.code, 'trace_absente');
  // Aucun montant, nulle part, et la ligne reste ouverte pour le veilleur : ni argent, ni joueur
  // enfermé dans un billet mort.
  for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
    assert.strictEqual(db.matches[0][col], undefined, `l'exploit a écrit ${col}`);
  assert.strictEqual(db.matches[0].status, 'open');
});
await test('UN BILLET NE SERT QU\'UNE TENTATIVE : après un résultat refusé, la graine suivante est AUTRE', async () => {
  // LE DÉFAUT. Depuis que toute la partie est une fonction pure de la graine publique, un billet
  // resservi est le même monde : mêmes caisses, mêmes vingt bots, même plan de gaz. Un joueur qui
  // bloque simplement l'envoi de sa trace obtenait un 409, gardait son billet OUVERT, recliquait
  // sur la table, recevait le MÊME billet — donc la même graine — et rejouait en connaissance de
  // cause le monde qu'il venait d'explorer, autant de fois que la vie du billet le permettait,
  // jusqu'à faire régler sa meilleure tentative. Ce n'est pas l'ESP structurel déjà consigné :
  // c'est une répétition générale gratuite de la partie qu'il va faire payer.
  const { db, app, horloge } = bancDeBillet();
  const TABLE = { ...DEMANDE, mode: 'resurgence', stake: 10 };
  const b1 = await demander(app, { ...TABLE, clientKey: 'cle-A' });
  const p1 = partieDe(b1, { encaisser: 300 });
  horloge.t = Date.parse(b1.corps.openedAt) + (C.LOBBY.wait + p1.rapport.seconds + 3) * 1000;
  const r1 = await appel(app, { method: 'POST', path: `/api/match/${b1.corps.id}/result`,
                                token: 'ok:u1:Loic', body: p1.rapport });
  assert.strictEqual(r1.code, 409, JSON.stringify(r1.corps));
  assert.strictEqual(r1.corps.code, 'trace_absente');
  // La ligne reste ouverte — c'est voulu, la trace peut encore arriver — mais elle est MARQUÉE.
  assert.strictEqual(db.matches[0].status, 'open');
  assert.ok(db.matches[0].first_result_at, 'le billet n\'est pas marqué comme joué');

  // Il reclique sur la même table, avec une clé d'idempotence NEUVE : c'est une nouvelle demande,
  // pas le rejeu d'une ancienne.
  const b2 = await demander(app, { ...TABLE, clientKey: 'cle-B' });
  assert.strictEqual(b2.code, 200, JSON.stringify(b2.corps));
  assert.notStrictEqual(b2.corps.id, b1.corps.id, 'le serveur a resservi le même billet');
  assert.notStrictEqual(b2.corps.seed, b1.corps.seed, 'le serveur a resservi la MÊME graine, donc le même monde');
  // L'ancien est clos SANS MONTANT, comme le veilleur le ferait : on ferme une porte, on n'écrit
  // pas d'argent.
  assert.strictEqual(db.matches[0].status, 'abandoned');
  for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
    assert.strictEqual(db.matches[0][col], undefined, `la clôture a écrit ${col}`);
  assert.strictEqual(db.matches.length, 2);
  // Et le monde n'est vraiment pas le même : deux graines, deux parties.
  const A = SIM.newMatch(b1.corps.seed, C.MODES.resurgence, b1.corps.stakeCents, C.BRAWLERS[BRAWLER]);
  const B = SIM.newMatch(b2.corps.seed, C.MODES.resurgence, b2.corps.stakeCents, C.BRAWLERS[BRAWLER]);
  assert.notStrictEqual(SIM.condenseEtat(A), SIM.condenseEtat(B), 'les deux billets posent le même monde');
  assert.notDeepStrictEqual(A.boxes.map(x => [x.x, x.z]), B.boxes.map(x => [x.x, x.z]),
    'les caisses sont aux mêmes endroits : c\'est le monde qu\'il vient d\'explorer');
});
await test('… et le joueur dont la trace s\'est perdue peut toujours la renvoyer sur le MÊME billet', async () => {
  // La contrepartie, et elle compte autant : la marque ne ferme rien. Un joueur honnête dont le
  // réseau a lâché au mauvais moment renvoie sa trace puis son résultat sur le même `match_id`, et
  // il est réglé. Fermer ici ferait un second endroit qui clôt une ligne, et punirait la panne.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  horloge.t = ARRIVEE(p.rapport);
  const rate = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                  token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(rate.corps.code, 'trace_absente');
  const marque = db.matches[0].first_result_at;
  await poserTrace(app, b.corps.id, p.segments);
  const bon = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                 token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(bon.code, 200, JSON.stringify(bon.corps));
  assert.strictEqual(bon.corps.status, 'settled');
  assert.ok(bon.corps.netCents > 0);
  // La marque ne se repose pas : elle vaut « la première fois », et un résultat renvoyé ne modifie
  // donc jamais la ligne. C'est ce qui garde l'idempotence de cette route totale.
  assert.strictEqual(db.matches[0].first_result_at, marque);
});
await test('LE PAIEMENT SORT DE LA PARTIE REJOUÉE : un encaissement Resurgence, joué pour de bon', async () => {
  // Le seul chemin par lequel un net non nul entre encore en base : une partie réellement jouée qui
  // se termine sur un encaissement. Rien ici n'est déclaré — la sacoche est celle que le rejeu
  // trouve dans la poche du joueur au moment où il sort.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(partie.terminal, 'encaissement');
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'settled');
  assert.strictEqual(rep.corps.issue, 'encaissement');
  // Personne n'est mort de sa main et il n'a rien ramassé : il sort avec exactement sa propre mise.
  // C'est un fait de la partie, pas un nombre choisi par le test.
  assert.strictEqual(rep.corps.purseCents, b.corps.stakeCents);
  assert.strictEqual(rep.corps.grossCents, b.corps.stakeCents);
  assert.ok(rep.corps.netCents > 0);
  assert.ok(rep.corps.feeCents > 0, 'la commission ne tombe jamais à zéro');
  assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents);
  // L'API ne recalcule jamais la commission elle-même : le net sort des fonctions de paiement.
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(rep.corps.purseCents).netCents);
  assert.strictEqual(db.matches[0].net_cents, rep.corps.netCents);
  assert.strictEqual(db.matches[0].cashed_out, true);
});
await test('LA SACOCHE PAYÉE N\'EST PAS LA MISE : un encaissement qui sort avec plus qu\'il n\'a engagé', async () => {
  // LE TROU QUE CE TEST BOUCHE. Le seul règlement payant du fichier avait une sacoche exactement
  // égale à la mise : rien n'y distinguait « la sacoche que le rejeu trouve dans la poche » de
  // « la mise inscrite sur le billet ». Plafonner tout paiement à une mise — `min(purse, stake)` —
  // ne cassait aucun test, alors que c'est précisément le premier des deux « contrôles évidents et
  // faux » que `api/README.md` refuse d'écrire, et que LA promesse de la phase est que le montant
  // sorte de la partie rejouée.
  //
  // La graine est forcée pour que la partie soit celle-là et pas une autre ; elle n'a rien de
  // magique — c'est l'assertion `purseCents > stakeCents` qui porte la garantie, et c'est elle qui
  // fera tomber le test avec un message clair le jour où un correctif de simulation changera la
  // partie, au lieu de le laisser redevenir aveugle en silence.
  const { db, app, horloge } = bancDeBillet({ randomSeed: () => 4 });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const { partie, rep } = await jouerEtRendre(app, horloge, b, { encaisserSiRiche: true });
  assert.strictEqual(partie.terminal, 'encaissement');
  assert.ok(partie.rapport.purseCents > b.corps.stakeCents,
    `la partie de ce test sort avec ${partie.rapport.purseCents} centimes pour ${b.corps.stakeCents} engagés : `
    + 'le test ne distingue plus la sacoche de la mise, il faut lui retrouver une partie qui le fasse');

  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.issue, 'encaissement');
  // LA ROUTE PAIE LA SACOCHE QUE LE REJEU A TROUVÉE, pas la mise inscrite sur le billet.
  assert.strictEqual(rep.corps.purseCents, partie.rapport.purseCents);
  assert.notStrictEqual(rep.corps.purseCents, b.corps.stakeCents);
  assert.strictEqual(rep.corps.grossCents, rep.corps.purseCents);
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(rep.corps.purseCents).netCents);
  assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents);
  // Et la ligne qui tue explicitement le plafonnement à une mise : payer `min(sacoche, mise)`
  // rendrait exactement le net d'une mise, et ce test-là serait le seul à le voir.
  assert.ok(rep.corps.netCents > C.cashoutCents(b.corps.stakeCents).netCents,
    'le paiement ne dépasse pas une mise : la sacoche du rejeu n\'est pas ce qui décide');
  assert.strictEqual(db.matches[0].net_cents, rep.corps.netCents);
  assert.strictEqual(db.matches[0].purse_cents, partie.rapport.purseCents);
  // La sacoche reste sous le plafond démontré par la conservation de l'argent : ce n'est pas parce
  // qu'elle n'est plus la mise qu'elle n'est plus bornée.
  assert.ok(rep.corps.purseCents <= C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents);
});
await test('LE PLANCHER D\'HORLOGE SUR LA ROUTE : un encaissement rendu à l\'instant du billet est refusé, et personne n\'est enfermé', async () => {
  // LE CHEMIN QUI PORTE LE PLUS GROS PAIEMENT DU DOSSIER N'AVAIT AUCUN PLANCHER. `margeHorlogeS`
  // vaut 120 pour un sas de 25, donc l'inéquation du contrôle `chronometre`, lue dans l'autre sens,
  // n'exigeait AUCUNE attente réelle d'un encaissement Resurgence. La partie étant une fonction pure
  // de `seed_public`, que le client reçoit avec son billet, chercher hors ligne la trace qui
  // maximise l'argent emporté ne demandait donc qu'un processeur et de la patience.
  const { db, app, horloge } = bancDeBillet({ randomSeed: () => 4 });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisserSiRiche: true });
  assert.strictEqual(p.terminal, 'encaissement');
  await poserTrace(app, b.corps.id, p.segments);

  // Zéro seconde après l'ouverture du billet. La première moitié du test montre le trou : le
  // chronomètre de la 02a laisse passer ce rapport à cet instant précis.
  horloge.t = Date.parse(b.corps.openedAt);
  assert.ok(p.rapport.seconds <= 0 - C.LOBBY.wait + C.ENVELOPPE.margeHorlogeS,
    `la partie du test dure ${p.rapport.seconds} s : le chronomètre la refuserait déjà, et le test ne prouverait plus rien`);
  assert.ok(p.rapport.seconds > C.ENVELOPPE.margePlancherS - C.LOBBY.wait,
    `la partie du test dure ${p.rapport.seconds} s : trop courte pour que le plancher ait quoi que ce soit à exiger`);

  const rep = await rendre(app, b.corps.id, p.rapport);
  // AUCUN 500, ET C'EST LA MOITIÉ QUI COMPTE. Le dépôt a déjà payé une fois un refus arrivé jusqu'à
  // une colonne `integer` : Postgres levait `22003`, la route rendait 500, et la ligne restait
  // `open` — le joueur était enfermé dans un billet mort pendant les treize minutes de l'expiration,
  // puisqu'il n'en a qu'un à la fois. Un refus de verdict n'est pas une panne : il clôt la ligne en
  // `rejected` et rend le règlement, exactement comme `chronometre`, `victoire` ou `expire`.
  assert.notStrictEqual(rep.code, 500, 'un refus de plancher est sorti en 500');
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'rejected');
  assert.strictEqual(rep.corps.issue, 'refus');
  assert.strictEqual(rep.corps.controle, 'plancher', JSON.stringify(rep.corps));
  assert.ok(rep.corps.motif && rep.corps.motif.length > 10, 'un refus doit dire pourquoi');
  assert.strictEqual(rep.corps.netCents, 0);
  assert.strictEqual(rep.corps.grossCents, 0);
  assert.strictEqual(db.matches[0].status, 'rejected');
  // Et rien n'est sorti de la caisse. Le séquestre se solde comme sur tout refus — une seule
  // écriture, `enjeu → maison:contrepartie`, la mise que le joueur perd — mais AUCUNE ligne ne
  // crédite le joueur, et la maison ne met rien au pot. Ce qui aurait été payé sans ce module se
  // lit sur la ligne d'à côté.
  const gains = db.ledger.filter(l => l.motif === 'gain');
  assert.deepStrictEqual(gains.map(l => [l.compte_debit, l.compte_credit, l.montant_cents]),
    [[`enjeu:${db.matches[0].id}`, 'maison:contrepartie', b.corps.stakeCents]],
    'un règlement refusé a fait bouger autre chose que le séquestre');
  assert.ok(C.cashoutCents(db.matches[0].purse_cents).netCents > 0,
    'la sacoche rejouée ne payait rien : le test ne prouve pas que le plancher protège de l\'argent');
  // Le séquestre est vide : la mise est partie chez la maison, elle n'attend plus personne.
  assert.strictEqual(soldeLu(db, `enjeu:${db.matches[0].id}`), 0, 'le séquestre reste habité après un refus');

  // PERSONNE N'EST ENFERMÉ : la ligne est close, donc le billet suivant s'ouvre dans la foulée.
  const neuf = await demander(app, { ...DEMANDE, mode: 'resurgence', clientKey: 'apres-plancher' });
  assert.strictEqual(neuf.code, 200, JSON.stringify(neuf.corps));
});
await test('le même encaissement, après l\'attente réelle, est RÉGLÉ et payé : le plancher renchérit, il n\'interdit pas', async () => {
  // La seconde moitié de la démonstration, et celle qui garde l'arbitrage honnête : ce module ne
  // ferme pas une porte, il ramène le solveur hors ligne au rythme d'un joueur. Celui qui a
  // réellement attendu le sas puis joué sa partie touche exactement ce que la table promet — au
  // BORD EXACT du plancher, et pas trois secondes après, sinon la marge pourrait glisser sans que
  // rien ne tombe.
  const { db, app, horloge } = bancDeBillet({ randomSeed: () => 4 });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisserSiRiche: true });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = Date.parse(b.corps.openedAt)
    + (C.LOBBY.wait + p.rapport.seconds - C.ENVELOPPE.margePlancherS) * 1000;
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'settled');
  assert.strictEqual(rep.corps.issue, 'encaissement');
  assert.ok(rep.corps.netCents > 0, 'l\'encaissement honnête n\'a rien payé');
  assert.strictEqual(rep.corps.netCents, C.cashoutCents(rep.corps.purseCents).netCents);
  // La durée que le SERVEUR a rejouée est bien celle sur laquelle le plancher a été calculé : sans
  // cette ligne, le test pourrait mesurer un bord qui n'est pas celui de la partie jugée.
  assert.strictEqual(db.matches[0].seconds, p.rapport.seconds);
  // Les trois jambes d'un gain qui paie : la maison met le reliquat au pot, la commission part, et
  // le net va au joueur. C'est exactement l'exposition que le module 1 sait chiffrer.
  const gains = db.ledger.filter(l => l.motif === 'gain');
  assert.strictEqual(gains.length, 3, JSON.stringify(gains));
  assert.ok(gains.some(l => l.compte_debit === 'maison:contrepartie'),
    'la maison n\'a rien mis au pot : ce règlement ne l\'expose pas, donc il ne prouve rien');
  assert.ok(gains.some(l => l.compte_credit === `joueur:${db.users[0].id}:disponible`
                            && l.montant_cents === rep.corps.netCents),
    'le net n\'a pas été crédité au joueur');
  assert.strictEqual(soldeLu(db, `enjeu:${db.matches[0].id}`), 0, 'le séquestre reste habité après un règlement');
});
await test('le même billet réglé deux fois rend le PREMIER verdict, sans rien modifier', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const r = RAPPORT({ seconds: 154, rank: 1 });
  horloge.t = ARRIVEE(r);
  const un = await rendre(app, b.corps.id, r);
  const apres = JSON.stringify(db.matches);
  // Le second envoi ment sur tout : autre durée, autre rang, autre net annoncé. Il doit rendre
  // exactement ce que le premier a écrit, et ne rien réécrire.
  horloge.t += 60_000;
  const deux = await rendre(app, b.corps.id, RAPPORT({ seconds: 3, rank: 7, declaredNetCents: 424242 }));
  assert.deepStrictEqual(deux.corps, un.corps);
  assert.strictEqual(JSON.stringify(db.matches), apres, 'la ligne a été réécrite');
  assert.strictEqual(db.matches.length, 1);
});
await test('la base refuse elle-même un second règlement, sans compter sur la route', async () => {
  // Deux gardes empêchent une ligne d'être réglée deux fois : la route court-circuite dès qu'elle
  // voit une ligne close, et la clause `where status = 'open' and net_cents is null` de l'écriture
  // tranche pour de bon. Chacune masque l'autre, donc aucune des deux n'est prouvée en passant par
  // la route : celle-ci est donc appelée directement. C'est la seule qui compte en production,
  // l'autre n'est qu'une économie de calcul. La doublure imite la clause, elle ne la subit pas :
  // c'est la limite connue de tout ce dossier, écrite dans le README.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  await jouerEtRendre(app, horloge, b);
  const regle = JSON.stringify(db.matches[0]);
  const second = await db.settleMatch({
    matchId: b.corps.id, userId: db.users[0].id, status: 'settled', settledAt: new Date(0),
    issue: 'victoire', controle: null, motif: null,
    grossCents: 999_999, feeCents: 0, netCents: 999_999, purseCents: 999_999,
    declaredNetCents: 999_999, ecartCents: 0,
    seconds: 1, kills: 1, deaths: 0, rank: 1, cubes: 0, damage: 0, cashedOut: false,
    traceSteps: 1, replayDigest: 1, digestMatch: true, divergenceStep: null, replayMs: 1,
  });
  assert.strictEqual(second.deja, true, 'un second règlement doit être reconnu comme un rejeu');
  assert.strictEqual(JSON.stringify(db.matches[0]), regle, 'un montant déjà écrit a été réécrit');
});
await test('un résultat qui arrive en retard, mais avant expiration, est accepté', async () => {
  // Si couper le wifi effaçait une partie perdue, ce serait la meilleure stratégie du jeu.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = Date.parse(b.corps.expiresAt) - 1000;
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.corps.status, 'settled', rep.corps.motif);
  assert.ok(rep.corps.netCents > 0);
  assert.strictEqual(db.matches[0].status, 'settled');
});
await test('après expiration, le résultat ne se règle plus et la ligne est close en expired', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  const rep = await rendre(app, b.corps.id, RAPPORT({ seconds: 154, rank: 1 }));
  assert.strictEqual(rep.code, 200);
  assert.strictEqual(rep.corps.status, 'expired');
  assert.strictEqual(rep.corps.controle, 'expire');
  assert.strictEqual(rep.corps.netCents, 0);
  assert.strictEqual(db.matches[0].status, 'expired');
  // Et rejouer ne ressuscite rien.
  const encore = await rendre(app, b.corps.id, RAPPORT({ seconds: 154, rank: 1 }));
  assert.deepStrictEqual(encore.corps, rep.corps);
});
await test('checkReport refuse un champ inconnu, avec un code, et rien n\'est écrit', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = T0 + 200_000;
  const rep = await rendre(app, b.corps.id, { ...RAPPORT({ seconds: 60, rank: 1 }), netCents: 9999 });
  assert.strictEqual(rep.code, 400);
  assert.ok(rep.corps.erreurs.some(e => e.code === 'inconnu' && e.field === 'netCents'),
    JSON.stringify(rep.corps.erreurs));
  assert.strictEqual(db.matches[0].status, 'open', 'un rapport refusé à l\'analyse ne clôt rien');
  // Un rapport incomplet est refusé de la même façon, avec le code qui dit quoi corriger.
  const nu = await rendre(app, b.corps.id, { seconds: 10 });
  assert.strictEqual(nu.code, 400);
  assert.ok(nu.corps.erreurs.every(e => ['manquant', 'inconnu'].includes(e.code)));
});
await test('L\'ENVELOPPE RESTE, ET ELLE MORD SUR LES FAITS REJOUÉS : un résultat rendu trop tôt est refusé', async () => {
  // `matchVerdict` NE DISPARAÎT PAS avec le rejeu, et voici pourquoi elle vaut encore quelque
  // chose : le chronomètre du serveur compare la durée RECALCULÉE au temps réellement écoulé
  // depuis l'ouverture du billet. Une partie de cent quatre secondes rendue à l'instant même où le
  // billet s'ouvre n'a pas pu avoir lieu, quelle que soit la qualité de la trace qui l'accompagne.
  // Si le rejeu se trompait, ce contrôle-là serait le dernier à regarder le montant.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  const p = partieDe(b);
  assert.ok(p.rapport.seconds > C.ENVELOPPE.margeHorlogeS - C.LOBBY.wait,
    `la partie du test (${p.rapport.seconds} s) est trop courte pour éprouver le chronomètre`);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = T0;
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.corps.status, 'rejected');
  assert.strictEqual(rep.corps.issue, 'refus');
  assert.strictEqual(rep.corps.controle, 'chronometre');
  assert.ok(rep.corps.motif && rep.corps.motif.length > 10, 'un refus doit dire pourquoi');
  assert.strictEqual(rep.corps.netCents, 0);
  // La mesure survit au refus : c'est elle qui fixera un seuil en phase 06.
  assert.strictEqual(rep.corps.ecartCents, p.rapport.declaredNetCents);
  assert.strictEqual(db.matches[0].status, 'rejected');
  // Et une partie refusée n'est ni réglée ni ouverte : aucune somme sur `status = 'settled'` ne la
  // verra jamais.
  assert.strictEqual(db.matches.filter(m => m.status === 'settled').length, 0);
  // C'EST BIEN `chronometre` QUI PARLE, ET PAS `plancher`. Le plancher d'horloge de la 04a aurait
  // refusé cet instant-là aussi — mais ce règlement ne paie rien, et il ne s'arme que là où de
  // l'argent sort de la caisse. La marge large de 120 s reste donc la seule à regarder les
  // règlements qui ne paient pas : un onglet endormi ne doit pas coûter une partie honnête.
  assert.strictEqual(C.horlogePlancher({ openedAt: T0 }, p.rapport, T0), false,
    'le plancher aurait refusé cet instant : c\'est bien qu\'il ne s\'est pas armé');
});
await test('un rapport hors du domaine d\'un integer est refusé en 400, et le billet reste réglable', async () => {
  // LA PANNE, DE BOUT EN BOUT. `deaths`, `damage` et `declaredNetCents` n'avaient aucune borne
  // haute : un rapport parfaitement « valide » traversait toute la validation jusqu'à des colonnes
  // `integer`, Postgres levait `22003`, la route rendait 500 — et la ligne restait `open`. Comme un
  // joueur n'a qu'un billet ouvert à la fois, il était enfermé dans un billet mort pendant les
  // treize minutes de l'expiration, et sa partie n'était jamais enregistrée.
  //
  // Ce n'est pas le 400 qui compte dans ce test, c'est la SECONDE moitié : la ligne n'est pas
  // piégée, et un rapport honnête la règle juste après.
  for (const champ of ['deaths', 'damage', 'declaredNetCents']) {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app);
    const p = partieDe(b);
    const r = { ...p.rapport, [champ]: 3_000_000_000 };
    horloge.t = ARRIVEE(r);
    const ko = await rendre(app, b.corps.id, r);
    assert.strictEqual(ko.code, 400, `${champ} : attendu un refus motivé, pas un 500 muet`);
    assert.ok(ko.corps.erreurs.some(e => e.code === 'borne' && e.field === champ),
      `${champ} : ${JSON.stringify(ko.corps.erreurs)}`);
    assert.strictEqual(db.matches[0].status, 'open', `${champ} : la ligne a été close par un refus d'analyse`);

    const ok = (await jouerEtRendre(app, horloge, b)).rep;
    assert.strictEqual(ok.code, 200, `${champ} : le billet est resté piégé`);
    assert.strictEqual(ok.corps.status, 'settled', `${champ} : ${ok.corps.motif}`);
  }
});
await test('la doublure refuse désormais ce que Postgres refuserait', async () => {
  // Sans cette garde, la doublure était plus permissive que la base, et aucun test ne pouvait voir
  // la classe de bug ci-dessus. On l'éprouve directement : c'est la seule façon de prouver que la
  // doublure ment comme il faut.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  await assert.rejects(() => db.settleMatch({
    matchId: b.corps.id, userId: db.users[0].id, status: 'settled', settledAt: new Date(T0),
    issue: 'defaite', controle: null, motif: null,
    grossCents: 0, feeCents: 0, netCents: 0, purseCents: 0,
    declaredNetCents: 3_000_000_000, ecartCents: 3_000_000_000,
    seconds: 60, kills: 0, deaths: 0, rank: 5, cubes: 0, damage: 0, cashedOut: false,
    traceSteps: 1, replayDigest: 1, digestMatch: true, divergenceStep: null, replayMs: 1,
  }), e => e.code === '22003');
  assert.strictEqual(db.matches[0].status, 'open', 'une écriture refusée ne doit rien laisser derrière');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
test('tout champ du rapport qui finit dans une colonne integer porte sa borne', () => {
  // La garde qui attrape la PROCHAINE colonne ajoutée sans borne. Elle relie les deux moitiés du
  // dossier : le schéma déclare la largeur, WBCore la fait respecter, et rien entre les deux ne
  // permet d'oublier l'un des deux côtés.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const serpent = n => n.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  let vus = 0;
  for (const [nom, regle] of Object.entries(C.REPORT_FIELDS)) {
    if (regle.kind !== 'entier') continue;
    const col = serpent(nom);
    const decl = (sql.match(new RegExp('^[ \\t]*' + col + '\\b.*$', 'm')) || [])[0];
    assert.ok(decl, `« ${nom} » part en base mais la colonne ${col} n'existe pas`);
    assert.match(decl, /\binteger\b/, decl);
    assert.ok(Number.isInteger(regle.max) && regle.max <= 2147483647,
      `« ${nom} » écrit dans un integer sans borne haute : max = ${regle.max}`);
    vus++;
  }
  assert.ok(vus >= 8, `seulement ${vus} champs entiers vérifiés`);
});
await test('en Duo comme en Trio la ligne s\'équilibre : fee + net = brut, au périmètre du joueur', () => {
  // `gross_cents` et `fee_cents` décrivaient la TABLE — le pot, la commission de la maison — quand
  // `net_cents` décrivait le JOUEUR : en Duo la ligne stockée disait 2000 − 400 = 800, et il
  // manquait 800 c que personne n'écrivait nulle part. Qui réconcilie ces lignes lisait une
  // commission de 60 %. Depuis que le prix est la sacoche emportée, les trois montants sont au même
  // périmètre et la ligne se referme sur elle-même, dans les cinq modes.
  return Promise.all([['duo', 1], ['trio', 1], ['solo', 10], ['resurgence', 5], ['resurgenceDuo', 0.5]]
    .map(async ([cle, stake]) => {
      const { db, app, horloge } = bancDeBillet();
      const mode = C.MODES[cle];
      const b = await demander(app, { ...DEMANDE, mode: cle, stake });
      const { partie, rep } = await jouerEtRendre(app, horloge, b,
        mode.cashout ? { encaisser: 300 } : {});
      assert.strictEqual(rep.corps.status, 'settled', `${cle} : ${rep.corps.motif}`);
      assert.ok(partie.terminal, `${cle} : la partie rejouée n'atteint pas d'état terminal`);
      assert.strictEqual(rep.corps.feeCents + rep.corps.netCents, rep.corps.grossCents, cle);
      // Le brut EST la sacoche que le rejeu a trouvée, jamais un forfait ni un nombre annoncé.
      assert.strictEqual(rep.corps.grossCents, rep.corps.purseCents, `${cle} : le brut n'est pas la sacoche`);
      // Et le plafond du lobby n'est jamais dépassé : la conservation de l'argent le garantit, elle
      // est assertée au règlement, et cette ligne-ci le constate de l'extérieur.
      assert.ok(rep.corps.netCents <= C.payoutCents(b.corps.stakeCents, mode).winnerCents, cle);
      assert.ok(rep.corps.purseCents <= C.purseBound(b.corps.stakeCents, b.corps.seats).maxCents, cle);
      const ligne = db.matches[0];
      assert.strictEqual(ligne.fee_cents + ligne.net_cents, ligne.gross_cents, `${cle} : la ligne ne s'équilibre pas`);
      assert.strictEqual(ligne.digest_match, true, `${cle} : le rejeu n'a pas convergé`);
    }));
});
await test('la table du billet est FIGÉE : seats et teamSize sont recopiés dans la ligne', async () => {
  // Un résultat est accepté jusqu'à l'expiration du billet. Un serveur redémarré entre-temps avec
  // un `teams` corrigé jugerait la partie contre une table que personne n'a achetée : c'est la
  // seule raison d'être de ces deux colonnes, et `teamSize` manquait alors que le verdict borne
  // les kills et le rang avec lui.
  for (const cle of Object.keys(C.MODES)) {
    const { db, app } = bancDeBillet();
    const r = await demander(app, { ...DEMANDE, mode: cle });
    assert.strictEqual(r.corps.seats, C.seatsOf(C.MODES[cle]), cle);
    assert.strictEqual(r.corps.teamSize, C.MODES[cle].teamSize, cle);
    assert.strictEqual(db.matches[0].seats, C.seatsOf(C.MODES[cle]), cle);
    assert.strictEqual(db.matches[0].team_size, C.MODES[cle].teamSize, cle);
  }
});
await test('le billet d\'un autre joueur est introuvable, et un billet inconnu aussi', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = T0 + 200_000;
  const voisin = await appel(app, {
    method: 'POST', path: `/api/match/${b.corps.id}/result`, token: 'ok:u2:Zoe',
    body: RAPPORT({ seconds: 60, rank: 1 }),
  });
  assert.strictEqual(voisin.code, 404, 'un identifiant deviné ne doit rien apprendre');
  assert.strictEqual(db.matches[0].status, 'open');
  const fantome = await rendre(app, '999999', RAPPORT({ seconds: 60, rank: 1 }));
  assert.strictEqual(fantome.code, 404);
});
await test('la route du résultat n\'accepte que POST, et son chemin n\'est pas un passe-partout', async () => {
  const { app } = bancDeBillet();
  for (const m of ['GET', 'PATCH', 'DELETE'])
    assert.strictEqual((await appel(app, { method: m, path: '/api/match/1/result', token: 'ok:u1:Loic' })).code, 405, m);
  for (const chemin of ['/api/match//result', '/api/match/abc/result', '/api/match/1/result/x', '/api/match/1'])
    assert.strictEqual((await appel(app, { method: 'POST', path: chemin, token: 'ok:u1:Loic' })).code, 404, chemin);
  // Sans jeton, rien ne passe : le refus vient avant la lecture du corps.
  const nu = await appel(app, { method: 'POST', path: '/api/match/1/result' });
  assert.strictEqual(nu.code, 401);
});
await test('le pré-vol annonce toujours les méthodes des deux routes de partie', async () => {
  const { app } = bancDeBillet();
  const r = await appel(app, { method: 'OPTIONS' });
  const methodes = String(r.head['access-control-allow-methods']).split(',');
  for (const m of ['GET', 'PATCH', 'POST', 'OPTIONS']) assert.ok(methodes.includes(m), m);
});
await test('le veilleur clôt les billets expirés, et seulement eux', async () => {
  const { db, app, horloge } = bancDeBillet();
  // Trois billets pour trois joueurs : l'un sera réglé, l'un périmera, l'un sera encore valable.
  const a = await demander(app);
  const regle = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u2:Zoe',
                                   body: { ...DEMANDE, clientKey: 'z-1' } });
  await jouerEtRendre(app, horloge, regle, { token: 'ok:u2:Zoe' });
  assert.strictEqual(db.matches[1].status, 'settled');

  // Personne ne clôt rien tant que rien n'a expiré : le veilleur passe à vide.
  assert.deepStrictEqual(await app.veiller(), { closes: 0, echecs: [] });
  assert.strictEqual(db.matches[0].status, 'open');

  const tard = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u3:Max',
                                  body: { ...DEMANDE, clientKey: 'm-1' } });
  // On avance jusqu'après l'expiration du premier billet, mais pas de celui qu'on vient d'ouvrir.
  horloge.t = Date.parse(a.corps.expiresAt) + 1;
  assert.ok(horloge.t < Date.parse(tard.corps.expiresAt));
  assert.deepStrictEqual(await app.veiller(), { closes: 1, echecs: [] });
  assert.strictEqual(db.matches[0].status, 'expired', 'le billet que personne n\'a terminé');
  assert.strictEqual(db.matches[1].status, 'settled', 'une partie réglée n\'est jamais rouverte ni reclose');
  assert.strictEqual(db.matches[2].status, 'open', 'un billet encore valable n\'est pas balayé');
  // Repassé deux fois, il ne clôt plus rien : il ferme une porte, il ne la claque pas en boucle.
  assert.deepStrictEqual(await app.veiller(), { closes: 0, echecs: [] });
});
await test('le veilleur n\'écrit aucun montant SUR LA LIGNE : un billet périmé n\'a pas de verdict', async () => {
  // Ce test disait « il ne règle rien », et la phase 03 l'a rendu à moitié faux : le veilleur vide
  // désormais le séquestre. Ce qui reste vrai, et qui est tout ce que ce test-ci prouve, c'est
  // qu'aucun MONTANT n'entre dans la ligne `matches` — un billet que personne n'a terminé n'a pas
  // de verdict, et lui en écrire un ferait compter une partie qui n'a jamais été jugée. Le
  // séquestre, lui, a son propre test un peu plus bas.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app);
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  await app.veiller();
  const ligne = db.matches[0];
  for (const col of ['net_cents', 'fee_cents', 'gross_cents', 'purse_cents', 'ecart_cents'])
    assert.strictEqual(ligne[col], undefined, `le veilleur a écrit ${col}`);
  assert.strictEqual(ligne.settled_at, undefined);
  assert.strictEqual(ligne.status, 'expired');
});
await test('chaque requête rejouée deux fois : mêmes lignes, mêmes réponses', async () => {
  // Le patron, appliqué à toutes les routes qui écrivent. Ce qui compte n'est pas qu'elles
  // répondent 200 deux fois, c'est que la seconde réponse soit la première, au caractère près, et
  // que la table n'ait pas bougé entre les deux.
  const { db, app, horloge } = bancDeBillet();
  const rejeux = [];
  const deuxFois = async (nom, envoi) => {
    const un = await envoi();
    const lignes = JSON.stringify(db.matches);
    const deux = await envoi();
    // `repris` mis à part, et l'exception est écrite là où elle naît, dans `app.js` : il décrit le
    // CHEMIN qui a servi la réponse, pas le billet. Ce que l'idempotence promet reste entier — même
    // identifiant, même graine, même mise, et la table n'a pas bougé d'un octet.
    assert.deepStrictEqual(sansRepris(deux.corps), sansRepris(un.corps), nom);
    assert.strictEqual(JSON.stringify(db.matches), lignes, nom + ' : la table a bougé au rejeu');
    rejeux.push(nom);
  };
  await deuxFois('POST /api/match', () => demander(app));
  const b = await demander(app);
  const r = RAPPORT({ seconds: 154, rank: 1 });
  horloge.t = ARRIVEE(r);
  await deuxFois('POST /api/match/:id/result', () => rendre(app, b.corps.id, r));
  await deuxFois('POST /api/match/:id/result (refusé)', () => rendre(app, b.corps.id, r));
  assert.strictEqual(rejeux.length, 3);
  assert.strictEqual(db.matches.length, 1);
});
await test('la limitation de débit du résultat a son propre seau', async () => {
  const { app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await rendre(app, b.corps.id, p.rapport)).code);
  assert.deepStrictEqual(codes, [200, 200, 429], codes.join(','));
  // Le seau du billet, lui, n'a servi qu'une fois : demander une partie reste possible.
  assert.strictEqual((await demander(app, { ...DEMANDE, clientKey: 'cle-2' })).code, 200);
});

console.log('Les statistiques sont la somme des parties');
// Une partie entière, du billet au règlement, avec une horloge qui avance comme celle d'un joueur
// honnête. Chaque partie ouvre SON billet : un joueur n'en a qu'un ouvert à la fois, et c'est le
// règlement qui libère la place — donc enchaîner des parties éprouve aussi cela.
// Elle JOUE, désormais : le serveur ne croit plus aucun fait déclaré, donc une statistique ne peut
// plus se fabriquer avec un rapport écrit à la main. `encaisser` fait sortir le joueur avec sa
// sacoche — la seule sortie gagnante qu'un test puisse commander.
const jouer = async (app, horloge, cle, opts = {}, demande = DEMANDE) => {
  const b = await demander(app, { ...demande, clientKey: cle });
  return (await jouerEtRendre(app, horloge, b, opts)).rep;
};
const mesStats = async app => (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;

await test('les statistiques rendues sont exactement la somme des parties réglées', async () => {
  const { db, app, horloge } = bancDeBillet();
  assert.deepStrictEqual(await mesStats(app), { matches: 0, wins: 0, kills: 0, best: 0, divergences: 0 },
    'un compte neuf n\'a rien à initialiser : la somme d\'un ensemble vide vaut zéro');

  const gagnee = await jouer(app, horloge, 'p1', { encaisser: 300 }, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(gagnee.corps.status, 'settled');
  assert.strictEqual(gagnee.corps.issue, 'encaissement');
  const perdue = await jouer(app, horloge, 'p2');
  assert.strictEqual(perdue.corps.issue, 'defaite');

  // Les chiffres attendus ne sont PAS écrits à la main : ils sont ceux des parties réellement
  // jouées. Les écrire à la main reviendrait à décider du résultat d'une simulation.
  const reglees = db.matches.filter(m => m.status === 'settled');
  const s = await mesStats(app);
  assert.deepStrictEqual(s, {
    matches: 2, wins: 1,
    kills: reglees.reduce((t, m) => t + m.kills, 0),
    best: gagnee.corps.netCents,
    divergences: 0,
  });
  assert.ok(s.best > 0, 'aucune des deux parties n\'a rien rapporté : le test ne prouve plus rien');
  // Et rien nulle part ne ressemble à un compteur : la somme se refait à l'identique depuis les
  // lignes, ce qui est précisément la propriété qu'un double envoi ne peut pas casser.
  assert.strictEqual(s.matches, reglees.length);
});
await test('une partie refusée ou restée ouverte ne compte pour rien', async () => {
  const { db, app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1');
  const avant = await mesStats(app);

  // Refusée : la ligne est close avec son motif, et aucune somme ne la verra jamais. Le refus vient
  // du chronomètre du serveur, sur la durée RECALCULÉE — le rapport est sincère, c'est l'horloge
  // qui n'a pas eu le temps de contenir la partie.
  const b2 = await demander(app, { ...DEMANDE, clientKey: 'p2' });
  const p2 = partieDe(b2);
  await poserTrace(app, b2.corps.id, p2.segments);
  // Une seconde AVANT que l'horloge du serveur ne puisse contenir cette partie-là : c'est le bord
  // exact du contrôle, et il tient quelle que soit la durée que le rejeu a trouvée.
  horloge.t = Date.parse(b2.corps.openedAt)
            + (C.LOBBY.wait + p2.rapport.seconds - C.ENVELOPPE.margeHorlogeS - 1) * 1000;
  const refus = await rendre(app, b2.corps.id, p2.rapport);
  assert.strictEqual(refus.corps.status, 'rejected', JSON.stringify(refus.corps));
  assert.strictEqual(refus.corps.controle, 'chronometre');
  assert.deepStrictEqual(await mesStats(app), avant, 'une partie refusée a compté');

  // Restée ouverte : le billet est pris, la partie n'est jamais rendue. Elle ne vaut rien non plus,
  // sinon demander un billet suffirait à gonfler son compteur de parties.
  const ouvert = await demander(app, { ...DEMANDE, clientKey: 'p3' });
  assert.strictEqual(ouvert.code, 200);
  assert.deepStrictEqual(await mesStats(app), avant, 'un billet ouvert a compté');

  // Et périmée, pas davantage : le veilleur ferme une porte, il ne règle rien.
  horloge.t = Date.parse(ouvert.corps.expiresAt) + 1;
  assert.deepStrictEqual(await app.veiller(), { closes: 1, echecs: [] });
  assert.deepStrictEqual(await mesStats(app), avant, 'une partie périmée a compté');
  assert.strictEqual(db.matches.length, 3);
});
await test('best est le plus grand net en centimes, jamais le dernier ni une somme', async () => {
  const { app, horloge } = bancDeBillet();
  // Deux sorties gagnantes réellement jouées, sur deux tables : la grosse d'abord, la petite
  // ensuite. Les montants sortent des parties, pas du test.
  const grosse = (await jouer(app, horloge, 'p1', { encaisser: 300 },
                              { ...DEMANDE, mode: 'resurgence', stake: 10 })).corps.netCents;
  const petite0 = (await jouer(app, horloge, 'p2', { encaisser: 300 },
                               { ...DEMANDE, mode: 'resurgence', stake: 0.5 })).corps.netCents;
  assert.ok(grosse > petite0 && petite0 > 0, `${grosse} / ${petite0}`);
  // La plus modeste, jouée EN SECOND, ne doit RIEN changer : c'est un maximum, pas un dernier
  // résultat, et surtout pas un cumul.
  const s = await mesStats(app);
  assert.strictEqual(s.best, grosse);
  assert.notStrictEqual(s.best, grosse + petite0);
  // En centimes ENTIERS jusqu'au bout du réseau. La conversion en dollars n'a lieu qu'une fois,
  // côté jeu, dans `applyAccount` — que l'on vérifie ici brancher sur la même valeur.
  assert.ok(Number.isInteger(s.best));
  assert.strictEqual(C.applyAccount(null, { stats: s }, []).stats.best, C.fromCents(grosse));
});
await test('un encaissement Resurgence compte comme une sortie gagnante, comme dans le jeu', async () => {
  // `endMatch` incrémente `wins` dès que `won` est vrai, encaissement compris. Si le serveur
  // comptait autrement, se connecter ferait BAISSER le compteur d'un joueur de Resurgence.
  const { app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence', clientKey: 'p0' });
  const { rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(rep.corps.issue, 'encaissement');
  const s = await mesStats(app);
  assert.strictEqual(s.matches, 1);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.best, rep.corps.netCents);
});
await test('les parties d\'un joueur ne comptent que pour lui', async () => {
  const { db, app, horloge } = bancDeBillet();
  await jouer(app, horloge, 'p1');
  const voisin = await appel(app, { method: 'POST', path: '/api/match', token: 'ok:u2:Zoe',
                                    body: { ...DEMANDE, clientKey: 'z-1' } });
  await jouerEtRendre(app, horloge, voisin, { token: 'ok:u2:Zoe' });
  const a = await mesStats(app);
  const z = (await appel(app, { token: 'ok:u2:Zoe' })).corps.stats;
  assert.strictEqual(a.matches, 1);
  assert.strictEqual(z.matches, 1);
  // Les deux parties ont des graines différentes, donc des comptes différents : ce qui se vérifie
  // ici est que chacun ne voit QUE sa ligne.
  assert.strictEqual(a.kills, db.matches[0].kills);
  assert.strictEqual(z.kills, db.matches[1].kills);
});
await test('des statistiques rendues en chaînes par la base ressortent en nombres', async () => {
  // `count()` et `sum()` rendent un `bigint`, que le pilote Postgres livre sous forme de CHAÎNE —
  // le même piège que les graines, en pire : une graine en chaîne fait repartir le jeu sur la
  // sienne, une statistique en chaîne ne se voit qu'à l'écran, des semaines plus tard. La doublure
  // ment donc ici comme le vrai pilote, plutôt que comme l'idée qu'on s'en fait.
  const db = fakeDb();
  const brute = db.findOrCreate;
  db.findOrCreate = async a => ({
    user: (await brute(a)).user,
    stats: { matches: '2', wins: '1', kills: '9', best: '160', divergences: '0' },
  });
  const r = await appel(appDe(db), { token: 'ok:u1:Loic' });
  for (const [k, v] of Object.entries(r.corps.stats)) assert.strictEqual(typeof v, 'number', k);
  assert.deepStrictEqual(r.corps.stats, { matches: 2, wins: 1, kills: 9, best: 160, divergences: 0 });
  assert.strictEqual(C.applyAccount(null, r.corps, []).stats.best, C.fromCents(160));
});
test('toute colonne dont db-pg.js parle existe encore dans le schéma', () => {
  // Première des deux gardes AU NIVEAU DU TEXTE. Aucune base ne tourne : elle attrape la dérive
  // entre la doublure et Postgres là où elle est la plus probable aujourd'hui — une requête restée
  // en arrière après la disparition d'une table, qui ne planterait qu'au premier déploiement.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const mots = t => new Set(t.match(/\b[a-z_][a-z0-9_]*\b/g) || []);
  const schema = mots(sql);
  // Les requêtes, c'est-à-dire les littéraux entre accents graves plus les listes de colonnes
  // qu'ils interpolent. On retire les interpolations (du code, pas des colonnes — les deux listes
  // sont relues à part), les alias (`as parties`) et les chaînes ('settled').
  // Les `require` de tête ne sont pas des listes de colonnes : `require('./ledger')` y ferait
  // entrer les mots « require » et « ledger », qu'aucune table ne porte.
  const listes = (pg.match(/^const \w+ =[^;]*;/gm) || []).filter(l => !/require\(/.test(l))
    .join(' ').replace(/'/g, ' ');
  // Et seuls les littéraux qui sont VRAIMENT des requêtes : depuis que le pilote lève des refus
  // nommés, il porte aussi des messages d'erreur entre accents graves, et « grand livre : … » n'est
  // pas une colonne qu'on cherche dans le schéma. Toute instruction de ce fichier commence par un
  // de ces quatre verbes — une requête qui n'en porterait aucun échapperait à la garde, et c'est
  // la limite écrite de ce filtre.
  const corps = (pg.match(/`[^`]*`/g) || []).filter(q => /\b(select|insert|update|delete)\b/i.test(q))
    .join(' ')
    .replace(/\$\{[^}]*\}/g, ' ').replace(/'[^']*'/g, ' ');
  const SQL = new Set(['const', 'select', 'from', 'where', 'and', 'or', 'in', 'is', 'not', 'null',
    'insert', 'into', 'values', 'on', 'conflict', 'do', 'nothing', 'returning', 'update', 'set',
    'order', 'by', 'limit', 'count', 'sum', 'max', 'coalesce', 'filter', 'as', 'now',
    // `for update` : le verrou de ligne, premier verrou explicite du dépôt.
    'for',
    // Phase 04a : la requête de fenêtre du plafond. `join` parce qu'elle est la seule du fichier à
    // croiser deux tables, `any` parce que les comptes et les motifs lui arrivent en TABLEAUX —
    // `L.COMPTES_EXPOSITION` et `L.MOTIFS_EXPOSITION`, les mêmes listes que lit `expositionDe`, et
    // pas des littéraux recopiés dans le SQL.
    'join', 'any',
    'true', 'false']);
  // LES ALIAS DE LA REQUÊTE DE FENÊTRE, NOMMÉS PLUTÔT QUE GLISSÉS DANS LA LISTE DES MOTS SQL. Un
  // alias est un nom qu'on a choisi, pas un mot-clé : la garde doit dire lesquels elle accepte,
  // sinon la première colonne mal orthographiée passerait pour un alias. `e` est la sous-requête sur
  // `ledger_entries` — elle existe parce que l'expression de la référence nomme `motif` sans le
  // qualifier, et que `matches` porte aussi un `motif` —, `m` la table des billets, et `billet`
  // l'identifiant que cette expression calcule.
  const ALIAS = new Set(['e', 'm', 'billet']);
  const utilises = mots((listes + ' ' + corps).replace(/\bas\s+\w+/g, ' '));
  assert.ok(utilises.size > 20, `seulement ${utilises.size} identifiants retrouvés dans db-pg.js`);
  for (const mot of utilises)
    if (!SQL.has(mot) && !ALIAS.has(mot))
      assert.ok(schema.has(mot), `db-pg.js parle de « ${mot} », absent de schema.sql`);
});
test('aucun compteur nulle part, et l\'agrégat ne lit que les parties réglées', () => {
  // Le revirement se vérifie, il ne se raconte pas : un compteur qu'on incrémente est une case
  // qu'on écrase, et un double envoi la fausse pour toujours. La raison est dans
  // docs/HISTORIQUE.md, à sa place — une décision renversée, pas une ligne de module.
  const fs = require('node:fs'), path = require('node:path');
  for (const f of ['schema.sql', 'db-pg.js', 'app.js', 'README.md'])
    assert.ok(!/user_stats/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')),
      `${f} parle encore d'une table de compteurs`);
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.deepStrictEqual((sql.match(/create table if not exists (\w+)/g) || []).sort(),
    ['create table if not exists ledger_audit', 'create table if not exists ledger_entries',
     'create table if not exists match_traces',
     'create table if not exists matches', 'create table if not exists users']);
  // « Une partie refusée ou restée ouverte ne compte pour rien » se prouve plus haut contre la
  // doublure ; la vraie requête, elle, n'est jamais exécutée par un test. On relit donc son texte.
  // Les commentaires sont retirés d'abord : ils citent `count()` et `sum()` entre accents graves,
  // et une garde qui prend un commentaire pour une requête ne garde rien. C'est arrivé en
  // écrivant ce test, exactement comme au module précédent.
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  // La trace compte elle aussi ses lignes, et c'est un garde-fou de volume, pas une statistique de
  // joueur : on ne retient donc que ce qui agrège la table `matches`.
  const agregat = (pg.match(/`[^`]*`/g) || [])
    .filter(q => /\bcount\s*\(/i.test(q) && /from\s+matches\b/.test(q));
  assert.strictEqual(agregat.length, 1, 'une seule requête doit agréger les statistiques');
  assert.match(agregat[0], /from\s+matches/);
  assert.match(agregat[0], /status\s*=\s*'settled'/, 'l\'agrégat compterait des parties non réglées');
});

console.log('Le serveur partage les règles du jeu');
test('la garde de démarrage couvre TOUS les noms de WBCore qu\'app.js appelle', () => {
  // La garde ne listait que les quatre noms de la phase 01. La disparition de `zonePlan` ou de
  // `matchVerdict` — appelés seulement dans les gestionnaires — ne cassait donc plus au démarrage
  // mais à la première requête d'un joueur, en 500 : très exactement la panne que cette garde
  // existe pour empêcher. Même doctrine que les gardes textuelles sur schema.sql et db-pg.js, et
  // même mode de défaillance qu'elles attrapent — la dérive par oubli.
  const fs = require('node:fs'), path = require('node:path');
  const lire = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const app = lire('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const noyau = lire('core.js');
  const liste = noyau.slice(noyau.indexOf('const ATTENDUS'), noyau.indexOf('for (const nom of ATTENDUS)'));
  assert.ok(liste.length > 100, 'la liste de la garde n\'a pas été retrouvée dans core.js');
  const utilises = [...new Set((app.match(/\bC\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(2)))];
  assert.ok(utilises.length >= 12, `seulement ${utilises.length} noms de WBCore retrouvés dans app.js`);
  for (const nom of utilises)
    assert.ok(liste.includes(`'${nom}'`), `app.js appelle C.${nom}, que la garde de core.js ne couvre pas`);
});
test('WBCore est chargé depuis index.html, pas recopié', () => {
  assert.strictEqual(typeof C.nameKey, 'function');
  assert.strictEqual(C.nameKey('Loïc'), C.nameKey('LOIC'));
  assert.ok(C.BRAWLERS.bolt, 'les brawlers du jeu sont visibles côté serveur');
});
test('le jeu et le serveur désignent le même Crossmint, environnement par environnement', () => {
  // Deux adresses écrites à deux endroits finissent toujours par diverger. Le jeu déduit la sienne
  // du préfixe de sa clé « ck_ », le serveur de sa clé « sk_ » : ce test est le seul garde-fou.
  const { crossmintBaseUrl } = require('./crossmint-key');
  for (const env of ['development', 'staging', 'production'])
    assert.strictEqual(C.crossmintApi(`ck_${env}_abc`), crossmintBaseUrl(env), env);
});
test('le serveur exige le destinataire que le jeu ne peut pas choisir', () => {
  // Le jeu ne fabrique jamais de jeton : il reçoit celui de Crossmint et le transmet. L'identifiant
  // de projet qui sert de destinataire vient de la clé serveur, hors de portée du navigateur.
  const a = autorite();
  const cle = parseApiKey(fabriqueCle(a, { projectId: PROJET }), { usageOrigin: 'server', signers: a.signers });
  assert.strictEqual(cle.projectId, PROJET);
  assert.throws(() => identityFromClaims(revendications({ aud: 'un_projet_choisi_par_le_client' }),
    { projectId: cle.projectId }));
});

console.log('Le serveur charge la simulation du jeu, il ne la recopie pas');
// Le bloc SIM, chargé UNE SECONDE FOIS et à la façon du navigateur : son propre WBCore, extrait du
// même index.html, et le bloc évalué par-dessus. Ce n'est pas une doublure — c'est le même texte,
// dans un module qui ne partage rien avec `api/sim.js`. C'est ce qui permet de dire, et pas
// seulement d'affirmer, que le serveur et le jeu exécutent le même code.
const NAVIGATEUR = (() => {
  const fs = require('node:fs'), path = require('node:path');
  const f = process.env.WARBLOCK_FILE || path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(f, 'utf8');
  const noyau = html.slice(html.indexOf('/*CORE-START*/'), html.indexOf('/*CORE-END*/'));
  const bloc = html.slice(html.indexOf('/*SIM-START*/'), html.indexOf('/*SIM-END*/'));
  const mc = { exports: {} }; new Function('module', 'exports', noyau)(mc, mc.exports);
  const ms = { exports: {} }; new Function('module', 'exports', 'WBCore', bloc)(ms, ms.exports, mc.exports);
  return { C: mc.exports, S: ms.exports, html };
})();

// Une trace fabriquée par le codec de WBCore, jamais écrite à la main : c'est la seule porte, et
// l'écrire à la main ferait deux idées du format — c'est toujours la seconde qui ment.
function traceDe(C, pas, options = {}) {
  const rec = C.traceEnregistreur(options.max || 400000);
  const rng = C.makeRng(options.graine || 4242);
  for (let i = 0; i < pas; i++) {
    if (options.actes && i && i % options.actes === 0)
      rec.acte(C.TRACE.SUP, C.traceViseeMots(Math.cos(i), Math.sin(i), 4));
    const a = options.fixe ? 1 : rng() * Math.PI * 2;
    rec.ajouter(C.traceMots({ mx: Math.cos(a), mz: Math.sin(a), ax: Math.cos(a), az: Math.sin(a),
                              aimDist: options.fixe ? 4 : 3 + rng() * 4,
                              feu: options.fixe ? true : rng() < 0.7 }));
  }
  return rec;
}
// La même partie, rejouée par un couple (WBCore, WBSim) donné. Rien d'autre que la graine publique
// du billet et la trace des entrées du joueur n'entre ici : c'est exactement ce que le module
// suivant aura sous la main au moment de juger.
function empreinteDe(coeur, simu, texte) {
  const G = simu.newMatch(31337, coeur.MODES.solo, 50, coeur.BRAWLERS.bolt);
  const depart = { x: G.player.x, z: G.player.z };
  const lu = coeur.traceDecode(texte);
  assert.strictEqual(lu.erreur, null, 'la trace ne se relit pas : ' + lu.erreur);
  simu.rejouer(G, lu.items);
  return { empreinte: simu.empreinte(G), pas: G.pas,
           // De quoi dire que la partie a VÉCU, et pas seulement qu'elle a tourné : le brawler a
           // bougé, il a tiré, et le gaz s'est refermé sur lui.
           parcouru: Math.round(coeur.dist(G.player.x - depart.x, G.player.z - depart.z) * 100),
           morts: G.ents.filter(e => !e.alive).length,
           cercle: Math.round(G.zone.r * 100) };
}

test('api/sim.js charge le MÊME bloc que le navigateur, et il n\'en existe pas de seconde copie', () => {
  assert.strictEqual(typeof SIM.step, 'function');
  assert.strictEqual(SIM.SIM_VERSION, NAVIGATEUR.S.SIM_VERSION);
  // Le serveur ne redéfinit rien : le fichier n'est qu'un chargeur, calqué sur api/core.js. S'il
  // contenait une règle, elle serait la seconde copie — le patron du `respawn()` défini deux fois.
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'sim.js'), 'utf8');
  assert.match(src, /SIM-START/);
  assert.match(src, /new Function\('module', 'exports', 'WBCore'/);
  assert.ok(!/function (step|newMatch|moveEntity|attack|rejouer)\s*\(/.test(src),
    'api/sim.js redéfinit une fonction de simulation au lieu de charger le bloc');
});
test('LE REJEU DU SERVEUR ET CELUI DU JEU RENDENT LA MÊME EMPREINTE — c\'est le même bloc, chargé deux fois', () => {
  // L'invariant central de la phase, et la raison est dans le titre : il n'y a pas deux
  // simulations à réconcilier, il y a un bloc de texte dans index.html que deux chargeurs évaluent.
  // Ce que ce test prouve, c'est que le chargeur du serveur n'a rien perdu en route — pas que deux
  // MOTEURS JavaScript s'accordent, ce que rien ici ne peut montrer et que la spécification se
  // garde bien de promettre.
  const texte = traceDe(C, 4000, { actes: 137 }).texte();
  const serveur = empreinteDe(C, SIM, texte);
  const navigateur = empreinteDe(NAVIGATEUR.C, NAVIGATEUR.S, texte);
  // Le compte à rebours d'intro est posé par `newMatch` des DEUX côtés, et il consomme ses pas sans
  // faire avancer `G.pas` : c'est exactement ce que le serveur doit reposer, sinon il rejouerait
  // ces pas-là pour de vrai et jugerait une autre partie que celle qui s'est affichée.
  assert.strictEqual(serveur.pas, 4000 - PAS_INTRO);
  assert.ok(PAS_INTRO > 0, 'le décompte d\'intro a disparu de newMatch : le rejeu du serveur dérive');
  assert.deepStrictEqual(serveur, navigateur, 'les deux chargements ne rejouent pas la même partie');
  // Et la partie rejouée a VÉCU : sans ces bornes, deux parties vides rendraient aussi la même
  // empreinte, et le test passerait sur un bloc à moitié chargé.
  assert.ok(serveur.parcouru > 100, 'le brawler du rejeu n\'a pas bougé d\'une case');
  assert.ok(serveur.morts > 0, 'personne n\'est mort en 4000 pas : la simulation ne tourne pas');
  // La trace est bien le chaînon manquant : la même graine, sans elle, ne rejoue pas la même partie.
  const immobile = SIM.newMatch(31337, C.MODES.solo, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < 4000; i++) SIM.step(immobile, {});
  assert.notStrictEqual(SIM.empreinte(immobile), serveur.empreinte,
    'un joueur immobile rend la même partie qu\'un joueur qui joue : la trace ne sert à rien');
});
test('la garde de démarrage d\'api/sim.js casse BRUYAMMENT si un nom exporté disparaît', () => {
  // La même garde que celle de core.js, et pour la même raison : si le bloc change de forme, on veut
  // casser au démarrage du serveur, pas à la première requête d'un joueur un dimanche soir. On le
  // vérifie en amputant vraiment le bloc, pas en relisant la liste — une liste est toujours
  // d'accord avec ce qu'on veut lui faire dire.
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const ampute = NAVIGATEUR.html.replace('newMatch, step, drainer,', 'step, drainer,');
  assert.notStrictEqual(ampute, NAVIGATEUR.html, 'la ligne d\'export du bloc SIM n\'a pas été retrouvée');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'warblock-'));
  const tmp = path.join(dossier, 'index.html');
  fs.writeFileSync(tmp, ampute);
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', 'require("./sim.js")'],
    { env: { ...process.env, WARBLOCK_FILE: tmp }, cwd: __dirname, encoding: 'utf8' });
  fs.rmSync(dossier, { recursive: true, force: true });
  assert.notStrictEqual(r.status, 0, 'un export disparu doit faire échouer le chargement');
  assert.match(r.stderr, /WBSim n'exporte plus newMatch/, r.stderr);
});
test('la garde d\'api/sim.js couvre TOUS les noms de WBSim qu\'app.js appelle', () => {
  // Le patron déjà en place pour core.js : une garde qui ne couvre pas ce que les gestionnaires
  // consomment déplace la panne du démarrage vers la première requête d'un joueur.
  const fs = require('node:fs'), path = require('node:path');
  const lire = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const app = lire('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const src = lire('sim.js');
  const liste = src.slice(src.indexOf('const ATTENDUS'), src.indexOf('for (const nom of ATTENDUS)'));
  assert.ok(liste.length > 40, 'la liste de la garde n\'a pas été retrouvée dans sim.js');
  const utilises = [...new Set((app.match(/\bS\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(2)))];
  assert.ok(utilises.length >= 1, 'app.js n\'appelle aucun nom de WBSim : la garde ne garde rien');
  for (const nom of utilises)
    assert.ok(liste.includes(`'${nom}'`), `app.js appelle S.${nom}, que la garde de sim.js ne couvre pas`);
  // Et le contrat public du bloc y figure en entier : c'est lui que le module du rejeu consommera.
  for (const nom of ['SIM_VERSION', 'newMatch', 'step', 'empreinte', 'rejouer', 'appliquerActe'])
    assert.ok(liste.includes(`'${nom}'`), `le contrat public de WBSim ne couvre pas ${nom}`);
});

console.log('sim_version, figée à l\'ouverture du billet');
await test('sim_version est écrite par le SERVEUR, et un corps qui la porte n\'y change rien', async () => {
  // Le patron déjà éprouvé sur les graines et les sièges : deux bancs, mêmes horloge et mêmes
  // sources, et deux lignes qui doivent être indiscernables. La raison est celle de `seats` et de
  // `team_size` : un correctif de simulation déployé pendant qu'un joueur joue rejouerait une AUTRE
  // partie que la sienne, et paierait autre chose que ce qu'il a vu.
  const nu = bancDeBillet(), charge = bancDeBillet();
  const a = await demander(nu.app, DEMANDE);
  const b = await demander(charge.app, { ...DEMANDE, simVersion: 999, sim_version: 999, simversion: 999 });
  assert.strictEqual(nu.db.matches[0].sim_version, SIM.SIM_VERSION);
  assert.deepStrictEqual(charge.db.matches, nu.db.matches, 'le client a écrit la version de simulation');
  assert.deepStrictEqual(b.corps, a.corps);
  // Elle ne part PAS au client : il n'en a rien à faire, et la lui donner l'inviterait à la renvoyer
  // telle quelle au lieu de dire celle sous laquelle il a réellement joué.
  assert.ok(!('simVersion' in a.corps), JSON.stringify(a.corps));
  assert.ok(Number.isInteger(SIM.SIM_VERSION) && SIM.SIM_VERSION >= 1);
});

console.log('paid_seats, figée à l\'ouverture et DORMANTE');
await test('paid_seats vaut UN, et le chemin `repris` ne la réécrit JAMAIS', async () => {
  // Le chemin `repris` est celui qui rend un billet déjà ouvert — rejeu de la clé du client, ou
  // onglet rouvert. Il ne doit rien réécrire du tout, et c'est le même raisonnement que « il
  // n'écrit jamais une seconde mise » : ce qui a été figé à l'ouverture l'est pour de bon.
  //
  // La preuve demande une valeur DISCERNABLE. On pose donc, à la main et dans la doublure, une
  // valeur parfaitement légale mais différente de celle que le serveur écrit — trois sièges payés
  // sur vingt — puis on rejoue la demande en annonçant sept. Si le chemin `repris` réécrivait quoi
  // que ce soit, la ligne rendrait 1 ou 7, et jamais 3.
  const { db, app } = bancDeBillet();
  const a = await demander(app, DEMANDE);
  assert.strictEqual(db.matches[0].paid_seats, 1);
  assert.strictEqual(db.matches.length, 1);
  db.matches[0].paid_seats = 3;

  // (1) le rejeu de la MÊME clé de client.
  const b = await demander(app, { ...DEMANDE, paidSeats: 7 });
  assert.strictEqual(b.code, 200);
  assert.strictEqual(b.corps.repris, true, 'ce n\'est pas le chemin `repris` qu\'on éprouve');
  assert.strictEqual(b.corps.id, a.corps.id);
  assert.strictEqual(db.matches[0].paid_seats, 3, 'le chemin `repris` a réécrit paid_seats');

  // (2) le billet DÉJÀ OUVERT, repris sous une autre clé de client : l'autre porte du même chemin.
  const c = await demander(app, { ...DEMANDE, clientKey: 'cle-2', paidSeats: 7 });
  assert.strictEqual(c.corps.repris, true);
  assert.strictEqual(c.corps.id, a.corps.id);
  assert.strictEqual(db.matches.length, 1, 'un joueur n\'a qu\'un billet ouvert à la fois');
  assert.strictEqual(db.matches[0].paid_seats, 3, 'le billet déjà ouvert a été réécrit');
});
await test('GARDE TEXTUELLE : la contrainte de paid_seats est `between 1 and seats` dans schema.sql', () => {
  // Deux écritures de la même règle se confrontent, elles ne se font pas confiance — même patron
  // que la grammaire des comptes et la liste des motifs du grand livre, comparées au TEXTE du
  // schéma. Ici il n'y a pas d'expression exportée à comparer : la règle n'existe QUE dans le
  // schéma, et ce qu'on garde est qu'elle y est toujours, entière, et nommée.
  const fs = require('node:fs'), path = require('node:path');
  const brut = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const sql = brut.replace(/--[^\n]*/g, '');
  const bloc = sql.slice(sql.indexOf('create table if not exists matches'),
                         sql.indexOf('create unique index if not exists matches_client_key_uniq'));
  assert.ok(bloc.length > 500, 'la table des billets n\'a pas été retrouvée');
  const decl = (bloc.match(/^[ \t]*paid_seats\b.*$/m) || [])[0];
  assert.ok(decl, 'la colonne paid_seats a disparu de matches');
  assert.match(decl, /\binteger\b/, decl);
  assert.match(decl, /\bnot null\b/, decl);
  // La borne, caractère pour caractère. `between 1 and seats` et pas `>= 1` : on ne paie pas moins
  // d'un siège, et jamais plus qu'il n'y en a sur la table.
  assert.match(bloc, /constraint matches_paid_seats_borne check \(paid_seats between 1 and seats\)/,
    'la borne de paid_seats a changé de forme ou de nom');
  // Le nom est celui que `api/db-check.js` attend d'un refus : une contrainte anonyme rendrait le
  // refus illisible, et le cas de db-check ne saurait plus dire QUI a refusé.
  assert.ok(fs.readFileSync(path.join(__dirname, 'db-check.js'), 'utf8')
    .includes('matches_paid_seats_borne'),
    'db-check.js n\'éprouve plus la borne : une doublure ne peut que l\'imiter');
  // ET LA RAISON EST ÉCRITE AU-DESSUS DE LA COLONNE. Une colonne dormante dont personne ne relit le
  // motif se fait inventer un lecteur au module suivant — c'est très exactement ce qu'il ne faut
  // pas faire ici, et le dossier l'a déjà tranché à propos de `seed_secret`.
  const i = brut.indexOf('paid_seats   integer');
  assert.ok(i > 0);
  const raison = brut.slice(brut.lastIndexOf('-- COMBIEN DE SIÈGES', i), i);
  assert.ok(raison.length > 200, 'le commentaire de paid_seats a disparu');
  assert.match(raison, /DORMANTE/, 'la colonne ne s\'annonce plus dormante');
  assert.match(raison, /APRÈS COUP/, 'la raison — la donnée est irrécupérable — n\'est plus écrite');
  assert.match(raison, /NOTIONNEL/, 'le lecteur qu\'il ne faut PAS lui inventer n\'est plus nommé');
  // Et elle est écrite UNE FOIS dans le routeur, au seul endroit qui fige les colonnes du billet.
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.strictEqual((app.match(/paidSeats/g) || []).length, 1,
    'paid_seats a plus d\'un point d\'écriture dans app.js');
  assert.ok(!/paid_seats/.test(app), 'app.js parle de la colonne en dehors du pilote');
});

console.log('La trace, en insertion seule');
const MAX_PAS = C.traceMaxSteps(C.zonePlan(GRAINES[0], C.MODES.solo));
const TEXTE = traceDe(C, 400).texte();
const envoyerTrace = (app, id, corps, opts = {}) =>
  appel(app, { method: 'POST', path: `/api/match/${id}/trace`, token: 'ok:u1:Loic', body: corps, ...opts });
const SEGMENT = (extra = {}) => ({ seq: 0, simVersion: SIM.SIM_VERSION, data: TEXTE, ...extra });

await test('un segment est accepté, et le serveur COMPTE ses pas au lieu de les croire', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  // Un nombre de pas annoncé n'a aucun effet : il n'est même pas lu. Le serveur relit la grammaire,
  // ce qui valide le segment et en donne la longueur du même coup — un nombre déclaré aurait été un
  // nombre de plus à ne pas croire.
  const r = await envoyerTrace(app, b.corps.id, SEGMENT({ steps: 999999, totalSteps: 1 }));
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.deepStrictEqual(r.corps, { matchId: b.corps.id, seq: 0, segments: 1, totalSteps: 400 });
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].steps, 400);
  assert.strictEqual(db.traces[0].sim_version, SIM.SIM_VERSION);
  assert.strictEqual(db.traces[0].data, TEXTE);
  // Et la ligne du billet n'a pas bougé d'un octet : cette route n'écrit jamais dans `matches`.
  assert.strictEqual(db.matches[0].status, 'open');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
await test('IDEMPOTENCE : le même segment deux fois n\'écrit qu\'une ligne, et le PREMIER écrit gagne', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const un = await envoyerTrace(app, b.corps.id, SEGMENT());
  const lignes = JSON.stringify(db.traces);
  const deux = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.deepStrictEqual(deux.corps, un.corps, 'un rejeu doit rendre exactement la première réponse');
  assert.strictEqual(JSON.stringify(db.traces), lignes, 'la table a bougé au rejeu');
  // Et un segment DIFFÉRENT sous le même rang ne remplace rien : premier écrit gagne. Sans cela, un
  // client pourrait réécrire sa trace après coup, ce qui la viderait de toute valeur de preuve.
  //
  // IL EST DÉSORMAIS REFUSÉ, ET NOMMÉ, au lieu d'être avalé en silence. Avalé, il permettait de
  // COUDRE deux parties bout à bout : le segment 0 d'une tentative et les segments suivants d'une
  // autre se recollaient en une partie que personne n'a jouée, et le serveur écrivait un montant
  // dessus. Le premier écrit gagne toujours — la ligne posée ne bouge pas d'un caractère — mais le
  // client apprend enfin que son segment n'a pas été pris.
  const menteur = await envoyerTrace(app, b.corps.id, SEGMENT({ data: traceDe(C, 120, { graine: 9 }).texte() }));
  assert.strictEqual(menteur.code, 409, JSON.stringify(menteur.corps));
  assert.strictEqual(menteur.corps.code, 'trace_divergente');
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].data, TEXTE, 'la première trace a été réécrite');
  assert.strictEqual(db.traces[0].steps, 400);
});
await test('UN SEGMENT D\'ACTES SEULS EST ACCEPTÉ : sans lui, l\'acte terminal n\'arrive jamais', async () => {
  // LE DÉFAUT. La route refusait tout segment dont le décompte de pas était nul (`!lu.pas`). Or le
  // découpage coupe au JETON, et un jeton d'action ponctuelle ne compte aucun pas : quand la
  // frontière des 24 000 caractères tombe juste avant le dernier geste, le segment de queue ne
  // porte que l'abandon ou l'encaissement. L'envoi s'arrêtant au premier refus, l'acte terminal
  // n'arrivait jamais, le rejeu s'arrêtait avant la fin et la route répondait `non_terminal` :
  // aucun montant, billet laissé au veilleur, sur une partie parfaitement honnête.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  // Une vraie partie qui se termine par un encaissement, découpée À LA MAIN sur la frontière : le
  // dernier jeton part seul, exactement comme `segments()` le ferait si la coupe tombait là.
  const p = partieDe(b, { encaisser: 300 });
  const texte = p.segments.join('');
  const coupe = texte.lastIndexOf('!');
  assert.ok(coupe > 0, 'la partie du test ne finit pas sur un jeton d\'acte');
  const plein = texte.slice(0, coupe), queue = texte.slice(coupe);
  assert.strictEqual(C.traceDecode(queue).pas, 0, 'le segment de queue porte des pas : le cas n\'est pas celui-là');

  const un = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: plein });
  assert.strictEqual(un.code, 200, JSON.stringify(un.corps));
  const deux = await envoyerTrace(app, b.corps.id, { seq: 1, simVersion: SIM.SIM_VERSION, data: queue });
  assert.strictEqual(deux.code, 200, JSON.stringify(deux.corps));
  assert.strictEqual(db.traces[1].steps, 0, 'la ligne doit s\'écrire avec zéro pas, et la colonne l\'accepter');
  assert.strictEqual(deux.corps.totalSteps, p.pas);

  // ET LE RÈGLEMENT ATTEINT BIEN UN ÉTAT TERMINAL. C'est la conséquence, et c'est elle qui compte :
  // sans le second segment, le rejeu s'arrêtait avant l'encaissement et refusait en `non_terminal`.
  horloge.t = ARRIVEE(p.rapport);
  const r = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                               token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.issue, 'encaissement');
  assert.ok(r.corps.netCents > 0, 'la partie n\'a rien payé');
  // La contre-épreuve : le même dossier SANS la queue ne se règle pas, et le refus se nomme.
  const sans = bancDeBillet();
  const b2 = await demander(sans.app, { ...DEMANDE, mode: 'resurgence' });
  await envoyerTrace(sans.app, b2.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: plein });
  sans.horloge.t = Date.parse(b2.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000;
  const rr = await appel(sans.app, { method: 'POST', path: `/api/match/${b2.corps.id}/result`,
                                     token: 'ok:u1:Loic', body: p.rapport });
  assert.strictEqual(rr.code, 409, JSON.stringify(rr.corps));
  assert.strictEqual(rr.corps.code, 'non_terminal');
});
await test('DEUX TENTATIVES NE SE COUSENT PAS : un rang déjà posé qui change de données est refusé', async () => {
  // La seconde moitié du même défaut, et la plus vicieuse parce qu'elle arrive sans mauvaise
  // volonté : le premier segment passe, le second échoue, la tentative suivante renvoie son seq 0
  // que `on conflict do nothing` avalait en silence, et ses segments 1..n s'ajoutaient derrière le
  // segment 0 de la tentative précédente. Le serveur rejouait alors une partie RECOLLÉE de deux
  // parties différentes — soit `non_terminal` pour toujours, soit un montant écrit sur une partie
  // que personne n'a jouée.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const A = [traceDe(C, 400).texte(), traceDe(C, 300, { graine: 11 }).texte()];
  const B = [traceDe(C, 400, { graine: 22 }).texte(), traceDe(C, 300, { graine: 33 }).texte()];
  assert.notStrictEqual(A[0], B[0]);
  assert.strictEqual((await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: A[0] })).code, 200);
  // La tentative suivante repart de son propre seq 0 : c'est là que la couture se ferait.
  const collision = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: B[0] });
  assert.strictEqual(collision.code, 409, JSON.stringify(collision.corps));
  assert.strictEqual(collision.corps.code, 'trace_divergente');
  // Le premier écrit gagne toujours — la ligne posée n'a pas bougé d'un caractère — mais le client
  // l'apprend, et son envoi s'arrête là au lieu de coudre la suite derrière.
  assert.strictEqual(db.traces.length, 1);
  assert.strictEqual(db.traces[0].data, A[0]);
  // Renvoyer le MÊME segment reste parfaitement idempotent : c'est la même tentative.
  assert.strictEqual((await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: A[0] })).code, 200);
  assert.strictEqual(db.traces.length, 1);
  // Et la trace refusée n'a rien touché du billet : cette route n'écrit jamais dans `matches`.
  assert.strictEqual(db.matches[0].status, 'open');
});
await test('une partie complète tient en UN À TROIS segments, qui se recollent et s\'additionnent', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const rec = traceDe(C, 9000, { actes: 500 });
  const segs = rec.segments();
  assert.ok(segs.length >= 1 && segs.length <= 3, `${segs.length} segments pour une partie complète`);
  let dernier = null;
  for (let i = 0; i < segs.length; i++) {
    dernier = await envoyerTrace(app, b.corps.id, { seq: i, simVersion: SIM.SIM_VERSION, data: segs[i] });
    assert.strictEqual(dernier.code, 200, JSON.stringify(dernier.corps));
  }
  assert.strictEqual(dernier.corps.segments, segs.length);
  assert.strictEqual(dernier.corps.totalSteps, 9000);
  // Recollés dans l'ordre des rangs, ils rendent la trace entière — celle que le rejeu relira.
  const recolle = db.traces.slice().sort((x, y) => x.seq - y.seq).map(t => t.data).join('');
  assert.strictEqual(recolle, rec.texte());
  assert.strictEqual(C.traceDecode(recolle).pas, 9000);
});
await test('chaque refus a un CODE NOMMÉ, sort en 400 ou 409, et ne laisse jamais la ligne bloquée', async () => {
  // La leçon du `22003`, transposée à la trace : un joueur n'a qu'un billet ouvert à la fois, donc
  // un 500 qui laisse la ligne `open` l'enferme jusqu'à l'expiration. Ici c'est structurel — cette
  // route n'écrit jamais dans `matches` — et chaque refus se nomme.
  // Un seau large : ce test envoie une vingtaine de requêtes, et ce n'est pas la limitation de
  // débit qu'il éprouve — elle a le sien, juste en dessous.
  const { db, app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 100, windowMs: 60_000 }) });
  const b = await demander(app);
  const cas = [
    ['corps',       '{ pas du json',                                   400],
    ['corps',       { ...SEGMENT(), data: 'A'.repeat(40 * 1024) },     400],
    ['seq',         SEGMENT({ seq: -1 }),                              400],
    ['seq',         SEGMENT({ seq: C.TRACE.MAX_SEG }),                 400],
    ['seq',         SEGMENT({ seq: 1.5 }),                             400],
    ['seq',         SEGMENT({ seq: '0' }),                             400],
    ['sim_version', SEGMENT({ simVersion: SIM.SIM_VERSION + 1 }),      409],
    ['sim_version', SEGMENT({ simVersion: undefined }),                409],
    ['donnees',     SEGMENT({ data: 'pas une trace du tout' }),        400],
    ['donnees',     SEGMENT({ data: '' }),                             400],
    ['donnees',     SEGMENT({ data: 42 }),                             400],
    ['trop_de_pas', SEGMENT({ data: traceDe(C, 40).texte() + '~___' }), 400],
  ];
  for (const [code, corps, attendu] of cas) {
    const r = await envoyerTrace(app, b.corps.id, corps);
    assert.strictEqual(r.code, attendu, `${code} : reçu ${r.code} — ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, code, JSON.stringify(r.corps));
    assert.ok(r.corps.erreur && r.corps.erreur.length > 8, `${code} : un refus doit dire pourquoi`);
    assert.strictEqual(db.traces.length, 0, `${code} : une trace refusée a été écrite`);
    assert.strictEqual(db.matches[0].status, 'open', `${code} : la ligne du billet a été touchée`);
  }
  // Un billet qui n'est pas le sien, ou qui n'existe pas : 404, et rien n'est appris de personne.
  const voisin = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/trace`,
                                    token: 'ok:u2:Zoe', body: SEGMENT() });
  assert.strictEqual(voisin.code, 404);
  assert.strictEqual((await envoyerTrace(app, '999999', SEGMENT())).code, 404);
  // Un billet déjà réglé n'accepte plus rien : la partie a son verdict, une trace n'y changerait
  // rien. Il faut donc le régler pour de bon, c'est-à-dire jouer — et la trace de CETTE partie-là
  // est retirée avant de vérifier qu'un segment de plus ne s'écrit pas.
  await jouerEtRendre(app, horloge, b);
  db.traces.length = 0;
  const clos = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.strictEqual(clos.code, 409);
  assert.strictEqual(clos.corps.code, 'billet_clos');
  assert.strictEqual(db.traces.length, 0);
  // Et un billet périmé non plus — sans être clos par cette route, qui ne touche pas `matches` : le
  // veilleur de la 02a fait déjà ce travail, et un second endroit qui clôt une ligne serait un
  // second endroit à surveiller.
  const suite = bancDeBillet();
  const c = await demander(suite.app, { ...DEMANDE, clientKey: 'cle-x' });
  suite.horloge.t = Date.parse(c.corps.expiresAt) + 1;
  const perime = await envoyerTrace(suite.app, c.corps.id, SEGMENT());
  assert.strictEqual(perime.code, 409);
  assert.strictEqual(perime.corps.code, 'expire');
  assert.strictEqual(suite.db.matches[0].status, 'open', 'la route de trace a écrit dans matches');
});
await test('la borne de pas vient du PLAN DE ZONE du billet, et le total la respecte', async () => {
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  // Une trace longue mais compressible — un joueur qui ne change pas de geste — pour éprouver la
  // borne de PAS et non celle du corps : les deux existent, elles ne disent pas la même chose.
  const gros = traceDe(C, MAX_PAS - 10, { fixe: true });
  const un = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: gros.texte() });
  assert.strictEqual(un.code, 200, JSON.stringify(un.corps));
  assert.strictEqual(un.corps.totalSteps, MAX_PAS - 10);
  const trop = await envoyerTrace(app, b.corps.id,
    { seq: 1, simVersion: SIM.SIM_VERSION, data: traceDe(C, 100, { graine: 3 }).texte() });
  assert.strictEqual(trop.code, 400);
  assert.strictEqual(trop.corps.code, 'trop_de_pas');
  assert.strictEqual(db.traces.length, 1, 'le segment de trop a été écrit quand même');
  assert.strictEqual(db.matches[0].status, 'open');
  // Le rejeu d'un segment DÉJÀ écrit reste accepté même à la borne : sinon une réponse perdue
  // enfermerait le joueur, ce que toute cette route existe pour éviter.
  const rejeu = await envoyerTrace(app, b.corps.id, { seq: 0, simVersion: SIM.SIM_VERSION, data: gros.texte() });
  assert.deepStrictEqual(rejeu.corps, un.corps);
  assert.strictEqual(db.traces.length, 1);
});
await test('MAX_BODY vaut toujours 4 Ko partout, et la borne large ne vaut QUE sur la trace', async () => {
  // La route qui décide d'un règlement garde sa borne. Relever celle de tout le monde ferait de la
  // route de l'argent la surface d'attaque la plus large de l'API, et « la raison est écrite » n'est
  // pas une protection. La garde est double : le chiffre, et un gros corps qui passe sur la trace
  // et sur elle seule.
  const { MAX_BODY, MAX_TRACE_BODY } = require('./app');
  assert.strictEqual(MAX_BODY, 4 * 1024);
  assert.ok(MAX_TRACE_BODY > MAX_BODY);
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.match(src, /const MAX_BODY = 4 \* 1024;/);
  // `lireCorps` prend sa borne en ARGUMENT, et un seul appel la relève : celui de la trace.
  const larges = (src.match(/lireCorps\(req[^)]*\)/g) || []).filter(a => a.includes('MAX_TRACE_BODY'));
  assert.strictEqual(larges.length, 1, 'plus d\'une route lit un corps large : ' + larges.join(' | '));
  const { app } = bancDeBillet();
  const b = await demander(app);
  // Le même corps de huit kilo-octets : refusé sur le profil, LU sur la trace — où il est refusé sur
  // le fond et non sur la taille, ce qui prouve qu'il est bien arrivé jusqu'à la lecture.
  const bourre = 'x'.repeat(8 * 1024);
  const profil = await appel(app, { method: 'PATCH', token: 'ok:u1:Loic', body: { name: bourre } });
  assert.strictEqual(profil.code, 400);
  const trace = await envoyerTrace(app, b.corps.id, SEGMENT({ data: bourre }));
  assert.strictEqual(trace.corps.code, 'donnees', 'un corps de 8 Ko doit atteindre la route de trace');
});
test('match_traces : aucun update, et LE SEUL delete est la purge nommée, dont la clause porte les QUATRE conditions', () => {
  // CE TEST A CHANGÉ DE FORME EN PHASE 03, ET IL FAUT LE DIRE PLUTÔT QUE DE LE LAISSER GLISSER. Il
  // interdisait tout `delete from match_traces`, et il passait. La politique de conservation en
  // ouvre un — le PREMIER `delete` du dépôt sur la pièce qui prouve un paiement — donc la garde
  // s'affaiblit forcément. Une garde qu'on affaiblit sans le dire est très exactement l'écart que la
  // recette de la 02b a trouvé : on écrit donc ce qu'elle ne garde plus (« aucun delete ») et ce
  // qu'elle garde à la place, qui est plus étroit — UN seul delete, nommé, et sa clause porte les
  // quatre conditions.
  //
  // Aucune base ne tourne, donc c'est tout ce qu'on peut prouver ici : un test qui passe contre la
  // doublure prouve la doublure, pas Postgres. Le comportement des quatre conditions s'éprouve
  // séparément, condition par condition, contre la doublure.
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const pg = fs.readFileSync(path.join(__dirname, 'db-pg.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.match(sql, /create table if not exists match_traces/);
  assert.match(sql, /primary key \(match_id, seq\)/, 'la clé qui arbitre le premier-écrit-gagne a disparu');
  const suppressions = [];
  for (const q of (pg.match(/`[^`]*`/g) || [])) {
    if (!/match_traces/.test(q)) continue;
    // L'insertion seule tient encore sur la modification : une trace ne se RÉÉCRIT jamais, premier
    // écrit gagne, et ça n'a pas bougé d'un octet.
    assert.ok(!/\bupdate\s+match_traces\b/i.test(q), 'un update vise match_traces : ' + q);
    if (/\bdelete\s+from\s+match_traces\b/i.test(q)) suppressions.push(q);
  }
  assert.strictEqual(suppressions.length, 1,
    `${suppressions.length} suppressions de traces dans db-pg.js : il ne doit y en avoir qu'UNE, la purge nommée`);
  const purge = suppressions[0];
  // (a) la ligne `matches` est réglée DÉFINITIVEMENT. Ni `expired`, ni `abandoned`, ni `renounced`,
  // ni `open` : une partie que personne n'a jugée garde sa pièce.
  assert.match(purge, /status in \('settled', 'rejected'\)/,
    'la purge n\'exige plus une ligne réglée définitivement : ' + purge);
  // (b) le grand livre a POSÉ SON ÉCRITURE sur cette partie. La liste des motifs qui soldent un
  // billet vit dans `api/ledger.js` : on confronte les deux écritures plutôt que de les croire.
  const motifs = purge.match(/motif in \(([^)]*)\)/);
  assert.ok(motifs, 'la purge n\'exige plus une écriture du grand livre : ' + purge);
  assert.deepStrictEqual((motifs[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)),
    L.MOTIFS_REGLEMENT.slice(),
    'la clause de la purge et api/ledger.js ne s\'accordent pas sur ce qui solde un billet');
  assert.match(purge, /exists \(select 1 from ledger_entries/, purge);
  // (c) RIEN N'EST EN ATTENTE : le séquestre de cette partie est à zéro. La somme n'est pas
  // recopiée, elle vient de `soldeExpr`, la même que celle de `ledgerSolde`.
  assert.match(purge, /soldeExpr\(enjeu\)/, 'la purge ne regarde plus le séquestre : ' + purge);
  assert.match(purge, /\)\s*=\s*0/, 'la purge n\'exige plus un séquestre vide : ' + purge);
  // Le compte du séquestre est nommé une fois, en SQL, et rien de ce qui y entre ne vient d'une
  // requête HTTP : c'est l'identifiant de la ligne `matches` qu'on est en train de lire.
  assert.ok(pg.includes('const enjeu = "\'enjeu:\' || matches.id"'),
    'le compte du séquestre de la purge a changé de forme : ' + purge);
  // (d) LE DÉLAI EST ÉCOULÉ.
  assert.match(purge, /settled_at\s*<\s*\$1/, 'la purge n\'exige plus le délai de rétention : ' + purge);
  // ET ELLE NE TOUCHE NI `matches` NI LE GRAND LIVRE : elle les LIT. Un `delete` ou un `update` sur
  // l'une de ces deux tables dans la même instruction serait une purge qui efface une preuve.
  assert.ok(!/\b(delete\s+from|update)\s+(matches|ledger_entries)\b/i.test(purge), purge);
  // La rétention est une constante NOMMÉE, avec sa raison écrite à côté d'elle, et jamais un nombre
  // de jours écrit dans la requête.
  assert.ok(Number.isInteger(L.TRACE_RETENTION_JOURS) && L.TRACE_RETENTION_JOURS > 0,
    'TRACE_RETENTION_JOURS doit être un nombre de jours entier');
  assert.ok(pg.includes('L.TRACE_RETENTION_JOURS'),
    'la purge n\'utilise pas la constante de rétention : un délai en dur ne se relit pas');
  const ledgerSrc = fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');
  const i = ledgerSrc.indexOf('const TRACE_RETENTION_JOURS');
  const raison = ledgerSrc.slice(ledgerSrc.lastIndexOf('// ---------- La conservation', i), i);
  assert.match(raison, /pièce justificative/i, 'la raison de la rétention n\'est plus écrite à côté d\'elle');
  assert.match(raison, /phase 06/, 'la rétention doit dire qui la fixera vraiment');
  assert.match(raison, /juridique/i, 'la rétention doit dire qu\'elle n\'est PAS une décision juridique');
  // L'insertion, elle, porte `on conflict do nothing` : c'est la BASE qui arbitre l'idempotence,
  // jamais un `select` préalable — même doctrine que `name_key`.
  const inserts = (pg.match(/`[^`]*`/g) || []).filter(q => /insert into match_traces/i.test(q));
  assert.strictEqual(inserts.length, 1, 'une seule insertion de trace');
  assert.match(inserts[0], /on conflict do nothing/);
  // Et la route de trace n'écrit JAMAIS dans `matches` : c'est ce qui fait qu'une trace refusée ne
  // peut pas laisser un billet bloqué, quoi qu'il arrive.
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const route = app.slice(app.indexOf('async function recevoirTrace'), app.indexOf('async function rendreResultat'));
  assert.ok(route.length > 800, 'la route de trace n\'a pas été retrouvée');
  for (const ecriture of ['db.settleMatch', 'db.createMatch', 'db.expireMatches'])
    assert.ok(!route.includes(ecriture), `la route de trace appelle ${ecriture}`);
});
await test('des totaux rendus en chaînes par la base ressortent en nombres', async () => {
  // Le même piège de pilote que les graines et les statistiques : `count()` et `sum()` rendent un
  // `bigint`, donc une CHAÎNE. Un total parti en texte ne se verrait qu'à l'écran, longtemps après.
  const { db, app } = bancDeBillet();
  const b = await demander(app);
  const brute = db.addTrace;
  db.addTrace = async a => {
    const r = await brute(a);
    return { ...r, segments: String(r.segments), totalSteps: String(r.totalSteps) };
  };
  const r = await envoyerTrace(app, b.corps.id, SEGMENT());
  assert.strictEqual(typeof r.corps.segments, 'number');
  assert.strictEqual(typeof r.corps.totalSteps, 'number');
  assert.strictEqual(r.corps.totalSteps, 400);
});
await test('la doublure refuse ce que la colonne de trace refuserait', async () => {
  // La doublure ment comme le vrai pilote, ici comme ailleurs : `seq` et `steps` sont des `integer`,
  // `data` porte une borne de longueur. Sans cela, aucun test ne pourrait voir la classe de panne du
  // `22003` sur cette table-là.
  const { db } = bancDeBillet();
  await assert.rejects(() => db.addTrace({ matchId: '1', seq: 0, simVersion: 1,
    steps: 3_000_000_000, data: 'AAAAA', maxSteps: 1e12 }), e => e.code === '22003');
  await assert.rejects(() => db.addTrace({ matchId: '1', seq: 0, simVersion: 1,
    steps: 1, data: 'A'.repeat(70000), maxSteps: 1e12 }), e => e.code === '23514');
  assert.strictEqual(db.traces.length, 0, 'une écriture refusée ne doit rien laisser derrière');
});
await test('la trace a son propre seau de débit, son propre pré-vol, et sa seule méthode', async () => {
  const { app } = bancDeBillet({ limiter: makeLimiter({ max: 2, windowMs: 60_000 }) });
  const b = await demander(app);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await envoyerTrace(app, b.corps.id, SEGMENT({ seq: i }))).code);
  assert.deepStrictEqual(codes, [200, 200, 429], codes.join(','));
  // Marteler la trace ne doit pas empêcher de rendre son résultat : les seaux sont séparés.
  const r = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                               token: 'ok:u1:Loic', body: {} });
  assert.notStrictEqual(r.code, 429);
  for (const m of ['GET', 'PATCH', 'DELETE'])
    assert.strictEqual((await appel(app, { method: m, path: '/api/match/1/trace', token: 'ok:u1:Loic' })).code, 405, m);
  for (const chemin of ['/api/match//trace', '/api/match/abc/trace', '/api/match/1/trace/x'])
    assert.strictEqual((await appel(app, { method: 'POST', path: chemin, token: 'ok:u1:Loic' })).code, 404, chemin);
  // Sans jeton, rien ne passe : le refus vient avant la lecture du corps.
  assert.strictEqual((await appel(app, { method: 'POST', path: '/api/match/1/trace' })).code, 401);
  // Et le pré-vol annonce la route sans que personne ait eu à réécrire la liste des méthodes.
  const pre = await appel(app, { method: 'OPTIONS' });
  assert.ok(String(pre.head['access-control-allow-methods']).split(',').includes('POST'));
});

console.log('Le rejeu décide : le serveur recalcule les faits');
// Poser une trace DIRECTEMENT dans la table, sans passer par la route qui la borne. C'est le seul
// moyen d'éprouver les refus du rejeu qui, en pratique, ne devraient jamais lui parvenir : la route
// de trace en arrête déjà une partie. Un serveur qui compterait sur elle pour être protégé
// dépendrait d'une garde qui vit ailleurs, et c'est exactement ce qu'on refuse.
const poserBrut = (db, matchId, data, seq = 0) =>
  db.traces.push({ match_id: matchId, seq, sim_version: SIM.SIM_VERSION,
                   steps: 1, data, created_at: '2026-01-01T00:00:00Z' });

await test('SIX CODES NOMMÉS, chacun en 400 ou 409, jamais en 500, et jamais un billet sans issue', async () => {
  // La leçon du `22003`, appliquée à la route qui décide de l'argent : un joueur n'a qu'un billet
  // ouvert à la fois, donc un 500 qui laisse la ligne `open` l'enferme jusqu'à l'expiration. Ici
  // chaque refus se nomme, sort en 400 ou 409, n'écrit AUCUN montant, et laisse la ligne au
  // veilleur de la 02a — le seul endroit du dossier qui clôt sans montant.
  const cas = [
    ['trace_absente', 409, async () => {}],
    ['donnees', 400, async (db, b) => { poserBrut(db, b.corps.id, 'pas une trace du tout'); }],
    ['donnees', 400, async (db, b) => { poserBrut(db, b.corps.id, traceDe(C, 40).texte(), 1); }],
    ['trop_de_pas', 400, async (db, b) => {
      poserBrut(db, b.corps.id, traceDe(C, 40).texte() + '~___'); }],
    ['non_terminal', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b, { pasMax: 400 }).segments); }],
    ['sim_version', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      // Un serveur redéployé pendant qu'un joueur joue : le billet garde la version sous laquelle
      // il a été ouvert, et le rejeu refuse de juger une partie qu'il ne saurait pas refaire.
      db.matches[0].sim_version = SIM.SIM_VERSION + 1; }],
    ['billet', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      db.matches[0].mode = 'bataille-navale'; }],
    ['conservation', 409, async (db, b, app) => {
      await poserTrace(app, b.corps.id, partieDe(b).segments);
      // On fait MENTIR la simulation sur l'argent en jeu : si le rejeu se trompe, le serveur
      // n'écrit surtout pas de montant. C'est une garde contre lui-même, pas contre le joueur.
      SIM.argentCents = () => 1; }],
  ];
  for (const [code, attendu, preparer] of cas) {
    const vrai = SIM.argentCents;
    const { db, app, horloge } = bancDeBillet({ limiter: makeLimiter({ max: 100, windowMs: 60_000 }) });
    let panne = null;
    app.onError = e => { panne = e; };
    const b = await demander(app);
    await preparer(db, b, app);
    horloge.t = T0 + 200_000;
    const r = await rendre(app, b.corps.id, partieDe(b).rapport);
    SIM.argentCents = vrai;
    assert.strictEqual(panne, null, `${code} : une exception est remontée jusqu'au 500`);
    assert.strictEqual(r.code, attendu, `${code} : reçu ${r.code} — ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, code, JSON.stringify(r.corps));
    assert.ok(r.corps.erreur && r.corps.erreur.length > 20, `${code} : un refus doit dire pourquoi`);
    assert.strictEqual(db.matches[0].status, 'open', `${code} : la ligne n'est plus au veilleur`);
    for (const col of ['net_cents', 'gross_cents', 'fee_cents', 'purse_cents', 'settled_at'])
      assert.strictEqual(db.matches[0][col], undefined, `${code} : ${col} a été écrit sur un refus`);
    // Et le veilleur la ramasse : le joueur n'est enfermé que jusqu'à l'expiration de son billet,
    // pas au-delà, et il peut renvoyer sa trace entre-temps.
    horloge.t = Date.parse(b.corps.expiresAt) + 1;
    assert.deepStrictEqual(await app.veiller(), { closes: 1, echecs: [] }, code);
  }
  // Les six codes de la trace sont bien ceux que la spécification nomme, plus deux gardes internes.
  const { REJEU_CODES } = require('./app');
  for (const code of ['trop_de_pas', 'donnees', 'trace_absente', 'non_terminal', 'sim_version', 'budget'])
    assert.ok([400, 409].includes(REJEU_CODES[code]), code);
});
await test('LE BUDGET DE CALCUL EST ÉPROUVÉ SANS ATTENDRE : une horloge injectée, pas une trace lente', async () => {
  // Un rejeu tourne dans le fil de la requête, et une trace adversariale peut chercher à en
  // maximiser le coût. Le dépassement est un code nommé — jamais une exception, jamais un fil tenu
  // une minute — et il s'éprouve avec une horloge qui avance d'elle-même : attendre deux secondes
  // dans un test serait payer le prix qu'on cherche justement à borner.
  const { REPLAY_BUDGET_MS } = require('./app');
  let t = 0;
  const { db, app, horloge } = bancDeBillet({ chrono: () => (t += REPLAY_BUDGET_MS) });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'budget');
  assert.ok(r.corps.replayMs > REPLAY_BUDGET_MS);
  assert.strictEqual(db.matches[0].status, 'open', 'un rejeu abandonné a quand même écrit');
  assert.strictEqual(db.matches[0].net_cents, undefined);
});
await test('LE REJEU D\'UNE PARTIE HONNÊTE TIENT LARGEMENT SOUS SON BUDGET, sur la vraie horloge', async () => {
  // Le pendant du précédent, et le plancher de performance de la route : la seule mesure de ce
  // dossier qui se prenne sur une vraie horloge, parce que c'est la seule question à laquelle une
  // horloge figée ne peut pas répondre.
  const { REPLAY_BUDGET_MS } = require('./app');
  const { db, app, horloge } = bancDeBillet({ chrono: Date.now });
  const b = await demander(app);
  const p = partieDe(b);
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.ok(Number.isInteger(r.corps.replayMs) && r.corps.replayMs >= 0, String(r.corps.replayMs));
  assert.ok(r.corps.replayMs * 3 < REPLAY_BUDGET_MS,
    `un rejeu honnête de ${p.pas} pas coûte ${r.corps.replayMs} ms pour un budget de ${REPLAY_BUDGET_MS} ms`);
  assert.strictEqual(db.matches[0].replay_ms, r.corps.replayMs);
});
await test('TRONQUER UNE TRACE NE PAIE JAMAIS RIEN : net(préfixe) ≤ net(complète), et zéro sans fin', async () => {
  // LE VRAI TROU D'UN REJEU DIFFÉRÉ, et il s'ouvre le jour où un euro entre : sans état terminal
  // obligatoire, couper le réseau juste après un gros kill deviendrait la meilleure stratégie du
  // jeu — la partie resterait à jamais dans son meilleur instant.
  const complet = async (mode, opts) => {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app, { ...DEMANDE, mode });
    const { rep } = await jouerEtRendre(app, horloge, b, opts);
    return { rep, ligne: db.matches[0] };
  };
  // Une partie qui PAIE, et la même tronquée à tous les stades avant sa fin.
  const entiere = await complet('resurgence', { encaisser: 300 });
  assert.strictEqual(entiere.rep.corps.status, 'settled');
  assert.ok(entiere.rep.corps.netCents > 0, 'la partie de référence ne paie rien : le test est vide');

  for (const pasMax of [60, 120, 240, 299]) {
    const { db, app, horloge } = bancDeBillet();
    const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
    const p = partieDe(b, { encaisser: 300, pasMax });
    assert.strictEqual(p.terminal, null, `${pasMax} pas : le préfixe est déjà terminal`);
    await poserTrace(app, b.corps.id, p.segments);
    horloge.t = ARRIVEE(p.rapport);
    const r = await rendre(app, b.corps.id, p.rapport);
    assert.strictEqual(r.code, 409, `${pasMax} : ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.code, 'non_terminal');
    // AUCUN MONTANT : c'est zéro, et zéro est bien inférieur à ce que la partie complète a payé.
    assert.strictEqual(db.matches[0].net_cents, undefined, `${pasMax} : un montant a été écrit`);
    assert.ok(0 <= entiere.rep.corps.netCents);
  }
  // Et la même chose sur une partie PERDUE : tronquée ou entière, elle ne paie rien non plus, mais
  // seule l'entière se règle. Une défaite tronquée n'efface pas la défaite, elle reste ouverte.
  const perdue = await complet('solo', {});
  assert.strictEqual(perdue.rep.corps.status, 'settled');
  assert.strictEqual(perdue.rep.corps.netCents, 0);
  assert.strictEqual(perdue.ligne.digest_match, true);
});
await test('RALLONGER SA TRACE APRÈS L\'ENCAISSEMENT N\'AJOUTE PAS UN CENTIME', async () => {
  // Le pendant exact de la troncature, et personne ne l'avait nommé : le jeu coupe sa boucle sur
  // l'événement de fin, un serveur qui continuerait à simuler au-delà jugerait une partie que
  // personne n'a jouée. Le joueur qui encaisse puis colle mille deux cents pas de plus au bout de
  // sa trace verrait sa sacoche continuer de grossir APRÈS être sorti avec l'argent.
  //
  // Deux bancs, mêmes graines, même horloge : le premier envoie la trace qui s'arrête au jeton
  // d'encaissement, le second la même trace RALLONGÉE. Les deux lignes doivent être indiscernables.
  const droit = bancDeBillet(), rallonge = bancDeBillet();
  const a = await demander(droit.app, { ...DEMANDE, mode: 'resurgence' });
  const b = await demander(rallonge.app, { ...DEMANDE, mode: 'resurgence' });
  const honnete = partieDe(a, { encaisser: 300 });
  const longue = partieDe(b, { encaisser: 300, rallonge: 1200 });
  assert.ok(longue.pas > honnete.pas + 1000, 'la trace rallongée ne l\'est pas');

  const un = await jouerEtRendre(droit.app, droit.horloge, a, { encaisser: 300 });
  await poserTrace(rallonge.app, b.corps.id, longue.segments);
  rallonge.horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + honnete.rapport.seconds + 3) * 1000;
  // Le rapport est celui de la partie HONNÊTE : ce qui change entre les deux appels est la trace,
  // et elle seule.
  const deux = await rendre(rallonge.app, b.corps.id, honnete.rapport);

  assert.strictEqual(deux.code, 200, JSON.stringify(deux.corps));
  assert.deepStrictEqual(deux.corps, un.rep.corps, 'la rallonge a changé le règlement');
  assert.deepStrictEqual(rallonge.db.matches, droit.db.matches, 'la rallonge a changé la ligne');
  // Et le serveur s'est bien arrêté au jeton, pas au bout du fichier.
  assert.strictEqual(deux.corps.traceSteps, honnete.pas);
  assert.strictEqual(deux.corps.digestMatch, true);
});
await test('UNE DIVERGENCE EST MESURÉE, JAMAIS PUNIE — et aucun agrégat ne compte la ligne', async () => {
  // `Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp près par ECMAScript : un
  // désaccord entre le rejeu du serveur et l'empreinte du client peut ne prouver qu'une chose, que
  // les deux n'ont pas la même bibliothèque mathématique. Refuser ce joueur serait le QUATRIÈME
  // contrôle « évident » et faux de ce dossier. La ligne est donc RÉGLÉE, marquée, et la garantie
  // écrite noir sur blanc est celle dont la phase 03 a besoin : elle ne lira que ce qui a convergé.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  const siens = C.digestsDecode(p.rapport.digests);
  assert.ok(siens && siens.length > 3, 'la partie du test ne porte pas assez de condensés');
  const faux = siens.slice(); faux[2] = (faux[2] ^ 1) >>> 0;
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, { ...p.rapport, digests: C.digestsEncode(faux) });

  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.status, 'settled', 'une divergence a été PUNIE');
  assert.ok(r.corps.netCents > 0, 'le joueur divergent doit être payé comme les autres');
  assert.strictEqual(r.corps.digestMatch, false);
  // Le premier pas où les deux s'écartent, au pas d'empreinte près. Sans ce chiffre, la liste
  // d'exclusion grandirait en silence et la phase 03 hériterait d'un filtre au rendement inconnu.
  assert.strictEqual(r.corps.divergenceStep, 3 * SIM.EMPREINTE_PAS);
  assert.strictEqual(db.matches[0].digest_match, false);
  assert.strictEqual(db.matches[0].replay_digest, SIM.empreinte(p.G));

  // ET LA GARDE QUI COMPTE : aucun agrégat ne voit cette ligne. Elle est réglée, elle est payée,
  // et le grand livre de la phase 03 ne la lira jamais.
  const s = (await appel(app, { token: 'ok:u1:Loic' })).corps.stats;
  assert.strictEqual(s.matches, 0, 'une ligne divergente a été comptée');
  assert.strictEqual(s.wins, 0);
  assert.strictEqual(s.kills, 0);
  assert.strictEqual(s.best, 0);
  assert.strictEqual(s.divergences, 1, 'le taux de divergence n\'est pas exposé');
});
await test('un client sans condensés est réglé aussi, et compté comme divergent — pas comme convergé', async () => {
  // Un client qui n'envoie pas ses condensés n'est pas un tricheur : il ne prouve simplement
  // aucune convergence. La valeur par défaut sûre est donc « non convergé », jamais l'inverse.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const r = await rendre(app, b.corps.id, { ...p.rapport, digests: '' });
  assert.strictEqual(r.corps.status, 'settled');
  assert.strictEqual(r.corps.digestMatch, false);
  assert.strictEqual(r.corps.divergenceStep, 0, 'zéro veut dire « aucun condensé comparable »');
  assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).corps.stats.divergences, 1);
  assert.strictEqual(db.matches[0].digest_match, false);
});
test('LA ROUTE DU RÉSULTAT NE LIT PLUS AUCUN FAIT DU CORPS : garde textuelle', () => {
  // La garde qui attrape le PROCHAIN champ qu'on relira du corps par inadvertance. Deux seulement
  // ont le droit d'en sortir : ce que le client croit avoir gagné, et ses condensés — ni l'un ni
  // l'autre ne décide d'un montant.
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const route = src.slice(src.indexOf('function rejouerPartie'), src.indexOf('async function veiller'));
  assert.ok(route.length > 2000, 'la route du résultat n\'a pas été retrouvée');
  const lus = [...new Set((route.match(/\brapport\.([A-Za-z_$][\w$]*)/g) || []).map(x => x.slice(8)))];
  assert.deepStrictEqual(lus.sort(), ['declaredNetCents', 'digests'],
    'la route lit un fait déclaré : ' + lus.join(', '));
  // Et les faits écrits viennent tous de la partie rejouée.
  for (const champ of ['seconds', 'kills', 'deaths', 'rank', 'cubes', 'damage', 'cashedOut'])
    assert.ok(route.includes(`faits.${champ}`) || route.includes(`vide.${champ}`), champ);
});

// ------------------------------------------------------------------------------------------------
// LE GRAND LIVRE (phase 03, module 1). Il est testé ICI et pas dans `test.js` parce qu'il est du
// SERVEUR : le plan de comptes n'est pas une règle du jeu, et rien dans le navigateur n'exécutera
// jamais une ligne de comptabilité. Ce qui est réellement partagé avec le sas — la fenêtre de
// renoncement — vit dans `WBCore` et se teste dans `test.js`.
//
// À ce stade rien n'est écrit sur un disque : `api/ledger.js` est entièrement pur.
console.log('Le grand livre : la grammaire, les transferts, les mouvements');
// `L` est requis en tête de fichier : la doublure de base s'en sert déjà.
// Les cinq modes avec leurs VRAIS sièges, et les quatre tables. Aucun échantillon : le domaine.
const MODES_LEDGER = Object.keys(C.MODES).map(id => ({ id, seats: C.seatsOf(C.MODES[id]) }));
const MISES_LEDGER = C.TIERS.map(t => C.toCents(t.stake));

// Le contrôle que tout mouvement doit passer, et qui n'est PAS une fonction d'équilibre appelée
// avant l'insertion : la partie double est structurelle, on ne fait ici que constater qu'elle l'est
// bien restée sur chaque ligne produite.
function verifierMouvement(transferts, quoi) {
  assert.ok(Array.isArray(transferts) && transferts.length > 0, `${quoi} : mouvement vide`);
  let signe = 0;
  for (const t of transferts) {
    assert.ok(Number.isSafeInteger(t.montantCents) && t.montantCents > 0,
      `${quoi} : montant ${t.montantCents} — un transfert porte un entier de centimes strictement positif`);
    assert.notStrictEqual(t.compteDebit, t.compteCredit, `${quoi} : un transfert vers soi-même`);
    assert.ok(L.compteValide(t.compteDebit), `${quoi} : ${t.compteDebit} hors grammaire`);
    assert.ok(L.compteValide(t.compteCredit), `${quoi} : ${t.compteCredit} hors grammaire`);
    assert.ok(L.MOTIFS.includes(t.motif), `${quoi} : motif ${t.motif} hors liste`);
    assert.strictEqual(t.motif, transferts[0].motif, `${quoi} : deux motifs dans un mouvement`);
    assert.strictEqual(t.reference, transferts[0].reference, `${quoi} : deux références dans un mouvement`);
    // La somme signée : `+m` quelque part, `−m` ailleurs, donc zéro. C'est vrai PAR CONSTRUCTION,
    // et c'est très exactement pour cela que le test peut l'affirmer sans rien avoir à corriger.
    signe += t.montantCents - t.montantCents;
  }
  const comptes = new Set();
  for (const t of transferts) { comptes.add(t.compteDebit); comptes.add(t.compteCredit); }
  let total = 0;
  for (const c of comptes) total += L.soldeDe(transferts, c);
  assert.strictEqual(total, 0, `${quoi} : la somme du mouvement n'est pas nulle`);
  assert.strictEqual(signe, 0);
  // Les paires de comptes d'un même mouvement sont distinctes deux à deux : c'est ce qui rend la
  // clé d'idempotence `(motif, reference, compte_debit, compte_credit)` capable d'identifier UNE
  // jambe. Deux jambes identiques et la seconde serait refusée par la base.
  const paires = new Set(transferts.map(t => `${t.compteDebit}>${t.compteCredit}`));
  assert.strictEqual(paires.size, transferts.length, `${quoi} : deux jambes de même paire de comptes`);
}

test('EXHAUSTIVEMENT : sur les cinq modes, les quatre tables et TOUTE sacoche, un mouvement est un ensemble de transferts positifs qui boucle', () => {
  // Pas un échantillon : toute sacoche de 0 à `mise × sièges`, la borne que `purseBound` démontre.
  // 280 500 règlements, chacun confronté à la grammaire, aux entiers et à la partie double.
  let regles = 0;
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const max = C.purseBound(miseCents, seats).maxCents;
    const mise = L.mouvementMise({ userId: 1, matchId: 42, miseCents });
    verifierMouvement(mise, `${id} $${miseCents / 100} mise`);
    for (let sacoche = 0; sacoche <= max; sacoche++) {
      // Le brut, la commission et le net viennent de `WBCore.cashoutCents` et de NULLE PART
      // ailleurs. `api/ledger.js` les reçoit et les répartit ; il n'a pas le droit de les calculer,
      // et une garde textuelle plus bas le vérifie sur son texte.
      const p = C.cashoutCents(sacoche);
      const gain = L.mouvementGain({ userId: 1, matchId: 42, miseCents,
                                     grossCents: p.grossCents, feeCents: p.feeCents,
                                     netCents: p.netCents, convergee: true });
      verifierMouvement(gain, `${id} $${miseCents / 100} sacoche ${sacoche}`);
      // Le séquestre est habité par la mise, puis vidé par le règlement. Exactement, au centime :
      // c'est l'invariant fort et local que le séquestre par partie existe pour donner.
      const livre = mise.concat(gain);
      assert.strictEqual(L.soldeDe(mise, L.compteEnjeu(42)), miseCents);
      assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(42)), 0,
        `${id} $${miseCents / 100} sacoche ${sacoche} : séquestre non vidé`);
      regles++;
    }
  }
  assert.strictEqual(regles, MODES_LEDGER.reduce((a, m) =>
    a + MISES_LEDGER.reduce((b, s) => b + s * m.seats + 1, 0), 0));
  assert.ok(regles > 280000, `le domaine balayé est trop maigre : ${regles} règlements`);
});

test('fee + net = brut sur chaque règlement, et les trois montants viennent de cashoutCents', () => {
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    for (let sacoche = 0; sacoche <= C.purseBound(miseCents, seats).maxCents; sacoche++) {
      const p = C.cashoutCents(sacoche);
      assert.strictEqual(p.feeCents + p.netCents, p.grossCents);
      // Et le grand livre REFUSE un triplet qui ne vient manifestement pas de là. Sans ce refus, le
      // séquestre ne bouclerait plus et le trou n'apparaîtrait qu'au règlement suivant.
      assert.throws(() => L.mouvementGain({ userId: 1, matchId: 3, miseCents,
        grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents + 1, convergee: true }),
        /cashoutCents/);
    }
  }
});

test('GARDE TEXTUELLE : api/ledger.js ne contient AUCUNE arithmétique de commission', () => {
  // Elle est infiniment plus sûre sur un fichier dédié que sur une plage de marqueurs dans un
  // fichier de six mille lignes, et c'est l'une des raisons pour lesquelles le grand livre vit dans
  // `api/ledger.js` plutôt que dans `WBCore`.
  const fs = require('node:fs'), path = require('node:path');
  const brut = fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');
  const src = brut.replace(/^[ \t]*\/\/[^\n]*/gm, '');
  for (const interdit of ['RAKE', '0.2', 'Math.ceil', '/ 100', 'toFixed'])
    assert.ok(!src.includes(interdit), `api/ledger.js recalcule un montant : ${interdit}`);
  // Et il ne recopie pas non plus une règle du jeu par la porte de derrière : il ne charge PAS
  // WBCore. Il reçoit des montants déjà décidés, il ne va pas les chercher.
  assert.ok(!src.includes('require('), 'api/ledger.js dépend de quelque chose : il doit rester pur');
  assert.ok(src.includes('cashoutCents'), 'la raison de la garde doit rester écrite dans le fichier');
});

test('chaque montant est un entier SÛR : aucun flottant n\'entre', () => {
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const max = C.purseBound(miseCents, seats).maxCents;
    for (let sacoche = 0; sacoche <= max; sacoche++) {
      const p = C.cashoutCents(sacoche);
      for (const t of L.mouvementGain({ userId: 9, matchId: 9, miseCents, grossCents: p.grossCents,
                                        feeCents: p.feeCents, netCents: p.netCents, convergee: false }))
        assert.ok(Number.isSafeInteger(t.montantCents), `${t.montantCents}`);
    }
  }
  // Et ce qui n'est pas un entier sûr est REFUSÉ, jamais arrondi en silence : un centime perdu à
  // l'arrondi est un livre qui ne boucle plus.
  for (const mauvais of [0, -1, 1.5, NaN, Infinity, '100', null, undefined, 2 ** 53])
    assert.throws(() => L.mouvementMise({ userId: 1, matchId: 1, miseCents: mauvais }), /montant invalide/,
      `${String(mauvais)} a été accepté comme montant`);
});

test('un compte hors grammaire LANCE, au lieu de rendre une écriture boiteuse', () => {
  // Une écriture boiteuse s'insérerait, et elle BOUCLERAIT — un transfert boucle toujours. Le solde
  // qu'elle fausse ne se verrait qu'au moment de payer quelqu'un.
  for (const bon of ['joueur:1:disponible', 'joueur:987654321:quarantaine', 'enjeu:7',
                     L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.ok(L.compteValide(bon), bon);
  for (const mauvais of ['joueur:1', 'joueur:1:autre', 'joueur:0:disponible', 'joueur:01:disponible',
                         'joueur:-1:disponible', 'joueur:a:disponible', 'enjeu:', 'enjeu:0',
                         'maison', 'maison:autre', 'maison:dotation:1', '', ' enjeu:1',
                         'enjeu:1\nmaison:dotation', 42, null, undefined]) {
    assert.ok(!L.compteValide(mauvais), `${String(mauvais)} est passé pour un compte`);
    assert.throws(() => L.exigeCompte(mauvais), /hors grammaire/, String(mauvais));
    assert.throws(() => L.soldeDe([], mauvais), /hors grammaire/, String(mauvais));
  }
  // Les zéros de tête sont refusés PAR LES FABRICANTS aussi : `joueur:007:disponible` et
  // `joueur:7:disponible` seraient deux comptes pour un seul joueur, et le solde du second ne
  // verrait jamais l'argent du premier.
  for (const mauvais of ['007', '0', -3, 1.5, '', 'sept', null, NaN])
    for (const fab of [L.compteJoueur, L.compteQuarantaine, L.compteEnjeu])
      assert.throws(() => fab(mauvais), /identifiant/, `${fab.name}(${String(mauvais)})`);
  // Les trois formes qu'un pilote Postgres peut rendre pour un `bigserial` donnent le MÊME compte.
  assert.strictEqual(L.compteJoueur(12), 'joueur:12:disponible');
  assert.strictEqual(L.compteJoueur('12'), 'joueur:12:disponible');
  assert.strictEqual(L.compteJoueur(12n), 'joueur:12:disponible');
  // Un transfert d'un compte vers lui-même n'est pas représentable non plus.
  assert.throws(() => L.transfert('mise', '1', 'enjeu:1', 'enjeu:1', 10), /vers lui-même/);
});

test('un motif hors liste LANCE, et la liste est fermée à SIX', () => {
  assert.deepStrictEqual(L.MOTIFS.slice(),
    ['dotation', 'recharge', 'mise', 'gain', 'remboursement', 'contrepassation']);
  // Six, et pas sept : la spécification renvoie explicitement à la phase 06 le motif de libération
  // de quarantaine, parce qu'un membre de liste fermée que personne n'écrit est une case en attente
  // d'être créée de travers. Le test tombera le jour où quelqu'un l'ajoutera sans lire la raison.
  for (const absent of ['liberation', 'quarantaine', 'depot', 'retrait', 'ajustement', 'correction'])
    assert.ok(!L.MOTIFS.includes(absent), `${absent} est entré dans la liste des motifs`);
  for (const mauvais of ['', 'MISE', 'gains', 'transfert', null, undefined, 0])
    assert.throws(() => L.exigeMotif(mauvais), /motif hors liste/, String(mauvais));
  for (const mauvais of ['', 'MISE', 'transfert', null])
    assert.throws(() => L.transfert(mauvais, '1', 'enjeu:1', L.MAISON_COMMISSION, 10), /motif hors liste/);
});

test('la grammaire est une EXPRESSION, exportée en source pour que le schéma la recopie', () => {
  // Ne jamais l'écrire « liste fermée » : trois des six comptes sont des familles paramétrées, et
  // un `check (compte in (...))` serait refusé au premier joueur inscrit. Le module suivant recopie
  // `COMPTE_RE_SQL` caractère pour caractère dans `api/schema.sql`, et un test l'y comparera.
  assert.strictEqual(typeof L.COMPTE_RE_SQL, 'string');
  assert.ok(L.COMPTE_RE_SQL.startsWith('^') && L.COMPTE_RE_SQL.endsWith('$'),
    'la contrainte doit être ancrée des deux côtés, sinon elle laisse passer n\'importe quel préfixe');
  assert.ok(!L.COMPTE_RE_SQL.includes("'"), 'une apostrophe casserait le littéral SQL du schéma');
  // Le RegExp en DÉRIVE : il n'existe pas deux écritures de la même règle.
  assert.strictEqual(L.COMPTE_RE.source, L.COMPTE_RE_SQL);
  for (const c of ['joueur:1:disponible', 'joueur:1:quarantaine', 'enjeu:1',
                   L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.ok(new RegExp(L.COMPTE_RE_SQL).test(c), c);
});

test('SEULS le compte d\'émission et la contrepartie ont le droit de passer en négatif', () => {
  assert.deepStrictEqual(L.COMPTES_EMETTEURS.slice(), [L.MAISON_DOTATION, L.MAISON_CONTREPARTIE]);
  assert.ok(L.decouvertAutorise(L.MAISON_DOTATION));
  assert.ok(L.decouvertAutorise(L.MAISON_CONTREPARTIE));
  // La commission n'est pas un compte d'émission : elle encaisse, elle n'avance rien.
  assert.ok(!L.decouvertAutorise(L.MAISON_COMMISSION));
  assert.ok(!L.decouvertAutorise(L.compteJoueur(1)));
  assert.ok(!L.decouvertAutorise(L.compteQuarantaine(1)));
  // ET SURTOUT PAS LES SÉQUESTRES, et c'est tout l'intérêt de l'uniformité de la règle : un second
  // gain sur un même billet devrait débiter un séquestre déjà vide, et se fait donc refuser.
  // « Un billet a au plus un gain » ne repose alors pas uniquement sur un index.
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    assert.ok(!L.decouvertAutorise(L.compteEnjeu(seats * miseCents)));
  }
  assert.throws(() => L.decouvertAutorise('maison:tresorerie'), /hors grammaire/);
});

test('LA MESURE QUE docs/HISTORIQUE.md RÉCLAME AVANT LA PHASE 04 : ce que la maison paie, au centime', () => {
  // Ce chiffre existait déjà ; il n'était écrit nulle part, et le risque n'est pas le chiffre —
  // c'est de le voir apparaître un jour et de le prendre pour un bug. Il tombe ici, avant qu'une
  // base ne le calcule.
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const mise = L.mouvementMise({ userId: 4, matchId: 4, miseCents });

    // 1. LE JOUEUR QUI PERD : sa sacoche est vide, le séquestre part entier chez la contrepartie.
    //    Un seul transfert, parce qu'une jambe nulle n'est pas représentable.
    const perdu = C.cashoutCents(0);
    const perte = L.mouvementGain({ userId: 4, matchId: 4, miseCents, grossCents: perdu.grossCents,
                                    feeCents: perdu.feeCents, netCents: perdu.netCents, convergee: true });
    assert.strictEqual(perte.length, 1, `${id} : un brut nul doit produire UN seul transfert`);
    assert.deepStrictEqual({ ...perte[0] }, { motif: 'gain', reference: '4', compteDebit: 'enjeu:4',
                                              compteCredit: L.MAISON_CONTREPARTIE, montantCents: miseCents });
    let livre = mise.concat(perte);
    assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(4)), 0);
    assert.strictEqual(L.soldeDe(livre, L.MAISON_CONTREPARTIE), miseCents, 'enjeu −mise, contrepartie +mise');
    assert.strictEqual(L.soldeDe(livre, L.MAISON_COMMISSION), 0, 'un brut nul ne rapporte aucune commission');
    assert.strictEqual(L.soldeDe(livre, L.compteJoueur(4)), -miseCents);

    // 2. LE JOUEUR QUI RAFLE LA TABLE : la maison paie les mises que personne n'a versées.
    const rafle = C.cashoutCents(miseCents * seats);
    const gain = L.mouvementGain({ userId: 4, matchId: 4, miseCents, grossCents: rafle.grossCents,
                                   feeCents: rafle.feeCents, netCents: rafle.netCents, convergee: true });
    livre = mise.concat(gain);
    assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(4)), 0, 'le séquestre doit être vidé');
    // La contrepartie verse `(sièges − 1)` mises en BRUT — le pot moins la seule mise réelle.
    const verse = -L.soldeDe(livre, L.MAISON_CONTREPARTIE);
    assert.strictEqual(verse, miseCents * (seats - 1), `${id} $${miseCents / 100} : brut versé`);
    // Et le COÛT NET de la maison est ce versement moins ce que la commission rattrape :
    // `brut − fee − mise`. C'est le chiffre qu'il fallait écrire avant qu'il ne surprenne quelqu'un.
    const encaisse = L.soldeDe(livre, L.MAISON_COMMISSION);
    assert.strictEqual(encaisse, rafle.feeCents);
    assert.strictEqual(verse - encaisse, rafle.grossCents - rafle.feeCents - miseCents,
      `${id} $${miseCents / 100} : coût net de la maison`);
    assert.strictEqual(L.soldeDe(livre, L.compteJoueur(4)), rafle.netCents - miseCents);
  }
  // Et le cas nommé dans la spécification, en chiffres : une table à 10 $ en resurgence.
  const mise = 1000, seats = C.seatsOf(C.MODES.resurgence);
  assert.strictEqual(seats, 50);
  const p = C.cashoutCents(mise * seats);
  assert.deepStrictEqual(p, { grossCents: 50000, feeCents: 10000, netCents: 40000 });
  const livre = L.mouvementMise({ userId: 4, matchId: 4, miseCents: mise })
    .concat(L.mouvementGain({ userId: 4, matchId: 4, miseCents: mise, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  assert.strictEqual(-L.soldeDe(livre, L.MAISON_CONTREPARTIE), 49000, 'la contrepartie verse 49 000 centimes');
  assert.strictEqual(L.soldeDe(livre, L.MAISON_COMMISSION), 10000, 'la maison encaisse 10 000 centimes');
  assert.strictEqual(-L.soldeDe(livre, L.MAISON_CONTREPARTIE) - L.soldeDe(livre, L.MAISON_COMMISSION),
    39000, '390 $ de coût net sur UNE partie');
});

test('le gain d\'une ligne DIVERGENTE va en quarantaine, et le solde dépensable n\'en voit pas un centime', () => {
  const p = C.cashoutCents(2500);
  const commun = { userId: 8, matchId: 8, miseCents: 100, grossCents: p.grossCents,
                   feeCents: p.feeCents, netCents: p.netCents };
  const droit = L.mouvementGain({ ...commun, convergee: true });
  const retenu = L.mouvementGain({ ...commun, convergee: false });
  assert.strictEqual(L.soldeDe(droit, L.compteJoueur(8)), p.netCents);
  assert.strictEqual(L.soldeDe(droit, L.compteQuarantaine(8)), 0);
  assert.strictEqual(L.soldeDe(retenu, L.compteQuarantaine(8)), p.netCents);
  assert.strictEqual(L.soldeDe(retenu, L.compteJoueur(8)), 0);
  // Le livre boucle dans les deux cas : c'est tout l'intérêt de la quarantaine face aux trois
  // autres réponses possibles — ne rien créditer punirait un joueur qui n'a rien fait, créditer le
  // dépensable romprait une garantie écrite quatre fois, et ne rien écrire laisserait `net_cents`
  // sans contrepartie.
  for (const m of [droit, retenu]) verifierMouvement(m, 'gain');
  // Un `convergee` oublié enverrait silencieusement le gain en quarantaine. Il est donc exigé.
  assert.throws(() => L.mouvementGain({ ...commun }), /convergee/);
  assert.throws(() => L.mouvementGain({ ...commun, convergee: 'oui' }), /convergee/);
  // Sauf quand le net est nul : aucune jambe ne touche alors un compte de joueur, et le veilleur,
  // qui ne connaît que le billet, n'a rien à en dire.
  assert.doesNotThrow(() => L.mouvementGain({ matchId: 8, miseCents: 100, grossCents: 0, feeCents: 0, netCents: 0 }));
});

test('LE VIDAGE D\'UN SÉQUESTRE À L\'EXPIRATION est un règlement à net nul, pas un motif de plus', () => {
  // `remboursement` mentirait — personne n'est remboursé. `contrepassation` mentirait aussi — on ne
  // corrige aucune écriture fausse, le débit de la mise était juste. Un septième motif rouvrirait la
  // liste fermée pour rien. Le vidage EST le règlement d'une partie qui n'a rien rapporté, donc
  // motif `gain`, net nul — c'est-à-dire `mouvementGain` avec un brut nul, et pas une fonction de
  // plus dont la seule différence aurait été le chemin qui l'appelle.
  assert.strictEqual(L.mouvementExpiration, undefined,
    'une fonction d\'expiration a été ajoutée : le vidage se lit comme un règlement à net nul');
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const vidage = L.mouvementGain({ matchId: 5, miseCents, grossCents: 0, feeCents: 0, netCents: 0 });
    assert.strictEqual(vidage.length, 1);
    assert.deepStrictEqual({ ...vidage[0] }, { motif: 'gain', reference: '5', compteDebit: 'enjeu:5',
                                               compteCredit: L.MAISON_CONTREPARTIE, montantCents: miseCents });
    // Et il produit EXACTEMENT le même mouvement que le règlement d'un joueur qui perd. C'est la
    // vérité comptable : les deux billets ont rapporté zéro.
    const perdu = C.cashoutCents(0);
    assert.deepStrictEqual(vidage.map(t => ({ ...t })),
      L.mouvementGain({ userId: 6, matchId: 5, miseCents, grossCents: perdu.grossCents,
                        feeCents: perdu.feeCents, netCents: perdu.netCents, convergee: true })
        .map(t => ({ ...t })));
    assert.strictEqual(L.soldeDe(L.mouvementMise({ userId: 6, matchId: 5, miseCents }).concat(vidage),
                                 L.compteEnjeu(5)), 0, 'aucun séquestre ne reste habité');
    assert.ok(seats > 0);
  }
});

test('la dotation, la recharge et le remboursement portent la référence qui les rend idempotents', () => {
  const d = L.mouvementDotation({ userId: 3, montantCents: 5000 });
  verifierMouvement(d, 'dotation');
  assert.deepStrictEqual({ ...d[0] }, { motif: 'dotation', reference: '3',
    compteDebit: L.MAISON_DOTATION, compteCredit: 'joueur:3:disponible', montantCents: 5000 });
  // La recharge est idempotente PAR JOUR : une par joueur et par jour, écrite par le serveur à la
  // connexion, jamais par une route de crédit gratuit que le client pourrait marteler.
  const r = L.mouvementRecharge({ userId: 3, jour: '2026-09-14', montantCents: 500 });
  verifierMouvement(r, 'recharge');
  assert.strictEqual(r[0].reference, '3:2026-09-14');
  assert.strictEqual(r[0].compteDebit, L.MAISON_DOTATION);
  assert.notStrictEqual(r[0].reference, d[0].reference, 'dotation et recharge se distingueraient mal');
  for (const mauvais of ['14/09/2026', '2026-9-14', '', '2026-09-14T00:00:00Z', null, 20260914])
    assert.throws(() => L.mouvementRecharge({ userId: 3, jour: mauvais, montantCents: 500 }),
      /jour de recharge/, String(mauvais));
  // Le remboursement rend la mise et vide le séquestre : le seul chemin qui rende une mise.
  const mise = L.mouvementMise({ userId: 3, matchId: 11, miseCents: 100 });
  const rb = L.mouvementRemboursement({ userId: 3, matchId: 11, miseCents: 100 });
  verifierMouvement(rb, 'remboursement');
  assert.strictEqual(rb[0].reference, '11');
  assert.strictEqual(L.soldeDe(mise.concat(rb), L.compteEnjeu(11)), 0);
  assert.strictEqual(L.soldeDe(mise.concat(rb), L.compteJoueur(3)), 0, 'le joueur retrouve sa mise');
});

test('la contre-passation est l\'inverse EXACT, et laisse les deux mouvements visibles', () => {
  // Une écriture modifiée est une preuve détruite : on ne peut plus dire ce qui a été payé ni
  // quand. Le seul chemin de correction est un mouvement inverse, daté et motivé.
  const p = C.cashoutCents(3000);
  const gain = L.mouvementGain({ userId: 2, matchId: 77, miseCents: 500, grossCents: p.grossCents,
                                 feeCents: p.feeCents, netCents: p.netCents, convergee: true });
  const contre = L.mouvementContrepassation({ transferts: gain });
  verifierMouvement(contre, 'contrepassation');
  assert.strictEqual(contre.length, gain.length);
  for (let i = 0; i < gain.length; i++) {
    assert.strictEqual(contre[i].compteDebit, gain[i].compteCredit);
    assert.strictEqual(contre[i].compteCredit, gain[i].compteDebit);
    assert.strictEqual(contre[i].montantCents, gain[i].montantCents);
    assert.strictEqual(contre[i].motif, 'contrepassation');
  }
  // La référence dit CE QUI a été contre-passé, sans jointure, et reste distincte de l'original :
  // la clé d'idempotence `(motif, reference, débit, crédit)` ne collisionne donc jamais.
  assert.strictEqual(contre[0].reference, 'gain:77');
  // Et le livre revient exactement à ce qu'il était avant le mouvement corrigé.
  const tout = gain.concat(contre);
  for (const c of ['enjeu:77', 'joueur:2:disponible', L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.strictEqual(L.soldeDe(tout, c), 0, c);
  // Un paquet hétéroclite n'est pas un mouvement : son inverse ne correspondrait à rien de nommable.
  assert.throws(() => L.mouvementContrepassation({
    transferts: gain.concat(L.mouvementMise({ userId: 2, matchId: 77, miseCents: 500 })) }),
    /même mouvement/);
  assert.throws(() => L.mouvementContrepassation({ transferts: [] }), /non vide/);
});

test('soldeDe rend ZÉRO sur une liste vide, et un ENTIER partout', () => {
  // Jamais `null`, jamais `undefined` : un solde absent qui se propage en `NaN` dans une somme est
  // exactement le genre de panne qu'on découvre au moment de payer quelqu'un.
  for (const c of [L.compteJoueur(1), L.compteQuarantaine(1), L.compteEnjeu(1),
                   L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE]) {
    assert.strictEqual(L.soldeDe([], c), 0);
    assert.ok(Number.isInteger(L.soldeDe([], c)));
    assert.strictEqual(L.soldeDe(undefined, c), 0);
  }
  const livre = L.mouvementDotation({ userId: 1, montantCents: 5000 })
    .concat(L.mouvementMise({ userId: 1, matchId: 1, miseCents: 50 }));
  assert.strictEqual(L.soldeDe(livre, L.compteJoueur(1)), 4950);
  assert.strictEqual(L.soldeDe(livre, L.MAISON_DOTATION), -5000);
  assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(1)), 50);
  // Un compte que le livre n'a jamais touché vaut zéro, il n'est pas « inconnu ».
  assert.strictEqual(L.soldeDe(livre, L.compteEnjeu(999)), 0);
});

// ------------------------------------------------------------------------------------------------
// L'EXPOSITION DE LA MAISON (phase 04a, module 1). Le grand livre MESURAIT l'exposition depuis la
// phase 03 ; il ne la BORNAIT pas. Ces fonctions la rendent calculable, et rien ne les appelle
// encore : aucune route, aucune colonne, aucun changement de schéma. C'est « le contrat avant le
// brancheur », déjà employé en 02a pour `seedFor` et `matchFlow`, et le prix est écrit dans
// `docs/PHASE-04A.md` — hors de ces tests, le module ne tourne nulle part.
console.log('L\'exposition de la maison : le pire cas, la référence, le plafond');

// Le pire cas d'une table, RECALCULÉ depuis `WBCore` et jamais écrit à la main : le net maximal que
// `purseBound` autorise, moins la mise que le joueur a réellement versée.
function pireCasDe(miseCents, seats) {
  return L.expositionBilletMaxCents(C.cashoutCents(C.purseBound(miseCents, seats).maxCents).netCents,
                                    miseCents);
}

test('LE PIRE CAS D\'UN BILLET est confronté aux ÉCRITURES RÉELLES, sur les quatre paliers et les cinq modes', () => {
  // Jamais asserté depuis une formule recopiée : c'est la leçon du pot forfaitaire ressuscité, qui a
  // coûté un `ecart_cents` de −520. Le chiffre annoncé est comparé AU CENTIME à ce que les jambes de
  // maison de `mouvementGain` portent vraiment quand le joueur rafle toute la table.
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const p = C.cashoutCents(C.purseBound(miseCents, seats).maxCents);
    const annonce = L.expositionBilletMaxCents(p.netCents, miseCents);
    const livre = L.mouvementMise({ userId: 1, matchId: 42, miseCents })
      .concat(L.mouvementGain({ userId: 1, matchId: 42, miseCents, grossCents: p.grossCents,
                                feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
    assert.strictEqual(annonce, L.expositionDe(livre, ['42']),
      `${id} $${miseCents / 100} : le pire cas annoncé n'est pas celui que le livre porte`);
    // Et il vaut bien ce que la maison paie de sa poche : le brut versé au pot, moins ce que la
    // commission rattrape, moins la seule mise qui a été réellement versée.
    assert.strictEqual(annonce, (p.grossCents - miseCents) - p.feeCents, `${id} $${miseCents / 100}`);
    assert.ok(Number.isSafeInteger(annonce) && annonce > 0, `${id} : ${annonce}`);
  }
  // LE CLAMP À ZÉRO, sur la seule forme de table qui le déclenche : un net maximal sous la mise
  // n'expose la maison à rien — le séquestre suffit à payer, et le reliquat rentre chez elle.
  assert.strictEqual(L.expositionBilletMaxCents(0, 1000), 0);
  assert.strictEqual(L.expositionBilletMaxCents(999, 1000), 0);
  assert.strictEqual(L.expositionBilletMaxCents(1000, 1000), 0);
  assert.strictEqual(L.expositionBilletMaxCents(1001, 1000), 1);
  // Elle REÇOIT le net maximal, elle ne le calcule pas : ce qui n'est pas un entier de centimes est
  // refusé, jamais arrondi en silence.
  for (const mauvais of [-1, 1.5, NaN, Infinity, '800', null, undefined])
    assert.throws(() => L.expositionBilletMaxCents(mauvais, 100), /netMaxCents invalide/, String(mauvais));
  for (const mauvais of [0, -1, 1.5, NaN, '100', null])
    assert.throws(() => L.expositionBilletMaxCents(800, mauvais), /montant invalide/, String(mauvais));
});

test('LE MAXIMUM DU DOMAINE vaut 39 000 centimes, et la table qui le porte est la Resurgence à 10 $', () => {
  let max = 0;
  const porteuses = [];
  for (const { id, seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const pire = pireCasDe(miseCents, seats);
    if (pire > max) { max = pire; porteuses.length = 0; }
    if (pire === max) porteuses.push(`${id} $${miseCents / 100}`);
  }
  assert.strictEqual(max, 39000, 'le pire cas du domaine a bougé : le plafond doit être re-décidé');
  // La table est NOMMÉE, pas seulement chiffrée : cinquante sièges à 10 $, brut maximal 50 000,
  // commission 10 000, net 40 000, donc 39 000 d'exposition pour 1 000 misés. La resurgence en duo
  // porte les mêmes cinquante sièges, donc le même pire cas : les deux sont attendues.
  assert.deepStrictEqual(porteuses, ['resurgence $10', 'resurgenceDuo $10']);
  assert.strictEqual(C.seatsOf(C.MODES.resurgence), 50);
  assert.deepStrictEqual(C.cashoutCents(C.purseBound(1000, 50).maxCents),
                         { grossCents: 50000, feeCents: 10000, netCents: 40000 });
  assert.strictEqual(pireCasDe(1000, 50), 39000);
});

test('PLAFOND_JOUEUR_CENTS est DÉRIVÉ du pire cas maximal, recalculé depuis WBCore et jamais écrit à la main', () => {
  // LES DEUX ANCRAGES, et il faut les deux :
  //
  // 1. LE PLANCHER. Sous 39 000, la Resurgence à 10 $ devient impossible à ouvrir pour tout le monde
  //    et tout le temps, et la panne se lirait comme un bug du lobby. Un nombre rond « raisonnable »
  //    — 10 000, 20 000 — ferme silencieusement les deux tables les plus chères. Le plafond décide
  //    donc quelles tables EXISTENT.
  // 2. LE SECOND ANCRAGE, celui qui manquait. Sous 78 000, une seule victoire maximale ferme la
  //    table pour vingt-quatre heures : le joueur a consommé 39 000, son billet suivant en pèse
  //    39 000 de plus. Le premier gros gagnant LÉGITIME lirait `plafond` sur un lobby qui a l'air
  //    cassé, et il lui faudrait trente-neuf défaites pour effacer sa victoire.
  //
  // D'où la question retenue — combien de tables maximales laisse-t-on ouvertes après une grosse
  // sortie ? — et la réponse : quatre. Un palier ou un mode qui change fait tomber ce test, pour que
  // quelqu'un RE-DÉCIDE au lieu de laisser un nombre survivre à la table qui l'a justifié.
  let pireCasMaximal = 0;
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER)
    pireCasMaximal = Math.max(pireCasMaximal, pireCasDe(miseCents, seats));
  assert.strictEqual(L.PLAFOND_JOUEUR_CENTS, L.PLAFOND_TABLES_PAR_JOUR * pireCasMaximal);
  assert.ok(L.PLAFOND_JOUEUR_CENTS >= pireCasMaximal, 'sous un pire cas, la table la plus chère n\'existe plus');
  assert.ok(L.PLAFOND_JOUEUR_CENTS >= 2 * pireCasMaximal, 'sous deux pires cas, une seule victoire ferme la table');
  // Le fusible global vaut environ treize comptes saturés dans la même journée. Ce n'est pas un
  // invariant, c'est un aveu daté : le remède à la flotte de comptes est une vérification
  // d'identité, et elle est en 04b.
  assert.ok(L.PLAFOND_MAISON_CENTS > L.PLAFOND_JOUEUR_CENTS,
    'un fusible global sous le plafond par joueur rendrait le second inatteignable');
  assert.strictEqual(Math.floor(L.PLAFOND_MAISON_CENTS / L.PLAFOND_JOUEUR_CENTS), 12,
    'le fusible ne vaut plus le nombre de comptes saturés annoncé dans la spécification');
});

test('les cinq constantes du plafond sont des ENTIERS de centimes, d\'heures ou de secondes', () => {
  // L'argent se compte en centimes entiers, jamais en flottant : un arrondi sur un seuil se voit au
  // moment où il refuse quelqu'un, c'est-à-dire trop tard.
  const attendu = { PLAFOND_FENETRE_H: 24, PLAFOND_TABLES_PAR_JOUR: 4, PLAFOND_JOUEUR_CENTS: 156000,
                    PLAFOND_MAISON_CENTS: 2000000, FUSIBLE_RAFRAICHI_S: 60 };
  for (const [nom, valeur] of Object.entries(attendu)) {
    assert.strictEqual(L[nom], valeur, nom);
    assert.ok(Number.isSafeInteger(L[nom]) && L[nom] > 0, `${nom} = ${L[nom]}`);
  }
  // La fenêtre est GLISSANTE, et pas une journée calendaire : attendre minuit deviendrait une
  // stratégie. Et le fusible se relit à une cadence, pas à chaque ouverture — le lire sous le verrou
  // de ligne ferait de chaque billet un agrégat non borné sur la table qui grossit le plus vite.
  assert.ok(L.FUSIBLE_RAFRAICHI_S < L.PLAFOND_FENETRE_H * 3600);
});

test('expositionDe rend un entier SIGNÉ : positif quand la maison a versé, négatif sur un billet perdu, zéro sur un livre vide', () => {
  // Zéro sur un livre vide, et un VRAI zéro : `-0` est un nombre distinct de `0` pour `Object.is`,
  // donc pour `assert.strictEqual` et pour toute comparaison stricte qu'un appelant écrirait.
  assert.strictEqual(L.expositionDe([], ['1']), 0);
  assert.strictEqual(L.expositionDe(undefined, ['1']), 0);
  assert.strictEqual(L.expositionDe([], []), 0);
  assert.ok(Object.is(L.expositionDe([], ['1']), 0), 'un livre vide rend « moins zéro »');

  // LE JOUEUR QUI RAFLE LA TABLE : la maison a versé, l'exposition est positive.
  const p = C.cashoutCents(C.purseBound(1000, 50).maxCents);
  const gagne = L.mouvementMise({ userId: 1, matchId: 1, miseCents: 1000 })
    .concat(L.mouvementGain({ userId: 1, matchId: 1, miseCents: 1000, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  assert.strictEqual(L.expositionDe(gagne, ['1']), 39000);

  // LE JOUEUR QUI PERD : le séquestre part entier chez la contrepartie, donc l'exposition est
  // NÉGATIVE D'EXACTEMENT LA MISE. C'est ce qui finance les versements du cas précédent, et c'est
  // pour cela que l'exposition est nette.
  const perdu = C.cashoutCents(0);
  const perte = L.mouvementMise({ userId: 1, matchId: 2, miseCents: 1000 })
    .concat(L.mouvementGain({ userId: 1, matchId: 2, miseCents: 1000, grossCents: perdu.grossCents,
                              feeCents: perdu.feeCents, netCents: perdu.netCents, convergee: true }));
  assert.strictEqual(L.expositionDe(perte, ['2']), -1000);

  // Et elle est NETTE sur l'ensemble : les billets perdus s'imputent sur les gagnés.
  const tout = gagne.concat(perte);
  assert.strictEqual(L.expositionDe(tout, ['1', '2']), 38000);
  // Restreinte aux références demandées, et à elles seules : un billet qu'on n'interroge pas ne
  // pèse rien. C'est ce qui rendra l'agrégat borné par joueur et par fenêtre.
  assert.strictEqual(L.expositionDe(tout, ['1']), 39000);
  assert.strictEqual(L.expositionDe(tout, ['2']), -1000);
  assert.strictEqual(L.expositionDe(tout, ['3']), 0);
  // Les trois formes qu'un pilote Postgres rend pour un `bigserial` désignent le même billet.
  for (const r of [1, '1', 1n]) assert.strictEqual(L.expositionDe(tout, [r]), 39000, String(r));
  assert.strictEqual(L.expositionDe(tout, new Set(['1', '2'])), 38000, 'un Set est un ensemble comme un autre');
  for (const mauvais of ['007', '0', -3, 1.5, '', 'sept', null])
    assert.throws(() => L.expositionDe(tout, [mauvais]), /identifiant/, String(mauvais));
});

test('LA DOTATION ET LA RECHARGE n\'entrent JAMAIS dans l\'exposition, même quand elles dominent le livre', () => {
  // Émettre des crédits fictifs n'est pas s'exposer. `maison:dotation` est donc hors de la somme, et
  // ce n'est pas un oubli : sans cette règle, la première connexion de chaque joueur compterait pour
  // 5 000 centimes d'exposition, et le fusible global sauterait sur des inscriptions.
  const p = C.cashoutCents(C.purseBound(1000, 50).maxCents);
  const partie = L.mouvementMise({ userId: 7, matchId: 7, miseCents: 1000 })
    .concat(L.mouvementGain({ userId: 7, matchId: 7, miseCents: 1000, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  const nu = L.expositionDe(partie, ['7']);
  assert.strictEqual(nu, 39000);

  // On noie la partie sous des émissions : mille dotations et mille recharges, soit six millions de
  // centimes émis — trois fois le fusible global. L'exposition ne doit pas bouger d'un centime.
  let bruyant = [];
  for (let u = 1; u <= 1000; u++) {
    bruyant = bruyant.concat(L.mouvementDotation({ userId: u, montantCents: L.DOTATION_CENTS }));
    bruyant = bruyant.concat(L.mouvementRecharge({ userId: u, jour: '2026-09-15', montantCents: L.RECHARGE_CENTS }));
  }
  assert.ok(-L.soldeDe(bruyant, L.MAISON_DOTATION) >= 3 * L.PLAFOND_MAISON_CENTS, 'le bruit ne domine pas assez');
  assert.strictEqual(L.expositionDe(bruyant.concat(partie), ['7']), nu);
  assert.strictEqual(L.expositionDe(bruyant, ['7']), 0);

  // LE PIÈGE EXACT : la référence d'une dotation est l'identifiant du JOUEUR, celle d'une recharge
  // `<joueur>:<jour>`. Le joueur 7 et le billet 7 portent donc le même texte, et une lecture qui
  // regarderait la référence sans regarder le motif les confondrait. On le prouve sur une écriture
  // de motif `dotation` qui touche un compte de maison — la grammaire l'autorise, aucun mouvement
  // ne la produit, et c'est précisément le genre de ligne qu'un incident ferait naître.
  const piege = [L.transfert('dotation', '7', L.MAISON_CONTREPARTIE, L.compteJoueur(7), 50000)];
  assert.strictEqual(L.expositionDe(piege, ['7']), 0, 'une dotation a été prise pour un billet');
  assert.strictEqual(L.referenceBillet('dotation', '7'), null);
  assert.strictEqual(L.referenceBillet('recharge', '7:2026-09-15'), null);
});

test('UN GAIN CONTRE-PASSÉ est bien vu : l\'exposition retombe exactement où elle était', () => {
  // LE DÉFAUT QUE CE MODULE EXISTE POUR FAIRE NAÎTRE FERMÉ. `mouvementContrepassation` écrit
  // `gain:<id>` et non `<id>` — pour qu'on lise dans le livre CE QUI a été contre-passé sans faire
  // de jointure. Une lecture par `reference::bigint` lèverait `22P02` sur ces lignes ; une lecture
  // qui les filtre les IGNORE, et un gain contre-passé continuerait de compter dans l'exposition.
  // Le module qui écrit la requête n'est pas celui qui crée les lignes qui la cassent : sans ce
  // test, le défaut naîtrait vert et se révélerait une phase plus tard.
  const p = C.cashoutCents(C.purseBound(1000, 50).maxCents);
  const mise = L.mouvementMise({ userId: 5, matchId: 5, miseCents: 1000 });
  const gain = L.mouvementGain({ userId: 5, matchId: 5, miseCents: 1000, grossCents: p.grossCents,
                                 feeCents: p.feeCents, netCents: p.netCents, convergee: true });
  assert.strictEqual(L.expositionDe(mise.concat(gain), ['5']), 39000);

  const contre = L.mouvementContrepassation({ transferts: gain });
  assert.strictEqual(contre[0].reference, 'gain:5', 'la référence d\'une contre-passation porte son motif d\'origine');
  // Le gain est annulé, donc l'exposition aussi : elle retombe à ce qu'elle était avant lui — la
  // mise seule, que la maison n'a pas encore encaissée.
  assert.strictEqual(L.expositionDe(mise.concat(gain, contre), ['5']), 0);
  // Et le livre boucle : c'est la vérification que le zéro global ne suffit pas à donner.
  for (const c of ['enjeu:5', L.compteJoueur(5), L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE])
    assert.strictEqual(L.soldeDe(gain.concat(contre), c), 0, c);
  // La contre-passation de la MISE se rattache au même billet, elle aussi.
  assert.strictEqual(L.referenceBillet('contrepassation', 'mise:5'), '5');
  assert.strictEqual(L.referenceBillet('contrepassation', 'remboursement:5'), '5');
});

test('referenceBillet est EXHAUSTIVE : les six mouvements et leurs contre-passations se ramènent au bon billet, ou à null', () => {
  // On BALAIE `MOTIFS`, on ne code pas six cas à la main : un septième motif ajouté sans lire cette
  // fonction fait tomber le test au lieu de produire une référence qu'elle ignorerait en silence.
  const p = C.cashoutCents(2500);
  const fabriques = {
    dotation: () => L.mouvementDotation({ userId: 3, montantCents: L.DOTATION_CENTS }),
    recharge: () => L.mouvementRecharge({ userId: 3, jour: '2026-09-15', montantCents: L.RECHARGE_CENTS }),
    mise: () => L.mouvementMise({ userId: 3, matchId: 42, miseCents: 100 }),
    gain: () => L.mouvementGain({ userId: 3, matchId: 42, miseCents: 100, grossCents: p.grossCents,
                                  feeCents: p.feeCents, netCents: p.netCents, convergee: true }),
    remboursement: () => L.mouvementRemboursement({ userId: 3, matchId: 42, miseCents: 100 }),
    contrepassation: () => L.mouvementContrepassation({ transferts: L.mouvementMise({ userId: 3, matchId: 42, miseCents: 100 }) }),
  };
  // `dotation` et `recharge` ne parlent d'aucun billet ; les quatre autres parlent du billet 42.
  const attendu = { dotation: null, recharge: null, mise: '42', gain: '42', remboursement: '42',
                    contrepassation: '42' };
  for (const motif of L.MOTIFS) {
    assert.ok(fabriques[motif], `le motif ${motif} n'a pas de mouvement dans ce test : la liste fermée a bougé`);
    const mvt = fabriques[motif]();
    assert.ok(mvt.length > 0);
    for (const t of mvt) {
      assert.strictEqual(t.motif, motif);
      assert.strictEqual(L.referenceBillet(t.motif, t.reference), attendu[motif],
        `${motif} (${t.reference})`);
      // Une CHAÎNE de chiffres, jamais un nombre : c'est du texte qu'on comparera à
      // `matches.id::text`, sans aucun `cast`. Un `bigint` ne tient pas toujours dans un `Number`.
      if (attendu[motif] !== null) assert.strictEqual(typeof L.referenceBillet(t.motif, t.reference), 'string');
    }
    // ET LA CONTRE-PASSATION DE CHACUN. `dotation` et `recharge` restent hors billet ; les trois
    // motifs de billet se retrouvent par leur préfixe.
    const contre = L.mouvementContrepassation({ transferts: mvt });
    const attenduContre = motif === 'contrepassation' ? null : attendu[motif];
    for (const t of contre)
      assert.strictEqual(L.referenceBillet(t.motif, t.reference), attenduContre,
        `contre-passation de ${motif} (${t.reference})`);
  }
  // LA LIMITE, NOMMÉE PLUTÔT QUE DÉCOUVERTE : contre-passer une contre-passation produit
  // `contrepassation:mise:42`, que la règle ne ramène à aucun billet. Ce double geste n'a pas
  // d'appelant — l'outil de la phase 04a corrige un mouvement d'origine — et l'élargir demanderait
  // d'élargir aussi `REFERENCE_BILLET_SQL`, donc de re-décider des deux côtés à la fois.
  // `docs/PHASE-04A.md` le consigne.
  assert.strictEqual(L.referenceBillet('contrepassation', 'contrepassation:mise:42'), null);

  // Ce qui ne désigne aucun billet rend `null` et ne lance pas : le livre porte du texte libre dans
  // cette colonne, et une lecture d'agrégat qui lèverait sur une ligne bizarre refuserait un billet
  // légitime.
  for (const r of ['', '0', '007', '-1', '1.5', 'quarante-deux', '42:', ':42', '42 ', ' 42',
                   'gain:42', 'gain:007', '9007199254740993'])
    assert.strictEqual(L.referenceBillet('gain', r), /^[1-9][0-9]*$/.test(r) ? r : null, `gain ${r}`);
  for (const r of ['', 'gain:', 'gain:0', 'gain:007', 'dotation:3', 'recharge:3:2026-09-15',
                   'GAIN:42', 'gain:42:1', 'x:42', '42'])
    assert.strictEqual(L.referenceBillet('contrepassation', r), null, `contrepassation ${r}`);
  for (const r of [42, null, undefined, {}, ['42']])
    assert.strictEqual(L.referenceBillet('gain', r), null, String(r));
  // Un identifiant de billet plus grand que `Number.MAX_SAFE_INTEGER` traverse sans perte, parce
  // qu'il ne devient jamais un nombre.
  assert.strictEqual(L.referenceBillet('gain', '9007199254740993'), '9007199254740993');
  // Un motif hors liste LANCE : la même règle que partout ailleurs dans ce fichier.
  for (const mauvais of ['', 'MISE', 'depot', null, undefined])
    assert.throws(() => L.referenceBillet(mauvais, '42'), /motif hors liste/, String(mauvais));
});

test('REFERENCE_BILLET_SQL est la MÊME règle, écrite une seule fois, et prête pour le schéma', () => {
  // Même patron que `COMPTE_RE_SQL` : la chaîne est la source, le reste en dérive, et une garde
  // textuelle d'un module ultérieur comparera le texte du schéma à cette chaîne. Il ne doit jamais
  // exister deux écritures de la même règle — c'est le patron du `respawn()` défini deux fois, et
  // ici la seconde vivrait dans un fichier `.sql` que personne ne relit.
  assert.strictEqual(typeof L.REFERENCE_BILLET_SQL, 'string');
  assert.ok(L.REFERENCE_BILLET_SQL.startsWith('case when ') && L.REFERENCE_BILLET_SQL.endsWith(' else null end'),
    L.REFERENCE_BILLET_SQL);
  assert.ok(!L.REFERENCE_BILLET_SQL.includes('\n'), 'une expression sur une seule ligne se compare sans normaliser');
  // AUCUN `cast`, aucune conversion : on comparera du TEXTE à `matches.id::text`. Un
  // `reference::bigint` lèverait `22P02` sur `gain:42`, et c'est tout le sujet de cette règle.
  for (const interdit of ['::bigint', '::int', '::numeric', 'cast('])
    assert.ok(!L.REFERENCE_BILLET_SQL.includes(interdit), interdit);
  // Les trois motifs de billet et le motif de correction y sont nommés, et les identifiants y
  // portent la même forme que dans la grammaire des comptes : pas de zéro de tête, jamais.
  for (const m of ['mise', 'gain', 'remboursement', 'contrepassation'])
    assert.ok(L.REFERENCE_BILLET_SQL.includes(`'${m}'`) || L.REFERENCE_BILLET_SQL.includes(`${m}|`)
              || L.REFERENCE_BILLET_SQL.includes(`|${m}:`), m);
  assert.ok(L.REFERENCE_BILLET_SQL.includes('[1-9][0-9]*'), L.REFERENCE_BILLET_SQL);
  assert.ok(L.COMPTE_RE_SQL.includes('[1-9][0-9]*'), 'les deux règles doivent refuser le même zéro de tête');
  // Le groupe des motifs est NON CAPTURANT : Postgres rend, par `substring(texte from motif)`, la
  // première parenthèse CAPTURANTE. Capturer le motif d'origine rendrait « gain » là où on attend
  // « 42 », et la lecture serait vide au lieu d'être fausse — donc silencieuse.
  const m = /substring\(reference from '([^']+)'\)/.exec(L.REFERENCE_BILLET_SQL);
  assert.ok(m, 'l\'extraction de la contre-passation n\'a pas été retrouvée dans l\'expression SQL');
  assert.ok(m[1].includes('(?:'), 'le groupe des motifs doit être non capturant');
  // Et l'expression extraite est CELLE QUE JAVASCRIPT APPLIQUE : on la rejoue sur les références que
  // les mouvements produisent vraiment, et elle doit rendre ce que `referenceBillet` rend.
  const sql = new RegExp(m[1]);
  for (const ref of ['mise:42', 'gain:42', 'remboursement:42', 'dotation:3', 'recharge:3:2026-09-15',
                     'contrepassation:mise:42', 'gain:007', 'gain:', '42']) {
    const par = sql.exec(ref);
    assert.strictEqual(par === null ? null : par[1], L.referenceBillet('contrepassation', ref), ref);
  }
});

test('plafondVerdict est MONOTONE, et ramène l\'exposition réalisée à ZÉRO avant de comparer', () => {
  const plafondCents = L.PLAFOND_JOUEUR_CENTS, billet = 39000;
  // ACCUMULER DES PERTES N'ACHÈTE AUCUNE MARGE. L'exposition est nette — les billets perdus
  // s'imputent sur les gagnés — mais une exposition négative reportée serait un compte d'épargne à
  // moissonner : perdre cent parties achèterait le droit d'en gagner une très grosse.
  const plancher = L.plafondVerdict({ expositionRealiseeCents: 0, expositionBilletCents: billet, plafondCents });
  for (const perte of [-1, -1000, -100000, -L.PLAFOND_MAISON_CENTS]) {
    const v = L.plafondVerdict({ expositionRealiseeCents: perte, expositionBilletCents: billet, plafondCents });
    assert.deepStrictEqual({ ...v }, { ...plancher }, `${perte} a acheté de la marge`);
    assert.strictEqual(v.expositionCents, billet);
  }
  // LA MONOTONIE : croître l'exposition ne fait JAMAIS repasser le verdict au vert.
  let dejaFranchi = false;
  let precedent = -1;
  for (let realisee = -50000; realisee <= 250000; realisee += 137) {
    const v = L.plafondVerdict({ expositionRealiseeCents: realisee, expositionBilletCents: billet, plafondCents });
    assert.ok(v.expositionCents >= precedent, 'l\'exposition a reculé alors qu\'elle croissait');
    precedent = v.expositionCents;
    if (dejaFranchi) assert.ok(v.franchi, `le verdict est repassé au vert à ${realisee}`);
    dejaFranchi = dejaFranchi || v.franchi;
    assert.strictEqual(v.franchi, Math.max(0, realisee) + billet > plafondCents);
    assert.strictEqual(v.plafondCents, plafondCents);
  }
  assert.ok(dejaFranchi, 'le plafond n\'a jamais été franchi : le balayage ne prouve rien');
  // Monotone AUSSI en la taille du billet : une table plus chère ne peut pas rendre vert ce qu'une
  // table moins chère rendait rouge.
  let vu = false;
  for (const { seats } of MODES_LEDGER) for (const miseCents of MISES_LEDGER) {
    const v = L.plafondVerdict({ expositionRealiseeCents: 130000,
                                 expositionBilletCents: pireCasDe(miseCents, seats), plafondCents });
    if (v.franchi) vu = true;
    else assert.ok(!vu || pireCasDe(miseCents, seats) < 26000);
  }
  // LA COMPARAISON EST STRICTE : il faut que le QUATRIÈME billet maximal passe, sans quoi
  // `PLAFOND_TABLES_PAR_JOUR` en vaudrait trois et le second ancrage serait faux d'une table.
  assert.strictEqual(L.plafondVerdict({ expositionRealiseeCents: 3 * billet,
    expositionBilletCents: billet, plafondCents }).franchi, false);
  assert.strictEqual(L.plafondVerdict({ expositionRealiseeCents: 3 * billet + 1,
    expositionBilletCents: billet, plafondCents }).franchi, true);
  // Le verdict est gelé : un appelant qui corrigerait `expositionCents` en place réécrirait la
  // mesure au lieu de re-décider.
  assert.ok(Object.isFrozen(plancher));
  for (const mauvais of [1.5, NaN, Infinity, '0', null, undefined])
    assert.throws(() => L.plafondVerdict({ expositionRealiseeCents: mauvais,
      expositionBilletCents: 0, plafondCents }), /expositionRealiseeCents invalide/, String(mauvais));
  for (const mauvais of [-1, 1.5, NaN, '0', null])
    for (const champ of ['expositionBilletCents', 'plafondCents'])
      assert.throws(() => L.plafondVerdict({ expositionRealiseeCents: 0, expositionBilletCents: 0,
        plafondCents, [champ]: mauvais }), new RegExp(`${champ} invalide`), `${champ} ${mauvais}`);
});

test('LE PLAFOND EST UNE SOMME : on le franchit en POSANT DES ÉCRITURES, jamais en touchant un compteur', () => {
  // La doctrine de `user_stats`, appliquée une fois de plus : un compteur qu'on incrémente est une
  // case qu'on écrase, une somme sur des lignes immuables ne peut pas être fausse. Le corollaire est
  // celui-ci, et il est testable : aucune colonne n'existe à lire, et RELIRE redonne le même chiffre.
  const miseCents = 1000, seats = 50, billet = pireCasDe(miseCents, seats);
  const p = C.cashoutCents(C.purseBound(miseCents, seats).maxCents);
  let livre = [];
  const references = [];
  for (let id = 1; id <= L.PLAFOND_TABLES_PAR_JOUR; id++) {
    references.push(String(id));
    livre = livre.concat(L.mouvementMise({ userId: 1, matchId: id, miseCents }),
      L.mouvementGain({ userId: 1, matchId: id, miseCents, grossCents: p.grossCents,
                        feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
    const realisee = L.expositionDe(livre, references);
    assert.strictEqual(realisee, id * billet, `après ${id} victoires maximales`);
    // Le billet SUIVANT : il passe tant qu'on n'a pas consommé les quatre tables de la fenêtre.
    const v = L.plafondVerdict({ expositionRealiseeCents: realisee, expositionBilletCents: billet,
                                 plafondCents: L.PLAFOND_JOUEUR_CENTS });
    assert.strictEqual(v.franchi, id >= L.PLAFOND_TABLES_PAR_JOUR, `billet ${id + 1}`);
  }
  assert.strictEqual(L.expositionDe(livre, references), L.PLAFOND_JOUEUR_CENTS,
    'quatre tables maximales valent exactement le plafond par joueur');

  // RELIRE REDONNE LE MÊME CHIFFRE, et l'ordre des écritures n'y change rien : c'est une somme, pas
  // une machine à états. Le livre est fait d'objets GELÉS, donc la relecture ne peut pas le muter.
  const relu = L.expositionDe(livre, references);
  assert.strictEqual(relu, L.expositionDe(livre, references));
  const melange = livre.slice().reverse();
  assert.strictEqual(L.expositionDe(melange, references), relu, 'la somme dépend de l\'ordre des lignes');
  for (const t of livre) assert.ok(Object.isFrozen(t), 'une écriture du livre n\'est pas gelée');

  // ET IL N'EXISTE AUCUNE COLONNE À LIRE : le module n'exporte aucun compteur, aucun état, aucune
  // fonction qui écrirait une exposition quelque part. Cinq constantes et quatre fonctions pures.
  for (const nom of ['expositionBilletMaxCents', 'referenceBillet', 'expositionDe', 'plafondVerdict'])
    assert.strictEqual(typeof L[nom], 'function', nom);
  for (const absent of ['exposition', 'incrementerExposition', 'poserExposition', 'resetExposition',
                        'expositionCourante', 'EXPOSITION'])
    assert.strictEqual(L[absent], undefined, `${absent} est un compteur : l'exposition est une somme`);
  // Une CINQUIÈME victoire maximale franchit le plafond, et le chiffre reste une somme d'écritures.
  livre = livre.concat(L.mouvementMise({ userId: 1, matchId: 5, miseCents }),
    L.mouvementGain({ userId: 1, matchId: 5, miseCents, grossCents: p.grossCents,
                      feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  references.push('5');
  assert.strictEqual(L.expositionDe(livre, references), 5 * billet);
  assert.ok(L.plafondVerdict({ expositionRealiseeCents: L.expositionDe(livre, references),
    expositionBilletCents: 0, plafondCents: L.PLAFOND_JOUEUR_CENTS }).franchi);
});

test('decouvertAutorise est FAUX hors des deux familles nommées, sur TOUTE forme que la grammaire engendre', () => {
  // La garde qui empêchera un futur `maison:reserve` d'hériter du découvert par distraction. Jusqu'ici
  // `decouvertAutorise` n'avait jamais été confrontée à l'ESPACE des comptes, seulement aux deux
  // littéraux de `COMPTES_EMETTEURS` et à trois voisins choisis à la main.
  const grammaire = new RegExp(L.COMPTE_RE_SQL);
  let vus = 0;
  const formes = [];
  // Les trois familles paramétrées, balayées sur des identifiants de toutes les magnitudes qu'un
  // `bigserial` produit — jusqu'au-delà de `Number.MAX_SAFE_INTEGER`, que le compte porte en texte.
  const ids = ['1', '2', '7', '10', '99', '12345', '2147483647', '9007199254740993',
               '9223372036854775807'];
  for (const n of ids) {
    formes.push(`joueur:${n}:disponible`, `joueur:${n}:quarantaine`, `enjeu:${n}`);
  }
  formes.push(L.MAISON_DOTATION, L.MAISON_COMMISSION, L.MAISON_CONTREPARTIE);
  for (const compte of formes) {
    assert.ok(grammaire.test(compte), `${compte} n'est pas engendré par la grammaire`);
    const attendu = L.COMPTES_EMETTEURS.includes(compte);
    assert.strictEqual(L.decouvertAutorise(compte), attendu, compte);
    vus++;
  }
  assert.strictEqual(vus, ids.length * 3 + 3);
  // DEUX comptes seulement, et ils sont nommés : le compte d'ÉMISSION et celui de CONTREPARTIE,
  // dont le solde négatif EST la mesure qu'on cherche.
  assert.strictEqual(formes.filter(c => L.decouvertAutorise(c)).length, 2);
  assert.deepStrictEqual(L.COMPTES_EMETTEURS.slice(), [L.MAISON_DOTATION, L.MAISON_CONTREPARTIE]);
  // Et LES SÉQUESTRES N'EN SONT PAS, sur toute la famille : c'est ce qui fait qu'un second gain sur
  // un même billet devrait débiter un séquestre déjà vide, donc se fait refuser. « Un billet a au
  // plus un gain » ne repose alors pas uniquement sur un index.
  for (const n of ids) assert.ok(!L.decouvertAutorise(`enjeu:${n}`), n);
  // Un compte hors grammaire LANCE, il ne rend pas « faux » : un troisième compte de maison qui
  // n'existe pas encore doit se faire refuser à la grammaire AVANT d'arriver ici.
  for (const futur of ['maison:reserve', 'maison:tresorerie', 'maison:depot', 'maison:retrait',
                       'reel:maison:contrepartie', 'fictif:maison:dotation', 'maison:contrepartie:1',
                       'MAISON:DOTATION', 'maison:contrepartie ', ''])
    assert.throws(() => L.decouvertAutorise(futur), /hors grammaire/, futur);
});

console.log('Le grand livre : la réconciliation');
// Un scénario minimal : un billet réglé, sa mise et son gain. C'est cette forme-là que
// `ledgerReconcile` devra retrouver à la fin de chaque scénario d'`api/test.js` dans les modules
// suivants.
function scenarioRegle({ id = 1, userId = 1, miseCents = 100, sacoche = 400, digest_match = true } = {}) {
  const p = C.cashoutCents(sacoche);
  const ligne = { id, user_id: userId, status: 'settled', stake_cents: miseCents,
                  gross_cents: p.grossCents, fee_cents: p.feeCents, net_cents: p.netCents, digest_match };
  const livre = L.mouvementMise({ userId, matchId: id, miseCents })
    .concat(L.mouvementGain({ userId, matchId: id, miseCents, grossCents: p.grossCents,
                              feeCents: p.feeCents, netCents: p.netCents, convergee: digest_match }));
  return { ligne, livre };
}

test('ledgerReconcile ne se plaint de rien quand tout s\'apparie, sur les cinq issues', () => {
  const { ligne, livre } = scenarioRegle();
  assert.deepStrictEqual(L.ledgerReconcile(ligne, livre), []);
  assert.deepStrictEqual(L.ledgerReconcile([ligne], livre), []);
  // Une ligne OUVERTE : le séquestre porte la mise, et rien d'autre.
  const ouvert = { id: 2, user_id: 1, status: 'open', stake_cents: 50, net_cents: null };
  assert.deepStrictEqual(L.ledgerReconcile(ouvert, L.mouvementMise({ userId: 1, matchId: 2, miseCents: 50 })), []);
  // Les trois autres clôtures, séquestre vidé vers la contrepartie et aucun montant à retrouver.
  // `renounced` N'EST PAS DE CETTE BOUCLE : un billet renoncé dont le séquestre part chez la maison
  // en motif `gain` est un état que le code ne produit jamais — c'est la seule issue qui RENDE la
  // mise — et l'y laisser aurait fait asserter qu'il ne produit aucun grief, ce que la règle de
  // destination refuse désormais, à raison. Son cas légitime est juste en dessous.
  for (const status of ['expired', 'rejected', 'abandoned']) {
    const clos = { id: 3, user_id: 1, status, stake_cents: 50, net_cents: null };
    const vide = L.mouvementMise({ userId: 1, matchId: 3, miseCents: 50 })
      .concat(L.mouvementGain({ matchId: 3, miseCents: 50, grossCents: 0, feeCents: 0, netCents: 0 }));
    assert.deepStrictEqual(L.ledgerReconcile(clos, vide), [], status);
  }
  // Une ligne renoncée dont la mise est rendue boucle aussi.
  const rendu = { id: 4, user_id: 1, status: 'renounced', stake_cents: 50, net_cents: null };
  assert.deepStrictEqual(L.ledgerReconcile(rendu,
    L.mouvementMise({ userId: 1, matchId: 4, miseCents: 50 })
      .concat(L.mouvementRemboursement({ userId: 1, matchId: 4, miseCents: 50 }))), []);
  // Une ligne DIVERGENTE : le net est en quarantaine, et c'est là qu'il doit être retrouvé.
  const d = scenarioRegle({ id: 5, digest_match: false });
  assert.deepStrictEqual(L.ledgerReconcile(d.ligne, d.livre), []);
});

test('ledgerReconcile attrape un montant JUSTE posé sur le MAUVAIS compte', () => {
  // Le zéro global ne dit RIEN sur cet appariement : il est vrai même si un montant juste est posé
  // sur le mauvais compte. C'est exactement, et seulement, ce que ce prédicat existe pour attraper.
  const { ligne, livre } = scenarioRegle();
  const totalDe = l => { const s = new Set(); for (const t of l) { s.add(t.compteDebit); s.add(t.compteCredit); }
                         let n = 0; for (const c of s) n += L.soldeDe(l, c); return n; };

  // 1. Le net d'une ligne CONVERGÉE posé en quarantaine : le livre boucle, le joueur est volé.
  const egare = livre.map(t => t.compteCredit === L.compteJoueur(1)
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.compteQuarantaine(1), t.montantCents) : t);
  assert.strictEqual(totalDe(egare), 0, 'le livre boucle quand même : c\'est le piège');
  const g1 = L.ledgerReconcile(ligne, egare);
  assert.ok(g1.some(x => /joueur:1:disponible/.test(x)), g1.join(' | '));
  assert.ok(g1.some(x => /quarantaine/.test(x)), g1.join(' | '));

  // 2. Le net d'une ligne DIVERGENTE posé sur le solde dépensable : la garantie « le solde
  //    dépensable ne compte que des lignes convergées » tombe, et rien d'autre ne le verrait.
  const d = scenarioRegle({ id: 6, digest_match: false });
  const dépensé = d.livre.map(t => t.compteCredit === L.compteQuarantaine(1)
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.compteJoueur(1), t.montantCents) : t);
  assert.strictEqual(totalDe(dépensé), 0);
  assert.ok(L.ledgerReconcile(d.ligne, dépensé).length > 0);

  // 3. La commission versée à la contrepartie : boucle encore, et fausse la mesure de la phase.
  const detourne = livre.map(t => t.compteCredit === L.MAISON_COMMISSION
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.MAISON_CONTREPARTIE, t.montantCents) : t);
  assert.strictEqual(totalDe(detourne), 0);
  const g3 = L.ledgerReconcile(ligne, detourne);
  assert.ok(g3.some(x => /maison:commission/.test(x)), g3.join(' | '));

  // 4. Le bon compte, le mauvais montant : le net d'une AUTRE partie.
  const faux = { ...ligne, net_cents: ligne.net_cents + 1, fee_cents: ligne.fee_cents - 1 };
  assert.strictEqual(L.ledgerReconcile(faux, livre).length, 2);

  // 5. LE REMBOURSEMENT MAL DIRIGÉ, et c'est la sixième issue de la phase : elle n'avait qu'un cas
  //    positif. Le joueur a renoncé DANS sa fenêtre, sa mise part chez la maison au lieu de revenir
  //    sur son compte disponible — le livre boucle, le séquestre est vide, `net_cents` est nul.
  const renonce = { id: 7, user_id: 1, status: 'renounced', stake_cents: 50, net_cents: null };
  const rendu = L.mouvementMise({ userId: 1, matchId: 7, miseCents: 50 })
    .concat(L.mouvementRemboursement({ userId: 1, matchId: 7, miseCents: 50 }));
  assert.deepStrictEqual(L.ledgerReconcile(renonce, rendu), [], 'le cas légitime, pour référence');
  const vole = rendu.map(t => t.motif === 'remboursement'
    ? L.transfert(t.motif, t.reference, t.compteDebit, L.MAISON_CONTREPARTIE, t.montantCents) : t);
  assert.strictEqual(totalDe(vole), 0, 'le livre boucle quand même : c\'est le piège');
  const g5 = L.ledgerReconcile(renonce, vole);
  assert.ok(g5.some(x => /joueur:1:disponible/.test(x)), g5.join(' | '));
  assert.ok(g5.some(x => /maison:contrepartie/.test(x)), g5.join(' | '));
});

test('ledgerReconcile regarde OÙ le séquestre est parti, et pas seulement qu\'il est vide', () => {
  // LA MOITIÉ AVEUGLE DU PRÉDICAT. Sur une ligne close SANS règlement — `expired`, `abandoned`,
  // `rejected`, `renounced` — `net_cents` est nul, donc tout le bloc de comparaison des montants
  // était sauté : la réconciliation vérifiait que le séquestre était vide, jamais où il était
  // parti. « Ouvrir un billet, laisser expirer, se faire rembourser » se réconciliait en vert,
  // c'est-à-dire très exactement le vol que la fenêtre de renoncement existe pour fermer.
  const totalDe = l => { const s = new Set(); for (const t of l) { s.add(t.compteDebit); s.add(t.compteCredit); }
                         let n = 0; for (const c of s) n += L.soldeDe(l, c); return n; };

  // 1. Un billet PÉRIMÉ dont le séquestre revient chez le joueur : le veilleur ne rembourse pas.
  const perime = { id: 11, user_id: 1, status: 'expired', stake_cents: 50, net_cents: null };
  const rembourse = L.mouvementMise({ userId: 1, matchId: 11, miseCents: 50 })
    .concat([L.transfert('gain', '11', L.compteEnjeu(11), L.compteJoueur(1), 50)]);
  assert.strictEqual(totalDe(rembourse), 0, 'le livre boucle : c\'est le piège');
  assert.strictEqual(L.soldeDe(rembourse, L.compteEnjeu(11)), 0, 'et le séquestre est bien vide');
  const g1 = L.ledgerReconcile(perime, rembourse);
  assert.ok(g1.some(x => /joueur:1:disponible/.test(x) && /maison:contrepartie/.test(x)), g1.join(' | '));

  // 2. Un billet RENONCÉ dont la mise revient à QUELQU'UN D'AUTRE. Le compte crédité existe, le
  //    montant est juste, le zéro global tient : seule la comparaison au `user_id` de la ligne
  //    peut le voir.
  const renonce = { id: 12, user_id: 1, status: 'renounced', stake_cents: 50, net_cents: null };
  const voisin = L.mouvementMise({ userId: 1, matchId: 12, miseCents: 50 })
    .concat([L.transfert('remboursement', '12', L.compteEnjeu(12), L.compteJoueur(9), 50)]);
  assert.strictEqual(totalDe(voisin), 0);
  const g2 = L.ledgerReconcile(renonce, voisin);
  assert.ok(g2.some(x => /joueur:9:disponible/.test(x)), g2.join(' | '));

  // 3. Un billet REFUSÉ dont le séquestre repart chez le joueur : même règle que le périmé.
  const refuse = { id: 13, user_id: 4, status: 'rejected', stake_cents: 100, net_cents: null };
  const repart = L.mouvementMise({ userId: 4, matchId: 13, miseCents: 100 })
    .concat([L.transfert('gain', '13', L.compteEnjeu(13), L.compteJoueur(4), 100)]);
  assert.strictEqual(totalDe(repart), 0);
  assert.ok(L.ledgerReconcile(refuse, repart).length > 0);

  // 4. Et un remboursement sur une issue qui ne rend PAS la mise est nommé pour ce qu'il est.
  const abandon = { id: 14, user_id: 1, status: 'abandoned', stake_cents: 50, net_cents: null };
  const melange = L.mouvementMise({ userId: 1, matchId: 14, miseCents: 50 })
    .concat(L.mouvementRemboursement({ userId: 1, matchId: 14, miseCents: 50 }));
  const g4 = L.ledgerReconcile(abandon, melange);
  assert.ok(g4.some(x => /remboursement/.test(x)), g4.join(' | '));

  // LE CONTRÔLE, sans lequel les quatre ci-dessus ne mesureraient rien : les mêmes issues, écrites
  // par les mouvements du fichier, ne produisent aucun grief.
  for (const status of ['expired', 'rejected', 'abandoned']) {
    const clos = { id: 15, user_id: 2, status, stake_cents: 50, net_cents: null };
    const vide = L.mouvementMise({ userId: 2, matchId: 15, miseCents: 50 })
      .concat(L.mouvementGain({ matchId: 15, miseCents: 50, grossCents: 0, feeCents: 0, netCents: 0 }));
    assert.deepStrictEqual(L.ledgerReconcile(clos, vide), [], status);
  }
});

test('ledgerReconcile attrape un billet sans engagement et un engagement sans billet', () => {
  const { ligne, livre } = scenarioRegle();
  // Un billet sans son engagement : c'est aussi la frontière avec la 02a, qu'un module suivant
  // constatera sur une ligne à `trace_steps` nul — une ligne sans mise n'a jamais de gain.
  const sansMise = livre.filter(t => t.motif !== 'mise');
  const g1 = L.ledgerReconcile(ligne, sansMise);
  assert.ok(g1.some(x => /aucun engagement/.test(x)), g1.join(' | '));

  // Un engagement sans son billet : un séquestre habité par une partie que `matches` ne connaît
  // pas, donc de l'argent que rien ne soldera jamais.
  const intrus = livre.concat(L.mouvementMise({ userId: 1, matchId: 4242, miseCents: 100 }));
  const g2 = L.ledgerReconcile(ligne, intrus);
  assert.ok(g2.some(x => /enjeu:4242.*sans billet/.test(x)), g2.join(' | '));
  // Et il disparaît dès que le billet correspondant est présenté, séquestre vidé.
  const autre = scenarioRegle({ id: 4242 });
  assert.deepStrictEqual(L.ledgerReconcile([ligne, autre.ligne], livre.concat(autre.livre)), []);

  // Une mise écrite DEUX FOIS sur le même billet — le POST rejoué qui débite deux fois, le vol le
  // plus facile de la phase.
  const double = livre.concat(L.mouvementMise({ userId: 1, matchId: 1, miseCents: 100 }));
  const g3 = L.ledgerReconcile(ligne, double);
  assert.ok(g3.some(x => /2 écritures de mise/.test(x)), g3.join(' | '));
  // Et une mise du mauvais montant.
  const g4 = L.ledgerReconcile({ ...ligne, stake_cents: 999 }, livre);
  assert.ok(g4.some(x => /mise engagée/.test(x)), g4.join(' | '));
});

test('ledgerReconcile attrape un séquestre NON VIDÉ sur une ligne close', () => {
  // « Aucun séquestre ne reste habité » est l'invariant que le veilleur devenu écrivain d'argent
  // doit tenir. Sans lui, de l'argent reste dans un compte que rien ne solde.
  for (const status of ['settled', 'expired', 'rejected', 'abandoned', 'renounced']) {
    const clos = { id: 9, user_id: 1, status, stake_cents: 75, net_cents: null };
    const habite = L.mouvementMise({ userId: 1, matchId: 9, miseCents: 75 });
    const g = L.ledgerReconcile(clos, habite);
    assert.ok(g.some(x => /séquestre n'est pas vidé.*75/.test(x)), `${status} : ${g.join(' | ')}`);
  }
  // Et l'inverse : une ligne OUVERTE dont le séquestre a déjà été vidé, ou n'a jamais été rempli.
  const ouvert = { id: 9, user_id: 1, status: 'open', stake_cents: 75, net_cents: null };
  const vide = L.mouvementMise({ userId: 1, matchId: 9, miseCents: 75 })
    .concat(L.mouvementGain({ matchId: 9, miseCents: 75, grossCents: 0, feeCents: 0, netCents: 0 }));
  const g = L.ledgerReconcile(ouvert, vide);
  assert.ok(g.some(x => /ouvert.*séquestre porte 0/.test(x)), g.join(' | '));
  // Un statut que le grand livre ne connaît pas ne passe pas en silence.
  assert.ok(L.ledgerReconcile({ id: 9, user_id: 1, status: 'zombie', stake_cents: 75 }, vide)
    .some(x => /statut inconnu/.test(x)));
});

// ------------------------------------------------------------------------------------------------
// LE GRAND LIVRE EN LIGNE (phase 03, module 3). Le livre cesse d'être une fonction pure et devient
// ce que les routes écrivent : la dotation et la recharge à la connexion, la mise à l'ouverture du
// billet, le gain au règlement. Tout est ici éprouvé contre la DOUBLURE, sans base et sans réseau —
// et la phrase du dossier reste vraie tant que le job Postgres n'a pas été vert une fois : un test
// qui passe contre la doublure prouve la doublure. Ce qu'aucun de ces tests ne peut prouver est
// nommé une fois pour toutes : le verrou de ligne, que seul `api/db-check.js` éprouve.
console.log('Le grand livre : la partie complète en ligne');

// Le livre de la doublure, rendu dans la forme que `api/ledger.js` manipule. Les colonnes portent
// les noms de la base, les transferts ceux du code : c'est la seule traduction du fichier, et elle
// vit à un seul endroit.
const livreDe = db => db.ledger.map(l => ({ motif: l.motif, reference: l.reference,
  compteDebit: l.compte_debit, compteCredit: l.compte_credit, montantCents: l.montant_cents }));
const comptesDe = db => {
  const s = new Set();
  for (const l of db.ledger) { s.add(l.compte_debit); s.add(l.compte_credit); }
  return s;
};
// LA SOMME GLOBALE DU LIVRE EST NULLE, ET ON LA VÉRIFIE QUAND MÊME. Elle l'est par construction —
// une ligne est un transfert, donc `+m` quelque part et `−m` ailleurs — mais « par construction »
// est exactement le genre de phrase qui cesse d'être vraie sans que personne ne s'en aperçoive.
function zeroGlobal(db, quand) {
  const livre = livreDe(db);
  let total = 0;
  for (const c of comptesDe(db)) total += L.soldeDe(livre, c);
  assert.strictEqual(total, 0, `la somme globale du livre vaut ${total} — ${quand || 'à cet instant'}`);
}
// LA RÉCONCILIATION, à la fin de chaque scénario. Le zéro global ne dit RIEN sur l'appariement : il
// est vrai même si un montant juste est posé sur le mauvais compte.
function reconcilier(db, quand) {
  const griefs = L.ledgerReconcile(db.matches, livreDe(db));
  assert.deepStrictEqual(griefs, [], `${quand || 'réconciliation'} : ${griefs.join(' | ')}`);
}
const soldeJoueur = (db, id = 1) => L.soldeDe(livreDe(db), L.compteJoueur(id));
const soldeQuarantaine = (db, id = 1) => L.soldeDe(livreDe(db), L.compteQuarantaine(id));
const misesDe = db => db.ledger.filter(l => l.motif === 'mise');
const rechargesDe = db => db.ledger.filter(l => l.motif === 'recharge');

await test('la dotation est écrite UNE fois, même après vingt connexions, et elle vaut le portefeuille de démonstration', async () => {
  const db = fakeDb(), app = appDe(db);
  for (let i = 0; i < 20; i++) await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(db.users.length, 1);
  const dotations = db.ledger.filter(l => l.motif === 'dotation');
  assert.strictEqual(dotations.length, 1, `${dotations.length} dotations pour un seul compte`);
  assert.strictEqual(dotations[0].montant_cents, L.DOTATION_CENTS);
  assert.strictEqual(dotations[0].compte_debit, L.MAISON_DOTATION);
  assert.strictEqual(dotations[0].compte_credit, L.compteJoueur(db.users[0].id));
  // DEUX ÉCONOMIES VIVENT SUR LE MÊME ÉCRAN depuis cette phase : le portefeuille de démonstration
  // hors ligne, le solde du serveur en ligne. Les faire partir de deux nombres différents ferait
  // prendre la première connexion pour un bug. `api/ledger.js` reste pur, donc les deux écritures
  // de ce nombre se CONFRONTENT ici plutôt que de se faire confiance.
  assert.strictEqual(L.DOTATION_CENTS, C.toCents(C.START_WALLET),
    'la dotation en ligne et le portefeuille de démonstration hors ligne ont divergé');
  // Aucune recharge : un compte neuf est très au-dessus du plancher.
  assert.strictEqual(rechargesDe(db).length, 0, 'une recharge a été écrite sur un compte plein');
  const r = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(r.corps.balanceCents, L.DOTATION_CENTS);
  assert.strictEqual(r.corps.quarantineCents, 0);
  zeroGlobal(db, 'après vingt connexions');
});

await test('la recharge s\'écrit au plus une fois par jour et par joueur, et pas du tout au-dessus du plancher', async () => {
  // Sans elle, un joueur qui épuise ses crédits ne peut PLUS JAMAIS jouer — le bouton de recharge
  // disparaît en ligne. Ce n'est pas un détail de confort, c'est la fin de la boucle de jeu.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const heure = 3600 * 1000, jour = 24 * heure;
  // On vide le compte par le SEUL chemin qui dépense : ouvrir des billets. Chaque billet périmé est
  // clos par le suivant, et sa mise rentre chez la maison — le joueur n'est jamais remboursé.
  for (let i = 0; i < 5; i++) {
    horloge.t = T0 + i * heure;
    const r = await demander(app, { ...DEMANDE, stake: 10, clientKey: 'vide' + i });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  }
  assert.strictEqual(soldeJoueur(db), 0, 'le compte n\'est pas vide');
  assert.strictEqual(rechargesDe(db).length, 0, 'une recharge a été écrite avant le plancher');

  // Le joueur se reconnecte : il est au-dessous du plancher, la recharge tombe.
  const un = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(rechargesDe(db).length, 1);
  assert.strictEqual(rechargesDe(db)[0].montant_cents, L.RECHARGE_CENTS);
  assert.strictEqual(rechargesDe(db)[0].reference, `${db.users[0].id}:2026-01-01`);
  assert.strictEqual(rechargesDe(db)[0].compte_debit, L.MAISON_DOTATION);
  assert.strictEqual(un.corps.balanceCents, L.RECHARGE_CENTS);
  // Rechargé, il est au-dessus du plancher : se reconnecter dix fois ne rapporte rien.
  for (let i = 0; i < 10; i++) await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(rechargesDe(db).length, 1);

  // Il redescend à zéro LE MÊME JOUR. C'est le cas que la référence datée existe pour tenir : une
  // recharge par jour, pas une par passage sous le plancher.
  horloge.t = T0 + 6 * heure;
  await demander(app, { ...DEMANDE, stake: 10, clientKey: 'encore' });
  assert.strictEqual(soldeJoueur(db), 0);
  await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(rechargesDe(db).length, 1, 'une seconde recharge est tombée le même jour');
  assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).corps.balanceCents, 0);

  // Le lendemain, elle revient. C'est un PLANCHER DE JEU, pas un revenu : elle ne s'écrit que sous
  // le plancher, une fois, et le jour se compte en UTC pour que deux instances ne basculent pas à
  // deux heures différentes.
  horloge.t = T0 + jour;
  const deux = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(rechargesDe(db).length, 2);
  assert.strictEqual(rechargesDe(db)[1].reference, `${db.users[0].id}:2026-01-02`);
  assert.strictEqual(deux.corps.balanceCents, L.RECHARGE_CENTS);
  zeroGlobal(db, 'après deux recharges');
  reconcilier(db, 'la recharge');
});

await test('il n\'existe AUCUNE route par laquelle le client puisse se créditer', () => {
  // La dotation et la recharge sont écrites par le SERVEUR, au moment de la connexion. Une route de
  // frappe de monnaie appelable par le client est exactement ce qu'on refuse, et une garde vaut
  // mieux qu'une intention : c'est le patron déjà en place pour l'écrivain du grand livre.
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
  for (const interdit of ['/api/credits', '/api/wallet', '/api/topup', '/api/balance'])
    assert.ok(!app.includes(interdit), `une route de crédit est apparue : ${interdit}`);
  // Les routes connues sont celles de la table, et elles n'ont pas changé.
  const table = app.slice(app.indexOf('const METHODES = new Map'), app.indexOf('const RESULTAT ='));
  assert.deepStrictEqual((table.match(/'\/api\/[a-z]+'/g) || []).sort(), ["'/api/match'", "'/api/me'"]);
});

await test('LE TEST QUI DÉCIDE : un POST rejoué avec la MÊME clientKey rend le même billet et n\'écrit PAS de seconde mise', async () => {
  // Le vol le plus facile de la phase : un `POST` rejoué qui débite deux fois, ou pire, une réponse
  // perdue qui débite sans billet. Le chemin `repris` ne doit RIEN écrire, jamais.
  const { db, app } = bancDeBillet();
  const a = await demander(app);
  assert.strictEqual(a.code, 200, JSON.stringify(a.corps));
  assert.strictEqual(misesDe(db).length, 1);
  assert.strictEqual(a.corps.balanceCents, L.DOTATION_CENTS - a.corps.stakeCents);

  const b = await demander(app);
  assert.deepStrictEqual(sansRepris(b.corps), sansRepris(a.corps),
    'un rejeu doit être indiscernable du premier appel, `repris` mis à part');
  assert.strictEqual(b.corps.repris, true, 'et il dit par quel chemin il a été servi');
  assert.strictEqual(db.matches.length, 1);
  assert.strictEqual(misesDe(db).length, 1, 'le POST rejoué a débité une seconde fois');
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - a.corps.stakeCents);

  // ET L'AUTRE CHEMIN `repris` : une clé DIFFÉRENTE sur un billet déjà ouvert. C'est l'index
  // partiel « un seul billet ouvert » qui refuse l'insertion, et un refus ne laisse rien derrière.
  const avant = db.ledger.length;
  const c = await demander(app, { ...DEMANDE, clientKey: 'une-autre-cle' });
  assert.strictEqual(c.corps.id, a.corps.id);
  assert.strictEqual(db.ledger.length, avant, 'le billet repris a laissé une écriture derrière lui');
  assert.strictEqual(misesDe(db).length, 1);
  zeroGlobal(db, 'après trois demandes et un seul billet');
  reconcilier(db, 'le billet rejoué');
});

await test('un solde insuffisant sort en 409 fonds, ne laisse NI billet NI écriture, et n\'enferme personne', async () => {
  const { db, app } = bancDeBillet({ limiter: () => true });
  // Une partie déjà close, avec sa mise et son séquestre vidé : exactement ce que l'API aurait
  // écrit, et le compte descend à 500 — le plancher lui-même, donc AUCUNE recharge (le contrôle est
  // « au-dessous », pas « au plus »).
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  db.matches.push({ id: 9001, user_id: uid, mode: 'solo', stake_cents: 4500, seats: 20, team_size: 1,
                    brawler: BRAWLER, seed_public: 1, seed_secret: SECRETS[0], sim_version: 1,
                    client_key: 'passe', status: 'expired', first_result_at: null,
                    opened_at: new Date(T0 - 1000), expires_at: new Date(T0 - 1) });
  await db.ledgerWrite(L.mouvementMise({ userId: uid, matchId: 9001, miseCents: 4500 }));
  await db.ledgerWrite(L.mouvementGain({ matchId: 9001, miseCents: 4500, grossCents: 0,
                                         feeCents: 0, netCents: 0 }));
  assert.strictEqual(soldeJoueur(db), L.PLANCHER_CENTS);

  const avantLignes = db.matches.length, avantLivre = db.ledger.length;
  const r = await demander(app, { ...DEMANDE, stake: 10, clientKey: 'trop-cher' });
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'fonds');
  // Pas un 402 : la doctrine du dossier est « des refus nommés, tous en 400 ou 409, aucun en 500 ».
  assert.notStrictEqual(r.code, 402);
  assert.strictEqual(r.corps.balanceCents, L.PLANCHER_CENTS);
  assert.strictEqual(r.corps.requiredCents, 1000);
  assert.strictEqual(db.matches.length, avantLignes, 'un refus a laissé un billet');
  assert.strictEqual(db.ledger.length, avantLivre, 'un refus a laissé une écriture');
  assert.strictEqual(rechargesDe(db).length, 0, 'le plancher est « au-dessous », pas « au plus »');

  // ET LE JOUEUR N'EST PAS ENFERMÉ : il redemande, il obtient le même refus, puis il joue à une
  // table qu'il peut payer. C'est la leçon du `22003`, transposée sur le chemin de l'argent.
  const encore = await demander(app, { ...DEMANDE, stake: 10, clientKey: 'trop-cher-2' });
  assert.strictEqual(encore.corps.code, 'fonds');
  const petite = await demander(app, { ...DEMANDE, stake: 0.5, clientKey: 'abordable' });
  assert.strictEqual(petite.code, 200, JSON.stringify(petite.corps));
  assert.strictEqual(petite.corps.balanceCents, L.PLANCHER_CENTS - 50);
  zeroGlobal(db, 'après deux refus et un billet');
  reconcilier(db, 'le refus de fonds');
});

await test('le solde après N billets vaut dotation − N × mise, RESOMMÉ depuis les écritures, et GET /api/me dit la même chose', async () => {
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const N = 6;
  for (let i = 0; i < N; i++) {
    horloge.t = T0 + i * 3600 * 1000;
    const r = await demander(app, { ...DEMANDE, clientKey: 'n' + i });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
    // Le montant rendu AVEC le billet est déjà celui d'après le débit : c'est un aller-retour de
    // moins pour le jeu, et c'est la parole du serveur.
    assert.strictEqual(r.corps.balanceCents, L.DOTATION_CENTS - (i + 1) * 50);
    zeroGlobal(db, `après le billet ${i}`);
  }
  assert.strictEqual(misesDe(db).length, N);
  // LA SOMME, refaite depuis les écritures et pas relue d'une case : il n'existe nulle part de case.
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - N * 50);
  const moi = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(moi.corps.balanceCents, soldeJoueur(db));
  assert.strictEqual(moi.corps.quarantineCents, 0);
  reconcilier(db, `après ${N} billets`);
});

await test('AUCUN MONTANT NE VIENT DU CORPS : un corps chargé écrit exactement les mêmes ÉCRITURES qu\'un corps minimal', async () => {
  // Le patron de la 02a — « un corps portant une graine écrit une ligne identique à celle d'un
  // corps vide » — étendu des paramètres aux faits en 02b, et étendu ICI AUX ÉCRITURES. Deux bancs,
  // mêmes graines, même horloge, même trace : les deux livres doivent être indiscernables.
  const nu = bancDeBillet(), charge = bancDeBillet();
  const DEM = { ...DEMANDE, mode: 'resurgence' };
  const a = await demander(nu.app, DEM);
  const b = await demander(charge.app, {
    ...DEM, balanceCents: 999_999, quarantineCents: 999_999, dotation: 999_999,
    netCents: 999_999, feeCents: 0, grossCents: 999_999, montantCents: 999_999,
    compteCredit: 'joueur:1:disponible', motif: 'dotation',
  });
  assert.deepStrictEqual(b.corps, a.corps, 'le corps chargé a changé la réponse du billet');
  assert.deepStrictEqual(charge.db.ledger, nu.db.ledger, 'le corps chargé a changé le grand livre');

  const p = partieDe(a, { encaisser: 300 });
  // Le corps gonflé passe l'analyse et l'enveloppe : ce n'est pas un rapport absurde, c'est un
  // rapport que la 02a aurait accepté mot pour mot — et payé. `declaredNetCents` n'y est pas
  // touché : c'est le seul nombre du corps qui survive, et il ne décide d'aucun montant.
  const gonfle = { ...p.rapport,
                   purseCents: C.purseBound(a.corps.stakeCents, a.corps.seats).maxCents,
                   kills: 19, damage: 999_999 };
  assert.deepStrictEqual(C.checkReport(gonfle).erreurs, []);
  const un = await jouerEtRendre(nu.app, nu.horloge, a, { encaisser: 300 });
  const deux = await jouerEtRendre(charge.app, charge.horloge, b, { encaisser: 300, corps: gonfle });
  assert.strictEqual(un.rep.code, 200, JSON.stringify(un.rep.corps));
  assert.strictEqual(deux.rep.code, 200, JSON.stringify(deux.rep.corps));
  assert.ok(nu.db.matches[0].net_cents > 0, 'la partie du test ne paie rien : elle ne prouve rien');
  assert.deepStrictEqual(charge.db.ledger, nu.db.ledger,
    'un net dix fois plus gros dans le corps a déplacé un centime');
  assert.deepStrictEqual(charge.db.matches, nu.db.matches);
  reconcilier(nu.db, 'le corps minimal');
  reconcilier(charge.db, 'le corps chargé');
});

await test('LE RÈGLEMENT : le montant crédité est exactement le net_cents de la ligne, et le solde vaut dotation − mise + net', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const mise = b.corps.stakeCents;
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - mise);
  assert.strictEqual(L.soldeDe(livreDe(db), L.compteEnjeu(b.corps.id)), mise,
    'le séquestre d\'un billet ouvert porte la mise');

  const { rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'settled');
  const ligne = db.matches[0];
  assert.ok(ligne.net_cents > 0, 'la partie du test ne paie rien : elle ne prouve pas le crédit');

  const gains = db.ledger.filter(l => l.motif === 'gain' && l.reference === String(ligne.id));
  const verse = c => gains.reduce((s, l) => s + (l.compte_credit === c ? l.montant_cents : 0), 0);
  assert.strictEqual(verse(L.compteJoueur(1)), ligne.net_cents,
    'le montant crédité ne vient pas de net_cents');
  assert.strictEqual(verse(L.MAISON_COMMISSION), ligne.fee_cents);
  assert.strictEqual(verse(L.compteQuarantaine(1)), 0, 'un gain convergé n\'a rien à faire en quarantaine');
  // LE SÉQUESTRE EST VIDE, et c'est l'invariant local que la phase existe pour tenir.
  assert.strictEqual(L.soldeDe(livreDe(db), L.compteEnjeu(ligne.id)), 0);
  // ET LE SOLDE : dotation − mise + net, à l'unité, resommé depuis les écritures.
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - mise + ligne.net_cents);
  assert.strictEqual((await appel(app, { token: 'ok:u1:Loic' })).corps.balanceCents, soldeJoueur(db));
  // La maison a payé le reliquat et encaissé sa commission : c'est la mesure que la phase produit.
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_COMMISSION), ligne.fee_cents);
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_CONTREPARTIE), mise - ligne.gross_cents);
  zeroGlobal(db, 'après un règlement');
  reconcilier(db, 'une partie complète');
});

await test('RÉGLER DEUX FOIS CRÉDITE UNE FOIS, et la seconde réponse est relue depuis la ligne', async () => {
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  const un = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(un.code, 200, JSON.stringify(un.corps));
  const livreApres = db.ledger.slice(), soldeApres = soldeJoueur(db);

  const deux = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(deux.code, 200);
  assert.deepStrictEqual(deux.corps, un.corps, 'la seconde réponse n\'est pas la première');
  assert.deepStrictEqual(db.ledger, livreApres, 'le second règlement a écrit dans le grand livre');
  assert.strictEqual(soldeJoueur(db), soldeApres);
  // LA CLÉ DU GRAND LIVRE DOIT TENIR MÊME SI LA CLAUSE `where` GLISSAIT. On le constate en
  // demandant directement au livre de réécrire le même mouvement : il refuse, il n'avale pas.
  const ligne = db.matches[0];
  await assert.rejects(() => db.ledgerWrite(L.mouvementGain({
    userId: ligne.user_id, matchId: ligne.id, miseCents: ligne.stake_cents,
    grossCents: ligne.gross_cents, feeCents: ligne.fee_cents, netCents: ligne.net_cents,
    convergee: true })), e => e.code === '23505' || e.code === 'decouvert',
    'un second gain sur le même billet a été accepté');
  assert.deepStrictEqual(db.ledger, livreApres);
  reconcilier(db, 'un règlement rejoué');
});

await test('UNE LIGNE DIVERGENTE MET SON NET EN QUARANTAINE, et GET /api/me montre les deux montants séparément', async () => {
  // « Une divergence est mesurée, jamais punie » et « le grand livre ne lit que des lignes
  // convergées » doivent tenir ENSEMBLE. La quarantaine est la seule lecture qui tienne les deux :
  // le mouvement existe, le livre boucle, et la divergence est chiffrée EN CENTIMES.
  const { db, app, horloge } = bancDeBillet();
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);
  // Un client sans condensés ne prouve aucune convergence : la valeur sûre est « non convergé ».
  const r = await rendre(app, b.corps.id, { ...p.rapport, digests: '' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.status, 'settled', 'une divergence a été PUNIE');
  assert.strictEqual(r.corps.digestMatch, false);
  const ligne = db.matches[0];
  assert.ok(ligne.net_cents > 0);

  assert.strictEqual(soldeQuarantaine(db), ligne.net_cents, 'le net divergent n\'est pas en quarantaine');
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - ligne.stake_cents,
    'un net divergent a été rendu dépensable');
  const moi = await appel(app, { token: 'ok:u1:Loic' });
  assert.strictEqual(moi.corps.balanceCents, L.DOTATION_CENTS - ligne.stake_cents);
  assert.strictEqual(moi.corps.quarantineCents, ligne.net_cents);
  // AUCUN AGRÉGAT CONVERGÉ N'EN COMPTE UN CENTIME, et le taux de divergence reste exposé.
  assert.strictEqual(moi.corps.stats.matches, 0);
  assert.strictEqual(moi.corps.stats.best, 0);
  assert.strictEqual(moi.corps.stats.divergences, 1);
  // La commission, elle, est encaissée comme sur n'importe quelle ligne : la maison ne punit pas.
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_COMMISSION), ligne.fee_cents);
  zeroGlobal(db, 'après un règlement divergent');
  reconcilier(db, 'une ligne divergente');
});

await test('UN RÈGLEMENT INTERROMPU AU MILIEU NE LAISSE AUCUNE ÉCRITURE PARTIELLE, et ne sort pas en 500', async () => {
  // La classe de panne la plus coûteuse du dossier. Le règlement de la ligne et les transferts du
  // gain sont UNE transaction : si le livre refuse, la ligne repart `open`, sans montant, et le
  // joueur peut renvoyer son résultat sur le MÊME billet tant qu'il vit.
  const { db, app, horloge } = bancDeBillet();
  let vu500 = 0;
  app.onError = () => { vu500++; };
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = ARRIVEE(p.rapport);

  const avant = db.ledger.slice();
  db.panne.ledger = t => t.some(x => x.motif === 'gain');
  const rate = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rate.code, 409, JSON.stringify(rate.corps));
  assert.strictEqual(rate.corps.code, 'livre');
  assert.strictEqual(vu500, 0, 'un échec du grand livre est sorti en 500');
  assert.deepStrictEqual(db.ledger, avant, 'un règlement interrompu a laissé une écriture');
  const ligne = db.matches[0];
  assert.strictEqual(ligne.status, 'open', 'la ligne a été close sans son gain');
  assert.strictEqual(ligne.net_cents, undefined, 'un montant a été écrit sans sa contrepartie');
  reconcilier(db, 'après un règlement interrompu');

  // La panne passée, le même billet se règle normalement : rien n'est perdu, rien n'est enfermé.
  db.panne.ledger = null;
  const ok = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(ok.code, 200, JSON.stringify(ok.corps));
  assert.strictEqual(ok.corps.status, 'settled');
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - ligne.stake_cents + db.matches[0].net_cents);
  zeroGlobal(db, 'après la reprise');
  reconcilier(db, 'le billet repris après la panne');
});

await test('un refus du grand livre à L\'OUVERTURE ne laisse ni billet ni écriture, et sort en 409 nommé', async () => {
  // Le pendant du précédent sur l'autre route qui écrit de l'argent. Le billet et sa mise naissent
  // ensemble ou pas du tout : si le livre refuse la mise, il ne doit rester aucune ligne `matches`
  // — sinon le joueur serait enfermé dans un billet qu'il n'a pas payé, et il n'en a qu'un.
  const { db, app } = bancDeBillet();
  let vu500 = 0;
  app.onError = () => { vu500++; };
  db.panne.ledger = t => t.some(x => x.motif === 'mise');
  const r = await demander(app);
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'livre');
  assert.strictEqual(vu500, 0, 'un échec du grand livre est sorti en 500');
  assert.strictEqual(db.matches.length, 0, 'un billet a survécu au refus de sa mise');
  assert.strictEqual(misesDe(db).length, 0);
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS, 'le joueur a été débité sans billet');

  db.panne.ledger = null;
  const ok = await demander(app, { ...DEMANDE, clientKey: 'apres-panne' });
  assert.strictEqual(ok.code, 200, JSON.stringify(ok.corps));
  reconcilier(db, 'après un refus d\'ouverture');
});

await test('LA FRONTIÈRE AVEC LA 02a SE CONSTATE : une ligne sans écriture de mise n\'a jamais d\'écriture de gain', async () => {
  // Le grand livre ne lit AUCUNE ligne dont les faits ont été déclarés par le client. On sème donc
  // une ligne de la phase 02a — faits déclarés, `trace_steps` nul, aucune mise au livre — et on
  // prouve qu'aucune écriture ne la touche jamais, ni au règlement ni à la clôture.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  const semee = { id: 777, user_id: uid, mode: 'solo', stake_cents: 50, seats: 20, team_size: 1,
                  brawler: BRAWLER, seed_public: GRAINES[30], seed_secret: SECRETS[30],
                  sim_version: 1, client_key: 'phase-02a', status: 'open', first_result_at: null,
                  trace_steps: null,
                  opened_at: new Date(T0), expires_at: new Date(T0 + 600 * 1000) };
  db.matches.push(semee);
  const avant = db.ledger.slice();

  // On la clôt par le chemin le plus banal de l'API : demander un billet neuf après l'expiration.
  horloge.t = T0 + 3600 * 1000;
  const neuf = await demander(app, { ...DEMANDE, clientKey: 'apres-02a' });
  assert.strictEqual(neuf.code, 200, JSON.stringify(neuf.corps));
  assert.strictEqual(semee.status, 'expired');
  assert.strictEqual(db.ledger.filter(l => l.reference === '777').length, 0,
    'le grand livre a touché une ligne de la phase 02a');
  // Et une seconde ligne 02a, réglée cette fois : toujours aucune écriture.
  const reglee = { ...semee, id: 778, client_key: '02a-bis', status: 'open',
                   opened_at: new Date(horloge.t), expires_at: new Date(horloge.t + 600 * 1000) };
  db.matches.push(reglee);
  await db.settleMatch({ matchId: 778, userId: uid, status: 'settled', settledAt: new Date(horloge.t),
    issue: 'encaissement', controle: null, motif: null,
    grossCents: 400, feeCents: 80, netCents: 320, purseCents: 400, declaredNetCents: 320,
    ecartCents: 0, seconds: 60, kills: 1, deaths: 0, rank: 1, cubes: 0, damage: 10,
    cashedOut: true, traceSteps: null, replayDigest: null, digestMatch: null,
    divergenceStep: null, replayMs: null });
  assert.strictEqual(db.matches.find(m => m.id === 778).status, 'settled');
  assert.strictEqual(db.ledger.filter(l => l.reference === '778').length, 0,
    'une ligne sans mise a reçu un gain : la frontière avec la 02a a cédé');
  assert.deepStrictEqual(db.ledger.filter(l => l.motif === 'gain' && ['777', '778'].includes(l.reference)), []);
  // Le seul mouvement écrit pendant tout ce test est la mise du billet neuf.
  assert.deepStrictEqual(db.ledger.slice(avant.length).map(l => l.motif), ['mise']);
  zeroGlobal(db, 'avec deux lignes 02a semées');
});

await test('CINQUANTE PARTIES DE BOUT EN BOUT : la somme globale est nulle à CHAQUE étape, et aucun séquestre ne reste habité', async () => {
  // Les cinq modes, les quatre tables, et les cinq issues qui passent par le règlement ou la
  // clôture. La SIXIÈME, `renounced`, ne passe par aucun des deux — elle a sa propre route et son
  // propre mouvement — et elle est couverte par « LA SIXIÈME ISSUE », sur le même domaine.
  const db = fakeDb();
  const horloge = { t: T0 };
  let g = 0, s = 0;
  const app = appDe(db, {
    randomSeed: () => GRAINES[g++ % GRAINES.length],
    randomSecret: () => SECRETS[s++ % SECRETS.length],
    now: () => horloge.t, chrono: () => 0, limiter: () => true,
  });
  const etape = async (quoi, promesse) => { const r = await promesse; zeroGlobal(db, quoi); return r; };
  const MODES = Object.keys(C.MODES);
  const MISES = C.TIERS.map(t => t.stake);
  const ISSUES = ['settled', 'rejected', 'expired', 'abandoned', 'open'];
  const comptees = new Map();

  for (let i = 0; i < 50; i++) {
    const mode = MODES[i % MODES.length];
    const stake = MISES[(i / MODES.length | 0) % MISES.length];
    // Les deux issues qui exigent une partie TERMINALE ne se demandent qu'aux modes à
    // encaissement : c'est la seule sortie gagnante qu'un pilote de test puisse produire à coup
    // sûr, et gagner une partie contre dix-neuf bots ne se commande pas.
    let issue = ISSUES[(i + (i / MODES.length | 0)) % ISSUES.length];
    if (!C.MODES[mode].cashout && (issue === 'settled' || issue === 'rejected')) issue = 'expired';
    const token = `ok:s${i}:Zoe`;
    const quoi = `scénario ${i} (${mode}, ${stake} $, ${issue})`;
    horloge.t = T0;

    const b = await etape(quoi, demander(app, { mode, stake, brawler: BRAWLER, clientKey: 'a' },
                                        { token }));
    assert.strictEqual(b.code, 200, `${quoi} : ${JSON.stringify(b.corps)}`);
    const uid = db.users.find(u => u.auth_id === `s${i}`).id;
    assert.strictEqual(L.soldeDe(livreDe(db), L.compteEnjeu(b.corps.id)), b.corps.stakeCents,
      `${quoi} : le séquestre d'un billet ouvert doit porter la mise`);

    if (issue === 'settled' || issue === 'rejected') {
      const p = partieDe(b, { encaisser: 300 });
      await poserTrace(app, b.corps.id, p.segments, token);
      // Le refus vient du CHRONOMÈTRE du serveur, sur la durée recalculée : le rapport est sincère,
      // c'est l'horloge qui n'a pas eu le temps de contenir la partie.
      horloge.t = issue === 'settled'
        ? Date.parse(b.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000
        : Date.parse(b.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds - C.ENVELOPPE.margeHorlogeS - 1) * 1000;
      const r = await etape(quoi, rendre(app, b.corps.id, p.rapport, { token }));
      assert.strictEqual(r.code, 200, `${quoi} : ${JSON.stringify(r.corps)}`);
      assert.strictEqual(r.corps.status, issue, `${quoi} : ${JSON.stringify(r.corps)}`);
    } else if (issue === 'expired') {
      horloge.t = Date.parse(b.corps.expiresAt) + 1000;
      const r = await etape(quoi, rendre(app, b.corps.id, RAPPORT(), { token }));
      assert.strictEqual(r.code, 200, `${quoi} : ${JSON.stringify(r.corps)}`);
      assert.strictEqual(r.corps.status, 'expired', `${quoi} : ${JSON.stringify(r.corps)}`);
    } else if (issue === 'abandoned') {
      // Un résultat rendu SANS trace pose `first_result_at` sans rien régler : le billet suivant
      // clôt alors celui-ci en `abandoned`. Un billet ne sert qu'une tentative.
      const r = await etape(quoi, rendre(app, b.corps.id, RAPPORT(), { token }));
      assert.strictEqual(r.corps.code, 'trace_absente', `${quoi} : ${JSON.stringify(r.corps)}`);
      const c = await etape(quoi, demander(app, { mode, stake, brawler: BRAWLER, clientKey: 'b' },
                                          { token }));
      assert.strictEqual(c.code, 200, `${quoi} : ${JSON.stringify(c.corps)}`);
      assert.notStrictEqual(c.corps.id, b.corps.id);
      assert.strictEqual(db.matches.find(m => String(m.id) === b.corps.id).status, 'abandoned');
    }

    // L'INVARIANT LOCAL, sur chaque ligne de ce joueur : la mise sur un billet ouvert, ZÉRO sur
    // toute ligne close. Aucun séquestre ne reste habité.
    for (const m of db.matches.filter(x => x.user_id === uid)) {
      const solde = L.soldeDe(livreDe(db), L.compteEnjeu(m.id));
      assert.strictEqual(solde, m.status === 'open' ? m.stake_cents : 0,
        `${quoi} : le séquestre de ${m.id} (${m.status}) porte ${solde}`);
      // LE SIÈGE PAYÉ, SUR LES CINQ MODES, LES QUATRE TABLES ET LES CINQ ISSUES : toujours UN, et
      // toujours dans sa borne. Aujourd'hui un billet EST une table, donc la réponse ne varie pas ;
      // le jour où elle variera, c'est ce test-là qui dira que quelque chose a changé de nature.
      assert.strictEqual(m.paid_seats, 1, `${quoi} : ${m.id} porte ${m.paid_seats} sièges payés`);
      assert.ok(m.paid_seats >= 1 && m.paid_seats <= m.seats, `${quoi} : hors de [1, ${m.seats}]`);
      comptees.set(m.status, (comptees.get(m.status) || 0) + 1);
    }
    // LA RÉCONCILIATION À LA FIN DE CHAQUE SCÉNARIO. Le zéro global est vrai même si un montant
    // juste est posé sur le mauvais compte ; elle attrape exactement cela.
    reconcilier(db, quoi);
  }

  assert.ok(db.matches.length >= 50, `seulement ${db.matches.length} billets`);
  for (const statut of ['settled', 'rejected', 'expired', 'abandoned', 'open'])
    assert.ok(comptees.get(statut) > 0, `aucune ligne ${statut} dans les cinquante scénarios`);
  // Et le compte de la maison porte enfin la mesure que la phase existe pour produire.
  const livre = livreDe(db);
  assert.ok(L.soldeDe(livre, L.MAISON_COMMISSION) > 0, 'la maison n\'a encaissé aucune commission');
  assert.strictEqual(L.soldeDe(livre, L.MAISON_DOTATION), -50 * L.DOTATION_CENTS);
  zeroGlobal(db, 'à la toute fin');
});

// ------------------------------------------------------------------------------------------------
// LE BILLET QUE PERSONNE NE TERMINE (phase 03, module 4). La fenêtre de renoncement, la
// temporisation du chercheur de graine, le veilleur devenu écrivain d'argent, et la conservation des
// traces. Tout est éprouvé contre la DOUBLURE, avec l'horloge injectée : une horloge qu'on avance
// fait vieillir un billet sans attendre, et fait vieillir une trace sans attendre quatre cents jours.
console.log('Le billet que personne ne termine : renoncement, veilleur, conservation');

const renoncer = (app, id, opts = {}) =>
  appel(app, { method: 'POST', path: `/api/match/${id}/renounce`, token: 'ok:u1:Loic', ...opts });
const soldeEnjeu = (db, id) => L.soldeDe(livreDe(db), L.compteEnjeu(id));
const remboursementsDe = db => db.ledger.filter(l => l.motif === 'remboursement');

await test('LE VOL QUE CETTE PHASE FERME : jouer, perdre, n\'envoyer NI trace NI résultat, laisser expirer — le solde vaut dotation − mise, JAMAIS dotation', async () => {
  // C'est le vol que le débit à l'ouverture ouvre, et il faut le nommer : si un billet expiré était
  // remboursé, le joueur ne perdrait JAMAIS. Toute condition fondée sur « aucune trace n'est
  // arrivée » est contrôlée par le client, donc sans valeur — la seule chose que le serveur observe
  // sans lui est son propre chronomètre, et il a dit non depuis la onzième seconde.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const b = await demander(app);
  const mise = b.corps.stakeCents;
  // Il JOUE, et il perd. La trace existe ; elle ne partira jamais.
  const p = partieDe(b);
  assert.ok(p.segments.length > 0, 'la partie du test n\'a produit aucune trace : elle ne prouve rien');
  assert.strictEqual(db.traces.length, 0, 'la trace du test est partie : ce n\'est plus le vol qu\'on décrit');
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - mise);

  // Il laisse expirer. Le veilleur passe.
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  assert.deepStrictEqual(await app.veiller(), { closes: 1, echecs: [] });
  assert.strictEqual(db.matches[0].status, 'expired');

  // LE SOLDE, ET C'EST TOUT CE QUE CE TEST EXISTE POUR DIRE.
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - mise,
    'un billet expiré sans résultat a été remboursé : le joueur ne perd jamais');
  assert.notStrictEqual(soldeJoueur(db), L.DOTATION_CENTS);
  assert.strictEqual(remboursementsDe(db).length, 0, 'le veilleur a remboursé');
  // La mise est chez la maison, et le séquestre est VIDE : c'est le revirement du veilleur.
  assert.strictEqual(soldeEnjeu(db, db.matches[0].id), 0,
    'le veilleur a laissé un séquestre habité : cet argent-là, plus rien ne le solde');
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_CONTREPARTIE), mise);
  zeroGlobal(db, 'après un billet expiré');
  reconcilier(db, 'le billet que personne n\'a terminé');
});

await test('LES QUATRE REFUS QUI ARRÊTENT LE SAS EXISTENT VRAIMENT, et le jeu ne les invente pas', async () => {
  // Le jeu ne se comporte pas de la même façon devant une PANNE et devant un REFUS : une panne le
  // laisse partir hors ligne comme depuis la 02a, un refus nommé arrête le sas et ne lance aucune
  // partie. La liste des refus qui arrêtent vit dans `WBCore.REFUS_SAS`, côté jeu, parce que c'est
  // le jeu qui décide quoi en faire — mais elle décrit des codes que le SERVEUR émet. Deux listes
  // qui décrivent la même chose se confrontent, sinon la seconde ment un jour en silence.
  const fs = require('node:fs'), path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  assert.deepStrictEqual(C.REFUS_SAS, ['fonds', 'livre', 'renonce_recent', 'plafond']);
  for (const code of C.REFUS_SAS)
    assert.ok(new RegExp("code: '" + code + "'").test(app),
      `le jeu arrête son sas sur un refus « ${code} » que l'API n'émet nulle part`);
  // Et chacun des trois sort bien en 409 : le jeu ne s'arrête que sur une réponse qui a un STATUT,
  // et un 500 est traité comme une panne. Le statut se lit sur l'`envoyer` le plus proche EN AMONT
  // du code, ce qui est exactement ce que le lecteur humain fait — et ce qu'un `[^}]*` ne sait pas
  // faire, la réponse portant des littéraux gabarits avec leurs propres accolades.
  const statutDe = code => {
    let statut = null;
    for (const m of app.matchAll(/envoyer\(res, (\d{3})|code: '([a-z_]+)'/g)) {
      if (m[1]) statut = m[1];
      else if (m[2] === code) return statut;
    }
    return null;
  };
  for (const code of C.REFUS_SAS)
    assert.strictEqual(statutDe(code), '409', `« ${code} » ne sort pas en 409`);
  // Le détecteur est éprouvé avant de servir, sur un refus dont on sait qu'il est un 404.
  assert.strictEqual(statutDe('billet'), '404', 'le détecteur de statut ne détecte rien');
  // LE SENS INVERSE, et c'est celui qui compte : un refus de `POST /api/match` qui n'est PAS dans la
  // liste laisse la partie partir hors ligne. Ce n'est pas un oubli, c'est la règle — mais elle doit
  // être relue le jour où un refus de plus arrive sur cette route.
  const ouverture = app.slice(app.indexOf('async function ouvrirBillet('), app.indexOf('async function recevoirTrace('));
  const codes = [...new Set([...ouverture.matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))].sort();
  assert.deepStrictEqual(codes, ['fonds', 'livre', 'plafond', 'renonce_recent'],
    'un refus de plus sur POST /api/match : décider s\'il arrête le sas ou non, et l\'écrire');
  // `plafond` EST ÉMIS DEUX FOIS SUR CETTE ROUTE, et c'est la moitié qui compte : un seul code, deux
  // PORTÉES. Le fusible global refuse avant les tirages de graines, le plafond par joueur revient de
  // la transaction — et les deux sortent en 409 avec la même forme de corps.
  assert.strictEqual((ouverture.match(/code: 'plafond'/g) || []).length, 2,
    'le plafond doit être émis par les deux portées : la maison, et le joueur');
  for (const portee of ['maison', 'joueur'])
    assert.ok(new RegExp(`portee: '${portee}'|portee: ouverture\\.portee`).test(ouverture),
      `la portée « ${portee} » ne part pas au client : le sas ne saurait quoi dire`);
});

await test('LA FRONTIÈRE AVEC LA 02a TIENT SUR TOUS LES CHEMINS D\'ARGENT, y compris les deux nouveaux', async () => {
  // Le test ci-dessus constate la frontière sur le règlement et sur la clôture d'un billet périmé.
  // La phase 03 a depuis ajouté DEUX écrivains d'argent — la route de renoncement, seul chemin du
  // dépôt qui rende une mise, et le veilleur, qui vide chaque séquestre — plus un effaceur, la
  // purge des traces. Une frontière qui ne tient que sur les chemins d'hier ne tient pas : on la
  // CONSTATE donc sur les trois, un billet 02a par chemin.
  //
  // Ce qu'une ligne 02a est, et pourquoi le livre ne doit pas y toucher : ses faits ont été
  // DÉCLARÉS par le client, jamais rejoués. `trace_steps` nul en est la marque. Le grand livre ne
  // lit que des lignes que le serveur a refaites lui-même.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  const apresDotation = db.ledger.length;
  const semer = (id, cle) => {
    const m = { id, user_id: uid, mode: 'solo', stake_cents: 50, seats: 20, team_size: 1,
                brawler: BRAWLER, seed_public: GRAINES[31], seed_secret: SECRETS[31],
                sim_version: 1, client_key: cle, status: 'open', first_result_at: null,
                trace_steps: null,
                opened_at: new Date(horloge.t), expires_at: new Date(horloge.t + 600 * 1000) };
    db.matches.push(m);
    return m;
  };
  const renoncee = semer(801, '02a-renonce');
  const veillee = semer(802, '02a-veilleur');
  const purgee = semer(803, '02a-purge');
  // Une trace sur la ligne à purger : sans elle, la purge n'aurait rien à ne pas faire.
  db.traces.push({ match_id: 803, seq: 0, sim_version: 1, steps: 10, data: 'aaa',
                   created_at: '2026-01-01T00:00:00Z' });

  // (1) LA ROUTE DE RENONCEMENT, dans sa fenêtre. Le montant rendu est ce que le SÉQUESTRE porte,
  // et il ne porte rien : la ligne est close, et pas un centime n'a bougé.
  const r = await renoncer(app, '801');
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.status, 'renounced');
  assert.strictEqual(r.corps.refundedCents, 0, 'une ligne 02a a été remboursée : elle n\'avait rien misé');
  assert.strictEqual(renoncee.status, 'renounced');

  // (2) LE VEILLEUR. Il clôt et il vide — sauf qu'il n'y a rien à vider. La ligne à purger est
  // réglée d'abord, sinon elle expirerait dans le même balayage et n'aurait plus rien à purger.
  horloge.t += 3600 * 1000;
  purgee.status = 'settled';
  purgee.settled_at = new Date(horloge.t - L.TRACE_RETENTION_JOURS * 24 * 3600 * 1000 - 1);
  const balayage = await app.veiller();
  assert.strictEqual(balayage.closes, 1, JSON.stringify(balayage));
  assert.deepStrictEqual(balayage.echecs, []);
  assert.strictEqual(veillee.status, 'expired');

  // (3) LA PURGE. La troisième de ses quatre conditions est « le grand livre a posé son écriture »,
  // et une ligne 02a n'en a jamais : sa trace n'est donc JAMAIS effacée, ce qui est le bon défaut —
  // c'est exactement la pièce qu'on voudra relire.
  const purge = await db.purgeTraces({ maintenant: new Date(horloge.t) });
  assert.deepStrictEqual({ effacees: purge.effacees, parties: purge.parties }, { effacees: 0, parties: 0 },
    'la trace d\'une ligne que le grand livre n\'a jamais touchée a été effacée');
  assert.strictEqual(db.traces.length, 1);

  // LE VERDICT : aucune écriture, sur aucun des trois, par aucun des chemins.
  for (const ref of ['801', '802', '803'])
    assert.deepStrictEqual(db.ledger.filter(l => l.reference === ref), [],
      `le grand livre a écrit sur la ligne 02a ${ref}`);
  assert.strictEqual(db.ledger.length, apresDotation,
    'le grand livre a bougé alors que seules des lignes 02a ont été traitées');
  zeroGlobal(db, 'trois lignes 02a, trois chemins d\'argent');

  // ET LA FRONTIÈRE SE VOIT, elle ne se devine pas : passer une de ces lignes à la réconciliation
  // produit le grief nommé « aucun engagement ». C'est ce que `ledgerReconcile` doit dire d'une
  // ligne qui n'a rien à faire dans le grand livre — un silence serait indistinguable d'un
  // appariement réussi, et le jour où une ligne 02a recevrait une écriture, personne ne le verrait.
  const griefs = L.ledgerReconcile(renoncee, livreDe(db));
  assert.strictEqual(griefs.length, 1, griefs.join(' | '));
  assert.match(griefs[0], /aucun engagement/);
});

await test('LES DEUX BORNES EXACTES DE LA FENÊTRE : à la neuvième seconde on rembourse, à la onzième on refuse et on n\'écrit rien', async () => {
  // La fenêtre vaut dix secondes, et pas les vingt-cinq de `LOBBY.wait` : le jeu décolle dès que la
  // salle est pleine. On n'écrit pas 10 ici — on interroge `WBCore.renonceFenetreS`, faute de quoi
  // ce test cesserait de dire la vérité le jour où le lobby change.
  const fenetre = C.renonceFenetreS() * 1000;
  assert.ok(fenetre > 0 && fenetre < C.LOBBY.wait * 1000, `${fenetre} ms`);

  // NEUVIÈME SECONDE : remboursé, au centime, et le billet est clos avec SON statut.
  {
    const { db, app, horloge } = bancDeBillet({ limiter: () => true });
    const b = await demander(app);
    const mise = b.corps.stakeCents;
    horloge.t = Date.parse(b.corps.openedAt) + 9000;
    const r = await renoncer(app, b.corps.id);
    assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
    assert.strictEqual(r.corps.status, 'renounced');
    assert.strictEqual(r.corps.refundedCents, mise);
    assert.strictEqual(r.corps.balanceCents, L.DOTATION_CENTS);
    assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS, 'la mise n\'est pas revenue');
    assert.strictEqual(soldeEnjeu(db, db.matches[0].id), 0);
    assert.strictEqual(remboursementsDe(db).length, 1);
    assert.strictEqual(remboursementsDe(db)[0].reference, String(db.matches[0].id));
    // La maison n'a rien encaissé : un renoncement n'est pas une défaite.
    assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_CONTREPARTIE), 0);
    zeroGlobal(db, 'après un renoncement');
    reconcilier(db, 'un billet renoncé');
  }
  // ONZIÈME SECONDE : refus NOMMÉ, en 409, et RIEN n'a bougé — ni la ligne, ni le livre.
  {
    const { db, app, horloge } = bancDeBillet({ limiter: () => true });
    const b = await demander(app);
    const avant = db.ledger.slice();
    let vu500 = 0;
    app.onError = () => { vu500++; };
    horloge.t = Date.parse(b.corps.openedAt) + 11000;
    const r = await renoncer(app, b.corps.id);
    assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
    assert.strictEqual(r.corps.code, 'fenetre_close');
    assert.strictEqual(vu500, 0, 'un refus de fenêtre est sorti en 500');
    assert.deepStrictEqual(db.ledger, avant, 'un refus de fenêtre a écrit dans le grand livre');
    assert.strictEqual(db.matches[0].status, 'open', 'un refus de fenêtre a clos le billet');
    assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS - b.corps.stakeCents);
    reconcilier(db, 'un renoncement refusé');
  }
  // ET LES DEUX BORNES EXACTES, au millième près : `renonciationOuverte` est un `<=`, donc le
  // dernier instant ouvert est la fenêtre elle-même. Une borne éprouvée à deux secondes près ne dit
  // rien de celle que le code applique.
  for (const [decalage, attendu] of [[fenetre, 200], [fenetre + 1, 409]]) {
    const { app, horloge } = bancDeBillet({ limiter: () => true });
    const b = await demander(app);
    horloge.t = Date.parse(b.corps.openedAt) + decalage;
    const r = await renoncer(app, b.corps.id);
    assert.strictEqual(r.code, attendu, `à ${decalage} ms : ${JSON.stringify(r.corps)}`);
  }
});

await test('les refus du renoncement sont NOMMÉS, jamais un 500, et aucun n\'enferme le joueur', async () => {
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  let vu500 = 0;
  app.onError = () => { vu500++; };
  const b = await demander(app);
  // Un billet inconnu, et le billet de quelqu'un d'autre : 404 tous les deux. Un identifiant deviné
  // ne doit rien apprendre sur la partie d'un autre, pas même qu'elle existe.
  assert.strictEqual((await renoncer(app, '999999')).code, 404);
  const autre = await renoncer(app, b.corps.id, { token: 'ok:u2:Zoe' });
  assert.strictEqual(autre.code, 404, JSON.stringify(autre.corps));

  // Un billet déjà clos : refus NOMMÉ, et la place est libre — le joueur n'est pas enfermé.
  horloge.t = Date.parse(b.corps.openedAt) + 1000;
  assert.strictEqual((await renoncer(app, b.corps.id)).code, 200);
  const deux = await renoncer(app, b.corps.id);
  assert.strictEqual(deux.code, 409, JSON.stringify(deux.corps));
  assert.strictEqual(deux.corps.code, 'billet_clos');
  assert.strictEqual(remboursementsDe(db).length, 1, 'renoncer deux fois a remboursé deux fois');
  assert.strictEqual(vu500, 0, 'un refus de renoncement est sorti en 500');

  // Et les formes de la route, comme pour la trace et le résultat.
  for (const m of ['GET', 'PATCH', 'DELETE'])
    assert.strictEqual((await appel(app, { method: m, path: '/api/match/1/renounce', token: 'ok:u1:Loic' })).code, 405, m);
  for (const chemin of ['/api/match//renounce', '/api/match/abc/renounce', '/api/match/1/renounce/x'])
    assert.strictEqual((await appel(app, { method: 'POST', path: chemin, token: 'ok:u1:Loic' })).code, 404, chemin);
  assert.strictEqual((await appel(app, { method: 'POST', path: '/api/match/1/renounce' })).code, 401);
  reconcilier(db, 'les refus du renoncement');
});

await test('UN ZÉRO DE TÊTE DANS LE CHEMIN N\'ATTEINT PLUS RIEN, et le grand livre se nomme sur la LIGNE', async () => {
  // Deux défauts en un, et le second était masqué par la doublure. (1) Les trois motifs de route
  // acceptaient `007` : Postgres convertit ce texte en `bigint` 7, donc `findMatch` retrouvait bien
  // la ligne — mais `renounceMatch` nommait ensuite le séquestre avec le PARAMÈTRE reçu, et
  // `compteEnjeu('007')` lève à juste titre (un identifiant de ligne est un entier positif sans
  // zéro de tête). L'exception n'était pas un refus du livre : elle remontait, et la seule route
  // qui rende une mise sortait en 500. (2) La doublure comparait les identifiants en TEXTE, donc
  // elle répondait 404 à `007` là où la base répond 200 : elle prouvait la doublure.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  let vu500 = 0;
  app.onError = () => { vu500++; };
  const b = await demander(app);
  assert.strictEqual(b.corps.id, '1');
  horloge.t = Date.parse(b.corps.openedAt) + 1000;

  // LA CEINTURE : un `bigserial` ne produit jamais de zéro de tête, donc un chemin qui en porte un
  // n'est pas une route. Il est refusé avant l'authentification et avant la base — même raison que
  // le `[1-9][0-9]*` de `COMPTE_RE_SQL`, écrite au même endroit.
  for (const suffixe of ['renounce', 'result', 'trace']) {
    const r = await appel(app, { method: 'POST', path: `/api/match/007/${suffixe}`,
                                 token: 'ok:u1:Loic', body: {} });
    assert.strictEqual(r.code, 404, suffixe + ' : ' + JSON.stringify(r.corps));
    assert.strictEqual(r.corps.erreur, 'Route inconnue.', suffixe);
  }
  assert.strictEqual(db.matches[0].status, 'open', 'un chemin refusé n\'a rien clos');
  assert.strictEqual(vu500, 0, 'un zéro de tête est sorti en 500');

  // LES BRETELLES : la couche base, appelée directement avec le paramètre tel que la route l'aurait
  // capturé. Elle doit nommer ses comptes sur l'`id` DE LA LIGNE relue, jamais sur ce qu'on lui a
  // passé — c'est le patron que `reglerSequestre` applique déjà avec `ligne.id`.
  const avant = soldeEnjeu(db, 1);
  assert.strictEqual(avant, b.corps.stakeCents, 'le séquestre porte la mise');
  const r = await db.renounceMatch({ matchId: '00' + b.corps.id, userId: db.users[0].id,
                                     at: new Date(horloge.t) });
  assert.ok(r.match, 'la ligne 1 doit être retrouvée, comme Postgres la retrouve');
  assert.strictEqual(r.rembourseCents, b.corps.stakeCents, 'la mise n\'a pas été rendue');
  assert.strictEqual(soldeEnjeu(db, 1), 0, 'le séquestre n\'a pas été vidé');
  reconcilier(db, 'un renoncement demandé avec un zéro de tête');
});

test('GARDE TEXTUELLE : renounceMatch nomme ses comptes sur la ligne, jamais sur le paramètre', () => {
  // `db-pg.js` n'est exécuté par aucune suite — c'est la dette écrite de la phase — donc ce qu'on
  // peut encore en dire, on le dit par le texte. Le défaut se redéferait en une seule frappe.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'db-pg.js'), 'utf8');
  const rm = src.slice(src.indexOf('    async renounceMatch('), src.indexOf('    async lastRenounced('));
  assert.ok(rm.length > 600, 'renounceMatch n\'a pas été retrouvée');
  const code = rm.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.includes('const ligne = maj.rows[0];'), 'la ligne relue doit être nommée une fois');
  assert.ok(code.includes('L.compteEnjeu(ligne.id)'), 'le séquestre se nomme avec l\'id de la ligne');
  for (const interdit of ['compteEnjeu(matchId)', 'compteJoueur(userId)', 'compteQuarantaine(userId)',
                          'matchId, miseCents', 'ligneMatch(maj.rows[0])'])
    assert.ok(!code.includes(interdit), `renounceMatch nomme un compte avec le paramètre : ${interdit}`);
});

test('GARDE TEXTUELLE : la création de compte réessaie SOUS UN POINT DE REPRISE', () => {
  // Sans le `savepoint`, le réessai de pseudo est mort-né : dans un bloc transactionnel, toute
  // commande qui suit une erreur sort en `25P02` et jamais en `23505`, donc le test de code était
  // faux, la transaction partait en `rollback`, et le SECOND compte jamais créé sortait en 500 —
  // sans compte et sans dotation. Et ce n'était pas rare : Crossmint ne transporte pas de pseudo,
  // donc tout nouveau compte se présente avec le même `NAME.fallback`, donc la même `name_key`.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'db-pg.js'), 'utf8');
  const fc = src.slice(src.indexOf('    async findOrCreate('), src.indexOf('    async updateProfile('));
  assert.ok(fc.length > 800, 'findOrCreate n\'a pas été retrouvée');
  const code = fc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.includes("await client.query('savepoint pseudo');"), 'le point de reprise a disparu');
  assert.ok(code.includes("await client.query('rollback to savepoint pseudo');"),
    'un point de reprise qu\'on n\'annule pas ne protège rien');
  assert.ok(code.includes("await client.query('release savepoint pseudo');"));
  // Et il ENTOURE l'insertion : posé après, il ne protégerait rien.
  assert.ok(code.indexOf("savepoint pseudo") < code.indexOf('insert into users'), code);
  // Le repli du fournisseur est bien le même pour tout le monde : c'est ce qui rend la collision
  // certaine plutôt que rare, et c'est pour cela que ce chemin doit marcher du premier coup.
  assert.strictEqual(C.nameOr('', C.NAME.fallback), C.NAME.fallback);
  assert.strictEqual(C.nameKey(C.NAME.fallback), C.nameKey(C.nameOr('', C.NAME.fallback)));
});

await test('LE VEILLEUR PASSÉ CENT FOIS : il ne rembourse jamais, il ne vide jamais deux fois, et chaque séquestre part chez la maison', async () => {
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const joueurs = ['ok:u1:Loic', 'ok:u2:Zoe', 'ok:u3:Max'];
  const billets = [];
  for (let i = 0; i < joueurs.length; i++)
    billets.push(await demander(app, { ...DEMANDE, stake: [0.5, 1, 5][i], clientKey: 'v' + i },
                                { token: joueurs[i] }));
  const mises = billets.map(b => b.corps.stakeCents);
  horloge.t = Math.max(...billets.map(b => Date.parse(b.corps.expiresAt))) + 1;

  const premier = await app.veiller();
  assert.deepStrictEqual(premier, { closes: 3, echecs: [] });
  const apresPremier = db.ledger.slice();
  // CENT PASSAGES DE PLUS. Le livre ne bouge pas d'une ligne : un séquestre déjà vide n'a rien à
  // vider, et la clause `status = 'open'` n'a plus rien à clore.
  for (let i = 0; i < 100; i++)
    assert.deepStrictEqual(await app.veiller(), { closes: 0, echecs: [] }, `passage ${i}`);
  assert.deepStrictEqual(db.ledger, apresPremier, 'le veilleur a réécrit au centième passage');

  assert.strictEqual(remboursementsDe(db).length, 0,
    'le veilleur a remboursé : passé la fenêtre, RIEN ne rend la mise');
  for (const b of billets) assert.strictEqual(soldeEnjeu(db, b.corps.id), 0, b.corps.id);
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_CONTREPARTIE), mises.reduce((a, m) => a + m, 0),
    'les séquestres ne sont pas tous arrivés chez la maison');
  for (let i = 0; i < joueurs.length; i++) {
    const uid = db.users[i].id;
    assert.strictEqual(L.soldeDe(livreDe(db), L.compteJoueur(uid)), L.DOTATION_CENTS - mises[i]);
  }
  zeroGlobal(db, 'après cent passages du veilleur');
  reconcilier(db, 'le veilleur');
});

await test('UN BILLET QUI ÉCHOUE N\'EMPORTE PAS LE BALAYAGE : une transaction par billet, et l\'échec est NOMMÉ', async () => {
  // C'est la raison de forme du revirement : un mouvement du grand livre ne se pose pas en masse.
  // Avec un `update` de 500 lignes, un seul refus d'écriture annulerait les 499 autres clôtures —
  // ou pire, les laisserait closes avec leur séquestre habité.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const joueurs = ['ok:u1:Loic', 'ok:u2:Zoe', 'ok:u3:Max'];
  const billets = [];
  for (let i = 0; i < joueurs.length; i++)
    billets.push(await demander(app, { ...DEMANDE, clientKey: 'e' + i }, { token: joueurs[i] }));
  const casse = String(billets[1].corps.id);
  horloge.t = Math.max(...billets.map(b => Date.parse(b.corps.expiresAt))) + 1;

  // Le grand livre refuse le vidage du SECOND séquestre, et de lui seul.
  db.panne.ledger = t => t.some(x => x.motif === 'gain' && x.reference === casse);
  const r = await app.veiller();
  assert.strictEqual(r.closes, 2, 'un échec a emporté les clôtures voisines');
  assert.deepStrictEqual(r.echecs, [{ id: casse, code: '23505' }],
    'le billet en échec doit être NOMMÉ, pas avalé');
  // Le billet en échec n'a PAS bougé : ni clos, ni vidé. C'est le seul état acceptable — une ligne
  // close dont le séquestre reste habité serait de l'argent que plus rien ne solde.
  const rate = db.matches.find(m => String(m.id) === casse);
  assert.strictEqual(rate.status, 'open');
  assert.strictEqual(soldeEnjeu(db, rate.id), rate.stake_cents);
  for (const b of billets) if (String(b.corps.id) !== casse) {
    assert.strictEqual(db.matches.find(m => String(m.id) === b.corps.id).status, 'expired');
    assert.strictEqual(soldeEnjeu(db, b.corps.id), 0);
  }
  reconcilier(db, 'après un balayage partiel');

  // La panne passée, le tour suivant le reprend. Rien n'est perdu, rien n'est enfermé.
  db.panne.ledger = null;
  assert.deepStrictEqual(await app.veiller(), { closes: 1, echecs: [] });
  assert.strictEqual(rate.status, 'expired');
  assert.strictEqual(soldeEnjeu(db, rate.id), 0);
  zeroGlobal(db, 'après la reprise du veilleur');
  reconcilier(db, 'le veilleur après la panne');
});

await test('UN RÉSULTAT ARRIVÉ APRÈS UN REMBOURSEMENT n\'écrit aucun second mouvement, et un billet remboursé ne reçoit plus de gain', async () => {
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  // La trace arrive AVANT le renoncement : le billet est encore ouvert, c'est un envoi parfaitement
  // normal. Ce qui doit être refusé, c'est de le faire PAYER après coup.
  await poserTrace(app, b.corps.id, p.segments);
  horloge.t = Date.parse(b.corps.openedAt) + 5000;
  const rr = await renoncer(app, b.corps.id);
  assert.strictEqual(rr.code, 200, JSON.stringify(rr.corps));
  const apresRemboursement = db.ledger.slice();
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS);

  // Le résultat arrive quand même. La ligne est close : on relit son état, on ne recalcule rien, et
  // AUCUN montant n'entre — c'est la doctrine de tout billet clos, appliquée au sixième statut.
  horloge.t = ARRIVEE(p.rapport);
  const rep = await rendre(app, b.corps.id, p.rapport);
  assert.strictEqual(rep.corps.status, 'renounced', JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.netCents, null, 'un billet remboursé a reçu un gain');
  assert.deepStrictEqual(db.ledger, apresRemboursement,
    'un résultat rendu après un remboursement a écrit dans le grand livre');
  assert.strictEqual(db.ledger.filter(l => l.motif === 'gain').length, 0);
  assert.strictEqual(soldeJoueur(db), L.DOTATION_CENTS);
  // Et une trace de plus est refusée, nommément : le billet est clos.
  const t = await appel(app, { method: 'POST', path: `/api/match/${b.corps.id}/trace`,
                               token: 'ok:u1:Loic',
                               body: { seq: 9, simVersion: SIM.SIM_VERSION, data: p.segments[0] } });
  assert.strictEqual(t.code, 409, JSON.stringify(t.corps));
  assert.strictEqual(t.corps.code, 'billet_clos');
  // ET LE SÉQUESTRE REFUSERAIT DE TOUTE FAÇON : un gain devrait le débiter, et il est vide. C'est la
  // protection qui reste debout même si la clause `where` du règlement glissait un jour.
  const ligne = db.matches[0];
  await assert.rejects(() => db.ledgerWrite(L.mouvementGain({
    userId: ligne.user_id, matchId: ligne.id, miseCents: ligne.stake_cents,
    grossCents: 400, feeCents: 80, netCents: 320, convergee: true })),
    e => e.code === 'decouvert', 'un gain a pu être posé sur un séquestre remboursé');
  zeroGlobal(db, 'après un résultat tardif');
  reconcilier(db, 'le billet remboursé puis rendu');
});

await test('LA TEMPORISATION DU CHERCHEUR DE GRAINE : 409 renonce_recent pendant la fenêtre, accepté juste après, et le refus n\'écrit rien', async () => {
  // Renoncer à la première seconde clôt le billet et libère l'index partiel : `createMatch` en
  // délivrerait un neuf immédiatement, avec une graine neuve, et comme la carte est une fonction
  // pure de `seed_public` — que le client reçoit AVEC le billet — un nouveau tirage coûterait un
  // aller-retour HTTP. La temporisation le fait coûter la fenêtre entière.
  const { db, app, horloge, tires } = bancDeBillet({ limiter: () => true });
  const un = await demander(app);
  const ouvert = Date.parse(un.corps.openedAt);
  horloge.t = ouvert + 1000;
  assert.strictEqual((await renoncer(app, un.corps.id)).code, 200);

  const graines = tires(), lignes = db.matches.length, livre = db.ledger.length;
  horloge.t = ouvert + 2000;
  const refus = await demander(app, { ...DEMANDE, clientKey: 'trop-tot' });
  assert.strictEqual(refus.code, 409, JSON.stringify(refus.corps));
  assert.strictEqual(refus.corps.code, 'renonce_recent');
  assert.strictEqual(refus.corps.windowSeconds, C.renonceFenetreS());
  assert.strictEqual(db.matches.length, lignes, 'la temporisation a laissé un billet');
  assert.strictEqual(db.ledger.length, livre, 'la temporisation a laissé une écriture');
  // ELLE NE CONSOMME PAS MÊME UNE GRAINE : le refus est posé avant les deux tirages. Un chercheur
  // de graine qui martèlerait la route n'en verrait pas défiler une seule.
  assert.strictEqual(tires(), graines, 'un tirage de graine a eu lieu malgré le refus');

  // Et elle tient jusqu'au dernier millième : la borne est celle de `renonciationOuverte`, pas une
  // seconde arrondie.
  horloge.t = ouvert + C.renonceFenetreS() * 1000;
  assert.strictEqual((await demander(app, { ...DEMANDE, clientKey: 'pile' })).corps.code, 'renonce_recent');
  horloge.t = ouvert + C.renonceFenetreS() * 1000 + 1;
  const neuf = await demander(app, { ...DEMANDE, clientKey: 'apres' });
  assert.strictEqual(neuf.code, 200, JSON.stringify(neuf.corps));
  assert.notStrictEqual(neuf.corps.seed, un.corps.seed, 'un billet neuf doit porter une graine neuve');
  assert.strictEqual(neuf.corps.balanceCents, L.DOTATION_CENTS - neuf.corps.stakeCents);
  zeroGlobal(db, 'après la temporisation');
  reconcilier(db, 'la temporisation');
});

await test('LA SIXIÈME ISSUE : sur les cinq modes et les quatre tables, un billet renoncé laisse le livre équilibré et le séquestre VIDE', async () => {
  // Le test des cinquante parties couvre les cinq issues que le module 3 savait produire, et il dit
  // qu'il ne couvre pas `renounced`. Celui-ci la couvre, sur le même domaine.
  const db = fakeDb();
  const horloge = { t: T0 };
  let g = 0, s = 0;
  const app = appDe(db, {
    randomSeed: () => GRAINES[g++ % GRAINES.length],
    randomSecret: () => SECRETS[s++ % SECRETS.length],
    now: () => horloge.t, chrono: () => 0, limiter: () => true,
  });
  const MODES = Object.keys(C.MODES), MISES = C.TIERS.map(t => t.stake);
  let n = 0;
  for (const mode of MODES) for (const stake of MISES) {
    const token = `ok:r${n}:Zoe`;
    const quoi = `renoncement ${mode} ${stake} $`;
    horloge.t = T0;
    const b = await demander(app, { mode, stake, brawler: BRAWLER, clientKey: 'a' }, { token });
    assert.strictEqual(b.code, 200, `${quoi} : ${JSON.stringify(b.corps)}`);
    assert.strictEqual(soldeEnjeu(db, b.corps.id), b.corps.stakeCents, quoi);
    horloge.t = T0 + 4000;
    const r = await renoncer(app, b.corps.id, { token });
    assert.strictEqual(r.code, 200, `${quoi} : ${JSON.stringify(r.corps)}`);
    assert.strictEqual(r.corps.refundedCents, b.corps.stakeCents, quoi);
    assert.strictEqual(soldeEnjeu(db, b.corps.id), 0, `${quoi} : séquestre non vidé`);
    const uid = db.users.find(u => u.auth_id === `r${n}`).id;
    assert.strictEqual(L.soldeDe(livreDe(db), L.compteJoueur(uid)), L.DOTATION_CENTS, quoi);
    zeroGlobal(db, quoi);
    reconcilier(db, quoi);
    n++;
  }
  assert.strictEqual(n, MODES.length * MISES.length);
  assert.ok(db.matches.every(m => m.status === 'renounced'));
  // La maison n'a rien gagné et rien perdu : un renoncement est un aller-retour, pas une partie.
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_CONTREPARTIE), 0);
  assert.strictEqual(L.soldeDe(livreDe(db), L.MAISON_COMMISSION), 0);
});

// ---------- LA CONSERVATION DES TRACES ----------
// Un cas dégénéré, construit exprès : une partie réglée, vieille, dont le livre porte l'écriture et
// dont le séquestre est vide. C'est le seul état où une trace s'efface, et chacune des quatre
// conditions est ensuite RETIRÉE SEULE. On ne teste pas en bloc le premier `delete` du dépôt sur la
// pièce qui prouve un paiement.
async function bancDeTrace({ status = 'settled', settledAt = T0, avecMise = true, avecGain = true,
                             gainPartiel = 0, segments = 2 } = {}) {
  const db = fakeDb();
  const id = 1, uid = 1, mise = 50;
  await db.ledgerWrite(L.mouvementDotation({ userId: uid, montantCents: L.DOTATION_CENTS }));
  db.matches.push({ id, user_id: uid, mode: 'solo', stake_cents: mise, seats: 20, team_size: 1,
                    brawler: BRAWLER, seed_public: GRAINES[0], seed_secret: SECRETS[0],
                    sim_version: SIM.SIM_VERSION, client_key: 'archive', status,
                    first_result_at: new Date(T0), opened_at: new Date(T0),
                    expires_at: new Date(T0 + 1000),
                    settled_at: settledAt === null ? null : new Date(settledAt),
                    gross_cents: 0, fee_cents: 0, net_cents: status === 'settled' ? 0 : null,
                    digest_match: true });
  if (avecMise) await db.ledgerWrite(L.mouvementMise({ userId: uid, matchId: id, miseCents: mise }));
  if (avecGain) {
    // `gainPartiel` est ce qui rend le cas DÉGÉNÉRÉ : le livre a bien posé son écriture — la
    // condition (b) tient — mais il n'a vidé qu'une partie du séquestre, si bien que (c) ne tient
    // plus. C'est le seul montage qui sépare vraiment ces deux conditions-là.
    const vide = gainPartiel || mise;
    await db.ledgerWrite(L.mouvementGain({ matchId: id, miseCents: vide,
                                           grossCents: 0, feeCents: 0, netCents: 0 }));
  }
  for (let seq = 0; seq < segments; seq++)
    await db.addTrace({ matchId: id, seq, simVersion: SIM.SIM_VERSION, steps: 1,
                        data: 'AAAA' + seq, maxSteps: 1_000_000 });
  return { db, id, mise };
}
const APRES_RETENTION = T0 + (L.TRACE_RETENTION_JOURS + 1) * 24 * 3600 * 1000;

await test('LA PURGE, CAS NOMINAL : les quatre conditions réunies, la trace s\'efface — et rien d\'autre', async () => {
  const { db } = await bancDeTrace();
  assert.strictEqual(db.traces.length, 2);
  const lignes = JSON.stringify(db.matches), livre = db.ledger.slice();
  const r = await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) });
  assert.strictEqual(r.effacees, 2, 'les deux segments de la partie doivent partir ensemble');
  assert.strictEqual(r.parties, 1);
  assert.strictEqual(db.traces.length, 0);
  // ELLE NE TOUCHE NI UNE LIGNE `matches`, NI UNE ÉCRITURE DU GRAND LIVRE. `ledger_entries` reste en
  // insertion seule, sans exception : la purge porte sur `match_traces` et sur elle seule.
  assert.strictEqual(JSON.stringify(db.matches), lignes, 'la purge a touché une ligne matches');
  assert.deepStrictEqual(db.ledger, livre, 'la purge a touché une écriture du grand livre');
  zeroGlobal(db, 'après la purge');
  reconcilier(db, 'la purge');
  // Repassée, elle n'a plus rien à faire : une trace effacée ne se réefface pas.
  assert.deepStrictEqual(await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) }),
    { effacees: 0, parties: 0, avant: new Date(APRES_RETENTION - L.TRACE_RETENTION_JOURS * 24 * 3600 * 1000) });
});

await test('LA PURGE, CONDITION (a) RETIRÉE : une ligne qui n\'est pas réglée DÉFINITIVEMENT garde sa trace', async () => {
  // `expired`, `abandoned`, `renounced` et `open` ne sont pas des règlements : la partie n'a jamais
  // été jugée, et c'est exactement la pièce qu'on voudra relire.
  for (const status of ['expired', 'abandoned', 'renounced', 'open']) {
    const { db } = await bancDeTrace({ status });
    const r = await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) });
    assert.strictEqual(r.effacees, 0, `une trace ${status} a été effacée`);
    assert.strictEqual(db.traces.length, 2, status);
  }
  // Et le contre-témoin : `rejected` est bien un règlement définitif, donc il purge.
  const { db } = await bancDeTrace({ status: 'rejected' });
  assert.strictEqual((await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) })).effacees, 2,
    'une ligne refusée est réglée définitivement : sa trace doit pouvoir partir');
});

await test('LA PURGE, CONDITION (b) RETIRÉE : sans écriture du grand livre sur cette partie, la trace reste', async () => {
  // Le cas est celui d'une ligne de la phase 02a : faits déclarés, aucune mise, aucun gain. Son
  // séquestre est vide — la condition (c) tient donc toute seule — et c'est bien la condition (b)
  // qui la retient. Sans elle, la première purge effacerait les pièces de toutes les lignes que le
  // grand livre n'a jamais lues.
  const { db } = await bancDeTrace({ avecMise: false, avecGain: false });
  assert.strictEqual(L.soldeDe(livreDe(db), L.compteEnjeu(1)), 0, 'le montage ne teste pas (b) seule');
  // ET LE MOTIF COMPTE, PAS SEULEMENT LA RÉFÉRENCE. Une dotation porte `<user_id>` et un gain porte
  // `<match_id>` : les deux vivent dans le même espace de noms, et le joueur 1 de ce montage a bien
  // une écriture de référence « 1 ». Sans le filtre sur le motif, la dotation d'un joueur ferait
  // purger la trace de la partie qui porte le même numéro — une collision silencieuse, et sur le
  // chemin d'un effacement.
  assert.ok(db.ledger.some(l => l.reference === '1' && l.motif === 'dotation'),
    'le montage ne met pas la collision de référence à l\'épreuve');
  assert.strictEqual(db.ledger.filter(l => l.reference === '1'
    && L.MOTIFS_REGLEMENT.includes(l.motif)).length, 0);
  const r = await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) });
  assert.strictEqual(r.effacees, 0, 'une trace sans écriture du grand livre a été effacée');
  assert.strictEqual(db.traces.length, 2);
});

await test('LA PURGE, CONDITION (c) RETIRÉE : un séquestre encore habité retient sa trace', async () => {
  // Le cas dégénéré : le livre a POSÉ son écriture — (b) tient — mais il n'a vidé que trente des
  // cinquante centimes. Il reste vingt centimes en attente, et tant qu'il en reste un seul, la pièce
  // qui prouve ce que cette partie a payé ne s'efface pas.
  const { db } = await bancDeTrace({ gainPartiel: 30 });
  assert.strictEqual(L.soldeDe(livreDe(db), L.compteEnjeu(1)), 20, 'le montage ne teste pas (c) seule');
  assert.ok(db.ledger.some(l => l.reference === '1' && l.motif === 'gain'), '(b) doit tenir ici');
  const r = await db.purgeTraces({ maintenant: new Date(APRES_RETENTION) });
  assert.strictEqual(r.effacees, 0, 'une trace dont le séquestre est habité a été effacée');
  assert.strictEqual(db.traces.length, 2);
});

await test('LA PURGE, CONDITION (d) RETIRÉE : avant le délai de rétention, rien ne part', async () => {
  const { db } = await bancDeTrace();
  // La veille du terme, au millième près. Une rétention éprouvée à un mois près ne dit rien de celle
  // que le code applique.
  const veille = T0 + L.TRACE_RETENTION_JOURS * 24 * 3600 * 1000;
  assert.strictEqual((await db.purgeTraces({ maintenant: new Date(veille) })).effacees, 0,
    'une trace a été effacée le jour même du terme : le contrôle est un « plus vieux que »');
  assert.strictEqual((await db.purgeTraces({ maintenant: new Date(veille + 1) })).effacees, 2,
    'la rétention ne se termine jamais : la table grandirait sans borne');
  // Et une ligne close sans `settled_at` ne part pas non plus : sans date, il n'y a pas de délai.
  const sansDate = await bancDeTrace({ settledAt: null });
  assert.strictEqual((await sansDate.db.purgeTraces({ maintenant: new Date(APRES_RETENTION) })).effacees, 0,
    'une ligne sans settled_at a été purgée : sur quel délai ?');
});

await test('LA PURGE N\'EFFACE JAMAIS LA TRACE D\'UN BILLET DONT LE RÉSULTAT N\'EST JAMAIS ARRIVÉ, et la table ne descend pas à zéro', async () => {
  // C'est la conséquence directe de la première condition, et c'est LE BON DÉFAUT : la ligne d'un
  // billet que personne n'a terminé n'est ni `settled` ni `rejected`, donc sa pièce reste. C'est
  // exactement celle qu'on voudra relire le jour où quelqu'un contestera une mise perdue.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  const p = partieDe(b, { encaisser: 300 });
  await poserTrace(app, b.corps.id, p.segments);
  const combien = db.traces.length;
  assert.ok(combien > 0);
  // Le résultat n'arrive jamais. Le veilleur clôt, vide le séquestre, et n'écrit aucun verdict.
  horloge.t = Date.parse(b.corps.expiresAt) + 1;
  await app.veiller();
  assert.strictEqual(db.matches[0].status, 'expired');
  assert.strictEqual(soldeEnjeu(db, db.matches[0].id), 0);

  // Quatre cents jours plus tard, et mille ans plus tard : la trace est toujours là.
  horloge.t = APRES_RETENTION;
  assert.strictEqual((await app.purger()).effacees, 0);
  horloge.t = T0 + 1000 * 365 * 24 * 3600 * 1000;
  assert.strictEqual((await app.purger()).effacees, 0,
    'la pièce d\'un billet jamais jugé a fini par être effacée');
  assert.strictEqual(db.traces.length, combien);
  zeroGlobal(db, 'après une purge qui n\'efface rien');
  reconcilier(db, 'le billet jamais jugé');
});

console.log('Le plafond refuse à l\'ouverture, et le sas le dit');

// SEMER UNE VICTOIRE MAXIMALE, EN POSANT DES ÉCRITURES. C'est la moitié qui compte : on franchit le
// plafond en écrivant dans le grand livre, jamais en touchant un compteur — il n'existe aucune
// colonne à écrire, et relire redonne le même chiffre. La ligne `matches` qui va avec est posée
// aussi, pour que `ledgerReconcile` reste sans grief : une exposition semée dans le vide serait un
// engagement sans billet, c'est-à-dire un grief, pas un décor.
//
// La mise est débitée puis le gain crédité : le joueur peut donc en enchaîner autant qu'on veut, la
// première seule ayant besoin de sa dotation.
let semees = 0;
async function semerVictoireMaximale(db, userId, miseCents, seats, at) {
  const p = C.cashoutCents(C.purseBound(miseCents, seats).maxCents);
  const id = 900001 + (semees++);
  const quand = new Date(at);
  db.matches.push({
    id, user_id: userId, mode: 'resurgence', stake_cents: miseCents, seats, team_size: 1,
    paid_seats: 1, brawler: BRAWLER, seed_public: 1, seed_secret: SECRETS[0],
    sim_version: SIM.SIM_VERSION, client_key: `semee-${id}`, status: 'settled',
    first_result_at: quand, opened_at: quand, expires_at: quand, settled_at: quand,
    issue: 'encaissement', controle: null, motif: null,
    gross_cents: p.grossCents, fee_cents: p.feeCents, net_cents: p.netCents,
    purse_cents: 0, declared_net_cents: null, ecart_cents: null,
    seconds: 1, kills: 0, deaths: 0, rank: 1, cubes: 0, damage: 0, cashed_out: true,
    trace_steps: 1, replay_digest: null, digest_match: true, divergence_step: null, replay_ms: 0,
  });
  await db.ledgerWrite(L.mouvementMise({ userId, matchId: id, miseCents }));
  await db.ledgerWrite(L.mouvementGain({ userId, matchId: id, miseCents, grossCents: p.grossCents,
                                         feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  return { id, pireCas: L.expositionBilletMaxCents(p.netCents, miseCents), p };
}
// Les deux tables qui servent à tout ce qui suit, et leurs pires cas — RECALCULÉS depuis `WBCore`,
// jamais écrits à la main. La chère porte le maximum du domaine (39 000 centimes), la petite le
// minimum utile : c'est cet écart qui rend « une table moins chère marchera » vérifiable plutôt que
// promis.
const CHERE = { corps: { ...DEMANDE, mode: 'resurgence', stake: 10 },
                miseCents: 1000, seats: C.seatsOf(C.MODES.resurgence) };
const PETITE = { corps: { ...DEMANDE, mode: 'solo', stake: 0.5 },
                 miseCents: 50, seats: C.seatsOf(C.MODES.solo) };
const pireCasChere = () => pireCasDe(CHERE.miseCents, CHERE.seats);
const pireCasPetite = () => pireCasDe(PETITE.miseCents, PETITE.seats);

await test('UN REFUS plafond NE LAISSE RIEN, et la table moins chère s\'ouvre DANS LA FOULÉE', async () => {
  // La propriété entière : le refus est un 409 nommé, il ne pose ni ligne, ni écriture, ni
  // séquestre, `ledgerReconcile` reste sans grief — et il n'enferme personne. C'est la leçon du
  // `22003` transposée : un joueur n'a qu'un billet ouvert à la fois, donc un refus qui laisserait
  // quoi que ce soit derrière lui le bloquerait jusqu'à l'expiration.
  const { db, app, horloge, tires } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;

  // TROIS victoires maximales et une demi-table : de quoi refuser la table la plus chère sans
  // refuser la plus petite. Le nombre n'est pas choisi au hasard — trois pires cas maximaux laissent
  // passer le QUATRIÈME billet, c'est la définition même de `PLAFOND_TABLES_PAR_JOUR` — donc il faut
  // strictement plus que trois pour voir un refus, et strictement moins que le plafond entier pour
  // que la petite table passe encore.
  let realisee = 0;
  for (let i = 0; i < 3; i++)
    realisee += (await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t)).pireCas;
  realisee += (await semerVictoireMaximale(db, uid, 500, CHERE.seats, horloge.t)).pireCas;
  assert.strictEqual(realisee, 3 * pireCasChere() + pireCasDe(500, CHERE.seats));
  assert.ok(realisee + pireCasChere() > L.PLAFOND_JOUEUR_CENTS, `${realisee} : la chère passerait`);
  assert.ok(realisee + pireCasPetite() <= L.PLAFOND_JOUEUR_CENTS, `${realisee} : la petite tomberait aussi`);

  const lignes = db.matches.length, livre = db.ledger.length, graines = tires();
  const r = await demander(app, { ...CHERE.corps, clientKey: 'chere' });

  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'plafond');
  assert.strictEqual(r.corps.portee, 'joueur');
  assert.strictEqual(r.corps.expositionCents, realisee + pireCasChere());
  assert.strictEqual(r.corps.plafondCents, L.PLAFOND_JOUEUR_CENTS);
  assert.strictEqual(r.corps.fenetreHeures, L.PLAFOND_FENETRE_H);
  // Le corps ne porte AUCUN montant du joueur : rien n'a bougé, il n'y a rien à dire, et un solde
  // rendu ici serait un solde que le jeu écrirait pour rien.
  assert.ok(!('balanceCents' in r.corps) && !('quarantineCents' in r.corps), JSON.stringify(r.corps));

  // RIEN N'A ÉTÉ POSÉ.
  assert.strictEqual(db.matches.length, lignes, 'le refus a laissé une ligne dans matches');
  assert.strictEqual(db.ledger.length, livre, 'le refus a laissé une écriture');
  for (const m of db.matches)
    assert.strictEqual(soldeEnjeu(db, m.id), 0, `le séquestre de ${m.id} est habité`);
  zeroGlobal(db, 'après un refus de plafond');
  reconcilier(db, 'le refus de plafond');

  // CE QUE LE REFUS CONSOMME QUAND MÊME, ÉCRIT PLUTÔT QUE TU : UNE GRAINE. Le verdict par joueur est
  // EXACT, donc il se lit sous le verrou de ligne, donc dans la transaction — c'est-à-dire après que
  // le routeur a tiré ses deux graines. C'est exactement ce que fait déjà le refus `fonds`, et pour
  // la même raison. Ce n'est pas la même chose que `renonce_recent`, qui refuse AVANT les tirages :
  // là-bas la graine est l'enjeu du refus — un chercheur de carte martelait la route — ici le joueur
  // n'obtient aucun billet, donc aucune carte, et le tirage ne lui apprend rien. La source est un
  // générateur, pas une suite finie.
  assert.strictEqual(tires(), graines + 1,
    'le refus par joueur se décide dans la transaction : il a tiré sa graine comme le refus `fonds`');

  // ET IL N'ENFERME PERSONNE : la table moins chère s'ouvre immédiatement, mise débitée, séquestre
  // habité. C'est ce que la portée `joueur` promet à l'écran, et c'est vérifié ici plutôt qu'écrit.
  const petite = await demander(app, { ...PETITE.corps, clientKey: 'petite' });
  assert.strictEqual(petite.code, 200, JSON.stringify(petite.corps));
  assert.strictEqual(petite.corps.repris, false);
  assert.strictEqual(petite.corps.stakeCents, PETITE.miseCents);
  assert.strictEqual(soldeEnjeu(db, petite.corps.id), PETITE.miseCents);
  zeroGlobal(db, 'après la table moins chère');
  reconcilier(db, 'la table moins chère ouverte après un refus');
});

await test('LE PLAFOND LAISSE PASSER LE QUATRIÈME BILLET MAXIMAL, et refuse le cinquième', async () => {
  // `PLAFOND_TABLES_PAR_JOUR` vaut quatre, et cela veut dire QUATRE tables ouvertes, pas trois. La
  // comparaison de `plafondVerdict` est stricte pour cette raison exacte ; ce test le constate de
  // bout en bout, par la route, plutôt que sur la fonction pure.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR - 1; i++)
    await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);

  const quatrieme = await demander(app, { ...CHERE.corps, clientKey: 'q4' });
  assert.strictEqual(quatrieme.code, 200, 'le quatrième billet maximal doit passer : sinon le plafond en vaut trois');
  // On le clôt, et on sème la quatrième victoire : le cinquième, lui, est refusé.
  db.matches.find(m => String(m.id) === String(quatrieme.corps.id)).status = 'abandoned';
  await db.ledgerWrite(L.mouvementGain({ userId: uid, matchId: quatrieme.corps.id,
    miseCents: CHERE.miseCents, grossCents: 0, feeCents: 0, netCents: 0, convergee: true }));
  await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);
  const cinquieme = await demander(app, { ...CHERE.corps, clientKey: 'q5' });
  assert.strictEqual(cinquieme.code, 409, JSON.stringify(cinquieme.corps));
  assert.strictEqual(cinquieme.corps.code, 'plafond');
  zeroGlobal(db, 'après le cinquième billet refusé');
  reconcilier(db, 'quatre tables maximales');
});

await test('LE LOBBY SATURÉ NE PROMET PAS UNE TABLE MOINS CHÈRE : il n\'en existe plus aucune', async () => {
  // L'ÉTAT QUE LE PLAFOND EST CALIBRÉ POUR PRODUIRE, pas un cas limite. `PLAFOND_TABLES_PAR_JOUR`
  // vaut quatre, donc quatre Resurgence à 10 $ gagnées au maximum passent toutes — la quatrième
  // tombant sur `156 000 > 156 000`, qui est faux, et la comparaison est stricte pour cette raison —
  // et laissent l'exposition réalisée à `PLAFOND_JOUEUR_CENTS` tout rond. Le pire cas est alors
  // strictement positif sur les vingt combinaisons mode × palier : plus AUCUNE table ne passe.
  //
  // Le message de la portée `joueur` promettait quand même « pick a smaller buy-in ». Le joueur
  // essayait les vingt tables, prenait vingt fois le même refus, épuisait son seau de débit et
  // finissait sur un 429 — qui n'est pas dans `REFUS_SAS` et le renvoie jouer hors ligne. C'est
  // exactement le tort que la décision 8 invoque pour séparer les deux portées, reproduit sur
  // l'autre portée.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR; i++)
    await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);

  // LA TABLE LA MOINS CHÈRE DU LOBBY, et son pire cas est le PLUS PETIT du domaine : si elle refuse,
  // aucune n'ouvre. Le chiffre est recalculé depuis `WBCore`, jamais écrit à la main.
  const pireCasMin = Math.min(...MODES_LEDGER.flatMap(
    ({ seats }) => MISES_LEDGER.map(mise => pireCasDe(mise, seats))));
  assert.strictEqual(pireCasMin, pireCasPetite(),
    'la plus petite table du lobby n\'est plus celle que ce test demande');

  const petite = await demander(app, { ...PETITE.corps, clientKey: 'saturee' });
  assert.strictEqual(petite.code, 409, JSON.stringify(petite.corps));
  assert.strictEqual(petite.corps.code, 'plafond');
  // LA PORTÉE NE MENT PAS : c'est bien le plafond PAR JOUEUR qui a refusé, et la réponse porte son
  // chiffre. La faire basculer à `maison` aurait déplacé le défaut au lieu de le fermer.
  assert.strictEqual(petite.corps.portee, 'joueur');
  assert.strictEqual(petite.corps.plafondCents, L.PLAFOND_JOUEUR_CENTS);
  assert.strictEqual(petite.corps.aucuneTableMoinsChere, true);
  // ET LE MESSAGE CESSE DE PROMETTRE CE QUI N'EXISTE PAS. C'est le pendant exact de l'assertion déjà
  // écrite pour le fusible global.
  assert.ok(!/smaller buy-in/.test(C.refusMessage('plafond', petite.corps)),
    'le sas promet une table moins chère alors que les vingt refusent');
  assert.match(C.refusMessage('plafond', petite.corps), /try again later/i);

  // LA BANDE D'EN DESSOUS TIENT TOUJOURS, sans quoi le drapeau serait allumé partout et la portée
  // `joueur` n'aurait plus de message à elle. Trois victoires maximales laissent 117 000 : la
  // Resurgence à 10 $ pèse 39 000 de plus et refuse, mais la petite table passe — donc le drapeau
  // est FAUX, et le message promet une table moins chère parce qu'il en existe une.
  const b = bancDeBillet({ limiter: () => true });
  await appel(b.app, { token: 'ok:u1:Loic' });
  const autre = b.db.users[0].id;
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR - 1; i++)
    await semerVictoireMaximale(b.db, autre, CHERE.miseCents, CHERE.seats, b.horloge.t);
  await semerVictoireMaximale(b.db, autre, PETITE.miseCents, PETITE.seats, b.horloge.t);
  const chere = await demander(b.app, { ...CHERE.corps, clientKey: 'bande-basse' });
  assert.strictEqual(chere.corps.code, 'plafond', JSON.stringify(chere.corps));
  assert.strictEqual(chere.corps.aucuneTableMoinsChere, false);
  assert.match(C.refusMessage('plafond', chere.corps), /smaller buy-in/);
  const ouvre = await demander(b.app, { ...PETITE.corps, clientKey: 'bande-basse-petite' });
  assert.strictEqual(ouvre.code, 200,
    'le drapeau dit faux mais aucune table n\'ouvre : le seuil est mal posé');

  zeroGlobal(db, 'après un lobby saturé');
  reconcilier(db, 'le lobby saturé');
});

await test('LA FENÊTRE GLISSE : un billet sorti des vingt-quatre heures ne compte plus, éprouvé sans attendre', async () => {
  // La fenêtre est GLISSANTE et pas une journée calendaire : une journée calendaire se réinitialise
  // à une heure connue de tous, et attendre minuit deviendrait une stratégie. Ce que ce test tient,
  // c'est la clause `cree_le >= $2` de la requête : sans elle, l'exposition d'un joueur ne
  // redescendrait JAMAIS, et le plafond deviendrait une interdiction à vie au bout de quatre tables.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR; i++)
    await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);

  const refus = await demander(app, { ...CHERE.corps, clientKey: 'dedans' });
  assert.strictEqual(refus.corps.code, 'plafond', JSON.stringify(refus.corps));

  // AU BORD EXACT : les écritures ont l'âge de la fenêtre à la milliseconde près, donc elles y sont
  // encore. `cree_le >= maintenant − fenêtre` est une inégalité LARGE, et c'est le bord qu'on tient.
  horloge.t += L.PLAFOND_FENETRE_H * 3600 * 1000;
  assert.strictEqual((await demander(app, { ...CHERE.corps, clientKey: 'bord' })).corps.code, 'plafond',
    'au bord exact, les écritures sont encore dans la fenêtre');

  // Une milliseconde plus tard, elles en sont sorties, et le même billet s'ouvre.
  horloge.t += 1;
  const ouvert = await demander(app, { ...CHERE.corps, clientKey: 'dehors' });
  assert.strictEqual(ouvert.code, 200, JSON.stringify(ouvert.corps));
  assert.strictEqual(ouvert.corps.stakeCents, CHERE.miseCents);
  // Et le grand livre n'a PAS bougé : ce n'est pas l'exposition qui a été effacée, c'est la fenêtre
  // qui a glissé. Le chiffre de toujours est toujours là.
  assert.strictEqual(L.expositionDe(livreDe(db), db.matches.map(m => String(m.id))),
    L.PLAFOND_TABLES_PAR_JOUR * pireCasChere(),
    'la fenêtre a effacé des écritures au lieu de glisser');
  zeroGlobal(db, 'après que la fenêtre a glissé');
});

await test('UN GAIN CONTRE-PASSÉ NE COMPTE PLUS DANS L\'EXPOSITION, et c\'est le piège de la phase', async () => {
  // `ledger_entries.reference` est du TEXTE, et une contre-passation y porte `gain:42`. Une jointure
  // par `reference::bigint` lèverait `22P02` sur ces lignes-là ; une jointure qui les FILTRE les
  // ignore, c'est-à-dire qu'un gain annulé continuerait de peser dans l'exposition et refuserait un
  // joueur pour de l'argent qu'il n'a jamais reçu. Le défaut naît VERT : le module qui écrit la
  // requête n'est pas celui qui crée les lignes qui la cassent.
  //
  // La contre-passation n'aura son appelant qu'au module suivant — c'est `api/operateur.js` — et ce
  // test est écrit ICI justement pour cela : la requête existe déjà, donc sa lacune existe déjà.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  const semees = [];
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR; i++)
    semees.push(await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t));
  assert.strictEqual((await demander(app, { ...CHERE.corps, clientKey: 'avant' })).corps.code, 'plafond');

  // ON CONTRE-PASSE LE DERNIER GAIN : le mouvement inverse, daté, qui laisse les deux visibles. Le
  // livre boucle toujours — un transfert boucle toujours — mais l'exposition doit redescendre d'un
  // pire cas exactement.
  const dernier = semees[semees.length - 1];
  const gain = L.mouvementGain({ userId: uid, matchId: dernier.id, miseCents: CHERE.miseCents,
    grossCents: dernier.p.grossCents, feeCents: dernier.p.feeCents, netCents: dernier.p.netCents,
    convergee: true });
  await db.ledgerWrite(L.mouvementContrepassation({ transferts: gain }));
  assert.ok(db.ledger.some(l => l.motif === 'contrepassation' && l.reference === `gain:${dernier.id}`),
    'la contre-passation doit bien porter la référence préfixée qui casse une jointure naïve');

  const apres = await demander(app, { ...CHERE.corps, clientKey: 'apres' });
  assert.strictEqual(apres.code, 200, JSON.stringify(apres.corps));
  // Le livre boucle toujours. La réconciliation, elle, a désormais un grief légitime — le séquestre
  // contre-passé est réhabité — et ce n'est pas ce test qui le juge : c'est le module 5, avec son
  // appelant. Ici on ne prouve QUE la lecture de l'exposition.
  zeroGlobal(db, 'après une contre-passation de gain');
});

await test('LE FUSIBLE GLOBAL refuse sur le cumul de TOUS LES JOUEURS, avec la portée maison', async () => {
  // Un plafond par joueur ne borne pas une FLOTTE DE COMPTES : `findOrCreate` crée un compte par
  // adresse email, et rien n'empêche cinquante adresses. Le fusible est la seule réponse de cette
  // phase, il vaut environ treize comptes saturés SUR UN LIVRE PAR AILLEURS À L'ÉQUILIBRE, et son
  // déclenchement refuse TOUT LE MONDE — y compris un joueur dont l'exposition personnelle est
  // NULLE, ce que ce test constate. Le « par ailleurs à l'équilibre » n'est pas une précaution de
  // style : le test suivant sème une population perdante et montre que le fusible ne saute plus.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;

  // La flotte : autant de comptes qu'il en faut pour faire sauter le fusible, un billet maximal
  // chacun. Le nombre est CALCULÉ, jamais écrit — un palier ou un mode qui change le fera bouger.
  // La borne est celle de la PLUS PETITE table, pas de la plus chère : quand le fusible saute, il
  // refuse tout le monde, y compris celui qui demandait la table à cinquante centimes, et c'est
  // exactement ce que ce test doit pouvoir montrer.
  let cumul = 0;
  let voisin = 1000;
  while (cumul + pireCasPetite() <= L.PLAFOND_MAISON_CENTS) {
    voisin += 1;
    await db.ledgerWrite(L.mouvementDotation({ userId: voisin, montantCents: CHERE.miseCents }));
    cumul += (await semerVictoireMaximale(db, voisin, CHERE.miseCents, CHERE.seats, horloge.t)).pireCas;
  }
  assert.ok(cumul > 0 && cumul + pireCasPetite() > L.PLAFOND_MAISON_CENTS);
  assert.ok(cumul + pireCasChere() > L.PLAFOND_MAISON_CENTS);

  const r = await demander(app, { ...CHERE.corps, clientKey: 'fusible' });
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'plafond', 'le code est le MÊME : le sas n\'a qu\'un comportement à tenir');
  assert.strictEqual(r.corps.portee, 'maison', 'la portée est ce qui distingue les deux, et elle seule');
  assert.strictEqual(r.corps.plafondCents, L.PLAFOND_MAISON_CENTS);
  assert.strictEqual(r.corps.expositionCents, cumul + pireCasChere());
  assert.strictEqual(r.corps.fenetreHeures, L.PLAFOND_FENETRE_H);
  // ET CE N'EST PAS LE PLAFOND PAR JOUEUR QUI A REFUSÉ : celui qui demande n'a JAMAIS joué.
  assert.strictEqual(L.expositionDe(livreDe(db), db.matches.filter(m => m.user_id === uid).map(m => String(m.id))), 0,
    'le demandeur a une exposition personnelle : le test ne prouve plus ce qu\'il annonce');
  assert.ok(pireCasChere() < L.PLAFOND_JOUEUR_CENTS, 'le plafond par joueur aurait refusé tout seul');
  // Le refus vient AVANT les tirages de graines et avant la transaction : ni ligne, ni écriture.
  assert.strictEqual(db.matches.filter(m => m.user_id === uid).length, 0);
  // Et il refuse aussi la table la moins chère : aucune table moins chère n'aide quand c'est la
  // maison qui ferme. C'est très exactement la raison pour laquelle le message lit la portée.
  const petite = await demander(app, { ...PETITE.corps, clientKey: 'petite-fusible' });
  assert.strictEqual(petite.corps.code, 'plafond');
  assert.strictEqual(petite.corps.portee, 'maison');
  assert.match(C.refusMessage('plafond', petite.corps), /try again/i);
  assert.ok(!/smaller buy-in/.test(C.refusMessage('plafond', petite.corps)));
});

// SEMER UNE DÉFAITE : la mise part au séquestre puis chez la maison, et l'exposition de la maison
// DESCEND d'autant. C'est le pendant de `semerVictoireMaximale`, et il existe pour une seule raison :
// le fusible lit une exposition NETTE, donc une population perdante lui fait de la place.
async function semerDefaite(db, userId, miseCents, at) {
  const id = 900001 + (semees++);
  const quand = new Date(at);
  db.matches.push({
    id, user_id: userId, mode: 'solo', stake_cents: miseCents, seats: C.seatsOf(C.MODES.solo),
    team_size: 1, paid_seats: 1, brawler: BRAWLER, seed_public: 1, seed_secret: SECRETS[0],
    sim_version: SIM.SIM_VERSION, client_key: `perdue-${id}`, status: 'settled',
    first_result_at: quand, opened_at: quand, expires_at: quand, settled_at: quand,
    issue: 'defaite', controle: null, motif: null,
    gross_cents: 0, fee_cents: 0, net_cents: 0,
    purse_cents: 0, declared_net_cents: null, ecart_cents: null,
    seconds: 1, kills: 0, deaths: 1, rank: 20, cubes: 0, damage: 0, cashed_out: false,
    trace_steps: 1, replay_digest: null, digest_match: true, divergence_step: null, replay_ms: 0,
  });
  await db.ledgerWrite(L.mouvementDotation({ userId, montantCents: miseCents }));
  await db.ledgerWrite(L.mouvementMise({ userId, matchId: id, miseCents }));
  await db.ledgerWrite(L.mouvementGain({ userId, matchId: id, miseCents, grossCents: 0,
                                         feeCents: 0, netCents: 0, convergee: true }));
  return id;
}

await test('LIMITE CONNUE : le fusible borne une CAISSE, pas un nombre de comptes — la marge du jour relève son seuil', async () => {
  // LE CHIFFRE QUI ÉTAIT ÉCRIT COMME UNE PROPRIÉTÉ, et qui n'en est pas une. « Le fusible vaut
  // environ treize comptes saturés » n'est vrai que sur un livre dont l'exposition nette par
  // ailleurs est NULLE — c'est-à-dire sur la doublure d'un test qui n'a jamais eu de population
  // perdante en face de l'attaquant. `db.expositionMaison` somme débits moins crédits, et l'espérance
  // par billet est négative pour le joueur : chaque perdant RAMÈNE de l'argent à la maison et lui
  // achète donc de la marge sous le fusible. Le seuil réel est
  // `PLAFOND_MAISON_CENTS + marge nette de la fenêtre`, et il croît avec le trafic.
  //
  // CE TEST EST UN CONSTAT, pas une exigence : on ne corrige ni le clamp ni la lecture nette. Le
  // clamp est protecteur et monotone dans le bon sens ; une lecture BRUTE ferait sauter le fusible
  // tous les jours dès quelques dizaines de milliers de billets, puisque les seuls gagnants légitimes
  // pèsent des millions. C'est la PHRASE qui était fausse, et elle est corrigée dans les cinq
  // documents qui la portaient. Ce qui reste ouvert — indexer une flotte sur autre chose qu'un stock
  // net — est renvoyé à la 04b, et ce test est là pour que le chiffre cesse d'être écrit comme un
  // fait.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });

  // LA MÊME FLOTTE QUE LE TEST PRÉCÉDENT, au billet près.
  let cumul = 0;
  let voisin = 1000;
  while (cumul + pireCasPetite() <= L.PLAFOND_MAISON_CENTS) {
    voisin += 1;
    await db.ledgerWrite(L.mouvementDotation({ userId: voisin, montantCents: CHERE.miseCents }));
    cumul += (await semerVictoireMaximale(db, voisin, CHERE.miseCents, CHERE.seats, horloge.t)).pireCas;
  }
  assert.ok(cumul > L.PLAFOND_MAISON_CENTS - pireCasPetite(),
    'la flotte ne suffit plus à approcher le fusible : le test ne prouve plus rien');

  // ET UNE POPULATION PERDANTE, semée sur la même fenêtre. Une défaite à $0,50 rend 50 centimes à la
  // maison : il en faut donc beaucoup, et c'est exactement le point — un site qui tourne en produit
  // des centaines de milliers par jour sans y penser.
  const marge = cumul + pireCasChere() - L.PLAFOND_MAISON_CENTS;
  assert.ok(marge > 0, 'le fusible ne saute même pas sans population perdante');
  const perdants = Math.ceil(marge / 50) + 20;
  for (let i = 0; i < perdants; i++) await semerDefaite(db, 5000 + i, 50, horloge.t);

  // LE FUSIBLE NE SAUTE PLUS, pour exactement la même flotte. Le seuil n'est pas une propriété du
  // système, c'est « deux millions PLUS le profit du jour ».
  const r = await demander(app, { ...CHERE.corps, clientKey: 'flotte-amortie' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.corps));
  // Et on le dit en chiffres plutôt qu'en mots : l'exposition NETTE du livre est retombée sous le
  // fusible, alors que les gains de la flotte, eux, n'ont pas bougé d'un centime.
  const nette = L.expositionDe(livreDe(db), db.matches.map(m => String(m.id)));
  assert.ok(nette + pireCasChere() <= L.PLAFOND_MAISON_CENTS,
    `l'exposition nette vaut ${nette} : le test ne montre plus ce qu'il annonce`);
  assert.ok(nette < cumul, 'la population perdante n\'a pas amorti l\'exposition de la flotte');
  zeroGlobal(db, 'après une flotte amortie par une population perdante');
});

await test('LIMITE CONNUE : le fusible ne voit QUE des écritures réglées — les billets en vol lui sont invisibles', async () => {
  // CE QUE LA CADENCE BORNE, ET CE QU'ELLE NE BORNE PAS. Il était écrit en quatre endroits que le
  // retard du fusible « vaut au plus ce qu'une minute d'ouvertures peut engager ». C'est faux d'un
  // ordre de grandeur, et c'est cette phrase-là qu'on relirait le jour où le fusible aurait laissé
  // passer la casse : les seules jambes de maison viennent du motif `gain`, écrit au RÈGLEMENT, donc
  // un billet OUVERT pèse exactement ZÉRO dans le fusible pendant toute sa vie —
  // `LOBBY.wait + zoneTotalS + MATCH_MARGE_S`, plusieurs minutes. Le verdict n'ajoute qu'UN pire cas,
  // celui du billet qu'on ouvre, et `matches_un_seul_ouvert` est un index PARTIEL sur `user_id` : il
  // borne le nombre de billets ouverts PAR JOUEUR, jamais tous joueurs confondus.
  //
  // Le cache n'y est pour rien, et c'est important : on le désarme en donnant à chaque ouverture sa
  // propre lecture du livre, et la flotte passe quand même. L'erreur ne vient pas de l'amortissement,
  // elle vient de ce que le livre ne porte pas encore ces billets-là.
  // LE NOMBRE DE BILLETS EN VOL EST CALCULÉ, jamais écrit : il vaut ce qu'il faut pour que le livre
  // dépasse le fusible une fois tout réglé, et il se re-décide si un palier, un mode ou une constante
  // change. Les deux sources de hasard sont élargies pour l'occasion — celles du banc sont des listes
  // finies, taillées pour des scénarios à quelques billets.
  const FLOTTE = Math.floor(L.PLAFOND_MAISON_CENTS / pireCasChere()) + 1;
  let graine = 0;
  const { db, app, horloge } = bancDeBillet({
    limiter: () => true,
    randomSeed: () => ((++graine) * 7919) >>> 0,
    randomSecret: () => String(graine).padStart(4, '0') + 'c'.repeat(28),
  });
  let lectures = 0;
  const brute = db.expositionMaison;
  db.expositionMaison = async a => { lectures++; return brute(a); };

  const ouverts = [];
  for (let i = 0; i < FLOTTE; i++) {
    const jeton = `ok:u${i + 1}:Flotte${i}`;
    await appel(app, { token: jeton });
    // L'horloge avance d'une cadence entière entre deux ouvertures : le cache est donc relu à chaque
    // fois, et il rend ZÉRO à chaque fois, parce qu'aucun de ces billets n'a encore été réglé.
    horloge.t += L.FUSIBLE_RAFRAICHI_S * 1000;
    const r = await demander(app, { ...CHERE.corps, clientKey: `vol-${i}` }, { token: jeton });
    assert.strictEqual(r.code, 200, `billet ${i} refusé : ${JSON.stringify(r.corps)}`);
    ouverts.push({ id: r.corps.id, userId: db.users[i].id });
  }
  assert.strictEqual(lectures, FLOTTE, 'le cache n\'a pas été relu à chaque ouverture : le test mesure autre chose');
  // LE FUSIBLE EST À ZÉRO alors que trente pires cas sont en vol. C'est la limite, en une ligne.
  assert.strictEqual(await db.expositionMaison({ depuis: new Date(horloge.t - L.PLAFOND_FENETRE_H * 3600 * 1000) }), 0,
    'un billet ouvert pèse dans le fusible : la limite est fermée, ce test doit être réécrit');

  // ET ILS RÈGLENT TOUS, EN VICTOIRE MAXIMALE. Le livre porte alors d'un coup ce que le fusible
  // n'avait jamais vu venir, et il dépasse `PLAFOND_MAISON_CENTS` sans qu'un seul refus ait été
  // prononcé.
  const p = C.cashoutCents(C.purseBound(CHERE.miseCents, CHERE.seats).maxCents);
  for (const { id, userId } of ouverts) {
    db.matches.find(m => String(m.id) === String(id)).status = 'settled';
    await db.ledgerWrite(L.mouvementGain({ userId, matchId: id, miseCents: CHERE.miseCents,
      grossCents: p.grossCents, feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  }
  const apres = await db.expositionMaison({ depuis: new Date(horloge.t - L.PLAFOND_FENETRE_H * 3600 * 1000) });
  assert.strictEqual(apres, FLOTTE * pireCasChere());
  assert.ok(apres > L.PLAFOND_MAISON_CENTS,
    `le livre porte ${apres}, sous le fusible : la flotte du test est trop petite pour montrer la limite`);
  // LA BORNE VRAIE EST DONC « le pire cas cumulé de TOUS les billets en vol », et un billet vit
  // plusieurs minutes — pas « une minute d'ouvertures ». Ce test est un constat : la refermer
  // demanderait de faire entrer les lignes `open` dans la lecture amortie, ce que la spécification
  // renvoie aux phases suivantes avec son chiffrage.
  zeroGlobal(db, 'après une flotte réglée d\'un coup');
});

await test('LE FUSIBLE NE SE RELIT QU\'À SA CADENCE, et il ne tourne PAS sous le verrou', async () => {
  // Le plafond par joueur est exact ; le fusible est APPROCHÉ, et c'est le bon marché. Le lire sous
  // le verrou ferait de chaque ouverture de billet un agrégat non borné sur la table qui grossit le
  // plus vite du dépôt — et le dépôt a déjà payé ce genre de chose une fois : `GET /api/me` mettait
  // en file le renoncement d'un AUTRE joueur au-delà de sa fenêtre de dix secondes.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  let lectures = 0;
  const brute = db.expositionMaison;
  db.expositionMaison = async a => { lectures++; return brute(a); };

  assert.strictEqual((await demander(app, { ...PETITE.corps, clientKey: 'u1' })).code, 200);
  assert.strictEqual(lectures, 1, 'la première ouverture doit lire le fusible');
  // DEUX OUVERTURES DANS LA MÊME MINUTE, UNE SEULE LECTURE. La valeur est gardée en mémoire du
  // processus entre les deux — un état de plus qui vit là, comme la limitation de débit, perdu au
  // redémarrage et non partagé entre instances.
  horloge.t += (L.FUSIBLE_RAFRAICHI_S - 1) * 1000;
  assert.strictEqual((await demander(app, { ...PETITE.corps, clientKey: 'u2' })).code, 200);
  assert.strictEqual(lectures, 1, 'le fusible a été relu deux fois dans la même minute');

  // Passé la cadence, il se relit. L'horloge est celle qui est injectée, donc rien n'attend.
  horloge.t += 1000;
  assert.strictEqual((await demander(app, { ...PETITE.corps, clientKey: 'u3' })).code, 200);
  assert.strictEqual(lectures, 2, 'le fusible ne s\'est jamais rafraîchi');

  // ET CHAQUE `createApp` A SON PROPRE FUSIBLE : la valeur est une fermeture, pas un module. Deux
  // instances du routeur dans le même processus ne se partagent rien, et un test n'hérite pas de la
  // lecture d'un autre.
  const autre = bancDeBillet({ limiter: () => true });
  let autresLectures = 0;
  const brute2 = autre.db.expositionMaison;
  autre.db.expositionMaison = async a => { autresLectures++; return brute2(a); };
  await demander(autre.app, { ...PETITE.corps, clientKey: 'v1' });
  assert.strictEqual(autresLectures, 1);
});

await test('UNE HORLOGE QUI RECULE NE FIGE PAS LE FUSIBLE : la cadence se lit dans les DEUX sens', async () => {
  // `now` vaut `Date.now` par défaut : une horloge MURALE, pas un chronomètre. Le dépôt a déjà fait
  // ce raisonnement une fois — `RENONCE_MARGE_ECRAN_MS` lit `performance.now()` exprès, parce qu'un
  // `setInterval` retarde dans le sens qui fait promettre un remboursement refusé. Ici c'est un pas
  // NTP qui joue contre nous : avec la seule borne haute, `t - luA` devenait négatif, donc toujours
  // inférieur à la cadence, et le cache se figeait pour toute la durée du recul. La maison ouvrait
  // des tables au-delà de son fusible pendant une heure, alors que le retard promis est de soixante
  // secondes. Le test de cadence voisin n'avançait que l'horloge : il serait resté vert pour
  // toujours.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  let lectures = 0;
  const brute = db.expositionMaison;
  db.expositionMaison = async a => { lectures++; return brute(a); };

  // Première ouverture : le fusible est lu, l'exposition de la maison est nulle, la table s'ouvre.
  assert.strictEqual((await demander(app, { ...PETITE.corps, clientKey: 'avant' })).code, 200);
  assert.strictEqual(lectures, 1, 'la première ouverture doit lire le fusible');

  // On sème l'exposition de la maison AU-DELÀ du fusible, sur d'autres comptes que le demandeur :
  // c'est bien l'interrupteur global qu'on éprouve, pas le plafond par joueur.
  let cumul = 0;
  let voisin = 2000;
  while (cumul + pireCasPetite() <= L.PLAFOND_MAISON_CENTS) {
    voisin += 1;
    await db.ledgerWrite(L.mouvementDotation({ userId: voisin, montantCents: CHERE.miseCents }));
    cumul += (await semerVictoireMaximale(db, voisin, CHERE.miseCents, CHERE.seats, horloge.t)).pireCas;
  }

  // ET L'HORLOGE RECULE D'UNE HEURE. Sans la borne basse, `age` vaut environ −3 600 000, ce qui est
  // bien inférieur à la cadence : le cache serait rendu tel quel, `expositionMaison` ne serait pas
  // relue, et la table s'ouvrirait en 200 alors que le fusible a sauté.
  horloge.t -= 3600 * 1000;
  const r = await demander(app, { ...PETITE.corps, clientKey: 'apres-recul' });
  assert.strictEqual(r.code, 409, JSON.stringify(r.corps));
  assert.strictEqual(r.corps.code, 'plafond');
  assert.strictEqual(r.corps.portee, 'maison');
  assert.strictEqual(lectures, 2, 'le fusible est resté figé sur une horloge qui recule');
});

await test('UN BILLET DÉJÀ OUVERT N\'EST JAMAIS CASSÉ RÉTROACTIVEMENT : le plafond franchi pendant qu\'il vit ne change rien', async () => {
  // Le corollaire écrit de « le plafond se décide à l'OUVERTURE » : refuser plus tard serait voler
  // une partie gagnée, et c'est irréparable. On ouvre, on franchit le plafond PENDANT que le billet
  // vit, et on le règle — la partie est rejouée et payée comme si de rien n'était.
  const { db, app, horloge } = bancDeBillet({ limiter: () => true });
  await appel(app, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  const b = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(b.code, 200);

  // Le plafond est franchi pendant que le billet vit. On le vérifie plutôt que de le supposer : une
  // NOUVELLE demande serait refusée à cet instant précis.
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR; i++)
    await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);

  // Le chemin `repris` rend TOUJOURS le billet : le joueur dont la réponse s'est perdue le retrouve,
  // plafond ou pas. Le lui refuser l'enfermerait dedans jusqu'à l'expiration, mise débitée.
  const repris = await demander(app, { ...DEMANDE, mode: 'resurgence' });
  assert.strictEqual(repris.code, 200, JSON.stringify(repris.corps));
  assert.strictEqual(repris.corps.repris, true);
  assert.strictEqual(repris.corps.id, b.corps.id);

  // ET IL SE RÈGLE. Le montant sort de la partie rejouée, comme toujours.
  const { rep } = await jouerEtRendre(app, horloge, b, { encaisser: 300 });
  assert.notStrictEqual(rep.code, 500);
  assert.strictEqual(rep.code, 200, JSON.stringify(rep.corps));
  assert.strictEqual(rep.corps.status, 'settled', JSON.stringify(rep.corps));
  assert.notStrictEqual(rep.corps.code, 'plafond');
  assert.ok(rep.corps.netCents > 0, 'la partie gagnée n\'a rien payé');
  assert.strictEqual(soldeEnjeu(db, b.corps.id), 0);
  zeroGlobal(db, 'après un règlement au-delà du plafond');
  reconcilier(db, 'le billet ouvert avant le plafond');
});

console.log('Le grand livre : le schéma, les gardes textuelles, et la vraie Postgres');
// Tout ce qui suit lit du TEXTE. Il faut le dire une fois de plus, parce que c'est la limite exacte
// de ce module : aucune base ne tourne ici, et un test qui passe contre la doublure prouve la
// doublure. Ce que ces gardes attrapent, c'est la DÉRIVE entre deux écritures de la même règle —
// l'expression des comptes, la liste des motifs, une colonne dont le pilote parle et que le schéma
// n'a plus. C'est `api/db-check.js` qui éprouve la base, et il ne tourne pas ici.
const lireApi = f => require('node:fs').readFileSync(require('node:path').join(__dirname, f), 'utf8');
// Le schéma sans ses commentaires, et le bloc du grand livre à l'intérieur : les commentaires
// citent justement les expressions qu'on vérifie, et un commentaire est toujours d'accord avec ce
// qu'on veut lui faire dire. C'est arrivé deux fois en écrivant les gardes des modules précédents.
const SQL_NU = () => lireApi('schema.sql').replace(/--[^\n]*/g, '');
const BLOC_LEDGER = () => {
  const sql = SQL_NU(), i = sql.indexOf('create table if not exists ledger_entries');
  assert.ok(i > 0, 'la table du grand livre a disparu de schema.sql');
  return sql.slice(i);
};
const PG_NU = () => lireApi('db-pg.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');

const COLONNES_LEDGER = ['id', 'motif', 'reference', 'compte_debit', 'compte_credit',
                         'montant_cents', 'cree_le'];

test('toute colonne du grand livre dont db-pg.js parle existe dans schema.sql', () => {
  // L'extension de la garde qui existe déjà pour `matches` et `match_traces`, resserrée d'un cran :
  // ici on n'exige pas seulement que le mot figure quelque part dans le schéma, mais qu'il soit
  // déclaré DANS LA TABLE DU GRAND LIVRE. Une colonne d'une autre table porterait le même nom sans
  // rien prouver — `motif` existe déjà sur `matches`, et il n'y a aucun rapport entre les deux.
  const bloc = BLOC_LEDGER();
  for (const col of COLONNES_LEDGER)
    assert.match(bloc, new RegExp(`^\\s*${col}\\s`, 'm'), `la colonne ${col} manque à ledger_entries`);
  const pg = PG_NU();
  const listes = (pg.match(/^const LEDGER_\w+ =[^;]*;/gm) || []).join(' ').replace(/'/g, ' ');
  // LA PURGE EST LA SEULE REQUÊTE QUI FRANCHIT DEUX TABLES, et elle est écartée d'ici NOMMÉMENT
  // plutôt que silencieusement : elle lit `matches` et `ledger_entries` pour effacer dans
  // `match_traces`, donc elle porte forcément des mots qui ne sont pas des colonnes du grand livre.
  // Ce qu'elle promet, c'est le test « le seul delete est la purge nommée » qui le vérifie, clause
  // par clause. On compte quand même les requêtes croisées : une SECONDE ne doit pas se faufiler
  // ici sans que personne ne s'en aperçoive.
  //
  // ET LA REQUÊTE DE FENÊTRE DU PLAFOND EST LA SECONDE, écartée d'ici de la même façon : elle joint
  // `ledger_entries` à `matches` pour ramener chaque écriture à son billet, donc elle porte
  // forcément des mots qui ne sont pas des colonnes du grand livre. Ce qu'elle promet est tenu par
  // sa propre garde, plus bas — l'expression de la référence y est INTERPOLÉE depuis `api/ledger.js`
  // et jamais réécrite. On compte les deux : une TROISIÈME requête croisée ne doit pas se faufiler
  // ici sans que personne ne s'en aperçoive.
  const toutes = (pg.match(/`[^`]*`/g) || []).filter(q => /ledger_entries/.test(q));
  const croisees = toutes.filter(q => /match_traces/.test(q) || /\bmatches\b/.test(q));
  assert.strictEqual(croisees.length, 2,
    `${croisees.length} requêtes croisent le grand livre et une autre table : la purge, et la fenêtre du plafond`);
  assert.strictEqual(croisees.filter(q => /match_traces/.test(q)).length, 1, 'la purge des traces');
  assert.strictEqual(croisees.filter(q => /m\.id::text/.test(q)).length, 1, 'la fenêtre du plafond');
  const requetes = toutes.filter(q => !croisees.includes(q));
  assert.ok(requetes.length >= 3, `seulement ${requetes.length} requêtes du grand livre dans db-pg.js`);
  const MOTS_SQL = new Set(['const', 'select', 'from', 'where', 'and', 'or', 'is', 'not', 'null',
    'insert', 'into', 'values', 'returning', 'order', 'by', 'sum', 'coalesce', 'filter', 'as',
    // `any` et `text` : le fusible global reçoit les comptes et les motifs en TABLEAUX, depuis
    // `L.COMPTES_EXPOSITION` et `L.MOTIFS_EXPOSITION`. Des littéraux recopiés dans le SQL auraient
    // été une seconde écriture de « quels comptes comptent », et c'est le patron qu'on refuse.
    'any', 'text',
    'ledger_entries']);
  const texte = (listes + ' ' + requetes.join(' '))
    .replace(/\$\{[^}]*\}/g, ' ').replace(/'[^']*'/g, ' ').replace(/\bas\s+\w+/g, ' ');
  const vus = new Set(texte.match(/\b[a-z_][a-z0-9_]*\b/g) || []);
  assert.ok(vus.size > 8, `seulement ${vus.size} identifiants retrouvés dans les requêtes du livre`);
  for (const mot of vus)
    if (!MOTS_SQL.has(mot))
      assert.ok(COLONNES_LEDGER.includes(mot),
        `db-pg.js parle de « ${mot} » sur ledger_entries, qui n'est pas une colonne de cette table`);
});

test('ledger_entries est en INSERTION SEULE : aucun update, aucun delete, nulle part', () => {
  // Une écriture modifiée est une PREUVE DÉTRUITE : on ne peut plus dire ce qui a été payé ni
  // quand. Le seul chemin de correction est la contre-passation, c'est-à-dire une insertion de plus.
  // Même garde que celle de `match_traces`, et pour une raison plus chère.
  // La doctrine se lit dans les COMMENTAIRES du schéma, donc sur le texte brut : ailleurs, elle
  // serait une intention que rien ne rappelle à celui qui ajoutera la prochaine requête.
  const commente = lireApi('schema.sql');
  const entete = commente.slice(commente.lastIndexOf('Phase 03'),
                                commente.indexOf('create table if not exists ledger_entries'));
  assert.match(entete, /INSERTION SEULE/, 'la doctrine a disparu de l\'en-tête de la table');
  assert.match(entete, /contre-passation/i, 'le seul chemin de correction n\'est plus nommé');
  assert.ok(/aucun `update`/i.test(entete) && /aucun `delete`/i.test(entete), entete);
  for (const q of (PG_NU().match(/`[^`]*`/g) || [])) {
    if (!/ledger_entries/.test(q)) continue;
    assert.ok(!/\bupdate\s+ledger_entries\b/i.test(q), 'un update vise ledger_entries : ' + q);
    assert.ok(!/\bdelete\s+from\s+ledger_entries\b/i.test(q), 'un delete vise ledger_entries : ' + q);
  }
  // Et l'insertion N'AVALE PAS le doublon : pas de `on conflict do nothing` ici. Sur `match_traces`
  // c'était le bon comportement — premier écrit gagne, segment identique. Sur le grand livre, un
  // doublon veut dire qu'on paie deux fois, et l'appelant doit l'apprendre.
  const inserts = (PG_NU().match(/`[^`]*`/g) || []).filter(q => /insert into ledger_entries/i.test(q));
  assert.strictEqual(inserts.length, 1, 'une seule insertion dans le grand livre');
  assert.ok(!/on conflict/i.test(inserts[0]),
    'l\'écriture du grand livre avale un doublon au lieu de le refuser : ' + inserts[0]);
  // LE PIÈGE DU PILOTE, GARDÉ SUR LE TEXTE parce que `db-pg.js` n'est JAMAIS exécuté par les tests :
  // `sum()` rend un `bigint`, donc une CHAÎNE. Un solde parti en texte ferait comparer « 9 » et
  // « 10 » caractère par caractère, et le refus de découvert laisserait passer exactement ce qu'il
  // existe pour arrêter. `api/db-check.js` l'éprouve pour de bon, contre une vraie base.
  const pg = PG_NU();
  const lecteur = pg.slice(pg.indexOf('async function ledgerSolde'), pg.indexOf('async function ledgerDe'));
  assert.ok(lecteur.length > 100, 'le lecteur de solde n\'a pas été retrouvé');
  assert.match(lecteur, /return\s+Number\(/, 'le solde repart en chaîne : sum() rend un bigint');
  // LA SOMME EST ÉCRITE UNE SEULE FOIS, ET LE LECTEUR L'INTERPOLE. Elle sert aussi à la troisième
  // condition de la purge des traces — « le séquestre est à zéro » — et deux écritures de « un solde
  // est cette somme-là » finiraient par différer, celle qui différerait étant justement celle qui
  // autorise un EFFACEMENT. On garde donc les deux moitiés : le lecteur passe par l'expression
  // partagée, et l'expression partagée est bien une somme.
  assert.match(lecteur, /soldeExpr\(/, 'le lecteur de solde n\'utilise plus l\'expression partagée');
  const expression = pg.slice(pg.indexOf('function soldeExpr('), pg.indexOf('async function ledgerWrite'));
  assert.ok(expression.length > 100, 'l\'expression partagée du solde n\'a pas été retrouvée');
  assert.match(expression, /\bsum\s*\(/, 'le solde doit rester une SOMME, jamais une colonne');
  assert.match(expression, /compte_credit/, expression);
  assert.match(expression, /compte_debit/, expression);
  assert.strictEqual((pg.match(/\bsoldeExpr\s*\(/g) || []).length, 3,
    'l\'expression du solde doit être définie une fois et appelée deux : le lecteur, et la purge');
  // La DOUBLURE n'expose aucun chemin de modification non plus : trois méthodes, une seule écrit.
  const db = fakeDb();
  assert.deepStrictEqual(Object.keys(db).filter(k => typeof db[k] === 'function' && /^ledger/.test(k)).sort(),
    ['ledgerDe', 'ledgerSolde', 'ledgerWrite']);
  // `db.ledger` est la table elle-même, exposée comme `db.matches` et `db.traces` pour être
  // OBSERVÉE par les tests. Les lignes y sont gelées : même par ce chemin-là, rien ne se modifie.
  assert.ok(Array.isArray(db.ledger) && db.ledger.length === 0);
});

await test('la doublure du grand livre REFUSE ce que la colonne refuserait, et un mouvement s\'écrit en entier ou pas du tout', async () => {
  const db = fakeDb();
  // Le joueur est doté d'abord : depuis que le découvert est une règle uniforme, un compte de
  // joueur vide ne peut plus rien miser, et c'est exactement ce qu'on veut.
  await db.ledgerWrite(L.mouvementDotation({ userId: 1, montantCents: L.DOTATION_CENTS }));
  const mise = L.mouvementMise({ userId: 1, matchId: 1, miseCents: 50 });
  await db.ledgerWrite(mise);
  assert.strictEqual(db.ledger.length, 2);
  // La ligne posée porte les colonnes du schéma, et rien d'autre — pas un champ interne de la
  // doublure qu'un module suivant prendrait pour une colonne.
  assert.deepStrictEqual(Object.keys(db.ledger[0]).sort(),
    ['compte_credit', 'compte_debit', 'cree_le', 'id', 'montant_cents', 'motif', 'reference']);
  // Et elle est GELÉE : la règle « aucun update, aucun delete » commence par l'objet en mémoire.
  assert.ok(Object.isFrozen(db.ledger[0]));
  assert.throws(() => { db.ledger[0].montant_cents = 1; }, TypeError);
  // La clé (motif, reference, compte_debit, compte_credit) REFUSE la seconde, elle ne l'avale pas.
  await assert.rejects(() => db.ledgerWrite(mise),
    e => e.code === '23505' && e.constraint === 'ledger_entries_mouvement_uniq');
  assert.strictEqual(db.ledger.length, 2, 'une écriture refusée ne doit rien laisser derrière');
  // La largeur de la colonne : le `22003` déjà payé une fois.
  await assert.rejects(() => db.ledgerWrite([{ motif: 'dotation', reference: 'x',
    compteDebit: L.MAISON_DOTATION, compteCredit: L.compteJoueur(1), montantCents: 3_000_000_000 }]),
    e => e.code === '22003');
  // Et les contraintes de fond, chacune nommée comme la base la nomme.
  const mauvais = [
    [{ motif: 'depot', reference: 'x', compteDebit: L.MAISON_DOTATION, compteCredit: L.compteJoueur(1), montantCents: 1 }, 'ledger_entries_motif_check'],
    [{ motif: 'mise', reference: 'x', compteDebit: 'maison:tresorerie', compteCredit: L.compteJoueur(1), montantCents: 1 }, 'ledger_compte_debit_grammaire'],
    [{ motif: 'mise', reference: 'x', compteDebit: L.compteJoueur(1), compteCredit: 'joueur:007:disponible', montantCents: 1 }, 'ledger_compte_credit_grammaire'],
    [{ motif: 'mise', reference: 'x', compteDebit: L.compteJoueur(1), compteCredit: L.compteJoueur(1), montantCents: 1 }, 'ledger_comptes_distincts'],
    [{ motif: 'mise', reference: 'x', compteDebit: L.MAISON_DOTATION, compteCredit: L.compteJoueur(1), montantCents: 0 }, 'ledger_entries_montant_cents_check'],
  ];
  for (const [ligne, contrainte] of mauvais)
    await assert.rejects(() => db.ledgerWrite([ligne]),
      e => e.code === '23514' && e.constraint === contrainte, contrainte);
  // UN MOUVEMENT S'ÉCRIT EN ENTIER OU PAS DU TOUT. La vraie écriture est dans une transaction ; une
  // doublure qui laisserait deux jambes sur trois raconterait une histoire que la base ne peut pas
  // produire, et le test d'atomicité passerait sur une doublure complaisante.
  const p = C.cashoutCents(400);
  const gain = L.mouvementGain({ userId: 1, matchId: 1, miseCents: 50, grossCents: p.grossCents,
                                 feeCents: p.feeCents, netCents: p.netCents, convergee: true });
  assert.ok(gain.length >= 3);
  const boiteux = gain.slice(0, -1).concat([{ ...gain[gain.length - 1], montantCents: -1 }]);
  await assert.rejects(() => db.ledgerWrite(boiteux), e => e.code === '23514');
  assert.strictEqual(db.ledger.length, 2, 'un mouvement refusé a laissé des jambes derrière lui');
  // Et le solde est un NOMBRE, jamais la chaîne que `sum()` rend — la conversion vit dans le vrai
  // pilote, donc la doublure rend ce qu'il rend une fois converti.
  const solde = await db.ledgerSolde(L.compteEnjeu(1));
  assert.strictEqual(typeof solde, 'number');
  assert.strictEqual(solde, 50);
  assert.strictEqual(await db.ledgerSolde(L.compteJoueur(1)), L.DOTATION_CENTS - 50);
  assert.strictEqual((await db.ledgerDe({ reference: '1' })).length, 2,
    'la dotation et la mise portent toutes deux la référence « 1 » : le joueur et la partie');
});

test('les montants du grand livre sont integer et STRICTEMENT positifs', () => {
  const bloc = BLOC_LEDGER();
  const decl = (bloc.match(/^[ \t]*montant_cents\b.*$/m) || [])[0];
  assert.ok(decl, 'la colonne des montants a disparu');
  assert.match(decl, /\binteger\b/, decl);
  // Strictement positif, et pas « positif ou nul » : une jambe de montant nul n'est pas
  // représentable, et c'est ce qui oblige `api/ledger.js` à l'omettre plutôt qu'à la poser.
  assert.match(decl, /check\s*\(\s*montant_cents\s*>\s*0\s*\)/, decl);
  assert.ok(!/>=\s*0/.test(decl), 'un montant nul redeviendrait représentable : ' + decl);
  // Et la partie double est STRUCTURELLE : deux comptes distincts sur la même ligne.
  assert.match(bloc, /check\s*\(compte_debit\s*<>\s*compte_credit\)/,
    'sans cette contrainte, une ligne peut ne rien déplacer et compter quand même');
});

test('le motif est contraint EXACTEMENT à la liste de api/ledger.js, comparée au TEXTE du schéma', () => {
  // Une liste qui diverge du code est le patron du `respawn()` défini deux fois. Ici la divergence
  // se paierait au premier motif refusé par la base sur un chemin d'argent, en 500.
  const m = BLOC_LEDGER().match(/check\s*\(\s*motif in \(([^)]*)\)\s*\)/);
  assert.ok(m, 'la contrainte des motifs a disparu de ledger_entries');
  const dans = (m[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));
  assert.deepStrictEqual(dans, L.MOTIFS.slice(),
    'la liste du schéma et celle d\'api/ledger.js ont divergé');
  assert.strictEqual(dans.length, 6, 'six motifs, pas sept : le septième est une affaire de phase 06');
});

test('l\'expression des comptes du schéma est IDENTIQUE, caractère pour caractère, à COMPTE_RE_SQL', () => {
  // Ce n'est PAS une énumération, et c'est justement pour cela que la comparaison peut être exacte :
  // trois des six comptes sont des familles paramétrées, et un `check (compte in (...))` aurait été
  // refusé au premier joueur inscrit. Le test compare une grammaire à une grammaire.
  const bloc = BLOC_LEDGER();
  const expressions = [];
  for (const colonne of ['compte_debit', 'compte_credit']) {
    const m = bloc.match(new RegExp(`check\\s*\\(${colonne}\\s*~\\s*'([^']*)'\\)`));
    assert.ok(m, `la contrainte de grammaire de ${colonne} a disparu`);
    assert.strictEqual(m[1], L.COMPTE_RE_SQL,
      `${colonne} : le schéma et api/ledger.js ne portent pas la MÊME expression`);
    expressions.push(m[1]);
  }
  assert.strictEqual(expressions.length, 2, 'les deux comptes doivent porter la contrainte');
  // Et la grammaire n'a pas été « simplifiée » en liste fermée par quelqu'un de bien intentionné.
  assert.ok(!/compte_(debit|credit)\s+in\s*\(/i.test(bloc),
    'un `check (compte in (...))` est apparu : il serait refusé au premier joueur inscrit');
  // `[1-9][0-9]*` et pas `[0-9]+` : les zéros de tête feraient de `joueur:007:disponible` et
  // `joueur:7:disponible` deux comptes pour un seul joueur.
  assert.ok(L.COMPTE_RE_SQL.includes('[1-9][0-9]*'), L.COMPTE_RE_SQL);
});

test('la clé du grand livre, et les deux index qui remplacent la case', () => {
  const bloc = BLOC_LEDGER();
  assert.match(bloc, /create unique index[^\n]*\n?[^\n]*on ledger_entries \(motif, reference, compte_debit, compte_credit\)/,
    'la clé d\'idempotence du grand livre a disparu ou a changé de colonnes');
  // Elle identifie UNE jambe, et c'est `api/ledger.js` qui le rend vrai : les paires de comptes d'un
  // même mouvement sont distinctes deux à deux. On le reconstate ici sur le mouvement le plus
  // fourni, celui qui a quatre jambes.
  const p = C.cashoutCents(5000);
  const gain = L.mouvementGain({ userId: 1, matchId: 1, miseCents: 100, grossCents: p.grossCents,
                                 feeCents: p.feeCents, netCents: p.netCents, convergee: true });
  const cles = new Set(gain.map(t => [t.motif, t.reference, t.compteDebit, t.compteCredit].join(' ')));
  assert.strictEqual(cles.size, gain.length, 'deux jambes du même mouvement partagent la clé');
  // Le solde est une SOMME sur ces lignes, jamais une colonne : les deux index de lecture sont ce
  // qui rend cette somme tenable, et l'échappatoire nommée reste l'instantané, jamais une case.
  //
  // ILS PORTENT DEUX COLONNES DEPUIS LA PHASE 04a, et le renommage est le sujet du test : le
  // plafond lit l'exposition d'une FENÊTRE GLISSANTE à chaque ouverture de billet, donc sa clause
  // porte un compte ET une date. Sur un index qui ne connaît que le compte, Postgres remonte toutes
  // les écritures de `maison:contrepartie` depuis le premier jour pour n'en garder qu'une journée.
  assert.match(bloc, /create index[^\n]*on ledger_entries \(compte_debit, cree_le\)/);
  assert.match(bloc, /create index[^\n]*on ledger_entries \(compte_credit, cree_le\)/);
  // ET LES ANCIENS SONT EXPLICITEMENT DÉPOSÉS. `create index if not exists` sous un NOUVEAU nom
  // laisserait les deux anciens en place : deux index morts qui ralentissent chaque insertion du
  // livre sans servir une seule lecture. Aucune base de production n'existe, donc ce `drop` coûte
  // zéro aujourd'hui et une fenêtre de maintenance après le premier euro.
  for (const vieux of ['ledger_entries_debit_idx', 'ledger_entries_credit_idx']) {
    assert.match(bloc, new RegExp(`drop index if exists ${vieux}`), `${vieux} n'est pas déposé`);
    assert.ok(!new RegExp(`create index[^\\n]*${vieux}\\b`).test(bloc), `${vieux} est recréé`);
  }
  // ET UN TROISIÈME INDEX, CELUI PAR BILLET, qui est le seul à rendre VRAIE la phrase « l'agrégat du
  // plafond par joueur est borné par les billets d'un seul joueur ». Sans lui, la requête de fenêtre
  // ne peut partir que du livre — toutes les écritures de maison de la fenêtre, tous joueurs
  // confondus — parce que sa jointure porte sur une EXPRESSION qu'aucun index ne couvre. Avec lui,
  // le planificateur peut partir des quelques dizaines de billets du joueur et descendre.
  //
  // L'EXPRESSION EST COMPARÉE CARACTÈRE POUR CARACTÈRE À `REFERENCE_BILLET_SQL`, exactement comme
  // celle des comptes l'est à `COMPTE_RE_SQL`. Il ne doit jamais exister deux écritures de la règle
  // qui ramène une écriture à un billet : la seconde vivrait dans un `.sql` que personne ne relit,
  // et elle laisserait un gain contre-passé peser dans l'exposition — le piège nommé de la phase.
  const idx = bloc.match(/create index if not exists ledger_entries_billet_fenetre_idx on ledger_entries\s*\n?\s*\(\((.*)\), cree_le\);/);
  assert.ok(idx, 'l\'index par billet a disparu, ou sa forme a changé');
  assert.strictEqual(idx[1], L.REFERENCE_BILLET_SQL,
    'le schéma et api/ledger.js ne portent pas la MÊME expression de référence de billet');
  // Et ce que la clé NE prouve pas doit rester écrit à côté d'elle : deux décompositions
  // différentes sur la même référence passeraient, et c'est ailleurs que ce trou est refermé.
  const commente = lireApi('schema.sql');
  const i = commente.indexOf('create unique index if not exists ledger_entries_mouvement_uniq');
  assert.ok(i > 0);
  const raison = commente.slice(commente.lastIndexOf('-- LA CLÉ D\'IDEMPOTENCE', i), i);
  assert.match(raison, /NE PROUVE PAS/, 'la limite de la clé n\'est plus écrite à côté d\'elle');
  assert.match(raison, /découvert|séquestre/i);
  assert.match(raison, /net_cents is null/);
});

await test('GARDE NÉGATIVE : AUCUN CHEMIN DE RÈGLEMENT NE PEUT PRODUIRE LE CODE plafond', async () => {
  // Refuser au RÈGLEMENT serait voler une partie gagnée, et c'est irréparable. C'est très exactement
  // le genre de `if` qu'on ajoute un dimanche soir, donc la propriété mérite une garde et pas
  // seulement une phrase de conception. Elle se tient sur le TEXTE : le code `plafond` ne doit
  // apparaître QUE dans les constantes de tête et dans la route qui OUVRE un billet.
  const fs = require('node:fs'), path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const constantes = app.indexOf('function createApp(');
  const debut = app.indexOf('async function ouvrirBillet(');
  const fin = app.indexOf('async function recevoirTrace(');
  assert.ok(constantes > 0 && debut > constantes && fin > debut, 'app.js a changé de forme');
  const sites = [...app.matchAll(/'plafond'/g)].map(m => m.index);
  assert.ok(sites.length >= 2, `seulement ${sites.length} mentions de « plafond » dans app.js`);
  for (const i of sites)
    assert.ok(i < constantes || (i >= debut && i < fin),
      `« plafond » est nommé hors de la route qui ouvre un billet, à l'octet ${i}`);
  // Et côté pilote, le refus ne naît que de `createMatch` : ni le règlement, ni le renoncement, ni
  // le veilleur ne savent le prononcer.
  const pg = PG_NU();
  const ouverture = pg.slice(pg.indexOf('async createMatch(m)'), pg.indexOf('async expositionMaison('));
  assert.ok(ouverture.length > 500, 'createMatch n\'a pas été retrouvé');
  assert.strictEqual((pg.match(/refus: 'plafond'/g) || []).length, 1, 'le refus plafond a plus d\'un site');
  assert.ok(ouverture.includes("refus: 'plafond'"), 'le refus plafond n\'est plus dans createMatch');

  // ET LA PROPRIÉTÉ SE CONSTATE AUSSI EN MARCHE : on franchit le plafond, puis on parcourt TOUS les
  // chemins qui closent une ligne — règlement, trace, renoncement, veilleur — et aucun ne le
  // prononce. Une garde textuelle dit où le mot est écrit ; celle-ci dit ce que les routes rendent.
  const { db, app: routeur, horloge } = bancDeBillet({ limiter: () => true });
  await appel(routeur, { token: 'ok:u1:Loic' });
  const uid = db.users[0].id;
  const b = await demander(routeur, { ...DEMANDE, mode: 'resurgence' });
  for (let i = 0; i < L.PLAFOND_TABLES_PAR_JOUR; i++)
    await semerVictoireMaximale(db, uid, CHERE.miseCents, CHERE.seats, horloge.t);
  const p = partieDe(b, { encaisser: 300 });
  const reponses = [];
  // `poserTrace` asserte déjà ses 200 ; ce qu'on ramasse ici, ce sont les deux routes qui CLOSENT
  // une ligne et qui pourraient être tentées de regarder un plafond.
  for (let i = 0; i < p.segments.length; i++)
    reponses.push(await appel(routeur, { method: 'POST', path: `/api/match/${b.corps.id}/trace`,
      token: 'ok:u1:Loic', body: { seq: i, simVersion: SIM.SIM_VERSION, data: p.segments[i] } }));
  horloge.t = Date.parse(b.corps.openedAt) + (C.LOBBY.wait + p.rapport.seconds + 3) * 1000;
  reponses.push(await appel(routeur, { method: 'POST', path: `/api/match/${b.corps.id}/result`,
                                       token: 'ok:u1:Loic', body: p.rapport }));
  reponses.push(await renoncer(routeur, b.corps.id));
  for (const r of reponses) {
    assert.notStrictEqual(r.code, 500, JSON.stringify(r.corps));
    assert.notStrictEqual((r.corps || {}).code, 'plafond', JSON.stringify(r.corps));
  }
  assert.deepStrictEqual((await routeur.veiller()).echecs, []);
});

test('GARDE TEXTUELLE : la requête de fenêtre INTERPOLE REFERENCE_BILLET_SQL, et ne la réécrit nulle part', () => {
  // Même patron que `COMPTE_RE_SQL` recopiée dans `schema.sql` : il ne doit jamais exister deux
  // écritures de la même règle. Ici on peut faire mieux qu'une comparaison de textes — la requête est
  // en JavaScript, donc elle INTERPOLE la chaîne exportée — et ce que la garde tient est que c'est
  // bien cette interpolation-là, et qu'aucune seconde écriture n'est apparue à côté.
  const pg = PG_NU();
  const debut = pg.indexOf('const EXPOSITION_FENETRE_SQL = `');
  assert.ok(debut > 0, 'la requête de fenêtre a disparu de db-pg.js');
  const requete = pg.slice(debut, pg.indexOf('`;', debut));
  assert.ok(requete.includes('${L.REFERENCE_BILLET_SQL}'),
    'la requête de fenêtre réécrit la règle au lieu d\'interpoler celle d\'api/ledger.js');
  // AUCUN CAST SUR LA RÉFÉRENCE. `reference::bigint` lèverait `22P02` sur `gain:42` — c'est tout le
  // sujet — et le seul `::text` autorisé est celui qui porte l'identifiant du billet DANS L'AUTRE
  // SENS : on compare du texte à du texte.
  for (const interdit of ['reference::', '::bigint', '::int', '::numeric', 'cast('])
    assert.ok(!requete.includes(interdit), `${interdit} dans la requête de fenêtre`);
  assert.ok(requete.includes('m.id::text'), 'la comparaison ne se fait plus sur matches.id::text');
  // ET LA RÈGLE N'EST ÉCRITE NULLE PART AILLEURS dans le pilote : ni l'expression régulière des
  // billets, ni l'extraction d'une contre-passation.
  assert.ok(!/substring\s*\(\s*reference/.test(pg), 'une seconde écriture de la règle est apparue');
  assert.ok(!/reference\s*~/.test(pg), 'une seconde écriture de la règle est apparue');
  // LES COMPTES ET LES MOTIFS SONT DES PARAMÈTRES, pas des littéraux : les deux listes viennent
  // d'`api/ledger.js`, les mêmes que lit `expositionDe`. `maison:dotation` n'entre jamais dans
  // l'exposition, et un littéral recopié ici finirait par l'y laisser entrer.
  for (const appel of ['L.COMPTES_EXPOSITION', 'L.MOTIFS_EXPOSITION'])
    assert.strictEqual((pg.match(new RegExp(appel.replace('.', '\\.'), 'g')) || []).length, 2,
      `${appel} doit servir aux DEUX requêtes d'exposition, et à elles seules`);
  for (const litteral of ["'maison:contrepartie'", "'maison:commission'", "'maison:dotation'"])
    assert.ok(!pg.includes(litteral), `${litteral} est recopié dans db-pg.js`);
  // Les deux listes disent bien ce qu'elles annoncent, et `maison:dotation` n'en est pas.
  assert.deepStrictEqual(L.COMPTES_EXPOSITION.slice(), [L.MAISON_CONTREPARTIE, L.MAISON_COMMISSION]);
  assert.ok(!L.COMPTES_EXPOSITION.includes(L.MAISON_DOTATION));
  assert.deepStrictEqual(L.MOTIFS_EXPOSITION.slice(),
                         ['mise', 'gain', 'remboursement', 'contrepassation']);
  for (const m of L.MOTIFS_EXPOSITION) assert.ok(L.MOTIFS.includes(m), m);
});

test('GARDE TEXTUELLE : le plafond par joueur est SOUS le verrou, le fusible global ne l\'est pas', () => {
  // Les deux nombres n'ont pas la même nature, et les traiter pareil coûtait la section critique la
  // plus disputée du système. Ce que cette garde tient, c'est la FRONTIÈRE : la lecture par joueur
  // est dans la transaction et après le verrou ; celle de la maison est une méthode à part, qui
  // ouvre sa propre connexion, et le routeur l'appelle hors de tout.
  const pg = PG_NU();
  const ouverture = pg.slice(pg.indexOf('async createMatch(m)'), pg.indexOf('async expositionMaison('));
  const VERROU = 'select id from users where id = $1 for update';
  assert.ok(ouverture.indexOf(VERROU) < ouverture.indexOf('expositionJoueur('),
    'l\'exposition du joueur est lue AVANT le verrou : elle ne serait plus exacte');
  assert.ok(ouverture.indexOf('expositionJoueur(') < ouverture.indexOf('insert into matches'),
    'le plafond est décidé après l\'insertion du billet');
  assert.ok(!ouverture.includes('EXPOSITION_MAISON_SQL') && !ouverture.includes('expositionMaison('),
    'le fusible global est lu dans la transaction du billet : agrégat non borné sous le verrou');
  // Et le routeur l'amortit : au plus une lecture toutes les `FUSIBLE_RAFRAICHI_S` secondes, sur
  // l'horloge INJECTÉE, avec la valeur gardée en mémoire du processus entre les deux.
  const app = lireApi('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const amorti = app.slice(app.indexOf('async function expositionMaisonCents('),
                           app.indexOf('async function ouvrirBillet('));
  assert.ok(amorti.length > 100, 'l\'amortissement du fusible n\'a pas été retrouvé');
  assert.match(amorti, /FUSIBLE_RAFRAICHI_S/, 'la cadence n\'est plus lue dans api/ledger.js');
  assert.match(amorti, /now\(\)/, 'le fusible ne lit plus l\'horloge injectée : sa cadence serait intestable');
  assert.ok(!/Date\.now\(\)/.test(amorti), 'le fusible lit une horloge que les tests ne peuvent pas avancer');
  // LA DEUX-COLONNES DES INDEX EST CE QUI REND CETTE LECTURE TENABLE, et le schéma le dit.
  assert.match(SQL_NU(), /on ledger_entries \(compte_debit, cree_le\)/);
});

test('les statuts clos du grand livre et le `check` de matches.status sont la MÊME liste', () => {
  // `ledgerReconcile` exige un séquestre vide sur cinq statuts clos, dont `renounced` — la sixième
  // valeur, arrivée avec la fenêtre de renoncement. Un statut que le code reconnaît et que la base
  // refuse ne se verrait qu'au premier renoncement réel, en 500, avec une mise débitée et un billet
  // qui ne se ferme pas. Deux listes qui décident de la même chose se confrontent.
  const m = SQL_NU().match(/check\s*\(status in \(([^)]*)\)\)/);
  assert.ok(m, 'la contrainte de statut a disparu de matches');
  const dans = (m[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));
  assert.deepStrictEqual(dans.slice().sort(), ['open', ...L.STATUTS_CLOS].slice().sort(),
    'le schéma et api/ledger.js ne connaissent pas les mêmes statuts');
  assert.ok(dans.includes('renounced'), 'la fenêtre de renoncement n\'aurait aucun statut où se poser');
});

test('aucune colonne solde, balance ou wallet n\'est apparue avec le grand livre', () => {
  // La garde existante lit tout `schema.sql` ; celle-ci vise le nouveau bloc, pour que la phrase
  // « un solde est une SOMME, jamais une colonne » soit vérifiée là où elle est le plus tentante à
  // trahir. Une somme fausse se refait ; une case fausse ne se répare pas.
  assert.ok(!/\b(solde|balance|wallet)\b/i.test(BLOC_LEDGER()),
    'une case de solde est apparue dans la table du grand livre');
  for (const interdit of ['solde_cents', 'balance_cents', 'wallet_cents'])
    assert.ok(!lireApi('schema.sql').includes(interdit), interdit);
});

test('GARDE TEXTUELLE : le débit et le règlement prennent leur verrou EN TÊTE de transaction', () => {
  // LE SEUL ENDROIT OÙ CETTE PROPRIÉTÉ PEUT ÊTRE GARDÉE SANS BASE, et il faut dire ce qu'elle vaut :
  // rien sur le comportement de Postgres. Un mono-fil JavaScript sérialise gratuitement ce que
  // Postgres ne sérialise que si on le lui demande bien, donc la doublure ne prouvera jamais le
  // verrou — seul `api/db-check.js` le peut, et il n'a jamais tourné. Ce qu'on garde ici, c'est que
  // le verrou EXISTE, qu'il porte sur la bonne table, et qu'il est pris AVANT que la somme ne soit
  // calculée : un verrou pris après la lecture ne verrouille rien du tout.
  const pg = PG_NU();
  const tranche = (debut, fin) => {
    const a = pg.indexOf(debut), b = pg.indexOf(fin, a);
    assert.ok(a > 0 && b > a, `${debut} n'a pas été retrouvé dans db-pg.js`);
    return pg.slice(a, b);
  };
  const VERROU_JOUEUR = 'select id from users where id = $1 for update';
  const VERROU_PARTIE = 'select id from matches where id = $1 for update';

  // L'OUVERTURE D'UN BILLET. Il n'y a pas de table des comptes — c'est tout l'intérêt — donc le
  // verrou porte sur la seule ligne qui existe par joueur.
  const ouverture = tranche('async createMatch(m)', 'async findMatch(');
  assert.ok(ouverture.includes('await client.query(\'begin\')'),
    'createMatch n\'ouvre pas de transaction : le billet et sa mise pourraient naître séparément');
  assert.ok(ouverture.includes(VERROU_JOUEUR), 'createMatch ne verrouille pas la ligne du joueur');
  assert.ok(ouverture.indexOf(VERROU_JOUEUR) < ouverture.indexOf('ledgerSolde('),
    'le verrou est pris APRÈS la lecture du solde : il ne sérialise plus rien');
  assert.ok(ouverture.indexOf(VERROU_JOUEUR) < ouverture.indexOf('insert into matches'),
    'le verrou est pris après l\'insertion du billet');
  assert.ok(/rollback/.test(ouverture), 'aucune annulation : un refus laisserait un billet impayé');

  // LE RÈGLEMENT. Le séquestre qu'on va débiter appartient à une partie, et la seule ligne qui
  // existe par partie est celle de `matches`.
  const reglement = tranche('async settleMatch(r)', 'async addTrace(');
  assert.ok(reglement.includes('await client.query(\'begin\')'),
    'le règlement et son gain ne sont pas dans la même transaction');
  assert.ok(reglement.includes(VERROU_PARTIE), 'settleMatch ne verrouille pas la ligne de la partie');
  assert.ok(reglement.indexOf(VERROU_PARTIE) < reglement.indexOf('update matches set'),
    'le verrou du règlement est pris après l\'écriture');
  assert.ok(/rollback/.test(reglement), 'un règlement interrompu laisserait une écriture partielle');

  // LA CONNEXION. La recharge se décide sur une SOMME, qu'aucune contrainte ne sait exprimer : lire
  // puis écrire sans verrou laisserait deux onglets écrire deux recharges.
  const connexion = tranche('async findOrCreate(', 'async updateProfile(');
  assert.ok(connexion.includes(VERROU_JOUEUR), 'la recharge se décide sans verrou');
  assert.ok(connexion.indexOf(VERROU_JOUEUR) < connexion.indexOf('mouvementRecharge'),
    'le verrou de la recharge est pris après sa décision');

  // ET LE JOUR SE COMPTE EN UTC. Dans le fuseau de la machine, deux instances déployées dans deux
  // régions basculeraient à deux heures différentes, et « une recharge par jour » deviendrait « une
  // ou deux selon le serveur qui répond ».
  const jour = tranche('function jourDe(', 'function reglerSequestre');
  assert.match(jour, /toISOString\(\)\.slice\(0, 10\)/, 'le jour d\'une recharge n\'est plus en UTC');
});

test('GARDE TEXTUELLE : l\'écrivain du grand livre n\'est appelé que depuis les méthodes NOMMÉES de db-pg.js', () => {
  // Le patron déjà en place pour `match_traces` et pour le lecteur unique des tables annexes du bloc
  // `Game`. Sans lui, le veilleur — qui devient un écrivain d'argent au module 4 — deviendrait un
  // écrivain SILENCIEUX. Un écrivain d'argent doit être nommé.
  //
  // LA LISTE DES APPELANTS AUTORISÉS. Elle était vide au module 2 : le schéma et l'écrivain
  // existaient, et personne ne les appelait encore. Le module 3 y met les siens, et il doit le
  // faire EXPRÈS — c'est tout l'objet de cette garde.
  //
  // — `findOrCreate` : la dotation à la création du compte, la recharge à la connexion. Les deux
  //   sont écrites par le SERVEUR ; il n'existe aucune route `POST /api/credits`, et une garde plus
  //   bas vérifie que le routeur ne nomme jamais l'écrivain.
  // — `createMatch` : la mise, débitée à l'ouverture et dans la même transaction que le billet.
  // — `reglerSequestre` : le gain, le vidage d'un séquestre clos, et rien d'autre. Vider et régler
  //   sont la même opération comptable, donc une seule fonction et une seule entrée ici.
  //
  // — `renounceMatch` : le REMBOURSEMENT, arrivé au module 4. C'est le seul chemin du dépôt qui
  //   rende une mise, et il est borné par la fenêtre de renoncement, à l'horloge du serveur.
  //
  // ET LA GARDE S'ÉTEND À `reglerSequestre`, PARCE QUE LE VEILLEUR SERAIT SINON UN ÉCRIVAIN
  // SILENCIEUX. Il n'appelle pas `ledgerWrite` directement — il passe par `reglerSequestre`, qui
  // est bien dans la liste — donc une garde posée sur le seul écrivain direct l'aurait laissé
  // entrer sans que personne n'ait à l'écrire. Or c'est exactement le revirement de cette phase :
  // à l'expiration, le séquestre est vidé vers `maison:contrepartie`. On garde donc les appelants
  // des DEUX : l'écrivain, et la fonction qui l'appelle pour vider un séquestre.
  //
  // — `settleMatch` et `expireMatches` : les deux qui règlent un séquestre sans écrire eux-mêmes.
  //
  // — `contrepasser` : l'UNIQUE appelant de `mouvementContrepassation`, arrivé au module 5 de la
  //   phase 04a. Il n'est atteignable que par `api/operateur.js`, en ligne de commande : aucune
  //   route ne le nomme, et une garde plus bas vérifie qu'`api/app.js` ne charge jamais l'outil.
  const APPELANTS_LEDGER = ['findOrCreate', 'createMatch', 'reglerSequestre', 'renounceMatch',
                            'settleMatch', 'expireMatches', 'contrepasser'];
  const pg = PG_NU();
  assert.strictEqual((pg.match(/^async function ledgerWrite\s*\(/gm) || []).length, 1,
    'l\'écrivain du grand livre doit être défini une fois et une seule');
  assert.strictEqual((pg.match(/^async function reglerSequestre\s*\(/gm) || []).length, 1,
    'le règlement d\'un séquestre doit être défini une fois et une seule');

  // Le détecteur de fonction englobante. Il est ÉPROUVÉ sur un cas connu avant de servir : une
  // garde dont le mécanisme ne marche pas passe verte sur tout, ce qui est pire que pas de garde.
  // `for`, `if`, `while` et compagnie ouvrent eux aussi une parenthèse puis une accolade en début de
  // ligne : sans cette exclusion, le détecteur nommerait « for » la fonction englobante.
  const MOTS_CLES = new Set(['for', 'if', 'while', 'switch', 'catch', 'do', 'else', 'function',
                             'return', 'await', 'typeof', 'new']);
  const entetes = [...pg.matchAll(/^\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)]
    .map(m => ({ nom: m[1], i: m.index })).filter(e => !MOTS_CLES.has(e.nom));
  assert.ok(entetes.length > 8, `seulement ${entetes.length} fonctions retrouvées dans db-pg.js`);
  const englobante = i => (entetes.filter(e => e.i < i).pop() || { nom: '(hors fonction)' }).nom;
  const sites = nom => {
    const trouves = [];
    const re = new RegExp(`\\b${nom}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(pg))) {
      // La définition elle-même n'est pas un appel.
      if (/(?:async\s+)?function\s+$/.test(pg.slice(Math.max(0, m.index - 20), m.index))) continue;
      trouves.push(m.index);
    }
    return trouves;
  };
  // Le cas connu : `ligneMatch` est appelé depuis des méthodes nommées, et le détecteur doit les
  // nommer. S'il rendait « (hors fonction) » partout, la garde ci-dessous ne vaudrait rien.
  const temoins = sites('ligneMatch').map(englobante);
  assert.ok(temoins.length >= 4, `seulement ${temoins.length} appels témoins`);
  for (const t of temoins)
    assert.ok(/^(createMatch|findMatch|settleMatch|markPlayed|expireMatches|renounceMatch|lastRenounced|lireBillet)$/.test(t),
      `le détecteur de fonction englobante rend « ${t} » : il ne marche plus`);

  for (const nom of ['ledgerWrite', 'reglerSequestre']) for (const appel of sites(nom)) {
    const qui = englobante(appel);
    assert.ok(APPELANTS_LEDGER.includes(qui),
      `${nom} est appelé depuis « ${qui} », qui n'est pas dans la liste des appelants autorisés du grand livre`);
  }
  // ET LE VEILLEUR Y EST NOMMÉMENT. C'est le revirement de la phase : il écrit de l'argent, donc il
  // doit figurer dans cette liste. Un écrivain d'argent de plus se nomme, il ne se glisse pas.
  assert.ok(sites('reglerSequestre').map(englobante).includes('expireMatches'),
    'le veilleur ne vide plus les séquestres : une ligne close laisserait son séquestre habité');
  // Et le routeur ne touche JAMAIS le grand livre directement : il ne connaît que les méthodes
  // qu'on lui injecte, et `ledgerWrite` n'en est pas une.
  const app = lireApi('app.js');
  for (const interdit of ['ledgerWrite', 'ledger_entries'])
    assert.ok(!app.includes(interdit), `app.js parle de ${interdit} : le routeur écrirait de l'argent`);
});

console.log('Qui a le droit de contre-passer');

// LE BANC D'INCIDENT : un joueur doté, un billet, sa mise, et — s'il est clos — son gain. C'est
// exactement l'état devant lequel un opérateur se retrouve quand on l'appelle. Le gain est posé
// APRÈS qu'on a relevé les soldes, pour que « tout retombe exactement » se mesure contre un état
// observé et non contre une formule recopiée.
const SIEGES_CHERE = C.seatsOf(C.MODES.resurgence);
async function bancIncident({ statut = 'settled', miseCents = 1000 } = {}) {
  const db = fakeDb();
  const userId = 1, matchId = 77;
  const clos = statut !== 'open';
  const p = C.cashoutCents(C.purseBound(miseCents, SIEGES_CHERE).maxCents);
  const quand = new Date(T0).toISOString();
  db.matches.push({
    id: matchId, user_id: userId, mode: 'resurgence', stake_cents: miseCents, seats: SIEGES_CHERE,
    team_size: 1, paid_seats: 1, brawler: BRAWLER, seed_public: 1, seed_secret: SECRETS[0],
    sim_version: SIM.SIM_VERSION, client_key: 'incident', status: statut,
    first_result_at: clos ? quand : null, opened_at: quand, expires_at: quand,
    settled_at: clos ? quand : null, issue: clos ? 'encaissement' : null, controle: null, motif: null,
    gross_cents: clos ? p.grossCents : null, fee_cents: clos ? p.feeCents : null,
    net_cents: clos ? p.netCents : null, purse_cents: clos ? 0 : null,
    declared_net_cents: null, ecart_cents: null,
    seconds: 1, kills: 0, deaths: 0, rank: 1, cubes: 0, damage: 0, cashed_out: clos,
    trace_steps: 1, replay_digest: null, digest_match: clos ? true : null,
    divergence_step: null, replay_ms: 0,
  });
  await db.ledgerWrite(L.mouvementDotation({ userId, montantCents: L.DOTATION_CENTS }));
  await db.ledgerWrite(L.mouvementMise({ userId, matchId, miseCents }));
  // LES QUATRE COMPTES QUE LE GAIN TOUCHE, relevés AVANT lui. C'est la référence contre laquelle la
  // contre-passation doit ramener le livre, au centime.
  const COMPTES = [L.compteEnjeu(matchId), L.MAISON_CONTREPARTIE, L.MAISON_COMMISSION,
                   L.compteJoueur(userId)];
  const soldes = () => COMPTES.map(c => L.soldeDe(livreDe(db), c));
  const exposition = () => L.expositionDe(livreDe(db), [String(matchId)]);
  const avant = { soldes: soldes(), exposition: exposition() };
  if (clos) {
    await db.ledgerWrite(L.mouvementGain({ userId, matchId, miseCents, grossCents: p.grossCents,
      feeCents: p.feeCents, netCents: p.netCents, convergee: true }));
  }
  return { db, userId, matchId, miseCents, p, COMPTES, soldes, exposition, avant };
}
// Un collecteur de sortie : l'outil n'imprime que par `sortie`, donc un test peut lire ce que
// l'opérateur aurait lu.
// L'HORLOGE EST RÉGLABLE, et ce n'est pas du confort. Avec `maintenant: () => T0` figé, l'heure
// d'ouverture des billets du banc et l'heure de l'outil COÏNCIDAIENT : la fenêtre ancrée sur
// l'horloge courante et celle ancrée sur `opened_at` rendaient le même chiffre, et le défaut était
// invisible par construction. L'opérateur, lui, regarde des heures ou des jours après le refus.
function bancOutil(db, horloge = { t: T0 }) {
  const lignes = [];
  return { lignes, horloge, texte: () => lignes.join('\n'),
           lancer: argv => OP.executer(argv, { db, sortie: l => lignes.push(l),
                                               maintenant: () => horloge.t }) };
}
const OP_SIGNE = ['--par', 'Loïc', '--raison', 'double règlement du 14, ticket 118'];

test('planCorrection REFUSE un mouvement vide, une raison vide, un opérateur vide, et un paquet hétéroclite', () => {
  // Les quatre refus que la partie PURE doit tenir, donc les quatre qui se prouvent sans base. Ils
  // sont RENDUS et non lancés : un opérateur qui lit une pile d'appels un dimanche soir n'apprend
  // rien, et ce sont des cas normaux — un couple qui ne désigne rien, une option oubliée.
  const mise = L.mouvementMise({ userId: 3, matchId: 9, miseCents: 50 });
  const billet = { id: 9, status: 'expired' };
  const bon = { par: 'Loïc', raison: 'ticket 118', billet };

  for (const vide of [[], null, undefined, 'pas un tableau'])
    assert.strictEqual(L.planCorrection(vide, bon).code, 'mouvement_vide', String(vide));

  for (const par of ['', '   ', null, undefined, 42])
    assert.strictEqual(L.planCorrection(mise, { ...bon, par }).code, 'operateur_vide', String(par));
  assert.strictEqual(L.planCorrection(mise, { ...bon, par: 'x'.repeat(L.AUDIT_OPERATEUR_MAX + 1) }).code,
    'operateur_trop_long');

  // LA RAISON EST LE CŒUR DU MODULE : une contre-passation sans raison écrite est indistinguable
  // d'une erreur de manipulation. Les blancs ne comptent pas — sinon « pourquoi » serait une case à
  // cocher, et une espace suffirait à la cocher.
  for (const raison of ['', '   ', '\n\t ', 'ab', null, undefined, 0])
    assert.strictEqual(L.planCorrection(mise, { ...bon, raison }).code, 'raison_vide', String(raison));
  assert.strictEqual(L.planCorrection(mise, { ...bon, raison: 'x'.repeat(L.AUDIT_RAISON_MAX + 1) }).code,
    'raison_trop_longue');
  // Et une raison valide est CONSERVÉE DÉBARRASSÉE DE SES BLANCS : c'est elle qui part en base.
  assert.strictEqual(L.planCorrection(mise, { ...bon, raison: '  ticket 118  ' }).raison, 'ticket 118');
  assert.strictEqual(L.planCorrection(mise, { ...bon, par: ' Loïc ' }).par, 'Loïc');

  // UN MOUVEMENT EST UN ENSEMBLE DE TRANSFERTS PARTAGEANT `(motif, reference)`. Contre-passer un
  // paquet hétéroclite produirait un inverse qui ne correspond à rien de nommable.
  const autreRef = L.mouvementMise({ userId: 3, matchId: 11, miseCents: 50 });
  assert.strictEqual(L.planCorrection([...mise, ...autreRef], bon).code, 'mouvement_heterogene');
  const gain = L.mouvementGain({ userId: 3, matchId: 9, miseCents: 50, grossCents: 0, feeCents: 0,
                                 netCents: 0, convergee: true });
  assert.strictEqual(L.planCorrection([...mise, ...gain], bon).code, 'mouvement_heterogene');

  // Et le cas nominal passe, avec tout ce que l'audit devra porter.
  const plan = L.planCorrection(mise, bon);
  assert.strictEqual(plan.ok, true, plan.message);
  assert.strictEqual(plan.geste, 'contrepassation');
  assert.strictEqual(plan.motifOrigine, 'mise');
  assert.strictEqual(plan.referenceOrigine, '9');
  assert.strictEqual(plan.referencePosee, 'mise:9');
  assert.strictEqual(plan.jambes, 1);
  assert.strictEqual(plan.montantCents, 50);
  assert.strictEqual(plan.billet, '9');
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.contrepassation));
  // L'inverse EXACT, jambe par jambe : les deux comptes échangés, le montant identique.
  assert.strictEqual(plan.contrepassation[0].compteDebit, mise[0].compteCredit);
  assert.strictEqual(plan.contrepassation[0].compteCredit, mise[0].compteDebit);
});

test('planCorrection REFUSE un mouvement portant sur un billet encore `open`, et le refus est NOMMÉ', () => {
  // LE SEUL CAS QUI LAISSERAIT UN SÉQUESTRE INCOHÉRENT AVEC SON STATUT, et c'est pour cela qu'il a
  // un nom à lui. Sur une ligne `open`, `solde(enjeu:<id>)` doit valoir la mise : contre-passer la
  // mise le viderait, contre-passer un gain le remplirait, et `ledgerReconcile` produirait un grief
  // sur une ligne que personne n'a touchée.
  const mise = L.mouvementMise({ userId: 3, matchId: 9, miseCents: 50 });
  const bon = { par: 'Loïc', raison: 'ticket 118' };
  const refus = L.planCorrection(mise, { ...bon, billet: { id: 9, status: 'open' } });
  assert.strictEqual(refus.ok, false);
  assert.strictEqual(refus.code, 'billet_ouvert');
  // Et le refus DIT OÙ ALLER : la clôture normale, c'est-à-dire le veilleur.
  assert.match(refus.message, /veilleur/);

  // Les cinq statuts clos passent, et eux seuls.
  for (const status of L.STATUTS_CLOS)
    assert.strictEqual(L.planCorrection(mise, { ...bon, billet: { id: 9, status } }).ok, true, status);
  assert.strictEqual(L.planCorrection(mise, { ...bon, billet: { id: 9, status: 'zombie' } }).code,
    'billet_statut_inconnu');

  // NE PAS RELIRE LE BILLET N'EST PAS UNE FAÇON DE CONTOURNER LE CONTRÔLE. Sans la ligne, on ne
  // peut pas savoir si le séquestre est habité : on refuse, on ne suppose pas.
  for (const billet of [undefined, null, {}, { id: null }])
    assert.strictEqual(L.planCorrection(mise, { ...bon, billet }).code, 'billet_inconnu', String(billet));
  assert.strictEqual(L.planCorrection(mise, { ...bon, billet: { id: 12, status: 'settled' } }).code,
    'billet_etranger');

  // ET UNE ÉCRITURE QUI NE DÉSIGNE AUCUN BILLET N'A AUCUN BILLET À RELIRE : la dotation et la
  // recharge passent sans ligne `matches`, parce que `referenceBillet` les rend `null`.
  for (const mvt of [L.mouvementDotation({ userId: 3, montantCents: 5000 }),
                     L.mouvementRecharge({ userId: 3, jour: '2026-01-01', montantCents: 1000 })]) {
    const p = L.planCorrection(mvt, bon);
    assert.strictEqual(p.ok, true, p.message);
    assert.strictEqual(p.billet, null);
  }

  // Et l'AIDE de l'outil le dit aussi, pour que personne ne cherche le déblocage d'un billet ouvert
  // du côté de la correction du livre.
  assert.match(OP.AIDE, /billet_ouvert/);
  assert.match(OP.AIDE, /CL[ÔO]TURE NORMALE/i);
  assert.match(OP.AIDE, /veilleur/);
});

test('planCorrection REFUSE de contre-passer une contre-passation, et ferme la limite du module 1', () => {
  // LA DETTE DU MODULE 1, SOLDÉE ICI PLUTÔT QU'ÉLARGIE. Le double geste produit la référence
  // `contrepassation:gain:42`, que `referenceBillet` — et sa traduction SQL — ne ramènent à AUCUN
  // billet : l'écriture cesserait de compter dans l'exposition, et le plafond serait faux sans que
  // rien ne le dise. `docs/PHASE-04A.md` chiffrait les deux réponses possibles ; on ferme le chemin.
  const gain = L.mouvementGain({ userId: 3, matchId: 42, miseCents: 50, grossCents: 0, feeCents: 0,
                                 netCents: 0, convergee: true });
  const contre = L.mouvementContrepassation({ transferts: gain });
  assert.strictEqual(contre[0].reference, 'gain:42');
  const refus = L.planCorrection(contre, { par: 'Loïc', raison: 'ticket 118',
                                           billet: { id: 42, status: 'settled' } });
  assert.strictEqual(refus.code, 'double_contrepassation');
  // La raison du refus est vérifiable, pas seulement écrite : la référence que le double geste
  // produirait ne se ramène à aucun billet, des deux côtés de la règle.
  const doublee = L.mouvementContrepassation({ transferts: contre });
  assert.strictEqual(doublee[0].reference, 'contrepassation:gain:42');
  assert.strictEqual(L.referenceBillet('contrepassation', doublee[0].reference), null);
  assert.ok(!L.REFERENCE_BILLET_SQL.includes('contrepassation:'),
    'la règle SQL a été élargie d\'un côté seulement');
});

await test('L\'ÉCRITURE ET SA RAISON PARTAGENT LA TRANSACTION : un audit qui échoue ne laisse AUCUNE contre-passation', async () => {
  // La propriété entière du module. Une raison consignée APRÈS COUP peut ne jamais l'être — le shell
  // se ferme, la connexion tombe — et une contre-passation sans raison est indistinguable d'une
  // erreur de manipulation. On fait donc échouer la SECONDE moitié et on regarde la première.
  const { db, matchId, avant, soldes, exposition } = await bancIncident();
  const outil = bancOutil(db);
  const lignes = await db.lireMouvement({ motif: 'gain', reference: String(matchId) });
  assert.strictEqual(lignes.length, 3, 'le gain maximal porte trois jambes');
  const apresGain = db.ledger.length;

  db.panne.audit = () => true;
  await assert.rejects(() => outil.lancer(['contrepasser', 'gain', String(matchId), ...OP_SIGNE, '--confirme']),
    e => e.code === '23514');
  assert.strictEqual(db.ledger.length, apresGain,
    'l\'audit a échoué et la contre-passation est restée : l\'argent et sa raison ne partagent plus la transaction');
  assert.strictEqual(db.ledgerAudit.length, 0);
  assert.ok(!db.ledger.some(l => l.motif === 'contrepassation'));

  // Et sans la panne, les deux arrivent ENSEMBLE.
  db.panne.audit = null;
  assert.strictEqual(await outil.lancer(['contrepasser', 'gain', String(matchId), ...OP_SIGNE, '--confirme']), 0);
  assert.strictEqual(db.ledger.filter(l => l.motif === 'contrepassation').length, 3);
  assert.strictEqual(db.ledgerAudit.length, 1);
  const trace = db.ledgerAudit[0];
  assert.strictEqual(trace.geste, 'contrepassation');
  assert.strictEqual(trace.operateur, 'Loïc');
  assert.strictEqual(trace.raison, 'double règlement du 14, ticket 118');
  assert.strictEqual(trace.motif_origine, 'gain');
  assert.strictEqual(trace.reference_origine, String(matchId));
  assert.strictEqual(trace.reference_posee, `gain:${matchId}`);
  assert.strictEqual(trace.jambes, 3);
  assert.strictEqual(trace.montant_cents, lignes.reduce((s, l) => s + l.montant_cents, 0));
  // La ligne d'audit est GELÉE : la règle « aucun update, aucun delete » commence par l'objet en
  // mémoire, et une trace qu'on peut réécrire ne trace rien.
  assert.ok(Object.isFrozen(trace));
  assert.throws(() => { trace.raison = 'autre chose'; }, TypeError);
  assert.match(outil.texte(), /POSÉE : 3 jambe/);
  // ET LA TRACE SE RELIT PAR L'OUTIL, sur le mouvement qu'elle corrige : c'est de là que part un
  // opérateur, et c'est ce qui évite le `select` à la main.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['montrer', 'mouvement', 'gain', String(matchId)]), 0);
  assert.match(outil.texte(), /contrepassation par Loïc/);
  assert.match(outil.texte(), /double règlement du 14, ticket 118/);

  // TOUT RETOMBE EXACTEMENT, sur les quatre comptes touchés, et le zéro global tient.
  assert.deepStrictEqual(soldes(), avant.soldes,
    'la contre-passation d\'un gain n\'a pas ramené les quatre comptes là où ils étaient');
  zeroGlobal(db, 'après une contre-passation de gain');
  // ET L'EXPOSITION RETOMBE AVEC EUX : un gain contre-passé ne compte plus. C'est le piège de la
  // phase, et il se vérifie ici de bout en bout — l'écriture porte `gain:77`, que seule
  // `referenceBillet` sait ramener au billet 77.
  assert.strictEqual(exposition(), avant.exposition);
  assert.strictEqual(exposition(), 0, 'le livre ne portait qu\'une mise avant le gain');

  // LE GRIEF QUI RESTE EST LÉGITIME, ET IL EST NOMMÉ PLUTÔT QUE TU : contre-passer le gain d'une
  // ligne réglée RÉHABITE son séquestre, et `ledgerReconcile` a raison de le dire. L'outil corrige
  // le livre, il ne décide pas de la suite — c'est à l'opérateur de poser le mouvement juste, ou de
  // faire clore la ligne.
  const griefs = L.ledgerReconcile(db.matches, livreDe(db));
  assert.strictEqual(griefs.length, 1, griefs.join(' | '));
  assert.match(griefs[0], /séquestre n'est pas vidé/);
});

await test('REJOUER L\'OUTIL NE POSE RIEN, et il LE DIT au lieu de sortir en erreur', async () => {
  // La clé `(motif, reference, compte_debit, compte_credit)` refuse la seconde pose. Un opérateur
  // qui relance sa commande parce que sa connexion a lâché doit lire « c'était déjà fait » : sortir
  // en erreur sur un geste idempotent est exactement ce qui fait ouvrir `psql` pour « vérifier ».
  const { db, matchId } = await bancIncident();
  const outil = bancOutil(db);
  const argv = ['contrepasser', 'gain', String(matchId), ...OP_SIGNE, '--confirme'];
  assert.strictEqual(await outil.lancer(argv), 0);
  const apres = db.ledger.length;

  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(argv), 0, 'le rejeu doit sortir proprement, pas en erreur');
  assert.match(outil.texte(), /DÉJÀ POSÉE/);
  assert.strictEqual(db.ledger.length, apres, 'le rejeu a posé des écritures');
  // ET L'AUDIT NON PLUS : la seconde raison n'est pas consignée, puisque rien n'a été écrit. Une
  // trace sans écriture raconterait un geste qui n'a pas eu lieu.
  assert.strictEqual(db.ledgerAudit.length, 1);
  zeroGlobal(db, 'après un rejeu de l\'outil');

  // ET LE DÉCOUVERT EST UN REFUS, PAS UNE PANNE. Contre-passer la DOTATION d'un joueur qui a déjà
  // dépensé ses crédits demande à son compte plus qu'il ne porte : la règle uniforme l'arrête, et
  // l'opérateur lit une phrase au lieu d'une pile d'appels. Aucun compte ne passe en négatif, pas
  // même par une correction.
  const vide = fakeDb();
  await vide.ledgerWrite(L.mouvementDotation({ userId: 5, montantCents: L.DOTATION_CENTS }));
  await vide.ledgerWrite(L.mouvementMise({ userId: 5, matchId: 3, miseCents: L.DOTATION_CENTS }));
  const o = bancOutil(vide);
  assert.strictEqual(await o.lancer(['contrepasser', 'dotation', '5', ...OP_SIGNE, '--confirme']), 1);
  assert.match(o.texte(), /REFUSÉ \(decouvert\)/);
  assert.ok(!vide.ledger.some(l => l.motif === 'contrepassation'));
  assert.strictEqual(vide.ledgerAudit.length, 0, 'une raison a été consignée sans son argent');
});

await test('le verbe `montrer` n\'écrit RIEN : aucune ligne dans ledger_entries, aucune dans ledger_audit', async () => {
  // Le premier geste d'un incident réel n'est pas de corriger, c'est de regarder. Un verbe de
  // lecture qui écrirait — ne serait-ce qu'une trace — ferait de « aller voir » une décision.
  const { db, matchId, userId } = await bancIncident();
  const outil = bancOutil(db);
  const avant = { livre: db.ledger.length, audit: db.ledgerAudit.length,
                  matches: JSON.stringify(db.matches) };

  assert.strictEqual(await outil.lancer(['montrer', 'mouvement', 'gain', String(matchId)]), 0);
  assert.match(outil.texte(), /3 jambe\(s\)/);
  assert.match(outil.texte(), new RegExp(`billet désigné : ${matchId}`));
  // LE JOURNAL SE RELIT PAR LE MÊME OUTIL QUI L'ÉCRIT. « Quelqu'un y a-t-il déjà touché, et
  // pourquoi ? » est la première question d'un incident réel ; sans réponse ici, elle en a une dans
  // `psql`.
  assert.match(outil.texte(), /aucun geste d'opération consigné/);

  // Un identifiant illisible est REFUSÉ avant de partir en SQL : `where id = $1` sur « abc » lève
  // `22P02`, et l'opérateur lirait une pile d'appels au lieu d'une phrase.
  for (const mauvais of ['abc', '007', '0', '-1'])
    assert.strictEqual(await outil.lancer(['montrer', 'billet', mauvais]), 2, mauvais);

  assert.strictEqual(await outil.lancer(['montrer', 'billet', String(matchId)]), 0);
  assert.match(outil.texte(), /statut settled/);
  assert.match(outil.texte(), new RegExp(`séquestre ${L.compteEnjeu(matchId)} : 0 centimes`));
  assert.match(outil.texte(), /exposition réalisée du joueur à l'ouverture de ce billet, sur 24 h/);

  assert.strictEqual(await outil.lancer(['montrer', 'exposition', String(userId)]), 0);
  assert.match(outil.texte(), new RegExp(`plafond\\s+: ${L.PLAFOND_JOUEUR_CENTS} centimes`));

  // Et l'aide, qui n'a besoin d'aucune base.
  assert.strictEqual(await outil.lancer([]), 0);
  assert.match(outil.texte(), /montrer mouvement/);

  assert.strictEqual(db.ledger.length, avant.livre, 'un verbe de lecture a écrit dans le grand livre');
  assert.strictEqual(db.ledgerAudit.length, avant.audit, 'un verbe de lecture a écrit dans le journal');
  assert.strictEqual(JSON.stringify(db.matches), avant.matches, 'un verbe de lecture a touché matches');

  // ET IL MONTRE AVANT D'ÉCRIRE : sans `--confirme`, `contrepasser` n'est qu'un verbe de lecture de
  // plus, et il le dit.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['contrepasser', 'gain', String(matchId), ...OP_SIGNE]), 0);
  assert.match(outil.texte(), /RIEN N'A ÉTÉ ÉCRIT/);
  assert.match(outil.texte(), /--confirme/);
  assert.strictEqual(db.ledger.length, avant.livre);
  assert.strictEqual(db.ledgerAudit.length, avant.audit);

  // UN BILLET ENCORE OUVERT EST REFUSÉ PAR L'OUTIL, avec le code nommé et sans rien écrire.
  const ouvert = await bancIncident({ statut: 'open' });
  const o2 = bancOutil(ouvert.db);
  assert.strictEqual(await o2.lancer(['contrepasser', 'mise', String(ouvert.matchId), ...OP_SIGNE, '--confirme']), 1);
  assert.match(o2.texte(), /REFUSÉ \(billet_ouvert\)/);
  assert.strictEqual(ouvert.db.ledger.filter(l => l.motif === 'contrepassation').length, 0);
  assert.strictEqual(ouvert.db.ledgerAudit.length, 0);
  reconcilier(ouvert.db, 'un billet ouvert qu\'on a refusé de contre-passer');
});

await test('`montrer billet` dit le chiffre QUI A DÉCIDÉ, et pas celui de l\'heure où on le consulte', async () => {
  // LE DÉFAUT QUE LA COÏNCIDENCE DU BANC CACHAIT. `createMatch` décide sur la fenêtre
  // `[opened_at − 24 h, opened_at]` ; l'outil lisait `[maintenant − 24 h, maintenant]`. Tant que le
  // banc figeait les deux à `T0`, les deux fenêtres étaient la même et rien ne pouvait se voir. Un
  // opérateur, lui, arrive des heures ou des jours après le refus : une jambe de gain posée deux
  // heures avant l'ouverture sort de sa fenêtre à lui et pas de celle qui a refusé, et le
  // commentaire « c'est le chiffre qui a décidé » devient faux sans qu'une ligne de code bouge.
  //
  // Ce cas casse la coïncidence exprès : le gain est posé DEUX heures avant l'ouverture, et l'outil
  // est lancé VINGT-TROIS heures après.
  // L'horloge du livre est celle de la doublure : c'est elle qui date `cree_le`, donc elle qui
  // décide de quel côté des deux fenêtres tombe chaque jambe.
  const livreT = { t: T0 - 2 * 3600 * 1000 };
  const db = fakeDb([], () => livreT.t);
  const userId = 1, matchId = 4242;
  const miseCents = 1000, sieges = C.seatsOf(C.MODES.resurgence);
  const p = C.cashoutCents(C.purseBound(miseCents, sieges).maxCents);
  const ouvert = new Date(T0);
  const avantOuverture = new Date(T0 - 2 * 3600 * 1000);
  db.users.push({ id: userId, auth_id: 'op', email: 'op@x.test', name: 'Op', name_key: 'op' });
  // UN PREMIER BILLET, RÉGLÉ AVANT L'OUVERTURE DU SECOND, et son gain maximal : c'est lui qui pèse
  // dans la fenêtre du refus.
  db.matches.push({ id: 4241, user_id: userId, mode: 'resurgence', stake_cents: miseCents,
    seats: sieges, team_size: 1, paid_seats: 1, brawler: BRAWLER, seed_public: 1,
    seed_secret: SECRETS[0], sim_version: SIM.SIM_VERSION, client_key: 'vieux', status: 'settled',
    first_result_at: avantOuverture, opened_at: avantOuverture, expires_at: avantOuverture,
    settled_at: avantOuverture, issue: 'encaissement', controle: null, motif: null,
    gross_cents: p.grossCents, fee_cents: p.feeCents, net_cents: p.netCents, purse_cents: 0,
    declared_net_cents: null, ecart_cents: null, seconds: 1, kills: 0, deaths: 0, rank: 1,
    cubes: 0, damage: 0, cashed_out: true, trace_steps: 1, replay_digest: null,
    digest_match: true, divergence_step: null, replay_ms: 0 });
  db.matches.push({ id: matchId, user_id: userId, mode: 'resurgence', stake_cents: miseCents,
    seats: sieges, team_size: 1, paid_seats: 1, brawler: BRAWLER, seed_public: 1,
    seed_secret: SECRETS[0], sim_version: SIM.SIM_VERSION, client_key: 'apres', status: 'settled',
    first_result_at: ouvert, opened_at: ouvert, expires_at: ouvert, settled_at: ouvert,
    issue: 'defaite', controle: null, motif: null, gross_cents: 0, fee_cents: 0, net_cents: 0,
    purse_cents: 0, declared_net_cents: null, ecart_cents: null, seconds: 1, kills: 0, deaths: 0,
    rank: 20, cubes: 0, damage: 0, cashed_out: false, trace_steps: 1, replay_digest: null,
    digest_match: true, divergence_step: null, replay_ms: 0 });
  await db.ledgerWrite(L.mouvementDotation({ userId, montantCents: 500000 }));
  await db.ledgerWrite(L.mouvementMise({ userId, matchId: 4241, miseCents }));
  await db.ledgerWrite(L.mouvementGain({ userId, matchId: 4241, miseCents, grossCents: p.grossCents,
    feeCents: p.feeCents, netCents: p.netCents, convergee: true }));

  const attendu = L.expositionBilletMaxCents(p.netCents, miseCents);
  assert.strictEqual(attendu, 39000, 'le pire cas du domaine a bougé : ce cas doit être re-décidé');

  // L'OPÉRATEUR ARRIVE VINGT-TROIS HEURES PLUS TARD. La jambe de gain est alors sortie de SA fenêtre
  // à lui, et elle est toujours dans celle qui a décidé.
  const outil = bancOutil(db, { t: T0 + 23 * 3600 * 1000 });
  assert.strictEqual(await outil.lancer(['montrer', 'billet', String(matchId)]), 0);
  assert.match(outil.texte(), new RegExp(`à l'ouverture de ce billet, sur 24 h : ${attendu} centimes`));
  // ET LE PIRE CAS DE LA TABLE EST CELUI DE LA TABLE, dérivé de `WBCore` et jamais écrit à la main :
  // sans lui, la « retenue » affichée valait l'exposition seule et ne disait pas ce que ce billet-ci
  // pesait.
  assert.match(outil.texte(), new RegExp(`pire cas de cette table ${attendu},`));
  assert.match(outil.texte(), new RegExp(`retenue ${2 * attendu}`));

  // ET `montrer exposition`, LUI, PARLE BIEN D'AUJOURD'HUI : c'est le verbe qui répond à « pourquoi
  // ce joueur est-il refusé », et sa question est au présent. Les deux verbes ne disent pas la même
  // chose, et c'est voulu — vingt-trois heures après, la fenêtre du jour ne porte plus ce gain.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['montrer', 'exposition', String(userId)]), 0);
  assert.match(outil.texte(), /exposition réalisée : 0 centimes/);
});

test('L\'AIDE N\'ASSIGNE PLUS À `montrer billet` UNE QUESTION QU\'AUCUN VERBE NE PEUT RENDRE', () => {
  // Un refus `plafond` ne laisse AUCUNE ligne dans `matches` — « ni ligne, ni écriture, ni
  // séquestre » — et le corps du 409 ne porte pas d'identifiant. `montrer billet <id>` rendait donc
  // « aucun billet <id> » sur le cas exact que l'aide lui assignait. La question appartient à
  // `montrer exposition`, qui part du joueur.
  const aide = lireApi('operateur.js');
  const bloc = section => {
    const i = aide.indexOf(section);
    assert.ok(i > 0, `${section} a disparu de l'aide`);
    return aide.slice(i, aide.indexOf('\n\n', i));
  };
  const billet = bloc('  montrer billet <id>');
  assert.ok(!/refusé en plafond/.test(billet),
    '`montrer billet` promet encore d\'expliquer un refus qui ne laisse aucun billet');
  assert.match(billet, /marge de plafond/);
  const exposition = bloc('  montrer exposition <userId>');
  assert.match(exposition, /refusé en plafond/);
  assert.match(exposition, /AUCUNE ligne dans matches/);
});

test('l\'analyseur d\'arguments de l\'outil est pur, et une option sans valeur n\'avale pas la suivante', () => {
  // Une raison avalée par une option collée se découvre un dimanche soir. Les deux écritures sont
  // acceptées — `--par X` et `--par=X` — parce que les deux se tapent, et une option inconnue est
  // REFUSÉE plutôt qu'ignorée : ignorer `--raion` poserait une contre-passation sans raison.
  const a = OP.lireArguments(['contrepasser', 'gain', '42', '--par', 'Loïc', '--raison=ticket 118', '--confirme']);
  assert.strictEqual(a.verbe, 'contrepasser');
  assert.deepStrictEqual(a.positions, ['gain', '42']);
  assert.strictEqual(a.par, 'Loïc');
  assert.strictEqual(a.raison, 'ticket 118');
  assert.strictEqual(a.confirme, true);

  assert.strictEqual(OP.lireArguments([]).verbe, '');
  assert.strictEqual(OP.lireArguments(['montrer']).confirme, false);
  assert.match(OP.lireArguments(['--raison']).erreur, /--raison attend une valeur/);
  assert.match(OP.lireArguments(['--raison', '--confirme']).erreur, /--raison attend une valeur/);
  assert.match(OP.lireArguments(['--raion', 'x']).erreur, /option inconnue/);
  assert.match(OP.lireArguments(['--confirme=oui']).erreur, /ne prend pas de valeur/);

  // La traduction des colonnes vers les transferts du grand livre, une seule fois et ici : le fichier
  // pur ne sait pas ce qu'est une colonne.
  const brut = [{ motif: 'mise', reference: '9', compte_debit: 'joueur:3:disponible',
                  compte_credit: 'enjeu:9', montant_cents: 50 }];
  assert.deepStrictEqual(OP.enTransferts(brut), [{ motif: 'mise', reference: '9',
    compteDebit: 'joueur:3:disponible', compteCredit: 'enjeu:9', montantCents: 50 }]);
  assert.deepStrictEqual(OP.enTransferts(null), []);
});

test('GARDE TEXTUELLE : ledger_audit est en INSERTION SEULE, et ses bornes sont celles d\'api/ledger.js', () => {
  // Une trace qu'on peut réécrire ne trace rien. Même garde que sur `ledger_entries`, et pour une
  // raison de plus : c'est la seule pièce qui dira, six mois plus tard, POURQUOI de l'argent a bougé.
  const commente = lireApi('schema.sql');
  const i = commente.indexOf('create table if not exists ledger_audit');
  assert.ok(i > 0, 'la table du journal d\'opération a disparu de schema.sql');
  const entete = commente.slice(commente.lastIndexOf('Phase 04a', i), i);
  assert.match(entete, /INSERTION SEULE/, 'la doctrine a disparu de l\'en-tête de la table');
  assert.match(entete, /MÊME TRANSACTION|PARTAGE LA TRANSACTION/i,
    'la raison d\'être de la table — partager la transaction — n\'est plus écrite à côté d\'elle');
  const sql = SQL_NU();
  assert.ok(!/\bupdate\s+ledger_audit\b/i.test(sql) && !/\bdelete\s+from\s+ledger_audit\b/i.test(sql));
  // ET DANS LE PILOTE : un seul écrivain, aucune modification, aucun `on conflict` qui avalerait.
  const pg = PG_NU();
  for (const q of (pg.match(/`[^`]*`/g) || [])) {
    if (!/ledger_audit/.test(q)) continue;
    assert.ok(!/\bupdate\s+ledger_audit\b/i.test(q), 'un update vise ledger_audit : ' + q);
    assert.ok(!/\bdelete\s+from\s+ledger_audit\b/i.test(q), 'un delete vise ledger_audit : ' + q);
    assert.ok(!/on conflict/i.test(q), 'l\'écriture du journal avale un doublon : ' + q);
  }
  assert.strictEqual((pg.match(/insert into ledger_audit/gi) || []).length, 1,
    'le journal d\'opération doit avoir un seul écrivain');
  assert.strictEqual((pg.match(/^async function ledgerAuditWrite\s*\(/gm) || []).length, 1);

  // LES DEUX LISTES ET LES DEUX BORNES SE CONFRONTENT, exactement comme les motifs du grand livre.
  // Un `check` qui diverge du code se découvre au premier geste réel, c'est-à-dire au pire moment.
  const bloc = sql.slice(sql.indexOf('create table if not exists ledger_audit'));
  const gestes = bloc.match(/check \(geste in \(([^)]*)\)\)/);
  assert.ok(gestes, 'la liste des gestes a disparu du schéma');
  assert.deepStrictEqual((gestes[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)),
    L.AUDIT_GESTES.slice(), 'le schéma et api/ledger.js ne connaissent pas les mêmes gestes');
  // DEUX MEMBRES DEPUIS LE MODULE 6, ET PAS TROIS. Le second est entré le jour où quelque chose
  // l'écrit — le verbe `anonymiser` — et pas d'avance : un membre de liste fermée que personne
  // n'écrit est une case en attente d'être créée de travers, ce que le dossier refuse depuis le
  // motif de libération de quarantaine. Chacun des deux a donc un écrivain, ci-dessous.
  assert.deepStrictEqual(L.AUDIT_GESTES.slice(), ['contrepassation', 'anonymisation']);
  const outil = lireApi('operateur.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  for (const geste of L.AUDIT_GESTES)
    assert.ok(new RegExp(`geste: '${geste}'`).test(lireApi('ledger.js')),
      `le geste ${geste} n'est produit par aucun plan d'api/ledger.js`);
  assert.match(outil, /db\.anonymiser\(/, 'le geste anonymisation n\'a aucun appelant');
  assert.ok(bloc.includes(`check (char_length(raison) between ${L.AUDIT_RAISON_MIN} and ${L.AUDIT_RAISON_MAX})`),
    'les bornes de la raison divergent entre schema.sql et api/ledger.js');
  assert.ok(bloc.includes(`check (char_length(operateur) between 1 and ${L.AUDIT_OPERATEUR_MAX})`),
    'la borne du nom de l\'opérateur diverge entre schema.sql et api/ledger.js');
  // Et la liste des motifs d'origine est bien celle du grand livre, pas une seconde écriture qui
  // dériverait. Elle est relue par le même chemin que celle de `ledger_entries`.
  const motifs = bloc.match(/check \(motif_origine in \(([\s\S]*?)\)\)/);
  assert.ok(motifs, 'la liste des motifs d\'origine a disparu');
  assert.deepStrictEqual((motifs[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)).sort(),
    L.MOTIFS.slice().sort());
  // Aucune case de solde n'est entrée par cette porte-là non plus.
  assert.ok(!/\b(solde|balance|wallet)\b/i.test(bloc));
});

await test('GARDE : api/app.js ne charge JAMAIS api/operateur.js, et il n\'existe aucune route d\'administration', () => {
  // Même patron et même garde que « il n'existe aucune route `POST /api/credits` ». Une route
  // d'administration est une surface d'attaque PERMANENTE pour un geste qui arrive deux fois par an,
  // et elle demanderait une authentification de second ordre que rien d'autre du dossier ne justifie.
  // L'opérateur détient déjà les identifiants de la base : il n'y a rien à lui accorder.
  const app = lireApi('app.js');
  for (const interdit of ['operateur', 'ledger_audit', 'contrepass', 'planCorrection',
                          '/api/admin', '/api/ops', '/api/audit', '/api/contrepassation'])
    assert.ok(!app.includes(interdit), `app.js parle de ${interdit} : une porte d'administration s'ouvre`);
  // Les routes connues sont celles de la table, et elles n'ont pas changé — la même assertion que
  // pour les routes de crédit, relue avec elle.
  const table = app.slice(app.indexOf('const METHODES = new Map'), app.indexOf('const RESULTAT ='));
  assert.deepStrictEqual((table.match(/'\/api\/[a-z]+'/g) || []).sort(), ["'/api/match'", "'/api/me'"]);
  // ET L'OUTIL N'EST PAS UN SERVEUR : il ne parle pas HTTP, il ne s'écoute nulle part. Les
  // commentaires sont retirés d'abord — le même piège que sur `schema.sql` et `db-pg.js`, une fois
  // de plus : « expression » contient « express », et une garde qui lit les commentaires ne garde
  // rien. Cela m'a coûté un aller-retour.
  const outil = lireApi('operateur.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  for (const interdit of ['node:http', 'createServer', 'listen(', 'require(\'express\')'])
    assert.ok(!outil.includes(interdit), `api/operateur.js devient un serveur : ${interdit}`);
  // Il lit ses identifiants de base dans l'environnement, comme `api/main.js`, et aucun secret ne
  // vit dans le dépôt.
  assert.match(outil, /process\.env\.DATABASE_URL/);
  // `contrepasser` est l'UNIQUE appelant de `mouvementContrepassation` dans tout le dossier : la
  // fonction existait depuis la phase 03 sans en avoir un seul.
  const appelants = ['app.js', 'db-pg.js', 'operateur.js', 'ledger.js']
    .map(f => [f, (lireApi(f).match(/mouvementContrepassation\s*\(/g) || []).length]);
  assert.deepStrictEqual(appelants,
    [['app.js', 0], ['db-pg.js', 0], ['operateur.js', 0], ['ledger.js', 2]],
    'la contre-passation a repris un appelant hors de planCorrection');
});

await test('api/operateur.js sans DATABASE_URL affiche l\'aide et SORT 0, sans charger `pg`', () => {
  // La même sémantique et le même piège que `db-check.js` : `npm test` tourne sans base et sans
  // réseau, et l'intégration continue lance `node api/test.js` AVANT `npm install`. Un
  // `require('./db-pg')` en tête de fichier ferait échouer tout le harnais par « module
  // introuvable », c'est-à-dire un code 1 sur une machine parfaitement saine. On LANCE le fichier
  // plutôt que de relire son texte — une garde textuelle ne dit pas ce qu'un processus fait.
  const { spawnSync } = require('node:child_process');
  const chemin = require('node:path').join(__dirname, 'operateur.js');
  const vide = { env: { PATH: process.env.PATH || '' }, encoding: 'utf8' };
  const aide = spawnSync(process.execPath, [chemin], vide);
  assert.strictEqual(aide.status, 0, `operateur.js sort ${aide.status} : ${aide.stderr || aide.stdout}`);
  assert.match(aide.stdout, /montrer mouvement/);
  assert.strictEqual(aide.stderr, '');
  // Et un verbe qui a besoin de la base le dit, au lieu d'échouer sur un module manquant.
  const sans = spawnSync(process.execPath, [chemin, 'montrer', 'mouvement', 'gain', '42'], vide);
  assert.strictEqual(sans.status, 2, sans.stderr || sans.stdout);
  assert.match(sans.stderr, /DATABASE_URL/);
  assert.ok(!/Cannot find module/.test(sans.stderr), sans.stderr);
  // La garde textuelle en second, pour nommer le piège : le `require` du pilote est APRÈS le
  // contrôle. Les commentaires sont retirés d'abord — celui qui explique ce piège le cite.
  const src = lireApi('operateur.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const controle = src.indexOf('process.env.DATABASE_URL'), pilote = src.indexOf('require(\'./db-pg\')');
  assert.ok(controle > 0 && pilote > 0, 'api/operateur.js a changé de forme');
  assert.ok(controle < pilote,
    'api/operateur.js charge `pg` avant de constater l\'absence de DATABASE_URL : les tests échoueraient sans dépendances');
});

await test('db-check.js sans DATABASE_URL SORT 0, et il le dit', () => {
  // La sémantique exacte, et elle n'est pas négociable : `npm test` tourne sans base et sans réseau,
  // donc ce script ne doit bloquer personne. On le LANCE, avec un environnement vidé, plutôt que de
  // relire son texte — une garde textuelle sur un `process.exit(0)` ne dit pas ce que le processus
  // fait vraiment, et le piège ici est un `require('pg')` en tête de fichier, qui ferait échouer le
  // lancement avec un code 1 sur une machine parfaitement saine.
  const { spawnSync } = require('node:child_process');
  const chemin = require('node:path').join(__dirname, 'db-check.js');
  const r = spawnSync(process.execPath, [chemin],
    { env: { PATH: process.env.PATH || '' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `db-check.js sort ${r.status} : ${r.stderr || r.stdout}`);
  assert.match(r.stdout, /DATABASE_URL/, 'il sort 0 sans dire pourquoi');
  assert.match(r.stdout, /doublure/, 'il doit redire ce que son absence laisse non prouvé');
  assert.strictEqual(r.stderr, '', r.stderr);
  // Et le lancement ci-dessus ne prouve cela que sur CETTE machine, où `pg` est peut-être installé.
  // L'intégration continue lance `node api/test.js` AVANT `npm install` : un `require('pg')` en tête
  // de fichier ferait alors échouer le test par « module introuvable », c'est-à-dire un code 1 sur
  // une machine parfaitement saine. Le contrôle de `DATABASE_URL` doit donc précéder le `require`.
  // Les commentaires sont retirés d'abord : celui qui explique ce piège le cite, et une garde qui
  // prend un commentaire pour du code ne garde rien. Le même piège pour la troisième fois.
  const src = lireApi('db-check.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const sortie = src.indexOf('process.exit(0)'), pilote = src.indexOf('require(\'pg\')');
  assert.ok(sortie > 0 && pilote > 0, 'db-check.js a changé de forme');
  assert.ok(sortie < pilote,
    'db-check.js charge `pg` AVANT de constater l\'absence de DATABASE_URL : il échouerait sans dépendances');
});

test('db-check.js n\'entre pas dans npm test, et le job existant reste sans base ni réseau', () => {
  // C'est la seule façon de SOLDER la dette au lieu de la promettre : un job à part, avec son
  // service Postgres, pendant que celui qui existe ne change pas d'une ligne. Sinon le module se
  // clôt sur une intention, et c'est exactement l'écart que la recette de la 02b a trouvé.
  const fs = require('node:fs'), path = require('node:path');
  const racine = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const p of [racine('package.json'), lireApi('package.json')])
    assert.ok(!/db-check/.test(p), 'db-check est entré dans les scripts npm : les tests exigeraient une base');
  const yml = racine('.github/workflows/test.yml');
  const iDb = yml.indexOf('\n  db:');
  assert.ok(iDb > 0, 'le job Postgres n\'existe pas dans l\'intégration continue');
  // Les commentaires du job Postgres sont écrits AVANT lui, donc dans cette tranche-là : sans les
  // retirer, la garde prendrait la phrase qui explique `DATABASE_URL` pour un `DATABASE_URL`. Le
  // même piège que sur `schema.sql` et `db-pg.js`, une troisième fois.
  const existant = yml.slice(yml.indexOf('\n  test:'), iDb).replace(/^[ \t]*#[^\n]*$/gm, '');
  // LE JOB EXISTANT NE CHANGE PAS D'UNE LIGNE, et on le vérifie ligne à ligne : ses quatre étapes,
  // dans cet ordre, et rien d'autre. Une garde qui se contenterait de « il contient encore node
  // test.js » laisserait passer une étape ajoutée à côté — c'est-à-dire exactement la façon dont
  // une base finirait par entrer dans le job qui doit tourner sans base.
  assert.deepStrictEqual((existant.match(/^\s*- run: [^\n]*/gm) || []).map(s => s.trim()),
    ['- run: node test.js', '- run: node api/test.js',
     '- run: npm install --no-audit --no-fund', '- run: node api/test.js']);
  assert.ok(!/services:/.test(existant), 'le job existant a reçu un service : il ne tourne plus sans base');
  assert.ok(!/DATABASE_URL/.test(existant), 'le job existant a reçu une base');
  const job = yml.slice(iDb);
  for (const attendu of ['services:', 'postgres:16', 'pg_isready', 'node api/db-check.js', 'DATABASE_URL'])
    assert.ok(job.includes(attendu), `le job Postgres ne porte pas « ${attendu} »`);
  // Aucun secret dans le dépôt : l'adresse est celle du service du job, une base jetable créée et
  // détruite avec l'exécution.
  assert.match(job, /DATABASE_URL:\s*postgres:\/\/[^\n]*127\.0\.0\.1/);
  assert.ok(!/secrets\./.test(job), 'le job va chercher un secret : la base doit rester jetable');
});

console.log('Un compte ne s\'efface pas, il s\'anonymise');

// LE BANC D'UN COMPTE QUI A VÉCU : une ligne `users`, un billet réglé, et les trois écritures que ce
// billet a laissées. C'est le seul état qui rende la question intéressante — un compte sans histoire
// pourrait être effacé sans que rien ne s'y oppose, et il n'apprendrait rien.
async function bancAnonyme({ id = 1, nom = 'Loïc' } = {}) {
  const db = fakeDb([{ id, auth_id: `crossmint|${id}`, email: `joueur${id}@exemple.test`,
                       name: nom, name_key: C.nameKey(nom), avatar: 'a2', country: 'FR',
                       created_at: '2026-01-01T00:00:00Z' }]);
  const matchId = 4242, miseCents = 50, quand = new Date(T0).toISOString();
  db.matches.push({
    id: matchId, user_id: id, mode: 'solo', stake_cents: miseCents, seats: 20, team_size: 1,
    paid_seats: 1, brawler: BRAWLER, seed_public: 1, seed_secret: SECRETS[0],
    sim_version: SIM.SIM_VERSION, client_key: 'anon', status: 'settled',
    first_result_at: quand, opened_at: quand, expires_at: quand, settled_at: quand,
    issue: 'defaite', controle: null, motif: null,
    gross_cents: 0, fee_cents: 0, net_cents: 0, purse_cents: 0,
    declared_net_cents: null, ecart_cents: null,
    seconds: 1, kills: 0, deaths: 1, rank: 20, cubes: 0, damage: 0, cashed_out: false,
    trace_steps: 1, replay_digest: null, digest_match: true, divergence_step: null, replay_ms: 0,
  });
  await db.ledgerWrite(L.mouvementDotation({ userId: id, montantCents: L.DOTATION_CENTS }));
  await db.ledgerWrite(L.mouvementMise({ userId: id, matchId, miseCents }));
  await db.ledgerWrite(L.mouvementGain({ userId: id, matchId, miseCents, grossCents: 0,
                                         feeCents: 0, netCents: 0, convergee: true }));
  return { db, id, matchId, miseCents };
}
// L'OPÉRATEUR NE PORTE PAS LE MÊME NOM QUE LE JOUEUR, et ce n'est pas de la coquetterie : le test
// vérifie plus bas qu'aucun identifiant de personne ne survit dans `ledger_audit`, et un opérateur
// homonyme du joueur rendrait cette assertion vraie pour la mauvaise raison — ou fausse alors que
// tout va bien. C'est le nom de QUI A SIGNÉ, et il reste écrit ; c'est le nom du JOUEUR qui part.
const ANON_SIGNE = ['--par', 'Astrid', '--raison', 'demande de suppression du 14, ticket 231'];

test('GARDE TEXTUELLE : plus UNE SEULE cascade de users vers matches, ni de matches vers match_traces', () => {
  // Les deux cascades dataient de la phase 01, quand `matches` ne portait aucun montant. Depuis la
  // phase 03, ces lignes sont les PIÈCES JUSTIFICATIVES de mouvements d'argent qui, eux, restent :
  // `ledger_entries` est en insertion seule et nomme ses comptes avec `users.id` et `matches.id`.
  // Un `delete from users` détruisait donc la pièce et laissait l'écriture pointer dans le vide.
  const sql = SQL_NU();
  assert.match(sql, /user_id\s+bigint\s+not null references users\(id\) on delete restrict/,
    'la cascade de matches vers users est encore là');
  assert.match(sql, /match_id\s+bigint\s+not null references matches\(id\) on delete restrict/,
    'la cascade de match_traces vers matches est encore là');
  assert.ok(!/on delete cascade/i.test(sql), 'une cascade a survécu dans schema.sql');
  // ET TOUTES les clés étrangères du schéma portent `restrict`, comptées une par une : une
  // quatrième qui entrerait en cascade passerait sous les deux assertions ci-dessus.
  const fks = sql.match(/references \w+\(id\)[^,\n]*/g) || [];
  assert.strictEqual(fks.length, 3,
    `${fks.length} clés étrangères : matches.user_id, match_traces.match_id, ledger_audit.user_id`);
  for (const fk of fks) assert.match(fk, /on delete restrict/, fk);
  // LA RAISON EST ÉCRITE À CÔTÉ, et sur le texte COMMENTÉ : ailleurs, elle serait une intention que
  // rien ne rappelle à celui qui rouvrira le fichier pour « simplifier ».
  const commente = lireApi('schema.sql');
  const entete = commente.slice(commente.lastIndexOf('-- LA CASCADE', commente.indexOf('create table if not exists matches')),
                                commente.indexOf('create table if not exists matches'));
  assert.match(entete, /restrict/);
  assert.match(entete, /pièces justificatives|PIÈCES JUSTIFICATIVES/i,
    'la raison du renversement n\'est plus écrite au-dessus de la table');
  assert.match(entete, /anonymise/i, 'le geste qui remplace la suppression n\'est pas nommé');
});

test('LE NOM D\'UN COMPTE ANONYMISÉ TIENT DANS LA COLONNE, y compris sur un id de dix-neuf chiffres', () => {
  // C'est le point sur lequel ce module se serait trompé : l'anonymisation est une RÉÉCRITURE SOUS
  // CONTRAINTES, pas une suppression de colonnes. `auth_id`, `email`, `name` et `name_key` sont
  // toutes `not null`, deux d'entre elles sont uniques, et deux `check` bornent les longueurs.
  const MAX = '9223372036854775807';
  for (const id of ['1', '9', '42', '1000000', '9007199254740993', MAX]) {
    const nom = L.nomAnonyme(id);
    assert.strictEqual(nom, 'x' + BigInt(id).toString(36));
    assert.ok(nom.length >= L.USERS_NOM_MIN && nom.length <= L.USERS_NOM_MAX,
      `« ${nom} » fait ${nom.length} caractères`);
    const cle = C.nameKey(nom);
    assert.ok(cle.length >= L.USERS_CLE_MIN && cle.length <= L.USERS_CLE_MAX, cle);
    // Le nom anonyme survit à `sanitizeName` sans perdre un caractère : s'il en perdait, deux
    // identifiants voisins pourraient se replier sur la même clé.
    assert.strictEqual(cle, nom);
    assert.strictEqual(L.authIdAnonyme(id), `anonyme:${id}`);
    assert.strictEqual(L.emailAnonyme(id), `anonyme+${id}@invalid`);
  }
  // LE MAXIMUM D'UN `bigserial` TIENT EXACTEMENT DANS LA COLONNE, et c'est ce qui justifie la base
  // 36 : en base 10 il aurait fallu vingt caractères pour quatorze disponibles.
  assert.strictEqual(L.nomAnonyme(MAX).length, L.USERS_NOM_MAX);
  assert.ok(('x' + BigInt(MAX).toString(10)).length > L.USERS_NOM_MAX,
    'la base 36 ne sert plus à rien : la base 10 tiendrait');
  // ET LE PIÈGE DE PRÉCISION EST ÉPROUVÉ, PAS SUPPOSÉ : `Number` arrondit au-delà de 2^53, donc deux
  // comptes voisins recevraient le même nom, donc la même clé, donc une collision inexplicable. Le
  // pilote Postgres rend les `bigint` en CHAÎNE précisément pour cela.
  assert.notStrictEqual(L.nomAnonyme(MAX), 'x' + Number(MAX).toString(36));
  assert.strictEqual(L.nomAnonyme('9007199254740993'), 'x' + BigInt('9007199254740993').toString(36));
  assert.notStrictEqual(L.nomAnonyme('9007199254740993'), L.nomAnonyme('9007199254740992'));
  // LES BORNES SONT CELLES DE LA COLONNE ET CELLES DU JEU, et les trois écritures se confrontent :
  // `schema.sql`, `api/ledger.js`, `WBCore.NAME`. Deux d'entre elles qui divergeraient ne se
  // verraient qu'au premier compte anonymisé.
  const sql = SQL_NU();
  assert.ok(sql.includes(`check (char_length(name) between ${L.USERS_NOM_MIN} and ${L.USERS_NOM_MAX})`), sql);
  assert.ok(sql.includes(`check (char_length(name_key) between ${L.USERS_CLE_MIN} and ${L.USERS_CLE_MAX})`), sql);
  assert.strictEqual(L.USERS_NOM_MAX, C.NAME.max);
  assert.strictEqual(L.USERS_NOM_MIN, C.NAME.min);
});

await test('UN COMPTE ANONYMISÉ CONSERVE SON id : joueur:<id> et enjeu:<match_id> restent des comptes valides', async () => {
  // La propriété entière du module. Le grand livre est immortel et nomme ses comptes avec `users.id`
  // et `matches.id` : déplacer l'identifiant ferait pointer des écritures qu'on ne peut pas corriger
  // sur des lignes qui n'existent plus.
  const { db, id, matchId } = await bancAnonyme({ id: '9223372036854775807' });
  reconcilier(db, 'avant l\'anonymisation');
  const comptes = [L.compteJoueur(id), L.compteQuarantaine(id), L.compteEnjeu(matchId)];
  const avant = comptes.map(c => L.soldeDe(livreDe(db), c));
  const ecritures = db.ledger.length;

  const outil = bancOutil(db);
  assert.strictEqual(await outil.lancer(['anonymiser', id, ...ANON_SIGNE, '--confirme']), 0, outil.texte());

  assert.strictEqual(db.users[0].id, id, 'l\'identifiant du compte a bougé');
  assert.strictEqual(db.matches[0].user_id, id, 'le billet a changé de propriétaire');
  for (const c of comptes) assert.ok(L.compteValide(c), `${c} n'est plus un compte valide`);
  assert.deepStrictEqual(comptes.map(c => L.soldeDe(livreDe(db), c)), avant,
    'l\'anonymisation a déplacé de l\'argent');
  assert.strictEqual(db.ledger.length, ecritures, 'l\'anonymisation a écrit dans le grand livre');
  reconcilier(db, 'après l\'anonymisation');
  zeroGlobal(db, 'après l\'anonymisation');
});

await test('LES IDENTIFIANTS DE PERSONNE SONT PARTIS, et la trace ne les garde pas non plus', async () => {
  const { db, id } = await bancAnonyme({ nom: 'Loïc' });
  const avant = { ...db.users[0] };
  const outil = bancOutil(db);
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 0, outil.texte());

  const u = db.users[0];
  assert.strictEqual(u.auth_id, `anonyme:${id}`);
  assert.strictEqual(u.email, `anonyme+${id}@invalid`);
  assert.strictEqual(u.name, L.nomAnonyme(id));
  assert.strictEqual(u.name_key, C.nameKey(u.name));
  assert.strictEqual(u.avatar, '');
  assert.strictEqual(u.country, null);
  // `.invalid` est un domaine de premier niveau RÉSERVÉ : il n'est routable nulle part, jamais.
  assert.ok(u.email.endsWith('@invalid'));
  // Et RIEN de l'ancienne identité ne survit dans la ligne, ni de près ni de loin.
  const ligne = JSON.stringify(u);
  for (const parti of [avant.auth_id, avant.email, avant.name, avant.name_key, avant.avatar, avant.country])
    assert.ok(!ligne.includes(parti), `« ${parti} » est resté sur la ligne`);
  // LA TRACE NON PLUS NE LES GARDE PAS, et c'est délibéré : un journal d'audit qui conserverait
  // l'ancien email n'anonymiserait rien du tout. Ce qu'il garde, c'est QUI, QUAND et POURQUOI.
  const t = db.ledgerAudit[0];
  const trace = JSON.stringify(t);
  for (const parti of [avant.auth_id, avant.email, avant.name])
    assert.ok(!trace.includes(parti), `« ${parti} » est resté dans ledger_audit`);
  // L'OPÉRATEUR, LUI, L'A VU AVANT DE CONFIRMER : la sortie de terminal est la seule mémoire de ce
  // qu'il avait sous les yeux, et elle ne va nulle part en base.
  assert.ok(outil.texte().includes(avant.email), 'l\'outil n\'a pas montré ce qui allait disparaître');
  assert.ok(outil.texte().includes(avant.auth_id));
});

await test('L\'ANCIEN PSEUDO REDEVIENT DISPONIBLE, et l\'historique se lit alors sur l\'id', async () => {
  const { db, id } = await bancAnonyme({ nom: 'Loïc' });
  // AVANT : le pseudo est pris, et `findOrCreate` suffixe plutôt que d'échouer au nez du nouveau.
  const occupe = await db.findOrCreate({ authId: 'crossmint|second', email: 'b@x.test',
                                         name: 'Loïc', nameKey: C.nameKey, at: T0 });
  assert.notStrictEqual(occupe.user.name_key, C.nameKey('Loïc'), 'le pseudo n\'était donc pas pris');

  const outil = bancOutil(db);
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 0, outil.texte());

  // APRÈS : un nouveau venu obtient le pseudo EXACT, sans suffixe. C'est voulu, et c'est le prix.
  const repris = await db.findOrCreate({ authId: 'crossmint|tiers', email: 'c@x.test',
                                         name: 'Loïc', nameKey: C.nameKey, at: T0 });
  assert.strictEqual(repris.user.name, 'Loïc');
  assert.strictEqual(repris.user.name_key, C.nameKey('Loïc'));
  // LE COROLLAIRE, ET IL EST À CONNAÎTRE : deux personnes différentes ont porté ce pseudo, donc toute
  // lecture d'historique par le NOM les confondrait. Le billet du premier reste attaché à son id.
  assert.notStrictEqual(repris.user.id, id);
  assert.strictEqual(db.matches[0].user_id, id);
  assert.strictEqual(db.matches.filter(m => m.user_id === repris.user.id).length, 0,
    'le nouveau venu hérite de l\'historique de l\'ancien : la jointure se fait par le nom');
  assert.match(OP.AIDE, /l'historique d'un joueur se/i);
});

await test('L\'ANONYMISATION ET SA RAISON PARTAGENT LA TRANSACTION, et le geste est REFUSÉ sans raison écrite', async () => {
  // La même propriété que pour la contre-passation, et la même raison : un compte réécrit sans qu'on
  // sache pourquoi est indistinguable d'une erreur de manipulation, et ce geste-là ne se défait pas.
  const { db, id } = await bancAnonyme();
  const outil = bancOutil(db);
  const identite = { ...db.users[0] };

  // SANS RAISON, ET SANS NOM : rien n'est écrit, et le refus est nommé.
  for (const [argv, code] of [
    [['anonymiser', String(id), '--par', 'Astrid', '--confirme'], 'raison_vide'],
    // Les blancs ne comptent pas : sinon « pourquoi » serait une case à cocher, et une espace
    // suffirait à la cocher.
    [['anonymiser', String(id), '--par', 'Astrid', '--raison', '   ', '--confirme'], 'raison_vide'],
    [['anonymiser', String(id), '--raison', 'ticket 231', '--confirme'], 'operateur_vide'],
  ]) {
    outil.lignes.length = 0;
    assert.strictEqual(await outil.lancer(argv), 1, argv.join(' '));
    assert.match(outil.texte(), new RegExp(`REFUSÉ \\(${code}\\)`));
    assert.deepStrictEqual({ ...db.users[0] }, identite, 'la ligne a été réécrite malgré le refus');
    assert.strictEqual(db.ledgerAudit.length, 0);
  }

  // ET LA SECONDE MOITIÉ QUI ÉCHOUE NE LAISSE AUCUNE RÉÉCRITURE. C'est ce que la doublure sait
  // imiter, et ce qu'elle ne sait pas PROUVER : elle décide de l'ordre de ses `await`. Seul
  // `api/db-check.js` fait arbitrer ce `rollback` par Postgres.
  outil.lignes.length = 0;
  db.panne.audit = () => true;
  await assert.rejects(() => outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']),
    e => e.code === '23514');
  assert.deepStrictEqual({ ...db.users[0] }, identite,
    'la ligne users a été réécrite alors que sa raison n\'a pas pu être consignée');
  assert.strictEqual(db.ledgerAudit.length, 0);

  // Sans la panne, les deux arrivent ENSEMBLE.
  db.panne.audit = null;
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 0, outil.texte());
  assert.match(outil.texte(), /ANONYMISÉ/);
  assert.strictEqual(db.ledgerAudit.length, 1);
  const t = db.ledgerAudit[0];
  assert.strictEqual(t.geste, 'anonymisation');
  assert.strictEqual(t.operateur, 'Astrid');
  assert.strictEqual(t.raison, 'demande de suppression du 14, ticket 231');
  assert.strictEqual(t.user_id, String(id));
  // UNE ANONYMISATION NE BOUGE PAS UN CENTIME, et les cinq colonnes d'argent sont NULLES — pas zéro.
  // Un zéro se lirait comme un montant nul, donc comme une correction du livre qui n'a rien corrigé.
  for (const vide of ['motif_origine', 'reference_origine', 'reference_posee', 'jambes', 'montant_cents'])
    assert.strictEqual(t[vide], null, `${vide} devrait être nul sur une anonymisation`);
  assert.ok(Object.isFrozen(t));
  assert.throws(() => { t.raison = 'autre chose'; }, TypeError);
  // ET LA TRACE SE RELIT PAR L'OUTIL, par le COMPTE et non par un mouvement : l'anonymisation ne
  // porte sur aucune écriture du livre, donc `montrer mouvement` ne la retrouverait jamais.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['montrer', 'exposition', String(id)]), 0);
  assert.match(outil.texte(), /anonymisation par Astrid/);
  assert.match(outil.texte(), /ticket 231/);
});

await test('UNE COLLISION SUR name_key EST DITE, et l\'outil S\'ARRÊTE au lieu de deviner', async () => {
  // Le nom anonyme est `x<id en base 36>` : quelqu'un peut parfaitement porter ce pseudo-là.
  // `findOrCreate` réessaie avec un suffixe à l'inscription, et c'est le bon geste À CET ENDROIT —
  // il arrange un joueur qui ne remarquera rien. Ici, ce serait décider à la place d'un opérateur,
  // sur un geste rare, manuel et irréversible.
  const { db, id } = await bancAnonyme();
  const squatte = L.nomAnonyme(id);
  db.users.push({ id: 77, auth_id: 'crossmint|squatteur', email: 'sq@exemple.test', name: squatte,
                  name_key: C.nameKey(squatte), avatar: '', country: null,
                  created_at: '2026-01-01T00:00:00Z' });
  const identite = { ...db.users[0] };
  const outil = bancOutil(db);

  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 1);
  // Elle est DITE, avec la contrainte qui a refusé, et pas rendue en pile d'appels.
  assert.match(outil.texte(), /REFUSÉ \(collision\)/);
  assert.match(outil.texte(), /users_name_key_key/);
  assert.match(outil.texte(), new RegExp(`Quelqu'un porte déjà « ${squatte} »`));
  assert.match(outil.texte(), /deviner à ta place serait pire/);
  // ET RIEN N'A ÉTÉ ÉCRIT, ni la ligne, ni sa raison.
  assert.deepStrictEqual({ ...db.users[0] }, identite);
  assert.strictEqual(db.ledgerAudit.length, 0);

  // L'identité anonyme déjà prise par quelqu'un d'autre est refusée de la même façon.
  db.users[1].name = 'Libre'; db.users[1].name_key = C.nameKey('Libre');
  db.users[1].auth_id = L.authIdAnonyme(id);
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 1);
  assert.match(outil.texte(), /users_auth_id_key/);
  assert.strictEqual(db.ledgerAudit.length, 0);
});

await test('anonymiser MONTRE avant d\'écrire, et rejouer le geste ne réécrit rien', async () => {
  const { db, id } = await bancAnonyme();
  const outil = bancOutil(db);
  const identite = { ...db.users[0] };

  // SANS `--confirme`, c'est un verbe de lecture de plus, et il le dit.
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE]), 0);
  assert.match(outil.texte(), /ce qui disparaît/);
  assert.match(outil.texte(), /ce qui est écrit à la place/);
  assert.match(outil.texte(), new RegExp(`l'identifiant ${id} NE BOUGE PAS`));
  assert.match(outil.texte(), /RIEN N'A ÉTÉ ÉCRIT/);
  assert.deepStrictEqual({ ...db.users[0] }, identite);
  assert.strictEqual(db.ledgerAudit.length, 0);

  // Un identifiant illisible est refusé AVANT de partir en SQL : `where id = $1` sur « abc » lève
  // `22P02`, et l'opérateur lirait une pile d'appels au lieu d'une phrase.
  for (const mauvais of ['abc', '007', '0', '-1'])
    assert.strictEqual(await outil.lancer(['anonymiser', mauvais, ...ANON_SIGNE, '--confirme']), 2, mauvais);
  // Un compte qui n'existe pas est un refus NOMMÉ, pas une panne.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['anonymiser', '999', ...ANON_SIGNE, '--confirme']), 1);
  assert.match(outil.texte(), /REFUSÉ \(compte_inconnu\)/);

  // LE GESTE, PUIS SON REJEU. Un opérateur qui relance parce que sa connexion a lâché doit lire
  // « c'était déjà fait » : réécrire n'aurait rien cassé, mais aurait consigné une SECONDE raison,
  // donc raconté deux gestes là où il n'y en a eu qu'un.
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 0, outil.texte());
  const apres = { ...db.users[0] };
  outil.lignes.length = 0;
  assert.strictEqual(await outil.lancer(['anonymiser', String(id), ...ANON_SIGNE, '--confirme']), 0,
    'le rejeu doit sortir proprement, pas en erreur');
  assert.match(outil.texte(), /DÉJÀ ANONYMISÉ/);
  assert.deepStrictEqual({ ...db.users[0] }, apres);
  assert.strictEqual(db.ledgerAudit.length, 1, 'le rejeu a consigné une seconde raison');
});

test('planAnonymisation est PURE et rend ses refus, elle ne lance pas', () => {
  // Même discipline que `planCorrection` : un opérateur qui lit une pile d'appels un dimanche soir
  // n'apprend rien, et ces refus sont des cas normaux.
  const ligne = { id: 3, auth_id: 'crossmint|3', email: 'a@x.test', name: 'Loïc',
                  name_key: C.nameKey('Loïc'), avatar: 'a1', country: 'FR' };
  const bon = { par: 'Loïc', raison: 'ticket 231', nameKey: C.nameKey };
  assert.strictEqual(L.planAnonymisation(ligne, bon).ok, true);
  assert.strictEqual(L.planAnonymisation(null, bon).code, 'compte_inconnu');
  assert.strictEqual(L.planAnonymisation({ ...ligne, id: '007' }, bon).code, 'compte_inconnu');
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, par: '  ' }).code, 'operateur_vide');
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, par: 'x'.repeat(L.AUDIT_OPERATEUR_MAX + 1) }).code,
    'operateur_trop_long');
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, raison: ' ' }).code, 'raison_vide');
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, raison: 'x'.repeat(L.AUDIT_RAISON_MAX + 1) }).code,
    'raison_trop_longue');
  assert.strictEqual(L.planAnonymisation({ ...ligne, auth_id: L.authIdAnonyme(3) }, bon).code,
    'deja_anonymise');
  // LA CLÉ EST INJECTÉE, ET SON ABSENCE EST UN REFUS ET PAS UN PLANTAGE : `api/ledger.js` porte une
  // garde de pureté qui lui interdit tout `require`, donc il ne peut pas aller chercher `WBCore`.
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, nameKey: undefined }).code, 'cle_indisponible');
  // Une dérivation qui rendrait n'importe quoi est arrêtée ici, là où la contrainte de la colonne se
  // lit avec le nom fabriqué. C'est la raison pour laquelle le nom est calculé en JavaScript et pas
  // en SQL : les deux moitiés de la règle sont au même endroit.
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, nameKey: () => '' }).code, 'cle_hors_bornes');
  assert.strictEqual(L.planAnonymisation(ligne, { ...bon, nameKey: () => 'x'.repeat(15) }).code,
    'cle_hors_bornes');
  // Le plan est GELÉ, comme celui d'une correction : un pilote ne retouche pas ce qu'il exécute.
  const plan = L.planAnonymisation(ligne, bon);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.apres) && Object.isFrozen(plan.avant));
  assert.strictEqual(plan.geste, 'anonymisation');
  // Et elle ne TOUCHE rien : c'est un plan, pas une écriture.
  assert.strictEqual(ligne.auth_id, 'crossmint|3');
});

test('LA SURFACE DE RÉGRESSION DE CE MODULE EST VIDE, et c\'est un TEST qui le dit', () => {
  // Il faut le présenter comme tel plutôt que le prétendre prouvé : il n'existe AUJOURD'HUI aucune
  // route ni aucune méthode qui supprime un compte, donc le passage des cascades en `restrict` ne
  // peut rien casser. Son seul effet observable est un REFUS, et un refus de contrainte ne se
  // constate que contre une vraie base. C'est vrai aujourd'hui SEULEMENT, et c'est pour cela que la
  // phrase est ici, sous forme d'assertions, et pas dans une relecture.
  const app = lireApi('app.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  for (const interdit of ['delete from users', 'deleteUser', 'supprimerCompte', 'anonymiser'])
    assert.ok(!app.includes(interdit), `app.js parle de ${interdit} : une route de suppression s'ouvre`);
  assert.ok(!/'DELETE'|"DELETE"/.test(app), 'une route DELETE est apparue');
  // Le pilote n'a QU'UN `delete`, et c'est la purge nommée de `match_traces` — l'unique exception
  // écrite du dépôt. Aucun autre effacement n'existe, donc aucun ne peut être refusé par surprise.
  const effacements = (PG_NU().match(/delete\s+from\s+\w+/gi) || []).map(s => s.toLowerCase().replace(/\s+/g, ' '));
  assert.deepStrictEqual(effacements, ['delete from match_traces']);
  // Et la doublure n'expose aucun chemin de suppression non plus, à l'exception NOMMÉE qui existe
  // depuis la phase 03 : la purge des traces, à ses quatre conditions.
  const db = fakeDb();
  assert.deepStrictEqual(Object.keys(db).filter(k => /suppr|delete|efface|purge/i.test(k)),
    ['purgeTraces']);
  // CE QUI RESTE À PROUVER EST NOMMÉ, ET IL EST AILLEURS : `api/db-check.js` fait SUBIR la contrainte
  // à une vraie base. Une doublure ne peut pas subir une contrainte, elle ne fait que l'imiter.
  const check = lireApi('db-check.js');
  assert.match(check, /delete from users/, 'la seule preuve du refus n\'est plus dans db-check.js');
  assert.match(check, /matches_user_id_fkey/, 'le refus n\'est pas attribué à une contrainte nommée');
});

test('UN NETTOYAGE DE db-check.js QUI EFFACE UN COMPTE DESCEND L\'ARBRE ENTIER : `restrict` ne pardonne pas', () => {
  // LA GARDE QUI MANQUAIT, ET QUI A LAISSÉ PASSER UN JOB ROUGE. Le test ci-dessus se contentait de
  // chercher les chaînes `delete from users` et `matches_user_id_fkey` dans `db-check.js` : le
  // `refuse(...)` volontaire du cas « UN delete from users EST REFUSÉ » suffit à les lui donner. Il
  // prenait donc la ligne cassée pour la preuve que rien n'était cassé.
  //
  // CE QUE LE MODULE 6 A CHANGÉ SANS TOUCHER UN SEUL NETTOYAGE : les deux clés étrangères sont
  // passées en `restrict`, donc aucun `delete from users` n'emporte plus ni les billets ni les
  // traces. Un cas qui POSE un billet puis efface son joueur sort en `23503`, part rouge — et s'il
  // avait validé sa transaction de montage, la pollution reste EN BASE : au lancement suivant,
  // `creerJoueur` bute sur l'index unique d'`auth_id` et le cas ne peut plus jamais repasser sans
  // qu'un humain ouvre `psql`. C'est le pire mode de défaillance d'une recette d'intégration.
  //
  // La garde ne regarde que les nettoyages RÉELS : les `refuse(...)` sont retirés d'abord, puisque
  // leur `delete from users` est précisément l'effacement qu'on veut voir échouer, et le titre du
  // cas aussi — l'un d'eux contient la chaîne en toutes lettres.
  const source = lireApi('db-check.js').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const blocs = source.replace(/await refuse\([\s\S]*?\);/g, ' ').split(/await cas\(/).slice(1);
  let vus = 0;
  for (const bloc of blocs) {
    const titre = (bloc.match(/^\s*'((?:[^'\\]|\\.)*)'/) || [])[1] || '(sans titre)';
    // Le titre porte le nom du cas, pas son code : il ne doit pas répondre à la place du nettoyage.
    const corps = bloc.slice(bloc.indexOf("'", bloc.indexOf(titre) + titre.length));
    if (!/delete\s+from\s+users/.test(corps)) continue;
    // Un cas qui n'ouvre aucun billet n'a rien à descendre : la garde ne lui demande rien.
    if (!/ouvrirBillet\(|insert into matches/.test(corps)) continue;
    vus++;
    assert.match(corps, /delete\s+from\s+matches/,
      `« ${titre} » efface son joueur sans effacer ses billets : matches_user_id_fkey refusera`);
    if (/insert into match_traces/.test(corps)) {
      assert.match(corps, /delete\s+from\s+match_traces/,
        `« ${titre} » efface ses billets sans effacer leurs traces : match_traces_match_id_fkey refusera`);
    }
    // ET L'ORDRE EST CELUI DES CLÉS ÉTRANGÈRES, des traces vers le compte. Effacer `matches` avant
    // `match_traces` échoue tout autant, et l'erreur serait attribuée à l'autre contrainte.
    const iTraces = corps.search(/delete\s+from\s+match_traces/);
    const iMatches = corps.search(/delete\s+from\s+matches\b/);
    const iUsers = corps.search(/delete\s+from\s+users/);
    if (iTraces >= 0) assert.ok(iTraces < iMatches, `« ${titre} » efface matches avant match_traces`);
    assert.ok(iMatches < iUsers, `« ${titre} » efface users avant matches`);
  }
  assert.ok(vus >= 4, `${vus} nettoyages de compte examinés : la garde ne regarde plus rien`);
});

test('LE TROU QUI RESTE EST ÉCRIT, NOMMÉ ET CHIFFRÉ : findOrCreate cherche par auth_id', () => {
  // `findOrCreate` retrouve un compte par `auth_id`. Un joueur anonymisé qui se reconnecte avec le
  // même email obtient donc une ligne NEUVE — son `auth_id` Crossmint n'est plus dans la base — et
  // une nouvelle DOTATION_CENTS. C'est un robinet à crédits, dans la phase qui existe pour borner ce
  // que la maison émet, et il est écrit plutôt que découvert.
  const pg = PG_NU();
  const trouve = pg.slice(pg.indexOf('async findOrCreate('), pg.indexOf('async updateProfile('));
  assert.ok(trouve.length > 200, 'findOrCreate n\'a pas été retrouvé');
  assert.match(trouve, /from users where auth_id = \$1/,
    'findOrCreate ne cherche plus par auth_id : le trou ci-dessous a changé de forme');
  assert.match(trouve, /mouvementDotation/, 'la dotation n\'est plus écrite à la création');
  // CE QUI LE TIENT AUJOURD'HUI : le robinet exige que l'OPÉRATEUR l'ouvre lui-même, un compte à la
  // fois, en ligne de commande. Il n'existe aucune route qui demande l'anonymisation.
  const app = lireApi('app.js');
  assert.ok(!app.includes('anonymis'), 'une route demande l\'anonymisation : le robinet est ouvert au client');
  assert.match(lireApi('operateur.js'), /anonymiser <userId>/, 'le seul chemin n\'est plus l\'outil');
  // ET IL EST CHIFFRÉ AUX DEUX ENDROITS QUI COMPTENT, pour que le jour où une route de suppression
  // existera, personne n'ait à le redécouvrir : une table, un index unique, une lecture, un test.
  for (const [f, texte] of [['api/README.md', lireApi('README.md')],
                            ['docs/HISTORIQUE.md', require('node:fs').readFileSync(
                              require('node:path').join(__dirname, '..', 'docs', 'HISTORIQUE.md'), 'utf8')]]) {
    const i = texte.indexOf('robinet à crédits');
    assert.ok(i > 0, `${f} ne nomme pas le robinet à crédits`);
    const autour = texte.slice(i - 1500, i + 1500);
    // Le montant est écrit en français — « 5 000 » — donc l'espace des milliers est optionnelle
    // dans la garde, mais le CHIFFRE vient de `DOTATION_CENTS` et pas d'un littéral recopié.
    const chiffre = String(L.DOTATION_CENTS).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s?');
    assert.match(autour, new RegExp(chiffre), `${f} ne chiffre pas ce que le robinet verse`);
    assert.match(autour, /empreinte/, `${f} ne dit pas ce qu'il faudra construire`);
    assert.match(autour, /insertion seule/, `${f} ne dit pas de quelle nature est la table à venir`);
  }
});

console.log('Lecture de la clé d\'API Crossmint');
test('le base58 fait l\'aller-retour, zéros de tête compris', () => {
  for (let essai = 0; essai < 200; essai++) {
    const n = 1 + Math.floor(Math.random() * 40);
    const octets = crypto.randomBytes(n);
    // Les zéros de tête sont là où les implémentations naïves perdent des octets : on en force.
    for (let i = 0; i < essai % 4 && i < n; i++) octets[i] = 0;
    assert.deepStrictEqual(base58Decode(base58Encode(octets)), octets);
  }
  assert.deepStrictEqual(base58Decode(base58Encode(Buffer.alloc(0))), Buffer.alloc(0));
});
test('un caractère hors alphabet est refusé, pas interprété', () => {
  // « 0 », « O », « I » et « l » n'existent pas en base58 : ce sont ceux qu'on confond en recopiant.
  for (const c of ['0', 'O', 'I', 'l', '+', '/', '=']) assert.throws(() => base58Decode('ab' + c));
});
test('une vraie clé signée est acceptée, et livre son identifiant de projet', () => {
  const a = autorite();
  const r = parseApiKey(fabriqueCle(a, { prefix: 'sk_production', projectId: 'proj_warblock' }),
    { usageOrigin: 'server', signers: a.signers });
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.projectId, 'proj_warblock');
  assert.strictEqual(r.environment, 'production');
  assert.strictEqual(r.usageOrigin, 'server');
});
test('une clé dont on a changé un caractère est refusée', () => {
  const a = autorite();
  const cle = fabriqueCle(a);
  const abime = cle.slice(0, -2) + (cle.endsWith('z') ? 'a' : 'z');
  const r = parseApiKey(abime, { usageOrigin: 'server', signers: a.signers });
  assert.ok(!r.ok, 'une clé abîmée ne doit jamais passer');
});
test('une clé fabriquée par quelqu\'un d\'autre est refusée', () => {
  // Le pirate connaît le format, l'identifiant de projet, tout — sauf la clé privée de Crossmint.
  const vrai = autorite(), pirate = autorite();
  const r = parseApiKey(fabriqueCle(pirate, { projectId: 'proj_warblock' }),
    { usageOrigin: 'server', signers: vrai.signers });
  assert.ok(!r.ok);
  assert.match(r.message, /[Ss]ignature/);
});
test('la clé du jeu ne peut pas servir de clé serveur', () => {
  const a = autorite();
  const r = parseApiKey(fabriqueCle(a, { prefix: 'ck_production' }), { usageOrigin: 'server', signers: a.signers });
  assert.ok(!r.ok);
  assert.match(r.message, /ck_/, 'le message doit dire laquelle des deux clés on attend');
});
test('une clé staging ne passe pas là où la production est exigée', () => {
  const a = autorite();
  const cle = fabriqueCle(a, { prefix: 'sk_staging' });
  assert.ok(parseApiKey(cle, { usageOrigin: 'server', signers: a.signers }).ok);
  assert.ok(!parseApiKey(cle, { usageOrigin: 'server', environment: 'production', signers: a.signers }).ok);
});
test('une clé signée pour staging ne devient pas une clé de production en changeant l\'étiquette', () => {
  // La signature porte sur « préfixe.données » : renommer le préfixe la casse.
  const a = autorite();
  const staging = fabriqueCle(a, { prefix: 'sk_staging' });
  const maquille = 'sk_production_' + staging.slice('sk_staging_'.length);
  assert.ok(!parseApiKey(maquille, { usageOrigin: 'server', signers: a.signers }).ok);
});
test('l\'ancien format de clé est nommé, pas seulement refusé', () => {
  assert.match(parseApiKey('sk_live_abcdef').message, /console/);
  assert.match(parseApiKey('sk_test_abcdef').message, /console/);
});
test('une clé absente, vide ou malformée ne fait pas tomber la lecture', () => {
  for (const mauvaise of [undefined, null, '', 42, {}, 'bonjour', 'sk_', 'sk_prod_x', 'sk_production_', 'sk_production_!!']) {
    const r = parseApiKey(mauvaise);
    assert.strictEqual(r.ok, false, String(mauvaise));
    assert.ok(r.message, 'un refus doit toujours dire pourquoi');
  }
});
test('l\'environnement décide du trousseau public, et staging n\'est pas production', () => {
  assert.strictEqual(jwksUri('production'), 'https://www.crossmint.com/.well-known/jwks.json');
  assert.strictEqual(jwksUri('staging'), 'https://staging.crossmint.com/.well-known/jwks.json');
  assert.notStrictEqual(jwksUri('staging'), jwksUri('production'));
  assert.strictEqual(jwksUri('lune'), null);
});

console.log('Ce qu\'un jeton Crossmint doit prouver');
test('un jeton du bon projet donne l\'identité', () => {
  const id = identityFromClaims(revendications(), { projectId: PROJET });
  assert.strictEqual(id.authId, 'user_1');
  assert.strictEqual(id.email, 'joueur@exemple.test');
});
test('un jeton émis pour un autre projet est refusé', () => {
  // C'est le contrôle que le SDK du fournisseur ne fait pas : le jeton est signé par la bonne
  // autorité et parfaitement valide, il appartient simplement à quelqu'un d'autre.
  assert.throws(() => identityFromClaims(revendications({ aud: 'proj_voisin' }), { projectId: PROJET }),
    /autre projet/);
});
test('un jeton sans destinataire est refusé', () => {
  assert.throws(() => identityFromClaims(revendications({ aud: undefined }), { projectId: PROJET }),
    /autre projet/);
});
test('un destinataire en liste est accepté s\'il nous contient, refusé sinon', () => {
  assert.ok(identityFromClaims(revendications({ aud: ['autre', PROJET] }), { projectId: PROJET }).authId);
  assert.throws(() => identityFromClaims(revendications({ aud: ['autre', 'encore'] }), { projectId: PROJET }));
});
test('un jeton sans expiration est refusé', () => {
  // Sans `exp`, jose n'a rien à comparer : le jeton serait éternel, et un vol de session aussi.
  assert.throws(() => identityFromClaims(revendications({ exp: undefined }), { projectId: PROJET }), /expiration/);
  assert.throws(() => identityFromClaims(revendications({ exp: 'bientôt' }), { projectId: PROJET }), /expiration/);
});
test('un jeton sans sujet est refusé', () => {
  for (const sub of [undefined, '', '   ', 42, null])
    assert.throws(() => identityFromClaims(revendications({ sub }), { projectId: PROJET }), /sujet/);
});
test('sans identifiant de projet à comparer, rien ne passe', () => {
  assert.throws(() => identityFromClaims(revendications(), {}), /projet/);
  assert.throws(() => identityFromClaims(revendications(), { projectId: '' }), /projet/);
});
test('un jeton vide ou d\'un type inattendu est refusé sans casser', () => {
  for (const p of [undefined, null, 'abc', 42, []])
    assert.throws(() => identityFromClaims(p, { projectId: PROJET }));
});
test('l\'email manquant n\'empêche pas la connexion', () => {
  // Crossmint ne met pas toujours l'email dans le jeton. L'identité, c'est `sub` ; l'email est une
  // commodité, et le serveur ira le chercher séparément.
  const id = identityFromClaims(revendications({ email: undefined }), { projectId: PROJET });
  assert.strictEqual(id.email, '');
  assert.strictEqual(id.authId, 'user_1');
});
test('le compte naît sans pseudo : c\'est le joueur qui le choisira', () => {
  const id = identityFromClaims(revendications(), { projectId: PROJET });
  assert.strictEqual(id.name, '');
  assert.ok(C.validName(C.nameOr(id.name, C.NAME.fallback)), 'le repli doit être un pseudo valide');
});

// ---------- de bout en bout, avec de la vraie cryptographie ----------
// Ce bloc est le seul qui demande une dépendance. Il ne s'exécute que si jose est installé, pour que
// `node api/test.js` reste lançable sans rien installer ; l'intégration continue, elle, installe les
// dépendances de l'API et l'exécute vraiment. Il n'appelle jamais Crossmint : le trousseau public
// est servi par un serveur local, ce qui permet d'éprouver aussi les cas qu'on ne peut pas demander
// à un fournisseur — un jeton signé par la mauvaise clé, un jeton expiré, une confusion
// d'algorithme.
let jose = null;
try { jose = require('jose'); } catch { /* pas installé : bloc sauté */ }

if (!jose) {
  console.log('Chaîne complète de vérification (sautée : jose n\'est pas installé — cd api && npm install)');
} else {
  console.log('Chaîne complète de vérification');
  const http = require('node:http');

  const paire = await jose.generateKeyPair('ES256', { extractable: true });
  const pirate = await jose.generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(paire.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

  const trousseau = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(r => trousseau.listen(0, '127.0.0.1', r));
  const jwksUrl = `http://127.0.0.1:${trousseau.address().port}/.well-known/jwks.json`;

  const a = autorite();
  const verifie = require('./auth-crossmint').crossmintVerifier({
    apiKey: fabriqueCle(a, { prefix: 'sk_production', projectId: PROJET }),
    jwksUrl, signers: a.signers,
    // Pas d'email à aller chercher : ce test ne parle à personne d'autre qu'à lui-même.
    lookupEmail: false,
  });

  const jeton = ({ cle = paire.privateKey, alg = 'ES256', aud = PROJET, sub = 'user_1', exp = '2h', ...reste } = {}) => {
    let s = new jose.SignJWT({ email: 'joueur@exemple.test', ...reste })
      .setProtectedHeader({ alg, kid: 'k1' })
      .setIssuedAt()
      .setSubject(sub)
      .setExpirationTime(exp);
    if (aud !== undefined) s = s.setAudience(aud);
    return s.sign(cle);
  };

  await test('un jeton signé par Crossmint, pour notre projet, ouvre la session', async () => {
    const id = await verifie(await jeton());
    assert.strictEqual(id.authId, 'user_1');
    assert.strictEqual(id.email, 'joueur@exemple.test');
  });
  await test('un jeton signé par une autre clé est refusé', async () => {
    await assert.rejects(verifie(await jeton({ cle: pirate.privateKey })));
  });
  await test('un jeton expiré est refusé', async () => {
    await assert.rejects(verifie(await jeton({ exp: Math.floor(Date.now() / 1000) - 3600 })));
  });
  await test('un jeton pour un autre projet est refusé par la signature comme par le contenu', async () => {
    await assert.rejects(verifie(await jeton({ aud: 'proj_voisin' })));
  });
  await test('la clé publique ne peut pas servir de secret partagé', async () => {
    // L'attaque classique : signer en HS256 avec le matériau public, en pariant que le serveur
    // choisisse l'algorithme d'après l'en-tête du jeton. La liste fermée d'algorithmes l'interdit.
    const faux = await new jose.SignJWT({ sub: 'pirate' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt().setSubject('pirate').setAudience(PROJET).setExpirationTime('2h')
      .sign(new TextEncoder().encode(JSON.stringify(jwk)));
    await assert.rejects(verifie(faux));
  });
  await test('un jeton sans signature du tout est refusé', async () => {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const nu = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ sub: 'pirate', aud: PROJET, exp: 4102444800 })}.`;
    await assert.rejects(verifie(nu));
  });
  await test('un jeton du bon émetteur mais sans expiration est refusé', async () => {
    // jose laisse passer un jeton sans `exp` : c'est notre contrôle à nous qui l'arrête.
    const eternel = await new jose.SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuedAt().setSubject('user_1').setAudience(PROJET)
      .sign(paire.privateKey);
    await assert.rejects(verifie(eternel), /expiration/);
  });
  await test('la clé serveur décide du projet : une clé d\'un autre projet ne voit pas nos jetons', async () => {
    const voisin = require('./auth-crossmint').crossmintVerifier({
      apiKey: fabriqueCle(a, { prefix: 'sk_production', projectId: 'proj_voisin' }),
      jwksUrl, signers: a.signers, lookupEmail: false,
    });
    await assert.rejects(voisin(await jeton()), 'un jeton Warblock ne doit pas ouvrir une session ailleurs');
  });
  await test('une clé serveur illisible fait échouer la construction, pas la première connexion', () => {
    assert.throws(() => require('./auth-crossmint').crossmintVerifier({ apiKey: 'sk_production_nimportequoi' }),
      /CROSSMINT_SERVER_API_KEY/);
  });

  trousseau.close();
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
