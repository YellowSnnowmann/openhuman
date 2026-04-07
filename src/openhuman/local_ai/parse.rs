//! Parse model output into suggestions and inline completions.

use super::types::Suggestion;

pub(crate) fn parse_suggestions(raw: &str, limit: usize) -> Vec<Suggestion> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-'))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(limit)
        .map(|text| Suggestion {
            text: text.to_string(),
            confidence: 0.65,
        })
        .collect()
}

fn normalize_inline_text(value: &str) -> String {
    value
        .replace('\u{200B}', "")
        .replace('\u{200C}', "")
        .replace('\u{200D}', "")
        .replace('\u{FEFF}', "")
        .replace('\u{00A0}', " ")
        .replace('\u{2028}', " ")
        .replace('\u{2029}', " ")
        .replace('\t', " ")
        .replace('→', " ")
}

fn trim_generation_prefixes(mut value: &str) -> &str {
    value = value.trim_start();

    // Common wrappers from LLM output formatting.
    for prefix in ["suffix:", "completion:", "result:", "output:"] {
        if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
            value = value[prefix.len()..].trim_start();
            break;
        }
    }

    value
}

pub(crate) fn sanitize_inline_completion(raw: &str, context: &str) -> String {
    let raw_norm = normalize_inline_text(raw);
    let mut line = raw_norm
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if line.is_empty() {
        return String::new();
    }

    line = trim_generation_prefixes(&line).to_string();

    let mut cleaned = line
        .trim_matches('"')
        .trim_start_matches(|c: char| matches!(c, '-' | '*' | '>' | '→' | '1'..='9' | '.' | ')'))
        .trim()
        .to_string();

    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    if cleaned.eq_ignore_ascii_case("none") || cleaned.eq_ignore_ascii_case("n/a") {
        return String::new();
    }

    let context_norm = normalize_inline_text(context)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Avoid overly aggressive overlap stripping for very short contexts.
    // Example: context="hello", model="hello world" should usually stay as
    // "hello world" instead of collapsing to "world".
    const MIN_CONTEXT_CHARS_FOR_DEDUP: usize = 6;
    let should_dedup_against_context = context_norm.chars().count() >= MIN_CONTEXT_CHARS_FOR_DEDUP;

    if !context_norm.is_empty() && should_dedup_against_context {
        // If model returned full text, keep suffix only.
        if cleaned.starts_with(&context_norm) {
            cleaned = cleaned[context_norm.len()..].trim_start().to_string();
        } else {
            // Remove overlap between end of context and start of prediction.
            let cleaned_chars: Vec<char> = cleaned.chars().collect();
            let max_overlap = context_norm
                .chars()
                .count()
                .min(cleaned_chars.len())
                .min(160);
            for overlap in (1..=max_overlap).rev() {
                let overlap_prefix: String = cleaned_chars.iter().take(overlap).collect();
                if context_norm.ends_with(&overlap_prefix) {
                    cleaned = cleaned_chars
                        .iter()
                        .skip(overlap)
                        .collect::<String>()
                        .trim_start()
                        .to_string();
                    break;
                }
            }
        }

        // If "completion" is already part of the context tail, drop it.
        if !cleaned.is_empty() && context_norm.ends_with(&cleaned) {
            return String::new();
        }
    }

    if cleaned.chars().count() > 96 {
        cleaned = cleaned.chars().take(96).collect();
    }

    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_suggestions_strips_numbering_and_respects_limit() {
        let raw = "1. First idea\n- Second idea\n3) Third idea\n";
        let out = parse_suggestions(raw, 2);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "First idea");
        assert_eq!(out[1].text, "Second idea");
        assert!((out[0].confidence - 0.65).abs() < f32::EPSILON);
    }

    #[test]
    fn sanitize_inline_completion_handles_placeholders_and_clamps_length() {
        assert_eq!(sanitize_inline_completion("none", "hello"), "");
        assert_eq!(sanitize_inline_completion("n/a", "hello"), "");
        assert_eq!(
            sanitize_inline_completion("\"- hello world\"", "hello"),
            "hello world"
        );

        let long = "a".repeat(256);
        let out = sanitize_inline_completion(&long, "hello");
        assert_eq!(out.chars().count(), 96);
    }

    #[test]
    fn sanitize_inline_completion_strips_arrow_and_extra_whitespace() {
        assert_eq!(
            sanitize_inline_completion("\t→  keep   it concise\t", "hello"),
            "keep it concise"
        );
    }

    #[test]
    fn sanitize_inline_completion_returns_suffix_only_when_model_repeats_context() {
        let ctx = "Yesterday, I went";
        let raw = "Yesterday, I went to the garden";
        assert_eq!(sanitize_inline_completion(raw, ctx), "to the garden");
    }

    #[test]
    fn sanitize_inline_completion_drops_tabby_unicode_noise() {
        let ctx = "Yester";
        let raw = "Yester\tday, \u{2028}I went\t to garden";
        assert_eq!(
            sanitize_inline_completion(raw, ctx),
            "day, I went to garden"
        );
    }
}
