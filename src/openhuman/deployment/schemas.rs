use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::core::all::{ControllerFuture, RegisteredController};
use crate::core::{ControllerSchema, FieldSchema, TypeSchema};
use crate::openhuman::config::rpc as config_rpc;
use crate::rpc::RpcOutcome;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentProvisionParams {
    aws_access_key_id: String,
    aws_secret_access_key: String,
    aws_region: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentTerminateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_access_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_secret_access_key: Option<String>,
}

pub fn all_deployment_controller_schemas() -> Vec<ControllerSchema> {
    vec![
        deployment_schemas("deployment_get_core_token"),
        deployment_schemas("deployment_provision"),
        deployment_schemas("deployment_get_status"),
        deployment_schemas("deployment_get_health"),
        deployment_schemas("deployment_terminate"),
    ]
}

pub fn all_deployment_registered_controllers() -> Vec<RegisteredController> {
    vec![
        RegisteredController {
            schema: deployment_schemas("deployment_get_core_token"),
            handler: handle_deployment_get_core_token,
        },
        RegisteredController {
            schema: deployment_schemas("deployment_provision"),
            handler: handle_deployment_provision,
        },
        RegisteredController {
            schema: deployment_schemas("deployment_get_status"),
            handler: handle_deployment_get_status,
        },
        RegisteredController {
            schema: deployment_schemas("deployment_get_health"),
            handler: handle_deployment_get_health,
        },
        RegisteredController {
            schema: deployment_schemas("deployment_terminate"),
            handler: handle_deployment_terminate,
        },
    ]
}

pub fn deployment_schemas(function: &str) -> ControllerSchema {
    match function {
        "deployment_get_core_token" => ControllerSchema {
            namespace: "deployment",
            function: "get_core_token",
            description: "Fetch the current user's remote core token from the hosted API.",
            inputs: vec![],
            outputs: vec![json_output(
                "token",
                "Payload from GET /auth/me/core-token.",
            )],
        },
        "deployment_provision" => ControllerSchema {
            namespace: "deployment",
            function: "provision",
            description: "Provision a BYOC cloud core instance through the hosted API.",
            inputs: vec![
                string_input(
                    "awsAccessKeyId",
                    "AWS access key ID used for provisioning.",
                    true,
                ),
                string_input(
                    "awsSecretAccessKey",
                    "AWS secret access key used for provisioning.",
                    true,
                ),
                string_input("awsRegion", "AWS region for the instance.", true),
                optional_string_input("imageTag", "Optional core image tag override."),
                optional_string_input("domain", "Optional custom domain for the deployment."),
            ],
            outputs: vec![json_output(
                "deployment",
                "Payload from POST /deployments/provision.",
            )],
        },
        "deployment_get_status" => ControllerSchema {
            namespace: "deployment",
            function: "get_status",
            description: "Fetch the current user's cloud deployment status.",
            inputs: vec![],
            outputs: vec![json_output(
                "deployment",
                "Payload from GET /deployments/status, or null when no deployment exists.",
            )],
        },
        "deployment_get_health" => ControllerSchema {
            namespace: "deployment",
            function: "get_health",
            description: "Check health for the current user's cloud deployment.",
            inputs: vec![],
            outputs: vec![json_output(
                "health",
                "Payload from GET /deployments/health.",
            )],
        },
        "deployment_terminate" => ControllerSchema {
            namespace: "deployment",
            function: "terminate",
            description: "Terminate the current user's cloud deployment.",
            inputs: vec![
                optional_string_input(
                    "awsAccessKeyId",
                    "Optional AWS access key ID for cleanup when required.",
                ),
                optional_string_input(
                    "awsSecretAccessKey",
                    "Optional AWS secret access key for cleanup when required.",
                ),
            ],
            outputs: vec![json_output(
                "deployment",
                "Payload from POST /deployments/terminate.",
            )],
        },
        _ => ControllerSchema {
            namespace: "deployment",
            function: "unknown",
            description: "Unknown deployment controller.",
            inputs: vec![],
            outputs: vec![FieldSchema {
                name: "error",
                ty: TypeSchema::String,
                comment: "Lookup error details.",
                required: true,
            }],
        },
    }
}

