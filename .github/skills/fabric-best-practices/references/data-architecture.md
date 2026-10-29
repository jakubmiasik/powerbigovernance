# Data Architecture, Engineering & Integration

## Choosing the store

| Need | Use |
|------|-----|
| Files + tables, Spark/Python engineering, data science, semi-structured data | **Lakehouse** |
| T-SQL-first team, multi-table transactions, stored procedures, SQL security model | **Warehouse** |
| Streaming / time-series / logs, sub-second queries over high-volume events | **Eventhouse (KQL database)** + Eventstream |
| Operational (OLTP) app database with automatic mirroring to OneLake | **SQL database in Fabric** |
| Data stays in an external database but should be queryable in OneLake | **Mirroring** |
| Data already in ADLS Gen2 / S3 / GCS / another workspace | **Shortcut** (no copy) |

Lakehouse and warehouse both store **Delta Parquet in OneLake**; mixing them is fine
(e.g. lakehouse for bronze/silver, warehouse for gold) — choose by team skills and features.

## Medallion architecture

- **Bronze (raw)** — data landed as-is, append-only, keep source fidelity and load metadata
  (load timestamp, source file, batch id). Often files or raw Delta tables.
- **Silver (cleansed/conformed)** — deduplicated, typed, validated, conformed keys,
  history (SCD) handled. Delta tables.
- **Gold (curated)** — business-ready star schemas / aggregates feeding semantic models.
- Put each layer in its **own lakehouse** (often its own workspace) so permissions,
  retention and capacity can differ. Consumers get access to gold only.
- Use **shortcuts** to reference data across layers/workspaces instead of copying.

## Delta table hygiene

- Write tables in **Delta**; keep **V-Order** enabled for tables read by Power BI / SQL
  (it can be relaxed for write-heavy bronze ingestion).
- Avoid the **small-file problem**: use optimized write, run `OPTIMIZE` regularly
  (or table maintenance from the lakehouse UI/API), and `VACUUM` with a retention that
  respects time-travel needs (default 7 days).
- **Partition only large tables** on a low-cardinality column used in filters (e.g. date
  for very large fact tables). Over-partitioning small tables hurts performance.
- Use consistent **snake_case or PascalCase** naming, explicit data types, no spaces in
  table/column names. Use **schemas** in lakehouses to organize tables.
- Track lineage columns and implement **idempotent loads** (MERGE on keys) so reruns are safe.

## Spark / notebooks

- Use **starter pools** for fast startup; use custom pools only when you need specific sizing.
- Manage libraries and Spark settings in **Environments**, attached to notebooks/jobs,
  not with ad-hoc `%pip install` in production.
- Enable the **Native Execution Engine** for supported workloads; consider **high-concurrency
  mode** to share sessions in interactive work and pipelines.
- Don't `collect()` or `toPandas()` large data; push filters early; avoid Python UDFs where
  built-in functions exist.
- Parameterize notebooks (parameter cell), keep business logic in reusable notebooks or
  wheel libraries, and orchestrate with pipelines or `notebookutils.notebook.runMultiple`.
- Stop interactive sessions when done — idle sessions consume capacity.
- For light, single-node work consider **Python notebooks** (not Spark) to save capacity.

## Pipelines and Dataflows

- Prefer **metadata-driven pipelines**: a control table lists sources/targets, one
  parameterized pipeline loops over them.
- Use **Copy job** or Copy activity for bulk movement; **Dataflow Gen2** for low-code
  transformations by analysts; **notebooks** for complex/large transformations.
- Use **incremental loads** (watermarks, CDC, mirroring) instead of full reloads.
- Configure **retries and timeouts** on activities; add failure paths that alert
  (Teams/email activity or **Activator**).
- Externalize environment-specific values (connections, paths, workspace IDs) into
  **variable libraries** or pipeline parameters.
- Dataflow Gen2: stage data where folding isn't possible, set a data destination
  explicitly, and avoid long chains of dataflows reading each other.

## Data quality

- Validate at the silver boundary: schema checks, nullability, uniqueness of keys,
  referential integrity, reasonable ranges. Quarantine failing rows rather than dropping silently.
- Reconcile counts/totals between source and target for critical data.
- Record data quality results in a table so they can be monitored and reported.

## Real-Time Intelligence

- Ingest with **Eventstream**, store in **Eventhouse**, use **update policies** for
  transformation and **materialized views** for aggregations.
- Set **retention and caching policies** per table deliberately — they drive cost and performance.
- Use **OneLake availability** to expose KQL tables as Delta for other engines.
- Drive alerts and automated actions with **Activator**.
