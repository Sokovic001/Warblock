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
