// The isolated PayPal service as one Vercel function. Same routes as the
// standalone chainpay-paypal binary; background work is driven by requests
// (see the vercel cfg blocks in paypal/routes.rs) because Vercel freezes a
// function once it has answered.
use chainpay_backend::paypal::{
    ai::Ai,
    config::Config,
    disabled_router,
    provider::Provider,
    routes::{App, router},
    store::Store,
};
use std::sync::Arc;
use tower::ServiceBuilder;
use vercel_runtime::{Error, axum::VercelLayer};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let routes = match Config::from_env()? {
        // Flags off: health answers "disabled" and no payment route exists.
        None => disabled_router(),
        Some(config) => {
            let store = Store::connect(&config.database_url).await?;
            let app = App {
                ai: Ai::from_env()?,
                provider: Provider::new(&config)?,
                store,
                config: Arc::new(config),
            };
            router(app)
        }
    };
    let app = ServiceBuilder::new()
        .layer(VercelLayer::new())
        .service(routes);
    vercel_runtime::run(app).await
}
