---
name: compliance-audit
description: >-
  Scans the codebase for common LGPD/GDPR technical signals — personal data
  handling, retention, consent, and cross-border transfer patterns. A
  technical starting point for a legal review, not a substitute for one.
  Use when the user asks about data privacy compliance, LGPD, or GDPR.
---

# Compliance Audit — LGPD/GDPR (technical signals only)

**This is not legal advice and does not certify compliance.** LGPD (Brazil) and GDPR (EU) are legal frameworks; whether a system actually complies depends on facts a codebase scan can't see — the legal basis for processing, contracts with processors, actual company practice, DPO sign-off. This skill finds **technical signals** a legal/privacy reviewer would want to see, and flags where the code and the stated privacy practice might not match. Always route findings through the user's actual legal/DPO process before treating anything here as a conclusion.

## Step 1 — Context

Read:
- `.github/project.yml` — stack, apps, `locale` (Brazil-facing product → LGPD is the relevant framework; EU-facing → GDPR; both regimes overlap heavily, most findings below apply to either)
- Any existing privacy policy, terms of service, or data-processing doc in the repo
- `.github/memory/DECISIONS.md` — has a legal basis for processing already been documented?

## Step 2 — Scan for personal-data handling signals

| Signal | What to look for |
|--------|-------------------|
| **Data inventory** | Fields/columns that are clearly personal data (name, email, phone, document IDs, address, IP, device fingerprint, location, biometric, health, financial) — list where each is collected, stored, and transmitted |
| **Consent** | Is there a recorded consent flow before collection, or is collection unconditional? For LGPD/GDPR, "legitimate interest" and other legal bases exist besides consent — this skill only flags *whether a mechanism exists*, not which basis is legally correct for this data |
| **Retention** | Any deletion/expiry logic for personal data, or does it accumulate indefinitely? (cron job, TTL, soft-delete-then-purge) |
| **Right to erasure/access** | Is there any code path that lets a user request their data or its deletion (self-service or support-driven)? |
| **Third-party processors** | External services receiving personal data (analytics, email providers, payment processors, LLM APIs sent user content) — each is a data-sharing relationship that likely needs a processor agreement |
| **Cross-border transfer** | Where do the services in the row above host data? Personal data leaving Brazil/EU has its own rules (adequacy decisions, SCCs) — flag the transfer, don't attempt the legal analysis |
| **Logging/observability leaks** | Personal data written to logs, error trackers, or analytics events in plaintext — a very common accidental-leak pattern, distinct from the intentional flows above |
| **Encryption at rest/in transit** | For the personal-data fields found in the inventory specifically, not a general infra audit |

## Step 3 — Report as signals, explicitly not verdicts

```markdown
### {SIGNAL-NNN}: {title}

- **Category:** Data inventory / Consent / Retention / Erasure / Third-party / Cross-border / Logging leak / Encryption
- **Location:** {file:line or table/schema}
- **What was found:** {factual, no legal conclusion — "email is stored with no observed deletion path", not "this violates LGPD Art. X"}
- **Why a reviewer would care:** {one sentence}
- **Suggested next step:** {usually: "confirm with legal/DPO whether X is required here", occasionally a concrete code fix for an unambiguous leak like Step 2's logging row}
```

## Output

| Artifact | Path |
|----------|------|
| Compliance signal report | `.github/audits/results/compliance/compliance-signals-{date}.md` |

## Rules

- Never phrase a finding as "this violates LGPD/GDPR" — phrase it as "this is a signal a privacy reviewer would want to evaluate." The legal conclusion is not this skill's to make.
- Logging/observability leaks (Step 2's last row) are the one category where a concrete code fix (stop logging the field, or redact it) is usually appropriate to suggest directly — that's a code bug, not a legal judgment call.
- Don't assume LGPD vs GDPR from language alone — ask or infer from `project.yml`'s `locale`/deployment target; a Brazilian company can have EU users and vice versa, both regimes can apply at once.
- Cross-reference `security-audit`'s existing "secrets/PII" checklist item to avoid duplicate findings — this skill goes deeper on privacy specifically, security-audit's PII item stays a general checklist entry.

## Example

> "Do a compliance pass for LGPD before we launch to Brazil."
> → Finds user email/CPF stored with no retention policy (flagged), a signup flow with no explicit consent checkbox (flagged, next step: confirm legal basis with legal), and a Sentry integration receiving full request bodies including the CPF field in plaintext (flagged as a logging leak, with a concrete redaction fix suggested). Writes `.github/audits/results/compliance/compliance-signals-2026-09-03.md`.
