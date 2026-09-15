// Lancer : DATABASE_URL=postgres://… node api/operateur.js <verbe> …
//
// L'OUTIL D'OPÉRATION DU GRAND LIVRE, ET IL N'EST PAS UNE ROUTE.
//
// Le grand livre est en INSERTION SEULE : aucun `update`, aucun `delete`, et la seule correction
// possible est une CONTRE-PASSATION. `mouvementContrepassation` existait depuis la phase 03 et
// n'avait aucun appelant — personne n'avait écrit qui pouvait l'emprunter. `docs/HISTORIQUE.md` le
// disait sans détour : « le premier incident réel se réglera à la main dans `psql`, un dimanche
// soir, et c'est ce jour-là que la règle "aucun `update`" tombe. » Ce fichier est l'appelant qui
// manquait.
//
// POURQUOI UNE LIGNE DE COMMANDE ET JAMAIS UNE ROUTE HTTP. Une route d'administration est une
// surface d'attaque PERMANENTE pour un geste qui arrive deux fois par an, et elle demanderait une
// authentification de second ordre — un rôle dans `users`, un second facteur, une liste d'adresses —
// que rien d'autre du dossier ne justifie. L'opérateur, lui, détient déjà les identifiants de la
// base : il n'y a rien à lui accorder qu'il n'ait pas. C'est le même patron que « il n'existe aucune
// route `POST /api/credits` », et la même garde textuelle le tient : `api/app.js` ne charge jamais
// ce fichier et ne porte aucune route d'administration.
//
// IL SAIT LIRE AVANT DE SAVOIR ÉCRIRE, ET `montrer` ARRIVE EN PREMIER. Le premier geste d'un
// incident réel n'est pas de corriger, c'est de regarder : l'exposition d'un joueur sur la fenêtre,
// les jambes d'un mouvement, pourquoi tel billet a été refusé en `plafond`. Un outil qui n'aurait
// que des verbes d'écriture enverrait l'opérateur dans `psql` — précisément le geste et le jour que
// ce module existe pour empêcher. `montrer` n'écrit RIEN et n'exige aucune confirmation.
//
// CE QU'IL NE FAIT PAS, ÉCRIT POUR QUE PERSONNE NE LE CHERCHE ICI : débloquer un billet encore
// `open`. Un billet ouvert coincé se clôt par la CLÔTURE NORMALE — le veilleur, qui vide son
// séquestre vers `maison:contrepartie` — et jamais par une contre-passation, qui laisserait le
// séquestre incohérent avec le statut de la ligne. Le refus porte un nom, `billet_ouvert`, et il est
// le seul de la liste à regarder ailleurs que dans le livre.
//
// LE SECOND VERBE D'ÉCRITURE, DEPUIS LE MODULE 6 : `anonymiser`. Il ne touche pas un centime, et il
// est pourtant ici plutôt qu'ailleurs, parce que c'est le même registre — un geste manuel, rare,
// irréversible, fait par quelqu'un qui détient les identifiants de la base et qui doit dire
// pourquoi. Le schéma portait depuis la phase 01 deux cascades qui, en effaçant un compte,
// détruisaient les PIÈCES JUSTIFICATIVES de mouvements d'argent qui, eux, restent : elles sont
// passées en `restrict`, et un compte ne s'efface plus, il se RÉÉCRIT. `users.id` survit toujours,
// sans quoi `joueur:<id>` et `enjeu:<match_id>` désigneraient des lignes mortes.
//
// LA PARTIE QUI DÉCIDE N'EST PAS ICI : c'est `L.planCorrection` et `L.planAnonymisation`, pures,
// dans `api/ledger.js`, donc entièrement testables sans base. Ce fichier est un pilote — il lit, il
// imprime, il confirme — et une décision qui vit dans un pilote ne se prouve qu'en le lançant.
//
// AUCUNE DÉPENDANCE NOUVELLE, ET AUCUN SECRET : les identifiants de la base viennent de
// `DATABASE_URL`, comme dans `api/main.js`.
'use strict';

