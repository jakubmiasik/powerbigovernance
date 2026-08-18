// Table definitions for the reconciliation engine.
//
// Kept free of imports so databaseService can run these migrations while the
// reconciliation repository imports databaseService for its SQL primitives —
// without the two requiring each other.

const RECONCILIATION_MIGRATIONS = [
  {
    label: 'create recon_sources',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_sources') AND type = 'U')
      BEGIN
        CREATE TABLE recon_sources (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          system_label NVARCHAR(255) NULL,
          kind NVARCHAR(50) NOT NULL,
          workspace_id NVARCHAR(100) NULL,
          workspace_name NVARCHAR(400) NULL,
          item_id NVARCHAR(100) NULL,
          item_type NVARCHAR(100) NULL,
          connection_string NVARCHAR(500) NULL,
          database_name NVARCHAR(255) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          created_by NVARCHAR(255) NULL
        );
        CREATE UNIQUE INDEX UX_recon_sources_item ON recon_sources (workspace_id, item_id);
      END
    `,
  },
  {
    label: 'create recon_rules',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_rules') AND type = 'U')
      BEGIN
        CREATE TABLE recon_rules (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          description NVARCHAR(2000) NULL,
          business_area NVARCHAR(255) NULL,
          owner NVARCHAR(255) NULL,
          priority NVARCHAR(20) NOT NULL DEFAULT 'medium',
          status NVARCHAR(20) NOT NULL DEFAULT 'draft',
          version INT NOT NULL DEFAULT 1,
          source_a_id INT NULL,
          source_b_id INT NULL,
          dataset_a NVARCHAR(400) NULL,
          dataset_b NVARCHAR(400) NULL,
          key_field_a NVARCHAR(255) NULL,
          key_field_b NVARCHAR(255) NULL,
          compare_fields NVARCHAR(MAX) NULL,
          duplicate_handling NVARCHAR(20) NOT NULL DEFAULT 'exception',
          incomplete_key_handling NVARCHAR(20) NOT NULL DEFAULT 'exception',
          row_limit INT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          created_by NVARCHAR(255) NULL,
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_recon_rules_status ON recon_rules (status, business_area);
      END
    `,
  },
  {
    label: 'create recon_rule_versions',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_rule_versions') AND type = 'U')
      BEGIN
        CREATE TABLE recon_rule_versions (
          id INT IDENTITY(1,1) PRIMARY KEY,
          rule_id INT NOT NULL,
          version INT NOT NULL,
          snapshot NVARCHAR(MAX) NOT NULL,
          change_note NVARCHAR(1000) NULL,
          changed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          changed_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_recon_rule_versions_rule ON recon_rule_versions (rule_id, version DESC);
      END
    `,
  },
  {
    label: 'create recon_runs',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_runs') AND type = 'U')
      BEGIN
        CREATE TABLE recon_runs (
          id INT IDENTITY(1,1) PRIMARY KEY,
          rule_id INT NOT NULL,
          rule_version INT NULL,
          rule_name NVARCHAR(255) NULL,
          status NVARCHAR(20) NOT NULL DEFAULT 'running',
          records_a INT NULL,
          records_b INT NULL,
          keys_compared INT NULL,
          matched INT NULL,
          exception_count INT NULL,
          counts_json NVARCHAR(MAX) NULL,
          error_message NVARCHAR(2000) NULL,
          started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          completed_at DATETIME2 NULL,
          run_by NVARCHAR(255) NULL
        );
        CREATE INDEX IX_recon_runs_rule ON recon_runs (rule_id, started_at DESC);
      END
    `,
  },
  {
    label: 'create recon_exceptions',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_exceptions') AND type = 'U')
      BEGIN
        CREATE TABLE recon_exceptions (
          id INT IDENTITY(1,1) PRIMARY KEY,
          fingerprint NVARCHAR(500) NOT NULL,
          rule_id INT NOT NULL,
          rule_name NVARCHAR(255) NULL,
          business_area NVARCHAR(255) NULL,
          first_run_id INT NULL,
          last_run_id INT NULL,
          business_key NVARCHAR(400) NULL,
          outcome NVARCHAR(50) NOT NULL,
          severity NVARCHAR(20) NOT NULL DEFAULT 'medium',
          status NVARCHAR(30) NOT NULL DEFAULT 'open',
          owner NVARCHAR(255) NULL,
          values_a NVARCHAR(MAX) NULL,
          values_b NVARCHAR(MAX) NULL,
          differences NVARCHAR(MAX) NULL,
          resolution_reason NVARCHAR(1000) NULL,
          occurrence_count INT NOT NULL DEFAULT 1,
          first_seen_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          last_seen_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          resolved_at DATETIME2 NULL
        );
        CREATE UNIQUE INDEX UX_recon_exceptions_fingerprint ON recon_exceptions (fingerprint);
        CREATE INDEX IX_recon_exceptions_status ON recon_exceptions (status, severity, last_seen_at DESC);
      END
    `,
  },
  {
    label: 'create recon_exception_events',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'recon_exception_events') AND type = 'U')
      BEGIN
        CREATE TABLE recon_exception_events (
          id INT IDENTITY(1,1) PRIMARY KEY,
          exception_id INT NOT NULL,
          action NVARCHAR(50) NOT NULL,
          from_status NVARCHAR(30) NULL,
          to_status NVARCHAR(30) NULL,
          comment NVARCHAR(2000) NULL,
          actor NVARCHAR(255) NULL,
          occurred_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_recon_exception_events_exception ON recon_exception_events (exception_id, occurred_at DESC);
      END
    `,
  },
];

module.exports = { RECONCILIATION_MIGRATIONS };
