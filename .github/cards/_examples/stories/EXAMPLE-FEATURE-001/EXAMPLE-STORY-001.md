---
card_id: EXAMPLE-STORY-001
title: "Login endpoint"
status: Backlog
type: Story
priority: Highest
sprint: null
story_points: 5
reporter: null
parent: EXAMPLE-FEATURE-001
due_date: null
categories:
  - Backend
---

> **Kit sample** — never synced. Prefer nested paths: `stories/{PARENT_FEATURE_ID}/{CARD_ID}.md`.

# [STORY] Login endpoint

> **Context:** REST login with JWT for authenticated sessions.

## 📝 Description

As a **user**, I want to log in with email and password, so that I can access my account.

## ✅ Acceptance criteria

### Scenario 1 — Valid login
**Given** a registered user with email `user@example.com`,  
**When** `POST /api/auth/login` is called with valid credentials,  
**Then** returns `200` with JWT token and user data.

### Scenario 2 — Invalid credentials
**Given** a registered user,  
**When** `POST /api/auth/login` is called with wrong password,  
**Then** returns `401` with `"Invalid credentials"`.

```json
{ "error": "invalid_credentials" }
```

## 📋 Summary

### ✅ Done
- Spec defined

### ⏳ Pending
- Implementation
- Tests