const L = require('./ledger');
// `WBCore`, pour `nameKey` et pour elle seule. La clé d'unicité d'un pseudo est une règle du JEU —
// « Loïc », « loic » et « LO.IC » sont le même nom à l'œil — et elle vit donc dans `index.html`,
// chargée par `api/core.js` comme partout ailleurs dans ce dossier. `api/ledger.js` ne peut pas
// l'appeler : il porte une garde de pureté qui lui interdit tout `require`. C'est donc ce pilote qui
// la lui passe, et le nom d'un compte anonymisé se dérive exactement de la même fonction que celui
// d'un joueur inscrit — il n'existe jamais deux écritures de « quelle est la clé de ce pseudo ».
const C = require('./core');

const AIDE = `Warblock — outil d'opération du grand livre.

  DATABASE_URL=postgres://… node api/operateur.js <verbe> …

LIRE (n'écrit rien, n'exige aucune confirmation) :

  montrer mouvement <motif> <reference>
      Les jambes d'un mouvement, son total, et le billet qu'il désigne s'il en désigne un.
      Exemple : montrer mouvement gain 42

  montrer billet <id>
      La ligne de matches, ses écritures, son séquestre, et le verdict de plafond du joueur.
      C'est ce qui répond à « pourquoi ce billet a-t-il été refusé en plafond ».

  montrer exposition <userId>
      L'exposition réalisée du joueur sur la fenêtre glissante, ce qu'il lui reste,
      et les gestes d'opération déjà consignés sur son compte.

CORRIGER (écrit, et exige une raison, un nom et --confirme) :

  contrepasser <motif> <reference> --par "<qui>" --raison "<pourquoi>" [--confirme]
      Sans --confirme, montre ce qui serait posé et n'écrit RIEN.
      Avec --confirme, pose la contre-passation ET sa raison dans la MÊME transaction.
      Rejouer la commande ne pose rien une seconde fois, et le dit.

  anonymiser <userId> --par "<qui>" --raison "<pourquoi>" [--confirme]
      Sans --confirme, montre ce qui serait réécrit et n'écrit RIEN.
      Avec --confirme, réécrit la ligne users ET consigne la raison dans la MÊME transaction.
      L'identifiant du compte NE BOUGE PAS : joueur:<id> et enjeu:<match_id> restent des
      comptes valides du grand livre, qui est immortel. Partent : auth_id, email, pseudo,
      avatar et pays. L'ancien pseudo redevient disponible — l'historique d'un joueur se
      lit donc sur son id et jamais sur son nom.

CE QUE CET OUTIL NE FAIT PAS, ET OÙ ALLER :

  Un billet encore « open » n'est PAS contre-passable, et le refus s'appelle billet_ouvert.
  Un billet ouvert coincé se règle par la CLÔTURE NORMALE — le veilleur clôt à l'expiration
  et vide le séquestre vers maison:contrepartie. Contre-passer une écriture d'un billet
  ouvert laisserait son séquestre incohérent avec son statut : c'est le seul cas où une
  correction du livre casserait ce que la réconciliation vérifie.

  Un compte ne s'EFFACE pas. Les cascades du schéma sont en « restrict » depuis la phase
  04a : un delete from users est REFUSÉ tant qu'un billet référence la ligne, parce que ce
  billet est la pièce justificative d'un mouvement d'argent qui, lui, reste. Le geste
  disponible est « anonymiser », et c'est une réécriture.

  Le grand livre reste en INSERTION SEULE : il n'existe ici ni update, ni delete, et il ne
  doit jamais en exister. Une écriture modifiée est une preuve détruite.
`;

// ---------- la lecture des arguments, pure ----------
//
// Elle est séparée du reste pour la même raison que `planCorrection` : elle se teste sans base et
// sans processus. Un analyseur d'arguments qui n'a jamais été éprouvé se découvre un dimanche soir,
// avec une raison avalée par une option collée.
const OPTIONS_TEXTE = ['par', 'raison'];
const OPTIONS_DRAPEAU = ['confirme'];

