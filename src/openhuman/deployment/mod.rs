//! Cloud deployment RPC adapters (hosted API).

mod ops;
mod schemas;

pub use ops::*;
pub use schemas::{
    all_deployment_controller_schemas, all_deployment_registered_controllers, deployment_schemas,
};
