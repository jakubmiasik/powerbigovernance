/**
 * The application's own trail: who changed what through this tool, and whether it
 * worked. Evidence for an audit starts with the governance tool's own actions —
 * a grant nobody can attribute is a finding in its own right.
 *
 * Append-only by design: the application writes rows and never updates or
 * deletes them.
 */

const AUDIT_MIGRATIONS = [
  {
    label: 'create app_audit_log',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'app_audit_log') AND type = 'U')
      BEGIN
        CREATE TABLE app_audit_log (
          id BIGINT IDENTITY(1,1) PRIMARY KEY,
          occurred_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          actor_email NVARCHAR(320) NULL,
          actor_name NVARCHAR(400) NULL,
          action NVARCHAR(100) NOT NULL,
          category NVARCHAR(50) NOT NULL,
          method NVARCHAR(10) NOT NULL,
          path NVARCHAR(400) NOT NULL,
          target NVARCHAR(400) NULL,
          tenant_id NVARCHAR(64) NULL,
          outcome NVARCHAR(16) NOT NULL,
          status_code INT NULL,
          message NVARCHAR(1000) NULL,
          detail_json NVARCHAR(4000) NULL
        );
        CREATE INDEX IX_app_audit_log_time ON app_audit_log (occurred_at DESC);
        CREATE INDEX IX_app_audit_log_actor ON app_audit_log (actor_email, occurred_at DESC);
      END
    `,
  },
];

module.exports = { AUDIT_MIGRATIONS };