function lireArguments(argv) {
  const positions = [];
  const options = { par: '', raison: '', confirme: false };
  const liste = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < liste.length; i++) {
    const a = String(liste[i]);
    if (!a.startsWith('--')) { positions.push(a); continue; }
    const egal = a.indexOf('=');
    const nom = (egal === -1 ? a.slice(2) : a.slice(2, egal));
    if (OPTIONS_DRAPEAU.includes(nom)) {
      if (egal !== -1) return { erreur: `--${nom} ne prend pas de valeur` };
      options[nom] = true;
      continue;
    }
    if (!OPTIONS_TEXTE.includes(nom)) return { erreur: `option inconnue : ${a}` };
    // `--raison` suivie de rien avalerait le verbe suivant ou, pire, rien du tout : une raison vide
    // qui passe pour écrite est exactement ce que la table `ledger_audit` refuse.
    const valeur = egal === -1 ? liste[i + 1] : a.slice(egal + 1);
    if (valeur === undefined || String(valeur).startsWith('--')) {
      return { erreur: `--${nom} attend une valeur` };
    }
    options[nom] = String(valeur);
    if (egal === -1) i++;
  }
  return { verbe: positions[0] || '', positions: positions.slice(1), ...options };
}

// UN IDENTIFIANT DE LIGNE, ET IL SE VÉRIFIE AVANT DE PARTIR EN SQL. `where id = $1` sur « abc » lève
// `22P02` : le pilote remonterait une pile d'appels là où l'opérateur attend une phrase. Même
// expression que partout ailleurs — un `bigserial` ne produit jamais de zéro de tête, et « 007 » ne
// doit pas devenir une seconde ligne à côté de « 7 ».
const ID_RE = /^[1-9][0-9]*$/;

// Les colonnes que le pilote rend, traduites en transferts du grand livre. `api/ledger.js` ne
// connaît que le camelCase — il est pur, il ne sait pas ce qu'est une colonne — donc la traduction
// vit ici, une seule fois, et un test la confronte à un aller-retour complet.
function enTransferts(lignes) {
  return (lignes || []).map(l => ({
    motif: l.motif, reference: l.reference,
    compteDebit: l.compte_debit, compteCredit: l.compte_credit,
    montantCents: Number(l.montant_cents),
  }));
}

// ---------- les verbes ----------
//
// `executer` reçoit le `db` plutôt que de le construire : c'est la même discipline que `createApp`,
// et c'est ce qui permet aux tests de faire tourner les verbes contre la doublure, sans base et sans
// réseau. Elle rend un CODE DE SORTIE — 0 tout va bien, 1 refusé, 2 mal appelé — et elle n'imprime
// que par `sortie`.
async function executer(argv, { db, sortie = console.log, maintenant = Date.now } = {}) {
  const dit = (...l) => sortie(l.join(' '));
  const a = lireArguments(argv);
  if (a.erreur) { dit(a.erreur); dit(''); dit(AIDE); return 2; }
  if (!a.verbe || a.verbe === 'aide' || a.verbe === 'help') { dit(AIDE); return 0; }

  if (a.verbe === 'montrer') return montrer(a, { db, dit, maintenant });
  if (a.verbe === 'contrepasser') return contrepasser(a, { db, dit, maintenant });
  if (a.verbe === 'anonymiser') return anonymiser(a, { db, dit });

  dit(`verbe inconnu : ${a.verbe}`);
  dit('');
  dit(AIDE);
  return 2;
}

// Les jambes d'un mouvement, telles quelles. C'est la lecture qu'on fait en premier, et celle qui
// dit si le couple `(motif, référence)` désigne quelque chose.
function imprimerJambes(lignes, dit) {
  let total = 0;
  for (const l of lignes) {
    total += Number(l.montant_cents);
    dit(`  #${l.id}  ${l.compte_debit} -> ${l.compte_credit}  ${l.montant_cents} centimes  (${l.cree_le})`);
  }
  dit(`  ${lignes.length} jambe(s), ${total} centimes au total`);
  return total;
}

