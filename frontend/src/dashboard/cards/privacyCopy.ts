/*
 * The one privacy claim the cards area makes (#40 scope delta). The approver key,
 * readers the owner adds and the card issuer (limits are mirrored at activation)
 * can all read a card's limits, so no copy may claim the owner is the only reader.
 * test/cards.test.mjs bans those phrases across this folder.
 */
export const PRIVACY_COPY = "Hidden from the public chain and from wallets you haven't approved. ChainPay's approver, readers you add and the card issuer can see them.";
export const PRIVACY_SHORT = "Hidden from the public chain and from wallets you haven't approved.";
