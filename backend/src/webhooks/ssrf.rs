//! Outbound-request boundary for owner webhook endpoints (OWASP SSRF
//! prevention). A webhook URL is chosen by a user, so every request it causes
//! is treated as untrusted:
//!
//! - HTTPS only, no userinfo, no fragment, port 443 or 1024-65535.
//! - Hostnames that only make sense inside a network (`localhost`, `*.local`,
//!   `*.internal`, single labels, ...) are refused before any lookup.
//! - DNS is resolved at registration *and* again at every dispatch. Every
//!   answer must be a public unicast address; one private answer refuses the
//!   whole host, so a rebinding record cannot slip in beside a public one.
//! - The connection is pinned to the address that was checked (the client
//!   never resolves the name again), redirects are not followed, proxies from
//!   the environment are ignored, and time and response size are bounded.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use super::BoxFuture;

pub const MAX_URL_BYTES: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SsrfError {
    #[error("Enter a full https:// URL (up to 2048 characters)")]
    InvalidUrl,
    #[error("Webhook URLs must use https://")]
    NotHttps,
    #[error("Webhook URLs cannot contain a username or password")]
    Credentials,
    #[error("Webhook URLs cannot contain a #fragment")]
    Fragment,
    #[error("Use port 443 or a port from 1024 to 65535")]
    Port,
    #[error("This host is not reachable from the public internet")]
    PrivateHost,
    #[error("This address is not a public internet address")]
    BlockedAddress,
    #[error("This host name could not be resolved")]
    Resolution,
}

/// Static checks shared by registration and dispatch.
pub fn validate_url(raw: &str) -> Result<reqwest::Url, SsrfError> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err(SsrfError::InvalidUrl);
    }
    let url = reqwest::Url::parse(raw).map_err(|_| SsrfError::InvalidUrl)?;
    if url.scheme() != "https" {
        return Err(SsrfError::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(SsrfError::Credentials);
    }
    if url.fragment().is_some() {
        return Err(SsrfError::Fragment);
    }
    if let Some(port) = url.port() {
        if port != 443 && port < 1024 {
            return Err(SsrfError::Port);
        }
    }
    match url.host() {
        None => return Err(SsrfError::InvalidUrl),
        Some(url::Host::Ipv4(ip)) => check_ip(IpAddr::V4(ip))?,
        Some(url::Host::Ipv6(ip)) => check_ip(IpAddr::V6(ip))?,
        Some(url::Host::Domain(name)) => check_hostname(name)?,
    }
    Ok(url)
}

fn check_hostname(name: &str) -> Result<(), SsrfError> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    // A dotted-decimal or bare number that the parser left as a domain is
    // never a legitimate public host name.
    if name.parse::<IpAddr>().is_ok() || name.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(SsrfError::PrivateHost);
    }
    let internal_suffixes = [
        ".localhost",
        ".local",
        ".localdomain",
        ".internal",
        ".intranet",
        ".lan",
        ".home",
        ".corp",
        ".home.arpa",
        ".in-addr.arpa",
        ".ip6.arpa",
    ];
    if name.is_empty()
        || !name.contains('.')
        || name == "localhost"
        || internal_suffixes
            .iter()
            .any(|suffix| name.ends_with(suffix))
    {
        return Err(SsrfError::PrivateHost);
    }
    Ok(())
}

fn check_ip(ip: IpAddr) -> Result<(), SsrfError> {
    if is_public_ip(ip) {
        Ok(())
    } else {
        Err(SsrfError::BlockedAddress)
    }
}

