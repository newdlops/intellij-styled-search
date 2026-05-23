# Project Instructions

## Generalization Requirement

When fixing graph/index inference, reference resolution, fallback, pruning, usage counts, or related tests, do not solve the problem with project-specific or measurement-corpus-specific overfitting.

Required approach:

- Use language semantics, framework semantics, type information, import/export structure, annotations, inheritance, and other general structural evidence.
- Do not hardcode project, package, file, class, method, field, variable, or domain names taken from a specific repository or report sample.
- Do not keep a test solely by renaming domain-specific fixture symbols to neutral names. A test must exercise a general rule that would apply to real projects with different names.
- If a regression sample comes from a specific project, translate it into a minimal fixture that preserves the language/framework structure, not the domain vocabulary.
- Prefer false positives over false negatives only through general conservative rules, not through project-specific keyword lists.
