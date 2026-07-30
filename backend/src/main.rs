//! Minimal process entrypoint for the backend workspace boundary.
//!
//! The relay service is not implemented in the restructuring phase. Keeping
//! an executable here makes the backend independently startable without
//! pretending that settlement endpoints already exist.

fn main() {
    println!("ChainPay backend scaffold ready");
}