/// True only for globally routable unicast addresses.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn in_v4(ip: Ipv4Addr, base: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(ip) & mask) == (u32::from(Ipv4Addr::from(base)) & mask)
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    const BLOCKED: &[([u8; 4], u32)] = &[
        ([0, 0, 0, 0], 8),       // "this network", incl. 0.0.0.0
        ([10, 0, 0, 0], 8),      // private
        ([100, 64, 0, 0], 10),   // carrier-grade NAT
        ([127, 0, 0, 0], 8),     // loopback
        ([169, 254, 0, 0], 16),  // link-local, incl. 169.254.169.254 metadata
        ([172, 16, 0, 0], 12),   // private
        ([192, 0, 0, 0], 24),    // IETF protocol assignments
        ([192, 0, 2, 0], 24),    // TEST-NET-1
        ([192, 88, 99, 0], 24),  // 6to4 relay anycast
        ([192, 168, 0, 0], 16),  // private
        ([198, 18, 0, 0], 15),   // benchmarking
        ([198, 51, 100, 0], 24), // TEST-NET-2
        ([203, 0, 113, 0], 24),  // TEST-NET-3
        ([224, 0, 0, 0], 4),     // multicast
        ([240, 0, 0, 0], 4),     // reserved, incl. broadcast
    ];
    !BLOCKED
        .iter()
        .any(|(base, prefix)| in_v4(ip, *base, *prefix))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4
    // destination: judge that address.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let [a, b] = segments[6].to_be_bytes();
        let [c, d] = segments[7].to_be_bytes();
        return is_public_v4(Ipv4Addr::new(a, b, c, d));
    }
    // Only global unicast (2000::/3) is ever public.
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }
    // 2001::/23 IETF protocol assignments (Teredo, ORCHID, ...), 2001:db8::/32
    // documentation, 2002::/16 6to4 (embeds any IPv4 destination) and
    // 3fff::/20 documentation.
    let ietf = segments[0] == 0x2001 && segments[1] < 0x0200;
    let documentation = (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x3fff && segments[1] < 0x1000);
    !(ietf || documentation || segments[0] == 0x2002)
}

/// Name resolution, injectable so tests never depend on real DNS.
pub trait Resolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            let lookup = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::net::lookup_host((host, port)),
            )
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "DNS timeout"))??;
            Ok(lookup.map(|addr| addr.ip()).collect())
        })
    }
}

