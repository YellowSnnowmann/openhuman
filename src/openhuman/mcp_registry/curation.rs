//! One-canonical-server-per-service curation for the registry catalog.
//!
//! The upstream registries list many community servers for popular services —
//! a dozen "gmail" servers, several "notion", and so on. Showing all of them is
//! noisy, so for a curated set of well-known services we collapse the results
//! to a single canonical row. A server belongs to a service when one of the
//! service's match terms appears, as a whole word, in its display name or in
//! its qualified name *after the code-host namespace is stripped*.
//!
//! The namespace strip and whole-word match are not cosmetic: the official
//! registry namespaces ~76% of all servers under `io.github.<user>/…`, so a
//! naive substring match for `"github"` hits >10k unrelated servers (every
//! GitHub-published author) and collapses the whole registry into one bogus
//! "github" row. Stripping the `io.github.`/`io.gitlab.` code-host roots and
//! requiring a word boundary (so `github` matches `github-mcp-server` but not
//! the username `github30` or the namespace of `io.github.alice/weather`)
//! keeps the match on the ~30 servers that are actually GitHub tools.
//!
//! Within a collapsed service the winner is chosen by:
//!   1. the service's `pinned` qualified name, if that exact server is present;
//!   2. otherwise a ranking — official-registry source, then deployed, then
//!      highest `use_count`.
//!
//! Servers that match no known service pass through untouched, preserving the
//! upstream ordering. The surviving row keeps the position of the first member
//! of its service seen in the input.

use std::collections::HashMap;

use super::registries::SOURCE_MCP_OFFICIAL;
use super::types::SmitheryServerSummary;

/// A well-known service collapsed to a single catalog row.
struct CuratedService {
    /// Stable grouping key (e.g. `"gmail"`).
    key: &'static str,
    /// Lowercase terms; a server joins this service when any term appears as a
    /// whole word in its display name or its namespace-stripped qualified name
    /// (see [`match_haystack`] / [`contains_word`]).
    match_terms: &'static [&'static str],
    /// Preferred server's qualified name. When that exact server is in the
    /// results it wins outright; otherwise the ranking picks the winner.
    pinned: Option<&'static str>,
}

/// Services we collapse to one row. Extend this list (and set `pinned` once a
/// canonical server is chosen) as more well-known integrations are curated.
const CURATED_SERVICES: &[CuratedService] = &[
    CuratedService {
        key: "gmail",
        match_terms: &["gmail"],
        pinned: None,
    },
    CuratedService {
        key: "google-calendar",
        match_terms: &["google-calendar", "googlecalendar", "gcal"],
        pinned: None,
    },
    CuratedService {
        key: "google-drive",
        match_terms: &["google-drive", "googledrive", "gdrive"],
        pinned: None,
    },
    CuratedService {
        key: "notion",
        match_terms: &["notion"],
        pinned: None,
    },
    CuratedService {
        key: "slack",
        match_terms: &["slack"],
        pinned: None,
    },
    CuratedService {
        key: "github",
        match_terms: &["github"],
        pinned: None,
    },
    CuratedService {
        key: "gitlab",
        match_terms: &["gitlab"],
        pinned: None,
    },
    CuratedService {
        key: "linear",
        match_terms: &["linear"],
        pinned: None,
    },
    CuratedService {
        key: "jira",
        match_terms: &["jira"],
        pinned: None,
    },
    CuratedService {
        key: "discord",
        match_terms: &["discord"],
        pinned: None,
    },
    CuratedService {
        key: "telegram",
        match_terms: &["telegram"],
        pinned: None,
    },
    CuratedService {
        key: "whatsapp",
        match_terms: &["whatsapp"],
        pinned: None,
    },
];

/// Code-host namespace roots stripped from a qualified name before matching.
/// The official registry namespaces most servers under the author's code-host
/// identity (`io.github.<user>/…`), so these segments carry no service meaning
/// and must not feed term matching — otherwise every author who published from
/// GitHub looks like a "github" server. Vendor roots (`com.stripe`, `ai.notion`,
/// …) are deliberately *not* stripped: there the namespace is the service.
const CODE_HOST_PREFIXES: &[&str] = &["io.github.", "io.gitlab."];

/// Services whose hosted MCP endpoints we've empirically confirmed connect via
/// the standard browser-OAuth handshake (RFC 9728 `resource_metadata` challenge
/// → DCR + PKCE). A hosted server matching one of these terms is marked
/// `verified` so the UI can badge it. This only annotates — nothing is removed.
/// Extend as more endpoints are confirmed.
const VERIFIED_TERMS: &[&str] = &[
    "sentry",
    "linear",
    "notion",
    "atlassian",
    "jira",
    "confluence",
    "asana",
    "intercom",
    "paypal",
    "stripe",
    "github",
    "cloudflare",
];

/// Collapse the merged catalog so each curated service appears at most once.
pub fn curate_one_per_service(servers: Vec<SmitheryServerSummary>) -> Vec<SmitheryServerSummary> {
    curate_with(servers, CURATED_SERVICES)
}

