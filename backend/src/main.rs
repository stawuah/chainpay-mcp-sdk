use chainpay_backend::{BackendState, server::BackendConfig, storage::StatusStore};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = BackendConfig::from_env()?;
    let store = StatusStore::from_env()?;
    let state = BackendState::new(config, store)?;
    chainpay_backend::server::run(state).await
}
