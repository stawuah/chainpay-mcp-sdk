//! Fixed sandbox catalog plus the purchase routes that spend an allowance.
//! Prices live here, never in a request body.
use super::{
    allowance::{self, Policy, RULE},
    domain::{self, Document, Error, Principal, Role, Task, Unit, UnitState},
    money::Cents,
    observations,
    routes::App,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const OFFER_VERSION: &str = "catalog-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Availability {
    Always,
    MaxPerOrder(u32),
    Weekdays,
}
impl Availability {
    pub fn label(&self) -> String {
        match self {
            Availability::Always => "always".into(),
            Availability::MaxPerOrder(n) => format!("max_per_order:{n}"),
            Availability::Weekdays => "weekdays".into(),
        }
    }
    fn allows(&self, qty: u32, now: u64) -> Result<(), Error> {
        match self {
            Availability::Always => Ok(()),
            Availability::MaxPerOrder(n) if qty > *n => Err(Error::Invalid(
                "Quantity exceeds this item's per-order limit",
            )),
            Availability::MaxPerOrder(_) => Ok(()),
            Availability::Weekdays => {
                let day = chrono::DateTime::<chrono::Utc>::from_timestamp(now as i64, 0)
                    .ok_or(Error::Invalid("Invalid clock"))?
                    .weekday();
                if day.number_from_monday() > 5 {
                    Err(Error::Invalid("This item is only sold on weekdays"))
                } else {
                    Ok(())
                }
            }
        }
    }
}

