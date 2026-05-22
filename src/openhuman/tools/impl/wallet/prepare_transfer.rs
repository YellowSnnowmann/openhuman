use crate::openhuman::tools::traits::{Tool, ToolCallOptions, ToolResult};
use crate::openhuman::wallet::{self, PrepareTransferParams};
use async_trait::async_trait;
use serde_json::json;

pub struct WalletPrepareTransferTool;

impl WalletPrepareTransferTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for WalletPrepareTransferTool {
    fn name(&self) -> &str {
        "wallet_prepare_transfer"
    }

    fn description(&self) -> &str {
        "Prepare a cryptocurrency transfer. Returns a quote that must be confirmed before execution."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "chain": {
                    "type": "string",
                    "enum": ["evm", "btc", "solana", "tron"],
                    "description": "Blockchain network to use"
                },
                "toAddress": {
                    "type": "string",
                    "description": "Destination wallet address"
                },
                "amountRaw": {
                    "type": "string",
                    "description": "Transfer amount in the chain's smallest unit (e.g. wei for EVM)"
                },
                "assetSymbol": {
                    "type": "string",
                    "description": "Asset symbol (e.g. ETH, USDC). Defaults to the native asset."
                }
            },
            "required": ["chain", "toAddress", "amountRaw"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: serde_json::Value) -> anyhow::Result<ToolResult> {
        self.execute_with_options(args, ToolCallOptions::default())
            .await
    }

    async fn execute_with_options(
        &self,
        args: serde_json::Value,
        _options: ToolCallOptions,
    ) -> anyhow::Result<ToolResult> {
        let params: PrepareTransferParams = match serde_json::from_value(args) {
            Ok(p) => p,
            Err(e) => return Ok(ToolResult::error(format!("invalid arguments: {e}"))),
        };

        match wallet::prepare_transfer(params).await {
            Ok(outcome) => {
                let json_str = serde_json::to_string_pretty(&outcome.value)?;
                Ok(ToolResult::success(json_str))
            }
            Err(e) => Ok(ToolResult::error(e)),
        }
    }
}
