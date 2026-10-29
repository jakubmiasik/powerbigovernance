# Lifecycle Management & CI/CD

## Environments

- At minimum **Dev → Test → Prod** workspaces per solution (add per-developer feature
  workspaces for teams). Production is never edited directly.
- Test uses production-like data volume and security to catch performance and RLS issues.
- Keep dev/test on a separate (cheaper, pausable) capacity from production.

## Git integration

- Connect **Dev** (and feature) workspaces to **Azure DevOps** or **GitHub** via Fabric
  Git integration. Items are stored as source definitions (e.g. PBIP/TMDL for semantic
  models, PBIR for reports, notebook source files, pipeline JSON).
- Branching: `main` is the integration branch; developers work in **feature branches
  connected to their own feature workspace** ("branch out" to a new workspace), and merge
  via **pull requests with review**.
- Use **Power BI Desktop projects (PBIP)** with TMDL and PBIR so model and report changes
  are diff-able and reviewable.
- Don't connect production workspaces to a branch that people push to directly; promote instead.
- Check which item types support Git integration — not all do; document manual steps
  for the rest.
- Keep secrets, credentials and environment-specific IDs out of the repository.

## Promotion options

1. **Fabric deployment pipelines** — UI/API-driven promotion Dev → Test → Prod with
   **deployment rules** (data source, parameter overrides) and selective deployment.
   Simplest option for most teams.
2. **Git-based per-stage** — each stage's workspace syncs from its own branch
   (`dev`, `test`, `main`); promotion = PR between branches.
3. **Build-and-release automation** — Azure DevOps Pipelines / GitHub Actions using the
   **`fabric-cicd`** Python library or the **Fabric REST APIs** (Items, Git, Deployment
   Pipelines) to deploy item definitions with parameter replacement per environment.

Choose one primary approach per solution and document it.

## Environment-specific configuration

- Use **variable libraries** for values that differ per stage (connections, lakehouse
  and workspace IDs, file paths, feature flags), referenced by pipelines/notebooks.
- Use **deployment rules** or `fabric-cicd` parameter files for semantic model data
  sources and parameters.
- Avoid hard-coded workspace/item GUIDs in notebooks; resolve by name or variable.
- Bind default lakehouses for notebooks per stage (deployment rules or parameterization).

## Automation identity

- Run CI/CD as a **service principal** (or managed identity) with only the workspace
  roles it needs, scoped through the "service principals can use Fabric APIs" tenant setting.
- Store its credentials in pipeline secret stores / Key Vault; prefer workload identity
  federation (OIDC) over client secrets.

## Quality gates

- PR checks: linting of notebook code, **Best Practice Analyzer** on TMDL, naming
  convention checks, schema/contract tests on gold tables.
- Post-deployment: smoke tests (refresh the model, run key queries, validate row counts),
  then automated or manual approval before Prod.
- Version and tag releases; keep a changelog for production deployments.

## Rollback

- Rollback = redeploy the previous Git commit/tag (or previous deployment-pipeline stage
  content). Make data changes idempotent and reversible (Delta time travel, restore
  points in warehouses) so code rollbacks don't strand data.