pub struct Item {
    pub id: &'static str,
    pub name: &'static str,
    pub price: Cents,
    pub availability: Availability,
}
pub struct Merchant {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: &'static str,
    pub items: Vec<Item>,
}
fn item(id: &'static str, name: &'static str, price: u64, availability: Availability) -> Item {
    Item {
        id,
        name,
        price: Cents(price),
        availability,
    }
}
pub fn merchants() -> Vec<Merchant> {
    use Availability::*;
    vec![
        Merchant {
            id: "grocer",
            name: "Corner Grocer",
            kind: "grocery",
            items: vec![
                item("oat-milk", "Oat milk 1L", 390, Always),
                item("coffee-beans", "Coffee beans 250g", 1250, Always),
                item("sourdough", "Sourdough loaf", 650, MaxPerOrder(2)),
                item("eggs", "Free-range eggs (12)", 480, Weekdays),
            ],
        },
        Merchant {
            id: "box-office",
            name: "Riverside Box Office",
            kind: "events",
            items: vec![
                item("matinee", "Matinee ticket", 1800, Always),
                item("evening", "Evening show ticket", 3200, MaxPerOrder(4)),
                item("programme", "Printed programme", 500, Always),
            ],
        },
        Merchant {
            id: "tours",
            name: "Old Town Tours",
            kind: "booking",
            items: vec![
                item("walking-tour", "Old town walking tour", 2500, Always),
                item("food-tour", "Street food tour", 4500, MaxPerOrder(2)),
                item("bike-rental", "Bike rental (half day)", 1500, Weekdays),
                item("audio-guide", "Audio guide", 600, Always),
            ],
        },
        Merchant {
            id: "print-shop",
            name: "Quickprint",
            kind: "print",
            items: vec![
                item("bw-copies", "B&W copies (100 pages)", 800, Always),
                item("colour-poster", "Colour poster A2", 1900, Always),
                item(
                    "business-cards",
                    "Business cards (250)",
                    2400,
                    MaxPerOrder(2),
                ),
                item("binding", "Spiral binding", 350, Weekdays),
            ],
        },
    ]
}
pub fn merchant(id: &str) -> Result<Merchant, Error> {
    merchants()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or(Error::Invalid("Unknown merchant"))
}
pub fn catalog_json(q: Option<&str>) -> Value {
    let q = q.unwrap_or("").trim().to_lowercase();
    let list: Vec<Value> = merchants()
        .iter()
        .filter(|m| {
            q.is_empty()
                || m.name.to_lowercase().contains(&q)
                || m.kind.contains(&q)
                || m.items.iter().any(|i| i.name.to_lowercase().contains(&q))
        })
        .map(|m| {
            json!({"id":m.id,"name":m.name,"kind":m.kind,"items":m.items.iter().map(|i| json!({"id":i.id,"name":i.name,"price_cents":i.price,"price":i.price.decimal(),"availability":i.availability.label()})).collect::<Vec<_>>()})
        })
        .collect();
    json!({"merchants":list})
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemInput {
    pub id: String,
    pub qty: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Line {
    pub id: String,
    pub name: String,
    pub qty: u32,
    pub unit_cents: Cents,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RefundRequest {
    pub reason: String,
    pub amount_cents: Cents,
    pub amount: String,
    pub digest: String,
    pub failed_units: Vec<usize>,
    pub requested_by: String,
    pub requested_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Purchase {
    pub merchant: String,
    pub buyer: String,
    pub allowance_id: String,
    pub mode: String,
    pub approval: Option<String>,
    pub approval_requested_at: Option<u64>,
    pub approval_decided_at: Option<u64>,
    pub approved_by: Option<String>,
    pub lines: Vec<Line>,
    pub policy: Policy,
    pub refund_request: Option<RefundRequest>,
}

fn catalog_id(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(Error::Invalid("Catalog IDs are 1–40 lowercase characters"));
    }
    Ok(())
}
/// Resolves requested items against the fixed catalog. Pure.
pub fn lines(
    merchant_id: &str,
    items: &[ItemInput],
    now: u64,
) -> Result<(Vec<Line>, Cents), Error> {
    catalog_id(merchant_id)?;
    let m = merchant(merchant_id)?;
    if items.is_empty() || items.len() > 10 {
        return Err(Error::Invalid("Choose 1–10 catalog lines"));
    }
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for input in items {
        catalog_id(&input.id)?;
        if !(1..=10).contains(&input.qty) {
            return Err(Error::Invalid("Quantity must be 1–10"));
        }
        if out.iter().any(|l: &Line| l.id == input.id) {
            return Err(Error::Invalid("Repeated catalog item; use qty instead"));
        }
        let item = m
            .items
            .iter()
            .find(|i| i.id == input.id)
            .ok_or(Error::Invalid("Unknown catalog item for this merchant"))?;
        item.availability.allows(input.qty, now)?;
        total += item.price.0 * input.qty as u64;
        out.push(Line {
            id: item.id.into(),
            name: item.name.into(),
            qty: input.qty,
            unit_cents: item.price,
        });
    }
    Ok((out, Cents(total)))
}

impl Task {
    /// One unit per piece so refunds and fulfilment stay per item.
    pub fn quote_purchase(
        p: &Principal,
        a: &allowance::Allowance,
        merchant_id: &str,
        items: &[ItemInput],
    ) -> Result<Self, Error> {
        if !matches!(p.role, Role::Buyer | Role::Agent) {
            return Err(Error::Forbidden);
        }
        let created_at = domain::now();
        let (lines, amount) = lines(merchant_id, items, created_at)?;
        let id = domain::random_id()?;
        let mut documents = Vec::new();
        let mut units = Vec::new();
        for line in &lines {
            for _ in 0..line.qty {
                let text = format!("catalog:{merchant_id}/{}", line.id);
                units.push(Unit {
                    revision: 0,
                    attempt: None,
                    history: vec![],
                    input_hash: domain::hash(text.as_bytes()),
                    state: UnitState::Pending,
                    started_at: None,
                    result: None,
                    output_hash: None,
                    reason: None,
                    price: Some(line.unit_cents),
                });
                documents.push(Document {
                    name: line.name.clone(),
                    text,
                });
            }
        }
        let quote_digest = domain::hash(
            &serde_json::to_vec(&(OFFER_VERSION, &id, merchant_id, &lines, amount, &a.id)).unwrap(),
        );
        Ok(Self {
            resolution: vec![],
            refunds: vec![],
            legacy_refund_units: None,
            purchase: Some(Purchase {
                merchant: merchant_id.into(),
                buyer: a.buyer.clone(),
                allowance_id: a.id.clone(),
                mode: a.mode.clone(),
                approval: None,
                approval_requested_at: None,
                approval_decided_at: None,
                approved_by: None,
                lines,
                policy: Policy {
                    allowed: false,
                    rule: RULE.into(),
                    allowance_id: a.id.clone(),
                    reason_code: None,
                    checks: vec![],
                },
                refund_request: None,
            }),
            dispute: None,
            id,
            workspace: p.workspace.clone(),
            principal: p.id.clone(),
            created_at,
            offer_version: OFFER_VERSION.into(),
            requirements: None,
            documents,
            units,
            amount,
            quote_digest,
            quote_expires_at: created_at + 1800,
            approved_at: None,
            order: None,
            order_id: None,
            approval_url: None,
            capture: None,
            capture_id: None,
            captured: false,
            subscription_funding: None,
            payment_review: None,
            refund: None,
            refund_id: None,
            refund_amount: Cents(0),
            refund_confirmed: false,
            share_token: None,
        })
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/paypal/catalog", get(catalog))
        .route("/v1/paypal/purchases", post(purchase))
        .route("/v1/paypal/purchases/quote", post(quote))
        .route("/v1/paypal/purchases/approvals", get(approvals))
        .route("/v1/paypal/purchases/{id}/approve", post(approve))
        .route("/v1/paypal/purchases/{id}/deny", post(deny))
        .route("/v1/paypal/tasks/{id}/fulfil", post(fulfil))
        .route("/v1/paypal/tasks/{id}/refund-request", post(refund_request))
}

#[derive(Deserialize)]
struct Search {
    q: Option<String>,
}
async fn catalog(
    State(app): State<App>,
    headers: HeaderMap,
    Query(search): Query<Search>,
) -> Result<Json<Value>, Error> {
    app.principal(&headers).await?;
    Ok(Json(catalog_json(search.q.as_deref())))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteInput {
    merchant: String,
    items: Vec<ItemInput>,
    #[serde(default)]
    allowance_id: Option<String>,
}
fn lines_json(lines: &[Line]) -> Vec<Value> {
    lines.iter().map(|l| json!({"id":l.id,"name":l.name,"qty":l.qty,"unit_cents":l.unit_cents,"line_cents":Cents(l.unit_cents.0*l.qty as u64)})).collect()
}
async fn quote(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<QuoteInput>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if !matches!(p.role, Role::Buyer | Role::Agent) {
        return Err(Error::Forbidden);
    }
    let now = domain::now();
    let (lines, amount) = lines(&body.merchant, &body.items, now)?;
    let mut view = json!({"merchant":body.merchant,"lines":lines_json(&lines),"amount_cents":amount,"amount":amount.decimal(),"currency":"USD","sandbox":true});
    if let Some(allowance_id) = body.allowance_id {
        let a = app.store.allowance(&allowance_id, &p).await?;
        let usage = app.store.usage(&a.id, "", now).await?;
        view["policy"] = json!(allowance::check(
            &a,
            &p,
            &body.merchant,
            amount,
            &usage,
            now
        ));
    }
    Ok(Json(view))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PurchaseInput {
    request_id: String,
    allowance_id: String,
    merchant: String,
    items: Vec<ItemInput>,
    /// The caller says which mode it expects, so an approval request can
    /// never turn into a charge because the allowance was agent_pays.
    mode: String,
}
async fn purchase(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<PurchaseInput>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.allowances_enabled()?;
    app.store
        .rate_limit(&format!("purchase:{}", p.workspace), 30)
        .await?;
    if !matches!(body.mode.as_str(), "agent_pays" | "ask_first" | "ask_above") {
        return Err(Error::Invalid(
            "Purchase mode is agent_pays, ask_first or ask_above",
        ));
    }
    let a = app.store.allowance(&body.allowance_id, &p).await?;
    if body.mode != a.mode {
        return Err(Error::Invalid(match a.mode.as_str() {
            "agent_pays" => "Allowance mode is agent_pays, not ask_first; use the purchase call",
            "ask_above" => {
                "Allowance mode is ask_above; send mode ask_above and larger purchases wait for the buyer"
            }
            _ => "Allowance mode is ask_first, not agent_pays; ask the buyer for approval instead",
        }));
    }
    let fingerprint = domain::hash(
        &serde_json::to_vec(&(&body.allowance_id, &body.merchant, &body.items)).unwrap(),
    );
    let task = Task::quote_purchase(&p, &a, &body.merchant, &body.items)?;
    let task = app
        .store
        .purchase(&task, &body.request_id, &fingerprint, &p)
        .await?;
    let purchase = task.purchase.as_ref().ok_or(Error::Conflict)?;
    // agent_pays, or ask_above at or under its threshold: no approval was requested.
    if purchase.policy.allowed && purchase.mode != "ask_first" && purchase.approval.is_none() {
        return Ok(Json(observations::receipt(
            &app.charge_purchase(&task.id, &p).await?,
            false,
        )));
    }
    Ok(Json(observations::receipt(&task, false)))
}

async fn approvals(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(
        json!({"approvals":app.store.approvals(&p).await?.iter().map(|t| observations::receipt(t,false)).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    digest: String,
}
async fn approve(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Approval>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.allowances_enabled()?;
    let task = app.store.get(&id, &p).await?;
    let purchase = task.purchase.as_ref().ok_or(Error::NotFound)?;
    if p.role != Role::Buyer || purchase.buyer != p.id {
        return Err(Error::Forbidden);
    }
    if body.digest != task.quote_digest {
        return Err(Error::Conflict);
    }
    let task = app.store.approve_purchase(&id, &p).await?;
    let purchase = task.purchase.as_ref().ok_or(Error::Conflict)?;
    if purchase.policy.allowed && purchase.approval.as_deref() == Some("approved") {
        return Ok(Json(observations::receipt(
            &app.charge_purchase(&id, &p).await?,
            false,
        )));
    }
    Ok(Json(observations::receipt(&task, false)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Denial {
    reason: String,
}
async fn deny(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Denial>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if body.reason.trim().is_empty() || body.reason.len() > 500 {
        return Err(Error::Invalid("Supply a reason of 1–500 bytes"));
    }
    let task = app.store.deny_purchase(&id, &p, &body.reason).await?;
    Ok(Json(observations::receipt(&task, false)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Outcome {
    unit: usize,
    state: String,
    #[serde(default)]
    reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fulfilment {
    outcomes: Vec<Outcome>,
}
async fn fulfil(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Fulfilment>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app
        .store
        .update(&id, &p, |t| {
            t.merchant(&p)?;
            if t.purchase.is_none() {
                return Err(Error::Invalid("Only catalog purchases are fulfilled here"));
            }
            if !t.verified_funded() {
                return Err(Error::Invalid(
                    "A verified capture is required before fulfilment",
                ));
            }
            let now = domain::now();
            for o in &body.outcomes {
                let unit = t.units.get_mut(o.unit).ok_or(Error::Conflict)?;
                if unit.state != UnitState::Pending {
                    continue;
                }
                unit.state = match o.state.as_str() {
                    "delivered" => UnitState::Delivered,
                    "failed" => UnitState::Failed,
                    _ => return Err(Error::Invalid("Outcome state is delivered or failed")),
                };
                let result = json!({"fulfilled_at":now,"by":p.id,"state":o.state});
                unit.output_hash = Some(domain::hash(&serde_json::to_vec(&result).unwrap()));
                unit.result = Some(result);
                unit.started_at = Some(now);
                unit.reason = o.reason.clone().filter(|r| !r.is_empty());
            }
            Ok(())
        })
        .await?;
    Ok(Json(observations::receipt(&task, false)))
}

async fn refund_request(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Denial>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if body.reason.trim().is_empty() || body.reason.len() > 2000 {
        return Err(Error::Invalid("Supply a reason of 1–2000 bytes"));
    }
    let (task, _) = app
        .store
        .update(&id, &p, |t| {
            if !matches!(p.role, Role::Buyer | Role::Agent) || !t.can_read(&p) {
                return Err(Error::Forbidden);
            }
            let (amount, digest) = t.refund_proposal()?;
            let failed_units = t
                .units
                .iter()
                .enumerate()
                .filter(|(_, u)| u.state == UnitState::Failed)
                .map(|(i, _)| i)
                .collect();
            let purchase = t.purchase.as_mut().ok_or(Error::NotFound)?;
            if purchase.refund_request.is_none() {
                purchase.refund_request = Some(RefundRequest {
                    reason: body.reason.clone(),
                    amount_cents: amount,
                    amount: amount.decimal(),
                    digest,
                    failed_units,
                    requested_by: p.id.clone(),
                    requested_at: domain::now(),
                });
            }
            Ok(())
        })
        .await?;
    let r = task
        .purchase
        .as_ref()
        .and_then(|c| c.refund_request.as_ref())
        .ok_or(Error::Conflict)?;
    Ok(Json(
        json!({"amount":r.amount,"amount_cents":r.amount_cents,"currency":"USD","digest":r.digest,"failed_units":r.failed_units,"capture_id":task.capture_id,"requires_merchant_approval":true}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn buyer() -> Principal {
        Principal {
            id: "buyer".into(),
            workspace: "workspace".into(),
            role: Role::Buyer,
        }
    }
    fn allowance() -> allowance::Allowance {
        allowance::Allowance::fixture("buyer", "agent_pays")
    }
    #[test]
    fn seed_catalog_has_unique_lowercase_ids_and_positive_prices() {
        let all = merchants();
        assert_eq!(all.len(), 4);
        let mut merchant_ids = std::collections::HashSet::new();
        for m in &all {
            assert!(catalog_id(m.id).is_ok());
            assert!(merchant_ids.insert(m.id));
            assert!((3..=4).contains(&m.items.len()));
            let mut item_ids = std::collections::HashSet::new();
            for i in &m.items {
                assert!(catalog_id(i.id).is_ok());
                assert!(item_ids.insert(i.id));
                assert!(i.price.0 > 0);
                assert!(!i.name.trim().is_empty());
            }
        }
        let view = catalog_json(Some("coffee"));
        assert_eq!(view["merchants"].as_array().unwrap().len(), 1);
        assert_eq!(view["merchants"][0]["items"][1]["price_cents"], 1250);
        assert_eq!(view["merchants"][0]["items"][1]["price"], "12.50");
        assert_eq!(
            view["merchants"][0]["items"][2]["availability"],
            "max_per_order:2"
        );
    }
    #[test]
    fn lines_enforce_limits_and_catalog_prices() {
        // A Wednesday, so weekday-only items are allowed.
        let wednesday = 1_761_091_200;
        let items = vec![
            ItemInput {
                id: "oat-milk".into(),
                qty: 2,
            },
            ItemInput {
                id: "eggs".into(),
                qty: 1,
            },
        ];
        let (resolved, amount) = lines("grocer", &items, wednesday).unwrap();
        assert_eq!(amount, Cents(390 * 2 + 480));
        assert_eq!(resolved[0].unit_cents, Cents(390));
        let saturday = wednesday + 3 * 86400;
        assert!(lines("grocer", &items, saturday).is_err());
        assert!(
            lines(
                "grocer",
                &[ItemInput {
                    id: "sourdough".into(),
                    qty: 3
                }],
                wednesday
            )
            .is_err()
        );
        assert!(
            lines(
                "grocer",
                &[ItemInput {
                    id: "matinee".into(),
                    qty: 1
                }],
                wednesday
            )
            .is_err()
        );
        assert!(
            lines(
                "grocer",
                &[
                    ItemInput {
                        id: "oat-milk".into(),
                        qty: 1
                    },
                    ItemInput {
                        id: "oat-milk".into(),
                        qty: 1
                    }
                ],
                wednesday
            )
            .is_err()
        );
        assert!(lines("Grocer", &items, wednesday).is_err());
    }
    #[test]
    fn purchase_units_carry_their_price_and_refund_per_unit() {
        let p = buyer();
        let items = vec![
            ItemInput {
                id: "oat-milk".into(),
                qty: 2,
            },
            ItemInput {
                id: "coffee-beans".into(),
                qty: 1,
            },
        ];
        let mut task = Task::quote_purchase(&p, &allowance(), "grocer", &items).unwrap();
        assert_eq!(task.units.len(), 3);
        assert_eq!(task.amount, Cents(390 * 2 + 1250));
        assert_eq!(task.documents[0].text, "catalog:grocer/oat-milk");
        assert_eq!(task.unit_price(2).unwrap(), Cents(1250));
        assert_eq!(task.offer_version, OFFER_VERSION);
        // Not allowed until the allowance transaction says so, and never through PayPal checkout.
        assert!(task.start_vault_charge(&p).is_err());
        let digest = task.quote_digest.clone();
        assert!(matches!(
            task.start_checkout(&p, &digest),
            Err(Error::Conflict)
        ));
        task.captured = true;
        task.capture_id = Some("capture".into());
        task.units[0].state = UnitState::Delivered;
        task.units[1].state = UnitState::Delivered;
        task.units[2].state = UnitState::Failed;
        let (amount, _) = task.refund_proposal().unwrap();
        assert_eq!(amount, Cents(1250));
        let mut other = Task::quote_purchase(&p, &allowance(), "grocer", &items).unwrap();
        assert_ne!(other.quote_digest, task.quote_digest);
        let mut agent = p.clone();
        agent.role = Role::Agent;
        other.purchase.as_mut().unwrap().policy.allowed = true;
        other.purchase.as_mut().unwrap().mode = "ask_first".into();
        assert!(other.start_vault_charge(&agent).is_err());
        other.purchase.as_mut().unwrap().approval = Some("approved".into());
        assert!(other.start_vault_charge(&agent).unwrap().is_some());
        assert!(other.start_vault_charge(&agent).unwrap().is_none());
    }
}