/// Mark hosted servers for confirmed-working services as `verified`. Only
/// `is_deployed` (hosted) servers qualify — a local stdio package named
/// "sentry" is not the confirmed hosted endpoint. Mutates in place.
pub fn tag_verified(servers: &mut [SmitheryServerSummary]) {
    for server in servers.iter_mut() {
        server.verified = server.is_deployed && matches_verified_term(server);
    }
}

fn matches_verified_term(server: &SmitheryServerSummary) -> bool {
    let haystack = match_haystack(server);
    VERIFIED_TERMS
        .iter()
        .any(|term| contains_word(&haystack, term))
}

/// Lowercased text a service term is matched against: the qualified name with
/// any code-host namespace root removed, plus the display name. Removing the
/// `io.github.<user>/` style prefix is what stops the namespace from being read
/// as a service term (see the module docs).
fn match_haystack(server: &SmitheryServerSummary) -> String {
    let name = server.qualified_name.to_lowercase();
    let stripped = CODE_HOST_PREFIXES
        .iter()
        .find_map(|p| name.strip_prefix(p))
        .unwrap_or(&name);
    format!("{} {}", stripped, server.display_name.to_lowercase())
}

/// Whole-word containment: `term` must appear in `haystack` bounded by
/// non-alphanumeric characters (or the string ends). `-`, `/`, `.`, `_` and
/// space all count as boundaries, but digits and letters do not — so `github`
/// matches `github-mcp-server` and `omnigit/github` yet not the username
/// `github30` or `mygithub`. `term` is assumed already lowercase.
fn contains_word(haystack: &str, term: &str) -> bool {
    if term.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(term) {
        let start = from + rel;
        let end = start + term.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn curate_with(
    servers: Vec<SmitheryServerSummary>,
    services: &[CuratedService],
) -> Vec<SmitheryServerSummary> {
    let mut out: Vec<SmitheryServerSummary> = Vec::with_capacity(servers.len());
    // service key -> index of the current winner in `out`.
    let mut winner_pos: HashMap<&'static str, usize> = HashMap::new();
    let mut collapsed: usize = 0;

    for server in servers {
        let Some(service) = matched_service(&server, services) else {
            out.push(server);
            continue;
        };
        match winner_pos.get(service.key) {
            Some(&pos) => {
                if outranks(&server, &out[pos], service) {
                    out[pos] = server;
                }
                collapsed += 1;
            }
            None => {
                winner_pos.insert(service.key, out.len());
                out.push(server);
            }
        }
    }

    if collapsed > 0 {
        tracing::debug!(
            "[mcp-registry] curation collapsed {collapsed} server(s) to one-per-service"
        );
    }
    out
}

/// First curated service whose match terms appear, as a whole word, in the
/// server's namespace-stripped qualified name or display name.
fn matched_service<'a>(
    server: &SmitheryServerSummary,
    services: &'a [CuratedService],
) -> Option<&'a CuratedService> {
    let haystack = match_haystack(server);
    services.iter().find(|svc| {
        svc.match_terms
            .iter()
            .any(|term| contains_word(&haystack, term))
    })
}

/// Whether `candidate` should replace the current `incumbent` winner.
fn outranks(
    candidate: &SmitheryServerSummary,
    incumbent: &SmitheryServerSummary,
    service: &CuratedService,
) -> bool {
    if let Some(pin) = service.pinned {
        if candidate.qualified_name == pin {
            return true;
        }
        if incumbent.qualified_name == pin {
            return false;
        }
    }
    rank_key(candidate) > rank_key(incumbent)
}

