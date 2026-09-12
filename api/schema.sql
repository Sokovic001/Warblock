-- Warblock — schéma de la phase 01 : comptes et profils. Aucun argent.
--
-- Ce qui n'est PAS ici, volontairement : aucune colonne « solde ». Un solde stocké comme un nombre
-- qu'on écrase est exactement ce qu'il faudrait supprimer en phase 03, quand le grand livre arrive.
-- Le solde sera la somme d'écritures immuables, pas une case qu'on met à jour. Mieux vaut ne pas
-- créer la case que d'avoir à migrer de l'argent hors d'elle.

create table if not exists users (
  id          bigserial    primary key,
  -- l'identifiant rendu par le fournisseur d'identité. C'est lui qui fait foi, jamais l'email :
  -- un joueur peut changer d'email, il ne change pas d'identifiant.
  auth_id     text         not null unique,
  email       text         not null,
  -- le pseudo tel que le joueur l'a écrit, accents et casse compris
  name        text         not null,
  -- la clé d'unicité rendue par WBCore.nameKey() : accents, casse et séparateurs repliés.
  -- C'est elle qui empêche « Loïc » et « loic » de coexister.
  name_key    text         not null unique,
  avatar      text         not null default '',
  country     text,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),

  constraint users_name_len     check (char_length(name) between 2 and 14),
  constraint users_name_key_len check (char_length(name_key) between 1 and 14)
);

-- Les statistiques n'ont PAS de table, et c'est un revirement assumé sur la phase 01, qui en avait
-- écrit une : quatre compteurs qu'on incrémentait. Elles se lisent désormais par agrégat sur les
-- parties réglées de `matches` — voir la fin de ce fichier, et `docs/HISTORIQUE.md` pour la raison.
-- C'est le même raisonnement que l'absence de colonne solde : un compteur qu'on incrémente est une
-- case qu'on écrase, et un double envoi la fausse pour toujours.

