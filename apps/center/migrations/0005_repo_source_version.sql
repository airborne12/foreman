-- 0005: 仓库来源新增 version（按 Jira 影响版本规则算出）
--
-- 背景：之前只取修复版本（几乎为空），代码定位 agent 看不到版本，照提示词示例把基线猜成
-- branch-selectdb-doris-4.1（2026-09-30）。改为按影响版本确定性地算仓库与基线（versionTarget.ts），
-- 这类仓库的来源记为 version，分流时 agent 不能覆盖。

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_repo_source_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_repo_source_check CHECK (repo_source IN ('mapping', 'llm', 'manual', 'unresolved', 'version'));
