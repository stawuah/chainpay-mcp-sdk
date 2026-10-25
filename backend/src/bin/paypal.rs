//! Separate executable in the existing Axum backend, not a second backend stack.
use chainpay_backend::paypal::{
    ai::Ai,
    config, disabled_router,
    domain::{Principal, Role},
    provider::Provider,
    routes::{App, router},
    store::Store,
};
use std::{sync::Arc, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(config) = config::Config::from_env()? else {
        let listener = tokio::net::TcpListener::bind(config::bind_address()?).await?;
        axum::serve(listener, disabled_router()).await?;
        return Ok(());
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|s| s == "issue-access") {
        if !(4..=5).contains(&args.len()) {
            return Err("Usage: chainpay-paypal issue-access <workspace> <principal> <buyer|merchant|agent> [days:1..60]".into());
        }
        let role = match args[3].as_str() {
            "buyer" => Role::Buyer,
            "merchant" => Role::Merchant,
            "agent" => Role::Agent,
            _ => return Err("Invalid role".into()),
        };
        let days = args
            .get(4)
            .map(|s| s.parse::<u64>())
            .transpose()?
            .unwrap_or(7);
        if !(1..=60).contains(&days) {
            return Err("Grant duration must be 1–60 days".into());
        }
        let store = Store::connect(&config.database_url).await?;
        let token = store
            .issue_access(
                &Principal {
                    id: args[2].clone(),
                    workspace: args[1].clone(),
                    role,
                },
                days * 86400,
            )
            .await?;
        println!("{token}");
        return Ok(());
    }
    if !args.is_empty() {
        return Err("Unknown PayPal command".into());
    }
    let ai = Ai::from_env()?;
    let provider = Provider::new(&config)?;
    let store = Store::connect(&config.database_url).await?;
    let app = App {
        ai,
        store,
        provider,
        config: Arc::new(config),
    };
    let worker = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if worker.process_events().await.is_err() {
                eprintln!("PayPal inbox reconciliation incomplete; events retained");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(config::bind_address()?).await?;
    axum::serve(listener, router(app)).await?;
    Ok(())
}
