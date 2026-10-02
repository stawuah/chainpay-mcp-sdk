use chainpay_backend::{BackendState, build_router, server::BackendConfig, storage::StatusStore};
use tower::ServiceBuilder;
use vercel_runtime::{Error, axum::VercelLayer};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = BackendConfig::from_env()?;
    let store = StatusStore::from_env().await?;
    let state = BackendState::new(config, store)?;
    let app = ServiceBuilder::new()
        .layer(VercelLayer::new())
        .service(build_router(state));
    vercel_runtime::run(app).await
}
