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

-- Les statistiques quittent l'objet `profile` du navigateur. Elles ne sont pas de l'argent, mais
-- elles seront affichées publiquement : le client ne doit pas pouvoir les écrire.
create table if not exists user_stats (
  user_id  bigint  primary key references users(id) on delete cascade,
  matches  integer not null default 0 check (matches >= 0),
  wins     integer not null default 0 check (wins    >= 0),
  kills    integer not null default 0 check (kills   >= 0),
  -- en CENTIMES, entier. Le jeu calcule déjà au centime via cents() ; côté base, le nombre à
  -- virgule n'a pas droit de cité, et cette colonne fixe l'habitude dès maintenant.
  best     integer not null default 0 check (best    >= 0)
);

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
  -- Trois états seulement. Un rapport refusé en demandera un quatrième : la contrainte est là
  -- pour qu'on l'ajoute exprès, dans le module du verdict, plutôt que de l'écrire par accident.
  status       text         not null default 'open' check (status in ('open', 'settled', 'expired')),
  opened_at    timestamptz  not null default now(),
  -- L'expiration se livre AVEC le billet, calculée depuis LOBBY.wait, la durée du plan de zone et
  -- une marge. Sans elle, un onglet fermé enfermerait le joueur dans un billet mort.
  expires_at   timestamptz  not null,

  constraint matches_expire_apres check (expires_at > opened_at)
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

-- Les statistiques de la phase 02a seront une somme sur les parties réglées d'un joueur, pas un
-- compteur qu'on incrémente : c'est cet index-là qu'elles liront.
create index if not exists matches_user_status_idx on matches (user_id, status);