async function montrer(a, { db, dit, maintenant }) {
  const sujet = a.positions[0] || '';

  if (sujet === 'mouvement') {
    const [, motif, reference] = a.positions;
    if (!motif || !reference) { dit('usage : montrer mouvement <motif> <reference>'); return 2; }
    if (!L.MOTIFS.includes(motif)) {
      dit(`motif hors liste : ${motif} — les motifs sont ${L.MOTIFS.join(', ')}`);
      return 2;
    }
    const lignes = await db.lireMouvement({ motif, reference });
    dit(`mouvement (${motif}, ${reference})`);
    if (lignes.length === 0) { dit('  aucune écriture ne porte ce couple'); return 1; }
    imprimerJambes(lignes, dit);
    const billet = L.referenceBillet(motif, reference);
    dit(`  billet désigné : ${billet === null ? 'aucun' : billet}`);
    // ET CE QUE LE JOURNAL D'OPÉRATION EN DIT DÉJÀ. C'est la première question d'un incident réel —
    // « est-ce que quelqu'un y a déjà touché, et pourquoi ? » — et elle n'a de réponse que si l'audit
    // se relit par le même outil qui l'écrit.
    const traces = await db.lireAudit({ motif, reference });
    if (traces.length === 0) dit('  aucun geste d\'opération consigné sur ce mouvement');
    else for (const t of traces) {
      dit(`  ${t.geste} par ${t.operateur} le ${t.cree_le} : ${t.raison}`);
      dit(`    posé sous ${t.reference_posee}, ${t.jambes} jambe(s), ${t.montant_cents} centimes`);
    }
    return 0;
  }

  if (sujet === 'billet') {
    const id = a.positions[1];
    if (!id) { dit('usage : montrer billet <id>'); return 2; }
    if (!ID_RE.test(id)) { dit(`identifiant de billet illisible : ${id}`); return 2; }
    const ligne = await db.lireBillet({ matchId: id });
    if (!ligne) { dit(`aucun billet ${id}`); return 1; }
    dit(`billet ${ligne.id} — joueur ${ligne.user_id}, ${ligne.mode}, mise ${ligne.stake_cents} centimes,`
        + ` ${ligne.seats} sièges, statut ${ligne.status}`);
    dit(`  ouvert le ${ligne.opened_at}, expire le ${ligne.expires_at}`);
    if (ligne.settled_at) {
      dit(`  réglé le ${ligne.settled_at} : issue ${ligne.issue}, brut ${ligne.gross_cents},`
          + ` commission ${ligne.fee_cents}, net ${ligne.net_cents}`);
    }
    const ecritures = await db.ledgerDe({ reference: String(ligne.id) });
    dit(`  écritures du livre portant la référence ${ligne.id} :`);
    if (ecritures.length === 0) dit('    aucune');
    else imprimerJambes(ecritures, dit);
    // LE SÉQUESTRE, ET C'EST LUI QU'ON VIENT VOIR. Il vaut la mise sur une ligne ouverte et zéro sur
    // toute ligne close ; tout le reste est un incident.
    const sequestre = await db.ledgerSolde(L.compteEnjeu(ligne.id));
    dit(`  séquestre ${L.compteEnjeu(ligne.id)} : ${sequestre} centimes`);
    // ET POURQUOI LE PLAFOND A REFUSÉ. On rejoue le verdict sur l'exposition RÉALISÉE du joueur :
    // c'est la même requête que celle qui refuse, donc le chiffre qu'on montre est celui qui a
    // décidé — un outil qui en montrerait un autre ne servirait à rien.
    const realisee = await db.expositionJoueurCents({ userId: ligne.user_id, maintenant: maintenant() });
    const verdict = L.plafondVerdict({
      expositionRealiseeCents: realisee,
      expositionBilletCents: 0,
      plafondCents: L.PLAFOND_JOUEUR_CENTS,
    });
    dit(`  exposition réalisée du joueur sur ${L.PLAFOND_FENETRE_H} h : ${realisee} centimes`
        + ` (plafond ${verdict.plafondCents}, retenue ${verdict.expositionCents})`);
    return 0;
  }

  if (sujet === 'exposition') {
    const userId = a.positions[1];
    if (!userId) { dit('usage : montrer exposition <userId>'); return 2; }
    if (!ID_RE.test(userId)) { dit(`identifiant de joueur illisible : ${userId}`); return 2; }
    const realisee = await db.expositionJoueurCents({ userId, maintenant: maintenant() });
    const verdict = L.plafondVerdict({
      expositionRealiseeCents: realisee,
      expositionBilletCents: 0,
      plafondCents: L.PLAFOND_JOUEUR_CENTS,
    });
    dit(`joueur ${userId}, fenêtre glissante de ${L.PLAFOND_FENETRE_H} h`);
    dit(`  exposition réalisée : ${realisee} centimes`);
    // LE CLAMP À ZÉRO EST MONTRÉ, PAS CACHÉ : une exposition négative ne s'accumule pas, sans quoi
    // perdre cent parties achèterait le droit d'en gagner une très grosse.
    dit(`  retenue après clamp : ${verdict.expositionCents} centimes`);
    dit(`  plafond            : ${verdict.plafondCents} centimes`);
    dit(`  marge restante     : ${verdict.plafondCents - verdict.expositionCents} centimes`);
    // ET CE QUE LE JOURNAL D'OPÉRATION DIT DE CE COMPTE. L'anonymisation ne porte sur aucune
    // écriture du livre, donc `montrer mouvement` ne la retrouverait jamais : sans cette lecture-ci,
    // sa trace n'aurait qu'un seul chemin de relecture, `psql`, c'est-à-dire celui que cet outil
    // existe pour fermer.
    const gestes = await db.lireAuditJoueur({ userId });
    if (gestes.length === 0) dit('  aucun geste d\'opération consigné sur ce compte');
    else for (const g of gestes) dit(`  ${g.geste} par ${g.operateur} le ${g.cree_le} : ${g.raison}`);
    return 0;
  }

  dit('usage : montrer mouvement|billet|exposition …');
  return 2;
}

