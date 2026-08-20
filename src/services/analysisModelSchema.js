// Relational tables for what an analysis run found.
//
// A run's result was stored only as one `results_json` document on `analysis_runs`.
// That is a reasonable way to keep an immutable record of a scan, and a poor way to
// query it: opening one workspace meant reading and parsing the whole tenant, every
// page load, with no index able to help. Any question narrower than "give me
// everything" paid the cost of everything.
//
// These tables carry the same facts in third normal form — a run has workspaces, a
// workspace has items and access grants, each fact recorded once and keyed by what
// identifies it. The JSON document is still written, because it is the faithful
// record of the scan and the whole-tenant analytics genuinely do want all of it;
// it simply stops being the query path.
//
// Import-free, like the other schema modules, so databaseService can run these
// migrations without a circular dependency.

const ANALYSIS_MODEL_MIGRATIONS = [
  {
    label: 'create analysis_workspaces',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_workspaces') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_workspaces (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          workspace_id NVARCHAR(100) NOT NULL,
          name NVARCHAR(400) NULL,
          type NVARCHAR(100) NULL,
          state NVARCHAR(100) NULL,
          capacity_id NVARCHAR(100) NULL,
          capacity_name NVARCHAR(400) NULL,
          capacity_sku NVARCHAR(50) NULL,
          is_on_dedicated_capacity BIT NULL,
          pipeline_name NVARCHAR(400) NULL,
          pipeline_stage NVARCHAR(200) NULL,
          storage_size BIGINT NULL,
          storage_files BIGINT NULL,
          item_count INT NOT NULL DEFAULT 0,
          user_count INT NOT NULL DEFAULT 0,
          users_readable BIT NOT NULL DEFAULT 1,
          description NVARCHAR(MAX) NULL
        );
        CREATE UNIQUE INDEX UX_analysis_workspaces_run ON analysis_workspaces (run_id, workspace_id);
        CREATE INDEX IX_analysis_workspaces_name ON analysis_workspaces (run_id, name);
      END
    `,
  },
  {
    label: 'create analysis_items',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_items') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_items (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          workspace_id NVARCHAR(100) NOT NULL,
          item_id NVARCHAR(100) NOT NULL,
          name NVARCHAR(400) NULL,
          type NVARCHAR(100) NULL,
          description NVARCHAR(MAX) NULL,
          storage_size BIGINT NULL,
          modified_at DATETIME2 NULL,
          modified_by NVARCHAR(255) NULL
        );
        CREATE UNIQUE INDEX UX_analysis_items_run ON analysis_items (run_id, workspace_id, item_id);
        -- The two questions actually asked: everything in one workspace, and
        -- everything of one type across a run.
        CREATE INDEX IX_analysis_items_type ON analysis_items (run_id, type) INCLUDE (workspace_id, item_id, name);
      END
    `,
  },
  {
    label: 'create analysis_workspace_users',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_workspace_users') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_workspace_users (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          workspace_id NVARCHAR(100) NOT NULL,
          principal_id NVARCHAR(200) NULL,
          principal_type NVARCHAR(50) NULL,
          display_name NVARCHAR(400) NULL,
          email NVARCHAR(400) NULL,
          access_right NVARCHAR(50) NULL
        );
        CREATE INDEX IX_analysis_workspace_users_ws ON analysis_workspace_users (run_id, workspace_id);
        CREATE INDEX IX_analysis_workspace_users_principal ON analysis_workspace_users (run_id, email);
      END
    `,
  },
  // Records which runs have been normalised, so a reader knows the difference
  // between "this run has no workspaces" and "this run predates the tables".
  {
    label: 'create analysis_run_model_state',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_run_model_state') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_run_model_state (
          run_id INT NOT NULL PRIMARY KEY,
          workspaces INT NOT NULL DEFAULT 0,
          items INT NOT NULL DEFAULT 0,
          users INT NOT NULL DEFAULT 0,
          built_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END
    `,
  },
  // Indexes for predicates the newer features query on but never had support for.
  {
    label: 'index recon_exceptions by rule and status',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_exceptions') AND type = 'U')
         AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_recon_exceptions_rule_status' AND object_id = OBJECT_ID(N'recon_exceptions'))
        CREATE INDEX IX_recon_exceptions_rule_status ON recon_exceptions (rule_id, status) INCLUDE (severity, owner, business_key);
    `,
  },
  {
    label: 'index recon_exceptions by owner',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_exceptions') AND type = 'U')
         AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_recon_exceptions_owner' AND object_id = OBJECT_ID(N'recon_exceptions'))
        CREATE INDEX IX_recon_exceptions_owner ON recon_exceptions (owner, status);
    `,
  },
  {
    label: 'index mdm_golden_records by model',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_golden_records') AND type = 'U')
         AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_mdm_golden_records_model' AND object_id = OBJECT_ID(N'mdm_golden_records'))
        CREATE INDEX IX_mdm_golden_records_model ON mdm_golden_records (model_id, run_id);
    `,
  },
  {
    label: 'index mdm_crosswalk by source record',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_crosswalk') AND type = 'U')
         AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_mdm_crosswalk_source' AND object_id = OBJECT_ID(N'mdm_crosswalk'))
        CREATE INDEX IX_mdm_crosswalk_source ON mdm_crosswalk (run_id, source_record_id);
    `,
  },
];

module.exports = { ANALYSIS_MODEL_MIGRATIONS };
