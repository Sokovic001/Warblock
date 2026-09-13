// Le grand livre en partie double : la grammaire des comptes, la liste fermée des motifs, et une
// fonction pure par mouvement. RIEN D'AUTRE. Pas de base, pas de réseau, pas de route, pas un octet
// de serveur : ce fichier construit des écritures, il ne les pose nulle part. C'est ce qui rend les
// modules suivants ennuyeux, et c'est le but — l'API n'aura plus qu'à persister ce qu'on lui donne.
//
// Deux règles gouvernent tout le fichier, et elles ne sont pas des préférences de style :
//
// 1. UNE ÉCRITURE EST UN TRANSFERT, jamais une jambe signée. Une ligne porte un montant strictement
//    positif, un compte débité et un compte crédité différents l'un de l'autre. La somme globale du
//    livre est alors nulle PAR CONSTRUCTION : chaque ligne pose exactement `+m` quelque part et
//    `−m` ailleurs. Il n'y a donc aucune fonction `equilibre()` ici, et il ne faut pas en ajouter
//    une : elle protégerait le chemin qui l'appelle, pas la donnée. Le jour où quelqu'un ouvrira un
//    second chemin d'écriture, la contrainte de colonne le suivra et la fonction ne l'aurait pas
//    suivi.
// 2. AUCUN MONTANT NE SE RECALCULE ICI. Le brut, la commission et le net viennent de
//    `WBCore.cashoutCents` et de nulle part ailleurs ; ce fichier les reçoit et les répartit. Une
//    garde textuelle d'`api/test.js` interdit à ce texte de contenir la moindre arithmétique de
//    commission — c'est infiniment plus sûr sur un fichier dédié que sur une plage de marqueurs
//    dans un fichier de six mille lignes, et c'est l'une des raisons pour lesquelles le grand livre
//    vit ici plutôt que dans `WBCore`.
'use strict';

// ---------- La grammaire des comptes ----------
//
// Six comptes, dont TROIS SONT DES FAMILLES PARAMÉTRÉES. L'écrire « liste fermée » aurait produit
// un `check (compte in (...))` que Postgres refuse au premier joueur inscrit. La validation est
// donc une EXPRESSION, et la contrainte de colonne d'`api/schema.sql` sera la même expression,
// caractère pour caractère : c'est une grammaire, et c'est pour cela qu'un test peut la comparer
// exactement au texte du schéma. Une liste qui diverge du code est le patron du `respawn()` défini
// deux fois.
//
// La source est exportée en CHAÎNE parce que c'est elle que le schéma recopie ; le `RegExp` en
// dérive, pour qu'il n'existe jamais deux écritures de la même règle.
//
// `[1-9][0-9]*` et non `[0-9]+` : les identifiants viennent de colonnes `bigserial`, qui ne
// produisent jamais de zéro de tête. Les accepter ferait de `joueur:007:disponible` et
// `joueur:7:disponible` deux comptes distincts pour un seul joueur, et le solde du second ne
// verrait jamais l'argent du premier.
const COMPTE_RE_SQL = '^(joueur:[1-9][0-9]*:(disponible|quarantaine)|enjeu:[1-9][0-9]*|maison:(dotation|commission|contrepartie))$';
const COMPTE_RE = new RegExp(COMPTE_RE_SQL);

// Les trois comptes de maison, qui eux sont bien des constantes.
const MAISON_DOTATION = 'maison:dotation';
const MAISON_COMMISSION = 'maison:commission';
const MAISON_CONTREPARTIE = 'maison:contrepartie';

// Un identifiant de ligne, tel que Postgres le rend : un nombre quand il tient, une chaîne de
// chiffres quand le pilote préfère ne pas perdre de précision sur un `bigint`, un `BigInt` quand
// on le lui demande. Les trois donnent le même compte, et rien d'autre ne passe.
function identifiant(valeur, quoi) {
  const texte = typeof valeur === 'bigint' ? valeur.toString()
              : typeof valeur === 'number' ? (Number.isSafeInteger(valeur) ? String(valeur) : '')
              : typeof valeur === 'string' ? valeur
              : '';
  if (!/^[1-9][0-9]*$/.test(texte)) {
    throw new Error(`grand livre : ${quoi} invalide (${String(valeur)}) — un identifiant de ligne est un entier positif sans zéro de tête`);
  }
  return texte;
}

