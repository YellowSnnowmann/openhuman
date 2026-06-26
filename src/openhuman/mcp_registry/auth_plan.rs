//! Unified, probe-based auth classification for an MCP server.
//!
//! The registry's declared headers / env-vars / `source` are *claims* and are
//! routinely wrong (under-declared, mislabelled, or out of date). The only
//! reliable signal for a hosted server is the server's own response to an
//! unauthenticated `initialize`: a 200 means open, a 401 with RFC 9728
//! `resource_metadata` means browser OAuth, a bare 401 means a static API key.
//!
//! [`build_auth_plan`] folds the registry claim and the live probe into one
//! [`AuthPlan`] that every surface (install screen, connect modal) renders from
//! — so they can never tell the user two different auth stories again. When the
//! claim and the probe disagree, the probe wins and the disagreement is
//! surfaced as a [`AuthMismatch`].

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

use crate::openhuman::mcp_client::McpHttpClient;

use super::types::SmitheryServerDetail;

/// What the live probe observed at the remote endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Observed {
    /// `initialize` succeeded without a 401 — no auth required.
    Open,
    /// 401 advertised OAuth (RFC 9728 protected-resource metadata) → sign-in.
    OAuth,
    /// Bare 401 with no OAuth metadata → static API key / bearer.
    ApiKey,
    /// Could not determine (transient error, unreachable, unparseable 401).
    Unknown,
}

/// One credential input a server declares (from a connection's `config_schema`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuthField {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub secret: bool,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub get_key_url: Option<String>,
    /// `"header"` (http remote) or `"env"` (stdio package).
    pub location: String,
}

/// Set when the registry's claimed auth disagreed with the live probe. The
/// probe is authoritative; this exists so the UI can say "the listing said X
/// but the server actually wants Y."
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuthMismatch {
    pub declared: String,
    pub observed: String,
}

/// The single source of truth for how a server authenticates. Rendered by both
/// the install screen and the connect modal.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuthPlan {
    /// `"open"` · `"oauth"` · `"api_key"` · `"unknown"`.
    pub method: String,
    /// `"probed"` (from a live 401/200) or `"declared"` (registry hint only —
    /// stdio servers, or a remote we couldn't reach).
    pub confidence: String,
    /// Declared credential inputs — rendered when `method == "api_key"`.
    pub fields: Vec<AuthField>,
    /// Friendly name for the "Sign in with X" button when `method == "oauth"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Present when the registry claim disagreed with the probe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mismatch: Option<AuthMismatch>,
}

const METHOD_OPEN: &str = "open";
const METHOD_OAUTH: &str = "oauth";
const METHOD_API_KEY: &str = "api_key";
const METHOD_UNKNOWN: &str = "unknown";

/// Extract declared credential fields from one connection's `config_schema`
/// (the `{properties, required}` shape the registry adapters stamp, carrying
/// `x-secret` / `x-get-key-url`).
fn fields_from_schema(schema: &Value, location: &str) -> Vec<AuthField> {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let required: HashSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    props
        .iter()
        .map(|(name, spec)| AuthField {
            name: name.clone(),
            description: spec
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            secret: spec
                .get("x-secret")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            required: required.contains(name.as_str()),
            get_key_url: spec
                .get("x-get-key-url")
                .and_then(Value::as_str)
                .map(str::to_string),
            location: location.to_string(),
        })
        .collect()
}

/// Collect every declared field across a server's connections (deduped by
/// name, first occurrence wins) and the first usable http remote URL.
fn declared(detail: &SmitheryServerDetail) -> (Vec<AuthField>, Option<String>) {
    let mut fields: Vec<AuthField> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut http_url: Option<String> = None;
    for conn in &detail.connections {
        let location = if conn.r#type == "stdio" {
            "env"
        } else {
            "header"
        };
        if let Some(schema) = &conn.config_schema {
            for field in fields_from_schema(schema, location) {
                if seen.insert(field.name.clone()) {
                    fields.push(field);
                }
            }
        }
        if conn.r#type == "http" {
            if let Some(url) = conn.deployment_url.as_deref().filter(|u| !u.is_empty()) {
                http_url.get_or_insert_with(|| url.to_string());
            }
        }
    }
    (fields, http_url)
}

