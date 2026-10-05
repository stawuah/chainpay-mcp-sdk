//! ChainPay backend orchestration boundary.

pub mod api;
pub mod catalog;
pub mod connectors;
pub mod delivery;
pub mod mandate_request;
pub mod receipts;
pub mod rpc;
pub mod server;
pub mod signer;
pub mod status;
pub mod storage;
pub mod webhooks;

pub use api::{PaymentRequest, PaymentResponse};
pub use server::{BackendConfig, BackendState, build_router};
pub use status::PaymentStatus;