function compteJoueur(userId) { return `joueur:${identifiant(userId, 'userId')}:disponible`; }
function compteQuarantaine(userId) { return `joueur:${identifiant(userId, 'userId')}:quarantaine`; }
function compteEnjeu(matchId) { return `enjeu:${identifiant(matchId, 'matchId')}`; }

// Un compte hors grammaire LANCE. Rendre une écriture boiteuse serait pire que la panne : elle
// s'insérerait, elle bouclerait — un transfert boucle toujours — et le solde qu'elle fausse ne se
// verrait qu'au moment de payer quelqu'un.
function exigeCompte(compte, quoi) {
  if (typeof compte !== 'string' || !COMPTE_RE.test(compte)) {
    throw new Error(`grand livre : ${quoi || 'compte'} hors grammaire (${String(compte)})`);
  }
  return compte;
}
function compteValide(compte) { return typeof compte === 'string' && COMPTE_RE.test(compte); }

// ---------- Les motifs ----------
//
// Ceux-là sont une VRAIE liste fermée, énumérable, et la contrainte du schéma sera un `check ... in`
// sans état d'âme. Six, et pas sept : la spécification renvoie explicitement à la phase 06 le motif
// de libération de quarantaine, parce qu'un membre de liste fermée que personne n'écrit est une
// case en attente d'être créée de travers. Ce que son ajout coûtera est chiffré dans
// `docs/PHASE-03.md` : un motif, un `alter table`, un test.
const MOTIFS = Object.freeze(['dotation', 'recharge', 'mise', 'gain', 'remboursement', 'contrepassation']);

// LES DEUX MOTIFS QUI SOLDENT UNE PARTIE, et pourquoi ils sont nommés à part. Un billet se termine
// de deux façons seulement : son séquestre part au règlement (`gain`, y compris le règlement à net
// nul d'une partie qui n'a rien rapporté), ou il revient au joueur (`remboursement`). Voir l'un de
// ces deux mouvements sur un `match_id` est donc la preuve que le livre a POSÉ SON ÉCRITURE sur
// cette partie — c'est la deuxième des quatre conditions de la purge des traces. La liste est ici
// pour que la clause SQL de la purge et la doublure d'`api/test.js` la lisent au même endroit : deux
// écritures de la même règle sont le patron du `respawn()` défini deux fois.
const MOTIFS_REGLEMENT = Object.freeze(['gain', 'remboursement']);

function exigeMotif(motif) {
  if (!MOTIFS.includes(motif)) {
    throw new Error(`grand livre : motif hors liste (${String(motif)}) — les motifs sont ${MOTIFS.join(', ')}`);
  }
  return motif;
}

// ---------- La dotation, la recharge, et le plancher ----------
//
// Trois entiers de centimes. Ils vivent ici pour la même raison que les motifs : ce ne sont pas des
// règles du JEU — rien dans le navigateur ne décide de ce que la maison émet — mais ce sont bien des
// règles du grand livre, et elles doivent se lire à côté des mouvements qui les dépensent.
//
// LA DOTATION vaut exactement le portefeuille de démonstration hors ligne, `WBCore.START_WALLET`.
// Cette phase fait apparaître DEUX ÉCONOMIES SUR LE MÊME ÉCRAN — le portefeuille de démonstration
// hors ligne, le solde du serveur en ligne — et les faire partir de deux nombres différents ferait
// prendre la première connexion pour un bug. Ce fichier ne charge pas `WBCore` : il doit rester
// pur, donc le nombre est écrit ici et un test d'`api/test.js` confronte les deux. C'est le patron
// déjà employé pour l'expression des comptes et le texte de `schema.sql` — deux écritures de la
// même règle se confrontent, elles ne se font pas confiance.
const DOTATION_CENTS = 5000;