/// Ranking tuple, compared lexicographically (higher wins): official source,
/// then deployed, then popularity.
fn rank_key(server: &SmitheryServerSummary) -> (bool, bool, u64) {
    (
        server.source == SOURCE_MCP_OFFICIAL,
        server.is_deployed,
        server.use_count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(
        qualified_name: &str,
        source: &str,
        deployed: bool,
        use_count: u64,
    ) -> SmitheryServerSummary {
        SmitheryServerSummary {
            qualified_name: qualified_name.to_string(),
            display_name: qualified_name.to_string(),
            description: None,
            icon_url: None,
            use_count,
            is_deployed: deployed,
            source: source.to_string(),
            verified: false,
            extra: Default::default(),
        }
    }

    const SVCS: &[CuratedService] = &[
        CuratedService {
            key: "gmail",
            match_terms: &["gmail"],
            pinned: Some("com.mintmcp/gmail"),
        },
        CuratedService {
            key: "slack",
            match_terms: &["slack"],
            pinned: None,
        },
    ];

    #[test]
    fn collapses_a_service_to_a_single_row_and_keeps_unknowns() {
        let input = vec![
            server("ai.smithery/faithk7-gmail-mcp", "mcp_official", false, 10),
            server("waystation/gmail", "smithery", false, 5),
            server("acme/weather", "smithery", false, 99), // unknown -> passthrough
            server("com.pulsemcp/gmail", "mcp_official", true, 3),
        ];

        let out = curate_with(input, SVCS);

        let slugs: Vec<_> = out.iter().map(|s| s.qualified_name.as_str()).collect();
        // One gmail (at the first gmail's position) + the unknown server.
        assert_eq!(slugs, vec!["com.pulsemcp/gmail", "acme/weather"]);
    }

    #[test]
    fn pinned_server_wins_even_against_more_popular() {
        let input = vec![
            server("com.pulsemcp/gmail", "mcp_official", true, 1000),
            server("com.mintmcp/gmail", "smithery", false, 1), // pinned, low stats
        ];

        let out = curate_with(input, SVCS);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].qualified_name, "com.mintmcp/gmail");
    }

    #[test]
    fn unpinned_service_falls_back_to_ranking() {
        // slack has no pin -> official+deployed+use_count decides.
        let input = vec![
            server("a/slack", "smithery", false, 500),
            server("b/slack-mcp", "mcp_official", false, 1),
            server("c/slack", "smithery", true, 9),
        ];

        let out = curate_with(input, SVCS);

        assert_eq!(out.len(), 1);
        // official source outranks both popularity and deployed.
        assert_eq!(out[0].qualified_name, "b/slack-mcp");
    }

    #[test]
    fn tag_verified_marks_only_hosted_confirmed_services() {
        let mut servers = vec![
            server("io.sentry/mcp", "mcp_official", true, 1), // hosted + confirmed
            server("acme/sentry-cli", "smithery", false, 1),  // confirmed term but local
            server("x/linear", "mcp_official", true, 1),      // hosted + confirmed
            server("y/random-tool", "mcp_official", true, 1), // hosted, not confirmed
        ];

        tag_verified(&mut servers);

        assert!(servers[0].verified, "hosted sentry should be verified");
        assert!(
            !servers[1].verified,
            "local sentry-cli must not be verified"
        );
        assert!(servers[2].verified, "hosted linear should be verified");
        assert!(
            !servers[3].verified,
            "unknown hosted server is not verified"
        );
    }

    #[test]
    fn preserves_first_seen_position_of_a_service() {
        let input = vec![
            server("acme/weather", "smithery", false, 1),
            server("x/gmail", "smithery", false, 1),
            server("y/notes", "smithery", false, 1),
            server("z/gmail", "mcp_official", false, 9), // winner, but slots into first gmail's place
        ];

        let out = curate_with(input, SVCS);

        let slugs: Vec<_> = out.iter().map(|s| s.qualified_name.as_str()).collect();
        assert_eq!(slugs, vec!["acme/weather", "z/gmail", "y/notes"]);
    }

    const GH: &[CuratedService] = &[CuratedService {
        key: "github",
        match_terms: &["github"],
        pinned: None,
    }];

    /// Build a server with a distinct display name (a title), as the real
    /// registry does — the namespaced slug is never echoed into the title.
    fn server_titled(qualified_name: &str, display: &str, deployed: bool) -> SmitheryServerSummary {
        let mut s = server(qualified_name, "mcp_official", deployed, 1);
        s.display_name = display.to_string();
        s
    }

    #[test]
    fn code_host_namespace_does_not_match_a_service_term() {
        // ~76% of the official registry is namespaced `io.github.<user>/…`. A
        // naive substring match collapses all of them into one "github" row;
        // stripping the code-host root must keep these as independent rows.
        let input = vec![
            server_titled("io.github.alice/weather", "Weather", false),
            server_titled("io.github.000safah000-ai/blackhawk-mcp", "Blackhawk", false),
            // A real GitHub tool, namespaced under the GitHub org, survives as the
            // sole collapsed "github" row.
            server_titled("io.github.github/github-mcp-server", "GitHub", true),
        ];

        let out = curate_with(input, GH);

        let slugs: Vec<_> = out.iter().map(|s| s.qualified_name.as_str()).collect();
        assert_eq!(
            slugs,
            vec![
                "io.github.alice/weather",
                "io.github.000safah000-ai/blackhawk-mcp",
                "io.github.github/github-mcp-server",
            ]
        );
    }

    #[test]
    fn contains_word_respects_boundaries() {
        assert!(contains_word("github-mcp-server x", "github"));
        assert!(contains_word("omnigit/github", "github"));
        assert!(contains_word("io.sentry/mcp", "sentry"));
        // Username-style and glued forms must not match.
        assert!(!contains_word("github30/note-mcp-server", "github"));
        assert!(!contains_word("mygithub/tool", "github"));
        assert!(!contains_word("", "github"));
    }

    #[test]
    fn match_haystack_strips_code_host_prefix_only() {
        let gh = server(
            "io.github.github/github-mcp-server",
            "mcp_official",
            true,
            1,
        );
        assert!(match_haystack(&gh).starts_with("github/github-mcp-server"));
        // Vendor namespaces are left intact so their term still matches.
        let vendor = server("com.stripe/payments", "mcp_official", true, 1);
        assert_eq!(
            match_haystack(&vendor),
            "com.stripe/payments com.stripe/payments"
        );
    }
}
