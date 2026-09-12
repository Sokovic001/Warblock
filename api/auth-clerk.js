// La vérification du jeton de session, déléguée au SDK du fournisseur.
//
// Pourquoi ne pas vérifier la signature à la main : Node sait le faire, et ça tiendrait en trente
// lignes. Mais c'est le contrôle qui garde l'argent des joueurs, et les détails qui le rendent sûr
// — quel émetteur accepter, quelle tolérance d'horloge, quelle partie autorisée, comment gérer la
// rotation des clés — sont exactement ceux qu'on oublie en les réécrivant. On prend le code du
// fournisseur, qui est maintenu et audité.
'use strict';
const { verifyToken } = require('@clerk/backend');

function clerkVerifier({ secretKey, authorizedParties }) {
  if (!secretKey) throw new Error('CLERK_SECRET_KEY manquante.');
  if (!authorizedParties || !authorizedParties.length) {
    // Sans cette liste, un jeton émis pour une autre application de la même instance serait accepté.
    throw new Error('APP_ORIGINS manquante : les parties autorisées doivent être explicites.');
  }
  return async function (jeton) {
    const charge = await verifyToken(jeton, { secretKey, authorizedParties });
    return {
      authId: charge.sub,
      // Clerk ne met email et pseudo dans le jeton que si tu les as ajoutés aux revendications
      // personnalisées de la session. Absents, on retombe sur des valeurs vides et le joueur
      // renseignera son pseudo lui-même : rien ne casse.
      email: charge.email || charge.primary_email_address || '',
      name: charge.name || charge.username || '',
    };
  };
}

module.exports = { clerkVerifier };