// LE PLANCHER, ET POURQUOI LA RECHARGE EXISTE. Une dotation unique laisse un cul-de-sac : le bouton
// « + reload demo credits » disparaît en ligne, donc un joueur qui épuise ses crédits ne peut PLUS
// JAMAIS jouer, à vie. Ce n'est pas un détail de confort, c'est la fin de la boucle de jeu, et cela
// arrive après une centaine de parties à 0,50 $.
//
// Le plancher est fixé à dix parties de la table la moins chère : au-dessous, le joueur est à
// quelques défaites du cul-de-sac, et la recharge doit arriver AVANT lui, pas après. La recharge
// elle-même vaut vingt parties de cette même table, une fois par jour et par joueur : assez pour
// que la boucle ne se ferme jamais, trop peu pour que la recharge devienne un revenu qu'on récolte.
// Ce n'est pas un revenu, c'est un plancher de jeu en crédits fictifs, et le seul chemin qui
// l'écrit est le serveur au moment de la connexion — jamais une route que le client appelle.
const PLANCHER_CENTS = 500;
const RECHARGE_CENTS = 1000;

// ---------- La conservation de la trace d'une partie ----------
//
// POURQUOI CETTE CONSTANTE VIT ICI, dans un fichier qui dit « le grand livre, et rien d'autre ». La
// tension est réelle et il vaut mieux l'écrire que la cacher : `TRACE_RETENTION_JOURS` parle de
// `match_traces`, pas d'une écriture. Mais LA TRACE EST LA PIÈCE JUSTIFICATIVE D'UN MOUVEMENT
// D'ARGENT — c'est elle, et elle seule, qui permet de refaire la partie qui a produit un `net_cents`
// — et deux des quatre conditions de la purge sont des conditions du LIVRE : il faut qu'une écriture
// de règlement ou de remboursement porte cette partie, et que son séquestre soit vide. La règle se
// lit donc à côté des mouvements qu'elle prouve. Les deux autres domiciles possibles ne tenaient
// pas : `db-pg.js` charge `pg`, donc `api/test.js` ne peut pas le charger (l'intégration continue
// lance les tests AVANT `npm install`) ; un fichier de plus pour un entier serait une surface de
// plus pour rien.
//
// LA VALEUR EST CONSERVATRICE, ET CE N'EST PAS UNE DÉCISION JURIDIQUE. La trace se garde au moins
// aussi longtemps que la fenêtre pendant laquelle un joueur peut contester un paiement, et cette
// fenêtre-là est une affaire de phase 06, sur un cadre légal que personne n'a encore lu. Quatre
// cents jours, c'est une année pleine plus cinq semaines : une contestation ouverte le dernier jour
// d'un exercice se traite le mois suivant, et la marge existe pour que la pièce soit encore là ce
// jour-là. Se tromper vers le haut coûte des lignes dans une table ; se tromper vers le bas coûte la
// preuve d'un paiement, et celle-là ne se refait pas.
//
// Ce que la purge ne fera JAMAIS, et c'est le bon défaut : effacer la trace d'un billet dont le
// résultat n'est jamais arrivé. Sa ligne n'est ni `settled` ni `rejected`, donc la première des
// quatre conditions ne tient pas — et c'est exactement la pièce qu'on voudra relire.
const TRACE_RETENTION_JOURS = 400;

// ---------- Le découvert ----------
//
// Aucun compte ne passe en négatif, sauf ces deux-là : un compte d'ÉMISSION et un compte de
// CONTREPARTIE. Leur solde négatif n'est pas un incident, c'est la mesure qu'on cherche — combien
// de crédits fictifs ont été émis, et ce que coûte à la maison le fait que dix-neuf adversaires ne
// misent rien.
//
// L'uniformité de la règle referme gratuitement un trou qu'une clé d'idempotence ne peut pas
// fermer seule : un second gain sur un même billet devrait débiter un séquestre déjà vide, et se
// fait donc refuser. « Un billet a au plus un gain » ne repose alors pas uniquement sur un index.
// Les séquestres ne sont PAS exemptés, et c'est tout l'intérêt.
const COMPTES_EMETTEURS = Object.freeze([MAISON_DOTATION, MAISON_CONTREPARTIE]);
function decouvertAutorise(compte) {
  exigeCompte(compte);
  return COMPTES_EMETTEURS.includes(compte);
}

// ---------- La ligne-transfert ----------

function exigeMontant(montantCents) {
  if (!Number.isSafeInteger(montantCents) || montantCents <= 0) {
    throw new Error(`grand livre : montant invalide (${String(montantCents)}) — un transfert porte un entier de centimes strictement positif`);
  }
  return montantCents;
}

