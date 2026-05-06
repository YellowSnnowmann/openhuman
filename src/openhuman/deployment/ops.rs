//! Cloud deployment operations — authenticated calls to the hosted API.
//!
//! The desktop WebView runs from `http://tauri.localhost`, so direct browser
//! requests to temporary API hosts such as ngrok can fail CORS. These ops route
//! deployment API calls through the core's reqwest client, matching billing and
//! referral.

use reqwest::Method;
use serde_json::Value;

use crate::api::config::effective_api_url;
use crate::api::jwt::get_session_token;
use crate::api::BackendOAuthClient;
use crate::openhuman::config::Config;
use crate::rpc::RpcOutcome;

fn require_token(config: &Config) -> Result<String, String> {
    get_session_token(config)?
        .and_then(|v| {
            let t = v.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
        .ok_or_else(|| "no backend session token; run auth_store_session first".to_string())
}

async fn deployment_api_value(
    config: &Config,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = require_token(config)?;
    let api_url = effective_api_url(&config.api_url);
    let client = BackendOAuthClient::new(&api_url).map_err(|e| e.to_string())?;
    let data = client
        .authed_json(&token, method, path, body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(normalize_null_data_envelope(data))
}

fn normalize_null_data_envelope(value: Value) -> Value {
    let Some(obj) = value.as_object() else {
        return value;
    };
    if obj.len() == 1 && obj.get("data").is_some_and(Value::is_null) {
        return Value::Null;
    }
    value
}

pub async fn get_core_token(config: &Config) -> Result<RpcOutcome<Value>, String> {
    let data = deployment_api_value(config, Method::GET, "/auth/me/core-token", None).await?;
    Ok(RpcOutcome::single_log(
        data,
        "deployment core token fetched",
    ))
}

pub async fn provision(config: &Config, payload: Value) -> Result<RpcOutcome<Value>, String> {
    let data = deployment_api_value(
        config,
        Method::POST,
        "/deployments/provision",
        Some(payload),
    )
    .await?;
    Ok(RpcOutcome::single_log(
        data,
        "cloud deployment provision request accepted",
    ))
}

pub async fn get_status(config: &Config) -> Result<RpcOutcome<Value>, String> {
    let data = deployment_api_value(config, Method::GET, "/deployments/status", None).await?;
    Ok(RpcOutcome::single_log(
        data,
        "cloud deployment status fetched",
    ))
}

pub async fn get_health(config: &Config) -> Result<RpcOutcome<Value>, String> {
    let data = deployment_api_value(config, Method::GET, "/deployments/health", None).await?;
    Ok(RpcOutcome::single_log(
        data,
        "cloud deployment health fetched",
    ))
}

pub async fn terminate(config: &Config, payload: Value) -> Result<RpcOutcome<Value>, String> {
    let data = deployment_api_value(
        config,
        Method::POST,
        "/deployments/terminate",
        Some(payload),
    )
    .await?;
    Ok(RpcOutcome::single_log(
        data,
        "cloud deployment termination requested",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_null_data_envelope_preserves_backend_null_data() {
        assert_eq!(
            normalize_null_data_envelope(json!({ "data": null })),
            Value::Null
        );
    }

    #[test]
    fn normalize_null_data_envelope_leaves_regular_payloads_untouched() {
        let payload = json!({ "deploymentId": "dep_1", "status": "active" });
        assert_eq!(normalize_null_data_envelope(payload.clone()), payload);
    }
}
