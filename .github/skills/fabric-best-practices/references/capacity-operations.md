# Capacity, Cost & Operations

## Capacity strategy

- Fabric capacities are **F SKUs** (F2 … F2048) bought in Azure; F64 and above include
  free viewing of Power BI content for users without a Pro/PPU license.
- **Separate capacities by criticality**: production (sized for peaks, protected),
  dev/test (smaller, **paused** outside working hours), and optionally a dedicated capacity
  for heavy data engineering or for self-service/ad-hoc users.
- Assign capacity admins per capacity; delegate tenant settings at capacity level where needed.
- Consider **reservations** for steady production capacity and pay-as-you-go for
  scalable or pausable ones. Scale up/down via Azure (API, automation) for known peaks.
- Use **Autoscale billing for Spark** (where available) to move bursty Spark jobs off the
  shared capacity model.

## Understand throttling

- Usage is measured in **Capacity Units (CU)**. Fabric **bursts** above the SKU and
  **smooths** consumption: interactive operations over ~5 minutes, background operations
  over 24 hours.
- When future capacity is consumed, throttling escalates (at the time of writing):
  - up to 10 minutes of future usage → no throttling (overage protection)
  - 10–60 minutes → interactive requests **delayed**
  - 60 minutes – 24 hours → interactive requests **rejected**
  - over 24 hours → background requests **rejected** too
- Throttling on a shared capacity affects **every workspace on it** — a reason to isolate
  production.
- Use **surge protection** to cap background usage, and workload-level controls
  (e.g. Spark job admission, semantic model query limits) to stop runaway jobs.
- Confirm current thresholds on learn.microsoft.com before making sizing decisions.

## Monitoring

- **Fabric Capacity Metrics app** — install for every capacity; review utilization,
  throttling, overages and the top consuming items/users weekly.
- **Monitoring hub** — status of pipelines, notebooks, Spark jobs, refreshes.
- **Workspace monitoring** (Eventhouse-based logs) for detailed query and operation logs
  per workspace.
- **Admin monitoring workspace** and **audit logs** for usage, adoption and inventory.
- **Capacity notifications / alerts** to a team distribution list at utilization thresholds.
- Track refresh failures, pipeline failures and long-running queries as operational KPIs.

## Cost optimization

- Kill idle Spark sessions, set session timeouts, prefer starter pools and
  Python (single-node) notebooks for small jobs.
- Incremental loads instead of full reloads; incremental refresh in semantic models.
- Optimize Delta tables (V-Order, OPTIMIZE) — fewer files = less CU per query.
- Remove unused items, models and reports (scanner API + activity log to find them).
- Schedule heavy background jobs off-peak and stagger refreshes.
- Pause non-production capacities when not in use. Note OneLake storage is billed separately
  from compute and continues while paused; manage retention (VACUUM, soft-delete).

## Operations & support

- Document a **runbook**: who owns each capacity, escalation path, how to identify a
  runaway item in the Metrics app, how to scale up temporarily, how to move a workspace to
  another capacity.
- Keep a **disaster recovery** stance: enable capacity **disaster recovery** (OneLake
  replication to the paired region) for critical data, keep code in Git, and document how
  to recreate workspaces and items.
- Track the **Fabric roadmap and release notes**; test preview features in dev only and
  check GA status before relying on them in production.
- Measure adoption (active users, certified content usage) to guide training and the CoE.