/// Resolve the URL's host now and return the one address to connect to.
pub async fn resolve_public(
    resolver: &dyn Resolver,
    url: &reqwest::Url,
) -> Result<SocketAddr, SsrfError> {
    let port = url.port_or_known_default().ok_or(SsrfError::InvalidUrl)?;
    let addresses = match url.host() {
        Some(url::Host::Ipv4(ip)) => vec![IpAddr::V4(ip)],
        Some(url::Host::Ipv6(ip)) => vec![IpAddr::V6(ip)],
        Some(url::Host::Domain(name)) => {
            check_hostname(name)?;
            resolver
                .resolve(name.trim_end_matches('.'), port)
                .await
                .map_err(|_| SsrfError::Resolution)?
        }
        None => return Err(SsrfError::InvalidUrl),
    };
    if addresses.is_empty() {
        return Err(SsrfError::Resolution);
    }
    if !addresses.iter().all(|ip| is_public_ip(*ip)) {
        return Err(SsrfError::BlockedAddress);
    }
    Ok(SocketAddr::new(addresses[0], port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    pub struct FixedResolver(pub HashMap<&'static str, Vec<IpAddr>>);
    impl Resolver for FixedResolver {
        fn resolve<'a>(
            &'a self,
            host: &'a str,
            _: u16,
        ) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
            let answer = self.0.get(host).cloned();
            Box::pin(async move {
                answer.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "nx"))
            })
        }
    }

    #[test]
    fn address_table() {
        let cases: &[(&str, bool)] = &[
            ("93.184.216.34", true),
            ("1.1.1.1", true),
            ("0.0.0.0", false),
            ("10.1.2.3", false),
            ("100.64.0.1", false),
            ("100.127.255.254", false),
            ("100.128.0.1", true),
            ("127.0.0.1", false),
            ("127.255.255.254", false),
            ("169.254.169.254", false),
            ("172.16.0.1", false),
            ("172.31.255.255", false),
            ("172.32.0.1", true),
            ("192.0.0.170", false),
            ("192.0.2.10", false),
            ("192.168.1.1", false),
            ("198.18.0.1", false),
            ("198.51.100.7", false),
            ("203.0.113.9", false),
            ("224.0.0.1", false),
            ("239.255.255.250", false),
            ("255.255.255.255", false),
            ("2606:4700:4700::1111", true),
            ("::", false),
            ("::1", false),
            ("::ffff:127.0.0.1", false),
            ("::ffff:169.254.169.254", false),
            ("::ffff:10.0.0.1", false),
            ("::ffff:93.184.216.34", true),
            ("::127.0.0.1", false),
            ("64:ff9b::a9fe:a9fe", false),
            ("64:ff9b::5db8:d822", true),
            ("fc00::1", false),
            ("fd00:ec2::254", false),
            ("fe80::1", false),
            ("fec0::1", false),
            ("ff02::1", false),
            ("2001:db8::1", false),
            ("2001::1", false),
            ("2001:1ff::1", false),
            ("2001:200::1", true),
            ("3fff:fff::1", false),
            ("3fff:1000::1", true),
            ("2002:7f00:1::", false),
            ("3fff::1", false),
            ("100::1", false),
        ];
        for (ip, public) in cases {
            assert_eq!(is_public_ip(ip.parse().unwrap()), *public, "{ip}");
        }
    }

    #[test]
    fn url_table() {
        let ok = [
            "https://hooks.example.com/chainpay",
            "https://hooks.example.com:8443/x?y=1",
            "https://93.184.216.34/hook",
            "https://[2606:4700:4700::1111]/hook",
            "https://example.com./hook",
        ];
        for url in ok {
            assert!(validate_url(url).is_ok(), "{url}");
        }
        let refused: &[(&str, SsrfError)] = &[
            ("http://hooks.example.com/", SsrfError::NotHttps),
            ("ftp://hooks.example.com/", SsrfError::NotHttps),
            ("https://user:pw@hooks.example.com/", SsrfError::Credentials),
            ("https://user@hooks.example.com/", SsrfError::Credentials),
            ("https://hooks.example.com/#frag", SsrfError::Fragment),
            ("https://hooks.example.com:22/", SsrfError::Port),
            ("https://hooks.example.com:80/", SsrfError::Port),
            ("https://localhost/", SsrfError::PrivateHost),
            ("https://LOCALHOST./", SsrfError::PrivateHost),
            ("https://api.localhost/", SsrfError::PrivateHost),
            ("https://printer.local/", SsrfError::PrivateHost),
            ("https://metadata.google.internal/", SsrfError::PrivateHost),
            ("https://intranet/", SsrfError::PrivateHost),
            ("https://127.0.0.1/", SsrfError::BlockedAddress),
            ("https://0x7f.1/", SsrfError::BlockedAddress),
            ("https://2130706433/", SsrfError::BlockedAddress),
            ("https://017700000001/", SsrfError::BlockedAddress),
            (
                "https://169.254.169.254/latest/meta-data/",
                SsrfError::BlockedAddress,
            ),
            ("https://[::1]/", SsrfError::BlockedAddress),
            ("https://[::ffff:7f00:1]/", SsrfError::BlockedAddress),
            ("https://[fd00:ec2::254]/", SsrfError::BlockedAddress),
            ("https://[fe80::1]/", SsrfError::BlockedAddress),
            ("https://0.0.0.0/", SsrfError::BlockedAddress),
            ("not a url", SsrfError::InvalidUrl),
            ("", SsrfError::InvalidUrl),
        ];
        for (url, error) in refused {
            assert_eq!(validate_url(url).err().as_ref(), Some(error), "{url}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(validate_url(&long).err(), Some(SsrfError::InvalidUrl));
    }

    #[tokio::test]
    async fn dns_answers_are_checked_at_dispatch_and_pinned() {
        let resolver = FixedResolver(HashMap::from([
            ("public.example.com", vec!["93.184.216.34".parse().unwrap()]),
            ("private.example.com", vec!["10.0.0.7".parse().unwrap()]),
            (
                "metadata.example.com",
                vec!["169.254.169.254".parse().unwrap()],
            ),
            ("v6meta.example.com", vec!["fd00:ec2::254".parse().unwrap()]),
            (
                "mapped.example.com",
                vec!["::ffff:127.0.0.1".parse().unwrap()],
            ),
            (
                "mixed.example.com",
                vec![
                    "93.184.216.34".parse().unwrap(),
                    "127.0.0.1".parse().unwrap(),
                ],
            ),
            ("empty.example.com", vec![]),
        ]));
        let check = |host: &str| {
            let url = validate_url(&format!("https://{host}:8443/x")).unwrap();
            let resolver = &resolver;
            async move { resolve_public(resolver, &url).await }
        };
        assert_eq!(
            check("public.example.com").await.unwrap(),
            "93.184.216.34:8443".parse().unwrap()
        );
        for host in [
            "private.example.com",
            "metadata.example.com",
            "v6meta.example.com",
            "mapped.example.com",
            "mixed.example.com",
        ] {
            assert_eq!(
                check(host).await.err(),
                Some(SsrfError::BlockedAddress),
                "{host}"
            );
        }
        assert_eq!(
            check("empty.example.com").await.err(),
            Some(SsrfError::Resolution)
        );
        assert_eq!(
            check("nx.example.com").await.err(),
            Some(SsrfError::Resolution)
        );
    }
}