/// The registry's *claimed* method, from declared fields alone: a declared
/// secret field implies an API key, otherwise we assume open (pre-probe).
fn declared_method(fields: &[AuthField]) -> &'static str {
    if fields.iter().any(|f| f.secret) {
        METHOD_API_KEY
    } else {
        METHOD_OPEN
    }
}

/// Fold the declared claim and the (optional) probe result into the final plan.
/// Pure — the network probe happens in [`build_auth_plan`].
fn finalize(
    declared_method: &str,
    fields: Vec<AuthField>,
    observed: Option<Observed>,
    provider: String,
) -> AuthPlan {
    // Resolve the authoritative method + how confident we are.
    let (method, confidence) = match observed {
        Some(Observed::Open) => (METHOD_OPEN, "probed"),
        Some(Observed::OAuth) => (METHOD_OAUTH, "probed"),
        Some(Observed::ApiKey) => (METHOD_API_KEY, "probed"),
        // Probe inconclusive: keep a declared API-key claim (we have fields to
        // show), else admit we don't know rather than guess "open".
        Some(Observed::Unknown) => {
            if declared_method == METHOD_API_KEY {
                (METHOD_API_KEY, "declared")
            } else {
                (METHOD_UNKNOWN, "declared")
            }
        }
        // No remote to probe (stdio): the declared claim is all we have.
        None => (declared_method, "declared"),
    };

    // Claim-vs-reality: only when the probe gave a definite, differing answer.
    let mismatch = match observed {
        Some(Observed::Open) | Some(Observed::OAuth) | Some(Observed::ApiKey)
            if method != declared_method =>
        {
            Some(AuthMismatch {
                declared: declared_method.to_string(),
                observed: method.to_string(),
            })
        }
        _ => None,
    };

    AuthPlan {
        method: method.to_string(),
        confidence: confidence.to_string(),
        // Fields only matter when the user pastes a key; drop them otherwise so
        // an OAuth/open server never renders stray credential inputs.
        fields: if method == METHOD_API_KEY {
            fields
        } else {
            Vec::new()
        },
        provider: if method == METHOD_OAUTH {
            Some(provider)
        } else {
            None
        },
        mismatch,
    }
}

/// Probe a hosted remote with an unauthenticated `initialize` and classify the
/// response. Network call; never panics — a failure maps to [`Observed::Unknown`].
pub(crate) async fn probe_remote(url: &str) -> Observed {
    let client = McpHttpClient::new(url.to_string(), 15);
    match client.discover_authorization().await {
        Ok(None) => Observed::Open,
        Ok(Some(ctx)) => match super::oauth::classify_auth_context(&ctx).kind.as_str() {
            "oauth" => Observed::OAuth,
            _ => Observed::ApiKey,
        },
        Err(_) => Observed::Unknown,
    }
}

