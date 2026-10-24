//! Separate executable in the existing Axum backend, not a second backend stack.
use chainpay_backend::paypal::{config, disabled_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Until the provider/storage slice lands, refuse an enabled deployment rather
    // than pretending the health-only foundation is a functioning checkout.
    if config::Config::from_env()?.is_some() {
        return Err("PayPal foundation only: enabled service is not implemented yet".into());
    }
    let listener = tokio::net::TcpListener::bind(config::bind_address()?).await?;
    axum::serve(listener, disabled_router()).await?;
    Ok(())
}
