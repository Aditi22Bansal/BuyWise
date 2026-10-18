SELECT e.id, w.name, e.status FROM execution_entity e JOIN workflow_entity w ON w.id = e."workflowId" WHERE e.id > 169 ORDER BY e.id;
SELECT count(*) FROM vendors WHERE procurement_id = '679a22df-df99-46b1-8abc-08bd8a0ba09b';
SELECT count(*) FROM quality_evaluations WHERE procurement_id = '679a22df-df99-46b1-8abc-08bd8a0ba09b';
