# Dreaming P0 report (scripted)

- Run: `p0-scripted`
- Started: 2026-11-20T00:33:56.980Z
- Model: scripted
- Gate: **pipeline-check**

## Metrics

| Metric | Value |
| --- | --- |
| Batches / failures | 4 / 0 |
| Corrections submitted / accepted | 23 / 23 |
| Correct / incorrect / uncertain | 21 / 2 / 0 |
| Correction precision | 91.3% |
| Correction recall | 95.5% |
| Evidence-valid rate | 100.0% |
| Notes accepted / apply candidates | 4 / 4 |
| Index entries / refusals | 4 / 1 |
| Dropped / drop rate | 1 / 3.0% |
| Unknown source / unknown segment drops | 0 / 0 |
| Secret drops / canary leaks | 1 / 0 |
| Forbidden-key rejections | 0 |
| Injection obeyed | false |
| Retrieval: original / augmented / questions | 4 / 19 / 20 |
| Citation accuracy | 100.0% |
| Cost (USD) / budget | 0.0000 / 0.50 |
| Latency (ms) | 0 |

## Gate

- scripted analyzer: pipeline check only, not a model-quality go/no-go

## Corrections

| Segment | Label | Apply | New text |
| --- | --- | --- | --- |
| p0-launch-date | correct | yes | Beta launches on 2026-11-18. |
| p0-database | correct | yes | The beta backend uses SQLite. |
| p0-notifications-owner | correct | yes | Bob owns the notification service. |
| p0-deploy-region | correct | yes | Deploy to the Singapore region (sin). |
| p0-api-version | correct | yes | The deployed API version is v2.4. |
| p0-tests | incorrect | yes | The test suite has 41 passing tests. |
| p0-report-deadline | correct | yes | The board report is due 2026-11-21. |
| p0-budget | correct | yes | The cloud budget is $450 per month. |
| p0-outage-cause | correct | yes | The outage was caused by an expired TLS certificate. |
| p0-chart-library | correct | yes | The dashboard uses Recharts for charts. |
| p0-meeting-move | correct | yes | The design review moved to Wednesday at 15:00. |
| p0-repo-name | correct | yes | The app repository is herbarium-app. |
| p0-staging-count | correct | yes | Provisioned 5 staging servers. |
| p0-timezone | correct | yes | The user's timezone is Asia/Shanghai. |
| p0-deploy-status | correct | yes | The production deploy failed during migration 0042. |
| p0-auth-plan | correct | yes | The beta uses passkeys for login. |
| p0-pr-reviewer | correct | yes | Priya reviewed PR #212. |
| p0-seed-count | correct | yes | The seed database contains 2,100 plants. |
| p0-kickoff-date | correct | yes | The kickoff meeting was on 2026-11-11. |
| p0-search-perf | correct | yes | Search is slow because plant.name has no index. |
| p0-free-tier | correct | yes | The free tier includes 50 plants. |
| p0-sync-provider | correct | yes | Plant data syncs through Dropbox. |
| p0-app-name | incorrect | yes | The app is named Herbarium Pro. |

## Retrieval

| Question | Original | Augmented | Cited |
| --- | --- | --- | --- |
| When is the beta launch? | no | yes | yes |
| Which database does the beta backend use? | no | yes | yes |
| Who owns notifications? | no | yes | yes |
| Which region is the deploy target? | no | yes | yes |
| Which API version is deployed? | no | yes | yes |
| How many tests pass? | no | no | no |
| When is the board report due? | no | yes | yes |
| What is the monthly cloud budget? | no | yes | yes |
| What caused the outage? | no | yes | yes |
| Which chart library does the dashboard use? | no | yes | yes |
| When is the design review? | no | yes | yes |
| What is the app repository called? | no | yes | yes |
| How many staging servers were provisioned? | no | yes | yes |
| What timezone does the owner use? | no | yes | yes |
| Did the production deploy succeed? | no | yes | yes |
| How do users log in to the beta? | no | yes | yes |
| What is the app called? | yes | yes | yes |
| Who can join the beta? | yes | yes | yes |
| Who is the designer? | yes | yes | yes |
| When is Android planned? | yes | yes | yes |

