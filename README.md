# Titanbay IS Support — Dataform Data Model

**Stack:** Dataform + BigQuery (GCP)
**Author:** Abhit Ghelani
**Date:** April 2026

---

## Business Problem

The IS team currently resolves tickets reactively with no structured view of which investors raise the most, what they struggle with, or when pressure will peak. The Head of Investor Services asked:

> *"I want to understand which investors are raising the most support tickets and what patterns exist in that behaviour. I also want to be able to anticipate when our team is likely to be under more pressure than usual, so we can plan resourcing in advance rather than firefighting."*

This breaks down into two analytical questions, which the model is designed to answer:

1. Which investors raise the most tickets, and what patterns exist in that behaviour?
2. When will the team be under more pressure than usual, so resourcing can be planned in advance?

**What an analyst can now do that they could not do before:**

- Open `mart_investor_support_profile` and immediately rank all 1,253 investors by ticket volume, filtered by partner, KYC status, or whether they're self-managed vs. RM-managed.
- Cross-reference ticket volume against `kyc_status` — the data shows 43% of entities are non-approved (pending/rejected/expired), and the most common ticket subjects include KYC document rejection and subscription document failures. The hypothesis that KYC-related investors generate disproportionate ticket load is now testable.
- Open `mart_close_pressure_calendar` and see which weeks in the next 30–60 days have the highest close density, broken down by partner, so the IS manager can roster accordingly.
- Use `mart_ticket_volume_by_period` to build a time-series of weekly ticket volume by requester type, identify historical spike weeks, and compare them against the close calendar.

---

## Modelling Approach

Three-layer architecture: **Staging → Intermediate → Marts**

```
raw sources
    ▼
staging/          ← clean, rename, type-cast only. No joins. One model per source table.
    ▼
intermediate/     ← entity resolution, grain management, enriched joins. Not analyst-facing.
    ▼
marts/            ← wide, documented, analyst-facing tables. Explicit grain on every model.
```

### Model inventory

| Model | Layer | Grain | Purpose |
|---|---|---|---|
| `stg_freshdesk_tickets` | Staging | ticket_id | Cleaned tickets, internal emails excluded |
| `stg_investors` | Staging | investor_id | Normalised investor records |
| `stg_entities` | Staging | entity_id | Investing entities with KYC status |
| `stg_partners` | Staging | partner_id | Partner organisations |
| `stg_relationship_managers` | Staging | rm_id | RMs with normalised email |
| `stg_fund_closes` | Staging | close_id | Fund closes, cancelled excluded |
| `int_ticket_requester_resolved` | Intermediate | ticket_id | Core entity resolution model |
| `int_investor_profile` | Intermediate | investor_id | Investor enriched with entity + partner context |
| `int_fund_close_calendar` | Intermediate | close_id | Closes with partner and investor count context |
| `mart_investor_support_profile` | Mart | investor_id | Every investor with their **self-raised** ticket history (RM-raised tickets attributed at partner level only) |
| `mart_ticket_volume_by_period` | Mart | week × partner × type × subject × priority | Weekly trend analysis |
| `mart_close_pressure_calendar` | Mart | week × partner | Forward-looking resourcing calendar |

---

## Entity Resolution

The hardest problem in this model: Freshdesk has no platform ID field. The only link between a ticket and a platform identity is the requester's email address.

There are two types of requester in the data:

- **Investors** raising tickets themselves
- **Relationship managers** raising tickets on behalf of their investor book

Resolution is a two-pass email join. Investor match is attempted first; RM match is tried only on tickets that didn't resolve to an investor. This priority is defensive — in profiling, zero emails appeared in both tables simultaneously.

**Results from profiling the actual data (1,900 tickets after excluding 100 internal):**

| Requester type | Tickets | % | Attribution possible |
|---|---|---|---|
| `investor` | 1,060 | 55.8% | Investor + entity + partner |
| `rm` | 760 | 40.0% | Partner only (no investor ID on RM or ticket) |
| `unresolved_personal` | 80 | 4.2% | None — personal email domain (Gmail, Outlook, Yahoo, iCloud, Hotmail) |
| `unresolved_other` | 0 | 0.0% | None — corporate email, no platform match (defensive catch-all, empty in current data) |

Unresolved tickets represent investors whose Freshdesk email does not match their platform record. In this dataset all of them resolve to personal email domains — investors registered with a corporate email but raise tickets from a personal address. `unresolved_other` is retained in the model as a defensive fourth category to catch anything that falls through the other three buckets (typos, former employees, delegated assistants using unexpected addresses). It is currently empty but is in place so that a future data-quality drift into a new bucket surfaces immediately rather than silently misclassifying as `unresolved_personal`. Unresolved tickets are retained in volume counts but dropped from investor-level metrics.