function exigeReference(reference) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 128) {
    throw new Error(`grand livre : référence invalide (${String(reference)})`);
  }
  return reference;
}

// La seule fabrique de lignes du fichier. Un transfert est gelé : une écriture qu'on modifie est
// une preuve détruite, et la règle « aucun `update`, aucun `delete` » commence par l'objet en
// mémoire — le grand livre n'a qu'un chemin de correction, la contre-passation.
function transfert(motif, reference, compteDebit, compteCredit, montantCents) {
  exigeMotif(motif);
  exigeReference(reference);
  exigeCompte(compteDebit, 'compte débité');
  exigeCompte(compteCredit, 'compte crédité');
  if (compteDebit === compteCredit) {
    throw new Error(`grand livre : un transfert ne va pas d'un compte vers lui-même (${compteDebit})`);
  }
  exigeMontant(montantCents);
  return Object.freeze({ motif, reference, compteDebit, compteCredit, montantCents });
}

// ---------- Une fonction pure par mouvement ----------
//
// Un mouvement est un ENSEMBLE de transferts partageant `(motif, reference)`. Chaque fonction rend
// une liste, éventuellement d'un seul élément, jamais vide.

// La dotation initiale : le serveur l'écrit une fois à la création du compte. Idempotente sur
// `(dotation, <user_id>)`, d'où une référence qui est l'identifiant du joueur et rien d'autre.
function mouvementDotation({ userId, montantCents }) {
  return [transfert('dotation', identifiant(userId, 'userId'),
                    MAISON_DOTATION, compteJoueur(userId), montantCents)];
}

// La recharge périodique. Sa référence porte le JOUR, parce que c'est l'idempotence qu'on veut :
// une par joueur et par jour, écrite par le serveur au moment de la connexion, jamais par une
// route que le client pourrait marteler. Ce n'est pas un revenu, c'est un plancher de jeu en
// crédits fictifs — sans lui, un joueur qui épuise ses crédits ne joue plus jamais, puisque le
// bouton de recharge disparaît en ligne.
function mouvementRecharge({ userId, jour, montantCents }) {
  if (typeof jour !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(jour)) {
    throw new Error(`grand livre : jour de recharge invalide (${String(jour)}) — attendu AAAA-MM-JJ`);
  }
  return [transfert('recharge', `${identifiant(userId, 'userId')}:${jour}`,
                    MAISON_DOTATION, compteJoueur(userId), montantCents)];
}

// La mise, débitée à l'OUVERTURE du billet et dans la même transaction que lui. Le seul instant que
// le serveur observe sans dépendre du client est celui où il émet le billet : débiter au coup
// d'envoi laisserait jouer gratuitement qui ne l'annonce jamais, et compenser à la fin laisserait
// jouer gratuitement qui ne rend jamais de résultat.
function mouvementMise({ userId, matchId, miseCents }) {
  return [transfert('mise', identifiant(matchId, 'matchId'),
                    compteJoueur(userId), compteEnjeu(matchId), miseCents)];
}

