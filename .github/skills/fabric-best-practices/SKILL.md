---
name: fabric-best-practices
description: Microsoft Fabric and Power BI best practices for governance, workspace and access design, security, lakehouse/warehouse architecture, semantic models, Spark and pipelines, CI/CD, and capacity management. Use when designing, building, reviewing or auditing anything in a Fabric tenant — workspaces, lakehouses, warehouses, notebooks, pipelines, semantic models, reports, deployment pipelines, tenant settings or capacities — or when asked "what is the best practice for…" in Fabric or Power BI.
---

# Microsoft Fabric Best Practices

Use this skill to design, review or audit Microsoft Fabric / Power BI solutions against
established practice. The rules below are the condensed version; each area has a
reference file with the detail, the reasoning and the exceptions.

| Area | Read when the task touches… | Reference |
|------|-----------------------------|-----------|
| Governance & security | tenant settings, workspaces, roles, security groups, RLS/OLS, sensitivity labels, endorsement, network security | [references/governance-security.md](references/governance-security.md) |
| Data architecture | lakehouse vs warehouse vs eventhouse, medallion layers, Delta tables, shortcuts, Spark, pipelines, Dataflows | [references/data-architecture.md](references/data-architecture.md) |
| Semantic models & reports | star schema, Direct Lake / Import / DirectQuery, DAX, refresh, report design | [references/semantic-models.md](references/semantic-models.md) |
| Lifecycle & CI/CD | Git integration, deployment pipelines, environments, variable libraries, automation | [references/lifecycle-cicd.md](references/lifecycle-cicd.md) |
| Capacity & operations | F SKUs, throttling, smoothing, monitoring, cost, incident response | [references/capacity-operations.md](references/capacity-operations.md) |

Load only the reference files the task needs.

## The ten rules that matter most

1. **Grant access to Entra ID security groups, never to individuals.** Workspace roles,
   item shares, RLS role membership, tenant-setting scopes and app audiences all go to groups.
   Every workspace has at least two admins (a group, plus a break-glass identity).
2. **Separate workspaces by purpose and by stage.** Dev / Test / Prod are different
   workspaces; data engineering (lakehouses, notebooks, pipelines) is separate from
   reporting (semantic models, reports) so permissions and capacity can differ.
3. **Apply a naming convention and enforce it.** Workspace, item and group names
   encode domain, purpose and stage (e.g. `FIN-Sales-Reporting [PROD]`).
4. **Scope tenant settings to security groups** instead of "the entire organization",
   especially export, external sharing, publish-to-web, service-principal API access and
   item creation. Review tenant settings on a schedule; Microsoft adds new ones regularly.
5. **One copy of the data.** Build medallion layers (bronze → silver → gold) in OneLake
   with Delta tables, use shortcuts instead of copying, and point many reports at a few
   shared, endorsed semantic models rather than one model per report.
6. **Model for analytics: star schema.** Fact and dimension tables, single-direction
   relationships, explicit measures, no auto date/time, minimal columns and cardinality.
7. **Source control and promote; never edit production by hand.** Git-integrate
   development workspaces, promote with deployment pipelines or `fabric-cicd`, and keep
   environment-specific values in deployment rules or variable libraries.
8. **No secrets in code.** Use workspace identity, managed identity or service principals,
   store secrets in Azure Key Vault, and read them at runtime
   (`notebookutils.credentials.getSecret`). Never paste keys into notebooks or pipeline JSON.
9. **Isolate capacities by workload criticality.** Production on its own capacity; dev/test
   on a smaller one that can be paused. Watch the Capacity Metrics app and act before
   throttling, not after.
10. **Label, endorse and monitor.** Sensitivity labels on everything that holds business
    data, Certified/Promoted endorsement for trusted content, audit logs and the admin
    monitoring workspace retained and reviewed.

## How to review a Fabric solution

When asked to review, audit or assess:

1. Establish scope: tenant, capacity, domain, workspace(s), or specific items.
2. Walk the relevant reference files and check each rule against what you can observe
   (code, item definitions in Git, API output, screenshots, descriptions).
3. Report findings in this format, most severe first:

```
### <Finding title>
- Severity: Critical | High | Medium | Low
- Area: Governance | Security | Architecture | Semantic model | CI/CD | Capacity
- Evidence: <what you saw, with item/workspace names or file:line>
- Why it matters: <the concrete risk — data exposure, outage, cost, wrong numbers>
- Recommendation: <the specific change, with the setting/API/feature to use>
```

Severity guide:
- **Critical** — data exposed to the wrong people (publish to web, Everyone-scoped shares,
  secrets in code, missing RLS on sensitive data), or no recoverable owner.
- **High** — production edited directly, individual-user access at scale, single admin,
  production sharing a capacity with dev, no source control for production content.
- **Medium** — performance and maintainability issues: no star schema, duplicated models,
  small-file problems, missing incremental refresh, inconsistent naming.
- **Low** — hygiene: missing descriptions, endorsement, labels on low-risk content.

4. Finish with a short prioritized action list (what to do this week / this quarter).

## How to answer "what's the best practice for X"

- Give the recommendation first, then the reason, then the exceptions.
- Prefer native Fabric features over custom workarounds, and name the exact feature,
  setting or API.
- Product limits (SKU guardrails, Direct Lake row limits, throttling thresholds, preview
  vs GA status) change often. State them as "at the time of writing" and tell the user to
  confirm on learn.microsoft.com when a decision depends on an exact number.

## Authoritative sources

- Microsoft Fabric adoption roadmap — `https://learn.microsoft.com/power-bi/guidance/fabric-adoption-roadmap`
- Power BI implementation planning — `https://learn.microsoft.com/power-bi/guidance/powerbi-implementation-planning-introduction`
- Fabric governance — `https://learn.microsoft.com/fabric/governance/`
- Fabric security — `https://learn.microsoft.com/fabric/security/`
- Fabric CI/CD — `https://learn.microsoft.com/fabric/cicd/`
- Power BI guidance (modeling, DAX, reports) — `https://learn.microsoft.com/power-bi/guidance/`