-- Les recherches se font par identifiant fournisseur à chaque requête authentifiée : l'index unique
-- sur auth_id suffit. name_key porte déjà le sien.
create index if not exists users_created_at_idx on users (created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Phase 02a — le billet d'une partie.
--
-- Le serveur possède l'identité de la partie : les graines, la mise en centimes, le nombre de
-- sièges, l'heure d'ouverture et l'heure d'expiration sortent du serveur ou de WBCore, jamais du
-- client. Le client ne choisit que sa table, son mode et son brawler.
--
-- Toujours aucune colonne « solde », et aucune ici non plus : `stake_cents` est la mise engagée,
-- pas de l'argent détenu. Une ligne s'insère puis se règle UNE fois ; en phase 02a rien ne la
-- règle encore, c'est le module du verdict qui ajoutera les colonnes du résultat.
create table if not exists matches (
  id           bigserial    primary key,
  user_id      bigint       not null references users(id) on delete cascade,
  -- l'identifiant du mode dans WBCore.MODES — solo, duo, trio, resurgence, resurgenceDuo
  mode         text         not null,
  -- en CENTIMES, entier, produit par WBCore.toCents() à partir de la table choisie. Strictement
  -- positive : une partie à mise nulle n'existe pas, et une mise négative encore moins.
  stake_cents  integer      not null check (stake_cents > 0),
  -- WBCore.seatsOf(mode) : le nombre de mises dans le pot. Recopié ici parce qu'un mode dont
  -- l'équilibrage changerait ne doit pas réécrire le passé d'une partie déjà jouée.
  seats        integer      not null check (seats > 0),
  -- mode.teamSize, recopié pour exactement la même raison que `seats`, et il le fallait : le
  -- verdict borne les kills à (seats − teamSize) × vies et le rang à seats / teamSize. Relire
  -- `MODES` au moment du règlement — jusqu'à une dizaine de minutes après l'ouverture du billet,
  -- et donc après un redémarrage de serveur — jugeait la partie contre une table que personne
  -- n'avait achetée.
  team_size    integer      not null check (team_size > 0),
  brawler      text         not null,
  -- La graine PUBLIQUE : 32 bits non signés, le domaine de WBCore.makeRng. Elle décide de la carte,
  -- du gaz, des caisses et des vingt bots, et elle part au client — c'est `seedFor` qui la lit.
  -- Elle reste 32 bits parce que tout le contrat client de la 02a en dépend, et parce que son
  -- entropie est publique par construction : les flux nommés en dérivent un état plus large, ils
  -- ne créent pas de l'entropie qui n'existe pas.
  -- bigint et pas integer : l'integer de Postgres est signé, il s'arrête à 2 147 483 647.
  seed_public  bigint       not null check (seed_public between 0 and 4294967295),
  -- La graine SECRÈTE, 128 bits en hexadécimal, et le commentaire dit la vérité : DANS CETTE PHASE
  -- ELLE NE PROTÈGE RIEN ET LA SIMULATION NE L'UTILISE PAS. Dans une architecture de rejeu, le
  -- client possède tout ce qu'il dessine — il dessine les caisses, donc il connaît leur contenu dès
  -- la première seconde. Elle reste pour le jour où le serveur décidera de quelque chose que le
  -- client n'a pas à savoir. Elle passe de 32 bits à 128 parce que `between 0 and 4294967295`
  -- rendait une graine « secrète » trouvable par force brute hors ligne, et parce qu'une colonne qui
  -- porte un nom qui ment est pire que pas de colonne. Aucune base n'ayant jamais tourné, l'élargir
  -- coûte encore zéro migration.
  seed_secret  text         not null check (seed_secret ~ '^[0-9a-f]{32}$'),
  -- La version du bloc de simulation, FIGÉE À L'OUVERTURE du billet et écrite par le serveur, jamais
  -- par le client. Un correctif de simulation déployé pendant qu'un joueur joue rejouerait une AUTRE
  -- partie que la sienne, et paierait autre chose que ce qu'il a vu : c'est la raison exacte pour
  -- laquelle `seats` et `team_size` sont déjà figés ici.
  sim_version  integer      not null check (sim_version > 0),
  -- la clé d'idempotence tirée par le client. Sans elle, un POST dont la réponse se perd est
  -- indistinguable d'un POST jamais arrivé.
  client_key   text         not null check (char_length(client_key) between 1 and 64),
  -- Cinq états. Le quatrième, 'rejected', est arrivé exprès avec le module du verdict, comme la
  -- contrainte étroite le demandait : une partie dont le rapport est refusé est CLOSE, avec son
  -- motif, et ne comptera dans aucune statistique.
  -- Le cinquième, 'abandoned', est arrivé avec `first_result_at` ci-dessous : un billet
  -- sur lequel une partie a déjà été jouée et qui n'a pas pu être réglé est CLOS sans montant
  -- quand le joueur en redemande un, exactement comme le veilleur le ferait à l'expiration.
  status       text         not null default 'open'
               check (status in ('open', 'settled', 'expired', 'rejected', 'abandoned')),
  -- L'HEURE DU PREMIER RÉSULTAT RENDU SUR CE BILLET, ET POURQUOI ELLE EXISTE. Toute la partie est
  -- une fonction pure de `seed_public` : la carte, les caisses, les vingt bots et le plan de gaz.
  -- Un billet resservi est donc le MÊME monde. Sans cette marque, un joueur qui bloque l'envoi de
  -- sa trace obtient un 409, garde son billet ouvert, redemande une partie, reçoit la même graine —
  -- et rejoue en connaissance de cause le monde qu'il vient d'explorer, autant de fois que la vie
  -- du billet le permet, jusqu'à faire payer sa meilleure tentative.
  --
  -- Elle est posée par la route du résultat, quelle que soit l'issue, et UNE SEULE FOIS : la clause
  -- porte `status = 'open' and first_result_at is null`, si bien qu'un résultat renvoyé ne modifie
  -- pas la ligne — l'idempotence de cette route reste totale. C'est une écriture de STATUT, jamais
  -- d'un montant. Un billet déjà marqué n'est jamais resservi à une SECONDE partie ; renvoyer une
  -- trace perdue puis son résultat sur le même `match_id` reste possible, et c'est le but.
  first_result_at timestamptz,
  opened_at    timestamptz  not null default now(),
  -- L'expiration se livre AVEC le billet, calculée depuis LOBBY.wait, la durée du plan de zone et
  -- une marge. Sans elle, un onglet fermé enfermerait le joueur dans un billet mort.
  expires_at   timestamptz  not null,

  -- ---- Le règlement. Toutes ces colonnes sont NULL tant que la partie est ouverte, et écrites
  -- UNE SEULE FOIS, par l'update qui ferme la ligne (`where status = 'open' and net_cents is
  -- null`). Aucune n'est jamais mise à jour ensuite : c'est la règle qui remplace la colonne solde
  -- qu'on ne crée pas. Le jour où le grand livre existera, il écrira ses propres lignes ; celles-ci
  -- ne lui serviront pas.
  settled_at         timestamptz,
  -- ce que le verdict a décidé : victoire, encaissement, defaite ou refus
  issue              text     check (issue in ('victoire', 'encaissement', 'defaite', 'refus')),
  -- le contrôle d'ENVELOPPE qui a refusé, et sa phrase. NULL sur une partie réglée.
  controle           text,
  motif              text,
  -- Les trois montants du règlement, en CENTIMES entiers, tous produits par les fonctions de
  -- paiement de WBCore : l'API ne recalcule jamais la commission elle-même. Ils sont tous les
  -- trois au périmètre du JOUEUR, dans les cinq modes, et `fee_cents + net_cents = gross_cents`
  -- sans exception — c'est ce qui rend la ligne réconciliable seule. Ce que l'ÉQUIPE emporte
  -- n'est écrit nulle part, et c'est volontaire : le prix est la sacoche qu'on emporte, donc la
  -- part d'une équipe est la somme des sacoches de ses membres, que le serveur ne connaît pas.
  -- Le pot forfaitaire de `payoutCents` n'est qu'un plafond d'affichage, jamais un versement.
  gross_cents        integer  check (gross_cents >= 0),
  fee_cents          integer  check (fee_cents   >= 0),
  net_cents          integer  check (net_cents   >= 0),
  -- La sacoche retenue : celle que le REJEU a trouvée dans la poche du joueur à la fin de la
  -- partie, jamais celle du corps de la requête. C'est elle qui décide du brut dans les deux jeux,
  -- donc du net. `purseBound` — [0, stake_cents × seats] — reste le plafond, et il est DÉMONTRÉ et
  -- non décrété : la conservation de l'argent est assertée sur la partie rejouée avant tout
  -- règlement. C'est le point que la phase 03 doit lire correctement.
  purse_cents        integer  check (purse_cents >= 0),
  -- Ce que le client CROIT avoir gagné. Conservé pour être comparé, jamais pour être payé.
  declared_net_cents integer  check (declared_net_cents >= 0),
  -- L'écart mesuré, declared_net_cents − net_cents. LA SEULE COLONNE EN CENTIMES QUI PEUT ÊTRE
  -- NÉGATIVE, et c'est voulu : le client peut annoncer moins que le serveur ne compte, et cette
  -- mesure-là intéresse autant que l'autre. Ce n'est pas de l'argent dû, c'est une observation :
  -- on mesure, on ne punit pas. Le seuil est une affaire de phase 06, sur des données réelles.
  -- Elle tient dans un `integer` PAR CONSTRUCTION : declared_net_cents est borné à 2 147 483 647
  -- par WBCore.REPORT_FIELDS et net_cents est positif. Relever cette borne-là rouvrirait la panne
  -- ici, en silence.
  ecart_cents        integer,
  -- Les faits RECALCULÉS par le rejeu, depuis la graine publique du billet et la trace des entrées
  -- du joueur. Rien ici ne vient du corps de la requête : un corps gonflé écrit la même ligne qu'un
  -- corps sincère, et un test le vérifie ligne à ligne.
  --
  -- Les bornes de colonne restent, et elles protègent l'ÉCRITURE, pas la véracité : ces champs
  -- finissent dans des `integer`, qui s'arrêtent à 2 147 483 647, et WBCore.checkReport refuse en
  -- amont ce qui dépasse — sans quoi Postgres lèverait `22003`, la route rendrait 500, et la ligne
  -- resterait ouverte. `deaths` est en plus tenu par l'enveloppe de plausibilité (on ne meurt pas
  -- plus de fois qu'on n'a de vies) ; `damage` n'a aucun plafond démontrable depuis le billet et
  -- n'est borné que par la capacité de sa colonne. Ils sont là pour que les statistiques soient une
  -- somme sur des lignes immuables plutôt qu'un compteur.
  seconds            integer  check (seconds >= 0),
  kills              integer  check (kills   >= 0),
  deaths             integer  check (deaths  >= 0),
  rank               integer  check (rank    >= 1),
  cubes              integer  check (cubes   >= 0),
  damage             integer  check (damage  >= 0),
  cashed_out         boolean,

  -- ---- Phase 02b : ce que le REJEU a coûté et ce qu'il a trouvé. Écrites par la même écriture
  -- unique que tout le reste du règlement.
  --
  -- Le nombre de pas réellement rejoués. La durée d'une partie se compte en pas × SIM.stepS,
  -- jamais sur une horloge : c'est le seul repère qu'un rejeu partage avec la partie d'origine.
  trace_steps        integer  check (trace_steps >= 0),
  -- L'empreinte de la partie telle que le SERVEUR l'a rejouée. bigint et pas integer, pour la même
  -- raison que seed_public : c'est un entier 32 bits NON signé, et l'integer de Postgres est signé.
  replay_digest      bigint   check (replay_digest between 0 and 4294967295),
  -- LA GARANTIE DONT LA PHASE 03 A BESOIN, ET ELLE TIENT EN UNE COLONNE : le grand livre ne lira
  -- jamais que des lignes dont le rejeu a CONVERGÉ avec l'empreinte du client. Une divergence est
  -- MESURÉE, jamais punie — `Math.sin`, `Math.cos` et `Math.exp` ne sont pas spécifiées à l'ulp
  -- près par ECMAScript, donc un écart peut ne prouver qu'une chose : les deux côtés n'ont pas la
  -- même bibliothèque mathématique. Refuser ce joueur serait le quatrième contrôle « évident » et
  -- faux de ce dossier. La ligne est donc réglée, payée, et simplement invisible au grand livre.
  digest_match       boolean,
  -- Le premier pas où les deux empreintes s'écartent, au pas d'empreinte près (WBSim.EMPREINTE_PAS).
  -- Zéro veut dire « aucun condensé comparable » : le client n'en a pas envoyé, ou pas de lisibles.
  -- NULL sur une ligne qui a convergé. Sans ce chiffre, la liste d'exclusion grandirait en silence
  -- et la phase 03 hériterait d'un filtre dont personne ne connaît le rendement.
  divergence_step    integer  check (divergence_step >= 0),
  -- Le coût du rejeu, en millisecondes. Il est borné par REPLAY_BUDGET_MS dans app.js ; le mesurer
  -- ici est ce qui permettra de savoir si cette borne est large ou serrée, sur des parties réelles.
  replay_ms          integer  check (replay_ms >= 0),

  constraint matches_expire_apres check (expires_at > opened_at),
  -- Un règlement est complet ou absent : une ligne close porte ses montants, une ligne ouverte
  -- n'en porte aucun. Sans cette contrainte, un règlement interrompu à mi-chemin serait lisible
  -- comme une partie gagnée à zéro.
  constraint matches_reglement_complet check (
    (status = 'open'  and settled_at is null and net_cents is null)
    or (status <> 'open' and (settled_at is not null or net_cents is null))
  )
);

-- L'idempotence est arbitrée par des CONTRAINTES, jamais par un select préalable : c'est la même
-- doctrine que name_key. Une vérification préalable laisse une fenêtre entre le « est-ce libre ? »
-- et l'insertion, et deux onglets rapides passent tous les deux.
--
-- La création du billet est idempotente sur la clé du client…
create unique index if not exists matches_client_key_uniq on matches (user_id, client_key);
-- … et un joueur n'a jamais deux billets ouverts à la fois. L'index est PARTIEL : une fois la
-- partie réglée ou périmée, la place se libère d'elle-même.
create unique index if not exists matches_un_seul_ouvert on matches (user_id) where status = 'open';

-- Les statistiques sont une SOMME sur les parties réglées d'un joueur, pas un compteur qu'on
-- incrémente : c'est cet index-là qu'elles lisent. `matches` est donc la source de vérité de
-- `matches`, `wins`, `kills` et `best`, et il n'existe nulle part ailleurs de case à écraser.
-- Une partie refusée ou restée ouverte ne compte pour rien : la clause porte `status = 'settled'`.
create index if not exists matches_user_status_idx on matches (user_id, status);

-- ---------------------------------------------------------------------------------------------
-- Phase 02b — la trace des entrées du joueur.
--
-- Ce que le serveur rejouera. La graine publique lui donne la carte, le gaz, les caisses et les
-- vingt bots ; il ne lui manque que ce que le JOUEUR a fait. La trace porte donc cela et rien
-- d'autre : enregistrer les positions des bots ferait du client l'auteur de ses propres
-- adversaires, et multiplierait la taille par vingt.
--
-- CETTE TABLE EST EN INSERTION SEULE. Aucun `update`, aucun `delete`, PREMIER ÉCRIT GAGNE : la clé
-- primaire (match_id, seq) et `on conflict do nothing` arbitrent, comme `name_key` et l'index
-- partiel des billets ouverts. Un segment renvoyé n'écrit donc jamais une seconde ligne et ne
-- réécrit jamais la première — c'est la même doctrine que « une ligne s'insère puis se règle une
-- fois », poussée jusqu'au bout : ici, elle s'insère et c'est tout.
--
-- LA DETTE, ÉCRITE PLUTÔT QUE TUE : cette table n'a AUCUNE politique de conservation. Combien de
-- temps garde-t-on la pièce qui prouve une partie, et qui a le droit de la relire, est renvoyé à
-- la phase 03, qui décidera de ce qu'un grand livre a besoin de garder.
create table if not exists match_traces (
  match_id    bigint       not null references matches(id) on delete cascade,
  -- Le rang du segment. Une partie complète tient en un à trois envois, jamais vingt : on ne paie
  -- pas une sémantique d'ordre et de reprise pour une robustesse que la 02a possède déjà.
  seq         integer      not null check (seq >= 0 and seq < 64),
  -- La version du bloc sous laquelle la trace a été produite. Elle est comparée à celle du billet
  -- à l'insertion : une trace produite par un autre code que celui qui la rejouera ne prouve rien.
  sim_version integer      not null check (sim_version > 0),
  -- Le nombre de pas de simulation que ce segment contient. Il est COMPTÉ par le serveur en
  -- relisant la grammaire, jamais annoncé par le client : un nombre déclaré serait un nombre à
  -- vérifier, donc un nombre de plus à ne pas croire.
  --
  -- ZÉRO EST UNE VALEUR LÉGITIME, et `> 0` était un piège. Le découpage coupe au JETON, et un jeton
  -- d'action ponctuelle ne compte aucun pas : quand la frontière des 24 000 caractères tombe juste
  -- avant le dernier geste, le segment de queue ne porte que l'abandon ou l'encaissement. Le
  -- refuser fait échouer l'envoi juste avant la fin de la partie, donc `non_terminal` au règlement
  -- et aucun montant écrit — sur une partie parfaitement honnête.
  steps       integer      not null check (steps >= 0),
  -- Le segment lui-même : la grammaire de WBCore.traceDecode, en base64url plus deux marqueurs.
  -- La borne haute est celle de MAX_TRACE_BODY, moins la place de l'enveloppe JSON.
  data        text         not null check (char_length(data) between 1 and 65536),
  created_at  timestamptz  not null default now(),

  constraint match_traces_pk primary key (match_id, seq)
);