// LE RÈGLEMENT, et le seul endroit du dépôt où la DIRECTION DU RELIQUAT se décide. Elle se décide
// ici, dans la fonction pure, et jamais au point d'insertion : c'est le coût nommé de la
// ligne-transfert, et c'est précisément là qu'une erreur se cacherait.
//
// `grossCents`, `feeCents` et `netCents` viennent de `WBCore.cashoutCents` et de nulle part
// ailleurs — l'appelant les lui a demandés. On vérifie seulement qu'ils tiennent ensemble.
//
// UNE JAMBE DE MONTANT NUL N'EST PAS REPRÉSENTABLE, donc elle est OMISE. Ce n'est pas une
// optimisation : `montant_cents > 0` est une contrainte de colonne, une jambe nulle serait refusée
// par la base. Conséquence directe et voulue — un brut nul ne produit qu'UN seul transfert,
// `enjeu → maison:contrepartie` de toute la mise.
//
// CE QUI SE PASSE À L'EXPIRATION D'UN BILLET, et pourquoi il n'y a pas de `mouvementExpiration`.
// Le veilleur doit vider le séquestre d'un billet que personne n'a terminé, sinon l'invariant
// « aucun séquestre ne reste habité » est faux. Trois motifs se présentaient, aucun n'a tenu :
// `remboursement` mentirait, puisque personne n'est remboursé ; `contrepassation` mentirait aussi,
// puisqu'on ne corrige aucune écriture fausse — le débit de la mise était juste ; et un septième
// motif rouvrirait la liste fermée pour un cas qui n'en demande pas. La lecture juste est que le
// vidage d'un séquestre à l'expiration EST LE RÈGLEMENT d'une partie qui n'a rien rapporté : motif
// `gain`, net nul. Or `mouvementGain` avec `grossCents = 0` produit exactement cela, et exactement
// la même chose que le règlement d'un joueur qui perd — ce qui est la vérité comptable, les deux
// billets ayant rapporté zéro. On réutilise donc, plutôt que d'ajouter une fonction dont la seule
// différence aurait été le chemin qui l'appelle.
//
// `userId` et `convergee` ne sont exigés que si le net est non nul : quand il l'est, aucune jambe
// ne touche un compte de joueur, et le veilleur — qui ne connaît que le billet — n'a rien à en
// dire.
function mouvementGain({ userId, matchId, miseCents, grossCents, feeCents, netCents, convergee }) {
  const reference = identifiant(matchId, 'matchId');
  const enjeu = compteEnjeu(matchId);
  exigeMontant(miseCents);
  for (const [nom, v] of [['grossCents', grossCents], ['feeCents', feeCents], ['netCents', netCents]]) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`grand livre : ${nom} invalide (${String(v)}) — attendu un entier de centimes positif ou nul`);
    }
  }
  // `fee + net = brut` est la promesse de `cashoutCents`. On ne la recalcule pas, on refuse de
  // poser des écritures sur un triplet qui ne vient manifestement pas de lui : le séquestre ne
  // boucherait plus, et le trou n'apparaîtrait qu'au prochain règlement.
  if (feeCents + netCents !== grossCents) {
    throw new Error(`grand livre : feeCents + netCents (${feeCents} + ${netCents}) ne fait pas grossCents (${grossCents}) — ces trois montants viennent de WBCore.cashoutCents`);
  }
  const lignes = [];
  // Le brut dépasse la mise : la maison met le reliquat AU POT avant qu'on le partage. C'est ce
  // versement-là que la phase mesure, et il est bien plus gros qu'il n'y paraît.
  if (grossCents > miseCents) {
    lignes.push(transfert('gain', reference, MAISON_CONTREPARTIE, enjeu, grossCents - miseCents));
  }
  if (feeCents > 0) {
    lignes.push(transfert('gain', reference, enjeu, MAISON_COMMISSION, feeCents));
  }
  if (netCents > 0) {
    // Le gain d'une ligne dont le rejeu a DIVERGÉ va en quarantaine : visible, chiffré, jamais
    // dépensable. Ne rien créditer punirait un joueur dont le moteur JavaScript n'a pas la même
    // bibliothèque mathématique que le serveur ; créditer le solde dépensable romprait « le grand
    // livre ne lit que des lignes convergées » ; ne rien écrire laisserait `net_cents` sans
    // contrepartie et le livre ne bouclerait plus.
    if (typeof convergee !== 'boolean') {
      throw new Error('grand livre : convergee doit être un booléen dès que le net est non nul — un « indéfini » enverrait silencieusement le gain en quarantaine');
    }
    lignes.push(transfert('gain', reference, enjeu,
                          convergee ? compteJoueur(userId) : compteQuarantaine(userId), netCents));
  }
  // Le brut est inférieur à la mise : ce qui reste au séquestre rentre chez la maison. C'est le cas
  // de tout joueur qui perd, et c'est ce qui finance les versements du cas ci-dessus.
  if (grossCents < miseCents) {
    lignes.push(transfert('gain', reference, enjeu, MAISON_CONTREPARTIE, miseCents - grossCents));
  }
  return lignes;
}

// Le remboursement : la mise revient au joueur, le séquestre se vide. C'est le seul chemin qui
// rende une mise, et la fenêtre de renoncement de `WBCore` décide de qui y a droit.
function mouvementRemboursement({ userId, matchId, miseCents }) {
  return [transfert('remboursement', identifiant(matchId, 'matchId'),
                    compteEnjeu(matchId), compteJoueur(userId), miseCents)];
}

