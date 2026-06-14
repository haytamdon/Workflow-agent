import psycopg
import time
import os
from agno.utils.log import log_info, log_error

def seed_n8n_database():
    db_host = os.getenv("DB_HOST", "postgresdb")
    db_port = os.getenv("DB_PORT", "5432")
    db_user = os.getenv("DB_USER", "workflow")
    db_pass = os.getenv("DB_PASS", "workflow")
    n8n_db = os.getenv("N8N_DB_DATABASE", "n8n")
    
    conn_str = f"host={db_host} port={db_port} user={db_user} password={db_pass} dbname={n8n_db}"
    
    log_info("Seeding n8n database...")
    for attempt in range(30):
        try:
            with psycopg.connect(conn_str) as conn:
                with conn.cursor() as cur:
                    # Check if 'user', 'user_api_keys', and 'settings' tables exist
                    cur.execute("""
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_name = 'user'
                        );
                    """)
                    user_table_exists = cur.fetchone()[0]
                    
                    cur.execute("""
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_name = 'user_api_keys'
                        );
                    """)
                    api_keys_table_exists = cur.fetchone()[0]
                    
                    cur.execute("""
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_name = 'settings'
                        );
                    """)
                    settings_table_exists = cur.fetchone()[0]
                    
                    if not (user_table_exists and api_keys_table_exists and settings_table_exists):
                        log_info(f"N8N tables not ready yet. Retrying in 2 seconds... (attempt {attempt+1}/30)")
                        time.sleep(2)
                        continue
                    
                    # Insert or replace user
                    cur.execute('SELECT id FROM "user" ORDER BY "createdAt" ASC LIMIT 1;')
                    row = cur.fetchone()
                    if row:
                        existing_id = row[0]
                        if existing_id != '505cda6d-f27e-45dd-80b1-139aef2fa98b':
                            # Delete the auto-created user to avoid unique constraint issues
                            cur.execute('DELETE FROM "user" WHERE id = %s;', (existing_id,))
                            
                            # Insert our persistent user
                            cur.execute("""
                                INSERT INTO "user" (id, email, "firstName", "lastName", password, "roleSlug", "settings")
                                VALUES (
                                  '505cda6d-f27e-45dd-80b1-139aef2fa98b',
                                  'admin@example.com',
                                  'Admin',
                                  'Agent',
                                  '$2b$12$9g8iaZmGwO/xKTgYavwkj.DPLA2h90A.Xdzpfw7IBYAeALP/rt5O.',
                                  'global:owner',
                                  '{"userActivated": false}'
                                )
                                ON CONFLICT (id) DO NOTHING;
                            """)
                    else:
                        cur.execute("""
                            INSERT INTO "user" (id, email, "firstName", "lastName", password, "roleSlug", "settings")
                            VALUES (
                              '505cda6d-f27e-45dd-80b1-139aef2fa98b',
                              'admin@example.com',
                              'Admin',
                              'Agent',
                              '$2b$12$9g8iaZmGwO/xKTgYavwkj.DPLA2h90A.Xdzpfw7IBYAeALP/rt5O.',
                              'global:owner',
                              '{"userActivated": false}'
                            )
                            ON CONFLICT (id) DO NOTHING;
                        """)
                    
                    # Ensure there is a project relation for our user
                    cur.execute("SELECT id FROM project WHERE type = 'personal' ORDER BY \"createdAt\" ASC LIMIT 1;")
                    project_row = cur.fetchone()
                    if project_row:
                        project_id = project_row[0]
                        cur.execute("""
                            INSERT INTO project_relation ("projectId", "userId", role)
                            VALUES (%s, '505cda6d-f27e-45dd-80b1-139aef2fa98b', 'project:personalOwner')
                            ON CONFLICT DO NOTHING;
                        """, (project_id,))

                    # Insert API key
                    cur.execute("""
                        INSERT INTO user_api_keys (id, "userId", label, "apiKey", scopes, audience)
                        VALUES (
                          '283rXO2luhFVXTmH',
                          '505cda6d-f27e-45dd-80b1-139aef2fa98b',
                          'internal-key',
                          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1MDVjZGE2ZC1mMjdlLTQ1ZGQtODBiMS0xMzlhZWYyZmE5OGIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiN2ZlN2U0Y2MtZTcwYi00NTMzLWE4ZDEtZTlhZTBiMTRkYzY2IiwiaWF0IjoxNzgxNDM2NjgwfQ.xv5j0Q-fpTh6Ypi2tspri2d3atEph9IwTJg4haeZjuA',
                          '["communityPackage:install","communityPackage:uninstall","communityPackage:update","communityPackage:list","credential:move","credential:create","credential:read","credential:update","credential:delete","credential:list","project:create","project:update","project:delete","project:list","securityAudit:generate","sourceControl:pull","tag:create","tag:read","tag:update","tag:delete","tag:list","user:changeRole","user:enforceMfa","user:create","user:read","user:delete","user:list","variable:create","variable:update","variable:delete","variable:list","workflow:export","workflow:import","workflow:move","workflow:create","workflow:read","workflow:update","workflow:delete","workflow:list","folder:create","folder:read","folder:update","folder:delete","folder:list","insights:read","dataTable:create","dataTable:read","dataTable:update","dataTable:delete","dataTable:list","workflowTags:update","workflowTags:list","executionTags:update","executionTags:list","workflow:activate","workflow:deactivate","execution:delete","execution:read","execution:retry","execution:stop","execution:list","dataTableRow:create","dataTableRow:read","dataTableRow:update","dataTableRow:delete","dataTableRow:upsert","dataTableColumn:create","dataTableColumn:read","dataTableColumn:update","dataTableColumn:delete"]'::json,
                          'public-api'
                        )
                        ON CONFLICT (id) DO NOTHING;
                    """)
                    
                    # Insert settings to enable MCP
                    cur.execute("""
                        INSERT INTO settings (key, value, "loadOnStartup")
                        VALUES ('mcp.access.enabled', 'true', true)
                        ON CONFLICT (key) DO UPDATE SET value = 'true';
                    """)
                    
                    conn.commit()
                    log_info("N8N database successfully seeded!")
                    break
        except Exception as e:
            log_error(f"Error seeding n8n database: {e}")
            time.sleep(2)
