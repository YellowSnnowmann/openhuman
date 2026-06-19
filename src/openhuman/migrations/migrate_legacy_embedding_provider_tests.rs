use super::*;
use crate::openhuman::embeddings::{
    DEFAULT_CLOUD_EMBEDDING_DIMENSIONS, DEFAULT_CLOUD_EMBEDDING_MODEL,
};

fn config_with_provider(provider: &str, model: &str, dims: usize) -> Config {
    let mut config = Config::default();
    config.memory.embedding_provider = provider.to_string();
    config.memory.embedding_model = model.to_string();
    config.memory.embedding_dimensions = dims;
    config
}

#[test]
fn rewrites_fastembed_to_managed_with_cloud_defaults() {
    let mut config = config_with_provider("fastembed", "BGESmallENV15", 384);

    let stats = run(&mut config).expect("migration should succeed");

    assert!(stats.provider_migrated, "fastembed must be migrated");
    assert_eq!(stats.old_dimensions, 384);
    assert_eq!(stats.new_dimensions, DEFAULT_CLOUD_EMBEDDING_DIMENSIONS);
    assert_eq!(config.memory.embedding_provider, "managed");
    assert_eq!(config.memory.embedding_model, DEFAULT_CLOUD_EMBEDDING_MODEL);
    assert_eq!(
        config.memory.embedding_dimensions,
        DEFAULT_CLOUD_EMBEDDING_DIMENSIONS
    );
}

#[test]
fn is_idempotent() {
    let mut config = config_with_provider("fastembed", "BGESmallENV15", 384);
    run(&mut config).expect("first run");
    let stats = run(&mut config).expect("second run");
    assert!(
        !stats.provider_migrated,
        "second run must be a no-op once provider is managed"
    );
    assert_eq!(config.memory.embedding_provider, "managed");
}

#[test]
fn matches_case_insensitively_and_trims() {
    let mut config = config_with_provider("  FastEmbed  ", "BGESmallENV15", 384);
    let stats = run(&mut config).expect("migration should succeed");
    assert!(stats.provider_migrated);
    assert_eq!(config.memory.embedding_provider, "managed");
}

#[test]
fn leaves_valid_providers_untouched() {
    for provider in ["managed", "ollama", "voyage", "none", "openai"] {
        let mut config = config_with_provider(provider, "some-model", 1024);
        let stats = run(&mut config).expect("migration should succeed");
        assert!(
            !stats.provider_migrated,
            "{provider} must not be migrated"
        );
        assert_eq!(config.memory.embedding_provider, provider);
        assert_eq!(config.memory.embedding_model, "some-model");
        assert_eq!(config.memory.embedding_dimensions, 1024);
    }
}