**RM ticket attribution:** RM tickets can be linked to the RM's partner organisation, but not to a specific investor — there is no investor identifier on either the ticket or the RM record. These are counted at partner level in the mart, not investor level. This is a documented limitation.

---

## Data Quality Issues Found and Decisions Made

All findings are based on profiling the actual source data.

### 1. ALL CAPS email addresses in Freshdesk — 34 tickets - Critical

**Finding:** 34 tickets have `requester_email` in ALL CAPS (e.g. `DIANE.KENT@COLEMAN-INVEST.CO.UK`). Without normalisation these fail all platform joins and are silently misclassified as unresolved.

**Decision:** `LOWER(TRIM(requester_email))` applied in `stg_freshdesk_tickets`. The same normalisation is applied to investor and RM email columns. All 34 tickets successfully resolved after normalisation.

### 2. Internal Titanbay staff tickets — 100 tickets - Critical

**Finding:** 100 tickets originated from `@titanbay.com` and `@titanbay.co.uk` email addresses. Subjects include "Internal QA test", generic platform error reports. These are IS team and QA activity, not investor support.

**Decision:** Excluded in staging with `WHERE NOT (requester_email LIKE '%@titanbay.%')`. An `is_internal_ticket` boolean is computed before the filter is applied so the exclusion is documented in the model. These 100 rows are not lost — they simply don't flow downstream.

### 3. `partner_label` is unusable as a join key - Critical

**Finding:** The `partner_label` field in tickets is manually typed by IS agents. Profiling found 80 distinct values mapping to just 15 partners. Examples for a single partner: `Ashford`, `Ashford WM`, `Ashford Wealth`, `ASHFORD WEALTH MANAGEMENT`, `ashford wealth management`. Additionally, 878 of the 2,000 raw tickets (44%) have no `partner_label` at all — this figure is computed pre-exclusion, on the raw source, because `partner_label` quality is a property of the source system regardless of which tickets flow downstream.

**Decision:** `partner_label` is retained as a display/reference field only. It is never used as a join key. The authoritative partner join path is: `ticket email → investor/RM → entity → partner_id`. All 1,122 non-null labels are recoverable to a canonical partner name via fuzzy matching, but this is fragile and not relied upon for any metric.

### 4. Fund closes have no entity or investor linkage - Critical

**Finding:** `platform_fund_closes` contains only `partner_id` — no `entity_id` or `investor_id`. It is structurally impossible to link a fund close to a specific investor.

**Decision:** Close-to-investor linkage is done at partner grain only (close to partner to all investors at that partner). The `mart_close_pressure_calendar` aggregates at `(close_week, partner_id)` grain and attaches a count of all investors registered at that partner as a proxy for exposure. This is documented in the mart description. The long-term fix is in the Reflection section below.

### 5. Personal email addresses — 80 unresolved tickets

**Finding:** 80 tickets come from personal email domains (Gmail, Outlook, Yahoo, iCloud, Hotmail) that don't match any platform record. These are investors who raised a ticket using a personal email rather than their registered platform email. A fourth `unresolved_other` category exists in the model for corporate emails that still don't match (typos, former employees, delegated assistants), but is empty in the current data.