async function contrepasser(a, { db, dit, maintenant }) {
  const [motif, reference] = a.positions;
  if (!motif || !reference) {
    dit('usage : contrepasser <motif> <reference> --par "<qui>" --raison "<pourquoi>" [--confirme]');
    return 2;
  }
  if (!L.MOTIFS.includes(motif)) {
    dit(`motif hors liste : ${motif} — les motifs sont ${L.MOTIFS.join(', ')}`);
    return 2;
  }

  const lignes = await db.lireMouvement({ motif, reference });
  // LE BILLET EST RELU AVANT DE DÉCIDER, parce que le refus `billet_ouvert` en dépend. Quand
  // l'écriture ne désigne aucun billet — une dotation, une recharge — il n'y a rien à relire, et
  // `planCorrection` ne le demandera pas.
  const refBillet = lignes.length > 0 ? L.referenceBillet(motif, reference) : null;
  const billet = refBillet === null ? null : await db.lireBillet({ matchId: refBillet });

  const plan = L.planCorrection(enTransferts(lignes), {
    par: a.par, raison: a.raison, billet,
  });
  if (!plan.ok) { dit(`REFUSÉ (${plan.code}) : ${plan.message}`); return 1; }

  // ON MONTRE AVANT D'ÉCRIRE, TOUJOURS, ET MÊME QUAND `--confirme` EST LÀ. La sortie de terminal est
  // ce que l'opérateur relira dans son historique de shell le lendemain ; elle ne coûte rien et elle
  // porte le seul récit que la base ne garde pas — ce qu'il a vu au moment de décider.
  dit(`contre-passation du mouvement (${plan.motifOrigine}, ${plan.referenceOrigine})`);
  dit('  ce qui existe aujourd\'hui :');
  imprimerJambes(lignes, dit);
  dit(`  ce qui serait posé, sous la référence ${plan.referencePosee} :`);
  for (const t of plan.contrepassation) {
    dit(`    ${t.compteDebit} -> ${t.compteCredit}  ${t.montantCents} centimes`);
  }
  dit(`  par     : ${plan.par}`);
  dit(`  raison  : ${plan.raison}`);
  dit(`  billet  : ${plan.billet === null ? 'aucun' : plan.billet}`
      + (billet ? ` (statut ${billet.status})` : ''));

  if (!a.confirme) {
    dit('');
    dit('RIEN N\'A ÉTÉ ÉCRIT. Relance la même commande avec --confirme pour poser ces écritures.');
    return 0;
  }

  const r = await db.contrepasser(plan);
  if (!r.pose && r.deja) {
    // LA CLÉ D'IDEMPOTENCE A REFUSÉ LA SECONDE POSE, ET CE N'EST PAS UNE PANNE. Un opérateur qui
    // relance sa commande parce que sa connexion a lâché doit lire « c'était déjà fait » : sortir en
    // erreur sur un geste idempotent est exactement ce qui fait ouvrir `psql` pour « vérifier ».
    dit('');
    dit(`DÉJÀ POSÉE : la clé (motif, reference, compte_debit, compte_credit) refuse la seconde.`);
    dit('Rien n\'a été écrit cette fois-ci, et le livre porte déjà la correction.');
    return 0;
  }
  if (!r.pose && r.refus === 'decouvert') {
    // LE DÉCOUVERT EST UN REFUS, PAS UNE PANNE. Contre-passer une dotation que le joueur a déjà
    // dépensée demande à son compte plus qu'il ne porte : la règle uniforme l'arrête, et c'est ce
    // qu'on veut. Aucun compte ne passe en négatif, séquestres compris.
    dit('');
    dit(`REFUSÉ (decouvert) : ${r.message}`);
    dit('Rien n\'a été écrit. Aucun compte ne passe en négatif, pas même par une correction.');
    return 1;
  }
  dit('');
  dit(`POSÉE : ${r.jambes} jambe(s), ${r.montantCents} centimes, avec sa raison, dans la même transaction.`);
  return 0;
}

