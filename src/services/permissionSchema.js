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
  {
    // A group is granted the same way a person is, so it lives in the same table.
    // That means identity can no longer be "the email": a security group may not
    // have one, and two groups without one must not collide.
    label: 'allow security groups alongside users in app_users',
    sql: `
      IF COL_LENGTH('app_users', 'principal_type') IS NULL
        ALTER TABLE app_users ADD principal_type NVARCHAR(16) NOT NULL DEFAULT 'user';
      -- The directory object the entry was picked from. For a group it is what
      -- members are matched against; for a person it survives a rename or an
      -- address change that would otherwise lose their grants.
      IF COL_LENGTH('app_users', 'entra_object_id') IS NULL
        ALTER TABLE app_users ADD entra_object_id NVARCHAR(64) NULL;
    `,
  },
  {
    label: 'key app_users by principal rather than by email alone',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_users_email' AND object_id = OBJECT_ID(N'app_users'))
        DROP INDEX UX_app_users_email ON app_users;

      IF EXISTS (
        SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'app_users')
          AND name = 'email' AND is_nullable = 0
      )
        ALTER TABLE app_users ALTER COLUMN email NVARCHAR(320) NULL;

      -- Filtered, so each kind of principal is unique by the thing that actually
      -- identifies it: a person by the address they sign in with, a group by its
      -- directory object.
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_users_user_email' AND object_id = OBJECT_ID(N'app_users'))
        CREATE UNIQUE INDEX UX_app_users_user_email ON app_users (email)
          WHERE principal_type = 'user' AND email IS NOT NULL;

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_users_group_object' AND object_id = OBJECT_ID(N'app_users'))
        CREATE UNIQUE INDEX UX_app_users_group_object ON app_users (entra_object_id)
          WHERE principal_type = 'group' AND entra_object_id IS NOT NULL;
    `,
  },
  {
    label: 'keep a person unique by directory object as well as by address',
    sql: `
      -- A guest is known by two addresses, so the same person could otherwise be
      -- granted twice - once under each - and the two entries could then disagree
      -- about what they may see.
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_users_user_object' AND object_id = OBJECT_ID(N'app_users'))
        CREATE UNIQUE INDEX UX_app_users_user_object ON app_users (entra_object_id)
          WHERE principal_type = 'user' AND entra_object_id IS NOT NULL;
    `,
  },
];

module.exports = { PERMISSION_MIGRATIONS };