/// Build the unified [`AuthPlan`] for a server detail: read its declared
/// credential fields, probe its http remote (if any), and reconcile the two.
pub async fn build_auth_plan(detail: &SmitheryServerDetail) -> AuthPlan {
    let (fields, http_url) = declared(detail);
    let declared_method = declared_method(&fields);
    let observed = match http_url.as_deref() {
        Some(url) => Some(probe_remote(url).await),
        None => None, // stdio-only: nothing to probe
    };
    finalize(
        declared_method,
        fields,
        observed,
        detail.display_name.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn detail_with(connections: Value) -> SmitheryServerDetail {
        serde_json::from_value(json!({
            "qualified_name": "x/y",
            "display_name": "Example",
            "connections": connections,
            "source": "smithery",
        }))
        .unwrap()
    }

    #[test]
    fn fields_parse_secret_required_and_get_key() {
        let schema = json!({
            "properties": {
                "API_KEY": { "description": "Generate at https://x.io/keys", "x-secret": true,
                             "x-get-key-url": "https://x.io/keys" },
                "REGION": { "description": "AWS region" }
            },
            "required": ["API_KEY"]
        });
        let fields = fields_from_schema(&schema, "env");
        let key = fields.iter().find(|f| f.name == "API_KEY").unwrap();
        assert!(key.secret && key.required);
        assert_eq!(key.get_key_url.as_deref(), Some("https://x.io/keys"));
        let region = fields.iter().find(|f| f.name == "REGION").unwrap();
        assert!(!region.secret && !region.required);
    }

    #[test]
    fn probe_oauth_overrides_a_declared_token_and_records_mismatch() {
        // Registry declared an Authorization header (looks like a token), but
        // the live probe found OAuth — the golemry case. Plan must be OAuth,
        // carry no credential fields, and flag the mismatch.
        let fields = vec![AuthField {
            name: "Authorization".into(),
            description: None,
            secret: true,
            required: true,
            get_key_url: None,
            location: "header".into(),
        }];
        let plan = finalize(
            METHOD_API_KEY,
            fields,
            Some(Observed::OAuth),
            "Golemry".into(),
        );
        assert_eq!(plan.method, "oauth");
        assert_eq!(plan.confidence, "probed");
        assert!(plan.fields.is_empty(), "oauth shows no key box");
        assert_eq!(plan.provider.as_deref(), Some("Golemry"));
        let m = plan
            .mismatch
            .expect("declared token vs observed oauth is a mismatch");
        assert_eq!(m.declared, "api_key");
        assert_eq!(m.observed, "oauth");
    }

    #[test]
    fn probe_open_yields_no_auth_and_no_fields() {
        let plan = finalize(METHOD_OPEN, vec![], Some(Observed::Open), "X".into());
        assert_eq!(plan.method, "open");
        assert_eq!(plan.confidence, "probed");
        assert!(plan.fields.is_empty() && plan.provider.is_none() && plan.mismatch.is_none());
    }

    #[test]
    fn probed_api_key_keeps_declared_fields() {
        let fields = vec![AuthField {
            name: "X-API-Key".into(),
            description: None,
            secret: true,
            required: true,
            get_key_url: Some("https://k".into()),
            location: "header".into(),
        }];
        let plan = finalize(
            METHOD_API_KEY,
            fields.clone(),
            Some(Observed::ApiKey),
            "X".into(),
        );
        assert_eq!(plan.method, "api_key");
        assert_eq!(plan.fields, fields);
        assert!(plan.mismatch.is_none(), "claim matched the probe");
    }

    #[test]
    fn unreachable_remote_with_open_claim_is_unknown_not_open() {
        // A probe failure must not be reported as a confident "open" — that
        // would tell the user no auth is needed when we simply couldn't reach it.
        let plan = finalize(METHOD_OPEN, vec![], Some(Observed::Unknown), "X".into());
        assert_eq!(plan.method, "unknown");
        assert_eq!(plan.confidence, "declared");
    }

    #[test]
    fn stdio_only_server_uses_declared_claim_without_probing() {
        // No http connection → http_url is None → declared() drives the plan.
        let detail = detail_with(json!([
            { "type": "stdio", "config_schema": {
                "properties": { "TOKEN": { "x-secret": true } }, "required": ["TOKEN"] } }
        ]));
        let (fields, http_url) = declared(&detail);
        assert!(http_url.is_none());
        let plan = finalize(
            declared_method(&fields),
            fields,
            None,
            detail.display_name.clone(),
        );
        assert_eq!(plan.method, "api_key");
        assert_eq!(plan.confidence, "declared");
        assert_eq!(plan.fields.len(), 1);
    }

    #[test]
    fn declared_collects_http_url_and_dedupes_fields() {
        let detail = detail_with(json!([
            { "type": "http", "deployment_url": "https://r/mcp", "config_schema": {
                "properties": { "Authorization": { "x-secret": true } } } },
            { "type": "stdio", "config_schema": {
                "properties": { "Authorization": { "x-secret": true } } } }
        ]));
        let (fields, http_url) = declared(&detail);
        assert_eq!(http_url.as_deref(), Some("https://r/mcp"));
        assert_eq!(fields.len(), 1, "duplicate field name collapses");
    }
}
