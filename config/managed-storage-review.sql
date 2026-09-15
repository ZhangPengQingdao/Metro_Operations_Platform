-- Read-only review. Run against the intended platform database with psql.
-- Never run against the historical project database. No grants are changed here.
SELECT current_database() AS database, session_user AS connected_role;
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb
FROM pg_catalog.pg_roles WHERE rolname = current_user;
SELECT a.privilege_type AS public_database_privilege
FROM pg_catalog.pg_database d,
LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
WHERE d.datname = current_database() AND a.grantee = 0;
SELECT n.nspname AS schema, a.privilege_type AS public_schema_privilege
FROM pg_catalog.pg_namespace n,
LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND a.grantee = 0;

-- Proposed changes for DBA review ONLY (replace placeholders, retain original ACLs first):
-- REVOKE CREATE, TEMPORARY ON DATABASE "<PLATFORM_DATABASE>" FROM PUBLIC;
-- REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- CREATE ROLE "<STORAGE_ADMIN_ROLE>" NOLOGIN SUPERUSER;
-- Set its unique password privately with psql \password, then explicitly enable LOGIN.
-- Do not grant this role to the ordinary API role. Do not elevate the API role.
-- The current executor needs superuser role management; it is not a least-privilege broker.
-- This affects the PostgreSQL cluster, not merely one database. Use an isolated instance
-- for local verification; production privilege confinement remains a separate task.
-- After preflight, public object/function/column/large-object ACLs may need separate review.
-- Do not blanket-revoke unrelated privileges or automatically re-grant PUBLIC on rollback.
-- Preserve application schemas, owner/runtime roles, leases and migration evidence.
