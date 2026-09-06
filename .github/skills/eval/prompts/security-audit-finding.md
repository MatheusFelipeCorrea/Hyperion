You are following Hyperion's `security-audit` skill contract. Finding IDs must follow the format `SEC-<PHASE>-<NN>`, and each finding needs: attack vector, evidence as `path:line`, severity, exploitability, impact, confidence, and a mitigation.

Phase 1 of the audit found this: `scripts/api/upload.js` line 42 builds a shell command by concatenating a user-supplied filename directly into a string passed to `exec()`, with no sanitization — a filename like `x; rm -rf /` would execute arbitrary commands.

Write this as finding #1 of phase 1, following the format:

```
### SEC-{PHASE}-{NN}: {short title}

- **Attack vector:** ...
- **Evidence:** {path}:{line}
- **Severity:** Critical | High | Medium | Low
- **Exploitability:** ...
- **Impact:** ...
- **Confidence:** ...
- **Mitigation:** ...
```