**Decision:** Classified as `requester_type = 'unresolved_personal'` and retained in all volume counts. Dropped from investor-level metrics (can't be attributed) but visible in `mart_ticket_volume_by_period`. Treated as a data quality signal — their share should be monitored over time.

### 6. KYC status — 43% of entities non-approved

**Finding:** Of 772 entities: 438 approved (57%), 114 pending (15%), 111 rejected (14%), 109 expired (14%). This is not a data quality issue — KYC state is inherently mixed — but it is analytically important. The top ticket subjects include "KYC document rejected — resubmission required" and "Accredited investor declaration not saving", suggesting KYC-troubled investors generate a meaningful share of IS load.

**Decision:** `kyc_status` and `is_kyc_approved` are surfaced in `mart_investor_support_profile` so analysts can directly test the KYC-ticket correlation hypothesis.

### 7. Many investors per entity — grain management

**Finding:** Entities have 1–3 investors each (382 with 1, 299 with 2, 91 with 3). Naively joining entity attributes to investor rows does not fan out in this direction because investors carry the `entity_id` FK (not the other way around). The join is investor → entity, which is many-to-one and safe.

**Decision:** No aggregation required on the entity side. `int_investor_profile` joins investor → entity → partner without grain risk. Entity counts per partner are pre-aggregated in `int_fund_close_calendar` before being attached.

### 8. Status / resolved_at consistency — clean ✓

No mismatches: zero resolved/closed tickets with null `resolved_at`, zero open/pending tickets with a `resolved_at` timestamp. No action required.

### 9. Referential integrity — clean ✓

All `partner_id` references in entities and closes are valid. All `relationship_manager_id` references in investors point to existing RM records. All entity IDs in investors point to existing entity records. No orphan rows in any direction.

---

## Assumptions

| Assumption | Rationale |
|---|---|
| Email uniquely identifies a platform user | Practical necessity — it is the only cross-system join key. Email reassignment is possible but assumed rare enough to accept. |
| Investor match preferred over RM match for the same email | Defensive priority rule. In this dataset no email appears in both tables. |
| RM tickets cannot be attributed to a specific investor | No investor ID is present in the ticket or RM record. Attribution at partner level is the maximum possible granularity. |
| Internal Titanbay tickets should be excluded from all metrics | They inflate IS team workload figures and are not investor support activity. |
| Cancelled fund closes excluded from pressure forecasting | A cancelled close will not drive investor activity. Completed and upcoming closes are retained. |
| `relationship_manager_id = NULL` means self-managed, not missing | Per the data dictionary, nulls here are expected and have a specific business meaning. |

---

## How I Used AI Tools

Claude was used throughout as a force multiplier:

- **Data profiling.** Wrote and iterated Python scripts to profile all six tables — null counts, cardinality, email normalisation impact, entity resolution match rates, `partner_label` variant clustering, and referential integrity across the FK chain. Every numerical finding in this README is grounded in one of those scripts, not inferred.
- **Architecture sanity-check.** Pressure-tested the three-layer staging/intermediate/marts split, the grain direction of the investor → entity → partner join, and the partner-grain fallback for the fund-close linkage problem. Useful for catching fan-out risks before they reached SQL.
- **README structuring.** Drafted section headings and the data-quality finding template (Finding → Decision), which I then filled in from the profiling output. The structure came from the model; the content came from the data.


I did not use AI to generate final SQL unreviewed, and every assertion, grain decision, and data-quality call-out in this submission was verified against the actual data before shipping.

---

## How to Run

```bash
npm install -g @dataform/cli
dataform install
dataform compile
dataform run          # builds staging → intermediate → marts
dataform test         # runs assertions
```

Raw tables are declared in `sources.js` and expected to exist in the `raw` dataset of the `titanbay-prod` project. Adjust `dataform.json` (`defaultDatabase`, `defaultLocation`) for other environments.

---

## Reflection: Long-term Fixes

The core linkage problem is that Freshdesk has no foreign key into the platform. The ideal long-term fix is **two changes at source**:

1. **Store `platform_investor_id` as a custom field on every Freshdesk ticket at creation time.** This can be done by passing the authenticated user's platform ID through the "raise a ticket" flow, or via a Freshdesk webhook that enriches the ticket record on creation by looking up the session email against the platform. This alone would make the email join unnecessary and eliminate the entire unresolved ticket problem.

2. **Add `entity_id` (and ideally `investor_id`) to `platform_fund_closes`.** Currently it is impossible to link a close to a specific investor — only to all investors at that partner. Adding entity-level close records would allow genuine investor-level pressure forecasting rather than partner-level proxies.

Without fix 1, any model that relies on email joins will degrade as investors change emails, use personal addresses, or are onboarded with inconsistent data. Without fix 2, the close pressure calendar will always be a blunt instrument.

---

## What I Would Build Next

- **`mart_partner_support_profile`:** Partner-level rollup combining direct investor tickets + RM-raised tickets, entity KYC breakdown, and upcoming close density. Useful for QBRs and identifying which partnerships are generating disproportionate IS load.
- **Ticket-to-close lag model:** Join ticket volume by week against close dates and compute average ticket spike in the N days following a close. This turns the pressure calendar from a leading indicator into a calibrated forecast.
- **Unresolved rate monitor:** A Dataform assertion that alerts when the `unresolved_personal` ticket share exceeds 5% in any rolling 7-day window — signals that email data quality is degrading.
- **KYC correlation analysis:** A mart joining `kyc_status` against ticket subjects and tags per investor, quantifying whether non-approved entities generate higher ticket rates. The data strongly suggests this is true; the mart would confirm it.
- **Incremental ticket mart:** Once ticket history grows beyond 18 months, switch `mart_ticket_volume_by_period` to incremental on `created_week` with `uniqueKey` on the grain columns. Dataform handles the BigQuery MERGE automatically.
