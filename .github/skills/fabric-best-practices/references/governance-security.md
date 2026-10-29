# Governance & Security

## Operating model

- Pick an explicit governance model: **centralized**, **decentralized (self-service)** or,
  most commonly, **managed self-service** — a central team owns tenant settings, shared
  data and certified models; business teams build reports on top.
- Run a **Center of Excellence (CoE)**: owns standards, tenant settings, training,
  the certification process and the monitoring of usage.
- Use **domains** (and subdomains) to group workspaces by business area so admin
  rights, default sensitivity labels and discovery can be delegated per domain.
- Every workspace and every production item has a named **business owner** and a
  **technical owner**. Record them (workspace description, contact list, or a catalog).

## Tenant settings

- Default to **restrictive, scoped to security groups**; open up deliberately.
- High-risk settings to scope or disable:
  - Publish to web (disable, or restrict to a tiny group with an approval process)
  - Export to Excel / CSV / PowerPoint / PDF and "export data" features
  - Share content with external users, B2B guest access, external data sharing
  - Service principals can use Fabric APIs (scope to a group of approved SPNs)
  - Users can create Fabric items (scope during rollout)
  - Create workspaces (restrict to a group; route others through a request process)
  - Allow XMLA endpoints with Read Write, Azure Maps, R/Python visuals, custom visuals
    from outside AppSource (allow only certified/org visuals)
- Review settings at least quarterly and after each Fabric release — new settings
  often arrive **enabled for the entire organization**.
- Delegate overrides to **capacity admins** and **domain admins** where appropriate
  instead of granting Fabric Administrator broadly. Keep Fabric Administrators few,
  use PIM (just-in-time elevation) for the role.

## Workspaces

- **One purpose, one stage per workspace.** Typical split per domain/solution:
  - `…-Data [DEV|TEST|PROD]` — lakehouses, warehouses, notebooks, pipelines
  - `…-Reporting [DEV|TEST|PROD]` — semantic models, reports, dashboards
  - Consumers use the **workspace app** or audiences, not the workspace itself.
- **Naming convention** covering domain, solution, layer/purpose and stage. Enforce it
  at creation and audit it regularly.
- **Personal workspaces (My workspace)** are for experiments only; nothing shared or
  scheduled should live there. Watch for orphaned content when people leave.
- Assign every workspace to the right **capacity** and **domain**, add a description and contact list.

## Roles and access

| Role | Give to | Notes |
|------|---------|-------|
| Admin | Owning team's group + break-glass account | ≥ 2 admins; can delete the workspace and manage access |
| Member | Lead developers | Can share and add members/contributors |
| Contributor | Developers | Can create/edit items; cannot manage access |
| Viewer | Rarely | Prefer the **app** or item-level permissions for consumers; note Viewer can read data through SQL analytics endpoints |

- Always assign **Entra ID security groups** (or M365 groups) — never individual users
  — for roles, item sharing, RLS role membership, app audiences and tenant-setting scopes.
- Use **least privilege**: consumers get Read on the app/report, Build only when they
  genuinely create their own reports, and no workspace role.
- Avoid "Share with people in your organization" links for sensitive content.
- Review access periodically (Entra access reviews on the groups), and remove guests
  who no longer need access.

## Data security layers (defense in depth)

1. **Workspace roles** — coarse, item-wide.
2. **Item permissions** — share a single lakehouse/warehouse/model with Read, ReadData, ReadAll or Build.
3. **OneLake security / data access roles** — folder- and table-level security in a lakehouse, enforced across engines.
4. **SQL granular permissions** in warehouses and SQL analytics endpoints — `GRANT`/`DENY`,
   **row-level security**, **column-level security**, **dynamic data masking**.
5. **Semantic model RLS/OLS** — row- and object-level security for report consumers.
   Test roles with "View as". Remember RLS does **not** apply to workspace Admin/Member/Contributor.

Use the layer closest to the data that every consumer path goes through; don't rely on
report-level filtering for security.

## Identity and secrets

- Prefer **workspace identity**, **managed identities** and **service principals** for
  automation and data connections; avoid connections bound to a personal account.
- Store secrets in **Azure Key Vault**; in notebooks use
  `notebookutils.credentials.getSecret(vaultUrl, secretName)`. Use Key Vault references
  in connections where supported.
- Never commit secrets to Git; Git-integrated item definitions are plain text.
- Gateways: run on-premises data gateways in a **cluster** (≥ 2 members), keep them
  patched, restrict who can create connections on them.

## Network security

- Enforce **Conditional Access** (MFA, compliant devices) on Fabric/Power BI.
- Consider **Private Links** (tenant or workspace level) for regulated data — understand
  the feature impact before turning on tenant-level private link.
- Use **trusted workspace access** (with workspace identity) to reach firewall-protected
  ADLS Gen2, and **managed private endpoints** for Spark to reach private Azure sources.
- Use **outbound access protection** where available to stop data exfiltration from Spark.

## Information protection and compliance

- Apply **Microsoft Purview sensitivity labels**; set a **default label** and enable
  **mandatory labeling** for the organization or per domain. Labels follow exports.
- Use **label inheritance** from data sources and downstream inheritance.
- Integrate with **Microsoft Purview** (Unified Catalog, DLP policies for Fabric,
  data map scanning) for classification and discovery.
- **Endorse** content: *Promoted* (owner vouches), *Certified* (CoE-approved process),
  *Master data* (authoritative reference data). Keep the certifier group small.
- Retain **audit logs / activity events** beyond the default retention — export them
  (Admin API `activityevents` or Purview audit) to your own storage for long-term analysis.
- Use the **Admin monitoring workspace** and the **scanner (metadata scanning) APIs**
  for inventory, lineage and unused-content cleanup.
