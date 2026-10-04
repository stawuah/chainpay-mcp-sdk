//! Provider connectors orchestrated by Axum (contracts.md §11): each provider
//! lives in its own module and shares the webhook inbox primitive.

pub mod card_issuer;
pub mod inbox;