// UN COMPTE NE S'EFFACE PAS, IL S'ANONYMISE. Le schéma portait depuis la phase 01 deux cascades que
// personne n'avait regardées — `matches` sur `users`, `match_traces` sur `matches` — et un
// `delete from users` détruisait donc les PIÈCES JUSTIFICATIVES de mouvements d'argent qui, eux,
// restent : le grand livre est en insertion seule et nomme ses comptes avec `users.id` et
// `matches.id`. Les deux cascades sont passées en `restrict`, et ce verbe est le geste qui remplace
// la suppression.
//
// CE QUI NE BOUGE PAS EST LE POINT DU MODULE : `users.id`. Le déplacer ferait de `joueur:<id>` et
// `enjeu:<match_id>` des comptes désignant des lignes mortes, sur un livre qu'on ne peut pas
// corriger. Tout le reste de l'identité est réécrit, pas supprimé — aucune de ces colonnes ne peut
// « partir », elles sont toutes `not null`.
async function anonymiser(a, { db, dit }) {
  const userId = a.positions[0];
  if (!userId) {
    dit('usage : anonymiser <userId> --par "<qui>" --raison "<pourquoi>" [--confirme]');
    return 2;
  }
  if (!ID_RE.test(userId)) { dit(`identifiant de joueur illisible : ${userId}`); return 2; }

  const ligne = await db.lireUtilisateur({ userId });
  const plan = L.planAnonymisation(ligne, { par: a.par, raison: a.raison, nameKey: C.nameKey });
  if (!plan.ok && plan.code === 'deja_anonymise') {
    // REJOUER LE GESTE NE RÉÉCRIT RIEN, ET CE N'EST PAS UNE PANNE — même doctrine que « DÉJÀ POSÉE »
    // sur la contre-passation. Réécrire les mêmes valeurs n'aurait rien cassé, mais aurait consigné
    // une SECONDE ligne d'audit, donc raconté deux gestes là où il n'y en a eu qu'un.
    dit(`DÉJÀ ANONYMISÉ : ${plan.message}`);
    dit('Rien n\'a été écrit cette fois-ci, et la ligne porte déjà son identité anonyme.');
    return 0;
  }
  if (!plan.ok) { dit(`REFUSÉ (${plan.code}) : ${plan.message}`); return 1; }

  // ON MONTRE AVANT D'ÉCRIRE, TOUJOURS. Ici plus qu'ailleurs : le geste ne se défait pas, l'`auth_id`
  // d'origine n'est écrit nulle part ailleurs, et la sortie de terminal est la seule trace de ce que
  // l'opérateur avait sous les yeux — elle ne part PAS dans `ledger_audit`, qui n'anonymiserait plus
  // rien s'il gardait l'ancien email.
  dit(`anonymisation du compte ${plan.userId}`);
  dit('  ce qui disparaît :');
  dit(`    auth_id  ${plan.avant.authId}`);
  dit(`    email    ${plan.avant.email}`);
  dit(`    pseudo   ${plan.avant.name}  (clé ${plan.avant.nameKey})`);
  dit(`    avatar   ${plan.avant.avatar === '' ? '(vide)' : plan.avant.avatar}`);
  dit(`    pays     ${plan.avant.country === null || plan.avant.country === undefined ? '(aucun)' : plan.avant.country}`);
  dit('  ce qui est écrit à la place :');
  dit(`    auth_id  ${plan.apres.authId}`);
  dit(`    email    ${plan.apres.email}`);
  dit(`    pseudo   ${plan.apres.name}  (clé ${plan.apres.nameKey})`);
  dit(`  l'identifiant ${plan.userId} NE BOUGE PAS : ${L.compteJoueur(plan.userId)} reste un compte valide.`);
  dit(`  l'ancien pseudo « ${plan.avant.name} » redevient disponible : l'historique se lit sur l'id.`);
  dit(`  par     : ${plan.par}`);
  dit(`  raison  : ${plan.raison}`);

  if (!a.confirme) {
    dit('');
    dit('RIEN N\'A ÉTÉ ÉCRIT. Relance la même commande avec --confirme pour réécrire cette ligne.');
    return 0;
  }

  const r = await db.anonymiser(plan);
  if (!r.pose && r.absent) { dit(''); dit(`REFUSÉ : le compte ${plan.userId} a disparu entre-temps.`); return 1; }
  if (!r.pose && r.collision) {
    // LA COLLISION EST DITE, ET L'OUTIL S'ARRÊTE. Le nom anonyme est `x<id en base 36>` : quelqu'un
    // peut parfaitement porter ce pseudo-là. `findOrCreate` réessaie avec un suffixe à l'inscription,
    // et c'est le bon geste À CET ENDROIT-LÀ — il arrange un joueur qui ne remarquera rien. Ici, ce
    // serait décider à la place de l'opérateur, sur un geste rare, manuel et irréversible.
    dit('');
    dit(`REFUSÉ (collision) : ${r.message}`);
    dit(`Quelqu'un porte déjà « ${plan.apres.name} » ou l'identité ${plan.apres.authId}.`);
    dit('Rien n\'a été écrit. Fais changer ce pseudo-là, puis relance : deviner à ta place serait pire.');
    return 1;
  }
  dit('');
  dit(`ANONYMISÉ : la ligne ${plan.userId} et sa raison, dans la même transaction.`);
  return 0;
}

// ---------- le pilote ----------
//
// Le contrôle de `DATABASE_URL` est AVANT le `require` de `db-pg`, qui charge `pg` : l'intégration
// continue lance `node api/test.js` AVANT `npm install`, et ce fichier y est chargé pour ses
// fonctions pures. Un `require('./db-pg')` en tête ferait échouer les tests par « module
// introuvable », c'est-à-dire un code 1 sur une machine parfaitement saine. Le même piège que sur
// `api/db-check.js`, et la même parade.
async function principal(argv) {
  const url = process.env.DATABASE_URL;
  const a = lireArguments(argv);
  if (!a.verbe || a.verbe === 'aide' || a.verbe === 'help') { console.log(AIDE); return 0; }
  if (!url) {
    console.error('DATABASE_URL n\'est pas définie. Voir api/.env.example.');
    return 2;
  }
  const { pgDb } = require('./db-pg');
  const db = pgDb(url);
  try {
    return await executer(argv, { db });
  } finally {
    await db.close().catch(() => {});
  }
}

if (require.main === module) {
  principal(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(e => { console.error('operateur : ' + ((e && e.stack) || e)); process.exitCode = 1; });
}

module.exports = { AIDE, ID_RE, lireArguments, enTransferts, executer, principal };
