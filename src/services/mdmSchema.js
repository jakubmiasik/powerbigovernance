// Table definitions for master data management.
//
// Kept free of imports, like the reconciliation schema, so databaseService can run
// these migrations while the MDM repository imports databaseService for its SQL
// primitives — without the two requiring each other.

const MDM_MIGRATIONS = [
  {
    label: 'create mdm_models',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_models') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_models (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          description NVARCHAR(2000) NULL,
          entity_type NVARCHAR(100) NULL,
          status NVARCHAR(20) NOT NULL DEFAULT 'draft',
          version INT NOT NULL DEFAULT 1,
          source_id INT NULL,
          source_dataset NVARCHAR(400) NULL,
          destination_id INT NULL,
          destination_table NVARCHAR(400) NULL,
          crosswalk_table NVARCHAR(400) NULL,
          write_mode NVARCHAR(20) NOT NULL DEFAULT 'replace',
          config NVARCHAR(MAX) NULL,
          row_limit INT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          created_by NVARCHAR(255) NULL,
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_mdm_models_status ON mdm_models (status, name);
      END
    `,
  },
  {
    label: 'create mdm_model_versions',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_model_versions') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_model_versions (
          id INT IDENTITY(1,1) PRIMARY KEY,
          model_id INT NOT NULL,
          version INT NOT NULL,
          snapshot NVARCHAR(MAX) NOT NULL,
          change_note NVARCHAR(1000) NULL,
          changed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          changed_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_mdm_model_versions_model ON mdm_model_versions (model_id, version DESC);
      END
    `,
  },
  {
    label: 'create mdm_runs',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_runs') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_runs (
          id INT IDENTITY(1,1) PRIMARY KEY,
          model_id INT NOT NULL,
          model_version INT NULL,
          model_name NVARCHAR(255) NULL,
          status NVARCHAR(20) NOT NULL DEFAULT 'running',
          mode NVARCHAR(20) NOT NULL DEFAULT 'preview',
          raw_records INT NULL,
          golden_records INT NULL,
          merged_clusters INT NULL,
          duplicates_removed INT NULL,
          review_pairs INT NULL,
          pairs_compared INT NULL,
          stats_json NVARCHAR(MAX) NULL,
          written_rows INT NULL,
          error_message NVARCHAR(2000) NULL,
          started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          completed_at DATETIME2 NULL,
          run_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_mdm_runs_model ON mdm_runs (model_id, started_at DESC);
      END
    `,
  },
  // The golden records a run produced, kept here as well as at the destination so
  // the result can be reviewed before — or without — publishing it anywhere.
  {
    label: 'create mdm_golden_records',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_golden_records') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_golden_records (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          model_id INT NOT NULL,
          golden_id NVARCHAR(200) NOT NULL,
          member_count INT NOT NULL DEFAULT 1,
          conflicts INT NOT NULL DEFAULT 0,
          needs_steward BIT NOT NULL DEFAULT 0,
          source_systems NVARCHAR(1000) NULL,
          values_json NVARCHAR(MAX) NULL,
          provenance_json NVARCHAR(MAX) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_mdm_golden_records_run ON mdm_golden_records (run_id, member_count DESC);
      END
    `,
  },
  // Which source record contributed to which golden record. The crosswalk is what
  // lets a downstream system trace a mastered value back to where it came from.
  {
    label: 'create mdm_crosswalk',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_crosswalk') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_crosswalk (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          model_id INT NOT NULL,
          golden_id NVARCHAR(200) NOT NULL,
          source_record_id NVARCHAR(400) NULL,
          source_system NVARCHAR(255) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_mdm_crosswalk_run ON mdm_crosswalk (run_id, golden_id);
      END
    `,
  },
  // Pairs the model was not confident enough to merge automatically. A steward's
  // decision here is the training signal that makes the next run better.
  {
    label: 'create mdm_review_pairs',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'mdm_review_pairs') AND type = 'U')
      BEGIN
        CREATE TABLE mdm_review_pairs (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          model_id INT NOT NULL,
          left_record_id NVARCHAR(400) NULL,
          right_record_id NVARCHAR(400) NULL,
          left_system NVARCHAR(255) NULL,
          right_system NVARCHAR(255) NULL,
          score DECIMAL(5,3) NULL,
          detail_json NVARCHAR(MAX) NULL,
          decision NVARCHAR(20) NOT NULL DEFAULT 'pending',
          decided_by NVARCHAR(255) NULL,
          decided_at DATETIME2 NULL,
          note NVARCHAR(1000) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_mdm_review_pairs_run ON mdm_review_pairs (run_id, decision, score DESC);
      END
    `,
  },
];

module.exports = { MDM_MIGRATIONS };
