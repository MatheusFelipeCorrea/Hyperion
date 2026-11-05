## 📋 Summary

<!-- What / why (1–3 sentences). Linked behavior change? -->

**Card:** <!-- CARD_ID ou n/a -->

**Risk:** <!-- none | docs-only | sync/CI | user-facing command -->

## 🏷️ Type

- [ ] Bug fix
- [ ] New skill / agent behavior
- [ ] Docs / onboarding
- [ ] Cards / sync / backends
- [ ] Scripts / CI / tooling
- [ ] Other

## ✅ Test plan

- [ ] `npm run docs:check` (if docs/links changed)
- [ ] `npm run skills:validate` (if skills changed)
- [ ] `npm run hyperion:check-rules` (if `commands.yml` / rules changed)
- [ ] `npm run hyperion:skills-catalog -- --check` (if catalog meta/generator changed)
- [ ] `npm test` and/or `npm run cards:test` (if scripts changed)
- [ ] Manual smoke: `/doctor` or relevant chat command (if user-facing)

## 📝 Notes

<!-- Screenshots, breaking changes, follow-ups -->
