-- A SQL file: '--' comments, and a keyword set of its own.

/* Block comments work here too,
   across lines. */

CREATE TABLE workspaces (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  cwd    TEXT NOT NULL,
  colour TEXT DEFAULT '#888888'
);

INSERT INTO workspaces (id, name, cwd) VALUES
  ('a', 'dev', 'C:\Projects\dev'),
  ('b', 'audio', 'C:\Projects\audio');

SELECT w.name, count(t.id) AS tabs
FROM workspaces w
LEFT JOIN tabs t ON t.workspace_id = w.id
WHERE w.name NOT LIKE 'scratch%'
GROUP BY w.name
ORDER BY tabs DESC
LIMIT 10;
