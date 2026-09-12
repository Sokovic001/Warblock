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
  -- Deux graines 32 bits non signées — le domaine de WBCore.makeRng. La publique décide de la
  -- carte et du gaz et part au client ; la SECRÈTE ne sort jamais du serveur. Elle ne sert à rien
  -- tant que rien n'est simulé : elle existe pour que le jour où le serveur décidera du contenu
  -- des caisses, le client ne l'ait jamais reçue — et pour que ce jour-là coûte zéro migration.
  -- bigint et pas integer : l'integer de Postgres est signé, il s'arrête à 2 147 483 647.
  seed_public  bigint       not null check (seed_public between 0 and 4294967295),
  seed_secret  bigint       not null check (seed_secret between 0 and 4294967295),
  -- la clé d'idempotence tirée par le client. Sans elle, un POST dont la réponse se perd est
  -- indistinguable d'un POST jamais arrivé.
  client_key   text         not null check (char_length(client_key) between 1 and 64),
  -- Quatre états. Le quatrième, 'rejected', est arrivé exprès avec le module du verdict, comme la
  -- contrainte étroite le demandait : une partie dont le rapport est refusé est CLOSE, avec son
  -- motif, et ne comptera dans aucune statistique.
  status       text         not null default 'open'
               check (status in ('open', 'settled', 'expired', 'rejected')),
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
  -- La sacoche retenue : DÉCLARÉE par le client, et seulement bornée à [0, stake_cents × seats].
  -- C'est elle qui décide du brut dans les deux jeux, donc du net : la borne ci-dessus est le
  -- seul plafond de paiement qui existe.
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
  -- Les faits DÉCLARÉS par le client, tels quels. Ils sont bornés, ils ne sont pas vérifiés :
  -- borner n'est pas vérifier. Deux bornes, et elles ne disent pas la même chose — `deaths` est
  -- tenu par l'enveloppe de plausibilité (on ne meurt pas plus de fois qu'on n'a de vies) ;
  -- `damage` n'a aucun plafond démontrable depuis le billet et n'est borné que par la CAPACITÉ de
  -- sa colonne, 2 147 483 647, refusée en amont par WBCore.checkReport. Ils sont là pour que les
  -- statistiques de la phase 02a soient une somme sur des lignes immuables plutôt qu'un compteur.
  seconds            integer  check (seconds >= 0),
  kills              integer  check (kills   >= 0),
  deaths             integer  check (deaths  >= 0),
  rank               integer  check (rank    >= 1),
  cubes              integer  check (cubes   >= 0),
  damage             integer  check (damage  >= 0),
  cashed_out         boolean,

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
