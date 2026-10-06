//! The authorizer's handle on the private rollup. `Live` talks to MagicBlock
//! PER through [`TeeClient`]; tests swap in a deterministic in-process model
//! of `card_policy` so every lifecycle path runs without the network.

use super::tee::{TeeClient, TeeRead, TxOutcome, Watched};
use solana_address::Address;
use solana_message::Instruction;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub enum Per {
    Live(Arc<TeeClient>),
    #[cfg(test)]
    Fake(Arc<super::fake_per::FakePer>),
}

impl Per {
    pub fn authorizer(&self) -> Address {
        match self {
            Self::Live(tee) => tee.authorizer,
            #[cfg(test)]
            Self::Fake(fake) => fake.authorizer(),
        }
    }

    /// Warm the PER session off the decision path.
    pub async fn warm(&self) {
        match self {
            Self::Live(tee) => {
                let _ = tee.warm().await;
            }
            #[cfg(test)]
            Self::Fake(_) => {}
        }
    }

    /// Prepare the authorization path off the decision path: session,
    /// blockhash, pooled connections ([`TeeClient::prime`]).
    pub async fn prime(&self) {
        match self {
            Self::Live(tee) => tee.prime().await,
            #[cfg(test)]
            Self::Fake(_) => {}
        }
    }

    pub fn signing_key(&self) -> &ed25519_dalek::SigningKey {
        match self {
            Self::Live(tee) => tee.signing_key(),
            #[cfg(test)]
            Self::Fake(fake) => fake.signing_key(),
        }
    }

    pub async fn submit(&self, instructions: Vec<Instruction>, deadline: Instant) -> TxOutcome {
        match self {
            Self::Live(tee) => tee.submit(instructions, deadline).await,
            #[cfg(test)]
            Self::Fake(fake) => fake.submit(instructions, deadline).await,
        }
    }

    /// Submit a transaction that creates `watch` and confirm it while
    /// reading `watch` in the same rounds ([`TeeClient::submit_watching`]).
    pub async fn submit_watching(
        &self,
        instructions: Vec<Instruction>,
        watch: &Address,
        deadline: Instant,
    ) -> Watched {
        match self {
            Self::Live(tee) => tee.submit_watching(instructions, watch, deadline).await,
            // The model applies effects at once but reports them only after
            // its confirmation delay, so a read is only meaningful then.
            #[cfg(test)]
            Self::Fake(fake) => {
                let outcome = fake.submit(instructions, deadline).await;
                let account = match (&outcome, fake.read(watch)) {
                    (TxOutcome::Confirmed { .. }, TeeRead::Visible { data, .. }) => Some(data),
                    _ => None,
                };
                Watched { outcome, account }
            }
        }
    }

    pub async fn read(&self, address: &Address, timeout: Duration) -> TeeRead {
        match self {
            Self::Live(tee) => tee.read_account(address, timeout).await,
            #[cfg(test)]
            Self::Fake(fake) => fake.read(address),
        }
    }

    pub async fn signature_status(&self, signature: &str) -> Option<TxOutcome> {
        match self {
            Self::Live(tee) => tee.signature_status(signature).await,
            #[cfg(test)]
            Self::Fake(fake) => fake.signature_status(signature),
        }
    }

    /// Latest PER blockhash, for transactions the owner co-signs (restore).
    pub async fn blockhash(&self) -> Option<[u8; 32]> {
        match self {
            Self::Live(tee) => {
                let body = tee
                    .rpc(
                        "getLatestBlockhash",
                        serde_json::json!([{"commitment":"confirmed"}]),
                        Duration::from_secs(5),
                    )
                    .await
                    .ok()?;
                bs58::decode(body["result"]["value"]["blockhash"].as_str()?)
                    .into_vec()
                    .ok()?
                    .try_into()
                    .ok()
            }
            #[cfg(test)]
            Self::Fake(_) => Some([1; 32]),
        }
    }
}
