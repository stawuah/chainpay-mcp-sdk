//! USD amounts never pass through binary floating point.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Cents(pub u64);

impl Cents {
    pub fn decimal(self) -> String {
        format!("{}.{:02}", self.0 / 100, self.0 % 100)
    }

    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let (whole, fraction) = value.split_once('.').ok_or("Expected exact USD decimal")?;
        if whole.is_empty()
            || fraction.len() != 2
            || !whole
                .bytes()
                .chain(fraction.bytes())
                .all(|c| c.is_ascii_digit())
        {
            return Err("Expected exact USD decimal");
        }
        let whole: u64 = whole.parse().map_err(|_| "Amount overflow")?;
        let fraction: u64 = fraction.parse().map_err(|_| "Invalid fraction")?;
        whole
            .checked_mul(100)
            .and_then(|n| n.checked_add(fraction))
            .map(Self)
            .ok_or("Amount overflow")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_exact_cents_and_rejects_ambiguous_amounts() {
        for n in [0, 1, 99, 100, 1200, 9_007_199_254_740_993, u64::MAX] {
            assert_eq!(Cents::parse(&Cents(n).decimal()).unwrap(), Cents(n));
        }
        for s in [
            "1",
            "1.1",
            "1.001",
            "-1.00",
            "+1.00",
            "1e2",
            " 1.00",
            ".00",
            "1.00.0",
            "18446744073709551616.00",
        ] {
            assert!(Cents::parse(s).is_err(), "accepted {s}");
        }
    }
}
