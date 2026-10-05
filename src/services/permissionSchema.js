/**
 * Who the application's own users are, and what they have been granted.
 *
 * Identity is the sign-in email, lower-cased, because that is the only thing the
 * application reliably knows about a person arriving through Entra ID. Grants are
 * separate tables rather than a list column: a grant is a fact about a user and a
 * tenant (or a section), and a delimited string cannot be joined, indexed, or
 * cleaned up when the tenant it names is deleted.
 */

const PERMISSION_MIGRATIONS = [
  {
    label: 'create app_users',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'app_users') AND type = 'U')
      BEGIN
        CREATE TABLE app_users (
          id INT IDENTITY(1,1) PRIMARY KEY,
          -- Stored lower-cased so sign-in casing cannot create a second account
          -- for the same person, which would silently carry different grants.
          email NVARCHAR(320) NOT NULL,
          display_name NVARCHAR(400) NULL,
          role NVARCHAR(32) NOT NULL DEFAULT 'user',
          is_active BIT NOT NULL DEFAULT 1,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          created_by NVARCHAR(320) NULL,
          updated_at DATETIME2 NULL,
          updated_by NVARCHAR(320) NULL
        );
        CREATE UNIQUE INDEX UX_app_users_email ON app_users (email);
      END
    `,
  },
  {
    label: 'create app_user_tenants',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'app_user_tenants') AND type = 'U')
      BEGIN
        CREATE TABLE app_user_tenants (
          user_id INT NOT NULL,
          sp_id INT NOT NULL,
          granted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          CONSTRAINT PK_app_user_tenants PRIMARY KEY (user_id, sp_id)
        );
        CREATE INDEX IX_app_user_tenants_sp ON app_user_tenants (sp_id);
      END
    `,
  },
  {
    label: 'create app_user_sections',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'app_user_sections') AND type = 'U')
      BEGIN
        CREATE TABLE app_user_sections (
          user_id INT NOT NULL,
          -- The section key from appSectionService, not a label: labels are display
          -- text and change, keys are the grant.
          section_key NVARCHAR(64) NOT NULL,
          granted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          CONSTRAINT PK_app_user_sections PRIMARY KEY (user_id, section_key)
        );
      END
    `,
  },
];

module.exports = { PERMISSION_MIGRATIONS };