// LA CONTRE-PASSATION : l'inverse exact d'un mouvement existant, et le SEUL chemin de correction du
// grand livre. Une écriture modifiée est une preuve détruite — on ne peut plus dire ce qui a été
// payé ni quand. Les deux mouvements restent visibles, et c'est le but.
//
// Sans référence donnée, elle dérive de celle du mouvement corrigé, préfixée de son motif. Deux
// raisons : la clé d'idempotence `(motif, reference, compte_debit, compte_credit)` reste unique, et
// on peut lire dans le livre CE QUI a été contre-passé sans faire une jointure.
function mouvementContrepassation({ transferts, reference }) {
  if (!Array.isArray(transferts) || transferts.length === 0) {
    throw new Error('grand livre : une contre-passation porte sur un mouvement non vide');
  }
  const motif = transferts[0].motif, refOrigine = transferts[0].reference;
  for (const t of transferts) {
    // Un mouvement est un ensemble de transferts partageant `(motif, reference)`. Contre-passer un
    // paquet hétéroclite produirait un inverse qui ne correspond à rien de nommable.
    if (t.motif !== motif || t.reference !== refOrigine) {
      throw new Error(`grand livre : les transferts contre-passés n'appartiennent pas au même mouvement (${motif}, ${refOrigine}) contre (${t.motif}, ${t.reference})`);
    }
  }
  const ref = reference === undefined ? `${motif}:${refOrigine}` : reference;
  return transferts.map(t =>
    transfert('contrepassation', ref, t.compteCredit, t.compteDebit, t.montantCents));
}

// ---------- Lire le livre ----------

// La somme des crédits moins la somme des débits. ENTIER, et ZÉRO sur une liste vide : jamais
// `null`, jamais `undefined`. C'est la seule façon de connaître un solde, puisqu'il n'existe nulle
// part de colonne à lire — un compteur qu'on incrémente est une case qu'on écrase, et un double
// envoi la fausse pour toujours.
function soldeDe(transferts, compte) {
  exigeCompte(compte);
  let solde = 0;
  for (const t of transferts || []) {
    if (t.compteCredit === compte) solde += t.montantCents;
    if (t.compteDebit === compte) solde -= t.montantCents;
  }
  return solde;
}

// ---------- La réconciliation ----------
//
// Le zéro global ne dit RIEN sur l'appariement : il est vrai même si un montant juste est posé sur
// le mauvais compte. Ce prédicat attrape exactement cela, en confrontant le livre aux lignes de
// `matches`, et il est appelé à la fin de chaque scénario d'`api/test.js`.
//
// Il accepte une ligne seule ou une liste de lignes. Avec une liste, il peut en plus tenir le sens
// qu'une ligne seule ne permet pas de vérifier — « aucun engagement sans son billet » — puisqu'il
// voit alors tous les billets que le livre a le droit de connaître.
//
// Il rend une LISTE DE GRIEFS, en français, vide quand tout s'apparie.
// Les statuts sur lesquels un billet est CLOS, donc ceux sur lesquels le séquestre doit être vide.
// Exportée depuis le module 2 : le `check` de `matches.status` porte ces cinq valeurs plus `open`,
// et un test compare les deux listes. Un statut que ce fichier reconnaît et que la base refuse ne
// se verrait qu'au premier renoncement réel — et une valeur de statut qui ment est du même genre
// qu'une colonne qui ment.
const STATUTS_CLOS = Object.freeze(['settled', 'expired', 'rejected', 'abandoned', 'renounced']);
const CLOS = STATUTS_CLOS;

