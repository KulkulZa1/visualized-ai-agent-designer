# Risks

## Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Tauri plugin breaking changes | Low | High | Pin plugin versions in Cargo.lock |
| React Flow v12 API instability | Low | Medium | Pin to exact version |
| Monaco Editor lazy-load fails on first open | Medium | Low | Add loading state and fallback |
| Rust compile time slows iteration | High | Low | Use incremental builds; `cargo check` for quick feedback |
| Path traversal not caught in edge cases | Low | High | Unit tests + Rust canonicalize() before assertion |
| YAML parsing inconsistency between Rust and JS | Low | Medium | Use serde_yaml (YAML 1.2) + yaml npm package v2 (YAML 1.2) |

## Security Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Malicious hook scripts | Medium | High | Consent gate + timeout + audit log |
| Path traversal via crafted filenames | Low | High | resolve_safe_path() in all Rust commands |
| API key leaked in audit log | Medium | High | Audit entries never include key values |
| Prompt injection via agent output | Medium | Medium | Input validation at IPC boundaries |
| Vulnerable npm dependency | Medium | Medium | npm audit in CI |
| Vulnerable Cargo dependency | Low | Medium | cargo audit in CI |

## Commercial Risks (Future)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Competing tool adds same features | High | Medium | Focus on local-first UX and debuggability as differentiators |
| License incompatibility | Low | High | Review all deps before first commercial release |
| Telemetry without consent (legal risk) | N/A | High | No telemetry without explicit opt-in |
