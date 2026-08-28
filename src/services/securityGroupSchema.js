/**
 * The security group mapping, in third normal form.
 *
 * The shape follows what the model actually is. A person is a person; a person's
 * involvement in a stream under a project role is an assignment; the environments
 * that assignment covers are a many-to-many; the group is identified by the
 * combination of stream, role and environment, and carries the one fact that is
 * not derivable — which real directory group it is.
 *
 * What is deliberately *not* a table: group membership. Who is in a group follows
 * from the assignments, and a stored copy would disagree with them the moment
 * either changed, with nothing to say which was right. It is a join, not a table.
 *
 * Nor is the group's name or its Fabric role stored. Both are computed from the
 * rules — storing a derivation means a rule change leaves rows behind that quietly
 * contradict it.
 */

const SECURITY_GROUP_MIGRATIONS = [
  {
    label: 'create sg_streams',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_streams') AND type = 'U')
      BEGIN
        CREATE TABLE sg_streams (
          id INT IDENTITY(1,1) PRIMARY KEY,
          code NVARCHAR(32) NOT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE UNIQUE INDEX UX_sg_streams_code ON sg_streams (code);
      END
    `,
  },
  {
    label: 'create sg_project_roles',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_project_roles') AND type = 'U')
      BEGIN
        CREATE TABLE sg_project_roles (
          id INT IDENTITY(1,1) PRIMARY KEY,
          code NVARCHAR(32) NOT NULL,
          label NVARCHAR(200) NULL,
          is_admin BIT NOT NULL DEFAULT 0,
          sort_order INT NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX UX_sg_project_roles_code ON sg_project_roles (code);
      END
    `,
  },
  {
    label: 'create sg_environments',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_environments') AND type = 'U')
      BEGIN
        CREATE TABLE sg_environments (
          id INT IDENTITY(1,1) PRIMARY KEY,
          code NVARCHAR(32) NOT NULL,
          label NVARCHAR(200) NULL,
          sort_order INT NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX UX_sg_environments_code ON sg_environments (code);
      END
    `,
  },
  {
    label: 'create sg_people',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_people') AND type = 'U')
      BEGIN
        CREATE TABLE sg_people (
          id INT IDENTITY(1,1) PRIMARY KEY,
          display_name NVARCHAR(400) NOT NULL,
          -- Blank rather than NULL, so the unique index treats "no email" as one
          -- value instead of letting the same person in twice.
          email NVARCHAR(400) NOT NULL DEFAULT '',
          entra_object_id NVARCHAR(100) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NULL
        );
        CREATE UNIQUE INDEX UX_sg_people_identity ON sg_people (display_name, email);
      END
    `,
  },
  {
    label: 'create sg_assignments',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_assignments') AND type = 'U')
      BEGIN
        CREATE TABLE sg_assignments (
          id INT IDENTITY(1,1) PRIMARY KEY,
          person_id INT NOT NULL,
          stream_id INT NOT NULL,
          project_role_id INT NOT NULL,
          note NVARCHAR(MAX) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          created_by NVARCHAR(255) NULL,
          updated_at DATETIME2 NULL,
          updated_by NVARCHAR(255) NULL
        );
        -- One person, one stream, one project role is one assignment. This is the
        -- duplicate rule, enforced where it cannot be worked around.
        CREATE UNIQUE INDEX UX_sg_assignments_identity ON sg_assignments (person_id, stream_id, project_role_id);
        CREATE INDEX IX_sg_assignments_stream ON sg_assignments (stream_id, project_role_id);
      END
    `,
  },
  {
    label: 'create sg_assignment_environments',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_assignment_environments') AND type = 'U')
      BEGIN
        CREATE TABLE sg_assignment_environments (
          assignment_id INT NOT NULL,
          environment_id INT NOT NULL,
          CONSTRAINT PK_sg_assignment_environments PRIMARY KEY (assignment_id, environment_id)
        );
        CREATE INDEX IX_sg_assignment_environments_env ON sg_assignment_environments (environment_id);
      END
    `,
  },
  {
    label: 'create sg_groups',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_groups') AND type = 'U')
      BEGIN
        CREATE TABLE sg_groups (
          id INT IDENTITY(1,1) PRIMARY KEY,
          stream_id INT NOT NULL,
          project_role_id INT NOT NULL,
          environment_id INT NOT NULL,
          -- The link to what actually exists in the directory. The suggested name
          -- and the real one differ often enough that assuming they match is how a
          -- check reports every group missing.
          entra_group_id NVARCHAR(100) NULL,
          entra_group_name NVARCHAR(400) NULL,
          entra_group_type NVARCHAR(64) NULL,
          linked_at DATETIME2 NULL,
          linked_by NVARCHAR(255) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE UNIQUE INDEX UX_sg_groups_identity ON sg_groups (stream_id, project_role_id, environment_id);
        CREATE INDEX IX_sg_groups_entra ON sg_groups (entra_group_id);
      END
    `,
  },
  {
    label: 'create sg_group_workspaces',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_group_workspaces') AND type = 'U')
      BEGIN
        CREATE TABLE sg_group_workspaces (
          id INT IDENTITY(1,1) PRIMARY KEY,
          group_id INT NOT NULL,
          workspace_id NVARCHAR(100) NOT NULL,
          -- Kept beside the id because a workspace can be deleted, and a plan that
          -- can only say "6a1f…" about what is missing is not readable.
          workspace_name NVARCHAR(400) NULL,
          -- What the group should hold there. Defaults to the computed role, and is
          -- stored because it can be overridden per workspace.
          intended_role NVARCHAR(32) NOT NULL,
          attached_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          attached_by NVARCHAR(255) NULL
        );
        CREATE UNIQUE INDEX UX_sg_group_workspaces ON sg_group_workspaces (group_id, workspace_id);
        CREATE INDEX IX_sg_group_workspaces_ws ON sg_group_workspaces (workspace_id);
      END
    `,
  },
  {
    label: 'create sg_group_workspace_checks',
    sql: `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_group_workspace_checks') AND type = 'U')
      BEGIN
        CREATE TABLE sg_group_workspace_checks (
          id INT IDENTITY(1,1) PRIMARY KEY,
          group_workspace_id INT NOT NULL,
          checked_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          checked_by NVARCHAR(255) NULL,
          -- present / wrong-role / missing / unlinked / unreadable. Kept apart
          -- because "we could not read it" is not "it is not there".
          state NVARCHAR(32) NOT NULL,
          actual_role NVARCHAR(32) NULL,
          message NVARCHAR(MAX) NULL
        );
        CREATE INDEX IX_sg_checks_target ON sg_group_workspace_checks (group_workspace_id, checked_at DESC);
      END
    `,
  },
  {
    label: 'seed sg_project_roles',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_project_roles') AND type = 'U')
      BEGIN
        INSERT INTO sg_project_roles (code, label, is_admin, sort_order)
        SELECT code, label, is_admin, sort_order FROM (VALUES
          ('DE', 'Data Engineer', 0, 1),
          ('BI', 'Business Intelligence', 0, 2),
          ('AI', 'Artificial Intelligence', 0, 3),
          ('PM', 'Project Manager', 0, 4),
          ('ADMIN', 'Administrator', 1, 5),
          ('UX', 'User Experience', 0, 6),
          ('OTHER', 'Other', 0, 7)
        ) AS seed(code, label, is_admin, sort_order)
        WHERE NOT EXISTS (SELECT 1 FROM sg_project_roles existing WHERE existing.code = seed.code);
      END
    `,
  },
  {
    label: 'seed sg_environments',
    sql: `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'sg_environments') AND type = 'U')
      BEGIN
        INSERT INTO sg_environments (code, label, sort_order)
        SELECT code, label, sort_order FROM (VALUES
          ('DEV', 'Development', 1),
          ('TEST', 'Test', 2),
          ('PROD', 'Production', 3)
        ) AS seed(code, label, sort_order)
        WHERE NOT EXISTS (SELECT 1 FROM sg_environments existing WHERE existing.code = seed.code);
      END
    `,
  },
];

module.exports = { SECURITY_GROUP_MIGRATIONS };