function ledgerReconcile(ligneMatch, transferts) {
  const lignes = Array.isArray(ligneMatch) ? ligneMatch : [ligneMatch];
  const livre = transferts || [];
  const griefs = [];
  const enjeuxConnus = new Set();

  for (const m of lignes) {
    const ref = identifiant(m.id, 'matches.id');
    const enjeu = compteEnjeu(m.id);
    enjeuxConnus.add(enjeu);
    const surEnjeu = livre.filter(t => t.compteDebit === enjeu || t.compteCredit === enjeu);
    const mises = surEnjeu.filter(t => t.motif === 'mise');

    // Aucun billet sans son engagement. Une ligne de la phase 02a — celles que le grand livre ne
    // lit pas — n'a pas à être passée ici ; si elle l'est, c'est le grief qu'on veut voir.
    if (mises.length === 0) {
      griefs.push(`billet ${ref} : aucun engagement (aucune écriture de mise sur ${enjeu})`);
    } else {
      if (mises.length > 1) griefs.push(`billet ${ref} : ${mises.length} écritures de mise au lieu d'une`);
      const engage = mises.reduce((a, t) => a + (t.compteCredit === enjeu ? t.montantCents : -t.montantCents), 0);
      if (engage !== m.stake_cents) {
        griefs.push(`billet ${ref} : la mise engagée est ${engage} au lieu de ${m.stake_cents}`);
      }
    }

    // `solde(enjeu:<match_id>)` vaut la mise sur une ligne ouverte et ZÉRO sur toute ligne close —
    // réglée, refusée, périmée, abandonnée, renoncée. Aucun séquestre ne reste habité.
    const solde = soldeDe(livre, enjeu);
    if (m.status === 'open') {
      if (solde !== m.stake_cents) {
        griefs.push(`billet ${ref} ouvert : le séquestre porte ${solde} au lieu de la mise ${m.stake_cents}`);
      }
    } else if (CLOS.includes(m.status)) {
      if (solde !== 0) {
        griefs.push(`billet ${ref} ${m.status} : le séquestre n'est pas vidé, il porte encore ${solde}`);
      }
    } else {
      griefs.push(`billet ${ref} : statut inconnu du grand livre (${String(m.status)})`);
    }

    // Sur une ligne réglée, les montants de `matches` se retrouvent AU CENTIME, et sur le bon
    // compte. `digest_match === false` est la seule marque de divergence : le gain part alors en
    // quarantaine, et le solde dépensable ne doit pas en voir un centime.
    if (m.net_cents !== null && m.net_cents !== undefined) {
      const gains = livre.filter(t => t.motif === 'gain' && t.reference === ref);
      const commission = gains.reduce((a, t) => a + (t.compteCredit === MAISON_COMMISSION ? t.montantCents : 0), 0);
      if (commission !== m.fee_cents) {
        griefs.push(`billet ${ref} : ${commission} sur ${MAISON_COMMISSION} au lieu de fee_cents ${m.fee_cents}`);
      }
      const divergee = m.digest_match === false;
      const attendu = divergee ? compteQuarantaine(m.user_id) : compteJoueur(m.user_id);
      const evite = divergee ? compteJoueur(m.user_id) : compteQuarantaine(m.user_id);
      const verse = gains.reduce((a, t) => a + (t.compteCredit === attendu ? t.montantCents : 0), 0);
      if (verse !== m.net_cents) {
        griefs.push(`billet ${ref} : ${verse} sur ${attendu} au lieu de net_cents ${m.net_cents}`);
      }
      const egare = gains.reduce((a, t) => a + (t.compteCredit === evite ? t.montantCents : 0), 0);
      if (egare !== 0) {
        griefs.push(`billet ${ref} : ${egare} posés sur ${evite}, qui n'a rien à recevoir de cette ligne`);
      }
    }
  }

  // Aucun engagement sans son billet. Un séquestre habité par une partie que `matches` ne connaît
  // pas est de l'argent que rien ne soldera jamais.
  for (const t of livre) {
    for (const c of [t.compteDebit, t.compteCredit]) {
      if (c.startsWith('enjeu:') && !enjeuxConnus.has(c)) {
        griefs.push(`${c} : un engagement sans billet — aucune ligne de matches ne porte ce séquestre`);
      }
    }
  }

  return griefs;
}

module.exports = {
  COMPTE_RE_SQL, COMPTE_RE, compteValide, exigeCompte,
  compteJoueur, compteQuarantaine, compteEnjeu,
  MAISON_DOTATION, MAISON_COMMISSION, MAISON_CONTREPARTIE,
  MOTIFS, MOTIFS_REGLEMENT, exigeMotif,
  DOTATION_CENTS, PLANCHER_CENTS, RECHARGE_CENTS, TRACE_RETENTION_JOURS,
  COMPTES_EMETTEURS, decouvertAutorise,
  transfert,
  mouvementDotation, mouvementRecharge, mouvementMise, mouvementGain,
  mouvementRemboursement, mouvementContrepassation,
  soldeDe, ledgerReconcile, STATUTS_CLOS,
};