fn handle_deployment_get_core_token(_params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        let config = config_rpc::load_config_with_timeout().await?;
        to_json(crate::openhuman::deployment::get_core_token(&config).await?)
    })
}

fn handle_deployment_provision(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        let config = config_rpc::load_config_with_timeout().await?;
        let payload = deserialize_params::<DeploymentProvisionParams>(params)?;
        to_json(crate::openhuman::deployment::provision(&config, json!(payload)).await?)
    })
}

fn handle_deployment_get_status(_params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        let config = config_rpc::load_config_with_timeout().await?;
        to_json(crate::openhuman::deployment::get_status(&config).await?)
    })
}

fn handle_deployment_get_health(_params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        let config = config_rpc::load_config_with_timeout().await?;
        to_json(crate::openhuman::deployment::get_health(&config).await?)
    })
}

fn handle_deployment_terminate(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        let config = config_rpc::load_config_with_timeout().await?;
        let payload = deserialize_params::<DeploymentTerminateParams>(params)?;
        to_json(crate::openhuman::deployment::terminate(&config, json!(payload)).await?)
    })
}

fn to_json(outcome: RpcOutcome<Value>) -> Result<Value, String> {
    outcome.into_cli_compatible_json()
}

fn deserialize_params<T: DeserializeOwned>(params: Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(params)).map_err(|e| format!("invalid params: {e}"))
}

fn string_input(name: &'static str, comment: &'static str, required: bool) -> FieldSchema {
    FieldSchema {
        name,
        ty: TypeSchema::String,
        comment,
        required,
    }
}

fn optional_string_input(name: &'static str, comment: &'static str) -> FieldSchema {
    FieldSchema {
        name,
        ty: TypeSchema::Option(Box::new(TypeSchema::String)),
        comment,
        required: false,
    }
}

fn json_output(name: &'static str, comment: &'static str) -> FieldSchema {
    FieldSchema {
        name,
        ty: TypeSchema::Json,
        comment,
        required: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_deployment_controller_schemas_advertises_expected_methods() {
        let names: Vec<_> = all_deployment_controller_schemas()
            .into_iter()
            .map(|s| s.function)
            .collect();
        assert_eq!(
            names,
            vec![
                "get_core_token",
                "provision",
                "get_status",
                "get_health",
                "terminate"
            ]
        );
    }

    #[test]
    fn registered_controllers_match_schema_count() {
        assert_eq!(
            all_deployment_registered_controllers().len(),
            all_deployment_controller_schemas().len()
        );
    }

    #[test]
    fn provision_params_require_aws_credentials_and_region() {
        let err = serde_json::from_value::<DeploymentProvisionParams>(json!({
            "awsAccessKeyId": "AKIA"
        }))
        .unwrap_err();
        assert!(err.to_string().contains("awsSecretAccessKey"));
    }

    #[test]
    fn provision_params_serialize_camel_case() {
        let payload = DeploymentProvisionParams {
            aws_access_key_id: "AKIA".to_string(),
            aws_secret_access_key: "secret".to_string(),
            aws_region: "us-east-1".to_string(),
            image_tag: Some("v1".to_string()),
            domain: None,
        };
        assert_eq!(
            json!(payload),
            json!({
                "awsAccessKeyId": "AKIA",
                "awsSecretAccessKey": "secret",
                "awsRegion": "us-east-1",
                "imageTag": "v1"
            })
        );
    }

    #[test]
    fn terminate_params_allow_empty_payload() {
        let payload = serde_json::from_value::<DeploymentTerminateParams>(json!({})).unwrap();
        assert!(payload.aws_access_key_id.is_none());
        assert!(payload.aws_secret_access_key.is_none());
    }
}
